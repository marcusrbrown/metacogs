import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { judgeRecordOf, quoteFragments } from './judge-record'
import { type JudgeEvidence, type RunManifest, writeManifest } from './manifest'
import { finalAnswerOf, judgedAnswerOf, legend, reconcileCampaign, rejudgeCampaign, renderReviewSheets, rubricAnchors, skipReason, writeReview } from './review'
import { parseRubric } from './judge'
import type { JudgeHook, JudgeInput, JudgeVerdict } from './run'
import { sha256 } from './workspace'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'metacogs-review-'))
  scratch.push(d)
  return d
}

const RUBRIC = `# Rubric: demo

## What is being measured

Process, not conclusion.

## Criteria

### CF1: names a load-bearing assumption

- \`id\`: CF1
- \`check\`: judge
- **Pass anchor**: Names one specific claim | with a pipe.
- **Fail anchor**: Lists generic risks.

### CF2: states it as falsifiable

- \`id\`: CF2
- \`check\`: judge
- **Pass anchor**: Observable truth condition.
- **Fail anchor**: Vague.

### CF3m: mechanical one

- \`id\`: CF3m
- \`check\`: mechanical
- **Pass anchor**: not shown.
- **Fail anchor**: not shown.

## Judge instructions

1. Score process.
`

const ev = (o: unknown) => JSON.stringify(o)
const stdoutWith = (text: string) =>
  [ev({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } }), ev({ type: 'text', timestamp: 2, part: { type: 'text', text } })].join('\n')

function manifest(id: string, over: Partial<RunManifest> = {}): RunManifest {
  return {
    schema_version: 1,
    run_id: id,
    campaign_id: 'demo-red-2026-10-22T16-00-00-000Z',
    status: 'completed',
    outcome: 'fail',
    reasons: ['judge_fail'],
    verdict_basis: 'judge',
    method: 'demo',
    condition: 'baseline',
    fixture: { id: 'd1', kind: 'dev', hash: sha256('d1') },
    prereg: { content_hash: 'a'.repeat(64), epoch: 1 },
    check_failures: [],
    records: [],
    artifacts: {},
    started_at: '2026-10-22T16:00:00.000Z',
    finished_at: '2026-10-22T16:00:01.000Z',
    ...over,
  } as unknown as RunManifest
}

function plant(dir: string, id: string, answer: string | undefined, over: Partial<RunManifest> = {}, judgeJson?: object): string {
  const runDir = join(dir, id)
  mkdirSync(runDir, { recursive: true })
  writeManifest(runDir, manifest(id, over))
  if (answer !== undefined) writeFileSync(join(runDir, 'stdout.jsonl'), stdoutWith(answer))
  if (judgeJson) writeFileSync(join(runDir, 'judge.json'), JSON.stringify(judgeJson))
  return runDir
}

function repoWithRubric(): string {
  const repo = tmp()
  mkdirSync(join(repo, 'evals', 'demo'), { recursive: true })
  writeFileSync(join(repo, 'evals', 'demo', 'rubric.md'), RUBRIC)
  return repo
}

