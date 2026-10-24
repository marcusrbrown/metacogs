/**
 * Campaign execution: plan interleaved runs, execute each in an isolated
 * workspace, classify outcomes, retry `infra_error`, and write manifests.
 *
 * Orchestration only. Policy lives in the modules it calls: env/workspace
 * (what the child can see), isolation (is the run admissible), checks
 * (did it pass), prereg (may it run at all), manifest (what we record).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { needlesOf, type PassthroughAuth, passthroughNames } from './auth'
import { checkBudget, classifyHostOutcome, type CheckFailure, fireEvidence, helperVersionOf, listRecordFiles, runChecks } from './checks'
import { destroyFixture } from './env'
import { analyzeEvents, type EventSummary, finalAnswerText, isRateLimited, parseEvents } from './events'
import { checkDebugConfig, checkIsolation, type IsolationEvidence } from './isolation'
import type { RubricDeclarations } from './judge'
import { writeJudgeRecord } from './judge-record'
import {
  type ArtifactRef,
  CredentialLeakError,
  type FinalStatus,
  type JudgeEvidence,
  MANIFEST_SCHEMA_VERSION,
  type Needle,
  type PilotArm,
  type RunManifest,
  type RunOutcomeName,
  scanForLeaks,
  writeManifest,
} from './manifest'
import { debugConfig, OPENCODE_PIN, runArgv, sleepUnlessAborted, type SpawnResult, spawnCapture } from './opencode'
import { type Expectation, type LoadedFixture, type PreregVerification } from './prereg'
import {
  gatewayOf,
  isLiveModel,
  PLACEHOLDER_API_KEY,
  providerOf,
  type RecordedRequest,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  skillCallStep,
  type ScriptedStep,
  startRecordingProxy,
  startScriptedProvider,
  upstreamFor,
} from './scripted-provider'
import { countWords, isOverLimit } from './word-limit'
import { type Condition, createRunWorkspace, type FixtureKind, type RunWorkspace, sha256 } from './workspace'

export { CredentialLeakError, isRateLimited }

export type ProviderMode = 'scripted' | 'live'
export const SCRIPTED_MODEL = `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`

// ── planning ───────────────────────────────────────────────────────────────

export interface PlannedRun {
  /** `expectation` is evaluator-only (judge input); it never reaches the agent workspace or the manifest. */
  fixture: { id: string; kind: FixtureKind; text: string; hash: string; expectation?: Expectation }
  condition: Condition
  /** `eval pilot` only: the arm this run belongs to. Reports refuse manifests that carry one. */
  arm?: PilotArm
  /** 1-based repetition for this fixture and condition. */
  index: number
}

export interface PlanInput {
  mode: 'red' | 'green' | 'dev'
  fixtures: { dev: readonly LoadedFixture[]; negative: readonly LoadedFixture[]; heldout: readonly LoadedFixture[] }
  runsPerCondition: number
  /** Restrict to fixtures with this id (single-run debugging). */
  onlyFixture?: string
  /** GREEN only: also run dev fixtures under the skill condition (dev-regression check). */
  includeDev?: boolean
}

/**
 * RED: baseline on dev and negative fixtures. GREEN: baseline and skill on
 * held-out, skill on negatives (false-fire gate), optionally skill on dev.
 * DEV (authoring iteration): skill on dev and negatives only; held-out is never planned.
 * Rounds interleave conditions and flip which goes first per fixture, so
 * neither condition systematically runs earlier (provider drift hits both).
 */
