import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordFilename } from './canonical'
import { LIMITS } from './contract'
import { runRecord } from './run'
import { validRecord } from './test-support'
import { validateRecord } from './validate'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'metacogs-run-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const base = () => ({ methods: ['counterfactual', 'synthesis'], helperVersion: '1.2.3', env: { METACOGS_RECORDS_DIR: join(tmp, 'records') }, cwd: tmp })

describe('runRecord', () => {
  test('writes and returns path, next_action and status', async () => {
    const result = await runRecord({ ...base(), input: validRecord() })
    expect(result).toEqual({ ok: true, exit: 0, path: join(tmp, 'records', recordFilename(validRecord())), next_action: 'Confirm the deploy target supports the queue client', status: 'written' })
    expect(JSON.parse(readFileSync((result as { path: string }).path, 'utf8')).helper_version).toBe('1.2.3')
  })

  test('an equivalent retry is ok with status exists', async () => {
    await runRecord({ ...base(), input: validRecord() })
    const again = await runRecord({ ...base(), input: validRecord() })
    expect(again).toMatchObject({ ok: true, status: 'exists' })
  })

  test('validation failure carries field errors and exit 2, and writes nothing', async () => {
    const result = await runRecord({ ...base(), input: validRecord({ objective: '' }) })
    expect(result).toEqual({ ok: false, kind: 'validation', exit: 2, errors: [{ field: 'objective', message: 'is required and must be a non-empty string' }] })
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })

  test('a differing file at the final name is a collision, exit 4, and is left as it was', async () => {
    const first = await runRecord({ ...base(), input: validRecord() })
    const path = (first as { path: string }).path
    await Bun.write(path, '{"different":true}\n')
    const result = await runRecord({ ...base(), input: validRecord() })
    expect(result).toMatchObject({ ok: false, kind: 'collision', exit: 4 })
    expect(readFileSync(path, 'utf8')).toBe('{"different":true}\n')
  })

  test('an unusable root is an io failure, exit 3', async () => {
    await Bun.write(join(tmp, 'blocker'), 'x')
    const result = await runRecord({ ...base(), env: { METACOGS_RECORDS_DIR: join(tmp, 'blocker', 'records') }, input: validRecord() })
    expect(result).toMatchObject({ ok: false, kind: 'io', exit: 3 })
  })

  test('concurrent identical writes yield one file and all report ok', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => runRecord({ ...base(), input: validRecord() })))
    expect(results.every(result => result.ok)).toBe(true)
    expect(results.filter(result => result.ok && result.status === 'written')).toHaveLength(1)
    expect(readdirSync(join(tmp, 'records'))).toEqual([recordFilename(validRecord())])
  })

  test('files are 0600, the created root is 0700, and no temporary file is left behind', async () => {
    const result = await runRecord({ ...base(), input: validRecord() })
    expect(statSync((result as { path: string }).path).mode & 0o777).toBe(0o600)
    expect(statSync(join(tmp, 'records')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(tmp, 'records')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('a method that would traverse is rejected and nothing is created', async () => {
    const result = await runRecord({ ...base(), input: validRecord({ method: '../escape' }) })
    expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2 })
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('payload limits', () => {
  const messages = (input: unknown): string[] => {
    const result = validateRecord(input)
    return result.ok ? [] : result.errors.map(error => `${error.field}: ${error.message}`)
  }

  test('limits are the documented constants', () => {
    expect(LIMITS).toEqual({ MAX_STRING_LENGTH: 4096, MAX_ARRAY_ITEMS: 64, MAX_PAYLOAD_BYTES: 65536 })
  })

  test('a string field at the limit passes and one over it fails', () => {
    expect(validateRecord(validRecord({ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH) })).ok).toBe(true)
    expect(messages(validRecord({ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }))).toEqual([`objective: is ${LIMITS.MAX_STRING_LENGTH + 1} characters; the limit is ${LIMITS.MAX_STRING_LENGTH}`])
  })

  test('an array entry over the limit fails, naming the entry', () => {
    expect(messages(validRecord({ evidence: ['ok', 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1)] }))).toEqual([`evidence[1]: is ${LIMITS.MAX_STRING_LENGTH + 1} characters; the limit is ${LIMITS.MAX_STRING_LENGTH}`])
  })

  test('an array at the item limit passes and one over it fails with one error, not one per entry', () => {
    expect(validateRecord(validRecord({ findings: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS }, (_, i) => `f${i}`) })).ok).toBe(true)
    expect(messages(validRecord({ findings: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS + 1 }, () => '') }))).toEqual([`findings: has ${LIMITS.MAX_ARRAY_ITEMS + 1} entries; the limit is ${LIMITS.MAX_ARRAY_ITEMS}`])
  })

  test('the total payload is capped in bytes even when every part is inside its own limit', () => {
    const wide = 'é'.repeat(LIMITS.MAX_STRING_LENGTH) // 2 bytes per character
    const record = validRecord({ evidence: Array.from({ length: 10 }, () => wide), findings: Array.from({ length: 10 }, () => wide) })
    const [error] = messages(record)
    expect(messages(record)).toHaveLength(1)
    expect(error).toMatch(/^\$: record is \d+ bytes; the limit is 65536$/)
  })

  test('oversized input through runRecord creates no file and no directory', async () => {
    for (const input of [validRecord({ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }), validRecord({ evidence: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS + 1 }, () => 'e') }), validRecord({ assumptions: Array.from({ length: 20 }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH)) })]) {
      const result = await runRecord({ ...base(), input })
      expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2 })
    }
    expect(readdirSync(tmp)).toEqual([])
  })
})
