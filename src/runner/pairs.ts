/**
 * The blind pair sheet for a two-arm pilot (`eval pairs --build` / `--reconcile`).
 *
 * `buildPairs` pairs baseline run *i* with skill run *i* for each fixture, draws a random side (X or Y) for each pair, and writes
 * a sheet and a key:
 *
 * - The sheet shows, per fixture, the prompt and the acceptance statement once, then each pair as two anonymised answers. The owner
 *   marks each answer `pass` or `fail` against the statement, then says which of the two they would use (`X`, `Y` or `same`). No run
 *   id, arm, condition, judge verdict or record appears on it.
 * - The key records which side holds which arm, with each run's judge verdict, skill-load fact and check codes. It carries the
 *   campaign id and is never overwritten.
 *
 * Both are written under the state root (mode 0600), never under `evals/`. They quote agent answers.
 *
 * The owner and the judge see the same evidence. `redactJudgeInput` builds what the judge is sent (task, answer, canonical
 * expectation, redacted) and the card shows that text; the build rebuilds the judge payload hash for every run and fails if it
 * differs from the `redacted_input_sha256` the run recorded. The sheet is only partly blind: an answer's own formatting (the
 * skill's labelled lines) can still reveal its side.
 *
 * `reconcilePairs` reads the marked sheet against the key with a strict parser and returns the summary that becomes
 * `evals/<method>/pilot/pair-summary.json`: counts and verdict letters only, never an answer, a quote or a note.
 *
 * `cryptoRng`, `Side`, the strict-marks reader and the refuse-overwrite key follow `src/spike/feel-drugs/blind.ts` and are copied,
 * not imported: this is their second use.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readJudgeRecord } from './judge-record'
import { redactJudgeInput } from './judge'
import { type CampaignRun, JUDGE_BLOCKING_CHECK_CODES, loadCampaignRuns, PILOT_ARMS, type PilotArm } from './manifest'
import { pilotDir, readRejudgeSummary, type RejudgeSummary, vouchedRejudge, verdictUnderContract } from './pilot'
import type { LoadedFixture } from './prereg'
import { wilson95 } from './report'
import { judgedAnswerOf } from './review'
import { sha256, stateRoot } from './workspace'

/** 2: the key carries `build_id`, which the sheet must repeat. A version-1 key is refused. */
export const PAIR_SCHEMA_VERSION = 2 as const
export const PAIR_SUMMARY_FILE = 'pair-summary.json'

export type Side = 'X' | 'Y'
/** A random source in [0, 1). */
export type Rng = () => number
export const cryptoRng: Rng = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32

export type OwnerMark = 'pass' | 'fail'
export type Preference = 'X' | 'Y' | 'same'
/** What the judge said about a run: a verdict, an error, or nothing (it never reached the judge). */
export type JudgeSays = 'pass' | 'fail' | 'judge_error' | 'none'

// ── the key ────────────────────────────────────────────────────────────────

export interface PairRunKey {
  arm: PilotArm
  run_id: string
  judge: JudgeSays
  /** Skill arm: the skill's text reached the model (`fire_basis` is not null); `null` for baseline, and for a manifest without the field. */
  skill_loaded: boolean | null
  /** Codes of the deterministic checks the run failed (recorded, not blocking). */
  check_codes: string[]
  /** The rebuilt judge payload hash. */
  payload_sha256: string
  /** sha256 of the run's `judge.json` as it was when the sheet was built; `null` when it had none. Reconcile re-reads it. */
  judge_json_sha256: string | null
  /** The hash was compared with the hash the run recorded (false: the run recorded none, e.g. it never reached the judge). */
  hash_checked: boolean
}

export interface PairCardKey {
  id: string
  fixture_id: string
  /** The 1-based repetition both runs share. */
  index: number
  sides: Record<Side, PairRunKey>
}

export interface IncompletePair {
  fixture_id: string
  index: number
  /** Per missing arm, why it has no answer to show. */
  missing: { arm: PilotArm; reason: string }[]
}

export interface RunSlotCount {
  runs: number
  answered: number
}

export interface PairKey {
  schema_version: typeof PAIR_SCHEMA_VERSION
  campaign_id: string
  /** 16 random bytes, hex, drawn at build time and printed on the sheet's `Build:` line. A sheet marked for another build is refused. */
  build_id: string
  method: string
  prereg_content_hash: string
  created_at: string
  /** The fixtures in sheet order. */
  fixtures: string[]
  cards: PairCardKey[]
  incomplete: IncompletePair[]
  campaign: {
    /** arm → fixture → run slots (latest attempt each) and how many delivered an answer. */
    slots: Record<string, Record<string, RunSlotCount>>
    /** arm → check code → runs that failed it. */
    check_failures: Record<string, Record<string, number>>
    /** Skill-arm runs that delivered an answer, and how many of them loaded the skill. */
    skill_loaded: { answered: number; loaded: number }
  }
}

// ── evidence ───────────────────────────────────────────────────────────────

const RUN_INDEX = /-r(\d+)(?:-a\d+)?$/

interface Slot {
  fixtureId: string
  arm: PilotArm
  index: number
  run: CampaignRun
}

