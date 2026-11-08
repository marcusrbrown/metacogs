/** `bun run replay campaign | status`: run a fixture × model × arm campaign, or list its cells. Prints ids, counts and statuses, never text. */
import { disposeFixtures, packedPlugin } from '../../../plugin/fixture'
import { type ResolvedCliproxy, resolveCliproxy as defaultResolveCliproxy } from '../../../runner/cliproxy'
import { CredentialLeakError } from '../../../runner/manifest'
import { ARM_NAMES, type ArmName, REPLAY_MODELS, WORLD_ARM_NAMES } from './gates'
import { createHostExecutor, defaultBaseDir, type Executor, prepareBase, resolveHarness } from './host'
import { campaignCells, campaignDir, runCampaign, spentUsd } from './run'
import { listWorldScenarios, loadWorldFixture, type ReplayFixture } from './scenario'
import { listFixtures, loadFrozen, type Store } from './store'
import { type GhAuth, resolveGhAuth as defaultResolveGhAuth } from './world'

export class CampaignUsageError extends Error {}

export interface CampaignValues {
  name?: string | undefined
  models?: string | undefined
  arms?: string | undefined
  fixtures?: string | undefined
  cap?: string | undefined
  provider?: string | undefined
  'auth-cliproxy'?: string | undefined
  'attempt-estimate'?: string | undefined
  'timeout-ms'?: string | undefined
  'expect-host-version'?: string | undefined
  again?: boolean | undefined
  /** `real`: replay the real history in a clone of the real repo. */
  world?: string | undefined
}

/** A real-world attempt may run long; this is its default limit. */
export const WORLD_TIMEOUT_MS = 900_000

/** Test seams: a fake host, and the credential lookup. */
export interface CampaignCliDeps {
  executor?: Executor
  resolveCliproxy?: typeof defaultResolveCliproxy
  skillsDir?: string
  sleep?: (ms: number) => Promise<void>
  resolveGhAuth?: () => GhAuth
  /** The home directory the project checkouts are looked up under. */
  home?: string
}

export interface CampaignCliContext {
  store: Store
  out: (line: string) => void
  env: Record<string, string | undefined>
  deps?: CampaignCliDeps
}

const list = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean)
const usage = (message: string): never => {
  throw new CampaignUsageError(message)
}

function positive(text: string | undefined, flag: string): number {
  const n = Number(text)
  return text !== undefined && Number.isFinite(n) && n > 0 ? n : usage(`${flag} takes a positive number`)
}

/** Fixture ids to run: the named ones, or every frozen and approved one. An edited fixture is refused either way. */
function fixtureIds(store: Store, spec: string): string[] {
  if (spec !== 'all') return list(spec)
  const ids: string[] = []
  for (const f of listFixtures(store)) {
    if (f.status === 'stale') loadFrozen(store, f.id) // throws: edited after the freeze
    else if (f.status === 'frozen' && f.approved) ids.push(f.id)
  }
  return ids
}

/** Scenario ids to run: the named ones, or every built one. */
function worldFixtureIds(store: Store, spec: string): string[] {
  return spec === 'all' ? listWorldScenarios(store).filter((s) => s.built).map((s) => s.id) : list(spec)
}