export function planRuns(input: PlanInput): PlannedRun[] {
  const groups: { fixture: LoadedFixture; kind: FixtureKind; conditions: Condition[] }[] = []
  const add = (fixtures: readonly LoadedFixture[], kind: FixtureKind, conditions: Condition[]) => {
    for (const fixture of fixtures) groups.push({ fixture, kind, conditions })
  }
  if (input.mode === 'red') {
    add(input.fixtures.dev, 'dev', ['baseline'])
    add(input.fixtures.negative, 'negative', ['baseline'])
  } else if (input.mode === 'dev') {
    add(input.fixtures.dev, 'dev', ['skill'])
    add(input.fixtures.negative, 'negative', ['skill'])
  } else {
    add(input.fixtures.heldout, 'heldout', ['baseline', 'skill'])
    add(input.fixtures.negative, 'negative', ['skill'])
    if (input.includeDev) add(input.fixtures.dev, 'dev', ['skill'])
  }
  const selected = input.onlyFixture ? groups.filter((g) => g.fixture.id === input.onlyFixture) : groups
  if (input.onlyFixture && selected.length === 0) {
    throw new Error(`no fixture with id "${input.onlyFixture}" in the ${input.mode} plan`)
  }
  const plan: PlannedRun[] = []
  for (let round = 1; round <= input.runsPerCondition; round += 1) {
    selected.forEach((g, gi) => {
      const ordered = (round + gi) % 2 === 0 ? g.conditions : [...g.conditions].reverse()
      for (const condition of ordered) {
        plan.push({
          fixture: {
            id: g.fixture.id,
            kind: g.kind,
            text: g.fixture.text,
            hash: g.fixture.hash,
            ...(g.fixture.expectation ? { expectation: g.fixture.expectation } : {}),
          },
          condition,
          index: round,
        })
      }
    })
  }
  return plan
}

// ── host seam ──────────────────────────────────────────────────────────────

export interface HostRunRequest {
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  /** Live array filled by the provider stub/proxy. Real hosts ignore it; test hosts may append to it. */
  requests: RecordedRequest[]
  /** The generated config the child was given. */
  config: Record<string, unknown>
}