/** One run per fixture × arm × index: the latest attempt. A retried infra error leaves its earlier attempt on disk. */
function latestSlots(runs: readonly CampaignRun[]): Slot[] {
  const best = new Map<string, Slot>()
  for (const run of runs) {
    const m = run.manifest
    if (m.arm === undefined) throw new Error(`${m.run_id} carries no arm: ${m.campaign_id} is not a pilot campaign`)
    const index = RUN_INDEX.exec(m.run_id)?.[1]
    if (index === undefined) throw new Error(`cannot read the repetition from run id ${m.run_id}`)
    const slot: Slot = { fixtureId: m.fixture.id, arm: m.arm, index: Number(index), run }
    const key = `${slot.fixtureId}\0${slot.arm}\0${slot.index}`
    const held = best.get(key)
    if (held === undefined || m.attempt >= held.run.manifest.attempt) best.set(key, slot)
  }
  return [...best.values()]
}

interface JudgeContext {
  summary: RejudgeSummary | undefined
  /** The pilot prereg's current content hash. */
  contract: string
  judgeModelId: string
  criteria: readonly string[]
}

interface JudgeFor {
  says: JudgeSays
  /** `redacted_input_sha256` that `judge.json` recorded, when it exists. */
  hash: string | null | undefined
  /** sha256 of `judge.json` as it is now, `null` when there is none. */
  fileSha256: string | null
  /** Every way this run's judge record is not bound to the current contract. Empty when it is, and when there is no record. */
  problems: string[]
}

/**
 * What the judge said for a run, once that verdict is bound to the current contract. The verdict comes from the same place the pilot
 * tally takes it (`verdictUnderContract`): a `judge.json` that a rejudge under this prereg content hash vouches for, else the
 * manifest's own recorded evidence. Anything else is a problem, never a silent drop: the manifest made under another prereg; a rejudge
 * row that is not under this prereg, or whose file is not the one it vouched for; another judge model; criteria other than the
 * rubric's. A judge that errored has no criteria to compare. A run with no judge record at all has no verdict and nothing to bind.
 */
function judgeFor(slot: Slot, ctx: JudgeContext): JudgeFor {
  const m = slot.run.manifest
  const path = join(slot.run.dir, 'judge.json')
  const fileText = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const fileSha256 = fileText === undefined ? null : sha256(fileText)
  const hash = fileText === undefined ? undefined : readJudgeRecord(fileText).redacted_input_sha256
  const row = ctx.summary?.rows.get(m.run_id)
  const rejudged = row !== undefined && row.verdict !== 'skipped' && row.judge_json_sha256 !== undefined
  if (m.judge === undefined && fileText === undefined && !rejudged) return { says: 'none', hash, fileSha256, problems: [] }

  const problems: string[] = []
  const bad = (why: string) => problems.push(`${m.run_id}: ${why}`)
  if (m.prereg.content_hash !== ctx.contract) bad(`it was run under prereg ${m.prereg.content_hash.slice(0, 12)}, not the current ${ctx.contract.slice(0, 12)}`)
  let verdicts: readonly { id: string; verdict: string }[] = []
  let errored = false
  let model: string | undefined
  let resolved = false
  if (rejudged) {
    const vouched = vouchedRejudge(ctx.summary, slot.run.dir, m.run_id, ctx.contract)
    if (vouched.ok) {
      ;({ verdicts, errored, model } = vouched)
      resolved = true
    }
    else bad(`it was rejudged, but the rejudge does not bind to the current contract: ${vouched.why}`)
  } else if (m.prereg.content_hash === ctx.contract) {
    const found = verdictUnderContract(ctx.summary, slot.run.dir, m, ctx.contract)
    if (found.ok && m.judge === undefined) bad('its judge.json is not vouched for by a rejudge under the current contract, and the manifest records no judge evidence')
    else if (found.ok) {
      ;({ verdicts, errored, model } = found)
      resolved = true
    }
  }
  if (resolved) {
    if (model !== ctx.judgeModelId) bad(`the verdict is from judge ${model ?? 'unknown'}, not the prereg's ${ctx.judgeModelId}`)
    if (!errored) {
      const ids = verdicts.map((v) => v.id)
      const same = ids.length === ctx.criteria.length && ctx.criteria.every((c) => ids.includes(c)) && new Set(ids).size === ids.length
      if (!same) bad(`its verdict criteria [${ids.join(', ')}] are not exactly the rubric's [${ctx.criteria.join(', ')}]`)
    }
  }
  const says: JudgeSays = errored ? 'judge_error' : verdicts.every((v) => v.verdict === 'pass') ? 'pass' : 'fail'
  return { says, hash, fileSha256, problems }
}

interface Shown {
  slot: Slot
  /** The redacted text the judge read, which the card shows. */
  answer: string
  key: PairRunKey
}

/**
 * Why a slot has nothing to show, or its judged text. Only a `completed` run that reached the judge is shown: a timeout, a budget
 * breach or a host crash is a fail the protocol scores without judging, and a run a check kept from the judge (`unrecognized_events`,
 * `false_fire_*`) has no verdict to compare with. Its pair partner is then incomplete too. A completed run whose judge errored is
 * shown, because the owner can still mark its answer.
 */
