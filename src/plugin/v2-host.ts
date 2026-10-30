/**
 * Test support for running the packed plugin on the pinned OpenCode v2 CLI against the scripted provider ($0). Not
 * imported by production code.
 *
 * The CLI is installed into an npm prefix, not through bunx: v2 ships as `@opencode/cli`. Every child runs with an
 * explicit environment (nothing inherited but PATH) in its own process group. The group is killed on every exit path,
 * and `survivingGroups()` lets a suite assert that nothing outlived it. A `serve` child prints a Basic-auth password;
 * it is parsed from the raw stream and never echoed: `output()` redacts it.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFixture, destroyFixture, type Fixture } from '../runner/env'
import { systemTexts } from '../runner/isolation'
import {
  PLACEHOLDER_API_KEY,
  type RecordedRequest,
  type ScriptedProviderServer,
  type ScriptedProviderOptions,
  scriptedProviderConfigV2,
  startScriptedProvider,
  V2_PROVIDER_KEY_ENV,
} from '../runner/scripted-provider'
import { gitInit } from '../runner/workspace'
import { REPO_ROOT } from './build'
import { GUIDANCE_OPEN } from './guidance'

/** The v2 tests run only when the owner or CI asks for them: `check` and `prepublishOnly` have no v2 CLI. */
export const hostV2Enabled = process.env.METACOGS_HOST_V2 === '1'

/** The single source of the tested v2 version. */
export const V2_PIN = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { testedWith: Record<string, string> }).testedWith['opencode-v2'] as string

const PARENT_PATH = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'

// ── the CLI ────────────────────────────────────────────────────────────────

const cliDir = join(tmpdir(), `metacogs-opencode-v2-${process.getuid?.() ?? 'u'}-${V2_PIN}`)
const cliBin = join(cliDir, 'node_modules', '.bin', 'opencode')

const versionOf = (bin: string): string | undefined => {
  if (!existsSync(bin)) return undefined
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { PATH: PARENT_PATH, HOME: cliDir, TMPDIR: tmpdir() } })
  return run.status === 0 ? run.stdout.trim() : undefined
}

let installed: string | undefined

/**
 * The pinned CLI binary. `METACOGS_OPENCODE_V2_BIN` points at one already installed (CI installs it as its own step, so a
 * broken install fails before any test); it must report the pin or this throws. Otherwise the CLI is installed once per
 * machine into a shared npm prefix, and a cold runner pays for that install on the first call.
 */
export function installedCli(): string {
  if (installed !== undefined) return installed
  const expected = `opencode v${V2_PIN}`
  const override = process.env.METACOGS_OPENCODE_V2_BIN
  if (override) {
    const reported = versionOf(override)
    if (reported !== expected) throw new Error(`METACOGS_OPENCODE_V2_BIN: expected "${expected}", the CLI reported "${reported ?? '(nothing)'}"`)
    installed = override
    return override
  }
  if (versionOf(cliBin) !== expected) {
    rmSync(cliDir, { recursive: true, force: true })
    mkdirSync(cliDir, { recursive: true })
    const npmMajor = Number.parseInt(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim().split('.')[0] ?? '0', 10)
    // npm 12 skips install scripts unless told otherwise, and the CLI's launcher needs its postinstall.
    const args = ['install', '--prefix', cliDir, `@opencode/cli@${V2_PIN}`, '--no-audit', '--no-fund', ...(npmMajor >= 12 ? ['--dangerously-allow-all-scripts'] : [])]
    const install = spawnSync('npm', args, { encoding: 'utf8', timeout: 300_000 })
    if (install.status !== 0) throw new Error(`npm install @opencode/cli@${V2_PIN} failed (status ${install.status}): ${install.stderr.slice(0, 400)}`)
    const reported = versionOf(cliBin)
    if (reported !== expected) throw new Error(`expected "${expected}", the installed CLI reported "${reported ?? '(nothing)'}"`)
  }
  installed = cliBin
  return cliBin
}

// ── processes ──────────────────────────────────────────────────────────────

