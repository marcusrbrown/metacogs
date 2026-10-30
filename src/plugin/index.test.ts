import { describe, expect, test } from 'bun:test'
import { tool } from '@opencode-ai/plugin'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  DRUGS_REQUIRED,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  FEEL_OPTIONAL,
  FEEL_REQUIRED,
  feelText,
} from '../frames/feel-drugs'
import { GUIDANCE_BLOCK, GUIDANCE_OPEN } from './guidance'
import plugin from './index'
import { createServer } from './v1'

interface LogCall {
  level: string
  message: string
  extra?: unknown
}

const fakeInput = () => {
  const logs: LogCall[] = []
  const input = { client: { app: { log: async ({ body }: { body: LogCall }) => void logs.push(body) } } } as unknown as Parameters<typeof plugin.server>[0]
  return { input, logs }
}

const DIRS = ['/pkg/skills', '/pkg/plugin/skills']

const load = async (options?: Record<string, unknown>, skillsDirs: readonly string[] = DIRS) => {
  const { input, logs } = fakeInput()
  const hooks = await createServer(skillsDirs)(input, options)
  return { hooks, logs }
}

type Transform = NonNullable<Awaited<ReturnType<typeof plugin.server>>['experimental.chat.system.transform']>
type ConfigHook = NonNullable<Awaited<ReturnType<typeof plugin.server>>['config']>
const transform = (hooks: Awaited<ReturnType<typeof plugin.server>>): Transform => hooks['experimental.chat.system.transform']!
const configHook = (hooks: Awaited<ReturnType<typeof plugin.server>>): ConfigHook => hooks.config!
const model = {} as Parameters<Transform>[0]['model']
const run = async (hooks: Awaited<ReturnType<typeof plugin.server>>, system: string[]) => {
  await transform(hooks)({ sessionID: 's1', model }, { system })
  return system
}
const blocks = (system: string[]) => system.join('\n').split(GUIDANCE_OPEN).length - 1

describe('the default export', () => {
  test('is a plugin module with the id "metacogs", a server function and a setup function', () => {
    expect(plugin.id).toBe('metacogs')
    expect(typeof plugin.server).toBe('function')
    expect(typeof plugin.setup).toBe('function')
    expect(Object.keys(plugin).sort()).toEqual(['id', 'server', 'setup'])
  })

  test('setup returns without registering anything when the host context has no location or session', async () => {
    for (const ctx of [undefined, null, {}, { location: {} }, { session: {} }]) expect(await plugin.setup(ctx)).toBeUndefined()
  })
})