function answerOf(slot: Slot): { reason: string } | { text: string } {
  const m = slot.run.manifest
  if (m.status !== 'completed') return { reason: `status ${m.status}` }
  const blocking = m.check_failures.find((f) => (JUDGE_BLOCKING_CHECK_CODES as readonly string[]).includes(f.code))
  if (blocking) return { reason: `blocked by ${blocking.code}` }
  const text = judgedAnswerOf(slot.run.dir, { expectation: true })
  if (text === undefined) return { reason: 'no stdout retained' }
  if (text.trim() === '') return { reason: 'no answer text' }
  return { text }
}

export interface BuildPairsInput {
  campaignDir: string
  /** The prereg's verified dev fixtures, each with its expectation. */
  fixtures: readonly LoadedFixture[]
  /** The judge's redaction (`redactOrThrow` over the content directory's `redact.json`); throws if a token survives. */
  redactText: (text: string) => string
  preregContentHash: string
  /** The prereg's `judge_model_id`: every shown verdict must come from this judge. */
  judgeModelId: string
  /** The rubric's declared judge criterion ids: every shown verdict must carry exactly these. */
  criteria: readonly string[]
  /** The rubric declares `expectation: true`. The sheet is the statement-plus-answer view of that contract; without it there is no statement. */
  declared: boolean
  rng?: Rng
  now?: Date
  /** Test seam; default 16 random bytes, hex. */
  buildId?: string
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1
}

