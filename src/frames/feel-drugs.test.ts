import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

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
  UPSTREAM,
} from './feel-drugs'

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Pinned from a byte-for-byte comparison against the upstream file at that commit (substring match of every
// description and template literal in src/index.ts). A change here means the copy drifted from upstream.
const FEEL_DIGEST = '8bb89d7ccdb674ac4fbb462ae49da1eca22c2399d74ccde9c94f1aec45367253'
const DRUGS_DIGEST = 'd1b34c924255e81586ccc3da4cf55624a32aefac360b691230423a070f9323bd'

describe('provenance', () => {
  test('names the pinned upstream commit and licence', () => {
    expect(UPSTREAM).toEqual({
      repo: 'inanna-malick/metacog',
      commit: '3d89bb30cd26369fdcd242fd704f66641dca327c',
      file: 'src/index.ts',
      lines: { feel: '34-88', drugs: '91-133' },
      licence: 'MIT',
    })
  })

  test('descriptions and field descriptions match the pinned digests', () => {
    expect(sha([FEEL_DESCRIPTION, FEEL_FIELD_DESCRIPTIONS])).toBe(FEEL_DIGEST)
    expect(sha([DRUGS_DESCRIPTION, DRUGS_FIELD_DESCRIPTIONS])).toBe(DRUGS_DIGEST)
  })
})

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

describe('frames', () => {
  test('the exported frames are the builders rendered with placeholders', () => {
    expect(FEEL_FRAME).toBe(feelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' }))
    expect(DRUGS_FRAME).toBe(drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' }))
    expect(FEEL_FRAME).toBe('<sigil>\n\nAttending: <somewhere>\nTexture: <quality>\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.')
    expect(DRUGS_FRAME).toBe('SUBSTRATE DISPLACED: <displaces>. What it gave you is gone.\n\n<substance> ingested. <method>\n\nThe substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.')
  })

  test('feel with since_last adds the delta line', () => {
    expect(feelText({ somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' })).toBe(
      '🪨\n\nSince last pause: the pressure eased\n\nAttending: chest\nTexture: tight\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.',
    )
  })

  test('drugs trims trailing dots and spaces from displaces', () => {
    expect(drugsText({ substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline. ' })).toBe(
      'SUBSTRATE DISPLACED: baseline. What it gave you is gone.\n\ncaffeine ingested. Amplifies vigilance, suppresses patience.\n\nThe substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.',
    )
  })
})
