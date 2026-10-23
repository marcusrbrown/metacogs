/**
 * Allowlist projection of a campaign into `evals/reports/<method>/red.json`.
 *
 * The report contains counts, Wilson intervals, per-fixture `fail/total`,
 * outcome-taxonomy tallies, verdict enums, hashes, model ids, SHAs, and the
 * prereg tag. It never contains stdout, stderr, transcripts, quotes, paths,
 * or environment. Two layers enforce that: `buildRedReport` only reads named
 * manifest fields, and `validateReport` rejects any key or string value that
 * is not in the schema below (checked again before every write).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { type HumanReview, type HumanReviewBlock, humanReviewBlock } from './human-review'
import { type RunManifest, manifestPath, readManifest } from './manifest'
import type { Prereg, PreregShas } from './prereg'
import { sha256 } from './workspace'

export const REPORT_SCHEMA_VERSION = 1 as const

// ── statistics ─────────────────────────────────────────────────────────────

const round4 = (x: number) => Math.round(x * 10_000) / 10_000

/** Wilson score interval (z = 1.96) for `k` successes in `n` trials; `[0, 1]` when `n` is 0. */
export function wilson95(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1]
  const z = 1.959964
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [round4(Math.max(0, centre - half)), round4(Math.min(1, centre + half))]
}

// ── shape ──────────────────────────────────────────────────────────────────

export interface OutcomeCounts {
  pass: number
  /** Judge returned `fail`. */
  fail_judge_verdict: number
  /** A deterministic check failed (a baseline's only possible one is an unreadable event stream). */
  fail_check: number
  fail_timeout: number
  fail_budget: number
  fail_host_crash: number
  /** judge_error, counted as FAIL per the prereg. */
  fail_judge_error: number
  /** Attempts (retries included) that ended in `infra_error`; not in any denominator. */
  infra_error: number
  non_isolated: number
}

export interface Taxonomy {
  pass: number
  fail: number
  'timeout->fail': number
  'budget->fail': number
  'judge_error->fail': number
  infra_error: number
  non_isolated: number
}

export interface CriterionTally {
  pass: number
  fail_quoted: number
  fail_absent: number
}

export interface RetainedRun {
  run_id: string
  manifest_sha256: string
  stdout_sha256: string
}

export interface FixtureReport {
  id: string
  kind: 'dev' | 'negative'
  fixture_hash: string
  attempted: number
  pass: number
  fail: number
  fail_over_total: string
  fail_rate_wilson95: [number, number]
  outcomes: OutcomeCounts
  taxonomy: Taxonomy
  criteria: Record<string, CriterionTally>
  /** Dev fixtures: baseline fails >= the prereg bar. Negatives: always false (not part of the bar). */
  meets_red_bar: boolean
  /** The same fail count with `judge_error` runs removed from numerator and denominator (sensitivity only). */
  fail_excluding_judge_error: { fail: number; attempted: number; meets_red_bar: boolean }
  retained: RetainedRun[]
}

export interface RedReport {
  schema_version: typeof REPORT_SCHEMA_VERSION
  kind: 'red'
  method: string
  prereg: {
    tag: string
    tag_object_sha: string
    commit_sha: string
    blob_sha: string
    epoch: number
    rubric_hash: string
    runs_per_condition: number
    per_run_timeout_ms: number
    red_bar: { min_baseline_fails_per_fixture: number; min_fixtures: number }
  }
  repo: { head_sha: string }
  opencode: { package: string; version: string }
  /** `gateways`: which OpenCode gateway answered (Go is the default and preferred; Zen bills credits). A recorded fact. */
  models: { agent_pinned: string; agent_returned: string[]; judge_pinned: string; judge_returned: string[]; gateways?: string[] }
  judge: { system_prompt_sha256: string[]; judged_runs: number; judge_error_runs: number; temperature_observed: number[] }
  campaign: { id: string; started_at: string; finished_at: string; planned_runs: number; executed_manifests: number; incomplete_manifests: number }
  totals: { attempted: number; taxonomy: Taxonomy; wall_clock_ms: number; tokens: { input: number; output: number; reasoning: number } }
  fixtures: FixtureReport[]
  red: {
    dev_fixtures_meeting_bar: number
    min_fixtures: number
    green_eligible: boolean
    sensitivity_excluding_judge_error: { dev_fixtures_meeting_bar: number; green_eligible: boolean }
  }
}

// ── building ───────────────────────────────────────────────────────────────

const emptyOutcomes = (): OutcomeCounts => ({ pass: 0, fail_judge_verdict: 0, fail_check: 0, fail_timeout: 0, fail_budget: 0, fail_host_crash: 0, fail_judge_error: 0, infra_error: 0, non_isolated: 0 })
const emptyTaxonomy = (): Taxonomy => ({ pass: 0, fail: 0, 'timeout->fail': 0, 'budget->fail': 0, 'judge_error->fail': 0, infra_error: 0, non_isolated: 0 })

type Bucket = keyof OutcomeCounts | 'incomplete'

/**
 * A positive-fixture result with no judge verdict behind it: a pass the deterministic checks alone produced, or a run still
 * waiting for the judge. Failures that never reached the judge (timeout, budget, host crash, failed checks) are real failures.
 */
export function lacksJudgeVerdict(m: Pick<RunManifest, 'outcome' | 'verdict_basis' | 'fixture'>): boolean {
  return m.fixture.kind !== 'negative' && m.verdict_basis !== 'judge' && (m.outcome === 'pass' || m.verdict_basis === 'pending-judge')
}

/** Reports count judged results only: an unjudged positive-fixture run is a reason to stop, not a number to average in. */
function assertAllJudged(runs: readonly LoadedRun[]): void {
  const unjudged = runs.filter((r) => lacksJudgeVerdict(r.manifest))
  if (unjudged.length) {
    throw new Error(`${unjudged.length} positive-fixture run(s) have no judge verdict (${unjudged.slice(0, 3).map((r) => r.manifest.run_id).join(', ')}); judge the campaign before reporting it`)
  }
}

/** One manifest → exactly one bucket. */
export function bucketOf(m: Pick<RunManifest, 'status' | 'outcome' | 'reasons' | 'verdict_basis' | 'fixture'>): Bucket {
  if (m.status === 'infra_error') return 'infra_error'
  if (m.status === 'non_isolated') return 'non_isolated'
  if (m.status === 'running' || m.status === 'interrupted' || m.status === 'credential_leak') return 'incomplete'
  if (lacksJudgeVerdict(m)) return 'incomplete'
  if (m.outcome === 'pass') return 'pass'
  if (m.outcome !== 'fail') return 'incomplete'
  if (m.status === 'timeout') return 'fail_timeout'
  if (m.status === 'budget_exceeded') return 'fail_budget'
  if (m.status === 'host_crash') return 'fail_host_crash'
  if (m.reasons.includes('judge_error')) return 'fail_judge_error'
  if (m.reasons.includes('judge_fail')) return 'fail_judge_verdict'
  return 'fail_check'
}

function addToTaxonomy(t: Taxonomy, bucket: keyof OutcomeCounts): void {
  switch (bucket) {
    case 'pass':
      t.pass += 1
      break
    case 'fail_judge_verdict':
    case 'fail_check':
    case 'fail_host_crash':
      t.fail += 1
      break
    case 'fail_timeout':
      t['timeout->fail'] += 1
      break
    case 'fail_budget':
      t['budget->fail'] += 1
      break
    case 'fail_judge_error':
      t['judge_error->fail'] += 1
      break
    case 'infra_error':
      t.infra_error += 1
      break
    case 'non_isolated':
      t.non_isolated += 1
      break
  }
}

export interface LoadedRun {
  manifest: RunManifest
  manifestSha256: string
}

