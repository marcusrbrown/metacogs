/**
 * Host probes for the metacogs plugin: how OpenCode 1.19.4 treats an object plugin loaded by `file://`, its `config`
 * and `experimental.chat.system.transform` hooks, commands, skill paths and permissions. Every probe runs the pinned
 * host against the scripted provider ($0). The probe plugin is a throwaway module that records what the host does with
 * it; the findings are summarised in `evals/spikes/feel-drugs/README.md`, "Plugin host probes". The suite takes minutes and
 * runs only with `METACOGS_HOST_PROBES=1`, on a host pin bump.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildChildEnv, createFixture, destroyFixture, type Fixture } from '../runner/env'
import { type OpencodeEvent, parseEvents, toolUses } from '../runner/events'
import { systemTexts } from '../runner/isolation'
import { opencodeArgv, opencodeAvailability, spawnCapture, type SpawnResult } from '../runner/opencode'
import {
  type RecordedRequest,
  type ScriptedStep,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  scriptedProviderConfig,
  startScriptedProvider,
} from '../runner/scripted-provider'
import { buildConfig, gitInit } from '../runner/workspace'

const HOST_MODEL = `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`
const SYSTEMATIC_TITLE_SIGNATURE = 'You are a title generator'
const SYSTEMATIC_SUMMARY_SIGNATURE = 'You are a helpful AI assistant tasked with summarizing conversations'
const COMPACTION_SIGNATURE = 'You are a context summarization agent'
const BLOCK = '<PROBE_BLOCK/>'

/** Every permission key in `core/src/v1/config/permission.ts` that gates a built-in tool, denied. */
const DENY_ALL: Record<string, unknown> = Object.fromEntries(
  ['glob', 'grep', 'list', 'read', 'edit', 'bash', 'task', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill'].map((key) => [key, 'deny']),
)
const BASE_PERMISSION: Record<string, unknown> = { edit: 'deny', bash: { '*': 'deny' } }

interface ChatBody {
  messages?: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]
  tools?: { function: { name: string } }[]
}

const bodyOf = (request: RecordedRequest): ChatBody => (request.body ?? {}) as ChatBody
const offeredNames = (request: RecordedRequest): string[] => (bodyOf(request).tools ?? []).map((t) => t.function.name)
const systemOf = (request: RecordedRequest): string => systemTexts(request.body as Record<string, unknown>).join('\n')
const userTexts = (request: RecordedRequest): string[] => (bodyOf(request).messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content))
const mainRequest = (requests: readonly RecordedRequest[]): RecordedRequest => {
  const found = requests.find((r) => systemOf(r).startsWith('You are opencode'))
  if (!found) throw new Error('no main request recorded')
  return found
}
const skillNames = (request: RecordedRequest): string[] => [...systemOf(request).matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '')
const countBlocks = (request: RecordedRequest): number => systemOf(request).split(BLOCK).length - 1

interface ProbeLogEntry {
  ev: string
  tag: string
  options?: unknown
  head?: string
  keys?: string[]
}

interface PluginSpec {
  tag: string
  /** `null` omits the `id` field entirely. */
  id?: string | null
  tools?: Record<string, string>
  commands?: Record<string, string>
  skillsPath?: string
  block?: boolean
}

/** The host runs `npm install @opencode-ai/plugin` in its config dir on the first run that loads a plugin (about 20 s). Every lab copies one installed dir and then keeps npm offline. */
const OFFLINE_NPM = { npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }
let template: { lab: Lab; ready: Promise<string> } | undefined
const installedConfigDir = (): Promise<string> => {
  template ??= (() => {
    const lab = new Lab(false)
    const ready = (async () => {
      const spec = lab.plugin('seed.mjs', { tag: 'SEED' })
      await lab.run({ args: ['seed'], config: { plugin: [spec] } })
      return lab.fixture.opencodeConfigDir
    })()
    return { lab, ready }
  })()
  return template.ready
}
afterAll(() => template?.lab.destroy())

class Lab {
  readonly fixture: Fixture = createFixture('metacogs-probe-')
  readonly log = join(this.fixture.root, 'probe.log')
  private seeded = false

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