export function buildPairs(input: BuildPairsInput): { sheet: string; key: PairKey } {
  if (!input.declared) throw new Error('the rubric does not declare expectation: true; a pair sheet shows the acceptance statement, so there is nothing to show')
  const rng = input.rng ?? cryptoRng
  const runs = loadCampaignRuns(input.campaignDir)
  if (runs.length === 0) throw new Error(`no run manifests in ${input.campaignDir}`)
  const campaigns = new Set(runs.map((r) => r.manifest.campaign_id))
  const methods = new Set(runs.map((r) => r.manifest.method))
  if (campaigns.size !== 1 || methods.size !== 1) throw new Error(`${input.campaignDir} holds more than one campaign or method`)
  const campaignId = [...campaigns][0]!
  const method = [...methods][0]!
  const slots = latestSlots(runs)

  const fixtureIds = [...new Set(slots.map((s) => s.fixtureId))].sort()
  const arms = [...new Set(slots.map((s) => s.arm))]
  if (!arms.includes('baseline') || !arms.includes('skill')) throw new Error(`a pair sheet needs both arms; ${campaignId} has ${arms.join(', ')}`)

  const judgeCtx: JudgeContext = { summary: readRejudgeSummary(input.campaignDir), contract: input.preregContentHash, judgeModelId: input.judgeModelId, criteria: input.criteria }
  const problems: string[] = []
  const summary: PairKey['campaign'] = { slots: {}, check_failures: {}, skill_loaded: { answered: 0, loaded: 0 } }
  const shown = new Map<string, Shown>()
  const missing = new Map<string, { arm: PilotArm; reason: string }[]>()
  const pairKey = (fixtureId: string, index: number) => `${fixtureId}\0${index}`

  for (const slot of slots) {
    const m = slot.run.manifest
    const cell = ((summary.slots[slot.arm] ??= {})[slot.fixtureId] ??= { runs: 0, answered: 0 })
    cell.runs += 1
    for (const f of m.check_failures) bump((summary.check_failures[slot.arm] ??= {}), f.code)
    const answer = answerOf(slot)
    if ('reason' in answer) {
      const list = missing.get(pairKey(slot.fixtureId, slot.index)) ?? []
      list.push({ arm: slot.arm, reason: answer.reason })
      missing.set(pairKey(slot.fixtureId, slot.index), list)
      continue
    }
    cell.answered += 1
    const skillLoaded = slot.arm === 'skill' && m.fire_basis !== undefined ? m.fire_basis !== null : null
    if (slot.arm === 'skill') {
      summary.skill_loaded.answered += 1
      if (skillLoaded === true) summary.skill_loaded.loaded += 1
    }

    const fixture = input.fixtures.find((f) => f.id === slot.fixtureId)
    if (fixture === undefined) throw new Error(`${m.run_id} ran fixture ${slot.fixtureId}, which the prereg does not have`)
    if (fixture.hash !== m.fixture.hash) throw new Error(`${m.run_id}: fixture ${fixture.id} changed since the run`)
    if (fixture.expectation === undefined) throw new Error(`fixture ${fixture.id} has no verified expectation`)
    // The judge's own function builds the evidence; a different hash means the card would show other text than the judge read.
    const payload = redactJudgeInput({ fixtureText: fixture.text, answer: answer.text, declared: true, expectation: fixture.expectation }, input.redactText)
    const judged = judgeFor(slot, judgeCtx)
    problems.push(...judged.problems)
    const recorded = [m.judge?.redacted_input_sha256, judged.hash].filter((h): h is string => typeof h === 'string')
    for (const hash of recorded) {
      if (hash !== payload.sha256) throw new Error(`${m.run_id}: the judged text does not match what the judge was sent (rebuilt ${payload.sha256.slice(0, 12)}, recorded ${hash.slice(0, 12)}); the sheet would not show the judge's evidence`)
    }
    shown.set(`${pairKey(slot.fixtureId, slot.index)}\0${slot.arm}`, {
      slot,
      answer: payload.answer,
      key: {
        arm: slot.arm,
        run_id: m.run_id,
        judge: judged.says,
        skill_loaded: skillLoaded,
        check_codes: m.check_failures.map((f) => f.code),
        payload_sha256: payload.sha256,
        judge_json_sha256: judged.fileSha256,
        hash_checked: recorded.length > 0,
      },
    })
  }

  // A verdict not bound to the current contract is never shown, and never dropped quietly: the build stops and names every such run.
  if (problems.length) throw new PairSheetError(problems)

  // Pairs: both arms shown. Anything else is incomplete and reported, not shown.
  const incomplete: IncompletePair[] = []
  const complete = new Map<string, { fixtureId: string; index: number; baseline: Shown; skill: Shown }[]>()
  const pairs = new Set(slots.map((s) => pairKey(s.fixtureId, s.index)))
  for (const k of [...pairs].sort()) {
    const [fixtureId, index] = k.split('\0') as [string, string]
    const baseline = shown.get(`${k}\0baseline`)
    const skill = shown.get(`${k}\0skill`)
    if (baseline && skill) {
      const list = complete.get(fixtureId) ?? []
      list.push({ fixtureId, index: Number(index), baseline, skill })
      complete.set(fixtureId, list)
      continue
    }
    const gaps = missing.get(k) ?? []
    for (const arm of ['baseline', 'skill'] as const) {
      if (!shown.has(`${k}\0${arm}`) && !gaps.some((g) => g.arm === arm)) gaps.push({ arm, reason: 'no run' })
    }
    incomplete.push({ fixture_id: fixtureId, index: Number(index), missing: gaps.sort((a, b) => (a.arm < b.arm ? -1 : 1)) })
  }

  const cards: PairCardKey[] = []
  const groups: { fixtureId: string; cards: PairCardKey[]; answers: Record<string, Record<Side, string>> }[] = []
  let n = 0
  for (const fixtureId of fixtureIds) {
    const pairsOfFixture = shuffled((complete.get(fixtureId) ?? []).sort((a, b) => a.index - b.index), rng)
    if (pairsOfFixture.length === 0) continue
    const group: (typeof groups)[number] = { fixtureId, cards: [], answers: {} }
    for (const p of pairsOfFixture) {
      const skillOnX = rng() < 0.5
      const x = skillOnX ? p.skill : p.baseline
      const y = skillOnX ? p.baseline : p.skill
      n += 1
      const card: PairCardKey = { id: `card-${String(n).padStart(2, '0')}`, fixture_id: fixtureId, index: p.index, sides: { X: x.key, Y: y.key } }
      group.cards.push(card)
      group.answers[card.id] = { X: x.answer, Y: y.answer }
      cards.push(card)
    }
    groups.push(group)
  }
  if (cards.length === 0) throw new Error(`${campaignId} has no complete pair to show`)

  const key: PairKey = {
    schema_version: PAIR_SCHEMA_VERSION,
    campaign_id: campaignId,
    build_id: input.buildId ?? randomBytes(16).toString('hex'),
    method,
    prereg_content_hash: input.preregContentHash,
    created_at: (input.now ?? new Date()).toISOString(),
    fixtures: groups.map((g) => g.fixtureId),
    cards,
    incomplete,
    campaign: summary,
  }

  const prompts = new Map<string, { prompt: string; statement: string }>()
  for (const g of groups) {
    const fixture = input.fixtures.find((f) => f.id === g.fixtureId)!
    if (fixture.expectation === undefined) throw new Error(`fixture ${fixture.id} has no verified expectation`)
    const payload = redactJudgeInput({ fixtureText: fixture.text, answer: '-', declared: true, expectation: fixture.expectation }, input.redactText)
    prompts.set(g.fixtureId, { prompt: payload.task, statement: (JSON.parse(payload.expectation!) as { outcome: string }).outcome })
  }
  const sheet = renderSheet(key, groups, prompts)
  assertSheetMatchesKey(sheet, key)
  return { sheet, key }
}

// ── the sheet ──────────────────────────────────────────────────────────────

/**
 * A `~~~` fenced block whose fence is longer than any run of `~` or backticks in the text, so nothing inside it (an answer's own
 * code fences, `#` lines, a stray `~~~`) can close it or reach the sheet's outline.
 */
function tildeFenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/[`~]+/g) ?? []).map((m) => m.length))
  const fence = '~'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text}\n${fence}`
}

const quoted = (text: string): string[] => text.trimEnd().split('\n').map((l) => `> ${l}`)

