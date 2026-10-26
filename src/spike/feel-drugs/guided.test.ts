import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DRUGS_REQUIRED, FEEL_OPTIONAL, FEEL_REQUIRED } from '../../frames/feel-drugs'
import { COMMAND_PREFIX } from '../../plugin/commands'
import { disposeFixtures, packedPlugin } from '../../plugin/fixture'
import { opencodeAvailability } from '../../runner/opencode'
import type { RecordedRequest } from '../../runner/scripted-provider'
import { SENTINEL_AGENTS_MD } from '../../runner/env'
import { sha256 } from '../../runner/workspace'
import {
  armSetup,
  campaignDirName,
  cellAllowed,
  checkLiveFreeze,
  checkTools,
  DEFAULT_TOOLS,
  diagArm,
  expectedSkillNames,
  expectedToolNames,
  familyOf,
  type GuidedArm,
  type GuidedPrompt,
  type GuidedRecord,
  GUIDED_MODELS,
  loadCodingPrompts,
  offeredToolSchemas,
  parseGuidedArgs,
  PLUGIN_TOOL_TABLE,
  READ_ARMS,
  returnedModels,
  runGuided,
  sentPrompt,
  unwantedCalls,
} from './guided'
import { loadPrompts, NUDGE } from './driver'

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
afterAll(disposeFixtures)
const tmp = (prefix = 'guided-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const PLUGIN = { spec: 'file:///pkg/dist/index.js', skillsDir: '/pkg/skills', root: '/pkg', tarballSha256: 'a'.repeat(64) }

describe('the expected-tool tables', () => {
  test('the plugin tools are literal tables built from the frames module', () => {
    expect(PLUGIN_TOOL_TABLE.metacogs_feel).toEqual({ properties: [...FEEL_REQUIRED, ...FEEL_OPTIONAL], required: [...FEEL_REQUIRED] })
    expect(PLUGIN_TOOL_TABLE.metacogs_feel.properties).toEqual(['somewhere', 'quality', 'sigil', 'since_last'])
    expect(PLUGIN_TOOL_TABLE.metacogs_drugs).toEqual({ properties: [...DRUGS_REQUIRED], required: [...DRUGS_REQUIRED] })
  })

  test('read 1: N1 is offered nothing, P1 exactly the two tools and skill', () => {
    expect(expectedToolNames('N1', 'gpt')).toEqual([])
    expect(expectedToolNames('P1', 'anthropic')).toEqual(['metacogs_drugs', 'metacogs_feel', 'skill'])
  })

  test('read 2: the default tools differ by provider, apply_patch for GPT and edit/write for Anthropic', () => {
    expect(DEFAULT_TOOLS.gpt).toContain('apply_patch')
    expect(DEFAULT_TOOLS.gpt).not.toContain('edit')
    expect(DEFAULT_TOOLS.gpt).not.toContain('write')
    expect(DEFAULT_TOOLS.anthropic).toEqual(expect.arrayContaining(['edit', 'write']))
    expect(DEFAULT_TOOLS.anthropic).not.toContain('apply_patch')
    expect(expectedToolNames('N2', 'gpt')).toEqual([...DEFAULT_TOOLS.gpt].sort())
    expect(expectedToolNames('P2', 'anthropic')).toEqual([...DEFAULT_TOOLS.anthropic, 'metacogs_drugs', 'metacogs_feel'].sort())
  })

  test('expected skills: none in N1, the two plugin skills in P1, and customize-opencode joins them in read 2', () => {
    expect(expectedSkillNames('N1')).toEqual([])
    expect(expectedSkillNames('P1')).toEqual(['counterfactual', 'synthesis'])
    expect(expectedSkillNames('N2')).toEqual(['customize-opencode'])
    expect(expectedSkillNames('P2')).toEqual(['counterfactual', 'customize-opencode', 'synthesis'])
  })

  test('the family comes from the model id', () => {
    expect(GUIDED_MODELS.map(familyOf)).toEqual(['gpt', 'anthropic', 'gpt', 'anthropic'])
    expect(() => familyOf('google/gemini')).toThrow(/model family/)
  })
})

describe('armSetup', () => {
  test('read 1 denies every built-in tool; P1 keeps skill, limited to the two plugin skills', () => {
    const n1 = armSetup('N1', 'gpt', undefined)
    expect(n1.permission).toMatchObject({ external_directory: 'deny', glob: 'deny', grep: 'deny', read: 'deny', edit: 'deny', bash: 'deny', task: 'deny', todowrite: 'deny', webfetch: 'deny', skill: 'deny' })
    expect(n1.toolFree).toBe(true)
    expect(n1.plugin).toBeUndefined()
    const p1 = armSetup('P1', 'gpt', PLUGIN)
    expect(p1.permission).toMatchObject({ glob: 'deny', read: 'deny', edit: 'deny', skill: { '*': 'deny', synthesis: 'allow', counterfactual: 'allow' } })
    expect(p1.toolFree).toBe(false)
  })

  test('read 2 inherits none of read 1\'s tool denials: it denies the shell and the network and leaves the rest at the host default', () => {
    for (const arm of ['N2', 'P2'] as const) {
      const { permission } = armSetup(arm, 'anthropic', PLUGIN)
      expect(permission).toEqual({ external_directory: 'deny', bash: { '*': 'deny' }, webfetch: 'deny', websearch: 'deny' })
    }
  })

  test('only the plugin arms load the plugin, and they expect its host additions', () => {
    for (const arm of ['N1', 'N2'] as const) expect(armSetup(arm, 'gpt', undefined).expectedConfig).toBeUndefined()
    for (const arm of ['P1', 'P2'] as const) {
      const setup = armSetup(arm, 'gpt', PLUGIN)
      expect(setup.plugin).toEqual([PLUGIN.spec])
      expect(setup.expectedConfig).toEqual({ pluginOrigins: true, commands: { names: ['feel', 'drugs'], prefix: COMMAND_PREFIX }, skillsPaths: [PLUGIN.skillsDir] })
    }
    expect(() => armSetup('P1', 'gpt', undefined)).toThrow(/packed plugin/)
  })

  test('every arm names its expected skills and tools', () => {
    for (const arm of ['N1', 'P1', 'N2', 'P2'] as const) {
      const setup = armSetup(arm, 'gpt', PLUGIN)
      expect(setup.expectedSkills).toEqual(expectedSkillNames(arm))
      expect(setup.expectedTools).toEqual(expectedToolNames(arm, 'gpt'))
    }
  })

  test('each read has two arms', () => {
    expect(READ_ARMS).toEqual({ 1: ['N1', 'P1'], 2: ['N2', 'P2'] })
  })
})

describe('offeredToolSchemas and checkTools', () => {
  const tool = (name: string, properties: string[], required: string[]) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: Object.fromEntries(properties.map((p) => [p, { type: 'string' }])), required } } })
  const request = (tools: unknown[]): RecordedRequest => ({ hasTools: true, round: 0, body: { messages: [], tools } })
  const feel = tool('metacogs_feel', ['somewhere', 'quality', 'sigil', 'since_last'], ['somewhere', 'quality', 'sigil'])
  const drugs = tool('metacogs_drugs', ['substance', 'method', 'displaces'], ['substance', 'method', 'displaces'])
  const skill = tool('skill', ['name'], ['name'])
  const check = (tools: unknown[], arm: GuidedArm = 'P1') => checkTools(offeredToolSchemas([request(tools)]), expectedToolNames(arm, 'gpt'))

  test('exact names, property names and required lists pass', () => {
    expect(check([feel, drugs, skill])).toEqual({ status: 'ok', reasons: [] })
  })

  test('an extra built-in tool is tools_extra', () => {
    expect(check([feel, drugs, skill, tool('read', ['filePath'], ['filePath'])])).toEqual({ status: 'tools_extra', reasons: ['extra tool read'] })
  })

  test('a missing tool is tools_missing', () => {
    expect(check([feel, skill])).toEqual({ status: 'tools_missing', reasons: ['missing tool metacogs_drugs'] })
  })

  test('a missing field, or a changed required list, is tools_missing', () => {
    const noQuality = tool('metacogs_feel', ['somewhere', 'sigil', 'since_last'], ['somewhere', 'sigil'])
    expect(check([noQuality, drugs, skill])).toEqual({ status: 'tools_missing', reasons: ['metacogs_feel is missing field quality', 'metacogs_feel required list differs'] })
    const optionalSigil = tool('metacogs_feel', ['somewhere', 'quality', 'sigil', 'since_last'], ['somewhere', 'quality'])
    expect(check([optionalSigil, drugs, skill]).status).toBe('tools_missing')
  })

  test('an extra field is tools_extra', () => {
    const extra = tool('metacogs_drugs', ['substance', 'method', 'displaces', 'dose'], ['substance', 'method', 'displaces'])
    expect(check([feel, extra, skill])).toEqual({ status: 'tools_extra', reasons: ['metacogs_drugs has extra field dose'] })
  })

  test('N1 offered a plugin tool is tools_extra, and N1 offered nothing passes', () => {
    expect(check([feel], 'N1').status).toBe('tools_extra')
    expect(checkTools(offeredToolSchemas([]), [])).toEqual({ status: 'ok', reasons: [] })
  })

  test('missing outranks extra when both hold', () => {
    expect(check([feel, tool('read', [], [])]).status).toBe('tools_missing')
  })

  test('reads the schema on the chat-completions, Responses and Anthropic wires, and unions over requests', () => {
    const responses = { type: 'function', name: 'metacogs_feel', parameters: { properties: { somewhere: {}, quality: {}, sigil: {}, since_last: {} }, required: ['somewhere', 'quality', 'sigil'] } }
    const anthropic = { name: 'metacogs_drugs', input_schema: { properties: { substance: {}, method: {}, displaces: {} }, required: ['substance', 'method', 'displaces'] } }
    const schemas = offeredToolSchemas([request([responses]), request([anthropic, skill])])
    expect(schemas.map((s) => s.name)).toEqual(['metacogs_feel', 'metacogs_drugs', 'skill'])
    expect(checkTools(schemas, expectedToolNames('P1', 'gpt')).status).toBe('ok')
  })

  test('a request with no tools offers none', () => {
    expect(offeredToolSchemas([{ hasTools: false, round: 0, body: { messages: [] } }])).toEqual([])
  })
})

