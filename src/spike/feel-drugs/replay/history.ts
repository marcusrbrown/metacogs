/** Real session rows to an import export: the DB mapping, the token-budget window, and the cut at the cutoff message. All of it is private. */
import type { RawExtract, RawMessage, RawPart } from './extract'
import { HOST_VERSION, type SessionExport } from './store'

/** The loosest shape the replay needs from an export: what `opencode import` reads and the gates count. */
export interface SeedMessage {
  info: { id: string; role: string }
  parts: { type: string }[]
}
export interface ReplaySeed {
  info: SessionExport['info']
  messages: SeedMessage[]
}

export const HISTORY_TOKEN_BUDGET = 120_000
const CHARS_PER_TOKEN = 4
const PART_OVERHEAD_CHARS = 16
/** A data: URL is an image or a file body; it costs about this much, not its length. */
const FILE_CHARS = 4_000
const SEED_TURNS = 3
const SEED_TURN_CHARS = 200

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseJson(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

// ── parts ──────────────────────────────────────────────────────────────────

const TOOL_STATUSES = ['pending', 'running', 'completed', 'error']

/** What the importer needs of each part kind; `null` when the part is usable, else why not. */
function partProblem(part: Json): string | null {
  const type = str(part.type)
  switch (type) {
    case 'text':
    case 'reasoning':
      return typeof part.text === 'string' ? null : 'malformed'
    case 'tool':
      return typeof part.tool === 'string' && typeof part.callID === 'string' && isRecord(part.state) && TOOL_STATUSES.includes(str(part.state.status)) ? null : 'malformed'
    case 'step-start':
      return null
    case 'step-finish':
      return typeof part.reason === 'string' && isRecord(part.tokens) && typeof part.cost === 'number' ? null : 'malformed'
    case 'file':
      return typeof part.mime === 'string' && typeof part.url === 'string' ? null : 'malformed'
    case 'patch':
      return typeof part.hash === 'string' && Array.isArray(part.files) ? null : 'malformed'
    case 'agent':
      return typeof part.name === 'string' ? null : 'malformed'
    case 'snapshot':
      return typeof part.snapshot === 'string' ? null : 'malformed'
    case 'retry':
      return typeof part.attempt === 'number' && isRecord(part.error) ? null : 'malformed'
    case 'compaction':
      return typeof part.auto === 'boolean' ? null : 'malformed'
    case 'subtask':
      return typeof part.prompt === 'string' && typeof part.description === 'string' && typeof part.agent === 'string' ? null : 'malformed'
    default:
      return 'unknown_type'
  }
}

/** Characters the model would see from one part; the token estimate divides the sum by four. */
export function partChars(part: Json): number {
  const type = str(part.type)
  let chars = PART_OVERHEAD_CHARS
  if (type === 'text' || type === 'reasoning') chars += str(part.text).length
  else if (type === 'tool' && isRecord(part.state)) chars += str(part.tool).length + JSON.stringify(part.state.input ?? {}).length + str(part.state.output).length + str(part.state.error).length
  else if (type === 'file') chars += str(part.url).startsWith('data:') ? FILE_CHARS : str(part.url).length + str(part.filename).length
  else if (type === 'patch') chars += JSON.stringify(part.files).length
  else if (type === 'agent') chars += str(part.name).length
  else if (type === 'subtask') chars += str(part.prompt).length + str(part.description).length
  return chars
}

export const tokensOfChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

// ── the mapping ────────────────────────────────────────────────────────────

interface Item {
  id: string
  role: 'user' | 'assistant'
  time: number
  info: Json
  parts: Json[]
  chars: number
  compaction: boolean
}

export interface DroppedParts {
  total: number
  /** Count per part type; a malformed part of a known type counts as `<type>:malformed`, an unreadable row as `unparseable`. */
  by_type: Record<string, number>
}

/** `message.data` plus the row columns is the export's message info; the same for a part. */
export function mapRow(row: RawMessage): Json | null
export function mapRow(row: RawPart): Json | null
export function mapRow(row: RawMessage | RawPart): Json | null {
  const data = parseJson(row.data)
  if (!data) return null
  return 'message_id' in row ? { ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id } : { ...data, id: row.id, sessionID: row.session_id }
}

function mapItems(raw: RawExtract): { items: Item[]; dropped: DroppedParts } {
  const dropped: DroppedParts = { total: 0, by_type: {} }
  const drop = (label: string) => {
    dropped.total += 1
    dropped.by_type[label] = (dropped.by_type[label] ?? 0) + 1
  }
  const byMessage = new Map<string, RawPart[]>()
  for (const p of raw.parts) byMessage.set(p.message_id, [...(byMessage.get(p.message_id) ?? []), p])
  const items: Item[] = []
  for (const row of raw.messages) {
    const info = mapRow(row)
    const role = info?.role
    if (!info || (role !== 'user' && role !== 'assistant')) {
      drop(info ? `message:${str(role) || 'no_role'}` : 'message:unparseable')
      continue
    }
    const parts: Json[] = []
    for (const p of byMessage.get(row.id) ?? []) {
      const part = mapRow(p)
      if (!part) {
        drop('unparseable')
        continue
      }
      const problem = partProblem(part)
      if (problem) {
        drop(problem === 'malformed' ? `${str(part.type)}:malformed` : str(part.type) || 'no_type')
        continue
      }
      parts.push(part)
    }
    items.push({ id: row.id, role, time: row.time_created, info, parts, chars: parts.reduce((n, p) => n + partChars(p), 0), compaction: parts.some((p) => p.type === 'compaction') })
  }
  return { items, dropped }
}

// ── the window ─────────────────────────────────────────────────────────────

export interface HistoryWindow {
  /** `all` fits whole; `compaction` starts at the latest compaction message; `last_n` keeps the last N messages. */
  rule: 'all' | 'compaction' | 'compaction_over_budget' | 'last_n'
  messages: number
  first_message: string
  /** Session messages up to and including the cutoff, before any window. */
  total_messages: number
  token_estimate: number
  budget: number
  over_budget: boolean
  compaction_message: string | null
}

function chooseStart(items: readonly Item[], budgetChars: number): { start: number; rule: HistoryWindow['rule'] } {
  const n = items.length
  const suffix = new Array<number>(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + items[i]!.chars
  const compaction = items.findLastIndex((m) => m.compaction)
  let start = 0
  let rule: HistoryWindow['rule'] = 'all'
  if (compaction >= 0 && suffix[compaction]! <= budgetChars) {
    start = compaction
    rule = 'compaction'
  } else if (suffix[0]! > budgetChars) {
    const fits = suffix.findIndex((total, i) => i < n && total <= budgetChars)
    start = fits === -1 ? n - 1 : fits // a lone oversize cutoff message still has to go in
    rule = compaction >= 0 ? 'compaction_over_budget' : 'last_n'
  }
  if (items[start]!.role !== 'user') {
    const next = items.findIndex((m, i) => i > start && m.role === 'user')
    const before = items.findLastIndex((m, i) => i < start && m.role === 'user')
    if (next >= 0) start = next
    else if (before >= 0) start = before
  }
  return { start, rule }
}

/** The human-typed user turns of the window (first text part, not starting with `<`), last few, trimmed. For the seed-history gate. */
function seedTurns(items: readonly Item[]): string[] {
  return items
    .filter((m) => m.role === 'user')
    .map((m) => str(m.parts.find((p) => p.type === 'text')?.text).trim())
    .filter((t) => t !== '' && !t.startsWith('<'))
    .slice(-SEED_TURNS)
    .map((t) => t.slice(0, SEED_TURN_CHARS))
}

// ── the export ─────────────────────────────────────────────────────────────

export interface RealHistory {
  export: ReplaySeed
  window: HistoryWindow
  dropped: DroppedParts
  /** Count per part type in the exported window. */
  part_types: Record<string, number>
  cutoff: { message: string; time_ms: number }
  /** Texts the first request of an attempt must still hold, for the seed-history gate. */
  seed_user_turns: string[]
  /** The directory the session ran in, as recorded. The export itself carries the placeholder or the clone. */
  original_directory: string
}

export class HistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryError'
  }
}

