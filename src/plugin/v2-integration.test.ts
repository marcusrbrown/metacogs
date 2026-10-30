/**
 * The built, packed and extracted plugin loaded by the pinned OpenCode v2 CLI (scripted provider, $0). Every assertion
 * reads what the provider recorded. The exit code is never evidence: a plugin the host skips still exits 0, so each test
 * first asserts that the plugin registered.
 *
 * Gated by `METACOGS_HOST_V2=1`: `check` and `prepublishOnly` have no v2 CLI. When the gate is set, a CLI that cannot be
 * installed fails the suite instead of skipping it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
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
import type { RecordedRequest, ScriptRequest, ScriptedStep } from '../runner/scripted-provider'
import { disposeFixtures, packedPlugin } from './fixture'
import { GUIDANCE_OPEN } from './guidance'
import {
  bodyOf,
  guidanceCount,
  hostV2Enabled,
  installedCli,
  kindOf,
  ofKind,
  offeredNames,
  reapAll,
  survivingGroups,
  systemOf,
  toolResults,
  until,
  userTexts,
  V2_PIN,
  V2Lab,
  type V2LabOptions,
  type V2Server,
} from './v2-host'

const TIMEOUT = 300_000
const SKILLS = ['feel', 'drugs', 'synthesis', 'counterfactual']

afterAll(async () => {
  await reapAll()
  disposeFixtures()
})

const call = (id: string, name: string, args: Record<string, unknown>): ScriptedStep => ({ toolCalls: [{ id, name, arguments: args }] })
const FEEL_ARGS = { somewhere: 'in the gap', quality: 'warm, slow', sigil: '🌊', since_last: 'it eased' }
const DRUGS_ARGS = { substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline.' }

/** A lab with the packed plugin configured. `plugin` options go to `plugins[].options`. */
function withLab(name: string, body: (lab: V2Lab, plugin: (options?: Record<string, unknown>) => { plugins: unknown[] }, root: string) => Promise<void>) {
  test(
    name,
    async () => {
      const packed = await packedPlugin()
      const lab = new V2Lab()
      try {
        // A bare absolute directory is what loads a packed package: `file://<dir>` works too, but the entry file's URL is skipped.
        await body(lab, (options) => ({ plugins: [{ package: packed.root, ...(options ? { options } : {}) }] }), packed.root)
      } finally {
        lab.destroy()
      }
    },
    TIMEOUT,
  )
}

/** The requests that carry the agent loop: the registration check every test starts with. */
function agentRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  const found = ofKind(requests, 'agent')
  expect(found.length).toBeGreaterThan(0)
  return found
}

/** The skills the model was shown: the `<name>` entries of the skill list in the system text. */
const skillNamesOf = (request: RecordedRequest): string[] => [...systemOf(request).matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '')

/** `GET /api/command` until the plugin's commands appear (the plugin loads lazily, on the first API request). */
async function commandsLoaded(server: V2Server): Promise<{ name: string; description?: string }[]> {
  return until('the plugin commands', async () => {
    const { body } = await server.call('GET', '/api/command')
    const data = (body as { data?: { name: string; description?: string }[] }).data ?? []
    return SKILLS.every((skill) => data.some((c) => c.name === skill)) ? data : undefined
  })
}

async function newSession(server: V2Server): Promise<string> {
  const { body } = await server.call('POST', '/api/session', {})
  return (body as { data: { id: string } }).data.id
}

const idle = (server: V2Server, session: string) => server.call('POST', `/api/experimental/session/${session}/wait`, {})

// ── always on: the classifier the host tests rely on ────────────────────────

const req = (messages: unknown[], tools: string[] = []): RecordedRequest => ({
  hasTools: tools.length > 0,
  round: 0,
  body: { messages, tools: tools.map((name) => ({ function: { name } })) },
})
const SYSTEM = { role: 'system', content: 'You are an AI agent running in OpenCode, a coding agent harness.' }

