/** Blind labelling sheet for a replay campaign: scenario brief, expected-move line, then shuffled answers with arm tells removed. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { type OpencodeEvent, parseEvents } from '../../../runner/events'
import { sha256 } from '../../../runner/workspace'
import { cryptoRng, type Rng } from '../blind'
import { fenced, redactPaths } from '../sheet'
import { ARM_NAMES, type ArmName, NUDGE_ONLY, REPLAY_MODELS, WHICHEVER } from './gates'
import { type AttemptRecord, campaignCells, campaignDir, cellDir } from './run'
import { type FixtureKind, type FixtureSpec, ID_PATTERN, loadFrozen, type Store } from './store'

export const SHEET_SCHEMA_VERSION = 1 as const
export const HIDDEN_CALL = '[tool call hidden]'
export const HIDDEN = '[hidden]'
/** Answers longer than this are clipped on the sheet; the evidence on disk is whole. */
const ANSWER_LIMIT = 6000

// ── the key ────────────────────────────────────────────────────────────────

export interface KeyFixture {
  label: string
  id: string
  kind: FixtureKind
}

export interface KeyAnswer {
  /** Opaque id on the sheet: scenario label, model label, answer letter. */
  id: string
  letter: string
  fixture: string
  model: string
  arm: ArmName
  /** Attempt directory, relative to the campaign directory. */
  attempt: string
  /** sha256 of that attempt's `attempt.json` at build time. */
  attempt_sha256: string
  /** Counts only: how many strings and calls were replaced on the way to the sheet. */
  redactions: number
  hidden_calls: number
}

export interface AppendixRow {
  fixture: string
  model: string
  arm: string
  status: string
  reason: string
}

export interface SheetKey {
  schema_version: typeof SHEET_SCHEMA_VERSION
  build_id: string
  campaign: string
  created_at: string
  fixtures: KeyFixture[]
  models: string[]
  answers: KeyAnswer[]
  appendix: AppendixRow[]
}

export const sheetsDir = (store: Store, campaign: string): string => join(store.root, 'sheets', campaign)

// ── arm tells ──────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const METACOGS_TOOL = /^(?:metacogs[_-])?(?:feel|drugs)$/i

/** A `feel` or `drugs` call, or a `skill` call that loads one of them. */
export function isHiddenCall(tool: string, input: unknown): boolean {
  if (METACOGS_TOOL.test(tool)) return true
  return tool === 'skill' && isRecord(input) && typeof input.name === 'string' && /^(?:feel|drugs)$/i.test(input.name)
}

/** One short line for a tool input: up to three fields, each clipped. */
export function summarizeInput(input: unknown): string {
  if (isRecord(input)) {
    const entries = Object.entries(input)
    const shown = entries.slice(0, 3).map(([k, v]) => `${k}=${clip(oneLine(typeof v === 'string' ? v : (JSON.stringify(v) ?? '')), 80)}`)
    return clip(`${shown.join(' ')}${entries.length > 3 ? ' …' : ''}`, 220)
  }
  return input === undefined || input === null ? '' : clip(oneLine(typeof input === 'string' ? input : (JSON.stringify(input) ?? '')), 220)
}

export interface Scrubbed {
  text: string
  redactions: number
}