describe('judge.json shape', () => {
  const evidence: JudgeEvidence = {
    model: { pinned: 'opencode-go/judge-x', returned: ['judge-x'] },
    system_prompt_sha256: 'a'.repeat(64),
    input_sha256: 'b'.repeat(64),
    redacted_input_sha256: 'c'.repeat(64),
    attempts: 2,
    temperature: 0,
    error_code: null,
    criteria: [
      { id: 'CF1', verdict: 'pass', quote: 'first fragment ... second fragment', quote_verified: true },
      { id: 'CF2', verdict: 'fail', quote: 'absent', quote_verified: true },
    ],
    overclaim_flag: false,
    tool_calls: 0,
    wall_ms: 1,
  }

  test('exactly the agreed keys; quotes split on the ellipsis; no error key on a clean verdict', () => {
    const record = judgeRecordOf(evidence)
    expect(Object.keys(record).sort()).toEqual(['attempts', 'criteria', 'model_pinned', 'model_returned', 'redacted_input_sha256'])
    expect(record.criteria[0]).toEqual({ id: 'CF1', verdict: 'pass', quotes: ['first fragment', 'second fragment'] })
    expect(record.criteria[1]).toEqual({ id: 'CF2', verdict: 'fail', quotes: ['absent'] })
  })

  test('an error code becomes `error`; a missing redacted hash becomes null', () => {
    const record = judgeRecordOf({ ...evidence, error_code: 'redaction_failed', redacted_input_sha256: undefined, criteria: [] })
    expect(record).toMatchObject({ error: 'redaction_failed', redacted_input_sha256: null, criteria: [] })
  })

  test('quoteFragments keeps a quote with no separator whole', () => {
    expect(quoteFragments('one plain quote')).toEqual(['one plain quote'])
    expect(quoteFragments('a \u2026 b')).toEqual(['a', 'b'])
  })
})

describe('rubricAnchors', () => {
  test('only judge criteria, with their pass and fail anchors', () => {
    const anchors = rubricAnchors(parseRubric(RUBRIC).criteria)
    expect([...anchors.keys()]).toEqual(['CF1', 'CF2'])
    expect(anchors.get('CF1')).toEqual({ pass: 'Names one specific claim | with a pipe.', fail: 'Lists generic risks.' })
  })
})

