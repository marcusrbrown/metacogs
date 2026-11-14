import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saltedHash } from '../../runner/prereg'
import { CustodyError } from '../../runner/workspace'
import type { Proposal } from './labeler'
import { type Declaration, DECLARATION_PATH, GateRefusal, type Label, type Method, recordDeviation } from './declaration'
import type { SkillBodies } from './loads'
import {
  answerOmission,
  judgeProposal,
  type Lock,
  lockMarks,
  lockPath,
  type MarkingInput,
  MarksRefusal,
  type MarksReason,
  omissionSample,
  openMarking,
  pendingOmissions,
  pendingProposals,
  proposalItems,
  readLocks,
  requireLocks,
  type StimulusRef,
} from './marks'
import { buildHiddenView, type HiddenView } from './mask'
import { freezeManifest, openPrivateRoot, readManifest, walkManifest } from './store'
import { gatedRepo, seedWorkflowSession, syntheticStore } from './test-support'

const BODIES: SkillBodies = { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] }
const FIRE = 'expected_fire'
const SILENCE = 'expected_silence'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function fixture(overrides: Partial<Declaration> = {}) {
  const { repo, declaration } = gatedRepo(overrides)
  const store = syntheticStore()
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-marks-'))
  const privateRoot = openPrivateRoot({ root: join(dir, 'state'), repoRoot: repo.dir })
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  const input = { git: repo.git, db: store.path, privateRoot }
  /** A workflow session whose scope holds one user-message stimulus per text; returns the stimulus ids. */
  const seed = (id: string, texts: readonly string[]): string[] => {
    seedWorkflowSession(store, { id, created: '2026-01-15' })
    return texts.map((text) => {
      const message = store.addMessage(id, 'user')
      store.addText(message, text)
      return message
    })
  }
  /** Freezes the slot's manifest if needed, then renders its hidden view. */
  const build = (slot: 'initial' | 'added' = 'initial'): HiddenView => {
    freezeManifest({ ...input, slot })
    const sessions = walkManifest({ ...input, slot, skillBodies: BODIES })
    return buildHiddenView({ git: repo.git, sessions })
  }
  const marking = (view: HiddenView, proposals: readonly Proposal[], slot: 'initial' | 'added' = 'initial'): MarkingInput => ({
    git: repo.git,
    privateRoot,
    slot,
    proposals,
    view,
  })
  return { repo, declaration, store, privateRoot, dir, input, seed, build, marking }
}
type Fixture = ReturnType<typeof fixture>

const prop = (sessionId: string, stimulusId: string, method: Method, label: Label, reason = 'a reason', scopeIndex = 0): Proposal => ({ sessionId, scopeIndex, stimulusId, method, label, reason })

const stimuliOf = (view: HiddenView): StimulusRef[] => view.scopes.flatMap((scope) => scope.stimuli.map((s) => ({ sessionId: scope.sessionId, scopeIndex: scope.scopeIndex, stimulusId: s.id })))

const refusal = (fn: () => unknown): MarksReason => {
  try {
    fn()
  } catch (e) {
    if (e instanceof MarksRefusal) return e.reason
    throw e
  }
  throw new Error('expected a MarksRefusal')
}

const markKey = (m: { sessionId: string; stimulusId: string; method: string; label: string; source: string }): string => `${m.sessionId}|${m.stimulusId}|${m.method}|${m.label}|${m.source}`
const sortedMarks = (lock: Lock): string[] => lock.marks.map(markKey).sort()

const NEITHER = { counterfactual: 'neither', synthesis: 'neither' } as const

/** A session `s1` with six stimuli: `proposed` are the first four, `unproposed` the last two. */
function sixStimuli(f: Fixture) {
  const ids = f.seed('s1', ['one', 'two', 'three', 'four', 'five', 'six'])
  const [a = '', b = '', c = '', d = '', e = '', g = ''] = ids
  const view = f.build()
  const proposals = [
    prop('s1', a, 'counterfactual', FIRE),
    prop('s1', b, 'counterfactual', SILENCE),
    prop('s1', c, 'synthesis', FIRE),
    prop('s1', d, 'synthesis', FIRE),
    prop('s1', d, 'synthesis', SILENCE),
  ]
  return { a, b, c, d, e, g, view, proposals, input: f.marking(view, proposals) }
}

