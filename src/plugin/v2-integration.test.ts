/** The packed plugin on the pinned OpenCode v2 CLI (scripted provider). Gated by `METACOGS_HOST_V2=1`; asserts from recorded requests. */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { REPO_ROOT } from './build'
import { disposeFixtures, packedPlugin } from './fixture'
import { GUIDANCE_OPEN } from './guidance'
import {
  bodyOf,
  GENERATE_PROMPT_PREFIX,
  guidanceCount,
  hostV2Enabled,
  installedCli,
  kindOf,
  ofKind,
  offeredNames,
  groupAlive,
  reapAll,
  survivingGroups,
  systemOf,
  textOf,
  toolResults,
  until,
  userTexts,
  V2_PIN,
  V2Lab,
  type V2LabOptions,
  type V2Run,
  type V2Server,
} from './v2-host'

const TIMEOUT = 300_000
const SKILLS = ['feel', 'drugs', 'synthesis', 'counterfactual']
const SKILL_DIRS: Record<string, string> = { feel: 'plugin/skills/feel', drugs: 'plugin/skills/drugs', synthesis: 'skills/synthesis', counterfactual: 'skills/counterfactual' }

/** A skill's first heading, read from its own `SKILL.md`: one stable body line to find in what the host delivers. */
const headingOf = (name: string): string => readFileSync(join(REPO_ROOT, SKILL_DIRS[name]!, 'SKILL.md'), 'utf8').split('\n').find((line) => line.startsWith('# ')) ?? ''
const hasLine = (text: string | undefined, line: string): boolean => line !== '' && (text ?? '').split('\n').includes(line)
const SUMMARY_MARKER = 'scripted-summary-marker'
/** A summary in the host's template; without every heading the host asks again and then keeps the full history. */
const SUMMARY = ['## Objective', `- Run the loop (${SUMMARY_MARKER}).`, '', '## Requirements', '- (none)', '', '## Decisions', '- (none)', '', '## Work State', '### Completed', '- (none)', '', '### Active', '- (none)', '', '### Blocked', '- (none)', '', '## Next Move', '1. (none)', '', '## Relevant Files', '(none)', '', '## Important Context', '- (none)'].join('\n')

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

/** Asserts a serve-driven call got a 2xx and returns it. */
async function ok(response: Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }> {
  const result = await response
  expect(result.status).toBeGreaterThanOrEqual(200)
  expect(result.status).toBeLessThan(300)
  return result
}

/** Asserts `opencode run` exited 0 and returns the run. */
function exitedZero(run: V2Run): V2Run {
  expect(run.exitCode).toBe(0)
  return run
}

async function newSession(server: V2Server): Promise<string> {
  const { body } = await ok(server.call('POST', '/api/session', {}))
  return (body as { data: { id: string } }).data.id
}

