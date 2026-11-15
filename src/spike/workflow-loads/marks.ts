/**
 * Judgments, the omission sample and the locks: the maintainer's decisions on the labeler's proposals and on a sample of stimuli
 * the labeler did not propose, stored append-only under the private root and then locked, before any load is counted.
 *
 * - A proposal item is one stimulus and method. Proposals for the same stimulus, method and label are one item; when the labeler
 *   proposed both labels for it, the item takes a pick between them or a reject.
 * - The omission sample is the declared number of stimuli with no proposal for either method, ranked by a salted hash with its own
 *   prefix. Each answer per method other than `neither` adds a mark and counts as one omission.
 * - Every stored judgment, answer and lock is bound to the declaration hash and the manifest hash of its slot, and to the digest of
 *   the hidden view it was made on: a view that differs from that one is refused, so a judgment never rests on text the maintainer
 *   did not see. After a slot's lock exists nothing more is accepted for that slot. The other slot's lock is never touched.
 * - Nothing here prints; a refusal names a reason and carries no session text.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { canonicalize } from '../../record/canonical'
import { saltedHash } from '../../runner/prereg'
import { sha256 } from '../../runner/workspace'
import { assertOutsideRepo, privateDir, writePrivate } from '../feel-drugs/replay/store'
import { assertGate, type Declaration, type GateInput, type GatePass, LABELS, type Label, METHODS, type Method } from './declaration'
import type { Proposal } from './labeler'
import type { HiddenView } from './mask'
import { MANIFEST_SLOTS, ManifestError, type ManifestSlot, type PrivateRoot, readManifest } from './store'

// ── refusals ───────────────────────────────────────────────────────────────

export type MarksReason =
  | 'view_declaration_mismatch'
  | 'view_slot_mismatch'
  | 'proposal_not_in_view'
  | 'unknown_item'
  | 'already_judged'
  | 'already_answered'
  | 'choice_invalid'
  | 'slot_locked'
  | 'items_remaining'
  | 'judgments_invalid'
  | 'lock_invalid'
  | 'lock_tampered'
  | 'lock_declaration_mismatch'
  | 'lock_manifest_mismatch'
  | 'no_lock'
  | 'slot_not_locked'
  | 'judging_started'
  | 'view_changed'

const REFUSAL_MESSAGE: Record<MarksReason, string> = {
  view_declaration_mismatch: 'the hidden view was built under a different declaration',
  view_slot_mismatch: "the hidden view holds sessions that are not in this slot's manifest",
  proposal_not_in_view: 'a proposal names a stimulus the hidden view does not hold',
  unknown_item: 'no such item in this slot',
  already_judged: 'that proposal item is already judged',
  already_answered: 'that omission item is already answered',
  choice_invalid: "that choice does not fit the item's proposed labels",
  slot_locked: 'this slot is locked; nothing more is accepted for it',
  items_remaining: 'the slot cannot be locked while items are unjudged or unanswered',
  judgments_invalid: 'a stored judgment is unreadable or bound to another declaration or manifest',
  lock_invalid: 'a lock file is not a lock',
  lock_tampered: 'a lock file was edited after it was written',
  lock_declaration_mismatch: 'a lock was written under a different declaration',
  lock_manifest_mismatch: "a lock does not match its slot's manifest",
  no_lock: 'no lock exists, so there are no locked marks to count',
  slot_not_locked: 'a frozen slot has no lock yet',
  judging_started: 'a judgment or an omission answer is stored for this slot, so the proposals can no longer change',
  view_changed: 'the hidden view differs from the one the stored judgments or the lock were made on',
}

/** The marks step cannot proceed. The message is fixed per reason (plus counts, where given): it never carries session text. */
export class MarksRefusal extends Error {
  constructor(
    readonly reason: MarksReason,
    detail?: string,
  ) {
    super(`${reason}: ${REFUSAL_MESSAGE[reason]}${detail ? ` (${detail})` : ''}`)
    this.name = 'MarksRefusal'
  }
}