describe('proposal items', () => {
  test('two proposals for the same stimulus, method and label are one item', () => {
    const items = proposalItems([prop('s1', 'm1', 'counterfactual', FIRE, 'first'), prop('s1', 'm1', 'counterfactual', FIRE, 'second'), prop('s1', 'm1', 'synthesis', FIRE)])
    expect(items).toHaveLength(2)
    expect(items[0]?.proposed).toEqual([{ label: FIRE, reason: 'first' }])
    expect(items[1]?.method).toBe('synthesis')
  })

  test('both labels for one stimulus and method are one item, labels in the declared order', () => {
    const items = proposalItems([prop('s1', 'm1', 'synthesis', SILENCE, 'quiet'), prop('s1', 'm1', 'synthesis', FIRE, 'loud')])
    expect(items).toHaveLength(1)
    expect(items[0]?.proposed).toEqual([
      { label: FIRE, reason: 'loud' },
      { label: SILENCE, reason: 'quiet' },
    ])
  })

  test('the same stimulus id in another scope or session is another item', () => {
    const items = proposalItems([prop('s1', 'm1', 'synthesis', FIRE), prop('s1', 'm1', 'synthesis', FIRE, 'r', 1), prop('s2', 'm1', 'synthesis', FIRE)])
    expect(items).toHaveLength(3)
  })
})

