import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

import type { RawPart } from '../feel-drugs/replay/extract'
import { hermeticGitEnv, TestRepo } from '../../runner/test-support'
import { collectSkillBodies, intervalEvidence, type LoadEvent, loadEvents, methodCallOf, parseJsonObject, type SkillBodies, toolUseOfPart, workflowLoadOf } from './loads'
import { numberedRead, skillOutput } from './test-support'

let seq = 0
function part(data: unknown): RawPart {
  seq += 1
  return { id: `prt_${seq}`, message_id: 'msg_1', session_id: 'ses_1', time_created: seq, data: typeof data === 'string' ? data : JSON.stringify(data) }
}
function toolPart(tool: string, input: Record<string, unknown>, output: string | undefined, status = 'completed'): RawPart {
  return part({ type: 'tool', callID: 'call_1', tool, state: { status, input, ...(output === undefined ? {} : { output }), time: { start: 1, end: 2 } } })
}
const skillCall = (name: string, tool = 'skill', status = 'completed', output = skillOutput(name)) => toolPart(tool, { name }, output, status)
const read = (filePath: string, content: string) => toolPart('read', { filePath }, numberedRead(filePath, content))

const CURRENT = '---\nname: counterfactual\ndescription: current\n---\n\n# Counterfactual\n\nStep one: check the premise.\nStep two: write the record.\n'
const OLDER = '---\nname: counterfactual\ndescription: older\n---\n\n# Counterfactual\n\nStep one: test the weakest premise.\n'
const SYNTHESIS = '---\nname: synthesis\ndescription: s\n---\n\n# Synthesis\n\nCompare the analyses and name the shared source.\n'
const bodies: SkillBodies = { counterfactual: [CURRENT, OLDER], synthesis: [SYNTHESIS] }

describe('toolUseOfPart', () => {
  test('a stored tool part becomes the tool-use shape the detectors take, with its stored fields', () => {
    const use = toolUseOfPart(toolPart('read', { filePath: 'a.txt' }, 'out'))
    expect(use).toMatchObject({ tool: 'read', storedTool: 'read', status: 'completed', input: { filePath: 'a.txt' }, output: 'out', callID: 'call_1', startMs: 1, endMs: 2 })
  })

  test('a systematic_skill part is normalized to the skill tool, keeping its stored name', () => {
    const use = toolUseOfPart(skillCall('synthesis', 'systematic_skill'))
    expect(use?.tool).toBe('skill')
    expect(use?.storedTool).toBe('systematic_skill')
  })

  test('anything that is not a tool part, or is unreadable, is null and never throws', () => {
    expect(toolUseOfPart(part({ type: 'text', text: 'hello' }))).toBeNull()
    expect(toolUseOfPart(part('not json {'))).toBeNull()
    expect(toolUseOfPart(part('[]'))).toBeNull()
    expect(toolUseOfPart(part({ type: 'tool', tool: 'read' }))).toMatchObject({ tool: 'read', status: undefined, output: undefined })
    expect(toolUseOfPart(part({ type: 'tool', state: {} }))).toBeNull()
  })
})

describe('methodCallOf', () => {
  const kindOf = (p: RawPart) => {
    const use = toolUseOfPart(p)
    return use ? methodCallOf(use) : 'no tool use'
  }

  test('a call that loads or records a method is classified from its input alone, whatever its status or output', () => {
    expect(kindOf(skillCall('counterfactual'))).toBe('skill_call')
    expect(kindOf(skillCall('systematic:synthesis', 'systematic_skill', 'error', 'boom'))).toBe('skill_call')
    expect(kindOf(skillCall('Counterfactual', 'skill', 'running', ''))).toBe('skill_call')
    expect(kindOf(read('/pkg/skills/synthesis/SKILL.md', 'partial'))).toBe('file_read')
    expect(kindOf(toolPart('bash', { command: 'cat skills/counterfactual/SKILL.md' }, 'x'))).toBe('file_read')
    expect(kindOf(toolPart('bash', { command: 'node skills/synthesis/scripts/record.mjs < in.json' }, 'x', 'error'))).toBe('helper_call')
  })

  test('any other call is none, including a workflow skill, another file and another shell command', () => {
    expect(kindOf(skillCall('ce:plan'))).toBeNull()
    expect(kindOf(read('src/a.ts', 'x'))).toBeNull()
    expect(kindOf(toolPart('bash', { command: 'ls' }, 'x'))).toBeNull()
    expect(kindOf(toolPart('bash', {}, 'x'))).toBeNull()
    expect(kindOf(toolPart('task', { prompt: 'use the counterfactual method' }, 'x'))).toBeNull()
  })
})