function renderSheet(
  key: PairKey,
  groups: readonly { fixtureId: string; cards: readonly PairCardKey[]; answers: Record<string, Record<Side, string>> }[],
  prompts: ReadonlyMap<string, { prompt: string; statement: string }>,
): string {
  const out = [
    `# Pair sheet: ${key.campaign_id}`,
    '',
    `Campaign: ${key.campaign_id}`,
    `Build: ${key.build_id}`,
    'Started:',
    'Finished:',
    '',
    'Local only: this file quotes agent answers. Write the time you start and finish above (for example `2026-11-02 09:30`).',
    '',
    `${key.cards.length} cards in ${groups.length} fixtures. Each fixture shows its prompt and its **statement** once. Each card then shows two answers, X and Y.`,
    '',
    '1. Read both answers. For each, decide whether it satisfies the statement as written: put `pass` or `fail` on its `Mark` line. A paraphrase of the statement passes. Judge the statement, not the style.',
    '2. Then answer: which of the two would you use for this decision? Put `X`, `Y` or `same` on the `Use` line.',
    '3. If a mark needed your interpretation (the statement did not settle it), say so on the `note:` line. Leave `note:` empty otherwise.',
    '',
    'Every mark line must be filled in. A blank, repeated or unreadable mark stops the reconcile and names the card.',
    '',
    'Answers are shown exactly as a judge read them: all of the assistant text, with some terms replaced by `[redacted]`. Paths are not redacted. This sheet is only partly blind: how an answer is laid out can still hint at where it came from, and `[redacted]` placeholders mostly replace skill vocabulary, so a placeholder can hint that an answer came from the skill arm.',
    '',
  ]
  for (const g of groups) {
    const p = prompts.get(g.fixtureId)!
    out.push(`# Fixture: ${g.fixtureId}`, '', 'Prompt:', '', ...quoted(p.prompt), '', 'Statement (an answer passes if it satisfies this):', '', ...quoted(p.statement), '')
    for (const card of g.cards) {
      out.push(`## ${card.id}`, '')
      for (const side of ['X', 'Y'] as const) out.push(`### ${side}`, '', tildeFenced(g.answers[card.id]![side], 'markdown'), '')
      out.push('Mark X:', 'Mark Y:', 'Use:', 'note:', '')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

// ── reading the marks ──────────────────────────────────────────────────────

/** The sheet could not be read as a complete set of marks for the key. Every problem is named. */
export class PairSheetError extends Error {
  constructor(readonly problems: string[]) {
    super(`the sheet cannot be reconciled:\n- ${problems.join('\n- ')}`)
    this.name = 'PairSheetError'
  }
}

/** The sheet or key belongs to another campaign, or the key already exists. */
export class PairRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairRefusal'
  }
}

export interface ParsedCard {
  id: string
  markX: string[]
  markY: string[]
  use: string[]
  note: string[]
}

export interface ParsedSheet {
  campaign: string[]
  build: string[]
  started: string[]
  finished: string[]
  cards: ParsedCard[]
}

const FENCE_OPEN = /^(~{3,})/
const CARD_HEADING = /^## (card-\d+)\s*$/
const FIELD = /^(Campaign|Build|Started|Finished|Mark X|Mark Y|Use|note):(.*)$/i

/** Reads the header and the mark lines of every card. Text inside a fenced answer is never a heading or a mark. */
export function parseSheet(sheet: string): ParsedSheet {
  const parsed: ParsedSheet = { campaign: [], build: [], started: [], finished: [], cards: [] }
  let current: ParsedCard | undefined
  let fence = 0
  for (const line of sheet.split(/\r?\n/)) {
    if (fence > 0) {
      if (new RegExp(`^~{${fence},}\\s*$`).test(line)) fence = 0
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      fence = open[1]!.length
      continue
    }
    const heading = CARD_HEADING.exec(line)
    if (heading) {
      current = { id: heading[1]!, markX: [], markY: [], use: [], note: [] }
      parsed.cards.push(current)
      continue
    }
    // A fixture heading ends the card above it.
    if (/^# /.test(line)) {
      current = undefined
      continue
    }
    const field = FIELD.exec(line)
    if (!field) continue
    const name = field[1]!.toLowerCase()
    const value = field[2]!.trim()
    if (name === 'campaign' || name === 'build' || name === 'started' || name === 'finished') {
      if (current === undefined) parsed[name].push(value)
    } else if (current !== undefined) {
      if (name === 'mark x') current.markX.push(value)
      else if (name === 'mark y') current.markY.push(value)
      else if (name === 'use') current.use.push(value)
      else current.note.push(value)
    }
  }
  return parsed
}

/** The key and the sheet agree on the cards: same ids, same count. Throws a `PairSheetError` naming the difference. */
export function assertSheetMatchesKey(sheet: string, key: PairKey): void {
  const ids = parseSheet(sheet).cards.map((c) => c.id)
  const problems: string[] = []
  const expected = key.cards.map((c) => c.id)
  if (ids.length !== expected.length) problems.push(`the sheet has ${ids.length} cards, the key has ${expected.length}`)
  for (const id of expected) if (!ids.includes(id)) problems.push(`${id} is in the key and not on the sheet`)
  for (const id of ids) if (!expected.includes(id)) problems.push(`${id} is on the sheet and not in the key`)
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`${id} appears more than once on the sheet`)
  if (problems.length) throw new PairSheetError(problems)
}

export interface CardMarks {
  id: string
  X: OwnerMark
  Y: OwnerMark
  use: Preference
  note: string
}

export interface ReadMarks {
  cards: CardMarks[]
  started: string | undefined
  finished: string | undefined
}

