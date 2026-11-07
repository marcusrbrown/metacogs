/** Reads the marked sheet and the key, applies the noise-floor rule, and writes `summary.json` (counts and ids only). */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isInside, sha256 } from '../../../runner/workspace'
import { ARM_NAMES, type ArmName, REPLAY_MODELS } from './gates'
import { type AttemptRecord, campaignDir } from './run'
import { type KeyAnswer, SHEET_SCHEMA_VERSION, type SheetKey, sheetsDir } from './sheet'
import { ID_PATTERN, type Store } from './store'

export const SUMMARY_SCHEMA_VERSION = 1 as const
/** Phase 2 runs only when at least this many moments qualify. */
export const PHASE2_MIN_QUALIFYING = 3
export const COMMAND_ARMS = ['feel', 'feel-somewhere', 'drugs', 'drugs-caffeine', 'drugs-psilocybin'] as const satisfies readonly ArmName[]
const CONTINUE_ARMS = ['continue-a', 'continue-b'] as const satisfies readonly ArmName[]
const RATE_ARMS = ['whichever', 'nudge-only'] as const satisfies readonly ArmName[]

const isCommandArm = (arm: ArmName): boolean => (COMMAND_ARMS as readonly string[]).includes(arm)
const isContinueArm = (arm: ArmName): boolean => (CONTINUE_ARMS as readonly string[]).includes(arm)

// ── reading the marks ──────────────────────────────────────────────────────

export type Changed = 'yes' | 'no'
export type Direction = 'toward' | 'away' | 'neutral'
const CHANGED: readonly Changed[] = ['yes', 'no']
const DIRECTIONS: readonly Direction[] = ['toward', 'away', 'neutral']

export interface RawMark {
  changed: Changed | null
  direction: Direction | null
  line: number
}

export interface ParsedSheet {
  build_id: string | null
  /** Scenario labels, in order. */
  moments: string[]
  /** Expected-move text by scenario label; `''` when blank. Never leaves this module's caller. */
  expected: Record<string, string>
  /** Answer ids found, in order. */
  answers: string[]
  marks: Record<string, RawMark>
  /** `line N: …` messages for typos and duplicates. */
  errors: string[]
}

const FENCE_OPEN = /^(~{3,})/
const BUILD_LINE = /^build:\s*(\S+)\s*$/
const MOMENT_HEADING = /^## (s\d{2,})\s*$/
const ANSWER_HEADING = /^#### (s\d{2,}-m\d+-[A-Z])\s*$/
const EXPECTED_LINE = /^expected:(.*)$/
const MARK_LINE = /^mark:(.*)$/i
const BLANK = new Set(['', '_'])

function parseMarkBody(body: string, line: number, id: string, errors: string[]): RawMark {
  const mark: RawMark = { changed: null, direction: null, line }
  const seen = new Set<string>()
  for (const token of body.trim().replace(/\s*=\s*/g, '=').split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=')
    const key = eq === -1 ? token : token.slice(0, eq)
    const value = (eq === -1 ? '' : token.slice(eq + 1)).toLowerCase()
    if (key !== 'changed' && key !== 'direction') {
      errors.push(`line ${line}: ${id}: "${token}" is not changed=… or direction=…`)
      continue
    }
    if (seen.has(key)) {
      errors.push(`line ${line}: ${id}: ${key} is given twice`)
      continue
    }
    seen.add(key)
    if (BLANK.has(value)) continue
    if (key === 'changed') {
      if ((CHANGED as readonly string[]).includes(value)) mark.changed = value as Changed
      else errors.push(`line ${line}: ${id}: changed takes yes, no or _ (got "${value}")`)
    } else if ((DIRECTIONS as readonly string[]).includes(value)) mark.direction = value as Direction
    else errors.push(`line ${line}: ${id}: direction takes toward, away, neutral or _ (got "${value}")`)
  }
  return mark
}