describe('parseJsonObject', () => {
  test('is the object for an object, and null for anything else, without throwing', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    for (const text of ['', 'not json', 'null', '[1]', '"s"', '3', '{broken']) expect(parseJsonObject(text)).toBeNull()
  })
})

describe('workflowLoadOf', () => {
  test('a completed load of ce:plan or ce:review, by either skill tool', () => {
    expect(workflowLoadOf(skillCall('ce:plan'))).toBe('ce:plan')
    expect(workflowLoadOf(skillCall('ce:review', 'systematic_skill'))).toBe('ce:review')
  })

  test('the systematic: prefix the plugin tool accepts names the same skill', () => {
    expect(workflowLoadOf(skillCall('systematic:ce:plan', 'systematic_skill'))).toBe('ce:plan')
  })

  test('other skills, other tools and calls that did not complete are not workflow loads', () => {
    expect(workflowLoadOf(skillCall('ce:work'))).toBeNull()
    expect(workflowLoadOf(skillCall('counterfactual'))).toBeNull()
    expect(workflowLoadOf(skillCall('ce:plan', 'skill', 'error'))).toBeNull()
    expect(workflowLoadOf(skillCall('ce:plan', 'skill', 'running'))).toBeNull()
    expect(workflowLoadOf(toolPart('read', { name: 'ce:plan' }, 'x'))).toBeNull()
    expect(workflowLoadOf(toolPart('skill', {}, 'x'))).toBeNull()
    expect(workflowLoadOf(part({ type: 'text', text: 'ce:plan' }))).toBeNull()
  })
})

describe('loadEvents', () => {
  test('a completed skill call, by either tool, is a load with the skill-call basis', () => {
    for (const tool of ['skill', 'systematic_skill']) {
      const p = skillCall('counterfactual', tool)
      expect(loadEvents(p, bodies)).toEqual([{ method: 'counterfactual', basis: 'skill_call', partId: p.id }])
    }
    const s = skillCall('synthesis')
    expect(loadEvents(s, bodies)).toEqual([{ method: 'synthesis', basis: 'skill_call', partId: s.id }])
  })

  test('a skill call that errored, or whose output is not skill content, is no load', () => {
    expect(loadEvents(skillCall('counterfactual', 'skill', 'error'), bodies)).toEqual([])
    expect(loadEvents(skillCall('counterfactual', 'skill', 'running'), bodies)).toEqual([])
    expect(loadEvents(skillCall('counterfactual', 'skill', 'completed', 'Skill not found'), bodies)).toEqual([])
  })

  test('a skill call for a workflow or an unrelated skill is no method load', () => {
    expect(loadEvents(skillCall('ce:plan'), bodies)).toEqual([])
    expect(loadEvents(skillCall('feel'), bodies)).toEqual([])
  })

  test('a read whose output holds the whole current body is a load with the direct-read basis', () => {
    const p = read('/repo/skills/counterfactual/SKILL.md', CURRENT)
    expect(loadEvents(p, bodies)).toEqual([{ method: 'counterfactual', basis: 'direct_read', partId: p.id }])
  })

  test('a read holding the whole body of an older version is also a load', () => {
    const p = read('/repo/skills/counterfactual/SKILL.md', OLDER)
    expect(loadEvents(p, bodies).map((e) => e.basis)).toEqual(['direct_read'])
  })

  test('a read that returns only part of the file is no load', () => {
    const half = CURRENT.split('\n').slice(0, 8).join('\n')
    expect(loadEvents(read('/repo/skills/counterfactual/SKILL.md', half), bodies)).toEqual([])
  })

  test('a read of a body no supplied version holds, or with no versions supplied, is no load', () => {
    const edited = CURRENT.replace('premise', 'assumption')
    expect(loadEvents(read('/repo/skills/counterfactual/SKILL.md', edited), bodies)).toEqual([])
    expect(loadEvents(read('/repo/skills/counterfactual/SKILL.md', CURRENT), { counterfactual: [], synthesis: [] })).toEqual([])
  })

  test('a read credits only the method whose file it read', () => {
    const p = read('/repo/skills/synthesis/SKILL.md', SYNTHESIS)
    expect(loadEvents(p, bodies).map((e) => e.method)).toEqual(['synthesis'])
    expect(loadEvents(read('/repo/skills/other/SKILL.md', SYNTHESIS), bodies)).toEqual([])
  })

  test('a failed read is no load', () => {
    const p = toolPart('read', { filePath: '/repo/skills/counterfactual/SKILL.md' }, numberedRead('x', CURRENT), 'error')
    expect(loadEvents(p, bodies)).toEqual([])
  })

  test('parts that are not tool parts carry no load', () => {
    expect(loadEvents(part({ type: 'text', text: skillOutput('counterfactual') }), bodies)).toEqual([])
  })
})

