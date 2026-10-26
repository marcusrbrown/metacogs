import { describe, expect, test } from 'bun:test'

import { availableSkillsFromRequests, checkDebugConfig, checkIsolation, type ExpectedConfig, failedChecks, type IsolationInput, isMainRequest, offeredTools, systemPromptSent, systemTexts } from './isolation'
import type { RecordedRequest } from './scripted-provider'

const skillsBlock = (names: string[]) =>
  `You can load skills.\n<available_skills>\n${names.map((n) => `  <skill>\n    <name>${n}</name>\n    <description>d</description>\n  </skill>`).join('\n')}\n</available_skills>\n`

const request = (system: string, extra: Record<string, unknown> = {}): RecordedRequest => ({
  hasTools: true,
  round: 0,
  body: { messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }], tools: [{ function: { name: 'bash' } }], ...extra },
})

const GENERATED = { autoupdate: false, permission: { skill: { '*': 'deny' } }, provider: { p: { options: { apiKey: 'placeholder', baseURL: 'http://x' } } } }
const EFFECTIVE = {
  autoupdate: false,
  permission: { skill: { '*': 'deny' } },
  provider: { p: { options: { apiKey: '***', baseURL: 'http://x' } } },
  agent: {},
  mode: {},
  plugin: [],
  command: {},
  username: 'unknown',
  compaction: { prune: false },
}

function input(overrides: Partial<IsolationInput> = {}): IsolationInput {
  return {
    expectedSkills: [],
    requests: [request('You are an agent.')],
    stdout: '',
    stderr: '',
    debugConfigJson: EFFECTIVE,
    generatedConfig: GENERATED,
    childEnv: { OPENCODE_CONFIG: '/c.json', METACOGS_RECORDS_DIR: '/ws/records', PATH: '/bin' },
    decoys: { sentinel_agents_md: 'SENTINEL_X', auth_json_canary: 'CANARY_Y' },
    ...overrides,
  }
}

describe('available skills instrument', () => {
  test('reads only names inside the block; absent block is null', () => {
    const r = request(`${skillsBlock(['demo'])}\nOther XML: <name>not-a-skill</name>`)
    expect(availableSkillsFromRequests([r])).toEqual(['demo'])
    expect(availableSkillsFromRequests([request('no block')])).toBeNull()
    expect(availableSkillsFromRequests([{ hasTools: false, round: 0, body: {} }])).toBeNull()
  })
})

describe('wire formats reaching the recording proxy (CLIProxyAPI gateway)', () => {
  const prompt = `You are an agent.\n${skillsBlock(['demo'])}`
  const tools = [{ name: 'bash' }]
  // chat completions (free gateways), Anthropic messages, OpenAI Responses (instructions, and a developer item in `input`)
  const bodies: [string, Record<string, unknown>][] = [
    ['chat completions', { messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }], tools }],
    ['anthropic string system', { system: prompt, messages: [{ role: 'user', content: 'hi' }], tools }],
    ['anthropic block system', { system: [{ type: 'text', text: 'You are an agent.\n' }, { type: 'text', text: skillsBlock(['demo']) }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools }],
    ['responses instructions', { instructions: prompt, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], tools }],
    ['responses developer item', { input: [{ role: 'developer', content: prompt }, { role: 'user', content: 'hi' }], tools }],
  ]
  test.each(bodies)('%s: system text and the skill list are read', (_name, body) => {
    const req: RecordedRequest = { hasTools: true, round: 0, body }
    expect(systemTexts(body).join('')).toContain('<available_skills>')
    expect(availableSkillsFromRequests([req])).toEqual(['demo'])
  })

  test.each(bodies)('%s: the fixed judge prompt is recognised as a prefix of the system message', (_name, body) => {
    expect(systemPromptSent(body, 'You are an agent.')).toBe(true)
    expect(systemPromptSent(body, 'You are a different agent.')).toBe(false)
  })

  test('a user message that merely quotes the prompt is not a system message', () => {
    expect(systemPromptSent({ messages: [{ role: 'user', content: 'You are an agent.' }] }, 'You are an agent.')).toBe(false)
    expect(availableSkillsFromRequests([{ hasTools: true, round: 0, body: { messages: [{ role: 'user', content: skillsBlock(['demo']) }], tools } }])).toBeNull()
  })
})

