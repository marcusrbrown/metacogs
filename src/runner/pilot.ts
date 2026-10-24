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

export const PILOT_SCHEMA_VERSION = 1 as const

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
  /** arm → fixture id → counts. */
  tally: Partial<Record<PilotArm, Record<string, PilotCell>>>
}

const emptyCell = (): PilotCell => ({ runs: 0, te1_pass: 0, te2_pass: 0, both_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0, instruction_present: 0 })

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

/** Counts one pilot campaign into `arm → fixture → cell`. A manifest without an `arm` means this is not a pilot campaign. */
export function tallyPilotCampaign(campaignDir: string, ctx: PilotContext): PilotTally {
  const tally: PilotTally['tally'] = {}
  for (const { dir: runDir, manifest: m } of loadCampaignRuns(campaignDir)) {
    if (m.arm === undefined) throw new Error(`${m.run_id} carries no arm: ${campaignDir} is not a pilot campaign`)
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
  return projectPilot({ ...ctx, tally })
}

/** The fixed-key projection: nothing but the allowlisted keys reaches the file. */
export function projectPilot(input: PilotContext & { tally: PilotTally['tally'] }): PilotTally {
  const tally: PilotTally['tally'] = {}
  for (const arm of PILOT_ARMS) {
    const fixtures = input.tally[arm]
    if (!fixtures) continue
    tally[arm] = Object.fromEntries(Object.keys(fixtures).sort().map((id) => [id, fixedCell(fixtures[id]!)]))
  }
  return {
    schema_version: PILOT_SCHEMA_VERSION,
    method: input.method,
    prereg_content_hash: input.prereg_content_hash,
    agent_model_id: input.agent_model_id,
    judge_model_id: input.judge_model_id,
    arms: PILOT_ARMS.filter((arm) => tally[arm] !== undefined),
    tally,
  }
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

function readExisting(path: string): PilotTally | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PilotTally
    if (raw.schema_version !== PILOT_SCHEMA_VERSION || typeof raw.tally !== 'object' || raw.tally === null) return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * Writes `evals/<method>/pilot/pilot.json`. Arms run in separate campaigns, so an arm already tallied under the same prereg content
 * stays, and `incoming` replaces only its own arms; a different prereg content hash starts the file over.
 */
export function writePilotTally(repoRoot: string, incoming: PilotTally): string {
  const path = pilotTallyPath(repoRoot, incoming.method)
  const existing = readExisting(path)
  const kept = existing && existing.prereg_content_hash === incoming.prereg_content_hash ? existing.tally : {}
  const merged = projectPilot({ ...incoming, tally: { ...kept, ...incoming.tally } })
  mkdirSync(pilotDir(repoRoot, incoming.method), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}
