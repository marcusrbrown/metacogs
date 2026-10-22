/**
 * Unit 1 spike driver: run `opencode run --format json` under an allowlisted
 * env, capture its events, and expose the instruments used to prove isolation.
 *
 * Nothing here is imported from Systematic; the shapes (process-group reaping,
 * memoized availability probe, scripted provider) are reimplemented minimally.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildChildEnv,
  bunInstallCacheDir,
  createFixture,
  type Fixture,
  OPENCODE_PIN,
} from './env'
import {
  type RecordedRequest,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  scriptedProviderConfig,
  type ScriptedProviderServer,
  type ScriptedStep,
  startRecordingProxy,
  startScriptedProvider,
} from './scripted-provider'

export { OPENCODE_PIN } from './env'

export const SPIKE_MODEL = `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`
/** Free-tier live model. Recorded in the README; id availability is probed, not assumed. */
export const LIVE_MODEL = 'opencode/big-pickle'

// ── availability ───────────────────────────────────────────────────────────

export interface Availability {
  available: boolean
  reason: string
}

let cachedAvailability: Availability | undefined

/** Memoized: `bunx opencode-ai@<pin> --version` must print exactly the pin. */
export function opencodeAvailability(): Availability {
  if (cachedAvailability) return cachedAvailability
  const result = spawnSync('bunx', [`opencode-ai@${OPENCODE_PIN}`, '--version'], {
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BUN_INSTALL_CACHE_DIR: bunInstallCacheDir(),
    },
  })
  const last = (result.stdout ?? '').trim().split(/\r?\n/).at(-1)?.trim()
  if (result.error || result.status !== 0) {
    cachedAvailability = {
      available: false,
      reason: `bunx opencode-ai@${OPENCODE_PIN} --version failed (status=${result.status ?? 'null'}): ${(result.stderr ?? '').slice(0, 200).trim()}`,
    }
  } else if (last !== OPENCODE_PIN) {
    cachedAvailability = {
      available: false,
      reason: `expected opencode-ai@${OPENCODE_PIN}, bunx reported ${last ?? '(nothing)'}`,
    }
  } else {
    cachedAvailability = { available: true, reason: `opencode-ai@${OPENCODE_PIN} available` }
  }
  if (!cachedAvailability.available) {
    console.warn(
      `\n!!! OPENCODE SPIKE TESTS WILL BE SKIPPED: ${cachedAvailability.reason} !!!\n`,
    )
  }
  return cachedAvailability
}

// ── process spawning ───────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string
  stderr: string
  /** -1 on timeout or spawn error. */
  exitCode: number
  timedOut: boolean
  wallMs: number
  /** Epoch ms at spawn, to compare against event timestamps. */
  startedAtMs: number
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Async spawn (a sync spawn would block the thread serving the scripted
 * provider). `detached` gives the child its own process group so the timeout
 * can reap `bunx` and its `opencode` grandchild together; stdin is closed
 * because `opencode run` otherwise waits on it.
 */
export function spawnCapture(
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<SpawnResult> {
  const [command, ...rest] = argv
  if (!command) throw new Error('spawnCapture requires a non-empty argv')
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(command, rest, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Reap any survivor in the group (e.g. a grandchild holding pipes).
      killGroup(child, 'SIGKILL')
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        wallMs: Date.now() - started,
        startedAtMs: started,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      setTimeout(() => {
        killGroup(child, 'SIGKILL')
        finish(-1)
      }, 5_000)
    }, options.timeoutMs)
    child.stdout?.on('data', (c: string) => {
      stdout += c
    })
    child.stderr?.on('data', (c: string) => {
      stderr += c
    })
    child.once('error', (e) => {
      stderr += `\n${String(e)}`
      finish(-1)
    })
    child.once('close', (code) => finish(timedOut ? -1 : (code ?? -1)))
  })
}

export function opencodeArgv(...args: string[]): string[] {
  return ['bunx', `opencode-ai@${OPENCODE_PIN}`, ...args]
}

// ── event parsing ──────────────────────────────────────────────────────────

/** Loose view over the (undocumented) `--format json` events. */
export interface OpencodeEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: Record<string, unknown>
  error?: Record<string, unknown>
  [key: string]: unknown
}

export interface ParsedEvents {
  events: OpencodeEvent[]
  /** Lines of stdout that were not valid JSON objects with a string `type`. */
  nonJsonLines: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEvents(stdout: string): ParsedEvents {
  const events: OpencodeEvent[] = []
  const nonJsonLines: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value) && typeof value.type === 'string') {
        events.push(value as OpencodeEvent)
        continue
      }
    } catch {
      // fall through
    }
    nonJsonLines.push(line)
  }
  return { events, nonJsonLines }
}

export interface ToolUse {
  tool: string
  callID: string | undefined
  status: string | undefined
  input: unknown
  output: string | undefined
  metadata: Record<string, unknown> | undefined
  error: string | undefined
  startMs: number | undefined
  endMs: number | undefined
}