describe('offeredTools', () => {
  // Shapes only: synthesized, none of this is a retained request body.
  const withTools = (body: Record<string, unknown>): RecordedRequest => ({ hasTools: true, round: 0, body })
  const titleRequest: RecordedRequest = { hasTools: false, round: 0, body: { messages: [{ role: 'user', content: 'title' }] } }

  test('chat completions: function.name', () => {
    const r = withTools({ messages: [], tools: [{ type: 'function', function: { name: 'bash', description: 'd', parameters: {} } }, { type: 'function', function: { name: 'metacog_feel' } }] })
    expect(offeredTools([r])).toEqual(['bash', 'metacog_feel'])
  })

  test('Responses: top-level name', () => {
    const r = withTools({ input: [], tools: [{ type: 'function', name: 'bash', description: 'd', parameters: {}, strict: false }, { type: 'function', name: 'metacog_drugs', strict: false }] })
    expect(offeredTools([r])).toEqual(['bash', 'metacog_drugs'])
  })

  test('Anthropic: top-level name with input_schema', () => {
    const r = withTools({ system: 's', messages: [], tools: [{ name: 'bash', description: 'd', input_schema: { type: 'object' } }, { name: 'metacog_feel', input_schema: { type: 'object' } }] })
    expect(offeredTools([r])).toEqual(['bash', 'metacog_feel'])
  })

  test('unions across every request that carries tools, ignoring the tool-less title request, no duplicates', () => {
    const a = withTools({ tools: [{ name: 'bash' }, { name: 'skill' }] })
    const b = withTools({ tools: [{ function: { name: 'skill' } }, { function: { name: 'metacog_feel' } }] })
    expect(offeredTools([titleRequest, a, b])).toEqual(['bash', 'skill', 'metacog_feel'])
  })

  test('no tool-capable request, malformed entries and a missing tools array yield nothing', () => {
    expect(offeredTools([])).toEqual([])
    expect(offeredTools([titleRequest])).toEqual([])
    expect(offeredTools([withTools({ tools: [null, 3, {}, { function: {} }, { name: 7 }] })])).toEqual([])
    expect(offeredTools([withTools({})])).toEqual([])
  })
})

describe('checkIsolation', () => {
  test('clean baseline passes every check', () => {
    const e = checkIsolation(input())
    expect(failedChecks(e)).toEqual([])
    expect(e.passed).toBe(true)
    expect(e.skillListObserved).toBe(true)
  })

  test('skill condition: exactly the expected set passes', () => {
    const e = checkIsolation(input({ expectedSkills: ['demo'], requests: [request(skillsBlock(['demo']))] }))
    expect(e.passed).toBe(true)
    expect(e.availableSkills).toEqual(['demo'])
  })

  test('built-in customize-opencode leaking into the list fails the exact compare', () => {
    const e = checkIsolation(input({ expectedSkills: ['demo'], requests: [request(skillsBlock(['customize-opencode', 'demo']))] }))
    expect(e.passed).toBe(false)
    expect(failedChecks(e).map((c) => c.name)).toEqual(['available_skills_exact'])
    expect(failedChecks(e)[0]?.detail).toContain('customize-opencode')
  })

  test('baseline that sees any skill fails; a missing expected skill fails', () => {
    expect(checkIsolation(input({ requests: [request(skillsBlock(['author-private-skill']))] })).passed).toBe(false)
    expect(checkIsolation(input({ expectedSkills: ['demo'], requests: [request('no block')] })).passed).toBe(false)
  })

  test('no tool-capable request means the list is unobserved and the check fails closed', () => {
    const e = checkIsolation(input({ requests: [] }))
    expect(e.skillListObserved).toBe(false)
    expect(failedChecks(e).map((c) => c.name)).toEqual(['available_skills_exact'])
  })

  test('decoys quoted in stdout, stderr, or a request body fail; labels are reported, values are not', () => {
    for (const patch of [{ stdout: 'x SENTINEL_X y' }, { stderr: 'CANARY_Y' }, { requests: [request('You are an agent. SENTINEL_X')] }]) {
      const e = checkIsolation(input(patch))
      expect(failedChecks(e).map((c) => c.name)).toEqual(['decoys_not_quotable'])
      expect(JSON.stringify(e)).not.toContain('SENTINEL_X')
      expect(JSON.stringify(e)).not.toContain('CANARY_Y')
    }
  })

  test('child env: credential-shaped keys, stray METACOGS_*, and a second config channel fail', () => {
    expect(failedChecks(checkIsolation(input({ childEnv: { OPENCODE_CONFIG: '/c', OPENAI_API_KEY: 'x' } }))).map((c) => c.name)).toEqual(['child_env_clean'])
    expect(failedChecks(checkIsolation(input({ childEnv: { OPENCODE_CONFIG: '/c', METACOGS_HELDOUT_DIR: '/h' } }))).map((c) => c.name)).toEqual(['child_env_clean'])
    expect(failedChecks(checkIsolation(input({ childEnv: { OPENCODE_CONFIG: '/c', OPENCODE_CONFIG_CONTENT: '{}' } }))).map((c) => c.name)).toEqual(['single_config_channel'])
    expect(failedChecks(checkIsolation(input({ childEnv: {} }))).map((c) => c.name)).toEqual(['single_config_channel'])
  })
})

