/**
 * `eval pilot`: a dev-only, unreported campaign on the pilot prereg (`evals/<m>/pilot/prereg.json`).
 *
 * - `planPilot` plans the named arms (`baseline`, `skill`) over the dev fixtures only: no negatives, no held-out. Arms are interleaved
 *   and the first arm flips by round and fixture, so neither runs systematically earlier. Every planned run carries its `arm`, which
 *   lands on the manifest and marks the campaign as a pilot.
 * - Reports refuse any manifest that carries an `arm`, so the only projection of a pilot is `pilot.json`, written by a fixed-key
 *   writer: counts, model ids, the prereg content hash, the arms present and their campaign ids. No stdout, stderr, env, quotes or
 *   transcript text.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { isAbsolute, join, relative, resolve } from 'node:path'

import { isSkillContentLoad, parseEvents, toolUses } from './events'
import { readJudgeRecord } from './judge-record'
import { loadCampaignRuns, PILOT_ARMS, type PilotArm, type RunManifest, skipReason } from './manifest'
import type { LoadedFixture } from './prereg'
import type { PlannedRun } from './run'
import { isOverLimit } from './word-limit'
import { type Condition, sha256 } from './workspace'

export { PILOT_ARMS, type PilotArm }

export const isPilotArm = (value: string): value is PilotArm => (PILOT_ARMS as readonly string[]).includes(value)

/** The condition an arm runs under: `skill` installs the skill, `baseline` installs nothing. */
export const conditionOfArm = (arm: PilotArm): Condition => (arm === 'skill' ? 'skill' : 'baseline')

/** `--arm` as a comma list: known arms, no repeats. `bad` names every entry that is empty, unknown or repeated. */
export function parsePilotArms(flag: string): { ok: true; arms: PilotArm[] } | { ok: false; bad: string[] } {
  const parts = flag.split(',').map((p) => p.trim())
  const bad = parts.filter((p, i) => !isPilotArm(p) || parts.indexOf(p) !== i)
  return bad.length ? { ok: false, bad: [...new Set(bad)] } : { ok: true, arms: parts as PilotArm[] }
}

export interface PilotPlanInput {
  /** The arms to run, in the order they lead on an even round + fixture index; each fixture gets `runsPerCondition` runs of every arm. */
  arms: readonly PilotArm[]
  /** The prereg's dev fixtures; a pilot never plans negatives or held-out fixtures. */
  fixtures: readonly LoadedFixture[]
  runsPerCondition: number
  onlyFixture?: string
}

/**
 * Rounds over the dev fixtures: `runsPerCondition` runs of each arm per fixture. Within a round each fixture's arms run back to back,
 * and the arm order flips with the parity of round + fixture index (as `planRuns` does for conditions).
 */
export function planPilot(input: PilotPlanInput): PlannedRun[] {
  if (input.arms.length === 0) throw new Error('a pilot plan needs at least one arm')
  const selected = input.onlyFixture ? input.fixtures.filter((f) => f.id === input.onlyFixture) : input.fixtures
  if (input.onlyFixture && selected.length === 0) throw new Error(`no fixture with id "${input.onlyFixture}" in the pilot plan`)
  const plan: PlannedRun[] = []
  for (let index = 1; index <= input.runsPerCondition; index += 1) {
    selected.forEach((f, fi) => {
      const ordered = (index + fi) % 2 === 0 ? input.arms : [...input.arms].reverse()
      for (const arm of ordered) {
        plan.push({
          fixture: { id: f.id, kind: 'dev', text: f.text, hash: f.hash, ...(f.expectation ? { expectation: f.expectation } : {}) },
          condition: conditionOfArm(arm),
          arm,
          index,
        })
      }
    })
  }
  return plan
}

// ── tally projection ───────────────────────────────────────────────────────

export const PILOT_SCHEMA_VERSION = 3 as const

