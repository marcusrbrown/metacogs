import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractSession } from './extract'
import { assertEndsAtCutoff, buildRealExport, HISTORY_TOKEN_BUDGET, HistoryError, mapRow, partChars, tokensOfChars } from './history'
import { buildExport } from './store'
import { SYNTHETIC_SPEC } from './test-support'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

const SES = 'ses_real'
interface Row {
  id: string
  data: object
  parts: object[]
}

/** A session DB (extra tables included) holding the rows in order, one millisecond apart. */
function makeSession(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-history-'))
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?)', [SES, null, 'real title', '/real/dir', 1000])
  rows.forEach((row, i) => {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?)', [row.id, SES, 1000 + i, JSON.stringify(row.data)])
    row.parts.forEach((part, k) => db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?)', [`prt_${row.id}_${k}`, row.id, SES, 1000 + i, JSON.stringify(part)]))
  })
  db.close()
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return path
}

const user = (n: number, text: string, extra: object[] = []): Row => ({ id: `msg_${String(n).padStart(3, '0')}`, data: { role: 'user', time: { created: n }, agent: 'build', model: { providerID: 'anthropic', modelID: 'm' } }, parts: [{ type: 'text', text }, ...extra] })
const assistant = (n: number, text: string, extra: object[] = []): Row => ({
  id: `msg_${String(n).padStart(3, '0')}`,
  data: { role: 'assistant', parentID: 'msg_000', time: { created: n, completed: n + 1 }, agent: 'build', modelID: 'm', providerID: 'anthropic', mode: 'build', path: { cwd: '/real/dir', root: '/real/dir' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' },
  parts: [{ type: 'step-start' }, ...extra, { type: 'text', text }, { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
})
const toolPart = (output: string) => ({ type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: 'a.ts' }, output, title: 'read', metadata: {}, time: { start: 1, end: 2 } }, metadata: { anthropic: { x: 1 } } })

const sized = (n: number) => 'x'.repeat(n)

/** Pairs 0..pairs-1, then the cutoff assistant, then the author's next turn and a later reply. */
function session(pairs: number, size = 400): { path: string; cutoff: string } {
  const rows: Row[] = []
  for (let i = 0; i < pairs; i++) {
    rows.push(user(i * 2, `human turn ${i}`), assistant(i * 2 + 1, `reply ${i}`, [toolPart(sized(size))]))
  }
  const cutoff = rows.at(-1)!.id
  rows.push(user(pairs * 2, 'AUTHOR_NEXT_TURN_SENTINEL'), assistant(pairs * 2 + 1, 'LATER_REPLY_SENTINEL', [toolPart('LATER_TOOL_SENTINEL')]))
  return { path: makeSession(rows), cutoff }
}

describe('the row mapping', () => {
  test('message data plus the row ids is the export info; parts keep tool calls and results as they are', () => {
    const { path, cutoff } = session(2)
    const raw = extractSession({ db: path, session: SES, cutoff })
    const history = buildRealExport(raw, { scenario: 'moment-real' })
    const msg = history.export.messages[1]! as unknown as { info: Record<string, unknown>; parts: Record<string, unknown>[] }
    expect(msg.info).toMatchObject({ id: 'msg_001', sessionID: SES, role: 'assistant', parentID: 'msg_000', finish: 'stop' })
    const tool = msg.parts.find((p) => p.type === 'tool')!
    expect(tool).toMatchObject({ id: 'prt_msg_001_1', sessionID: SES, messageID: 'msg_001', tool: 'read', callID: 'call_1', state: { status: 'completed', output: sized(400) }, metadata: { anthropic: { x: 1 } } })
  })

  test('mapRow tells a message row from a part row and returns null for unreadable JSON', () => {
    expect(mapRow({ id: 'm', session_id: 's', time_created: 1, data: '{"role":"user"}' })).toEqual({ role: 'user', id: 'm', sessionID: 's' })
    expect(mapRow({ id: 'p', message_id: 'm', session_id: 's', time_created: 1, data: '{"type":"text"}' })).toEqual({ type: 'text', id: 'p', sessionID: 's', messageID: 'm' })
    expect(mapRow({ id: 'm', session_id: 's', time_created: 1, data: 'nope' })).toBeNull()
  })

  test('the session info has the fields of the paraphrased export, with the real session id and the given directory', () => {
    const { path, cutoff } = session(1)
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff }), { scenario: 'moment-real', directory: '/clone' })
    expect(Object.keys(history.export.info).sort()).toEqual(Object.keys(buildExport(SYNTHETIC_SPEC).info).sort())
    expect(history.export.info).toMatchObject({ id: SES, directory: '/clone', title: 'Replay moment-real', agent: 'orchestrator' })
    expect(history.export.info.permission.map((p) => p.permission)).toEqual(['question', 'plan_enter', 'plan_exit'])
    expect(history.original_directory).toBe('/real/dir')
  })
})

