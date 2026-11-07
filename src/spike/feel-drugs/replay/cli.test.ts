import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from './cli'
import type { FixtureSpec } from './store'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function tmp(prefix = 'replay-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function harness() {
  const state = tmp()
  const repoRoot = tmp('replay-repo-')
  const out: string[] = []
  const err: string[] = []
  const run = (...argv: string[]) => main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { XDG_STATE_HOME: state }, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') })
  return { run, out, err, state, repoRoot, store: join(state, 'metacogs', 'replay') }
}

const PRIVATE = 'PRIVATE-MESSAGE-CONTENT'
function makeDb(): string {
  const dir = tmp('replay-db-')
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run("INSERT INTO session VALUES ('ses_a', NULL, 'a title', '/work', 1)")
  for (let i = 0; i < 4; i++) {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?)', [`msg_${i}`, 'ses_a', 10 + i, '{"role":"user"}'])
    db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?)', [`prt_${i}`, `msg_${i}`, 'ses_a', 10 + i, JSON.stringify({ type: 'text', text: PRIVATE })])
  }
  db.close()
  return path
}

const spec = (over: Partial<FixtureSpec> = {}): FixtureSpec => ({
  id: 'moment-a',
  kind: 'drugs',
  provenance: { project: 'project-a', source_session: 'ses_a', cutoff_message: 'msg_3', date: '2026-11-01' },
  expected_outcome_ref: 'Resolved by pinning the dependency.',
  somewhere: 'in the gap between the test and the fix',
  turns: [
    { role: 'user', text: PRIVATE },
    { role: 'assistant', text: 'Looking.' },
  ],
  ...over,
})
function writeSpec(s: FixtureSpec): string {
  const path = join(tmp('replay-spec-'), `${s.id}.json`)
  writeFileSync(path, JSON.stringify(s))
  return path
}

describe('replay cli', () => {
  test('extract stores the raw window under the private root and prints counts only', () => {
    const h = harness()
    expect(h.run('extract', '--db', makeDb(), '--session', 'ses_a', '--cutoff', 'msg_2', '--window', '2', '--out', 'raw-a')).toBe(0)
    const printed = [...h.out, ...h.err].join('\n')
    expect(printed).toContain('raw-a')
    expect(printed).toMatch(/messages=2/)
    expect(printed).toMatch(/parts=2/)
    expect(printed).toMatch(/total=3/)
    expect(printed).not.toContain(PRIVATE)
    expect(statSync(join(h.store, 'raw', 'raw-a.json')).mode & 0o777).toBe(0o600)
  })

  test('extract refuses a second write to the same raw name, and a missing cutoff', () => {
    const h = harness()
    const db = makeDb()
    expect(h.run('extract', '--db', db, '--session', 'ses_a', '--cutoff', 'msg_2', '--out', 'raw-a')).toBe(0)
    expect(h.run('extract', '--db', db, '--session', 'ses_a', '--cutoff', 'msg_2', '--out', 'raw-a')).toBe(1)
    expect(h.run('extract', '--db', db, '--session', 'ses_a', '--cutoff', 'msg_nope', '--out', 'raw-b')).toBe(1)
    expect([...h.out, ...h.err].join('\n')).not.toContain(PRIVATE)
  })

  test('build, freeze, approve and list run a fixture to frozen without printing its text', () => {
    const h = harness()
    const file = writeSpec(spec())
    expect(h.run('build', file)).toBe(0)
    expect(h.run('list')).toBe(0)
    expect(h.out.at(-1)).toBe('moment-a\tdrugs\tdraft\tunapproved')
    expect(h.run('freeze', 'moment-a')).toBe(0)
    expect(h.run('approve', 'moment-a')).toBe(0)
    expect(h.run('list')).toBe(0)
    expect(h.out.at(-1)).toBe('moment-a\tdrugs\tfrozen\tapproved')
    expect([...h.out, ...h.err].join('\n')).not.toContain(PRIVATE)
  })

  test('freeze reports the rule for a dirty fixture, exits 1, and leaves it draft', () => {
    const h = harness()
    const token = `ghp_${'A1'.repeat(18)}`
    expect(h.run('build', writeSpec(spec({ turns: [{ role: 'user', text: `key ${token}` }, { role: 'assistant', text: 'ok' }] })))).toBe(0)
    expect(h.run('freeze', 'moment-a')).toBe(1)
    const printed = [...h.out, ...h.err].join('\n')
    expect(printed).toContain('github-token')
    expect(printed).not.toContain(token)
    h.run('list')
    expect(h.out.at(-1)).toBe('moment-a\tdrugs\tdraft\tunapproved')
  })

  test('an excluded spec builds as excluded and cannot freeze', () => {
    const h = harness()
    expect(h.run('build', writeSpec(spec({ excluded: { reason: 'child session' } })))).toBe(0)
    expect(h.out.at(-1)).toContain('excluded')
    expect(h.run('freeze', 'moment-a')).toBe(1)
  })

  test('a spec file inside the repo is a custody error, and a bad spec names the field not the value', () => {
    const h = harness()
    const inside = join(h.repoRoot, 'spec.json')
    writeFileSync(inside, JSON.stringify(spec()))
    expect(h.run('build', inside)).toBe(1)
    expect(h.err.join('\n')).toContain('CustodyError')
    expect(existsSync(join(h.store, 'fixtures', 'moment-a'))).toBe(false)
    h.err.length = 0
    expect(h.run('build', writeSpec(spec({ kind: 'PRIVATE-KIND' as never })))).toBe(1)
    expect(h.err.join('\n')).toContain('kind')
    expect(h.err.join('\n')).not.toContain('PRIVATE-KIND')
  })

  test('a store root inside the repo exits 1 before anything is created', () => {
    const state = tmp()
    const repoRoot = join(state, 'metacogs')
    mkdirSync(repoRoot)
    const err: string[] = []
    expect(main(['list'], { out: () => {}, err: (l) => err.push(l), env: { XDG_STATE_HOME: state }, repoRoot })).toBe(1)
    expect(err.join('\n')).toContain('CustodyError')
    expect(existsSync(join(repoRoot, 'replay'))).toBe(false)
  })

  test('usage errors exit 2', () => {
    const h = harness()
    expect(h.run()).toBe(2)
    expect(h.run('nope')).toBe(2)
    expect(h.run('extract', '--db', 'x')).toBe(2)
    expect(h.run('extract', '--db', 'x', '--session', 's', '--cutoff', 'c', '--out', 'o', '--window', 'many')).toBe(2)
    expect(h.run('freeze')).toBe(2)
    expect(h.run('build')).toBe(2)
  })
})
