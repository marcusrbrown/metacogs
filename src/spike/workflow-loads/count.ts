/**
 * Counting: each locked mark is set against the load evidence of its stimulus's interval, by the bucket table below, and the
 * outcome rule turns the totals into one of three outcomes. Nothing here prints or writes; the projection step keeps only counts.
 *
 * | Mark            | Load in the interval | Method loaded earlier in the session | Bucket         |
 * | --------------- | -------------------- | ------------------------------------ | -------------- |
 * | expected fire   | yes                  | either                               | hit            |
 * | expected fire   | no                   | no                                   | miss           |
 * | expected fire   | no                   | yes                                  | loaded earlier |
 * | expected silence| yes                  | either                               | false fire     |
 * | expected silence| no                   | either                               | correct silence|
 * | none            | yes                  | either                               | unmarked load  |
 *
 * A load belongs to the stimulus it follows, so a load in a later interval never turns an earlier mark into a hit. A mark whose
 * stimulus is not in the walk is a refusal, never a skipped mark.
 */
import type { Declaration, DeviationCode, GateInput, Label, Method } from './declaration'
import { assertGate, LABELS, METHODS } from './declaration'
import type { LabelingCoverage } from './labeler'
import type { IntervalEvidence, LoadBasis, MethodEvidence, SkillBodies } from './loads'
import { itemKey, type Lock, requireLocks, type StimulusRef, stimulusKey } from './marks'
import type { ViewCounters } from './mask'
import { type ExclusionReason, EXCLUSION_REASONS, ManifestError, type ManifestSlot, type PrivateRoot, readManifest, type RawMessage, type WalkedSession, type WalkedStimulus, walkManifestEach } from './store'

// ── refusals ───────────────────────────────────────────────────────────────

export type CountReason = 'mark_stimulus_not_found' | 'slot_not_walked' | 'labeling_missing'

const REFUSAL_MESSAGE: Record<CountReason, string> = {
  mark_stimulus_not_found: 'a locked mark names a stimulus that is not in the walk of its slot',
  slot_not_walked: 'a lock belongs to a slot that was not walked',
  labeling_missing: 'a locked slot has no labeling coverage to read',
}

/** Counting cannot proceed. The message is fixed per reason: it never names a session, a stimulus or any text. */
export class CountRefusal extends Error {
  constructor(readonly reason: CountReason) {
    super(`${reason}: ${REFUSAL_MESSAGE[reason]}`)
    this.name = 'CountRefusal'
  }
}

// ── model families ─────────────────────────────────────────────────────────

/** The only family labels a count carries. A model that matches none of the others is `other`. */
export const MODEL_FAMILIES = ['anthropic', 'openai', 'google', 'other'] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

/** Lower-case prefixes, matched against a provider id and then against a model id. */
const FAMILY_PREFIXES: readonly (readonly [Exclude<ModelFamily, 'other'>, readonly string[]])[] = [
  ['anthropic', ['anthropic', 'claude']],
  ['openai', ['openai', 'gpt']],
  ['google', ['google', 'gemini']],
]

const familyByPrefix = (id: string | undefined): Exclude<ModelFamily, 'other'> | undefined => {
  const text = id?.toLowerCase()
  return text === undefined ? undefined : FAMILY_PREFIXES.find(([, prefixes]) => prefixes.some((prefix) => text.startsWith(prefix)))?.[0]
}

/**
 * The coarse family of a stored model: the provider id's prefix first, then the model id's (a proxy's provider id names no family
 * but its model ids still do). An unknown or missing id is `other`.
 */
export function modelFamily(ref: { providerID?: string; modelID?: string }): ModelFamily {
  return familyByPrefix(ref.providerID) ?? familyByPrefix(ref.modelID) ?? 'other'
}

/** An assistant message's model, from its stored data. Unreadable data gives no model. */
function modelOf(message: RawMessage): { providerID?: string; modelID?: string } {
  let data: unknown
  try {
    data = JSON.parse(message.data)
  } catch {
    return {}
  }
  if (typeof data !== 'object' || data === null) return {}
  const { providerID, modelID } = data as { providerID?: unknown; modelID?: unknown }
  return { ...(typeof providerID === 'string' ? { providerID } : {}), ...(typeof modelID === 'string' ? { modelID } : {}) }
}