describe('intervalEvidence', () => {
  const event = (method: LoadEvent['method'], basis: LoadEvent['basis'], partId: string): LoadEvent => ({ method, basis, partId })

  test('reports per method whether a load fell in the interval, on which basis, and whether the method loaded earlier', () => {
    const evidence = intervalEvidence([event('counterfactual', 'direct_read', 'p2')], [event('synthesis', 'skill_call', 'p1')])
    expect(evidence.counterfactual).toEqual({ loaded: true, basis: 'direct_read', events: [event('counterfactual', 'direct_read', 'p2')], loadedEarlier: false })
    expect(evidence.synthesis).toEqual({ loaded: false, basis: null, events: [], loadedEarlier: true })
  })

  test('with no events at all nothing is loaded', () => {
    const evidence = intervalEvidence([], [])
    for (const method of ['counterfactual', 'synthesis'] as const) expect(evidence[method]).toEqual({ loaded: false, basis: null, events: [], loadedEarlier: false })
  })

  test('the basis is that of the first load in the interval', () => {
    const evidence = intervalEvidence([event('synthesis', 'skill_call', 'a'), event('synthesis', 'direct_read', 'b')], [])
    expect(evidence.synthesis.basis).toBe('skill_call')
    expect(evidence.synthesis.events).toHaveLength(2)
  })
})

describe('collectSkillBodies', () => {
  const repos: TestRepo[] = []
  afterEach(() => {
    for (const r of repos.splice(0)) r.destroy()
  })

  function commitAt(repo: TestRepo, iso: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) repo.write(path, text)
    repo.sh(['add', '--', ...Object.keys(files)])
    const env = { ...hermeticGitEnv(), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }
    const r = spawnSync('git', ['-C', repo.dir, 'commit', '-q', '-m', `at ${iso}`, '--allow-empty'], { encoding: 'utf8', env })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  const file = (method: string) => `skills/${method}/SKILL.md`
  const window = { start: '2026-02-01', end: '2026-02-28' }

  function history() {
    const repo = new TestRepo('metacogs-skill-history-')
    repos.push(repo)
    commitAt(repo, '2026-01-10T10:00:00Z', { [file('counterfactual')]: 'v-before', [file('synthesis')]: 's-before' })
    commitAt(repo, '2026-01-20T10:00:00Z', { [file('counterfactual')]: 'v-in-force' })
    commitAt(repo, '2026-02-01T00:30:00Z', { [file('counterfactual')]: 'v-first-day' })
    commitAt(repo, '2026-02-15T10:00:00Z', { [file('counterfactual')]: 'v-middle', [file('synthesis')]: 's-middle' })
    commitAt(repo, '2026-02-28T23:30:00Z', { [file('counterfactual')]: 'v-last-day' })
    commitAt(repo, '2026-03-01T00:30:00Z', { [file('counterfactual')]: 'v-after' })
    return repo
  }

  test('collects the version in force when the window opens and every version committed inside it, and no later one', () => {
    const repo = history()
    const collected = collectSkillBodies(repo.git, window)
    expect([...collected.counterfactual].sort()).toEqual(['v-first-day', 'v-in-force', 'v-last-day', 'v-middle'])
    expect([...collected.synthesis].sort()).toEqual(['s-before', 's-middle'])
  })

  test('with no commit inside the window, the version in force is the only one', () => {
    const repo = history()
    const collected = collectSkillBodies(repo.git, { start: '2026-01-25', end: '2026-01-31' })
    expect(collected.counterfactual).toEqual(['v-in-force'])
    expect(collected.synthesis).toEqual(['s-before'])
  })

  test('identical versions are listed once, and the body is the file text unchanged', () => {
    const repo = history()
    commitAt(repo, '2026-02-20T10:00:00Z', { [file('counterfactual')]: 'v-middle' })
    const collected = collectSkillBodies(repo.git, window)
    expect(collected.counterfactual.filter((t) => t === 'v-middle')).toHaveLength(1)
  })

  test('a method with no version up to the end of the window is an error, not an empty list', () => {
    const repo = new TestRepo('metacogs-skill-history-')
    repos.push(repo)
    commitAt(repo, '2026-02-10T10:00:00Z', { [file('counterfactual')]: 'only' })
    expect(() => collectSkillBodies(repo.git, window)).toThrow(/synthesis/)
  })
})
