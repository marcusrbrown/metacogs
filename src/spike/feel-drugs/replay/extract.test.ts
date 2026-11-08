import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXTRACT_SQL, extractSession, nextHumanTurn } from './extract'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

/** Tables beyond the allowlist carry sentinel values that must never come back. */
function makeDb(opts: { wal?: boolean } = {}): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'replay-extract-'))
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  if (opts.wal) db.run('PRAGMA journal_mode = WAL')
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, permission TEXT, share_url TEXT, time_created INTEGER, time_updated INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.run('CREATE TABLE account (id TEXT, access_token TEXT)')
  db.run('CREATE TABLE control_account (id TEXT, secret TEXT)')
  db.run("INSERT INTO account VALUES ('a1', 'SENTINEL_ACCOUNT')")
  db.run("INSERT INTO control_account VALUES ('c1', 'SENTINEL_CONTROL')")
  cleanup.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { path, db }
}

function seed(db: Database, session: string, n: number, extra: { compactionAt?: number } = {}): string[] {
  db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [session, 'proj', null, 'slug', '/work', `title ${session}`, 'SENTINEL_PERMISSION', 'SENTINEL_SHARE', 1000, 2000])
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `msg_${session}_${String(i).padStart(3, '0')}`
    ids.push(id)
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [id, session, 1000 + i, 9999, JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', n: i })])
    db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [`prt_${session}_${i}_b`, id, session, 1000 + i, 9999, JSON.stringify({ type: 'text', text: `${session} text ${i} b` })])
    db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [`prt_${session}_${i}_a`, id, session, 1000 + i, 9999, JSON.stringify({ type: extra.compactionAt === i ? 'compaction' : 'text', text: `${session} text ${i} a` })])
  }
  return ids
}

describe('extractSession', () => {
  test('returns only the target session up to the cutoff, in order, with allowlisted columns', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 6)
    seed(db, 'ses_two', 6)
    const raw = extractSession({ db: path, session: 'ses_one', cutoff: ids[3]! })
    expect(raw.messages.map((m) => m.id)).toEqual(ids.slice(0, 4))
    expect(raw.total_messages).toBe(4)
    expect(raw.window).toBeNull()
    expect(raw.parts.every((p) => p.session_id === 'ses_one')).toBe(true)
    expect(raw.parts.map((p) => p.id)).toEqual(ids.slice(0, 4).flatMap((_, i) => [`prt_ses_one_${i}_a`, `prt_ses_one_${i}_b`]))
    expect(Object.keys(raw.session).sort()).toEqual(['directory', 'id', 'parent_id', 'time_created', 'title'])
    expect(Object.keys(raw.messages[0]!).sort()).toEqual(['data', 'id', 'session_id', 'time_created'])
    expect(Object.keys(raw.parts[0]!).sort()).toEqual(['data', 'id', 'message_id', 'session_id', 'time_created'])
    expect(JSON.stringify(raw)).not.toMatch(/SENTINEL/)
  })

  test('a window keeps the last N messages up to the cutoff, plus any message holding a compaction part', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 10, { compactionAt: 1 })
    const raw = extractSession({ db: path, session: 'ses_one', cutoff: ids[7]!, window: 3 })
    expect(raw.messages.map((m) => m.id)).toEqual([ids[1]!, ids[5]!, ids[6]!, ids[7]!])
    expect(raw.compaction_message_ids).toEqual([ids[1]!])
    expect(raw.total_messages).toBe(8)
    expect(raw.window).toBe(3)
    expect(new Set(raw.parts.map((p) => p.message_id))).toEqual(new Set(raw.messages.map((m) => m.id)))
  })

  test('a window larger than the history returns the whole history', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 4)
    const raw = extractSession({ db: path, session: 'ses_one', cutoff: ids[3]!, window: 500 })
    expect(raw.messages.map((m) => m.id)).toEqual(ids)
  })

  test('a cutoff that does not exist in the session throws, even if another session has it', () => {
    const { path, db } = makeDb()
    seed(db, 'ses_one', 3)
    const other = seed(db, 'ses_two', 3)
    expect(() => extractSession({ db: path, session: 'ses_one', cutoff: 'msg_nope' })).toThrow(/cutoff/)
    expect(() => extractSession({ db: path, session: 'ses_one', cutoff: other[1]! })).toThrow(/cutoff/)
  })

  test('an unknown session throws', () => {
    const { path, db } = makeDb()
    seed(db, 'ses_one', 3)
    expect(() => extractSession({ db: path, session: 'ses_missing', cutoff: 'msg_x' })).toThrow(/session/)
  })

  test('a bad window throws', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 3)
    expect(() => extractSession({ db: path, session: 'ses_one', cutoff: ids[2]!, window: 0 })).toThrow(/window/)
    expect(() => extractSession({ db: path, session: 'ses_one', cutoff: ids[2]!, window: 1.5 })).toThrow(/window/)
  })

  test('a WAL-mode DB with an open writer is readable, and the database file is not modified', async () => {
    const { path, db } = makeDb({ wal: true })
    const ids = seed(db, 'ses_one', 5)
    // Keep the writer open with an uncheckpointed row only the WAL holds.
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', ['msg_ses_one_999', 'ses_one', 5000, 0, '{"role":"user"}'])
    const before = statSync(path)
    await Bun.sleep(20)
    const raw = extractSession({ db: path, session: 'ses_one', cutoff: 'msg_ses_one_999' })
    expect(raw.messages.map((m) => m.id)).toEqual([...ids, 'msg_ses_one_999'])
    const after = statSync(path)
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size])
    // The writer still works afterwards: the reader left no lock behind.
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', ['msg_ses_one_1000', 'ses_one', 5001, 0, '{}'])
  })

  test('the connection is read-only: nothing in the module can write', () => {
    const { path } = makeDb()
    expect(() => new Database(path, { readonly: true }).run("INSERT INTO account VALUES ('x', 'y')")).toThrow()
  })
})

