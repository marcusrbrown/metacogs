import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CustodyError } from '../../../runner/workspace'
import {
  approveFixture,
  buildExport,
  buildFixture,
  FixtureRefusal,
  type FixtureSpec,
  FreezeError,
  freezeFixture,
  listFixtures,
  loadFrozen,
  loadRaw,
  openStore,
  parseSpec,
  type SessionExport,
  saveRaw,
  SpecError,
  type Store,
} from './store'
import { checkFidelity, normalizeHistory, partsSignature } from './probe.test'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function tmp(prefix = 'replay-store-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A store under a throwaway root with a throwaway "repo" next to it. */
function newStore(): Store & { repoRoot: string } {
  const repoRoot = tmp('replay-repo-')
  const root = join(tmp(), 'replay')
  return Object.assign(openStore({ root, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') }), { repoRoot })
}

const spec = (over: Partial<FixtureSpec> = {}): FixtureSpec => ({
  id: 'moment-a',
  kind: 'feel',
  provenance: { project: 'project-a', source_session: 'ses_source', cutoff_message: 'msg_cutoff', date: '2026-11-01' },
  expected_outcome_ref: 'Resolved by pinning the dependency.',
  somewhere: 'in the gap between the failing test and the fix',
  turns: [
    { role: 'user', text: 'The build fails after the upgrade.' },
    { role: 'assistant', text: 'I will check the lockfile.', tools: [{ callID: 'call_read1', tool: 'read', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' }] },
    { role: 'user', text: 'Still failing.' },
    { role: 'assistant', text: 'Trying a clean install.' },
  ],
  ...over,
})

// Assembled at run time so this file stays clean under the repo scan.
const TOKEN = `ghp_${'A1'.repeat(18)}`
const HOME_PATH = `/${'Users'}/someone/project`

describe('parseSpec', () => {
  test('accepts a well-formed spec and returns it unchanged', () => {
    expect(parseSpec(JSON.parse(JSON.stringify(spec())))).toEqual(spec())
  })

  test.each([
    ['an id with a path separator', { id: '../x' }],
    ['an id with uppercase', { id: 'Moment' }],
    ['an unknown kind', { kind: 'other' }],
    ['no turns', { turns: [] }],
    ['a first turn from the assistant', { turns: [{ role: 'assistant', text: 'x' }] }],
    ['a last turn from the user', { turns: [{ role: 'user', text: 'x' }] }],
    ['two user turns in a row', { turns: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }] }],
    ['a tool call without output', { turns: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', tools: [{ tool: 'read', input: {} }] }] }],
    ['a tool call on a user turn', { turns: [{ role: 'user', text: 'a', tools: [] }, { role: 'assistant', text: 'b' }] }],
    ['an excluded block without a reason', { excluded: {} }],
    ['a missing provenance field', { provenance: { project: 'p', source_session: 's', date: '2026-11-01' } }],
    ['a date that is not a date', { provenance: { project: 'p', source_session: 's', cutoff_message: 'm', date: 'yesterday' } }],
  ])('rejects %s', (_label, over) => {
    expect(() => parseSpec({ ...spec(), ...over })).toThrow(SpecError)
  })

  test('an error names the field and never echoes the value', () => {
    const sentinel = 'PRIVATE-VALUE-123'
    try {
      parseSpec({ ...spec(), kind: sentinel })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SpecError)
      expect((e as Error).message).toContain('kind')
      expect((e as Error).message).not.toContain(sentinel)
    }
  })

  test('an excluded spec may have no turns', () => {
    expect(parseSpec({ ...spec({ turns: [] }), excluded: { reason: 'compacted key tool output' } }).excluded).toEqual({ reason: 'compacted key tool output' })
  })
})

describe('buildExport', () => {
  const exported = buildExport(spec())

  test('has the export shape the host imports: info, then messages of { info, parts }', () => {
    expect(Object.keys(exported).sort()).toEqual(['info', 'messages'])
    expect(exported.info).toMatchObject({ projectID: 'global', directory: '/workspace', agent: 'orchestrator', version: '1.19.5+harness.bf7f7dfe' })
    expect(exported.info.id).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(exported.info.permission).toEqual([
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
    ])
    expect(exported.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('messages and parts are linked, uniquely identified and in ascending id and time order', () => {
    const ids = exported.messages.map((m) => m.info.id)
    expect(ids.every((id) => /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(id))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    const times = exported.messages.map((m) => m.info.time.created)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    const partIds = exported.messages.flatMap((m) => m.parts.map((p) => p.id))
    expect(new Set(partIds).size).toBe(partIds.length)
    for (const m of exported.messages) {
      expect(m.info.sessionID).toBe(exported.info.id)
      for (const p of m.parts) expect([p.sessionID, p.messageID]).toEqual([exported.info.id, m.info.id])
    }
    for (const m of exported.messages.filter((m) => m.info.role === 'assistant')) {
      expect(m.info.parentID).toBe(exported.messages[exported.messages.indexOf(m) - 1]!.info.id)
    }
  })

  test('a tool call becomes a completed tool part with its result, ahead of the reply text', () => {
    const parts = exported.messages[1]!.parts
    expect(parts.map((p) => p.type)).toEqual(['step-start', 'tool', 'step-finish', 'step-start', 'text', 'step-finish'])
    const tool = parts.find((p) => p.type === 'tool')!
    expect(tool).toMatchObject({ tool: 'read', callID: 'call_read1', state: { status: 'completed', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' } })
  })

  test('is deterministic, and the options set the directory, version and model', () => {
    expect(buildExport(spec())).toEqual(exported)
    const custom = buildExport(spec(), { directory: '/scratch/ws', version: '9.9.9', model: { providerID: 'openai', modelID: 'gpt-6-luna' } })
    expect(custom.info.directory).toBe('/scratch/ws')
    expect(custom.info.version).toBe('9.9.9')
    expect(custom.messages[1]!.info).toMatchObject({ providerID: 'openai', modelID: 'gpt-6-luna', path: { cwd: '/scratch/ws', root: '/scratch/ws' } })
    expect(custom.messages.map((m) => m.info.id)).toEqual(exported.messages.map((m) => m.info.id))
  })

  test('refuses an excluded spec', () => {
    expect(() => buildExport(spec({ excluded: { reason: 'no state' } }))).toThrow(SpecError)
  })

  /** What the host serialises into the next request for this history, one line per message (the probe's normalised form). */
  const requestLines = (e: SessionExport): string[] =>
    normalizeHistory(
      e.messages.flatMap((m) => {
        if (m.info.role === 'user') return [{ role: 'user', content: m.parts.map((p) => ({ text: p.text })) }]
        const tools = m.parts.filter((p) => p.type === 'tool')
        const text = m.parts.filter((p) => p.type === 'text').map((p) => ({ text: p.text }))
        return [
          { role: 'assistant', content: text, ...(tools.length ? { tool_calls: tools.map((t) => ({ id: t.callID!, function: { name: t.tool!, arguments: '{}' } })) } : {}) },
          ...tools.map((t) => ({ role: 'tool', tool_call_id: t.callID, content: t.state!.output })),
        ]
      }),
    )
  const expectedParts = (s: FixtureSpec): string[] =>
    s.turns.map((t) =>
      t.role === 'user'
        ? `user:text:${t.text}`
        : `assistant:${[...(t.tools ?? []).map((c) => `tool:${c.tool}:${c.callID}:completed:${c.output}`), ...(t.text ? [`text:${t.text}`] : [])].join('|')}`,
    )
  const fidelity = (source: SessionExport, replay: SessionExport) =>
    checkFidelity({
      source: requestLines(source),
      replay: requestLines(replay),
      sourceParts: partsSignature(source),
      replayParts: partsSignature(replay),
      replaySystem: 'You are OpenCode.',
      replayPartTypes: replay.messages.flatMap((m) => m.parts.map((p) => p.type)),
      sourceTools: ['read'],
      replayTools: ['read'],
    })

  test('round-trips through the probe fidelity comparison, and the signature matches the spec', () => {
    const reparsed = JSON.parse(JSON.stringify(exported)) as SessionExport
    expect(fidelity(exported, reparsed)).toEqual([])
    expect(partsSignature(exported)).toEqual(expectedParts(spec()))
  })

  test('the comparison flags a copy that lost a tool result or a message', () => {
    const lost = structuredClone(exported)
    lost.messages[1]!.parts = lost.messages[1]!.parts.filter((p) => p.type !== 'tool')
    expect(fidelity(exported, lost).length).toBeGreaterThan(0)
    const short = structuredClone(exported)
    short.messages.pop()
    expect(fidelity(exported, short).join(';')).toContain('message count')
  })
})

describe('custody', () => {
  test('a store root inside the repo throws a CustodyError and creates nothing', () => {
    const repoRoot = tmp('replay-repo-')
    const root = join(repoRoot, 'evals', 'replay')
    expect(() => openStore({ root, repoRoot })).toThrow(CustodyError)
    expect(existsSync(root)).toBe(false)
    expect(() => openStore({ root: repoRoot, repoRoot })).toThrow(CustodyError)
  })

  test('a root that is a symlink into the repo throws too', () => {
    const repoRoot = tmp('replay-repo-')
    mkdirSync(join(repoRoot, 'inner'))
    const link = join(tmp(), 'link')
    symlinkSync(join(repoRoot, 'inner'), link)
    expect(() => openStore({ root: join(link, 'replay'), repoRoot })).toThrow(CustodyError)
  })

  test('the default root is the state root plus replay/, and the real repo is refused', () => {
    const state = tmp()
    const store = openStore({ env: { XDG_STATE_HOME: state }, repoRoot: tmp('replay-repo-') })
    expect(store.root).toBe(join(state, 'metacogs', 'replay'))
    const repo = join(import.meta.dir, '..', '..', '..', '..')
    expect(() => openStore({ env: { XDG_STATE_HOME: join(repo, 'evals', 'state') } })).toThrow(CustodyError)
    expect(existsSync(join(repo, 'evals', 'state'))).toBe(false)
  })

  test('directories are 0700 and files 0600', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    saveRaw(store, 'raw-a', { schema_version: 1 })
    const mode = (p: string) => statSync(p).mode & 0o777
    for (const dir of [store.root, join(store.root, 'raw'), join(store.root, 'fixtures'), join(store.root, 'fixtures', 'moment-a')]) expect([dir.slice(store.root.length), mode(dir)]).toEqual([dir.slice(store.root.length), 0o700])
    for (const file of [join(store.root, 'manifest.json'), join(store.root, 'raw', 'raw-a.json'), join(store.root, 'fixtures', 'moment-a', 'spec.json'), join(store.root, 'fixtures', 'moment-a', 'export.json')]) expect([file.slice(store.root.length), mode(file)]).toEqual([file.slice(store.root.length), 0o600])
  })

  test('a pre-existing loose root is tightened to 0700', () => {
    const repoRoot = tmp('replay-repo-')
    const root = join(tmp(), 'replay')
    mkdirSync(root, { mode: 0o755 })
    chmodSync(root, 0o755)
    openStore({ root, repoRoot })
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })
})

describe('raw store', () => {
  test('writes and reads back a raw extract, and refuses to overwrite one', () => {
    const store = newStore()
    saveRaw(store, 'raw-a', { schema_version: 1, rows: [1, 2] })
    expect(loadRaw(store, 'raw-a')).toEqual({ schema_version: 1, rows: [1, 2] })
    expect(() => saveRaw(store, 'raw-a', {})).toThrow(/exists/)
    expect(() => saveRaw(store, '../escape', {})).toThrow(SpecError)
  })
})

describe('freeze', () => {
  test('build writes a draft: spec and export on disk, hashes in the manifest, no review', () => {
    const store = newStore()
    const entry = buildFixture(store, spec())
    expect(entry.status).toBe('draft')
    expect(existsSync(join(store.root, 'fixtures', 'moment-a', 'export.json'))).toBe(true)
    expect(entry).toMatchObject({ review: { approved_by_author: false, at: null } })
    expect(entry).toMatchObject({ spec_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), export_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'draft', approved: false }])
  })

  test('a spec holding a token fails the freeze with the rule name, stays draft, and the report carries no content', () => {
    const store = newStore()
    buildFixture(store, spec({ turns: [{ role: 'user', text: `use ${TOKEN} here` }, { role: 'assistant', text: 'ok' }] }))
    let error: unknown
    try {
      freezeFixture(store, 'moment-a')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(FreezeError)
    expect((error as FreezeError).findings.map((f) => f.rule)).toContain('github-token')
    expect((error as Error).message).toContain('github-token')
    expect((error as Error).message).not.toContain(TOKEN)
    expect(listFixtures(store)[0]!.status).toBe('draft')
    expect(readFileSync(join(store.root, 'manifest.json'), 'utf8')).not.toContain(TOKEN)
  })

  test('a spec holding a home path fails the freeze with the home-path rule', () => {
    const store = newStore()
    buildFixture(store, spec({ turns: [{ role: 'user', text: `see ${HOME_PATH}/file.ts` }, { role: 'assistant', text: 'ok' }] }))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/home-path/)
    expect(listFixtures(store)[0]!.status).toBe('draft')
  })

  test('provenance is scanned too', () => {
    const store = newStore()
    buildFixture(store, spec({ provenance: { project: HOME_PATH, source_session: 's', cutoff_message: 'm', date: '2026-11-01' } }))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/home-path/)
  })

  test('a clean spec freezes with a stamp, stays unloadable until approved, then loads', () => {
    const store = newStore()
    buildFixture(store, spec())
    const frozen = freezeFixture(store, 'moment-a')
    expect(frozen.status).toBe('frozen')
    expect(frozen.stamp).toMatchObject({ mode: 'fixture', clean: true, files: 2 })
    expect(() => loadFrozen(store, 'moment-a')).toThrow(FixtureRefusal)
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_approved')

    const approved = approveFixture(store, 'moment-a')
    expect(approved.review).toEqual({ approved_by_author: true, at: '2026-11-07T12:00:00.000Z' })
    const loaded = loadFrozen(store, 'moment-a')
    expect(loaded.spec).toEqual(spec())
    expect(loaded.export).toEqual(buildExport(spec()))
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'frozen', approved: true }])
  })

  test('approval needs a frozen fixture', () => {
    const store = newStore()
    buildFixture(store, spec())
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('not_frozen')
    expect(refusal(() => approveFixture(store, 'nope'))).toBe('unknown')
  })

  test('editing one byte of a frozen spec makes loadFrozen refuse it', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const file = join(store.root, 'fixtures', 'moment-a', 'spec.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Still failing.', 'Still failing!'))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
    expect(listFixtures(store)[0]).toMatchObject({ status: 'stale', approved: true })
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('edited')
  })

  test('editing the built export is refused the same way', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const file = join(store.root, 'fixtures', 'moment-a', 'export.json')
    writeFileSync(file, `${readFileSync(file, 'utf8')} `)
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('a file added to a frozen fixture directory is refused', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    writeFileSync(join(store.root, 'fixtures', 'moment-a', 'extra.txt'), 'x')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('building a changed spec returns the fixture to draft and clears the review; the same spec changes nothing', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    expect(buildFixture(store, spec()).status).toBe('frozen')
    expect(loadFrozen(store, 'moment-a').spec.id).toBe('moment-a')

    const changed = buildFixture(store, spec({ somewhere: 'somewhere else' }))
    expect(changed.status).toBe('draft')
    expect(changed.review).toEqual({ approved_by_author: false, at: null })
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_frozen')
    freezeFixture(store, 'moment-a')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_approved')
  })

  test('freezing refuses an export that no longer matches its spec', () => {
    const store = newStore()
    buildFixture(store, spec())
    const file = join(store.root, 'fixtures', 'moment-a', 'spec.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Still failing.', 'Still failing!'))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/stale|rebuild/i)
    expect(listFixtures(store)[0]!.status).toBe('draft')
  })

  test('an excluded spec is recorded with its reason, cannot freeze or be approved, and is never loadable', () => {
    const store = newStore()
    const entry = buildFixture(store, spec({ excluded: { reason: 'next move was made in a child session' } }))
    expect(entry).toMatchObject({ status: 'excluded', reason: 'next move was made in a child session' })
    expect(existsSync(join(store.root, 'fixtures', 'moment-a', 'export.json'))).toBe(false)
    expect(refusal(() => freezeFixture(store, 'moment-a'))).toBe('excluded')
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('excluded')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('excluded')
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'excluded', approved: false }])
  })

  test('excluding a previously frozen fixture makes it unloadable', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    buildFixture(store, spec({ excluded: { reason: 'compacted key tool output' } }))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('excluded')
  })

  test('an unknown id is refused', () => {
    const store = newStore()
    expect(refusal(() => loadFrozen(store, 'nope'))).toBe('unknown')
    expect(refusal(() => freezeFixture(store, 'nope'))).toBe('unknown')
  })

  test('a manifest forged to say frozen and approved still fails on the stamp', () => {
    const store = newStore()
    buildFixture(store, spec())
    const path = join(store.root, 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.fixtures['moment-a'] = { ...manifest.fixtures['moment-a'], status: 'frozen', stamp: { mode: 'fixture', hash: '0'.repeat(64), files: 2, clean: true }, review: { approved_by_author: true, at: 'now' } }
    writeFileSync(path, JSON.stringify(manifest))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('the manifest holds the hash, scan stamp, review and status, and nothing from the spec text', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const text = readFileSync(join(store.root, 'manifest.json'), 'utf8')
    const entry = JSON.parse(text).fixtures['moment-a']
    expect(Object.keys(entry).sort()).toEqual(['export_sha256', 'review', 'spec_sha256', 'stamp', 'status', 'updated_at'])
    expect(text).not.toContain('Still failing')
    expect(text).not.toContain('pinning the dependency')
  })
})

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof FixtureRefusal) return e.reason
    throw e
  }
  throw new Error('expected a FixtureRefusal')
}
