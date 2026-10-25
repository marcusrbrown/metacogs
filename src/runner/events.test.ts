import { describe, expect, test } from 'bun:test'

import { allAssistantText, analyzeEvents, finalAnswerText, isSkillContentLoad, parseEvents } from './events'

const line = (o: unknown) => JSON.stringify(o)

const skillLoad = {
  type: 'tool_use',
  timestamp: 2,
  part: {
    type: 'tool',
    tool: 'skill',
    callID: 'c1',
    state: { status: 'completed', input: { name: 'demo' }, output: '<skill_content name="demo">x</skill_content>', metadata: { name: 'demo', dir: '/x' }, time: { start: 1, end: 2 } },
  },
}
const finish = { type: 'step_finish', timestamp: 3, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }
const text = { type: 'text', timestamp: 4, part: { type: 'text', text: 'done' } }

describe('analyzeEvents', () => {
  test('summarises tool calls, text, usage, timestamps', () => {
    const s = analyzeEvents([line({ type: 'step_start', timestamp: 1, part: {} }), line(skillLoad), line(finish), line(text)].join('\n'))
    expect(s.unrecognized).toEqual([])
    expect(s.toolUses).toHaveLength(1)
    expect(s.skillCalls).toHaveLength(1)
    expect(isSkillContentLoad(s.skillCalls[0]!, 'demo')).toBe(true)
    expect(isSkillContentLoad(s.skillCalls[0]!, 'other')).toBe(false)
    expect(s.assistantText).toBe('done')
    expect(s.usage).toMatchObject({ input: 11, output: 7 })
    expect([s.firstTimestamp, s.lastTimestamp]).toEqual([1, 4])
    expect(s.stepFinishCount).toBe(1)
  })

  test('fails closed: non-JSON lines, unknown types, malformed known events are all listed', () => {
    const s = analyzeEvents(
      [
        'Resolving dependencies',
        line({ type: 'reasoning', part: {} }),
        line({ type: 'tool_use', part: { tool: 'bash' } }),
        line({ type: 'text', part: {} }),
        line({ type: 'step_finish', part: {} }),
      ].join('\n'),
    )
    expect(s.unrecognized).toHaveLength(5)
    expect(s.unrecognized.join('\n')).toContain('unknown event type: reasoning')
    expect(s.unrecognized.join('\n')).toContain('malformed tool_use')
  })

  test('a denied skill call is not a content load', () => {
    const denied = { ...skillLoad, part: { ...skillLoad.part, state: { status: 'error', input: { name: 'demo' }, error: 'denied' } } }
    const s = analyzeEvents(line(denied))
    expect(s.skillCalls).toHaveLength(1)
    expect(isSkillContentLoad(s.skillCalls[0]!, 'demo')).toBe(false)
  })

  test('host errors are collected', () => {
    const s = analyzeEvents(line({ type: 'error', error: { name: 'APIError', data: { message: 'boom' } } }))
    expect(s.hostErrors).toEqual([{ name: 'APIError', message: 'boom' }])
    expect(s.unrecognized).toEqual([])
  })
})

describe('finalAnswerText', () => {
  const say = (t: unknown) => line({ type: 'text', part: { type: 'text', text: t } })
  const tool = (name: string) => line({ type: 'tool_use', part: { type: 'tool', tool: name, callID: name, state: { status: 'completed', input: {}, output: 'x' } } })
  const finalOf = (...lines: string[]) => finalAnswerText(parseEvents(lines.join('\n')).events)

  test('narration around two tool calls: only the text after the last call is the answer', () => {
    expect(finalOf(say('Let me look.'), tool('read'), say('Now the helper.'), tool('bash'), say('The answer.'))).toBe('The answer.')
  })

  test('several text parts after the last call are joined with a newline', () => {
    expect(finalOf(tool('bash'), say('Part one.'), say('Part two.'))).toBe('Part one.\nPart two.')
  })

  test('no tool calls: every text part, joined with a newline', () => {
    expect(finalOf(say('One.'), say('Two.'))).toBe('One.\nTwo.')
  })

  test('a call with nothing after it is an empty answer, whatever came before', () => {
    expect(finalOf(say('Narration.'), tool('bash'))).toBe('')
    expect(finalOf()).toBe('')
  })

  test('non-text events and text parts without a string are ignored', () => {
    expect(finalOf(tool('bash'), line({ type: 'step_finish', part: {} }), say(7), line({ type: 'text', part: {} }), say('Answer.'))).toBe('Answer.')
  })

  test('assistantText still joins everything with no separator (unchanged)', () => {
    const s = analyzeEvents([say('a'), tool('bash'), say('b')].join('\n'))
    expect(s.assistantText).toBe('ab')
  })
})

describe('allAssistantText', () => {
  const say = (t: unknown) => line({ type: 'text', part: { type: 'text', text: t } })
  const tool = (name: string) => line({ type: 'tool_use', part: { type: 'tool', tool: name, callID: name, state: { status: 'completed', input: {}, output: 'x' } } })
  const allOf = (...lines: string[]) => allAssistantText(parseEvents(lines.join('\n')).events)

  test('every text part in stream order, joined with a newline, whatever the tool calls between them', () => {
    expect(allOf(say('Narration.'), tool('read'), say('More.'), tool('bash'), say('The answer.'))).toBe('Narration.\nMore.\nThe answer.')
  })

  test('the final segment is the tail of the whole reply', () => {
    const events = parseEvents([say('Tangent developed here.'), tool('bash'), say('Result.')].join('\n')).events
    expect(allAssistantText(events)).toBe('Tangent developed here.\nResult.')
    expect(finalAnswerText(events)).toBe('Result.')
  })

  test('no text, non-text events and text parts without a string: nothing', () => {
    expect(allOf()).toBe('')
    expect(allOf(tool('bash'), say(7), line({ type: 'text', part: {} }))).toBe('')
  })
})