const spawnedGroups = new Set<number>()

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** SIGTERM the group, then SIGKILL after a grace period, and wait until no member is left. */
async function reapGroup(pgid: number): Promise<void> {
  for (const [signal, waitMs] of [['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
    if (!groupAlive(pgid)) return
    try {
      process.kill(-pgid, signal)
    } catch {
      return
    }
    for (let waited = 0; waited < waitMs && groupAlive(pgid); waited += 50) await sleep(50)
  }
}

/** The process groups this module started that still have a member. Empty once every child is reaped. */
export const survivingGroups = (): number[] => [...spawnedGroups].filter(groupAlive)

/** Kills every group this module started. For a suite's `afterAll`. */
export async function reapAll(): Promise<void> {
  await Promise.all([...spawnedGroups].map(reapGroup))
}

const REDACT = /(server password )\S+/g
const redact = (text: string): string => text.replace(REDACT, '$1<redacted>')

interface Child {
  pid: number
  child: ChildProcess
  /** Resolves with the exit code (-1 if killed by signal) once the child has exited. */
  exited: Promise<number>
  /** stdout and stderr so far, password redacted. */
  output(): string
  /** The raw stream, for parsing only. Never log it. */
  raw(): string
  stop(): Promise<void>
}

function spawnChild(argv: readonly string[], cwd: string, env: Record<string, string>): Child {
  const [command, ...args] = argv
  if (!command) throw new Error('spawnChild needs a command')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const pid = child.pid
  if (pid === undefined) throw new Error('the child has no pid')
  spawnedGroups.add(pid)
  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => void (buffer += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => void (buffer += chunk.toString()))
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(-1))
    child.once('exit', (code) => resolve(code ?? -1))
  })
  return { pid, child, exited, output: () => redact(buffer), raw: () => buffer, stop: () => reapGroup(pid) }
}

// ── the lab ────────────────────────────────────────────────────────────────

export interface V2LabOptions {
  /** Extra top-level `opencode.json` keys: `plugins`, `permissions`, `command`, `compaction`, ... */
  config?: Record<string, unknown>
  script?: ScriptedProviderOptions['script']
  steps?: ScriptedProviderOptions['steps']
  turns?: ScriptedProviderOptions['turns']
  finalText?: string
  limit?: { context: number; output: number }
  timeoutMs?: number
}

export interface V2Run {
  exitCode: number
  stdout: string
  /** Redacted. */
  output: string
  requests: RecordedRequest[]
}

/** A running `serve`: authenticated JSON calls plus the scripted provider's recorded requests. */
export interface V2Server {
  url: string
  requests: RecordedRequest[]
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>
  /** Redacted. */
  output(): string
  pid: number
  stop(): Promise<void>
}

export class V2Lab {
  readonly fixture: Fixture = createFixture('metacogs-v2-lab-')

  constructor() {
    gitInit(this.fixture.workspace)
  }

  destroy(): void {
    destroyFixture(this.fixture)
  }