/** `tool_use` events → flat records. Field names are the observed ones. */
export function toolUses(events: readonly OpencodeEvent[]): ToolUse[] {
  return events
    .filter((e) => e.type === 'tool_use')
    .map((e) => {
      const part = e.part ?? {}
      const state = isRecord(part.state) ? part.state : {}
      const time = isRecord(state.time) ? state.time : {}
      return {
        tool: String(part.tool),
        callID: typeof part.callID === 'string' ? part.callID : undefined,
        status: typeof state.status === 'string' ? state.status : undefined,
        input: state.input,
        output: typeof state.output === 'string' ? state.output : undefined,
        metadata: isRecord(state.metadata) ? state.metadata : undefined,
        error: typeof state.error === 'string' ? state.error : undefined,
        startMs: typeof time.start === 'number' ? time.start : undefined,
        endMs: typeof time.end === 'number' ? time.end : undefined,
      }
    })
}

export function skillLoads(events: readonly OpencodeEvent[]): ToolUse[] {
  return toolUses(events).filter((t) => t.tool === 'skill')
}

export function assistantText(events: readonly OpencodeEvent[]): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => (typeof e.part?.text === 'string' ? e.part.text : ''))
    .join('')
}

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Sum of `step_finish` token counters. */
export function totalUsage(events: readonly OpencodeEvent[]): Usage {
  const total: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const e of events) {
    if (e.type !== 'step_finish') continue
    const tokens = isRecord(e.part?.tokens) ? e.part.tokens : {}
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    total.input += Number(tokens.input ?? 0)
    total.output += Number(tokens.output ?? 0)
    total.reasoning += Number(tokens.reasoning ?? 0)
    total.cacheRead += Number(cache.read ?? 0)
    total.cacheWrite += Number(cache.write ?? 0)
    total.cost += Number(e.part?.cost ?? 0)
  }
  return total
}

// ── a scripted/live run ────────────────────────────────────────────────────

export interface RunSpec {
  prompt: string
  /** `provider/model`. Default: the scripted spike model. */
  model?: string
  /** Settings merged into the generated config (provider block is added in scripted mode). */
  permission: Record<string, unknown>
  /** Extra top-level config keys. */
  configExtra?: Record<string, unknown>
  /** Scripted turns. Omit for live runs (no stub is started). */
  steps?: readonly ScriptedStep[]
  finalText?: string
  /** Live mode: route the `opencode` provider through a body-recording proxy. */
  recordLive?: boolean
  /** Pass `--dir <workspace>` and run from a different cwd. */
  useDirFlag?: boolean
  injection?: 'file' | 'content' | 'both'
  /** Called after the fixture exists, before launch (plant skills, canaries, ...). */
  prepare?: (fixture: Fixture) => void
  /** Env override applied last (test-only). */
  extraEnv?: Record<string, string>
  /** Replace the allowlisted env entirely (control runs). */
  envOverride?: (fixture: Fixture, config: Record<string, unknown>) => Record<string, string>
  timeoutMs?: number
  /** Where to persist raw stdout/stderr/requests for inspection. */
  artifactDir?: string
  /** Reuse an existing fixture (caller destroys). */
  fixture?: Fixture
}

export interface RunOutcome extends SpawnResult {
  fixture: Fixture
  config: Record<string, unknown>
  env: Record<string, string>
  parsed: ParsedEvents
  requests: RecordedRequest[]
}

export function gitInit(dir: string): void {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`)
}

export function plantSkill(
  workspace: string,
  name: string,
  body: string,
  base = '.agents/skills',
): string {
  const dir = join(workspace, base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Spike skill ${name}.\n---\n\n${body}\n`,
  )
  return dir
}

export function buildConfig(
  spec: Pick<RunSpec, 'permission' | 'configExtra'>,
  providerUrl: string | undefined,
): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: spec.permission,
    ...(providerUrl ? { provider: scriptedProviderConfig(providerUrl) } : {}),
    ...spec.configExtra,
  }
}

/** Baseline permission set from the plan's KTDs (`bash` is OpenCode's key for the shell tool). */
export function basePermission(skill: Record<string, string>): Record<string, unknown> {
  return {
    edit: 'deny',
    external_directory: 'deny',
    bash: { '*': 'deny', 'node *scripts/record.mjs*': 'allow' },
    skill,
  }
}

export async function runOpencode(spec: RunSpec): Promise<RunOutcome> {
  const fixture = spec.fixture ?? createFixture()
  gitInit(fixture.workspace)
  spec.prepare?.(fixture)

  let server: ScriptedProviderServer | undefined
  if (spec.steps) {
    server = startScriptedProvider({ steps: spec.steps, finalText: spec.finalText })
  } else if (spec.recordLive) {
    server = startRecordingProxy()
  }
  try {
    const config = buildConfig(
      spec.recordLive
        ? {
            ...spec,
            configExtra: {
              provider: { opencode: { options: { baseURL: server?.url } } },
              ...spec.configExtra,
            },
          }
        : spec,
      spec.steps ? server?.url : undefined,
    )
    const env = spec.envOverride
      ? spec.envOverride(fixture, config)
      : buildChildEnv({
          fixture,
          config,
          injection: spec.injection,
          extra: spec.extraEnv,
        })
    const args = ['run', '--format', 'json', '--model', spec.model ?? SPIKE_MODEL]
    let cwd = fixture.workspace
    if (spec.useDirFlag) {
      args.push('--dir', fixture.workspace)
      cwd = fixture.tmp
    }
    args.push(spec.prompt)
    const result = await spawnCapture(opencodeArgv(...args), {
      cwd,
      env,
      timeoutMs: spec.timeoutMs ?? 120_000,
    })
    const outcome: RunOutcome = {
      ...result,
      fixture,
      config,
      env,
      parsed: parseEvents(result.stdout),
      requests: server?.requests ?? [],
    }
    if (spec.artifactDir) persistArtifacts(spec.artifactDir, outcome)
    return outcome
  } finally {
    server?.stop()
  }
}

