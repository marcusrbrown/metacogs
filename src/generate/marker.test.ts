import { describe, expect, test } from 'bun:test'
import { BANNER_LINE, helperBanner, readHelperVersion } from './marker'

describe('helper version marker', () => {
  test('round-trips through the banner', () => {
    expect(helperBanner('1.2.3')).toBe(`${BANNER_LINE}\n// helper_version: 1.2.3`)
    expect(readHelperVersion(`${helperBanner('1.2.3-rc.1')}\nexport{}`)).toBe('1.2.3-rc.1')
  })

  test('refuses a bundle without the two-line banner', () => {
    expect(readHelperVersion('')).toBeNull()
    expect(readHelperVersion(`${BANNER_LINE}\nexport{}`)).toBeNull()
    expect(readHelperVersion('// helper_version: 1.2.3\nexport{}')).toBeNull()
    expect(readHelperVersion(`${BANNER_LINE}\n// helper_version: \nexport{}`)).toBeNull()
  })

  test('refuses a version that cannot be read back', () => {
    expect(() => helperBanner('1 2')).toThrow()
    expect(() => helperBanner('')).toThrow()
  })
})
