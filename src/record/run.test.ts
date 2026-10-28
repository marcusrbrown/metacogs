import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordFilename } from './canonical'
import { LIMITS } from './contract'
import { runRecord } from './run'
import { runCli, validRecord } from './test-support'
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

const messages = (input: unknown): string[] => {
  const result = validateRecord(input)
  return result.ok ? [] : result.errors.map(error => `${error.field}: ${error.message}`)
}

describe('payload limits', () => {
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
    expect(error).toMatch(/^record: is \d+ bytes; the limit is 65536$/)
  })

  test('characters are code points: 4096 emoji pass, 4097 fail and the message reports 4097', () => {
    expect(validateRecord(validRecord({ objective: '😀'.repeat(LIMITS.MAX_STRING_LENGTH) })).ok).toBe(true)
    expect(messages(validRecord({ objective: '😀'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }))).toEqual(['objective: is 4097 characters; the limit is 4096'])
    expect(messages(validRecord({ findings: ['😀'.repeat(LIMITS.MAX_STRING_LENGTH + 1)] }))).toEqual(['findings[0]: is 4097 characters; the limit is 4096'])
  })

  test('an oversized helper_version is a validation error naming helper_version', async () => {
    expect(messages(validRecord({ helper_version: 'v'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }))).toEqual(['helper_version: is 4097 characters; the limit is 4096'])
    const result = await runRecord({ ...base(), input: validRecord({ helper_version: 'v'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }) })
    expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2, errors: [{ field: 'helper_version' }] })
    expect(readdirSync(tmp)).toEqual([])
  })

  /** A record whose compact UTF-8 JSON is exactly `target` bytes, padded with ASCII entries inside every per-entry and per-array limit. */
  const recordOfSize = (target: number): Record<string, unknown> => {
    const bytes = (record: unknown): number => Buffer.byteLength(JSON.stringify(record), 'utf8')
    for (let full = 0; full <= LIMITS.MAX_ARRAY_ITEMS - 1; full++) {
      const filler = Array.from({ length: full }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH))
      const base = bytes(validRecord({ findings: filler }))
      // The last entry adds its quotes (2), its characters, and a comma when it is not the first entry.
      const last = target - base - 2 - (full > 0 ? 1 : 0)
      if (last >= 1 && last <= LIMITS.MAX_STRING_LENGTH) {
        const record = validRecord({ findings: [...filler, 'b'.repeat(last)] })
        expect(bytes(record)).toBe(target)
        return record
      }
    }
    throw new Error('no padding fits')
  }

  const STAMP = '1.2.3'
  /** What the stamp adds to a record that has none: `,"helper_version":"1.2.3"`. */
  const stampBytes = (): number => Buffer.byteLength(JSON.stringify({ ...recordOfSize(1000), helper_version: STAMP }), 'utf8') - 1000

  test('a record of exactly MAX_PAYLOAD_BYTES passes the validator, but the stamp pushes it over, so it is rejected as the record', async () => {
    const exact = recordOfSize(LIMITS.MAX_PAYLOAD_BYTES)
    expect(validateRecord(exact).ok).toBe(true)
    const result = await runRecord({ ...base(), input: exact })
    expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2, errors: [{ field: 'record' }] })
    expect(messages(recordOfSize(LIMITS.MAX_PAYLOAD_BYTES + 1))).toEqual([`record: is ${LIMITS.MAX_PAYLOAD_BYTES + 1} bytes; the limit is ${LIMITS.MAX_PAYLOAD_BYTES}`])
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })

  test('a record whose stamped form is exactly MAX_PAYLOAD_BYTES is written, revalidates when read back, and replays through the CLI --file', async () => {
    const input = recordOfSize(LIMITS.MAX_PAYLOAD_BYTES - stampBytes())
    const result = await runRecord({ ...base(), input })
    expect(result).toMatchObject({ ok: true, status: 'written' })
    const path = (result as { path: string }).path
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Buffer.byteLength(JSON.stringify(saved), 'utf8')).toBe(LIMITS.MAX_PAYLOAD_BYTES)
    expect(validateRecord(saved).ok).toBe(true)
    // Replay: the saved file, stamp and all, goes back through the CLI by path and is accepted.
    const replay = await runCli(['--out-dir', join(tmp, 'replayed'), '--file', path], { helperVersion: STAMP })
    expect({ code: replay.code, stderr: replay.stderr }).toEqual({ code: 0, stderr: '' })
    expect(readdirSync(join(tmp, 'replayed'))).toEqual([path.split('/').pop()!])
    // One byte over, with the stamp, is refused.
    const over = await runRecord({ ...base(), input: recordOfSize(LIMITS.MAX_PAYLOAD_BYTES - stampBytes() + 1) })
    expect(over).toMatchObject({ ok: false, kind: 'validation', exit: 2, errors: [{ field: 'record' }] })
  })

  test('the size is counted in UTF-8 bytes: under the limit in UTF-16 code units, over it in bytes, rejected', async () => {
    const euro = '€'.repeat(LIMITS.MAX_STRING_LENGTH) // 1 unit, 3 bytes
    const input = validRecord({ evidence: Array.from({ length: 6 }, () => euro) })
    const json = JSON.stringify(input)
    expect(json.length).toBeLessThan(LIMITS.MAX_PAYLOAD_BYTES)
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(LIMITS.MAX_PAYLOAD_BYTES)
    expect(messages(input)).toEqual([`record: is ${Buffer.byteLength(json, 'utf8')} bytes; the limit is ${LIMITS.MAX_PAYLOAD_BYTES}`])
    expect(await runRecord({ ...base(), input })).toMatchObject({ ok: false, kind: 'validation', exit: 2 })
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })

  test('a non-object input is reported against the record', () => {
    const result = validateRecord([1])
    expect(result).toEqual({ ok: false, errors: [{ field: 'record', message: 'must be a JSON object' }] })
  })

  test('oversized input through runRecord creates no file and no directory', async () => {
    for (const input of [validRecord({ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }), validRecord({ evidence: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS + 1 }, () => 'e') }), validRecord({ assumptions: Array.from({ length: 20 }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH)) })]) {
      const result = await runRecord({ ...base(), input })
      expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2 })
    }
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('hostile input', () => {
  const nested = (depth: number): unknown => {
    let value: unknown = []
    for (let i = 1; i < depth; i++) value = [value]
    return value
  }

  test('deep nesting (which overflows JSON.stringify on V8) is a validation error, with no throw and no file', async () => {
    const junk = nested(10_000)
    for (const input of [{ ...validRecord(), junk }, { ...validRecord(), schema_version: junk }, { ...validRecord(), objective: junk }, { ...validRecord(), helper_version: junk }]) {
      const result = await runRecord({ ...base(), input })
      expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2 })
    }
    expect(readdirSync(tmp)).toEqual([])
  })

  test('an unknown field is rejected as unknown before anything is serialized', async () => {
    const result = await runRecord({ ...base(), input: { ...validRecord(), junk: nested(10_000) } })
    expect(result).toEqual({ ok: false, kind: 'validation', exit: 2, errors: [{ field: 'junk', message: 'unknown field' }] })
  })

  test('a lone surrogate in a string field, an entry or helper_version is a validation error, not an I/O error', async () => {
    for (const [field, overrides] of [
      ['objective', { objective: 'before \ud800 after' }],
      ['evidence[1]', { evidence: ['fine', 'bad \udc00'] }],
      ['helper_version', { helper_version: 'v\ud83d' }],
    ] as const) {
      const input = validRecord(overrides)
      expect(messages(input)).toEqual([`${field}: contains a lone surrogate`])
      const result = await runRecord({ ...base(), input })
      expect(result).toMatchObject({ ok: false, kind: 'validation', exit: 2, errors: [{ field, message: 'contains a lone surrogate' }] })
    }
    expect(readdirSync(tmp)).toEqual([])
  })

  test('a well-formed surrogate pair is fine', () => {
    expect(validateRecord(validRecord({ objective: 'pair 😀 ok' })).ok).toBe(true)
  })
})