export interface PilotCell {
  /** Runs that reached a verdict or a failure of their own: infra errors, isolation breaches and interrupted runs are left out. */
  runs: number
  /** Judge criterion id (read from the rubric) → runs that passed it. Mechanical criteria show up as `over_limit` instead. */
  criteria: Record<string, number>
  /** Runs that passed every judge criterion. */
  all_pass: number
  over_limit: number
  empty: number
  /** Runs whose transcript shows a skill's content being loaded. The baseline arm gets no skill, so any is contamination. */
  skill_loaded: number
}

export interface PilotTally {
  schema_version: typeof PILOT_SCHEMA_VERSION
  method: string
  prereg_content_hash: string
  agent_model_id: string
  judge_model_id: string
  /** Arms with a tally, in `PILOT_ARMS` order. */
  arms: PilotArm[]
  /** arm → id of the campaign that arm's tally was counted from. */
  campaigns: Partial<Record<PilotArm, string>>
  /** arm → fixture id → counts. */
  tally: Partial<Record<PilotArm, Record<string, PilotCell>>>
}

const emptyCell = (criteria: readonly string[]): PilotCell => ({ runs: 0, criteria: Object.fromEntries(criteria.map((id) => [id, 0])), all_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0 })

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

const COUNT_KEYS = ['runs', 'all_pass', 'over_limit', 'empty', 'skill_loaded'] as const satisfies readonly (keyof PilotCell)[]
const CELL_KEYS = ['runs', 'criteria', 'all_pass', 'over_limit', 'empty', 'skill_loaded'] as const satisfies readonly (keyof PilotCell)[]

/** Rebuilds a cell with exactly the allowlisted keys, whatever the value passed in carried. A count that is not a non-negative integer is an error. */
function fixedCell(cell: PilotCell): PilotCell {
  for (const key of COUNT_KEYS) if (!isCount(cell[key])) throw new Error(`${key} is not a non-negative integer`)
  const criteria = Object.fromEntries(
    Object.entries(cell.criteria).map(([id, passes]) => {
      if (!isCount(passes)) throw new Error(`criteria.${id} is not a non-negative integer`)
      return [id, passes]
    }),
  )
  return { runs: cell.runs, criteria, all_pass: cell.all_pass, over_limit: cell.over_limit, empty: cell.empty, skill_loaded: cell.skill_loaded }
}

const COUNTED_STATUSES: readonly string[] = ['completed', 'timeout', 'budget_exceeded', 'host_crash']

const passed = (verdicts: readonly { id: string; verdict: string }[], id: string): boolean => verdicts.some((c) => c.id === id && c.verdict === 'pass')

function skillLoadedIn(runDir: string): boolean {
  const path = join(runDir, 'stdout.jsonl')
  if (!existsSync(path)) return false
  return toolUses(parseEvents(readFileSync(path, 'utf8')).events).some((call) => isSkillContentLoad(call))
}

export interface PilotContext {
  method: string
  prereg_content_hash: string
  agent_model_id: string
  judge_model_id: string
}

export interface TallyContext extends Omit<PilotContext, 'agent_model_id'> {
  /** The rubric's judge criterion ids (`parseRubric(...).criteria`), in rubric order. Each gets a pass count per cell. */
  criteria: readonly string[]
  /**
   * The rubric declares `expectation: true`, so a run with only non-blocking check failures (no record, the skill never loaded) still
   * reached the judge and its verdicts are held to the contract. Default false: any check failure means the judge was never reached.
   */
  declared?: boolean
  /**
   * The verified dev fixtures of the current prereg, with their expectation sidecars. `over_limit` is recomputed against the current
   * `maxWords`, so a tally follows the committed contract whatever limit the run was graded under.
   */
  fixtures: readonly Pick<LoadedFixture, 'id' | 'expectation'>[]
}

export interface SummaryRow {
  verdict: string
  judge_json_sha256?: string
}

export interface RejudgeSummary {
  /** The prereg content hash the rejudge was enforced under; absent in summaries written before it was recorded. */
  contract: string | undefined
  /** The judge model the rejudge pinned; absent likewise. */
  model: string | undefined
  rows: Map<string, SummaryRow>
}

