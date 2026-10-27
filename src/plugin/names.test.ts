/**
 * How the plugin's native tools and its skills of the same names behave on the pinned host (scripted provider, $0): both
 * `feel` and `drugs` exist as a tool and as a skill, and the host keeps the two apart for offering, loading, permissions
 * and plugin order.
 *
 * With `METACOGS_REQUIRE_HOST=1` (set in CI) an unavailable host fails the suite instead of skipping it.
 */
import { afterAll, describe, expect, test } from 'bun:test'

import { drugsText, feelText } from '../frames/feel-drugs'
import { toolUses } from '../runner/events'
import { opencodeAvailability } from '../runner/opencode'
import { skillCallStep } from '../runner/scripted-provider'
import { BASE_PERMISSION, disposeFixtures, HostLab, mainRequest, offeredNames, packedPlugin, skillNames, userTexts } from './fixture'

const available = opencodeAvailability().available

afterAll(disposeFixtures)

const TIMEOUT = 300_000
const permission = (extra: Record<string, unknown> = {}, skill: unknown = 'allow') => ({ ...BASE_PERMISSION, skill, ...extra })

const withLab = (name: string, body: (lab: HostLab, spec: string) => Promise<void>) =>
  test(
    name,
    async () => {
      const packed = await packedPlugin()
      const lab = new HostLab()
      try {
        await body(lab, packed.spec)
      } finally {
        lab.destroy()
      }
    },
    TIMEOUT,
  )

/** A second plugin that registers its own tool under `name` and returns `out`. */
const rivalPlugin = (lab: HostLab, name: string, out: string): string =>
  `file://${lab.scratch(
    `rival-${out}.mjs`,
    `export default { id: 'rival-${out}', server: async () => ({ tool: { ${name}: { description: 'rival ${name}', args: {}, execute: async () => ${JSON.stringify(out)} } } }) }\n`,
  )}`

const feelArgs = { somewhere: 'in the gap', quality: 'warm, slow', sigil: '🌊' }

describe.skipIf(!available)('the native tools and the skills share the names feel and drugs (pinned host, $0)', () => {
  withLab('a. the model is offered tools feel and drugs, and the skill list holds the skills feel and drugs', async (lab, spec) => {
    const { requests } = await lab.run({ args: ['hello'], config: { plugin: [spec] }, permission: permission() })
    const main = mainRequest(requests)
    expect(offeredNames(main)).toEqual(expect.arrayContaining(['feel', 'drugs', 'skill']))
    expect(offeredNames(main).filter((n) => n === 'feel' || n === 'drugs')).toHaveLength(2)
    expect(skillNames(main)).toEqual(expect.arrayContaining(['feel', 'drugs']))
  })

  withLab('b. a scripted feel call runs the tool and returns the frame; a scripted skill call loads the skill instructions', async (lab, spec) => {
    const tool = await lab.run({ args: ['use it'], config: { plugin: [spec] }, permission: permission(), steps: [{ toolCalls: [{ id: 'f1', name: 'feel', arguments: feelArgs }] }] })
    const call = toolUses(tool.events).find((t) => t.tool === 'feel')
    expect(call?.status).toBe('completed')
    expect(call?.output).toBe(feelText(feelArgs))

    const skill = await lab.run({ args: ['load it'], config: { plugin: [spec] }, permission: permission(), steps: [skillCallStep('feel')] })
    const load = toolUses(skill.events).find((t) => t.tool === 'skill')
    expect(load?.status).toBe('completed')
    expect(load?.output).toContain('<skill_content name="feel">')
    expect(load?.output).toContain('Call the `feel` tool (not the `feel` skill')
  })

  withLab('c. --command drugs caffeine loads the skill with the argument at the end', async (lab, spec) => {
    const { requests } = await lab.run({ args: ['--command', 'drugs', 'caffeine'], config: { plugin: [spec] }, permission: permission() })
    const [text = ''] = userTexts(mainRequest(requests))
    expect(text).toContain('# drugs')
    expect(text).toContain('Base directory for this skill:')
    expect(text.trimEnd().endsWith('caffeine')).toBe(true)
  })

  withLab('d. permission feel:deny hides the tool and keeps the skill and /feel; permission.skill feel:deny hides the skill and keeps the tool', async (lab, spec) => {
    const toolDenied = await lab.run({ args: ['--command', 'feel', 'the chest'], config: { plugin: [spec] }, permission: permission({ feel: 'deny' }) })
    const main = mainRequest(toolDenied.requests)
    expect(offeredNames(main)).not.toContain('feel')
    expect(offeredNames(main)).toContain('drugs')
    expect(skillNames(main)).toContain('feel')
    expect(userTexts(main)[0]).toContain('# feel')

    const skillDenied = await lab.run({ args: ['hello'], config: { plugin: [spec] }, permission: permission({}, { '*': 'allow', feel: 'deny' }) })
    const other = mainRequest(skillDenied.requests)
    expect(skillNames(other)).not.toContain('feel')
    expect(skillNames(other)).toContain('drugs')
    expect(offeredNames(other)).toContain('feel')
  })

  withLab('e. a second plugin that registers feel wins when it is later in the plugin list, and loses when it is earlier', async (lab, spec) => {
    const rival = rivalPlugin(lab, 'feel', 'from-rival')
    const run = async (plugin: string[]) => {
      const { events, requests } = await lab.run({ args: ['use it'], config: { plugin }, permission: permission(), steps: [{ toolCalls: [{ id: 'f1', name: 'feel', arguments: feelArgs }] }] })
      return { out: toolUses(events).find((t) => t.tool === 'feel')?.output, offered: offeredNames(mainRequest(requests)).filter((n) => n === 'feel').length }
    }
    expect(await run([spec, rival])).toEqual({ out: 'from-rival', offered: 1 })
    expect(await run([rival, spec])).toEqual({ out: feelText(feelArgs), offered: 1 })
  })

  withLab('drugs is offered and runs under its own name too', async (lab, spec) => {
    const args = { substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline.' }
    const { events } = await lab.run({ args: ['use it'], config: { plugin: [spec] }, permission: permission(), steps: [{ toolCalls: [{ id: 'd1', name: 'drugs', arguments: args }] }] })
    expect(toolUses(events).find((t) => t.tool === 'drugs')?.output).toBe(drugsText(args))
  })
})