describe('the cut at the cutoff', () => {
  test('the export ends exactly at the cutoff; the author next turn and anything after it never appear', () => {
    const { path, cutoff } = session(3)
    const raw = extractSession({ db: path, session: SES, cutoff })
    const history = buildRealExport(raw, { scenario: 'moment-real' })
    expect(history.export.messages.at(-1)!.info.id).toBe(cutoff)
    expect(history.cutoff.message).toBe(cutoff)
    const text = JSON.stringify(history)
    for (const sentinel of ['AUTHOR_NEXT_TURN_SENTINEL', 'LATER_REPLY_SENTINEL', 'LATER_TOOL_SENTINEL']) expect(text).not.toContain(sentinel)
    expect(() => assertEndsAtCutoff(history.export, cutoff)).not.toThrow()
  })

  test('a cutoff that is not the last message, or not an assistant message, is refused', () => {
    const { path } = session(3)
    // the user message before the author's turn: an extract ending on it is a user cutoff
    expect(() => buildRealExport(extractSession({ db: path, session: SES, cutoff: 'msg_006' }), { scenario: 's' })).toThrow(HistoryError)
    const raw = extractSession({ db: path, session: SES, cutoff: 'msg_005' })
    expect(() => buildRealExport({ ...raw, cutoff: 'msg_003' }, { scenario: 's' })).toThrow(/last message/)
    expect(() => assertEndsAtCutoff(buildRealExport(raw, { scenario: 's' }).export, 'msg_003')).toThrow(HistoryError)
  })
})

