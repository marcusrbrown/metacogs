import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordFilename } from '../record/canonical'
import { validRecord } from '../record/test-support'
import {
  checkBudget,
  classifyHostOutcome,
  fireEvidence,
  hasFired,
  isDeniedSkillCall,
  listRecordFiles,
  type RecordFile,
  runChecks,
} from './checks'
import { analyzeEvents } from './events'

const ev = (o: unknown) => JSON.stringify(o)
const toolUse = (tool: string, state: Record<string, unknown>) => ev({ type: 'tool_use', timestamp: 1, part: { type: 'tool', tool, callID: `${tool}-1`, state } })
const skillLoad = (name = 'counterfactual') => toolUse('skill', { status: 'completed', input: { name }, output: `<skill_content name="${name}">x</skill_content>`, metadata: { name, dir: '/d' } })
const helperCall = () => toolUse('bash', { status: 'completed', input: { command: 'node /ws/.agents/skills/counterfactual/scripts/record.mjs --file r.json' }, output: '{}' })
const invalidSkill = () =>
  toolUse('invalid', { status: 'completed', input: { tool: 'skill' }, output: "Model tried to call unavailable tool 'skill'. Available tools: bash, read" })
const finish = ev({ type: 'step_finish', timestamp: 2, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } })

const stream = (...lines: string[]) => analyzeEvents([...lines, finish].join('\n'))

function recordFile(overrides: Record<string, unknown> = {}): RecordFile {
  const record = validRecord(overrides)
  return { name: recordFilename(record), content: JSON.stringify(record) }
}

const base = { method: 'counterfactual' } as const

describe('false-fire detection (negative fixtures)', () => {
  const negative = (events: ReturnType<typeof stream>, records: RecordFile[] = []) =>
    runChecks({ ...base, condition: 'skill', kind: 'negative', events, records })

  test('silence passes', () => {
    const r = negative(stream())
    expect(r.ok).toBe(true)
    expect(hasFired(r.fire)).toBe(false)
  })

  test('a skill tool call naming the method is a false fire', () => {
    const r = negative(stream(skillLoad()))
    expect(r.failures.map((f) => f.code)).toContain('false_fire_skill_call')
  })

  test('a denied skill call (invalid pseudo-tool naming the unavailable skill tool) counts as an attempted fire', () => {
    const events = stream(invalidSkill())
    expect(isDeniedSkillCall(events.toolUses[0]!)).toBe(true)
    const r = negative(events)
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.code)).toEqual(['false_fire_denied_skill_call'])
    expect(r.fire.deniedSkillCall).toBe(true)
  })

  test('an invalid call to some other tool is not an attempted skill fire', () => {
    const other = toolUse('invalid', { status: 'completed', input: {}, output: "Model tried to call unavailable tool 'weather'." })
    expect(negative(stream(other)).ok).toBe(true)
  })

  test('helper invocation in the trace is a false fire even if it wrote nothing', () => {
    expect(negative(stream(helperCall())).failures.map((f) => f.code)).toEqual(['false_fire_helper'])
  })

  test('any file in the records dir is a false fire', () => {
    const r = negative(stream(), [{ name: 'stray.txt', content: '' }])
    expect(r.failures.map((f) => f.code)).toEqual(['false_fire_record'])
  })

  test('a stream the parser could not fully read cannot prove silence', () => {
    const r = negative(analyzeEvents('garbage line\n'))
    expect(r.failures.map((f) => f.code)).toEqual(['unrecognized_events'])
  })
})