// ── items ──────────────────────────────────────────────────────────────────

/** A stimulus in a slot's view. */
export interface StimulusRef {
  sessionId: string
  scopeIndex: number
  stimulusId: string
}

/** One thing to judge: a stimulus and method with the labels the labeler proposed for it (one or both), in `LABELS` order. */
export interface ProposalItem extends StimulusRef {
  method: Method
  /** `reason` is the labeler's text: a private artifact, shown to the judge and never printed elsewhere. */
  proposed: { label: Label; reason: string }[]
}

export type ProposalTarget = StimulusRef & { method: Method }

export const stimulusKey = (ref: StimulusRef): string => JSON.stringify([ref.sessionId, ref.scopeIndex, ref.stimulusId])
export const itemKey = (ref: ProposalTarget): string => JSON.stringify([ref.sessionId, ref.scopeIndex, ref.stimulusId, ref.method])

/** Proposals grouped into items, in the order each stimulus and method first appears. A repeat of a label keeps the first reason. */
export function proposalItems(proposals: readonly Proposal[]): ProposalItem[] {
  const items = new Map<string, ProposalItem>()
  for (const p of proposals) {
    const key = itemKey(p)
    let item = items.get(key)
    if (!item) {
      item = { sessionId: p.sessionId, scopeIndex: p.scopeIndex, stimulusId: p.stimulusId, method: p.method, proposed: [] }
      items.set(key, item)
    }
    if (!item.proposed.some((entry) => entry.label === p.label)) item.proposed.push({ label: p.label, reason: p.reason })
  }
  for (const item of items.values()) item.proposed.sort((a, b) => LABELS.indexOf(a.label) - LABELS.indexOf(b.label))
  return [...items.values()]
}

/**
 * The stimuli the maintainer inspects though the labeler proposed nothing for them: those in the view with no proposal for any
 * method, ranked by a salted hash under the `omission:` prefix (the session order uses `session:`, so the two are independent),
 * cut at the declared sample size. Fewer candidates than the size are all taken. The same salt gives the same sample every time.
 */
export function omissionSample(view: Pick<HiddenView, 'scopes'>, proposals: readonly Proposal[], declaration: Pick<Declaration, 'salt' | 'omission'>): StimulusRef[] {
  const proposed = new Set(proposals.map(stimulusKey))
  const seen = new Set<string>()
  const candidates: { ref: StimulusRef; rank: string }[] = []
  for (const scope of view.scopes) {
    for (const stimulus of scope.stimuli) {
      const ref: StimulusRef = { sessionId: scope.sessionId, scopeIndex: scope.scopeIndex, stimulusId: stimulus.id }
      const key = stimulusKey(ref)
      if (proposed.has(key) || seen.has(key)) continue
      seen.add(key)
      candidates.push({ ref, rank: saltedHash(declaration.salt, `omission:${key}`) })
    }
  }
  candidates.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : stimulusKey(a.ref) < stimulusKey(b.ref) ? -1 : 1))
  return candidates.slice(0, declaration.omission.sample_size).map((candidate) => candidate.ref)
}

// ── what is stored ─────────────────────────────────────────────────────────

/**
 * The maintainer's choice on a proposal item. `accept` and `relabel` fit an item with one proposed label (relabel marks the other
 * label); `pick` and `reject` fit an item with both (`reject` fits either).
 */
export type ProposalChoice = { action: 'accept' } | { action: 'relabel' } | { action: 'reject' } | { action: 'pick'; label: Label }

/** What a choice came to: the action and the label the mark would carry. */
export type Judgment = { action: 'reject' } | { action: 'accept' | 'relabel' | 'pick'; label: Label }