/** Every `<campaignDir>/<run>/manifest.json`, in run-id order. */
export function loadCampaignManifests(campaignDir: string): LoadedRun[] {
  const out: LoadedRun[] = []
  for (const entry of readdirSync(campaignDir).sort()) {
    const path = manifestPath(join(campaignDir, entry))
    if (!existsSync(path)) continue
    out.push({ manifest: readManifest(path), manifestSha256: sha256(readFileSync(path)) })
  }
  return out
}

export interface RedReportInput {
  prereg: Prereg
  shas: PreregShas
  headSha: string
  runs: readonly LoadedRun[]
  /** `summary.json`'s `planned_runs`, when the campaign wrote one. */
  plannedRuns: number
}

const sorted = <T>(values: Iterable<T>): T[] => [...new Set(values)].sort()

export function buildRedReport(input: RedReportInput): RedReport {
  const { prereg, shas, runs } = input
  if (runs.length === 0) throw new Error('no run manifests to report')
  assertAllJudged(runs)
  const bar = prereg.red_bar

  const byFixture = new Map<string, { id: string; kind: 'dev' | 'negative'; hash: string; runs: LoadedRun[] }>()
  for (const run of runs) {
    const { fixture, condition } = run.manifest
    if (condition !== 'baseline') throw new Error(`RED reports baseline runs only; ${run.manifest.run_id} is ${condition}`)
    if (fixture.kind !== 'dev' && fixture.kind !== 'negative') throw new Error(`unexpected fixture kind ${fixture.kind} in ${run.manifest.run_id}`)
    const key = `${fixture.kind}/${fixture.id}`
    const entry = byFixture.get(key) ?? { id: fixture.id, kind: fixture.kind, hash: fixture.hash, runs: [] }
    entry.runs.push(run)
    byFixture.set(key, entry)
  }
  const ranDev = [...byFixture.values()].filter((e) => e.kind === 'dev').map((e) => e.id)
  const wantDev = Object.keys(prereg.fixture_hashes.dev)
  if (ranDev.length !== wantDev.length || wantDev.some((id) => !ranDev.includes(id))) {
    throw new Error(`the campaign covers dev fixtures [${ranDev.sort().join(', ')}] but the prereg pins [${[...wantDev].sort().join(', ')}]; refusing a partial or foreign RED read`)
  }

  const totalsTaxonomy = emptyTaxonomy()
  let wall = 0
  const tokens = { input: 0, output: 0, reasoning: 0 }
  let incomplete = 0
  let judged = 0
  let judgeErrors = 0

  const fixtures: FixtureReport[] = [...byFixture.values()]
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind === 'dev' ? -1 : 1))
    .map((entry) => {
      const outcomes = emptyOutcomes()
      const taxonomy = emptyTaxonomy()
      const criteria: Record<string, CriterionTally> = {}
      const retained: RetainedRun[] = []
      for (const { manifest, manifestSha256 } of entry.runs) {
        const bucket = bucketOf(manifest)
        if (bucket === 'incomplete') {
          incomplete += 1
          continue
        }
        outcomes[bucket] += 1
        addToTaxonomy(taxonomy, bucket)
        addToTaxonomy(totalsTaxonomy, bucket)
        wall += manifest.wall_clock_ms ?? 0
        tokens.input += manifest.usage?.input ?? 0
        tokens.output += manifest.usage?.output ?? 0
        tokens.reasoning += manifest.usage?.reasoning ?? 0
        if (manifest.judge) {
          judged += 1
          if (manifest.judge.error_code !== null) judgeErrors += 1
          for (const c of manifest.judge.criteria) {
            const t = (criteria[c.id] ??= { pass: 0, fail_quoted: 0, fail_absent: 0 })
            if (c.verdict === 'pass') t.pass += 1
            else if (c.quote.trim().toLowerCase() === 'absent') t.fail_absent += 1
            else t.fail_quoted += 1
          }
        }
        if (manifest.outcome === 'fail') {
          retained.push({ run_id: manifest.run_id, manifest_sha256: manifestSha256, stdout_sha256: manifest.artifacts['stdout.jsonl']?.sha256 ?? '' })
        }
      }
      const fail = outcomes.fail_judge_verdict + outcomes.fail_check + outcomes.fail_timeout + outcomes.fail_budget + outcomes.fail_host_crash + outcomes.fail_judge_error
      const attempted = outcomes.pass + fail
      const cleanFail = fail - outcomes.fail_judge_error
      const cleanAttempted = attempted - outcomes.fail_judge_error
      const isDev = entry.kind === 'dev'
      return {
        id: entry.id,
        kind: entry.kind,
        fixture_hash: entry.hash,
        attempted,
        pass: outcomes.pass,
        fail,
        fail_over_total: `${fail}/${attempted}`,
        fail_rate_wilson95: wilson95(fail, attempted),
        outcomes,
        taxonomy,
        criteria,
        meets_red_bar: isDev && attempted > 0 && fail >= bar.min_baseline_fails_per_fixture,
        fail_excluding_judge_error: { fail: cleanFail, attempted: cleanAttempted, meets_red_bar: isDev && cleanAttempted > 0 && cleanFail >= bar.min_baseline_fails_per_fixture },
        retained,
      }
    })

  const dev = fixtures.filter((f) => f.kind === 'dev')
  const meeting = dev.filter((f) => f.meets_red_bar).length
  const meetingClean = dev.filter((f) => f.fail_excluding_judge_error.meets_red_bar).length
  const manifests = runs.map((r) => r.manifest)

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    kind: 'red',
    method: prereg.method,
    prereg: {
      tag: shas.tag,
      tag_object_sha: shas.tagObjectSha,
      commit_sha: shas.commitSha,
      blob_sha: shas.blobSha,
      epoch: prereg.epoch,
      rubric_hash: prereg.rubric_hash,
      runs_per_condition: prereg.runs_per_condition,
      per_run_timeout_ms: prereg.per_run_timeout_ms,
      red_bar: { ...bar },
    },
    repo: { head_sha: input.headSha },
    opencode: { package: manifests[0]!.opencode.package, version: manifests[0]!.opencode.version },
    models: {
      agent_pinned: prereg.agent_model_id,
      agent_returned: sorted(manifests.flatMap((m) => m.model.returned)),
      judge_pinned: prereg.judge_model_id,
      judge_returned: sorted(manifests.flatMap((m) => m.judge?.model.returned ?? [])),
      gateways: sorted(manifests.flatMap((m) => [m.gateway, m.judge?.gateway].filter((g): g is NonNullable<typeof g> => Boolean(g)))),
    },
    judge: {
      system_prompt_sha256: sorted(manifests.flatMap((m) => (m.judge ? [m.judge.system_prompt_sha256] : []))),
      judged_runs: judged,
      judge_error_runs: judgeErrors,
      temperature_observed: sorted(manifests.flatMap((m) => (m.judge?.temperature == null ? [] : [m.judge.temperature]))),
    },
    campaign: {
      id: manifests[0]!.campaign_id,
      started_at: sorted(manifests.map((m) => m.started_at))[0]!,
      finished_at: sorted(manifests.map((m) => m.finished_at ?? m.started_at)).at(-1)!,
      planned_runs: input.plannedRuns,
      executed_manifests: manifests.length,
      incomplete_manifests: incomplete,
    },
    totals: {
      attempted: totalsTaxonomy.pass + totalsTaxonomy.fail + totalsTaxonomy['timeout->fail'] + totalsTaxonomy['budget->fail'] + totalsTaxonomy['judge_error->fail'],
      taxonomy: totalsTaxonomy,
      wall_clock_ms: wall,
      tokens,
    },
    fixtures,
    red: {
      dev_fixtures_meeting_bar: meeting,
      min_fixtures: bar.min_fixtures,
      green_eligible: meeting >= bar.min_fixtures,
      sensitivity_excluding_judge_error: { dev_fixtures_meeting_bar: meetingClean, green_eligible: meetingClean >= bar.min_fixtures },
    },
  }
}