  skill(root: string, name: string, description: string, body: string): string {
    const dir = join(this.fixture.root, 'scratch', root)
    this.scratch(`${root}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
    return dir
  }

  plugin(file: string, spec: PluginSpec): string {
    this.scratch(file, pluginSource(this.log, spec))
    return `file://${join(this.fixture.root, 'scratch', file)}`
  }

  logEntries(): ProbeLogEntry[] {
    if (!existsSync(this.log)) return []
    return readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ProbeLogEntry)
  }

  resetLog(): void {
    rmSync(this.log, { force: true })
  }

  async run(options: {
    args: string[]
    config?: Record<string, unknown>
    permission?: Record<string, unknown>
    steps?: ScriptedStep[]
    limit?: { context: number; output: number }
    timeoutMs?: number
  }): Promise<{ result: SpawnResult; requests: RecordedRequest[]; events: OpencodeEvent[] }> {
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

  async debugConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { result } = await this.run({ args: ['debug', 'config'], config })
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
}

/** An object plugin that records its lifecycle to `log` and optionally adds tools, commands, a skills path and a marked system block. */
function pluginSource(log: string, spec: PluginSpec): string {
  const tag = JSON.stringify(spec.tag)
  const tools = Object.entries(spec.tools ?? {}).map(([name, out]) => `${name}: { description: 'probe ${name}', args: {}, execute: async () => ${JSON.stringify(out)} },`)
  const commands = Object.entries(spec.commands ?? {}).map(([name, template]) => `cfg.command[${JSON.stringify(name)}] = { template: ${JSON.stringify(template)}, description: '(probe) ${name}' }`)
  return `import { appendFileSync } from 'node:fs'
const note = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n')
export default {
  ${spec.id === null ? '' : `id: ${JSON.stringify(spec.id ?? spec.tag)},`}
  server: async (input, options) => {
    note({ ev: 'server', tag: ${tag}, options })
    return {
      tool: { ${tools.join('\n')} },
      config: async (cfg) => {
        cfg.command ??= {}
        ${commands.join('\n')}
        ${spec.skillsPath ? `cfg.skills ??= {}; cfg.skills.paths ??= []; cfg.skills.paths.push(${JSON.stringify(spec.skillsPath)})` : ''}
      },
      'experimental.chat.system.transform': async (input, output) => {
        note({ ev: 'transform', tag: ${tag}, head: String(output.system[0] ?? '').slice(0, 60), keys: Object.keys(input ?? {}) })
        ${spec.block ? `output.system.push(${JSON.stringify(BLOCK)})` : ''}
      },
    }
  },
}
`
}

const HOST_TIMEOUT = 600_000
const probe = (name: string, body: (lab: Lab) => Promise<void>) =>
  test(
    name,
    async () => {
      const lab = new Lab()
      try {
        await body(lab)
      } finally {
        lab.destroy()
      }
    },
    HOST_TIMEOUT,
  )
const callStep = (name: string, id = 'call_1', args: Record<string, unknown> = {}): ScriptedStep => ({ toolCalls: [{ id, name, arguments: args }] })

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !opencodeAvailability().available)('plugin host behaviour on the pinned host (scripted provider, $0)', () => {
  probe(
    'a file:// object plugin loads under OPENCODE_DISABLE_DEFAULT_PLUGINS=1 and offers its tool; the env stays set',
    async (lab) => {
      const spec = lab.plugin('probe.mjs', { tag: 'P', tools: { probe_tool: 'out' } })
      const { requests, result } = await lab.run({ args: ['hello'], config: { plugin: [spec] }, steps: [callStep('probe_tool')] })
      expect(result.exitCode).toBe(0)
      expect(buildChildEnv({ fixture: lab.fixture, config: {} }).OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('1')
      expect(offeredNames(mainRequest(requests))).toContain('probe_tool')
      expect(lab.logEntries().filter((e) => e.ev === 'server')).toHaveLength(1)
    },
  )

  probe(
    'an object plugin without an id is not loaded: the host logs "must export id" and the run still exits 0',
    async (lab) => {
      const spec = lab.plugin('noid.mjs', { tag: 'NOID', id: null, tools: { noid_tool: 'out' } })
      const { requests, result } = await lab.run({ args: ['--print-logs', 'hello'], config: { plugin: [spec] } })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('must export id')
      expect(offeredNames(mainRequest(requests))).not.toContain('noid_tool')
      expect(lab.logEntries()).toEqual([])
    },
  )

  probe(
    'hook-added command and skills.paths show in `debug config`, and a plain config shows neither; plugin_origins appears with a plugin',
    async (lab) => {
      const skills = lab.skill('pskills', 'pluginskill', 'from the plugin path', 'PLUGIN_BODY')
      const spec = lab.plugin('probe.mjs', { tag: 'P', commands: { feel: 'T <args>$ARGUMENTS</args>' }, skillsPath: skills })

      const plain = await lab.debugConfig({})
      expect(plain.command).toEqual({})
      expect(plain.plugin).toEqual([])
      expect(plain.skills).toBeUndefined()
      expect(plain.plugin_origins).toBeUndefined()

      const withPlugin = await lab.debugConfig({ plugin: [spec] })
      expect(withPlugin.command).toEqual({ feel: { template: 'T <args>$ARGUMENTS</args>', description: '(probe) feel' } })
      expect(withPlugin.skills).toEqual({ paths: [skills] })
      expect(withPlugin.plugin).toEqual([spec])
      expect(withPlugin.plugin_origins).toHaveLength(1)
      expect(withPlugin.plugin_origins).toMatchObject([{ spec, source: lab.fixture.configPath, scope: 'global' }])

      const { requests } = await lab.run({ args: ['hello'], config: { plugin: [spec] } })
      expect(skillNames(mainRequest(requests))).toContain('pluginskill')
    },
  )

  probe(
    '--command substitutes $ARGUMENTS: one word arrives raw, several words arrive JSON-quoted, none arrives empty',
    async (lab) => {
      const spec = lab.plugin('probe.mjs', { tag: 'P', commands: { feel: 'FEEL <args>$ARGUMENTS</args>' } })
      const config = { plugin: [spec] }
      const textOf = async (args: string[]) => userTexts(mainRequest((await lab.run({ args: ['--command', 'feel', ...args], config })).requests))

      expect(await textOf(['caffeine'])).toEqual(['FEEL <args>caffeine</args>'])
      expect(await textOf(['two words'])).toEqual(['FEEL <args>"two words"</args>'])
      expect(await textOf([])).toEqual(['FEEL <args></args>'])
    },
  )

  probe(
    'a skill name found in a plugin skills.paths dir and in .agents/skills copies is listed once and loads one copy; the winner is not stable, so there is no documented precedence',
    async (lab) => {
      const skills = lab.skill('pskills', 'samename', 'plugin copy', 'FROM_PLUGIN_PATH')
      lab.skill('pskills', 'solo', 'only in the plugin path', 'FROM_SOLO')
      lab.workspaceFile('.agents/skills/samename/SKILL.md', '---\nname: samename\ndescription: project copy\n---\n\nFROM_PROJECT_COPY\n')
      lab.homeFile('.agents/skills/samename/SKILL.md', '---\nname: samename\ndescription: home copy\n---\n\nFROM_HOME_COPY\n')
      const spec = lab.plugin('probe.mjs', { tag: 'P', skillsPath: skills })

      const { requests, events } = await lab.run({
        args: ['load them'],
        config: { plugin: [spec] },
        permission: { ...BASE_PERMISSION, skill: 'allow' },
        steps: [callStep('skill', 'c1', { name: 'samename' }), callStep('skill', 'c2', { name: 'solo' })],
      })
      const names = skillNames(mainRequest(requests))
      expect(names.filter((n) => n === 'samename')).toHaveLength(1)
      expect(names).toContain('solo')
      const outputs = toolUses(events).filter((t) => t.tool === 'skill').map((t) => t.output ?? '')
      expect(outputs).toHaveLength(2)
      expect(outputs[0]?.match(/FROM_[A-Z_]+/g)).toHaveLength(1)
      expect(outputs[0]).toMatch(/FROM_(PLUGIN_PATH|PROJECT_COPY|HOME_COPY)/)
      expect(outputs[1]).toContain('FROM_SOLO')
    },
  )

  probe(
    'a title request carries the "You are a title generator" signature and a compaction request carries "You are a context summarization agent"; the transform hook fires for both',
    async (lab) => {
      const spec = lab.plugin('probe.mjs', { tag: 'P', block: true })
      const { requests, result } = await lab.run({
        args: ['please glob'],
        config: { plugin: [spec], compaction: { auto: true, reserved: 0 } },
        limit: { context: 10, output: 5 },
        steps: [callStep('glob', 'c1', { pattern: '*' })],
        timeoutMs: 25_000,
      })
      expect(result.exitCode).not.toBe(0) // the tiny context makes the host compact in a loop until the timeout kills it

      const title = requests.find((r) => systemOf(r).startsWith(SYSTEMATIC_TITLE_SIGNATURE))
      expect(title).toBeDefined()
      expect(bodyOf(title!).tools ?? []).toEqual([])
      expect(systemOf(title!).startsWith('You are a title generator. You output ONLY a thread title.')).toBe(true)

      const compaction = requests.find((r) => systemOf(r).startsWith(COMPACTION_SIGNATURE))
      expect(compaction).toBeDefined()
      expect(systemOf(compaction!)).not.toContain(SYSTEMATIC_SUMMARY_SIGNATURE)
      expect(countBlocks(compaction!)).toBe(1)

      const heads = lab.logEntries().filter((e) => e.ev === 'transform').map((e) => e.head ?? '')
      expect(heads.some((h) => h.startsWith(SYSTEMATIC_TITLE_SIGNATURE))).toBe(true)
      expect(heads.some((h) => h.startsWith(COMPACTION_SIGNATURE))).toBe(true)
      expect(lab.logEntries().filter((e) => e.ev === 'transform').every((e) => e.keys?.includes('sessionID'))).toBe(true)
    },
  )

  probe(
    'denying every permission key leaves N1 with no tools at all, and the main request is the one that starts "You are opencode"',
    async (lab) => {
      const { requests } = await lab.run({ args: ['hello'], permission: DENY_ALL })
      expect(requests.every((r) => !r.hasTools)).toBe(true)
      expect(bodyOf(mainRequest(requests)).tools).toBeUndefined()
      expect(userTexts(mainRequest(requests))).toEqual(['hello'])
    },
  )

  probe(
    'the deny set with only the plugin skills allowed offers exactly the plugin tool and `skill`, and lists exactly the allowed skills',
    async (lab) => {
      const skills = lab.skill('pskills', 'pluginskill', 'a', 'A')
      lab.skill('pskills', 'otherskill', 'b', 'B')
      const spec = lab.plugin('probe.mjs', { tag: 'P', tools: { probe_tool: 'out' }, skillsPath: skills })
      const { requests } = await lab.run({
        args: ['hello'],
        config: { plugin: [spec] },
        permission: { ...DENY_ALL, skill: { '*': 'deny', pluginskill: 'allow' } },
      })
      const main = mainRequest(requests)
      expect(offeredNames(main).sort()).toEqual(['probe_tool', 'skill'])
      expect(skillNames(main)).toEqual(['pluginskill'])
    },
  )

  probe(
    'permission.skill deny, a deny-all skill map and a per-agent deny-all hide the plugin skills and the skill tool; a per-name allow or deny is honoured',
    async (lab) => {
      const skills = lab.skill('pskills', 'pluginskill', 'a', 'A')
      const spec = lab.plugin('probe.mjs', { tag: 'P', skillsPath: skills })
      const seen = async (skill: unknown, extra: Record<string, unknown> = {}) => {
        const main = mainRequest((await lab.run({ args: ['hello'], config: { plugin: [spec], ...extra }, permission: { ...BASE_PERMISSION, skill } })).requests)
        return { tool: offeredNames(main).includes('skill'), skills: skillNames(main).filter((n) => n === 'pluginskill') }
      }

      expect(await seen('allow')).toEqual({ tool: true, skills: ['pluginskill'] })
      expect(await seen('deny')).toEqual({ tool: false, skills: [] })
      expect(await seen({ '*': 'deny' })).toEqual({ tool: false, skills: [] })
      expect(await seen({ '*': 'allow', pluginskill: 'deny' })).toEqual({ tool: true, skills: [] })
      expect(await seen('allow', { agent: { build: { permission: { skill: { '*': 'deny' } } } } })).toEqual({ tool: false, skills: [] })
      expect(await seen('allow', { agent: { build: { permission: { skill: { '*': 'deny', pluginskill: 'allow' } } } } })).toEqual({ tool: true, skills: ['pluginskill'] })
    },
  )

  probe(
    'one spec in two config layers loads once; the higher layer supplies the options',
    async (lab) => {
      const spec = lab.plugin('a.mjs', { tag: 'A', tools: { dup_tool: 'from-A' }, block: true })
      lab.workspaceFile('opencode.json', JSON.stringify({ plugin: [[spec, { guidance: false, layer: 'project' }]] }))

      const { requests } = await lab.run({ args: ['hello'], config: { plugin: [[spec, { guidance: true, layer: 'file' }]] } })
      expect(lab.logEntries().filter((e) => e.ev === 'server')).toEqual([{ ev: 'server', tag: 'A', options: { guidance: false, layer: 'project' } }])
      expect(countBlocks(mainRequest(requests))).toBe(1)
      expect(offeredNames(mainRequest(requests)).filter((n) => n === 'dup_tool')).toHaveLength(1)

      const effective = await lab.debugConfig({ plugin: [spec] })
      expect(effective.plugin).toEqual([[spec, { guidance: false, layer: 'project' }]])
    },
  )

  probe(
    'two distinct plugins both load; the later one (project layer, or later in the array) wins a shared tool name, and each adds its own block',
    async (lab) => {
      const a = lab.plugin('a.mjs', { tag: 'A', tools: { dup_tool: 'from-A' }, block: true })
      const b = lab.plugin('b.mjs', { tag: 'B', tools: { dup_tool: 'from-B' }, block: true })
      const winner = async (config: Record<string, unknown>) => {
        const { requests, events } = await lab.run({ args: ['call dup'], config, steps: [callStep('dup_tool')] })
        return { out: toolUses(events).find((t) => t.tool === 'dup_tool')?.output, blocks: countBlocks(mainRequest(requests)) }
      }

      expect(await winner({ plugin: [a, b] })).toEqual({ out: 'from-B', blocks: 2 })
      expect(await winner({ plugin: [b, a] })).toEqual({ out: 'from-A', blocks: 2 })
      expect(lab.logEntries().filter((e) => e.ev === 'server').map((e) => e.tag).sort()).toEqual(['A', 'A', 'B', 'B'])

      lab.workspaceFile('opencode.json', JSON.stringify({ plugin: [b] }))
      expect((await winner({ plugin: [a] })).out).toBe('from-B')
      lab.workspaceFile('opencode.json', JSON.stringify({ plugin: [a] }))
      expect((await winner({ plugin: [b] })).out).toBe('from-A')
    },
  )

  probe(
    'a resumed session replays the old plugin tool call and result, with the tool no longer offered, after the plugin is removed',
    async (lab) => {
      const spec = lab.plugin('probe.mjs', { tag: 'P', tools: { probe_tool: 'out' } })
      const first = await lab.run({ args: ['first turn'], config: { plugin: [spec] }, steps: [callStep('probe_tool')] })
      expect(toolUses(first.events).map((t) => [t.tool, t.status, t.output])).toEqual([['probe_tool', 'completed', 'out']])

      const second = await lab.run({ args: ['--continue', 'second turn'] })
      expect(second.result.exitCode).toBe(0)
      const main = mainRequest(second.requests)
      expect(offeredNames(main)).not.toContain('probe_tool')
      const history = (bodyOf(main).messages ?? []).filter((m) => m.role !== 'system')
      expect(history.find((m) => m.tool_calls)?.tool_calls?.[0]?.function.name).toBe('probe_tool')
      expect(history.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_1', content: 'out' })
      expect(userTexts(main)).toEqual(['"first turn"', '"second turn"'])
    },
  )

  probe(
    'a skills.paths entry from an earlier config does not survive a fresh config load',
    async (lab) => {
      const first = lab.skill('pskills', 'firstskill', 'a', 'A')
      const second = lab.skill('pskills2', 'secondskill', 'b', 'B')
      const one = lab.plugin('one.mjs', { tag: 'ONE', skillsPath: first })
      const two = lab.plugin('two.mjs', { tag: 'TWO', skillsPath: second })
      const listed = async (config: Record<string, unknown>) => {
        const main = mainRequest((await lab.run({ args: ['hello'], config, permission: { ...BASE_PERMISSION, skill: 'allow' } })).requests)
        return skillNames(main).filter((n) => n.endsWith('skill') && n !== 'customize-opencode')
      }

      expect(await listed({ plugin: [one] })).toEqual(['firstskill'])
      expect(await listed({ plugin: [two] })).toEqual(['secondskill'])
      expect((await lab.debugConfig({ plugin: [two] })).skills).toEqual({ paths: [second] })
      expect(await listed({})).toEqual([])
      expect((await lab.debugConfig({})).skills).toBeUndefined()
    },
  )
})
