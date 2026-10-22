/**
 * `bun run eval <red|green> --method <m> [options]`
 *
 * Judge and report generation are Unit 6; this entry point runs, checks, and
 * writes manifests.
 */
import { parseArgs } from 'node:util'
import { join } from 'node:path'

import { Git } from './git'
import { findStaleManifests } from './manifest'
import { opencodeAvailability } from './opencode'
import { enforcePrereg, PreregRefusal } from './prereg'
import { planRuns, type ProviderMode, runCampaign } from './run'
import { CustodyError, heldoutDir, resolveOutputDir, stateRoot } from './workspace'

export const EXIT = { OK: 0, ERROR: 1, USAGE: 64, REFUSED: 3, CREDENTIAL_LEAK: 4, INTERRUPTED: 130 } as const

const USAGE = `usage: bun run eval <red|green> --method <name> [options]

  --runs <n>              runs per condition per fixture (default: prereg runs_per_condition)
  --provider scripted|live   scripted = local stub (default), live = free-tier opencode/* model from prereg
  --fixture <id>          only this fixture (single-run debugging; marks the campaign as deviating from prereg)
  --include-dev           green only: also run dev fixtures under the skill condition
  --repo <dir>            repository to enforce prereg against (default: current git toplevel)
  --out <dir>             campaign output root (default: evals/runs, or the state root for held-out runs)
`

export interface MainIO {
  out: (line: string) => void
  err: (line: string) => void
  env: Record<string, string | undefined>
  /** Hook for tests; production installs SIGINT/SIGTERM handlers. */
  installSignalHandlers?: (abort: () => void) => () => void
  cwd: string
}

function defaultInstallSignalHandlers(abort: () => void): () => void {
  let count = 0
  const handler = () => {
    count += 1
    if (count > 1) process.exit(EXIT.INTERRUPTED)
    abort()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return () => {
    process.off('SIGINT', handler)
    process.off('SIGTERM', handler)
  }
}

export async function main(argv: readonly string[], io: Partial<MainIO> = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l))
  const err = io.err ?? ((l: string) => console.error(l))
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()

  const parsed = parseCli(argv)
  if ('error' in parsed) {
    err(`${parsed.error}\n${USAGE}`)
    return EXIT.USAGE
  }
  const [mode, ...extra] = parsed.positionals
  const { method, runs, provider, fixture, repo, out: outRoot } = parsed.values
  if ((mode !== 'red' && mode !== 'green') || extra.length || !method) {
    err(USAGE)
    return EXIT.USAGE
  }
  if (provider !== undefined && provider !== 'scripted' && provider !== 'live') {
    err(`--provider must be scripted or live\n${USAGE}`)
    return EXIT.USAGE
  }
  const providerMode: ProviderMode = provider === 'live' ? 'live' : 'scripted'
  const runsOverride = runs === undefined ? undefined : Number(runs)
  if (runsOverride !== undefined && (!Number.isInteger(runsOverride) || runsOverride < 1)) {
    err(`--runs must be a positive integer\n${USAGE}`)
    return EXIT.USAGE
  }

  const repoRoot = new Git(repo ?? cwd).toplevel()
  const git = new Git(repoRoot)

  const stale = findStaleManifests([join(repoRoot, 'evals', 'runs'), join(stateRoot(env), 'runs')])
  for (const s of stale) err(`warning: stale "running" manifest (a previous runner did not finish): ${s.path}`)

  // Enforcement happens before anything launches.
  let verification: ReturnType<typeof enforcePrereg>
  try {
    verification = enforcePrereg({ git, repoRoot, method, mode, heldoutDir: heldoutDir(method, env) })
  } catch (e) {
    if (e instanceof PreregRefusal) {
      err(`REFUSED: ${e.message}`)
      return EXIT.REFUSED
    }
    throw e
  }
  const { prereg } = verification

  const runsPerCondition = runsOverride ?? prereg.runs_per_condition
  const plan = planRuns({
    mode,
    fixtures: verification.content.fixtures,
    runsPerCondition,
    onlyFixture: fixture,
    includeDev: parsed.values['include-dev'],
  })
  if (plan.length === 0) {
    err(`nothing to run: the ${mode} plan for ${method} is empty (no fixtures?)`)
    return EXIT.ERROR
  }

  const campaignId = `${method}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let campaignDir: string
  try {
    campaignDir = resolveOutputDir({
      repoRoot,
      campaignId,
      heldout: plan.some((r) => r.fixture.kind === 'heldout'),
      outRoot,
      env,
    })
  } catch (e) {
    if (e instanceof CustodyError) {
      err(`REFUSED: ${e.message}`)
      return EXIT.REFUSED
    }
    throw e
  }

  const availability = opencodeAvailability()
  if (!availability.available) {
    err(`cannot launch the pinned OpenCode: ${availability.reason}`)
    return EXIT.ERROR
  }

  const deviates = runsPerCondition !== prereg.runs_per_condition || fixture !== undefined
  if (deviates) err('note: --runs/--fixture deviate from the prereg plan; this campaign is a debugging run, not evidence.')
  out(`campaign ${campaignId}: ${plan.length} runs (${providerMode}, ${mode}) → ${campaignDir}`)

  const controller = new AbortController()
  const uninstall = (io.installSignalHandlers ?? defaultInstallSignalHandlers)(() => controller.abort())
  let result: Awaited<ReturnType<typeof runCampaign>>
  try {
    result = await runCampaign({
      repoRoot,
      method,
      mode,
      providerMode,
      verification,
      campaignId,
      campaignDir,
      runs: plan,
      signal: controller.signal,
      log: out,
    })
  } finally {
    uninstall()
  }

  out(`\nsummary: ${result.summaryPath}`)
  for (const [key, t] of Object.entries(result.tallies)) {
    out(`  ${key}: pass ${t.pass}/${t.attempted}${t.infra_error ? ` · infra_error ${t.infra_error}` : ''}${t.non_isolated ? ` · non_isolated ${t.non_isolated}` : ''}`)
  }
  if (result.results.some((r) => r.outcome && r.outcome !== 'infra_error' && r.outcome !== 'non_isolated')) {
    out('note: positive-fixture outcomes are deterministic-only until the judge lands (verdict_basis=pending-judge).')
  }
  if (result.aborted === 'credential_leak') {
    err('ABORTED: credential_leak. Artifacts for that run were purged; see its manifest.')
    return EXIT.CREDENTIAL_LEAK
  }
  if (result.aborted === 'interrupted') return EXIT.INTERRUPTED
  return EXIT.OK
}

function parseCli(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true })
  } catch (e) {
    return { error: (e as Error).message }
  }
}

const OPTIONS = {
  method: { type: 'string' },
  runs: { type: 'string' },
  provider: { type: 'string' },
  fixture: { type: 'string' },
  repo: { type: 'string' },
  out: { type: 'string' },
  'include-dev': { type: 'boolean' },
} as const

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