/**
 * The family of the first assistant message in the stimulus's interval, or, when the interval holds none, of the session's first
 * assistant message. A session with no assistant message is `other`.
 */
function familyOf(stimulus: WalkedStimulus, session: WalkedSession): ModelFamily {
  const message = stimulus.after.find((entry) => entry.role === 'assistant')?.message ?? session.firstAssistant
  return message ? modelFamily(modelOf(message)) : 'other'
}

// ── the buckets ────────────────────────────────────────────────────────────

export const BUCKETS = ['hit', 'miss', 'loaded_earlier', 'false_fire', 'correct_silence'] as const
export type Bucket = (typeof BUCKETS)[number]
export type BucketCounts = Record<Bucket, number>

export interface MethodCounts {
  /** Locked marks by label, from both sources. */
  accepted: Record<Label, number>
  buckets: BucketCounts
  /** Hits by how the first load in the interval reached the run. Adds up to `buckets.hit`. */
  hitsByBasis: Record<LoadBasis, number>
  /** Stimuli with a load of the method and no mark for the method. One per stimulus, however many loads it holds. */
  unmarkedLoads: number
}

export interface LoadCounts {
  /** Stimuli in the walks of every locked slot. */
  stimuli: number
  methods: Record<Method, MethodCounts>
  /** The buckets again, split by the family of the model that answered each marked stimulus. */
  families: Record<ModelFamily, Record<Method, BucketCounts>>
}

const zeroBuckets = (): BucketCounts => ({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })

function emptyCounts(): LoadCounts {
  const methods = {} as LoadCounts['methods']
  for (const method of METHODS) methods[method] = { accepted: { expected_fire: 0, expected_silence: 0 }, buckets: zeroBuckets(), hitsByBasis: { skill_call: 0, direct_read: 0 }, unmarkedLoads: 0 }
  const families = {} as LoadCounts['families']
  for (const family of MODEL_FAMILIES) {
    families[family] = {} as Record<Method, BucketCounts>
    for (const method of METHODS) families[family][method] = zeroBuckets()
  }
  return { stimuli: 0, methods, families }
}

function bucketOf(label: Label, evidence: MethodEvidence): Bucket {
  if (label === 'expected_fire') return evidence.loaded ? 'hit' : evidence.loadedEarlier ? 'loaded_earlier' : 'miss'
  return evidence.loaded ? 'false_fire' : 'correct_silence'
}

/** What counting keeps of a stimulus: its evidence and its model family, never the raw rows it came from. */
interface Located {
  ref: StimulusRef
  loads: IntervalEvidence
  family: ModelFamily
}

/**
 * Applies the bucket table to every locked mark and counts unmarked loads, over the walked sessions of each lock's slot. Refuses
 * with `slot_not_walked` when a lock's slot has no walk and `mark_stimulus_not_found` when a mark names a stimulus the walk lacks.
 * A walk is read once, one session at a time: only each stimulus's evidence is kept, so the raw rows of a session are free to go
 * as soon as the next one is asked for.
 */
export function countLoads(locks: readonly Lock[], walks: Partial<Record<ManifestSlot, Iterable<WalkedSession>>>): LoadCounts {
  const counts = emptyCounts()
  for (const lock of locks) {
    const sessions = walks[lock.slot]
    if (!sessions) throw new CountRefusal('slot_not_walked')
    const index = new Map<string, Located>()
    for (const session of sessions) {
      for (const [scopeIndex, scope] of session.scopes.entries()) {
        for (const stimulus of scope.stimuli) {
          counts.stimuli += 1
          const ref: StimulusRef = { sessionId: session.sessionId, scopeIndex, stimulusId: stimulus.id }
          index.set(stimulusKey(ref), { ref, loads: stimulus.loads, family: familyOf(stimulus, session) })
        }
      }
    }

    for (const mark of lock.marks) {
      const located = index.get(stimulusKey(mark))
      if (!located) throw new CountRefusal('mark_stimulus_not_found')
      const evidence = located.loads[mark.method]
      const bucket = bucketOf(mark.label, evidence)
      const method = counts.methods[mark.method]
      method.accepted[mark.label] += 1
      method.buckets[bucket] += 1
      counts.families[located.family][mark.method][bucket] += 1
      if (bucket === 'hit') {
        if (evidence.basis === null) throw new Error('count: a load in the interval carries no basis')
        method.hitsByBasis[evidence.basis] += 1
      }
    }

    const marked = new Set(lock.marks.map(itemKey))
    for (const { ref, loads } of index.values()) {
      for (const method of METHODS) if (loads[method].loaded && !marked.has(itemKey({ ...ref, method }))) counts.methods[method].unmarkedLoads += 1
    }
  }
  return counts
}