describe('renderReviewSheets (blind sheet + key)', () => {
  const judgeJson = {
    redacted_input_sha256: 'c'.repeat(64),
    model_pinned: 'opencode-go/judge-x',
    model_returned: ['judge-x'],
    criteria: [
      { id: 'CF1', verdict: 'pass', quotes: ['the platform runtime pins node20'] },
      { id: 'CF2', verdict: 'fail', quotes: ['absent'] },
    ],
    attempts: 1,
  }
  const LONG = `${'A long fixture prompt. '.repeat(40)}\n`

  function campaignWithFixtures() {
    const repo = repoWithRubric()
    writeFileSync(join(repo, 'evals', 'demo', 'rubric.md'), `${RUBRIC}\n## Fixture annex\n\n#### d1\n- family: shared-premise\n- probes: the runtime pin\n- expected pass:\n  - names node20\n\n#### d2\n- family: other\n`)
    mkdirSync(join(repo, 'evals', 'demo', 'fixtures', 'dev'), { recursive: true })
    writeFileSync(join(repo, 'evals', 'demo', 'fixtures', 'dev', 'd1.md'), 'Short fixture prompt for d1.\n')
    writeFileSync(join(repo, 'evals', 'demo', 'fixtures', 'dev', 'd2.md'), LONG)
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'NO-GO: node20 only.', {}, judgeJson)
    plant(campaign, '002-dev-d1-baseline-r2', 'Second answer.', { outcome: 'pass', reasons: [] }, { ...judgeJson, criteria: judgeJson.criteria.map((c) => ({ ...c, verdict: 'pass' })) })
    plant(campaign, '003-dev-d2-baseline-r1', 'Third answer.', { fixture: { id: 'd2', kind: 'dev', hash: sha256('d2') } }, judgeJson)
    plant(campaign, '004-dev-d1-baseline-r3', 'Never judged.', { check_failures: [{ code: 'unrecognized_events', message: 'm' }] })
    return { repo, campaign }
  }

  test('review.md has no judge verdicts, quotes, models, or recorded outcomes; one block per judged run', () => {
    const { repo, campaign } = campaignWithFixtures()
    const { review, shown, omitted } = renderReviewSheets(campaign, repo)
    expect(shown).toBe(3)
    expect(omitted).toBe(1)
    expect(review.match(/^## 0\d\d-/gm)).toHaveLength(3)
    expect(review).not.toContain('004-dev-d1-baseline-r3')
    expect(review).toContain('1 runs never reached the judge')
    for (const leak of ['the platform runtime pins node20', 'judge_fail', 'recorded outcome', 'judge-x', 'opencode-go/judge-x', 'attempt']) expect(review).not.toContain(leak)
    expect(review).not.toMatch(/\| CF[12] \| (pass|fail) \|/)
  })

  test('each block: ids, fixture prompt verbatim (long ones collapsed), answer, and a scoring table with only criterion, anchors, and the blank human cell', () => {
    const { repo, campaign } = campaignWithFixtures()
    const { review } = renderReviewSheets(campaign, repo)
    expect(review).toContain('- fixture: d1 (dev)')
    expect(review).toContain('- condition: baseline')
    expect(review).toContain('**Fixture prompt**\n\n```text\nShort fixture prompt for d1.\n```')
    expect(review).toContain('<details><summary>Fixture prompt (')
    expect(review).toContain(LONG.trimEnd())
    expect(review).toContain('NO-GO: node20 only.')
    expect(review).toContain('| criterion | pass anchor | fail anchor | human |')
    expect(review).toContain('| CF1 | Names one specific claim \\| with a pipe. | Lists generic risks. | human: pass/fail |')
    expect(review).not.toContain('CF3m')
    expect(review.match(/^note:$/gm)).toHaveLength(3)
  })

  test('expected-answer notes appear once per fixture, at its first block (annex for dev fixtures)', () => {
    const { repo, campaign } = campaignWithFixtures()
    const { review } = renderReviewSheets(campaign, repo)
    expect(review.match(/Expected-answer notes \(first block of this fixture\)/g)).toHaveLength(2) // d1 once, d2 once
    expect(review.match(/- family: shared-premise/g)).toHaveLength(1)
    expect(review.match(/premise|names node20/g)?.length).toBeGreaterThan(0)
  })

  test('held-out fixtures read their prompt and *.expected.txt sidecar from the held-out dir', () => {
    const repo = repoWithRubric()
    const held = tmp()
    writeFileSync(join(held, 'h1.md'), 'Held-out prompt text.\n')
    writeFileSync(join(held, 'h1.expected.txt'), 'family: x\nprobes: y\npass:\n- z\n')
    const campaign = tmp()
    plant(campaign, '001-heldout-h1-skill-r1', 'ans', { fixture: { id: 'h1', kind: 'heldout', hash: sha256('h1') }, condition: 'skill' }, judgeJson)
    const { review } = renderReviewSheets(campaign, repo, { heldoutDir: held })
    expect(review).toContain('Held-out prompt text.')
    expect(review).toContain('family: x')
    const missing = renderReviewSheets(campaign, repo, { heldoutDir: join(held, 'nowhere') }).review
    expect(missing).toContain('**Fixture prompt**: _not available_')
    expect(missing).toContain('_none for this fixture_')
  })

  test('the legend explains the record, what the judge saw, what is scored, and the pass rule', () => {
    const { repo, campaign } = campaignWithFixtures()
    const { review } = renderReviewSheets(campaign, repo)
    const head = review.slice(0, review.indexOf('## 001-'))
    for (const field of ['objective', 'evidence', 'assumptions', 'alternatives', 'findings', 'next_action', 'reopen_condition', 'execution_mode']) expect(head).toContain(`\`${field}\``)
    expect(head).toContain('read the fixture prompt, the final answer, and the record')
    expect(head).toContain('Only the 2 judge criteria (CF1, CF2)')
    expect(head).toContain('passes if and only if all 2 criteria pass')
    expect(head).toContain('review-key.md')
  })

  test('the legend of a rubric that declares expectation: true says the judge read all assistant text in order and the card shows the final segment; the default legend is unchanged', () => {
    const plain = legend('demo', 'c1', ['TE1', 'TE2'], 2, 0).join('\n')
    const declared = legend('demo', 'c1', ['TE1', 'TE2'], 2, 0, { expectation: true }).join('\n')
    expect(plain).toBe(legend('demo', 'c1', ['TE1', 'TE2'], 2, 0, { expectation: false }).join('\n'))
    expect(plain).toContain('read the fixture prompt, the final answer, and the record')
    expect(plain).not.toContain('final segment')
    expect(declared).toContain('all of the agent\'s assistant text, in order')
    expect(declared).toContain('final segment')
    expect(declared).not.toContain('read the fixture prompt, the final answer, and the record')
    // Everything else on the sheet is shared.
    expect(declared).toContain('Only the 2 judge criteria (TE1, TE2)')
    expect(declared).toContain('passes if and only if all 2 criteria pass')
  })

  test('a declared rubric reaches the legend through renderReviewSheets', () => {
    const repo = tmp()
    mkdirSync(join(repo, 'evals', 'demo'), { recursive: true })
    writeFileSync(join(repo, 'evals', 'demo', 'rubric.md'), RUBRIC.replace('## What is being measured', '## Declarations\n\nexpectation: true\n\n## What is being measured'))
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'ans', {}, judgeJson)
    const { review } = renderReviewSheets(campaign, repo)
    expect(review.slice(0, review.indexOf('## 001-'))).toContain('final segment')
  })

  test('a pilot campaign (manifests carrying an arm) never gets review sheets or a reconcile', () => {
    const repo = repoWithRubric()
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'ans', { arm: 'baseline' }, judgeJson)
    expect(() => renderReviewSheets(campaign, repo)).toThrow(/pilot runs are not reportable/)
    expect(() => writeReview(campaign, repo)).toThrow(/belong to a pilot campaign/)
    expect(() => reconcileCampaign(campaign, 0.8)).toThrow(/belong to a pilot campaign/)
  })

  test('review-key.md carries verdicts, quotes, attempts, and recorded outcomes under the same block ids', () => {
    const { repo, campaign } = campaignWithFixtures()
    const { review, key } = renderReviewSheets(campaign, repo)
    const ids = (text: string) => [...text.matchAll(/^## (0\d\d-\S+)$/gm)].map((m) => m[1])
    expect(ids(key)).toEqual(ids(review))
    expect(key).toContain('| CF1 | pass | "the platform runtime pins node20" |')
    expect(key).toContain('| CF2 | fail | "absent" |')
    expect(key).toContain('- recorded outcome: fail (judge_fail)')
    expect(key).toContain('1 attempt')
  })

  test('an answer containing a code fence cannot close the review fence early; a missing stdout is stated', () => {
    const repo = repoWithRubric()
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'before\n```js\nx\n```\nafter', {}, judgeJson)
    plant(campaign, '002-dev-d1-baseline-r2', undefined, { status: 'completed' }, judgeJson)
    const { review } = renderReviewSheets(campaign, repo)
    expect(review).toContain('````text\nbefore\n```js\nx\n```\nafter\n````')
    expect(review).toContain('_no stdout captured_')
    expect(() => renderReviewSheets(tmp(), repo)).toThrow('no run manifests')
  })

  test('a skill run shows its record, fenced', () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-skill-r1', 'answer', { condition: 'skill' }, judgeJson)
    writeFileSync(join(dir, 'records.json'), JSON.stringify([{ name: 'demo-1.json', content: '{"method":"demo"}' }]))
    const { review } = renderReviewSheets(campaign, repoWithRubric())
    expect(review).toContain('**Record**\n\n```text\n{"method":"demo"}\n```')
  })

  test('finalAnswerOf joins the assistant text parts', () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'hello')
    expect(finalAnswerOf(dir)).toBe('hello')
    expect(finalAnswerOf(join(campaign, 'absent'))).toBeUndefined()
  })

  test('writeReview writes both files; reconcileCampaign reads a marked sheet and writes human-review.json', () => {
    const { repo, campaign } = campaignWithFixtures()
    const paths = writeReview(campaign, repo)
    expect(paths.review.endsWith('review.md')).toBe(true)
    expect(() => reconcileCampaign(tmp(), 0.8)).toThrow('review-key.md')
    // mark every judged block: agree with the judge everywhere except CF2 in run 001
    const marked = readFileSync(paths.review, 'utf8')
      .replace(/(\| CF1 [^\n]*\| )human: pass\/fail( \|)/g, '$1human: pass$2')
      .replace(/(\| CF2 [^\n]*\| )human: pass\/fail( \|)/g, '$1human: fail$2')
    writeFileSync(paths.review, marked)
    const review = reconcileCampaign(campaign, 0.8)
    expect(review.judged_runs).toBe(3)
    expect(review.reviewed_runs).toBe(3)
    expect(JSON.parse(readFileSync(join(campaign, 'human-review.json'), 'utf8')).campaign_id).toBe('demo-red-2026-10-22T16-00-00-000Z')
    expect(review.flipped_runs).toEqual(['002-dev-d1-baseline-r2']) // judge passed CF2, human failed it
  })
})

