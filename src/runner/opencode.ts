/**
 * Spawning the pinned OpenCode: `bunx opencode-ai@<pin> run --format json`.
 *
 * Process model (README, "Transport decision"): one process per run, stdin
 * closed (an open pipe makes `run` wait), own process group so a timeout or an
 * interrupt reaps `bunx` and its `opencode` grandchild together.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'

import { bunInstallCacheDir, OPENCODE_PIN } from './env'

export { OPENCODE_PIN } from './env'

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
    console.warn(`\n!!! OPENCODE TESTS WILL BE SKIPPED: ${cachedAvailability.reason} !!!\n`)
  }
  return cachedAvailability
}

// ── process spawning ───────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string
  stderr: string
  /** -1 on timeout, abort, or spawn error. */
  exitCode: number
  timedOut: boolean
  /** The caller's `signal` fired (interrupt); the group was killed. */
  aborted: boolean
  wallMs: number
  /** Epoch ms at spawn, to compare against event timestamps. */
  startedAtMs: number
}

/** Process groups of children that are still running, so a forced exit can kill them. */
const liveGroups = new Set<number>()

/** SIGKILL to every live child's process group. For the second-signal exit path only. */
export function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  liveGroups.clear()
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  /** Kills the process group and resolves with `aborted: true`. */
  signal?: AbortSignal
  /** Grace between SIGTERM and SIGKILL. Default 5 s. */
  killGraceMs?: number
  /**
   * Text written to the child's stdin, then closed. `opencode run` appends piped stdin to the
   * message verbatim, whereas a multi-word argv message reaches the model JSON-quoted. Absent: stdin is closed.
   */
  stdin?: string
}

/**
 * Async spawn (a sync spawn would block the thread serving the scripted
 * provider). `detached` gives the child its own process group.
 */
export function spawnCapture(argv: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  const [command, ...rest] = argv
  if (!command) throw new Error('spawnCapture requires a non-empty argv')
  const started = Date.now()
  const graceMs = options.killGraceMs ?? 5_000
  return new Promise((resolve) => {
    const child = spawn(command, rest, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (child.pid !== undefined) liveGroups.add(child.pid)
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {}) // EPIPE if the child exits before reading
      child.stdin?.end(options.stdin)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) liveGroups.delete(child.pid)
      clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      options.signal?.removeEventListener('abort', onAbort)
      // Reap any survivor in the group (e.g. a grandchild holding pipes).
      killGroup(child, 'SIGKILL')
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        aborted,
        wallMs: Date.now() - started,
        startedAtMs: started,
      })
    }
    const terminate = () => {
      killGroup(child, 'SIGTERM')
      forceKill = setTimeout(() => {
        killGroup(child, 'SIGKILL')
        finish(-1)
      }, graceMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    const onAbort = () => {
      aborted = true
      terminate()
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
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
    child.once('close', (code) => finish(timedOut || aborted ? -1 : (code ?? -1)))
  })
}

/** Resolves after `ms`, or as soon as `signal` fires (the caller checks the signal afterwards). */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function opencodeArgv(...args: string[]): string[] {
  return ['bunx', `opencode-ai@${OPENCODE_PIN}`, ...args]
}

/** `opencode run --format json --model <m> <prompt>`; cwd is the workspace. */
export function runArgv(model: string, prompt: string): string[] {
  return opencodeArgv('run', '--format', 'json', '--model', model, prompt)
}

/** `opencode debug config` under the same env/cwd as the run; parsed as JSON when possible. */
export async function debugConfig(
  options: SpawnOptions,
): Promise<{ result: SpawnResult; json: unknown }> {
  const result = await spawnCapture(opencodeArgv('debug', 'config'), options)
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = undefined
  }
  return { result, json }
}
