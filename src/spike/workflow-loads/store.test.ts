import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saltedHash } from '../../runner/prereg'
import { type Declaration, DEVIATIONS_PATH, GateRefusal, projectRootHash, recordDeviation } from './declaration'
import type { SkillBodies } from './loads'
import {
  freezeManifest,
  type Manifest,
  ManifestError,
  manifestPath,
  openPrivateRoot,
  type PrivateRoot,
  readManifest,
  StoreError,
  walkManifest,
  walkManifestEach,
  WORKFLOW_LOADS_SQL,
} from './store'
import { EXCLUDED_ROOT, gatedRepo, SAMPLE_SALT, SENTINEL, seedWorkflowSession, type SyntheticStore, syntheticStore } from './test-support'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

/** The order the cap cuts in: ascending salted hash of the session id. */
const byRank = (a: string, b: string): number => {
  const [ka, kb] = [saltedHash(SAMPLE_SALT, `session:${a}`), saltedHash(SAMPLE_SALT, `session:${b}`)]
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

const BODIES: SkillBodies = { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] }

function fixture(overrides: Partial<Declaration> = {}, storeOptions: Parameters<typeof syntheticStore>[0] = {}) {
  const { repo, declaration } = gatedRepo(overrides)
  const store = syntheticStore(storeOptions)
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-private-'))
  const privateRoot = openPrivateRoot({ root: join(dir, 'state') })
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  return { repo, declaration, store, privateRoot, input: { git: repo.git, db: store.path, privateRoot } }
}
type Fixture = ReturnType<typeof fixture>

const walkInput = (f: Fixture, extra: { slot?: 'initial' | 'added'; only?: string[] } = {}) => ({ ...f.input, skillBodies: BODIES, ...extra })

/** The message time the store recorded, which a manifest mark must repeat. */
function messageTime(store: SyntheticStore, id: string): number {
  const row = store.db.query<{ time_created: number }, [string]>('SELECT time_created FROM message WHERE id = ?').get(id)
  if (!row) throw new Error(`no message ${id}`)
  return row.time_created
}

/** Every statement the callback sends to SQLite, whichever method it goes through. */
function recordSql<T>(fn: () => T): { result: T; statements: Set<string> } {
  const statements = new Set<string>()
  const proto = Database.prototype as unknown as Record<string, unknown>
  const originals = new Map<string, (...args: unknown[]) => unknown>()
  for (const name of ['query', 'prepare', 'run', 'exec']) {
    const original = proto[name]
    if (typeof original !== 'function') continue
    originals.set(name, original as (...args: unknown[]) => unknown)
    proto[name] = function (this: unknown, sql: unknown, ...rest: unknown[]) {
      if (typeof sql === 'string') statements.add(sql)
      return (original as (...args: unknown[]) => unknown).call(this, sql, ...rest)
    }
  }
  try {
    return { result: fn(), statements }
  } finally {
    for (const [name, original] of originals) proto[name] = original
  }
}

/** Every row any statement returns to the callback, through `all` and `get`, as the reader sees it. */
function recordRows<T>(fn: () => T): { result: T; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const proto = Database.prototype as unknown as Record<string, unknown>
  const query = proto.query as (this: Database, ...args: unknown[]) => Record<string, unknown>
  const wrapped = new WeakSet<object>()
  proto.query = function (this: Database, ...args: unknown[]) {
    const statement = query.apply(this, args)
    if (wrapped.has(statement)) return statement
    wrapped.add(statement)
    for (const name of ['all', 'get']) {
      const original = statement[name] as (...a: unknown[]) => unknown
      statement[name] = (...a: unknown[]) => {
        const returned = original.apply(statement, a)
        for (const row of Array.isArray(returned) ? returned : [returned]) if (typeof row === 'object' && row !== null) rows.push(row as Record<string, unknown>)
        return returned
      }
    }
    return statement
  }
  try {
    return { result: fn(), rows }
  } finally {
    proto.query = query
  }
}

/** Seeds a session with a workflow load and one user message after it: one stimulus. */
function simpleSession(store: SyntheticStore, id: string, created: string | number = '2026-01-15', extra: { directory?: string; skill?: string; tool?: 'skill' | 'systematic_skill' } = {}) {
  const seeded = seedWorkflowSession(store, { id, created, ...extra })
  const user = store.addMessage(id, 'user')
  store.addText(user, `reply in ${id}`)
  const assistant = store.addMessage(id, 'assistant')
  store.addText(assistant, 'ok')
  return { ...seeded, user2: user, assistant2: assistant }
}