function persistArtifacts(dir: string, outcome: RunOutcome): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdout.jsonl'), outcome.stdout)
  writeFileSync(join(dir, 'stderr.txt'), outcome.stderr)
  writeFileSync(join(dir, 'requests.json'), JSON.stringify(outcome.requests, null, 1))
}

// ── instruments ────────────────────────────────────────────────────────────

function requestBodies(requests: readonly RecordedRequest[]): Record<string, unknown>[] {
  return requests.map((r) => (isRecord(r.body) ? r.body : {}))
}

/** Concatenated system-prompt text actually sent to the model (all requests). */
export function systemPromptText(requests: readonly RecordedRequest[]): string {
  const parts: string[] = []
  for (const body of requestBodies(requests)) {
    const messages = Array.isArray(body.messages) ? body.messages : []
    for (const m of messages) {
      if (isRecord(m) && m.role === 'system') parts.push(JSON.stringify(m.content))
    }
  }
  return parts.join('\n')
}

/** Everything the model saw or produced: all request bodies, serialized. */
export function modelSeenText(requests: readonly RecordedRequest[]): string {
  return requestBodies(requests)
    .map((b) => JSON.stringify(b))
    .join('\n')
}

/**
 * `<available_skills>` names from the system prompt of the tool-capable
 * request. In 1.19.4 the list lives in the system prompt, not the skill-tool
 * description. Returns names in prompt order; `null` when the block is absent.
 */
export function availableSkillsFromRequests(
  requests: readonly RecordedRequest[],
): string[] | null {
  const main = requests.find((r) => r.hasTools)
  if (!main) return null
  const text = systemPromptText([main])
  if (!text.includes('<available_skills>')) return null
  const names = [...text.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '')
  return names
}

/** Names of tools offered to the model on the tool-capable request. */
export function offeredTools(requests: readonly RecordedRequest[]): string[] {
  const main = requests.find((r) => r.hasTools)
  const body = isRecord(main?.body) ? main.body : {}
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools
    .map((t) => (isRecord(t) && isRecord(t.function) ? String(t.function.name) : ''))
    .filter(Boolean)
}

export function skillToolDescription(requests: readonly RecordedRequest[]): string | undefined {
  const main = requests.find((r) => r.hasTools)
  const body = isRecord(main?.body) ? main.body : {}
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const t of tools) {
    if (isRecord(t) && isRecord(t.function) && t.function.name === 'skill') {
      return String(t.function.description)
    }
  }
  return undefined
}

export interface CommandOutcome extends SpawnResult {
  json: unknown
}

/** `opencode debug <sub>` under the same env/cwd as a run. Output parsed as JSON when possible. */
export async function debugCommand(
  sub: string[],
  fixture: Fixture,
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<CommandOutcome> {
  const result = await spawnCapture(opencodeArgv('debug', ...sub), {
    cwd: fixture.workspace,
    env,
    timeoutMs,
  })
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = undefined
  }
  return { ...result, json }
}

// ── serve-based tool listing ───────────────────────────────────────────────

export interface ServeProbe {
  health: unknown
  tools: unknown
  toolsStatus: number
}

/**
 * `opencode serve` + `GET /global/health` + `GET /experimental/tool`. Used to
 * compare the HTTP surface against the system-prompt instrument.
 */
export async function probeServe(
  fixture: Fixture,
  env: Record<string, string>,
  model: { provider: string; model: string },
  timeoutMs = 60_000,
): Promise<ServeProbe> {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(
    opencodeArgv('serve', '--port', String(port), '--hostname', '127.0.0.1')[0] as string,
    opencodeArgv('serve', '--port', String(port), '--hostname', '127.0.0.1').slice(1),
    { cwd: fixture.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + timeoutMs
    let health: unknown
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/global/health`)
        if (res.ok) {
          health = await res.json()
          break
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(500)
    }
    if (health === undefined) throw new Error('opencode serve did not become healthy')
    const url = `${base}/experimental/tool?provider=${encodeURIComponent(model.provider)}&model=${encodeURIComponent(model.model)}`
    const res = await fetch(url)
    return { health, tools: await res.json().catch(() => undefined), toolsStatus: res.status }
  } finally {
    killGroup(child, 'SIGTERM')
    setTimeout(() => killGroup(child, 'SIGKILL'), 3_000).unref()
  }
}