function oneOf<T extends string>(values: readonly string[], allowed: readonly T[], label: string, id: string, problems: string[]): T | undefined {
  if (values.length === 0) {
    problems.push(`${id}: no ${label} line`)
    return undefined
  }
  if (values.length > 1) {
    problems.push(`${id}: more than one ${label} line`)
    return undefined
  }
  const raw = values[0]!
  if (raw === '') {
    problems.push(`${id}: ${label} is blank`)
    return undefined
  }
  const hit = allowed.find((a) => a.toLowerCase() === raw.toLowerCase())
  if (hit === undefined) problems.push(`${id}: ${label} "${raw}" is not ${allowed.join(', ').replace(/, ([^,]*)$/, ' or $1')}`)
  return hit
}

/**
 * The strict reader: every card of the key needs one `Mark X`, one `Mark Y` (pass or fail) and one `Use` (X, Y or same). A blank,
 * repeated or unreadable mark, an unknown or missing card, or a sheet from another campaign is an error naming the card. Nothing is
 * dropped silently.
 */
export function readMarks(sheet: string, key: PairKey): ReadMarks {
  const parsed = parseSheet(sheet)
  if (parsed.campaign.length !== 1) throw new PairRefusal(`the sheet names ${parsed.campaign.length === 0 ? 'no campaign' : 'more than one campaign'} on its Campaign line; it is not a sheet for ${key.campaign_id}`)
  if (parsed.campaign[0] !== key.campaign_id) throw new PairRefusal(`the sheet is for campaign ${parsed.campaign[0]}, the key is for ${key.campaign_id}`)
  // The campaign id alone cannot tell two builds of one campaign apart, and a rebuild can draw the same card ids.
  if (parsed.build.length !== 1 || parsed.build[0] !== key.build_id) {
    throw new PairSheetError([
      parsed.build.length === 0
        ? 'the sheet has no Build line, so it is from another build (or an older one) than the key; mark the sheet this key was built with'
        : parsed.build.length > 1
          ? 'the sheet has more than one Build line; it is from another build than the key'
          : `the sheet is from another build (sheet ${parsed.build[0]!.slice(0, 12)}, key ${key.build_id.slice(0, 12)}); mark the sheet this key was built with, or rebuild`,
    ])
  }
  const problems: string[] = []
  try {
    assertSheetMatchesKey(sheet, key)
  } catch (e) {
    if (!(e instanceof PairSheetError)) throw e
    problems.push(...e.problems)
  }
  for (const label of ['Started', 'Finished'] as const) {
    const values = parsed[label.toLowerCase() as 'started' | 'finished']
    if (values.length > 1) problems.push(`more than one ${label} line`)
    else if (values[0] !== undefined && values[0] !== '' && Number.isNaN(Date.parse(values[0]))) problems.push(`${label} "${values[0]}" is not a date and time`)
  }
  const cards: CardMarks[] = []
  for (const id of key.cards.map((c) => c.id)) {
    const card = parsed.cards.find((c) => c.id === id)
    if (card === undefined) continue
    const x = oneOf(card.markX, ['pass', 'fail'] as const, 'Mark X', id, problems)
    const y = oneOf(card.markY, ['pass', 'fail'] as const, 'Mark Y', id, problems)
    const use = oneOf(card.use, ['X', 'Y', 'same'] as const, 'Use', id, problems)
    if (card.note.length > 1) problems.push(`${id}: more than one note: line`)
    if (x !== undefined && y !== undefined && use !== undefined) cards.push({ id, X: x, Y: y, use, note: card.note[0] ?? '' })
  }
  if (problems.length) throw new PairSheetError(problems)
  const clean = (v: string | undefined) => (v === undefined || v === '' ? undefined : v)
  return { cards, started: clean(parsed.started[0]), finished: clean(parsed.finished[0]) }
}

// ── reconcile ──────────────────────────────────────────────────────────────

export interface PairCell {
  pass: number
  graded: number
}

export interface Disagreement {
  fixture_id: string
  index: number
  arm: PilotArm
  judge: 'pass' | 'fail'
  owner: OwnerMark
  /** The owner left a note on this card. The note's text is not part of the summary. */
  noted: boolean
}