export const OMISSION_ANSWERS = ['expected_fire', 'expected_silence', 'neither'] as const
export type OmissionAnswer = (typeof OMISSION_ANSWERS)[number]
/** An answer per method, none left out. */
export type OmissionAnswers = Record<Method, OmissionAnswer>

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const slotSchema = z.enum(MANIFEST_SLOTS)
const labelSchema = z.enum(LABELS)
const eventBase = { schemaVersion: z.literal(1), slot: slotSchema, declarationHash: hex64, manifestHash: hex64, viewDigest: hex64, at: z.string().min(1), sessionId: z.string().min(1), scopeIndex: z.number().int().nonnegative(), stimulusId: z.string().min(1) }

const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...eventBase,
    kind: z.literal('proposal'),
    method: z.enum(METHODS),
    /** The labels the item had when it was judged; a judgment of an item whose labels have since changed no longer counts. */
    proposed: z.array(labelSchema).min(1).max(2),
    decision: z.discriminatedUnion('action', [z.strictObject({ action: z.literal('reject') }), z.strictObject({ action: z.enum(['accept', 'relabel', 'pick']), label: labelSchema })]),
  }),
  z.strictObject({ ...eventBase, kind: z.literal('omission'), answers: z.record(z.enum(METHODS), z.enum(OMISSION_ANSWERS)) }),
])
type StoredEvent = z.infer<typeof eventSchema>

export type MarkSource = 'proposal' | 'omission'

/** One accepted mark. Source tells whether it came from a proposal the maintainer kept or from the omission sample. */
export interface LockedMark extends StimulusRef {
  method: Method
  label: Label
  source: MarkSource
}

const markSchema = z.strictObject({ sessionId: z.string().min(1), scopeIndex: z.number().int().nonnegative(), stimulusId: z.string().min(1), method: z.enum(METHODS), label: labelSchema, source: z.enum(['proposal', 'omission']) })
const count = z.number().int().nonnegative()

const lockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  slot: slotSchema,
  declarationHash: hex64,
  manifestHash: hex64,
  /** The digest of the hidden view the marks were judged on. */
  viewDigest: hex64,
  lockedAt: z.string().min(1),
  marks: z.array(markSchema),
  /** The stimuli actually sampled: the declared size, or all of them when fewer were unproposed. */
  omissionSampleSize: count,
  /** Answers other than `neither`, counted per stimulus and method. */
  omissionsFound: count,
  /** sha256 of the canonical form of every other field. */
  lockHash: hex64,
})

/** What the counting step reads: the accepted marks of one slot, the hashes they are bound to, and the omission counts. */
export type Lock = z.infer<typeof lockSchema>

/** JSON with the keys of every object sorted, so a view read back from its file digests as the view that was written. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** What a judgment or a lock is bound to: the sha256 of the view's content, however the file spells it. */
export const viewDigest = (view: HiddenView): string => sha256(stableJson(view))

// ── the private files ──────────────────────────────────────────────────────

const slotDir = (privateRoot: PrivateRoot, slot: ManifestSlot): string => join(privateRoot.root, 'marks', slot)
const judgmentsDir = (privateRoot: PrivateRoot, slot: ManifestSlot): string => join(slotDir(privateRoot, slot), 'judgments')
export const lockPath = (privateRoot: PrivateRoot, slot: ManifestSlot): string => join(privateRoot.root, 'marks', `lock-${slot}.json`)

const EVENT_FILE = /^(\d{6})\.json$/

function readEvents(privateRoot: PrivateRoot, slot: ManifestSlot, declarationHash: string, manifestHash: string): StoredEvent[] {
  const dir = judgmentsDir(privateRoot, slot)
  if (!existsSync(dir)) return []
  const events: StoredEvent[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!EVENT_FILE.test(name)) continue
    let parsed: ReturnType<typeof eventSchema.safeParse>
    try {
      parsed = eventSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    } catch {
      throw new MarksRefusal('judgments_invalid')
    }
    // a judgment is never silently skipped: a half-read log could let an item be judged twice
    if (!parsed.success || parsed.data.slot !== slot || parsed.data.declarationHash !== declarationHash || parsed.data.manifestHash !== manifestHash) throw new MarksRefusal('judgments_invalid')
    events.push(parsed.data)
  }
  return events
}

