/** Read-only extraction of one session window from the OpenCode session DB, allowlisted tables and columns only. */
import { Database } from 'bun:sqlite'

export interface RawSession {
  id: string
  parent_id: string | null
  title: string
  directory: string
  time_created: number
}
export interface RawMessage {
  id: string
  session_id: string
  time_created: number
  /** JSON text exactly as stored. */
  data: string
}
export interface RawPart {
  id: string
  message_id: string
  session_id: string
  time_created: number
  /** JSON text exactly as stored. */
  data: string
}

export interface RawExtract {
  schema_version: 1
  session: RawSession
  cutoff: string
  /** The window size asked for; null means the whole history up to the cutoff. */
  window: number | null
  /** Messages in the session up to and including the cutoff, before any window. */
  total_messages: number
  /** In stored order. With a window: the last N, plus every message holding a compaction part. */
  messages: RawMessage[]
  /** Parts of the returned messages, in stored order. */
  parts: RawPart[]
  /** Returned messages that hold a compaction part. */
  compaction_message_ids: string[]
}

/** Up to and including the cutoff, by the host's own order (time, then id). Takes `t, t, id`. */
const UP_TO_CUTOFF = '(time_created < ? OR (time_created = ? AND id <= ?))'

/** Every statement this module runs. Each names its columns; none touches another table. */
export const EXTRACT_SQL = {
  session: 'SELECT id, parent_id, title, directory, time_created FROM session WHERE id = ?',
  cutoff: 'SELECT time_created FROM message WHERE id = ? AND session_id = ?',
  count: `SELECT count(*) AS n FROM message WHERE session_id = ? AND ${UP_TO_CUTOFF}`,
  messages: `SELECT id, session_id, time_created, data FROM message WHERE session_id = ? AND ${UP_TO_CUTOFF} ORDER BY time_created DESC, id DESC LIMIT ?`,
  compaction: `SELECT DISTINCT message_id FROM part WHERE session_id = ? AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') END = 'compaction' AND message_id IN (SELECT id FROM message WHERE session_id = ? AND ${UP_TO_CUTOFF})`,
  message: 'SELECT id, session_id, time_created, data FROM message WHERE id = ? AND session_id = ?',
  parts: 'SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id',
} as const

export interface ExtractOptions {
  db: string
  session: string
  cutoff: string
  /** Keep only the last N messages (plus compaction holders). Absent: everything up to the cutoff. */
  window?: number
}

const byStoredOrder = (a: RawMessage, b: RawMessage) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Opens read-only (no write to the file, WAL-safe) and enforces it with `query_only` as well. */
export function extractSession(options: ExtractOptions): RawExtract {
  const { window } = options
  if (window !== undefined && (!Number.isInteger(window) || window < 1)) throw new Error(`window must be a positive integer, got ${window}`)
  const db = new Database(options.db, { readonly: true })
  try {
    db.run('PRAGMA query_only = ON')
    const session = db.query<RawSession, [string]>(EXTRACT_SQL.session).get(options.session)
    if (!session) throw new Error(`session ${options.session} not found`)
    const at = db.query<{ time_created: number }, [string, string]>(EXTRACT_SQL.cutoff).get(options.cutoff, options.session)
    if (!at) throw new Error(`cutoff message ${options.cutoff} not found in session ${options.session}`)
    const bound = [options.session, at.time_created, at.time_created, options.cutoff] as const

    const total = db.query<{ n: number }, [string, number, number, string]>(EXTRACT_SQL.count).get(...bound)!.n
    const kept = db.query<RawMessage, [string, number, number, string, number]>(EXTRACT_SQL.messages).all(...bound, window ?? -1)
    const have = new Set(kept.map((m) => m.id))
    const compactionIds = db.query<{ message_id: string }, [string, string, number, number, string]>(EXTRACT_SQL.compaction).all(options.session, ...bound).map((r) => r.message_id)
    for (const id of compactionIds) {
      if (have.has(id)) continue
      kept.push(db.query<RawMessage, [string, string]>(EXTRACT_SQL.message).get(id, options.session)!)
    }
    const messages = kept.sort(byStoredOrder)
    const partsOf = db.query<RawPart, [string, string]>(EXTRACT_SQL.parts)
    return {
      schema_version: 1,
      session,
      cutoff: options.cutoff,
      window: window ?? null,
      total_messages: total,
      messages,
      parts: messages.flatMap((m) => partsOf.all(options.session, m.id)),
      compaction_message_ids: messages.filter((m) => compactionIds.includes(m.id)).map((m) => m.id),
    }
  } finally {
    db.close()
  }
}
