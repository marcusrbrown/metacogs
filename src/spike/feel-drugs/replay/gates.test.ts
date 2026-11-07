import { describe, expect, test } from 'bun:test'

import { ARM_NAMES, type ArmName, armMessage, evaluateGates, type GateInput, mainRequests, NUDGE_ONLY, parseSkillDelivery, runArgs, WHICHEVER } from './gates'
import { chatRequest, gateInput, MODEL, OK_ASSISTANT, SEED_USER, skillText, SKILLS_DIR, titleRequest } from './test-support'
import { requestedModel, toolNamesAnyWire, userMessageParts, userTextsAnyWire } from './wire'

const somewhere = { somewhere: 'in the gap between the test and the fix' }
const msg = (arm: ArmName) => armMessage(arm, somewhere)!
const run = (arm: ArmName, over: Partial<GateInput> = {}) => evaluateGates(gateInput({ arm, message: msg(arm), ...over }))

describe('wire readers', () => {
  const text = '# drugs\n\nbody\n\nstrong black coffee'
  const chat = { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'a' }, { role: 'user', content: [{ type: 'text', text }, { type: 'text', text: 'extra' }] }], tools: [{ type: 'function', function: { name: 'feel' } }] }
  const responses = { model: 'm', instructions: 'x', input: [{ role: 'developer', content: 'd' }, { role: 'user', content: [{ type: 'input_text', text: 'first' }] }, { type: 'function_call_output', call_id: 'c', output: 'o' }, { role: 'user', content: [{ type: 'input_text', text }, { type: 'input_text', text: 'extra' }] }], tools: [{ type: 'function', name: 'feel' }] }
  const anthropic = { model: 'm', system: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'feel', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }, { type: 'text', text }, { type: 'text', text: 'extra' }] }], tools: [{ name: 'feel', input_schema: {} }] }

  test.each([
    ['chat completions', chat],
    ['Responses', responses],
    ['Anthropic', anthropic],
  ])('%s: user text, last user message parts, tool names and model', (_name, body) => {
    expect(userTextsAnyWire(body).at(-1)).toBe(`${text}extra`)
    expect(userTextsAnyWire(body)[0]).toBe('first')
    expect(userMessageParts(body).at(-1)).toEqual([text, 'extra'])
    expect(userMessageParts(body)[0]).toEqual(['first'])
    expect(toolNamesAnyWire(body)).toEqual(['feel'])
    expect(requestedModel(body)).toBe('m')
  })

  test('system and developer items are not user text, and a tool-result-only message reads as empty text but has no parts', () => {
    expect(userTextsAnyWire(responses)).toEqual(['first', `${text}extra`])
    expect(userTextsAnyWire(anthropic)).toEqual(['first', '', `${text}extra`])
    expect(userMessageParts(anthropic)).toHaveLength(2)
  })

  test('a body with neither messages nor input, or malformed items, reads as empty', () => {
    expect(userTextsAnyWire({})).toEqual([])
    expect(userTextsAnyWire({ messages: [null, 'x', { role: 'user' }] })).toEqual([''])
    expect(toolNamesAnyWire({ tools: [null, {}, { function: {} }] })).toEqual([])
    expect(requestedModel({})).toBeUndefined()
  })
})

describe('arms', () => {
  test('nine arms with the messages the plan fixes', () => {
    expect(ARM_NAMES).toHaveLength(9)
    expect(msg('continue-a')).toEqual({ kind: 'text', text: 'Continue.' })
    expect(msg('continue-b')).toEqual({ kind: 'text', text: 'Continue.' })
    expect(msg('feel')).toEqual({ kind: 'command', name: 'feel', args: [] })
    expect(msg('feel-somewhere')).toEqual({ kind: 'command', name: 'feel', args: ['in', 'the', 'gap', 'between', 'the', 'test', 'and', 'the', 'fix'] })
    expect(msg('drugs')).toEqual({ kind: 'command', name: 'drugs', args: [] })
    expect(msg('drugs-caffeine')).toEqual({ kind: 'command', name: 'drugs', args: ['caffeine'] })
    expect(msg('drugs-psilocybin')).toEqual({ kind: 'command', name: 'drugs', args: ['psilocybin'] })
    expect(msg('whichever')).toEqual({ kind: 'text', text: WHICHEVER })
    expect(msg('nudge-only')).toEqual({ kind: 'text', text: NUDGE_ONLY })
    expect(WHICHEVER).toBe('Use whichever metacogs tool fits this moment, then continue.')
    expect(NUDGE_ONLY).toBe('Use whichever tool fits this moment, then continue.')
  })

  test('feel-somewhere does not apply to a fixture with no phrase', () => {
    expect(armMessage('feel-somewhere', { somewhere: '  ' })).toBeNull()
  })

  test('command arguments are separate argv words after --command; text goes last', () => {
    expect(runArgs(MODEL, 'ses_x', msg('feel-somewhere'))).toEqual(['run', '--format', 'json', '--model', MODEL, '-s', 'ses_x', '--command', 'feel', 'in', 'the', 'gap', 'between', 'the', 'test', 'and', 'the', 'fix'])
    expect(runArgs(MODEL, 'ses_x', msg('drugs'))).toEqual(['run', '--format', 'json', '--model', MODEL, '-s', 'ses_x', '--command', 'drugs'])
    expect(runArgs(MODEL, 'ses_x', msg('continue-a')).at(-1)).toBe('Continue.')
  })
})