/** Any judgment or omission answer is stored for the slot, or the slot is locked. Judgments are never validated here: any file counts. */
function judgingStarted(privateRoot: PrivateRoot, slot: ManifestSlot): boolean {
  const dir = judgmentsDir(privateRoot, slot)
  return existsSync(lockPath(privateRoot, slot)) || (existsSync(dir) && readdirSync(dir).some((name) => EVENT_FILE.test(name)))
}

/**
 * Throws `judging_started` once a judgment, an omission answer or a lock is stored for the slot. Labeling again would change the
 * proposals, and with them the omission sample, after the maintainer began judging. Other slots are not affected.
 */
export function assertJudgingNotStarted(privateRoot: PrivateRoot, slot: ManifestSlot): void {
  if (judgingStarted(privateRoot, slot)) throw new MarksRefusal('judging_started')
}

function appendEvent(privateRoot: PrivateRoot, slot: ManifestSlot, event: StoredEvent): void {
  const dir = judgmentsDir(privateRoot, slot)
  privateDir(privateRoot.root)
  privateDir(join(privateRoot.root, 'marks'))
  privateDir(slotDir(privateRoot, slot))
  privateDir(dir)
  const next = readdirSync(dir).filter((name) => EVENT_FILE.test(name)).length + 1
  writePrivate(join(dir, `${String(next).padStart(6, '0')}.json`), `${JSON.stringify(event, null, 2)}\n`, true)
}

const lockHashOf = (lock: Omit<Lock, 'lockHash'>): string => sha256(canonicalize(lock))

/** One slot's lock, verified: `undefined` when none was written. */
function readLock(privateRoot: PrivateRoot, slot: ManifestSlot, declarationHash: string): Lock | undefined {
  const path = lockPath(privateRoot, slot)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new MarksRefusal('lock_invalid')
  }
  const parsed = lockSchema.safeParse(raw)
  if (!parsed.success || parsed.data.slot !== slot) throw new MarksRefusal('lock_invalid')
  const { lockHash, ...rest } = parsed.data
  if (lockHashOf(rest) !== lockHash) throw new MarksRefusal('lock_tampered')
  if (parsed.data.declarationHash !== declarationHash) throw new MarksRefusal('lock_declaration_mismatch')
  if (readManifest(privateRoot, slot, declarationHash)?.manifest_hash !== parsed.data.manifestHash) throw new MarksRefusal('lock_manifest_mismatch')
  return parsed.data
}

/** The locks that exist for this declaration, `initial` first. Each is verified against its own hash and its slot's manifest. */
export function readLocks(privateRoot: PrivateRoot, declarationHash: string): Lock[] {
  return MANIFEST_SLOTS.flatMap((slot) => readLock(privateRoot, slot, declarationHash) ?? [])
}

/**
 * The locks counting needs. Throws `no_lock` when none exists, and `slot_not_locked` when a slot has a frozen manifest but no
 * lock (a raised session cap, with its added sessions not yet judged), so marks are never counted over a partly judged sample.
 * Given a slot's current view, throws `view_changed` when it differs from the view that slot was locked on.
 */
export function requireLocks(privateRoot: PrivateRoot, declarationHash: string, views: Partial<Record<ManifestSlot, HiddenView>> = {}): Lock[] {
  const locks = readLocks(privateRoot, declarationHash)
  if (locks.length === 0) throw new MarksRefusal('no_lock')
  // a slot whose view is not given is not checked here: the caller names the missing view
  for (const lock of locks) {
    const view = views[lock.slot]
    if (view && viewDigest(view) !== lock.viewDigest) throw new MarksRefusal('view_changed', lock.slot)
  }
  for (const slot of MANIFEST_SLOTS) {
    if (!locks.some((lock) => lock.slot === slot) && readManifest(privateRoot, slot, declarationHash) !== undefined) throw new MarksRefusal('slot_not_locked', slot)
  }
  return locks
}