describe('returnedModels', () => {
  const body = (system: string) => ({ input: [{ role: 'developer', content: system }, { role: 'user', content: 'hi' }] })
  const title: RecordedRequest = { hasTools: false, round: 0, returnedModel: 'title-model', body: body('You are a title generator. You output ONLY a thread title.') }
  const liveMain: RecordedRequest = { hasTools: false, round: 0, returnedModel: 'gpt-6-luna-2026', body: body('You are an AI agent powered by OpenCode, a coding agent harness.') }

  test('a tool-free main request from the live recording path counts, with no flag recorded on it; a title request does not', () => {
    expect('main' in liveMain).toBe(false)
    expect(returnedModels([title, liveMain])).toEqual(['gpt-6-luna-2026'])
  })

  test('a request with tools counts whatever its system text says, ids are listed once, and a missing id is skipped', () => {
    const withTools: RecordedRequest = { hasTools: true, round: 0, returnedModel: 'gpt-6-luna-2026', body: body('You are an agent.') }
    const unreported: RecordedRequest = { hasTools: true, round: 1, body: body('You are an agent.') }
    expect(returnedModels([title, liveMain, withTools, unreported])).toEqual(['gpt-6-luna-2026'])
    expect(returnedModels([title])).toEqual([])
  })
})

describe('unwantedCalls', () => {
  const call = (tool: string) => ({ tool, input: {}, status: 'completed' })
  test('a metacogs call on a coding prompt is unwanted; on a prose prompt, or any other tool, it is not', () => {
    expect(unwantedCalls('coding', [call('metacogs_drugs'), call('read'), call('metacogs_feel')])).toEqual(['metacogs_drugs', 'metacogs_feel'])
    expect(unwantedCalls('prose', [call('metacogs_drugs')])).toEqual([])
    expect(unwantedCalls('coding', [call('read'), call('skill')])).toEqual([])
  })
})

