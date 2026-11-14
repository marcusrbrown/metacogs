/**
 * Read-only access to the OpenCode session store for the history count: which sessions are eligible, the frozen manifest of the
 * sample, and each sampled session's stimuli, scopes and load evidence.
 *
 * The store is only ever opened read-only and queried through the fixed statements in `WORKFLOW_LOADS_SQL`, which touch the
 * `session`, `message` and `part` tables and nothing else. The store keeps growing while it is read, so the manifest records each
 * sampled session's last message when it was frozen, and every later read stops at that mark.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { canonicalize } from '../../record/canonical'
import { saltedHash } from '../../runner/prereg'
import { sha256, stateRoot } from '../../runner/workspace'
import type { RawMessage, RawPart } from '../feel-drugs/replay/extract'
import { assertOutsideRepo, privateDir, writePrivate } from '../feel-drugs/replay/store'
import { assertGate, type Declaration, effectiveSessionCap, type GateInput, type GatePass, underExcludedRoot } from './declaration'
import { type IntervalEvidence, intervalEvidence, type LoadEvent, loadEvents, type SkillBodies, toolUseOfPart, type WorkflowSkill, workflowLoadOf } from './loads'

export type { RawMessage, RawPart }

// ── the allowlisted statements ─────────────────────────────────────────────

/** Up to and including a mark, by the host's own order (time, then id). Takes `t, t, id`. */
const UP_TO_MARK = '(time_created < ? OR (time_created = ? AND id <= ?))'

/**
 * Every statement this module runs. Each names its columns and none touches a table other than `session`, `message` and `part`
 * (`tables` reads the schema listing to confirm those three exist).
 */
export const WORKFLOW_LOADS_SQL = {
  tables: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')",
  sessions: 'SELECT id, parent_id, directory, time_created FROM session ORDER BY time_created, id',
  lastMessage: 'SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1',
  /** Tool parts of the skill-loading tools in messages up to the mark. Takes `session, session, t, t, id`. */
  skillParts: `SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? AND message_id IN (SELECT id FROM message WHERE session_id = ? AND ${UP_TO_MARK}) AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') END = 'tool' AND CASE WHEN json_valid(data) THEN json_extract(data, '$.tool') END IN ('skill', 'systematic_skill') ORDER BY time_created, id`,
  /** Takes `session, t, t, id`. */
  messages: `SELECT id, session_id, time_created, data FROM message WHERE session_id = ? AND ${UP_TO_MARK} ORDER BY time_created, id`,
  /** Takes `session, session, t, t, id`. */
  parts: `SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? AND message_id IN (SELECT id FROM message WHERE session_id = ? AND ${UP_TO_MARK}) ORDER BY time_created, id`,
} as const

export type StoreReason = 'store_unreadable' | 'store_missing_table' | 'store_schema_mismatch'

/** The store cannot be read as expected. The message names tables and never carries session text. */
export class StoreError extends Error {
  constructor(
    readonly reason: StoreReason,
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'StoreError'
  }
}

const REQUIRED_TABLES = ['session', 'message', 'part'] as const

/** Opens the store read-only, enforces it with `query_only`, and confirms the three tables before running anything else. */
function withStore<T>(path: string, run: (db: Database) => T): T {
  let db: Database
  try {
    db = new Database(path, { readonly: true })
  } catch {
    throw new StoreError('store_unreadable', 'the session store could not be opened read-only')
  }
  try {
    db.run('PRAGMA query_only = ON')
    const present = new Set(db.query<{ name: string }, []>(WORKFLOW_LOADS_SQL.tables).all().map((row) => row.name))
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table))
    if (missing.length > 0) throw new StoreError('store_missing_table', `the session store has no ${missing.join(', ')} table`)
    return run(db)
  } catch (e) {
    if (e instanceof StoreError) throw e
    if (e instanceof Error && /no such (table|column)/i.test(e.message)) throw new StoreError('store_schema_mismatch', 'the session store lacks a table or column this reader expects')
    throw e
  } finally {
    db.close()
  }
}

// ── the private root ───────────────────────────────────────────────────────

export interface PrivateRoot {
  root: string
  now: () => Date
}

export interface PrivateRootOptions {
  /** Default: `<state root>/workflow-loads`, beside the replay store's directory. */
  root?: string
  /** The repository the root must lie outside of. Default: this repository. */
  repoRoot?: string
  env?: Record<string, string | undefined>
  home?: string
  now?: () => Date
}