/** `rejudge-summary.json` by run id; `undefined` when there is no readable summary. */
export function readRejudgeSummary(campaignDir: string): RejudgeSummary | undefined {
  const path = join(campaignDir, 'rejudge-summary.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { prereg_content_hash?: unknown; judge_model_id?: unknown; runs?: unknown }
    if (!Array.isArray(raw.runs)) return undefined
    const rows = new Map<string, SummaryRow>()
    for (const r of raw.runs as { run_id?: unknown; verdict?: unknown; judge_json_sha256?: unknown }[]) {
      if (typeof r.run_id === 'string' && typeof r.verdict === 'string') rows.set(r.run_id, { verdict: r.verdict, ...(typeof r.judge_json_sha256 === 'string' ? { judge_json_sha256: r.judge_json_sha256 } : {}) })
    }
    return {
      contract: typeof raw.prereg_content_hash === 'string' ? raw.prereg_content_hash : undefined,
      model: typeof raw.judge_model_id === 'string' ? raw.judge_model_id : undefined,
      rows,
    }
  } catch {
    return undefined
  }
}

export type Vouched = { ok: true; model: string; verdicts: readonly { id: string; verdict: string }[]; errored: boolean } | { ok: false; why: string }

/**
 * Whether a rejudge under the *current* contract wrote the run's current `judge.json`: the summary records this prereg content hash (so
 * the same fixtures, expectations, rubric, models and bars), has a row for the run that was not skipped, and that row's hash is the
 * hash of the file on disk now.
 */
export function vouchedRejudge(summary: RejudgeSummary | undefined, runDir: string, runId: string, current: string): Vouched {
  if (summary === undefined) return { ok: false, why: 'there is no readable rejudge-summary.json in the campaign' }
  if (summary.contract === undefined || summary.model === undefined) return { ok: false, why: 'its rejudge summary predates the recorded contract' }
  if (summary.contract !== current) return { ok: false, why: `its rejudge was under prereg ${summary.contract.slice(0, 12)}, not the current contract ${current.slice(0, 12)}` }
  const row = summary.rows.get(runId)
  if (row === undefined) return { ok: false, why: 'the rejudge summary has no row for it' }
  if (row.verdict === 'skipped' || row.judge_json_sha256 === undefined) return { ok: false, why: 'the rejudge skipped it or wrote no judge.json for it' }
  const path = join(runDir, 'judge.json')
  if (!existsSync(path)) return { ok: false, why: 'it has no judge.json' }
  const text = readFileSync(path, 'utf8')
  if (sha256(text) !== row.judge_json_sha256) return { ok: false, why: 'its judge.json is not the file the rejudge wrote' }
  const record = readJudgeRecord(text)
  return { ok: true, model: summary.model, verdicts: record.criteria, errored: record.error !== undefined }
}

/** Where a run's verdicts, judge model and error flag come from, or why nothing under the current contract vouches for them. */
export type VerdictUnderContract =
  | { ok: true; source: 'rejudge' | 'manifest'; model: string | undefined; verdicts: readonly { id: string; verdict: string }[]; errored: boolean }
  | { ok: false; why: string }

/**
 * The tally's rule for a run that reached the judge, in one place so a pair sheet cannot read a different verdict than the tally does:
 * (a) its `judge.json`, if `rejudge-summary.json` was written under `current` (the prereg content hash) and vouches for that file;
 * (b) else the manifest's own recorded judge evidence, if the manifest was produced under `current`; (c) else nothing (`why` says why).
 */
export function verdictUnderContract(summary: RejudgeSummary | undefined, runDir: string, m: RunManifest, current: string): VerdictUnderContract {
  const rejudged = vouchedRejudge(summary, runDir, m.run_id, current)
  if (rejudged.ok) return { ok: true, source: 'rejudge', model: rejudged.model, verdicts: rejudged.verdicts, errored: rejudged.errored }
  if (m.prereg.content_hash === current) {
    return { ok: true, source: 'manifest', model: m.judge?.model.pinned, verdicts: m.judge?.criteria ?? [], errored: m.judge?.error_code != null }
  }
  return { ok: false, why: rejudged.why }
}