export interface HistoryOptions {
  /** The scenario id: names the export. */
  scenario: string
  /** The import target's workspace. Default: a placeholder; the host sets the clone. */
  directory?: string
  /** Token budget of the history. Default 120k. */
  budget?: number
}

/** Builds the import export from extracted rows up to the cutoff; the author's next turn and anything after it never enter. */
export function buildRealExport(raw: RawExtract, options: HistoryOptions): RealHistory {
  const budget = options.budget ?? HISTORY_TOKEN_BUDGET
  const directory = options.directory ?? '/workspace'
  const { items, dropped } = mapItems(raw)
  const last = items.at(-1)
  if (!last || last.id !== raw.cutoff) throw new HistoryError('the cutoff message is not the last message of the extract')
  if (last.role !== 'assistant') throw new HistoryError('the cutoff message is not an assistant message')
  if (items.some((m) => m.time > last.time)) throw new HistoryError('a message after the cutoff is in the extract')

  const { start, rule } = chooseStart(items, budget * CHARS_PER_TOKEN)
  const windowed = items.slice(start)
  const chars = windowed.reduce((n, m) => n + m.chars, 0)
  const partTypes: Record<string, number> = {}
  for (const m of windowed) for (const p of m.parts) partTypes[str(p.type)] = (partTypes[str(p.type)] ?? 0) + 1

  const agent = 'orchestrator'
  const messages = windowed.map((m) => ({ info: m.info, parts: m.parts })) as unknown as SeedMessage[]
  const compaction = windowed.find((m) => m.compaction)
  const exported: ReplaySeed = {
    info: {
      id: raw.session.id,
      slug: options.scenario,
      projectID: 'global',
      directory,
      path: '',
      title: `Replay ${options.scenario}`,
      agent,
      model: { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'default' },
      version: HOST_VERSION,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      permission: ['question', 'plan_enter', 'plan_exit'].map((permission) => ({ permission, pattern: '*', action: 'deny' })),
      time: { created: windowed[0]!.time, updated: last.time },
    },
    messages,
  }
  return {
    export: exported,
    window: {
      rule,
      messages: windowed.length,
      first_message: windowed[0]!.id,
      total_messages: raw.total_messages,
      token_estimate: tokensOfChars(chars),
      budget,
      over_budget: tokensOfChars(chars) > budget,
      compaction_message: compaction?.id ?? null,
    },
    dropped,
    part_types: partTypes,
    cutoff: { message: last.id, time_ms: last.time },
    seed_user_turns: seedTurns(windowed),
    original_directory: raw.session.directory,
  }
}

/** Throws unless the export's last message is the cutoff assistant message. Used again when a built export is loaded. */
export function assertEndsAtCutoff(seed: ReplaySeed, cutoff: string): void {
  const last = seed.messages.at(-1)
  if (!last || last.info.id !== cutoff || last.info.role !== 'assistant') throw new HistoryError('the export does not end on the cutoff assistant message')
}
