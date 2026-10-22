import { describe, expect, test } from 'bun:test'
import { EXECUTION_MODES, SHIPPED_METHODS } from './contract'
import { validateRecord } from './validate'
import { validRecord } from './test-support'

function fields(input: unknown, methods?: readonly string[]): string[] {
  const result = validateRecord(input, methods ? { methods } : undefined)
  return result.ok ? [] : result.errors.map(e => e.field)
}

describe('validateRecord', () => {
  test('accepts a complete record', () => {
    const result = validateRecord(validRecord())
    expect(result.ok).toBe(true)
  })

  test('accepts empty arrays', () => {
    expect(validateRecord(validRecord({ alternatives: [], evidence: [], assumptions: [], findings: [] })).ok).toBe(true)
  })

  test('accepts every execution mode and shipped method', () => {
    for (const mode of EXECUTION_MODES) expect(validateRecord(validRecord({ execution_mode: mode })).ok).toBe(true)
    for (const method of SHIPPED_METHODS) expect(validateRecord(validRecord({ method })).ok).toBe(true)
  })

  test('accepts a stamped helper_version', () => {
    expect(validateRecord(validRecord({ helper_version: '0.1.0' })).ok).toBe(true)
  })

  test('names the field when reopen_condition is missing', () => {
    const { reopen_condition: _omit, ...rest } = validRecord()
    expect(fields(rest)).toEqual(['reopen_condition'])
  })

  test('rejects an empty or whitespace-only reopen_condition', () => {
    expect(fields(validRecord({ reopen_condition: '' }))).toEqual(['reopen_condition'])
    expect(fields(validRecord({ reopen_condition: '   ' }))).toEqual(['reopen_condition'])
  })

  test('unknown schema_version names schema_version and nothing else', () => {
    expect(fields(validRecord({ schema_version: 2 }))).toEqual(['schema_version'])
    expect(fields(validRecord({ schema_version: '1' }))).toEqual(['schema_version'])
    const { schema_version: _omit, ...rest } = validRecord()
    expect(fields(rest)).toEqual(['schema_version'])
  })

  test('rejects traversal and malformed method names', () => {
    for (const method of ['../x', 'a/b', 'A', '', '1x', 'x'.repeat(65), 'a b', 'a.b']) {
      expect(fields(validRecord({ method }))).toEqual(['method'])
    }
  })

  test('rejects a well-formed method outside the shipped enum', () => {
    expect(fields(validRecord({ method: 'demo' }))).toEqual(['method'])
  })

  test('honours an injected method enum', () => {
    expect(fields(validRecord({ method: 'demo' }), [...SHIPPED_METHODS, 'demo'])).toEqual([])
    expect(fields(validRecord({ method: 'synthesis' }), ['demo'])).toEqual(['method'])
  })

  test('rejects an unknown execution_mode and non-string status', () => {
    expect(fields(validRecord({ execution_mode: 'parallel' }))).toEqual(['execution_mode'])
    expect(fields(validRecord({ status: 3 }))).toEqual(['status'])
  })

  test('rejects non-array and non-string array elements, naming the index', () => {
    expect(fields(validRecord({ evidence: 'x' }))).toEqual(['evidence'])
    expect(fields(validRecord({ findings: ['ok', 7] }))).toEqual(['findings[1]'])
    expect(fields(validRecord({ assumptions: [''] }))).toEqual(['assumptions[0]'])
  })

  test('rejects unknown fields', () => {
    expect(fields(validRecord({ extra: true }))).toEqual(['extra'])
  })

  test('reports every failing field at once', () => {
    expect(fields(validRecord({ objective: '', next_action: 4 })).sort()).toEqual(['next_action', 'objective'])
  })

  test('rejects non-object input', () => {
    for (const input of [null, [], 'x', 3, undefined]) expect(fields(input)).toEqual(['$'])
  })
})