/**
 * Counts one pilot campaign into `arm → fixture → cell`. A manifest without an `arm` means this is not a pilot campaign.
 *
 * Every verdict is tied to the current contract (the prereg content hash). A run that reached the judge takes its verdicts from, in order:
 * (a) its `judge.json`, if `rejudge-summary.json` was written under the current contract and vouches for that file (`vouchedRejudge`);
 * (b) else the manifest's own recorded judge criteria, if the manifest was produced under the current contract (immutable: a judge.json
 * that nothing vouches for is never read); (c) else the run is refused, naming its directory. A run that never reached the judge (a
 * timeout, an empty answer) has no verdict, so no contract to be under.
 *
 * The agent model on the tally is the one the manifests recorded, and the judge model is the summary's (for runs taken from judge.json)
 * or the manifests' recorded judge; either disagreeing with itself is refused. `ctx.judge_model_id` is only the fallback when no run was
 * judged.
 */
export function tallyPilotCampaign(campaignDir: string, ctx: TallyContext): PilotTally {
  const tally: PilotTally['tally'] = {}
  const campaignIds = new Set<string>()
  const agentModels = new Set<string>()
  const judgeModels = new Set<string>()
  const summary = readRejudgeSummary(campaignDir)
  for (const { dir: runDir, manifest: m } of loadCampaignRuns(campaignDir)) {
    if (m.arm === undefined) throw new Error(`${m.run_id} carries no arm: ${campaignDir} is not a pilot campaign`)
    campaignIds.add(m.campaign_id)
    agentModels.add(m.model.pinned)
    if (!COUNTED_STATUSES.includes(m.status)) continue
    const fixture = ctx.fixtures.find((f) => f.id === m.fixture.id)
    if (fixture === undefined) throw new Error(`${runDir} ran fixture ${m.fixture.id}, which the current prereg does not have`)
    let verdicts: readonly { id: string; verdict: string }[] = m.judge?.criteria ?? []
    if (skipReason(m, true, ctx.declared === true) === undefined) {
      const found = verdictUnderContract(summary, runDir, m, ctx.prereg_content_hash)
      if (!found.ok) {
        throw new Error(
          `${runDir} was run under prereg ${m.prereg.content_hash.slice(0, 12)}, not the current ${ctx.prereg_content_hash.slice(0, 12)}, and no rejudge under the current contract vouches for its verdicts: ${found.why}. Run \`rejudge\` (without --tally-only) first`,
        )
      }
      verdicts = found.verdicts
      if (found.model !== undefined) judgeModels.add(found.model)
    }
    const cell = ((tally[m.arm] ??= {})[m.fixture.id] ??= emptyCell(ctx.criteria))
    const passes = ctx.criteria.filter((id) => passed(verdicts, id))
    cell.runs += 1
    for (const id of passes) cell.criteria[id] = (cell.criteria[id] ?? 0) + 1
    if (passes.length === ctx.criteria.length) cell.all_pass += 1
    // The word limit is the current expectation's, applied to the words the run recorded; the recorded reason reflects the limit of its day.
    const maxWords = fixture.expectation?.maxWords
    if (maxWords !== undefined && m.word_count !== undefined && isOverLimit(m.word_count, maxWords)) cell.over_limit += 1
    if (m.reasons.includes('answer_empty')) cell.empty += 1
    if (skillLoadedIn(runDir)) cell.skill_loaded += 1
  }
  if (campaignIds.size > 1) throw new Error(`${campaignDir} holds manifests from more than one campaign (${[...campaignIds].sort().join(', ')})`)
  if (agentModels.size > 1) throw new Error(`${campaignDir} holds manifests that recorded different agent models (${[...agentModels].sort().join(', ')})`)
  if (judgeModels.size > 1) throw new Error(`${campaignDir} holds verdicts from different judge models (${[...judgeModels].sort().join(', ')})`)
  const [agentModel] = agentModels
  if (agentModel === undefined) throw new Error(`${campaignDir} holds no run manifests`)
  const [judgeModel] = judgeModels
  const campaigns: PilotTally['campaigns'] = {}
  const [campaignId] = campaignIds
  if (campaignId !== undefined) for (const arm of PILOT_ARMS) if (tally[arm] !== undefined) campaigns[arm] = campaignId
  const { criteria: _criteria, fixtures: _fixtures, declared: _declared, ...context } = ctx
  return projectPilot({ ...context, agent_model_id: agentModel, judge_model_id: judgeModel ?? ctx.judge_model_id, tally, campaigns })
}