  workspaceFile(rel: string, content: string): void {
    const full = join(this.fixture.workspace, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }

  /** Nothing but PATH is inherited. The key variable carries the placeholder, set here at run time. */
  private env(): Record<string, string> {
    const f = this.fixture
    return {
      PATH: PARENT_PATH,
      HOME: f.home,
      XDG_CONFIG_HOME: f.xdgConfigHome,
      XDG_DATA_HOME: f.xdgDataHome,
      XDG_STATE_HOME: f.xdgStateHome,
      XDG_CACHE_HOME: f.xdgCacheHome,
      OPENCODE_CONFIG_DIR: f.opencodeConfigDir,
      TMPDIR: f.tmp,
      TMP: f.tmp,
      TEMP: f.tmp,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      TERM: 'dumb',
      NO_COLOR: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PRUNE: '1',
      [V2_PROVIDER_KEY_ENV]: PLACEHOLDER_API_KEY,
    }
  }

  private writeConfig(provider: ScriptedProviderServer, options: V2LabOptions): void {
    const config = { ...scriptedProviderConfigV2(provider.url, options.limit ? { limit: options.limit } : {}), ...options.config }
    writeFileSync(join(this.fixture.workspace, 'opencode.json'), JSON.stringify(config))
  }

  private startProvider(options: V2LabOptions): ScriptedProviderServer {
    return startScriptedProvider({
      steps: options.steps ?? [],
      ...(options.turns ? { turns: options.turns } : {}),
      ...(options.script ? { script: options.script } : {}),
      ...(options.finalText ? { finalText: options.finalText } : {}),
    })
  }

  /** `opencode run --standalone <prompt>` against a private server; the child and its group are gone when this returns. */
  async run(prompt: string, options: V2LabOptions = {}): Promise<V2Run> {
    const provider = this.startProvider(options)
    let proc: Child | undefined
    try {
      this.writeConfig(provider, options)
      proc = spawnChild([installedCli(), 'run', '--standalone', prompt], this.fixture.workspace, this.env())
      const timeout = sleep(options.timeoutMs ?? 120_000).then(() => 'timeout' as const)
      const outcome = await Promise.race([proc.exited, timeout])
      if (outcome === 'timeout') throw new Error(`opencode run timed out: ${proc.output().slice(-600)}`)
      return { exitCode: outcome, stdout: proc.raw(), output: proc.output(), requests: provider.requests }
    } finally {
      await proc?.stop()
      provider.stop()
    }
  }

  /** `opencode serve` on an OS-assigned port. The plugin loads lazily, so callers poll `GET /api/command`. */
  async serve(options: V2LabOptions = {}): Promise<V2Server> {
    const provider = this.startProvider(options)
    this.writeConfig(provider, options)
    const proc = spawnChild([installedCli(), 'serve', '--hostname', '127.0.0.1', '--port', '0'], this.fixture.workspace, this.env())
    try {
      const deadline = Date.now() + 60_000
      let url: string | undefined
      let password: string | undefined
      while (Date.now() < deadline && (url === undefined || password === undefined)) {
        const raw = proc.raw()
        url ??= /server listening on (http:\/\/[\d.:]+)/.exec(raw)?.[1]
        // A password cut off mid-token would count as the whole of it, so it counts only once its line has ended.
        password ??= /server password (\S+)\r?\n/.exec(raw)?.[1]
        if (await Promise.race([proc.exited.then(() => true), sleep(50).then(() => false)])) throw new Error(`opencode serve exited early: ${proc.output().slice(-400)}`)
      }
      if (url === undefined || password === undefined) throw new Error(`opencode serve did not announce itself: ${proc.output().slice(-400)}`)
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      const base = url
      let stopped = false
      return {
        url: base,
        requests: provider.requests,
        pid: proc.pid,
        output: () => proc.output(),
        async call(method, path, body) {
          const response = await fetch(`${base}${path}`, {
            method,
            headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          const text = await response.text()
          let parsed: unknown = text
          try {
            parsed = text === '' ? undefined : JSON.parse(text)
          } catch {
            // a non-JSON body is returned as text
          }
          return { status: response.status, body: parsed }
        },
        async stop() {
          if (stopped) return
          stopped = true
          await proc.stop()
          provider.stop()
        },
      }
    } catch (error) {
      await proc.stop()
      provider.stop()
      throw error
    }
  }
}

// ── request accessors ──────────────────────────────────────────────────────

interface Message {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}
interface Body {
  messages?: Message[]
  tools?: { function: { name: string; description?: string; parameters?: { properties?: Record<string, { description?: string }>; required?: string[] } } }[]
}

export const bodyOf = (request: RecordedRequest): Body => (request.body ?? {}) as Body
export const offeredNames = (request: RecordedRequest): string[] => (bodyOf(request).tools ?? []).map((t) => t.function.name)
export const systemOf = (request: RecordedRequest): string => systemTexts(request.body as Record<string, unknown>).join('\n')

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('') : ''

export const userTexts = (request: RecordedRequest): string[] => (bodyOf(request).messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content))

/** The text of every tool result in the request's history, in order. */
export const toolResults = (request: RecordedRequest): string[] => (bodyOf(request).messages ?? []).filter((m) => m.role === 'tool').map((m) => textOf(m.content))

/** How many times the guidance block opens anywhere in the request. */
export const guidanceCount = (request: RecordedRequest): number => JSON.stringify(request.body ?? {}).split(GUIDANCE_OPEN).length - 1

export type RequestKind = 'title' | 'compaction' | 'agent'

/** The last user message of a compaction request, and of the retry the host sends when the summary misses its template. */
const COMPACTION_INSTRUCTIONS = ['You MUST summarize the conversation above', 'The previous response did not fill in the required summary template']

/**
 * What a request is for. A title request says so in its system text. A compaction request ends on the summarize
 * instruction; its system text is the agent prompt, so the prompt cannot tell the two apart. Its tool list depends on
 * the history: empty for a plain chat, the full set once the chat holds tool calls. Anything else that offers tools is
 * an agent-loop request (a subagent's included).
 */
export function kindOf(request: RecordedRequest): RequestKind | 'other' {
  if (systemTexts((request.body ?? {}) as Record<string, unknown>).some((text) => text.includes('You name conversations'))) return 'title'
  const messages = bodyOf(request).messages ?? []
  const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user')?.content)
  if (COMPACTION_INSTRUCTIONS.some((instruction) => lastUser.startsWith(instruction))) return 'compaction'
  return offeredNames(request).length > 0 ? 'agent' : 'other'
}

export const ofKind = (requests: readonly RecordedRequest[], kind: RequestKind): RecordedRequest[] => requests.filter((r) => kindOf(r) === kind)

/** Polls until `ready` returns a value, or fails after `timeoutMs`. */
export async function until<T>(what: string, ready: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await ready()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}