describe('freezeManifest', () => {
  test('one eligible session yields a manifest with that session and its last-message mark', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    const { manifest, created } = freezeManifest(f.input)
    expect(created).toBe(true)
    expect(manifest.sessions).toEqual([{ id: 'ses_a', last_message: { id: s.assistant2, time_created: messageTime(f.store, s.assistant2) }, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(manifest.slot).toBe('initial')
    expect(manifest.eligible).toBe(1)
    expect(manifest.considered).toBe(1)
  })

  test('the manifest binds to the declaration hash and carries a hash of its own content', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    const { manifest } = freezeManifest(f.input)
    expect(manifest.declaration_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.manifest_hash).toMatch(/^[0-9a-f]{64}$/)
    const reread = readManifest(f.privateRoot, 'initial')
    expect(reread).toEqual(manifest)
    expect(reread?.declaration_hash).toBe(manifest.declaration_hash)
  })

  test('the manifest is written privately: owner-only file in an owner-only directory', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const path = manifestPath(f.privateRoot, 'initial')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(f.privateRoot.root).mode & 0o777).toBe(0o700)
  })

  test('a load by the plugin skill tool counts, and ce:review is a workflow skill', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a', '2026-01-15', { tool: 'systematic_skill' })
    simpleSession(f.store, 'ses_b', '2026-01-16', { skill: 'ce:review' })
    simpleSession(f.store, 'ses_c', '2026-01-17', { skill: 'systematic:ce:plan', tool: 'systematic_skill' })
    expect(freezeManifest(f.input).manifest.sessions.map((s) => s.id).sort()).toEqual(['ses_a', 'ses_b', 'ses_c'])
  })

  test('a child session, a session outside the window, one under an excluded root and one with no workflow load are each excluded and counted by reason', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_ok')
    simpleSession(f.store, 'ses_ok_nested', '2026-01-20', { directory: '/excluded/project-not' })
    // child of a delegated task: has a workflow load but a parent
    seedWorkflowSession(f.store, { id: 'ses_child', created: '2026-01-15' })
    f.store.db.run("UPDATE session SET parent_id = 'ses_ok' WHERE id = 'ses_child'")
    simpleSession(f.store, 'ses_early', '2025-12-31')
    simpleSession(f.store, 'ses_late', '2026-03-01')
    simpleSession(f.store, 'ses_root', '2026-01-15', { directory: `${EXCLUDED_ROOT}/packages/a` })
    simpleSession(f.store, 'ses_root_exact', '2026-01-15', { directory: EXCLUDED_ROOT })
    // a session that never loaded a workflow skill, and one whose load did not complete
    f.store.addSession({ id: 'ses_none', created: '2026-01-15' })
    f.store.addText(f.store.addMessage('ses_none', 'user'), 'hello')
    f.store.addSkillCall(f.store.addMessage('ses_none', 'assistant'), 'ce:work')
    f.store.addSession({ id: 'ses_failed', created: '2026-01-15' })
    f.store.addSkillCall(f.store.addMessage('ses_failed', 'assistant'), 'ce:plan', { status: 'error', output: 'boom' })

    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id).sort()).toEqual(['ses_ok', 'ses_ok_nested'])
    expect(manifest.considered).toBe(9)
    expect(manifest.exclusions).toEqual({ child_session: 1, outside_window: 2, excluded_project_root: 2, no_workflow_load: 2, already_sampled: 0, unfinished: 0 })
    expect(manifest.eligible).toBe(2)
  })

  test('a session whose last assistant message is not finished at freeze is excluded as unfinished, not sampled', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_done')
    simpleSession(f.store, 'ses_running')
    f.store.addText(f.store.addMessage('ses_running', 'assistant', { time: { created: 1 } }), 'still working')
    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id)).toEqual(['ses_done'])
    expect(manifest.exclusions.unfinished).toBe(1)
    expect(manifest.eligible).toBe(1)
    expect(manifest.considered).toBe(2)
  })

  test('a session that ends on a user message is finished; an unfinished one with no workflow load is counted as having none', () => {
    const f = fixture()
    seedWorkflowSession(f.store, { id: 'ses_user_last', created: '2026-01-15' })
    f.store.addText(f.store.addMessage('ses_user_last', 'user'), 'one more thing')
    f.store.addSession({ id: 'ses_plain_running', created: '2026-01-15' })
    f.store.addText(f.store.addMessage('ses_plain_running', 'assistant', { time: { created: 1 } }), 'typing')
    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id)).toEqual(['ses_user_last'])
    expect(manifest.exclusions).toMatchObject({ unfinished: 0, no_workflow_load: 1 })
  })

  test('the window is inclusive UTC calendar days at both ends', () => {
    const f = fixture({ window: { start: '2026-01-10', end: '2026-01-12' } })
    simpleSession(f.store, 'ses_before', Date.parse('2026-01-09T23:59:59.999Z'))
    simpleSession(f.store, 'ses_first', Date.parse('2026-01-10T00:00:00.000Z'))
    simpleSession(f.store, 'ses_last', Date.parse('2026-01-12T23:59:59.999Z'))
    simpleSession(f.store, 'ses_after', Date.parse('2026-01-13T00:00:00.000Z'))
    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id).sort()).toEqual(['ses_first', 'ses_last'])
    expect(manifest.exclusions.outside_window).toBe(2)
  })

  test('with more eligible sessions than the cap, the cap keeps those whose salted hashes sort first, and the manifest lists them in that order', () => {
    const f = fixture({ session_cap: 3 })
    const ids = Array.from({ length: 12 }, (_, i) => `ses_${String.fromCharCode(97 + i)}`)
    for (const id of ids) simpleSession(f.store, id)
    const { manifest } = freezeManifest(f.input)
    const expected = [...ids].sort(byRank).slice(0, 3)
    expect(manifest.sessions.map((s) => s.id)).toEqual(expected)
    expect(manifest.eligible).toBe(12)
  })

  test('the same salt gives the same selection and a different salt gives a different one', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ses_${String.fromCharCode(97 + i)}`)
    const pick = (salt: string): string[] => {
      const f = fixture({ session_cap: 3, salt, excluded_project_root_hashes: [] })
      for (const id of ids) simpleSession(f.store, id)
      return freezeManifest(f.input).manifest.sessions.map((s) => s.id)
    }
    const first = pick('salt-one')
    expect(pick('salt-one')).toEqual(first)
    expect(pick('salt-two')).not.toEqual(first)
  })

  test('an existing manifest is read, never rebuilt, whatever the store has become', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    const first = freezeManifest(f.input)
    const bytes = readFileSync(manifestPath(f.privateRoot, 'initial'), 'utf8')
    simpleSession(f.store, 'ses_new')
    const second = freezeManifest(f.input)
    expect(second.created).toBe(false)
    expect(second.manifest).toEqual(first.manifest)
    expect(readFileSync(manifestPath(f.privateRoot, 'initial'), 'utf8')).toBe(bytes)
  })

  test('a session that gains a workflow load after the manifest was written does not join the sample', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    f.store.addSession({ id: 'ses_late_load', created: '2026-01-15' })
    f.store.addText(f.store.addMessage('ses_late_load', 'user'), 'plain chat')
    freezeManifest(f.input)
    f.store.addSkillCall(f.store.addMessage('ses_late_load', 'assistant'), 'ce:plan')
    const again = freezeManifest(f.input)
    expect(again.manifest.sessions.map((s) => s.id)).toEqual(['ses_a'])
    expect(walkManifest(walkInput(f)).map((s) => s.sessionId)).toEqual(['ses_a'])
  })

  test('listing is refused when the declaration gate fails, before the store is opened or anything is written', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    writeFileSync(join(f.repo.dir, 'evals/spikes/workflow-loads/declaration.json'), '{"edited":true}\n')
    let refusal: unknown
    try {
      freezeManifest({ ...f.input, db: join(f.repo.dir, 'does-not-exist.db') })
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(GateRefusal)
    expect((refusal as GateRefusal).reason).toBe('declaration_modified')
    expect(existsSync(manifestPath(f.privateRoot, 'initial'))).toBe(false)
  })

  test('a store missing an expected table fails with a named error and reads nothing else', () => {
    for (const omitTable of ['session', 'message', 'part'] as const) {
      const f = fixture({}, { omitTable })
      const { result, statements } = recordSql(() => {
        try {
          freezeManifest(f.input)
          return undefined
        } catch (e) {
          return e
        }
      })
      expect(result).toBeInstanceOf(StoreError)
      expect((result as StoreError).reason).toBe('store_missing_table')
      expect((result as StoreError).message).toContain(omitTable)
      expect([...statements].filter((sql) => !sql.startsWith('PRAGMA'))).toEqual([WORKFLOW_LOADS_SQL.tables])
      expect(existsSync(manifestPath(f.privateRoot, 'initial'))).toBe(false)
    }
  })

  test('a store file that is not there is a named error', () => {
    const f = fixture()
    expect(() => freezeManifest({ ...f.input, db: join(f.repo.dir, 'missing.db') })).toThrow(StoreError)
    try {
      freezeManifest({ ...f.input, db: join(f.repo.dir, 'missing.db') })
    } catch (e) {
      expect((e as StoreError).reason).toBe('store_unreadable')
    }
  })

  test('a store whose tables lack an expected column is a named error', () => {
    const f = fixture()
    f.store.db.run('ALTER TABLE session RENAME COLUMN directory TO dir')
    try {
      freezeManifest(f.input)
      throw new Error('expected a store error')
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError)
      expect((e as StoreError).reason).toBe('store_schema_mismatch')
    }
  })
})

describe('manifest integrity', () => {
  test('an edited manifest is refused', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    simpleSession(f.store, 'ses_b')
    freezeManifest(f.input)
    const path = manifestPath(f.privateRoot, 'initial')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    parsed.sessions.pop()
    chmodSync(path, 0o600)
    writeFileSync(path, JSON.stringify(parsed))
    expect(() => readManifest(f.privateRoot, 'initial')).toThrow(ManifestError)
    expect(() => freezeManifest(f.input)).toThrow(/manifest_tampered/)
    expect(() => walkManifest(walkInput(f))).toThrow(/manifest_tampered/)
  })

  test('a file that is not a manifest is refused', () => {
    const f = fixture()
    writeFileSync(manifestPath(f.privateRoot, 'initial'), '{"hello":1}')
    try {
      readManifest(f.privateRoot, 'initial')
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError)
      expect((e as ManifestError).reason).toBe('manifest_invalid')
    }
  })

  test('a manifest written under another declaration is refused by every step that uses it', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const other = fixture({ salt: 'another-salt' })
    const input = { ...f.input, git: other.repo.git }
    for (const run of [() => freezeManifest(input), () => walkManifest({ ...input, skillBodies: BODIES })]) {
      try {
        run()
        throw new Error('expected a refusal')
      } catch (e) {
        expect(e).toBeInstanceOf(ManifestError)
        expect((e as ManifestError).reason).toBe('manifest_declaration_mismatch')
      }
    }
  })

  test('no manifest yet reads as undefined, and walking is refused by name', () => {
    const f = fixture()
    expect(readManifest(f.privateRoot, 'initial')).toBeUndefined()
    try {
      walkManifest(walkInput(f))
      throw new Error('expected a refusal')
    } catch (e) {
      expect((e as ManifestError).reason).toBe('manifest_missing')
    }
  })
})

const manifestReasonOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ManifestError) return e.reason
    throw e
  }
  return 'no refusal'
}

describe('the rows of a sampled session are frozen with it', () => {
  test('the manifest holds a content hash for each sampled session, and an unchanged session walks', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    simpleSession(f.store, 'ses_b')
    const { manifest } = freezeManifest(f.input)
    const hashes = manifest.sessions.map((s) => s.content_hash)
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true)
    expect(new Set(hashes).size).toBe(2)
    expect(walkManifest(walkInput(f))).toHaveLength(2)
  })

  test('a part added to the last message after freeze makes the next walk refuse', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    f.store.addText(s.assistant2, 'a late addition')
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('session_rows_changed')
    expect(manifestReasonOf(() => walkManifest(walkInput(f, { only: ['ses_a'] })))).toBe('session_rows_changed')
  })

  test('a part of the last message updated after freeze makes the next walk refuse', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const part = f.store.db.query<{ id: string }, [string]>('SELECT id FROM part WHERE message_id = ?').get(s.assistant2)
    f.store.db.run('UPDATE part SET data = ? WHERE id = ?', [JSON.stringify({ type: 'text', text: 'rewritten' }), part?.id ?? ''])
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('session_rows_changed')
  })

  test('a part of an earlier message changed, or a message row changed, after freeze makes the next walk refuse', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const earlier = f.store.db.query<{ id: string }, [string]>('SELECT id FROM part WHERE message_id = ?').get(s.user)
    f.store.db.run('UPDATE part SET data = ? WHERE id = ?', [JSON.stringify({ type: 'text', text: 'rewritten' }), earlier?.id ?? ''])
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('session_rows_changed')
    f.store.db.run('UPDATE part SET data = ? WHERE id = ?', [JSON.stringify({ type: 'text', text: 'start the workflow' }), earlier?.id ?? ''])
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('no refusal')
    f.store.db.run('UPDATE message SET data = ? WHERE id = ?', [JSON.stringify({ role: 'user', agent: 'other' }), s.user])
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('session_rows_changed')
  })

  test('rows past the mark do not change the hash: a later message does not make the walk refuse', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    f.store.addText(f.store.addMessage('ses_a', 'user'), 'a later question')
    expect(manifestReasonOf(() => walkManifest(walkInput(f)))).toBe('no refusal')
  })

  test('the refusal is per session and names neither a session nor any text', () => {
    const f = fixture()
    const a = simpleSession(f.store, 'ses_a')
    simpleSession(f.store, 'ses_b')
    freezeManifest(f.input)
    f.store.addText(a.assistant2, 'LATE_TEXT_MARKER')
    try {
      walkManifest(walkInput(f))
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError)
      expect((e as Error).message).not.toMatch(/ses_a|ses_b|LATE_TEXT_MARKER/)
    }
    // the other session still walks on its own
    expect(walkManifest(walkInput(f, { only: ['ses_b'] })).map((s) => s.sessionId)).toEqual(['ses_b'])
  })

  test('the hash also guards the added slot', () => {
    const f = fixture({ session_cap: 1 })
    for (const id of ['ses_a', 'ses_b']) simpleSession(f.store, id)
    freezeManifest(f.input)
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'more sessions', session_cap: 2 } })
    const added = freezeManifest({ ...f.input, slot: 'added' }).manifest.sessions[0]
    const last = f.store.db.query<{ id: string }, [string]>('SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1').get(added?.id ?? '')
    f.store.addText(last?.id ?? '', 'late')
    expect(manifestReasonOf(() => walkManifest(walkInput(f, { slot: 'added' })))).toBe('session_rows_changed')
  })
})

describe('the added manifest after a session-cap raise', () => {
  function raised(sessionCap: number, raisedTo: number, count: number) {
    const f = fixture({ session_cap: sessionCap })
    const ids = Array.from({ length: count }, (_, i) => `ses_${String.fromCharCode(97 + i)}`)
    for (const id of ids) simpleSession(f.store, id)
    return { f, ids, raise: () => recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marked points', session_cap: raisedTo } }) }
  }

  test('holds only the added sessions, leaves the first manifest as it was, and ends at the raised cap', () => {
    const { f, ids, raise } = raised(2, 5, 8)
    const initial = freezeManifest(f.input).manifest
    const initialBytes = readFileSync(manifestPath(f.privateRoot, 'initial'), 'utf8')
    raise()
    const added = freezeManifest({ ...f.input, slot: 'added' })
    expect(added.created).toBe(true)
    expect(added.manifest.slot).toBe('added')
    expect(added.manifest.sessions).toHaveLength(3)
    const firstIds = new Set(initial.sessions.map((s) => s.id))
    expect(added.manifest.sessions.every((s) => !firstIds.has(s.id))).toBe(true)
    expect(added.manifest.exclusions.already_sampled).toBe(2)
    expect(readFileSync(manifestPath(f.privateRoot, 'initial'), 'utf8')).toBe(initialBytes)
    // the two manifests together are the five best-ranked sessions
    const ranked = [...ids].sort(byRank)
    expect([...initial.sessions, ...added.manifest.sessions].map((s) => s.id)).toEqual(ranked.slice(0, 5))
  })

  test('an existing added manifest is read, not rebuilt', () => {
    const { f, raise } = raised(2, 4, 6)
    freezeManifest(f.input)
    raise()
    const first = freezeManifest({ ...f.input, slot: 'added' })
    simpleSession(f.store, 'ses_extra')
    const second = freezeManifest({ ...f.input, slot: 'added' })
    expect(second.created).toBe(false)
    expect(second.manifest).toEqual(first.manifest)
  })

  test('is refused without a recorded raise, and without a first manifest', () => {
    const { f, raise } = raised(2, 4, 6)
    raise()
    try {
      freezeManifest({ ...f.input, slot: 'added' })
      throw new Error('expected a refusal')
    } catch (e) {
      expect((e as ManifestError).reason).toBe('initial_manifest_missing')
    }
    const g = fixture({ session_cap: 2 })
    simpleSession(g.store, 'ses_a')
    freezeManifest(g.input)
    try {
      freezeManifest({ ...g.input, slot: 'added' })
      throw new Error('expected a refusal')
    } catch (e) {
      expect((e as ManifestError).reason).toBe('session_cap_not_raised')
    }
  })

  test('a recorded raise does not change the first manifest of a store frozen after it', () => {
    const { f, raise } = raised(2, 4, 6)
    raise()
    expect(freezeManifest(f.input).manifest.sessions).toHaveLength(2)
  })

  test('the raise leaves the gate passing, so the deviations file is the only change', () => {
    const { f, raise } = raised(2, 4, 3)
    raise()
    expect(existsSync(join(f.repo.dir, DEVIATIONS_PATH))).toBe(true)
  })
})

describe('a manifest in the wrong slot', () => {
  const reasonOf = (fn: () => unknown): string => {
    try {
      fn()
    } catch (e) {
      if (e instanceof ManifestError) return e.reason
      throw e
    }
    throw new Error('expected a ManifestError')
  }

  test('a valid manifest copied into the other slot\'s file is refused with a named reason, in both directions', () => {
    const f = fixture({ session_cap: 1 })
    for (const id of ['ses_a', 'ses_b']) simpleSession(f.store, id)
    freezeManifest(f.input)
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'more sessions', session_cap: 2 } })
    freezeManifest({ ...f.input, slot: 'added' })
    // both files verify on their own: each is a manifest of the slot it names
    expect(readManifest(f.privateRoot, 'initial')?.slot).toBe('initial')
    expect(readManifest(f.privateRoot, 'added')?.slot).toBe('added')

    const [initialPath, addedPath] = [manifestPath(f.privateRoot, 'initial'), manifestPath(f.privateRoot, 'added')]
    const [initialText, addedText] = [readFileSync(initialPath, 'utf8'), readFileSync(addedPath, 'utf8')]
    writeFileSync(initialPath, addedText)
    writeFileSync(addedPath, initialText)
    expect(reasonOf(() => readManifest(f.privateRoot, 'initial'))).toBe('manifest_slot_mismatch')
    expect(reasonOf(() => readManifest(f.privateRoot, 'added'))).toBe('manifest_slot_mismatch')
    // and no step takes the copy for the slot's own
    expect(reasonOf(() => walkManifest(walkInput(f)))).toBe('manifest_slot_mismatch')
    expect(reasonOf(() => walkManifest(walkInput(f, { slot: 'added' })))).toBe('manifest_slot_mismatch')
    expect(reasonOf(() => freezeManifest(f.input))).toBe('manifest_slot_mismatch')
  })
})

describe('private root', () => {
  test('defaults to a workflow-loads directory in the metacogs state directory, and an override moves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-state-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const byDefault = openPrivateRoot({ env: { XDG_STATE_HOME: dir }, home: '/nowhere' })
    expect(byDefault.root).toBe(join(dir, 'metacogs', 'workflow-loads'))
    expect(statSync(byDefault.root).mode & 0o777).toBe(0o700)
    const moved = openPrivateRoot({ root: join(dir, 'elsewhere') })
    expect(moved.root).toBe(join(dir, 'elsewhere'))
  })

  test('a root inside the repository is refused, however it was spelled', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-repo-'))
    cleanup.push(() => rmSync(repoRoot, { recursive: true, force: true }))
    expect(() => openPrivateRoot({ root: join(repoRoot, 'state'), repoRoot })).toThrow(/outside the working tree/)
    expect(() => openPrivateRoot({ root: join(repoRoot, 'a', '..', 'state'), repoRoot })).toThrow(/outside the working tree/)
  })
})

describe('walkManifest: stimuli, scopes and intervals', () => {
  /** user, then an assistant message that loads the workflow skill, then whatever the callback appends. */
  function scene(f: Fixture, id: string, build: (s: { user: string; assistant: string; load: string }) => void, created: string = '2026-01-15') {
    const seeded = seedWorkflowSession(f.store, { id, created })
    build(seeded)
    return seeded
  }
  const freezeAndWalk = (f: Fixture, extra: { only?: string[] } = {}) => {
    freezeManifest(f.input)
    return walkManifest(walkInput(f, extra))
  }

  test('a user message after the workflow load is a stimulus, with its raw rows and a stable id', () => {
    const f = fixture()
    let user2 = ''
    scene(f, 'ses_a', () => {
      user2 = f.store.addMessage('ses_a', 'user')
      f.store.addText(user2, 'first answer')
      f.store.addText(user2, 'second part')
    })
    const [session] = freezeAndWalk(f)
    const [scope] = session!.scopes
    expect(scope!.workflow).toBe('ce:plan')
    expect(scope!.stimuli).toHaveLength(1)
    const stimulus = scope!.stimuli[0]!
    expect(stimulus.id).toBe(user2)
    expect(stimulus.kind).toBe('user_message')
    expect(stimulus.tool).toBeNull()
    expect(stimulus.partId).toBeNull()
    expect(stimulus.entry.message.id).toBe(user2)
    expect(stimulus.entry.role).toBe('user')
    expect(stimulus.entry.parts.map((p) => JSON.parse(p.data).text)).toEqual(['first answer', 'second part'])
  })

  test('the first assistant message of the session is reported with its stored data, and none when there is none', () => {
    const f = fixture()
    scene(f, 'ses_a', () => undefined)
    f.store.addSession({ id: 'ses_b', created: '2026-01-15' })
    const first = f.store.addMessage('ses_b', 'assistant', { providerID: 'anthropic', modelID: 'claude-x' })
    f.store.addSkillCall(first, 'ce:plan')
    f.store.addMessage('ses_b', 'assistant', { providerID: 'openai', modelID: 'gpt-x' })
    freezeManifest(f.input)
    const sessions = walkManifest(walkInput(f))
    const b = sessions.find((s) => s.sessionId === 'ses_b')
    expect(b?.firstAssistant?.id).toBe(first)
    expect(JSON.parse(b?.firstAssistant?.data ?? '{}')).toMatchObject({ role: 'assistant', providerID: 'anthropic' })
    // a session's first assistant message is the one that loaded the workflow skill in the seeded scene
    expect(sessions.find((s) => s.sessionId === 'ses_a')?.firstAssistant).not.toBeNull()
  })

  test('the user message that came before the workflow load is not in scope', () => {
    const f = fixture()
    scene(f, 'ses_a', () => {})
    const [session] = freezeAndWalk(f)
    expect(session!.scopes).toEqual([])
  })

  test('a result of a decision-bearing tool is a stimulus; the result of any other tool is not', () => {
    const f = fixture({ decision_bearing_tools: ['task', 'question'] })
    let task = ''
    let read = ''
    let question = ''
    scene(f, 'ses_a', ({ assistant }) => {
      read = f.store.addTool(assistant, { tool: 'read', input: { filePath: 'a.txt' }, output: 'file text' })
      task = f.store.addTool(assistant, { tool: 'task', input: { prompt: 'do it' }, output: 'task finished' })
      question = f.store.addTool(assistant, { tool: 'question', input: {}, output: 'the user said yes' })
    })
    const [session] = freezeAndWalk(f)
    const stimuli = session!.scopes[0]!.stimuli
    expect(stimuli.map((s) => [s.kind, s.tool, s.partId])).toEqual([
      ['tool_result', 'task', task],
      ['tool_result', 'question', question],
    ])
    expect(stimuli[0]!.id).toBe(`${stimuli[0]!.messageId}/${task}`)
    expect(stimuli[0]!.entry.parts.map((p) => p.id)).toEqual([task])
    // the unlisted read traffic sits before the first stimulus, so it belongs to no interval
    expect(JSON.stringify(session)).not.toContain(read)
  })

  test('a tool call that has not finished is not a result, an errored one is', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    let failed = ''
    scene(f, 'ses_a', ({ assistant }) => {
      f.store.addTool(assistant, { tool: 'task', output: '', status: 'running' })
      failed = f.store.addTool(assistant, { tool: 'task', output: 'it broke', status: 'error' })
    })
    const [session] = freezeAndWalk(f)
    expect(session!.scopes[0]!.stimuli.map((s) => s.partId)).toEqual([failed])
  })

  test('two stimuli inside one assistant turn yield two intervals, and a load between them belongs to the first', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    let first = ''
    let second = ''
    let load = ''
    scene(f, 'ses_a', ({ assistant }) => {
      first = f.store.addTool(assistant, { tool: 'task', output: 'result one' })
      load = f.store.addSkillCall(assistant, 'counterfactual')
      second = f.store.addTool(assistant, { tool: 'task', output: 'result two' })
      f.store.addText(assistant, 'wrapping up')
    })
    const [session] = freezeAndWalk(f)
    const [one, two] = session!.scopes[0]!.stimuli
    expect(one!.partId).toBe(first)
    expect(two!.partId).toBe(second)
    expect(one!.after.flatMap((e) => e.parts.map((p) => p.id))).toEqual([load])
    expect(one!.loads.counterfactual).toMatchObject({ loaded: true, basis: 'skill_call', loadedEarlier: false })
    expect(one!.loads.synthesis.loaded).toBe(false)
    expect(two!.after.flatMap((e) => e.parts.map((p) => JSON.parse(p.data).type))).toEqual(['text'])
    expect(two!.loads.counterfactual).toMatchObject({ loaded: false, basis: null, loadedEarlier: true })
  })

  test('the interval runs from a stimulus up to, not including, the next one, in stored order, across messages', () => {
    const f = fixture()
    let u2 = ''
    let u3 = ''
    let a2 = ''
    scene(f, 'ses_a', () => {
      u2 = f.store.addMessage('ses_a', 'user')
      f.store.addText(u2, 'one')
      a2 = f.store.addMessage('ses_a', 'assistant')
      f.store.addText(a2, 'thinking')
      f.store.addTool(a2, { tool: 'read', output: 'x' })
      u3 = f.store.addMessage('ses_a', 'user')
      f.store.addText(u3, 'two')
    })
    const [session] = freezeAndWalk(f)
    const [one, two] = session!.scopes[0]!.stimuli
    expect([one!.id, two!.id]).toEqual([u2, u3])
    expect(one!.after.map((e) => [e.message.id, e.role, e.parts.length])).toEqual([
      [a2, 'assistant', 1],
      [a2, 'assistant', 1],
    ])
    expect(two!.after).toEqual([])
  })

  test('a second workflow load ends the first scope, and stimuli after it belong to the second', () => {
    const f = fixture()
    let u2 = ''
    let u3 = ''
    scene(f, 'ses_a', () => {
      u2 = f.store.addMessage('ses_a', 'user')
      f.store.addText(u2, 'in the plan')
      const a2 = f.store.addMessage('ses_a', 'assistant')
      f.store.addText(a2, 'tail of the first scope')
      f.store.addSkillCall(a2, 'ce:review')
      f.store.addText(a2, 'between the scopes')
      u3 = f.store.addMessage('ses_a', 'user')
      f.store.addText(u3, 'in the review')
    })
    const [session] = freezeAndWalk(f)
    expect(session!.scopes.map((s) => [s.workflow, s.stimuli.map((x) => x.id), s.ended])).toEqual([
      ['ce:plan', [u2], 'workflow_load'],
      ['ce:review', [u3], 'session_end'],
    ])
    // the interval of the last stimulus of the first scope stops before the load and shows nothing of what follows it
    const tail = session!.scopes[0]!.stimuli[0]!.after.flatMap((e) => e.parts.map((p) => JSON.parse(p.data).text ?? JSON.parse(p.data).tool))
    expect(tail).toEqual(['tail of the first scope'])
  })

  test('a load of the same workflow skill again also starts a new scope', () => {
    const f = fixture()
    scene(f, 'ses_a', () => {
      f.store.addText(f.store.addMessage('ses_a', 'user'), 'one')
      f.store.addSkillCall(f.store.addMessage('ses_a', 'assistant'), 'ce:plan')
      f.store.addText(f.store.addMessage('ses_a', 'user'), 'two')
    })
    const [session] = freezeAndWalk(f)
    expect(session!.scopes.map((s) => s.stimuli.length)).toEqual([1, 1])
  })

  test('the scope message cap ends the scope, and stimuli beyond it are not returned', () => {
    const f = fixture({ scope_message_cap: 3 })
    const users: string[] = []
    scene(f, 'ses_a', () => {
      for (let i = 0; i < 3; i++) {
        const u = f.store.addMessage('ses_a', 'user')
        f.store.addText(u, `u${i}`)
        users.push(u)
        f.store.addText(f.store.addMessage('ses_a', 'assistant'), `a${i}`)
      }
    })
    const [session] = freezeAndWalk(f)
    const scope = session!.scopes[0]!
    expect(scope.ended).toBe('message_cap')
    // messages counted from the first stimulus: u0, a0, u1
    expect(scope.stimuli.map((s) => s.id)).toEqual([users[0]!, users[1]!])
    expect(new Set(scope.stimuli.flatMap((s) => [s.entry.message.id, ...s.after.map((e) => e.message.id)])).size).toBe(3)
  })

  test('a message with no parts still counts toward the scope message cap', () => {
    const f = fixture({ scope_message_cap: 3 })
    const users: string[] = []
    scene(f, 'ses_a', () => {
      for (const text of ['u0', 'u1', 'u2']) {
        const u = f.store.addMessage('ses_a', 'user')
        f.store.addText(u, text)
        users.push(u)
        // a partless assistant message between the first two user messages: the turn was cut off before it wrote anything
        if (text === 'u0') f.store.addMessage('ses_a', 'assistant')
      }
    })
    const [session] = freezeAndWalk(f)
    const scope = session!.scopes[0]!
    // messages counted from the first stimulus: u0, the partless one, u1
    expect(scope.ended).toBe('message_cap')
    expect(scope.stimuli.map((s) => s.id)).toEqual([users[0]!, users[1]!])
  })

  test('a message with no parts keeps its place in the interval and is the first assistant message when it comes first', () => {
    const f = fixture()
    f.store.addSession({ id: 'ses_a', created: '2026-01-15' })
    f.store.addText(f.store.addMessage('ses_a', 'user'), 'start')
    const partless = f.store.addMessage('ses_a', 'assistant', { providerID: 'anthropic', modelID: 'claude-x' })
    f.store.addSkillCall(f.store.addMessage('ses_a', 'assistant', { providerID: 'openai', modelID: 'gpt-x' }), 'ce:plan')
    const u = f.store.addMessage('ses_a', 'user')
    f.store.addText(u, 'in scope')
    const later = f.store.addMessage('ses_a', 'assistant', { providerID: 'google', modelID: 'gemini-x' })
    f.store.addText(f.store.addMessage('ses_a', 'assistant', { providerID: 'openai', modelID: 'gpt-x' }), 'answer')
    const [session] = freezeAndWalk(f)
    expect(session!.firstAssistant?.id).toBe(partless)
    const [stimulus] = session!.scopes[0]!.stimuli
    expect(stimulus!.after.map((e) => [e.message.id === later ? 'later' : 'other', e.role, e.parts.length])).toEqual([
      ['later', 'assistant', 0],
      ['other', 'assistant', 1],
    ])
  })

  test('a load by direct read of a skill file, and by the plugin tool, are reported with their basis', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    scene(f, 'ses_a', ({ assistant }) => {
      f.store.addTool(assistant, { tool: 'task', output: 'r1' })
      f.store.addRead(assistant, '/pkg/skills/synthesis/SKILL.md', BODIES.synthesis[0]!)
      f.store.addTool(assistant, { tool: 'task', output: 'r2' })
      f.store.addSkillCall(assistant, 'counterfactual', { tool: 'systematic_skill' })
      f.store.addTool(assistant, { tool: 'task', output: 'r3' })
      f.store.addRead(assistant, '/pkg/skills/counterfactual/SKILL.md', 'only a fragment')
    })
    const [session] = freezeAndWalk(f)
    const [s1, s2, s3] = session!.scopes[0]!.stimuli
    expect(s1!.loads.synthesis).toMatchObject({ loaded: true, basis: 'direct_read' })
    expect(s1!.loads.counterfactual.loaded).toBe(false)
    expect(s2!.loads.counterfactual).toMatchObject({ loaded: true, basis: 'skill_call' })
    expect(s2!.loads.synthesis).toMatchObject({ loaded: false, loadedEarlier: true })
    expect(s3!.loads.counterfactual).toMatchObject({ loaded: false, loadedEarlier: true })
  })

  test('a method loaded by its prefixed name is counted in its interval, and as loaded earlier after it', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    scene(f, 'ses_a', ({ assistant }) => {
      f.store.addTool(assistant, { tool: 'task', output: 'r1' })
      f.store.addSkillCall(assistant, 'systematic:counterfactual', { tool: 'systematic_skill' })
      f.store.addTool(assistant, { tool: 'task', output: 'r2' })
      f.store.addSkillCall(assistant, 'systematic:synthesis', { tool: 'skill' })
      f.store.addTool(assistant, { tool: 'task', output: 'r3' })
    })
    const [session] = freezeAndWalk(f)
    const [s1, s2, s3] = session!.scopes[0]!.stimuli
    expect(s1!.loads.counterfactual).toMatchObject({ loaded: true, basis: 'skill_call', loadedEarlier: false })
    expect(s1!.loads.synthesis.loaded).toBe(false)
    expect(s2!.loads.counterfactual).toMatchObject({ loaded: false, loadedEarlier: true })
    expect(s2!.loads.synthesis).toMatchObject({ loaded: true, basis: 'skill_call', loadedEarlier: false })
    expect(s3!.loads.counterfactual.loadedEarlier).toBe(true)
    expect(s3!.loads.synthesis).toMatchObject({ loaded: false, loadedEarlier: true })
    // the prefixed call is no stimulus even when its tool were declared decision-bearing: it stays in the interval it fell in
    expect(s1!.after.flatMap((e) => e.parts.map((p) => JSON.parse(p.data).tool))).toEqual(['systematic_skill'])
  })

  test('a method loaded before the workflow scope began counts as loaded earlier', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    f.store.addSession({ id: 'ses_a', created: '2026-01-15' })
    f.store.addSkillCall(f.store.addMessage('ses_a', 'assistant'), 'synthesis')
    const a = f.store.addMessage('ses_a', 'assistant')
    f.store.addSkillCall(a, 'ce:plan')
    f.store.addTool(a, { tool: 'task', output: 'r' })
    const [session] = freezeAndWalk(f)
    const stimulus = session!.scopes[0]!.stimuli[0]!
    expect(stimulus.loads.synthesis).toMatchObject({ loaded: false, loadedEarlier: true })
    expect(stimulus.loads.counterfactual).toMatchObject({ loaded: false, loadedEarlier: false })
  })

  test('a load in the same message as a stimulus but before it is earlier, not in its interval', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    scene(f, 'ses_a', ({ assistant }) => {
      f.store.addSkillCall(assistant, 'counterfactual')
      f.store.addTool(assistant, { tool: 'task', output: 'r' })
    })
    const [session] = freezeAndWalk(f)
    expect(session!.scopes[0]!.stimuli[0]!.loads.counterfactual).toMatchObject({ loaded: false, loadedEarlier: true })
  })

  test('a call that loads a method is never a stimulus, whatever the declaration says: with read decision-bearing, a skill-file read is no stimulus and counts as earlier for the next one', () => {
    const f = fixture({ decision_bearing_tools: ['read'] })
    scene(f, 'ses_a', ({ assistant }) => {
      f.store.addRead(assistant, '/pkg/skills/synthesis/SKILL.md', BODIES.synthesis[0]!)
      f.store.addRead(assistant, '/pkg/notes.txt', 'plain notes')
    })
    const [session] = freezeAndWalk(f)
    const stimuli = session!.scopes[0]!.stimuli
    expect(stimuli.map((s) => s.tool)).toEqual(['read'])
    expect(stimuli[0]!.loads.synthesis).toMatchObject({ loaded: false, loadedEarlier: true })
  })

  test('with read decision-bearing, a direct skill-file read after a stimulus is a load in that stimulus\'s interval', () => {
    const f = fixture({ decision_bearing_tools: ['read'] })
    let notes = ''
    let more = ''
    let skillRead = ''
    scene(f, 'ses_a', ({ assistant }) => {
      notes = f.store.addRead(assistant, '/pkg/notes.txt', 'plain notes')
      skillRead = f.store.addRead(assistant, '/pkg/skills/synthesis/SKILL.md', BODIES.synthesis[0]!)
      more = f.store.addRead(assistant, '/pkg/more.txt', 'more notes')
    })
    const [session] = freezeAndWalk(f)
    const [first, second] = session!.scopes[0]!.stimuli
    expect(first!.partId).toBe(notes)
    expect(second!.partId).toBe(more)
    expect(first!.after.flatMap((e) => e.parts.map((p) => p.id))).toEqual([skillRead])
    expect(first!.loads.synthesis).toMatchObject({ loaded: true, basis: 'direct_read', loadedEarlier: false })
    expect(second!.loads.synthesis).toMatchObject({ loaded: false, loadedEarlier: true })
  })

  test('a skill call, a skill-file read by shell and a record-helper call are not stimuli either, with their tools declared decision-bearing', () => {
    const f = fixture({ decision_bearing_tools: ['skill', 'systematic_skill', 'bash', 'read'] })
    let first = ''
    let last = ''
    scene(f, 'ses_a', ({ assistant }) => {
      first = f.store.addTool(assistant, { tool: 'bash', input: { command: 'ls src' }, output: 'a.ts' })
      f.store.addSkillCall(assistant, 'counterfactual', { tool: 'systematic_skill' })
      f.store.addTool(assistant, { tool: 'bash', input: { command: 'cat skills/synthesis/SKILL.md' }, output: 'body of synthesis' })
      f.store.addTool(assistant, { tool: 'bash', input: { command: 'node skills/counterfactual/scripts/record.mjs < in.json' }, output: 'recorded' })
      f.store.addTool(assistant, { tool: 'skill', input: { name: 'counterfactual' }, output: 'boom', status: 'error' })
      last = f.store.addTool(assistant, { tool: 'bash', input: { command: 'ls docs' }, output: 'b.md' })
    })
    const [session] = freezeAndWalk(f)
    const stimuli = session!.scopes[0]!.stimuli
    expect(stimuli.map((s) => s.partId)).toEqual([first, last])
    expect(stimuli[0]!.after).toHaveLength(4)
    expect(stimuli[0]!.loads.counterfactual.loaded).toBe(true)
  })

  test('messages added to a session after the manifest was written are not read', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const before = JSON.stringify(walkManifest(walkInput(f)))
    const u = f.store.addMessage('ses_a', 'user')
    f.store.addText(u, 'a later question')
    const a = f.store.addMessage('ses_a', 'assistant')
    f.store.addSkillCall(a, 'counterfactual')
    f.store.addSkillCall(a, 'ce:review')
    f.store.addText(f.store.addMessage('ses_a', 'user'), 'after the review load')
    const after = walkManifest(walkInput(f))
    expect(JSON.stringify(after)).toBe(before)
    expect(after[0]!.lastMessage.id).toBe(s.assistant2)
    expect(JSON.stringify(after)).not.toContain('a later question')
    expect(after[0]!.scopes).toHaveLength(1)
    expect(after[0]!.scopes[0]!.stimuli[0]!.loads.counterfactual.loaded).toBe(false)
  })

  test('the mark covers every message up to it and none beyond, even with equal message times', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    f.store.db.run("UPDATE message SET time_created = 5000 WHERE session_id = 'ses_a'")
    freezeManifest(f.input)
    const extra = f.store.addMessage('ses_a', 'user')
    f.store.addText(extra, 'later')
    f.store.db.run('UPDATE message SET time_created = 5000 WHERE id = ?', [extra])
    const [session] = walkManifest(walkInput(f))
    expect(JSON.stringify(session)).not.toContain('later')
  })

  test('no row the reader fetches belongs to a message past the mark, including one with the mark\'s own creation time and a later id', () => {
    const f = fixture()
    const s = simpleSession(f.store, 'ses_a')
    const mark = freezeManifest(f.input).manifest.sessions[0]?.last_message
    if (!mark) throw new Error('no mark')
    expect(mark.id).toBe(s.assistant2)

    const sameTime = f.store.addMessage('ses_a', 'user')
    f.store.addText(sameTime, 'same time, later id')
    f.store.db.run('UPDATE message SET time_created = ? WHERE id = ?', [mark.time_created, sameTime])
    const later = f.store.addMessage('ses_a', 'assistant')
    f.store.addSkillCall(later, 'counterfactual')
    f.store.addText(f.store.addMessage('ses_a', 'user'), 'much later')
    const pastMark = new Set<string>(f.store.db.query<{ id: string }, [number, number, string]>('SELECT id FROM message WHERE session_id = \'ses_a\' AND (time_created > ? OR (time_created = ? AND id > ?))').all(mark.time_created, mark.time_created, mark.id).map((row) => row.id))
    expect(pastMark.has(sameTime)).toBe(true)
    expect(pastMark.size).toBe(3)

    const { rows } = recordRows(() => walkManifest(walkInput(f)))
    const messageIds = rows.flatMap((row) => (typeof row.message_id === 'string' ? [row.message_id] : 'data' in row && 'session_id' in row && typeof row.id === 'string' ? [row.id] : []))
    // the instrument sees the reader's rows: the mark's own message was fetched, so an empty list would prove nothing
    expect(messageIds).toContain(mark.id)
    expect(messageIds.filter((id) => pastMark.has(id))).toEqual([])
    // and no part row names a message past the mark
    expect(rows.filter((row) => typeof row.message_id === 'string' && pastMark.has(row.message_id))).toEqual([])
  })

  test('re-running a step after the store has grown yields the same sessions, stimuli and intervals', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    for (const id of ['ses_a', 'ses_b']) {
      scene(f, id, ({ assistant }) => {
        f.store.addTool(assistant, { tool: 'task', output: `r-${id}` })
        f.store.addSkillCall(assistant, 'synthesis')
        f.store.addText(f.store.addMessage(id, 'user'), `u-${id}`)
      })
    }
    freezeManifest(f.input)
    const before = JSON.stringify(walkManifest(walkInput(f)))
    simpleSession(f.store, 'ses_c')
    for (const id of ['ses_a', 'ses_b']) f.store.addText(f.store.addMessage(id, 'user'), 'grown')
    expect(JSON.stringify(walkManifest(walkInput(f)))).toBe(before)
    expect(JSON.stringify(freezeManifest(f.input).manifest)).toBe(JSON.stringify(readManifest(f.privateRoot, 'initial')))
  })

  test('only restricts the walk to the named manifest sessions, in manifest order', () => {
    const f = fixture()
    for (const id of ['ses_a', 'ses_b', 'ses_c']) simpleSession(f.store, id)
    freezeManifest(f.input)
    expect(walkManifest(walkInput(f, { only: ['ses_c'] })).map((s) => s.sessionId)).toEqual(['ses_c'])
    expect(() => walkManifest(walkInput(f, { only: ['ses_not_in_manifest'] }))).toThrow(/ses_not_in_manifest/)
  })

  test('walking is refused when the declaration gate fails', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    writeFileSync(join(f.repo.dir, 'evals/spikes/workflow-loads/marking-rule.md'), 'changed rule\n')
    expect(() => walkManifest(walkInput(f))).toThrow(GateRefusal)
  })

  test('rows whose data is not a JSON object are counted per session, a part and a message each', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_clean')
    simpleSession(f.store, 'ses_bad_part')
    const textPart = f.store.addText(f.store.addMessage('ses_bad_part', 'assistant'), 'x')
    f.store.db.run("UPDATE part SET data = '{broken' WHERE id = ?", [textPart])
    simpleSession(f.store, 'ses_bad_message')
    const bad = f.store.addMessage('ses_bad_message', 'user')
    f.store.db.run("UPDATE message SET data = 'not json' WHERE id = ?", [bad])
    simpleSession(f.store, 'ses_not_objects')
    const tail = f.store.addMessage('ses_not_objects', 'assistant')
    const [one, two] = [f.store.addText(tail, 'a'), f.store.addText(tail, 'b')]
    f.store.db.run("UPDATE part SET data = 'null' WHERE id = ?", [one])
    f.store.db.run("UPDATE part SET data = '[1]' WHERE id = ?", [two])
    freezeManifest(f.input)
    const unreadable = Object.fromEntries(walkManifest(walkInput(f)).map((s) => [s.sessionId, s.unreadableRows]))
    expect(unreadable).toEqual({ ses_clean: 0, ses_bad_part: 1, ses_bad_message: 1, ses_not_objects: 2 })
  })

  test('the walk covers the added manifest by slot', () => {
    const f = fixture({ session_cap: 1 })
    for (const id of ['ses_a', 'ses_b', 'ses_c']) simpleSession(f.store, id)
    const first = freezeManifest(f.input).manifest.sessions[0]!.id
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'more sessions', session_cap: 2 } })
    const added = freezeManifest({ ...f.input, slot: 'added' }).manifest.sessions[0]!.id
    expect(walkManifest(walkInput(f)).map((s) => s.sessionId)).toEqual([first])
    expect(walkManifest(walkInput(f, { slot: 'added' })).map((s) => s.sessionId)).toEqual([added])
  })
})

describe('eligibility is one existence query per candidate', () => {
  const others = (f: Fixture, assistant: string, n: number): void => {
    for (let i = 0; i < n; i++) f.store.addSkillCall(assistant, `ce:other-${i}`, { tool: i % 2 === 0 ? 'skill' : 'systematic_skill' })
  }

  test('a session with many skill parts is decided correctly wherever its workflow load sits', () => {
    const f = fixture()
    f.store.addSession({ id: 'ses_none', created: '2026-01-15' })
    others(f, f.store.addMessage('ses_none', 'assistant'), 80)
    for (const [id, before, after] of [['ses_first', 0, 80], ['ses_middle', 40, 40], ['ses_last', 80, 0]] as const) {
      f.store.addSession({ id, created: '2026-01-15' })
      const a = f.store.addMessage(id, 'assistant')
      others(f, a, before)
      f.store.addSkillCall(a, 'systematic:ce:review', { tool: 'systematic_skill' })
      others(f, a, after)
    }
    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id).sort()).toEqual(['ses_first', 'ses_last', 'ses_middle'])
    expect(manifest.exclusions.no_workflow_load).toBe(1)
  })

  test('a workflow name that is not exactly a workflow skill, a non-skill tool, an unfinished call and a malformed part decide nothing', () => {
    const f = fixture()
    const bare = (id: string): string => {
      f.store.addSession({ id, created: '2026-01-15' })
      return f.store.addMessage(id, 'assistant')
    }
    f.store.addSkillCall(bare('ses_prefix_twice'), 'systematic:systematic:ce:plan', { tool: 'systematic_skill' })
    f.store.addSkillCall(bare('ses_longer_name'), 'ce:plan-extra')
    f.store.addTool(bare('ses_other_tool'), { tool: 'read', input: { name: 'ce:plan' } })
    f.store.addSkillCall(bare('ses_running'), 'ce:plan', { status: 'running' })
    f.store.addTool(bare('ses_number_name'), { tool: 'skill', input: { name: 7 } })
    f.store.db.run('UPDATE part SET data = ? WHERE id = ?', ['{"type":"tool","tool":"skill",', f.store.addText(bare('ses_malformed'), 'x')])
    f.store.addSkillCall(bare('ses_ok'), 'ce:plan')
    const { manifest } = freezeManifest(f.input)
    expect(manifest.sessions.map((s) => s.id)).toEqual(['ses_ok'])
    expect(manifest.exclusions.no_workflow_load).toBe(6)
  })

  test('a session with no workflow load has none of its parts read, and the statement used is on the allowlist and ends at the first row', () => {
    const f = fixture()
    f.store.addSession({ id: 'ses_many', created: '2026-01-15' })
    others(f, f.store.addMessage('ses_many', 'assistant'), 60)
    const { result, statements } = recordSql(() => recordRows(() => freezeManifest(f.input)))
    expect(result.result.manifest.exclusions.no_workflow_load).toBe(1)
    expect(result.rows.filter((row) => row.session_id === 'ses_many' || typeof row.message_id === 'string')).toEqual([])
    expect(statements.has(WORKFLOW_LOADS_SQL.workflowLoad)).toBe(true)
    expect(WORKFLOW_LOADS_SQL.workflowLoad).toMatch(/LIMIT 1$/)
    expect(Object.keys(WORKFLOW_LOADS_SQL)).not.toContain('skillParts')
  })
})

describe('walking one session at a time', () => {
  test('the walk reads the rows of one session per step, in manifest order', () => {
    const f = fixture()
    for (const id of ['ses_a', 'ses_b', 'ses_c']) simpleSession(f.store, id)
    const { manifest } = freezeManifest(f.input)
    const walk = walkManifestEach(walkInput(f))
    const { result: first, rows } = recordRows(() => walk.next())
    expect(first.done).toBe(false)
    expect(first.value?.sessionId).toBe(manifest.sessions[0]?.id)
    const sessionsRead = new Set(rows.flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : [])))
    expect([...sessionsRead]).toEqual([manifest.sessions[0]?.id ?? ''])
    expect(rows.length).toBeGreaterThan(0)
    const rest = [...walk].map((s) => s.sessionId)
    expect(rest).toEqual(manifest.sessions.slice(1).map((s) => s.id))
    expect(walk.next().done).toBe(true)
  })

  test('the refusals that need no row come when the walk is asked for, not when it is first pulled', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    expect(() => walkManifestEach(walkInput(f))).toThrow(/manifest_missing/)
    freezeManifest(f.input)
    expect(() => walkManifestEach(walkInput(f, { only: ['ses_nope'] }))).toThrow(/ses_nope/)
    writeFileSync(join(f.repo.dir, 'evals/spikes/workflow-loads/marking-rule.md'), 'changed rule\n')
    expect(() => walkManifestEach(walkInput(f))).toThrow(GateRefusal)
  })

  test('a walk can be abandoned early, and a store error in the middle of one is a named error', () => {
    const f = fixture()
    for (const id of ['ses_a', 'ses_b']) simpleSession(f.store, id)
    freezeManifest(f.input)
    const walk = walkManifestEach(walkInput(f))
    walk.next()
    expect(walk.return(undefined).done).toBe(true)
    // a new walk opens its own connection, and a column the reader needs having gone is a named error
    f.store.db.run('ALTER TABLE part RENAME COLUMN data TO payload')
    expect(() => [...walkManifestEach(walkInput(f))]).toThrow(StoreError)
  })

  test('walkManifest collects the same sessions the walk yields', () => {
    const f = fixture()
    for (const id of ['ses_a', 'ses_b']) simpleSession(f.store, id)
    freezeManifest(f.input)
    expect(JSON.stringify(walkManifest(walkInput(f)))).toBe(JSON.stringify([...walkManifestEach(walkInput(f))]))
  })
})

describe('read-only access', () => {
  test('every statement is on the allowlist and none touches a table outside session, message and part', () => {
    const f = fixture({ decision_bearing_tools: ['task'] })
    simpleSession(f.store, 'ses_a')
    f.store.addTool(f.store.addMessage('ses_a', 'assistant'), { tool: 'task', output: 'r' })
    f.store.addRead(f.store.addMessage('ses_a', 'assistant'), '/x/skills/synthesis/SKILL.md', 'body of synthesis')
    const { result, statements } = recordSql(() => {
      freezeManifest(f.input)
      return walkManifest(walkInput(f))
    })
    const allowed = new Set<string>([...Object.values(WORKFLOW_LOADS_SQL), 'PRAGMA query_only = ON'])
    expect([...statements].filter((sql) => !allowed.has(sql))).toEqual([])
    expect(statements.size).toBeGreaterThan(3)
    for (const sql of statements) expect(sql).not.toMatch(/account/i)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(JSON.stringify(readManifest(f.privateRoot, 'initial'))).not.toContain(SENTINEL)
  })

  test('the allowlist names only the three tables (and the schema listing), selects named columns, and carries no credential, share or permission column', () => {
    for (const sql of Object.values(WORKFLOW_LOADS_SQL)) {
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1] ?? "")
      for (const table of tables) expect(['session', 'message', 'part', 'sqlite_master']).toContain(table)
      expect(sql).not.toMatch(/SELECT\s+\*|\.\*/i)
      expect(sql).not.toMatch(/\b(account|control_account|credential|credentials|session_share|permission|share_url|access_token)\b/i)
    }
    expect(WORKFLOW_LOADS_SQL.sessions).toMatch(/^SELECT id, parent_id, directory, time_created FROM session\b/)
  })

  test('the connection cannot write: a decoy table is left as it was', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    walkManifest(walkInput(f))
    const row = f.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM account').get()
    expect(row?.n).toBe(1)
  })

  test('a write attempted through the connection the reader opens fails for an insert, an update and a delete, and leaves the database unchanged', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a')
    freezeManifest(f.input)
    const dump = (): string => JSON.stringify(['session', 'message', 'part', 'account'].map((table) => f.store.db.query(`SELECT * FROM ${table} ORDER BY id`).all()))
    const before = dump()

    const attempts = [
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_zz', 'ses_a', 1, 1, '{}')",
      "UPDATE message SET data = '{\"role\":\"user\"}'",
      'DELETE FROM part',
    ]
    // the reader's own connection: seen the first time it runs a query, after it was opened and configured
    const proto = Database.prototype as unknown as Record<string, unknown>
    const query = proto.query as (this: Database, ...args: unknown[]) => unknown
    const run = proto.run as (this: Database, sql: string) => unknown
    const connections = new Set<Database>()
    const outcomes: string[] = []
    proto.query = function (this: Database, ...args: unknown[]) {
      if (!connections.has(this)) {
        connections.add(this)
        for (const sql of attempts) {
          try {
            run.call(this, sql)
            outcomes.push('wrote')
          } catch {
            outcomes.push('refused')
          }
        }
      }
      return query.apply(this, args)
    }
    try {
      walkManifest(walkInput(f))
    } finally {
      proto.query = query
    }
    expect(connections.size).toBe(1)
    expect(outcomes).toEqual(['refused', 'refused', 'refused'])
    expect(dump()).toBe(before)
  })

  test('the manifest and an unsampled session text never carry the excluded root, a directory or a title', () => {
    const f = fixture()
    simpleSession(f.store, 'ses_a', '2026-01-15', { directory: '/work/app' })
    simpleSession(f.store, 'ses_x', '2026-01-15', { directory: `${EXCLUDED_ROOT}/sub` })
    freezeManifest(f.input)
    const text = readFileSync(manifestPath(f.privateRoot, 'initial'), 'utf8')
    expect(text).not.toContain('/work/app')
    expect(text).not.toContain(EXCLUDED_ROOT)
    expect(text).not.toContain('title ses_a')
    expect(projectRootHash(SAMPLE_SALT, EXCLUDED_ROOT)).toHaveLength(64)
  })
})
