/** Append-only replay attempts, gated and budgeted. Nothing here deletes or overwrites evidence. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import { analyzeEvents, isRateLimited, isSkillContentLoad, parseEvents, skillCallName, type Usage } from '../../../runner/events'
import { CredentialLeakError, type Needle } from '../../../runner/manifest'
import { sha256 } from '../../../runner/workspace'
import { writeEvidence } from '../artifacts'
import { BACKOFF_MS, RUN_TIMEOUT_MS } from '../driver'
import { ARM_NAMES, type ArmMessage, type ArmName, armMessage, type ExclusionReason, evaluateGates, type GateCheck, mainRequests } from './gates'
import type { Executor, HostResult } from './host'
import { HOST_VERSION, ID_PATTERN, loadFrozen, type LoadedFixture, type Store } from './store'

// ── statuses and records ───────────────────────────────────────────────────

/**
 * `completed`: every gate passed. `excluded`: a gate failed, reported and never an outcome. `timeout`: the attempt hit its
 * limit and its process group was killed. Those three are terminal. `rate_limited`, `host_error` and `error` are
 * infrastructure failures: they keep their directory, are not counted, and the cell tries again.
 */
export type AttemptStatus = 'completed' | 'excluded' | 'timeout' | 'rate_limited' | 'host_error' | 'error'
export const TERMINAL: readonly AttemptStatus[] = ['completed', 'excluded', 'timeout']
export const isTerminal = (status: AttemptStatus): boolean => TERMINAL.includes(status)

/** What the host-reported cost is multiplied by for the cap: earlier spike runs reported about $3.87 against an estimate near $6.2, and $1.25 against $2.15. */
export const UNDERCOUNT_FACTOR = 1.75

export type OutcomeLabel = 'no_tool' | 'metacogs_tool' | 'skill_only'

export interface ObservedCalls {
  tool_calls: { tool: string; status: string | undefined }[]
  /** `feel` and `drugs` calls, by tool name. */
  metacogs_calls: string[]
  /** Names of skills whose content a `skill` call loaded. */
  skill_loads: string[]
}

export interface AttemptRecord {
  schema_version: 1
  campaign: string
  fixture: { id: string; kind: string; spec_sha256: string; export_sha256: string }
  model: string
  arm: ArmName
  attempt: string
  seq: number
  provider: 'scripted' | 'cliproxy'
  host: { version: string | null; expected_version: string }
  message: ArmMessage | null
  /** Command arms: the argument text the model received; `''` for none, `null` when the skill text was not found or the arm is not a command. */
  received_args: string | null
  gates: { passed: boolean; checks: GateCheck[] } | null
  status: AttemptStatus
  terminal: boolean
  reasons: string[]
  /** What the model did, recorded for every attempt that reached the host. Only a `completed` attempt has an outcome. */
  observed: ObservedCalls | null
  outcome: OutcomeLabel | null
  requests: { total: number; main: number }
  stack: { plugins: string[]; default_agent: string | null; mcp_entries: number } | null
  unrecognized_events: number
  usage: Usage | null
  cost: { reported_usd: number; charged_usd: number; basis: 'scripted' | 'no_request' | 'reported_x_factor' | 'estimate' }
  timing: { started_at: string; ended_at: string; wall_ms: number }
  artifacts: Record<string, string>
  error?: { name: string; message: string }
  leak_labels?: string[]
}

// ── paths ──────────────────────────────────────────────────────────────────

export interface CellKey {
  campaign: string
  fixture: string
  model: string
  arm: ArmName
}

export const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/

const modelSlug = (model: string): string => model.replace('/', '__')
const modelOfSlug = (slug: string): string => slug.replace('__', '/')

export const campaignsRoot = (store: Store): string => join(store.root, 'campaigns')
export const campaignDir = (store: Store, campaign: string): string => join(campaignsRoot(store), campaign)
export const cellDir = (store: Store, key: CellKey): string => join(campaignDir(store, key.campaign), key.fixture, modelSlug(key.model), key.arm)

const ATTEMPT_ID = /^a\d{3,}$/
const attemptId = (seq: number): string => `a${String(seq).padStart(3, '0')}`

export class AttemptExistsError extends Error {
  constructor(path: string) {
    super(`${path} already exists; replay evidence is never overwritten`)
    this.name = 'AttemptExistsError'
  }
}

