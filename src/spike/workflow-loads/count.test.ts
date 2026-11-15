import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUCKETS,
  COVERAGE_NOTES,
  CountRefusal,
  type CountReason,
  countLoads,
  decideOutcome,
  type LoadCounts,
  MODEL_FAMILIES,
  modelFamily,
  runCount,
  type SlotLabeling,
} from './count'
import { DECLARATION_PATH, GateRefusal, type Label, type Method, METHODS, recordDeviation } from './declaration'
import type { LabelingCoverage, Proposal } from './labeler'
import { intervalEvidence, type IntervalEvidence, type LoadBasis, type LoadEvent, type SkillBodies } from './loads'
import { answerOmission, judgeProposal, type Lock, lockMarks, MarksRefusal, type MarksReason, openMarking, pendingOmissions, pendingProposals } from './marks'
import { buildHiddenView, type HiddenView } from './mask'
import {
  freezeManifest,
  openPrivateRoot,
  readManifest,
  type RawMessage,
  type WalkedEntry,
  type WalkedScope,
  type WalkedSession,
  type WalkedStimulus,
  walkManifest,
} from './store'
import { gatedRepo, seedWorkflowSession, sampleDeclaration, syntheticStore } from './test-support'

const FIRE = 'expected_fire'
const SILENCE = 'expected_silence'
const HASH = 'a'.repeat(64)
const BODIES: SkillBodies = { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] }

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

// ── hand-built walks: counting is pure over a walk, so no store is needed ──

type LoadSpec = { loaded?: LoadBasis; earlier?: boolean }
type Loads = Partial<Record<Method, LoadSpec>>

function evidence(loads: Loads = {}): IntervalEvidence {
  const inInterval: LoadEvent[] = []
  const earlier: LoadEvent[] = []
  for (const method of METHODS) {
    const spec = loads[method]
    if (spec?.loaded) inInterval.push({ method, basis: spec.loaded, partId: `p_${method}` })
    if (spec?.earlier) earlier.push({ method, basis: 'skill_call', partId: `e_${method}` })
  }
  return intervalEvidence(inInterval, earlier)
}

const message = (id: string, data: Record<string, unknown>): RawMessage => ({ id, session_id: 's', time_created: 1, data: JSON.stringify(data) })
const assistantEntry = (id: string, model?: { providerID?: string; modelID?: string }): WalkedEntry => ({ message: message(id, { role: 'assistant', ...model }), role: 'assistant', parts: [] })

function stimulus(id: string, loads: Loads = {}, after: WalkedEntry[] = []): WalkedStimulus {
  const entry: WalkedEntry = { message: message(id, { role: 'user' }), role: 'user', parts: [] }
  return { id, kind: 'user_message', tool: null, messageId: id, partId: null, entry, after, loads: evidence(loads) }
}

function walked(sessionId: string, stimuli: WalkedStimulus[], firstAssistant: RawMessage | null = null): WalkedSession {
  const scope: WalkedScope = { workflow: 'ce:plan', loadPartId: 'load', stimuli, ended: 'session_end' }
  return { sessionId, lastMessage: { id: 'last', time_created: 1 }, scopes: [scope], firstAssistant, unreadableRows: 0 }
}

const mark = (sessionId: string, stimulusId: string, method: Method, label: Label, source: 'proposal' | 'omission' = 'proposal') => ({ sessionId, scopeIndex: 0, stimulusId, method, label, source })

function lockOf(slot: 'initial' | 'added', marks: ReturnType<typeof mark>[], extra: Partial<Pick<Lock, 'omissionSampleSize' | 'omissionsFound'>> = {}): Lock {
  return { schemaVersion: 1, slot, declarationHash: HASH, manifestHash: HASH, lockedAt: '2026-01-01T00:00:00.000Z', marks, omissionSampleSize: 0, omissionsFound: 0, lockHash: HASH, ...extra }
}

const reasonOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof CountRefusal || e instanceof MarksRefusal || e instanceof GateRefusal) return e.reason
    throw e
  }
  throw new Error('expected a refusal')
}

const { counterfactual: CF, synthesis: SY } = { counterfactual: 'counterfactual', synthesis: 'synthesis' } as const

