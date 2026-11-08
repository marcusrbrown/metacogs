/** Real-world mode through the CLI and the campaign runner, on a fake host: the plumbing, not the harness (that is host.world.test.ts). */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CredentialLeakError, scanForLeaks } from '../../../runner/manifest'
import { main, mainAsync } from './cli'
import { WORLD_ARM_NAMES } from './gates'
import type { AttemptJob, HostResult } from './host'
import { type AttemptRecord, campaignDir, cellDir, runCampaign } from './run'
import { loadWorldFixture } from './scenario'
import type { FixtureSpec } from './store'
import { chatRequest, fakeExecutor, MODEL, textEvent, titleRequest } from './test-support'
import { userMessageParts } from './wire'
import { HINDSIGHT_NOTE, type WorldRecord } from './world'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SES = 'ses_a'
const FAKE_LOGIN = 'gho_FAKE0000000000000000000000000000000000'
const NEXT = 'AUTHOR_NEXT_TURN_SENTINEL'
const OUTCOME = 'EXPECTED_OUTCOME_SENTINEL'

function makeDb(): string {
  const path = join(tmp('replay-db-'), 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run("INSERT INTO session VALUES ('ses_a', NULL, 't', '/real/dir', 1)")
  const rows: [string, string, object[]][] = [
    ['msg_1', 'user', [{ type: 'text', text: 'please fix the build' }]],
    ['msg_2', 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'checking' }, { type: 'step-finish', reason: 'stop', cost: 0, tokens: {} }]],
    ['msg_3', 'user', [{ type: 'text', text: 'still failing' }]],
    ['msg_4', 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'trying again' }, { type: 'step-finish', reason: 'stop', cost: 0, tokens: {} }]],
    ['msg_5', 'user', [{ type: 'text', text: NEXT }]],
  ]
  rows.forEach(([id, role, parts], i) => {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?)', [id, SES, 10 + i, JSON.stringify({ role, time: { created: 10 + i } })])
    parts.forEach((p, k) => db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?)', [`prt_${id}_${k}`, id, SES, 10 + i, JSON.stringify(p)]))
  })
  db.close()
  return path
}

const fixture = (kind: FixtureSpec['kind'], id: string): FixtureSpec => ({
  id,
  kind,
  provenance: { project: 'systematic', source_session: SES, cutoff_message: 'msg_4', date: '2026-11-01' },
  expected_outcome_ref: OUTCOME,
  somewhere: kind === 'feel' ? 'in the gap between the test and the fix' : '',
  turns: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }],
})

function harness() {
  const state = tmp('replay-state-')
  const repoRoot = tmp('replay-repo-')
  const home = tmp('replay-home-')
  mkdirSync(join(home, 'src/github.com/marcusrbrown/systematic/.git'), { recursive: true })
  const out: string[] = []
  const err: string[] = []
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: { XDG_STATE_HOME: state }, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') }
  const store = join(state, 'metacogs', 'replay')
  const addFixture = (spec: FixtureSpec) => {
    const file = join(tmp('replay-spec-'), `${spec.id}.json`)
    writeFileSync(file, JSON.stringify(spec))
    expect(main(['build', file], io)).toBe(0)
    out.length = 0
  }
  return { io, out, err, store, home, db: makeDb(), addFixture, run: (...argv: string[]) => main(argv, io) }
}

describe('replay world specs | build | list', () => {
  test('specs and build print ids, counts and rules; nothing from the history or the private refs', () => {
    const h = harness()
    h.addFixture(fixture('feel', 'moment-a'))
    h.addFixture(fixture('drugs', 'moment-b'))
    expect(h.run('world', 'specs', '--db', h.db, '--fixtures', 'moment-a,moment-b')).toBe(0)
    expect(h.out).toEqual(['spec moment-a written author_next_turn=yes', 'spec moment-b written author_next_turn=yes'])
    expect(h.run('world', 'build', '--db', h.db, '--fixtures', 'moment-a')).toBe(0)
    const built = h.out.at(-1)!
    expect(built).toMatch(/^built moment-a window=all messages=4\/4 tokens≈\d+\/120000 dropped=0 parts=/)
    expect(h.run('world', 'list')).toBe(0)
    expect(h.out.slice(-2)).toEqual(['moment-a\tbuilt', 'moment-b\tspec-only'])
    const printed = [...h.out, ...h.err].join('\n')
    for (const secret of [NEXT, OUTCOME, 'please fix the build', 'trying again']) expect(printed).not.toContain(secret)
    expect(existsSync(join(h.store, 'world', 'moment-a', 'export.json'))).toBe(true)
  })

  test('a bad budget and an unknown world command are usage errors', () => {
    const h = harness()
    expect(h.run('world', 'build', '--budget', 'lots')).toBe(2)
    expect(h.run('world', 'frobnicate')).toBe(2)
    expect(h.run('world')).toBe(2)
  })
})