// ── the outcome rule ───────────────────────────────────────────────────────

export const OUTCOMES = ['errors_observed', 'clean', 'inconclusive'] as const
export type Outcome = (typeof OUTCOMES)[number]

/**
 * Why an outcome rests on thin ground, in this fixed order:
 * - `minimum_unmet`: some method and label has fewer accepted marks than its declared minimum;
 * - `labeling_incomplete`: a chunk failed or was not attempted, or there were no chunks;
 * - `spend_cap_reached`: the spend cap cut a chunk short;
 * - `omission_limit_exceeded`: the omission check found more than the declared limit;
 * - `unreadable_rows`: a stored message or part row could not be read as JSON, so the walk took it for no load and no stimulus;
 * - `transport_outage`: the labeler stopped calling after consecutive transport failures, so chunks were left unlabeled.
 */
export const COVERAGE_NOTES = ['minimum_unmet', 'labeling_incomplete', 'spend_cap_reached', 'omission_limit_exceeded', 'unreadable_rows', 'transport_outage'] as const
export type CoverageNote = (typeof COVERAGE_NOTES)[number]

export interface OutcomeResult {
  outcome: Outcome
  notes: CoverageNote[]
}

export interface OutcomeInput {
  declaration: Pick<Declaration, 'min_accepted_marks' | 'omission'>
  counts: LoadCounts
  coverage: LabelingCoverage
  /** Summed over the locks. */
  omissionsFound: number
  /** Unreadable message and part rows, summed over the walks of every locked slot. */
  unreadableRows: number
}

/**
 * The declared `errors-first` rule. Any miss or false fire is `errors_observed`, whatever else is thin. Otherwise `clean` needs
 * complete labeling coverage, omissions within the limit and every minimum of accepted marks met for both labels of both methods,
 * and anything else is `inconclusive`. The notes are the same in every outcome, so a reader sees what was thin. A declared minimum
 * is never zero, so zero accepted marks always has `minimum_unmet` and is never clean.
 */
export function decideOutcome(input: OutcomeInput): OutcomeResult {
  const { declaration, counts, coverage } = input
  const errors = METHODS.reduce((sum, method) => sum + counts.methods[method].buckets.miss + counts.methods[method].buckets.false_fire, 0)
  const thin: Record<CoverageNote, boolean> = {
    minimum_unmet: METHODS.some((method) => LABELS.some((label) => counts.methods[method].accepted[label] < declaration.min_accepted_marks[method][label])),
    labeling_incomplete: coverage.chunks === 0 || coverage.labeled !== coverage.chunks,
    spend_cap_reached: coverage.spendCapReached,
    omission_limit_exceeded: input.omissionsFound > declaration.omission.limit,
    unreadable_rows: input.unreadableRows > 0,
    transport_outage: coverage.transportOutage > 0,
  }
  const notes = COVERAGE_NOTES.filter((note) => thin[note])
  return { outcome: errors > 0 ? 'errors_observed' : notes.length === 0 ? 'clean' : 'inconclusive', notes }
}

// ── the whole count ────────────────────────────────────────────────────────

/** What counting needs from the labeling step for one locked slot: how its chunks ended, and what its view scrubbed. */
export interface SlotLabeling {
  coverage: LabelingCoverage
  counters: ViewCounters
}

export interface RunCountInput extends GateInput {
  db: string
  privateRoot: PrivateRoot
  skillBodies: SkillBodies
  /** By slot. Every locked slot needs an entry. */
  labeling: Partial<Record<ManifestSlot, SlotLabeling>>
}