/** The directory every private artifact of the history count lives in: outside the repository, owner-only. */
export function openPrivateRoot(options: PrivateRootOptions = {}): PrivateRoot {
  const root = resolve(options.root ?? join(stateRoot(options.env, options.home), 'workflow-loads'))
  assertOutsideRepo(root, options.repoRoot)
  privateDir(root)
  return { root, now: options.now ?? (() => new Date()) }
}

// ── the manifest ───────────────────────────────────────────────────────────

/** `initial`: the first sample. `added`: only the sessions a session-cap raise added; the initial manifest stays as it is. */
export const MANIFEST_SLOTS = ['initial', 'added'] as const
export type ManifestSlot = (typeof MANIFEST_SLOTS)[number]

/** Why a session is left out. Each session gets the first reason that applies, in this order. */
export const EXCLUSION_REASONS = ['child_session', 'outside_window', 'excluded_project_root', 'already_sampled', 'no_workflow_load'] as const
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

/** A session's last message at the moment it was frozen: later steps read the messages up to and including it, by (time, id). */
export interface Mark {
  id: string
  time_created: number
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const count = z.number().int().nonnegative()
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  slot: z.enum(MANIFEST_SLOTS),
  /** Hash of the declaration in force when the manifest was frozen. */
  declaration_hash: hex64,
  /** Most sessions this manifest could hold: the declared cap for `initial`, the raised cap minus the initial sample for `added`. */
  session_cap: z.number().int().positive(),
  created_at: z.string().min(1),
  /** Sessions in the store when it was frozen. */
  considered: count,
  /** Sessions left out, by reason. Counts only: a session is never named here. */
  exclusions: z.strictObject({ child_session: count, outside_window: count, excluded_project_root: count, already_sampled: count, no_workflow_load: count }),
  /** Sessions that passed every rule, before the cap. */
  eligible: count,
  /** The sample, in salted-hash order. */
  sessions: z.array(z.strictObject({ id: z.string().min(1), last_message: z.strictObject({ id: z.string().min(1), time_created: z.number().int() }) })),
  /** sha256 of the canonical form of every other field. */
  manifest_hash: hex64,
})
export type Manifest = z.infer<typeof manifestSchema>
export type ManifestSession = Manifest['sessions'][number]

export type ManifestReason = 'manifest_missing' | 'manifest_invalid' | 'manifest_tampered' | 'manifest_declaration_mismatch' | 'initial_manifest_missing' | 'session_cap_not_raised' | 'session_not_in_manifest'

export class ManifestError extends Error {
  constructor(
    readonly reason: ManifestReason,
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'ManifestError'
  }
}

export const manifestPath = (privateRoot: PrivateRoot, slot: ManifestSlot): string => join(privateRoot.root, `manifest-${slot}.json`)

const manifestHashOf = (manifest: Omit<Manifest, 'manifest_hash'>): string => sha256(canonicalize(manifest))

/**
 * The manifest in a slot, verified: `undefined` when none was written yet; `manifest_invalid` when the file is not a manifest,
 * `manifest_tampered` when its content no longer hashes to its own hash, and, when `declarationHash` is given,
 * `manifest_declaration_mismatch` when it was frozen under another declaration.
 */
export function readManifest(privateRoot: PrivateRoot, slot: ManifestSlot, declarationHash?: string): Manifest | undefined {
  const path = manifestPath(privateRoot, slot)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ManifestError('manifest_invalid', `the ${slot} manifest is not valid JSON`)
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw new ManifestError('manifest_invalid', `the ${slot} manifest does not have the manifest shape`)
  const { manifest_hash: stored, ...rest } = parsed.data
  if (manifestHashOf(rest) !== stored) throw new ManifestError('manifest_tampered', `the ${slot} manifest was edited after it was written`)
  if (declarationHash !== undefined && parsed.data.declaration_hash !== declarationHash) {
    throw new ManifestError('manifest_declaration_mismatch', `the ${slot} manifest was frozen under a different declaration`)
  }
  return parsed.data
}

// ── eligibility and freezing ───────────────────────────────────────────────

interface SessionRow {
  id: string
  parent_id: string | null
  directory: string | null
  time_created: number
}
interface Eligible {
  id: string
  lastMessage: Mark
}

const DAY_MS = 86_400_000

/** The window as epoch milliseconds: from the first instant of `start` up to, not including, the first instant after `end`. */
function windowBounds(window: Declaration['window']): { from: number; until: number } {
  return { from: Date.parse(`${window.start}T00:00:00Z`), until: Date.parse(`${window.end}T00:00:00Z`) + DAY_MS }
}