// ── allowlist validation ───────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
/** `provider/model` as pinned in a prereg. */
const PINNED_MODEL = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const RETURNED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type Schema =
  | { t: 'str'; re: RegExp }
  | { t: 'lit'; v: string | number }
  | { t: 'int' }
  | { t: 'num' }
  | { t: 'bool' }
  | { t: 'arr'; of: Schema }
  | { t: 'tuple2num' }
  | { t: 'tuple2delta' }
  | { t: 'opt'; of: Schema }
  | { t: 'obj'; shape: Record<string, Schema> }
  | { t: 'rec'; keys: RegExp; of: Schema }

const str = (re: RegExp): Schema => ({ t: 'str', re })
const INT: Schema = { t: 'int' }
const NUM: Schema = { t: 'num' }
const BOOL: Schema = { t: 'bool' }
const obj = (shape: Record<string, Schema>): Schema => ({ t: 'obj', shape })
const arr = (of: Schema): Schema => ({ t: 'arr', of })

/** Reports from before the gateway was recorded omit `gateways`; new ones always carry it. */
const gatewaysShape: Schema = { t: 'opt', of: { t: 'arr', of: { t: 'str', re: /^(go|zen|cliproxy|mixed)$/ } } }

/** `load_rate` arrived with the epoch-3 reads; the committed epoch-2 reports omit it. New reports always carry it. */
const loadRateShape: Schema = { t: 'opt', of: { t: 'num' } }

const outcomesShape = (): Schema =>
  obj(Object.fromEntries(Object.keys(emptyOutcomes()).map((k) => [k, INT])))
const taxonomyShape = (): Schema =>
  obj(Object.fromEntries(Object.keys(emptyTaxonomy()).map((k) => [k, INT])))

export const RED_REPORT_SCHEMA: Schema = obj({
  schema_version: { t: 'lit', v: REPORT_SCHEMA_VERSION },
  kind: { t: 'lit', v: 'red' },
  method: str(/^[a-z][a-z0-9-]{0,63}$/),
  prereg: obj({
    tag: str(/^prereg\/[a-z][a-z0-9-]{0,63}\/\d+$/),
    tag_object_sha: str(HEX40),
    commit_sha: str(HEX40),
    blob_sha: str(HEX40),
    epoch: INT,
    rubric_hash: str(HEX64),
    runs_per_condition: INT,
    per_run_timeout_ms: INT,
    red_bar: obj({ min_baseline_fails_per_fixture: INT, min_fixtures: INT }),
  }),
  repo: obj({ head_sha: str(HEX40) }),
  opencode: obj({ package: str(/^[a-z][a-z0-9-]*$/), version: str(/^\d+\.\d+\.\d+$/) }),
  models: obj({
    agent_pinned: str(PINNED_MODEL),
    agent_returned: arr(str(RETURNED_MODEL)),
    judge_pinned: str(PINNED_MODEL),
    judge_returned: arr(str(RETURNED_MODEL)),
    gateways: gatewaysShape,
  }),
  judge: obj({ system_prompt_sha256: arr(str(HEX64)), judged_runs: INT, judge_error_runs: INT, temperature_observed: arr(NUM) }),
  campaign: obj({
    id: str(/^[a-z][a-z0-9-]*-red-[0-9TZ-]+$/),
    started_at: str(ISO),
    finished_at: str(ISO),
    planned_runs: INT,
    executed_manifests: INT,
    incomplete_manifests: INT,
  }),
  totals: obj({ attempted: INT, taxonomy: taxonomyShape(), wall_clock_ms: INT, tokens: obj({ input: INT, output: INT, reasoning: INT }) }),
  fixtures: arr(
    obj({
      id: str(ID),
      kind: str(/^(dev|negative)$/),
      fixture_hash: str(HEX64),
      attempted: INT,
      pass: INT,
      fail: INT,
      fail_over_total: str(/^\d+\/\d+$/),
      fail_rate_wilson95: { t: 'tuple2num' },
      outcomes: outcomesShape(),
      taxonomy: taxonomyShape(),
      criteria: { t: 'rec', keys: /^[A-Z]{2}\d+$/, of: obj({ pass: INT, fail_quoted: INT, fail_absent: INT }) },
      meets_red_bar: BOOL,
      fail_excluding_judge_error: obj({ fail: INT, attempted: INT, meets_red_bar: BOOL }),
      retained: arr(obj({ run_id: str(/^\d{3}-(dev|negative)-[A-Za-z0-9._-]+-baseline-r\d+(-a\d+)?$/), manifest_sha256: str(HEX64), stdout_sha256: str(HEX64) })),
    }),
  ),
  red: obj({
    dev_fixtures_meeting_bar: INT,
    min_fixtures: INT,
    green_eligible: BOOL,
    sensitivity_excluding_judge_error: obj({ dev_fixtures_meeting_bar: INT, green_eligible: BOOL }),
  }),
})

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  const fail = (message: string): void => {
    errors.push(`${path || '$'}: ${message}`)
  }
  switch (schema.t) {
    case 'str':
      if (typeof value !== 'string') fail('expected a string')
      else if (!schema.re.test(value)) fail('string is outside the allowlisted pattern')
      return
    case 'lit':
      if (value !== schema.v) fail(`expected ${JSON.stringify(schema.v)}`)
      return
    case 'int':
      if (!Number.isInteger(value) || (value as number) < 0) fail('expected a non-negative integer')
      return
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a finite number')
      return
    case 'bool':
      if (typeof value !== 'boolean') fail('expected a boolean')
      return
    case 'tuple2num':
      if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) fail('expected [lo, hi] within [0, 1]')
      return
    case 'tuple2delta':
      if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && n >= -1 && n <= 1)) fail('expected [lo, hi] within [-1, 1]')
      return
    case 'arr':
      if (!Array.isArray(value)) fail('expected an array')
      else value.forEach((v, i) => check(v, schema.of, `${path}[${i}]`, errors))
      return
    case 'obj': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('expected an object')
        return
      }
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) if (!(key in schema.shape)) errors.push(`${path ? `${path}.` : ''}${key}: key is not in the allowlist`)
      for (const [key, sub] of Object.entries(schema.shape)) {
        if (!(key in record)) {
          if (sub.t !== 'opt') errors.push(`${path ? `${path}.` : ''}${key}: missing`)
        } else {
          check(record[key], sub, path ? `${path}.${key}` : key, errors)
        }
      }
      return
    }
    case 'opt':
      check(value, schema.of, path, errors)
      return
    case 'rec': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('expected an object')
        return
      }
      for (const [key, v] of Object.entries(value)) {
        if (!schema.keys.test(key)) errors.push(`${path}.${key}: key is not in the allowlist`)
        else check(v, schema.of, `${path}.${key}`, errors)
      }
    }
  }
}

/** Empty when `report` has exactly the allowlisted keys with allowlisted value shapes. */
export function validateReport(report: unknown): string[] {
  const errors: string[] = []
  check(report, RED_REPORT_SCHEMA, '', errors)
  return errors
}

export function reportPath(repoRoot: string, method: string): string {
  return join(repoRoot, 'evals', 'reports', method, 'red.json')
}

/** Validates, then writes with stable formatting. Throws on any allowlist violation. */
export function writeReport(repoRoot: string, report: RedReport): string {
  const errors = validateReport(report)
  if (errors.length) throw new Error(`report is not an allowlist projection:\n  ${errors.join('\n  ')}`)
  const path = reportPath(repoRoot, report.method)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}

// ── dev (authoring-iteration) report ───────────────────────────────────────
//
// `evals/reports/<method>/green-dev.json`: the skill condition on dev and negative
// fixtures only. It is not a GREEN read: it never touches held-out content, and the
// dev bar below is an authoring margin, not a prereg bar.

/** Dev fixtures: pass at least this fraction of attempted runs (4/5 at N=5). Negatives: no false fire. */
export const DEV_BAR = { min_pass_fraction: 0.8, max_negative_false_fires: 0 } as const