/** Exit 0 every cell has a counted attempt, 3 some cell did not run, 4 a credential leak. */
export async function campaignCommand(values: CampaignValues, ctx: CampaignCliContext): Promise<number> {
  const world = values.world === undefined ? false : values.world === 'real' ? true : usage(`--world takes real; got ${values.world}`)
  const name = values.name ?? usage('campaign needs --name')
  const models = list(values.models ?? usage('campaign needs --models'))
  for (const m of models) if (!(REPLAY_MODELS as readonly string[]).includes(m)) usage(`--models takes ${REPLAY_MODELS.join(', ')}; got ${m}`)
  const armSpec = values.arms ?? usage('campaign needs --arms')
  const armNames: readonly string[] = world ? WORLD_ARM_NAMES : ARM_NAMES
  const arms = armSpec === 'all' ? [...armNames] : list(armSpec)
  for (const a of arms) if (!armNames.includes(a)) usage(`--arms takes all or ${armNames.join(', ')}; got ${a}`)
  const capUsd = positive(values.cap ?? usage('campaign needs --cap <usd>'), '--cap')
  const provider = values.provider === undefined || values.provider === 'scripted' ? 'scripted' : values.provider === 'cliproxy' ? 'cliproxy' : usage(`--provider takes scripted or cliproxy; got ${values.provider}`)
  const live = provider === 'cliproxy'
  const attemptEstimateUsd = values['attempt-estimate'] === undefined ? undefined : positive(values['attempt-estimate'], '--attempt-estimate')
  if (live && attemptEstimateUsd === undefined) usage('--provider cliproxy needs --attempt-estimate <usd>, so the cap holds before the first call')
  const timeoutMs = values['timeout-ms'] === undefined ? (world ? WORLD_TIMEOUT_MS : undefined) : positive(values['timeout-ms'], '--timeout-ms')

  // Fixtures first, then the credential: no key is fetched for a fixture that would be refused.
  const loadWorld = (id: string): ReplayFixture => loadWorldFixture(ctx.store, id, { ...(ctx.deps?.home ? { home: ctx.deps.home } : {}), repoRoot: ctx.store.repoRoot })
  const ids = world ? worldFixtureIds(ctx.store, values.fixtures ?? usage('campaign needs --fixtures')) : fixtureIds(ctx.store, values.fixtures ?? usage('campaign needs --fixtures'))
  if (ids.length === 0) usage(world ? 'no built real-world scenarios to run; run `replay world build`' : 'no frozen, approved fixtures to run')
  for (const id of ids) world ? loadWorld(id) : loadFrozen(ctx.store, id)
  let gh: GhAuth | undefined
  if (world) {
    try {
      gh = (ctx.deps?.resolveGhAuth ?? defaultResolveGhAuth)()
    } catch (e) {
      usage(e instanceof Error ? e.message : 'no gh login') // the message names no token
    }
  }
  let cliproxy: ResolvedCliproxy | undefined
  if (live) {
    cliproxy = (ctx.deps?.resolveCliproxy ?? defaultResolveCliproxy)(values['auth-cliproxy'], ctx.env, { live: true })
    if (!cliproxy) usage('--provider cliproxy needs --auth-cliproxy <key-name> (or METACOGS_AUTH_CLIPROXY)')
  }

  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let owned = false
  try {
    let executor = ctx.deps?.executor
    let skillsDir = ctx.deps?.skillsDir
    if (!executor) {
      const harness = resolveHarness(ctx.env)
      const baseDir = await prepareBase({ harness, baseDir: defaultBaseDir(ctx.store.root, harness), log: ctx.out })
      const packed = await packedPlugin()
      owned = true
      executor = createHostExecutor({ harness, baseDir, packed, provider, ...(cliproxy ? { cliproxy } : {}), ...(world ? { world: { ...(gh ? { gh } : {}) } } : {}) })
      skillsDir = packed.pluginSkillsDir
    }
    const summary = await runCampaign(
      { name, models, arms: arms as ArmName[], fixtures: ids, capUsd, provider, ...(attemptEstimateUsd ? { attemptEstimateUsd } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(values.again ? { again: true } : {}), ...(values['expect-host-version'] ? { expectedHostVersion: values['expect-host-version'] } : {}), ...(world ? { world: true } : {}) },
      { store: ctx.store, executor, ...(cliproxy ? { cliproxy } : {}), ...(world ? { loadFixture: loadWorld, ...(gh ? { needles: gh.needles } : {}) } : {}), ...(skillsDir ? { skillsDir } : {}), ...(ctx.deps?.sleep ? { sleep: ctx.deps.sleep } : {}), log: ctx.out, signal: abort.signal },
    )
    const counted = Object.entries(summary.counted).map(([status, n]) => `${status}=${n}`).join(' ') || 'none'
    ctx.out(`campaign ${name}${world ? ' (real world)' : ''} cells=${summary.cells} attempts=${summary.attempts} spent=$${summary.spentUsd.toFixed(4)} cap=$${summary.capUsd.toFixed(4)}`)
    ctx.out(`counted: ${counted}`)
    for (const u of summary.unrun) ctx.out(`not run\t${u.fixture}\t${u.model}\t${u.arm}\t${u.reason}`)
    if (summary.stoppedBy === 'budget') ctx.out('stopped before the next provider attempt: it could pass the cap')
    if (summary.stoppedBy === 'accounting') ctx.out('stopped: an attempt record could not be written, so its spend is only in the run note')
    return summary.unrun.some((u) => u.reason !== 'no_somewhere') ? 3 : 0
  } catch (e) {
    if (e instanceof CredentialLeakError) {
      ctx.out(`credential leak in ${e.runId}: ${e.labels.join(', ')}; no artifact of that attempt was written`)
      return 4
    }
    throw e
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (owned) disposeFixtures()
  }
}

/** One line per cell: its attempts, and which one counts. */
export function statusCommand(name: string | undefined, ctx: Pick<CampaignCliContext, 'store' | 'out'>): number {
  if (!name) usage('status needs a campaign name')
  const rows = campaignCells(ctx.store, name!)
  if (rows.length === 0) throw new StatusError(`campaign ${name}: no cells on disk under ${campaignDir(ctx.store, name!)}`)
  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = row.counted ? (row.counted.status ?? 'incomplete') : 'pending'
    totals.set(key, (totals.get(key) ?? 0) + 1)
    ctx.out(`${row.fixture}\t${row.model}\t${row.arm}\tattempts=${row.attempts.length}\tcounted=${row.counted ? `${row.counted.id}:${row.counted.status}` : 'none'}\tall=${row.attempts.map((a) => `${a.id}:${a.status ?? 'incomplete'}`).join(',')}`)
  }
  ctx.out(`campaign ${name} cells=${rows.length} attempts=${rows.reduce((n, r) => n + r.attempts.length, 0)} spent=$${spentUsd(ctx.store, name!).toFixed(4)}`)
  ctx.out(`counted: ${[...totals].map(([status, n]) => `${status}=${n}`).join(' ')}`)
  return 0
}

class StatusError extends Error {
  override name = 'StatusError'
}
