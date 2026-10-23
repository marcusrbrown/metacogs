/**
 * `bun run eval <red|green> --method <m> [options]`
 * `bun run eval report --method <m> [--campaign <dir>]`
 *
 * `red`/`green` run, check, judge (live mode only), and write manifests.
 * `report` projects a finished RED campaign into `evals/reports/<m>/red.json`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'

import { AuthPassthroughError, DEFAULT_PASSTHROUGH, needlesOf, type PassthroughAuth, parseAuthPassthrough, PASSTHROUGH_PROVIDERS, readPassthroughAuth } from './auth'
import { CliproxyAuthError, cliproxyModelMismatch, type ResolvedCliproxy, resolveCliproxy } from './cliproxy'
import { Git } from './git'
import { findNearDuplicates, NEAR_DUPLICATE_THRESHOLD } from './neardup'
import { HUMAN_REVIEW_FILE, loadCampaignRuns, reconcileCampaign, rejudgeCampaign, writeReview } from './review'
import { type HumanReview, humanReviewBlock, summarize } from './human-review'
import { createJudge } from './judge'
import { findStaleManifests } from './manifest'
import { opencodeAvailability } from './opencode'
import { isLiveModel } from './scripted-provider'
import { enforcePrereg, parsePrereg, PreregRefusal } from './prereg'
import { buildDevReport, buildGreenReport, buildRedReport, type DevReport, type GreenReport, greenReportPath, loadCampaignManifests, recomputeDevRegression, validateDevReport, validateGreenReport, writeDevReport, writeGreenReport, writeReport } from './report'
import { planRuns, type ProviderMode, runCampaign } from './run'
import { claimHeldoutRead, CustodyError, hashSkillDir, heldoutDir, heldoutReadMarkerPath, resolveOutputDir, stateRoot } from './workspace'

export const EXIT = { OK: 0, ERROR: 1, USAGE: 64, REFUSED: 3, CREDENTIAL_LEAK: 4, INTERRUPTED: 130 } as const

const USAGE = `usage: bun run eval <red|green> --method <name> [options]
       bun run eval report --method <name> [--campaign <dir>]
       bun run eval review --campaign <id|dir>                     write the blind review.md (fixture prompt, expected-answer notes, answer, record, an unmarked
                                                                   scoring table) and review-key.md (judge verdicts and quotes) into the campaign dir
       bun run eval review --campaign <id|dir> --reconcile         read the marked-up review.md against review-key.md: per-criterion agreement, run-outcome
                                                                   flips, human-review.json; updates a matching GREEN report's human_review block
       bun run eval rejudge --campaign <id|dir> [--auth-passthrough opencode-go]
                                                                   judge calls over retained answers, then review.md; manifests untouched

  --runs <n>              runs per condition per fixture (default: prereg runs_per_condition)
  --provider scripted|live   scripted = local stub (default for red and green --dev-only), live = the model pinned in the prereg through
                          OpenCode's gateway: opencode-go/* (Go subscription, the default and preferred) or opencode/* (Zen, bills credits).
                          The one-shot held-out read (green without --dev-only) refuses anything but --provider live
  --fixture <id>          only this fixture (single-run debugging; marks the campaign as deviating from prereg)
  --rehearsal             green only: scripted dry run of the skill condition on dev + negative fixtures. Never loads held-out fixtures,
                          never claims the read marker, never feeds a report
  --dev-only              green: authoring iteration. Skill condition on dev + negative fixtures only; never reads or plans held-out,
                          needs no committed skill. report: project the newest dev campaign into evals/reports/<m>/green-dev.json
  --repo <dir>            repository to enforce prereg against (default: current git toplevel)
  --out <dir>             campaign output root (default: evals/runs, or the state root for held-out runs)
  --auth-passthrough <p,..>  copy these provider entries (opencode-go, opencode) from the real auth.json into each run's isolated
                          auth.json; or set METACOGS_AUTH_PASSTHROUGH. Live runs default to opencode-go only; opencode (Zen, credit-billed)
                          is copied only when listed; 'none' copies nothing. Values are never logged or recorded; names go in the manifest
  --auth-cliproxy <name>  live runs only: use the owner's CLIProxyAPI key <name> (e.g. fro-bot-marcusrbrown-metacogs) for openai/* and anthropic/*
                          models; or set METACOGS_AUTH_CLIPROXY. The value is fetched at spawn time with 'infra cliproxy keys list --json'
                          (run from METACOGS_INFRA_DIR, default ~/src/github.com/marcusrbrown/infra) and written only to the run's isolated
                          auth.json. Replaces the opencode-go passthrough; cannot be combined with --auth-passthrough. Never logged or recorded
  --green                 report: project the one-shot GREEN campaign (default: newest <state root>/runs/<name>-green-*) into
                          evals/reports/<m>/green.json. Refuses if green.json exists.
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
    return campaignToolMain({ mode, campaign: parsed.values.campaign, repo, reconcile: parsed.values.reconcile === true, authFlag: parsed.values['auth-passthrough'], cliproxyFlag: parsed.values['auth-cliproxy'], cwd, env, out, err })
  }
  if (mode === 'report' && !extra.length && method) return reportMain({ method, repo, campaign: parsed.values.campaign, devOnly, green: parsed.values.green === true, cliproxyFlag: parsed.values['auth-cliproxy'], cwd, env, out, err })
  if ((mode !== 'red' && mode !== 'green') || extra.length || !method) {
    err(USAGE)
    return EXIT.USAGE
  }
  if (devOnly && mode !== 'green') {
    err(`--dev-only applies to green (and report) only\n${USAGE}`)
    return EXIT.USAGE
  }
  const rehearsal = parsed.values.rehearsal === true
  if (rehearsal && (mode !== 'green' || devOnly || provider === 'live')) {
    err(`--rehearsal applies to scripted green only, and not together with --dev-only\n${USAGE}`)
    return EXIT.USAGE
  }
  if (mode === 'green' && parsed.values['include-dev']) {
    err(`--include-dev is not accepted for green: the dev regression comes from evals/reports/<method>/green-dev.json (run green --dev-only, then report --dev-only)\n${USAGE}`)
    return EXIT.USAGE
  }
  if (provider !== undefined && provider !== 'scripted' && provider !== 'live') {
    err(`--provider must be scripted or live\n${USAGE}`)
    return EXIT.USAGE
  }
  // The held-out read is live or it does not happen: refuse before any held-out content is loaded or any marker is claimed.
  const isGreenRead = mode === 'green' && !devOnly && !rehearsal
  if (isGreenRead && provider !== 'live') {
    err('REFUSED: green requires --provider live')
    return EXIT.REFUSED
  }
  // The dev-only green and the rehearsal are separate runner modes: they can never plan, load, or hash held-out content.
  const runMode = devOnly || rehearsal ? 'dev' : mode
  const providerMode: ProviderMode = provider === 'live' ? 'live' : 'scripted'
  let auth: PassthroughAuth = {}
  let cliproxy: ResolvedCliproxy | undefined
  try {
    cliproxy = resolveCliproxy(parsed.values['auth-cliproxy'], env, { live: providerMode === 'live', passthroughFlag: parsed.values['auth-passthrough'] })
    auth = cliproxy ? cliproxy.auth : readPassthroughAuth(parseAuthPassthrough(parsed.values['auth-passthrough'], env, providerMode === 'live' ? DEFAULT_PASSTHROUGH : []))
  } catch (e) {
    if (e instanceof AuthPassthroughError || e instanceof CliproxyAuthError) {
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

  // One shot: a GREEN report for this method already exists, so the held-out set has been read.
  if (isGreenRead && existsSync(greenReportPath(repoRoot, method))) {
    err(`REFUSED: ${greenReportPath(repoRoot, method).slice(repoRoot.length + 1)} exists; the held-out set was read once for this epoch. A second read needs a new epoch and a new held-out set.`)
    return EXIT.REFUSED
  }
  if (isGreenRead && providerMode === 'live' && (runsOverride !== undefined || fixture !== undefined)) {
    err('REFUSED: the one-shot GREEN read must follow the prereg plan; --runs and --fixture are for dev and debugging only.')
    return EXIT.REFUSED
  }

  const campaignId = `${method}-${rehearsal ? 'rehearsal' : runMode}-${new Date().toISOString().replace(/[:.]/g, '-')}`

  // Enforcement happens before anything launches.
  let verification: ReturnType<typeof enforcePrereg>
  try {
    verification = enforcePrereg({
      git,
      repoRoot,
      method,
      mode: runMode,
      heldoutDir: heldoutDir(method, env),
      // The marker is claimed after the ordering checks pass and before the set is loaded, so any later outcome (a hash
      // mismatch, a crash, an interrupt) still leaves the read on record. A directory that does not exist has nothing to burn.
      beforeHeldoutRead: ({ prereg: p, shas }) => {
        if (!existsSync(heldoutDir(method, env))) return
        claimHeldoutRead(heldoutReadMarkerPath(method, p.epoch, env), { campaign_id: campaignId, started_at: new Date().toISOString(), prereg_tag: shas.tag })
      },
    })
  } catch (e) {
    if (e instanceof PreregRefusal || e instanceof CustodyError) {
      err(`REFUSED: ${e.message}`)
      return EXIT.REFUSED
    }
    throw e
  }
  const { prereg } = verification

  // Private near-duplicate check: a held-out fixture that copies a dev fixture measures memorization, not the skill.
  if (isGreenRead) {
    const hits = findNearDuplicates(verification.content.fixtures.heldout, verification.content.fixtures.dev)
    if (hits.length) {
      err(`REFUSED: near-duplicate held-out/dev fixtures (word 3-gram Jaccard >= ${NEAR_DUPLICATE_THRESHOLD}): ${hits.map((h) => `${h.heldout}~${h.dev} ${h.similarity}`).join(', ')}`)
      return EXIT.REFUSED
    }
  }

  const runsPerCondition = runsOverride ?? prereg.runs_per_condition
  const plan = planRuns({
    mode: runMode,
    fixtures: verification.content.fixtures,
    runsPerCondition,
    onlyFixture: fixture,
  })
  if (plan.length === 0) {
    err(`nothing to run: the ${mode} plan for ${method} is empty (no fixtures?)`)
    return EXIT.ERROR
  }

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
      err(`prereg pins judge ${prereg.judge_model_id}; this runner only reaches opencode/*, opencode-go/*, openai/* and anthropic/* judges`)
      return EXIT.ERROR
    }
    const mismatch = cliproxyModelMismatch([prereg.agent_model_id, prereg.judge_model_id], cliproxy !== undefined)
    if (mismatch) {
      err(`REFUSED: ${mismatch}`)
      return EXIT.REFUSED
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
      ...(cliproxy ? { cliproxyKeyName: cliproxy.keyName, leakNeedles: cliproxy.needles } : {}),
      signal: controller.signal,
      log: out,
    })
  } finally {
    uninstall()
  }

  out(`\nsummary: ${result.summaryPath}`)
  const planned: Record<string, number> = {}
  for (const r of plan) planned[`${r.fixture.kind}/${r.fixture.id}/${r.condition}`] = (planned[`${r.fixture.kind}/${r.fixture.id}/${r.condition}`] ?? 0) + 1
  for (const key of new Set([...Object.keys(planned), ...Object.keys(result.tallies)])) {
    const t = result.tallies[key] ?? { attempted: 0, pass: 0, fail: 0, infra_error: 0, non_isolated: 0 }
    out(`  ${key}: pass ${t.pass}/${t.attempted} (planned ${planned[key] ?? 0})${t.infra_error ? ` · infra_error ${t.infra_error}` : ''}${t.non_isolated ? ` · non_isolated ${t.non_isolated}` : ''}`)
  }
  const ungraded = result.results.filter((r) => r.status === 'completed' && r.outcome === undefined).length
  if (ungraded) out(`note: ${ungraded} positive-fixture run(s) passed their checks but were not graded (no judge): outcome pending, not counted. Judge them with rejudge before reporting.`)
  if (result.aborted === 'credential_leak') {
    err('ABORTED: credential_leak. Artifacts for that run were purged; see its manifest.')
    return EXIT.CREDENTIAL_LEAK
  }
  if (result.aborted === 'provider_outage') {
    err('ABORTED: provider_outage. Three rate-limited attempts in a row; no further runs were launched. The summary lists what ran.')
    return EXIT.ERROR
  }
  if (result.aborted === 'interrupted') return EXIT.INTERRUPTED
  return EXIT.OK
}

interface CampaignToolArgs {
  mode: 'review' | 'rejudge'
  campaign?: string
  reconcile?: boolean
  repo?: string
  authFlag?: string
  cliproxyFlag?: string
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
  if (a.reconcile) {
    if (a.mode !== 'review') {
      a.err(`--reconcile applies to review only\n${USAGE}`)
      return EXIT.USAGE
    }
    return reconcileMain({ a, repoRoot, campaignDir, method })
  }
  if (a.mode === 'rejudge') {
    let auth: PassthroughAuth = {}
    let cliproxyOn = false
    try {
      const cliproxy = resolveCliproxy(a.cliproxyFlag, a.env, { live: true, passthroughFlag: a.authFlag })
      cliproxyOn = cliproxy !== undefined
      auth = cliproxy ? cliproxy.auth : readPassthroughAuth(parseAuthPassthrough(a.authFlag, a.env, DEFAULT_PASSTHROUGH))
    } catch (e) {
      if (e instanceof AuthPassthroughError || e instanceof CliproxyAuthError) {
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
      a.err(`prereg pins judge ${model}; this runner only reaches opencode/*, opencode-go/*, openai/* and anthropic/* judges`)
      return EXIT.ERROR
    }
    const mismatch = cliproxyModelMismatch([model], cliproxyOn)
    if (mismatch) {
      a.err(`REFUSED: ${mismatch}`)
      return EXIT.REFUSED
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
  const paths = writeReview(campaignDir, repoRoot, { heldoutDir: heldoutDir(method, a.env) })
  a.out(`wrote ${paths.review}`)
  a.out(`wrote ${paths.key} (judge verdicts; open after marking)`)
  return EXIT.OK
}

/** `review --reconcile`: agreement and flips from the marked sheet; refreshes only the `human_review` block of a matching GREEN report. */
function reconcileMain(c: { a: CampaignToolArgs; repoRoot: string; campaignDir: string; method: string }): number {
  const { a, repoRoot, campaignDir, method } = c
  const preregPath = join(repoRoot, 'evals', method, 'prereg.json')
  const parsed = existsSync(preregPath) ? parsePrereg(readFileSync(preregPath, 'utf8')) : undefined
  if (!parsed?.ok) {
    a.err(`cannot read a valid prereg for ${method}`)
    return EXIT.ERROR
  }
  let review: HumanReview
  try {
    review = reconcileCampaign(campaignDir, parsed.prereg.agreement_floor)
  } catch (e) {
    a.err((e as Error).message)
    return EXIT.ERROR
  }
  for (const line of summarize(review)) a.out(line)
  a.out(`wrote ${join(campaignDir, HUMAN_REVIEW_FILE)}`)
  const greenPath = greenReportPath(repoRoot, method)
  if (existsSync(greenPath)) {
    const green = JSON.parse(readFileSync(greenPath, 'utf8')) as GreenReport
    if (green.campaign.id === review.campaign_id) {
      green.human_review = humanReviewBlock(review, parsed.prereg.green_bar, green.checks, green.heldout.map((f) => f.id))
      const errors = validateGreenReport(green)
      if (errors.length) {
        a.err(`refusing to update ${greenPath.slice(repoRoot.length + 1)}: not an allowlist projection: ${errors.join('; ')}`)
        return EXIT.ERROR
      }
      writeFileSync(greenPath, `${JSON.stringify(green, null, 2)}\n`)
      a.out(`updated human_review in ${greenPath.slice(repoRoot.length + 1)} (status ${green.human_review.status}${green.human_review.recomputed ? `; recomputed verdict ${green.human_review.recomputed.verdict}` : ''}); the machine verdict field is unchanged`)
    }
  }
  return EXIT.OK
}