const markBound = (mark: Mark) => [mark.time_created, mark.time_created, mark.id] as const

/** A session holds a completed workflow-skill load among its messages up to its mark. */
function holdsWorkflowLoad(db: Database, sessionId: string, mark: Mark): boolean {
  const rows = db.query<RawPart, [string, string, number, number, string]>(WORKFLOW_LOADS_SQL.skillParts).all(sessionId, sessionId, ...markBound(mark))
  return rows.some((row) => workflowLoadOf(row) !== null)
}

/** Sorts sessions into the eligible and, for the rest, the one reason that applies first. */
function classify(db: Database, declaration: Declaration, alreadySampled: ReadonlySet<string>) {
  const { from, until } = windowBounds(declaration.window)
  const exclusions: Record<ExclusionReason, number> = { child_session: 0, outside_window: 0, excluded_project_root: 0, already_sampled: 0, no_workflow_load: 0 }
  const eligible: Eligible[] = []
  const rows = db.query<SessionRow, []>(WORKFLOW_LOADS_SQL.sessions).all()
  for (const row of rows) {
    let reason: ExclusionReason | null = null
    if (row.parent_id !== null && row.parent_id !== '') reason = 'child_session'
    else if (row.time_created < from || row.time_created >= until) reason = 'outside_window'
    else if (underExcludedRoot(declaration, row.directory ?? '')) reason = 'excluded_project_root'
    else if (alreadySampled.has(row.id)) reason = 'already_sampled'
    if (reason === null) {
      const last = db.query<Mark, [string]>(WORKFLOW_LOADS_SQL.lastMessage).get(row.id)
      if (last && holdsWorkflowLoad(db, row.id, last)) eligible.push({ id: row.id, lastMessage: { id: last.id, time_created: last.time_created } })
      else reason = 'no_workflow_load'
    }
    if (reason !== null) exclusions[reason] += 1
  }
  return { considered: rows.length, exclusions, eligible }
}

