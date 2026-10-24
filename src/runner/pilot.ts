/**
 * `eval pilot`: a dev-only, unreported campaign that compares arms on the pilot prereg (`evals/<m>/pilot/prereg.json`).
 *
 * - `planPilot` plans one arm over the dev fixtures only: no negatives, no held-out. `instruction` runs under condition
 *   `baseline`; `skill` under `skill`. Every planned run carries its `arm`, which lands on the manifest.
 * - Reports refuse any manifest that carries an `arm`, so the only projection of a pilot is `pilot.json`, written by a fixed-key
 *   writer: counts, model ids, the prereg content hash, the arms present. No stdout, stderr, env, quotes or transcript text.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { isAbsolute, join, relative, resolve } from 'node:path'

import { isSkillContentLoad, parseEvents, toolUses } from './events'
import { readJudgeRecord } from './judge-record'
import { loadCampaignRuns, PILOT_ARMS, type PilotArm, type RunManifest } from './manifest'
import type { LoadedFixture } from './prereg'
import type { PlannedRun } from './run'
import type { Condition } from './workspace'

export { PILOT_ARMS, type PilotArm }

/** The arms this build can run. The others are named so a refusal can say what is missing. */
export const RUNNABLE_ARMS: readonly PilotArm[] = ['baseline']

export const isPilotArm = (value: string): value is PilotArm => (PILOT_ARMS as readonly string[]).includes(value)

/** Why `arm` cannot run yet, or `undefined` when it can. */
export function armRefusal(arm: PilotArm): string | undefined {
  if (RUNNABLE_ARMS.includes(arm)) return undefined
  return `--arm ${arm} is not available yet: this build runs the baseline arm only (the instruction and skill arms are Unit 6 of docs/plans/2026-10-24-001-feat-tether-method-plan.md)`
}

export const conditionOfArm = (arm: PilotArm): Condition => (arm === 'skill' ? 'skill' : 'baseline')

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
        condition: conditionOfArm(input.arm),
        arm: input.arm,
        index,
      })
    }
  }
  return plan
}

// ── tally projection ───────────────────────────────────────────────────────

export const PILOT_SCHEMA_VERSION = 2 as const

/** Judge criteria the tether pilot reads; `TE3m` is mechanical and shows up as `over_limit`. */
const TE1 = 'TE1'
const TE2 = 'TE2'

