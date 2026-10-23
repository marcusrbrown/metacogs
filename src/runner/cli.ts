/**
 * `bun run eval <red|green> --method <m> [options]`
 * `bun run eval report --method <m> [--campaign <dir>]`
 *
 * `red`/`green` run, check, judge (live mode only), and write manifests.
 * `report` projects a finished RED campaign into `evals/reports/<m>/red.json`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'

import { AuthPassthroughError, DEFAULT_PASSTHROUGH, needlesOf, type PassthroughAuth, parseAuthPassthrough, PASSTHROUGH_PROVIDERS, readPassthroughAuth } from './auth'
import { Git } from './git'
import { loadCampaignRuns, rejudgeCampaign, writeReview } from './review'
import { createJudge } from './judge'
import { findStaleManifests } from './manifest'
import { opencodeAvailability } from './opencode'
import { isLiveModel } from './scripted-provider'
import { enforcePrereg, PreregRefusal } from './prereg'
import { buildDevReport, buildRedReport, loadCampaignManifests, writeDevReport, writeReport } from './report'
import { planRuns, type ProviderMode, runCampaign } from './run'
import { CustodyError, hashSkillDir, heldoutDir, resolveOutputDir, stateRoot } from './workspace'

export const EXIT = { OK: 0, ERROR: 1, USAGE: 64, REFUSED: 3, CREDENTIAL_LEAK: 4, INTERRUPTED: 130 } as const

const USAGE = `usage: bun run eval <red|green> --method <name> [options]
       bun run eval report --method <name> [--campaign <dir>]
       bun run eval review --campaign <id|dir>                     write review.md (human sheet) into the campaign dir
       bun run eval rejudge --campaign <id|dir> [--auth-passthrough opencode-go]
                                                                   judge calls over retained answers, then review.md; manifests untouched

  --runs <n>              runs per condition per fixture (default: prereg runs_per_condition)
  --provider scripted|live   scripted = local stub (default), live = the model pinned in the prereg through OpenCode's gateway:
                          opencode-go/* (Go subscription, the default and preferred) or opencode/* (Zen, bills credits)
  --fixture <id>          only this fixture (single-run debugging; marks the campaign as deviating from prereg)
  --include-dev           green only: also run dev fixtures under the skill condition
  --dev-only              green: authoring iteration. Skill condition on dev + negative fixtures only; never reads or plans held-out,
                          needs no committed skill. report: project the newest dev campaign into evals/reports/<m>/green-dev.json
  --repo <dir>            repository to enforce prereg against (default: current git toplevel)
  --out <dir>             campaign output root (default: evals/runs, or the state root for held-out runs)
  --auth-passthrough <p,..>  copy these provider entries (opencode-go, opencode) from the real auth.json into each run's isolated
                          auth.json; or set METACOGS_AUTH_PASSTHROUGH. Live runs default to opencode-go only; opencode (Zen, credit-billed)
                          is copied only when listed; 'none' copies nothing. Values are never logged or recorded; names go in the manifest
  --campaign <dir>        report only: the RED campaign directory (default: newest evals/runs/<name>-red-*)

Live runs are judged by the prereg's judge model through the isolated OpenCode gateway (Go by default); scripted runs are not judged.
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
  const devOnly = parsed.values['dev-only'] === true
  if ((mode === 'review' || mode === 'rejudge') && !extra.length) {
    return campaignToolMain({ mode, campaign: parsed.values.campaign, repo, authFlag: parsed.values['auth-passthrough'], cwd, env, out, err })
  }
  if (mode === 'report' && !extra.length && method) return reportMain({ method, repo, campaign: parsed.values.campaign, devOnly, cwd, env, out, err })
  if ((mode !== 'red' && mode !== 'green') || extra.length || !method) {
    err(USAGE)
    return EXIT.USAGE
  }
  if (devOnly && mode !== 'green') {
    err(`--dev-only applies to green (and report) only\n${USAGE}`)
    return EXIT.USAGE
  }
  // The dev-only green is a separate runner mode: it can never plan, load, or hash held-out content.
  const runMode = devOnly ? 'dev' : mode
  if (provider !== undefined && provider !== 'scripted' && provider !== 'live') {
    err(`--provider must be scripted or live\n${USAGE}`)
    return EXIT.USAGE
  }
  const providerMode: ProviderMode = provider === 'live' ? 'live' : 'scripted'
  let auth: PassthroughAuth = {}
  try {
    const providers = parseAuthPassthrough(parsed.values['auth-passthrough'], env, providerMode === 'live' ? DEFAULT_PASSTHROUGH : [])
    auth = readPassthroughAuth(providers)
  } catch (e) {
    if (e instanceof AuthPassthroughError) {
      err(`${e.message}\n${USAGE}`)
      return EXIT.USAGE
    }
    throw e
  }
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
    verification = enforcePrereg({ git, repoRoot, method, mode: runMode, heldoutDir: heldoutDir(method, env) })
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
    mode: runMode,
    fixtures: verification.content.fixtures,
    runsPerCondition,
    onlyFixture: fixture,
    includeDev: parsed.values['include-dev'],
  })
  if (plan.length === 0) {
    err(`nothing to run: the ${mode} plan for ${method} is empty (no fixtures?)`)
    return EXIT.ERROR
  }

  const campaignId = `${method}-${runMode}-${new Date().toISOString().replace(/[:.]/g, '-')}`
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

  let judge: ReturnType<typeof createJudge> | undefined
  if (providerMode === 'live') {
    if (!isLiveModel(prereg.judge_model_id)) {
      err(`prereg pins judge ${prereg.judge_model_id}; this runner only reaches opencode/* and opencode-go/* judges`)
      return EXIT.ERROR
    }
    judge = createJudge({ repoRoot, method, model: prereg.judge_model_id, auth })
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
      mode: runMode,
      providerMode,
      verification,
      campaignId,
      campaignDir,
      runs: plan,
      judge: judge?.hook,
      auth,
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
  if (!judge && result.results.some((r) => r.outcome && r.outcome !== 'infra_error' && r.outcome !== 'non_isolated')) {
    out('note: scripted run, no judge: positive-fixture outcomes are deterministic-only (verdict_basis=pending-judge).')
  }
  if (result.aborted === 'credential_leak') {
    err('ABORTED: credential_leak. Artifacts for that run were purged; see its manifest.')
    return EXIT.CREDENTIAL_LEAK
  }
  if (result.aborted === 'interrupted') return EXIT.INTERRUPTED
  return EXIT.OK
}

interface CampaignToolArgs {
  mode: 'review' | 'rejudge'
  campaign?: string
  repo?: string
  authFlag?: string
  cwd: string
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
}

/** `--campaign` is a directory, or a campaign id under `evals/runs/` (then the state root's `runs/`, where held-out campaigns live). */
export function resolveCampaignDir(value: string, repoRoot: string, cwd: string, env: Record<string, string | undefined>): string | undefined {
  const candidates = [resolve(cwd, value), join(repoRoot, 'evals', 'runs', value), join(stateRoot(env), 'runs', value)]
  return candidates.find((c) => existsSync(c) && statSync(c).isDirectory())
}

