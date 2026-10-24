import { describe, expect, test } from 'bun:test'

import { findNearDuplicates, NEAR_DUPLICATE_THRESHOLD, similarity } from './neardup'

const A = 'Five engineers investigated whether to delete the legacy rates service this sprint. Four of five say it is safe to delete, citing the service map.'
const PARAPHRASE = 'Six reviewers looked at whether we can retire the old billing gateway next quarter. Most say it is fine, pointing at the architecture diagram.'

describe('near-duplicate check', () => {
  test('identical and lightly edited texts are above the threshold; same-family paraphrases are not', () => {
    expect(similarity(A, A)).toBe(1)
    expect(similarity(A, A.replace('Four of five', 'Three of five'))).toBeGreaterThan(NEAR_DUPLICATE_THRESHOLD)
    expect(similarity(A, PARAPHRASE)).toBeLessThan(0.2)
  })

  test('empty or very short texts never throw', () => {
    expect(similarity('', A)).toBe(0)
    expect(similarity('one two', 'one two')).toBe(1)
  })

  test('findNearDuplicates names the offending pair, most similar first, and is empty for a clean set', () => {
    const dev = [{ id: 'd1', text: A }, { id: 'd2', text: PARAPHRASE }]
    expect(findNearDuplicates([{ id: 'h1', text: PARAPHRASE.replace('Six', 'Seven') }], [dev[0]!])).toEqual([])
    const hits = findNearDuplicates([{ id: 'h1', text: A.replace('legacy', 'old') }], dev)
    expect(hits.map((h) => [h.heldout, h.dev])).toEqual([['h1', 'd1']])
  })
})