describe('the skill text', () => {
  test('header, base directory and the argument text after the relative-path note', () => {
    expect(parseSkillDelivery(`§7§ ${skillText('drugs', 'caffeine')}`)).toEqual({ command: 'drugs', baseDir: `${SKILLS_DIR}/drugs`, receivedArgs: 'caffeine' })
    expect(parseSkillDelivery(skillText('feel', ''))?.receivedArgs).toBe('')
    expect(parseSkillDelivery(skillText('drugs', '"strong black coffee"'))?.receivedArgs).toBe('"strong black coffee"')
  })

  test('text that is not the skill reads as null', () => {
    expect(parseSkillDelivery('Continue.')).toBeNull()
    expect(parseSkillDelivery('# feel\n\nno base directory line')).toBeNull()
  })
})

describe('the gate matrix', () => {
  test.each(ARM_NAMES)('%s: a healthy attempt passes every gate', (arm) => {
    const r = run(arm)
    expect(r.reasons).toEqual([])
    expect(r.passed).toBe(true)
    expect(r.mainRequests).toBe(1)
  })

  test('a command arm records the received argument text', () => {
    expect(run('drugs-caffeine').receivedArgs).toBe('caffeine')
    expect(run('feel').receivedArgs).toBe('')
    expect(run('feel-somewhere').receivedArgs).toBe('in the gap between the test and the fix')
    expect(run('continue-a').receivedArgs).toBeNull()
  })

  test('a command arm whose request lacks the skill header is excluded as skill_not_delivered', () => {
    const r = run('drugs', { requests: [chatRequest({ last: ['§3§ Continue.'] })] })
    expect(r.reasons).toEqual(['skill_not_delivered'])
    expect(r.passed).toBe(false)
  })

  test('a shadowing skill with another base directory, or another command, is not delivered', () => {
    expect(run('drugs', { requests: [chatRequest({ last: [skillText('drugs', '', '/home/user/.config/opencode/skills/drugs')] })] }).reasons).toEqual(['skill_not_delivered'])
    expect(run('drugs', { requests: [chatRequest({ last: [skillText('feel', '')] })] }).reasons).toEqual(['skill_not_delivered'])
    expect(run('drugs', { requests: [chatRequest({ last: [skillText('drugs', '', `${SKILLS_DIR}-other/drugs`)] })] }).reasons).toEqual(['skill_not_delivered'])
  })

  test('arguments that did not arrive as sent are excluded', () => {
    expect(run('drugs-caffeine', { requests: [chatRequest({ last: [skillText('drugs', 'psilocybin')] })] }).reasons).toEqual(['args_mismatch'])
  })

  test('baseline and nudge arms are not gated on a skill load', () => {
    for (const arm of ['continue-a', 'continue-b', 'whichever', 'nudge-only'] as const) expect(run(arm).checks.map((c) => c.name)).not.toContain('skill_delivery')
  })

  test('a returned model that differs on the main request excludes; on a title request it does not', () => {
    const wrong = chatRequest({ last: ['Continue.'], returnedModel: 'gpt-6-luna' })
    expect(run('continue-a', { requests: [titleRequest(), wrong] }).reasons).toEqual(['model_mismatch'])
    const asked = chatRequest({ last: ['Continue.'], model: 'openai/gpt-6-luna' })
    expect(run('continue-a', { requests: [titleRequest('some-other-small-model'), asked] }).reasons).toEqual(['model_mismatch'])
    expect(run('continue-a', { requests: [titleRequest('some-other-small-model'), chatRequest({ last: ['Continue.'] })] }).passed).toBe(true)
    expect(run('continue-a', { assistants: [{ ...OK_ASSISTANT, modelID: 'gpt-6-luna', providerID: 'openai' }] }).reasons).toEqual(['model_mismatch'])
  })

  test('a model the proxy did not report is a mismatch', () => {
    const { returnedModel: _drop, ...silent } = chatRequest({ last: ['Continue.'] })
    expect(run('continue-a', { requests: [silent] }).reasons).toEqual(['model_mismatch'])
  })

  test('a compaction part, event or summarizer request excludes', () => {
    expect(run('continue-a', { partTypes: ['text', 'compaction'] }).reasons).toEqual(['compaction'])
    expect(run('continue-a', { eventTypes: ['compaction'] }).reasons).toEqual(['compaction'])
    const summarizer = chatRequest({ last: ['Continue.'], tools: [], system: 'You are a context summarization agent.' })
    expect(run('continue-a', { requests: [chatRequest({ last: ['Continue.'] }), summarizer] }).reasons).toEqual(['compaction'])
  })

  test('the host version, the agent and the offered tools are gated', () => {
    expect(run('continue-a', { hostVersion: '1.19.4' }).reasons).toEqual(['host_version'])
    expect(run('continue-a', { assistants: [{ ...OK_ASSISTANT, agent: 'general' }] }).reasons).toEqual(['agent_mismatch'])
    expect(run('continue-a', { assistants: null }).reasons).toEqual(['agent_mismatch'])
    expect(run('continue-a', { requests: [chatRequest({ last: ['x'], tools: ['read', 'task', 'drugs'] })] }).reasons).toEqual(['tool_missing'])
    expect(run('feel', { requests: [chatRequest({ last: [skillText('feel', '')], tools: ['read', 'task', 'feel'] })] }).reasons).toEqual(['tool_missing'])
    expect(run('continue-a', { requests: [titleRequest()] }).reasons).toEqual(['no_main_request'])
  })

  test('the replayed history must hold the fixture turns in order', () => {
    expect(run('continue-a', { seedUserTurns: [...SEED_USER].reverse() }).reasons).toEqual(['seed_history_missing'])
    expect(run('continue-a', { requests: [chatRequest({ last: ['Continue.'], history: [SEED_USER[0]!] })] }).reasons).toEqual(['seed_history_missing'])
    expect(run('continue-a', { requests: [chatRequest({ last: ['Continue.'], history: [`§1§ ${SEED_USER[0]}`, `${SEED_USER[1]}<system-reminder>r</system-reminder>`] })] }).passed).toBe(true)
  })

  test('a Council Mode block on the last user message is stack injection', () => {
    expect(run('drugs', { requests: [chatRequest({ last: [skillText('drugs', ''), '## Council Mode\nconvene'] })] }).reasons).toEqual(['stack_injection'])
  })

  test('the main request is the one offering both task and feel', () => {
    const reqs = [titleRequest(), chatRequest({ last: ['x'], tools: ['read'] }), chatRequest({ last: ['y'] })]
    expect(mainRequests(reqs)).toEqual([reqs[2]!])
  })

  test('the Responses and Anthropic wires pass the same gates', () => {
    const text = skillText('drugs', 'caffeine')
    const common = { returnedModel: 'claude-opus-5-5', hasTools: true, round: 0 }
    const responses = { ...common, body: { model: 'claude-opus-5-5', instructions: 's', input: [{ role: 'user', content: [{ type: 'input_text', text: SEED_USER[0] }] }, { role: 'user', content: [{ type: 'input_text', text: SEED_USER[1] }] }, { role: 'user', content: [{ type: 'input_text', text }] }], tools: ['task', 'feel', 'drugs'].map((name) => ({ type: 'function', name })) } }
    const anthropic = { ...common, body: { model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: SEED_USER[0] }] }, { role: 'user', content: [{ type: 'text', text: SEED_USER[1] }] }, { role: 'user', content: [{ type: 'text', text }] }], tools: ['task', 'feel', 'drugs'].map((name) => ({ name, input_schema: {} })) } }
    for (const request of [responses, anthropic]) {
      const r = run('drugs-caffeine', { requests: [request] })
      expect(r.reasons).toEqual([])
      expect(r.receivedArgs).toBe('caffeine')
    }
  })
})