export interface Host {
  run(request: HostRunRequest): Promise<SpawnResult>
  /** Output of `opencode debug config`, or `undefined` if it could not be obtained. */
  debugConfig(request: { cwd: string; env: Record<string, string>; config: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
}

export const realHost: Host = {
  run: (r) => spawnCapture(r.argv, { cwd: r.cwd, env: r.env, timeoutMs: r.timeoutMs, signal: r.signal }),
  debugConfig: async (r) => (await debugConfig({ cwd: r.cwd, env: r.env, timeoutMs: 120_000, signal: r.signal })).json,
}

// ── judge hook ────────────────────────────────────────────────────

export interface JudgeInput {
  method: string
  condition: Condition
  fixture: PlannedRun['fixture']
  finalAnswer: string
  recordJson: string[]
  /** The campaign's interrupt: the judge's spawn and its backoff waits stop when it fires. */
  signal?: AbortSignal
}

/** Transport-level reasons a judge call produced no verdict at all; none of them says anything about the answer. */
export type JudgeInfraCode = 'rate_limit' | 'timeout' | 'host_exit' | 'aborted'

export type JudgeVerdict =
  | { verdict: 'pass' | 'fail'; evidence?: JudgeEvidence }
  /** The model's output was unusable (malformed, ungrounded, wrong model). A FAIL. */
  | { verdict: 'judge_error'; detail: string; evidence?: JudgeEvidence }
  /** The judge could not be reached. Settled like a run-level `infra_error`: retried, and outside the denominator. */
  | { verdict: 'infra_error'; kind: 'infra'; code: JudgeInfraCode; evidence?: undefined }

/** `createJudge` in `judge.ts` implements this. Absent a judge, positive-fixture runs settle with no outcome and `pending-judge`. */
export type JudgeHook = (input: JudgeInput) => Promise<JudgeVerdict>

// ── campaign ───────────────────────────────────────────────────────────────

export interface CampaignInput {
  repoRoot: string
  method: string
  mode: 'red' | 'green' | 'dev'
  providerMode: ProviderMode
  verification: PreregVerification
  campaignId: string
  /** `<out>/<campaignId>`; one subdirectory per run. */
  campaignDir: string
  runs: readonly PlannedRun[]
  host?: Host
  /** Scripted mode: the model's turns for a run. Default: baseline answers; skill condition loads the skill. */
  scriptFor?: (run: PlannedRun) => readonly ScriptedStep[]
  finalText?: string
  judge?: JudgeHook
  /** The rubric's declarations (`parseDeclarations`). `expectation: true` scores the text after the last tool call; absent: all text. */
  declarations?: RubricDeclarations
  signal?: AbortSignal
  /** Default 2. */
  maxInfraRetries?: number
  /** Opt-in: real provider credentials copied into each run's isolated auth.json (names go in the manifest, values never). */
  auth?: PassthroughAuth
  /**
   * Opt-in CLIProxyAPI mode: `auth` then holds the gateway key for `openai` and `anthropic`, the workspace gets the wizard's provider
   * blocks, and the manifest records this key *name* (`auth_cliproxy`) and `gateways: ["cliproxy"]` instead of `auth_passthrough`.
   */
  cliproxyKeyName?: string
  /** Extra strings the credential-leak scan must never find (the key's prefix, a management key held in the runner's env). */
  leakNeedles?: readonly Needle[]
  /** Wait before retrying an `infra_error` caused by a provider 429; attempt is 1-based. Default 30 s, then 90 s. */
  backoffMs?: (attempt: number) => number
  /** Test seam. The default wait ends early when `signal` fires. */
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface RunResult {
  runId: string
  runDir: string
  fixtureId: string
  kind: FixtureKind
  condition: Condition
  arm?: PilotArm
  index: number
  attempt: number
  status: FinalStatus
  outcome?: RunOutcomeName
  reasons: string[]
}

export type CampaignAbort = 'interrupted' | 'credential_leak' | 'provider_outage'

export interface Tally {
  attempted: number
  pass: number
  fail: number
  infra_error: number
  non_isolated: number
}

export interface CampaignResult {
  /** The final attempt of each planned run that got that far. */
  results: RunResult[]
  /** Every attempt that ended in `infra_error`, retries included: reported, never in a denominator. */
  infraErrors: RunResult[]
  aborted?: CampaignAbort
  tallies: Record<string, Tally>
  summaryPath: string
}

const LEAK_NEEDLES: Needle[] = [{ label: 'scripted_placeholder_api_key', value: PLACEHOLDER_API_KEY }]

/** `kind/fixture/condition`; a pilot run's arm stands in for the condition, since two arms can share one. */
export const tallyKey = (r: { kind: FixtureKind; fixtureId: string; condition: Condition; arm?: PilotArm }): string => `${r.kind}/${r.fixtureId}/${r.arm ?? r.condition}`

export function tallyResults(results: readonly RunResult[], infraErrors: readonly RunResult[] = []): Record<string, Tally> {
  const tallies: Record<string, Tally> = {}
  const tallyFor = (r: RunResult) => (tallies[tallyKey(r)] ??= { attempted: 0, pass: 0, fail: 0, infra_error: 0, non_isolated: 0 })
  for (const r of results) {
    const t = tallyFor(r)
    if (r.outcome === 'pass') t.pass += 1
    else if (r.outcome === 'fail') t.fail += 1
    else if (r.outcome === 'non_isolated') t.non_isolated += 1
    // Denominator: attempted = pass + fail. infra_error and non_isolated are reported, not counted.
    t.attempted = t.pass + t.fail
  }
  for (const r of infraErrors) tallyFor(r).infra_error += 1
  return tallies
}

const defaultBackoffMs = (attempt: number): number => (attempt <= 1 ? 30_000 : 90_000)

/** Consecutive rate-limited attempts (agent or judge) after which the provider is treated as down and the campaign stops. */
export const PROVIDER_OUTAGE_STREAK = 3

const isProviderRateLimit = (reasons: readonly string[]): boolean => reasons.includes('provider_429') || reasons.includes('judge_infra:rate_limit')
/** Worth waiting for: a throttled provider, or a judge that could not be reached. An interrupt is not. */
const isBackoffWorthy = (reasons: readonly string[]): boolean => isProviderRateLimit(reasons) || reasons.some((r) => r.startsWith('judge_infra:') && r !== 'judge_infra:aborted')
/** A bug in the runner repeats exactly; retrying it only burns requests. */
const isRunnerException = (reasons: readonly string[]): boolean => reasons.some((r) => r.startsWith('runner_exception:'))

export async function runCampaign(c: CampaignInput): Promise<CampaignResult> {
  mkdirSync(c.campaignDir, { recursive: true, mode: 0o700 })
  const retries = c.maxInfraRetries ?? 2
  const results: RunResult[] = []
  const infraErrors: RunResult[] = []
  let aborted: CampaignAbort | undefined
  let rateLimitStreak = 0
  let summary: { tallies: Record<string, Tally>; summaryPath: string } | undefined

  // The summary is written whatever happens: a throw out of the loop still leaves a record of what ran.
  try {
    outer: for (const [i, run] of c.runs.entries()) {
      for (let attempt = 1; attempt <= 1 + retries; attempt += 1) {
        let result: RunResult
        try {
          result = await executeAttempt(c, run, i + 1, attempt)
        } catch (e) {
          if (e instanceof CredentialLeakError) {
            aborted = 'credential_leak'
            c.log?.(`ABORT ${e.message}`)
            break outer
          }
          throw e
        }
        c.log?.(`${result.runId}: ${result.status}${result.outcome ? ` → ${result.outcome}` : ''}${result.reasons.length ? ` (${result.reasons.join(', ')})` : ''}`)
        if (result.status === 'interrupted') {
          results.push(result)
          aborted = 'interrupted'
          break outer
        }
        // Only the final attempt of a planned run counts; an infra_error is retried.
        if (result.status === 'infra_error') {
          infraErrors.push(result)
          rateLimitStreak = isProviderRateLimit(result.reasons) ? rateLimitStreak + 1 : 0
          if (rateLimitStreak >= PROVIDER_OUTAGE_STREAK) {
            results.push(result)
            aborted = 'provider_outage'
            c.log?.(`ABORT provider_outage: ${rateLimitStreak} rate-limited attempts in a row; no further runs launched`)
            break outer
          }
          if (attempt <= retries && !isRunnerException(result.reasons)) {
            if (isBackoffWorthy(result.reasons)) {
              const wait = (c.backoffMs ?? defaultBackoffMs)(attempt)
              c.log?.(`${result.runId}: ${result.reasons.join(', ')}, backing off ${Math.round(wait / 1000)}s before retry`)
              await (c.sleep ?? ((ms: number) => sleepUnlessAborted(ms, c.signal)))(wait)
              if (c.signal?.aborted) {
                results.push(result)
                aborted = 'interrupted'
                break outer
              }
            }
            continue
          }
        } else {
          rateLimitStreak = 0
        }
        results.push(result)
        break
      }
    }
  } finally {
    summary = writeSummary(c, results, infraErrors, aborted)
  }
  return { results, infraErrors, aborted, ...summary! }
}

function writeSummary(c: CampaignInput, results: readonly RunResult[], infraErrors: readonly RunResult[], aborted: CampaignAbort | undefined): { tallies: Record<string, Tally>; summaryPath: string } {
  const tallies = tallyResults(results, infraErrors)
  const summaryPath = join(c.campaignDir, 'summary.json')
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        campaign_id: c.campaignId,
        method: c.method,
        mode: c.mode,
        provider_mode: c.providerMode,
        aborted: aborted ?? null,
        planned_runs: c.runs.length,
        prereg_runs_per_condition: c.verification.prereg.runs_per_condition,
        tallies,
        infra_errors: infraErrors.map(({ runId, reasons }) => ({ run_id: runId, reasons })),
        runs: results.map(({ runId, status, outcome, reasons }) => ({ run_id: runId, status, outcome: outcome ?? null, reasons })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return { tallies, summaryPath }
}

/** The version the skill's bundled helper stamps on its records; `null` when there is no helper or its version cannot be read. */
function installedHelperVersion(repoRoot: string, method: string): string | null {
  try {
    return helperVersionOf(readFileSync(join(repoRoot, 'skills', method, 'scripts', 'record.mjs'), 'utf8'))
  } catch {
    return null
  }
}

// ── credential scan ───────────────────────────────────────────────────

function leakScanInput(c: CampaignInput, runDir: string, manifest: RunManifest) {
  const artifacts: Record<string, string> = {}
  for (const file of Object.keys(manifest.artifacts)) {
    try {
      artifacts[file] = readFileSync(join(runDir, file), 'utf8')
    } catch {
      // an artifact that was never written has nothing to leak
    }
  }
  return {
    needles: [...LEAK_NEEDLES, ...needlesOf(c.auth ?? {}), ...(c.leakNeedles ?? [])],
    manifestJson: JSON.stringify(manifest),
    artifacts,
    dirs: [] as string[],
  }
}

const leakReasons = (findings: readonly { label: string; where: string }[]): string[] => [
  ...new Set(findings.map((f) => `credential_leak:${f.label}:${f.where.startsWith('manifest') ? 'manifest' : f.where.includes('::') ? 'workspace' : 'artifact'}`)),
]

/** Purge everything that could carry the key, keep only a sanitized manifest, and stop the campaign. */
function quarantineRun(runDir: string, manifest: RunManifest, runId: string, reasons: string[], labels: string[]): never {
  for (const file of Object.keys(manifest.artifacts)) rmSync(join(runDir, file), { force: true })
  manifest.artifacts = {}
  manifest.records = []
  manifest.host_errors = []
  manifest.check_failures = []
  manifest.isolation = null
  manifest.judge = undefined
  manifest.status = 'credential_leak'
  manifest.outcome = undefined
  manifest.reasons = reasons
  manifest.finished_at = new Date().toISOString()
  writeManifest(runDir, manifest)
  throw new CredentialLeakError(runId, labels)
}

// ── one attempt ────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(3, '0')

function defaultScript(run: PlannedRun, method: string): readonly ScriptedStep[] {
  return run.condition === 'skill' && run.fixture.kind !== 'negative' ? [skillCallStep(method)] : []
}

/**
 * The `available_skills_exact` check needs a tool-capable request. When the run
 * ended abnormally before any was made, that is "unobserved", not a violation:
 * otherwise a hang would be excluded as `non_isolated` instead of counted as FAIL.
 */
function isolationViolated(evidence: IsolationEvidence, completed: boolean): boolean {
  const unobserved = !evidence.skillListObserved && !completed
  return evidence.checks.some((c) => !c.passed && !(unobserved && c.name === 'available_skills_exact'))
}

async function executeAttempt(c: CampaignInput, run: PlannedRun, seq: number, attempt: number): Promise<RunResult> {
  const { verification } = c
  const prereg = verification.prereg
  const runId = `${pad(seq)}-${run.fixture.kind}-${run.fixture.id}-${run.arm ?? run.condition}-r${run.index}${attempt > 1 ? `-a${attempt}` : ''}`
  const runDir = join(c.campaignDir, runId)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })

  let model: string
  if (c.providerMode === 'scripted') {
    model = SCRIPTED_MODEL
  } else {
    model = prereg.agent_model_id
    if (!isLiveModel(model)) {
      throw new Error(`live mode only supports opencode/*, opencode-go/*, openai/* and anthropic/* models (prereg pins ${model})`)
    }
  }

  const manifest: RunManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    campaign_id: c.campaignId,
    status: 'running',
    reasons: [],
    verdict_basis: 'deterministic',
    method: c.method,
    condition: run.condition,
    ...(run.arm ? { arm: run.arm } : {}),
    fixture: { id: run.fixture.id, kind: run.fixture.kind, hash: run.fixture.hash },
    attempt,
    skill: null,
    prereg: { content_hash: verification.contentHash, epoch: prereg.epoch },
    provider_mode: c.providerMode,
    ...(c.cliproxyKeyName
      ? { auth_cliproxy: c.cliproxyKeyName, gateways: ['cliproxy'] }
      : c.auth && Object.keys(c.auth).length
        ? { auth_passthrough: passthroughNames(c.auth) }
        : {}),
    opencode: { package: 'opencode-ai', version: OPENCODE_PIN },
    model: { pinned: model, returned: [] },
    isolation: null,
    config: { path: '', sha256: '' },
    usage: null,
    wall_clock_ms: null,
    tool_call_count: null,
    host_errors: [],
    records: [],
    check_failures: [],
    artifacts: {},
    started_at: new Date().toISOString(),
    finished_at: null,
  }
  // Written as `running` before anything launches, so a crash leaves a visible stale manifest.
  writeManifest(runDir, manifest)

  const result = (status: FinalStatus, outcome: RunOutcomeName | undefined): RunResult => ({
    runId,
    runDir,
    fixtureId: run.fixture.id,
    kind: run.fixture.kind,
    condition: run.condition,
    ...(run.arm ? { arm: run.arm } : {}),
    index: run.index,
    attempt,
    status,
    outcome,
    reasons: manifest.reasons,
  })
  const settle = (status: FinalStatus, outcome: RunOutcomeName | undefined, reasons: string[]): RunResult => {
    manifest.status = status
    manifest.outcome = outcome
    manifest.reasons = reasons
    manifest.finished_at = new Date().toISOString()
    return result(status, outcome)
  }
  const interrupted = (): RunResult => {
    settle('interrupted', undefined, ['interrupted'])
    writeManifest(runDir, manifest)
    return result('interrupted', undefined)
  }

  try {
    return await runAttempt(c, run, { runId, runDir, manifest, model, settle, interrupted })
  } catch (e) {
    if (e instanceof CredentialLeakError) throw e
    // Whatever was written before the throw has not been through the credential scan yet.
    const findings = scanForLeaks(leakScanInput(c, runDir, manifest))
    if (findings.length) quarantineRun(runDir, manifest, runId, leakReasons(findings), findings.map((f) => f.label))
    // A bug in the runner must not take the campaign down with it. Only the error's name is kept: its message may quote anything.
    const final = settle('infra_error', 'infra_error', [`runner_exception:${e instanceof Error ? e.name : 'unknown'}`])
    writeManifest(runDir, manifest)
    return final
  }
}

interface AttemptState {
  runId: string
  runDir: string
  manifest: RunManifest
  model: string
  settle: (status: FinalStatus, outcome: RunOutcomeName | undefined, reasons: string[]) => RunResult
  interrupted: () => RunResult
}

async function runAttempt(c: CampaignInput, run: PlannedRun, state: AttemptState): Promise<RunResult> {
  const { verification } = c
  const prereg = verification.prereg
  const host = c.host ?? realHost
  const { runId, runDir, manifest, model, settle, interrupted } = state
  if (c.signal?.aborted) return interrupted()

  const server =
    c.providerMode === 'scripted'
      ? startScriptedProvider({ steps: (c.scriptFor ?? ((r) => defaultScript(r, c.method)))(run), finalText: c.finalText })
      : startRecordingProxy(upstreamFor(providerOf(model)))
  let workspace: RunWorkspace
  try {
    workspace = createRunWorkspace({
      repoRoot: c.repoRoot,
      method: c.method,
      condition: run.condition,
      fixtureId: run.fixture.id,
      fixtureText: run.fixture.text,
      provider: c.providerMode === 'scripted' ? { kind: 'scripted', url: server.url } : { kind: 'live', recordingProxyUrl: server.url },
      model,
      auth: c.auth,
      cliproxy: Boolean(c.cliproxyKeyName),
    })
  } catch (e) {
    server.stop()
    throw e
  }
  const signal = c.signal ?? new AbortController().signal

  try {
    manifest.config = { path: workspace.fixture.configPath, sha256: sha256(JSON.stringify(workspace.config)) }
    manifest.skill = workspace.skill ? { sha256: workspace.skill.sha256 } : null
    writeManifest(runDir, manifest)

    const base = { cwd: workspace.fixture.workspace, env: workspace.env, config: workspace.config }
    const evidenceFor = (requests: RecordedRequest[], stdout: string, stderr: string, debugConfigJson: unknown) =>
      checkIsolation({
        expectedSkills: workspace.expectedSkills,
        requests,
        stdout,
        stderr,
        debugConfigJson,
        generatedConfig: workspace.config,
        childEnv: workspace.env,
        decoys: workspace.decoys.needles,
      })

    // Effective config first: if something outside the generated file contributes, do not spend a model request.
    const debugJson = await host.debugConfig({ ...base, signal })
    if (signal.aborted) return interrupted()
    const dbg = debugJson === undefined ? { passed: false } : checkDebugConfig(debugJson, workspace.config)
    if (!dbg.passed) {
      manifest.isolation = evidenceFor([], '', '', debugJson)
      return finish(settle('non_isolated', 'non_isolated', ['debug_config_generated_only']))
    }

    const spawn = await host.run({
      ...base,
      argv: runArgv(model, run.fixture.text),
      timeoutMs: prereg.per_run_timeout_ms,
      signal,
      requests: server.requests,
    })
    if (c.providerMode === 'live') await Bun.sleep(50) // let the proxy's response scan settle

    if (spawn.aborted) return interrupted()

    const events: EventSummary = analyzeEvents(spawn.stdout)
    // The installed skill text lets the checks tell a complete direct read of SKILL.md from a probe or a truncated read.
    const skillText = run.condition === 'skill' ? readFileSync(join(c.repoRoot, 'skills', c.method, 'SKILL.md'), 'utf8') : undefined
    const hostOutcome = classifyHostOutcome(spawn, events, c.method, skillText)
    const records = listRecordFiles(workspace.fixture.recordsDir)
    const evidence = evidenceFor(server.requests, spawn.stdout, spawn.stderr, debugJson)

    manifest.isolation = evidence
    manifest.usage = events.usage
    manifest.wall_clock_ms = spawn.wallMs
    manifest.tool_call_count = events.toolUses.length
    manifest.host_errors = events.hostErrors
    manifest.records = records.map((r) => ({ name: r.name, sha256: sha256(r.content) }))
    if (c.providerMode === 'live') manifest.gateway = gatewayOf(server.requests.map((r) => r.upstream))
    if (run.condition === 'skill') manifest.fire_basis = fireEvidence(c.method, events, records, skillText).fireBasis
    manifest.model.returned = [...new Set(server.requests.filter((r) => r.hasTools).map((r) => r.returnedModel).filter((m): m is string => Boolean(m)))]

    const artifacts = {
      'stdout.jsonl': spawn.stdout,
      'stderr.txt': spawn.stderr,
      'requests.json': JSON.stringify(server.requests.map((r) => r.body), null, 1),
    }
    // Record contents are retained so a human (or a rejudge) sees exactly what the judge saw; the workspace is deleted.
    if (records.length) {
      Object.assign(artifacts, { 'records.json': JSON.stringify(records.map((r) => ({ name: r.name, content: r.content })), null, 1) })
    }
    const artifactRefs: Record<string, ArtifactRef> = {}
    for (const [file, text] of Object.entries(artifacts)) {
      writeFileSync(join(runDir, file), text, { mode: 0o600 })
      artifactRefs[file] = { file, sha256: sha256(text), bytes: Buffer.byteLength(text) }
    }
    manifest.artifacts = artifactRefs

    // Classification, in precedence order.
    let final: RunResult
    if (hostOutcome === 'infra_error') {
      final = settle('infra_error', 'infra_error', [isRateLimited(events.hostErrors) ? 'provider_429' : 'host_exit_before_skill_load'])
    } else if (isolationViolated(evidence, hostOutcome === 'completed')) {
      final = settle('non_isolated', 'non_isolated', evidence.checks.filter((k) => !k.passed).map((k) => k.name))
    } else if (hostOutcome === 'timeout') {
      final = settle('timeout', 'fail', ['timeout'])
    } else if (hostOutcome === 'host_crash') {
      final = settle('host_crash', 'fail', ['host_exit_after_skill_load'])
    } else {
      const breach = checkBudget(events, prereg.budget)
      if (breach) {
        final = settle('budget_exceeded', 'fail', [`budget_${breach.what}`])
      } else {
        const checks = runChecks({
          method: c.method,
          condition: run.condition,
          kind: run.fixture.kind,
          events,
          records,
          expectedExecutionModes: prereg.expected_execution_modes,
          skillText,
          ...(run.condition === 'skill' ? { helperVersion: installedHelperVersion(c.repoRoot, c.method) } : {}),
        })
        manifest.check_failures = checks.failures
        const reasons = checks.failures.map((f: CheckFailure) => f.code)
        const needsJudge = run.fixture.kind !== 'negative'
        // Under `expectation: true` the answer is what follows the last tool call, the same evidence the review card shows.
        const finalAnswer = c.declarations?.expectation ? finalAnswerText(parseEvents(spawn.stdout).events) : events.assistantText
        if (!checks.ok) {
          final = settle('completed', 'fail', reasons)
        } else if (needsJudge && c.declarations?.expectation && finalAnswer.trim() === '') {
          manifest.word_count = 0
          final = settle('completed', 'fail', ['answer_empty'])
        } else if (needsJudge && c.judge) {
          let verdict: JudgeVerdict
          try {
            verdict = await c.judge({
              method: c.method,
              condition: run.condition,
              fixture: run.fixture,
              finalAnswer,
              recordJson: records.map((r) => r.content),
              signal,
            })
          } catch (e) {
            // The judge's transport saw a configured secret: nothing from this run may stay on disk, and the campaign stops.
            if (e instanceof CredentialLeakError) quarantineRun(runDir, manifest, runId, e.labels.map((l) => `credential_leak:${l}:judge`), e.labels)
            // Any other throw is a judge_error (FAIL), never an unhandled crash that loses the campaign.
            verdict = { verdict: 'judge_error', detail: `judge_threw: ${(e as Error).message}` }
          }
          if (verdict.verdict === 'infra_error') {
            // The judge could not be reached: the answer was never graded, so the run is neither a pass nor a fail.
            final = verdict.code === 'aborted' ? interrupted() : settle('infra_error', 'infra_error', [`judge_infra:${verdict.code}`])
          } else {
            manifest.verdict_basis = 'judge'
            if (verdict.evidence) {
              manifest.judge = verdict.evidence
              manifest.artifacts['judge.json'] = writeJudgeRecord(runDir, verdict.evidence)
            }
            // The word limit (TE3m) is mechanical and runs after the judge, so the TE verdicts are on the manifest either way.
            const limit = run.fixture.expectation?.maxWords
            const overLimit = limit !== undefined && isOverLimit((manifest.word_count = countWords(finalAnswer)), limit)
            const reasons = [...(verdict.verdict === 'pass' ? [] : [verdict.verdict === 'judge_error' ? 'judge_error' : 'judge_fail']), ...(overLimit ? ['answer_over_limit'] : [])]
            final = reasons.length === 0 ? settle('completed', 'pass', []) : settle('completed', 'fail', reasons)
          }
        } else if (needsJudge) {
          // No judge wired: the checks passed, but nothing has graded the answer. No outcome until a judge does.
          manifest.verdict_basis = 'pending-judge'
          final = settle('completed', undefined, [])
        } else {
          final = settle('completed', 'pass', [])
        }
      }
    }
    return finish(final)
  } finally {
    server.stop()
    destroyFixture(workspace.fixture)
  }

  /** Credential scan, then the final manifest write. Runs before the workspace is deleted. */
  function finish(final: RunResult): RunResult {
    const findings = scanForLeaks({ ...leakScanInput(c, runDir, manifest), dirs: [workspace.fixture.workspace] })
    if (findings.length) quarantineRun(runDir, manifest, runId, leakReasons(findings), findings.map((f) => f.label))
    writeManifest(runDir, manifest)
    return final
  }
}
