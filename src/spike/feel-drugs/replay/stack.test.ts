import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aftConfig, magicContextConfig, replayPermission, slimConfig, stackHostConfig, STACK_NPM_PLUGINS, stubProviders, systematicConfig, writeStackConfigs } from './stack'

/** The parts of the generated host config these tests read. */
type GeneratedConfig = { plugin: unknown[]; share: string; compaction: { auto: boolean; prune: boolean }; provider: Record<string, unknown> }

const cleanup: string[] = []
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'stack-'))
  cleanup.push(d)
  return d
}

describe('the safety switches', () => {
  test('slim: auto-update off, its remote MCPs and council-inject disabled, the owner settings kept', () => {
    const out = slimConfig({ preset: 'mixed', disabled_mcps: ['x'], disabled_hooks: ['phase-reminder'] })
    expect(out).toMatchObject({ preset: 'mixed', autoUpdate: false })
    expect(out.disabled_mcps).toEqual(['x', 'context7', 'gh_grep'])
    expect(out.disabled_hooks).toEqual(['phase-reminder', 'council-inject', 'auto-update-checker'])
    expect(slimConfig({}).disabled_hooks).toContain('council-inject')
  })

  test('magic-context: historian, dreamer and embeddings off; nested owner settings survive', () => {
    expect(magicContextConfig({ historian: { model: 'm' }, embedding: { provider: 'openai', model: 'e' }, cache_ttl: '5m' })).toEqual({
      auto_update: false,
      cache_ttl: '5m',
      embedding: { provider: 'off', model: 'e' },
      historian: { model: 'm', disable: true },
      dreamer: { disable: true },
    })
  })

  test('aft and systematic', () => {
    expect(aftConfig({ indexes: { semantic: true, trigram: true }, x: 1 })).toEqual({ x: 1, auto_update: false, indexes: { semantic: false, trigram: true } })
    expect(systematicConfig({ search: { enabled: true, allow_project_sources: ['a'] }, y: 2 })).toEqual({ y: 2, search: { enabled: true, allow_project_sources: [] } })
  })
})

describe('writeStackConfigs', () => {
  test('reads the owner configs (JSONC) and writes the switched files; a missing directory leaves only the switches', () => {
    const owner = tmp()
    mkdirSync(join(owner, 'oc', 'oh-my-opencode-slim'), { recursive: true })
    mkdirSync(join(owner, 'ck'))
    writeFileSync(join(owner, 'oc', 'oh-my-opencode-slim.jsonc'), '{ // comment\n "preset": "mixed", }')
    writeFileSync(join(owner, 'oc', 'oh-my-opencode-slim', 'orchestrator_append.md'), 'append')
    writeFileSync(join(owner, 'ck', 'aft.jsonc'), '{"indexes": {"trigram": true}}')
    const fx = { xdgConfigHome: tmp() }
    writeStackConfigs(fx, { opencodeDir: join(owner, 'oc'), cortexkitDir: join(owner, 'ck') })
    const read = (...p: string[]) => JSON.parse(readFileSync(join(fx.xdgConfigHome, ...p), 'utf8'))
    expect(read('opencode', 'oh-my-opencode-slim.jsonc')).toMatchObject({ preset: 'mixed', autoUpdate: false })
    expect(readFileSync(join(fx.xdgConfigHome, 'opencode', 'oh-my-opencode-slim', 'orchestrator_append.md'), 'utf8')).toBe('append')
    expect(read('cortexkit', 'aft.jsonc')).toEqual({ auto_update: false, indexes: { trigram: true, semantic: false } })
    expect(read('cortexkit', 'magic-context.jsonc')).toMatchObject({ historian: { disable: true }, dreamer: { disable: true } })

    const bare = { xdgConfigHome: tmp() }
    writeStackConfigs(bare, { opencodeDir: null, cortexkitDir: null })
    expect(JSON.parse(readFileSync(join(bare.xdgConfigHome, 'opencode', 'systematic.jsonc'), 'utf8'))).toEqual({ search: { allow_project_sources: [] } })
  })
})

describe('the host config', () => {
  test('names the denials: pushes, gh, the shell, outside writes and the web', () => {
    const p = replayPermission() as { bash: Record<string, string> } & Record<string, unknown>
    expect(p.external_directory).toBe('deny')
    expect(p.webfetch).toBe('deny')
    expect(p.websearch).toBe('deny')
    expect(p.bash['*']).toBe('deny')
    expect(p.bash['git push*']).toBe('deny')
    expect(p.bash['gh *']).toBe('deny')
    // Later rules win, so no allow may follow the denials.
    expect(Object.values(p.bash).every((v) => v === 'deny')).toBe(true)
  })

  test('the generated config carries the stack, the compaction switches and no mcp block', () => {
    const c = stackHostConfig({ provider: stubProviders('http://127.0.0.1:1/v1'), pluginSpecs: [...STACK_NPM_PLUGINS, 'file:///pkg/dist/index.js'] }) as GeneratedConfig
    expect(c.plugin).toHaveLength(5)
    expect(JSON.stringify(c.plugin)).not.toMatch(/-auth/)
    expect(c.share).toBe('disabled')
    expect(c.compaction).toEqual({ auto: false, prune: false })
    expect('mcp' in c).toBe(false)
    expect(Object.keys(c.provider)).toEqual(['anthropic', 'openai'])
  })
})
