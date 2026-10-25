/**
 * `eval pilot`: a dev-only, unreported campaign on the pilot prereg (`evals/<m>/pilot/prereg.json`).
 *
 * - `planPilot` plans the baseline arm over the dev fixtures only: no negatives, no held-out. Every planned run carries its `arm`,
 *   which lands on the manifest and marks the campaign as a pilot.
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
import { sha256 } from './workspace'

export { PILOT_ARMS, type PilotArm }

export const isPilotArm = (value: string): value is PilotArm => (PILOT_ARMS as readonly string[]).includes(value)

export interface PilotPlanInput {
  arm: PilotArm
  /** The prereg's dev fixtures; a pilot never plans negatives or held-out fixtures. */
  fixtures: readonly LoadedFixture[]
  runsPerCondition: number
  onlyFixture?: string
}

/** Rounds over the dev fixtures: `runsPerCondition` runs of `arm` per fixture. */
export function planPilot(input: PilotPlanInput): PlannedRun[] {
  const selected = input.onlyFixture ? input.fixtures.filter((f) => f.id === input.onlyFixture) : input.fixtures
  if (input.onlyFixture && selected.length === 0) throw new Error(`no fixture with id "${input.onlyFixture}" in the pilot plan`)
  const plan: PlannedRun[] = []
  for (let index = 1; index <= input.runsPerCondition; index += 1) {
    for (const f of selected) {
      plan.push({
        fixture: { id: f.id, kind: 'dev', text: f.text, hash: f.hash, ...(f.expectation ? { expectation: f.expectation } : {}) },
        condition: 'baseline',
        arm: input.arm,
        index,
      })
    }
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

/**
 * The verdicts that count for a run: `judge.json` when the run directory has one, else the manifest's. A rejudge rewrites `judge.json`
 * and never the manifest, so the file holds the latest verdicts either way (the run's own judge call writes it too).
 */
function verdictsOf(runDir: string, m: RunManifest): readonly { id: string; verdict: string }[] {
  const path = join(runDir, 'judge.json')
  if (existsSync(path)) return readJudgeRecord(readFileSync(path, 'utf8')).criteria
  return m.judge?.criteria ?? []
}

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
   * The verified dev fixtures of the current prereg, with their expectation sidecars. `over_limit` is recomputed against the current
   * `maxWords`, so a tally follows the committed contract whatever limit the run was graded under.
   */
  fixtures: readonly Pick<LoadedFixture, 'id' | 'expectation'>[]
}

export interface TallyOptions {
  /**
   * Set by the rejudge path only. A rejudge rewrites `judge.json` under the current prereg and never touches the manifests, so they
   * keep the hash they were run under. Such a run counts only if it reached the judge originally and `rejudge-summary.json` proves
   * that a rejudge under this judge prompt wrote its current `judge.json` (see `judgingProvenance`); any other run is refused.
   */
  rejudgedUnder?: { judgePromptSha256: string }
}

interface SummaryRow {
  verdict: string
  judge_json_sha256?: string
}

/** The rows of `rejudge-summary.json` by run id, with the judge prompt hash the rejudge recorded; `undefined` when there is no readable summary. */
function readRejudgeSummary(campaignDir: string): { prompt: string; rows: Map<string, SummaryRow> } | undefined {
  const path = join(campaignDir, 'rejudge-summary.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { judge_prompt_sha256?: unknown; runs?: unknown }
    if (typeof raw.judge_prompt_sha256 !== 'string' || !Array.isArray(raw.runs)) return undefined
    const rows = new Map<string, SummaryRow>()
    for (const r of raw.runs as { run_id?: unknown; verdict?: unknown; judge_json_sha256?: unknown }[]) {
      if (typeof r.run_id === 'string' && typeof r.verdict === 'string') rows.set(r.run_id, { verdict: r.verdict, ...(typeof r.judge_json_sha256 === 'string' ? { judge_json_sha256: r.judge_json_sha256 } : {}) })
    }
    return { prompt: raw.judge_prompt_sha256, rows }
  } catch {
    return undefined
  }
}

/** Why the run's `judge.json` cannot be shown to come from a rejudge under `judgePromptSha256`, or `undefined` when it can. */
function judgingProvenance(runDir: string, runId: string, summary: ReturnType<typeof readRejudgeSummary>, judgePromptSha256: string): string | undefined {
  if (summary === undefined) return 'there is no readable rejudge-summary.json in the campaign'
  if (summary.prompt !== judgePromptSha256) return `its rejudge was under judge prompt ${summary.prompt.slice(0, 12)}, not the current ${judgePromptSha256.slice(0, 12)} (the rubric changed after it)`
  const row = summary.rows.get(runId)
  if (row === undefined) return 'the rejudge summary has no row for it'
  if (row.verdict === 'skipped' || row.judge_json_sha256 === undefined) return 'the rejudge skipped it or wrote no judge.json for it'
  const path = join(runDir, 'judge.json')
  if (!existsSync(path)) return 'it has no judge.json'
  if (sha256(readFileSync(path, 'utf8')) !== row.judge_json_sha256) return 'its judge.json is not the file the rejudge wrote'
  return undefined
}

/**
 * Counts one pilot campaign into `arm → fixture → cell`. A manifest without an `arm` means this is not a pilot campaign.
 *
 * A manifest produced under another prereg content hash is refused: its verdicts are not the current prereg's. The one exception is
 * the rejudge path (`options.rejudgedUnder`), where a run that reached the judge originally must have a `judge.json` that a rejudge
 * under the current judge prompt wrote; a run that never reached the judge (a timeout, an empty answer) has no verdict to vouch for.
 * The agent model on the tally is the one the manifests recorded, and manifests that disagree are refused.
 */
export function tallyPilotCampaign(campaignDir: string, ctx: TallyContext, options: TallyOptions = {}): PilotTally {
  const tally: PilotTally['tally'] = {}
  const campaignIds = new Set<string>()
  const agentModels = new Set<string>()
  const { rejudgedUnder } = options
  const summary = rejudgedUnder ? readRejudgeSummary(campaignDir) : undefined
  for (const { dir: runDir, manifest: m } of loadCampaignRuns(campaignDir)) {
    if (m.arm === undefined) throw new Error(`${m.run_id} carries no arm: ${campaignDir} is not a pilot campaign`)
    if (m.prereg.content_hash !== ctx.prereg_content_hash) {
      const mismatch = `${runDir} was run under prereg ${m.prereg.content_hash.slice(0, 12)}, not the current ${ctx.prereg_content_hash.slice(0, 12)}`
      if (rejudgedUnder === undefined) throw new Error(`${mismatch}; rejudge the campaign under the current prereg before tallying it`)
      if (skipReason(m, true) === undefined) {
        const why = judgingProvenance(runDir, m.run_id, summary, rejudgedUnder.judgePromptSha256)
        if (why !== undefined) throw new Error(`${mismatch}, and its verdicts are not from a rejudge under the current contract: ${why}. Run \`rejudge\` (without --tally-only) first`)
      }
    }
    campaignIds.add(m.campaign_id)
    agentModels.add(m.model.pinned)
    if (!COUNTED_STATUSES.includes(m.status)) continue
    const fixture = ctx.fixtures.find((f) => f.id === m.fixture.id)
    if (fixture === undefined) throw new Error(`${runDir} ran fixture ${m.fixture.id}, which the current prereg does not have`)
    const cell = ((tally[m.arm] ??= {})[m.fixture.id] ??= emptyCell(ctx.criteria))
    const verdicts = verdictsOf(runDir, m)
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
  const [agentModel] = agentModels
  if (agentModel === undefined) throw new Error(`${campaignDir} holds no run manifests`)
  const campaigns: PilotTally['campaigns'] = {}
  const [campaignId] = campaignIds
  if (campaignId !== undefined) for (const arm of PILOT_ARMS) if (tally[arm] !== undefined) campaigns[arm] = campaignId
  const { criteria: _criteria, fixtures: _fixtures, ...context } = ctx
  return projectPilot({ ...context, agent_model_id: agentModel, tally, campaigns })
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
