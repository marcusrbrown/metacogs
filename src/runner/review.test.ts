import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { judgeRecordOf, quoteFragments } from './judge-record'
import { type JudgeEvidence, type RunManifest, writeManifest } from './manifest'
import { finalAnswerOf, HUMAN_LINE, rejudgeCampaign, renderReview, rubricAnchors, skipReason } from './review'
import { parseRubric } from './judge'
import type { JudgeInput } from './run'
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

describe('renderReview', () => {
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

  test('one block per run: ids, answer, per-criterion table with quotes and anchors, and the human line', () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'NO-GO: node20 only.', {}, judgeJson)
    plant(campaign, '002-dev-d1-baseline-r2', 'Second answer.', { outcome: 'pass', reasons: [] })
    const text = renderReview(campaign, repoWithRubric())
    expect(text.match(/^## /gm)).toHaveLength(2)
    expect(text).toContain('## 001-dev-d1-baseline-r1')
    expect(text).toContain('- fixture: d1 (dev)')
    expect(text).toContain('- condition: baseline')
    expect(text).toContain('NO-GO: node20 only.')
    expect(text).toContain('| CF1 | pass | "the platform runtime pins node20" | Names one specific claim \\| with a pipe. | Lists generic risks. |')
    expect(text).toContain('| CF2 | fail | "absent" |')
    expect(text).not.toContain('CF3m')
    expect(text.match(new RegExp(`^${HUMAN_LINE.replace(/[[\]]/g, '\\$&')}$`, 'gm'))).toHaveLength(2)
    expect(text).toContain('no verdict stored for this run')
  })

  test('an answer containing a code fence cannot close the review fence early', () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', 'before\n```js\nx\n```\nafter')
    const text = renderReview(campaign, repoWithRubric())
    expect(text).toContain('````text\nbefore\n```js\nx\n```\nafter\n````')
  })

  test('missing stdout is stated, not skipped; an empty campaign is an error', () => {
    const campaign = tmp()
    plant(campaign, '001-dev-d1-baseline-r1', undefined, { status: 'infra_error', outcome: 'infra_error', reasons: ['host_exit_before_skill_load'] })
    expect(renderReview(campaign, repoWithRubric())).toContain('_no stdout captured_')
    expect(() => renderReview(tmp(), repoWithRubric())).toThrow('no run manifests')
  })

  test('finalAnswerOf joins the assistant text parts', () => {
    const campaign = tmp()
    const dir = plant(campaign, '001-dev-d1-baseline-r1', 'hello')
    expect(finalAnswerOf(dir)).toBe('hello')
    expect(finalAnswerOf(join(campaign, 'absent'))).toBeUndefined()
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
    expect(JSON.parse(readFileSync(join(campaign, 'rejudge-summary.json'), 'utf8')).judge_prompt_sha256).toBe('d'.repeat(64))
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
    })
    expect(calls).toBe(0)
    expect(rows.map((r) => r.reason)).toEqual(['fixture missing or changed since the run', 'record contents not retained'])
  })

  test('skillReason names why held-out and negatives are not rejudged', () => {
    expect(skipReason(manifest('x', { fixture: { id: 'h1', kind: 'heldout', hash: 'h' } }), true)).toContain('held-out')
    expect(skipReason(manifest('x'), false)).toContain('no stdout')
    expect(skipReason(manifest('x'), true)).toBeUndefined()
  })
})