describe('judging proposals', () => {
  test('accept, relabel and a pick are stored; a reject is not a mark; the lock holds only the accepted marks', () => {
    const f = fixture()
    const { a, b, c, d, e, g, input } = sixStimuli(f)
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: b, method: 'counterfactual' }, { action: 'relabel' })
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: c, method: 'synthesis' }, { action: 'reject' })
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: d, method: 'synthesis' }, { action: 'pick', label: SILENCE })
    expect(pendingProposals(openMarking(input))).toEqual([])
    for (const ref of [e, g]) answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: ref }, NEITHER)

    const lock = lockMarks(input)
    expect(sortedMarks(lock)).toEqual(
      [
        `s1|${a}|counterfactual|${FIRE}|proposal`,
        // proposed expected_silence, relabeled to the other label
        `s1|${b}|counterfactual|${FIRE}|proposal`,
        `s1|${d}|synthesis|${SILENCE}|proposal`,
      ].sort(),
    )
  })

  test('a relabel stores the other label, in both directions', () => {
    const f = fixture()
    f.seed('s1', ['one', 'two'])
    const view = f.build()
    const [x = '', y = ''] = stimuliOf(view).map((s) => s.stimulusId)
    const input = f.marking(view, [prop('s1', x, 'counterfactual', FIRE), prop('s1', y, 'synthesis', SILENCE)])
    expect(judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: x, method: 'counterfactual' }, { action: 'relabel' })).toEqual({ action: 'relabel', label: SILENCE })
    expect(judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: y, method: 'synthesis' }, { action: 'relabel' })).toEqual({ action: 'relabel', label: FIRE })
  })

  test('an item with both labels takes a pick or a reject, and not accept, relabel or a label it was not given', () => {
    const f = fixture()
    const { d, input } = sixStimuli(f)
    const target = { sessionId: 's1', scopeIndex: 0, stimulusId: d, method: 'synthesis' } as const
    expect(refusal(() => judgeProposal(input, target, { action: 'accept' }))).toBe('choice_invalid')
    expect(refusal(() => judgeProposal(input, target, { action: 'relabel' }))).toBe('choice_invalid')
    expect(judgeProposal(input, target, { action: 'reject' })).toEqual({ action: 'reject' })
  })

  test('an item with one label takes accept, relabel or reject, and not a pick', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    const target = { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' } as const
    expect(refusal(() => judgeProposal(input, target, { action: 'pick', label: FIRE }))).toBe('choice_invalid')
    expect(pendingProposals(openMarking(input)).some((item) => item.stimulusId === a)).toBe(true)
  })

  test('a judged item is not judged again, and an unknown item is refused', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    const target = { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' } as const
    judgeProposal(input, target, { action: 'accept' })
    expect(refusal(() => judgeProposal(input, target, { action: 'reject' }))).toBe('already_judged')
    expect(refusal(() => judgeProposal(input, { ...target, stimulusId: 'nothing' }, { action: 'accept' }))).toBe('unknown_item')
    expect(refusal(() => judgeProposal(input, { ...target, method: 'synthesis' }, { action: 'accept' }))).toBe('unknown_item')
  })

  test('an interrupted session resumes at the first unjudged item, from the stored judgments', () => {
    const f = fixture()
    const { a, b, c, d, input } = sixStimuli(f)
    const first = pendingProposals(openMarking(input))
    expect(first.map((item) => item.stimulusId)).toEqual([a, b, c, d])
    const [one, two] = first
    if (!one || !two) throw new Error('expected items')
    judgeProposal(input, one, { action: 'accept' })
    judgeProposal(input, two, { action: 'reject' })
    // a fresh open, as after a restart
    const resumed = pendingProposals(openMarking({ ...input }))
    expect(resumed.map((item) => item.stimulusId)).toEqual([c, d])
  })

  test('each judgment is stored under the declaration hash and the manifest hash', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    const marking = openMarking(input)
    const dir = join(f.privateRoot.root, 'marks', 'initial', 'judgments')
    const [name] = readdirSync(dir)
    const stored = JSON.parse(readFileSync(join(dir, name ?? ''), 'utf8')) as Record<string, unknown>
    expect(stored.declarationHash).toBe(marking.declarationHash)
    expect(stored.manifestHash).toBe(marking.manifestHash)
    expect(marking.manifestHash).toBe(readManifest(f.privateRoot, 'initial')?.manifest_hash ?? 'no manifest')
  })

  test('a stored judgment bound to another manifest is refused, not skipped', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    const dir = join(f.privateRoot.root, 'marks', 'initial', 'judgments')
    const file = join(dir, readdirSync(dir)[0] ?? '')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...stored, manifestHash: 'f'.repeat(64) }))
    expect(refusal(() => openMarking(input))).toBe('judgments_invalid')
  })

  test('a judgment made when the item had other labels no longer counts', () => {
    const f = fixture()
    const { a, view } = sixStimuli(f)
    const single = f.marking(view, [prop('s1', a, 'counterfactual', FIRE)])
    judgeProposal(single, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    const both = f.marking(view, [prop('s1', a, 'counterfactual', FIRE), prop('s1', a, 'counterfactual', SILENCE)])
    expect(pendingProposals(openMarking(both))).toHaveLength(1)
  })

  test('judgments files are owner-only', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    const dir = join(f.privateRoot.root, 'marks', 'initial', 'judgments')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, readdirSync(dir)[0] ?? '')).mode & 0o777).toBe(0o600)
  })
})

