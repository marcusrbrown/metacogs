import { describe, expect, test } from 'bun:test'

import { countWords, isOverLimit } from './word-limit'

describe('countWords', () => {
  test('splits on any run of whitespace', () => {
    expect(countWords('one two  three\tfour\nfive\r\n six')).toBe(6)
  })

  test('leading and trailing whitespace add nothing; empty and blank text are 0', () => {
    expect(countWords('  padded  ')).toBe(1)
    expect(countWords('')).toBe(0)
    expect(countWords(' \n\t ')).toBe(0)
  })

  test('punctuation and hyphens do not split words', () => {
    expect(countWords('well-known, e.g. node:sqlite.')).toBe(3)
  })
})

describe('isOverLimit', () => {
  test('inclusive: the limit itself is within it', () => {
    expect(isOverLimit(250, 250)).toBe(false)
    expect(isOverLimit(251, 250)).toBe(true)
    expect(isOverLimit(0, 1)).toBe(false)
  })
})