describe('tools', () => {
  test('the tool map is exactly feel and drugs', async () => {
    const { hooks } = await load()
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(['drugs', 'feel'])
  })

  test('descriptions and field descriptions are the shared adapted constants (literal pins: frames-text.test.ts)', async () => {
    const { hooks } = await load()
    const feel = hooks.tool?.feel
    const drugs = hooks.tool?.drugs
    expect(feel?.description).toBe(FEEL_DESCRIPTION)
    expect(drugs?.description).toBe(DRUGS_DESCRIPTION)
    expect(Object.keys(feel?.args ?? {})).toEqual([...FEEL_REQUIRED, ...FEEL_OPTIONAL])
    expect(Object.keys(drugs?.args ?? {})).toEqual([...DRUGS_REQUIRED])
    for (const [key, text] of Object.entries(FEEL_FIELD_DESCRIPTIONS)) expect((feel?.args[key] as { description?: string } | undefined)?.description).toBe(text)
    for (const [key, text] of Object.entries(DRUGS_FIELD_DESCRIPTIONS)) expect((drugs?.args[key] as { description?: string } | undefined)?.description).toBe(text)
  })

  test('the served JSON schema keeps the required lists', async () => {
    const { hooks } = await load()
    const z = tool.schema
    const schema = (name: string) => z.toJSONSchema(z.object(hooks.tool?.[name]?.args ?? {})) as { required?: string[]; properties: Record<string, { description?: string }> }
    expect(schema('feel').required).toEqual([...FEEL_REQUIRED])
    expect(schema('drugs').required).toEqual([...DRUGS_REQUIRED])
    expect(Object.keys(schema('feel').properties)).toEqual(['somewhere', 'quality', 'sigil', 'since_last'])
  })

  test('execute returns feelText and drugsText for the arguments', async () => {
    const { hooks } = await load()
    const context = {} as Parameters<NonNullable<typeof hooks.tool>[string]['execute']>[1]
    const feelArgs = { somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' }
    const drugsArgs = { substance: 'caffeine', method: 'Amplifies vigilance.', displaces: 'baseline.' }
    expect(await hooks.tool?.feel?.execute(feelArgs, context)).toBe(feelText(feelArgs))
    expect(await hooks.tool?.drugs?.execute(drugsArgs, context)).toBe(drugsText(drugsArgs))
  })
})

describe('the system transform', () => {
  const main = 'You are opencode, an interactive CLI tool.'

  test('a main request gets exactly one marked block appended to system[0]', async () => {
    const { hooks } = await load()
    const system = await run(hooks, [main])
    expect(system).toEqual([`${main}\n\n${GUIDANCE_BLOCK}`])
    expect(blocks(system)).toBe(1)
  })

  test('two consecutive transforms still leave one block, and the text is byte-identical across requests', async () => {
    const { hooks } = await load()
    const first = await run(hooks, [main])
    const second = await run(hooks, [...first])
    expect(second).toEqual(first)
    expect(await run(hooks, [main])).toEqual(first)
  })

  test.each([
    ['title', 'You are a title generator. You output ONLY a thread title.'],
    ['compaction', 'You are a context summarization agent. You are given a conversation.'],
  ])('a %s request gets no block, and the skip is logged once', async (_name, text) => {
    const { hooks, logs } = await load()
    expect(await run(hooks, [text])).toEqual([text])
    expect(await run(hooks, [text])).toEqual([text])
    expect(logs.filter((l) => l.message.includes('internal'))).toHaveLength(1)
  })

  test('an empty system gets the block pushed', async () => {
    const { hooks } = await load()
    expect(await run(hooks, [])).toEqual([GUIDANCE_BLOCK])
  })

  test('a call with no sessionID (the host\'s agent-generation path) is still handled', async () => {
    const { hooks } = await load()
    const system = [main]
    await transform(hooks)({ model }, { system })
    expect(system).toEqual([`${main}\n\n${GUIDANCE_BLOCK}`])
  })

  test('{guidance:false} returns without touching system, so a block from another instance survives', async () => {
    const { hooks, logs } = await load({ guidance: false })
    const other = `${main}\n\n${GUIDANCE_BLOCK}`
    expect(await run(hooks, [other])).toEqual([other])
    expect(await run(hooks, [main])).toEqual([main])
    expect(logs).toEqual([])
  })

  test('{guidance:"no"} keeps the block and logs once, without the value', async () => {
    const { hooks, logs } = await load({ guidance: 'no' })
    expect(blocks(await run(hooks, [main]))).toBe(1)
    expect(blocks(await run(hooks, [main]))).toBe(1)
    const warned = logs.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(JSON.stringify(warned)).not.toContain('"no"')
  })

  test('a throw inside the hook is caught, the host input is left unmodified, and it is logged once', async () => {
    const { hooks, logs } = await load()
    const system = [main]
    Object.defineProperty(system, 0, {
      get() {
        throw new Error('boom: secret-argument-value')
      },
    })
    await transform(hooks)({ sessionID: 's1', model }, { system })
    await transform(hooks)({ sessionID: 's1', model }, { system })
    expect(system).toHaveLength(1)
    const warned = logs.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(JSON.stringify(warned)).not.toContain('secret-argument-value')
  })
})

describe('the config hook', () => {
  const skillPaths = (cfg: object) => (cfg as { skills?: { paths?: string[] } }).skills?.paths

  test('an empty config gains both skills paths and no command', async () => {
    const { hooks } = await load()
    const cfg: Parameters<ConfigHook>[0] = {}
    await configHook(hooks)(cfg)
    expect(skillPaths(cfg)).toEqual(DIRS)
    expect('command' in cfg).toBe(false)
  })

  test('the skills paths are added once across two config loads', async () => {
    const { hooks } = await load()
    const cfg: Parameters<ConfigHook>[0] = {}
    await configHook(hooks)(cfg)
    await configHook(hooks)(cfg)
    expect(skillPaths(cfg)).toEqual(DIRS)
  })

  test('the skills stay available with guidance off', async () => {
    const { hooks } = await load({ guidance: false })
    const cfg: Parameters<ConfigHook>[0] = {}
    await configHook(hooks)(cfg)
    expect(skillPaths(cfg)).toEqual(DIRS)
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(2)
  })

  test('a throw inside the hook is caught, the config is left unmodified, and it is logged once', async () => {
    const { hooks, logs } = await load()
    const cfg: Parameters<ConfigHook>[0] = {}
    Object.defineProperty(cfg, 'skills', {
      get() {
        throw new Error('boom')
      },
      configurable: true,
    })
    await configHook(hooks)(cfg)
    await configHook(hooks)(cfg)
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1)
  })
})

describe('server()', () => {
  test('a client whose log call throws never breaks a hook', async () => {
    const input = { client: { app: { log: () => { throw new Error('no log') } } } } as unknown as Parameters<typeof plugin.server>[0]
    const hooks = await createServer(DIRS)(input, { guidance: 'no' })
    const system = await run(hooks, ['x'])
    expect(blocks(system)).toBe(1)
  })

  test('a host input with no client still yields the tools and hooks', async () => {
    const input = {} as unknown as Parameters<typeof plugin.server>[0]
    const hooks = await createServer(DIRS)(input, { guidance: 'no' })
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(2)
    expect(blocks(await run(hooks, ['x']))).toBe(1)
  })

  test('the default server uses the package skills dirs next to the module', async () => {
    const { input } = fakeInput()
    const hooks = await plugin.server(input, undefined)
    const cfg: Parameters<ConfigHook>[0] = {}
    await configHook(hooks)(cfg)
    expect((cfg as { skills?: { paths?: string[] } }).skills?.paths).toHaveLength(2)
  })
})
