/**
 * Standalone driver for the feel/drugs mechanism spike (docs/plans/2026-10-25-001-feat-feel-drugs-spike-plan.md).
 *
 * Three arms on one tool set: A nothing, B the upstream `feel`/`drugs` registrations over a local stdio MCP, C the same
 * frames as a skill. It reuses the runner's workspace, child-env, isolation and event primitives, but it is not a
 * method: no prereg, no rubric, no judge, no tally. Each run keeps its transcript under the state root; `sheet.ts`
 * renders the one committed read sheet from those.
 *
 * `--provider scripted` (the default) talks to a local stub and costs nothing. `--provider live` needs the frozen
 * prompt file (`checkFrozen`) and a CLIProxyAPI key, and is checked before either is touched.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'

import { CLIPROXY_UPSTREAM, type ResolvedCliproxy, resolveCliproxy as defaultResolveCliproxy } from '../../runner/cliproxy'
import { destroyFixture } from '../../runner/env'
import { allAssistantText, analyzeEvents, type EventSummary, isRateLimited, isSkillContentLoad, parseEvents, type Usage } from '../../runner/events'
import { checkDebugConfig, checkIsolation, offeredTools } from '../../runner/isolation'
import { CredentialLeakError, type Needle, scanForLeaks } from '../../runner/manifest'
import { debugConfig, runArgv, sleepUnlessAborted, spawnCapture } from '../../runner/opencode'
import {
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  type ScriptedStep,
  startRecordingProxy,
  startScriptedProvider,
} from '../../runner/scripted-provider'
import { createRunWorkspace, sha256, stateRoot } from '../../runner/workspace'

// ── constants ──────────────────────────────────────────────────────────────

export const ARMS = ['A', 'B', 'C'] as const
export type Arm = (typeof ARMS)[number]
export const MODELS = ['openai/gpt-6-luna', 'anthropic/claude-haiku-5-5'] as const
export const MCP_SERVER_NAME = 'metacog'
/** OpenCode names an MCP tool `<server key>_<tool>`; the probe confirms it against the pinned host. */
export const EXPECTED_TOOLS = [`${MCP_SERVER_NAME}_feel`, `${MCP_SERVER_NAME}_drugs`] as const
export const SKILL_NAME = 'metacog-frames'
/** The `method` handed to the workspace builder; only names the (unused) `skills/<method>` lookup. */
const METHOD = 'feel-drugs-spike'
export const RUN_TIMEOUT_MS = 300_000
export const BACKOFF_MS = [30_000, 60_000, 120_000] as const
/** `--nudge` appends exactly this to the frozen prompt text. The README records its sha256. */
export const NUDGE = '\n\nUse your available tools or skills before answering.'
export type Variant = 'unprompted' | 'nudged'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SERVER_PATH = fileURLToPath(new URL('./server.ts', import.meta.url))
const SPIKE_DIR = ['evals', 'spikes', 'feel-drugs'] as const
const spikeFile = (repoRoot: string, name: string) => join(repoRoot, ...SPIKE_DIR, name)

// ── arguments ──────────────────────────────────────────────────────────────

export interface SpikeOptions {
  models: string[]
  arms: Arm[]
  /** Prompt ids; empty means every prompt in the file. */
  prompts: string[]
  runs: number
  provider: 'scripted' | 'live'
  probe: boolean
  /** Append `NUDGE` to every prompt sent. `prompts.md` and its freeze are untouched. */
  nudge: boolean
  authCliproxy: string | undefined
}

export function parseArgs(argv: readonly string[]): SpikeOptions {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      model: { type: 'string', multiple: true },
      arm: { type: 'string', multiple: true },
      prompt: { type: 'string', multiple: true },
      runs: { type: 'string' },
      provider: { type: 'string' },
      probe: { type: 'boolean' },
      nudge: { type: 'boolean' },
      'auth-cliproxy': { type: 'string' },
    },
    strict: true,
  })
  const arms = (values.arm ?? [...ARMS]).map((a) => {
    if (!(ARMS as readonly string[]).includes(a)) throw new Error(`--arm takes ${ARMS.join(', ')}; got "${a}"`)
    return a as Arm
  })
  const provider = values.provider ?? 'scripted'
  if (provider !== 'scripted' && provider !== 'live') throw new Error(`--provider takes scripted or live; got "${provider}"`)
  const runs = values.runs === undefined ? 2 : Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs takes a positive integer; got "${values.runs}"`)
  return {
    models: values.model ?? [...MODELS],
    arms,
    prompts: values.prompt ?? [],
    runs,
    provider,
    probe: values.probe ?? false,
    nudge: values.nudge ?? false,
    authCliproxy: values['auth-cliproxy'],
  }
}

// ── prompts and the freeze ─────────────────────────────────────────────────

export interface SpikePrompt {
  id: string
  text: string
  rationale: string
}

/**
 * `## <id>` sections; the prompt is the section's blockquote (`> ` lines, joined with `\n`), the rationale is its
 * `Rationale:` line. Anything before the first `##` is free text.
 */
