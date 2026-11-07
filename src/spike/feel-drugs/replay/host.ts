/** The host side of an attempt: the daily harness, a cloned base fixture, import, run, export. Real processes, throwaway fixtures. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { OFFLINE_NPM, type PackedPlugin } from '../../../plugin/fixture'
import { writeIsolatedAuth } from '../../../runner/auth'
import { CLIPROXY_UPSTREAM, cliproxyProviderConfig, type ResolvedCliproxy } from '../../../runner/cliproxy'
import { buildChildEnv, createFixture, destroyFixture } from '../../../runner/env'
import { checkDailyStack, type DailyStackVerdict } from '../../../runner/isolation'
import { spawnCapture } from '../../../runner/opencode'
import { type RecordedRequest, type ScriptedStep, type ScriptRequest, startRecordingProxy, startScriptedProvider } from '../../../runner/scripted-provider'
import { gitInit, sha256 } from '../../../runner/workspace'
import { type ArmMessage, type ArmName, type AssistantInfo, runArgs } from './gates'
import { defaultOwnerConfig, type OwnerConfig, REPLAY_AGENT, STACK_NPM_PLUGINS, stackHostConfig, stubProviders, writeStackConfigs } from './stack'
import type { SessionExport } from './store'

// ── the harness binary ─────────────────────────────────────────────────────

/** `METACOGS_HARNESS_BIN`, else the newest `npm-fro-bot-harness` install under mise. Never the upstream package. */
export function resolveHarness(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.METACOGS_HARNESS_BIN) return env.METACOGS_HARNESS_BIN
  const root = join(home, '.local', 'share', 'mise', 'installs', 'npm-fro-bot-harness')
  const versions = existsSync(root) ? readdirSync(root).filter((d) => /^\d+\.\d+\.\d+-harness\./.test(d)) : []
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const newest = versions.at(-1)
  if (!newest) throw new Error(`no npm-fro-bot-harness install under ${root}; set METACOGS_HARNESS_BIN`)
  return join(root, newest, 'bin', 'opencode')
}

const versions = new Map<string, string>()

/** What `<harness> --version` prints, once per binary. */
export function hostVersion(harness: string): string {
  const known = versions.get(harness)
  if (known) return known
  const r = spawnSync(harness, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
  if (r.status !== 0) throw new Error(`${harness} --version failed (exit ${r.status ?? 'null'})`)
  const version = r.stdout.trim()
  versions.set(harness, version)
  return version
}

// ── the base fixture ───────────────────────────────────────────────────────

/** Where the installed plugin cache lives: keyed by the host version and the registry plugins, so a change starts a new base. */
export function defaultBaseDir(storeRoot: string, harness: string): string {
  return join(storeRoot, 'base', sha256(JSON.stringify({ version: hostVersion(harness), plugins: STACK_NPM_PLUGINS })).slice(0, 12))
}

const clone = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true })
  const r = spawnSync('cp', ['-cR', `${from}/.`, to])
  if (r.status !== 0) cpSync(from, to, { recursive: true })
}

/** Installs the registry plugins once (online) and keeps the cache and config dir as the base every attempt clones. */
export async function prepareBase(input: { harness: string; baseDir: string; owner?: OwnerConfig; log?: (line: string) => void }): Promise<string> {
  const { baseDir } = input
  if (existsSync(join(baseDir, 'READY'))) return baseDir
  input.log?.(`preparing the base fixture at ${baseDir} (installs the registry plugins; needs the network once)`)
  const fx = createFixture('metacogs-replay-base-')
  try {
    gitInit(fx.workspace)
    writeStackConfigs(fx, input.owner ?? defaultOwnerConfig())
    const config = stackHostConfig({ provider: stubProviders('http://127.0.0.1:9/v1'), pluginSpecs: STACK_NPM_PLUGINS })
    const env = buildChildEnv({ fixture: fx, config })
    mkdirSync(join(fx.root, 'logs'), { recursive: true })
    const r = await spawnCapture([input.harness, 'debug', 'config'], { cwd: fx.workspace, env, timeoutMs: 900_000, stdoutPath: join(fx.root, 'logs', 'base.out'), stderrPath: join(fx.root, 'logs', 'base.err') })
    if (r.exitCode !== 0) throw new Error(`preparing the base fixture failed (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''})`)
    mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    clone(fx.xdgCacheHome, join(baseDir, 'cache'))
    clone(fx.opencodeConfigDir, join(baseDir, 'opencode-config-dir'))
    writeFileSync(join(baseDir, 'READY'), `${hostVersion(input.harness)}\n`)
    return baseDir
  } finally {
    destroyFixture(fx)
  }
}

