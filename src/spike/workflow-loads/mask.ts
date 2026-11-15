/**
 * The hidden view: a walked session's workflow scope rendered so that no trace of a method load remains and no secret or local
 * path survives. Every rule decides from a part's own tool name, input and text, never from where a load happened, so an
 * interval that loaded a method and one that did not are rendered by the same rules and differ only by the dropped call.
 *
 * - Stimuli (user messages, results of decision-bearing tools) and every other tool call are shown with name, input and output.
 * - All assistant prose, text and reasoning, is withheld.
 * - A call of a skill tool naming a method, a read of a method's skill file, and a shell call to the record helper are dropped
 *   whole, from the call's input alone: a failed call and a successful one are treated alike.
 * - Everywhere else each method name and the helper's path become one neutral token.
 * - Each tool output, tool input and stimulus text goes through the scrub rules (`scrub.ts`: the secret scanner's stricter rules and
 *   credential fields such as `password=…`): a text with a finding is replaced and counted, except that a text whose only finding is
 *   an email address keeps its text and loses the addresses. Then path redaction (the current home, then any absolute path), then a
 *   length bound.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { redactPaths } from '../feel-drugs/sheet'
import { assertOutsideRepo, privateDir, writePrivate } from '../feel-drugs/replay/store'
import { assertGate, type GateInput, METHODS } from './declaration'
import { type MethodCall, methodCallOf, nameRegex, type StoredToolUse, toolUseOfPart, type WorkflowSkill, wholeWordRegex } from './loads'
import { EMAIL_ADDRESS, EMAIL_PLACEHOLDER, holdsSecret, inputHoldsSecret, redactAbsolutePaths, SCRUB_PLACEHOLDER, scrubFindings } from './scrub'
import type { ManifestSlot, PrivateRoot, StimulusKind, WalkedEntry, WalkedSession } from './store'

// ── rules ──────────────────────────────────────────────────────────────────

/** The masking rules. Each can be switched off, for the audit's own check that every rule matters; production never does. */
export const MASK_RULES = ['withhold_prose', 'drop_method_skill_calls', 'drop_method_file_reads', 'drop_helper_calls', 'tokenize_names'] as const
export type MaskRule = (typeof MASK_RULES)[number]

export interface MaskOptions {
  /** Rules to switch off. Default none. */
  disable?: readonly MaskRule[]
}

/** The one neutral token that stands for a method name or the record helper's path. */
export const METHOD_TOKEN = '<method>'
export { EMAIL_PLACEHOLDER, SCRUB_PLACEHOLDER }
const TRUNCATION_MARKER = '[… truncated]'

/** The same bounds for every part, whatever tool it came from. Lengths are in characters; `traffic` counts shown tool calls per interval. */
export const RENDER_LIMITS = { stimulus: 4000, input: 1500, output: 2000, traffic: 30 } as const
/** Preceding stimuli shown with a stimulus when a caller does not say. */
export const DEFAULT_CONTEXT = 3