const PROMPT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Prompt ids become directory names under the campaign dir, so they are a closed set of safe characters. */
export function assertPromptId(id: string): void {
  if (!PROMPT_ID.test(id)) throw new Error(`invalid prompt id ${JSON.stringify(id)}: ids match ${PROMPT_ID.source}`)
}

/** Throws unless `target` is an absolute path strictly inside `base`. Guards every recursive delete of a run directory. */
export function assertInside(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target))
  const inside = isAbsolute(target) && rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  if (!inside) throw new Error(`run directory ${target} is outside the campaign directory ${base}`)
}

export function parsePrompts(markdown: string): SpikePrompt[] {
  const prompts: SpikePrompt[] = []
  const sections = markdown.split(/^## /m).slice(1)
  for (const section of sections) {
    const lines = section.split('\n')
    const id = (lines[0] ?? '').trim().split(/\s+/)[0] ?? ''
    if (!id) throw new Error('a prompt section has no id')
    assertPromptId(id)
    if (prompts.some((p) => p.id === id)) throw new Error(`duplicate prompt id ${id}`)
    const quoted = lines.slice(1).filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, ''))
    const text = quoted.join('\n').trim()
    if (!text) throw new Error(`prompt ${id} has no text (a "> " blockquote)`)
    const rationale = lines.map((l) => /^Rationale:\s*(.+)$/.exec(l)?.[1]?.trim()).find(Boolean)
    if (!rationale) throw new Error(`prompt ${id} has no Rationale: line`)
    prompts.push({ id, text, rationale })
  }
  if (prompts.length === 0) throw new Error('no prompts found (expected "## <id>" sections)')
  return prompts
}

function promptById(prompts: readonly SpikePrompt[], id: string): SpikePrompt {
  const found = prompts.find((p) => p.id === id)
  if (!found) throw new Error(`unknown prompt id ${id}`)
  return found
}

export function loadPrompts(repoRoot = REPO_ROOT): SpikePrompt[] {
  return parsePrompts(readFileSync(spikeFile(repoRoot, 'prompts.md'), 'utf8'))
}

export type FrozenCheck = { ok: true; sha256: string } | { ok: false; reason: string }

/** The README records `prompts_sha256: <hex>`; live runs need it to equal the hash of the committed prompt file. */
export function checkFrozen(repoRoot = REPO_ROOT): FrozenCheck {
  const promptsPath = spikeFile(repoRoot, 'prompts.md')
  const readmePath = spikeFile(repoRoot, 'README.md')
  if (!existsSync(promptsPath)) return { ok: false, reason: `live runs need the frozen prompt file ${SPIKE_DIR.join('/')}/prompts.md` }
  if (!existsSync(readmePath)) return { ok: false, reason: `live runs need ${SPIKE_DIR.join('/')}/README.md to record the prompt file hash` }
  const recorded = /^prompts_sha256:\s*`?([0-9a-f]{64})`?\s*$/m.exec(readFileSync(readmePath, 'utf8'))?.[1]
  if (!recorded) return { ok: false, reason: 'the README records no prompts_sha256: <hex> line; the prompts are not frozen' }
  const actual = sha256(readFileSync(promptsPath))
  if (actual !== recorded) return { ok: false, reason: `the prompt file hash ${actual.slice(0, 12)} does not match the README's ${recorded.slice(0, 12)}; the prompts are not frozen` }
  return { ok: true, sha256: actual }
}

// ── per-arm setup ──────────────────────────────────────────────────────────