/** Runs per way the skill text reached the model. Negatives and non-fires are `none`. */
export interface FireBasisTally {
  skill_tool: number
  direct_read: number
  none: number
}

const emptyFireBasis = (): FireBasisTally => ({ skill_tool: 0, direct_read: 0, none: 0 })

/** The tally key of a manifest's `fire_basis`. A read of the skill file through a shell reader is pooled with `direct_read`. */
const tallyKeyOf = (basis: RunManifest['fire_basis']): keyof FireBasisTally => (basis === undefined || basis === null ? 'none' : basis === 'bash-read' ? 'direct_read' : basis)

/**
 * Share of attempted skill-condition runs in which the skill text reached the model (`skill_tool` + `direct_read`), whatever
 * the answer was. Reported next to the pass rate as its own metric; it is not a bar. `0` when nothing was attempted.
 */
export const loadRateOf = (tally: FireBasisTally): number => {
  const total = tally.skill_tool + tally.direct_read + tally.none
  return total === 0 ? 0 : round4((tally.skill_tool + tally.direct_read) / total)
}

export interface DevFixtureReport {
  id: string
  kind: 'dev' | 'negative'
  fixture_hash: string
  attempted: number
  pass: number
  /** Dev: failed runs. Negative: false fires and every other failure of a silent run. */
  fail: number
  pass_over_total: string
  pass_rate_wilson95: [number, number]
  outcomes: OutcomeCounts
  taxonomy: Taxonomy
  criteria: Record<string, CriterionTally>
  /** Deterministic-check failure codes (a closed vocabulary) → run count. */
  check_codes: Record<string, number>
  /** How the skill fired in the runs counted above (infra_error and non_isolated attempts excluded). */
  fire_basis: FireBasisTally
  /** `loadRateOf(fire_basis)`: how often the skill loaded in this fixture's runs. */
  load_rate: number
  meets_dev_bar: boolean
}

export interface DevReport {
  schema_version: typeof REPORT_SCHEMA_VERSION
  kind: 'green-dev'
  method: string
  held_out: 'untouched'
  prereg: {
    tag: string
    tag_object_sha: string
    commit_sha: string
    blob_sha: string
    epoch: number
    rubric_hash: string
    runs_per_condition: number
    per_run_timeout_ms: number
  }
  repo: { head_sha: string }
  skill: { sha256: string }
  opencode: { package: string; version: string }
  /** `gateways`: which OpenCode gateway answered (Go is the default and preferred; Zen bills credits). A recorded fact. */
  models: { agent_pinned: string; agent_returned: string[]; judge_pinned: string; judge_returned: string[]; gateways?: string[] }
  judge: { system_prompt_sha256: string[]; judged_runs: number; judge_error_runs: number; temperature_observed: number[] }
  campaign: { id: string; started_at: string; finished_at: string; planned_runs: number; executed_manifests: number; incomplete_manifests: number }
  totals: { attempted: number; taxonomy: Taxonomy; wall_clock_ms: number; tokens: { input: number; output: number; reasoning: number } }
  dev_bar: { min_pass_fraction: number; max_negative_false_fires: number }
  fixtures: DevFixtureReport[]
  dev: {
    dev_fixtures: number
    dev_fixtures_meeting_bar: number
    negative_fixtures: number
    negative_false_fires: number
    /** Summed over the dev (positive) fixtures. */
    fire_basis: FireBasisTally
    /** `loadRateOf` over the summed `fire_basis`: the pooled skill-load rate on dev fixtures. Its own metric, not a bar. */
    load_rate: number
    passes_dev_bar: boolean
  }
}

export interface DevReportInput {
  prereg: Prereg
  shas: PreregShas
  headSha: string
  runs: readonly LoadedRun[]
  plannedRuns: number
  /** Hash of `skills/<method>/` as checked out now; every manifest must have run exactly this skill. */
  skillSha256: string
}

export function buildDevReport(input: DevReportInput): DevReport {
  const { prereg, shas, runs } = input
  if (runs.length === 0) throw new Error('no run manifests to report')
  assertAllJudged(runs)

  const byFixture = new Map<string, { id: string; kind: 'dev' | 'negative'; hash: string; runs: LoadedRun[] }>()
  for (const run of runs) {
    const { fixture, condition, skill } = run.manifest
    if (condition !== 'skill') throw new Error(`a dev report covers skill-condition runs only; ${run.manifest.run_id} is ${condition}`)
    if (fixture.kind !== 'dev' && fixture.kind !== 'negative') throw new Error(`unexpected fixture kind ${fixture.kind} in ${run.manifest.run_id}`)
    if (skill?.sha256 !== input.skillSha256) {
      throw new Error(`${run.manifest.run_id} ran a different skill than the one checked out now; rerun the campaign on the committed skill`)
    }
    const key = `${fixture.kind}/${fixture.id}`
    const entry = byFixture.get(key) ?? { id: fixture.id, kind: fixture.kind, hash: fixture.hash, runs: [] }
    entry.runs.push(run)
    byFixture.set(key, entry)
  }

  const totalsTaxonomy = emptyTaxonomy()
  let wall = 0
  const tokens = { input: 0, output: 0, reasoning: 0 }
  let incomplete = 0
  let judged = 0
  let judgeErrors = 0

  const fixtures: DevFixtureReport[] = [...byFixture.values()]
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind === 'dev' ? -1 : 1))
    .map((entry) => {
      const outcomes = emptyOutcomes()
      const taxonomy = emptyTaxonomy()
      const criteria: Record<string, CriterionTally> = {}
      const checkCodes: Record<string, number> = {}
      const fireBasis = emptyFireBasis()
      for (const { manifest } of entry.runs) {
        const bucket = bucketOf(manifest)
        if (bucket === 'incomplete') {
          incomplete += 1
          continue
        }
        outcomes[bucket] += 1
        if (bucket !== 'infra_error' && bucket !== 'non_isolated') fireBasis[tallyKeyOf(manifest.fire_basis)] += 1
        addToTaxonomy(taxonomy, bucket)
        addToTaxonomy(totalsTaxonomy, bucket)
        wall += manifest.wall_clock_ms ?? 0
        tokens.input += manifest.usage?.input ?? 0
        tokens.output += manifest.usage?.output ?? 0
        tokens.reasoning += manifest.usage?.reasoning ?? 0
        for (const f of manifest.check_failures) checkCodes[f.code] = (checkCodes[f.code] ?? 0) + 1
        if (manifest.judge) {
          judged += 1
          if (manifest.judge.error_code !== null) judgeErrors += 1
          for (const c of manifest.judge.criteria) {
            const t = (criteria[c.id] ??= { pass: 0, fail_quoted: 0, fail_absent: 0 })
            if (c.verdict === 'pass') t.pass += 1
            else if (c.quote.trim().toLowerCase() === 'absent') t.fail_absent += 1
            else t.fail_quoted += 1
          }
        }
      }
      const fail = outcomes.fail_judge_verdict + outcomes.fail_check + outcomes.fail_timeout + outcomes.fail_budget + outcomes.fail_host_crash + outcomes.fail_judge_error
      const attempted = outcomes.pass + fail
      const meets =
        entry.kind === 'dev'
          ? attempted > 0 && outcomes.pass >= attempted * DEV_BAR.min_pass_fraction
          : attempted > 0 && fail <= DEV_BAR.max_negative_false_fires
      return {
        id: entry.id,
        kind: entry.kind,
        fixture_hash: entry.hash,
        attempted,
        pass: outcomes.pass,
        fail,
        pass_over_total: `${outcomes.pass}/${attempted}`,
        pass_rate_wilson95: wilson95(outcomes.pass, attempted),
        outcomes,
        taxonomy,
        criteria,
        check_codes: Object.fromEntries(Object.entries(checkCodes).sort(([a], [b]) => (a < b ? -1 : 1))),
        fire_basis: fireBasis,
        load_rate: loadRateOf(fireBasis),
        meets_dev_bar: meets,
      }
    })

  const dev = fixtures.filter((f) => f.kind === 'dev')
  const negatives = fixtures.filter((f) => f.kind === 'negative')
  const devMeeting = dev.filter((f) => f.meets_dev_bar).length
  const falseFires = negatives.reduce((n, f) => n + f.fail, 0)
  const manifests = runs.map((r) => r.manifest)
  const devFireBasis = dev.reduce((t, f) => ({ skill_tool: t.skill_tool + f.fire_basis.skill_tool, direct_read: t.direct_read + f.fire_basis.direct_read, none: t.none + f.fire_basis.none }), emptyFireBasis())

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    kind: 'green-dev',
    method: prereg.method,
    held_out: 'untouched',
    prereg: {
      tag: shas.tag,
      tag_object_sha: shas.tagObjectSha,
      commit_sha: shas.commitSha,
      blob_sha: shas.blobSha,
      epoch: prereg.epoch,
      rubric_hash: prereg.rubric_hash,
      runs_per_condition: prereg.runs_per_condition,
      per_run_timeout_ms: prereg.per_run_timeout_ms,
    },
    repo: { head_sha: input.headSha },
    skill: { sha256: input.skillSha256 },
    opencode: { package: manifests[0]!.opencode.package, version: manifests[0]!.opencode.version },
    models: {
      agent_pinned: prereg.agent_model_id,
      agent_returned: sorted(manifests.flatMap((m) => m.model.returned)),
      judge_pinned: prereg.judge_model_id,
      judge_returned: sorted(manifests.flatMap((m) => m.judge?.model.returned ?? [])),
      gateways: sorted(manifests.flatMap((m) => [m.gateway, m.judge?.gateway].filter((g): g is NonNullable<typeof g> => Boolean(g)))),
    },
    judge: {
      system_prompt_sha256: sorted(manifests.flatMap((m) => (m.judge ? [m.judge.system_prompt_sha256] : []))),
      judged_runs: judged,
      judge_error_runs: judgeErrors,
      temperature_observed: sorted(manifests.flatMap((m) => (m.judge?.temperature == null ? [] : [m.judge.temperature]))),
    },
    campaign: {
      id: manifests[0]!.campaign_id,
      started_at: sorted(manifests.map((m) => m.started_at))[0]!,
      finished_at: sorted(manifests.map((m) => m.finished_at ?? m.started_at)).at(-1)!,
      planned_runs: input.plannedRuns,
      executed_manifests: manifests.length,
      incomplete_manifests: incomplete,
    },
    totals: {
      attempted: totalsTaxonomy.pass + totalsTaxonomy.fail + totalsTaxonomy['timeout->fail'] + totalsTaxonomy['budget->fail'] + totalsTaxonomy['judge_error->fail'],
      taxonomy: totalsTaxonomy,
      wall_clock_ms: wall,
      tokens,
    },
    dev_bar: { ...DEV_BAR },
    fixtures,
    dev: {
      dev_fixtures: dev.length,
      dev_fixtures_meeting_bar: devMeeting,
      negative_fixtures: negatives.length,
      negative_false_fires: falseFires,
      fire_basis: devFireBasis,
      load_rate: loadRateOf(devFireBasis),
      passes_dev_bar: dev.length > 0 && negatives.length > 0 && devMeeting === dev.length && negatives.every((f) => f.meets_dev_bar),
    },
  }
}