describe('extraction SQL', () => {
  test('never names a credential, account, share or permission table', () => {
    const forbidden = /\b(account|control_account|credential|credentials|session_share|permission)\b/i
    for (const [name, sql] of Object.entries(EXTRACT_SQL)) {
      expect({ name, hit: forbidden.exec(sql)?.[0] ?? null }).toEqual({ name, hit: null })
    }
  })

  test('selects only the allowlisted columns from session, message and part', () => {
    expect(EXTRACT_SQL.session).toMatch(/^SELECT id, parent_id, title, directory, time_created FROM session\b/)
    expect(EXTRACT_SQL.cutoff).toMatch(/FROM message\b/)
    expect(EXTRACT_SQL.messages).toMatch(/^SELECT id, session_id, time_created, data FROM message\b/)
    expect(EXTRACT_SQL.parts).toMatch(/^SELECT id, message_id, session_id, time_created, data FROM part\b/)
    for (const sql of Object.values(EXTRACT_SQL)) expect(sql).not.toMatch(/SELECT\s+\*|\.\*/i)
  })
})

describe('nextHumanTurn', () => {
  const add = (db: Database, session: string, id: string, t: number, role: string, texts: string[]) => {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [id, session, t, 0, JSON.stringify({ role })])
    texts.forEach((text, i) => db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [`prt_${id}_${i}`, id, session, t, 0, JSON.stringify(text.startsWith('{') ? JSON.parse(text) : { type: 'text', text })]))
  }

  test('returns the first user message after the cutoff whose first text part is not machine-made', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 4)
    add(db, 'ses_one', 'msg_x1', 2000, 'assistant', ['assistant reply'])
    add(db, 'ses_one', 'msg_x2', 2001, 'user', ['<system-reminder>machine</system-reminder>'])
    add(db, 'ses_one', 'msg_x3', 2002, 'user', ['{"type":"file","mime":"x","url":"u"}'])
    add(db, 'ses_one', 'msg_x4', 2003, 'user', ['what next?', 'second part'])
    add(db, 'ses_one', 'msg_x5', 2004, 'user', ['later turn'])
    expect(nextHumanTurn({ db: path, session: 'ses_one', cutoff: ids[3]! })).toBe('what next?')
  })

  test('is null when no human turn follows, and never looks at another session or at the cutoff itself', () => {
    const { path, db } = makeDb()
    const ids = seed(db, 'ses_one', 4)
    seed(db, 'ses_two', 6)
    add(db, 'ses_two', 'msg_y1', 5000, 'user', ['other session'])
    expect(nextHumanTurn({ db: path, session: 'ses_one', cutoff: ids[3]! })).toBeNull()
    expect(() => nextHumanTurn({ db: path, session: 'ses_one', cutoff: 'msg_nope' })).toThrow(/cutoff/)
  })
})