export interface ArmSetup {
  permission: Record<string, unknown>
  configExtra?: Record<string, unknown> | undefined
  skillSource?: { name: string; dir: string } | undefined
}

/**
 * One permission block for every arm (the arms differ only in what the model is offered): no edits, no outside
 * directories, no web, no subagents, no shell, no skills, except the arm C skill.
 */
export function armSetup(arm: Arm, serverPath = SERVER_PATH, repoRoot = REPO_ROOT): ArmSetup {
  const permission = {
    edit: 'deny',
    external_directory: 'deny',
    webfetch: 'deny',
    task: 'deny',
    bash: { '*': 'deny' },
    skill: arm === 'C' ? { '*': 'deny', [SKILL_NAME]: 'allow' } : { '*': 'deny' },
  }
  if (arm === 'B') {
    return {
      permission,
      configExtra: { mcp: { [MCP_SERVER_NAME]: { type: 'local', command: ['bun', serverPath], enabled: true, timeout: 30000 } } },
    }
  }
  if (arm === 'C') return { permission, skillSource: { name: SKILL_NAME, dir: join(repoRoot, ...SPIKE_DIR, 'skill', SKILL_NAME) } }
  return { permission }
}

// ── classification ─────────────────────────────────────────────────────────

export type RunStatus = 'completed' | 'tools_missing' | 'timeout' | 'host_error' | 'rate_limited'

export function classifyStatus(input: {
  timedOut: boolean
  exitCode: number
  /** The host's raw `--format json` stream. */
  stdout: string
  arm: Arm
  offered: readonly string[]
}): { status: RunStatus; reasons: string[] } {
  const { timedOut, exitCode, stdout, arm, offered } = input
  if (timedOut) return { status: 'timeout', reasons: ['timeout'] }
  const events = analyzeEvents(stdout)
  if (isRateLimited(events.hostErrors)) return { status: 'rate_limited', reasons: ['provider_429'] }
  if (events.hostErrors.length > 0) return { status: 'host_error', reasons: events.hostErrors.map((e) => `host_error:${e.name ?? 'unknown'}`) }
  if (exitCode !== 0) return { status: 'host_error', reasons: [`host_exit_${exitCode}`] }
  // Fail closed: a stream that cannot be read, or shows no completion, is never a completed run.
  const parsed = parseEvents(stdout)
  if (parsed.events.length === 0 && parsed.nonJsonLines.length === 0) return { status: 'host_error', reasons: ['no_events'] }
  if (events.unrecognized.length > 0) return { status: 'host_error', reasons: ['unrecognized_events'] }
  if (events.stepFinishCount === 0 && events.assistantText.trim() === '') return { status: 'host_error', reasons: ['no_completion'] }
  const hasTools = EXPECTED_TOOLS.every((t) => offered.includes(t))
  if (arm !== 'B' && offered.some((t) => t.startsWith(`${MCP_SERVER_NAME}_`))) return { status: 'host_error', reasons: ['unexpected_tools_offered'] }
  if (arm === 'B' && !hasTools) return { status: 'tools_missing', reasons: ['expected_tools_not_offered'] }
  return { status: 'completed', reasons: [] }
}

/** Retries a rate-limited run after 30, 60 and 120 s; the last result stands. */
export async function withBackoff<T extends { status: RunStatus }>(attempt: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let result = await attempt()
  for (const ms of BACKOFF_MS) {
    if (result.status !== 'rate_limited') break
    await sleep(ms)
    result = await attempt()
  }
  return result
}

// ── the run record ─────────────────────────────────────────────────────────

export interface ToolCallRecord {
  tool: string
  input: unknown
  status: string | undefined
}

export interface RunRecord {
  schema_version: 1
  /** Absent in run records written before the nudged variant; readers treat that as `unprompted`. */
  variant: Variant
  arm: Arm
  model: string
  /** The model the host was pointed at: the scripted stub's id in scripted mode, otherwise `model`. */
  host_model: string
  provider: 'scripted' | 'live'
  prompt_id: string
  prompt_hash: string
  run: number
  status: RunStatus
  reasons: string[]
  offered_tools: string[]
  tool_calls: ToolCallRecord[]
  /** Arm C: the skill's content reached the model. Null for other arms. */
  skill_loaded: boolean | null
  /** Arm C: the frame labels appear in the reply. Null for other arms. */
  in_reply_fields: { feel: boolean; drugs: boolean } | null
  /** All assistant text parts in stream order, joined with a newline. */
  answer: string
  isolation: { passed: boolean; failed: string[] }
  /** For the sheet's path redaction; the fixture is deleted after the run. */
  paths: { workspaces: string[]; homes: string[] }
  wall_ms: number
  usage: Usage
  returned_models: string[]
}