describe('request classification', () => {
  test('a title request is told by its system text', () => {
    expect(kindOf(req([{ role: 'system', content: 'You name conversations so the user can find them.' }, { role: 'user', content: 'hi' }]))).toBe('title')
  })

  test('a compaction request is told by its last user message, with or without tools, and not by the agent prompt it shares', () => {
    const summarize = { role: 'user', content: [{ type: 'text', text: 'You MUST summarize the conversation above into a structured summary.' }] }
    expect(kindOf(req([SYSTEM, { role: 'user', content: 'hi' }, summarize]))).toBe('compaction')
    expect(kindOf(req([SYSTEM, { role: 'user', content: 'hi' }, summarize], ['feel']))).toBe('compaction')
    expect(kindOf(req([SYSTEM, summarize, { role: 'user', content: 'The previous response did not fill in the required summary template.' }], ['feel']))).toBe('compaction')
  })

  test('a request that offers tools and is neither is an agent-loop request, and one that offers none is "other"', () => {
    expect(kindOf(req([SYSTEM, { role: 'user', content: 'hi' }], ['feel']))).toBe('agent')
    expect(kindOf(req([SYSTEM, { role: 'user', content: 'hi' }]))).toBe('other')
  })

  test('guidanceCount counts the opening marker wherever it sits', () => {
    expect(guidanceCount(req([{ role: 'system', content: `a ${GUIDANCE_OPEN} b ${GUIDANCE_OPEN}` }]))).toBe(2)
    expect(guidanceCount(req([SYSTEM]))).toBe(0)
  })
})

// ── the pinned host ────────────────────────────────────────────────────────