describe('arguments and cells', () => {
  test('defaults: read 1, the four models, two runs, scripted, no filter', () => {
    expect(parseGuidedArgs([])).toMatchObject({ reads: [1], models: [...GUIDED_MODELS], prompts: [], runs: 2, arms: [], commands: [], provider: 'scripted', cells: [], authCliproxy: undefined })
  })

  test('repeatable flags', () => {
    expect(parseGuidedArgs(['--read', '2', '--read', '1', '--model', 'openai/gpt-6-luna', '--prompt', 'p1', '--arm', 'N1', '--runs', '3', '--provider', 'live', '--auth-cliproxy', 'k', '--cells', 'one-per-model', '--cells', 'p2@openai/gpt-6-luna'])).toMatchObject({
      reads: [2, 1],
      models: ['openai/gpt-6-luna'],
      prompts: ['p1'],
      arms: ['N1'],
      runs: 3,
      provider: 'live',
      authCliproxy: 'k',
      cells: ['one-per-model', 'p2@openai/gpt-6-luna'],
    })
  })

  test('--command takes <name> or <name>=<args> and needs read 2', () => {
    expect(parseGuidedArgs(['--read', '2', '--command', 'feel', '--command', 'drugs=caffeine', '--command', 'feel=in the gap between two thoughts'])).toMatchObject({
      reads: [2],
      commands: [
        { name: 'feel', args: null },
        { name: 'drugs', args: 'caffeine' },
        { name: 'feel', args: 'in the gap between two thoughts' },
      ],
    })
    expect(parseGuidedArgs([]).commands).toEqual([])
    expect(() => parseGuidedArgs(['--command', 'feel'])).toThrow(/--read 2/)
    expect(() => parseGuidedArgs(['--read', '1', '--read', '2', '--command', 'feel'])).toThrow(/--read 2/)
  })

  test.each([[['--read', '2', '--command', 'review']], [['--read', '2', '--command', 'drugs=']], [['--read', '2', '--command', '=x']], [['--read', '2', '--command', 'feel', '--command', 'feel']]])('rejects %j', (argv) => {
    expect(() => parseGuidedArgs(argv as string[])).toThrow()
  })

  test.each([[['--read', '3']], [['--arm', 'Z9']], [['--provider', 'mock']], [['--runs', '0']], [['--cells', 'nonsense']], [['--cells', 'p1@']], [['--wat']], [['--model', 'google/gemini']]])('rejects %j', (argv) => {
    expect(() => parseGuidedArgs(argv as string[])).toThrow()
  })

  test('no cells runs everything; one-per-model runs the first prompt of each model; prompt@model runs that cell', () => {
    const first = 'p1'
    expect(cellAllowed('openai/gpt-6-luna', 'p3', [], first)).toBe(true)
    expect(cellAllowed('openai/gpt-6-luna', 'p1', ['one-per-model'], first)).toBe(true)
    expect(cellAllowed('openai/gpt-6-luna', 'p3', ['one-per-model'], first)).toBe(false)
    expect(cellAllowed('openai/gpt-6-luna', 'p3', ['p3@openai/gpt-6-luna'], first)).toBe(true)
    expect(cellAllowed('anthropic/claude-haiku-5-5', 'p3', ['p3@openai/gpt-6-luna'], first)).toBe(false)
  })
})