// ── an attempt ─────────────────────────────────────────────────────────────

export interface AttemptJob {
  fixtureId: string
  seed: SessionExport
  model: string
  arm: ArmName
  message: ArmMessage
  timeoutMs: number
  signal?: AbortSignal
}

/** What one host attempt left behind. `cleanup` removes the throwaway fixture and stops the provider; the caller runs it after reading `leakDirs`. */
export interface HostResult {
  hostVersion: string
  requests: RecordedRequest[]
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  aborted: boolean
  /** `false` when the stack check failed and the arm was never sent. */
  ran: boolean
  startedAt: string
  endedAt: string
  wallMs: number
  stack: DailyStackVerdict | null
  /** Plugin specs, default agent and mcp count as the host reported them. */
  stackSummary: { plugins: string[]; default_agent: string | null; mcp_entries: number } | null
  assistants: AssistantInfo[] | null
  partTypes: string[] | null
  leakDirs: string[]
  cleanup(): void
}

export type Executor = (job: AttemptJob) => Promise<HostResult>

export interface HostExecutorOptions {
  harness: string
  baseDir: string
  packed: Pick<PackedPlugin, 'spec' | 'pluginSkillsDir'>
  provider: 'scripted' | 'cliproxy'
  /** Required for `cliproxy`: the key goes only into the attempt fixture's throwaway auth file. */
  cliproxy?: ResolvedCliproxy
  owner?: OwnerConfig
  /** Scripted provider only: the model's reply to a request. `undefined` answers with plain text. */
  script?: (arm: ArmName, request: ScriptRequest) => ScriptedStep | undefined
  /** Scripted provider only: the model id each request reports back. Default: the one it asked for. */
  returnedModel?: (body: Record<string, unknown>) => string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Moves every `time` object in the export by one offset, so the history ends `agoMs` before `now`. Frozen fixtures carry
 * fixed past times, and magic-context marks a gap like `+44w` on the next user message, which the model would read.
 */
export function shiftTimes(doc: unknown, now: number, agoMs = 120_000): void {
  const times: Record<string, unknown>[] = []
  const walk = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x))
    else if (isRecord(v)) {
      if (key === 'time') times.push(v)
      for (const [k, x] of Object.entries(v)) walk(x, k)
    }
  }
  walk(doc)
  const numbers = times.flatMap((t) => Object.values(t).filter((x): x is number => typeof x === 'number'))
  if (numbers.length === 0) return
  const delta = now - agoMs - Math.max(...numbers)
  for (const t of times) for (const [k, x] of Object.entries(t)) if (typeof x === 'number') t[k] = x + delta
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A host step that is not the attempt's own result failed: import or export could not run. Retryable, never an outcome. */
export class HostStepError extends Error {
  constructor(readonly step: string) {
    super(`host step ${step} failed`)
    this.name = 'HostStepError'
  }
}