describe('countLoads: the buckets', () => {
  test('an expected-fire mark with a skill-call load in its interval is a hit, counted by basis', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], { initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } })])] })
    expect(counts.methods.counterfactual.buckets).toEqual({ hit: 1, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
    expect(counts.methods.counterfactual.hitsByBasis).toEqual({ skill_call: 1, direct_read: 0 })
    expect(counts.methods.counterfactual.accepted).toEqual({ expected_fire: 1, expected_silence: 0 })
  })

  test('an expected-fire mark with a complete direct read in its interval is a hit by direct read', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, FIRE)])], { initial: [walked('s1', [stimulus('a', { synthesis: { loaded: 'direct_read' } })])] })
    expect(counts.methods.synthesis.buckets.hit).toBe(1)
    expect(counts.methods.synthesis.hitsByBasis).toEqual({ skill_call: 0, direct_read: 1 })
  })

  test('an expected-fire mark with no load and no earlier load is a miss', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], { initial: [walked('s1', [stimulus('a')])] })
    expect(counts.methods.counterfactual.buckets).toEqual({ hit: 0, miss: 1, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
    expect(counts.methods.counterfactual.hitsByBasis).toEqual({ skill_call: 0, direct_read: 0 })
  })

  test('an expected-fire mark with no load where the method loaded earlier is "loaded earlier", not a miss', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'b', CF, FIRE)])], { initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } }), stimulus('b', { counterfactual: { earlier: true } })])] })
    expect(counts.methods.counterfactual.buckets).toEqual({ hit: 0, miss: 0, loaded_earlier: 1, false_fire: 0, correct_silence: 0 })
  })

  test('an expected-fire mark whose interval holds a load is a hit even when the method loaded earlier too', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], { initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call', earlier: true } })])] })
    expect(counts.methods.counterfactual.buckets.hit).toBe(1)
    expect(counts.methods.counterfactual.buckets.loaded_earlier).toBe(0)
  })

  test('an expected-silence mark with a load in its interval is a false fire, whether or not the method loaded earlier', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE), mark('s1', 'b', SY, SILENCE)])], {
      initial: [walked('s1', [stimulus('a', { synthesis: { loaded: 'skill_call' } }), stimulus('b', { synthesis: { loaded: 'direct_read', earlier: true } })])],
    })
    expect(counts.methods.synthesis.buckets).toEqual({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 2, correct_silence: 0 })
    // a load under an expected-silence mark is never a hit, so the hit-basis count stays empty
    expect(counts.methods.synthesis.hitsByBasis).toEqual({ skill_call: 0, direct_read: 0 })
  })

  test('an expected-silence mark with no load is a correct silence, whether or not the method loaded earlier', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE), mark('s1', 'b', SY, SILENCE)])], { initial: [walked('s1', [stimulus('a'), stimulus('b', { synthesis: { earlier: true } })])] })
    expect(counts.methods.synthesis.buckets).toEqual({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 2 })
  })

  test('a load in the interval after the mark does not make the mark a hit; there it is an unmarked load', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], {
      initial: [walked('s1', [stimulus('a'), stimulus('b', { counterfactual: { loaded: 'skill_call' } })])],
    })
    expect(counts.methods.counterfactual.buckets).toEqual({ hit: 0, miss: 1, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
    expect(counts.methods.counterfactual.unmarkedLoads).toBe(1)
  })

  test('a load at an unmarked stimulus is an unmarked load for that method and changes no bucket', () => {
    const base = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], { initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } }), stimulus('b')])] })
    const withLoad = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], {
      initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } }), stimulus('b', { counterfactual: { loaded: 'direct_read' }, synthesis: { loaded: 'skill_call' } })])],
    })
    expect(base.methods.counterfactual.unmarkedLoads).toBe(0)
    expect(withLoad.methods.counterfactual.unmarkedLoads).toBe(1)
    expect(withLoad.methods.synthesis.unmarkedLoads).toBe(1)
    expect(withLoad.methods.counterfactual.buckets).toEqual(base.methods.counterfactual.buckets)
    expect(withLoad.methods.counterfactual.hitsByBasis).toEqual(base.methods.counterfactual.hitsByBasis)
    expect(withLoad.methods.synthesis.buckets).toEqual(base.methods.synthesis.buckets)
  })

  test('a load at a stimulus marked for the other method only is still unmarked for the loaded method', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE)])], { initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } })])] })
    expect(counts.methods.counterfactual.unmarkedLoads).toBe(1)
    expect(counts.methods.synthesis.buckets.correct_silence).toBe(1)
    expect(counts.methods.synthesis.unmarkedLoads).toBe(0)
  })

  test('a mark for one method is unaffected by a load of the other', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE), mark('s1', 'a', SY, SILENCE)])], {
      initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } })])],
    })
    expect(counts.methods.counterfactual.buckets.hit).toBe(1)
    expect(counts.methods.synthesis.buckets).toEqual({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 1 })
  })

  test('two loads in one interval are one hit and one unmarked count, not two', () => {
    const loads = { counterfactual: { loaded: 'skill_call' as const } }
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], {
      initial: [walked('s1', [{ ...stimulus('a', loads), loads: { ...evidence(loads), counterfactual: { ...evidence(loads).counterfactual, events: [{ method: 'counterfactual', basis: 'skill_call', partId: 'x' }, { method: 'counterfactual', basis: 'direct_read', partId: 'y' }] } } }, stimulus('b', loads)])],
    })
    expect(counts.methods.counterfactual.buckets.hit).toBe(1)
    expect(counts.methods.counterfactual.unmarkedLoads).toBe(1)
  })

  test('accepted marks count per method and label, from both sources', () => {
    const counts = countLoads(
      [lockOf('initial', [mark('s1', 'a', CF, FIRE), mark('s1', 'b', CF, FIRE, 'omission'), mark('s1', 'c', CF, SILENCE), mark('s1', 'd', SY, FIRE, 'omission'), mark('s1', 'e', SY, SILENCE)])],
      { initial: [walked('s1', ['a', 'b', 'c', 'd', 'e'].map((id) => stimulus(id)))] },
    )
    expect(counts.methods.counterfactual.accepted).toEqual({ expected_fire: 2, expected_silence: 1 })
    expect(counts.methods.synthesis.accepted).toEqual({ expected_fire: 1, expected_silence: 1 })
  })

  test('stimuli in scope are counted over every walked session of a locked slot', () => {
    const counts = countLoads([lockOf('initial', [])], { initial: [walked('s1', [stimulus('a'), stimulus('b')]), walked('s2', [stimulus('c')])] })
    expect(counts.stimuli).toBe(3)
  })

  test('marks from two locks are counted together', () => {
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)]), lockOf('added', [mark('s9', 'z', CF, FIRE), mark('s9', 'y', SY, SILENCE)])], {
      initial: [walked('s1', [stimulus('a', { counterfactual: { loaded: 'skill_call' } })])],
      added: [walked('s9', [stimulus('z'), stimulus('y')])],
    })
    expect(counts.methods.counterfactual.accepted.expected_fire).toBe(2)
    expect(counts.methods.counterfactual.buckets).toMatchObject({ hit: 1, miss: 1 })
    expect(counts.methods.synthesis.buckets.correct_silence).toBe(1)
    expect(counts.stimuli).toBe(3)
  })

  test('a scope index separates two scopes of one session that reuse a stimulus position', () => {
    const scopes: WalkedScope[] = [
      { workflow: 'ce:plan', loadPartId: 'l1', ended: 'workflow_load', stimuli: [stimulus('a', { counterfactual: { loaded: 'skill_call' } })] },
      { workflow: 'ce:review', loadPartId: 'l2', ended: 'session_end', stimuli: [stimulus('b')] },
    ]
    const session: WalkedSession = { sessionId: 's1', lastMessage: { id: 'last', time_created: 1 }, scopes, firstAssistant: null, unreadableRows: 0 }
    const counts = countLoads([lockOf('initial', [{ ...mark('s1', 'b', CF, FIRE), scopeIndex: 1 }])], { initial: [session] })
    // `b` has no load and nothing loaded before it in this hand-built evidence, so it is a miss; the load at `a` is unmarked
    expect(counts.methods.counterfactual.buckets.miss).toBe(1)
    expect(counts.methods.counterfactual.unmarkedLoads).toBe(1)
  })

  test('a mark whose stimulus is not in the walk is a named refusal, not a skip', () => {
    const walks = { initial: [walked('s1', [stimulus('a')])] }
    expect(reasonOf(() => countLoads([lockOf('initial', [mark('s1', 'missing', CF, FIRE)])], walks))).toBe<CountReason>('mark_stimulus_not_found')
    expect(reasonOf(() => countLoads([lockOf('initial', [mark('other', 'a', CF, FIRE)])], walks))).toBe<CountReason>('mark_stimulus_not_found')
    expect(reasonOf(() => countLoads([lockOf('initial', [{ ...mark('s1', 'a', CF, FIRE), scopeIndex: 3 }])], walks))).toBe<CountReason>('mark_stimulus_not_found')
  })

  test('a lock whose slot was not walked is refused', () => {
    expect(reasonOf(() => countLoads([lockOf('added', [])], { initial: [] }))).toBe<CountReason>('slot_not_walked')
  })

  test('a hit whose evidence names no basis is an error, not a count under a guessed basis', () => {
    const broken = stimulus('a')
    broken.loads.counterfactual = { loaded: true, basis: null, events: [], loadedEarlier: false }
    expect(() => countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE)])], { initial: [walked('s1', [broken])] })).toThrow('no basis')
  })
})

