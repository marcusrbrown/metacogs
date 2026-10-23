import { describe, expect, test } from 'bun:test'

import { cohenKappa, humanReviewBlock, parseHumanMarks, parseKey, reconcile } from './human-review'

const row = (id: string, mark: string) => `| ${id} | pass anchor \\| with pipe | fail anchor | ${mark} |`
const sheetBlock = (runId: string, marks: Record<string, string>) =>
  [`## ${runId}`, '', '- fixture: h1 (heldout)', '', ...Object.entries(marks).map(([id, m]) => row(id, m)), '', 'note: whatever', ''].join('\n')
const keyBlock = (runId: string, fixture: string, kind: string, condition: string, verdicts: Record<string, string>) =>
  [`## ${runId}`, '', `- fixture: ${fixture} (${kind})`, `- condition: ${condition}`, '- recorded outcome: pass', '', '| criterion | judge | quotes |', '| --- | --- | --- |', ...Object.entries(verdicts).map(([id, v]) => `| ${id} | ${v} | "q" |`), ''].join('\n')

const BLANK = 'human: pass/fail'

describe('parsing', () => {
  test('only `human: pass` and `human: fail` count; the blank template, free text, and other tables do not', () => {
    const text = [
      sheetBlock('001-heldout-h1-skill-r1', { SY1: 'human: pass', SY2: 'human: FAIL', SY3: BLANK, SY4: 'human:', SY5: 'human: maybe' }),
      '| SY1 | not a block row | human: pass |',
    ].join('\n')
    const marks = parseHumanMarks(text).get('001-heldout-h1-skill-r1')!
    expect([...marks]).toEqual([['SY1', 'pass'], ['SY2', 'fail']])
  })

  test('the key yields judge verdicts per block; blocks without a table or header are skipped', () => {
    const key = [keyBlock('001-heldout-h1-skill-r1', 'h1', 'heldout', 'skill', { SY1: 'pass', SY2: 'fail' }), '## 002-x\n\n_no per-criterion verdicts stored (judge_error)_\n'].join('\n')
    expect(parseKey(key)).toEqual([{ run_id: '001-heldout-h1-skill-r1', fixture_id: 'h1', fixture_kind: 'heldout', condition: 'skill', judge: { SY1: 'pass', SY2: 'fail' } }])
  })
})

describe('cohenKappa', () => {
  test('undefined unless both labels occur for both raters; otherwise the usual statistic', () => {
    expect(cohenKappa([['pass', 'pass'], ['pass', 'pass']])).toBeUndefined()
    expect(cohenKappa([['pass', 'pass'], ['fail', 'pass']])).toBeUndefined()
    expect(cohenKappa([['pass', 'pass'], ['fail', 'fail'], ['pass', 'pass'], ['fail', 'fail']])).toBe(1)
    expect(cohenKappa([['pass', 'fail'], ['fail', 'pass']])).toBe(-1)
    expect(cohenKappa([['pass', 'pass'], ['pass', 'pass'], ['fail', 'pass'], ['fail', 'fail']])).toBe(0.5)
  })
})