interface ReportArgs {
  method: string
  repo?: string
  campaign?: string
  devOnly: boolean
  green: boolean
  cliproxyFlag?: string | undefined
  cwd: string
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
}

/** Newest `<runs>/<method>-<kind>-*` directory (campaign ids embed an ISO timestamp, so names sort by time). */
function latestCampaign(runsDir: string, method: string, kind: 'red' | 'dev' | 'green'): string | undefined {
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
    verification = enforcePrereg({ git, repoRoot, method: a.method, mode: a.green ? 'green' : a.devOnly ? 'dev' : 'red', heldoutDir: heldoutDir(a.method, a.env) })
  } catch (e) {
    if (e instanceof PreregRefusal) {
      a.err(`REFUSED: ${e.message}`)
      return EXIT.REFUSED
    }
    throw e
  }
  const kind = a.green ? 'green' : a.devOnly ? 'dev' : 'red'
  const campaignDir = a.campaign
    ? (resolveCampaignDir(a.campaign, repoRoot, a.cwd, a.env) ?? resolve(a.cwd, a.campaign))
    : latestCampaign(a.green ? join(stateRoot(a.env), 'runs') : join(repoRoot, 'evals', 'runs'), a.method, kind)
  if (!campaignDir || !existsSync(campaignDir)) {
    a.err(`no ${kind === 'red' ? 'RED' : kind} campaign found for ${a.method}; pass --campaign <id|dir>`)
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
  // The CLIProxyAPI key is not in auth.json. When the campaign used it (flag or env names it), compare against it too, or refuse.
  try {
    const cliproxy = resolveCliproxy(a.cliproxyFlag, a.env, { live: true })
    if (cliproxy) needles = [...needles, ...cliproxy.needles]
  } catch (e) {
    if (e instanceof CliproxyAuthError) {
      a.err(`ABORTED: cannot check the report for the CLIProxyAPI key: ${e.message}`)
      return EXIT.CREDENTIAL_LEAK
    }
    throw e
  }
  if (a.green) return greenReportMain(a, { repoRoot, verification, headSha, runs, plannedRuns, needles, campaignDir })
  if (a.devOnly) return devReportMain(a, { repoRoot, git, verification, headSha, runs, plannedRuns, needles })
  let report: ReturnType<typeof buildRedReport>
  try {
    report = buildRedReport({ prereg: verification.prereg, shas: verification.shas, headSha, runs, plannedRuns })
  } catch (e) {
    a.err(`REFUSED: ${(e as Error).message}`)
    return EXIT.REFUSED
  }
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

/**
 * `green-dev.json` is committed text an author can edit, so the GREEN checks never take its numbers. It only names the dev
 * campaign; the dev regression is rebuilt from that campaign's manifests, and the read is refused when they are not here.
 */
function rebuildDevRegression(
  a: ReportArgs,
  c: { repoRoot: string; verification: ReturnType<typeof enforcePrereg>; headSha: string },
): Pick<DevReport, 'skill' | 'dev'> | null {
  const devPath = join(c.repoRoot, 'evals', 'reports', a.method, 'green-dev.json')
  if (!existsSync(devPath)) return null
  const committed = JSON.parse(readFileSync(devPath, 'utf8')) as DevReport
  const problems = validateDevReport(committed)
  const id = committed.campaign?.id
  if (problems.length || typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`${devPath.slice(c.repoRoot.length + 1)} is not a valid dev report${problems.length ? `: ${problems.slice(0, 3).join('; ')}` : ''}`)
  }
  const dir = resolveCampaignDir(id, c.repoRoot, a.cwd, a.env)
  if (!dir) {
    throw new Error(`dev campaign ${id}, named by green-dev.json, has no manifests here (looked under evals/runs and the state root); the dev regression cannot be recomputed, so the committed file is not trusted`)
  }
  const summaryPath = join(dir, 'summary.json')
  const runs = loadCampaignManifests(dir)
  const plannedRuns = existsSync(summaryPath) ? ((JSON.parse(readFileSync(summaryPath, 'utf8')) as { planned_runs?: number }).planned_runs ?? runs.length) : runs.length
  const rebuilt = recomputeDevRegression({ prereg: c.verification.prereg, shas: c.verification.shas, headSha: c.headSha, runs, plannedRuns })
  if (rebuilt.dev.passes_dev_bar !== committed.dev.passes_dev_bar || rebuilt.skill.sha256 !== committed.skill.sha256) {
    a.err(`warning: ${devPath.slice(c.repoRoot.length + 1)} disagrees with its campaign manifests; the recomputed values are used`)
  }
  return rebuilt
}