describe('the window', () => {
  test('a history under the budget is kept whole', () => {
    const { path, cutoff } = session(3)
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff }), { scenario: 's' })
    expect(history.window).toMatchObject({ rule: 'all', messages: 6, first_message: 'msg_000', total_messages: 6, over_budget: false, budget: HISTORY_TOKEN_BUDGET })
  })

  test('without a compaction, the last N messages that fit the budget, starting on a user message', () => {
    const { path, cutoff } = session(40, 4_000) // about 1000 tokens a pair
    const budget = 10_000
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff }), { scenario: 's', budget })
    expect(history.window.rule).toBe('last_n')
    expect(history.window.token_estimate).toBeLessThanOrEqual(budget)
    expect(history.window.token_estimate).toBeGreaterThan(budget * 0.6)
    expect(history.window.messages).toBeLessThan(80)
    expect(history.window.total_messages).toBe(80)
    expect(history.export.messages[0]!.info.role).toBe('user')
    expect(history.export.messages).toHaveLength(history.window.messages)
    expect(history.window.first_message).toBe(history.export.messages[0]!.info.id)
  })

  test('the default budget keeps a real-size history under 120k tokens', () => {
    const { path, cutoff } = session(60, 20_000) // about 5000 tokens a pair
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff }), { scenario: 's' })
    expect(history.window.token_estimate).toBeLessThanOrEqual(120_000)
    expect(history.window.rule).toBe('last_n')
  })

  test('the window starts at the latest compaction message when it fits', () => {
    const rows: Row[] = []
    for (let i = 0; i < 10; i++) rows.push(user(i * 2, `turn ${i}`, i === 3 || i === 6 ? [{ type: 'compaction', auto: true }] : []), assistant(i * 2 + 1, `reply ${i}`, [toolPart(sized(2_000))]))
    const path = makeSession(rows)
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff: rows.at(-1)!.id }), { scenario: 's', budget: 100_000 })
    expect(history.window).toMatchObject({ rule: 'compaction', first_message: 'msg_012', messages: 8, compaction_message: 'msg_012' })
  })

  test('a latest compaction that does not fit the budget falls back to the last N', () => {
    const rows: Row[] = []
    for (let i = 0; i < 10; i++) rows.push(user(i * 2, `turn ${i}`, i === 2 ? [{ type: 'compaction', auto: true }] : []), assistant(i * 2 + 1, `reply ${i}`, [toolPart(sized(8_000))]))
    const path = makeSession(rows)
    const history = buildRealExport(extractSession({ db: path, session: SES, cutoff: rows.at(-1)!.id }), { scenario: 's', budget: 5_000 })
    expect(history.window.rule).toBe('compaction_over_budget')
    expect(history.window.first_message).not.toBe('msg_004')
    expect(history.window.compaction_message).toBeNull()
  })

  test('one message bigger than the whole budget still goes in, and is flagged', () => {
    const rows = [user(0, 'ask'), assistant(1, 'reply', [toolPart(sized(40_000))])]
    const history = buildRealExport(extractSession({ db: makeSession(rows), session: SES, cutoff: 'msg_001' }), { scenario: 's', budget: 1_000 })
    expect(history.window).toMatchObject({ messages: 2, over_budget: true })
    expect(history.export.messages.at(-1)!.info.id).toBe('msg_001')
  })

  test('the estimate counts what the model sees: text, reasoning, tool input and output, not metadata', () => {
    expect(partChars({ type: 'text', text: 'abcd' })).toBe(20)
    expect(partChars({ type: 'tool', tool: 'read', state: { input: { a: 1 }, output: 'xx', metadata: { huge: sized(1_000) } } })).toBe(16 + 4 + 7 + 2)
    expect(partChars({ type: 'file', mime: 'image/png', url: `data:image/png;base64,${sized(900_000)}` })).toBe(4_016)
    expect(tokensOfChars(9)).toBe(3)
  })

  test('the seed turns are the last human-typed user texts of the window', () => {
    const rows: Row[] = [user(0, 'first ask'), assistant(1, 'a'), user(2, '<system-reminder>machine</system-reminder>'), assistant(3, 'b'), user(4, 'second ask'), assistant(5, 'c'), user(6, 'third ask'), assistant(7, 'd'), user(8, 'fourth ask'), assistant(9, 'e')]
    const history = buildRealExport(extractSession({ db: makeSession(rows), session: SES, cutoff: 'msg_009' }), { scenario: 's' })
    expect(history.seed_user_turns).toEqual(['second ask', 'third ask', 'fourth ask'])
  })
})

describe('parts the importer would reject', () => {
  test('unknown and malformed parts are dropped and counted per type; known parts and part types stay', () => {
    const rows = [
      user(0, 'ask', [{ type: 'hologram', x: 1 }]),
      assistant(1, 'reply', [{ type: 'tool', tool: 'bash' }, { type: 'reasoning' }, { type: 'hologram' }, { type: 'patch', hash: 'h', files: ['a'] }, { type: 'file', mime: 'm' }]),
    ]
    const history = buildRealExport(extractSession({ db: makeSession(rows), session: SES, cutoff: 'msg_001' }), { scenario: 's' })
    expect(history.dropped).toEqual({ total: 5, by_type: { hologram: 2, 'tool:malformed': 1, 'reasoning:malformed': 1, 'file:malformed': 1 } })
    expect(history.part_types).toEqual({ text: 2, 'step-start': 1, 'step-finish': 1, patch: 1 })
  })
})