export interface DevRegressionInput {
  prereg: Prereg
  shas: PreregShas
  headSha: string
  /** Every manifest of the dev campaign that `green-dev.json` names. */
  runs: readonly LoadedRun[]
  plannedRuns: number
}

/**
 * The dev-regression facts of a GREEN read, rebuilt from the dev campaign's manifests instead of read from the committed
 * `green-dev.json`. Throws unless the campaign ran under this prereg, on one skill, over exactly the prereg's dev and
 * negative fixtures.
 */
export function recomputeDevRegression(input: DevRegressionInput): Pick<DevReport, 'skill' | 'dev'> {
  const { prereg, shas, runs } = input
  if (runs.length === 0) throw new Error('the dev campaign has no run manifests')
  const foreign = runs.filter((r) => r.manifest.prereg.commit_sha !== shas.commitSha)
  if (foreign.length) throw new Error(`${foreign.length} dev manifest(s) were not produced under ${shas.tag} (${shas.commitSha.slice(0, 12)})`)
  const skills = new Set(runs.map((r) => r.manifest.skill?.sha256))
  const [skillSha256] = [...skills]
  if (skills.size !== 1 || !skillSha256) throw new Error('the dev campaign did not run exactly one skill')
  for (const kind of ['dev', 'negative'] as const) {
    const want = prereg.fixture_hashes[kind]
    const ran = runs.filter((r) => r.manifest.fixture.kind === kind).map((r) => r.manifest.fixture)
    const wrong = [...Object.keys(want).filter((id) => !ran.some((f) => f.id === id)), ...ran.filter((f) => want[f.id] !== f.hash).map((f) => f.id)]
    if (wrong.length) throw new Error(`the dev campaign's ${kind} fixtures do not match the prereg (${[...new Set(wrong)].sort().join(', ')})`)
  }
  const { skill, dev } = buildDevReport({ ...input, skillSha256 })
  return { skill, dev }
}

export const DEV_REPORT_SCHEMA: Schema = obj({
  schema_version: { t: 'lit', v: REPORT_SCHEMA_VERSION },
  kind: { t: 'lit', v: 'green-dev' },
  method: str(/^[a-z][a-z0-9-]{0,63}$/),
  held_out: { t: 'lit', v: 'untouched' },
  prereg: obj({
    tag: str(/^prereg\/[a-z][a-z0-9-]{0,63}\/\d+$/),
    tag_object_sha: str(HEX40),
    commit_sha: str(HEX40),
    blob_sha: str(HEX40),
    epoch: INT,
    rubric_hash: str(HEX64),
    runs_per_condition: INT,
    per_run_timeout_ms: INT,
  }),
  repo: obj({ head_sha: str(HEX40) }),
  skill: obj({ sha256: str(HEX64) }),
  opencode: obj({ package: str(/^[a-z][a-z0-9-]*$/), version: str(/^\d+\.\d+\.\d+$/) }),
  models: obj({
    agent_pinned: str(PINNED_MODEL),
    agent_returned: arr(str(RETURNED_MODEL)),
    judge_pinned: str(PINNED_MODEL),
    judge_returned: arr(str(RETURNED_MODEL)),
    gateways: gatewaysShape,
  }),
  judge: obj({ system_prompt_sha256: arr(str(HEX64)), judged_runs: INT, judge_error_runs: INT, temperature_observed: arr(NUM) }),
  campaign: obj({
    id: str(/^[a-z][a-z0-9-]*-dev-[0-9TZ-]+$/),
    started_at: str(ISO),
    finished_at: str(ISO),
    planned_runs: INT,
    executed_manifests: INT,
    incomplete_manifests: INT,
  }),
  totals: obj({ attempted: INT, taxonomy: taxonomyShape(), wall_clock_ms: INT, tokens: obj({ input: INT, output: INT, reasoning: INT }) }),
  dev_bar: obj({ min_pass_fraction: NUM, max_negative_false_fires: INT }),
  fixtures: arr(
    obj({
      id: str(ID),
      kind: str(/^(dev|negative)$/),
      fixture_hash: str(HEX64),
      attempted: INT,
      pass: INT,
      fail: INT,
      pass_over_total: str(/^\d+\/\d+$/),
      pass_rate_wilson95: { t: 'tuple2num' },
      outcomes: outcomesShape(),
      taxonomy: taxonomyShape(),
      criteria: { t: 'rec', keys: /^[A-Z]{2}\d+$/, of: obj({ pass: INT, fail_quoted: INT, fail_absent: INT }) },
      check_codes: { t: 'rec', keys: /^[a-z][a-z_]*$/, of: INT },
      fire_basis: obj({ skill_tool: INT, direct_read: INT, none: INT }),
      load_rate: loadRateShape,
      meets_dev_bar: BOOL,
    }),
  ),
  dev: obj({
    dev_fixtures: INT,
    dev_fixtures_meeting_bar: INT,
    negative_fixtures: INT,
    negative_false_fires: INT,
    fire_basis: obj({ skill_tool: INT, direct_read: INT, none: INT }),
    load_rate: loadRateShape,
    passes_dev_bar: BOOL,
  }),
})