const FEEL_LABELS = [/^Attending:/m, /^Texture:/m]
const DRUGS_LABELS = [/SUBSTRATE DISPLACED:/]

// ── one run ────────────────────────────────────────────────────────────────

export interface SpikeDeps {
  repoRoot?: string
  /** Campaign dirs go under here. Default `<state root>/spikes/feel-drugs`. */
  outRoot?: string
  prompts?: SpikePrompt[]
  /** Scripted turns for a cell. Default: arm B calls `metacog_feel` once; the others answer directly. */
  scriptFor?: (arm: Arm, prompt: SpikePrompt) => ScriptedStep[]
  finalText?: string
  /** Test hook: rewrite an arm's setup (e.g. drop the MCP entry). */
  tweakArm?: (arm: Arm, setup: ArmSetup) => ArmSetup
  /** Extra leak-scan needles (live mode adds the CLIProxyAPI key's). */
  needles?: Needle[]
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  resolveCliproxy?: typeof defaultResolveCliproxy
  runTimeoutMs?: number
  log?: (line: string) => void
  signal?: AbortSignal
}

const defaultScript = (arm: Arm): ScriptedStep[] =>
  arm === 'B'
    ? [{ toolCalls: [{ id: 'spike-feel', name: 'metacog_feel', arguments: { somewhere: 'in the response', quality: 'steady, warm', sigil: '🌊' } }] }]
    : []

interface RunContext {
  options: SpikeOptions
  deps: SpikeDeps
  repoRoot: string
  model: string
  prompt: SpikePrompt
  arm: Arm
  index: number
  campaignDir: string
  runDir: string
  cliproxy: ResolvedCliproxy | undefined
}