/** A path token ending in the helper's file name. */
const HELPER_PATH = /[^\s"'`<>(),;|&]*record\.mjs/gi

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export { PATH_PLACEHOLDER } from './scrub'

// ── what the view holds ────────────────────────────────────────────────────

export interface RenderedStimulus {
  id: string
  kind: StimulusKind
  /** The stimulus itself: the user message text, or the tool call and result that arrived. */
  text: string
  /** The tool calls of the stimulus's interval, in order, one rendered string per call. */
  traffic: string[]
}

export interface HiddenScope {
  sessionId: string
  /** Position among the session's scopes. */
  scopeIndex: number
  workflow: WorkflowSkill
  stimuli: RenderedStimulus[]
}

/**
 * How many texts the scrub replaced. Counted only over what the view keeps: a dropped call adds nothing, so a counter never
 * tells where a load was.
 */
export interface ViewCounters {
  scrubbedOutputs: number
  scrubbedInputs: number
  scrubbedStimuli: number
  /** Texts kept with their email addresses replaced. */
  redactedEmails: number
}

export interface RenderedSessions {
  scopes: HiddenScope[]
  counters: ViewCounters
}

export interface HiddenView extends RenderedSessions {
  schemaVersion: 1
  declarationHash: string
}

// ── rendering ──────────────────────────────────────────────────────────────

interface Renderer {
  off: ReadonlySet<MaskRule>
  counters: ViewCounters
}


/** The current home first, then any other absolute path. */
const redact = (text: string): string => redactAbsolutePaths(redactPaths(text, { workspaces: [], homes: [] }))

function tokenize(text: string, renderer: Renderer): string {
  if (renderer.off.has('tokenize_names')) return text
  return text.replace(HELPER_PATH, METHOD_TOKEN).replace(nameRegex(), METHOD_TOKEN)
}

type Counter = keyof ViewCounters

/** One escape, from its first backslash. */
const ESCAPE_AT = /\\+(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[/bfnrt"])/y

/** Whether cutting `text` at `cut` would leave part of an escape (`\u00` of `\u0040`) or a backslash that begins one. */
function cutsEscape(text: string, cut: number): boolean {
  if (text[cut - 1] === '\\') return true
  // an escape is at most six characters after its backslashes, so one that spans the cut has a backslash within five characters before it
  for (let start = Math.max(0, cut - 5); start < cut; start++) {
    if (text[start] !== '\\') continue
    ESCAPE_AT.lastIndex = start
    const found = ESCAPE_AT.exec(text)
    if (found && start + found[0].length > cut) return true
  }
  return false
}

/**
 * A text of the view, rendered: scanned, transformed, cut, and checked as the labeler's guard checks what it is sent.
 *
 * - The whole text is scanned and transformed before anything is cut, however little of it is kept: a pattern that needs its closing
 *   context (a quoted value, a token's last segment) is only recognised in full, and no window or tail is a bound for that. What
 *   keeps the cost small is the two bounds that need no window: a text over the hard bound is withheld without being scanned, and
 *   so is one with a line over the line bound (see `SCRUB_LIMITS`).
 * - Scan, then replace addresses, tokenize and redact paths, each followed by the guard: whatever the guard would refuse (an
 *   address that was only written with an escape and so was not replaced, say) withholds the whole text, before it is cut. A cut
 *   never falls inside an escape sequence: the text is withheld instead. The guard is run again after a step unless the text had
 *   no finding and the step left it as it was: the same text gives the same answer.
 * - A kept text ends as the guard accepted it: the guard runs once more on the cut text.
 */
function finish(text: string, counter: Counter, limit: number, renderer: Renderer): string {
  const rules = scrubFindings(text)
  // any finding but an address withholds the whole text, a limit finding included; an address alone only loses the address
  if ([...rules].some((rule) => rule !== 'email')) return withhold(counter, renderer)
  // a text with no finding that a step left as it was needs no second look; one that had a finding (an address) always gets it
  const clean = rules.size === 0
  const refused = (before: string, after: string): boolean => !(clean && after === before) && holdsSecret(after)
  const body = rules.has('email') ? text.replace(EMAIL_ADDRESS, EMAIL_PLACEHOLDER) : text
  if (refused(text, body)) return withhold(counter, renderer)
  const transformed = redact(tokenize(body, renderer))
  if (refused(body, transformed)) return withhold(counter, renderer)
  let out = transformed
  if (transformed.length > limit) {
    let cut = Math.max(0, limit - TRUNCATION_MARKER.length)
    // not between the two halves of a surrogate pair
    const before = transformed.charCodeAt(cut - 1)
    if (before >= 0xd800 && before <= 0xdbff) cut -= 1
    if (cutsEscape(transformed, cut)) return withhold(counter, renderer)
    out = `${transformed.slice(0, cut)}${TRUNCATION_MARKER}`
  }
  if (refused(transformed, out)) return withhold(counter, renderer)
  if (body !== text) renderer.counters.redactedEmails += 1
  return out
}

function withhold(counter: Counter, renderer: Renderer): string {
  renderer.counters[counter] += 1
  return SCRUB_PLACEHOLDER
}

const stringifyInput = (input: unknown): string => {
  if (input === undefined) return ''
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

const DROP_RULE: Record<MethodCall, MaskRule> = { skill_call: 'drop_method_skill_calls', file_read: 'drop_method_file_reads', helper_call: 'drop_helper_calls' }

/** Whether a call is one the view drops, decided from the tool's name and its input only. */
function droppedBy(use: StoredToolUse): MaskRule | null {
  const call = methodCallOf(use)
  return call === null ? null : DROP_RULE[call]
}

/** One tool call as text, or `null` when the view drops it. */
function renderTool(use: StoredToolUse, renderer: Renderer): string | null {
  const rule = droppedBy(use)
  if (rule !== null && !renderer.off.has(rule)) return null
  const status = use.status !== undefined && use.status !== 'completed' ? ` (${use.status})` : ''
  // the structured input is checked before it is serialized: serializing escapes the quotes of JSON text held in a string
  const input = inputHoldsSecret(use.input) ? withhold('scrubbedInputs', renderer) : finish(stringifyInput(use.input), 'scrubbedInputs', RENDER_LIMITS.input, renderer)
  const head = `[tool] ${tokenize(use.storedTool, renderer)}${status}${input === '' ? '' : ` ${input}`}`
  const [label, body] = use.output !== undefined && use.output !== '' ? (['output', use.output] as const) : use.error !== undefined && use.error !== '' ? (['error', use.error] as const) : ([null, ''] as const)
  return label === null ? head : `${head}\n[${label}] ${finish(body, 'scrubbedOutputs', RENDER_LIMITS.output, renderer)}`
}

function parsePart(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** The tool calls and, when prose is not withheld, the prose of an entry's parts, in order. A user message's text is read by `userText`. */
function renderEntry(entry: WalkedEntry, renderer: Renderer): string[] {
  const lines: string[] = []
  for (const part of entry.parts) {
    const use = toolUseOfPart(part)
    if (use) {
      const rendered = renderTool(use, renderer)
      if (rendered !== null) lines.push(rendered)
      continue
    }
    if (renderer.off.has('withhold_prose') && entry.role !== 'user') {
      const data = parsePart(part.data)
      if (data && (data.type === 'text' || data.type === 'reasoning') && typeof data.text === 'string' && data.text.trim() !== '') lines.push(`[assistant] ${finish(data.text, 'scrubbedStimuli', RENDER_LIMITS.output, renderer)}`)
    }
  }
  return lines
}

function userText(entry: WalkedEntry): string {
  const texts: string[] = []
  for (const part of entry.parts) {
    const data = parsePart(part.data)
    if (data?.type === 'text' && typeof data.text === 'string' && data.text.trim() !== '') texts.push(data.text)
  }
  return texts.join('\n\n')
}

/**
 * A rendered piece the labeler's guard would refuse (a tool line built from parts that were each fine, say) is withheld whole. The
 * pieces of a chunk are joined under headings that no key can reach across (`### [...]` follows a blank line, and no separator is
 * `#`), so a chunk of pieces that pass is a chunk that passes.
 */
function sendable(text: string, renderer: Renderer): string {
  return holdsSecret(text) ? withhold('scrubbedStimuli', renderer) : text
}

function renderScope(session: WalkedSession, scopeIndex: number, renderer: Renderer): HiddenScope | null {
  const scope = session.scopes[scopeIndex]
  if (!scope) return null
  const capped = (lines: string[]): string[] =>
    lines.length <= RENDER_LIMITS.traffic ? lines : [...lines.slice(0, RENDER_LIMITS.traffic), `[… ${lines.length - RENDER_LIMITS.traffic} more tool calls not shown]`]
  return {
    sessionId: session.sessionId,
    scopeIndex,
    workflow: scope.workflow,
    stimuli: scope.stimuli.map((stimulus) => {
      const text = stimulus.kind === 'user_message' ? finish(userText(stimulus.entry), 'scrubbedStimuli', RENDER_LIMITS.stimulus, renderer) : renderEntry(stimulus.entry, renderer).join('\n')
      return { id: stimulus.id, kind: stimulus.kind, text: sendable(text, renderer), traffic: capped(stimulus.after.flatMap((entry) => renderEntry(entry, renderer))).map((line) => sendable(line, renderer)) }
    }),
  }
}

/**
 * Renders every scope of the given sessions, one session at a time: a walk read once is enough, and a session's raw rows are not
 * held after its scopes are rendered. Pure and ungated: `buildHiddenView` is the gated entry for real runs.
 */
export function renderSessions(sessions: Iterable<WalkedSession>, options: MaskOptions = {}): RenderedSessions {
  const renderer: Renderer = { off: new Set(options.disable ?? []), counters: { scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 } }
  const scopes: HiddenScope[] = []
  for (const session of sessions) {
    for (const index of session.scopes.keys()) {
      const scope = renderScope(session, index, renderer)
      if (scope) scopes.push(scope)
    }
  }
  return { scopes, counters: renderer.counters }
}

export interface BuildViewInput extends GateInput {
  sessions: Iterable<WalkedSession>
  options?: MaskOptions
}

/** Checks the declaration gate, then renders. Throws `GateRefusal` when the gate fails; nothing is rendered then. */
export function buildHiddenView(input: BuildViewInput): HiddenView {
  const pass = assertGate(input)
  return { schemaVersion: 1, declarationHash: pass.declarationHash, ...renderSessions(input.sessions, input.options) }
}

// ── writing ────────────────────────────────────────────────────────────────

export const viewPath = (privateRoot: PrivateRoot, slot: ManifestSlot): string => join(privateRoot.root, 'views', `view-${slot}.json`)

/** Deletes every stored view and returns how many files that was. Nothing else under the private root is touched. */
export function deleteHiddenViews(privateRoot: PrivateRoot): number {
  const dir = join(privateRoot.root, 'views')
  if (!existsSync(dir)) return 0
  const files = readdirSync(dir).length
  rmSync(dir, { recursive: true, force: true })
  return files
}

/**
 * Writes a built view under the private root, owner-only, replacing an earlier view of the slot (a masking fix rebuilds it). The
 * target must lie outside the repository (`repoRoot` default: this repository); a path inside it throws `CustodyError`
 * before anything is created. Returns the path.
 */
export function writeHiddenView(privateRoot: PrivateRoot, view: HiddenView, options: { slot?: ManifestSlot; repoRoot?: string } = {}): string {
  const path = viewPath(privateRoot, options.slot ?? 'initial')
  assertOutsideRepo(path, options.repoRoot)
  const dir = join(privateRoot.root, 'views')
  privateDir(privateRoot.root)
  privateDir(dir)
  writePrivate(path, `${JSON.stringify(view, null, 2)}\n`)
  return path
}

// ── plain text for the labeler and the judge prompt ────────────────────────

const KIND_LABEL: Record<StimulusKind, string> = { user_message: 'user message', tool_result: 'tool result' }

/** One stimulus as plain text: its id and kind, its text, and the tool calls of its interval. `context` marks one shown only for background. */
export function renderStimulusBlock(stimulus: RenderedStimulus, role: 'stimulus' | 'context'): string {
  const lines = [`### [${role}] ${stimulus.id} · ${KIND_LABEL[stimulus.kind]}`, stimulus.text]
  if (stimulus.traffic.length > 0) lines.push('-- tool calls after this --', ...stimulus.traffic)
  return lines.join('\n')
}

const joinBlocks = (blocks: readonly string[]): string => blocks.join('\n\n')

/** One stimulus with the previous `contextK` stimuli before it, each as its own block, oldest first. */
export function renderWithContext(stimuli: readonly RenderedStimulus[], index: number, contextK = DEFAULT_CONTEXT): string {
  const target = stimuli[index]
  if (!Number.isInteger(index) || target === undefined) throw new RangeError(`no stimulus at index ${index}`)
  const context = stimuli.slice(Math.max(0, index - Math.max(0, contextK)), index)
  return joinBlocks([...context.map((s) => renderStimulusBlock(s, 'context')), renderStimulusBlock(target, 'stimulus')])
}

/**
 * One stimulus with the context the labeler had for it: the chunk's own context stimuli, then the chunk's covered stimuli before it,
 * each as its own block, oldest first. A chunk whose budget trimmed earlier context therefore shows less than `renderWithContext`
 * would, which is what the labeler saw. Throws `RangeError` when the chunk does not cover `stimulusId` or a block is not in `stimuli`.
 */
export function renderForChunk(stimuli: readonly RenderedStimulus[], chunk: Pick<Chunk, 'ids' | 'contextIds'>, stimulusId: string): string {
  const at = chunk.ids.indexOf(stimulusId)
  if (at < 0) throw new RangeError(`the chunk does not cover stimulus ${stimulusId}`)
  const byId = new Map(stimuli.map((s) => [s.id, s]))
  const block = (id: string, role: 'stimulus' | 'context'): string => {
    const found = byId.get(id)
    if (!found) throw new RangeError(`no stimulus ${id} in the scope`)
    return renderStimulusBlock(found, role)
  }
  return joinBlocks([...[...chunk.contextIds, ...chunk.ids.slice(0, at)].map((id) => block(id, 'context')), block(stimulusId, 'stimulus')])
}

// ── chunks ─────────────────────────────────────────────────────────────────

export interface Chunk {
  sessionId: string
  scopeIndex: number
  /** The stimuli this chunk asks about, in order; across a scope's chunks they cover every stimulus once. */
  ids: string[]
  /** Stimuli shown only for background: the ones just before the first covered stimulus, at most the context size. */
  contextIds: string[]
  text: string
  /** The one stimulus the chunk covers is larger than the budget on its own. */
  oversize: boolean
}

/**
 * Splits a scope into chunks of at most `budget` characters. A chunk holds consecutive stimuli whole, with up to `contextK`
 * stimuli before its first as context, so every covered stimulus has its preceding context in the same text. When the budget
 * cannot hold the context and one stimulus, the oldest context goes first; a stimulus too large alone gets its own chunk,
 * flagged `oversize`. A stimulus is never split.
 */
export function chunkScope(scope: HiddenScope, options: { budget: number; contextK?: number }): Chunk[] {
  const { budget } = options
  const contextK = Math.max(0, options.contextK ?? DEFAULT_CONTEXT)
  if (!Number.isInteger(budget) || budget <= 0) throw new RangeError('the chunk budget must be a positive integer')
  const { stimuli } = scope
  const asContext = stimuli.map((s) => renderStimulusBlock(s, 'context'))
  const asCovered = stimuli.map((s) => renderStimulusBlock(s, 'stimulus'))

  const chunks: Chunk[] = []
  let from = 0
  while (from < stimuli.length) {
    let contextFrom = Math.max(0, from - contextK)
    const text = (contextStart: number, to: number): string => joinBlocks([...asContext.slice(contextStart, from), ...asCovered.slice(from, to + 1)])
    let to = from
    while (contextFrom < from && text(contextFrom, to).length > budget) contextFrom += 1
    // a stimulus is added only while the chunk still holds its full preceding context (the K before it, or all of them near the
    // start of the scope) and stays within the budget
    while (to + 1 < stimuli.length && to + 1 - contextFrom >= Math.min(contextK, to + 1) && text(contextFrom, to + 1).length <= budget) to += 1
    const body = text(contextFrom, to)
    chunks.push({
      sessionId: scope.sessionId,
      scopeIndex: scope.scopeIndex,
      ids: stimuli.slice(from, to + 1).map((s) => s.id),
      contextIds: stimuli.slice(contextFrom, from).map((s) => s.id),
      text: body,
      oversize: body.length > budget,
    })
    from = to + 1
  }
  return chunks
}

// ── the leak list and the audit ────────────────────────────────────────────

export type LeakKind = 'method' | 'helper' | 'label'

export interface LeakEntry {
  kind: LeakKind
  text: string
}

/**
 * The labelled lines the two methods ask the agent to write in its reply, from the skill files. Only the distinctive ones:
 * "Observed:" and "Conclusion:" are everyday words in workflow text, so a hit on them would say nothing about a load.
 */
const REPLY_LABELS = ['Premise:', 'Inferred or asserted:', 'If false:', 'Flip test:', 'Perspectives:', 'Shared premise or constraint:', 'Dependence:', 'Alternatives compared:'] as const

/** What no rendered text may contain: the method names, the record helper, and the labelled reply lines. Matched in any case. */
export const LEAK_LIST: readonly LeakEntry[] = [
  ...METHODS.map((text): LeakEntry => ({ kind: 'method', text })),
  { kind: 'helper', text: 'record.mjs' },
  ...REPLY_LABELS.map((text): LeakEntry => ({ kind: 'label', text })),
]

export interface LeakHit {
  kind: LeakKind
  entry: string
}

/** The leak-list entries present in a text, each once. A hit names the entry, never an excerpt. Method names match as whole words, as the masking does. */
export function scanLeaks(text: string): LeakHit[] {
  const lower = text.toLowerCase()
  return LEAK_LIST.filter((entry) => (entry.kind === 'method' ? wholeWordRegex(entry.text).test(text) : lower.includes(entry.text.toLowerCase()))).map(
    (entry): LeakHit => ({ kind: entry.kind, entry: entry.text }),
  )
}

export interface AuditHit extends LeakHit {
  sessionId: string
  stimulusId: string
  /** Where in the rendered stimulus: its text, or its tool traffic. */
  field: 'text' | 'traffic'
}

export interface AuditResult {
  ok: boolean
  hits: AuditHit[]
}

/** Scans already rendered scopes, every stimulus text and tool call, for the leak list. Passes when there is no hit. */
export function auditRendered(scopes: readonly HiddenScope[]): AuditResult {
  const hits: AuditHit[] = []
  for (const scope of scopes) {
    for (const stimulus of scope.stimuli) {
      const fields = [
        ['text', stimulus.text],
        ['traffic', stimulus.traffic.join('\n')],
      ] as const
      for (const [field, text] of fields) for (const hit of scanLeaks(text)) hits.push({ ...hit, sessionId: scope.sessionId, stimulusId: stimulus.id, field })
    }
  }
  return { ok: hits.length === 0, hits }
}

/** Renders the sessions and scans what was rendered. Passes when there is no hit. */
export const auditLeaks = (sessions: Iterable<WalkedSession>, options: MaskOptions = {}): AuditResult => auditRendered(renderSessions(sessions, options).scopes)
