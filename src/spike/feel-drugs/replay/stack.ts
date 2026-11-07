/** The daily plugin stack inside a throwaway fixture: the owner's plugin configs with the safety switches applied on top. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Fixture } from '../../../runner/env'
import { PLACEHOLDER_API_KEY } from '../../../runner/scripted-provider'
import { buildConfig } from '../../../runner/workspace'

/** Registry plugins of the stack. The packed local metacogs plugin is added after these. */
export const STACK_NPM_PLUGINS = ['oh-my-opencode-slim@3.0.7', '@cortexkit/opencode-magic-context@0.49.40', '@cortexkit/aft-opencode@0.63.5', '@fro.bot/systematic@3.31.5'] as const
/** Slim's default agent, the one that sees all four metacogs skills. */
export const REPLAY_AGENT = 'orchestrator'
/** Slim hooks switched off: `council-inject` adds a Council Mode block to the first `/drugs` text; the other checks for updates. */
export const DISABLED_HOOKS = ['council-inject', 'auto-update-checker'] as const

/** Where the owner's configs are read from (read-only). `null` skips a directory, leaving only the safety switches. */
export interface OwnerConfig {
  opencodeDir: string | null
  cortexkitDir: string | null
}

export const defaultOwnerConfig = (home = homedir()): OwnerConfig => ({ opencodeDir: join(home, '.config', 'opencode'), cortexkitDir: join(home, '.config', 'cortexkit') })

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function readJsonc(dir: string | null, name: string): Json {
  if (dir === null) return {}
  const path = join(dir, name)
  if (!existsSync(path)) return {}
  const parsed: unknown = Bun.JSONC.parse(readFileSync(path, 'utf8'))
  return isRecord(parsed) ? parsed : {}
}

const section = (owner: Json, key: string): Json => (isRecord(owner[key]) ? (owner[key] as Json) : {})
const union = (a: unknown, b: readonly string[]): string[] => [...new Set([...(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []), ...b])]

// ── the safety switches, pure over the owner's parsed config ───────────────

export const slimConfig = (owner: Json): Json => ({ ...owner, autoUpdate: false, disabled_mcps: union(owner.disabled_mcps, ['context7', 'gh_grep']), disabled_hooks: union(owner.disabled_hooks, DISABLED_HOOKS) })
export const systematicConfig = (owner: Json): Json => ({ ...owner, search: { ...section(owner, 'search'), allow_project_sources: [] } })
export const aftConfig = (owner: Json): Json => ({ ...owner, auto_update: false, indexes: { ...section(owner, 'indexes'), semantic: false } })
export const magicContextConfig = (owner: Json): Json => ({
  ...owner,
  auto_update: false,
  embedding: { ...section(owner, 'embedding'), provider: 'off' },
  historian: { ...section(owner, 'historian'), disable: true },
  dreamer: { ...section(owner, 'dreamer'), disable: true },
})

/** Writes the four plugin configs into the fixture's XDG config home, and copies slim's prompt appendices. */
export function writeStackConfigs(fx: Pick<Fixture, 'xdgConfigHome'>, owner: OwnerConfig): void {
  const oc = join(fx.xdgConfigHome, 'opencode')
  mkdirSync(join(oc, 'oh-my-opencode-slim'), { recursive: true })
  writeFileSync(join(oc, 'oh-my-opencode-slim.jsonc'), JSON.stringify(slimConfig(readJsonc(owner.opencodeDir, 'oh-my-opencode-slim.jsonc'))))
  writeFileSync(join(oc, 'systematic.jsonc'), JSON.stringify(systematicConfig(readJsonc(owner.opencodeDir, 'systematic.jsonc'))))
  if (owner.opencodeDir !== null) {
    for (const f of ['orchestrator_append.md', 'designer_append.md']) {
      const source = join(owner.opencodeDir, 'oh-my-opencode-slim', f)
      if (existsSync(source)) copyFileSync(source, join(oc, 'oh-my-opencode-slim', f))
    }
  }
  const ck = join(fx.xdgConfigHome, 'cortexkit')
  mkdirSync(ck, { recursive: true })
  writeFileSync(join(ck, 'aft.jsonc'), JSON.stringify(aftConfig(readJsonc(owner.cortexkitDir, 'aft.jsonc'))))
  writeFileSync(join(ck, 'magic-context.jsonc'), JSON.stringify(magicContextConfig(readJsonc(owner.cortexkitDir, 'magic-context.jsonc'))))
}

// ── host config ────────────────────────────────────────────────────────────

/**
 * Write-capable actions are denied in the permission config itself. Every shell command is denied, with pushes and
 * `gh` named so the denial reads as intended. Edits can reach only the fixture workspace, because anything outside it
 * is `external_directory`, also denied. Web fetches and searches are denied.
 */
export function replayPermission(): Json {
  return {
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    edit: 'allow',
    bash: { '*': 'deny', 'git push*': 'deny', 'git *push*': 'deny', 'gh *': 'deny', gh: 'deny' },
  }
}

const stubModel = (id: string) => ({ id, name: id, attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: '2026-10-22', limit: { context: 200_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {} })
const STUB_MODELS = { anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], openai: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra'] } as const

/** The two provider ids the replays use, both pointed at the chat-completions stub. Slim's subagents and title model are in the list. */
export function stubProviders(baseURL: string): Json {
  return Object.fromEntries(Object.entries(STUB_MODELS).map(([id, models]) => [id, { name: id, npm: '@ai-sdk/openai-compatible', env: [], models: Object.fromEntries(models.map((m) => [m, stubModel(m)])), options: { apiKey: PLACEHOLDER_API_KEY, baseURL } }]))
}

/** The generated `OPENCODE_CONFIG` of one attempt. */
export function stackHostConfig(input: { provider: Json; pluginSpecs: readonly string[] }): Json {
  return buildConfig({
    permission: replayPermission(),
    provider: input.provider,
    extra: {
      plugin: [...input.pluginSpecs],
      agent: { general: { disable: true }, explore: { disable: true } },
      compaction: { auto: false, prune: false },
      experimental: { openTelemetry: false },
      lsp: true,
      snapshot: false,
    },
  })
}