/** Empty when `report` has exactly the allowlisted keys with allowlisted value shapes. */
export function validateDevReport(report: unknown): string[] {
  const errors: string[] = []
  check(report, DEV_REPORT_SCHEMA, '', errors)
  return errors
}

export function devReportPath(repoRoot: string, method: string): string {
  return join(repoRoot, 'evals', 'reports', method, 'green-dev.json')
}

export function writeDevReport(repoRoot: string, report: DevReport): string {
  const errors = validateDevReport(report)
  if (errors.length) throw new Error(`report is not an allowlist projection:\n  ${errors.join('\n  ')}`)
  const path = devReportPath(repoRoot, report.method)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}

// ── GREEN report (held-out, one-shot) ──────────────────────────────────────
//
// `evals/reports/<method>/green.json`. Counts, intervals, paired per-fixture outcomes, and a
// verdict. No held-out text, answers, quotes, or paths: held-out fixtures appear by id and hash
// only (both already in the prereg).

/** Newcombe's hybrid score interval for a difference of two proportions (Wilson-based), clamped to [-1, 1]. */
export function newcombe95(k1: number, n1: number, k2: number, n2: number): [number, number] {
  if (n1 <= 0 || n2 <= 0) return [-1, 1]
  const p1 = k1 / n1
  const p2 = k2 / n2
  const [l1, u1] = wilson95(k1, n1)
  const [l2, u2] = wilson95(k2, n2)
  const d = p1 - p2
  const lo = d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
  const hi = d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
  return [round4(Math.max(-1, lo)), round4(Math.min(1, hi))]
}

export interface GreenCell {
  attempted: number
  pass: number
  fail: number
  pass_over_total: string
  pass_rate_wilson95: [number, number]
  outcomes: OutcomeCounts
  taxonomy: Taxonomy
  criteria: Record<string, CriterionTally>
  check_codes: Record<string, number>
  fire_basis: FireBasisTally
  load_rate: number
}

export interface GreenDelta {
  /** Skill pass rate minus baseline pass rate. */
  value: number
  newcombe95: [number, number]
}

export interface GreenFixtureReport {
  id: string
  fixture_hash: string
  skill: GreenCell
  baseline: GreenCell
  delta: GreenDelta
  meets_floor: boolean
}

export interface GreenNegativeReport {
  id: string
  fixture_hash: string
  attempted: number
  /** Failed runs of a silent-expected fixture: false fires, plus any other failure. */
  false_fires: number
  outcomes: OutcomeCounts
  taxonomy: Taxonomy
  check_codes: Record<string, number>
  fire_basis: FireBasisTally
  load_rate: number
}

export interface GreenPooled {
  pass: number
  attempted: number
  pass_rate_wilson95: [number, number]
}

export interface GreenReport {
  schema_version: typeof REPORT_SCHEMA_VERSION
  kind: 'green'
  method: string
  prereg: DevReport['prereg']
  repo: { head_sha: string }
  skill: { sha256: string; tree_sha: string }
  opencode: { package: string; version: string }
  models: { agent_pinned: string; agent_returned: string[]; judge_pinned: string; judge_returned: string[]; gateways?: string[] }
  judge: { system_prompt_sha256: string[]; judged_runs: number; judge_error_runs: number; temperature_observed: number[] }
  campaign: { id: string; started_at: string; finished_at: string; planned_runs: number; executed_manifests: number; incomplete_manifests: number }
  totals: { attempted: number; taxonomy: Taxonomy; wall_clock_ms: number; tokens: { input: number; output: number; reasoning: number } }
  bars: { skill_pooled_pass_min: number; skill_per_fixture_pass_min: number; baseline_pooled_pass_max: number; false_fire_max: number }
  heldout: GreenFixtureReport[]
  negatives: GreenNegativeReport[]
  pooled: { skill: GreenPooled; baseline: GreenPooled; delta: GreenDelta }
  /** Skill-condition load rate pooled over the held-out fixtures (`loadRateOf` of the summed `fire_basis`). Its own metric, not a bar. */
  skill_load_rate: number
  dev_regression: { source_report_present: boolean; passes_dev_bar: boolean; skill_matches: boolean }
  near_duplicate_check: 'pass' | 'fail'
  checks: {
    skill_pooled: boolean
    per_fixture_floor: boolean
    baseline_ceiling: boolean
    negatives_silent: boolean
    dev_regression: boolean
    near_duplicate: boolean
  }
  /** `green` only if every check holds. Machine verdict: human review below is still owed. */
  verdict: 'green' | 'green-miss'
  held_out_too_easy: boolean
  /** `pending` until `eval review --reconcile` has produced `human-review.json`; then counts, per-criterion agreement, flipped runs, and a recomputed verdict. */
  human_review: HumanReviewBlock
  /** One-shot: any edit under `skills/<method>/` after this report, in this epoch, burns the held-out set. */
  burn_rule: { one_shot_read: true; skill_edit_burns_set: true }
}

export interface GreenReportInput {
  prereg: Prereg
  shas: PreregShas
  headSha: string
  runs: readonly LoadedRun[]
  plannedRuns: number
  /** Hash of `skills/<method>/` as checked out now. */
  skillSha256: string
  /** The committed `green-dev.json`, parsed; `null` when absent. */
  devReport: Pick<DevReport, 'skill' | 'dev'> | null
  nearDuplicate: 'pass' | 'fail'
  /** The reconciled human review of this campaign, when `human-review.json` exists. */
  humanReview?: HumanReview | null
}

interface Accumulator {
  wall: number
  tokens: { input: number; output: number; reasoning: number }
  incomplete: number
  judged: number
  judgeErrors: number
  taxonomy: Taxonomy
}

function cellOf(runs: readonly LoadedRun[], acc: Accumulator): GreenCell {
  const outcomes = emptyOutcomes()
  const taxonomy = emptyTaxonomy()
  const criteria: Record<string, CriterionTally> = {}
  const checkCodes: Record<string, number> = {}
  const fireBasis = emptyFireBasis()
  for (const { manifest } of runs) {
    const bucket = bucketOf(manifest)
    if (bucket === 'incomplete') {
      acc.incomplete += 1
      continue
    }
    outcomes[bucket] += 1
    addToTaxonomy(taxonomy, bucket)
    addToTaxonomy(acc.taxonomy, bucket)
    acc.wall += manifest.wall_clock_ms ?? 0
    acc.tokens.input += manifest.usage?.input ?? 0
    acc.tokens.output += manifest.usage?.output ?? 0
    acc.tokens.reasoning += manifest.usage?.reasoning ?? 0
    if (bucket !== 'infra_error' && bucket !== 'non_isolated') fireBasis[tallyKeyOf(manifest.fire_basis)] += 1
    for (const f of manifest.check_failures) checkCodes[f.code] = (checkCodes[f.code] ?? 0) + 1
    if (manifest.judge) {
      acc.judged += 1
      if (manifest.judge.error_code !== null) acc.judgeErrors += 1
      for (const c of manifest.judge.criteria) {
        const t = (criteria[c.id] ??= { pass: 0, fail_quoted: 0, fail_absent: 0 })
        if (c.verdict === 'pass') t.pass += 1
        else if (c.quote.trim().toLowerCase() === 'absent') t.fail_absent += 1
        else t.fail_quoted += 1
      }
    }
  }
  const fail = outcomes.fail_judge_verdict + outcomes.fail_check + outcomes.fail_timeout + outcomes.fail_budget + outcomes.fail_host_crash + outcomes.fail_judge_error
  const attempted = outcomes.pass + fail
  return {
    attempted,
    pass: outcomes.pass,
    fail,
    pass_over_total: `${outcomes.pass}/${attempted}`,
    pass_rate_wilson95: wilson95(outcomes.pass, attempted),
    outcomes,
    taxonomy,
    criteria,
    check_codes: Object.fromEntries(Object.entries(checkCodes).sort(([a], [b]) => (a < b ? -1 : 1))),
    fire_basis: fireBasis,
    load_rate: loadRateOf(fireBasis),
  }
}

