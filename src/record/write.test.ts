import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordFilename } from './canonical'
import { validRecord } from './test-support'
import { RecordCollisionError, RecordIoError, resolveRoot, writeRecord } from './write'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'metacogs-write-'))
})

afterEach(() => {
  chmodSync(tmp, 0o700)
  rmSync(tmp, { recursive: true, force: true })
})

const stamped = (overrides: Record<string, unknown> = {}) => validRecord({ helper_version: '0.1.0', ...overrides }) as never

describe('resolveRoot precedence', () => {
  const base = { cwd: '/work/cwd', home: '/home/tester' }

  test('--out-dir beats everything', () => {
    const env = { METACOGS_RECORDS_DIR: '/env/records', XDG_STATE_HOME: '/xdg' }
    expect(resolveRoot({ ...base, outDir: '/flag/records', env })).toBe('/flag/records')
  })

  test('METACOGS_RECORDS_DIR beats XDG_STATE_HOME', () => {
    const env = { METACOGS_RECORDS_DIR: '/env/records', XDG_STATE_HOME: '/xdg' }
    expect(resolveRoot({ ...base, env })).toBe('/env/records')
  })

  test('XDG_STATE_HOME is used next', () => {
    expect(resolveRoot({ ...base, env: { XDG_STATE_HOME: '/xdg' } })).toBe('/xdg/metacogs/records')
  })

  test('falls back to ~/.local/state/metacogs/records and never to cwd', () => {
    const root = resolveRoot({ ...base, env: {} })
    expect(root).toBe('/home/tester/.local/state/metacogs/records')
    expect(root.startsWith(base.cwd)).toBe(false)
  })

  test('empty and relative XDG_STATE_HOME are ignored; relative --out-dir resolves against cwd', () => {
    expect(resolveRoot({ ...base, env: { XDG_STATE_HOME: '' } })).toBe('/home/tester/.local/state/metacogs/records')
    expect(resolveRoot({ ...base, env: { XDG_STATE_HOME: 'rel' } })).toBe('/home/tester/.local/state/metacogs/records')
    expect(resolveRoot({ ...base, outDir: 'out', env: {} })).toBe('/work/cwd/out')
  })
})

describe('writeRecord', () => {
  test('writes <method>-<hash>.json with 0600 file and 0700 created dirs', async () => {
    const root = join(tmp, 'a', 'records')
    const record = stamped()
    const result = await writeRecord({ root, record })
    expect(result.status).toBe('written')
    expect(result.path).toBe(join(root, recordFilename(record)))
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(tmp, 'a')).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(result.path, 'utf8')).helper_version).toBe('0.1.0')
    expect(readdirSync(root)).toEqual([recordFilename(record)])
  })

  test('identical record twice is idempotent: same path, single file', async () => {
    const root = join(tmp, 'records')
    const first = await writeRecord({ root, record: stamped() })
    const second = await writeRecord({ root, record: stamped() })
    expect(second.path).toBe(first.path)
    expect(second.status).toBe('exists')
    expect(readdirSync(root)).toHaveLength(1)
  })

  test('same record from a different helper_version is idempotent and leaves the original', async () => {
    const root = join(tmp, 'records')
    const first = await writeRecord({ root, record: stamped({ helper_version: '0.1.0' }) })
    const before = readFileSync(first.path, 'utf8')
    const second = await writeRecord({ root, record: stamped({ helper_version: '0.2.0' }) })
    expect(second.path).toBe(first.path)
    expect(readFileSync(first.path, 'utf8')).toBe(before)
    expect(readdirSync(root)).toHaveLength(1)
  })

  test('existing final with different content is a collision; temp removed', async () => {
    const root = join(tmp, 'records')
    const first = await writeRecord({ root, record: stamped() })
    writeFileSync(first.path, '{"different":true}\n')
    const err = await writeRecord({ root, record: stamped() }).catch(e => e)
    expect(err).toBeInstanceOf(RecordCollisionError)
    expect(err.message).toContain(first.path)
    expect(readdirSync(root)).toEqual([recordFilename(stamped())])
    expect(readFileSync(first.path, 'utf8')).toBe('{"different":true}\n')
  })

  test('pre-existing truncated file is a collision naming the path', async () => {
    const root = join(tmp, 'records')
    const first = await writeRecord({ root, record: stamped() })
    const full = readFileSync(first.path, 'utf8')
    writeFileSync(first.path, full.slice(0, full.length / 2))
    const err = await writeRecord({ root, record: stamped() }).catch(e => e)
    expect(err).toBeInstanceOf(RecordCollisionError)
    expect(err.message).toContain(first.path)
    expect(readdirSync(root)).toHaveLength(1)
  })

  test('root beneath a regular file is an I/O error with nothing left behind', async () => {
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'x')
    const err = await writeRecord({ root: join(blocker, 'records'), record: stamped() }).catch(e => e)
    expect(err).toBeInstanceOf(RecordIoError)
    expect(readdirSync(tmp)).toEqual(['blocker'])
  })

  test.skipIf(process.getuid?.() === 0)('unwritable root is an I/O error with no temp left behind', async () => {
    const root = join(tmp, 'records')
    await writeRecord({ root, record: stamped({ objective: 'seed' }) })
    const before = readdirSync(root)
    chmodSync(root, 0o500)
    const err = await writeRecord({ root, record: stamped() }).catch(e => e)
    chmodSync(root, 0o700)
    expect(err).toBeInstanceOf(RecordIoError)
    expect(readdirSync(root)).toEqual(before)
  })

  test('refuses a method that would escape the root, even when validation is bypassed', async () => {
    const root = join(tmp, 'records')
    const err = await writeRecord({ root, record: stamped({ method: '../escape' }) }).catch(e => e)
    expect(err).toBeInstanceOf(RecordIoError)
    expect(readdirSync(tmp)).toEqual([])
  })
})
