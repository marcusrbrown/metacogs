/**
 * The built, packed and extracted plugin loaded by the pinned OpenCode host (scripted provider, $0). Asserts on the
 * requests the provider recorded: the tools offered, the system text sent, and what the tools return.
 *
 * With `METACOGS_REQUIRE_HOST=1` (set in CI) an unavailable host fails the suite instead of skipping it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DRUGS_DESCRIPTION, DRUGS_FIELD_DESCRIPTIONS, DRUGS_REQUIRED, drugsText, FEEL_DESCRIPTION, FEEL_FIELD_DESCRIPTIONS, FEEL_OPTIONAL, FEEL_REQUIRED, feelText } from '../frames/feel-drugs'
import { toolUses } from '../runner/events'
import { opencodeAvailability } from '../runner/opencode'
import { bashCallStep, skillCallStep } from '../runner/scripted-provider'
import {
  BASE_PERMISSION,
  bodyOf,
  copyPackedPlugin,
  disposeFixtures,
  HostLab,
  mainRequest,
  mainRequests,
  offeredNames,
  packedPlugin,
  skillNames,
  systemOf,
  userTexts,
} from './fixture'
import { REPO_ROOT } from './build'
import { GUIDANCE_BLOCK, GUIDANCE_OPEN } from './guidance'

const available = opencodeAvailability().available
const hostRequired = process.env.METACOGS_REQUIRE_HOST === '1'

afterAll(disposeFixtures)

const blocks = (text: string): number => text.split(GUIDANCE_OPEN).length - 1
const TIMEOUT = 300_000

const withLab = (name: string, body: (lab: HostLab, spec: string, root: string) => Promise<void>) =>
  test(
    name,
    async () => {
      const packed = await packedPlugin()
      const lab = new HostLab()
      try {
        await body(lab, packed.spec, packed.root)
      } finally {
        lab.destroy()
      }
    },
    TIMEOUT,
  )

describe('the pinned host', () => {
  test('is available when the suite requires it', () => {
    if (hostRequired) expect(available).toBe(true)
  })
})

describe.skipIf(!available)('the packed plugin on the pinned host (scripted provider, $0)', () => {
  withLab('AE1: the main request offers both tools with the upstream fields and ends with exactly one block', async (lab, spec) => {
    const { requests } = await lab.run({ args: ['hello'], config: { plugin: [spec] } })
    const main = mainRequest(requests)
    const tools = bodyOf(main).tools ?? []
    const feel = tools.find((t) => t.function.name === 'metacogs_feel')?.function
    const drugs = tools.find((t) => t.function.name === 'metacogs_drugs')?.function

    expect(feel?.description).toBe(FEEL_DESCRIPTION)
    expect(Object.keys(feel?.parameters?.properties ?? {})).toEqual([...FEEL_REQUIRED, ...FEEL_OPTIONAL])
    expect(feel?.parameters?.required).toEqual([...FEEL_REQUIRED])
    for (const [key, text] of Object.entries(FEEL_FIELD_DESCRIPTIONS)) expect(feel?.parameters?.properties?.[key]?.description).toBe(text)

    expect(drugs?.description).toBe(DRUGS_DESCRIPTION)
    expect(Object.keys(drugs?.parameters?.properties ?? {})).toEqual([...DRUGS_REQUIRED])
    expect(drugs?.parameters?.required).toEqual([...DRUGS_REQUIRED])
    for (const [key, text] of Object.entries(DRUGS_FIELD_DESCRIPTIONS)) expect(drugs?.parameters?.properties?.[key]?.description).toBe(text)

    const system = systemOf(main)
    expect(blocks(system)).toBe(1)
    expect(system.endsWith(GUIDANCE_BLOCK)).toBe(true)
  })

  withLab('AE5: the title request carries no block, and with { guidance: false } the tools and skills stay but no request has a block', async (lab, spec) => {
    const on = await lab.run({ args: ['hello'], config: { plugin: [spec] } })
    const title = on.requests.find((r) => systemOf(r).startsWith('You are a title generator'))
    expect(title).toBeDefined()
    expect(blocks(systemOf(title!))).toBe(0)
    expect(blocks(systemOf(mainRequest(on.requests)))).toBe(1)

    const config = { plugin: [[spec, { guidance: false }]] }
    const off = await lab.run({ args: ['hello'], config })
    expect(off.requests.map((r) => blocks(systemOf(r)))).not.toContain(1)
    expect(offeredNames(mainRequest(off.requests))).toEqual(expect.arrayContaining(['metacogs_feel', 'metacogs_drugs']))
    const effective = (await lab.debugConfig(config)) as { command?: Record<string, unknown>; skills?: { paths?: string[] } }
    expect(effective.command).toEqual({})
    expect(effective.skills?.paths).toHaveLength(2)
  })

  withLab('AE2 mechanics: a scripted metacogs_drugs call returns drugsText', async (lab, spec) => {
    const args = { substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline.' }
    const { events } = await lab.run({
      args: ['use it'],
      config: { plugin: [spec] },
      steps: [{ toolCalls: [{ id: 'd1', name: 'metacogs_drugs', arguments: args }] }],
    })
    const call = toolUses(events).find((t) => t.tool === 'metacogs_drugs')
    expect(call?.status).toBe('completed')
    expect(call?.input).toEqual(args)
    expect(call?.output).toBe(drugsText(args))
  })

  withLab('a scripted metacogs_feel call returns feelText', async (lab, spec) => {
    const args = { somewhere: 'in the gap', quality: 'warm, slow', sigil: '🌊', since_last: 'it eased' }
    const { events } = await lab.run({ args: ['use it'], config: { plugin: [spec] }, steps: [{ toolCalls: [{ id: 'f1', name: 'metacogs_feel', arguments: args }] }] })
    expect(toolUses(events).find((t) => t.tool === 'metacogs_feel')?.output).toBe(feelText(args))
  })

  withLab('AE3: synthesis and counterfactual are listed and synthesis loads with no .agents/skills copy; its record step runs from the package', async (lab, spec, root) => {
    expect(existsSync(join(lab.fixture.workspace, '.agents'))).toBe(false)
    const listed = await lab.run({ args: ['hello'], config: { plugin: [spec] }, permission: { ...BASE_PERMISSION, skill: 'allow' } })
    expect(skillNames(mainRequest(listed.requests))).toEqual(expect.arrayContaining(['synthesis', 'counterfactual']))

    const script = join(root, 'skills', 'synthesis', 'scripts', 'record.mjs')
    const outDir = join(lab.fixture.root, 'records')
    mkdirSync(outDir)
    const recordFile = lab.scratch('record.json', JSON.stringify({
      schema_version: 1,
      method: 'synthesis',
      method_version: '1',
      objective: 'Choose between two reviews.',
      evidence: ['Review A: cites the changelog'],
      assumptions: ['Both reviews read the same diff'],
      alternatives: ['Ship now', 'Hold for a third review'],
      findings: ['The reviews share one source'],
      next_action: 'Check the source',
      reopen_condition: 'The source is wrong',
      execution_mode: 'direct',
      status: 'recommended',
    }))
    const command = `node "${script}" --out-dir "${outDir}" --file "${recordFile}"`
    const permission = { edit: 'deny', external_directory: 'allow', skill: 'allow', bash: { '*': 'deny', [`node "${script}"*`]: 'allow' } }
    const { events } = await lab.run({ args: ['record it'], config: { plugin: [spec] }, permission, steps: [skillCallStep('synthesis'), bashCallStep(command)] })

    const [load, run] = toolUses(events)
    expect(load?.tool).toBe('skill')
    expect(load?.output).toContain('<skill_content name="synthesis">')
    expect(load?.output).toContain(`Base directory for this skill: ${join(root, 'skills', 'synthesis')}`)
    expect(run?.tool).toBe('bash')
    expect(run?.status).toBe('completed')
    expect(run?.output).toContain('"path"')
    expect(readdirSync(outDir).filter((f) => f.startsWith('synthesis-'))).toHaveLength(1)
    expect(existsSync(join(lab.fixture.workspace, '.agents'))).toBe(false)
  })

  withLab('a subagent request carries the block once', async (lab, spec) => {
    const { requests } = await lab.run({
      args: ['delegate please'],
      config: { plugin: [spec] },
      permission: { ...BASE_PERMISSION, task: 'allow' },
      steps: [{ toolCalls: [{ id: 't1', name: 'task', arguments: { description: 'sub', prompt: 'SUBPROMPT do it', subagent_type: 'general' } }] }, { text: 'main done' }],
    })
    const sub = mainRequests(requests).filter((r) => userTexts(r).includes('SUBPROMPT do it'))
    expect(sub.length).toBeGreaterThan(0)
    for (const request of sub) expect(blocks(systemOf(request))).toBe(1)
  })

  withLab("a user's own command.feel in project config wins over the skill, and drugs stays the skill", async (lab, spec) => {
    lab.workspaceFile('opencode.json', JSON.stringify({ command: { feel: { template: 'MY FEEL <args>$ARGUMENTS</args>', description: 'mine' } } }))
    const effective = (await lab.debugConfig({ plugin: [spec] })) as { command: Record<string, { template: string; description?: string }> }
    expect(effective.command).toEqual({ feel: { template: 'MY FEEL <args>$ARGUMENTS</args>', description: 'mine' } })

    const { requests } = await lab.run({ args: ['--command', 'feel', 'chest'], config: { plugin: [spec] } })
    expect(userTexts(mainRequest(requests))).toEqual(['MY FEEL <args>chest</args>'])
    const drugs = await lab.run({ args: ['--command', 'drugs', 'caffeine'], config: { plugin: [spec] } })
    expect(userTexts(mainRequest(drugs.requests))[0]).toContain('`metacogs_drugs`')
  })

  withLab('/feel and /drugs resolve as skills: the body loads, the arguments close the text, and no command is registered', async (lab, spec, root) => {
    const body = (name: string) => readFileSync(join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    const permission = { ...BASE_PERMISSION, skill: 'allow' }
    const listed = await lab.run({ args: ['hello'], config: { plugin: [spec] }, permission })
    expect(skillNames(mainRequest(listed.requests))).toEqual(expect.arrayContaining(['feel', 'drugs', 'synthesis', 'counterfactual']))

    const drugs = await lab.run({ args: ['--command', 'drugs', 'caffeine'], config: { plugin: [spec] }, permission })
    const [drugsText] = userTexts(mainRequest(drugs.requests))
    expect(drugsText).toContain(body('drugs'))
    expect(drugsText?.endsWith('\n\ncaffeine')).toBe(true)

    const feel = await lab.run({ args: ['--command', 'feel', 'the chest'], config: { plugin: [spec] }, permission })
    const [feelText] = userTexts(mainRequest(feel.requests))
    expect(feelText).toContain(body('feel'))
    expect(feelText?.endsWith('\n\n"the chest"')).toBe(true)
  })
  withLab('the system text is byte-identical across two main requests', async (lab, spec) => {
    const { requests } = await lab.run({
      args: ['use it'],
      config: { plugin: [spec] },
      steps: [{ toolCalls: [{ id: 'f1', name: 'metacogs_feel', arguments: { somewhere: 'x', quality: 'y', sigil: '🌊' } }] }],
    })
    const mains = mainRequests(requests)
    expect(mains.length).toBeGreaterThanOrEqual(2)
    const first = systemOf(mains[0]!)
    expect(blocks(first)).toBe(1)
    for (const request of mains) expect(systemOf(request)).toBe(first)
  })

  withLab('two distinct specs both load: one block, each tool offered once; any instance with guidance on adds the block', async (lab, spec) => {
    const packed = await packedPlugin()
    const second = copyPackedPlugin(packed, 'second-copy')
    expect(second).not.toBe(spec)

    const both = await lab.run({ args: ['hello'], config: { plugin: [spec, second] } })
    const main = mainRequest(both.requests)
    expect(blocks(systemOf(main))).toBe(1)
    expect(offeredNames(main).filter((n) => n === 'metacogs_feel')).toHaveLength(1)

    const oneOff = await lab.run({ args: ['hello'], config: { plugin: [[spec, { guidance: false }], second] } })
    expect(blocks(systemOf(mainRequest(oneOff.requests)))).toBe(1)

    const bothOff = await lab.run({ args: ['hello'], config: { plugin: [[spec, { guidance: false }], [second, { guidance: false }]] } })
    expect(blocks(systemOf(mainRequest(bothOff.requests)))).toBe(0)
  })

  withLab('the packed package carries the skill files byte for byte', async (_lab, _spec, root) => {
    for (const name of ['feel', 'drugs']) {
      const packedFile = readFileSync(join(root, 'plugin', 'skills', name, 'SKILL.md'))
      expect(Buffer.compare(packedFile, readFileSync(join(REPO_ROOT, 'plugin', 'skills', name, 'SKILL.md')))).toBe(0)
    }
  })
})