export interface PilotCell {
  /** Runs that reached a verdict or a failure of their own: infra errors, isolation breaches and interrupted runs are left out. */
  runs: number
  te1_pass: number
  te2_pass: number
  both_pass: number
  over_limit: number
  empty: number
  /** Runs whose transcript shows a skill's content being loaded. A baseline or instruction arm with any is contaminated. */
  skill_loaded: number
  /** Runs of the `instruction` arm (the runner adds the instruction to every one of them). */
  instruction_present: number
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

const emptyCell = (): PilotCell => ({ runs: 0, te1_pass: 0, te2_pass: 0, both_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0, instruction_present: 0 })

const CELL_KEYS = ['runs', 'te1_pass', 'te2_pass', 'both_pass', 'over_limit', 'empty', 'skill_loaded', 'instruction_present'] as const satisfies readonly (keyof PilotCell)[]

/** Rebuilds a cell with exactly the allowlisted keys, whatever the value passed in carried. */
function fixedCell(cell: PilotCell): PilotCell {
  return {
    runs: cell.runs,
    te1_pass: cell.te1_pass,
    te2_pass: cell.te2_pass,
    both_pass: cell.both_pass,
    over_limit: cell.over_limit,
    empty: cell.empty,
    skill_loaded: cell.skill_loaded,
    instruction_present: cell.instruction_present,
  }
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

export interface TallyOptions {
  /**
   * Skip the check that every manifest was produced under `ctx.prereg_content_hash`. Only the rejudge path sets it: a rejudge
   * rewrites `judge.json` under the current prereg and never touches the manifests, so they keep the hash they were run under.
   */
  allowRejudged?: boolean
}

/**
 * Counts one pilot campaign into `arm → fixture → cell`. A manifest without an `arm` means this is not a pilot campaign, and a
 * manifest produced under another prereg content hash is refused unless `allowRejudged`: its verdicts are not the current prereg's.
 */
export function tallyPilotCampaign(campaignDir: string, ctx: PilotContext, options: TallyOptions = {}): PilotTally {
  const tally: PilotTally['tally'] = {}
  const campaignIds = new Set<string>()
  for (const { dir: runDir, manifest: m } of loadCampaignRuns(campaignDir)) {
    if (m.arm === undefined) throw new Error(`${m.run_id} carries no arm: ${campaignDir} is not a pilot campaign`)
    if (!options.allowRejudged && m.prereg.content_hash !== ctx.prereg_content_hash) {
      throw new Error(`${runDir} was run under prereg ${m.prereg.content_hash.slice(0, 12)}, not the current ${ctx.prereg_content_hash.slice(0, 12)}; rejudge the campaign under the current prereg before tallying it`)
    }
    campaignIds.add(m.campaign_id)
    if (!COUNTED_STATUSES.includes(m.status)) continue
    const cell = ((tally[m.arm] ??= {})[m.fixture.id] ??= emptyCell())
    const verdicts = verdictsOf(runDir, m)
    const te1 = passed(verdicts, TE1)
    const te2 = passed(verdicts, TE2)
    cell.runs += 1
    if (te1) cell.te1_pass += 1
    if (te2) cell.te2_pass += 1
    if (te1 && te2) cell.both_pass += 1
    if (m.reasons.includes('answer_over_limit')) cell.over_limit += 1
    if (m.reasons.includes('answer_empty')) cell.empty += 1
    if (skillLoadedIn(runDir)) cell.skill_loaded += 1
    if (m.arm === 'instruction') cell.instruction_present += 1
  }
  if (campaignIds.size > 1) throw new Error(`${campaignDir} holds manifests from more than one campaign (${[...campaignIds].sort().join(', ')})`)
  const campaigns: PilotTally['campaigns'] = {}
  const [campaignId] = campaignIds
  if (campaignId !== undefined) for (const arm of PILOT_ARMS) if (tally[arm] !== undefined) campaigns[arm] = campaignId
  return projectPilot({ ...ctx, tally, campaigns })
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
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
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
  for (const [arm, fixtures] of Object.entries(tally)) {
    if (!isRecord(fixtures)) throw new Error(`tally.${arm} is not an object`)
    for (const [id, cell] of Object.entries(fixtures)) {
      if (!isRecord(cell) || !sameKeys(cell, CELL_KEYS)) throw new Error(`tally.${arm}.${id} is not a record of exactly [${CELL_KEYS.join(', ')}]`)
      for (const key of CELL_KEYS) if (!isCount(cell[key])) throw new Error(`tally.${arm}.${id}.${key} is not a non-negative integer`)
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
 * Writes `evals/<method>/pilot/pilot.json`. Arms run in separate campaigns, so an arm already tallied under the same prereg content
 * stays, and `incoming` replaces only its own arms (`log` hears which campaign each replaced); a different prereg content hash
 * starts the file over. An existing file that does not validate is an error and is left as it is.
 */
export function writePilotTally(repoRoot: string, incoming: PilotTally, log?: (line: string) => void): string {
  const path = pilotTallyPath(repoRoot, incoming.method)
  const existing = readExisting(path)
  const keep = existing !== undefined && existing.prereg_content_hash === incoming.prereg_content_hash
  const keptTally = keep ? existing.tally : {}
  const keptCampaigns = keep ? existing.campaigns : {}
  for (const arm of incoming.arms) {
    const replaced = keptCampaigns[arm]
    if (replaced !== undefined) log?.(`replaced ${arm} tally from ${replaced}`)
  }
  const merged = projectPilot({ ...incoming, tally: { ...keptTally, ...incoming.tally }, campaigns: { ...keptCampaigns, ...incoming.campaigns } })
  mkdirSync(pilotDir(repoRoot, incoming.method), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}
