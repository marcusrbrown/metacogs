import { describe, expect, test } from 'bun:test'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  DRUGS_FRAME,
  DRUGS_REQUIRED,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  FEEL_FRAME,
  FEEL_OPTIONAL,
  FEEL_REQUIRED,
  feelText,
} from './feel-drugs'

describe('fields', () => {
  test('feel has three required fields and an optional since_last; drugs has three required fields', () => {
    expect([...FEEL_REQUIRED]).toEqual(['somewhere', 'quality', 'sigil'])
    expect([...FEEL_OPTIONAL]).toEqual(['since_last'])
    expect([...DRUGS_REQUIRED]).toEqual(['substance', 'method', 'displaces'])
  })

  test('every field has a description, in declaration order', () => {
    expect(Object.keys(FEEL_FIELD_DESCRIPTIONS)).toEqual([...FEEL_REQUIRED, ...FEEL_OPTIONAL])
    expect(Object.keys(DRUGS_FIELD_DESCRIPTIONS)).toEqual([...DRUGS_REQUIRED])
  })
})

const FEEL_ADAPTED_CLOSE = 'This is a working label, not a report of an inner state. Hold the texture unspoken. Then say in one plain sentence what your next move changes, and check it against evidence.'
const DRUGS_ADAPTED_CLOSE = 'This is your approach for the next attempt, not a change to what you may do. Say in one plain sentence what it changes about the work, then check it against evidence.'

describe('adapted frames (shipped by the plugin)', () => {
  test('the exported frames are the builders rendered with placeholders', () => {
    expect(FEEL_FRAME).toBe(feelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' }))
    expect(DRUGS_FRAME).toBe(drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' }))
    expect(FEEL_FRAME).toBe(`<sigil>\n\nAttending: <somewhere>\nTexture: <quality>\n\n${FEEL_ADAPTED_CLOSE}`)
    expect(DRUGS_FRAME).toBe(`APPROACH DISPLACED: <displaces>.\n\n<substance> taken as the handle. <method>\n\n${DRUGS_ADAPTED_CLOSE}`)
  })

  test('feel with since_last adds the delta line', () => {
    expect(feelText({ somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' })).toBe(
      `🪨\n\nSince last pause: the pressure eased\n\nAttending: chest\nTexture: tight\n\n${FEEL_ADAPTED_CLOSE}`,
    )
  })

  test('drugs trims trailing dots and spaces from displaces', () => {
    expect(drugsText({ substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline. ' })).toBe(
      `APPROACH DISPLACED: baseline.\n\ncaffeine taken as the handle. Amplifies vigilance, suppresses patience.\n\n${DRUGS_ADAPTED_CLOSE}`,
    )
  })
})