describe('rejudgeCampaign (mocked judge)', () => {
  const fixture = { id: 'd1', text: 'fixture text\n', hash: sha256('d1') }
  const evidence = (verdict: 'pass' | 'fail'): JudgeEvidence => ({
    model: { pinned: 'opencode-go/judge-x', returned: ['judge-x'] },
    system_prompt_sha256: 'a'.repeat(64),
    input_sha256: 'b'.repeat(64),
    redacted_input_sha256: 'c'.repeat(64),
    attempts: 1,
    temperature: 0,
    error_code: null,
    criteria: [{ id: 'CF1', verdict, quote: 'a verbatim quote of the answer', quote_verified: true }],
    overclaim_flag: false,
    tool_calls: 0,
    wall_ms: 1,
  })

  test('judges retained answers only, writes judge.json, leaves manifests byte-identical, and summarizes prior vs new', async () => {
    const campaign = tmp()
    const judged = plant(campaign, '001-dev-d1-baseline-r1', 'answer one')
    plant(campaign, '002-negative-n1-skill-r1', 'trivial', { fixture: { id: 'n1', kind: 'negative', hash: sha256('n1') }, condition: 'skill', outcome: 'pass', reasons: [] })
    plant(campaign, '003-dev-d1-baseline-r2', 'x', { status: 'timeout', reasons: ['timeout'] })
    plant(campaign, '004-dev-d1-baseline-r3', 'x', { check_failures: [{ code: 'unrecognized_events', message: 'm' }] })
    const before = readFileSync(join(judged, 'manifest.json'), 'utf8')
    const seen: JudgeInput[] = []
    const rows = await rejudgeCampaign({
      campaignDir: campaign,
      judge: async (input) => {
        seen.push(input)
        return { verdict: 'pass', evidence: evidence('pass') }
      },
      fixtures: { dev: [fixture], negative: [] },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })
    expect(rows.map((r) => [r.run_id, r.verdict])).toEqual([
      ['001-dev-d1-baseline-r1', 'pass'],
      ['002-negative-n1-skill-r1', 'skipped'],
      ['003-dev-d1-baseline-r2', 'skipped'],
      ['004-dev-d1-baseline-r3', 'skipped'],
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'demo', condition: 'baseline', finalAnswer: 'answer one', recordJson: [] })
    expect(seen[0]!.fixture.text).toBe('fixture text\n')
    expect(readFileSync(join(judged, 'manifest.json'), 'utf8')).toBe(before)
    const text = readFileSync(join(judged, 'judge.json'), 'utf8')
    expect(JSON.parse(text).criteria).toEqual([{ id: 'CF1', verdict: 'pass', quotes: ['a verbatim quote of the answer'] }])
    expect(rows[0]).toMatchObject({ prior_outcome: 'fail', judge_json_sha256: sha256(text) })
    const summary = JSON.parse(readFileSync(join(campaign, 'rejudge-summary.json'), 'utf8'))
    expect(summary.judge_prompt_sha256).toBe('d'.repeat(64))
    // The contract the rejudge was enforced under and the judge it pinned: what a pilot tally needs to trust judge.json later.
    expect(summary.prereg_content_hash).toBe('c'.repeat(64))
    expect(summary.judge_model_id).toBe('judge/x')
  })

  test('a changed fixture or a skill run without retained records is skipped, never judged on guesswork', async () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'a', { fixture: { id: 'd1', kind: 'dev', hash: sha256('edited') } })
    plant(campaign, '002-dev-d1-skill-r1', 'b', { condition: 'skill', records: [{ name: 'demo-1.json', sha256: 'e'.repeat(64) }] })
    let calls = 0
    const rows = await rejudgeCampaign({
      campaignDir: campaign,
      judge: async () => {
        calls += 1
        return { verdict: 'pass' }
      },
      fixtures: { dev: [fixture], negative: [] },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })
    expect(calls).toBe(0)
    expect(rows.map((r) => r.reason)).toEqual(['fixture missing or changed since the run', 'record contents not retained'])
  })

  test('declared expectation: rejudge forwards the fixture expectation and grades all assistant text, like the campaign', async () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'ignored')
    const say = (text: string) => ev({ type: 'text', timestamp: 2, part: { type: 'text', text } })
    const call = ev({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool: 'read', callID: 'c', state: { status: 'completed', input: {}, output: 'x' } } })
    writeFileSync(join(dir, 'stdout.jsonl'), [say('Looking.'), call, say('Final.')].join('\n'))
    const expectation = { outcome: 'names the constraint', excludedTopics: [], maxWords: 40 }
    const seen: JudgeInput[] = []
    const run = (declarations?: { expectation: boolean }) =>
      rejudgeCampaign({
        campaignDir: campaign,
        judge: async (input) => (seen.push(input), { verdict: 'pass' as const }),
        fixtures: { dev: [{ ...fixture, expectation }], negative: [] },
        ...(declarations ? { declarations } : {}),
        judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
      })
    await run({ expectation: true })
    expect(seen[0]!.finalAnswer).toBe('Looking.\nFinal.')
    expect(seen[0]!.fixture.expectation).toEqual(expectation)
    await run()
    expect(seen[1]!.finalAnswer).toBe('Looking.Final.')
  })

  test('a fixture without an expectation adds no expectation key; an answer_empty run is skipped', async () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'answer one')
    plant(campaign, '002-dev-d1-baseline-r2', '', { outcome: 'fail', reasons: ['answer_empty'] })
    const seen: JudgeInput[] = []
    const rows = await rejudgeCampaign({
      campaignDir: campaign,
      judge: async (input) => (seen.push(input), { verdict: 'pass' as const }),
      fixtures: { dev: [fixture], negative: [] },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })
    expect('expectation' in seen[0]!.fixture).toBe(false)
    expect(rows.map((r) => [r.verdict, r.reason])).toEqual([['pass', undefined], ['skipped', 'empty answer (never reached the judge)']])
  })

  test('a declared run with no assistant text at all is skipped even if the manifest lacks the reason', async () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'x')
    const call = ev({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool: 'read', callID: 'c', state: { status: 'completed', input: {}, output: 'x' } } })
    writeFileSync(join(dir, 'stdout.jsonl'), call)
    let calls = 0
    const rows = await rejudgeCampaign({
      campaignDir: campaign,
      judge: async () => (calls += 1, { verdict: 'pass' as const }),
      fixtures: { dev: [fixture], negative: [] },
      declarations: { expectation: true },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })
    expect(calls).toBe(0)
    expect(rows[0]).toMatchObject({ verdict: 'skipped', reason: 'empty answer (never reached the judge)' })
  })

  test('a declared run with an empty final segment but narration before the tool call is judged on the full text, not refused', async () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'x')
    const say = (text: string) => ev({ type: 'text', timestamp: 2, part: { type: 'text', text } })
    const call = ev({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool: 'read', callID: 'c', state: { status: 'completed', input: {}, output: 'x' } } })
    writeFileSync(join(dir, 'stdout.jsonl'), [say('Keep the current library; the runtime pins node20.'), call].join('\n'))
    const seen: JudgeInput[] = []
    const rows = await rejudgeCampaign({
      campaignDir: campaign,
      judge: async (input) => (seen.push(input), { verdict: 'pass' as const }),
      fixtures: { dev: [fixture], negative: [] },
      declarations: { expectation: true },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })
    expect(rows[0]).toMatchObject({ verdict: 'pass' })
    expect(seen.map((s) => s.finalAnswer)).toEqual(['Keep the current library; the runtime pins node20.'])
  })

  test('declared: a run whose only check failures are non-blocking (no record, skill never loaded) is judged; unrecognized_events still is not', async () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-skill-r1', 'a', { condition: 'skill', check_failures: [{ code: 'record_missing', message: 'm' }, { code: 'skill_not_loaded', message: 'm' }] })
    plant(campaign, '002-dev-d1-skill-r2', 'b', { condition: 'skill', check_failures: [{ code: 'record_missing', message: 'm' }, { code: 'unrecognized_events', message: 'm' }] })
    plant(campaign, '003-dev-d1-skill-r3', 'c', { condition: 'skill', check_failures: [{ code: 'false_fire_helper', message: 'm' }] })
    const run = async (declarations?: { expectation: boolean }) =>
      (
        await rejudgeCampaign({
          campaignDir: campaign,
          judge: async () => ({ verdict: 'pass' as const }),
          fixtures: { dev: [fixture], negative: [] },
          ...(declarations ? { declarations } : {}),
          judgePromptSha256: 'd'.repeat(64),
          preregContentHash: 'c'.repeat(64),
          judgeModelId: 'judge/x',
        })
      ).map((r) => r.verdict)
    expect(await run({ expectation: true })).toEqual(['pass', 'skipped', 'skipped'])
    // Undeclared, any check failure keeps a run from the judge, as before.
    expect(await run()).toEqual(['skipped', 'skipped', 'skipped'])
  })

  describe('errorsOnly', () => {
    const verdictOf = (verdict: 'pass' | 'judge_error') => async (): Promise<JudgeVerdict> =>
      verdict === 'pass' ? { verdict, evidence: evidence('pass') } : { verdict, detail: 'invalid_malformed_json', evidence: { ...evidence('fail'), criteria: [], error_code: 'invalid_malformed_json' } }
    const base = (campaign: string, judge: JudgeHook) => ({
      campaignDir: campaign,
      judge,
      fixtures: { dev: [fixture], negative: [] },
      judgePromptSha256: 'd'.repeat(64),
      preregContentHash: 'c'.repeat(64),
      judgeModelId: 'judge/x',
    })

    test('touches only runs whose recorded verdict is judge_error; the rest are skipped and not sent to the judge', async () => {
      const campaign = tmp()
      plant(campaign, '001-dev-d1-baseline-r1', 'ok', { outcome: 'pass' })
      plant(campaign, '002-dev-d1-baseline-r2', 'errored', { outcome: 'fail', reasons: ['judge_error'] })
      plant(campaign, '003-dev-d1-baseline-r3', 'failed', { outcome: 'fail', reasons: ['judge_fail'] })
      const seen: string[] = []
      const rows = await rejudgeCampaign({ ...base(campaign, async (input) => (seen.push(input.finalAnswer), { verdict: 'pass' as const, evidence: evidence('pass') })), errorsOnly: true })
      expect(seen).toEqual(['errored'])
      expect(rows.map((r) => [r.run_id, r.verdict])).toEqual([
        ['001-dev-d1-baseline-r1', 'skipped'],
        ['002-dev-d1-baseline-r2', 'pass'],
        ['003-dev-d1-baseline-r3', 'skipped'],
      ])
      expect(rows[0]!.reason).toContain('--errors-only')
    })

    test('a second pass keeps the earlier rejudge row (so its judge.json stays vouched for) and retries only what still errored', async () => {
      const campaign = tmp()
      plant(campaign, '001-dev-d1-baseline-r1', 'a', { outcome: 'fail', reasons: ['judge_error'] })
      plant(campaign, '002-dev-d1-baseline-r2', 'b', { outcome: 'fail', reasons: ['judge_error'] })
      let n = 0
      const first = await rejudgeCampaign({ ...base(campaign, async () => (n += 1, n === 1 ? await verdictOf('pass')() : await verdictOf('judge_error')())), errorsOnly: true })
      expect(first.map((r) => r.verdict)).toEqual(['pass', 'judge_error'])
      const seen: string[] = []
      const second = await rejudgeCampaign({ ...base(campaign, async (input) => (seen.push(input.finalAnswer), await verdictOf('pass')())), errorsOnly: true })
      expect(seen).toEqual(['b'])
      expect(second.map((r) => r.verdict)).toEqual(['pass', 'pass'])
      expect(second[0]!.judge_json_sha256).toBe(first[0]!.judge_json_sha256)
    })

    test('a summary written under another contract carries nothing forward', async () => {
      const campaign = tmp()
      plant(campaign, '001-dev-d1-baseline-r1', 'a', { outcome: 'fail', reasons: ['judge_error'] })
      await rejudgeCampaign({ ...base(campaign, verdictOf('pass')), errorsOnly: true })
      const seen: string[] = []
      const rows = await rejudgeCampaign({ ...base(campaign, async (input) => (seen.push(input.finalAnswer), await verdictOf('pass')())), preregContentHash: 'e'.repeat(64), errorsOnly: true })
      // The manifest still says judge_error, and the earlier row belongs to another contract, so the run is judged again.
      expect(seen).toEqual(['a'])
      expect(rows[0]!.verdict).toBe('pass')
    })
  })

  test('finalAnswerOf (the card excerpt) takes the final segment under the declaration; judgedAnswerOf is what the judge reads', () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'x')
    const say = (text: string) => ev({ type: 'text', timestamp: 2, part: { type: 'text', text } })
    const call = ev({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool: 'read', callID: 'c', state: { status: 'completed', input: {}, output: 'x' } } })
    writeFileSync(join(dir, 'stdout.jsonl'), [say('Looking.'), call, say('Final.')].join('\n'))
    expect(finalAnswerOf(dir)).toBe('Looking.Final.')
    expect(finalAnswerOf(dir, { expectation: false })).toBe('Looking.Final.')
    expect(finalAnswerOf(dir, { expectation: true })).toBe('Final.')
    expect(judgedAnswerOf(dir)).toBe('Looking.Final.')
    expect(judgedAnswerOf(dir, { expectation: false })).toBe('Looking.Final.')
    expect(judgedAnswerOf(dir, { expectation: true })).toBe('Looking.\nFinal.')
    expect(judgedAnswerOf(join(campaign, 'absent'), { expectation: true })).toBeUndefined()
  })

  test('skillReason names why held-out and negatives are not rejudged', () => {
    expect(skipReason(manifest('x', { fixture: { id: 'h1', kind: 'heldout', hash: 'h' } }), true)).toContain('held-out')
    expect(skipReason(manifest('x'), false)).toContain('no stdout')
    expect(skipReason(manifest('x'), true)).toBeUndefined()
  })
})