describe('model families', () => {
  test('the list is fixed and ends in other', () => {
    expect(MODEL_FAMILIES).toEqual(['anthropic', 'openai', 'google', 'other'])
  })

  test.each([
    [{ providerID: 'anthropic', modelID: 'claude-opus-5-5' }, 'anthropic'],
    [{ providerID: 'openai', modelID: 'gpt-6-luna' }, 'openai'],
    [{ providerID: 'google', modelID: 'gemini-4-pro' }, 'google'],
    [{ providerID: 'Anthropic', modelID: 'x' }, 'anthropic'],
    // a proxy provider falls back to the model name
    [{ providerID: 'cliproxy', modelID: 'claude-haiku-5-5' }, 'anthropic'],
    [{ providerID: 'cliproxy', modelID: 'openai/gpt-6-luna' }, 'openai'],
    [{ modelID: 'gemini-4-flash' }, 'google'],
    [{ providerID: 'mistral', modelID: 'large' }, 'other'],
    [{ providerID: 'local' }, 'other'],
    [{}, 'other'],
  ] as const)('%j maps to %s', (ref, family) => {
    expect(modelFamily(ref)).toBe(family)
  })

  test('counts split by the family of the assistant message in the mark interval', () => {
    const session = walked('s1', [
      stimulus('a', { counterfactual: { loaded: 'skill_call' } }, [assistantEntry('m1', { providerID: 'anthropic', modelID: 'claude-x' })]),
      stimulus('b', {}, [assistantEntry('m2', { providerID: 'openai', modelID: 'gpt-x' })]),
    ])
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE), mark('s1', 'b', CF, FIRE)])], { initial: [session] })
    expect(counts.families.anthropic.counterfactual).toEqual({ hit: 1, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
    expect(counts.families.openai.counterfactual).toEqual({ hit: 0, miss: 1, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
    expect(counts.families.google.counterfactual).toEqual({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })
  })

  test('the first assistant message of the interval decides, and a later one does not', () => {
    const session = walked('s1', [stimulus('a', {}, [assistantEntry('m1', { providerID: 'google', modelID: 'gemini-x' }), assistantEntry('m2', { providerID: 'openai', modelID: 'gpt-x' })])])
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE)])], { initial: [session] })
    expect(counts.families.google.synthesis.correct_silence).toBe(1)
    expect(counts.families.openai.synthesis.correct_silence).toBe(0)
  })

  test('with no assistant message in the interval the session first assistant message decides', () => {
    const first = message('m0', { role: 'assistant', providerID: 'openai', modelID: 'gpt-x' })
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE)])], { initial: [walked('s1', [stimulus('a')], first)] })
    expect(counts.families.openai.synthesis.correct_silence).toBe(1)
  })

  test('a user message in the interval is not an assistant message', () => {
    const userEntry: WalkedEntry = { message: message('u', { role: 'user', model: { providerID: 'anthropic', modelID: 'claude-x' } }), role: 'user', parts: [] }
    const first = message('m0', { role: 'assistant', providerID: 'openai', modelID: 'gpt-x' })
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', SY, SILENCE)])], { initial: [walked('s1', [stimulus('a', {}, [userEntry])], first)] })
    expect(counts.families.openai.synthesis.correct_silence).toBe(1)
    expect(counts.families.anthropic.synthesis.correct_silence).toBe(0)
  })

  test('a missing, unreadable or unknown model is "other"', () => {
    const noModel = walked('s1', [stimulus('a', {}, [assistantEntry('m1')])])
    const noSession = walked('s2', [stimulus('b')])
    const unreadable = walked('s3', [stimulus('c', {}, [{ message: { id: 'bad', session_id: 's3', time_created: 1, data: 'not json' }, role: 'assistant', parts: [] }])])
    const unknown = walked('s4', [stimulus('d', {}, [assistantEntry('m4', { providerID: 'mistral', modelID: 'large' })])])
    const counts = countLoads([lockOf('initial', ['s1:a', 's2:b', 's3:c', 's4:d'].map((key) => mark(key.split(':')[0] ?? '', key.split(':')[1] ?? '', CF, SILENCE)))], { initial: [noModel, noSession, unreadable, unknown] })
    expect(counts.families.other.counterfactual.correct_silence).toBe(4)
  })

  test('the families add up to the method totals', () => {
    const session = walked('s1', [
      stimulus('a', { counterfactual: { loaded: 'skill_call' } }, [assistantEntry('m1', { providerID: 'anthropic' })]),
      stimulus('b', {}, [assistantEntry('m2', { providerID: 'openai' })]),
      stimulus('c', { counterfactual: { loaded: 'skill_call' } }, [assistantEntry('m3', { providerID: 'google' })]),
    ])
    const counts = countLoads([lockOf('initial', [mark('s1', 'a', CF, FIRE), mark('s1', 'b', CF, FIRE), mark('s1', 'c', CF, SILENCE)])], { initial: [session] })
    for (const bucket of BUCKETS) {
      const sum = MODEL_FAMILIES.reduce((n, family) => n + counts.families[family].counterfactual[bucket], 0)
      expect(sum).toBe(counts.methods.counterfactual.buckets[bucket])
    }
  })
})