describe('baseline condition on a positive fixture', () => {
  const baseline = (events: ReturnType<typeof stream>, records: RecordFile[] = []) =>
    runChecks({ ...base, condition: 'baseline', kind: 'dev', events, records })

  test('no skill call, empty records: counted', () => {
    expect(baseline(stream()).ok).toBe(true)
  })

  test('a denied skill attempt is recorded but does not fail a baseline (rubric-only pass rule)', () => {
    const r = baseline(stream(invalidSkill()))
    expect(r.ok).toBe(true)
    expect(r.fire.deniedSkillCall).toBe(true)
  })

  test('a record in a baseline is a failure (nothing can have written it)', () => {
    expect(baseline(stream(), [recordFile()]).ok).toBe(false)
  })

  test('a helper probe in a baseline is evidence, not a failure: the helper does not exist there and denial text quotes the allowlist', () => {
    const r = baseline(stream(helperCall()))
    expect(r.ok).toBe(true)
    expect(r.fire.helperInvoked).toBe(true)
  })

  test('on a negative, a helper call fails the skill condition but not the baseline', () => {
    const negative = (condition: 'baseline' | 'skill') => runChecks({ ...base, condition, kind: 'negative', events: stream(helperCall()), records: [] })
    expect(negative('skill').failures.map((f) => f.code)).toEqual(['false_fire_helper'])
    expect(negative('baseline').ok).toBe(true)
  })
})

describe('skill condition on a positive fixture', () => {
  const skill = (events: ReturnType<typeof stream>, records: RecordFile[], expectedExecutionModes?: string[]) =>
    runChecks({ ...base, condition: 'skill', kind: 'heldout', events, records, expectedExecutionModes })

  test('skill loaded, helper invoked, valid record: passes', () => {
    const r = skill(stream(skillLoad(), helperCall()), [recordFile()])
    expect(r.failures).toEqual([])
    expect(r.validRecords).toHaveLength(1)
  })

  test('missing record, skill, or helper call each fail by name', () => {
    expect(skill(stream(skillLoad(), helperCall()), []).failures.map((f) => f.code)).toContain('record_missing')
    expect(skill(stream(helperCall()), [recordFile()]).failures.map((f) => f.code)).toContain('skill_not_loaded')
    expect(skill(stream(skillLoad()), [recordFile()]).failures.map((f) => f.code)).toContain('helper_not_invoked')
  })

  test('a denied skill load does not count as loaded', () => {
    const denied = toolUse('skill', { status: 'error', input: { name: 'counterfactual' }, error: 'denied' })
    expect(skill(stream(denied, helperCall()), [recordFile()]).failures.map((f) => f.code)).toContain('skill_not_loaded')
  })

  test('validator failures name the field; the record is not accepted', () => {
    const bad = { name: 'counterfactual-0000000000000000.json', content: JSON.stringify({ ...validRecord(), reopen_condition: '' }) }
    const r = skill(stream(skillLoad(), helperCall()), [bad])
    const f = r.failures.find((x) => x.code === 'record_invalid')
    expect(f?.message).toContain('reopen_condition')
    expect(r.validRecords).toEqual([])
  })

  test('execution_mode must be an expected one; unrecorded is never expected by default', () => {
    const unrecorded = recordFile({ execution_mode: 'unrecorded' })
    expect(skill(stream(skillLoad(), helperCall()), [unrecorded]).failures.map((f) => f.code)).toContain('execution_mode_unexpected')
    const delegated = recordFile({ execution_mode: 'delegated' })
    expect(skill(stream(skillLoad(), helperCall()), [delegated], ['sequential']).failures.map((f) => f.code)).toContain('execution_mode_unexpected')
    expect(skill(stream(skillLoad(), helperCall()), [delegated], ['sequential', 'delegated']).ok).toBe(true)
  })

  test('a record whose filename does not match its hash, or for another method, fails', () => {
    const renamed = { ...recordFile(), name: 'counterfactual-deadbeefdeadbeef.json' }
    expect(skill(stream(skillLoad(), helperCall()), [renamed]).failures.map((f) => f.code)).toContain('record_filename_mismatch')
    const wrongMethod = recordFile({ method: 'synthesis' })
    expect(skill(stream(skillLoad(), helperCall()), [wrongMethod]).failures.map((f) => f.code)).toContain('record_invalid')
  })

  test('stray non-record files fail', () => {
    const r = skill(stream(skillLoad(), helperCall()), [recordFile(), { name: 'notes.txt', content: 'x' }])
    expect(r.failures.map((f) => f.code)).toEqual(['record_unexpected'])
  })
})