describe.skipIf(!hostV2Enabled)(`the packed plugin on the pinned OpenCode v2 CLI (scripted provider, $0)`, () => {
  test(`the CLI reports opencode v${V2_PIN}`, () => {
    // `installedCli` throws unless the binary reports exactly `opencode v<pin>`.
    expect(installedCli().endsWith('/node_modules/.bin/opencode')).toBe(true)
  }, TIMEOUT)

  withLab('load and schema: feel and drugs are offered with the v1 fields, descriptions and required set', async (lab, plugin) => {
    const { requests } = await lab.run('hello', { config: plugin() })
    const main = agentRequests(requests)[0]!
    const tools = bodyOf(main).tools ?? []
    const feel = tools.find((t) => t.function.name === 'feel')?.function
    const drugs = tools.find((t) => t.function.name === 'drugs')?.function

    expect(feel?.description).toBe(FEEL_DESCRIPTION)
    expect(Object.keys(feel?.parameters?.properties ?? {})).toEqual([...FEEL_REQUIRED, ...FEEL_OPTIONAL])
    expect(feel?.parameters?.required).toEqual([...FEEL_REQUIRED])
    for (const [key, text] of Object.entries(FEEL_FIELD_DESCRIPTIONS)) expect(feel?.parameters?.properties?.[key]?.description).toBe(text)

    expect(drugs?.description).toBe(DRUGS_DESCRIPTION)
    expect(Object.keys(drugs?.parameters?.properties ?? {})).toEqual([...DRUGS_REQUIRED])
    expect(drugs?.parameters?.required).toEqual([...DRUGS_REQUIRED])
    for (const [key, text] of Object.entries(DRUGS_FIELD_DESCRIPTIONS)) expect(drugs?.parameters?.properties?.[key]?.description).toBe(text)
  })

  withLab('tool call: scripted feel and drugs calls return feelText and drugsText', async (lab, plugin) => {
    const { requests } = await lab.run('use them', {
      config: plugin(),
      steps: [call('f1', 'feel', FEEL_ARGS), call('d1', 'drugs', DRUGS_ARGS)],
    })
    const results = toolResults(agentRequests(requests).at(-1)!)
    expect(results).toEqual([feelText(FEEL_ARGS), drugsText(DRUGS_ARGS)])
  })

  withLab('guidance: one block on every agent-loop request across a tool loop, a subagent and its continuation, and after compaction; none on title or compaction', async (lab, plugin) => {
    const SUB = 'SUBPROMPT'
    const feelCall = (id: string) => call(id, 'feel', { somewhere: 'x', quality: 'y', sigil: '🌊' })
    const parentTool = (name: string, args: Record<string, unknown>, id: string) => call(id, name, args)
    const sessionOf = (messages: readonly unknown[]): string => {
      const tool = [...messages].reverse().find((m) => (m as { role?: string }).role === 'tool') as { content?: unknown } | undefined
      return /ses_[A-Za-z0-9]+/.exec(JSON.stringify(tool?.content ?? ''))?.[0] ?? 'ses_missing'
    }
    const script = ({ messages, hasTools, turn, turnRound }: ScriptRequest): ScriptedStep | undefined => {
      const users = (messages as { role: string; content: unknown }[]).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      const last = users.at(-1) ?? ''
      if (last.startsWith('You MUST summarize') || last.startsWith('The previous response did not fill')) return { text: 'Summary: the goal, what was done, and what comes next.' }
      // A subagent's history holds the parent's prompt as its first user message, so it is told apart by that text.
      if (users.some((u) => u.includes(SUB))) return turnRound === 0 ? feelCall(`c${turn}`) : { text: 'child done' }
      if (!hasTools) return undefined
      if (last.includes('run the loop')) {
        if (turnRound === 0) return feelCall('p0')
        if (turnRound === 1) return parentTool('subagent', { agent: 'general', description: 'sub', prompt: `${SUB} do it` }, 'p1')
        if (turnRound === 2) return parentTool('subagent', { agent: 'general', description: 'sub again', prompt: `${SUB} again`, sessionID: sessionOf(messages) }, 'p2')
        return { text: 'parent done' }
      }
      return { text: 'after compaction' }
    }

    const server = await lab.serve({ config: plugin(), script })
    try {
      await commandsLoaded(server)
      const session = await newSession(server)
      await server.call('POST', `/api/session/${session}/prompt`, { text: 'run the loop' })
      await idle(server, session)
      await until('the parent to finish', () => (server.requests.some((r) => toolResults(r).some((t) => t.includes('child done'))) && agentRequests(server.requests).length >= 8 ? true : undefined))

      expect((await server.call('POST', `/api/session/${session}/compact`, {})).status).toBe(200)
      await idle(server, session)
      await until('the compaction request', () => (ofKind(server.requests, 'compaction').length > 0 ? true : undefined))

      await server.call('POST', `/api/session/${session}/prompt`, { text: 'carry on' })
      await idle(server, session)
      await until('the request after compaction', () => (server.requests.some((r) => userTexts(r).includes('carry on')) ? true : undefined))

      // The occurrences are asserted before the absences, so a classifier that matched nothing cannot pass.
      const compaction = ofKind(server.requests, 'compaction')
      const title = ofKind(server.requests, 'title')
      const agent = agentRequests(server.requests)
      expect(compaction.length).toBeGreaterThan(0)
      expect(title.length).toBeGreaterThan(0)
      const subagent = agent.filter((r) => userTexts(r).some((u) => u.includes(SUB)))
      expect(subagent.length).toBeGreaterThanOrEqual(4)
      expect(agent.filter((r) => userTexts(r).includes('carry on')).length).toBeGreaterThan(0)

      for (const request of agent) expect(guidanceCount(request)).toBe(1)
      for (const request of [...title, ...compaction]) expect(guidanceCount(request)).toBe(0)
    } finally {
      await server.stop()
    }
  })

  withLab('guidance: false offers the tools and skills and puts no block on any request', async (lab, plugin) => {
    const { requests } = await lab.run('use it', { config: plugin({ guidance: false }), steps: [call('f1', 'feel', FEEL_ARGS)] })
    const agent = agentRequests(requests)
    expect(agent.length).toBeGreaterThanOrEqual(2)
    expect(offeredNames(agent[0]!)).toEqual(expect.arrayContaining(['feel', 'drugs']))
    expect(ofKind(requests, 'title').length).toBeGreaterThan(0)
    for (const request of requests) expect(guidanceCount(request)).toBe(0)
  })

  withLab('skills: the skill tool loads counterfactual and prints a base directory that holds scripts/record.mjs', async (lab, plugin, root) => {
    const { requests } = await lab.run('load it', { config: plugin(), steps: [call('s1', 'skill', { id: 'counterfactual' }), call('s2', 'skill', { id: 'feel' })] })
    const [counterfactual, feel] = toolResults(agentRequests(requests).at(-1)!)
    expect(counterfactual).toContain('<skill_content name="counterfactual">')
    const base = /Base directory for this skill: (.+)/.exec(counterfactual ?? '')?.[1]?.trim()
    expect(base).toBe(join(root, 'skills', 'counterfactual'))
    expect(base?.endsWith('skills/counterfactual')).toBe(true)
    expect(existsSync(join(base ?? '', 'scripts', 'record.mjs'))).toBe(true)
    expect(/Base directory for this skill: (.+)/.exec(feel ?? '')?.[1]?.trim()).toBe(join(root, 'plugin', 'skills', 'feel'))

    expect(skillNamesOf(agentRequests(requests)[0]!)).toEqual(expect.arrayContaining(SKILLS))
  })

  withLab('commands: "drugs caffeine" delivers the drugs skill followed by the raw text', async (lab, plugin) => {
    const server = await lab.serve({ config: plugin() })
    try {
      const commands = await commandsLoaded(server)
      expect(commands.find((c) => c.name === 'drugs')?.description).toStartWith('Use when the approach itself needs to change.')
      const session = await newSession(server)
      expect((await server.call('POST', `/api/session/${session}/command`, { name: 'drugs', text: 'caffeine' })).status).toBe(204)
      await idle(server, session)
      const [text] = userTexts(agentRequests(server.requests)[0]!)
      expect(text?.startsWith('<skill_content name="drugs">')).toBe(true)
      expect(text).toContain('Base directory for this skill:')
      expect(text?.endsWith('caffeine')).toBe(true)
      // The server's password line is redacted in everything the harness can show.
      expect(server.output()).toContain('server password <redacted>')
    } finally {
      await server.stop()
    }
  })

  withLab("commands: a user's own command.feel wins over the plugin's, and drugs stays the skill", async (lab, plugin) => {
    const server = await lab.serve({ config: { ...plugin(), command: { feel: { template: 'MY FEEL $ARGUMENTS', description: 'mine' } } } })
    try {
      const commands = await commandsLoaded(server)
      expect(commands.find((c) => c.name === 'feel')?.description).toBe('mine')
      const session = await newSession(server)
      await server.call('POST', `/api/session/${session}/command`, { name: 'feel', text: 'chest' })
      await idle(server, session)
      expect(userTexts(agentRequests(server.requests)[0]!)).toEqual(['MY FEEL chest'])
      expect(commands.find((c) => c.name === 'drugs')?.description).not.toBe('mine')
    } finally {
      await server.stop()
    }
  })

  withLab('commands: with the drugs skill denied, the typed command still delivers it, as on v1', async (lab, plugin) => {
    const permissions = [{ action: 'skill', resource: 'drugs', effect: 'deny' }]
    const server = await lab.serve({ config: { ...plugin(), permissions } })
    try {
      await commandsLoaded(server)
      const session = await newSession(server)
      await server.call('POST', `/api/session/${session}/command`, { name: 'drugs', text: 'caffeine' })
      await idle(server, session)
      const request = agentRequests(server.requests)[0]!
      expect(userTexts(request)[0]?.startsWith('<skill_content name="drugs">')).toBe(true)
      expect(userTexts(request)[0]?.endsWith('caffeine')).toBe(true)
      // Hidden from the model's skill list, though the typed command delivered it.
      expect(skillNamesOf(request)).toEqual(expect.arrayContaining(['feel', 'synthesis', 'counterfactual']))
      expect(skillNamesOf(request)).not.toContain('drugs')
    } finally {
      await server.stop()
    }
  })

  withLab('name separation: denying tool feel leaves skill feel loadable', async (lab, plugin) => {
    const config: V2LabOptions['config'] = { ...plugin(), permissions: [{ action: 'feel', resource: '*', effect: 'deny' }] }
    const { requests } = await lab.run('load it', { config, steps: [call('s1', 'skill', { id: 'feel' })] })
    const agent = agentRequests(requests)
    expect(offeredNames(agent[0]!)).not.toContain('feel')
    expect(offeredNames(agent[0]!)).toContain('drugs')
    expect(toolResults(agent.at(-1)!)[0]).toContain('<skill_content name="feel">')
  })

  withLab('name separation: denying skill feel makes the skill tool refuse it, and tool feel stays offered', async (lab, plugin) => {
    const config: V2LabOptions['config'] = { ...plugin(), permissions: [{ action: 'skill', resource: 'feel', effect: 'deny' }] }
    const { requests } = await lab.run('load it', { config, steps: [call('s1', 'skill', { id: 'feel' })] })
    const agent = agentRequests(requests)
    expect(offeredNames(agent[0]!)).toContain('feel')
    const [refused] = toolResults(agent.at(-1)!)
    expect(refused).toContain('permission.rejected')
    expect(refused).not.toContain('<skill_content')
  })

  test('no host process survives the suite', async () => {
    // Every lab stopped its own children; nothing is reaped here, so a leak shows.
    expect(survivingGroups()).toEqual([])
  })
})