/** Reads the build id, the `expected:` lines and the `mark:` lines. Text inside a fence is never a heading or a mark. */
export function parseSheet(sheet: string): ParsedSheet {
  const parsed: ParsedSheet = { build_id: null, moments: [], expected: {}, answers: [], marks: {}, errors: [] }
  let moment: string | undefined
  let current: string | undefined
  let fence = 0
  let inMoments = false
  sheet.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1
    if (fence > 0) {
      if (new RegExp(`^~{${fence},}\\s*$`).test(text)) fence = 0
      return
    }
    const open = FENCE_OPEN.exec(text)
    if (open) {
      fence = open[1]!.length
      return
    }
    if (text.startsWith('## ')) {
      inMoments = true
      current = undefined
      const heading = MOMENT_HEADING.exec(text)
      moment = heading?.[1]
      if (moment) parsed.moments.push(moment)
      return
    }
    if (text.startsWith('### ')) {
      current = undefined
      return
    }
    const build = BUILD_LINE.exec(text)
    if (build && !inMoments && parsed.build_id === null) {
      parsed.build_id = build[1]!
      return
    }
    const answer = ANSWER_HEADING.exec(text)
    if (answer) {
      current = answer[1]!
      if (parsed.answers.includes(current)) parsed.errors.push(`line ${line}: ${current} appears more than once`)
      else parsed.answers.push(current)
      return
    }
    const expected = EXPECTED_LINE.exec(text)
    if (expected && moment !== undefined && current === undefined) {
      if (moment in parsed.expected) parsed.errors.push(`line ${line}: ${moment} has more than one expected line`)
      else parsed.expected[moment] = BLANK.has(expected[1]!.trim()) ? '' : expected[1]!.trim()
      return
    }
    const mark = MARK_LINE.exec(text)
    if (mark && current !== undefined) {
      if (current in parsed.marks) parsed.errors.push(`line ${line}: ${current} has more than one mark line`)
      else parsed.marks[current] = parseMarkBody(mark[1]!, line, current, parsed.errors)
    }
  })
  return parsed
}

// ── refusals ───────────────────────────────────────────────────────────────

export type RefusalKind = 'no_sheet' | 'bad_key' | 'build_mismatch' | 'attempt_changed' | 'bad_marks' | 'missing_answers' | 'unmarked'

export class RevealRefusal extends Error {
  constructor(
    readonly kind: RefusalKind,
    message: string,
  ) {
    super(message)
    this.name = 'RevealRefusal'
  }
}

// ── the summary ────────────────────────────────────────────────────────────

export interface Counted {
  toward: number
  away: number
  neutral: number
  total: number
}

export interface ArmRow {
  arm: ArmName
  model: string
  /** Fixture and model cells with a marked answer for this arm. */
  answers: number
  /** Marked `changed=yes`, counted or not. */
  changed: number
  counted: Counted
  /** Marked `changed=yes` in a cell whose Continue runs were noisy or missing: reported, never counted. */
  uncounted: number
  noisy_cells: number
  no_floor_cells: number
}

export type Floor = 'agree' | 'noisy' | 'no_floor'

export interface FloorRow {
  model: string
  cells: number
  agree: number
  noisy: number
  no_floor: number
}

export interface RateRow {
  arm: (typeof RATE_ARMS)[number]
  model: string
  scope: 'stuck' | 'ordinary'
  /** Completed attempts on the sheet; the rate is taken from `attempt.json` `observed`, not from the marks. */
  attempts: number
  metacogs_tool: number
  skill_only: number
  no_tool: number
}

export interface FixtureRow {
  id: string
  label: string
  kind: string
  models: { model: string; floor: Floor; counted: Counted; uncounted: number }[]
  /** Counted `toward` changes on command arms, over the models whose Continue runs agree. */
  counted_toward_command: number
  qualifying: boolean
}

export interface RevealSummary {
  schema_version: typeof SUMMARY_SCHEMA_VERSION
  campaign: string
  build_id: string
  revealed_at: string
  partial: boolean
  answers: { on_sheet: number; marked: number; excluded_unmarked: number }
  expected_moves: { moments: number; written: number; blank: number }
  appendix: { status: string; reason: string; cells: number }[]
  arms: ArmRow[]
  floor: FloorRow[]
  tool_call_rate: RateRow[]
  fixtures: FixtureRow[]
  ordinary: { arms: ArmRow[]; disruption: { command_answers: number; command_changes: number } }
  phase2: { qualifying: number; needed: number; runs: boolean; ranked: string[] }
}