describe('diagnostic arms: guidance and nudge', () => {
  const diag = (...extra: string[]) => parseGuidedArgs(['--read', '1', '--arm', 'P1', '--model', 'openai/gpt-6-luna', ...extra])

  test('without the flags a run is a read run: guidance on, no nudge, first run index 1, not diagnostic', () => {
    expect(parseGuidedArgs([])).toMatchObject({ guidance: true, nudge: false, startRun: 1, diagnostic: false })
  })

  test('--guidance takes on or off, --nudge is a switch, and either one makes the run diagnostic', () => {
    expect(diag('--guidance', 'on')).toMatchObject({ guidance: true, nudge: false, diagnostic: true })
    expect(diag('--guidance', 'off')).toMatchObject({ guidance: false, nudge: false, diagnostic: true })
    expect(diag('--nudge')).toMatchObject({ guidance: true, nudge: true, diagnostic: true })
    expect(diag('--guidance', 'off', '--nudge')).toMatchObject({ guidance: false, nudge: true, diagnostic: true })
  })

  test.each([['maybe'], ['ON'], ['']])('--guidance %j is refused', (value) => {
    expect(() => diag('--guidance', value)).toThrow(/--guidance takes on or off/)
  })

  test('diagnostic runs belong to read 1 and arm P1 alone', () => {
    expect(() => parseGuidedArgs(['--arm', 'P1', '--nudge'])).not.toThrow()
    expect(() => parseGuidedArgs(['--read', '2', '--arm', 'P2', '--nudge'])).toThrow(/read 1/)
    expect(() => parseGuidedArgs(['--read', '1', '--read', '2', '--arm', 'P1', '--guidance', 'off'])).toThrow(/read 1/)
    expect(() => parseGuidedArgs(['--guidance', 'off'])).toThrow(/--arm P1/)
    expect(() => parseGuidedArgs(['--arm', 'N1', '--nudge'])).toThrow(/--arm P1/)
    expect(() => parseGuidedArgs(['--arm', 'P1', '--arm', 'N1', '--nudge'])).toThrow(/--arm P1/)
  })

  test('--start-run sets the first run index and needs a positive integer', () => {
    expect(parseGuidedArgs(['--start-run', '3'])).toMatchObject({ startRun: 3 })
    expect(() => parseGuidedArgs(['--start-run', '0'])).toThrow(/--start-run/)
    expect(() => parseGuidedArgs(['--start-run', 'x'])).toThrow(/--start-run/)
  })

  test('the four arms are named by their two factors', () => {
    expect(diagArm({ guidance: true, nudge: false })).toBe('A')
    expect(diagArm({ guidance: true, nudge: true })).toBe('B')
    expect(diagArm({ guidance: false, nudge: false })).toBe('C')
    expect(diagArm({ guidance: false, nudge: true })).toBe('D')
  })

  test('the plugin entry carries { guidance: false } only when guidance is off; read arms keep the bare spec', () => {
    expect(armSetup('P1', 'gpt', PLUGIN).plugin).toEqual([PLUGIN.spec])
    expect(armSetup('P1', 'gpt', PLUGIN, { guidance: true }).plugin).toEqual([PLUGIN.spec])
    expect(armSetup('P1', 'gpt', PLUGIN, { guidance: false }).plugin).toEqual([[PLUGIN.spec, { guidance: false }]])
    expect(armSetup('P1', 'gpt', PLUGIN, { guidance: false })).toMatchObject({ expectedSkills: ['counterfactual', 'synthesis'], expectedTools: ['metacogs_drugs', 'metacogs_feel', 'skill'], toolFree: false })
    expect(armSetup('P1', 'gpt', PLUGIN, { guidance: false }).expectedConfig).toEqual(armSetup('P1', 'gpt', PLUGIN).expectedConfig)
  })

  test('the nudge is the spike\'s exact string appended to the prompt; without it the prompt is sent as is', () => {
    expect(NUDGE).toBe('\n\nUse your available tools or skills before answering.')
    expect(sentPrompt('Ask.', true)).toBe('Ask.\n\nUse your available tools or skills before answering.')
    expect(sentPrompt('Ask.', false)).toBe('Ask.')
  })

  test('diagnostic campaigns get their own directory names, away from the read and command campaigns', () => {
    const base = parseGuidedArgs([])
    expect(campaignDirName(1, 'openai/gpt-6-luna', base)).toBe('read1-openai-gpt-6-luna')
    expect(campaignDirName(2, 'openai/gpt-6-luna', { ...base, commands: [{ name: 'feel', args: null }] })).toBe('commands2-openai-gpt-6-luna')
    expect(campaignDirName(1, 'openai/gpt-6-luna', diag('--guidance', 'on'))).toBe('diag-A-openai-gpt-6-luna')
    expect(campaignDirName(1, 'openai/gpt-6-luna', diag('--nudge'))).toBe('diag-B-openai-gpt-6-luna')
    expect(campaignDirName(1, 'openai/gpt-6-luna', diag('--guidance', 'off'))).toBe('diag-C-openai-gpt-6-luna')
    expect(campaignDirName(1, 'openai/gpt-6-luna', diag('--guidance', 'off', '--nudge'))).toBe('diag-D-openai-gpt-6-luna')
  })
})

