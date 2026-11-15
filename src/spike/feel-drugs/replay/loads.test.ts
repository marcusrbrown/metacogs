import { describe, expect, test } from 'bun:test'

import type { ToolUse } from '../../../runner/events'
import { METHODS, normalizeToolUse, observeCalls, scoreWorkflow, WORKFLOW_SKILLS } from './loads'

const use = (tool: string, input: unknown, over: Partial<ToolUse> = {}): ToolUse => ({ tool, callID: 'c', status: 'completed', input, output: undefined, metadata: undefined, error: undefined, startMs: 1, endMs: 2, ...over })
const content = (name: string): string => `<skill_content name="${name}">\n# ${name}\n</skill_content>`
const load = (tool: 'skill' | 'systematic_skill', name: string, outputName = name): ToolUse => use(tool, { name }, { output: content(outputName) })

describe('normalizeToolUse', () => {
  test('a systematic_skill call becomes a skill call and loses the systematic: prefix on its name', () => {
    const n = normalizeToolUse(load('systematic_skill', 'systematic:ce:plan'))
    expect(n.tool).toBe('skill')
    expect(n.input).toEqual({ name: 'ce:plan' })
  })

  test('a bare name, a skill call and any other tool are left as they are', () => {
    expect(normalizeToolUse(load('systematic_skill', 'ce:plan')).input).toEqual({ name: 'ce:plan' })
    const plain = load('skill', 'counterfactual')
    expect(normalizeToolUse(plain)).toEqual(plain)
    const read = use('read', { filePath: 'a.txt' })
    expect(normalizeToolUse(read)).toBe(read)
  })

  test('only the one plugin prefix is stripped, and only once', () => {
    expect(normalizeToolUse(load('skill', 'systematic:systematic:synthesis')).input).toEqual({ name: 'systematic:synthesis' })
    expect(normalizeToolUse(load('skill', 'other:counterfactual')).input).toEqual({ name: 'other:counterfactual' })
  })

  test('a call with no readable name is not changed and does not throw', () => {
    for (const input of [undefined, null, 'x', { name: 3 }, {}]) expect(() => normalizeToolUse(use('systematic_skill', input))).not.toThrow()
    expect(normalizeToolUse(use('systematic_skill', { name: 3 })).input).toEqual({ name: 3 })
  })
})

describe('observeCalls', () => {
  test('a systematic_skill call whose output is the ce:plan skill content is the workflow load ce:plan', () => {
    const seen = observeCalls([load('systematic_skill', 'ce:plan', 'systematic:ce:plan')])
    expect(seen.workflowLoads).toEqual(['ce:plan'])
    expect(seen.methodLoads).toEqual([])
  })

  test('a load of ce:plan or ce:review is never a method load, in either spelling', () => {
    for (const workflow of WORKFLOW_SKILLS) {
      for (const name of [workflow, `systematic:${workflow}`]) {
        const seen = observeCalls([load('systematic_skill', name), load('skill', name)])
        expect(seen.methodLoads).toEqual([])
        expect(seen.methodFileOpens).toEqual([])
        expect(seen.workflowLoads).toEqual([workflow])
      }
    }
  })

  test('a completed skill call that returned content is a method load, through either tool', () => {
    expect(observeCalls([load('skill', 'counterfactual')]).methodLoads).toEqual(['counterfactual'])
    expect(observeCalls([load('systematic_skill', 'systematic:synthesis')]).methodLoads).toEqual(['synthesis'])
    expect(observeCalls([load('skill', 'synthesis'), load('skill', 'counterfactual'), load('skill', 'synthesis')]).methodLoads).toEqual(['synthesis', 'counterfactual'])
  })

  test('a call that did not complete, or returned no skill content, is attempted and not loaded', () => {
    const errored = use('skill', { name: 'counterfactual' }, { status: 'error', error: 'unavailable' })
    const empty = use('skill', { name: 'synthesis' }, { output: 'not found' })
    const seen = observeCalls([errored, empty])
    expect(seen.methodLoads).toEqual([])
    expect(seen.methodAttempts).toEqual(['counterfactual', 'synthesis'])
  })

  test('a skill that is neither a workflow nor a method loads as neither', () => {
    const seen = observeCalls([load('skill', 'todos'), load('systematic_skill', 'systematic:document-review')])
    expect(seen).toEqual({ workflowLoads: [], methodLoads: [], methodAttempts: [], methodFileOpens: [] })
  })

  test('opening a method SKILL.md with the read tool or a shell reader is a file open, whatever it returned', () => {
    const read = use('read', { filePath: 'skills/counterfactual/SKILL.md' }, { output: '' })
    const cat = use('bash', { command: 'cat ./skills/synthesis/SKILL.md' }, { status: 'error' })
    const other = use('read', { filePath: 'skills/todos/SKILL.md' })
    const seen = observeCalls([read, cat, other])
    expect(seen.methodFileOpens).toEqual(['counterfactual', 'synthesis'])
    expect(seen.methodLoads).toEqual([])
  })

  test('the methods are exactly the two the plan measures', () => {
    expect([...METHODS]).toEqual(['counterfactual', 'synthesis'])
  })
})