describe('the omission sample', () => {
  test('it holds the declared number of stimuli, none of them proposed, and is the same on every run', () => {
    const f = fixture({ omission: { sample_size: 5, limit: 2 } })
    const texts = Array.from({ length: 30 }, (_, i) => `text ${i}`)
    const ids = f.seed('s1', texts)
    const view = f.build()
    const proposals = ids.slice(0, 10).map((id) => prop('s1', id, 'counterfactual', FIRE))
    const proposed = new Set(ids.slice(0, 10))

    const first = openMarking(f.marking(view, proposals)).sample
    const second = openMarking(f.marking(view, proposals)).sample
    expect(first).toHaveLength(5)
    expect(second).toEqual(first)
    expect(first.every((ref) => !proposed.has(ref.stimulusId))).toBe(true)
    expect(new Set(first.map((ref) => ref.stimulusId)).size).toBe(5)
  })

  test('a stimulus proposed for any one method is left out, whichever method', () => {
    const f = fixture({ omission: { sample_size: 3, limit: 1 } })
    const [a = '', b = '', c = ''] = f.seed('s1', ['x', 'y', 'z'])
    const view = f.build()
    const sample = openMarking(f.marking(view, [prop('s1', a, 'synthesis', SILENCE), prop('s1', b, 'counterfactual', FIRE)])).sample
    expect(sample.map((ref) => ref.stimulusId)).toEqual([c])
  })

  test('another salt gives another sample, and the ranking uses its own prefix, apart from the session order', () => {
    const view: Pick<HiddenView, 'scopes'> = {
      scopes: [{ sessionId: 's1', scopeIndex: 0, workflow: 'ce:plan', stimuli: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, kind: 'user_message' as const, text: '', traffic: [] })) }],
    }
    const one = omissionSample(view, [], { salt: 'salt-one', omission: { sample_size: 6, limit: 1 } })
    const two = omissionSample(view, [], { salt: 'salt-two', omission: { sample_size: 6, limit: 1 } })
    expect(one).not.toEqual(two)
    const expected = Array.from({ length: 40 }, (_, i) => `m${i}`)
      .map((id) => ({ id, key: saltedHash('salt-one', `omission:${JSON.stringify(['s1', 0, id])}`) }))
      .sort((x, y) => (x.key < y.key ? -1 : 1))
      .slice(0, 6)
      .map((entry) => entry.id)
    expect(one.map((ref) => ref.stimulusId)).toEqual(expected)
    // the order that ranks sessions is a different construction
    const asSessionOrder = Array.from({ length: 40 }, (_, i) => `m${i}`)
      .map((id) => ({ id, key: saltedHash('salt-one', `session:${id}`) }))
      .sort((x, y) => (x.key < y.key ? -1 : 1))
      .slice(0, 6)
      .map((entry) => entry.id)
    expect(expected).not.toEqual(asSessionOrder)
  })

  test('fewer unproposed stimuli than the sample size are all sampled, and the lock records the actual size', () => {
    const f = fixture({ omission: { sample_size: 10, limit: 2 } })
    const { a, b, c, d, e, g, input } = sixStimuli(f)
    for (const [stimulusId, method] of [
      [a, 'counterfactual'],
      [b, 'counterfactual'],
      [c, 'synthesis'],
      [d, 'synthesis'],
    ] as const) {
      judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId, method }, stimulusId === d ? { action: 'reject' } : { action: 'accept' })
    }
    const marking = openMarking(input)
    expect(marking.sample.map((ref) => ref.stimulusId).sort()).toEqual([e, g].sort())
    for (const ref of marking.sample) answerOmission(input, ref, NEITHER)
    const lock = lockMarks(input)
    expect(lock.omissionSampleSize).toBe(2)
    expect(lock.omissionsFound).toBe(0)
  })

  test('a view with no unproposed stimulus has an empty sample, and locks with size zero', () => {
    const f = fixture()
    const [a = ''] = f.seed('s1', ['only'])
    const view = f.build()
    const input = f.marking(view, [prop('s1', a, 'counterfactual', FIRE)])
    expect(openMarking(input).sample).toEqual([])
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    expect(lockMarks(input).omissionSampleSize).toBe(0)
  })
})

