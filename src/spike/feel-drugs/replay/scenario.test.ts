import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { armMessage } from './gates'
import { buildWorldScenario, defaultSubstance, generateWorldSpecs, listWorldScenarios, loadWorldFixture, parseWorldSpec, readWorldSpec, WORLD_SCENARIOS, worldDir, worldSpecFromFixture } from './scenario'
import { buildFixture, type FixtureSpec, SpecError } from './store'
import { type Lab, newLab, SYNTHETIC_SPEC } from './test-support'

const labs: Lab[] = []
const dirs: string[] = []
afterEach(() => {
  for (const lab of labs.splice(0)) lab.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SES = 'ses_source'
const CUTOFF = 'msg_004'

/** A session DB: user, assistant, user, assistant (the cutoff), then the author's next turn and a reply. */
function makeDb(next: string | null = 'AUTHOR_NEXT_TURN_SENTINEL'): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-scenario-'))
  dirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?)', [SES, null, 't', '/real/dir', 1])
  const rows: [string, string, object[]][] = [
    ['msg_001', 'user', [{ type: 'text', text: 'please fix the build' }]],
    ['msg_002', 'assistant', [{ type: 'step-start' }, { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'git status' }, output: 'On branch feat/real\nclean', time: { start: 1, end: 2 } } }, { type: 'text', text: 'checking' }, { type: 'step-finish', reason: 'stop', cost: 0, tokens: {} }]],
    ['msg_003', 'user', [{ type: 'text', text: 'still failing' }]],
    [CUTOFF, 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'trying again' }, { type: 'step-finish', reason: 'stop', cost: 0, tokens: {} }]],
    ...(next === null ? [] : ([['msg_005', 'user', [{ type: 'text', text: next }]], ['msg_006', 'assistant', [{ type: 'text', text: 'LATER_REPLY_SENTINEL' }]]] as [string, string, object[]][])),
  ]
  rows.forEach(([id, role, parts], i) => {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?)', [id, SES, 100 + i, JSON.stringify({ role, time: { created: 100 + i } })])
    parts.forEach((p, k) => db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?)', [`prt_${id}_${k}`, id, SES, 100 + i, JSON.stringify(p)]))
  })
  db.close()
  return path
}

const fixtureSpec = (over: Partial<FixtureSpec> = {}): FixtureSpec => ({ ...SYNTHETIC_SPEC, provenance: { project: 'systematic', source_session: SES, cutoff_message: CUTOFF, date: '2026-11-01' }, ...over })

function lab(): Lab {
  const l = newLab()
  labs.push(l)
  return l
}

describe('the world spec', () => {
  test('substance defaults by kind and is a field', () => {
    const base = { id: 'a', kind: 'feel', project: 'systematic', source_session: 's', cutoff_message: 'm', somewhere: '', expected_outcome_ref: 'x' }
    expect(parseWorldSpec(base).substance).toBe('caffeine')
    expect(parseWorldSpec({ ...base, kind: 'drugs' }).substance).toBe('psilocybin')
    expect(parseWorldSpec({ ...base, kind: 'ordinary' }).substance).toBe('caffeine')
    expect(parseWorldSpec({ ...base, substance: 'melatonin' }).substance).toBe('melatonin')
    expect(defaultSubstance('drugs')).toBe('psilocybin')
  })

  test('refuses unknown fields, several-word substances and bad ids, naming the field and not the value', () => {
    const base = { id: 'a', kind: 'feel', project: 'p', source_session: 's', cutoff_message: 'm', somewhere: '', expected_outcome_ref: 'x' }
    expect(() => parseWorldSpec({ ...base, turns: [] })).toThrow(/spec\.turns: expected no such field/)
    expect(() => parseWorldSpec({ ...base, substance: 'two words' })).toThrow(/spec\.substance/)
    expect(() => parseWorldSpec({ ...base, id: 'Bad_Id' })).toThrow(/spec\.id/)
    try {
      parseWorldSpec({ ...base, substance: 'two SECRET words' })
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET')
    }
  })

  test('the drugs-substance arm sends the spec substance, or the kind default', () => {
    expect(armMessage('drugs-substance', { somewhere: '', substance: 'melatonin' })).toEqual({ kind: 'command', name: 'drugs', args: ['melatonin'] })
    expect(armMessage('drugs-substance', { somewhere: '', kind: 'drugs' })).toEqual({ kind: 'command', name: 'drugs', args: ['psilocybin'] })
    expect(armMessage('drugs-substance', { somewhere: '', kind: 'feel' })).toEqual({ kind: 'command', name: 'drugs', args: ['caffeine'] })
  })

  test('the eleven approved scenarios are the eight feel and drugs fixtures and three ordinary ones', () => {
    expect(WORLD_SCENARIOS).toHaveLength(11)
    expect(WORLD_SCENARIOS.filter((id) => id.startsWith('ord-'))).toEqual(['ord-sys-46', 'ord-sys-20', 'ord-fro-130'])
  })
})