/** Everything the projection keeps, in totals over every locked slot. No session, stimulus or message is named in it. */
export interface CountReport {
  declarationHash: string
  /** The recorded deviation codes, in order. */
  deviations: DeviationCode[]
  outcome: Outcome
  notes: CoverageNote[]
  counts: LoadCounts
  /**
   * `considered`, `eligible` and `exclusions` are the initial manifest's: it describes the store when the sample was first frozen.
   * The added manifest scans the whole store again, so summing it in would count sessions twice. `sampled` is the sessions of every
   * locked slot.
   */
  sample: { considered: number; eligible: number; sampled: number; exclusions: Record<ExclusionReason, number> }
  coverage: LabelingCoverage
  scrubbed: ViewCounters
  omissions: { sampleSize: number; found: number }
  /** Message and part rows the walks could not read as JSON, over every locked slot. */
  unreadableRows: number
  /** The locked slots, `initial` first. */
  slots: ManifestSlot[]
}

/**
 * Checks the gate, requires a lock for every frozen slot (`no_lock` or `slot_not_locked`), walks each locked slot's manifest one
 * session at a time, counts every lock's marks and applies the outcome rule. Writes nothing.
 */
export function runCount(input: RunCountInput): CountReport {
  const pass = assertGate(input)
  const locks = requireLocks(input.privateRoot, pass.declarationHash)

  const walks: Partial<Record<ManifestSlot, Iterable<WalkedSession>>> = {}
  let unreadableRows = 0
  /** Passes a walk through one session at a time, adding up its unreadable rows on the way. */
  function* tallied(sessions: Iterable<WalkedSession>): Generator<WalkedSession> {
    for (const session of sessions) {
      unreadableRows += session.unreadableRows
      yield session
    }
  }
  const sample: CountReport['sample'] = { considered: 0, eligible: 0, sampled: 0, exclusions: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number> }
  const coverage: LabelingCoverage = { chunks: 0, labeled: 0, failed: 0, notAttempted: 0, spendCapReached: false, transportOutage: 0 }
  const scrubbed: ViewCounters = { scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 }
  const omissions = { sampleSize: 0, found: 0 }

  const initial = readManifest(input.privateRoot, 'initial', pass.declarationHash)
  if (!initial) throw new ManifestError('manifest_missing', 'the initial manifest has not been written')
  sample.considered = initial.considered
  sample.eligible = initial.eligible
  for (const reason of EXCLUSION_REASONS) sample.exclusions[reason] = initial.exclusions[reason]

  for (const lock of locks) {
    const labeling = input.labeling[lock.slot]
    if (!labeling) throw new CountRefusal('labeling_missing')
    const manifest = readManifest(input.privateRoot, lock.slot, pass.declarationHash)
    if (!manifest) throw new ManifestError('manifest_missing', `the ${lock.slot} manifest has not been written`)
    walks[lock.slot] = tallied(walkManifestEach({ ...input, slot: lock.slot }))

    sample.sampled += manifest.sessions.length
    coverage.chunks += labeling.coverage.chunks
    coverage.labeled += labeling.coverage.labeled
    coverage.failed += labeling.coverage.failed
    coverage.notAttempted += labeling.coverage.notAttempted
    coverage.spendCapReached ||= labeling.coverage.spendCapReached
    coverage.transportOutage += labeling.coverage.transportOutage
    for (const key of Object.keys(scrubbed) as (keyof ViewCounters)[]) scrubbed[key] += labeling.counters[key]
    omissions.sampleSize += lock.omissionSampleSize
    omissions.found += lock.omissionsFound
  }

  const counts = countLoads(locks, walks)
  const { outcome, notes } = decideOutcome({ declaration: pass.declaration, counts, coverage, omissionsFound: omissions.found, unreadableRows })
  return { declarationHash: pass.declarationHash, deviations: pass.deviations.map((deviation) => deviation.code), outcome, notes, counts, sample, coverage, scrubbed, omissions, unreadableRows, slots: locks.map((lock) => lock.slot) }
}