/** `review`: write review.md for a campaign. `rejudge`: judge calls over retained answers, then the same sheet. */
async function campaignToolMain(a: CampaignToolArgs): Promise<number> {
  if (!a.campaign) {
    a.err(`${a.mode} needs --campaign <id|dir>\n${USAGE}`)
    return EXIT.USAGE
  }
  const repoRoot = new Git(a.repo ?? a.cwd).toplevel()
  const campaignDir = resolveCampaignDir(a.campaign, repoRoot, a.cwd, a.env)
  if (!campaignDir) {
    a.err(`no campaign directory found for ${a.campaign}`)
    return EXIT.ERROR
  }
  const runs = loadCampaignRuns(campaignDir)
  if (runs.length === 0) {
    a.err(`no run manifests in ${a.campaign}`)
    return EXIT.ERROR
  }
  const method = runs[0]!.manifest.method
  if (a.mode === 'rejudge') {
    let auth: PassthroughAuth = {}
    try {
      auth = readPassthroughAuth(parseAuthPassthrough(a.authFlag, a.env, DEFAULT_PASSTHROUGH))
    } catch (e) {
      if (e instanceof AuthPassthroughError) {
        a.err(`${e.message}\n${USAGE}`)
        return EXIT.USAGE
      }
      throw e
    }
    let verification: ReturnType<typeof enforcePrereg>
    try {
      verification = enforcePrereg({ git: new Git(repoRoot), repoRoot, method, mode: 'red', heldoutDir: heldoutDir(method, a.env) })
    } catch (e) {
      if (e instanceof PreregRefusal) {
        a.err(`REFUSED: ${e.message}`)
        return EXIT.REFUSED
      }
      throw e
    }
    const model = verification.prereg.judge_model_id
    if (!isLiveModel(model)) {
      a.err(`prereg pins judge ${model}; this runner only reaches opencode/* and opencode-go/* judges`)
      return EXIT.ERROR
    }
    const availability = opencodeAvailability()
    if (!availability.available) {
      a.err(`cannot launch the pinned OpenCode: ${availability.reason}`)
      return EXIT.ERROR
    }
    const judge = createJudge({ repoRoot, method, model, auth })
    const rows = await rejudgeCampaign({
      campaignDir,
      judge: judge.hook,
      fixtures: verification.content.fixtures,
      judgePromptSha256: judge.systemPromptSha256,
      log: a.out,
    })
    const count = (v: string) => rows.filter((r) => r.verdict === v).length
    a.out(`rejudged ${rows.length - count('skipped')} of ${rows.length} runs: pass ${count('pass')} · fail ${count('fail')} · judge_error ${count('judge_error')} · skipped ${count('skipped')} (manifests unchanged)`)
  }
  const path = writeReview(campaignDir, repoRoot)
  a.out(`wrote ${path}`)
  return EXIT.OK
}