// ── the state of one slot ──────────────────────────────────────────────────

export interface MarkingInput extends GateInput {
  privateRoot: PrivateRoot
  /** Default `initial`. */
  slot?: ManifestSlot
  /** The labeler's proposals for this slot's view. */
  proposals: readonly Proposal[]
  /** This slot's hidden view. */
  view: HiddenView
  /** The repository the private root must lie outside of. Default: the repository the gate reads, `git.repo`. */
  repoRoot?: string
  /** A gate pass the caller just obtained, so the gate is not run again. Default: the gate is checked. */
  pass?: GatePass
}

export interface Marking {
  slot: ManifestSlot
  declaration: Declaration
  declarationHash: string
  manifestHash: string
  /** The digest of the view this state was read against. */
  viewDigest: string
  items: ProposalItem[]
  /** Valid judgments by item. */
  judgments: ReadonlyMap<string, Judgment>
  sample: StimulusRef[]
  /** Answers by sampled stimulus. */
  answers: ReadonlyMap<string, OmissionAnswers>
  lock: Lock | undefined
}

const judgmentOf = (event: Extract<StoredEvent, { kind: 'proposal' }>): Judgment => event.decision

/**
 * Checks the gate and everything the slot's state rests on, then reads it: the declaration gate; the private root lies outside the
 * repository; the slot's manifest exists; the view was built under this declaration and holds only this slot's sessions; every
 * proposal names a stimulus in the view; every stored judgment is bound to this declaration and manifest. A judgment or answer for
 * an item that is no longer one (its proposed labels changed, or it left the omission sample) does not count and is not an error.
 * Every stored judgment and the lock were made on one view: a view with another digest is refused (`view_changed`).
 */
export function openMarking(input: MarkingInput): Marking {
  const slot = input.slot ?? 'initial'
  assertOutsideRepo(input.privateRoot.root, input.repoRoot ?? input.git.repo)
  const pass = input.pass ?? assertGate(input)
  const manifest = readManifest(input.privateRoot, slot, pass.declarationHash)
  if (!manifest) throw new ManifestError('manifest_missing', `the ${slot} manifest has not been written`)
  if (input.view.declarationHash !== pass.declarationHash) throw new MarksRefusal('view_declaration_mismatch')
  const sessions = new Set(manifest.sessions.map((s) => s.id))
  if (input.view.scopes.some((scope) => !sessions.has(scope.sessionId))) throw new MarksRefusal('view_slot_mismatch')
  const inView = new Set(input.view.scopes.flatMap((scope) => scope.stimuli.map((s) => stimulusKey({ sessionId: scope.sessionId, scopeIndex: scope.scopeIndex, stimulusId: s.id }))))
  if (input.proposals.some((p) => !inView.has(stimulusKey(p)))) throw new MarksRefusal('proposal_not_in_view')

  const items = proposalItems(input.proposals)
  const sample = omissionSample(input.view, input.proposals, pass.declaration)
  const itemsByKey = new Map(items.map((item) => [itemKey(item), item]))
  const sampled = new Set(sample.map(stimulusKey))

  const judgments = new Map<string, Judgment>()
  const answers = new Map<string, OmissionAnswers>()
  const digest = viewDigest(input.view)
  for (const event of readEvents(input.privateRoot, slot, pass.declarationHash, manifest.manifest_hash)) {
    if (event.viewDigest !== digest) throw new MarksRefusal('view_changed')
    if (event.kind === 'proposal') {
      const key = itemKey(event)
      const item = itemsByKey.get(key)
      const labels = item?.proposed.map((entry) => entry.label).join()
      if (item && labels === event.proposed.join() && !judgments.has(key)) judgments.set(key, judgmentOf(event))
    } else {
      const key = stimulusKey(event)
      if (sampled.has(key) && !answers.has(key)) answers.set(key, event.answers)
    }
  }
  const lock = readLock(input.privateRoot, slot, pass.declarationHash)
  if (lock && lock.viewDigest !== digest) throw new MarksRefusal('view_changed')
  return { slot, declaration: pass.declaration, declarationHash: pass.declarationHash, manifestHash: manifest.manifest_hash, viewDigest: digest, items, judgments, sample, answers, lock }
}