// ── counting from a walk that is read once ─────────────────────────────────

describe('countLoads: a walk read once', () => {
  /** `probe.earlierStillHeld` is, when the third session is asked for, whether the first session's stimulus is still in memory. */
  const feed = (count: number, probe: { earlierStillHeld: boolean | null } = { earlierStillHeld: null }): Generator<WalkedSession> => {
    function* sessions(): Generator<WalkedSession> {
      const first: WeakRef<WalkedStimulus>[] = []
      for (let i = 0; i < count; i++) {
        if (i === 2) {
          Bun.gc(true)
          probe.earlierStillHeld = first[0]?.deref() !== undefined
        }
        const one = stimulus(`a${i}`, { counterfactual: { loaded: 'skill_call' } })
        if (i === 0) first.push(new WeakRef(one))
        yield walked(`s${i}`, [one])
      }
    }
    return sessions()
  }
  const locks = [lockOf('initial', [mark('s0', 'a0', CF, FIRE), mark('s2', 'a2', CF, SILENCE)])]

  test('a one-shot walk counts what the same sessions as an array count', () => {
    const fromArray = countLoads(locks, { initial: [...feed(3)] })
    expect(countLoads(locks, { initial: feed(3) })).toEqual(fromArray)
    expect(fromArray.stimuli).toBe(3)
  })

  test('the rows of a session already counted are not held while the next one is read', () => {
    const streamed = { earlierStillHeld: null as boolean | null }
    countLoads(locks, { initial: feed(3, streamed) })
    expect(streamed.earlierStillHeld).toBe(false)
    // the control: the same sessions held in an array are still there when the third is reached
    const held = { earlierStillHeld: null as boolean | null }
    const all = [...feed(3, held)]
    expect(held.earlierStillHeld).toBe(true)
    expect(all).toHaveLength(3)
  })
})