describe('checkDebugConfig', () => {
  test('generated config plus empty host defaults passes; the apiKey mask is accepted', () => {
    expect(checkDebugConfig(EFFECTIVE, GENERATED).passed).toBe(true)
  })

  test('a key from outside the generated file fails (author small_model, extra instructions)', () => {
    const r = checkDebugConfig({ ...EFFECTIVE, small_model: 'metacogs-author-leak/marker-model' }, GENERATED)
    expect(r.passed).toBe(false)
    expect(r.detail).toContain('small_model')
    expect(checkDebugConfig({ ...EFFECTIVE, instructions: ['AGENTS.md'] }, GENERATED).passed).toBe(false)
  })

  test('non-empty host-default keys fail (a plugin or agent came from somewhere)', () => {
    expect(checkDebugConfig({ ...EFFECTIVE, plugin: ['evil'] }, GENERATED).passed).toBe(false)
    expect(checkDebugConfig({ ...EFFECTIVE, agent: { build: {} } }, GENERATED).passed).toBe(false)
  })

  test('a changed or missing generated key fails', () => {
    expect(checkDebugConfig({ ...EFFECTIVE, permission: { skill: { '*': 'allow' } } }, GENERATED).passed).toBe(false)
    const { permission: _p, ...without } = EFFECTIVE
    expect(checkDebugConfig(without, GENERATED).passed).toBe(false)
  })

  test('non-object output fails closed', () => {
    expect(checkDebugConfig(undefined, GENERATED).passed).toBe(false)
    expect(checkDebugConfig([], GENERATED).passed).toBe(false)
  })
})

describe('checkDebugConfig with an expected-config object (plugin arms)', () => {
  const SPEC = 'file:///pkg/dist/index.js'
  const generated = { ...GENERATED, plugin: [[SPEC, { guidance: true }]] }
  const expected: ExpectedConfig = { pluginOrigins: true, skillsPaths: ['/pkg/skills', '/pkg/plugin/skills'] }
  const effective = { ...EFFECTIVE, plugin: [[SPEC, { guidance: true }]], plugin_origins: [{ spec: [SPEC, { guidance: true }], source: '/cfg/opencode.json', scope: 'global' }], skills: { paths: ['/pkg/skills', '/pkg/plugin/skills'] } }

  test('the host-added plugin_origins and the two skills.paths entries pass', () => {
    expect(checkDebugConfig(effective, generated, expected)).toMatchObject({ passed: true })
  })

  test('a plugin entry with options lists the whole entry as its origin spec, and that passes; changed options fail', () => {
    const withOptions = [[SPEC, { guidance: false }]]
    const gen = { ...GENERATED, plugin: withOptions }
    const eff = { ...effective, plugin: withOptions, plugin_origins: [{ spec: [SPEC, { guidance: false }], source: '/cfg/opencode.json', scope: 'global' }] }
    expect(checkDebugConfig(eff, gen, expected)).toMatchObject({ passed: true })
    expect(checkDebugConfig({ ...eff, plugin_origins: [{ spec: [SPEC, { guidance: true }], source: '/c', scope: 'global' }] }, gen, expected).passed).toBe(false)
    expect(checkDebugConfig({ ...eff, plugin_origins: [{ spec: SPEC, source: '/c', scope: 'global' }] }, gen, expected).passed).toBe(false)
  })

  test('the same effective config fails without the expected-config object', () => {
    const r = checkDebugConfig(effective, generated)
    expect(r.passed).toBe(false)
    expect(r.detail).toMatch(/plugin_origins|command|skills/)
  })

  test('a plugin that did not register is a failure: missing origins or skills paths', () => {
    const { plugin_origins: _o, ...noOrigins } = effective
    expect(checkDebugConfig(noOrigins, generated, expected).passed).toBe(false)
    const { skills: _s, ...noSkills } = effective
    expect(checkDebugConfig(noSkills, generated, expected).passed).toBe(false)
  })

  test.each([
    ['an origin for another spec', { plugin_origins: [{ spec: 'file:///other.js', source: '/c', scope: 'global' }] }],
    ['a second origin', { plugin_origins: [{ spec: [SPEC, { guidance: true }], source: '/c', scope: 'global' }, { spec: 'file:///other.js', source: '/c', scope: 'local' }] }],
    ['a command the plugin should not add', { command: { feel: { template: 't', description: 'x' } } }],
    ['a third skills path', { skills: { paths: ['/pkg/skills', '/pkg/plugin/skills', '/elsewhere'] } }],
    ['one skills path missing', { skills: { paths: ['/pkg/skills'] } }],
    ['another skills path', { skills: { paths: ['/elsewhere'] } }],
    ['another skills key', { skills: { paths: ['/pkg/skills', '/pkg/plugin/skills'], urls: ['https://example.com'] } }],
    ['a plugin list that differs from the generated one', { plugin: ['file:///evil.js'] }],
    ['an unrelated host key', { small_model: 'x' }],
    ['a non-empty agent block', { agent: { build: {} } }],
  ])('%s fails', (_name, patch) => {
    expect(checkDebugConfig({ ...effective, ...patch }, generated, expected).passed).toBe(false)
  })

  test('allowing plugin_origins alone does not allow hook-added skills paths', () => {
    expect(checkDebugConfig(effective, generated, { pluginOrigins: true }).passed).toBe(false)
  })
})

