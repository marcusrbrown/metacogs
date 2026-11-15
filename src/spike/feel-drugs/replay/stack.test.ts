import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aftConfig, dailyStack, magicContextConfig, replayPermission, slimConfig, stackHostConfig, STACK_NPM_PLUGINS, stubProviders, SYSTEMATIC_PIN, systematicConfig, workflowPermission, workflowStack, writeStackConfigs } from './stack'

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

describe('the workflow stack', () => {
  test('the pinned Systematic is the only registry plugin: slim, magic-context and aft are left out', () => {
    const stack = workflowStack()
    expect(stack.npmPlugins).toEqual([SYSTEMATIC_PIN])
    expect(SYSTEMATIC_PIN).toMatch(/^@fro\.bot\/systematic@\d+\.\d+\.\d+$/)
    const joined = JSON.stringify(stack.npmPlugins)
    for (const left of ['oh-my-opencode-slim', 'magic-context', 'aft']) expect(joined).not.toContain(left)
    // no agent plugin: the host's own default runs, and `debug config` names none and may carry no mcp block
    expect(stack).toMatchObject({ defaultAgent: 'build', reportedDefaultAgent: null, mcpMayBeAbsent: true })
    expect(workflowStack('@fro.bot/systematic@9.9.9').npmPlugins).toEqual(['@fro.bot/systematic@9.9.9'])
  })

  test('only a registry release of Systematic is accepted: a local build and another plugin are refused', () => {
    expect(() => workflowStack('file:///tmp/build/dist/index.js')).toThrow('registry release')
    expect(() => workflowStack('oh-my-opencode-slim@3.0.7')).toThrow('registry release')
    expect(() => workflowStack('@fro.bot/systematic')).toThrow('registry release')
  })

  test('question and task are denied on top of the replay denials, which are kept', () => {
    const p = workflowPermission() as { bash: Record<string, string> } & Record<string, unknown>
    expect(p.question).toBe('deny')
    expect(p.task).toBe('deny')
    expect(p.external_directory).toBe('deny')
    expect(p.bash['git push*']).toBe('deny')
    expect(workflowStack().permission).toEqual(workflowPermission())
  })

  test('only the Systematic config is written, from the owner file with the safety switches', () => {
    const owner = tmp()
    mkdirSync(join(owner, 'oc'))
    writeFileSync(join(owner, 'oc', 'systematic.jsonc'), '{ "y": 2 }')
    const fx = { xdgConfigHome: tmp() }
    writeStackConfigs(fx, { opencodeDir: join(owner, 'oc'), cortexkitDir: null }, workflowStack())
    expect(JSON.parse(readFileSync(join(fx.xdgConfigHome, 'opencode', 'systematic.jsonc'), 'utf8'))).toEqual({ y: 2, search: { allow_project_sources: [] } })
    for (const absent of [['opencode', 'oh-my-opencode-slim.jsonc'], ['cortexkit', 'aft.jsonc'], ['cortexkit', 'magic-context.jsonc']]) expect(existsSync(join(fx.xdgConfigHome, ...absent!))).toBe(false)
  })

  test('the daily stack is the existing one: five plugins in the order they were, the orchestrator, the existing permission', () => {
    const daily = dailyStack()
    expect(daily.npmPlugins).toEqual(STACK_NPM_PLUGINS)
    expect(daily).toMatchObject({ defaultAgent: 'orchestrator', reportedDefaultAgent: 'orchestrator', mcpMayBeAbsent: false })
    expect(daily.permission).toEqual(replayPermission())
    expect(daily.agent).toEqual({ general: { disable: true }, explore: { disable: true } })
    const fx = { xdgConfigHome: tmp() }
    writeStackConfigs(fx, { opencodeDir: null, cortexkitDir: null }, daily)
    for (const present of [['opencode', 'oh-my-opencode-slim.jsonc'], ['opencode', 'systematic.jsonc'], ['cortexkit', 'aft.jsonc'], ['cortexkit', 'magic-context.jsonc']]) expect(existsSync(join(fx.xdgConfigHome, ...present!))).toBe(true)
  })

  test('the generated config carries the profile: its plugins, its permission and no mcp block', () => {
    const stack = workflowStack()
    const c = stackHostConfig({ provider: stubProviders('http://127.0.0.1:1/v1'), pluginSpecs: [...stack.npmPlugins, 'file:///pkg/dist/index.js'], permission: stack.permission, agent: stack.agent }) as GeneratedConfig & { permission: Record<string, unknown> }
    expect(c.plugin).toEqual([SYSTEMATIC_PIN, 'file:///pkg/dist/index.js'])
    expect(c.permission.question).toBe('deny')
    expect(c.permission.task).toBe('deny')
    expect('mcp' in c).toBe(false)
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