/** Removes what names the arm: skill header and base-directory lines, the arm message, the command and tool names, substances and the `somewhere` phrase. */
export function scrubAnswer(text: string, ctx: { somewhere: string }): Scrubbed {
  let n = 0
  let out = redactPaths(text, { workspaces: [], homes: [] })
  const sub = (re: RegExp, to: string | ((match: string, group: string) => string)): void => {
    out = out.replace(re, (...args: unknown[]) => {
      n += 1
      return typeof to === 'string' ? to : to(String(args[0]), typeof args[1] === 'string' ? args[1] : '')
    })
  }
  sub(/<skill_content[\s\S]*?<\/skill_content>/gi, HIDDEN_CALL)
  sub(/^[ \t]*#{1,6}[ \t]*(?:feel|drugs)\b.*(?:\r?\n|$)/gim, '')
  sub(/^.*(?:Base directory for this skill|Relative paths in this skill).*(?:\r?\n|$)/gim, '')
  sub(new RegExp(escapeRe(WHICHEVER), 'gi'), '')
  sub(new RegExp(escapeRe(NUDGE_ONLY), 'gi'), '')
  const phrase = oneLine(ctx.somewhere)
  if (phrase.length >= 3) sub(new RegExp(escapeRe(phrase).replace(/\s+/g, '\\s+'), 'gi'), HIDDEN)
  sub(/\b(call|calls|calling|called|use|uses|using|used|invoke|invoking|invoked|run|runs|running|load|loading|loaded|type|typing|try|trying)\s+(?:the\s+)?(?:metacogs[_-])?(?:feel|drugs)\b/gi, (_m, verb) => `${verb} ${HIDDEN}`)
  sub(/\b(?:metacogs[_-])?(?:feel|drugs)\s+(?:tool|skill|command|frame)s?\b/gi, HIDDEN)
  sub(/(["'`])(?:metacogs[_-])?(?:feel|drugs)\1/gi, HIDDEN)
  sub(/\b(?:feel|drugs)\s*\(/gi, `${HIDDEN}(`)
  sub(/[/#]\s*(?:feel|drugs)\b/gi, HIDDEN)
  sub(/\bmetacogs(?:[_-](?:feel|drugs))?\b/gi, HIDDEN)
  sub(/\b(?:caffeine|psilocybin)\b/gi, HIDDEN)
  sub(/\bdrugs\b/gi, HIDDEN)
  return { text: out, redactions: n }
}

export interface RenderedAnswer {
  text: string
  redactions: number
  hidden_calls: number
}

/** The next move: assistant text and a compact tool-call list in stream order. Calls to `feel` and `drugs` become a placeholder. */
export function renderAnswer(events: readonly OpencodeEvent[], ctx: { somewhere: string }): RenderedAnswer {
  const lines: string[] = []
  let hidden = 0
  for (const event of events) {
    const part = event.part
    if (event.type === 'text' && typeof part?.text === 'string' && part.text.trim() !== '') {
      lines.push(part.text.trim())
    } else if (event.type === 'tool_use' && isRecord(part) && typeof part.tool === 'string') {
      const state = isRecord(part.state) ? part.state : {}
      if (isHiddenCall(part.tool, state.input)) {
        hidden += 1
        lines.push(HIDDEN_CALL)
        continue
      }
      const status = typeof state.status === 'string' && state.status !== 'completed' ? ` [${state.status}]` : ''
      const summary = summarizeInput(state.input)
      lines.push(`[tool] ${part.tool}${summary ? ` ${summary}` : ''}${status}`)
    }
  }
  const scrubbed = scrubAnswer(lines.join('\n'), ctx)
  const over = scrubbed.text.length - ANSWER_LIMIT
  const text = over > 0 ? `${scrubbed.text.slice(0, ANSWER_LIMIT)}\n[… ${over} more characters not shown]` : scrubbed.text
  return { text: text.trim() === '' ? '(no text)' : text, redactions: scrubbed.redactions, hidden_calls: hidden }
}

// ── the brief ──────────────────────────────────────────────────────────────

const BRIEF_TURNS = 4
const BRIEF_TEXT = 700
const BRIEF_OUTPUT = 200

/** The last few turns of the fixture. Never the real outcome, provenance or the `somewhere` phrase. */
export function renderBrief(spec: Pick<FixtureSpec, 'turns'>): string {
  const turns = spec.turns
  const start = Math.max(0, turns.length - BRIEF_TURNS)
  const lines: string[] = []
  for (const turn of turns.slice(start)) {
    lines.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${clip(turn.text.trim(), BRIEF_TEXT)}`)
    if (turn.role === 'assistant') {
      for (const call of turn.tools ?? []) {
        const output = oneLine(call.output)
        lines.push(`  [tool] ${call.tool} ${summarizeInput(call.input)}${output ? ` -> ${clip(output, BRIEF_OUTPUT)}` : ''}`.trimEnd())
      }
    }
  }
  return lines.join('\n')
}

// ── gathering ──────────────────────────────────────────────────────────────

interface Candidate {
  fixture: string
  model: string
  arm: ArmName
  attempt: string
  sha: string
  stdout: string
}

const armKnown = (arm: string): arm is ArmName => (ARM_NAMES as readonly string[]).includes(arm)
const modelRank = (model: string): number => {
  const i = (REPLAY_MODELS as readonly string[]).indexOf(model)
  return i === -1 ? REPLAY_MODELS.length : i
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export interface Gathered {
  candidates: Candidate[]
  appendix: AppendixRow[]
}

/** Counted, completed attempts with passing gates become candidates; every other cell goes to the appendix with its status and reason. */
export function gather(store: Store, campaign: string): Gathered {
  const root = campaignDir(store, campaign)
  const candidates: Candidate[] = []
  const appendix: AppendixRow[] = []
  for (const row of campaignCells(store, campaign)) {
    const off = (status: string, reason: string): void => void appendix.push({ fixture: row.fixture, model: row.model, arm: row.arm, status, reason })
    if (!armKnown(row.arm)) {
      off('unknown_arm', 'not_an_arm')
      continue
    }
    if (!row.counted) {
      off('pending', `last_${row.attempts.at(-1)?.status ?? 'incomplete'}`)
      continue
    }
    const dir = join(cellDir(store, { campaign, fixture: row.fixture, model: row.model, arm: row.arm }), row.counted.id)
    const file = join(dir, 'attempt.json')
    const bytes = readFileSync(file)
    const record = JSON.parse(bytes.toString('utf8')) as AttemptRecord
    if (record.schema_version !== 1) throw new Error(`${relative(root, file)}: unsupported attempt schema_version ${String(record.schema_version)}`)
    if (record.status !== 'completed') {
      off(record.status, record.reasons.join('+') || 'none')
      continue
    }
    if (record.gates?.passed !== true) {
      off('completed', 'gates_not_passed')
      continue
    }
    const stdoutFile = join(dir, 'stdout.jsonl')
    const stdout = existsSync(stdoutFile) ? readFileSync(stdoutFile, 'utf8') : null
    if (stdout === null || sha256(stdout) !== record.artifacts['stdout.jsonl']) throw new Error(`${relative(root, dir)}: stdout.jsonl is missing or no longer matches the hash in attempt.json`)
    candidates.push({ fixture: row.fixture, model: row.model, arm: row.arm, attempt: relative(root, dir), sha: sha256(bytes), stdout })
  }
  return { candidates, appendix }
}

// ── composing ──────────────────────────────────────────────────────────────

interface Moment {
  label: string
  brief: string
  models: { label: string; id: string; answers: { id: string; text: string }[] }[]
}

export function composeSheet(input: { campaign: string; buildId: string; moments: readonly Moment[]; appendix: readonly AppendixRow[] }): string {
  const out: string[] = [
    `# Replay campaign ${input.campaign}: blind labelling sheet`,
    '',
    `build: ${input.buildId}`,
    '',
    'How to fill this in:',
    '',
    '- For each scenario, read the brief, then write the right next move on the `expected:` line **before** you read any answer.',
    '- Each answer ends with a `mark:` line. Replace each `_`. `changed` is `yes` or `no`: does the answer differ from the default next move you would expect from this agent. `direction` is `toward`, `away` or `neutral` against your expected move, and is needed only when `changed=yes`.',
    '- Answers are shuffled and carry no arm label. Tool calls show the tool name and a short input summary.',
    `- A \`${HIDDEN_CALL}\` or \`${HIDDEN}\` marker means text that named the arm was removed. It can hint that a command arm produced the answer. Treat it as a known tell, not evidence.`,
    '- Edit only the `expected:` and `mark:` lines. Do not change the `build:` line, headings or fences.',
    '',
  ]
  for (const moment of input.moments) {
    out.push(`## ${moment.label}`, '', 'Scenario (the last few turns):', '', fenced(moment.brief), '', 'expected: _', '')
    for (const model of moment.models) {
      out.push(`### ${moment.label} · ${model.id}`, '')
      for (const answer of model.answers) out.push(`#### ${answer.id}`, '', fenced(answer.text, 'markdown'), '', 'mark: changed=_ direction=_', '')
    }
  }
  const counts = new Map<string, number>()
  for (const row of input.appendix) counts.set(`${row.status} · ${row.reason}`, (counts.get(`${row.status} · ${row.reason}`) ?? 0) + 1)
  out.push('## Appendix: cells not on this sheet', '')
  if (counts.size === 0) out.push('none')
  else for (const [key, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) out.push(`- ${key}: ${n}`)
  return `${out.join('\n').trimEnd()}\n`
}

// ── building ───────────────────────────────────────────────────────────────

export interface BuildSheetOptions {
  campaign: string
  models?: readonly string[]
  rng?: Rng
  buildId?: string
}

export interface BuiltSheet {
  dir: string
  sheetPath: string
  keyPath: string
  key: SheetKey
  sheet: string
}

const randomBuildId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12)

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Builds the sheet and key under `<store>/sheets/<campaign>/`. A key that already exists is never replaced. */
export function buildSheet(store: Store, options: BuildSheetOptions): BuiltSheet {
  if (!ID_PATTERN.test(options.campaign)) throw new Error('campaign name: expected lowercase letters, digits and hyphens, up to 64 characters')
  const rng = options.rng ?? cryptoRng
  const dir = sheetsDir(store, options.campaign)
  const keyPath = join(dir, 'key.json')
  const sheetPath = join(dir, 'sheet.md')
  if (existsSync(keyPath) || existsSync(sheetPath)) throw new Error(`${dir} already holds a sheet or key; a drawn assignment is never replaced (archive the directory first to redraw)`)

  const all = gather(store, options.campaign)
  if (all.candidates.length === 0 && all.appendix.length === 0) throw new Error(`campaign ${options.campaign}: no cells on disk under ${campaignDir(store, options.campaign)}`)
  const wanted = options.models
  if (wanted) {
    const known = new Set([...all.candidates.map((c) => c.model), ...all.appendix.map((a) => a.model)])
    const unknown = wanted.filter((m) => !known.has(m))
    if (unknown.length > 0) throw new Error(`--models: campaign ${options.campaign} has no cells for ${unknown.join(', ')}`)
  }
  const candidates = wanted ? all.candidates.filter((c) => wanted.includes(c.model)) : all.candidates
  const appendix = wanted ? all.appendix.filter((a) => wanted.includes(a.model)) : all.appendix
  if (candidates.length === 0) throw new Error(`campaign ${options.campaign}: no counted, completed attempts to put on a sheet (${appendix.length} cells are in the appendix)`)

  const models = [...new Set(candidates.map((c) => c.model))].sort((a, b) => modelRank(a) - modelRank(b) || a.localeCompare(b))
  const fixtureIds = shuffle([...new Set(candidates.map((c) => c.fixture))].sort(), rng)
  const fixtures: KeyFixture[] = []
  const moments: Moment[] = []
  const answers: KeyAnswer[] = []
  fixtureIds.forEach((id, i) => {
    const loaded = loadFrozen(store, id)
    const label = `s${String(i + 1).padStart(2, '0')}`
    fixtures.push({ label, id, kind: loaded.spec.kind })
    const moment: Moment = { label, brief: renderBrief(loaded.spec), models: [] }
    models.forEach((model, j) => {
      const cell = candidates.filter((c) => c.fixture === id && c.model === model)
      if (cell.length === 0) return
      const modelLabel = `m${j + 1}`
      const shown: { id: string; text: string }[] = []
      shuffle(cell, rng).forEach((c, k) => {
        const letter = String.fromCharCode(65 + k)
        const answerId = `${label}-${modelLabel}-${letter}`
        const rendered = renderAnswer(parseEvents(c.stdout).events, { somewhere: loaded.spec.somewhere })
        shown.push({ id: answerId, text: rendered.text })
        answers.push({ id: answerId, letter, fixture: id, model, arm: c.arm, attempt: c.attempt, attempt_sha256: c.sha, redactions: rendered.redactions, hidden_calls: rendered.hidden_calls })
      })
      moment.models.push({ label: modelLabel, id: model, answers: shown })
    })
    moments.push(moment)
  })

  const buildId = options.buildId ?? randomBuildId()
  const key: SheetKey = { schema_version: SHEET_SCHEMA_VERSION, build_id: buildId, campaign: options.campaign, created_at: store.now().toISOString(), fixtures, models, answers, appendix }
  const sheet = composeSheet({ campaign: options.campaign, buildId, moments, appendix })

  privateDir(join(store.root, 'sheets'))
  privateDir(dir)
  writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  writeFileSync(sheetPath, sheet, { mode: 0o600, flag: 'wx' })
  return { dir, sheetPath, keyPath, key, sheet }
}