export interface PairSummary {
  schema_version: typeof PAIR_SCHEMA_VERSION
  method: string
  campaign_id: string
  prereg_content_hash: string
  pairs: { shown: number; incomplete: number; incomplete_detail: IncompletePair[] }
  owner: {
    /** arm → fixture → the owner's pass count over the answers marked. */
    by_arm_fixture: Record<string, Record<string, PairCell>>
    pooled: Record<string, PairCell>
  }
  judge_vs_owner: {
    /** Answers with a judge pass or fail, by the judge's verdict then the owner's mark. */
    table: { judge_pass_owner_pass: number; judge_pass_owner_fail: number; judge_fail_owner_pass: number; judge_fail_owner_fail: number }
    /** Answers in the table. */
    n: number
    /** Answers where the judge and the owner agree. */
    agree: number
    rate: number | null
    wilson95: [number, number] | null
    /** Marked answers left out of the table: the judge errored or never reached them. */
    without_judge_verdict: number
    disagreements: Disagreement[]
  }
  /** From the skill's side: wins = the owner would use the skill's answer, losses = the baseline's. */
  preference: { wins: number; losses: number; ties: number; net: number }
  review: {
    /** Finished minus started, in minutes; `null` when either time is missing. */
    minutes: number | null
    /** Cards whose marks the owner flagged as needing interpretation. */
    noted: { fixture_id: string; index: number }[]
  }
  campaign: PairKey['campaign']
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000
const rank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export interface Reconciled {
  summary: PairSummary
  /** For the terminal only: the disagreements with the owner's notes. Never written to the summary. */
  notes: { fixture_id: string; index: number; arm: PilotArm; judge: 'pass' | 'fail'; owner: OwnerMark; note: string }[]
}

/**
 * The key records each shown run's `judge.json` hash at build time. A rejudge after the build rewrites those files, so the judge
 * column of the four-cell table would no longer be the verdict the owner's sheet was built beside. Refuses, naming every run whose
 * file changed, appeared or vanished.
 */
export function verifyJudgeFiles(key: PairKey, campaignDir: string): void {
  const problems: string[] = []
  for (const card of key.cards) {
    for (const side of ['X', 'Y'] as const) {
      const run = card.sides[side]
      const path = join(campaignDir, run.run_id, 'judge.json')
      const now = existsSync(path) ? sha256(readFileSync(path, 'utf8')) : null
      if (now === run.judge_json_sha256) continue
      const what = run.judge_json_sha256 === null ? 'a judge.json appeared' : now === null ? 'its judge.json vanished' : 'its judge.json was rewritten'
      problems.push(`${run.run_id}: ${what} after the sheet was built (a rejudge?); rebuild the sheet after a rejudge, so the judge verdicts match the answers shown`)
    }
  }
  if (problems.length) throw new PairSheetError(problems)
}

export interface ReconcileOptions {
  /** The campaign directory the key was built from. When given, the shown runs' `judge.json` files are re-read (`verifyJudgeFiles`); `eval pairs --reconcile` always gives it. */
  campaignDir?: string
}

export function reconcilePairs(key: PairKey, sheet: string, options: ReconcileOptions = {}): Reconciled {
  if (options.campaignDir !== undefined) verifyJudgeFiles(key, options.campaignDir)
  const marks = readMarks(sheet, key)
  const byArmFixture: Record<string, Record<string, PairCell>> = {}
  const pooled: Record<string, PairCell> = Object.fromEntries(PILOT_ARMS.map((arm) => [arm, { pass: 0, graded: 0 }]))
  const table = { judge_pass_owner_pass: 0, judge_pass_owner_fail: 0, judge_fail_owner_pass: 0, judge_fail_owner_fail: 0 }
  const disagreements: Disagreement[] = []
  const notes: Reconciled['notes'] = []
  const noted: PairSummary['review']['noted'] = []
  let withoutVerdict = 0
  let wins = 0
  let losses = 0
  let ties = 0

  for (const card of key.cards) {
    const m = marks.cards.find((c) => c.id === card.id)!
    for (const side of ['X', 'Y'] as const) {
      const run = card.sides[side]
      const owner = m[side]
      const cell = ((byArmFixture[run.arm] ??= {})[card.fixture_id] ??= { pass: 0, graded: 0 })
      cell.graded += 1
      pooled[run.arm]!.graded += 1
      if (owner === 'pass') {
        cell.pass += 1
        pooled[run.arm]!.pass += 1
      }
      if (run.judge === 'pass' || run.judge === 'fail') {
        table[`judge_${run.judge}_owner_${owner}`] += 1
        if (run.judge !== owner) {
          disagreements.push({ fixture_id: card.fixture_id, index: card.index, arm: run.arm, judge: run.judge, owner, noted: m.note !== '' })
          notes.push({ fixture_id: card.fixture_id, index: card.index, arm: run.arm, judge: run.judge, owner, note: m.note })
        }
      } else {
        withoutVerdict += 1
      }
    }
    if (m.note !== '') noted.push({ fixture_id: card.fixture_id, index: card.index })
    if (m.use === 'same') ties += 1
    else if (card.sides[m.use].arm === 'skill') wins += 1
    else losses += 1
  }

  const n = table.judge_pass_owner_pass + table.judge_pass_owner_fail + table.judge_fail_owner_pass + table.judge_fail_owner_fail
  const agree = table.judge_pass_owner_pass + table.judge_fail_owner_fail
  const sortKey = (d: { fixture_id: string; index: number; arm: string }) => `${d.fixture_id}\0${String(d.index).padStart(4, '0')}\0${d.arm}`
  const started = marks.started === undefined ? undefined : Date.parse(marks.started)
  const finished = marks.finished === undefined ? undefined : Date.parse(marks.finished)
  const minutes = started !== undefined && finished !== undefined ? Math.round(((finished - started) / 60_000) * 10) / 10 : null

  const summary: PairSummary = {
    schema_version: PAIR_SCHEMA_VERSION,
    method: key.method,
    campaign_id: key.campaign_id,
    prereg_content_hash: key.prereg_content_hash,
    pairs: { shown: key.cards.length, incomplete: key.incomplete.length, incomplete_detail: key.incomplete },
    owner: {
      by_arm_fixture: Object.fromEntries(Object.entries(byArmFixture).map(([arm, fixtures]) => [arm, Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => rank(a, b)))])),
      pooled,
    },
    judge_vs_owner: {
      table,
      n,
      agree,
      rate: n === 0 ? null : round4(agree / n),
      wilson95: n === 0 ? null : wilson95(agree, n),
      without_judge_verdict: withoutVerdict,
      disagreements: disagreements.sort((a, b) => rank(sortKey(a), sortKey(b))),
    },
    preference: { wins, losses, ties, net: wins - losses },
    review: { minutes, noted: noted.sort((a, b) => rank(`${a.fixture_id}\0${a.index}`, `${b.fixture_id}\0${b.index}`)) },
    campaign: key.campaign,
  }
  return { summary, notes: notes.sort((a, b) => rank(sortKey(a), sortKey(b))) }
}

