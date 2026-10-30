import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
import { REPO_ROOT } from './build'
import { GUIDANCE_BLOCK, GUIDANCE_OPEN } from './guidance'
import { createSetup } from './v2'

// Drives the v2 `setup` with a fake host context that records every registration. A transform callback is kept, so a
// test can run it against a fresh fake editor as many times as the host would replay it.

const DIRS: [string, string] = ['/pkg/skills', '/pkg/plugin/skills']
const CANARY = 'ARGUMENT-VALUE-CANARY'

interface ToolDef {
  name: string
  description: string
  input: { $schema?: string; type?: string; properties: Record<string, { description?: string }>; required?: string[]; additionalProperties?: boolean }
  options?: { codemode?: boolean }
  execute: (input: unknown) => Promise<{ content?: string }>
}
interface SkillRecord {
  id: string
  name: string
  description: string
  path: string
  content: string
}
interface Invocation {
  sessionID: string
  delivery: string
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: { id: string }[] }
}
interface CommandDef {
  name: string
  description: string
  execute: (invocation: Invocation) => Promise<void>
}
interface SystemPart {
  type: string
  text: string
}
interface ContextRequest {
  system: SystemPart[]
}

const handle = { dispose: async () => {} }

function fakeCtx(options: { options?: unknown; reject?: 'tool' | 'skill' | 'command' | 'hook'; promptError?: Error } = {}) {
  const transforms = {
    tool: [] as ((editor: unknown) => void)[],
    skill: [] as ((editor: unknown) => void)[],
    command: [] as ((editor: unknown) => void)[],
  }
  const hooks: { name: string; callback: (request: ContextRequest) => void }[] = []
  const prompts: Record<string, unknown>[] = []
  const transform = (kind: 'tool' | 'skill' | 'command') => async (callback: (editor: unknown) => void) => {
    if (options.reject === kind) throw new Error(CANARY)
    transforms[kind].push(callback)
    return handle
  }
  const ctx = {
    location: { directory: '/work' },
    options: options.options ?? {},
    tool: { transform: transform('tool') },
    skill: { transform: transform('skill') },
    command: { transform: transform('command') },
    session: {
      hook: async (name: string, callback: (request: ContextRequest) => void) => {
        if (options.reject === 'hook') throw new Error(CANARY)
        hooks.push({ name, callback })
        return handle
      },
      prompt: async (input: Record<string, unknown>) => {
        if (options.promptError) throw options.promptError
        prompts.push(input)
      },
    },
  }
  return { ctx, transforms, hooks, prompts }
}

type Fake = ReturnType<typeof fakeCtx>

/** Runs every kept transform of `kind` against a fresh editor and returns what it added. */
function replay<T>(fake: Fake, kind: 'tool' | 'skill' | 'command', editorOverride?: Record<string, unknown>): T[] {
  const added: T[] = []
  const editor = { add: (item: T) => void added.push(item), ...editorOverride }
  for (const transform of fake.transforms[kind]) transform(editor)
  return added
}

const load = async (options: Parameters<typeof fakeCtx>[0] = {}, dirs: [string, string] = DIRS) => {
  const fake = fakeCtx(options)
  await createSetup(dirs)(fake.ctx)
  return fake
}

const readSkill = (rel: string): { name: string; description: string; body: string } => {
  const text = readFileSync(join(REPO_ROOT, rel, 'SKILL.md'), 'utf8')
  const [, front = '', ...rest] = text.split('---\n')
  return {
    name: /^name: (.*)$/m.exec(front)?.[1] ?? '',
    description: /^description: (.*)$/m.exec(front)?.[1] ?? '',
    body: rest.join('---\n').trim(),
  }
}

const SKILL_HOMES = [
  ['feel', 'plugin/skills/feel', 1],
  ['drugs', 'plugin/skills/drugs', 1],
  ['synthesis', 'skills/synthesis', 0],
  ['counterfactual', 'skills/counterfactual', 0],
] as const

let errors: string[]
let restore: () => void
beforeEach(() => {
  errors = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')))
  restore = () => spy.mockRestore()
})
afterEach(() => restore())