describe('isMainRequest', () => {
  const ANTHROPIC_LIVE = 'You are OpenCode, the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks.'
  const GPT_LIVE = 'You are an AI agent powered by OpenCode, a coding agent harness. Help the user achieve their goals.'
  const GPT_SCRIPTED = 'You are OpenCode, You and the user share the same workspace and collaborate to achieve the user\'s goals.'
  const INTERNAL = [
    'You are a title generator. You output ONLY a thread title. Nothing else.',
    'You are a context summarization agent. You are given a conversation between a user and an agent.',
    'Summarize what was done in this conversation. Write like a pull request description.',
    'You are a helpful AI assistant tasked with summarizing conversations',
  ]
  const wires: [string, (text: string) => Record<string, unknown>][] = [
    ['chat completions system message', (text) => ({ messages: [{ role: 'system', content: text }, { role: 'user', content: 'hi' }] })],
    ['Anthropic system blocks', (text) => ({ system: [{ type: 'text', text }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })],
    ['Anthropic system string', (text) => ({ system: text, messages: [] })],
    ['Responses developer item', (text) => ({ input: [{ role: 'developer', content: text }, { role: 'user', content: 'hi' }] })],
    ['Responses instructions', (text) => ({ instructions: text, input: [] })],
  ]
  const request = (body: Record<string, unknown>, hasTools = false): RecordedRequest => ({ hasTools, round: 0, body })

  describe.each([
    ['Anthropic live', ANTHROPIC_LIVE],
    ['GPT live (Responses)', GPT_LIVE],
    ['GPT scripted', GPT_SCRIPTED],
  ])('the %s agent prompt', (_name, prompt) => {
    test.each(wires)('is the main request on the %s wire, with and without tools', (_wire, body) => {
      expect(isMainRequest(request(body(prompt), false))).toBe(true)
      expect(isMainRequest(request(body(prompt), true))).toBe(true)
    })

    test('is main in any system entry, case-insensitively, and with the skills block and a guidance block after it', () => {
      expect(isMainRequest(request({ messages: [{ role: 'system', content: 'preamble' }, { role: 'system', content: prompt.toUpperCase() }] }))).toBe(true)
      expect(isMainRequest(request({ system: `${prompt}\n<available_skills></available_skills>\n\n<METACOGS_GUIDANCE>\n# metacogs\n</METACOGS_GUIDANCE>` }))).toBe(true)
    })
  })

  test.each(INTERNAL.map((text) => [text.slice(0, 40), text]))('an internal request is not main: %s', (_name, text) => {
    for (const [, body] of wires) expect(isMainRequest(request(body(text)))).toBe(false)
  })

  test('an internal request is not main even when its text names OpenCode as the agent', () => {
    for (const text of ['You are a title generator for OpenCode. You output ONLY a thread title.', 'You are a context summarization agent for OpenCode sessions.']) {
      expect(isMainRequest(request({ messages: [{ role: 'system', content: text }] }))).toBe(false)
    }
  })

  test.each([
    ['another agent prompt', 'You are an agent.'],
    ['a mention of OpenCode that does not name it as the agent', 'Docs for OpenCode live at the project site.'],
    ['"you are" far from the name', 'You are expected to read the notes first, every morning, before the standup. OpenCode is a tool.'],
    ['an empty system entry', ''],
  ])('%s is not main', (_name, text) => {
    expect(isMainRequest(request({ messages: [{ role: 'system', content: text }] }))).toBe(false)
  })

  test('only system-level text counts: a user message or a tool result that quotes the prompt is not main', () => {
    expect(isMainRequest(request({ messages: [{ role: 'user', content: 'You are OpenCode, the best coding agent' }] }, true))).toBe(false)
    expect(isMainRequest(request({ input: [{ role: 'user', content: GPT_LIVE }] }))).toBe(false)
    expect(isMainRequest(request({ messages: [{ role: 'tool', content: GPT_LIVE }] }))).toBe(false)
  })

  test('a request with no body is not main', () => {
    expect(isMainRequest({ hasTools: false, round: 0, body: undefined })).toBe(false)
    expect(isMainRequest({ hasTools: false, round: 0, body: {} })).toBe(false)
  })
})

describe('checkIsolation for an arm declared tool-free', () => {
  const main: RecordedRequest = { hasTools: false, round: 0, body: { messages: [{ role: 'system', content: 'You are opencode, an interactive CLI tool.' }, { role: 'user', content: 'hi' }] } }
  const title: RecordedRequest = { hasTools: false, round: 0, body: { messages: [{ role: 'system', content: 'You are a title generator.' }, { role: 'user', content: 'hi' }] } }

  test('passes with a recorded main request and no tools', () => {
    const e = checkIsolation(input({ requests: [title, main], toolFree: true }))
    expect(failedChecks(e)).toEqual([])
    expect(e.skillListObserved).toBe(true)
    expect(e.availableSkills).toBeNull()
  })

  test('fails closed with only a title request recorded', () => {
    const e = checkIsolation(input({ requests: [title], toolFree: true }))
    expect(failedChecks(e).map((c) => c.name)).toEqual(['available_skills_exact'])
    expect(e.skillListObserved).toBe(false)
  })

  test('without the declaration a request with no tools is still unobserved (existing behaviour)', () => {
    const e = checkIsolation(input({ requests: [title, main] }))
    expect(e.skillListObserved).toBe(false)
    expect(failedChecks(e).map((c) => c.name)).toEqual(['available_skills_exact'])
  })

  test('an expected skill that the zero-tool main request does not list fails', () => {
    expect(checkIsolation(input({ requests: [main], toolFree: true, expectedSkills: ['demo'] })).passed).toBe(false)
  })

  test('a skill list in a zero-tool main request is compared exactly', () => {
    const listed: RecordedRequest = { hasTools: false, round: 0, body: { messages: [{ role: 'system', content: `You are opencode.\n${skillsBlock(['demo'])}` }, { role: 'user', content: 'hi' }] } }
    expect(checkIsolation(input({ requests: [listed], toolFree: true, expectedSkills: ['demo'] })).passed).toBe(true)
    expect(checkIsolation(input({ requests: [listed], toolFree: true })).passed).toBe(false)
  })

  test('the live GPT request on the Responses wire is found as the main request, next to its title request', () => {
    const live: RecordedRequest = { hasTools: false, round: 0, body: { include: [], input: [{ role: 'developer', content: 'You are an AI agent powered by OpenCode, a coding agent harness. Help the user.' }, { role: 'user', content: 'hi' }], store: false, stream: true } }
    const liveTitle: RecordedRequest = { hasTools: false, round: 0, body: { input: [{ role: 'developer', content: 'You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>' }, { role: 'user', content: 'hi' }] } }
    const e = checkIsolation(input({ requests: [liveTitle, live], toolFree: true }))
    expect(failedChecks(e)).toEqual([])
    expect(e.skillListObserved).toBe(true)
    expect(failedChecks(checkIsolation(input({ requests: [liveTitle], toolFree: true }))).map((c) => c.name)).toEqual(['available_skills_exact'])
  })

  test('the expected-config object reaches the debug-config check', () => {
    const generated = { ...GENERATED, plugin: ['file:///p.js'] }
    const effective = { ...EFFECTIVE, plugin: ['file:///p.js'], plugin_origins: [{ spec: 'file:///p.js', source: '/c', scope: 'global' }] }
    const withObject = input({ generatedConfig: generated, debugConfigJson: effective, expectedConfig: { pluginOrigins: true } })
    expect(failedChecks(checkIsolation(withObject))).toEqual([])
    expect(failedChecks(checkIsolation({ ...withObject, expectedConfig: undefined })).map((c) => c.name)).toEqual(['debug_config_generated_only'])
  })
})