describe('omission answers', () => {
  test('an answer of expected fire adds a mark and counts one omission', () => {
    const f = fixture()
    const { a, b, c, d, e, g, input } = sixStimuli(f)
    for (const [stimulusId, method, action] of [
      [a, 'counterfactual', 'accept'],
      [b, 'counterfactual', 'accept'],
      [c, 'synthesis', 'accept'],
    ] as const)
      judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId, method }, { action })
    judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: d, method: 'synthesis' }, { action: 'reject' })
    answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: e }, { counterfactual: 'expected_fire', synthesis: 'neither' })
    answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: g }, NEITHER)
    const lock = lockMarks(input)
    expect(lock.omissionsFound).toBe(1)
    expect(sortedMarks(lock)).toContain(`s1|${e}|counterfactual|${FIRE}|omission`)
    expect(lock.marks.filter((m) => m.source === 'omission')).toHaveLength(1)
  })

  test('omissions are counted per stimulus and method answer: two answers on one stimulus are two omissions', () => {
    const f = fixture()
    const { a, b, c, d, e, g, input } = sixStimuli(f)
    for (const [stimulusId, method] of [
      [a, 'counterfactual'],
      [b, 'counterfactual'],
      [c, 'synthesis'],
      [d, 'synthesis'],
    ] as const)
      judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId, method }, stimulusId === d ? { action: 'reject' } : { action: 'accept' })
    answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: e }, { counterfactual: 'expected_fire', synthesis: 'expected_silence' })
    answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: g }, { counterfactual: 'neither', synthesis: 'expected_fire' })
    const lock = lockMarks(input)
    expect(lock.omissionsFound).toBe(3)
    expect(sortedMarks(lock).filter((k) => k.endsWith('|omission'))).toEqual(
      [`s1|${e}|counterfactual|${FIRE}|omission`, `s1|${e}|synthesis|${SILENCE}|omission`, `s1|${g}|synthesis|${FIRE}|omission`].sort(),
    )
  })

  test('an answer for a stimulus outside the sample, or a second answer, is refused', () => {
    const f = fixture()
    const { a, e, input } = sixStimuli(f)
    expect(refusal(() => answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a }, NEITHER))).toBe('unknown_item')
    answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: e }, NEITHER)
    expect(refusal(() => answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: e }, { counterfactual: 'expected_fire', synthesis: 'neither' }))).toBe('already_answered')
    expect(pendingOmissions(openMarking(input)).map((ref) => ref.stimulusId)).not.toContain(e)
  })
})