/** The items not yet judged, in order: a resumed session starts at the first. */
export const pendingProposals = (marking: Marking): ProposalItem[] => marking.items.filter((item) => !marking.judgments.has(itemKey(item)))

/** The sampled stimuli not yet answered, in sample order. */
export const pendingOmissions = (marking: Marking): StimulusRef[] => marking.sample.filter((ref) => !marking.answers.has(stimulusKey(ref)))

// ── recording ──────────────────────────────────────────────────────────────

function decide(item: ProposalItem, choice: ProposalChoice): Judgment {
  if (choice.action === 'reject') return { action: 'reject' }
  const [only, other] = item.proposed
  if (!only) throw new MarksRefusal('choice_invalid')
  if (other === undefined) {
    // one proposed label: accept it, or mark the other
    if (choice.action === 'accept') return { action: 'accept', label: only.label }
    if (choice.action === 'relabel') return { action: 'relabel', label: only.label === 'expected_fire' ? 'expected_silence' : 'expected_fire' }
    throw new MarksRefusal('choice_invalid')
  }
  // both labels proposed: the maintainer picks one of them
  if (choice.action === 'pick' && item.proposed.some((entry) => entry.label === choice.label)) return { action: 'pick', label: choice.label }
  throw new MarksRefusal('choice_invalid')
}

/**
 * One run of judging: the state is read once, after one gate check, and each stored judgment or answer is added to it in memory, so
 * a long session does not run the gate or read the whole log again for every item. The lock is still looked for at every write.
 * `marking` is that live state: its maps follow each write.
 */
export interface JudgingSession {
  readonly marking: Marking
  /** Stores the judgment of one proposal item and returns it. Refused with `slot_locked`, `unknown_item`, `already_judged` or `choice_invalid`. */
  judge: (target: ProposalTarget, choice: ProposalChoice) => Judgment
  /** Stores the answers for one sampled stimulus and returns them. Refused as `judge` is, with `already_answered` for a second answer. */
  answer: (target: StimulusRef, answers: OmissionAnswers) => OmissionAnswers
}

export function openJudging(input: MarkingInput): JudgingSession {
  const opened = openMarking(input)
  const judgments = new Map(opened.judgments)
  const answers = new Map(opened.answers)
  const marking: Marking = { ...opened, judgments, answers }
  const base = (): Omit<StoredEvent & { kind: 'omission' }, 'kind' | 'sessionId' | 'scopeIndex' | 'stimulusId' | 'answers'> => ({
    schemaVersion: 1,
    slot: marking.slot,
    declarationHash: marking.declarationHash,
    manifestHash: marking.manifestHash,
    viewDigest: marking.viewDigest,
    at: input.privateRoot.now().toISOString(),
  })
  // a lock written since the state was read stops the session at its next write
  const assertOpen = (): void => {
    if (marking.lock || existsSync(lockPath(input.privateRoot, marking.slot))) throw new MarksRefusal('slot_locked')
  }
  return {
    marking,
    judge(target, choice) {
      assertOpen()
      const item = marking.items.find((candidate) => itemKey(candidate) === itemKey(target))
      if (!item) throw new MarksRefusal('unknown_item')
      if (judgments.has(itemKey(item))) throw new MarksRefusal('already_judged')
      const decision = decide(item, choice)
      appendEvent(input.privateRoot, marking.slot, { ...base(), kind: 'proposal', sessionId: item.sessionId, scopeIndex: item.scopeIndex, stimulusId: item.stimulusId, method: item.method, proposed: item.proposed.map((entry) => entry.label), decision })
      judgments.set(itemKey(item), decision)
      return decision
    },
    answer(target, given) {
      assertOpen()
      const ref = marking.sample.find((candidate) => stimulusKey(candidate) === stimulusKey(target))
      if (!ref) throw new MarksRefusal('unknown_item')
      if (answers.has(stimulusKey(ref))) throw new MarksRefusal('already_answered')
      appendEvent(input.privateRoot, marking.slot, { ...base(), kind: 'omission', sessionId: ref.sessionId, scopeIndex: ref.scopeIndex, stimulusId: ref.stimulusId, answers: given })
      answers.set(stimulusKey(ref), given)
      return given
    },
  }
}