const idle = (server: V2Server, session: string) => ok(server.call('POST', `/api/experimental/session/${session}/wait`, {}))

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

  test('a generate request is told by its prompt, though it offers the same tools as the agent loop', () => {
    expect(kindOf(req([SYSTEM, { role: 'user', content: 'hi' }, { role: 'user', content: `${GENERATE_PROMPT_PREFIX} name it` }], ['feel']))).toBe('generate')
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

describe('the pinned v2 host gate', () => {
  test('is enabled when the suite requires it: a dropped METACOGS_HOST_V2 cannot leave the host tests skipped', () => {
    if (process.env.METACOGS_REQUIRE_HOST_V2 === '1') expect(hostV2Enabled).toBe(true)
  })
})

describe.skipIf(!hostV2Enabled)(`the packed plugin on the pinned OpenCode v2 CLI (scripted provider, $0)`, () => {
  test(`the CLI reports opencode v${V2_PIN}`, () => {
    const run = spawnSync(installedCli(), ['--version'], { encoding: 'utf8', timeout: 60_000 })
    expect(run.stdout.trim()).toBe(`opencode v${V2_PIN}`)
  }, TIMEOUT)

  withLab('load and schema: feel and drugs are offered with the v1 fields, descriptions and required set', async (lab, plugin) => {
    const { requests } = exitedZero(await lab.run('hello', { config: plugin() }))
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
    const { requests } = exitedZero(
      await lab.run('use them', {
        config: plugin(),
        steps: [call('f1', 'feel', FEEL_ARGS), call('d1', 'drugs', DRUGS_ARGS)],
      }),
    )
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
      const users = (messages as { role: string; content: unknown }[]).filter((m) => m.role === 'user').map((m) => textOf(m.content))
      const last = users.at(-1) ?? ''
      if (last.startsWith('You MUST summarize') || last.startsWith('The previous response did not fill')) return { text: SUMMARY }
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
      await ok(server.call('POST', `/api/session/${session}/prompt`, { text: 'run the loop' }))
      await idle(server, session)
      // Both subagent results (the new child and its continuation) are in one request: the parent's last round has run.
      await until('both subagent results', () => (server.requests.some((r) => toolResults(r).filter((t) => t.includes('child done')).length >= 2) ? true : undefined))

      expect((await ok(server.call('POST', `/api/session/${session}/compact`, {}))).status).toBe(200)
      await idle(server, session)
      await until('the compaction request', () => (ofKind(server.requests, 'compaction').length > 0 ? true : undefined))

      await ok(server.call('POST', `/api/session/${session}/prompt`, { text: 'carry on' }))
      await idle(server, session)
      await until('the request after compaction', () => (server.requests.some((r) => userTexts(r).includes('carry on')) ? true : undefined))

      expect((await ok(server.call('POST', `/api/session/${session}/generate`, { prompt: `${GENERATE_PROMPT_PREFIX} name this session` }))).status).toBe(200)
      await until('the generate request', () => (ofKind(server.requests, 'generate').length > 0 ? true : undefined))

      // The occurrences are asserted before the absences, so a classifier that matched nothing cannot pass.
      const compaction = ofKind(server.requests, 'compaction')
      const title = ofKind(server.requests, 'title')
      const generate = ofKind(server.requests, 'generate')
      const agent = agentRequests(server.requests)
      expect(compaction.length).toBeGreaterThan(0)
      expect(title.length).toBeGreaterThan(0)
      expect(generate.length).toBeGreaterThan(0)
      const subagent = agent.filter((r) => userTexts(r).some((u) => u.includes(SUB)))
      expect(subagent.length).toBeGreaterThanOrEqual(4)
      const carryOn = agent.filter((r) => userTexts(r).includes('carry on'))
      expect(carryOn.length).toBeGreaterThan(0)
      // Compaction completed: the scripted summary is in the history the next request carries.
      expect(JSON.stringify(bodyOf(carryOn[0]!).messages)).toContain(SUMMARY_MARKER)

      for (const request of agent) expect(guidanceCount(request)).toBe(1)
      // Every request that is not the agent loop carries no block: title, compaction, generate, and anything unclassified.
      const others = server.requests.filter((r) => kindOf(r) !== 'agent')
      for (const request of others) expect(guidanceCount(request)).toBe(0)
    } finally {
      await server.stop()
    }
  })

  withLab('guidance: false offers the tools and skills and puts no block on any request', async (lab, plugin) => {
    const { requests } = exitedZero(await lab.run('use it', { config: plugin({ guidance: false }), steps: [call('f1', 'feel', FEEL_ARGS)] }))
    const agent = agentRequests(requests)
    expect(agent.length).toBeGreaterThanOrEqual(2)
    expect(offeredNames(agent[0]!)).toEqual(expect.arrayContaining(['feel', 'drugs']))
    expect(ofKind(requests, 'title').length).toBeGreaterThan(0)
    for (const request of requests) expect(guidanceCount(request)).toBe(0)
  })

  withLab('skills: the skill tool loads counterfactual and prints a base directory that holds scripts/record.mjs', async (lab, plugin, root) => {
    const { requests } = exitedZero(await lab.run('load it', { config: plugin(), steps: [call('s1', 'skill', { id: 'counterfactual' }), call('s2', 'skill', { id: 'feel' })] }))
    const [counterfactual, feel] = toolResults(agentRequests(requests).at(-1)!)
    expect(counterfactual).toContain('<skill_content name="counterfactual">')
    expect(hasLine(counterfactual, headingOf('counterfactual'))).toBe(true)
    expect(hasLine(feel, headingOf('feel'))).toBe(true)
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
      expect(commands.find((c) => c.name === 'drugs')?.description).toBeTruthy()
      const session = await newSession(server)
      expect((await ok(server.call('POST', `/api/session/${session}/command`, { name: 'drugs', text: 'caffeine' }))).status).toBe(204)
      await idle(server, session)
      const [text] = userTexts(agentRequests(server.requests)[0]!)
      expect(text?.startsWith('<skill_content name="drugs">')).toBe(true)
      expect(text).toContain('Base directory for this skill:')
      expect(hasLine(text, headingOf('drugs'))).toBe(true)
      expect(text?.endsWith('caffeine')).toBe(true)
      // The server's password line is redacted in everything the harness can show.
      expect(server.output()).toContain('server password <redacted>')
    } finally {
      await server.stop()
    }
  })

  withLab('commands: multi-word args reach the model raw and unquoted after the drugs skill', async (lab, plugin) => {
    const server = await lab.serve({ config: plugin() })
    try {
      await commandsLoaded(server)
      const session = await newSession(server)
      await ok(server.call('POST', `/api/session/${session}/command`, { name: 'drugs', text: 'strong black coffee' }))
      await idle(server, session)
      const [text] = userTexts(agentRequests(server.requests)[0]!)
      expect(text?.startsWith('<skill_content name="drugs">')).toBe(true)
      expect(hasLine(text, headingOf('drugs'))).toBe(true)
      expect(text?.endsWith('strong black coffee')).toBe(true)
      expect(text).not.toContain('"strong black coffee"')
    } finally {
      await server.stop()
    }
  })

  withLab('commands: empty args deliver the feel skill with no trailing argument text and no undefined', async (lab, plugin) => {
    const server = await lab.serve({ config: plugin() })
    try {
      await commandsLoaded(server)
      const session = await newSession(server)
      await ok(server.call('POST', `/api/session/${session}/command`, { name: 'feel', text: '' }))
      await idle(server, session)
      const [text] = userTexts(agentRequests(server.requests)[0]!)
      expect(text?.startsWith('<skill_content name="feel">')).toBe(true)
      expect(hasLine(text, headingOf('feel'))).toBe(true)
      expect(text?.endsWith('</skill_content>')).toBe(true)
      expect(text).not.toContain('undefined')
    } finally {
      await server.stop()
    }
  })

  withLab("commands: a user's own command.feel wins over the plugin's, and drugs stays the skill", async (lab, plugin) => {
    const server = await lab.serve({ config: { ...plugin(), command: { feel: { template: 'MY FEEL $ARGUMENTS', description: 'mine' } } } })
    try {
      // The list can be read before the user's command has replaced the plugin's, so poll for the replacement.
      const commands = await until("the user's command.feel", async () => {
        const list = await commandsLoaded(server)
        return list.find((c) => c.name === 'feel')?.description === 'mine' ? list : undefined
      })
      expect(commands.find((c) => c.name === 'feel')?.description).toBe('mine')
      const session = await newSession(server)
      await ok(server.call('POST', `/api/session/${session}/command`, { name: 'feel', text: 'chest' }))
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
      await ok(server.call('POST', `/api/session/${session}/command`, { name: 'drugs', text: 'caffeine' }))
      await idle(server, session)
      const request = agentRequests(server.requests)[0]!
      expect(userTexts(request)[0]?.startsWith('<skill_content name="drugs">')).toBe(true)
      expect(hasLine(userTexts(request)[0], headingOf('drugs'))).toBe(true)
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
    const { requests } = exitedZero(await lab.run('load it', { config, steps: [call('s1', 'skill', { id: 'feel' })] }))
    const agent = agentRequests(requests)
    expect(offeredNames(agent[0]!)).not.toContain('feel')
    expect(offeredNames(agent[0]!)).toContain('drugs')
    expect(toolResults(agent.at(-1)!)[0]).toContain('<skill_content name="feel">')
    expect(hasLine(toolResults(agent.at(-1)!)[0], headingOf('feel'))).toBe(true)
  })

  withLab('name separation: denying skill feel makes the skill tool refuse it, and tool feel stays offered', async (lab, plugin) => {
    const config: V2LabOptions['config'] = { ...plugin(), permissions: [{ action: 'skill', resource: 'feel', effect: 'deny' }] }
    const { requests } = exitedZero(await lab.run('load it', { config, steps: [call('s1', 'skill', { id: 'feel' })] }))
    const agent = agentRequests(requests)
    expect(offeredNames(agent[0]!)).toContain('feel')
    const [refused] = toolResults(agent.at(-1)!)
    expect(refused).toContain('permission.rejected')
    expect(refused).not.toContain('<skill_content')
  })

  test('SIGTERM to a process holding a server kills the server group, and the signal still ends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-v2-signal-'))
    const script = join(dir, 'hold.ts')
    writeFileSync(
      script,
      [`import { V2Lab } from ${JSON.stringify(join(REPO_ROOT, 'src', 'plugin', 'v2-host'))}`, 'const lab = new V2Lab()', 'const server = await lab.serve({})', 'console.log(`READY ${server.pid} ${lab.fixture.root}`)', 'await new Promise(() => {})'].join('\n'),
    )
    const holder = spawn('bun', ['run', script], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    let pgid: number | undefined
    let fixtureRoot: string | undefined
    try {
      let out = ''
      holder.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()))
      await until('the holder to serve', () => {
        const match = /READY (\d+) (\S+)/.exec(out)
        if (match) {
          pgid = Number(match[1])
          fixtureRoot = match[2]
        }
        return match ? true : undefined
      })
      const exited = new Promise<NodeJS.Signals | null>((resolve) => holder.once('exit', (_code, signal) => resolve(signal)))
      expect(groupAlive(pgid!)).toBe(true)
      holder.kill('SIGTERM')
      expect(await exited).toBe('SIGTERM')
      await until('the server group to end', () => (groupAlive(pgid!) ? undefined : true), 15_000)
    } finally {
      holder.kill('SIGKILL')
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }, TIMEOUT)

  test('no host process survives the suite', async () => {
    // Every lab stopped its own children; nothing is reaped here, so a leak shows.
    expect(survivingGroups()).toEqual([])
  })
})