const uniq = <T>(values: T[]): T[] => [...new Set(values)]
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function runOnce(c: RunContext): Promise<RunRecord> {
  const { options, deps, model, prompt, arm } = c
  const live = options.provider === 'live'
  const signal = deps.signal ?? new AbortController().signal
  const sent = options.nudge ? `${prompt.text}${NUDGE}` : prompt.text
  assertInside(c.campaignDir, c.runDir)
  rmSync(c.runDir, { recursive: true, force: true })

  const server = live ? startRecordingProxy(CLIPROXY_UPSTREAM) : startScriptedProvider({ steps: (deps.scriptFor ?? ((a) => defaultScript(a)))(arm, prompt), finalText: deps.finalText })
  const hostModel = live ? model : `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`
  const setup = (deps.tweakArm ?? ((_a, s) => s))(arm, armSetup(arm, SERVER_PATH, c.repoRoot))
  let ws: ReturnType<typeof createRunWorkspace>
  try {
    ws = createRunWorkspace({
      repoRoot: c.repoRoot,
      method: METHOD,
      condition: setup.skillSource ? 'skill' : 'baseline',
      fixtureId: prompt.id,
      fixtureText: sent,
      provider: live ? { kind: 'live', recordingProxyUrl: server.url } : { kind: 'scripted', url: server.url },
      model: hostModel,
      permission: setup.permission,
      ...(live && c.cliproxy ? { auth: c.cliproxy.auth, cliproxy: true } : {}),
      ...(setup.configExtra ? { configExtra: setup.configExtra } : {}),
      ...(setup.skillSource ? { skillSource: setup.skillSource } : {}),
    })
  } catch (e) {
    server.stop()
    throw e
  }

  try {
    const base = { cwd: ws.fixture.workspace, env: ws.env }
    // Effective config first, as the runner does: if something outside the generated file contributes, spend no model request.
    const dbg = await debugConfig({ ...base, timeoutMs: 120_000, signal })
    const dbgVerdict = dbg.json === undefined ? { passed: false } : checkDebugConfig(dbg.json, ws.config)
    const spawn = dbgVerdict.passed
      ? await spawnCapture(runArgv(hostModel, sent), { ...base, timeoutMs: deps.runTimeoutMs ?? RUN_TIMEOUT_MS, signal })
      : { stdout: '', stderr: dbg.result.stderr, exitCode: dbg.result.exitCode, timedOut: false, wallMs: dbg.result.wallMs }
    if (live) await Bun.sleep(50) // let the proxy's response scan settle

    const events = analyzeEvents(spawn.stdout)
    const offered = offeredTools(server.requests)
    const evidence = checkIsolation({
      expectedSkills: ws.expectedSkills,
      requests: server.requests,
      stdout: spawn.stdout,
      stderr: spawn.stderr,
      debugConfigJson: dbg.json,
      generatedConfig: ws.config,
      childEnv: ws.env,
      decoys: ws.decoys.needles,
    })
    const failed = evidence.checks.filter((k) => !k.passed).map((k) => k.name)
    let { status, reasons } = dbgVerdict.passed ? classifyStatus({ timedOut: spawn.timedOut, exitCode: spawn.exitCode, stdout: spawn.stdout, arm, offered }) : { status: 'host_error' as RunStatus, reasons: ['debug_config_generated_only'] }
    if (status === 'completed' && failed.length > 0) {
      status = 'host_error'
      reasons = failed.map((n) => `isolation_failed:${n}`)
    }

    const answer = allAssistantText(parseEvents(spawn.stdout).events)
    const record: RunRecord = {
      schema_version: 1,
      variant: options.nudge ? 'nudged' : 'unprompted',
      arm,
      model,
      host_model: hostModel,
      provider: options.provider,
      prompt_id: prompt.id,
      prompt_hash: sha256(prompt.text),
      run: c.index,
      status,
      reasons,
      offered_tools: offered,
      tool_calls: events.toolUses.map((t) => ({ tool: t.tool, input: t.input, status: t.status })),
      skill_loaded: arm === 'C' ? events.skillCalls.some((s) => isSkillContentLoad(s, SKILL_NAME)) : null,
      in_reply_fields: arm === 'C' ? { feel: FEEL_LABELS.every((r) => r.test(answer)), drugs: DRUGS_LABELS.every((r) => r.test(answer)) } : null,
      answer,
      isolation: { passed: evidence.passed, failed },
      paths: {
        workspaces: uniq([ws.fixture.workspace, real(ws.fixture.workspace)]),
        homes: uniq([ws.fixture.home, real(ws.fixture.home)]),
      },
      wall_ms: spawn.wallMs,
      usage: events.usage,
      returned_models: uniq(server.requests.filter((r) => r.hasTools).map((r) => r.returnedModel).filter((m): m is string => Boolean(m))),
    }

    const artifacts = {
      'stdout.jsonl': spawn.stdout,
      'stderr.txt': spawn.stderr,
      'requests.json': JSON.stringify(server.requests.map((r) => r.body), null, 1),
    }
    // Nothing reaches the disk before the credential scan has seen all of it.
    const needles = [...(deps.needles ?? []), ...(c.cliproxy?.needles ?? [])]
    const findings = scanForLeaks({ needles, manifestJson: JSON.stringify(record), artifacts, dirs: [ws.fixture.workspace] })
    if (findings.length > 0) throw new CredentialLeakError(`${arm}-${prompt.id}-${c.index}`, [...new Set(findings.map((f) => f.label))])

    mkdirSync(c.runDir, { recursive: true, mode: 0o700 })
    for (const [file, text] of Object.entries(artifacts)) writeFileSync(join(c.runDir, file), text, { mode: 0o600 })
    writeFileSync(join(c.runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    return record
  } catch (e) {
    rmSync(c.runDir, { recursive: true, force: true })
    throw e
  } finally {
    server.stop()
    destroyFixture(ws.fixture)
  }
}

// ── the campaign ───────────────────────────────────────────────────────────

export interface SpikeSummary {
  campaignDirs: string[]
  records: RunRecord[]
}

const modelSlug = (model: string): string => model.replace(/[^A-Za-z0-9.]+/g, '-')

function describeProbe(record: RunRecord): string {
  const called = record.tool_calls.map((t) => t.tool)
  return `probe ${record.model} arm ${record.arm} (${record.status}): offered [${record.offered_tools.join(', ')}]; called: ${called.length ? called.join(', ') : 'none'}; isolation ${record.isolation.passed ? 'passed' : `failed (${record.isolation.failed.join(', ')})`}`
}

export async function runSpike(options: SpikeOptions, deps: SpikeDeps = {}): Promise<SpikeSummary> {
  const repoRoot = deps.repoRoot ?? REPO_ROOT
  const log = deps.log ?? ((line: string) => console.log(line))
  const signal = deps.signal
  const live = options.provider === 'live'

  // Ids name directories: check them before anything touches the disk or the network.
  for (const id of options.prompts) assertPromptId(id)

  // The freeze and the credential come first and in this order: no key is fetched for unfrozen prompts.
  if (live) {
    const frozen = checkFrozen(repoRoot)
    if (!frozen.ok) throw new Error(frozen.reason)
  }
  const all = deps.prompts ?? loadPrompts(repoRoot)
  for (const p of all) assertPromptId(p.id)
  const selected = options.prompts.length ? options.prompts.map((id) => promptById(all, id)) : all
  let cliproxy: ResolvedCliproxy | undefined
  if (live) {
    cliproxy = (deps.resolveCliproxy ?? defaultResolveCliproxy)(options.authCliproxy, process.env, { live: true })
    if (!cliproxy) throw new Error('--provider live needs --auth-cliproxy <key-name> (or METACOGS_AUTH_CLIPROXY)')
  }

  const outRoot = deps.outRoot ?? join(stateRoot(), 'spikes', 'feel-drugs')
  const sleep = deps.sleep ?? ((ms: number) => sleepUnlessAborted(ms, signal))
  const campaignDirs: string[] = []
  const records: RunRecord[] = []
  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')

  for (const model of options.models) {
    const campaignDir = join(outRoot, `${modelSlug(model)}${options.nudge ? '-nudged' : ''}-${stamp}`)
    campaignDirs.push(campaignDir)
    const plan = options.probe
      ? options.arms.map((arm) => ({ prompt: selected[0]!, arm, index: 1 }))
      : selected.flatMap((prompt) => options.arms.flatMap((arm) => Array.from({ length: options.runs }, (_, i) => ({ prompt, arm, index: i + 1 }))))
    const attempt = (cell: (typeof plan)[number]) =>
      withBackoff(() => runOnce({ options, deps, repoRoot, model, campaignDir, runDir: join(campaignDir, `${cell.arm}-${cell.prompt.id}-${cell.index}`), cliproxy, ...cell }), sleep)
    const describeRun = (record: RunRecord, label: string) =>
      options.probe ? describeProbe(record) : `${label} ${model} ${record.arm} ${record.prompt_id} #${record.run}: ${record.status}${record.reasons.length ? ` (${record.reasons.join(', ')})` : ''}; called: ${record.tool_calls.map((t) => t.tool).join(', ') || 'none'}`
    const first: RunRecord[] = []
    for (const [n, cell] of plan.entries()) {
      if (signal?.aborted) return { campaignDirs, records: [...records, ...first] }
      const record = await attempt(cell)
      first.push(record)
      log(describeRun(record, `[${n + 1}/${plan.length}]`))
    }
    // A cell that ended without a completed run gets one more try at the end; the final record stands.
    for (const [n, cell] of plan.entries()) {
      if (first[n]?.status === 'completed') continue
      if (signal?.aborted) break
      const record = await attempt(cell)
      first[n] = record
      log(describeRun(record, 'rerun'))
    }
    records.push(...first)
  }
  return { campaignDirs, records }
}

// ── entry point ────────────────────────────────────────────────────────────

export async function main(argv: readonly string[], deps: SpikeDeps = {}): Promise<number> {
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const { campaignDirs, records } = await runSpike(parseArgs(argv), { signal: abort.signal, ...deps })
    for (const dir of campaignDirs) console.log(`campaign: ${dir}`)
    const bad = records.filter((r) => r.status !== 'completed')
    if (bad.length) console.log(`${bad.length} of ${records.length} runs were not completed: ${bad.map((r) => `${r.arm}-${r.prompt_id}-${r.run}=${r.status}`).join(', ')}`)
    if (abort.signal.aborted) return 130
    return bad.length > 0 ? 1 : 0
  } catch (e) {
    if (e instanceof CredentialLeakError) {
      console.error(`credential leak in ${e.runId}: ${e.labels.join(', ')}; the run was discarded`)
      return 4
    }
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
