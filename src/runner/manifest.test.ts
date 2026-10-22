import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findStaleManifests, MANIFEST_SCHEMA_VERSION, manifestPath, readManifest, type RunManifest, scanForLeaks, writeManifest } from './manifest'

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
    prereg: { tag: 'prereg/demo/1', tag_object_sha: 'a', commit_sha: 'b', blob_sha: 'c', epoch: 1 },
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