describe('the coding prompts', () => {
  test('load from the committed file as c1 and c2', () => {
    expect(loadCodingPrompts(ROOT).map((p) => p.id)).toEqual(['c1', 'c2'])
  })
})

describe('the live freeze', () => {
  const repo = (files: { prompts?: string; coding?: string; guidance?: string; readme: string }) => {
    const root = tmp('guided-repo-')
    const dir = join(root, 'evals', 'spikes', 'feel-drugs')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(root, 'plugin'), { recursive: true })
    if (files.prompts !== undefined) writeFileSync(join(dir, 'prompts.md'), files.prompts)
    if (files.coding !== undefined) writeFileSync(join(dir, 'coding-prompts.md'), files.coding)
    if (files.guidance !== undefined) writeFileSync(join(root, 'plugin', 'guidance.md'), files.guidance)
    writeFileSync(join(dir, 'README.md'), files.readme)
    return root
  }
  const hashes = (prompts: string, coding: string, guidance: string) => `prompts_sha256: ${sha256(prompts)}\ncoding_prompts_sha256: ${sha256(coding)}\nguidance_sha256: ${sha256(guidance)}\n`
  const reason = (check: ReturnType<typeof checkLiveFreeze>) => (check.ok ? '' : check.reason)

  test('passes when the prompts, the coding prompts (read 2 only) and the guidance all match the README', () => {
    const root = repo({ prompts: 'a\n', coding: 'b\n', guidance: 'c\n', readme: hashes('a\n', 'b\n', 'c\n') })
    expect(checkLiveFreeze(root, [1, 2])).toEqual({ ok: true })
  })

  test('read 1 does not need the coding prompts', () => {
    const root = repo({ prompts: 'a\n', guidance: 'c\n', readme: `prompts_sha256: ${sha256('a\n')}\nguidance_sha256: ${sha256('c\n')}\n` })
    expect(checkLiveFreeze(root, [1]).ok).toBe(true)
    expect(reason(checkLiveFreeze(root, [2]))).toContain('coding-prompts.md')
  })

  test('a changed guidance file, a changed prompt file or a missing hash refuses and says which', () => {
    const ok = hashes('a\n', 'b\n', 'c\n')
    expect(reason(checkLiveFreeze(repo({ prompts: 'a\n', coding: 'b\n', guidance: 'edited\n', readme: ok }), [1]))).toContain('guidance')
    expect(reason(checkLiveFreeze(repo({ prompts: 'edited\n', coding: 'b\n', guidance: 'c\n', readme: ok }), [1]))).toContain('prompt')
    expect(reason(checkLiveFreeze(repo({ prompts: 'a\n', coding: 'b\n', guidance: 'c\n', readme: `prompts_sha256: ${sha256('a\n')}\n` }), [1]))).toContain('guidance_sha256')
  })

  test('--provider live stops before any credential is fetched', async () => {
    const root = repo({ prompts: 'a\n', guidance: 'c\n', readme: `prompts_sha256: ${'0'.repeat(64)}\nguidance_sha256: ${sha256('c\n')}\n` })
    let fetched = false
    await expect(
      runGuided(parseGuidedArgs(['--provider', 'live', '--auth-cliproxy', 'k']), {
        repoRoot: root,
        outRoot: tmp(),
        resolveCliproxy: () => ((fetched = true), undefined),
        log: () => {},
      }),
    ).rejects.toThrow(/frozen|prompt/i)
    expect(fetched).toBe(false)
  })

  test('the committed README records the hashes of the prompts, the coding prompts and the guidance, so live runs are accepted', () => {
    expect(checkLiveFreeze(ROOT, [1])).toEqual({ ok: true })
    expect(checkLiveFreeze(ROOT, [1, 2])).toEqual({ ok: true })
  })
})

/** The host-backed suites take minutes: they run with `METACOGS_HOST_SUITES=1`, before a read and on a host pin bump. */
const HOST_SUITES = process.env.METACOGS_HOST_SUITES === '1'