describe('tools', () => {
  test('feel and drugs carry the v1 descriptions, the required set (since_last optional) and codemode:false', async () => {
    const fake = await load()
    const tools = replay<ToolDef>(fake, 'tool')
    expect(tools.map((t) => t.name)).toEqual(['feel', 'drugs'])
    const [feel, drugs] = tools as [ToolDef, ToolDef]

    expect(feel.description).toBe(FEEL_DESCRIPTION)
    expect(feel.options).toEqual({ codemode: false })
    expect(feel.input.required).toEqual([...FEEL_REQUIRED])
    expect(Object.keys(feel.input.properties)).toEqual([...FEEL_REQUIRED, ...FEEL_OPTIONAL])
    for (const [key, text] of Object.entries(FEEL_FIELD_DESCRIPTIONS)) expect(feel.input.properties[key]?.description).toBe(text)
    expect(feel.input.$schema).toBeUndefined()
    expect(feel.input.type).toBe('object')

    expect(drugs.description).toBe(DRUGS_DESCRIPTION)
    expect(drugs.options).toEqual({ codemode: false })
    expect(drugs.input.required).toEqual([...DRUGS_REQUIRED])
    expect(Object.keys(drugs.input.properties)).toEqual([...DRUGS_REQUIRED])
    for (const [key, text] of Object.entries(DRUGS_FIELD_DESCRIPTIONS)) expect(drugs.input.properties[key]?.description).toBe(text)
    expect(drugs.input.$schema).toBeUndefined()
  })

  test('execute returns exactly feelText and drugsText', async () => {
    const [feel, drugs] = replay<ToolDef>(await load(), 'tool') as [ToolDef, ToolDef]
    const feelArgs = { somewhere: 'in the gap', quality: 'warm, slow', sigil: '🌊', since_last: 'it eased' }
    const drugsArgs = { substance: 'caffeine', method: 'Amplifies vigilance.', displaces: 'baseline.' }
    expect(await feel.execute(feelArgs)).toEqual({ content: feelText(feelArgs) })
    expect(await drugs.execute(drugsArgs)).toEqual({ content: drugsText(drugsArgs) })
  })
})

describe('skills', () => {
  test('four records whose names and descriptions equal the frontmatter and whose bodies have none', async () => {
    const records = replay<SkillRecord>(await load(), 'skill')
    expect(records.map((r) => r.name)).toEqual(SKILL_HOMES.map(([name]) => name))
    for (const [name, rel] of SKILL_HOMES) {
      const record = records.find((r) => r.name === name)!
      const source = readSkill(rel)
      expect(record.id).toBe(name)
      expect(record.name).toBe(source.name)
      expect(record.description).toBe(source.description)
      expect(record.description.length).toBeGreaterThan(0)
      expect(record.content).toBe(source.body)
      expect(record.content.startsWith('---')).toBe(false)
      expect(record.content).not.toMatch(/^name: /m)
    }
  })

  test('path is each SKILL.md: plugin skills under the plugin directory, methods under the skills directory', async () => {
    const records = replay<SkillRecord>(await load(), 'skill')
    for (const [name, , dir] of SKILL_HOMES) expect(records.find((r) => r.name === name)?.path).toBe(`${DIRS[dir]}/${name}/SKILL.md`)
  })

  test('with the real package directories every path exists, so the base directory holds scripts/record.mjs', async () => {
    const real: [string, string] = [join(REPO_ROOT, 'skills'), join(REPO_ROOT, 'plugin', 'skills')]
    const records = replay<SkillRecord>(await load({}, real), 'skill')
    for (const record of records) expect(existsSync(record.path)).toBe(true)
    for (const name of ['synthesis', 'counterfactual']) {
      const path = records.find((r) => r.name === name)!.path
      expect(existsSync(join(path, '..', 'scripts', 'record.mjs'))).toBe(true)
    }
  })
})

describe('commands', () => {
  const commands = async () => replay<CommandDef>(await load(), 'command')
  const invoke = async (name: string, prompt: Invocation['prompt'], extra: Partial<Invocation> = {}) => {
    const fake = await load()
    const command = replay<CommandDef>(fake, 'command').find((c) => c.name === name)!
    await command.execute({ sessionID: 'ses_1', delivery: 'queue', prompt, ...extra })
    return fake.prompts
  }

  test('one command per skill, with the skill name and description', async () => {
    const all = await commands()
    expect(all.map((c) => c.name)).toEqual(['feel', 'drugs', 'synthesis', 'counterfactual'])
    for (const [name, rel] of SKILL_HOMES) expect(all.find((c) => c.name === name)?.description).toBe(readSkill(rel).description)
  })

  test('execute with "caffeine" prompts with that text and the drugs skill attached', async () => {
    expect(await invoke('drugs', { text: 'caffeine' })).toEqual([{ sessionID: 'ses_1', text: 'caffeine', files: undefined, agents: undefined, skills: [{ id: 'drugs' }], delivery: 'queue' }])
  })

  test('multi-word text stays raw, and empty text attaches the skill with no text', async () => {
    const [raw] = await invoke('feel', { text: 'the chest  is "tight"' })
    expect(raw?.text).toBe('the chest  is "tight"')
    const [empty] = await invoke('synthesis', { text: '' })
    expect(empty?.text).toBe('')
    expect(empty?.skills).toEqual([{ id: 'synthesis' }])
  })

  test('forwards the envelope and adds the commanded skill once, even when it is already attached', async () => {
    const files = [{ uri: 'file:///a.txt' }]
    const agents = [{ name: 'general' }]
    const [added] = await invoke('counterfactual', { text: 'x', files, agents, skills: [{ id: 'other' }] }, { sessionID: 'ses_9', delivery: 'steer' })
    expect(added).toEqual({ sessionID: 'ses_9', text: 'x', files, agents, skills: [{ id: 'other' }, { id: 'counterfactual' }], delivery: 'steer' })

    const [again] = await invoke('counterfactual', { text: 'x', skills: [{ id: 'counterfactual' }, { id: 'other' }] })
    expect(again?.skills).toEqual([{ id: 'counterfactual' }, { id: 'other' }])
  })

  test('an error thrown by session.prompt propagates and is not swallowed', async () => {
    const fake = await load({ promptError: new Error('prompt refused') })
    const command = replay<CommandDef>(fake, 'command')[0]!
    await expect(command.execute({ sessionID: 's', delivery: 'queue', prompt: { text: 'x' } })).rejects.toThrow('prompt refused')
    expect(errors).toEqual([])
  })
})