/** Creates one attempt directory (0700). An existing directory is refused. */
export function createAttemptDir(cell: string, id: string): string {
  if (!ATTEMPT_ID.test(id)) throw new Error(`attempt id ${id}: expected a followed by at least three digits`)
  const dir = join(cell, id)
  mkdirSync(cell, { recursive: true, mode: 0o700 })
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AttemptExistsError(dir)
    throw e
  }
  return dir
}

const attemptSeqs = (cell: string): number[] => (existsSync(cell) ? readdirSync(cell).filter((d) => ATTEMPT_ID.test(d)).map((d) => Number(d.slice(1))) : [])

/** The next free attempt directory of a cell. */
export function allocateAttempt(cell: string): { id: string; seq: number; dir: string } {
  for (let tries = 0; tries < 8; tries++) {
    const seq = Math.max(0, ...attemptSeqs(cell)) + 1
    try {
      return { id: attemptId(seq), seq, dir: createAttemptDir(cell, attemptId(seq)) }
    } catch (e) {
      if (!(e instanceof AttemptExistsError)) throw e // lost a race: take the next one
    }
  }
  throw new Error(`could not allocate an attempt directory under ${cell}`)
}

// ── reading evidence ───────────────────────────────────────────────────────

export interface AttemptSummary {
  id: string
  seq: number
  /** `null`: the directory has no `attempt.json` (the process died mid-attempt). */
  status: AttemptStatus | null
  terminal: boolean
  charged_usd: number
}

export function readAttempts(cell: string): AttemptSummary[] {
  return attemptSeqs(cell)
    .sort((a, b) => a - b)
    .map((seq) => {
      const file = join(cell, attemptId(seq), 'attempt.json')
      if (!existsSync(file)) return { id: attemptId(seq), seq, status: null, terminal: false, charged_usd: 0 }
      const record = JSON.parse(readFileSync(file, 'utf8')) as AttemptRecord
      return { id: attemptId(seq), seq, status: record.status, terminal: record.terminal, charged_usd: record.cost.charged_usd }
    })
}

/** The first terminal attempt is the counted one; later attempts are kept and never replace it. */
export const countedAttempt = (attempts: readonly AttemptSummary[]): AttemptSummary | undefined => attempts.find((a) => a.terminal)

export interface CellRow {
  fixture: string
  model: string
  arm: string
  attempts: AttemptSummary[]
  counted: AttemptSummary | undefined
}

const subdirs = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [])

export function campaignCells(store: Store, campaign: string): CellRow[] {
  const root = campaignDir(store, campaign)
  const rows: CellRow[] = []
  for (const fixture of subdirs(root)) {
    for (const slug of subdirs(join(root, fixture))) {
      for (const arm of subdirs(join(root, fixture, slug))) {
        const attempts = readAttempts(join(root, fixture, slug, arm))
        rows.push({ fixture, model: modelOfSlug(slug), arm, attempts, counted: countedAttempt(attempts) })
      }
    }
  }
  return rows
}

export const spentUsd = (store: Store, campaign: string): number => campaignCells(store, campaign).reduce((sum, row) => sum + row.attempts.reduce((s, a) => s + a.charged_usd, 0), 0)

// ── one attempt ────────────────────────────────────────────────────────────

export interface AttemptContext {
  store: Store
  key: CellKey
  fixture: LoadedFixture
  executor: Executor
  provider: 'scripted' | 'cliproxy'
  /** Leak-scan needles: the CLIProxyAPI key and its prefix. */
  needles?: readonly Needle[]
  expectedHostVersion?: string
  /** The packed plugin's `plugin/skills` directory; the delivered skill must come from it. */
  skillsDir?: string
  timeoutMs?: number
  /** What the cap charges when the host reports no cost for a live attempt. */
  attemptEstimateUsd?: number
  signal?: AbortSignal
  now?: () => Date
}

function observe(events: ReturnType<typeof analyzeEvents>): ObservedCalls {
  return {
    tool_calls: events.toolUses.map((t) => ({ tool: t.tool, status: t.status })),
    metacogs_calls: events.toolUses.map((t) => t.tool).filter((t) => t === 'feel' || t === 'drugs'),
    skill_loads: events.skillCalls.filter((s) => isSkillContentLoad(s)).map((s) => skillCallName(s) ?? 'unknown'),
  }
}

const outcomeOf = (o: ObservedCalls): OutcomeLabel => (o.metacogs_calls.length > 0 ? 'metacogs_tool' : o.skill_loads.length > 0 ? 'skill_only' : 'no_tool')

