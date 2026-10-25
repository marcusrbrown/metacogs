import { describe, expect, test } from 'bun:test'

import { parseOptions } from './options'

const collect = () => {
  const warnings: [string, string][] = []
  return { warnings, warn: (key: string, message: string) => void warnings.push([key, message]) }
}

describe('parseOptions', () => {
  test.each([[undefined], [{}], [{ guidance: true }], [{ other: 1 }]])('guidance stays on for %j', (raw) => {
    const { warn, warnings } = collect()
    expect(parseOptions(raw, warn)).toEqual({ guidance: true })
    expect(warnings).toEqual([])
  })

  test('guidance: false turns it off, and nothing is logged', () => {
    const { warn, warnings } = collect()
    expect(parseOptions({ guidance: false }, warn)).toEqual({ guidance: false })
    expect(warnings).toEqual([])
  })

  test.each([['no'], ['false'], [0], [null], [{}], [[]]])('guidance: %j is not a boolean, so the block stays on and the problem is logged', (value) => {
    const { warn, warnings } = collect()
    expect(parseOptions({ guidance: value }, warn)).toEqual({ guidance: true })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[0]).toBe('options.guidance')
  })

  test('the log line names the type, never the value', () => {
    const { warn, warnings } = collect()
    parseOptions({ guidance: 'secret-value-123' }, warn)
    expect(warnings[0]?.[1]).toContain('string')
    expect(warnings[0]?.[1]).not.toContain('secret-value-123')
  })

  test.each([['text'], [3], [true], [['guidance']]])('options that are not an object (%j) leave guidance on and are logged', (raw) => {
    const { warn, warnings } = collect()
    expect(parseOptions(raw, warn)).toEqual({ guidance: true })
    expect(warnings.map(([key]) => key)).toEqual(['options'])
  })
})