describe('direct SKILL.md reads', () => {
  const SKILL_TEXT = '---\nname: counterfactual\ndescription: d\n---\n\n# Counterfactual\n\n1. Gate.\n2. Objective: state the decision.\n'
  const numbered = (text: string) => text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')
  const readOf = (filePath: string, output: string | undefined, status = 'completed') =>
    toolUse('read', { status, input: { filePath }, ...(output === undefined ? {} : { output }) })
  const FULL = `<path>/ws/.agents/skills/counterfactual/SKILL.md</path>\n<type>file</type>\n<content>\n${numbered(SKILL_TEXT)}\n\n(End of file - total 9 lines)\n</content>`
  const fullRead = (path = '/ws/.agents/skills/counterfactual/SKILL.md') => readOf(path, FULL)
  const positive = (events: ReturnType<typeof stream>, records: RecordFile[], skillText: string | undefined = SKILL_TEXT) =>
    runChecks({ ...base, condition: 'skill', kind: 'dev', events, records, skillText })

  test('a complete read of the installed SKILL.md plus helper and a valid record is a fire with basis direct_read', () => {
    const r = positive(stream(fullRead(), helperCall()), [recordFile()])
    expect(r.failures).toEqual([])
    expect(r.fire.fireBasis).toBe('direct_read')
    expect(r.fire.skillLoaded).toBe(false)
  })

  test('the skill tool wins the basis when both happened', () => {
    expect(positive(stream(fullRead(), skillLoad(), helperCall()), [recordFile()]).fire.fireBasis).toBe('skill_tool')
    expect(positive(stream(skillLoad(), helperCall()), [recordFile()]).fire.fireBasis).toBe('skill_tool')
  })

  test('a direct read without a record is not a fire that passes: record_missing and helper_not_invoked', () => {
    const r = positive(stream(fullRead()), [])
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.code)).toEqual(['helper_not_invoked', 'record_missing'])
    expect(r.failures.map((f) => f.code)).not.toContain('skill_not_loaded')
  })

  test('a record with no skill text ever loaded is flagged record_without_load: the model guessed the contract', () => {
    const r = positive(stream(helperCall()), [recordFile()])
    expect(r.ok).toBe(false)
    expect(r.fire.fireBasis).toBeNull()
    expect(r.failures.map((f) => f.code)).toEqual(['skill_not_loaded', 'record_without_load'])
    // A skill-less run that wrote no record is only skill_not_loaded plus the missing record.
    expect(positive(stream(), []).failures.map((f) => f.code)).toEqual(['skill_not_loaded', 'helper_not_invoked', 'record_missing'])
  })

  test('a read that does not carry the body (wrong file, truncated, errored, or no skill text to compare) does not credit', () => {
    const other = readOf('/ws/.agents/skills/synthesis/SKILL.md', FULL)
    const truncated = readOf('/ws/.agents/skills/counterfactual/SKILL.md', `<content>\n${numbered(SKILL_TEXT).split('\n').slice(0, 5).join('\n')}\n</content>`)
    const errored = readOf('/ws/.agents/skills/counterfactual/SKILL.md', undefined, 'error')
    for (const call of [other, truncated, errored]) {
      expect(positive(stream(call, helperCall()), [recordFile()]).fire.fireBasis).toBeNull()
    }
    const noText = runChecks({ ...base, condition: 'skill', kind: 'dev', events: stream(fullRead(), helperCall()), records: [recordFile()] })
    expect(noText.fire.fireBasis).toBeNull()
  })

  test('path matching: relative and dot-segment paths resolve; look-alike names and other files do not', () => {
    for (const ok of ['skills/counterfactual/SKILL.md', '.agents/skills/counterfactual/SKILL.md', '/ws/.agents/skills/x/../counterfactual/SKILL.md']) {
      expect(positive(stream(fullRead(ok), helperCall()), [recordFile()]).fire.fireBasis).toBe('direct_read')
    }
    for (const no of ['/ws/.agents/skills/counterfactual/notes.md', '/ws/myskills/counterfactual/SKILL.md', '/ws/.agents/skills/counterfactual-2/SKILL.md', '/ws/fixture.md']) {
      expect(positive(stream(fullRead(no), helperCall()), [recordFile()]).fire.fireBasis).toBeNull()
    }
  })

  test('negatives stay strict: any read of SKILL.md is a false fire, whatever it returned', () => {
    const negative = (events: ReturnType<typeof stream>) => runChecks({ ...base, condition: 'skill', kind: 'negative', events, records: [], skillText: SKILL_TEXT })
    expect(negative(stream(fullRead())).failures.map((f) => f.code)).toEqual(['false_fire_direct_read'])
    expect(negative(stream(readOf('/ws/.agents/skills/counterfactual/SKILL.md', undefined, 'error'))).failures.map((f) => f.code)).toEqual(['false_fire_direct_read'])
    expect(negative(stream(readOf('/ws/fixture.md', 'x'))).ok).toBe(true)
  })

  test('a host exit after a complete direct read is host_crash, not infra_error', () => {
    const events = stream(fullRead())
    const exit = { exitCode: 1, timedOut: false, aborted: false }
    expect(classifyHostOutcome(exit, events, 'counterfactual', SKILL_TEXT)).toBe('host_crash')
    expect(classifyHostOutcome(exit, events, 'counterfactual')).toBe('infra_error')
  })
})