/**
 * Stores the judgment of one proposal item and returns it. Refused when the gate fails, the slot is locked (`slot_locked`), the item
 * is not one (`unknown_item`), it is already judged (`already_judged`) or the choice does not fit its labels (`choice_invalid`).
 */
export const judgeProposal = (input: MarkingInput, target: ProposalTarget, choice: ProposalChoice): Judgment => openJudging(input).judge(target, choice)

/**
 * Stores the answers for one sampled stimulus, one per method, and returns them. Refused as `judgeProposal` is, with
 * `unknown_item` for a stimulus outside the sample and `already_answered` for a second answer.
 */
export const answerOmission = (input: MarkingInput, target: StimulusRef, answers: OmissionAnswers): OmissionAnswers => openJudging(input).answer(target, answers)

/**
 * Locks the slot: writes the accepted marks (accepted, relabeled and picked proposals, then the omission answers other than
 * `neither`) with the declaration hash, the manifest hash, the actual omission sample size and the omissions found. Refused with
 * `slot_locked` when a lock exists and `items_remaining` while any item is unjudged or any sampled stimulus unanswered. The lock
 * file is written once and never replaced.
 */
export function lockMarks(input: MarkingInput): Lock {
  const marking = openMarking(input)
  if (marking.lock) throw new MarksRefusal('slot_locked')
  const proposals = pendingProposals(marking).length
  const omissions = pendingOmissions(marking).length
  if (proposals + omissions > 0) throw new MarksRefusal('items_remaining', `${proposals} proposal items and ${omissions} omission items remain`)

  const marks: LockedMark[] = []
  for (const item of marking.items) {
    const judgment = marking.judgments.get(itemKey(item))
    if (judgment && judgment.action !== 'reject') marks.push({ sessionId: item.sessionId, scopeIndex: item.scopeIndex, stimulusId: item.stimulusId, method: item.method, label: judgment.label, source: 'proposal' })
  }
  let omissionsFound = 0
  for (const ref of marking.sample) {
    const answers = marking.answers.get(stimulusKey(ref))
    for (const method of METHODS) {
      const answer = answers?.[method]
      if (answer === undefined || answer === 'neither') continue
      omissionsFound += 1
      marks.push({ ...ref, method, label: answer, source: 'omission' })
    }
  }
  const body: Omit<Lock, 'lockHash'> = {
    schemaVersion: 1,
    slot: marking.slot,
    declarationHash: marking.declarationHash,
    manifestHash: marking.manifestHash,
    viewDigest: marking.viewDigest,
    lockedAt: input.privateRoot.now().toISOString(),
    marks,
    omissionSampleSize: marking.sample.length,
    omissionsFound,
  }
  const lock: Lock = { ...body, lockHash: lockHashOf(body) }
  privateDir(input.privateRoot.root)
  privateDir(join(input.privateRoot.root, 'marks'))
  writePrivate(lockPath(input.privateRoot, marking.slot), `${JSON.stringify(lock, null, 2)}\n`, true)
  return lock
}
