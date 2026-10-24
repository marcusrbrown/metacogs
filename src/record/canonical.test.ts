import { describe, expect, test } from 'bun:test'
import { canonicalize, canonicalPayload, recordFilename, recordHash } from './canonical'
import { validRecord } from './test-support'

describe('canonicalize (RFC 8785)', () => {
  test('sorts object keys by UTF-16 code units (RFC 8785 section 3.2.3 vector)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\u{1f600}': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    expect(Object.keys(JSON.parse(canonicalize(input)))).toEqual([
      '1',
      '\r',
      '\u0080',
      '\u00f6',
      '\u20ac',
      '\u{1f600}',
      '\ufb33',
    ])
    // Sorting is by UTF-16 code unit, so U+1F600 (D83D DE00) precedes U+FB33.
    expect('\u{1f600}' < '\ufb33').toBe(true)
  })

  test('emits no insignificant whitespace and preserves array order', () => {
    expect(canonicalize({ b: [3, 1, 2], a: { d: null, c: true } })).toBe('{"a":{"c":true,"d":null},"b":[3,1,2]}')
  })

  test('serializes numbers per ECMAScript (RFC 8785 section 3.2.2.3)', () => {
    expect(canonicalize([1e30, 4.5, 0.002, 1e-27, -0, 0, 10, 1e21, 123456789012345680000])).toBe(
      '[1e+30,4.5,0.002,1e-27,0,0,10,1e+21,123456789012345680000]',
    )
  })

  test('escapes strings as JSON does', () => {
    expect(canonicalize('a"b\\c\n\u0001\u007f')).toBe('"a\\"b\\\\c\\n\\u0001\u007f"')
  })

  test('rejects values outside I-JSON', () => {
    expect(() => canonicalize(Number.NaN)).toThrow()
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => canonicalize({ a: undefined })).toThrow()
    expect(() => canonicalize(1n)).toThrow()
    expect(() => canonicalize('\ud800')).toThrow()
    expect(() => canonicalize(new Date())).toThrow()
  })
})

describe('record hashing', () => {
  test('key order and whitespace do not change the hash', () => {
    const a = validRecord()
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())))
    expect(recordHash(reordered)).toBe(recordHash(a))
    expect(recordFilename(reordered)).toBe(recordFilename(a))
  })

  test('helper_version is excluded from the hashed payload', () => {
    const a = validRecord({ helper_version: '0.1.0' })
    const b = validRecord({ helper_version: '9.9.9' })
    const c = validRecord()
    expect(canonicalPayload(a)).toBe(canonicalPayload(c))
    expect(recordFilename(a)).toBe(recordFilename(b))
    expect(recordFilename(a)).toBe(recordFilename(c))
  })

  test('any other change alters the filename', () => {
    expect(recordFilename(validRecord({ objective: 'other' }))).not.toBe(recordFilename(validRecord()))
  })

  test('filename is <method>-<16 hex>.json', () => {
    expect(recordFilename(validRecord())).toMatch(/^counterfactual-[0-9a-f]{16}\.json$/)
  })

  test('hash is sha256 of the canonical UTF-8 bytes', () => {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(canonicalPayload(validRecord()))
    expect(recordHash(validRecord())).toBe(hasher.digest('hex'))
  })
})
