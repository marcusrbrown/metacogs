import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkBlocksJudge, findStaleManifests, JUDGE_BLOCKING_CHECK_CODES, ManifestFormatError, MANIFEST_SCHEMA_VERSION, manifestPath, parseManifest, PILOT_ARMS, readManifest, type RunManifest, scanForLeaks, skipReason, writeManifest } from './manifest'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'metacogs-mf-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: 'r1',
    campaign_id: 'c1',
    status: 'running',
    reasons: [],
    verdict_basis: 'deterministic',
    method: 'demo',
    condition: 'baseline',
    fixture: { id: 'f', kind: 'dev', hash: 'h' },
    attempt: 1,
    skill: null,
    prereg: { content_hash: 'a'.repeat(64), epoch: 1 },
    provider_mode: 'scripted',
    opencode: { package: 'opencode-ai', version: '1.19.4' },
    model: { pinned: 'p/m', returned: [] },
    isolation: null,
    config: { path: '', sha256: '' },
    usage: null,
    wall_clock_ms: null,
    tool_call_count: null,
    host_errors: [],
    records: [],
    check_failures: [],
    artifacts: {},
    started_at: '2026-10-22T00:00:00.000Z',
    finished_at: null,
    ...overrides,
  }
}

describe('manifest files', () => {
  test('write is atomic (no temp file left), mode 0600, and round-trips', () => {
    const dir = tmp()
    const path = writeManifest(dir, manifest())
    expect(path).toBe(manifestPath(dir))
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(readManifest(path).status).toBe('running')
    writeManifest(dir, manifest({ status: 'completed', outcome: 'pass' }))
    expect(readManifest(path)).toMatchObject({ status: 'completed', outcome: 'pass' })
    expect((require('node:fs').statSync(path).mode & 0o777).toString(8)).toBe('600')
  })

  test('a manifest with legacy prereg.tag/commit_sha and no content_hash predates the content-contract format', () => {
    const legacy = { ...manifest(), prereg: { tag: 'prereg/demo/1', commit_sha: 'f'.repeat(40), epoch: 1 } }
    expect(() => parseManifest(JSON.stringify(legacy))).toThrow(ManifestFormatError)
    expect(() => parseManifest(JSON.stringify(legacy))).toThrow('manifest predates the content-contract format')
    const dir = tmp()
    writeFileSync(manifestPath(dir), JSON.stringify(legacy))
    expect(() => readManifest(manifestPath(dir))).toThrow(ManifestFormatError)
  })

  test('a content hash that is not 64-hex, or a non-integer epoch, is refused', () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest(), prereg: { content_hash: 'abc', epoch: 1 } }))).toThrow(ManifestFormatError)
    expect(() => parseManifest(JSON.stringify({ ...manifest(), prereg: { content_hash: 'a'.repeat(64), epoch: 1.5 } }))).toThrow(ManifestFormatError)
    expect(() => parseManifest(JSON.stringify({ ...manifest(), prereg: undefined }))).toThrow(ManifestFormatError)
    expect(parseManifest(JSON.stringify(manifest())).prereg).toEqual({ content_hash: 'a'.repeat(64), epoch: 1 })
  })

  test('an arm outside PILOT_ARMS is refused; a known arm and no arm both parse', () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest(), arm: 'bogus' }))).toThrow(ManifestFormatError)
    expect(() => parseManifest(JSON.stringify({ ...manifest(), arm: 'bogus' }))).toThrow(/arm/)
    expect(() => parseManifest(JSON.stringify({ ...manifest(), arm: 7 }))).toThrow(ManifestFormatError)
    expect(parseManifest(JSON.stringify({ ...manifest(), arm: 'baseline' })).arm).toBe('baseline')
    expect(parseManifest(JSON.stringify({ ...manifest(), arm: 'skill', condition: 'skill' })).arm).toBe('skill')
    expect(parseManifest(JSON.stringify(manifest())).arm).toBeUndefined()
    expect([...PILOT_ARMS]).toEqual(['baseline', 'skill'])
  })
})