describe('the lock', () => {
  /** Judges every proposal item with `accept` or `pick`, then answers the sample as neither. */
  function finish(input: MarkingInput): void {
    for (const item of pendingProposals(openMarking(input))) judgeProposal(input, item, item.proposed.length === 2 ? { action: 'pick', label: FIRE } : { action: 'accept' })
    for (const ref of pendingOmissions(openMarking(input))) answerOmission(input, ref, NEITHER)
  }

  test('it is refused while proposals remain, and again while omission items remain, and writes nothing', () => {
    const f = fixture()
    const { input } = sixStimuli(f)
    expect(refusal(() => lockMarks(input))).toBe('items_remaining')
    for (const item of pendingProposals(openMarking(input))) judgeProposal(input, item, item.proposed.length === 2 ? { action: 'pick', label: FIRE } : { action: 'accept' })
    expect(refusal(() => lockMarks(input))).toBe('items_remaining')
    expect(existsSync(lockPath(f.privateRoot, 'initial'))).toBe(false)
    expect(readLocks(f.privateRoot, openMarking(input).declarationHash)).toEqual([])
  })

  test('the lock binds the declaration hash and the manifest hash and records the omission counts and a verifiable lock hash', () => {
    const f = fixture()
    const { input } = sixStimuli(f)
    finish(input)
    const lock = lockMarks(input)
    const marking = openMarking(input)
    expect(lock.declarationHash).toBe(marking.declarationHash)
    expect(lock.manifestHash).toBe(marking.manifestHash)
    expect(lock.slot).toBe('initial')
    expect(lock.omissionSampleSize).toBe(2)
    expect(lock.omissionsFound).toBe(0)
    expect(lock.lockHash).toMatch(/^[0-9a-f]{64}$/)
    expect(readLocks(f.privateRoot, lock.declarationHash)).toEqual([lock])
    expect(requireLocks(f.privateRoot, lock.declarationHash)).toEqual([lock])
    expect(statSync(lockPath(f.privateRoot, 'initial')).mode & 0o777).toBe(0o600)
    for (const mark of lock.marks) expect(Object.keys(mark).sort()).toEqual(['label', 'method', 'scopeIndex', 'sessionId', 'source', 'stimulusId'])
  })

  test('after a lock no judgment, answer or second lock is accepted', () => {
    const f = fixture()
    const { a, e, input } = sixStimuli(f)
    finish(input)
    lockMarks(input)
    const before = readFileSync(lockPath(f.privateRoot, 'initial'), 'utf8')
    expect(refusal(() => judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'reject' }))).toBe('slot_locked')
    expect(refusal(() => answerOmission(input, { sessionId: 's1', scopeIndex: 0, stimulusId: e }, NEITHER))).toBe('slot_locked')
    expect(refusal(() => lockMarks(input))).toBe('slot_locked')
    expect(readFileSync(lockPath(f.privateRoot, 'initial'), 'utf8')).toBe(before)
  })

  test('a lock that was edited, or that belongs to another declaration or manifest, is refused', () => {
    const f = fixture()
    const { input } = sixStimuli(f)
    finish(input)
    const lock = lockMarks(input)
    expect(refusal(() => readLocks(f.privateRoot, 'a'.repeat(64)))).toBe('lock_declaration_mismatch')

    const path = lockPath(f.privateRoot, 'initial')
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, JSON.stringify({ ...lock, marks: [...lock.marks, { sessionId: 's1', scopeIndex: 0, stimulusId: 'x', method: 'synthesis', label: FIRE, source: 'proposal' }] }))
    expect(refusal(() => readLocks(f.privateRoot, lock.declarationHash))).toBe('lock_tampered')
    writeFileSync(path, JSON.stringify({ ...lock, extra: true }))
    expect(refusal(() => readLocks(f.privateRoot, lock.declarationHash))).toBe('lock_invalid')
    writeFileSync(path, 'not json')
    expect(refusal(() => readLocks(f.privateRoot, lock.declarationHash))).toBe('lock_invalid')
    writeFileSync(path, original)
    expect(readLocks(f.privateRoot, lock.declarationHash)).toEqual([lock])
  })

  test('counting needs a lock: with none, the named refusal; with an unlocked frozen slot, another', () => {
    const f = fixture({ session_cap: 2 })
    f.seed('s1', ['one'])
    f.seed('s2', ['two'])
    f.seed('s3', ['three'])
    f.seed('s4', ['four'])
    const initial = f.build('initial')
    const hash = openMarking(f.marking(initial, [])).declarationHash
    expect(refusal(() => requireLocks(f.privateRoot, hash))).toBe('no_lock')

    const input = f.marking(initial, [])
    finish(input)
    lockMarks(input)
    expect(requireLocks(f.privateRoot, hash)).toHaveLength(1)

    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 4 } })
    f.build('added')
    expect(refusal(() => requireLocks(f.privateRoot, hash))).toBe('slot_not_locked')
    expect(readLocks(f.privateRoot, hash)).toHaveLength(1)
  })
})