function assertKnownArm(arm: string, where: string): asserts arm is PilotArm {
  if (!isPilotArm(arm)) throw new Error(`${where} carries unknown pilot arm "${arm}" (known: ${PILOT_ARMS.join(', ')})`)
}

/** The fixed-key projection: nothing but the allowlisted keys reaches the file. An arm outside `PILOT_ARMS` is an error, not dropped. */
export function projectPilot(input: PilotContext & { tally: PilotTally['tally']; campaigns: PilotTally['campaigns'] }): PilotTally {
  for (const arm of Object.keys(input.tally)) assertKnownArm(arm, 'tally')
  for (const arm of Object.keys(input.campaigns)) assertKnownArm(arm, 'campaigns')
  const tally: PilotTally['tally'] = {}
  const campaigns: PilotTally['campaigns'] = {}
  for (const arm of PILOT_ARMS) {
    const fixtures = input.tally[arm]
    const campaign = input.campaigns[arm]
    if (fixtures === undefined && campaign === undefined) continue
    if (fixtures === undefined || campaign === undefined) throw new Error(`arm ${arm} needs both a tally and a campaign id`)
    tally[arm] = Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, cell]) => [id, fixedCell(cell)]))
    campaigns[arm] = campaign
  }
  return {
    schema_version: PILOT_SCHEMA_VERSION,
    method: input.method,
    prereg_content_hash: input.prereg_content_hash,
    agent_model_id: input.agent_model_id,
    judge_model_id: input.judge_model_id,
    arms: PILOT_ARMS.filter((arm) => tally[arm] !== undefined),
    campaigns,
    tally,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sameKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((k) => keys.includes(k))
}

/**
 * Reads a `pilot.json` back: the allowlisted keys and nothing else, the current schema version, a hex-64 prereg content hash, arms
 * and tally and campaigns keys inside `PILOT_ARMS` and agreeing with each other, and every cell a closed record of non-negative
 * integers. Throws naming the first thing wrong; nothing is repaired.
 */