describe('which check failures keep a run from the judge', () => {
  const failures = (...codes: string[]) => codes.map((code) => ({ code: code as never, message: 'm' }))
  const completed = (...codes: string[]) => manifest({ status: 'completed', check_failures: failures(...codes) })

  test('without the declaration every failure blocks, as it always has', () => {
    expect(checkBlocksJudge(failures('record_missing'), false)).toBe(true)
    expect(checkBlocksJudge([], false)).toBe(false)
    expect(skipReason(completed('record_missing'), true)).toContain('deterministic check')
    expect(skipReason(completed(), true)).toBeUndefined()
  })

  test('under the declaration only an unreadable stream or a false fire blocks', () => {
    for (const code of JUDGE_BLOCKING_CHECK_CODES) expect(checkBlocksJudge(failures(code), true)).toBe(true)
    expect([...JUDGE_BLOCKING_CHECK_CODES]).toEqual(['unrecognized_events', 'false_fire_skill_call', 'false_fire_denied_skill_call', 'false_fire_direct_read', 'false_fire_helper', 'false_fire_record'])
    for (const code of ['skill_not_loaded', 'record_without_load', 'record_missing', 'record_unexpected', 'record_invalid', 'record_filename_mismatch', 'record_method_mismatch', 'execution_mode_unexpected', 'helper_not_invoked', 'record_without_helper']) {
      expect(checkBlocksJudge(failures(code), true)).toBe(false)
    }
    expect(checkBlocksJudge(failures('record_missing', 'unrecognized_events'), true)).toBe(true)
    expect(skipReason(completed('skill_not_loaded', 'record_missing'), true, true)).toBeUndefined()
    expect(skipReason(completed('record_missing', 'unrecognized_events'), true, true)).toContain('deterministic check')
  })

  test('status, fixture kind and answer_empty still skip, declared or not', () => {
    expect(skipReason(manifest({ status: 'timeout' }), true, true)).toContain('status timeout')
    expect(skipReason(completed(), false, true)).toContain('no stdout')
    expect(skipReason(manifest({ status: 'completed', reasons: ['answer_empty'] }), true, true)).toContain('empty answer')
  })
})

describe('stale manifests', () => {
  test('only manifests still "running" are reported; nothing is modified', () => {
    const root = tmp()
    for (const [run, status] of [['001', 'running'], ['002', 'completed'], ['003', 'interrupted']] as const) {
      const dir = join(root, 'campaign', run)
      mkdirSync(dir, { recursive: true })
      writeManifest(dir, manifest({ run_id: run, status }))
    }
    mkdirSync(join(root, 'campaign', '004'), { recursive: true })
    writeFileSync(join(root, 'campaign', '004', 'manifest.json'), '{truncated')
    const stale = findStaleManifests([root, join(root, 'does-not-exist')])
    expect(stale.map((s) => s.run_id)).toEqual(['001'])
    expect(readManifest(stale[0]!.path).status).toBe('running')
  })
})

describe('scanForLeaks', () => {
  const needles = [{ label: 'placeholder', value: 'placeholder-not-a-secret' }]

  test('finds the needle in the manifest, an artifact, and a workspace file; reports labels not values', () => {
    const ws = tmp()
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'notes.txt'), 'x placeholder-not-a-secret y')
    const findings = scanForLeaks({
      needles,
      manifestJson: JSON.stringify({ k: 'placeholder-not-a-secret' }),
      artifacts: { 'stdout.jsonl': 'clean', 'stderr.txt': 'oops placeholder-not-a-secret' },
      dirs: [ws],
    })
    expect(findings.map((f) => f.where.split('::').pop())).toEqual(['manifest', 'stderr.txt', 'sub/notes.txt'])
    expect(JSON.stringify(findings)).not.toContain('placeholder-not-a-secret')
  })

  test('clean inputs → no findings', () => {
    const ws = tmp()
    writeFileSync(join(ws, 'a'), 'nothing here')
    expect(scanForLeaks({ needles, manifestJson: '{}', artifacts: { a: 'b' }, dirs: [ws] })).toEqual([])
    expect(readFileSync(join(ws, 'a'), 'utf8')).toBe('nothing here')
  })
})