interface ReportArgs {
  method: string
  repo?: string
  campaign?: string
  devOnly: boolean
  cwd: string
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
}

/** Newest `<runs>/<method>-<kind>-*` directory (campaign ids embed an ISO timestamp, so names sort by time). */
function latestCampaign(runsDir: string, method: string, kind: 'red' | 'dev'): string | undefined {
  if (!existsSync(runsDir)) return undefined
  const names = readdirSync(runsDir)
    .filter((n) => n.startsWith(`${method}-${kind}-`) && statSync(join(runsDir, n)).isDirectory())
    .sort()
  const last = names.at(-1)
  return last ? join(runsDir, last) : undefined
}

function reportMain(a: ReportArgs): number {
  const repoRoot = new Git(a.repo ?? a.cwd).toplevel()
  const git = new Git(repoRoot)
  let verification: ReturnType<typeof enforcePrereg>
  try {
    verification = enforcePrereg({ git, repoRoot, method: a.method, mode: a.devOnly ? 'dev' : 'red', heldoutDir: heldoutDir(a.method, a.env) })
  } catch (e) {
    if (e instanceof PreregRefusal) {
      a.err(`REFUSED: ${e.message}`)
      return EXIT.REFUSED
    }
    throw e
  }
  const campaignDir = a.campaign ? resolve(a.cwd, a.campaign) : latestCampaign(join(repoRoot, 'evals', 'runs'), a.method, a.devOnly ? 'dev' : 'red')
  if (!campaignDir || !existsSync(campaignDir)) {
    a.err(`no ${a.devOnly ? 'dev' : 'RED'} campaign found for ${a.method}; pass --campaign <dir>`)
    return EXIT.ERROR
  }
  const runs = loadCampaignManifests(campaignDir)
  const stale = runs.filter((r) => r.manifest.prereg.commit_sha !== verification.shas.commitSha || r.manifest.method !== a.method)
  if (stale.length) {
    a.err(`REFUSED: ${stale.length} manifest(s) in ${campaignDir} were not produced under ${verification.shas.tag} (${verification.shas.commitSha.slice(0, 12)})`)
    return EXIT.REFUSED
  }
  const summaryPath = join(campaignDir, 'summary.json')
  const plannedRuns = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as { planned_runs?: number }).planned_runs ?? runs.length : runs.length
  const headSha = git.head()
  if (!headSha) {
    a.err('repository has no HEAD')
    return EXIT.ERROR
  }
  // The report must not carry a passthrough credential. Check against whatever the real auth.json holds for the allowed providers.
  let needles: ReturnType<typeof needlesOf> = []
  try {
    needles = needlesOf(readPassthroughAuth(PASSTHROUGH_PROVIDERS))
  } catch {
    // no real auth.json (CI, other machines): nothing to compare against
  }
  if (a.devOnly) return devReportMain(a, { repoRoot, git, verification, headSha, runs, plannedRuns, needles })
  const report = buildRedReport({ prereg: verification.prereg, shas: verification.shas, headSha, runs, plannedRuns })
  const serialized = JSON.stringify(report)
  if (needles.some((n) => serialized.includes(n.value))) {
    a.err('ABORTED: credential_leak: the report contains a passthrough credential value; nothing was written')
    return EXIT.CREDENTIAL_LEAK
  }
  const path = writeReport(repoRoot, report)
  a.out(`wrote ${path.slice(repoRoot.length + 1)}`)
  for (const f of report.fixtures) a.out(`  ${f.kind}/${f.id}: fail ${f.fail_over_total} ${JSON.stringify(f.fail_rate_wilson95)}${f.meets_red_bar ? ' · meets RED bar' : ''}`)
  a.out(`green_eligible=${report.red.green_eligible} (${report.red.dev_fixtures_meeting_bar}/${report.red.min_fixtures} dev fixtures at the bar; excluding judge_error: ${report.red.sensitivity_excluding_judge_error.dev_fixtures_meeting_bar})`)
  return EXIT.OK
}