const deltaOf = (skill: { pass: number; attempted: number }, baseline: { pass: number; attempted: number }): GreenDelta => ({
  value: round4((skill.attempted ? skill.pass / skill.attempted : 0) - (baseline.attempted ? baseline.pass / baseline.attempted : 0)),
  newcombe95: newcombe95(skill.pass, skill.attempted, baseline.pass, baseline.attempted),
})

export function buildGreenReport(input: GreenReportInput): GreenReport {
  const { prereg, shas, runs } = input
  if (runs.length === 0) throw new Error('no run manifests to report')
  assertAllJudged(runs)
  if (!shas.skillTreeSha) throw new Error('GREEN report needs the committed skill tree (enforce the prereg in green mode first)')

  type Group = { id: string; hash: string; baseline: LoadedRun[]; skill: LoadedRun[] }
  const heldout = new Map<string, Group>()
  const negatives = new Map<string, Group>()
  for (const run of runs) {
    const { fixture, condition, skill } = run.manifest
    if (fixture.kind === 'dev') throw new Error(`a GREEN campaign must not contain dev fixtures; ${run.manifest.run_id} is dev`)
    if (condition === 'skill' && skill?.sha256 !== input.skillSha256) {
      throw new Error(`${run.manifest.run_id} ran a different skill than the one checked out now; the read is void`)
    }
    const target = fixture.kind === 'heldout' ? heldout : negatives
    if (fixture.kind === 'negative' && condition !== 'skill') throw new Error(`negatives run under the skill condition only; ${run.manifest.run_id} is ${condition}`)
    const g = target.get(fixture.id) ?? { id: fixture.id, hash: fixture.hash, baseline: [], skill: [] }
    g[condition].push(run)
    target.set(fixture.id, g)
  }
  const wantHeldout = Object.keys(prereg.fixture_hashes.heldout).length
  const wantNegative = Object.keys(prereg.fixture_hashes.negative).length
  if (heldout.size !== wantHeldout || negatives.size !== wantNegative) {
    throw new Error(`campaign covers ${heldout.size}/${wantHeldout} held-out and ${negatives.size}/${wantNegative} negative fixtures; refusing a partial read`)
  }

  const acc: Accumulator = { wall: 0, tokens: { input: 0, output: 0, reasoning: 0 }, incomplete: 0, judged: 0, judgeErrors: 0, taxonomy: emptyTaxonomy() }
  const floor = prereg.green_bar.skill_per_fixture_pass_min
  const heldoutReports: GreenFixtureReport[] = [...heldout.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((g) => {
      const skill = cellOf(g.skill, acc)
      const baseline = cellOf(g.baseline, acc)
      return { id: g.id, fixture_hash: g.hash, skill, baseline, delta: deltaOf(skill, baseline), meets_floor: skill.pass >= floor }
    })
  const negativeReports: GreenNegativeReport[] = [...negatives.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((g) => {
      const cell = cellOf(g.skill, acc)
      return { id: g.id, fixture_hash: g.hash, attempted: cell.attempted, false_fires: cell.fail, outcomes: cell.outcomes, taxonomy: cell.taxonomy, check_codes: cell.check_codes, fire_basis: cell.fire_basis, load_rate: cell.load_rate }
    })
  if (acc.incomplete > 0) throw new Error(`${acc.incomplete} manifest(s) never finished; refusing to report an unfinished campaign`)

  const sum = (pick: (f: GreenFixtureReport) => GreenCell): { pass: number; attempted: number } =>
    heldoutReports.reduce((t, f) => ({ pass: t.pass + pick(f).pass, attempted: t.attempted + pick(f).attempted }), { pass: 0, attempted: 0 })
  const skillPooled = sum((f) => f.skill)
  const baselinePooled = sum((f) => f.baseline)
  const bar = prereg.green_bar
  const falseFires = negativeReports.reduce((n, f) => n + f.false_fires, 0)
  const dev = input.devReport
  const devRegression = {
    source_report_present: dev !== null,
    passes_dev_bar: dev?.dev.passes_dev_bar === true,
    skill_matches: dev?.skill.sha256 === input.skillSha256,
  }
  const checks = {
    skill_pooled: skillPooled.pass >= bar.skill_pooled_pass_min,
    per_fixture_floor: heldoutReports.every((f) => f.meets_floor),
    baseline_ceiling: baselinePooled.pass <= bar.baseline_pooled_pass_max,
    negatives_silent: falseFires <= prereg.false_fire_max,
    dev_regression: devRegression.source_report_present && devRegression.passes_dev_bar && devRegression.skill_matches,
    near_duplicate: input.nearDuplicate === 'pass',
  }
  const manifests = runs.map((r) => r.manifest)
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    kind: 'green',
    method: prereg.method,
    prereg: {
      tag: shas.tag,
      tag_object_sha: shas.tagObjectSha,
      commit_sha: shas.commitSha,
      blob_sha: shas.blobSha,
      epoch: prereg.epoch,
      rubric_hash: prereg.rubric_hash,
      runs_per_condition: prereg.runs_per_condition,
      per_run_timeout_ms: prereg.per_run_timeout_ms,
    },
    repo: { head_sha: input.headSha },
    skill: { sha256: input.skillSha256, tree_sha: shas.skillTreeSha },
    opencode: { package: manifests[0]!.opencode.package, version: manifests[0]!.opencode.version },
    models: {
      agent_pinned: prereg.agent_model_id,
      agent_returned: sorted(manifests.flatMap((m) => m.model.returned)),
      judge_pinned: prereg.judge_model_id,
      judge_returned: sorted(manifests.flatMap((m) => m.judge?.model.returned ?? [])),
      gateways: sorted(manifests.flatMap((m) => [m.gateway, m.judge?.gateway].filter((g): g is NonNullable<typeof g> => Boolean(g)))),
    },
    judge: {
      system_prompt_sha256: sorted(manifests.flatMap((m) => (m.judge ? [m.judge.system_prompt_sha256] : []))),
      judged_runs: acc.judged,
      judge_error_runs: acc.judgeErrors,
      temperature_observed: sorted(manifests.flatMap((m) => (m.judge?.temperature == null ? [] : [m.judge.temperature]))),
    },
    campaign: {
      id: manifests[0]!.campaign_id,
      started_at: sorted(manifests.map((m) => m.started_at))[0]!,
      finished_at: sorted(manifests.map((m) => m.finished_at ?? m.started_at)).at(-1)!,
      planned_runs: input.plannedRuns,
      executed_manifests: manifests.length,
      incomplete_manifests: acc.incomplete,
    },
    totals: {
      attempted: acc.taxonomy.pass + acc.taxonomy.fail + acc.taxonomy['timeout->fail'] + acc.taxonomy['budget->fail'] + acc.taxonomy['judge_error->fail'],
      taxonomy: acc.taxonomy,
      wall_clock_ms: acc.wall,
      tokens: acc.tokens,
    },
    bars: {
      skill_pooled_pass_min: bar.skill_pooled_pass_min,
      skill_per_fixture_pass_min: bar.skill_per_fixture_pass_min,
      baseline_pooled_pass_max: bar.baseline_pooled_pass_max,
      false_fire_max: prereg.false_fire_max,
    },
    heldout: heldoutReports,
    negatives: negativeReports,
    pooled: {
      skill: { ...skillPooled, pass_rate_wilson95: wilson95(skillPooled.pass, skillPooled.attempted) },
      baseline: { ...baselinePooled, pass_rate_wilson95: wilson95(baselinePooled.pass, baselinePooled.attempted) },
      delta: deltaOf(skillPooled, baselinePooled),
    },
    skill_load_rate: loadRateOf(
      heldoutReports.reduce((t, f) => ({ skill_tool: t.skill_tool + f.skill.fire_basis.skill_tool, direct_read: t.direct_read + f.skill.fire_basis.direct_read, none: t.none + f.skill.fire_basis.none }), emptyFireBasis()),
    ),
    dev_regression: devRegression,
    near_duplicate_check: input.nearDuplicate,
    checks,
    verdict: Object.values(checks).every(Boolean) ? 'green' : 'green-miss',
    held_out_too_easy: !checks.baseline_ceiling,
    human_review: input.humanReview
      ? humanReviewBlock(input.humanReview, bar, { negatives_silent: checks.negatives_silent, dev_regression: checks.dev_regression, near_duplicate: checks.near_duplicate }, heldoutReports.map((f) => f.id))
      : { status: 'pending', judged_runs: acc.judged, reviewed: 0 },
    burn_rule: { one_shot_read: true, skill_edit_burns_set: true },
  }
}

const poolShape = (): Schema => obj({ pass: INT, attempted: INT, pass_rate_wilson95: { t: 'tuple2num' } })
const deltaShape = (): Schema => obj({ value: NUM, newcombe95: { t: 'tuple2delta' } })
const cellShape = (): Schema =>
  obj({
    attempted: INT,
    pass: INT,
    fail: INT,
    pass_over_total: str(/^\d+\/\d+$/),
    pass_rate_wilson95: { t: 'tuple2num' },
    outcomes: outcomesShape(),
    taxonomy: taxonomyShape(),
    criteria: { t: 'rec', keys: /^[A-Z]{2}\d+$/, of: obj({ pass: INT, fail_quoted: INT, fail_absent: INT }) },
    check_codes: { t: 'rec', keys: /^[a-z][a-z_]*$/, of: INT },
    fire_basis: obj({ skill_tool: INT, direct_read: INT, none: INT }),
    load_rate: loadRateShape,
  })

const RUN_ID = /^\d{3}-[A-Za-z0-9._-]+$/
const agreementShape = (): Schema => ({ t: 'rec', keys: /^[A-Z]{2}\d+$/, of: obj({ n: INT, agree: INT, rate: NUM, kappa: { t: 'opt', of: NUM }, demoted: BOOL }) })
/** Pending reviews carry the three counts; reconciled ones add agreement, flips, and the recomputed verdict (all optional so earlier reports validate). */
function humanReviewShape(): Schema {
  return obj({
    status: str(/^(pending|partial|complete)$/),
    judged_runs: INT,
    reviewed: INT,
    agreement: { t: 'opt', of: agreementShape() },
    flipped_runs: { t: 'opt', of: arr(str(RUN_ID)) },
    demoted_criteria: { t: 'opt', of: arr(str(/^[A-Z]{2}\d+$/)) },
    recomputed: {
      t: 'opt',
      of: obj({
        skill_pooled_pass: INT,
        baseline_pooled_pass: INT,
        per_fixture_skill_pass: { t: 'rec', keys: ID, of: INT },
        checks: obj({ skill_pooled: BOOL, per_fixture_floor: BOOL, baseline_ceiling: BOOL }),
        verdict: str(/^(green|green-miss)$/),
      }),
    },
  })
}

export const GREEN_REPORT_SCHEMA: Schema = obj({
  schema_version: { t: 'lit', v: REPORT_SCHEMA_VERSION },
  kind: { t: 'lit', v: 'green' },
  method: str(/^[a-z][a-z0-9-]{0,63}$/),
  prereg: obj({
    tag: str(/^prereg\/[a-z][a-z0-9-]{0,63}\/\d+$/),
    tag_object_sha: str(HEX40),
    commit_sha: str(HEX40),
    blob_sha: str(HEX40),
    epoch: INT,
    rubric_hash: str(HEX64),
    runs_per_condition: INT,
    per_run_timeout_ms: INT,
  }),
  repo: obj({ head_sha: str(HEX40) }),
  skill: obj({ sha256: str(HEX64), tree_sha: str(HEX40) }),
  opencode: obj({ package: str(/^[a-z][a-z0-9-]*$/), version: str(/^\d+\.\d+\.\d+$/) }),
  models: obj({
    agent_pinned: str(PINNED_MODEL),
    agent_returned: arr(str(RETURNED_MODEL)),
    judge_pinned: str(PINNED_MODEL),
    judge_returned: arr(str(RETURNED_MODEL)),
    gateways: gatewaysShape,
  }),
  judge: obj({ system_prompt_sha256: arr(str(HEX64)), judged_runs: INT, judge_error_runs: INT, temperature_observed: arr(NUM) }),
  campaign: obj({
    id: str(/^[a-z][a-z0-9-]*-green-[0-9TZ-]+$/),
    started_at: str(ISO),
    finished_at: str(ISO),
    planned_runs: INT,
    executed_manifests: INT,
    incomplete_manifests: INT,
  }),
  totals: obj({ attempted: INT, taxonomy: taxonomyShape(), wall_clock_ms: INT, tokens: obj({ input: INT, output: INT, reasoning: INT }) }),
  bars: obj({ skill_pooled_pass_min: INT, skill_per_fixture_pass_min: INT, baseline_pooled_pass_max: INT, false_fire_max: INT }),
  heldout: arr(obj({ id: str(ID), fixture_hash: str(HEX64), skill: cellShape(), baseline: cellShape(), delta: deltaShape(), meets_floor: BOOL })),
  negatives: arr(
    obj({
      id: str(ID),
      fixture_hash: str(HEX64),
      attempted: INT,
      false_fires: INT,
      outcomes: outcomesShape(),
      taxonomy: taxonomyShape(),
      check_codes: { t: 'rec', keys: /^[a-z][a-z_]*$/, of: INT },
      fire_basis: obj({ skill_tool: INT, direct_read: INT, none: INT }),
      load_rate: loadRateShape,
    }),
  ),
  pooled: obj({ skill: poolShape(), baseline: poolShape(), delta: deltaShape() }),
  skill_load_rate: loadRateShape,
  dev_regression: obj({ source_report_present: BOOL, passes_dev_bar: BOOL, skill_matches: BOOL }),
  near_duplicate_check: str(/^(pass|fail)$/),
  checks: obj({ skill_pooled: BOOL, per_fixture_floor: BOOL, baseline_ceiling: BOOL, negatives_silent: BOOL, dev_regression: BOOL, near_duplicate: BOOL }),
  verdict: str(/^(green|green-miss)$/),
  held_out_too_easy: BOOL,
  human_review: humanReviewShape(),
  burn_rule: obj({ one_shot_read: BOOL, skill_edit_burns_set: BOOL }),
})

export function validateGreenReport(report: unknown): string[] {
  const errors: string[] = []
  check(report, GREEN_REPORT_SCHEMA, '', errors)
  return errors
}

export function greenReportPath(repoRoot: string, method: string): string {
  return join(repoRoot, 'evals', 'reports', method, 'green.json')
}

export function writeGreenReport(repoRoot: string, report: GreenReport): string {
  const errors = validateGreenReport(report)
  if (errors.length) throw new Error(`report is not an allowlist projection:\n  ${errors.join('\n  ')}`)
  const path = greenReportPath(repoRoot, report.method)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}
