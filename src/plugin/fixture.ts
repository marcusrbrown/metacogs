/**
 * Test fixtures for running the pinned OpenCode host against a plugin: an isolated lab (workspace, HOME, XDG dirs, a
 * scripted provider) and the packed metacogs package, built, packed once and extracted. Not imported by production code.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildChildEnv, createFixture, destroyFixture, type Fixture } from '../runner/env'
import { type OpencodeEvent, parseEvents } from '../runner/events'
import { systemTexts } from '../runner/isolation'
import { opencodeArgv, spawnCapture, type SpawnResult } from '../runner/opencode'
import {
  type RecordedRequest,
  type ScriptedStep,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  scriptedProviderConfig,
  startScriptedProvider,
} from '../runner/scripted-provider'
import { buildConfig, gitInit } from '../runner/workspace'
import { packPlugin, REPO_ROOT, writePlugin } from './build'

export const HOST_MODEL = `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`

/** Every permission key in `core/src/v1/config/permission.ts` that gates a built-in tool, denied. */
export const DENY_ALL: Record<string, unknown> = Object.fromEntries(
  ['glob', 'grep', 'list', 'read', 'edit', 'bash', 'task', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill'].map((key) => [key, 'deny']),
)
export const BASE_PERMISSION: Record<string, unknown> = { edit: 'deny', bash: { '*': 'deny' } }

// ── request accessors ──────────────────────────────────────────────────────

export interface ChatBody {
  messages?: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]
  tools?: { function: { name: string; description?: string; parameters?: { properties?: Record<string, { description?: string }>; required?: string[] } } }[]
}

export const bodyOf = (request: RecordedRequest): ChatBody => (request.body ?? {}) as ChatBody
export const offeredNames = (request: RecordedRequest): string[] => (bodyOf(request).tools ?? []).map((t) => t.function.name)
export const systemOf = (request: RecordedRequest): string => systemTexts(request.body as Record<string, unknown>).join('\n')
export const userTexts = (request: RecordedRequest): string[] => (bodyOf(request).messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content))
export const skillNames = (request: RecordedRequest): string[] => [...systemOf(request).matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '')

/** The request the user's prompt went into: its system text starts with the host's own prompt. With no tools offered it is still this one. */
export function mainRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => systemOf(r).startsWith('You are opencode'))
}

export function mainRequest(requests: readonly RecordedRequest[]): RecordedRequest {
  const found = mainRequests(requests)[0]
  if (!found) throw new Error('no main request recorded')
  return found
}

// ── the lab ────────────────────────────────────────────────────────────────

/**
 * The host runs `npm install @opencode-ai/plugin` in its config dir on the first run that loads a plugin (about 20 s, over
 * the network). Every lab copies one installed dir and then keeps npm offline.
 */
export const OFFLINE_NPM = { npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }

const SEED_PLUGIN = `export default { id: 'metacogs-seed', server: async () => ({}) }\n`

let template: { lab: HostLab; ready: Promise<string> } | undefined
function installedConfigDir(): Promise<string> {
  template ??= (() => {
    const lab = new HostLab(false)
    const seed = `file://${lab.scratch('seed.mjs', SEED_PLUGIN)}`
    return { lab, ready: lab.run({ args: ['seed'], config: { plugin: [seed] } }).then(() => lab.fixture.opencodeConfigDir) }
  })()
  return template.ready
}

export interface HostRun {
  result: SpawnResult
  requests: RecordedRequest[]
  events: OpencodeEvent[]
}

export interface HostRunOptions {
  args: string[]
  config?: Record<string, unknown>
  permission?: Record<string, unknown>
  steps?: ScriptedStep[]
  limit?: { context: number; output: number }
  timeoutMs?: number
}

export class HostLab {
  readonly fixture: Fixture = createFixture('metacogs-lab-')
  private seeded = false

  /** `useTemplate: false` is for the lab that makes the template: it installs online instead of copying. */
  constructor(private readonly useTemplate = true) {
    gitInit(this.fixture.workspace)
  }

  destroy(): void {
    destroyFixture(this.fixture)
  }