describe('guidance', () => {
  test('the context hook pushes exactly one text part holding the block, onto an empty system', async () => {
    const fake = await load()
    expect(fake.hooks.map((h) => h.name)).toEqual(['context'])
    const request: ContextRequest = { system: [] }
    fake.hooks[0]!.callback(request)
    expect(request.system).toEqual([{ type: 'text', text: GUIDANCE_BLOCK }])
  })

  test('the hook pushes nothing when a part already holds the marker, so a second instance adds no second block', async () => {
    const fake = await load()
    const request: ContextRequest = { system: [{ type: 'text', text: 'agent prompt' }] }
    fake.hooks[0]!.callback(request)
    fake.hooks[0]!.callback(request)
    expect(request.system.filter((p) => p.text.includes(GUIDANCE_OPEN))).toHaveLength(1)
    expect(request.system).toHaveLength(2)

    const marked: ContextRequest = { system: [{ type: 'text', text: `before\n${GUIDANCE_OPEN}\nold\n</METACOGS_GUIDANCE>` }] }
    fake.hooks[0]!.callback(marked)
    expect(marked.system).toHaveLength(1)
  })

  test('{guidance:false} registers no hook, and the tools, skills and commands stay', async () => {
    const fake = await load({ options: { guidance: false } })
    expect(fake.hooks).toEqual([])
    expect(replay(fake, 'tool')).toHaveLength(2)
    expect(replay(fake, 'skill')).toHaveLength(4)
    expect(replay(fake, 'command')).toHaveLength(4)
  })

  test.each([[{}], [undefined], [null], ['guidance'], [['guidance']], [{ guidance: 'no' }], [{ guidance: true }]])('options %p leave guidance on', async (value) => {
    const fake = await load({ options: value })
    expect(fake.hooks.map((h) => h.name)).toEqual(['context'])
  })
})

describe('setup on a context without a location or session', () => {
  test.each([[undefined], [null], [{}], [{ location: {} }], [{ session: {} }]])('%p registers nothing and does not throw', async (ctx) => {
    await expect(createSetup(DIRS)(ctx)).resolves.toBeUndefined()
    expect(errors).toEqual([])
  })
})

describe('failure containment', () => {
  test('a transform that throws on a replay after setup is caught, logs one value-free line, and another transform still works', async () => {
    const fake = await load()
    const kept: ToolDef[] = []
    const editor = {
      add: (tool: ToolDef) => {
        if (tool.name === 'feel') throw new Error(`${CANARY} for feel`)
        kept.push(tool)
      },
    }
    for (const transform of fake.transforms.tool) expect(() => transform(editor)).not.toThrow()
    expect(errors).toEqual(['metacogs: tool feel failed'])
    expect(kept.map((t) => t.name)).toEqual(['drugs'])

    expect(replay<SkillRecord>(fake, 'skill')).toHaveLength(4)
    expect(errors.join('\n')).not.toContain(CANARY)
  })

  test('a transform handed a broken editor is caught, whatever the part, and logs nothing but metacogs lines', async () => {
    const fake = await load()
    for (const kind of ['tool', 'skill', 'command'] as const) for (const transform of fake.transforms[kind]) expect(() => transform(undefined)).not.toThrow()
    expect(errors.length).toBeGreaterThan(0)
    for (const line of errors) expect(line).toMatch(/^metacogs: [\w ]+ failed$/)
  })

  test('a guidance callback that throws is caught and the request goes on without the block', async () => {
    const fake = await load()
    const request = { system: null } as unknown as ContextRequest
    expect(() => fake.hooks[0]!.callback(request)).not.toThrow()
    expect(errors).toEqual(['metacogs: guidance failed'])
    expect(request.system).toBeNull()
  })

  test('a rejected registration is reported once and costs only that registration', async () => {
    for (const reject of ['tool', 'skill', 'command', 'hook'] as const) {
      errors.length = 0
      const fake = await load({ reject })
      expect(errors).toEqual([`metacogs: ${reject === 'hook' ? 'guidance' : reject} registration failed`])
      expect(errors.join('\n')).not.toContain(CANARY)
      expect(fake.transforms.tool.length).toBe(reject === 'tool' ? 0 : 1)
      expect(fake.transforms.skill.length).toBe(reject === 'skill' ? 0 : 1)
      expect(fake.transforms.command.length).toBe(reject === 'command' ? 0 : 1)
      expect(fake.hooks.length).toBe(reject === 'hook' ? 0 : 1)
    }
  })
})