const zero = (): Counted => ({ toward: 0, away: 0, neutral: 0, total: 0 })
const bump = (c: Counted, d: Direction): void => {
  c[d] += 1
  c.total += 1
}

interface Scored {
  answer: KeyAnswer
  /** `null`: no complete mark. */
  changed: boolean | null
  direction: Direction | null
}

/** A mark is complete with `changed`, and a direction too for a change on any arm but Continue. */
function score(answer: KeyAnswer, raw: RawMark | undefined): Scored {
  if (!raw || raw.changed === null) return { answer, changed: null, direction: null }
  if (raw.changed === 'no') return { answer, changed: false, direction: null }
  if (isContinueArm(answer.arm)) return { answer, changed: true, direction: raw.direction }
  return raw.direction === null ? { answer, changed: null, direction: null } : { answer, changed: true, direction: raw.direction }
}

const armRank = (arm: ArmName): number => ARM_NAMES.indexOf(arm)
const modelRank = (model: string): number => {
  const i = (REPLAY_MODELS as readonly string[]).indexOf(model)
  return i === -1 ? REPLAY_MODELS.length : i
}

export interface TallyInput {
  key: SheetKey
  parsed: ParsedSheet
  /** Per answer id: what the attempt did, from `attempt.json`. */
  outcomes: ReadonlyMap<string, AttemptRecord['outcome']>
  partial: boolean
  now: Date
}