/** The skill's committed tree must be exactly what the campaign ran, so the report names a skill anyone can check out. */
function devReportMain(
  a: ReportArgs,
  c: {
    repoRoot: string
    git: Git
    verification: ReturnType<typeof enforcePrereg>
    headSha: string
    runs: ReturnType<typeof loadCampaignManifests>
    plannedRuns: number
    needles: ReturnType<typeof needlesOf>
  },
): number {
  if (c.git.porcelain([`skills/${a.method}`])) {
    a.err(`REFUSED: skills/${a.method} has uncommitted changes; commit the skill the campaign ran before projecting its report`)
    return EXIT.REFUSED
  }
  const current = hashSkillDir(join(c.repoRoot, 'skills', a.method)).sha256
  let report: ReturnType<typeof buildDevReport>
  try {
    report = buildDevReport({ prereg: c.verification.prereg, shas: c.verification.shas, headSha: c.headSha, runs: c.runs, plannedRuns: c.plannedRuns, skillSha256: current })
  } catch (e) {
    a.err(`REFUSED: ${(e as Error).message}`)
    return EXIT.REFUSED
  }
  if (c.needles.some((n) => JSON.stringify(report).includes(n.value))) {
    a.err('ABORTED: credential_leak: the report contains a passthrough credential value; nothing was written')
    return EXIT.CREDENTIAL_LEAK
  }
  const path = writeDevReport(c.repoRoot, report)
  a.out(`wrote ${path.slice(c.repoRoot.length + 1)}`)
  for (const f of report.fixtures) a.out(`  ${f.kind}/${f.id}: ${f.kind === 'dev' ? `pass ${f.pass_over_total} (skill tool ${f.fire_basis.skill_tool} · direct read ${f.fire_basis.direct_read} · none ${f.fire_basis.none})${f.meets_dev_bar ? ' · meets dev bar' : ''}` : `false fires ${f.fail}/${f.attempted}`}`)
  a.out(`passes_dev_bar=${report.dev.passes_dev_bar} (${report.dev.dev_fixtures_meeting_bar}/${report.dev.dev_fixtures} dev fixtures; ${report.dev.negative_false_fires} negative false fires)`)
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
  campaign: { type: 'string' },
  'auth-passthrough': { type: 'string' },
  'include-dev': { type: 'boolean' },
  'dev-only': { type: 'boolean' },
} as const

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