export function parsePilotTally(value: unknown): PilotTally {
  if (!isRecord(value)) throw new Error('not a JSON object')
  const top = ['schema_version', 'method', 'prereg_content_hash', 'agent_model_id', 'judge_model_id', 'arms', 'campaigns', 'tally']
  if (!sameKeys(value, top)) throw new Error(`keys are [${Object.keys(value).join(', ')}], expected [${top.join(', ')}]`)
  if (value.schema_version !== PILOT_SCHEMA_VERSION) throw new Error(`schema_version is ${JSON.stringify(value.schema_version)}, this build writes ${PILOT_SCHEMA_VERSION}`)
  for (const key of ['method', 'agent_model_id', 'judge_model_id'] as const) if (typeof value[key] !== 'string') throw new Error(`${key} is not a string`)
  if (typeof value.prereg_content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.prereg_content_hash)) throw new Error('prereg_content_hash is not 64 lowercase hex characters')
  const { arms, campaigns, tally } = value
  if (!Array.isArray(arms)) throw new Error('arms is not an array')
  for (const arm of arms) assertKnownArm(String(arm), 'arms')
  if (!isRecord(tally)) throw new Error('tally is not an object')
  if (!isRecord(campaigns)) throw new Error('campaigns is not an object')
  for (const arm of Object.keys(tally)) assertKnownArm(arm, 'tally')
  for (const arm of Object.keys(campaigns)) assertKnownArm(arm, 'campaigns')
  const expectedArms = PILOT_ARMS.filter((arm) => arm in tally)
  if (JSON.stringify(arms) !== JSON.stringify(expectedArms)) throw new Error(`arms ${JSON.stringify(arms)} do not match the tallied arms ${JSON.stringify(expectedArms)}`)
  if (!sameKeys(campaigns, expectedArms)) throw new Error('campaigns does not name exactly the tallied arms')
  for (const [arm, id] of Object.entries(campaigns)) if (typeof id !== 'string' || id === '') throw new Error(`campaigns.${arm} is not a campaign id`)
  let criteriaIds: string | undefined
  for (const [arm, fixtures] of Object.entries(tally)) {
    if (!isRecord(fixtures)) throw new Error(`tally.${arm} is not an object`)
    for (const [id, cell] of Object.entries(fixtures)) {
      if (!isRecord(cell) || !sameKeys(cell, CELL_KEYS)) throw new Error(`tally.${arm}.${id} is not a record of exactly [${CELL_KEYS.join(', ')}]`)
      for (const key of COUNT_KEYS) if (!isCount(cell[key])) throw new Error(`tally.${arm}.${id}.${key} is not a non-negative integer`)
      const counted = cell.criteria
      if (!isRecord(counted) || Object.keys(counted).length === 0) throw new Error(`tally.${arm}.${id}.criteria is not a non-empty record`)
      for (const [criterion, passes] of Object.entries(counted)) if (!isCount(passes)) throw new Error(`tally.${arm}.${id}.criteria.${criterion} is not a non-negative integer`)
      const ids = Object.keys(counted).sort().join(',')
      if ((criteriaIds ??= ids) !== ids) throw new Error(`tally.${arm}.${id} counts criteria [${ids}], other cells count [${criteriaIds}]`)
    }
  }
  return value as unknown as PilotTally
}

/**
 * The repo-relative pilot prereg: `flag` (as given to `--prereg`) or `evals/<method>/pilot/prereg.json`. `undefined` when it points
 * outside the repository, because a path that leaves the repo is not a committed contract.
 */
export function pilotPreregRel(repoRoot: string, method: string, flag?: string): string | undefined {
  const rel = relative(repoRoot, resolve(repoRoot, flag ?? join('evals', method, 'pilot', 'prereg.json')))
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel
}

export const pilotDir = (repoRoot: string, method: string): string => join(repoRoot, 'evals', method, 'pilot')
export const pilotTallyPath = (repoRoot: string, method: string): string => join(pilotDir(repoRoot, method), 'pilot.json')

/** A missing file is the only "no existing tally". One that cannot be read or does not validate stops the write: it holds other arms' numbers. */
function readExisting(path: string): PilotTally | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parsePilotTally(JSON.parse(readFileSync(path, 'utf8')))
  } catch (e) {
    throw new Error(`${path}: unreadable or malformed pilot.json (${(e as Error).message}); fix it or delete it to start over`)
  }
}

/**
 * Writes `evals/<method>/pilot/pilot.json`. A rerun of an arm under the same prereg content replaces its tally, and `log` hears which
 * campaign it replaced; a different prereg content hash starts the file over without a word, since nothing of the old file carries
 * over. An existing file that does not validate is an error and is left as it is.
 */
export function writePilotTally(repoRoot: string, incoming: PilotTally, log?: (line: string) => void): string {
  const path = pilotTallyPath(repoRoot, incoming.method)
  const existing = readExisting(path)
  if (existing !== undefined && existing.prereg_content_hash === incoming.prereg_content_hash) {
    for (const arm of incoming.arms) {
      const replaced = existing.campaigns[arm]
      if (replaced !== undefined) log?.(`replaced ${arm} tally from ${replaced}`)
    }
  }
  const projected = projectPilot(incoming)
  mkdirSync(pilotDir(repoRoot, incoming.method), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(projected, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}