/** The one-shot GREEN read: counts and verdict only; the artifacts stay under the state root. */
function greenReportMain(
  a: ReportArgs,
  c: {
    repoRoot: string
    verification: ReturnType<typeof enforcePrereg>
    headSha: string
    runs: ReturnType<typeof loadCampaignManifests>
    plannedRuns: number
    needles: ReturnType<typeof needlesOf>
    campaignDir: string
  },
): number {
  if (existsSync(greenReportPath(c.repoRoot, a.method))) {
    a.err(`REFUSED: ${greenReportPath(c.repoRoot, a.method).slice(c.repoRoot.length + 1)} already exists; GREEN is a one-shot read`)
    return EXIT.REFUSED
  }
  let devReport: Pick<DevReport, 'skill' | 'dev'> | null
  try {
    devReport = rebuildDevRegression(a, c)
  } catch (e) {
    a.err(`REFUSED: ${(e as Error).message}`)
    return EXIT.REFUSED
  }
  const fixtures = c.verification.content.fixtures
  const nearDuplicate = findNearDuplicates(fixtures.heldout, fixtures.dev).length === 0 ? 'pass' : 'fail'
  let report: ReturnType<typeof buildGreenReport>
  try {
    report = buildGreenReport({
      prereg: c.verification.prereg,
      shas: c.verification.shas,
      headSha: c.headSha,
      runs: c.runs,
      plannedRuns: c.plannedRuns,
      skillSha256: hashSkillDir(join(c.repoRoot, 'skills', a.method)).sha256,
      devReport,
      nearDuplicate,
      humanReview: existsSync(join(c.campaignDir, HUMAN_REVIEW_FILE)) ? (JSON.parse(readFileSync(join(c.campaignDir, HUMAN_REVIEW_FILE), 'utf8')) as HumanReview) : null,
    })
  } catch (e) {
    a.err(`REFUSED: ${(e as Error).message}`)
    return EXIT.REFUSED
  }
  if (c.needles.some((n) => JSON.stringify(report).includes(n.value))) {
    a.err('ABORTED: credential_leak: the report contains a passthrough credential value; nothing was written')
    return EXIT.CREDENTIAL_LEAK
  }
  const path = writeGreenReport(c.repoRoot, report)
  a.out(`wrote ${path.slice(c.repoRoot.length + 1)}`)
  for (const f of report.heldout) a.out(`  ${f.id}: skill ${f.skill.pass_over_total} baseline ${f.baseline.pass_over_total} delta ${f.delta.value} ${JSON.stringify(f.delta.newcombe95)}`)
  for (const f of report.negatives) a.out(`  ${f.id}: false fires ${f.false_fires}/${f.attempted}`)
  a.out(`pooled skill ${report.pooled.skill.pass}/${report.pooled.skill.attempted} baseline ${report.pooled.baseline.pass}/${report.pooled.baseline.attempted}; checks ${JSON.stringify(report.checks)}`)
  a.out(`verdict=${report.verdict}${report.held_out_too_easy ? ' (held-out too easy)' : ''}`)
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
  'auth-cliproxy': { type: 'string' },
  'include-dev': { type: 'boolean' },
  rehearsal: { type: 'boolean' },
  reconcile: { type: 'boolean' },
  'dev-only': { type: 'boolean' },
  green: { type: 'boolean' },
} as const

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