/** The noise-floor rule: a change counts only when both Continue runs of its fixture and model were marked no change. */
export function tally(input: TallyInput): RevealSummary {
  const { key, parsed } = input
  const scored = key.answers.map((a) => score(a, parsed.marks[a.id]))
  const marked = scored.filter((s) => s.changed !== null)
  const kindOf = new Map(key.fixtures.map((f) => [f.id, f.kind]))
  const isOrdinary = (fixture: string): boolean => kindOf.get(fixture) === 'ordinary'

  const cells = new Map<string, Map<ArmName, Scored>>()
  for (const s of marked) {
    const id = `${s.answer.fixture}\0${s.answer.model}`
    cells.set(id, (cells.get(id) ?? new Map()).set(s.answer.arm, s))
  }
  // Cells with an answer on the sheet but no complete mark still need a floor verdict.
  const allCells = new Map<string, { fixture: string; model: string }>()
  for (const a of key.answers) allCells.set(`${a.fixture}\0${a.model}`, { fixture: a.fixture, model: a.model })

  const floorOf = (cell: string): Floor => {
    const arms = cells.get(cell)
    const a = arms?.get('continue-a')
    const b = arms?.get('continue-b')
    if (!a || !b) return 'no_floor'
    return a.changed === false && b.changed === false ? 'agree' : 'noisy'
  }

  type Acc = ArmRow
  const stuck = new Map<string, Acc>()
  const ordinary = new Map<string, Acc>()
  const acc = (store: Map<string, Acc>, arm: ArmName, model: string): Acc => {
    const id = `${arm}\0${model}`
    if (!store.has(id)) store.set(id, { arm, model, answers: 0, changed: 0, counted: zero(), uncounted: 0, noisy_cells: 0, no_floor_cells: 0 })
    return store.get(id)!
  }

  const fixtureModel = new Map<string, { counted: Counted; uncounted: number }>()
  for (const [cell, arms] of cells) {
    const floor = floorOf(cell)
    const [fixture, model] = cell.split('\0') as [string, string]
    const fm = { counted: zero(), uncounted: 0 }
    fixtureModel.set(cell, fm)
    for (const [arm, s] of arms) {
      if (isContinueArm(arm)) continue
      const row = acc(isOrdinary(fixture) ? ordinary : stuck, arm, model)
      row.answers += 1
      if (floor === 'noisy') row.noisy_cells += 1
      if (floor === 'no_floor') row.no_floor_cells += 1
      if (s.changed !== true) continue
      row.changed += 1
      if (floor === 'agree') {
        bump(row.counted, s.direction!)
        bump(fm.counted, s.direction!)
      } else {
        row.uncounted += 1
        fm.uncounted += 1
      }
    }
  }

  const sortRows = (rows: Iterable<Acc>): Acc[] => [...rows].sort((a, b) => armRank(a.arm) - armRank(b.arm) || modelRank(a.model) - modelRank(b.model) || a.model.localeCompare(b.model))

  const models = [...new Set(key.answers.map((a) => a.model))].sort((a, b) => modelRank(a) - modelRank(b) || a.localeCompare(b))
  const floorRows = models.map((model): FloorRow => {
    const mine = [...allCells.entries()].filter(([, c]) => c.model === model).map(([id]) => floorOf(id))
    return { model, cells: mine.length, agree: mine.filter((f) => f === 'agree').length, noisy: mine.filter((f) => f === 'noisy').length, no_floor: mine.filter((f) => f === 'no_floor').length }
  })

  const rates = new Map<string, RateRow>()
  for (const a of key.answers) {
    if (!(RATE_ARMS as readonly string[]).includes(a.arm)) continue
    const scope = isOrdinary(a.fixture) ? 'ordinary' : 'stuck'
    const id = `${a.arm}\0${a.model}\0${scope}`
    if (!rates.has(id)) rates.set(id, { arm: a.arm as RateRow['arm'], model: a.model, scope, attempts: 0, metacogs_tool: 0, skill_only: 0, no_tool: 0 })
    const row = rates.get(id)!
    row.attempts += 1
    const outcome = input.outcomes.get(a.id)
    if (outcome === 'metacogs_tool') row.metacogs_tool += 1
    else if (outcome === 'skill_only') row.skill_only += 1
    else row.no_tool += 1
  }

  const fixtures = key.fixtures.map((f): FixtureRow => {
    const rows = models
      .filter((model) => allCells.has(`${f.id}\0${model}`))
      .map((model) => {
        const cell = `${f.id}\0${model}`
        const fm = fixtureModel.get(cell)
        return { model, floor: floorOf(cell), counted: fm?.counted ?? zero(), uncounted: fm?.uncounted ?? 0 }
      })
    const toward = rows.reduce((n, r) => n + commandToward(cells.get(`${f.id}\0${r.model}`), r.floor), 0)
    return { id: f.id, label: f.label, kind: f.kind, models: rows, counted_toward_command: toward, qualifying: f.kind !== 'ordinary' && toward >= 1 }
  })

  const ranked = fixtures
    .filter((f) => f.qualifying)
    .sort((a, b) => b.counted_toward_command - a.counted_toward_command || a.id.localeCompare(b.id))
    .map((f) => f.id)

  const ordinaryRows = sortRows(ordinary.values())
  const appendixCounts = new Map<string, { status: string; reason: string; cells: number }>()
  for (const row of key.appendix) {
    const id = `${row.status}\0${row.reason}`
    appendixCounts.set(id, { status: row.status, reason: row.reason, cells: (appendixCounts.get(id)?.cells ?? 0) + 1 })
  }
  const written = Object.values(parsed.expected).filter((t) => t !== '').length

  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    campaign: key.campaign,
    build_id: key.build_id,
    revealed_at: input.now.toISOString(),
    partial: input.partial,
    answers: { on_sheet: key.answers.length, marked: marked.length, excluded_unmarked: key.answers.length - marked.length },
    expected_moves: { moments: key.fixtures.length, written, blank: key.fixtures.length - written },
    appendix: [...appendixCounts.values()].sort((a, b) => (a.status + a.reason < b.status + b.reason ? -1 : 1)),
    arms: sortRows(stuck.values()),
    floor: floorRows,
    tool_call_rate: [...rates.values()].sort((a, b) => armRank(a.arm) - armRank(b.arm) || modelRank(a.model) - modelRank(b.model) || a.scope.localeCompare(b.scope)),
    fixtures,
    ordinary: {
      arms: ordinaryRows,
      disruption: {
        command_answers: ordinaryRows.filter((r) => isCommandArm(r.arm)).reduce((n, r) => n + r.answers, 0),
        command_changes: ordinaryRows.filter((r) => isCommandArm(r.arm)).reduce((n, r) => n + r.counted.total, 0),
      },
    },
    phase2: { qualifying: ranked.length, needed: PHASE2_MIN_QUALIFYING, runs: ranked.length >= PHASE2_MIN_QUALIFYING, ranked },
  }
}