export function createHostExecutor(options: HostExecutorOptions): Executor {
  const { harness } = options
  const version = hostVersion(harness)
  const owner = options.owner ?? defaultOwnerConfig()

  return async (job) => {
    const startedAt = new Date()
    const fx = createFixture('metacogs-replay-')
    const server = options.provider === 'scripted'
      ? startScriptedProvider({
          steps: [],
          script: (r) => options.script?.(job.arm, r),
          returnedModel: options.returnedModel ?? ((body) => (typeof body.model === 'string' ? body.model : 'unknown')),
        })
      : startRecordingProxy(CLIPROXY_UPSTREAM)
    let released = false
    const cleanup = () => {
      if (released) return
      released = true
      server.stop()
      destroyFixture(fx)
    }
    try {
      gitInit(fx.workspace)
      writeStackConfigs(fx, owner)
      clone(join(options.baseDir, 'cache'), fx.xdgCacheHome)
      clone(join(options.baseDir, 'opencode-config-dir'), fx.opencodeConfigDir)
      const provider = options.provider === 'scripted' ? stubProviders(server.url) : cliproxyProviderConfig(server.url)
      const config = stackHostConfig({ provider, pluginSpecs: [...STACK_NPM_PLUGINS, options.packed.spec] })
      const env = buildChildEnv({ fixture: fx, config, extra: OFFLINE_NPM })
      if (options.provider === 'cliproxy') {
        if (!options.cliproxy) throw new Error('the cliproxy provider needs a resolved key')
        writeIsolatedAuth(fx, options.cliproxy.auth)
      }
      mkdirSync(join(fx.root, 'logs'), { recursive: true })
      const host = (tag: string, argv: string[], timeoutMs: number) =>
        spawnCapture([harness, ...argv], { cwd: fx.workspace, env, timeoutMs, ...(job.signal ? { signal: job.signal } : {}), stdoutPath: join(fx.root, 'logs', `${tag}.out`), stderrPath: join(fx.root, 'logs', `${tag}.err`) })

      const dbg = await host('debug', ['debug', 'config'], 180_000)
      const effective = dbg.exitCode === 0 ? parseJson(dbg.stdout) : undefined
      const stack = checkDailyStack({
        effective,
        generated: config,
        plugins: [...STACK_NPM_PLUGINS, options.packed.spec],
        configPath: fx.configPath,
        defaultAgent: REPLAY_AGENT,
        skillsPaths: [options.packed.pluginSkillsDir],
        keepKeys: ['permission', 'share', 'compaction'],
      })
      const eff = isRecord(effective) ? effective : undefined
      const stackSummary = eff
        ? { plugins: Array.isArray(eff.plugin_origins) ? eff.plugin_origins.filter(isRecord).map((o) => String(o.spec)) : [], default_agent: typeof eff.default_agent === 'string' ? eff.default_agent : null, mcp_entries: isRecord(eff.mcp) ? Object.keys(eff.mcp).length : -1 }
        : null
      const base = { hostVersion: version, leakDirs: [fx.workspace], cleanup, stack, stackSummary }
      const finish = (extra: Partial<HostResult>): HostResult => {
        const ended = new Date()
        return { ...base, requests: server.requests, stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: false, ran: false, startedAt: startedAt.toISOString(), endedAt: ended.toISOString(), wallMs: ended.getTime() - startedAt.getTime(), assistants: null, partTypes: null, ...extra }
      }
      if (!stack.passed) return finish({ stderr: dbg.stderr })

      const seed = structuredClone(job.seed)
      seed.info.directory = realpathSync(fx.workspace)
      shiftTimes(seed, Date.now())
      const seedFile = join(fx.root, 'seed-export.json')
      writeFileSync(seedFile, JSON.stringify(seed))
      const imported = await host('import', ['import', seedFile], 180_000)
      if (imported.exitCode !== 0 || !imported.stdout.includes(seed.info.id)) throw new HostStepError('import')

      const run = await host('run', runArgs(job.model, seed.info.id, job.message), job.timeoutMs)
      if (options.provider === 'cliproxy') await Bun.sleep(100) // let the proxy's response scan settle

      let assistants: AssistantInfo[] | null = null
      let partTypes: string[] | null = null
      if (!run.timedOut && !run.aborted) {
        const exported = await host('export', ['export', seed.info.id], 180_000)
        const doc = exported.exitCode === 0 ? parseJson(exported.stdout.slice(Math.max(0, exported.stdout.indexOf('{')))) : undefined
        const messages = isRecord(doc) && Array.isArray(doc.messages) ? doc.messages.filter(isRecord) : []
        if (messages.length > 0) {
          const infos = messages.slice(seed.messages.length).map((m) => (isRecord(m.info) ? m.info : {}))
          assistants = infos.filter((i) => i.role === 'assistant').map((i) => ({ ...(typeof i.agent === 'string' ? { agent: i.agent } : {}), ...(typeof i.providerID === 'string' ? { providerID: i.providerID } : {}), ...(typeof i.modelID === 'string' ? { modelID: i.modelID } : {}) }))
          partTypes = messages.flatMap((m) => (Array.isArray(m.parts) ? m.parts.filter(isRecord).map((p) => String(p.type)) : []))
        }
      }
      return finish({ stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timedOut: run.timedOut, aborted: run.aborted, ran: true, assistants, partTypes })
    } catch (e) {
      cleanup()
      throw e
    }
  }
}