/** Eligible sessions in the order the cap cuts them: ascending salted hash of the session id. */
function ranked(eligible: readonly Eligible[], salt: string): Eligible[] {
  return eligible
    .map((session) => ({ session, key: saltedHash(salt, `session:${session.id}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0))
    .map((entry) => entry.session)
}

export interface FreezeInput extends GateInput {
  /** Path of the OpenCode session database. */
  db: string
  privateRoot: PrivateRoot
  /** Default `initial`. */
  slot?: ManifestSlot
}

/**
 * The manifest for a slot. The gate runs first and refuses when it fails. A manifest that already exists is verified and
 * returned, never rebuilt, and the store is not opened. Otherwise the eligible sessions are ranked, cut and written once:
 * - `initial`: cut at the declared session cap.
 * - `added`: needs the initial manifest and a recorded session-cap raise; takes the best-ranked eligible sessions the initial
 *   manifest does not hold, up to the raised cap minus the initial sample. The initial manifest is not touched.
 */
export function freezeManifest(input: FreezeInput): { manifest: Manifest; created: boolean } {
  const pass = assertGate(input)
  const slot = input.slot ?? 'initial'
  const existing = readManifest(input.privateRoot, slot, pass.declarationHash)
  if (existing) return { manifest: existing, created: false }

  let alreadySampled: ReadonlySet<string> = new Set()
  let slots = pass.declaration.session_cap
  if (slot === 'added') {
    const initial = readManifest(input.privateRoot, 'initial', pass.declarationHash)
    if (!initial) throw new ManifestError('initial_manifest_missing', 'the added manifest follows the initial one, which has not been written')
    const raised = effectiveSessionCap(pass.declaration, pass.deviations)
    if (raised <= pass.declaration.session_cap) throw new ManifestError('session_cap_not_raised', 'no session-cap raise is recorded, so there is nothing to add')
    // the initial sample never exceeds the declared cap, which a recorded raise always exceeds, so at least one slot is left
    slots = raised - initial.sessions.length
    alreadySampled = new Set(initial.sessions.map((s) => s.id))
  }

  const { considered, exclusions, eligible } = withStore(input.db, (db) => classify(db, pass.declaration, alreadySampled))
  const sessions = ranked(eligible, pass.declaration.salt)
    .slice(0, slots)
    .map((s): ManifestSession => ({ id: s.id, last_message: s.lastMessage }))
  const body: Omit<Manifest, 'manifest_hash'> = {
    schema_version: 1,
    slot,
    declaration_hash: pass.declarationHash,
    session_cap: slots,
    created_at: input.privateRoot.now().toISOString(),
    considered,
    exclusions,
    eligible: eligible.length,
    sessions,
  }
  const manifest: Manifest = { ...body, manifest_hash: manifestHashOf(body) }
  writePrivate(manifestPath(input.privateRoot, slot), `${JSON.stringify(manifest, null, 2)}\n`, true)
  return { manifest, created: true }
}

// ── walking a manifest: scopes, stimuli, intervals ─────────────────────────

export type MessageRole = 'user' | 'assistant' | 'other'

/**
 * One position in a session's stored order. A user message is one entry holding all its parts. An assistant message is one entry
 * per part, so the boundary between two stimuli can fall inside one assistant turn.
 */
export interface WalkedEntry {
  message: RawMessage
  role: MessageRole
  parts: RawPart[]
}

export type StimulusKind = 'user_message' | 'tool_result'

export interface WalkedStimulus {
  /**
   * Stable across reads: the message id for a user message, `<message id>/<part id>` for a tool result. Both come from stored ids,
   * which never change, so later steps key their marks on it.
   */
  id: string
  kind: StimulusKind
  /** The tool's stored name for a tool result; `null` for a user message. */
  tool: string | null
  messageId: string
  /** The tool part's id for a tool result; `null` for a user message. */
  partId: string | null
  /** The stimulus itself: the user message with all its parts, or the one tool part with its message row. Raw rows, for rendering. */
  entry: WalkedEntry
  /** The rest of the interval in stored order: everything after the stimulus up to, not including, the next stimulus or the end of scope. */
  after: WalkedEntry[]
  /** Load evidence for this interval, per method, with whether the method was loaded anywhere earlier in the session. */
  loads: IntervalEvidence
}

export type ScopeEnd = 'workflow_load' | 'message_cap' | 'session_end'

export interface WalkedScope {
  /** The workflow skill whose load opened the scope. */
  workflow: WorkflowSkill
  /** The part that loaded it. */
  loadPartId: string
  stimuli: WalkedStimulus[]
  ended: ScopeEnd
}

export interface WalkedSession {
  sessionId: string
  /** The manifest's mark: nothing after it was read. */
  lastMessage: Mark
  /** The session's first assistant message up to the mark, with its stored data (it names the model); `null` when there is none. */
  firstAssistant: RawMessage | null
  scopes: WalkedScope[]
}

const parseRole = (data: string): MessageRole => {
  try {
    const role = (JSON.parse(data) as { role?: unknown } | null)?.role
    return role === 'user' || role === 'assistant' ? role : 'other'
  } catch {
    return 'other'
  }
}

function entriesOf(messages: readonly RawMessage[], parts: readonly RawPart[]): WalkedEntry[] {
  const byMessage = new Map<string, RawPart[]>()
  for (const part of parts) {
    const list = byMessage.get(part.message_id)
    if (list) list.push(part)
    else byMessage.set(part.message_id, [part])
  }
  const entries: WalkedEntry[] = []
  for (const message of messages) {
    const role = parseRole(message.data)
    const own = byMessage.get(message.id) ?? []
    if (role === 'user') entries.push({ message, role, parts: own })
    else for (const part of own) entries.push({ message, role, parts: [part] })
  }
  return entries
}

/** A tool call that has finished, with or without an error, returned something to the agent. */
const FINISHED = new Set(['completed', 'error'])

function stimulusOf(entry: WalkedEntry, tools: ReadonlySet<string>): { kind: StimulusKind; tool: string | null; partId: string | null } | null {
  if (entry.role === 'user') return { kind: 'user_message', tool: null, partId: null }
  if (entry.role !== 'assistant') return null
  const [part] = entry.parts
  const use = part ? toolUseOfPart(part) : null
  if (part && use && tools.has(use.storedTool) && use.status !== undefined && FINISHED.has(use.status)) return { kind: 'tool_result', tool: use.storedTool, partId: part.id }
  return null
}

interface Building {
  stimulus: Omit<WalkedStimulus, 'loads'>
  position: number
  inInterval: LoadEvent[]
}

function walkSession(db: Database, declaration: Declaration, session: ManifestSession, bodies: SkillBodies): WalkedSession {
  const mark = session.last_message
  const messages = db.query<RawMessage, [string, number, number, string]>(WORKFLOW_LOADS_SQL.messages).all(session.id, ...markBound(mark))
  const parts = db.query<RawPart, [string, string, number, number, string]>(WORKFLOW_LOADS_SQL.parts).all(session.id, session.id, ...markBound(mark))
  const entries = entriesOf(messages, parts)
  const tools = new Set(declaration.decision_bearing_tools)

  // every method load in the session, by entry position, for "loaded earlier"
  const loadAt: { position: number; event: LoadEvent }[] = []
  const eventsOfEntry = entries.map((entry, position) => {
    const events = entry.parts.flatMap((part) => loadEvents(part, bodies))
    for (const event of events) loadAt.push({ position, event })
    return events
  })

  const scopes: WalkedScope[] = []
  let waiting: { skill: WorkflowSkill; partId: string } | null = null
  let open: { skill: WorkflowSkill; loadPartId: string; messages: Set<string>; building: Building[] } | null = null

  const close = (ended: ScopeEnd): void => {
    if (!open) return
    scopes.push({
      workflow: open.skill,
      loadPartId: open.loadPartId,
      ended,
      stimuli: open.building.map((b) =>
        Object.assign(b.stimulus, {
          loads: intervalEvidence(b.inInterval, loadAt.filter((l) => l.position < b.position).map((l) => l.event)),
        }),
      ),
    })
    open = null
  }

  for (const [position, entry] of entries.entries()) {
    const workflow = entry.parts.map((part) => ({ skill: workflowLoadOf(part), partId: part.id })).find((w) => w.skill !== null)
    if (workflow?.skill) {
      close('workflow_load')
      waiting = { skill: workflow.skill, partId: workflow.partId }
      continue
    }
    if (open && !open.messages.has(entry.message.id)) {
      if (open.messages.size >= declaration.scope_message_cap) {
        close('message_cap')
        waiting = null
      } else open.messages.add(entry.message.id)
    }
    const stimulus = stimulusOf(entry, tools)
    if (!open && waiting && stimulus) open = { skill: waiting.skill, loadPartId: waiting.partId, messages: new Set([entry.message.id]), building: [] }
    if (!open) continue
    if (stimulus) {
      open.building.push({
        position,
        inInterval: [],
        stimulus: {
          id: stimulus.partId === null ? entry.message.id : `${entry.message.id}/${stimulus.partId}`,
          kind: stimulus.kind,
          tool: stimulus.tool,
          messageId: entry.message.id,
          partId: stimulus.partId,
          entry,
          after: [],
        },
      })
    } else {
      const current = open.building.at(-1)
      if (current) {
        current.stimulus.after.push(entry)
        current.inInterval.push(...(eventsOfEntry[position] ?? []))
      }
    }
  }
  close('session_end')
  return { sessionId: session.id, lastMessage: mark, firstAssistant: entries.find((entry) => entry.role === 'assistant')?.message ?? null, scopes }
}

export interface WalkInput extends GateInput {
  db: string
  privateRoot: PrivateRoot
  /** Default `initial`. */
  slot?: ManifestSlot
  /** The texts of each method's skill file a complete direct read may hold; see `collectSkillBodies`. */
  skillBodies: SkillBodies
  /** Walk only these manifest sessions. A session that is not in the manifest is refused. */
  only?: readonly string[]
}

/**
 * For each session of a manifest, in manifest order: its scopes, their stimuli in stored order with the raw rows to render, and the
 * load evidence of each interval. The gate runs first. Only rows up to each session's mark are read, so the same manifest gives the
 * same walk however much the store has grown.
 */
export function walkManifest(input: WalkInput): WalkedSession[] {
  const pass: GatePass = assertGate(input)
  const slot = input.slot ?? 'initial'
  const manifest = readManifest(input.privateRoot, slot, pass.declarationHash)
  if (!manifest) throw new ManifestError('manifest_missing', `the ${slot} manifest has not been written`)
  if (input.only) {
    const known = new Set(manifest.sessions.map((s) => s.id))
    const stray = input.only.find((id) => !known.has(id))
    if (stray !== undefined) throw new ManifestError('session_not_in_manifest', `${stray} is not in the ${slot} manifest`)
  }
  const wanted = input.only ? new Set(input.only) : null
  const sessions = manifest.sessions.filter((s) => wanted === null || wanted.has(s.id))
  return withStore(input.db, (db) => sessions.map((s) => walkSession(db, pass.declaration, s, input.skillBodies)))
}