function commandToward(arms: Map<ArmName, Scored> | undefined, floor: Floor): number {
  if (!arms || floor !== 'agree') return 0
  return [...arms.values()].filter((s) => isCommandArm(s.answer.arm) && s.changed === true && s.direction === 'toward').length
}

// ── revealing ──────────────────────────────────────────────────────────────

export interface RevealOptions {
  campaign: string
  partial?: boolean
}

export interface Revealed {
  summary: RevealSummary
  summaryPath: string
  lines: string[]
}

const idList = (ids: readonly string[]): string => (ids.length > 12 ? `${ids.slice(0, 12).join(', ')} and ${ids.length - 12} more` : ids.join(', '))

function readKey(path: string, campaign: string): SheetKey {
  let key: SheetKey
  try {
    key = JSON.parse(readFileSync(path, 'utf8')) as SheetKey
  } catch {
    throw new RevealRefusal('bad_key', `${path} is not readable JSON`)
  }
  if (key.schema_version !== SHEET_SCHEMA_VERSION || !Array.isArray(key.answers) || !Array.isArray(key.fixtures) || typeof key.build_id !== 'string') throw new RevealRefusal('bad_key', `${path} is not a replay sheet key`)
  if (key.campaign !== campaign) throw new RevealRefusal('bad_key', `the key is for campaign ${key.campaign}, not ${campaign}`)
  return key
}