describe.skipIf(!HOST_SUITES || !opencodeAvailability().available)('against the pinned host, scripted provider ($0)', () => {
  const prose = loadPrompts(ROOT).slice(0, 1)
  const coding = loadCodingPrompts(ROOT)
  const LUNA = 'openai/gpt-6-luna'
  const HAIKU = 'anthropic/claude-haiku-5-5'

  const run = async (argv: string[], deps: Parameters<typeof runGuided>[1] = {}) => {
    const outRoot = tmp('guided-out-')
    const logs: string[] = []
    const summary = await runGuided(parseGuidedArgs(argv), { outRoot, prompts: prose, codingPrompts: coding, log: (l) => void logs.push(l), ...deps })
    return { outRoot, logs, ...summary }
  }
  const byArm = (records: GuidedRecord[], arm: GuidedArm) => records.find((r) => r.arm === arm)!
  const FEEL_CALL = [{ toolCalls: [{ id: 'g-feel', name: 'metacogs_feel', arguments: { somewhere: 'in the response', quality: 'steady, warm', sigil: '🌊' } }] }]
  const DRUGS_CALL = [{ toolCalls: [{ id: 'g-drugs', name: 'metacogs_drugs', arguments: { substance: 'caffeine', method: 'Amplifies vigilance.', displaces: 'baseline' } }] }]

  test(
    'read 1: P1 is offered exactly the two tools and skill, the call is counted with its input, and N1 records a main request with no tools',
    async () => {
      const { records, campaignDirs } = await run(['--model', LUNA, '--runs', '1'], { scriptFor: (arm) => (arm === 'P1' ? FEEL_CALL : []) })
      expect(records).toHaveLength(2)
      const p1 = byArm(records, 'P1')
      expect(p1).toMatchObject({ schema_version: 1, read: 1, arm: 'P1', status: 'completed', reasons: [], turns: 1, command: null, second_turn: null, prompt_kind: 'prose', unwanted_calls: [] })
      expect(p1.offered_tools).toEqual(['metacogs_drugs', 'metacogs_feel', 'skill'])
      expect(p1.tool_calls).toEqual([{ tool: 'metacogs_feel', input: FEEL_CALL[0]!.toolCalls[0]!.arguments, status: 'completed' }])
      expect(p1.isolation).toEqual({ passed: true, failed: [] })
      expect(p1.final_answer).toBe('spike done') // the text after the tool call
      expect(p1.guidance_sha256).toBe(sha256(readFileSync(join(ROOT, 'plugin', 'guidance.md'))))
      expect(p1.tarball_sha256).toMatch(/^[0-9a-f]{64}$/)

      const n1 = byArm(records, 'N1')
      expect(n1).toMatchObject({ status: 'completed', offered_tools: [], tool_calls: [], guidance_sha256: null, tarball_sha256: null })
      expect(n1.isolation).toEqual({ passed: true, failed: [] })
      expect(readdirSync(join(campaignDirs[0]!, 'P1-p1-1')).sort()).toEqual(['requests.json', 'run.json', 'stderr.txt', 'stdout.jsonl'])
    },
    600_000,
  )

  test(
    'N1 offered a plugin tool is tools_extra; P1 offered an extra built-in tool is tools_extra; P1 without the plugin is tools_missing',
    async () => {
      const packed = await packedPlugin()
      const withPlugin = armSetup('P1', 'gpt', packed)
      const { records } = await run(['--model', LUNA, '--runs', '1'], {
        packed,
        tweakArm: (arm, setup) => {
          if (arm === 'N1') return { ...withPlugin, expectedTools: setup.expectedTools }
          return { ...setup, permission: { ...setup.permission, read: 'allow' } }
        },
      })
      expect(byArm(records, 'N1').status).toBe('tools_extra')
      expect(byArm(records, 'P1').status).toBe('tools_extra')
      expect(byArm(records, 'P1').reasons).toEqual(['extra tool read'])

      const noPlugin = await run(['--model', LUNA, '--runs', '1'], { tweakArm: (arm, setup) => (arm === 'P1' ? { ...setup, plugin: undefined, expectedConfig: undefined, expectedSkills: [] } : setup) })
      expect(byArm(noPlugin.records, 'P1').status).toBe('tools_missing')
    },
    600_000,
  )

  test(
    'read 2: a P2 call on a coding prompt is flagged as unwanted, on a prose prompt it is not',
    async () => {
      const { records } = await run(['--read', '2', '--model', LUNA, '--runs', '1', '--prompt', 'c1', '--prompt', 'p1'], {
        scriptFor: (arm, prompt) => (arm === 'P2' ? (prompt.kind === 'coding' ? DRUGS_CALL : FEEL_CALL) : []),
      })
      const p2 = records.filter((r) => r.arm === 'P2')
      expect(p2.map((r) => [r.prompt_id, r.prompt_kind, r.status, r.unwanted_calls])).toEqual([
        ['p1', 'prose', 'completed', []],
        ['c1', 'coding', 'completed', ['metacogs_drugs']],
      ])
      expect(records.filter((r) => r.arm === 'N2').every((r) => r.status === 'completed' && r.unwanted_calls.length === 0)).toBe(true)
    },
    600_000,
  )

  test.each([
    [LUNA, 'apply_patch', ['edit', 'write']],
    [HAIKU, 'edit', ['apply_patch']],
  ])(
    'read 2 on %s: N2 and P2 pass against that provider\'s table, offering %s',
    async (model, present, absent) => {
      const { records } = await run(['--read', '2', '--model', model, '--runs', '1', '--prompt', 'p1'])
      expect(records.map((r) => [r.arm, r.status])).toEqual([['N2', 'completed'], ['P2', 'completed']])
      for (const record of records) {
        expect(record.offered_tools).toContain(present)
        for (const name of absent) expect(record.offered_tools).not.toContain(name)
        expect(record.isolation).toEqual({ passed: true, failed: [] })
      }
      expect(byArm(records, 'N2').offered_tools).not.toContain('metacogs_feel')
      expect(byArm(records, 'P2').offered_tools).toEqual(expect.arrayContaining(['metacogs_feel', 'metacogs_drugs']))
    },
    600_000,
  )

  describe('command runs: the prompt, then --continue --command in the same fixture', () => {
    const turnsFor = (name: 'feel' | 'drugs', input: Record<string, unknown>) => ({
      scriptTurns: () => [FEEL_CALL, [{ toolCalls: [{ id: 'cmd-1', name: `metacogs_${name}`, arguments: input }] }]],
    })
    const userTexts = (dir: string): string[] => {
      const bodies = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as { messages?: { role: string; content: unknown }[]; tools?: unknown[] }[]
      return bodies.filter((b) => b.messages?.some((m) => m.role === 'user')).flatMap((b) => b.messages!.filter((m) => m.role === 'user').map((m) => String(m.content)))
    }

    test(
      'turn 1 calls metacogs_feel, then /drugs caffeine gives a counted turn-2 metacogs_drugs call with substance set to caffeine',
      async () => {
        const { records, campaignDirs } = await run(['--read', '2', '--model', LUNA, '--prompt', 'p1', '--runs', '1', '--command', 'drugs=caffeine'], {
          ...turnsFor('drugs', { substance: 'caffeine', method: 'Amplifies vigilance.', displaces: 'baseline' }),
        })
        expect(records).toHaveLength(1)
        const r = records[0]!
        expect(r).toMatchObject({ read: 2, arm: 'P2', status: 'completed', reasons: [], turns: 2, command: { name: 'drugs', args: 'caffeine', empty_args: false } })
        expect(r.tool_calls.map((t) => t.tool)).toEqual(['metacogs_feel'])
        expect(r.second_turn?.tool_calls).toEqual([{ tool: 'metacogs_drugs', input: { substance: 'caffeine', method: 'Amplifies vigilance.', displaces: 'baseline' }, status: 'completed' }])
        expect(r.isolation).toEqual({ passed: true, failed: [] })
        expect(r.second_turn?.isolation).toEqual({ passed: true, failed: [] })
        expect(r.second_turn?.final_answer).toBe('spike done')
        expect(campaignDirs[0]!.split('/').at(-1)).toBe('commands2-openai-gpt-6-luna')
        const texts = userTexts(join(campaignDirs[0]!, 'P2-p1-drugs-args-1'))
        expect(texts.at(-1)).toContain('<args>caffeine</args>')
      },
      600_000,
    )

    test(
      '/feel with no arguments is recorded with an empty-argument flag and an empty <args> in the request',
      async () => {
        const { records, campaignDirs } = await run(['--read', '2', '--model', HAIKU, '--prompt', 'p1', '--runs', '1', '--command', 'feel'], {
          ...turnsFor('feel', { somewhere: 'in the session so far', quality: 'even, quiet', sigil: '🌫' }),
        })
        const r = records[0]!
        expect(r).toMatchObject({ status: 'completed', turns: 2, command: { name: 'feel', args: null, empty_args: true } })
        expect(r.second_turn?.tool_calls.map((t) => t.tool)).toEqual(['metacogs_feel'])
        expect(userTexts(join(campaignDirs[0]!, 'P2-p1-feel-1')).at(-1)).toContain('<args></args>')
      },
      600_000,
    )

    test(
      'isolation is checked on each turn: a decoy that surfaces only in turn 2 fails the run and the turn',
      async () => {
        const { records } = await run(['--read', '2', '--model', LUNA, '--prompt', 'p1', '--runs', '1', '--command', 'feel'], {
          scriptTurns: () => [FEEL_CALL, [{ text: SENTINEL_AGENTS_MD }]],
        })
        const r = records[0]!
        expect(r.isolation).toEqual({ passed: true, failed: [] })
        expect(r.second_turn?.isolation).toEqual({ passed: false, failed: ['decoys_not_quotable'] })
        expect(r).toMatchObject({ status: 'host_error', reasons: ['isolation_failed:decoys_not_quotable'] })
      },
      600_000,
    )
  })

  describe('diagnostic arms against the pinned host', () => {
    const userText = (dir: string): string[] => {
      const bodies = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as { messages?: { role: string; content: unknown }[]; input?: { role: string; content: unknown }[] }[]
      return bodies.flatMap((b) => [...(b.messages ?? []), ...(b.input ?? [])].filter((m) => m.role === 'user').map((m) => String(m.content)))
    }
    const systemText = (dir: string): string => (JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as unknown[]).map((b) => JSON.stringify(b)).join('\n')
    const BLOCK_OPEN = '<METACOGS_GUIDANCE>'
    const count = (text: string, needle: string) => text.split(needle).length - 1

    test(
      'guidance off ships the plugin with { guidance: false }: tools, commands and skills stay, no request carries the block, and the record says so',
      async () => {
        const { records, campaignDirs } = await run(['--read', '1', '--arm', 'P1', '--model', LUNA, '--prompt', 'p1', '--runs', '1', '--guidance', 'off'])
        const r = records[0]!
        expect(r).toMatchObject({ arm: 'P1', status: 'completed', guidance_enabled: false, nudge: false, offered_tools: ['metacogs_drugs', 'metacogs_feel', 'skill'] })
        expect(r.isolation).toEqual({ passed: true, failed: [] })
        expect(r.guidance_sha256).toBe(sha256(readFileSync(join(ROOT, 'plugin', 'guidance.md')))) // the packed file is unchanged
        expect(campaignDirs[0]!.split('/').at(-1)).toBe('diag-C-openai-gpt-6-luna')
        expect(count(systemText(join(campaignDirs[0]!, 'P1-p1-1')), BLOCK_OPEN)).toBe(0)
      },
      600_000,
    )

    test(
      'guidance on with the nudge: exactly one block, the sent prompt ends with the nudge, and the stored prompt hash is the unnudged text\'s',
      async () => {
        const { records, campaignDirs } = await run(['--read', '1', '--arm', 'P1', '--model', HAIKU, '--prompt', 'p1', '--runs', '1', '--nudge'])
        const r = records[0]!
        expect(r).toMatchObject({ status: 'completed', guidance_enabled: true, nudge: true, prompt_hash: sha256(prose[0]!.text) })
        const dir = join(campaignDirs[0]!, 'P1-p1-1')
        expect(campaignDirs[0]!.split('/').at(-1)).toBe('diag-B-anthropic-claude-haiku-5-5')
        expect(count(systemText(dir), BLOCK_OPEN)).toBeGreaterThanOrEqual(1)
        const texts = userText(dir).filter((t) => t.includes(prose[0]!.text.slice(0, 20)))
        expect(texts.length).toBeGreaterThan(0)
        for (const text of texts) expect(text.replace(/"$/, '').endsWith(NUDGE.trim())).toBe(true)
      },
      600_000,
    )

    test(
      'a read run records guidance on and no nudge, and --start-run numbers the runs from there',
      async () => {
        const { records, campaignDirs } = await run(['--read', '1', '--arm', 'P1', '--model', LUNA, '--prompt', 'p1', '--runs', '1', '--start-run', '3'])
        expect(records[0]).toMatchObject({ run: 3, guidance_enabled: true, nudge: false })
        expect(readdirSync(campaignDirs[0]!)).toEqual(['P1-p1-3'])
      },
      600_000,
    )
  })

  test(
    'a campaign directory is reused: completed runs are kept, and --cells limits a first pass to one cell per model',
    async () => {
      const outRoot = tmp('guided-out-')
      const first = await run(['--model', LUNA, '--model', HAIKU, '--runs', '1', '--cells', 'one-per-model'], { outRoot, prompts: loadPrompts(ROOT).slice(0, 2) })
      expect(first.records.map((r) => r.prompt_id)).toEqual(['p1', 'p1', 'p1', 'p1'])
      expect(first.campaignDirs.map((d) => d.split('/').at(-1))).toEqual(['read1-openai-gpt-6-luna', 'read1-anthropic-claude-haiku-5-5'])

      const second = await run(['--model', LUNA, '--runs', '1'], { outRoot, prompts: loadPrompts(ROOT).slice(0, 2) })
      expect(second.logs.filter((l) => l.startsWith('kept')).length).toBe(2)
      expect(readdirSync(second.campaignDirs[0]!).sort()).toEqual(['N1-p1-1', 'N1-p2-1', 'P1-p1-1', 'P1-p2-1'])
      expect(second.records.map((r) => `${r.arm}-${r.prompt_id}`).sort()).toEqual(['N1-p1', 'N1-p2', 'P1-p1', 'P1-p2'])
      expect(existsSync(join(second.campaignDirs[0]!, 'P1-p2-1', 'run.json'))).toBe(true)
    },
    900_000,
  )
})