/** Human-readable lines for the terminal; the only place the owner's notes are repeated. */
export function summarizePairs({ summary, notes }: Reconciled): string[] {
  const j = summary.judge_vs_owner
  const cellOf = (c: PairCell | undefined) => (c ? `${c.pass}/${c.graded}` : '-')
  const fixtures = [...new Set(Object.values(summary.owner.by_arm_fixture).flatMap((f) => Object.keys(f)))].sort()
  const lines = [
    `campaign ${summary.campaign_id}: ${summary.pairs.shown} pairs marked, ${summary.pairs.incomplete} incomplete`,
    `owner passes (pass/answers marked): ${PILOT_ARMS.map((arm) => `${arm} ${cellOf(summary.owner.pooled[arm])}`).join(' · ')}`,
    ...fixtures.map((f) => `  ${f}: ${PILOT_ARMS.map((arm) => `${arm} ${cellOf(summary.owner.by_arm_fixture[arm]?.[f])}`).join(' · ')}`),
    `judge vs owner (${j.n} answers with a judge verdict, ${j.without_judge_verdict} without):`,
    `              owner pass  owner fail`,
    `  judge pass  ${String(j.table.judge_pass_owner_pass).padStart(10)}  ${String(j.table.judge_pass_owner_fail).padStart(10)}`,
    `  judge fail  ${String(j.table.judge_fail_owner_pass).padStart(10)}  ${String(j.table.judge_fail_owner_fail).padStart(10)}`,
    `  agreement ${j.agree}/${j.n}${j.rate === null ? '' : ` = ${j.rate} (Wilson 95%: ${j.wilson95![0]}–${j.wilson95![1]})`}`,
    `preference (skill's side): ${summary.preference.wins} wins · ${summary.preference.losses} losses · ${summary.preference.ties} ties · net ${summary.preference.net >= 0 ? '+' : ''}${summary.preference.net}`,
    `review time: ${summary.review.minutes === null ? 'not recorded' : `${summary.review.minutes} min`} · cards with a note: ${summary.review.noted.length}`,
  ]
  if (notes.length) {
    lines.push('disagreements:')
    for (const d of notes) lines.push(`  ${d.fixture_id} #${d.index} ${d.arm}: judge ${d.judge}, owner ${d.owner}${d.note ? ` — ${d.note}` : ''}`)
  }
  for (const i of summary.pairs.incomplete_detail) lines.push(`incomplete: ${i.fixture_id} #${i.index}: ${i.missing.map((m) => `${m.arm} (${m.reason})`).join(', ')}`)
  return lines
}

// ── files ──────────────────────────────────────────────────────────────────

/** Where a campaign's sheet and key live: under the state root, never under `evals/`. */
export const pairsDir = (env: Record<string, string | undefined>, campaignId: string): string => join(stateRoot(env), 'pairs', campaignId)

/** Writes `sheet.md` and `key.json` (0600). Refuses if either exists: a drawn assignment is never replaced. */
export function writePairFiles(dir: string, built: { sheet: string; key: PairKey }): { sheet: string; key: string } {
  const sheet = join(dir, 'sheet.md')
  const key = join(dir, 'key.json')
  if (existsSync(key) || existsSync(sheet)) throw new PairRefusal(`${dir} already holds a sheet or a key; a drawn assignment is never replaced`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(key, `${JSON.stringify(built.key, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  writeFileSync(sheet, built.sheet, { mode: 0o600, flag: 'wx' })
  return { sheet, key }
}

export function readPairKey(dir: string): PairKey {
  const path = join(dir, 'key.json')
  if (!existsSync(path)) throw new PairRefusal(`no key at ${path}; run \`eval pairs --build\` first`)
  const key = JSON.parse(readFileSync(path, 'utf8')) as PairKey
  if (key.schema_version !== PAIR_SCHEMA_VERSION) {
    throw new PairRefusal(`${path} has schema_version ${String(key.schema_version)}, this build reads ${PAIR_SCHEMA_VERSION} (version 2 added the build id); rebuild the sheet and key, moving the old ones aside first`)
  }
  return key
}

export const pairSummaryPath = (repoRoot: string, method: string): string => join(pilotDir(repoRoot, method), PAIR_SUMMARY_FILE)

/** Writes `evals/<method>/pilot/pair-summary.json`, which holds counts and ids only. */
export function writePairSummary(repoRoot: string, summary: PairSummary): string {
  const path = pairSummaryPath(repoRoot, summary.method)
  mkdirSync(pilotDir(repoRoot, summary.method), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}