// ── the outcome rule ───────────────────────────────────────────────────────

/** Counts with the given accepted marks per method and label, and the given buckets. */
function countsWith(options: { accepted?: Partial<Record<Method, Partial<Record<Label, number>>>>; buckets?: Partial<Record<Method, Partial<Record<(typeof BUCKETS)[number], number>>>> } = {}): LoadCounts {
  const zero = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<(typeof BUCKETS)[number], number>
  const methods = Object.fromEntries(
    METHODS.map((method) => [method, { accepted: { expected_fire: 5, expected_silence: 3, ...options.accepted?.[method] }, buckets: { ...zero(), ...options.buckets?.[method] }, hitsByBasis: { skill_call: 0, direct_read: 0 }, unmarkedLoads: 0 }]),
  ) as unknown as LoadCounts['methods']
  const families = Object.fromEntries(MODEL_FAMILIES.map((f) => [f, Object.fromEntries(METHODS.map((m) => [m, zero()]))])) as unknown as LoadCounts['families']
  return { stimuli: 0, methods, families }
}

const COMPLETE: LabelingCoverage = { chunks: 4, labeled: 4, failed: 0, notAttempted: 0, spendCapReached: false, transportOutage: 0 }
const decide = (parts: { counts?: LoadCounts; coverage?: Partial<LabelingCoverage>; omissionsFound?: number; unreadableRows?: number; declaration?: Parameters<typeof sampleDeclaration>[0] } = {}) => {
  const declaration = sampleDeclaration(parts.declaration)
  return decideOutcome({ declaration, counts: parts.counts ?? countsWith(), coverage: { ...COMPLETE, ...parts.coverage }, omissionsFound: parts.omissionsFound ?? 0, unreadableRows: parts.unreadableRows ?? 0 })
}