describe('reconcile (mocked sheets)', () => {
  const ids = ['SY1', 'SY2', 'SY3']
  const allPass = Object.fromEntries(ids.map((i) => [i, 'pass']))
  const key = [
    keyBlock('001-heldout-h1-skill-r1', 'h1', 'heldout', 'skill', allPass),
    keyBlock('002-heldout-h1-skill-r2', 'h1', 'heldout', 'skill', { ...allPass, SY3: 'fail' }),
    keyBlock('003-heldout-h1-baseline-r1', 'h1', 'heldout', 'baseline', { ...allPass, SY1: 'fail' }),
    keyBlock('004-heldout-h2-skill-r1', 'h2', 'heldout', 'skill', allPass),
  ].join('\n')
  const input = (review: string, floor = 0.8) => ({ reviewText: review, keyText: key, campaignId: 'demo-green-2026-10-23T00-00-00-000Z', method: 'demo', agreementFloor: floor })
  const hp = (id: string) => `human: ${id}`

  test('full agreement: every criterion at 1.0, no flips, nothing demoted', () => {
    const review = reconcile(input([
      sheetBlock('001-heldout-h1-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('pass') }),
      sheetBlock('002-heldout-h1-skill-r2', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
      sheetBlock('003-heldout-h1-baseline-r1', { SY1: hp('fail'), SY2: hp('pass'), SY3: hp('pass') }),
      sheetBlock('004-heldout-h2-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('pass') }),
    ].join('\n')))
    expect(review).toMatchObject({ judged_runs: 4, reviewed_runs: 4, flipped_runs: [], demoted_criteria: [] })
    expect(review.criteria.SY1).toMatchObject({ n: 4, agree: 4, rate: 1, demoted: false })
    expect(review.runs.map((r) => r.human_outcome)).toEqual(['pass', 'fail', 'fail', 'pass'])
  })

  test('disagreements: per-criterion rate, run flips, and a sub-floor criterion demoted so it no longer gates the run', () => {
    // SY3: the human fails runs the judge passed (001, 004) → 2 of 4 agree = 0.5 < 0.8 → advisory.
    const review = reconcile(input([
      sheetBlock('001-heldout-h1-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
      sheetBlock('002-heldout-h1-skill-r2', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
      sheetBlock('003-heldout-h1-baseline-r1', { SY1: hp('fail'), SY2: hp('pass'), SY3: hp('pass') }),
      sheetBlock('004-heldout-h2-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
    ].join('\n')))
    expect(review.criteria.SY3).toMatchObject({ n: 4, agree: 2, rate: 0.5, demoted: true })
    expect(review.criteria.SY1).toMatchObject({ rate: 1, demoted: false })
    expect(review.demoted_criteria).toEqual(['SY3'])
    expect(review.flipped_runs).toEqual(['001-heldout-h1-skill-r1', '004-heldout-h2-skill-r1'])
    expect(review.runs[0]).toMatchObject({ judge_outcome: 'pass', human_outcome: 'fail', disagreements: ['SY3'], effective_outcome: 'pass' })
    // run 002: judge failed SY3, human agrees, but SY3 is advisory → effective pass
    expect(review.runs[1]).toMatchObject({ judge_outcome: 'fail', human_outcome: 'fail', effective_outcome: 'pass' })
    expect(review.runs[2]).toMatchObject({ effective_outcome: 'fail' }) // SY1 still gates
  })

  test('partially or un-marked blocks count as judged, not reviewed; the judge verdict stands for their unmarked criteria', () => {
    const review = reconcile(input([sheetBlock('001-heldout-h1-skill-r1', { SY1: hp('pass'), SY2: BLANK, SY3: BLANK })].join('\n')))
    expect(review).toMatchObject({ judged_runs: 4, reviewed_runs: 0, flipped_runs: [] })
    expect(review.criteria.SY1).toMatchObject({ n: 1, agree: 1 })
    expect(review.criteria.SY2).toBeUndefined()
    expect(review.runs[0]).toMatchObject({ human_outcome: null, effective_outcome: 'pass' })
  })

  test('the GREEN block: pending with no marks; otherwise agreement, flips, and a verdict recomputed with the same bars', () => {
    const bars = { skill_pooled_pass_min: 3, skill_per_fixture_pass_min: 1, baseline_pooled_pass_max: 1 }
    const fixed = { negatives_silent: true, dev_regression: true, near_duplicate: true }
    const none = humanReviewBlock(reconcile(input('')), bars, fixed, ['h1', 'h2'])
    expect(none).toEqual({ status: 'pending', judged_runs: 4, reviewed: 0 })

    const marked = reconcile(input([
      sheetBlock('001-heldout-h1-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('pass') }),
      sheetBlock('002-heldout-h1-skill-r2', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
      sheetBlock('003-heldout-h1-baseline-r1', { SY1: hp('fail'), SY2: hp('pass'), SY3: hp('pass') }),
      sheetBlock('004-heldout-h2-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('fail') }),
    ].join('\n')))
    // skill: 001 pass, 002 fail (SY3 judge+human fail, SY3 agreement 3/4 = 0.75 < 0.8 → advisory → effective pass), 004 human fail SY3 → advisory → pass
    const block = humanReviewBlock(marked, bars, fixed, ['h1', 'h2'])
    expect(block.status).toBe('complete')
    expect(block.demoted_criteria).toEqual(['SY3'])
    expect(block.recomputed).toMatchObject({ skill_pooled_pass: 3, baseline_pooled_pass: 0, per_fixture_skill_pass: { h1: 2, h2: 1 }, verdict: 'green' })
    const strict = humanReviewBlock(marked, { ...bars, skill_pooled_pass_min: 4 }, fixed, ['h1', 'h2'])
    expect(strict.recomputed).toMatchObject({ checks: { skill_pooled: false }, verdict: 'green-miss' })
    // checks the review cannot change still gate
    expect(humanReviewBlock(marked, bars, { ...fixed, near_duplicate: false }, ['h1', 'h2']).recomputed?.verdict).toBe('green-miss')
    const partial = humanReviewBlock(reconcile(input(sheetBlock('001-heldout-h1-skill-r1', { SY1: hp('pass'), SY2: hp('pass'), SY3: hp('pass') }))), bars, fixed, ['h1', 'h2'])
    expect(partial).toMatchObject({ status: 'partial', judged_runs: 4, reviewed: 1 })
  })
})