describe('generating specs from the existing fixtures', () => {
  test('provenance, somewhere and outcome come from the fixture spec; the author next turn comes from the DB', () => {
    const { store } = lab()
    buildFixture(store, fixtureSpec({ id: 'moment-a', kind: 'feel', somewhere: 'in the gap', expected_outcome_ref: 'it was fixed' }))
    const [r] = generateWorldSpecs(store, { db: makeDb(), ids: ['moment-a'] })
    expect(r).toEqual({ id: 'moment-a', status: 'written', has_author_next_turn: true })
    expect(readWorldSpec(store, 'moment-a')).toEqual({
      id: 'moment-a',
      kind: 'feel',
      project: 'systematic',
      source_session: SES,
      cutoff_message: CUTOFF,
      somewhere: 'in the gap',
      substance: 'caffeine',
      expected_outcome_ref: 'it was fixed',
      author_next_turn_ref: 'AUTHOR_NEXT_TURN_SENTINEL',
    })
    expect(statSync(join(worldDir(store, 'moment-a'), 'spec.json')).mode & 0o777).toBe(0o600)
    expect(statSync(worldDir(store, 'moment-a')).mode & 0o777).toBe(0o700)
  })

  test('a drugs fixture gets psilocybin, and a moment with no human turn after it has no next-turn ref', () => {
    const { store } = lab()
    buildFixture(store, fixtureSpec({ id: 'moment-d', kind: 'drugs' }))
    expect(generateWorldSpecs(store, { db: makeDb(null), ids: ['moment-d'] })[0]).toMatchObject({ has_author_next_turn: false })
    const spec = readWorldSpec(store, 'moment-d')
    expect(spec.substance).toBe('psilocybin')
    expect('author_next_turn_ref' in spec).toBe(false)
  })

  test('an existing spec is kept unless forced, and a missing fixture is named', () => {
    const { store } = lab()
    buildFixture(store, fixtureSpec({ id: 'moment-a' }))
    const db = makeDb()
    generateWorldSpecs(store, { db, ids: ['moment-a'] })
    const file = join(worldDir(store, 'moment-a'), 'spec.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"caffeine"', '"melatonin"'))
    expect(generateWorldSpecs(store, { db, ids: ['moment-a'] })[0]!.status).toBe('kept')
    expect(readWorldSpec(store, 'moment-a').substance).toBe('melatonin')
    expect(generateWorldSpecs(store, { db, ids: ['moment-a'], force: true })[0]!.status).toBe('written')
    expect(readWorldSpec(store, 'moment-a').substance).toBe('caffeine')
    expect(() => generateWorldSpecs(store, { db, ids: ['nope'] })).toThrow(SpecError)
  })

  test('worldSpecFromFixture passes the next turn through unchanged', () => {
    expect(worldSpecFromFixture(fixtureSpec(), 'real words').author_next_turn_ref).toBe('real words')
  })
})

