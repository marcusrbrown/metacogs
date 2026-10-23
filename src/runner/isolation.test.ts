import { describe, expect, test } from 'bun:test'

import { availableSkillsFromRequests, checkDebugConfig, checkIsolation, failedChecks, type IsolationInput, systemPromptSent, systemTexts } from './isolation'
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