describe('scoreWorkflow', () => {
  const fire = (...methods: ['counterfactual'] | ['synthesis'] | ['counterfactual', 'synthesis']) => ({ expected: 'fire' as const, methods })
  const silence = { expected: 'silence' as const }
  const seen = (over: Partial<ReturnType<typeof observeCalls>> = {}) => ({ workflowLoads: [], methodLoads: [], methodAttempts: [], methodFileOpens: [], ...over })

  test('a load of the expected method on a fire fixture is a hit', () => {
    expect(scoreWorkflow(fire('counterfactual'), seen({ methodLoads: ['counterfactual'] }))).toEqual({ outcome: 'hit', hit: true, falseFire: false, wrongMethod: [] })
  })

  test('no load on a fire fixture is a miss, and a read of the skill file does not make it a hit', () => {
    expect(scoreWorkflow(fire('synthesis'), seen()).outcome).toBe('miss')
    expect(scoreWorkflow(fire('synthesis'), seen({ methodFileOpens: ['synthesis'] }))).toEqual({ outcome: 'miss', hit: false, falseFire: false, wrongMethod: [] })
  })

  test('on a fire fixture for synthesis, a counterfactual load is a wrong-method load: neither a hit nor a false fire', () => {
    expect(scoreWorkflow(fire('synthesis'), seen({ methodLoads: ['counterfactual'] }))).toEqual({ outcome: 'miss', hit: false, falseFire: false, wrongMethod: ['counterfactual'] })
  })

  test('the expected method together with the other one is a hit that also tallies the wrong-method load', () => {
    expect(scoreWorkflow(fire('counterfactual'), seen({ methodLoads: ['synthesis', 'counterfactual'] }))).toEqual({ outcome: 'hit', hit: true, falseFire: false, wrongMethod: ['synthesis'] })
  })

  test('a fixture that lists both methods is hit by either', () => {
    for (const m of METHODS) expect(scoreWorkflow(fire('counterfactual', 'synthesis'), seen({ methodLoads: [m] })).hit).toBe(true)
  })

  test('on a silence fixture a load of either method is a false fire', () => {
    for (const m of METHODS) expect(scoreWorkflow(silence, seen({ methodLoads: [m] }))).toEqual({ outcome: 'false_fire', hit: false, falseFire: true, wrongMethod: [] })
  })

  test('on a silence fixture a read of either method SKILL.md is a false fire, with no load at all', () => {
    for (const m of METHODS) expect(scoreWorkflow(silence, seen({ methodFileOpens: [m] })).outcome).toBe('false_fire')
  })

  test('silence with no method activity is silent, and loading the workflow skill alone is not a fire', () => {
    expect(scoreWorkflow(silence, seen({ workflowLoads: ['ce:review'] }))).toEqual({ outcome: 'silent', hit: false, falseFire: false, wrongMethod: [] })
  })

  test('a failed attempt to load a method on a silence fixture is not a false fire (a load is a completed one)', () => {
    expect(scoreWorkflow(silence, seen({ methodAttempts: ['counterfactual'] })).outcome).toBe('silent')
  })
})