describe('decideOutcome: errors-first', () => {
  test('no errors, complete coverage, omission limit kept and every minimum met is clean, with no notes', () => {
    expect(decide()).toEqual({ outcome: 'clean', notes: [] })
  })

  test('every minimum met exactly is clean; one less on any of the four is inconclusive naming the minimum', () => {
    expect(decide({ counts: countsWith({ accepted: { counterfactual: { expected_fire: 5 }, synthesis: { expected_silence: 3 } } }) }).outcome).toBe('clean')
    for (const method of METHODS) {
      for (const [label, min] of [['expected_fire', 5], ['expected_silence', 3]] as const) {
        const result = decide({ counts: countsWith({ accepted: { [method]: { [label]: min - 1 } } }) })
        expect(result).toEqual({ outcome: 'inconclusive', notes: ['minimum_unmet'] })
      }
    }
  })

  test('no errors with one minimum unmet is inconclusive', () => {
    expect(decide({ counts: countsWith({ accepted: { synthesis: { expected_silence: 2 } } }) })).toEqual({ outcome: 'inconclusive', notes: ['minimum_unmet'] })
  })

  test('no errors with every minimum met but one failed chunk is inconclusive', () => {
    expect(decide({ coverage: { labeled: 3, failed: 1 } })).toEqual({ outcome: 'inconclusive', notes: ['labeling_incomplete'] })
  })

  test('a chunk not attempted is incomplete coverage too', () => {
    expect(decide({ coverage: { labeled: 3, notAttempted: 1 } })).toEqual({ outcome: 'inconclusive', notes: ['labeling_incomplete'] })
  })

  test('no chunks at all is not complete coverage', () => {
    expect(decide({ coverage: { chunks: 0, labeled: 0 } })).toEqual({ outcome: 'inconclusive', notes: ['labeling_incomplete'] })
  })

  test('no errors with every minimum met but the omission limit exceeded is inconclusive; at the limit is clean', () => {
    expect(decide({ omissionsFound: 3 })).toEqual({ outcome: 'inconclusive', notes: ['omission_limit_exceeded'] })
    expect(decide({ omissionsFound: 2 })).toEqual({ outcome: 'clean', notes: [] })
  })

  test('the omission limit is the declared one', () => {
    expect(decide({ declaration: { omission: { sample_size: 20, limit: 0 } }, omissionsFound: 1 }).notes).toEqual(['omission_limit_exceeded'])
  })

  test('the spend cap reached with no error is inconclusive and carries its note', () => {
    expect(decide({ coverage: { labeled: 3, notAttempted: 1, spendCapReached: true } })).toEqual({ outcome: 'inconclusive', notes: ['labeling_incomplete', 'spend_cap_reached'] })
  })

  test('chunks stopped by a proxy outage keep the outcome from being clean, and carry their own note', () => {
    expect(decide({ coverage: { labeled: 3, notAttempted: 1, transportOutage: 1 } })).toEqual({ outcome: 'inconclusive', notes: ['labeling_incomplete', 'transport_outage'] })
    expect(decide({ coverage: { transportOutage: 0 } })).toEqual({ outcome: 'clean', notes: [] })
  })

  test('one miss with minimums unmet and the spend cap reached is errors observed, with every coverage note', () => {
    const result = decide({
      counts: countsWith({ accepted: { counterfactual: { expected_fire: 1 } }, buckets: { counterfactual: { miss: 1 } } }),
      coverage: { labeled: 2, notAttempted: 2, spendCapReached: true, transportOutage: 1 },
      omissionsFound: 5,
      unreadableRows: 1,
    })
    expect(result).toEqual({ outcome: 'errors_observed', notes: ['minimum_unmet', 'labeling_incomplete', 'spend_cap_reached', 'omission_limit_exceeded', 'unreadable_rows', 'transport_outage'] })
  })

  test('a miss alone is errors observed with no notes when coverage and minimums are fine', () => {
    expect(decide({ counts: countsWith({ buckets: { synthesis: { miss: 1 } } }) })).toEqual({ outcome: 'errors_observed', notes: [] })
  })

  test('a false fire alone is errors observed', () => {
    expect(decide({ counts: countsWith({ buckets: { counterfactual: { false_fire: 1 } } }) }).outcome).toBe('errors_observed')
  })

  test('"loaded earlier", hits, correct silences and unmarked loads are not errors', () => {
    const counts = countsWith({ buckets: { counterfactual: { hit: 4, loaded_earlier: 3, correct_silence: 2 } } })
    counts.methods.synthesis.unmarkedLoads = 7
    expect(decide({ counts }).outcome).toBe('clean')
  })

  test('zero accepted marks is inconclusive, never clean', () => {
    const none = countsWith({ accepted: { counterfactual: { expected_fire: 0, expected_silence: 0 }, synthesis: { expected_fire: 0, expected_silence: 0 } } })
    expect(decide({ counts: none })).toEqual({ outcome: 'inconclusive', notes: ['minimum_unmet'] })
  })

  test('any unreadable row keeps the outcome from being clean, and carries its note', () => {
    expect(decide({ unreadableRows: 1 })).toEqual({ outcome: 'inconclusive', notes: ['unreadable_rows'] })
    expect(decide({ unreadableRows: 0 })).toEqual({ outcome: 'clean', notes: [] })
  })

  test('unreadable rows do not hide an error: a miss with unreadable rows is errors observed, with the note', () => {
    expect(decide({ counts: countsWith({ buckets: { synthesis: { miss: 1 } } }), unreadableRows: 2 })).toEqual({ outcome: 'errors_observed', notes: ['unreadable_rows'] })
  })

  test('notes come in the fixed order, each once', () => {
    expect(COVERAGE_NOTES).toEqual(['minimum_unmet', 'labeling_incomplete', 'spend_cap_reached', 'omission_limit_exceeded', 'unreadable_rows', 'transport_outage'])
  })
})

// ── counting over a real store: the gate, the locks, two slots ─────────────

function fixture(overrides: Parameters<typeof gatedRepo>[0] = {}) {
  const { repo } = gatedRepo(overrides)
  const store = syntheticStore()
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-count-'))
  const privateRoot = openPrivateRoot({ root: join(dir, 'state'), repoRoot: repo.dir })
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  const input = { git: repo.git, db: store.path, privateRoot }
  /** A workflow session with one user-message stimulus, answered by an assistant message that loads counterfactual when `loads`. */
  const seed = (id: string, loads: boolean): string => {
    seedWorkflowSession(store, { id, created: '2026-01-15' })
    const user = store.addMessage(id, 'user')
    store.addText(user, `question for ${id}`)
    const answer = store.addMessage(id, 'assistant', { providerID: 'anthropic', modelID: 'claude-x' })
    if (loads) store.addSkillCall(answer, 'counterfactual')
    else store.addText(answer, 'an answer')
    return user
  }
  const build = (slot: 'initial' | 'added'): HiddenView => {
    freezeManifest({ ...input, slot })
    return buildHiddenView({ git: repo.git, sessions: walkManifest({ ...input, slot, skillBodies: BODIES }) })
  }
  /** Judges every proposal accepted, answers the omission sample with neither, and locks. */
  const lock = (view: HiddenView, slot: 'initial' | 'added', proposals: Proposal[]): Lock => {
    const marking = { git: repo.git, privateRoot, slot, proposals, view }
    for (const item of pendingProposals(openMarking(marking))) judgeProposal(marking, item, { action: 'accept' })
    for (const ref of pendingOmissions(openMarking(marking))) answerOmission(marking, ref, { counterfactual: 'neither', synthesis: 'neither' })
    return lockMarks(marking)
  }
  const labeling = (slot: 'initial' | 'added', coverage: LabelingCoverage = COMPLETE): Partial<Record<'initial' | 'added', SlotLabeling>> => ({ [slot]: { coverage, counters: { scrubbedOutputs: 1, scrubbedInputs: 2, scrubbedStimuli: 3, redactedEmails: 4 } } })
  return { repo, store, privateRoot, input, seed, build, lock, labeling }
}