  workspaceFile(rel: string, content: string): void {
    const full = join(this.fixture.workspace, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  /** A file under the fixture root but outside the workspace and `HOME`; returns its path. */
  scratch(rel: string, content: string): string {
    const full = join(this.fixture.root, 'scratch', rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    return full
  }

  homeFile(rel: string, content: string): void {
    const full = join(this.fixture.home, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  async run(options: HostRunOptions): Promise<HostRun> {
    if (this.useTemplate && !this.seeded) {
      cpSync(await installedConfigDir(), this.fixture.opencodeConfigDir, { recursive: true })
      this.seeded = true
    }
    const provider = startScriptedProvider({ steps: options.steps ?? [] })
    try {
      const providerConfig = scriptedProviderConfig(provider.url) as Record<string, { models: Record<string, Record<string, unknown>> }>
      if (options.limit) providerConfig[SPIKE_PROVIDER_ID]!.models[SPIKE_MODEL_ID]!.limit = options.limit
      const config = buildConfig({ permission: options.permission ?? BASE_PERMISSION, provider: providerConfig, ...(options.config ? { extra: options.config } : {}) })
      const env = buildChildEnv({ fixture: this.fixture, config, ...(this.useTemplate ? { extra: OFFLINE_NPM } : {}) })
      const argv = options.args[0] === 'debug' ? opencodeArgv(...options.args) : opencodeArgv('run', '--format', 'json', '--model', HOST_MODEL, ...options.args)
      const result = await spawnCapture(argv, { cwd: this.fixture.workspace, env, timeoutMs: options.timeoutMs ?? 180_000 })
      return { result, requests: provider.requests, events: parseEvents(result.stdout).events }
    } finally {
      provider.stop()
    }
  }

  async debugConfig(config: Record<string, unknown>, permission?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { result } = await this.run({ args: ['debug', 'config'], config, ...(permission ? { permission } : {}) })
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
}

// ── the packed package ─────────────────────────────────────────────────────

export interface PackedPlugin {
  /** The extracted package root, symlinks resolved. */
  root: string
  /** `file://` URL of the built entry. */
  spec: string
  skillsDir: string
}

let packedDir: string | undefined
let packed: Promise<PackedPlugin> | undefined

const specFor = (root: string) => `file://${root}/dist/index.js`

/** Links the runtime dependency the way an installed package would find it. */
function linkRuntimeDependency(root: string): void {
  mkdirSync(join(root, 'node_modules', '@opencode-ai'), { recursive: true })
  symlinkSync(realpathSync(join(REPO_ROOT, 'node_modules', '@opencode-ai', 'plugin')), join(root, 'node_modules', '@opencode-ai', 'plugin'))
}

/** Builds, packs and extracts the package once per process. */
export function packedPlugin(): Promise<PackedPlugin> {
  packed ??= (async () => {
    await writePlugin()
    packedDir = mkdtempSync(join(tmpdir(), 'metacogs-packed-'))
    const { tarball } = packPlugin({ dest: packedDir })
    const unpacked = join(packedDir, 'unpacked')
    mkdirSync(unpacked)
    const tar = Bun.spawnSync(['tar', '-xzf', tarball, '-C', unpacked])
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString().slice(0, 300)}`)
    const root = realpathSync(join(unpacked, 'package'))
    linkRuntimeDependency(root)
    return { root, spec: specFor(root), skillsDir: join(root, 'skills') }
  })()
  return packed
}

/** An identical second copy of the package at another path: a distinct plugin spec for a double-load test. */
export function copyPackedPlugin(source: PackedPlugin, name: string): string {
  if (packedDir === undefined) throw new Error('packedPlugin() has not run')
  const dest = join(packedDir, name)
  cpSync(source.root, dest, { recursive: true, verbatimSymlinks: true })
  return specFor(realpathSync(dest))
}

/** Removes the template lab and the extracted package. Call from `afterAll`. */
export function disposeFixtures(): void {
  template?.lab.destroy()
  template = undefined
  if (packedDir !== undefined) rmSync(packedDir, { recursive: true, force: true })
  packedDir = undefined
  packed = undefined
}