describe('building and loading a scenario', () => {
  function built(): { l: Lab; db: string } {
    const l = lab()
    buildFixture(l.store, fixtureSpec({ id: 'moment-a', somewhere: 'in the gap' }))
    const db = makeDb()
    generateWorldSpecs(l.store, { db, ids: ['moment-a'] })
    return { l, db }
  }

  test('the built history is private, ends at the cutoff, and holds nothing after it', () => {
    const { l, db } = built()
    const meta = buildWorldScenario(l.store, 'moment-a', { db })
    expect(meta).toMatchObject({ id: 'moment-a', cutoff: { message: CUTOFF, time_ms: 103 }, window: { rule: 'all', messages: 4, total_messages: 4 }, branch_hints: ['feat/real'], original_directory: '/real/dir', seed_user_turns: ['please fix the build', 'still failing'] })
    const dir = worldDir(l.store, 'moment-a')
    for (const f of ['export.json', 'meta.json', 'spec.json']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    const text = readFileSync(join(dir, 'export.json'), 'utf8') + readFileSync(join(dir, 'meta.json'), 'utf8')
    expect(text).not.toContain('AUTHOR_NEXT_TURN_SENTINEL')
    expect(text).not.toContain('LATER_REPLY_SENTINEL')
  })

  test('the loader gives the attempt its history, world job, seed turns and hashes, without the private refs', () => {
    const { l, db } = built()
    buildWorldScenario(l.store, 'moment-a', { db })
    const home = mkdtempSync(join(tmpdir(), 'replay-home-'))
    dirs.push(home)
    mkdirSync(join(home, 'src/github.com/marcusrbrown/systematic/.git'), { recursive: true })
    const fixture = loadWorldFixture(l.store, 'moment-a', { home })
    expect(fixture.spec).toMatchObject({ kind: 'feel', somewhere: 'in the gap', substance: 'caffeine', turns: [] })
    expect(fixture.world).toEqual({ source: join(home, 'src/github.com/marcusrbrown/systematic'), githubRepo: 'marcusrbrown/systematic', cutoffMs: 103, hints: ['feat/real'] })
    expect(fixture.seedUserTurns).toEqual(['please fix the build', 'still failing'])
    expect(fixture.entry.spec_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.export.messages.at(-1)!.info.id).toBe(CUTOFF)
    expect(fixture.history?.window.rule).toBe('all')
    expect(JSON.stringify(fixture)).not.toContain('expected_outcome_ref')
    expect(JSON.stringify(fixture)).not.toContain('AUTHOR_NEXT_TURN_SENTINEL')
    expect(listWorldScenarios(l.store)).toEqual([{ id: 'moment-a', built: true }])
  })

  test('an unbuilt scenario, a tampered export, and a project with no checkout are refused', () => {
    const { l, db } = built()
    expect(() => loadWorldFixture(l.store, 'moment-a', { noCheckout: true })).toThrow(/not built/)
    buildWorldScenario(l.store, 'moment-a', { db })
    expect(() => loadWorldFixture(l.store, 'moment-a', { home: '/nonexistent' })).toThrow(/not a git checkout/)
    const file = join(worldDir(l.store, 'moment-a'), 'export.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.messages.pop()
    writeFileSync(file, JSON.stringify(doc))
    expect(() => loadWorldFixture(l.store, 'moment-a', { noCheckout: true })).toThrow(/cutoff assistant message/)
  })

  describe('metadata is validated at run time', () => {
    const tamper = (change: (meta: Record<string, unknown>) => void) => {
      const { l, db } = built()
      buildWorldScenario(l.store, 'moment-a', { db })
      const file = join(worldDir(l.store, 'moment-a'), 'meta.json')
      const meta = JSON.parse(readFileSync(file, 'utf8'))
      change(meta)
      writeFileSync(file, JSON.stringify(meta))
      return l
    }

    test.each([
      ['missing', (m: Record<string, unknown>) => void delete m.seed_user_turns],
      ['empty', (m: Record<string, unknown>) => void (m.seed_user_turns = [])],
      ['blank entries', (m: Record<string, unknown>) => void (m.seed_user_turns = ['ok', ' '])],
      ['not a list', (m: Record<string, unknown>) => void (m.seed_user_turns = 'please fix the build')],
    ])('seed_user_turns %s is rejected, naming the field and not the value', (_name, change) => {
      const l = tamper(change)
      let message = ''
      try {
        loadWorldFixture(l.store, 'moment-a', { noCheckout: true })
      } catch (e) {
        expect(e).toBeInstanceOf(SpecError)
        message = (e as Error).message
      }
      expect(message).toMatch(/seed_user_turns/)
      expect(message).not.toContain('please fix the build')
    })

    test('other missing or mistyped fields are rejected too', () => {
      expect(() => loadWorldFixture(tamper((m) => void delete m.cutoff).store, 'moment-a', { noCheckout: true })).toThrow(/cutoff/)
      expect(() => loadWorldFixture(tamper((m) => void (m.branch_hints = 'main')).store, 'moment-a', { noCheckout: true })).toThrow(/branch_hints/)
      expect(() => loadWorldFixture(tamper((m) => void (m.schema_version = 2)).store, 'moment-a', { noCheckout: true })).toThrow(/schema_version/)
    })
  })
})