const prop = (view: HiddenView, sessionId: string, method: Method, label: Label): Proposal => {
  const scope = view.scopes.find((s) => s.sessionId === sessionId)
  const stimulusId = scope?.stimuli[0]?.id
  if (scope === undefined || stimulusId === undefined) throw new Error('no stimulus')
  return { sessionId, scopeIndex: scope.scopeIndex, stimulusId, method, label, reason: 'a reason' }
}

describe('runCount', () => {
  test('counts the locked marks against the walked intervals and reports the sample, the omissions and the sums', () => {
    const f = fixture({ omission: { sample_size: 3, limit: 2 } })
    f.seed('s1', true)
    f.seed('s2', false)
    const view = f.build('initial')
    f.lock(view, 'initial', [prop(view, 's1', 'counterfactual', FIRE), prop(view, 's2', 'counterfactual', FIRE)])

    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: f.labeling('initial') })
    expect(report.counts.methods.counterfactual.buckets).toMatchObject({ hit: 1, miss: 1 })
    expect(report.counts.families.anthropic.counterfactual).toMatchObject({ hit: 1, miss: 1 })
    expect(report.counts.stimuli).toBe(2)
    expect(report.outcome).toBe('errors_observed')
    expect(report.notes).toEqual(['minimum_unmet'])
    expect(report.slots).toEqual(['initial'])
    const manifest = readManifest(f.privateRoot, 'initial')
    if (!manifest) throw new Error('no manifest')
    expect(report.sample).toEqual({ considered: manifest.considered, eligible: manifest.eligible, sampled: 2, exclusions: manifest.exclusions })
    expect(report.scrubbed).toEqual({ scrubbedOutputs: 1, scrubbedInputs: 2, scrubbedStimuli: 3, redactedEmails: 4 })
    expect(report.omissions).toEqual({ sampleSize: 0, found: 0 })
    expect(report.deviations).toEqual([])
    expect(report.declarationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(report.coverage).toEqual(COMPLETE)
    expect(report.unreadableRows).toBe(0)
    expect(report.notes).not.toContain('unreadable_rows')
  })

  test('marks from two locks are counted together; the sample is the sessions of both slots and the store counts are the initial manifest\'s', () => {
    const f = fixture({ session_cap: 2 })
    for (const id of ['s1', 's2', 's3', 's4']) f.seed(id, true)
    const initial = f.build('initial')
    const initialIds = initial.scopes.map((scope) => scope.sessionId)
    f.lock(initial, 'initial', initialIds.map((id) => prop(initial, id, 'counterfactual', FIRE)))
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 4 } })
    const added = f.build('added')
    const addedIds = added.scopes.map((scope) => scope.sessionId)
    f.lock(added, 'added', addedIds.map((id) => prop(added, id, 'counterfactual', FIRE)))

    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: { ...f.labeling('initial'), ...f.labeling('added') } })
    expect(report.slots).toEqual(['initial', 'added'])
    expect(report.counts.methods.counterfactual.accepted.expected_fire).toBe(4)
    expect(report.counts.methods.counterfactual.buckets.hit).toBe(4)
    expect(report.counts.stimuli).toBe(4)
    // the sample is the sessions of both slots; the store's size and the exclusions are the initial manifest's alone, because the
    // added manifest scans the whole store again
    const [a, b] = [readManifest(f.privateRoot, 'initial'), readManifest(f.privateRoot, 'added')]
    if (!a || !b) throw new Error('no manifest')
    expect(b.considered).toBeGreaterThan(0)
    expect(b.exclusions.already_sampled).toBeGreaterThan(0)
    expect(report.sample.sampled).toBe(a.sessions.length + b.sessions.length)
    expect(report.sample.sampled).toBe(4)
    expect(report.sample.considered).toBe(a.considered)
    expect(report.sample.eligible).toBe(a.eligible)
    expect(report.sample.exclusions).toEqual(a.exclusions)
    expect(report.coverage.chunks).toBe(2 * COMPLETE.chunks)
    expect(report.coverage.transportOutage).toBe(0)
    expect(report.scrubbed.scrubbedOutputs).toBe(2)
    expect(report.deviations).toEqual(['session_cap_raise'])
  })

  test('chunks stopped by an outage are summed over the slots and named in the notes', () => {
    const f = fixture({ session_cap: 2 })
    for (const id of ['s1', 's2', 's3', 's4']) f.seed(id, true)
    const initial = f.build('initial')
    f.lock(initial, 'initial', [])
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 4 } })
    f.lock(f.build('added'), 'added', [])
    const stopped = { ...COMPLETE, labeled: 2, notAttempted: 2, transportOutage: 2 }
    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: { ...f.labeling('initial', stopped), ...f.labeling('added', stopped) } })
    expect(report.coverage).toMatchObject({ chunks: 8, labeled: 4, notAttempted: 4, transportOutage: 4 })
    expect(report.notes).toContain('transport_outage')
    expect(report.outcome).not.toBe('clean')
  })

  test('the omission counts are the sums over the locks', () => {
    const f = fixture({ omission: { sample_size: 2, limit: 2 } })
    f.seed('s1', true)
    const view = f.build('initial')
    const marking = { git: f.repo.git, privateRoot: f.privateRoot, slot: 'initial' as const, proposals: [] as Proposal[], view }
    for (const ref of pendingOmissions(openMarking(marking))) answerOmission(marking, ref, { counterfactual: 'expected_fire', synthesis: 'neither' })
    lockMarks(marking)
    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: f.labeling('initial') })
    expect(report.omissions).toEqual({ sampleSize: 1, found: 1 })
    expect(report.counts.methods.counterfactual.accepted.expected_fire).toBe(1)
  })

  test('the omission counts are summed over two locks, not taken from one', () => {
    const f = fixture({ session_cap: 1, omission: { sample_size: 5, limit: 2 } })
    f.seed('s1', true)
    f.seed('s2', true)
    const answerAll = (view: HiddenView, slot: 'initial' | 'added'): void => {
      const marking = { git: f.repo.git, privateRoot: f.privateRoot, slot, proposals: [] as Proposal[], view }
      for (const ref of pendingOmissions(openMarking(marking))) answerOmission(marking, ref, { counterfactual: 'expected_fire', synthesis: 'neither' })
      lockMarks(marking)
    }
    answerAll(f.build('initial'), 'initial')
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 2 } })
    answerAll(f.build('added'), 'added')
    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: { ...f.labeling('initial'), ...f.labeling('added') } })
    expect(report.omissions).toEqual({ sampleSize: 2, found: 2 })
    expect(report.counts.methods.counterfactual.accepted.expected_fire).toBe(2)
    expect(report.notes).not.toContain('omission_limit_exceeded')
  })

  test('unreadable rows are summed over the walks of every locked slot, and the report cannot be clean with any', () => {
    const f = fixture({ session_cap: 1, min_accepted_marks: { counterfactual: { expected_fire: 1, expected_silence: 1 }, synthesis: { expected_fire: 1, expected_silence: 1 } } })
    f.seed('s1', true)
    f.seed('s2', true)
    const spoil = (session: string, data: string): void => {
      const part = f.store.addText(f.store.addMessage(session, 'assistant'), 'x')
      f.store.db.run('UPDATE part SET data = ? WHERE id = ?', [data, part])
    }
    spoil('s1', '{broken')
    spoil('s2', 'null')
    const initial = f.build('initial')
    f.lock(initial, 'initial', [])
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 2 } })
    const added = f.build('added')
    f.lock(added, 'added', [])
    const report = runCount({ ...f.input, skillBodies: BODIES, labeling: { ...f.labeling('initial'), ...f.labeling('added') } })
    expect(report.slots).toEqual(['initial', 'added'])
    expect(report.unreadableRows).toBe(2)
    expect(report.notes).toContain('unreadable_rows')
    expect(report.outcome).not.toBe('clean')
  })

  test('is refused with the lock reasons: none at all, and a frozen slot that is not locked', () => {
    const f = fixture({ session_cap: 1 })
    f.seed('s1', true)
    f.seed('s2', true)
    const initial = f.build('initial')
    expect(reasonOf(() => runCount({ ...f.input, skillBodies: BODIES, labeling: f.labeling('initial') }))).toBe<MarksReason>('no_lock')
    f.lock(initial, 'initial', [])
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 2 } })
    f.build('added')
    expect(reasonOf(() => runCount({ ...f.input, skillBodies: BODIES, labeling: f.labeling('initial') }))).toBe<MarksReason>('slot_not_locked')
  })

  test('is refused when a locked slot has no labeling state', () => {
    const f = fixture()
    f.seed('s1', true)
    f.lock(f.build('initial'), 'initial', [])
    expect(reasonOf(() => runCount({ ...f.input, skillBodies: BODIES, labeling: {} }))).toBe<CountReason>('labeling_missing')
  })

  test('is refused when the declaration gate fails', () => {
    const f = fixture()
    f.seed('s1', true)
    f.lock(f.build('initial'), 'initial', [])
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    expect(reasonOf(() => runCount({ ...f.input, skillBodies: BODIES, labeling: f.labeling('initial') }))).toBe('declaration_modified')
  })
})