describe('fireEvidence', () => {
  test('skill call naming another skill is not a fire for this method', () => {
    expect(fireEvidence('counterfactual', stream(skillLoad('synthesis')), []).skillCalled).toBe(false)
  })
})

describe('budget', () => {
  const events = stream(helperCall(), helperCall(), helperCall())
  test('within budget → null; breach names what and by how much', () => {
    expect(checkBudget(events, { max_tool_calls: 3, max_total_tokens: 1000 })).toBeNull()
    expect(checkBudget(events, { max_tool_calls: 2, max_total_tokens: 1000 })).toEqual({ what: 'tool_calls', limit: 2, actual: 3 })
    expect(checkBudget(events, { max_tool_calls: 10, max_total_tokens: 10 })).toEqual({ what: 'tokens', limit: 10, actual: 18 })
  })
})

describe('classifyHostOutcome', () => {
  const ok = { exitCode: 0, timedOut: false, aborted: false }
  test('exit 0 → completed', () => {
    expect(classifyHostOutcome(ok, stream(), 'counterfactual')).toBe('completed')
  })
  test('timeout and abort win over exit code', () => {
    expect(classifyHostOutcome({ ...ok, exitCode: -1, timedOut: true }, stream(), 'counterfactual')).toBe('timeout')
    expect(classifyHostOutcome({ ...ok, exitCode: -1, aborted: true }, stream(), 'counterfactual')).toBe('interrupted')
  })
  test('non-zero exit before skill content loads → infra_error', () => {
    expect(classifyHostOutcome({ ...ok, exitCode: 1 }, stream(), 'counterfactual')).toBe('infra_error')
    // A denied/errored skill call is not a content load.
    const denied = toolUse('skill', { status: 'error', input: { name: 'counterfactual' }, error: 'x' })
    expect(classifyHostOutcome({ ...ok, exitCode: 1 }, stream(denied), 'counterfactual')).toBe('infra_error')
  })
  test('non-zero exit after skill content loaded → host_crash (FAIL)', () => {
    expect(classifyHostOutcome({ ...ok, exitCode: 1 }, stream(skillLoad()), 'counterfactual')).toBe('host_crash')
  })
})

describe('listRecordFiles', () => {
  test('missing dir → empty; nested files are listed with relative names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-rec-'))
    try {
      expect(listRecordFiles(join(dir, 'absent'))).toEqual([])
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'a.json'), '{}')
      writeFileSync(join(dir, 'sub', 'b.json'), '{}')
      expect(listRecordFiles(dir).map((f) => f.name).sort()).toEqual(['a.json', 'sub/b.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
