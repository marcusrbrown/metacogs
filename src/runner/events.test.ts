import { describe, expect, test } from 'bun:test'

import { analyzeEvents, isSkillContentLoad } from './events'

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