describe('the added slot', () => {
  test('has its own judgments and its own lock, holds only marks from the added sessions, and leaves the initial lock as it was', () => {
    const f = fixture({ session_cap: 2 })
    for (const id of ['s1', 's2', 's3', 's4']) f.seed(id, [`${id} one`, `${id} two`])
    const initialView = f.build('initial')
    const initialIds = new Set(initialView.scopes.map((scope) => scope.sessionId))
    expect(initialIds.size).toBe(2)

    const lockSlot = (view: HiddenView, slot: 'initial' | 'added'): Lock => {
      // one proposal per session, on its first stimulus
      const proposals = view.scopes.map((scope) => prop(scope.sessionId, scope.stimuli[0]?.id ?? '', 'counterfactual', FIRE))
      const input = f.marking(view, proposals, slot)
      for (const item of pendingProposals(openMarking(input))) judgeProposal(input, item, { action: 'accept' })
      for (const ref of pendingOmissions(openMarking(input))) answerOmission(input, ref, { counterfactual: 'expected_silence', synthesis: 'neither' })
      return lockMarks(input)
    }

    const initialLock = lockSlot(initialView, 'initial')
    const initialBytes = readFileSync(lockPath(f.privateRoot, 'initial'), 'utf8')

    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 4 } })
    const addedView = f.build('added')
    const addedIds = new Set(addedView.scopes.map((scope) => scope.sessionId))
    expect(addedIds.size).toBe(2)
    for (const id of addedIds) expect(initialIds.has(id)).toBe(false)

    const addedLock = lockSlot(addedView, 'added')
    expect(addedLock.slot).toBe('added')
    expect(addedLock.manifestHash).not.toBe(initialLock.manifestHash)
    expect(addedLock.marks.length).toBeGreaterThan(0)
    for (const mark of addedLock.marks) expect(addedIds.has(mark.sessionId)).toBe(true)
    for (const mark of initialLock.marks) expect(initialIds.has(mark.sessionId)).toBe(true)
    expect(readFileSync(lockPath(f.privateRoot, 'initial'), 'utf8')).toBe(initialBytes)
    expect(existsSync(join(f.privateRoot.root, 'marks', 'added', 'judgments'))).toBe(true)

    const locks = readLocks(f.privateRoot, addedLock.declarationHash)
    expect(locks.map((l) => l.slot)).toEqual(['initial', 'added'])
    expect(requireLocks(f.privateRoot, addedLock.declarationHash)).toEqual(locks)
  })

  test('a view of the other slot is refused', () => {
    const f = fixture({ session_cap: 2 })
    for (const id of ['s1', 's2', 's3', 's4']) f.seed(id, [`${id} one`])
    const initialView = f.build('initial')
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 4 } })
    f.build('added')
    expect(refusal(() => openMarking(f.marking(initialView, [], 'added')))).toBe('view_slot_mismatch')
  })
})

describe('refusals', () => {
  test('a view built under another declaration is refused', () => {
    const f = fixture()
    f.seed('s1', ['one'])
    const view = f.build()
    expect(refusal(() => openMarking(f.marking({ ...view, declarationHash: 'b'.repeat(64) }, [])))).toBe('view_declaration_mismatch')
  })

  test('a proposal for a stimulus the view does not hold is refused', () => {
    const f = fixture()
    f.seed('s1', ['one'])
    const view = f.build()
    expect(refusal(() => openMarking(f.marking(view, [prop('s1', 'absent', 'counterfactual', FIRE)])))).toBe('proposal_not_in_view')
  })

  test('judging is refused when the declaration gate fails, and writes nothing', () => {
    const f = fixture()
    const { a, input } = sixStimuli(f)
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    let error: unknown
    try {
      judgeProposal(input, { sessionId: 's1', scopeIndex: 0, stimulusId: a, method: 'counterfactual' }, { action: 'accept' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(GateRefusal)
    expect(existsSync(join(f.privateRoot.root, 'marks'))).toBe(false)
  })

  test('a missing manifest is refused', () => {
    const f = fixture()
    f.seed('s1', ['one'])
    const view = f.build()
    rmSync(join(f.privateRoot.root, 'manifest-initial.json'))
    let error: unknown
    try {
      openMarking(f.marking(view, []))
    } catch (e) {
      error = e
    }
    expect((error as { reason?: string }).reason).toBe('manifest_missing')
  })

  test('a private root inside the repository is refused before anything is written', () => {
    const f = fixture()
    f.seed('s1', ['one'])
    const view = f.build()
    const inside = { root: join(f.repo.dir, 'private'), now: f.privateRoot.now }
    let error: unknown
    try {
      openMarking({ ...f.marking(view, []), privateRoot: inside })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(CustodyError)
    expect(existsSync(inside.root)).toBe(false)
  })

  test('judging and locking write only under the private root', () => {
    const f = fixture()
    const { input } = sixStimuli(f)
    const before = f.repo.git.porcelain([])
    for (const item of pendingProposals(openMarking(input))) judgeProposal(input, item, item.proposed.length === 2 ? { action: 'pick', label: SILENCE } : { action: 'accept' })
    for (const ref of pendingOmissions(openMarking(input))) answerOmission(input, ref, NEITHER)
    lockMarks(input)
    expect(f.repo.git.porcelain([])).toBe(before)
    expect(readdirSync(join(f.privateRoot.root, 'marks')).sort()).toEqual(['initial', 'lock-initial.json'])
  })
})