describe('campaign --world real', () => {
  function ready() {
    const h = harness()
    h.addFixture(fixture('feel', 'moment-a'))
    h.addFixture(fixture('drugs', 'moment-b'))
    h.run('world', 'specs', '--db', h.db, '--fixtures', 'moment-a,moment-b')
    h.run('world', 'build', '--db', h.db, '--fixtures', 'moment-a,moment-b')
    return h
  }
  const world: WorldRecord = { repo: 'marcusrbrown/systematic', commit: 'a'.repeat(40), rule: 'origin-main', gh: 'read', cutoff: '1970-01-01T00:00:00.010Z' }
  const seedTurns = ['please fix the build', 'still failing']

  /** Makes the healthy result look like a real-world one: the history's turns in the request, and the world the clone landed on. */
  const asWorld = (extra: Partial<HostResult> = {}) => (job: AttemptJob, result: HostResult): HostResult => {
    const last = userMessageParts(result.requests.at(-1)!.body as Record<string, unknown>).at(-1) ?? []
    return { ...result, requests: [titleRequest(), chatRequest({ model: job.model, history: seedTurns, last })], world, ...extra }
  }
  const worldHost = (over: { leak?: string } = {}) => fakeExecutor({ tweak: (job, result) => asWorld(over.leak ? { stdout: `${textEvent(over.leak)}${result.stdout}` } : {})(job, result) })

  test('runs the six arms over every built scenario, with the real history, the world job and the substance', async () => {
    const h = ready()
    const { executor, jobs } = fakeExecutor({ tweak: asWorld() })
    const code = await mainAsync(['campaign', '--world', 'real', '--name', 'real-a', '--models', MODEL, '--arms', 'all', '--fixtures', 'all', '--cap', '1'], { ...h.io, campaign: { executor, resolveGhAuth: () => ({ hosts: '', needles: [{ label: 'gh_token', value: FAKE_LOGIN }] }), home: h.home } })
    expect(h.err).toEqual([])
    expect(code).toBe(0)
    expect(h.out.some((l) => l.startsWith('campaign real-a (real world) cells=12'))).toBe(true)
    expect(jobs).toHaveLength(11) // moment-b has no somewhere phrase, so its feel-somewhere cell does not run
    // the default limit is 15 minutes, and the job carries the world and the real ids
    expect(new Set(jobs.map((j) => j.timeoutMs))).toEqual(new Set([900_000]))
    expect(jobs[0]!.world).toMatchObject({ githubRepo: 'marcusrbrown/systematic', cutoffMs: 13 })
    expect(jobs[0]!.seed.messages.map((m) => m.info.id)).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4'])
    const sent = (fx: string, arm: string) => jobs.find((j) => j.fixtureId === fx && j.arm === arm)!.message
    expect(sent('moment-a', 'drugs-substance')).toEqual({ kind: 'command', name: 'drugs', args: ['caffeine'] })
    expect(sent('moment-b', 'drugs-substance')).toEqual({ kind: 'command', name: 'drugs', args: ['psilocybin'] })
    expect(sent('moment-a', 'feel-somewhere')).toEqual({ kind: 'command', name: 'feel', args: ['in', 'the', 'gap', 'between', 'the', 'test', 'and', 'the', 'fix'] })
    expect(jobs.some((j) => j.fixtureId === 'moment-b' && j.arm === 'feel-somewhere')).toBe(false)
  })

  test('the attempt record has the world, the hindsight note and the history window; the private refs go nowhere', async () => {
    const h = ready()
    const { executor } = worldHost()
    await mainAsync(['campaign', '--world', 'real', '--name', 'real-a', '--models', MODEL, '--arms', 'continue-a,drugs-substance', '--fixtures', 'moment-a', '--cap', '1'], { ...h.io, campaign: { executor, resolveGhAuth: () => ({ hosts: '', needles: [] }), home: h.home } })
    const store = { root: join(h.store), repoRoot: h.io.repoRoot, now: h.io.now }
    const record = JSON.parse(readFileSync(join(cellDir(store, { campaign: 'real-a', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001', 'attempt.json'), 'utf8')) as AttemptRecord
    expect(record).toMatchObject({ status: 'completed', world, hindsight_note: HINDSIGHT_NOTE, history: { window: { rule: 'all', messages: 4, total_messages: 4, over_budget: false }, dropped: { total: 0 } } })
    const dir = campaignDir(store, 'real-a')
    const all = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8')).join('\n')
    for (const secret of [NEXT, OUTCOME]) expect(all).not.toContain(secret)
    expect(all).toContain('please fix the build') // the model-visible history is evidence, kept private under the state root
    expect(JSON.parse(readdirSync(dir).filter((f) => f.startsWith('run-')).map((f) => readFileSync(join(dir, f), 'utf8'))[0]!)).toMatchObject({ mode: 'real-world' })
  })

  test('the gh token never reaches an artifact: a clean attempt scans clean, a leaking one stops with labels only', async () => {
    const h = ready()
    const needles = [{ label: 'gh_token', value: FAKE_LOGIN }]
    const store = { root: h.store, repoRoot: h.io.repoRoot, now: h.io.now }
    const loadFixture = (id: string) => loadWorldFixture(store, id, { home: h.home })
    const base = { name: 'real-b', models: [MODEL], arms: ['continue-a' as const], fixtures: ['moment-a'], capUsd: 1, provider: 'scripted' as const, world: true }

    await runCampaign(base, { store, executor: worldHost().executor, needles, loadFixture })
    const dir = campaignDir(store, 'real-b')
    expect(scanForLeaks({ needles, manifestJson: '', artifacts: {}, dirs: [dir] })).toEqual([])

    await expect(runCampaign({ ...base, name: 'real-c' }, { store, executor: worldHost({ leak: `token ${FAKE_LOGIN}` }).executor, needles, loadFixture })).rejects.toBeInstanceOf(CredentialLeakError)
    const leaked = campaignDir(store, 'real-c')
    expect(scanForLeaks({ needles, manifestJson: '', artifacts: {}, dirs: [leaked] })).toEqual([])
    const files = readdirSync(leaked, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    expect(files).toEqual(['attempt.json'])
    expect(JSON.parse(readFileSync(join(leaked, 'moment-a', MODEL.replace('/', '__'), 'continue-a', 'a001', 'attempt.json'), 'utf8'))).toMatchObject({ status: 'error', reasons: ['credential_leak'], leak_labels: ['gh_token'] })
  })

  test('usage errors: a bad --world, a paraphrased-only arm, no built scenarios, a missing checkout, and no gh login', async () => {
    const h = ready()
    const { executor } = fakeExecutor()
    const run = (argv: string[], deps: object = {}) => mainAsync(argv, { ...h.io, campaign: { executor, resolveGhAuth: () => ({ hosts: '', needles: [] }), home: h.home, ...deps } })
    const base = ['campaign', '--name', 'real-z', '--models', MODEL, '--cap', '1']
    expect(await run([...base, '--world', 'fake', '--arms', 'all', '--fixtures', 'all'])).toBe(2)
    expect(await run([...base, '--world', 'real', '--arms', 'drugs-caffeine', '--fixtures', 'all'])).toBe(2)
    expect(await run([...base, '--world', 'real', '--arms', 'all', '--fixtures', 'all'], { resolveGhAuth: () => { throw new Error('no gh login') } })).toBe(2)
    expect(await run([...base, '--world', 'real', '--arms', 'all', '--fixtures', 'all'], { home: '/nonexistent' })).toBe(1)
    expect(h.err.join('\n')).toContain('not a git checkout')
    const empty = harness()
    expect(await mainAsync([...base, '--world', 'real', '--arms', 'all', '--fixtures', 'all'], { ...empty.io, campaign: { executor, home: empty.home, resolveGhAuth: () => ({ hosts: '', needles: [] }) } })).toBe(2)
  })

  test('without --world the paraphrased arms and loader are unchanged', async () => {
    const h = harness()
    const { executor } = fakeExecutor()
    const base = ['campaign', '--name', 'p', '--models', MODEL, '--fixtures', 'all', '--cap', '1']
    expect(await mainAsync([...base, '--arms', 'drugs-substance'], { ...h.io, campaign: { executor } })).toBe(2)
    expect(h.err.join('\n')).toContain('--arms takes all or')
    h.err.length = 0
    expect(await mainAsync([...base, '--arms', 'drugs-caffeine'], { ...h.io, campaign: { executor } })).toBe(2)
    expect(h.err.join('\n')).toContain('no frozen, approved fixtures')
  })
})

describe('the arms', () => {
  test('real-world mode has exactly the six approved arms', () => {
    expect([...WORLD_ARM_NAMES]).toEqual(['continue-a', 'continue-b', 'feel', 'feel-somewhere', 'drugs', 'drugs-substance'])
  })
})