function chargeFor(provider: 'scripted' | 'cliproxy', reported: number, requests: number, estimate: number): AttemptRecord['cost'] {
  if (provider === 'scripted') return { reported_usd: reported, charged_usd: 0, basis: 'scripted' }
  if (requests === 0) return { reported_usd: reported, charged_usd: 0, basis: 'no_request' }
  if (reported > 0) return { reported_usd: reported, charged_usd: reported * UNDERCOUNT_FACTOR, basis: 'reported_x_factor' }
  return { reported_usd: reported, charged_usd: estimate, basis: 'estimate' }
}

/** Runs one attempt into a fresh directory and writes its evidence. A credential leak writes labels only and rethrows. */
export async function runAttempt(ctx: AttemptContext): Promise<AttemptRecord> {
  const { store, key, fixture } = ctx
  const now = ctx.now ?? (() => new Date())
  const expectedVersion = ctx.expectedHostVersion ?? HOST_VERSION
  const cell = cellDir(store, key)
  const slot = allocateAttempt(cell)
  const message = armMessage(key.arm, fixture.spec)
  const startedAt = now().toISOString()
  const needles = ctx.needles ?? []
  const base = {
    schema_version: 1 as const,
    campaign: key.campaign,
    fixture: { id: key.fixture, kind: fixture.spec.kind, spec_sha256: fixture.entry.spec_sha256, export_sha256: fixture.entry.export_sha256 },
    model: key.model,
    arm: key.arm,
    attempt: slot.id,
    seq: slot.seq,
    provider: ctx.provider,
    host: { version: null as string | null, expected_version: expectedVersion },
    message,
  }
  const failed = (status: 'error' | 'host_error', reasons: string[], extra: Partial<AttemptRecord> = {}): AttemptRecord => ({
    ...base,
    received_args: null,
    gates: null,
    status,
    terminal: false,
    reasons,
    observed: null,
    outcome: null,
    requests: { total: 0, main: 0 },
    stack: null,
    unrecognized_events: 0,
    usage: null,
    cost: { reported_usd: 0, charged_usd: 0, basis: ctx.provider === 'scripted' ? 'scripted' : 'no_request' },
    timing: { started_at: startedAt, ended_at: now().toISOString(), wall_ms: 0 },
    artifacts: {},
    ...extra,
  })
  const keep = (record: AttemptRecord): AttemptRecord => {
    try {
      writeFileSync(join(slot.dir, 'attempt.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    } catch {
      // the directory stays either way; an unreadable record shows as an attempt with no status
    }
    return record
  }

  if (message === null) return keep(failed('error', ['arm_not_applicable']))
  let result: HostResult | undefined
  try {
    result = await ctx.executor({ fixtureId: key.fixture, seed: fixture.export, model: key.model, arm: key.arm, message, timeoutMs: ctx.timeoutMs ?? RUN_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const events = analyzeEvents(result.stdout)
    const observed = observe(events)
    const cost = chargeFor(ctx.provider, events.usage.cost, result.requests.length, ctx.attemptEstimateUsd ?? 0)
    const parsed = parseEvents(result.stdout).events

    let status: AttemptStatus
    let reasons: string[] = []
    let gates: AttemptRecord['gates'] = null
    let receivedArgs: string | null = null
    if (result.stack && !result.stack.passed) {
      status = 'excluded'
      reasons = ['isolation_failed' satisfies ExclusionReason]
      gates = { passed: false, checks: result.stack.checks.filter((c) => !c.passed).map((c) => ({ name: c.name, passed: false, reason: 'isolation_failed', detail: c.detail })) }
    } else if (result.aborted) {
      status = 'error'
      reasons = ['aborted']
    } else if (result.timedOut) {
      status = 'timeout'
      reasons = ['timeout']
    } else if (isRateLimited(events.hostErrors)) {
      status = 'rate_limited'
      reasons = ['provider_429']
    } else if (events.hostErrors.length > 0 || result.exitCode !== 0 || parsed.length === 0 || (events.stepFinishCount === 0 && events.assistantText.trim() === '')) {
      status = 'host_error'
      reasons = events.hostErrors.length > 0 ? events.hostErrors.map((e) => `host_error:${e.name ?? 'unknown'}`) : result.exitCode !== 0 ? [`host_exit_${result.exitCode}`] : [parsed.length === 0 ? 'no_events' : 'no_completion']
    } else {
      const g = evaluateGates({
        arm: key.arm,
        message,
        model: key.model,
        expectedHostVersion: expectedVersion,
        hostVersion: result.hostVersion,
        ...(ctx.skillsDir ? { skillsDir: ctx.skillsDir } : {}),
        requests: result.requests,
        seedUserTurns: fixture.spec.turns.flatMap((t) => (t.role === 'user' ? [t.text] : [])),
        assistants: result.assistants,
        partTypes: result.partTypes,
        eventTypes: parsed.map((e) => e.type),
      })
      gates = { passed: g.passed, checks: g.checks }
      receivedArgs = g.receivedArgs
      status = g.passed ? 'completed' : 'excluded'
      reasons = g.reasons
    }

    const artifacts = {
      'requests.json': JSON.stringify(result.requests.map((r) => ({ returned_model: r.returnedModel ?? null, body: r.body }))),
      'stdout.jsonl': result.stdout,
      'stderr.txt': result.stderr,
    }
    const record: AttemptRecord = {
      ...base,
      host: { version: result.hostVersion, expected_version: expectedVersion },
      received_args: receivedArgs,
      gates,
      status,
      terminal: isTerminal(status),
      reasons,
      observed,
      outcome: status === 'completed' ? outcomeOf(observed) : null,
      requests: { total: result.requests.length, main: mainRequests(result.requests).length },
      stack: result.stackSummary,
      unrecognized_events: events.unrecognized.length,
      usage: events.usage,
      cost,
      timing: { started_at: result.startedAt, ended_at: result.endedAt, wall_ms: result.wallMs },
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([file, text]) => [file, sha256(text)])),
    }
    writeEvidence({ dir: slot.dir, runId: `${key.fixture}/${key.model}/${key.arm}/${slot.id}`, artifacts, manifestFile: 'attempt.json', manifest: `${JSON.stringify(record, null, 2)}\n`, needles, scanDirs: result.leakDirs, exclusive: true })
    return record
  } catch (e) {
    if (e instanceof CredentialLeakError) {
      keep(failed('error', ['credential_leak'], { leak_labels: e.labels }))
      throw e
    }
    const raw = e instanceof Error ? e.message : String(e)
    const leaked = needles.some((n) => n.value && raw.includes(n.value))
    return keep(failed('error', [e instanceof Error ? e.name : 'unknown_error'], { error: { name: e instanceof Error ? e.name : 'unknown', message: leaked ? '[redacted]' : raw.slice(0, 300) } }))
  } finally {
    result?.cleanup()
  }
}

// ── the campaign ───────────────────────────────────────────────────────────

export interface CampaignOptions {
  name: string
  models: readonly string[]
  arms: readonly ArmName[]
  fixtures: readonly string[]
  capUsd: number
  provider: 'scripted' | 'cliproxy'
  /** Cliproxy only, required: what one attempt is assumed to cost until a larger one is seen. */
  attemptEstimateUsd?: number
  timeoutMs?: number
  /** Also run cells that already have a counted attempt. The extra attempts are kept and never count. */
  again?: boolean
  /** Tries per cell in one invocation when attempts keep failing for infrastructure reasons. Default 3. */
  maxAttempts?: number
  expectedHostVersion?: string
}

export interface CampaignDeps {
  store: Store
  executor: Executor
  cliproxy?: ResolvedCliproxy
  skillsDir?: string
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  signal?: AbortSignal
  now?: () => Date
}

export type UnrunReason = 'budget' | 'aborted' | 'no_somewhere' | 'attempts_exhausted'

export interface UnrunCell {
  fixture: string
  model: string
  arm: ArmName
  reason: UnrunReason
}

export interface CampaignSummary {
  cells: number
  attempts: number
  /** Cells whose counted attempt is of each status, as of the end of this invocation. */
  counted: Partial<Record<AttemptStatus, number>>
  unrun: UnrunCell[]
  spentUsd: number
  capUsd: number
  stoppedBy: 'budget' | 'aborted' | null
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:.]/g, '').slice(0, 18)

/** Runs every fixture, model and arm cell that has no counted attempt, stopping before a provider attempt that could pass the cap. */
export async function runCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<CampaignSummary> {
  const { store } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  if (!ID_PATTERN.test(options.name)) throw new Error('campaign name: expected lowercase letters, digits and hyphens, up to 64 characters')
  for (const model of options.models) if (!MODEL_PATTERN.test(model)) throw new Error(`model ${JSON.stringify(model)}: expected provider/model`)
  for (const arm of options.arms) if (!(ARM_NAMES as readonly string[]).includes(arm)) throw new Error(`unknown arm ${arm}`)
  if (!(options.capUsd > 0)) throw new Error('the cap takes a positive amount in USD')
  const live = options.provider === 'cliproxy'
  if (live && !(options.attemptEstimateUsd && options.attemptEstimateUsd > 0)) throw new Error('a cliproxy campaign needs an attempt estimate in USD, so the cap holds before the first call')
  if (live && !deps.cliproxy) throw new Error('a cliproxy campaign needs a resolved CLIProxyAPI key')

  // Fixtures come only through loadFrozen: frozen, scanned clean as of now, unedited and approved. All load before any run.
  const fixtures = new Map(options.fixtures.map((id) => [id, loadFrozen(store, id)] as const))
  const maxAttempts = options.maxAttempts ?? 3
  const estimate = options.attemptEstimateUsd ?? 0
  const before = spentUsd(store, options.name)
  let spent = before
  let largest = 0
  let attempts = 0
  const unrun: UnrunCell[] = []
  let stoppedBy: CampaignSummary['stoppedBy'] = null

  const cells = options.fixtures.flatMap((fixture) => options.models.flatMap((model) => options.arms.map((arm): CellKey => ({ campaign: options.name, fixture, model, arm }))))
  for (const key of cells) {
    const loaded = fixtures.get(key.fixture)!
    if (armMessage(key.arm, loaded.spec) === null) {
      unrun.push({ fixture: key.fixture, model: key.model, arm: key.arm, reason: 'no_somewhere' })
      continue
    }
    if (!options.again && countedAttempt(readAttempts(cellDir(store, key)))) continue
    if (stoppedBy) {
      unrun.push({ fixture: key.fixture, model: key.model, arm: key.arm, reason: stoppedBy })
      continue
    }

    let settled = false
    for (let tryNo = 1; tryNo <= maxAttempts && !settled; tryNo++) {
      if (deps.signal?.aborted) {
        stoppedBy = 'aborted'
        break
      }
      if (live && spent + Math.max(estimate, largest) > options.capUsd) {
        stoppedBy = 'budget'
        break
      }
      const record = await runAttempt({
        store,
        key,
        fixture: loaded,
        executor: deps.executor,
        provider: options.provider,
        ...(deps.cliproxy ? { needles: deps.cliproxy.needles } : {}),
        ...(options.expectedHostVersion ? { expectedHostVersion: options.expectedHostVersion } : {}),
        ...(deps.skillsDir ? { skillsDir: deps.skillsDir } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        attemptEstimateUsd: estimate,
        ...(deps.signal ? { signal: deps.signal } : {}),
        now,
      })
      attempts += 1
      spent += record.cost.charged_usd
      largest = Math.max(largest, record.cost.charged_usd)
      log(`${key.fixture} ${key.model} ${key.arm} ${record.attempt}: ${record.status}${record.reasons.length ? ` (${record.reasons.join(', ')})` : ''}`)
      settled = record.terminal
      if (!settled && record.status === 'rate_limited' && tryNo < maxAttempts) await sleep(BACKOFF_MS[Math.min(tryNo - 1, BACKOFF_MS.length - 1)]!)
      if (!settled && record.status === 'error' && record.reasons.includes('aborted')) {
        stoppedBy = 'aborted'
        break
      }
    }
    if (!settled) unrun.push({ fixture: key.fixture, model: key.model, arm: key.arm, reason: stoppedBy ?? 'attempts_exhausted' })
  }

  const counted: CampaignSummary['counted'] = {}
  for (const row of campaignCells(store, options.name)) if (row.counted?.status) counted[row.counted.status] = (counted[row.counted.status] ?? 0) + 1
  const summary: CampaignSummary = { cells: cells.length, attempts, counted, unrun, spentUsd: spent, capUsd: options.capUsd, stoppedBy }
  const dir = campaignDir(store, options.name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const note = `${JSON.stringify({ schema_version: 1, started_spent_usd: before, ...summary, provider: options.provider, models: options.models, arms: options.arms, fixtures: options.fixtures }, null, 2)}\n`
  for (let n = 1; ; n++) {
    try {
      writeFileSync(join(dir, `run-${stamp(now())}${n > 1 ? `-${n}` : ''}.json`), note, { mode: 0o600, flag: 'wx' })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw e
    }
  }
  return summary
}