/** Refuses on a build-id mismatch or a changed attempt, then on typos and missing marks, and writes `summary.json`. */
export function revealCampaign(store: Store, options: RevealOptions): Revealed {
  if (!ID_PATTERN.test(options.campaign)) throw new Error('campaign name: expected lowercase letters, digits and hyphens, up to 64 characters')
  const dir = sheetsDir(store, options.campaign)
  const keyPath = join(dir, 'key.json')
  const sheetPath = join(dir, 'sheet.md')
  if (!existsSync(keyPath) || !existsSync(sheetPath)) throw new RevealRefusal('no_sheet', `campaign ${options.campaign}: no sheet and key under ${dir}; run sheet first`)
  const key = readKey(keyPath, options.campaign)
  const parsed = parseSheet(readFileSync(sheetPath, 'utf8'))

  if (parsed.build_id !== key.build_id) throw new RevealRefusal('build_mismatch', `the sheet's build id (${parsed.build_id ?? 'none'}) does not match the key's (${key.build_id}); they are from different builds`)

  const root = campaignDir(store, options.campaign)
  const changed: string[] = []
  const outcomes = new Map<string, AttemptRecord['outcome']>()
  for (const a of key.answers) {
    const attemptDir = join(root, a.attempt)
    const file = join(attemptDir, 'attempt.json')
    if (!isInside(attemptDir, root) || !existsSync(file)) {
      changed.push(a.id)
      continue
    }
    const bytes = readFileSync(file)
    if (sha256(bytes) !== a.attempt_sha256) {
      changed.push(a.id)
      continue
    }
    outcomes.set(a.id, (JSON.parse(bytes.toString('utf8')) as AttemptRecord).outcome)
  }
  if (changed.length > 0) throw new RevealRefusal('attempt_changed', `${changed.length} attempt file${changed.length === 1 ? ' is' : 's are'} missing or changed since the sheet was built: ${idList(changed)}`)

  const unknown = parsed.answers.filter((id) => !key.answers.some((a) => a.id === id))
  if (unknown.length > 0) throw new RevealRefusal('bad_marks', `the sheet has answers the key does not: ${idList(unknown)}`)
  if (parsed.errors.length > 0) throw new RevealRefusal('bad_marks', `${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'} in the marks:\n${parsed.errors.join('\n')}`)
  const missing = key.answers.filter((a) => !parsed.answers.includes(a.id)).map((a) => a.id)
  if (missing.length > 0) throw new RevealRefusal('missing_answers', `the sheet is missing ${missing.length} answer${missing.length === 1 ? '' : 's'} the key has: ${idList(missing)}`)

  const unmarked = key.answers.filter((a) => score(a, parsed.marks[a.id]).changed === null).map((a) => a.id)
  const blankExpected = key.fixtures.filter((f) => (parsed.expected[f.label] ?? '') === '').map((f) => f.label)
  if (!options.partial && (unmarked.length > 0 || blankExpected.length > 0)) {
    const parts = [
      ...(unmarked.length > 0 ? [`${unmarked.length} answer${unmarked.length === 1 ? ' is' : 's are'} not marked (or changed=yes has no direction): ${idList(unmarked)}`] : []),
      ...(blankExpected.length > 0 ? [`${blankExpected.length} expected-move line${blankExpected.length === 1 ? ' is' : 's are'} blank: ${idList(blankExpected)}`] : []),
    ]
    throw new RevealRefusal('unmarked', `${parts.join('; ')}. Mark them, or pass --partial to exclude unmarked answers with a count.`)
  }

  const summary = tally({ key, parsed, outcomes, partial: options.partial === true, now: store.now() })
  const summaryPath = join(dir, 'summary.json')
  const temp = `${summaryPath}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, summaryPath)
  return { summary, summaryPath, lines: renderTable(summary) }
}

// ── the table ──────────────────────────────────────────────────────────────

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
  const all = [header, ...rows.map((r) => r.map(String))]
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)))
  return all.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
}

const pair = (n: number, of: number): string => `${n}/${of}`

export function renderTable(s: RevealSummary): string[] {
  const out: string[] = [
    `campaign ${s.campaign} build ${s.build_id}: ${s.answers.marked} of ${s.answers.on_sheet} answers marked${s.partial ? `, ${s.answers.excluded_unmarked} unmarked excluded (--partial)` : ''}; expected moves written for ${s.expected_moves.written} of ${s.expected_moves.moments} scenarios`,
    s.phase2.runs ? `phase 2 runs: ${s.phase2.qualifying} qualifying moments (needs ${s.phase2.needed})` : `phase 2 does not run: ${s.phase2.qualifying} qualifying moments (needs ${s.phase2.needed})`,
    '',
    'Counted changes per arm and model (stuck moments; a change counts only when both Continue runs were marked no change)',
    ...table(
      ['arm', 'model', 'answers', 'changed', 'toward', 'away', 'neutral', 'uncounted', 'noisy', 'no floor', 'reading'],
      s.arms.map((r) => [r.arm, r.model, r.answers, r.changed, r.counted.toward, r.counted.away, r.counted.neutral, r.uncounted, r.noisy_cells, r.no_floor_cells, r.counted.toward === 0 ? 'no measurable benefit' : '']),
    ),
    '',
    'Continue floor per model',
    ...table(['model', 'cells', 'agree', 'noisy', 'no floor'], s.floor.map((f) => [f.model, f.cells, f.agree, f.noisy, f.no_floor])),
  ]
  if (s.tool_call_rate.length > 0) {
    out.push('', 'Tool-call rate (from attempt.json, not the marks)', ...table(['arm', 'model', 'scope', 'metacogs tool', 'skill only', 'no tool'], s.tool_call_rate.map((r) => [r.arm, r.model, r.scope, pair(r.metacogs_tool, r.attempts), pair(r.skill_only, r.attempts), pair(r.no_tool, r.attempts)])))
  }
  out.push('', 'Moments', ...table(['scenario', 'id', 'kind', 'counted toward (command arms)', 'floor per model', 'qualifying'], s.fixtures.map((f) => [f.label, f.id, f.kind, f.counted_toward_command, f.models.map((m) => `${m.model}:${m.floor}`).join(' '), f.qualifying ? 'yes' : 'no'])))
  if (s.ordinary.arms.length > 0) {
    out.push(
      '',
      `Ordinary turns: ${s.ordinary.disruption.command_changes} of ${s.ordinary.disruption.command_answers} command-arm answers changed the next move (disruption); no measurable benefit is expected here`,
      ...table(['arm', 'model', 'answers', 'changed counted', 'uncounted'], s.ordinary.arms.map((r) => [r.arm, r.model, r.answers, r.counted.total, r.uncounted])),
    )
  }
  if (s.appendix.length > 0) out.push('', 'Not on the sheet', ...s.appendix.map((a) => `${a.status} · ${a.reason}: ${a.cells}`))
  return out
}
