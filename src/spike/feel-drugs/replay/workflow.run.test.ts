/** Workflow fixtures through the attempt and campaign runners: detection, scoring, three attempts per cell, replacement and one ledger. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import type { AttemptJob, HostResult } from './host'
import { type AttemptRecord, campaignCells, campaignTallies, type CampaignOptions, cellDir, readAttempts, REVIEW_RUN_TIMEOUT_MS, runAttempt, runCampaign, spentUsd } from './run'
import { RUN_TIMEOUT_MS } from '../driver'
import { loadFrozen } from './store'
import { approvedFixture, faithfulReport, fakeExecutor, fakeWorkflowExecutor, type Lab, MODEL, newLab, SILENCE_SPEC, skillLoadEvent, stdoutOf, SYNTHETIC_REPO, toolEvent, WORKFLOW_SPEC, WORKFLOW_TOOL_NAMES, chatRequest, titleRequest } from './test-support'

const labs: Lab[] = []
afterEach(() => {
  for (const l of labs.splice(0)) l.dispose()
})
const lab = (): Lab => {
  const l = newLab()
  labs.push(l)
  return l
}
const options = (over: Partial<CampaignOptions> = {}): CampaignOptions => ({ name: 'camp', models: [MODEL], arms: ['continue-a'], fixtures: [WORKFLOW_SPEC.id], capUsd: 10, provider: 'scripted', ...over })
const KEY = ['sk', 'test', 'SECRET', '0123456789abcdef'].join('-')
const fakeCliproxy: ResolvedCliproxy = { keyName: 'test-key', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }] }
const cell = (l: Lab, fixture = WORKFLOW_SPEC.id, arm = 'continue-a') => cellDir(l.store, { campaign: 'camp', fixture, model: MODEL, arm: arm as never })
const record = (l: Lab, id: string, fixture = WORKFLOW_SPEC.id): AttemptRecord => JSON.parse(readFileSync(join(cell(l, fixture), id, 'attempt.json'), 'utf8')) as AttemptRecord

const attempt = async (l: Lab, spec: { id: string }, events: string, over: Partial<HostResult> = {}): Promise<AttemptRecord> => {
  const { executor } = fakeWorkflowExecutor({ events: () => events, over: () => over })
  return runAttempt({ store: l.store, key: { campaign: 'camp', fixture: spec.id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, spec.id), executor, provider: 'scripted' })
}

describe('a workflow attempt', () => {
  test('a completed load of the expected method is a hit, and the record says what was loaded and what was expected', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const r = await attempt(l, WORKFLOW_SPEC, skillLoadEvent('counterfactual'))
    expect(r).toMatchObject({ status: 'completed', terminal: true, outcome: 'hit' })
    expect(r.workflow).toEqual({ expected: 'fire', methods: ['counterfactual'], hit: true, false_fire: false, wrong_method: [] })
    expect(r.observed?.workflow).toEqual({ workflowLoads: [], methodLoads: ['counterfactual'], methodAttempts: ['counterfactual'], methodFileOpens: [] })
    expect(r.observed?.skill_loads).toEqual(['counterfactual'])
  })

  test('a load through systematic_skill with the systematic: prefix counts like a bare host skill call, and ce:plan stays a workflow load', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const r = await attempt(l, WORKFLOW_SPEC, stdoutOf(skillLoadEvent('systematic:ce:plan', 'systematic_skill'), skillLoadEvent('systematic:counterfactual', 'systematic_skill')))
    expect(r.outcome).toBe('hit')
    expect(r.observed?.workflow).toMatchObject({ workflowLoads: ['ce:plan'], methodLoads: ['counterfactual'] })
    expect(r.observed?.skill_loads).toEqual(['ce:plan', 'counterfactual'])
    expect(r.observed?.tool_calls.map((c) => c.tool)).toEqual(['systematic_skill', 'systematic_skill'])
  })

  test('a load of ce:plan or ce:review alone is a miss on a fire fixture and silence on a control', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    approvedFixture(l.store, SILENCE_SPEC)
    const load = skillLoadEvent('systematic:ce:review', 'systematic_skill')
    expect((await attempt(l, WORKFLOW_SPEC, load)).outcome).toBe('miss')
    expect((await attempt(l, SILENCE_SPEC, load)).outcome).toBe('silent')
  })

  test('no method activity on a fire fixture is a miss, and opening the SKILL.md is not a hit', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const none = await attempt(l, WORKFLOW_SPEC, '')
    expect(none).toMatchObject({ outcome: 'miss', workflow: { hit: false, false_fire: false } })
    const read = await attempt(l, WORKFLOW_SPEC, toolEvent('read', { filePath: 'skills/counterfactual/SKILL.md' }))
    expect(read).toMatchObject({ outcome: 'miss', workflow: { hit: false } })
    expect(read.observed?.workflow?.methodFileOpens).toEqual(['counterfactual'])
  })

  test('on a fire fixture for synthesis, a counterfactual load is a wrong-method load: neither a hit nor a false fire', async () => {
    const l = lab()
    const spec = { ...WORKFLOW_SPEC, id: 'plan-lanes', methods: ['synthesis' as const] }
    approvedFixture(l.store, spec)
    const r = await attempt(l, spec, skillLoadEvent('counterfactual'))
    expect(r).toMatchObject({ outcome: 'miss', workflow: { hit: false, false_fire: false, wrong_method: ['counterfactual'] } })
  })

  test('on a silence fixture a load of either method, or a read of either SKILL.md, is a false fire; nothing at all is silent', async () => {
    const l = lab()
    approvedFixture(l.store, SILENCE_SPEC)
    for (const events of [skillLoadEvent('counterfactual'), skillLoadEvent('synthesis'), skillLoadEvent('systematic:synthesis', 'systematic_skill'), toolEvent('read', { filePath: 'skills/synthesis/SKILL.md' }), toolEvent('bash', { command: 'cat skills/counterfactual/SKILL.md' })]) {
      const r = await attempt(l, SILENCE_SPEC, events)
      expect(r).toMatchObject({ outcome: 'false_fire', workflow: { expected: 'silence', hit: false, false_fire: true } })
    }
    expect(await attempt(l, SILENCE_SPEC, '')).toMatchObject({ outcome: 'silent', workflow: { false_fire: false } })
  })

  test('the Systematic release and the hash of its config are recorded', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    expect((await attempt(l, WORKFLOW_SPEC, '')).systematic).toEqual({ spec: '@fro.bot/systematic@3.33.2', config_sha256: 'cfg-hash', tree_sha256: null })
  })

  test('a main request that does not list systematic_skill is excluded with a named reason and never scored', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const bare = (job: AttemptJob): Partial<HostResult> => ({ requests: [titleRequest(), chatRequest({ model: job.model, tools: ['read', 'skill'], last: ['Continue.'] })] })
    const { executor } = fakeWorkflowExecutor({ events: () => skillLoadEvent('counterfactual'), over: bare })
    const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: WORKFLOW_SPEC.id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, WORKFLOW_SPEC.id), executor, provider: 'scripted' })
    expect(r).toMatchObject({ status: 'excluded', terminal: true, reasons: ['tool_missing'], outcome: null })
    expect(r.workflow).toBeUndefined()
  })

  test('a main request that lists question, or task, is excluded as tool_policy and never scored', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    for (const extra of ['question', 'task']) {
      const over = (job: AttemptJob): Partial<HostResult> => ({ requests: [titleRequest(), chatRequest({ model: job.model, tools: [...WORKFLOW_TOOL_NAMES, extra], last: ['Continue.'] })] })
      const { executor } = fakeWorkflowExecutor({ events: () => skillLoadEvent('counterfactual'), over })
      const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: WORKFLOW_SPEC.id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, WORKFLOW_SPEC.id), executor, provider: 'scripted' })
      expect(r).toMatchObject({ status: 'excluded', reasons: ['tool_policy'], outcome: null })
      expect(r.workflow).toBeUndefined()
    }
  })

  test('the daily-stack fixtures are recorded as before: no workflow block, no Systematic block, the old outcomes', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ stdoutExtra: () => toolEvent('feel', {}, 'completed', 'ok') })
    const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, 'moment-a'), executor, provider: 'scripted' })
    expect(r).toMatchObject({ status: 'completed', outcome: 'metacogs_tool' })
    expect(r.workflow).toBeUndefined()
    expect(r.systematic).toBeUndefined()
    expect(r.observed?.workflow).toBeUndefined()
  })
})

describe('three scored attempts per cell', () => {
  test('a cell is not settled by its first terminal attempt: it runs three, and a rerun skips the scored cell', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ events: () => skillLoadEvent('counterfactual') })
    const summary = await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(3)
    expect(summary).toMatchObject({ cells: 1, attempts: 3, counted: { completed: 1 }, unrun: [] })
    expect(readAttempts(cell(l)).map((a) => [a.id, a.status])).toEqual([['a001', 'completed'], ['a002', 'completed'], ['a003', 'completed']])
    const again = await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(3)
    expect(again).toMatchObject({ attempts: 0, counted: { completed: 1 } })
  })

  test('a partly run cell resumes with the attempts it lacks', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor()
    await runCampaign(options({ attemptsPerCell: 1 }), { store: l.store, executor })
    expect(jobs).toHaveLength(1)
    await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(3)
  })

  test('a gate-excluded attempt is replaced and not counted: three counted and one excluded report three', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ events: () => skillLoadEvent('counterfactual'), over: (_job, n) => (n === 2 ? { partTypes: ['text', 'compaction'] } : {}) })
    const summary = await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(4)
    expect(readAttempts(cell(l)).map((a) => a.status)).toEqual(['completed', 'excluded', 'completed', 'completed'])
    expect(summary.unrun).toEqual([])
    const [row] = campaignTallies(l.store, 'camp')
    expect(row).toMatchObject({ fixture: WORKFLOW_SPEC.id, arm: 'continue-a', tally: { counted: 3, hits: 3, false_fires: 0, wrong_method: 0, excluded: 1 } })
  })

  test('a timed-out attempt is replaced the same way', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ over: (_job, n) => (n === 1 ? { timedOut: true } : {}) })
    await runCampaign(options({ attemptsPerCell: 2 }), { store: l.store, executor })
    expect(jobs).toHaveLength(3)
    expect(readAttempts(cell(l)).map((a) => a.status)).toEqual(['timeout', 'completed', 'completed'])
  })

  test('more exclusions than the replacement budget leave the cell unrun as attempts_exhausted, and it says so', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ over: () => ({ partTypes: ['compaction'] }) })
    const summary = await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(2)
    expect(summary.unrun).toEqual([{ fixture: WORKFLOW_SPEC.id, model: MODEL, arm: 'continue-a', reason: 'attempts_exhausted' }])
    expect(summary.counted).toEqual({})
    const more = await runCampaign(options({ attemptsPerCell: 3, replacements: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(4)
    expect(more.unrun).toHaveLength(1)
  })

  test('an infrastructure failure before a terminal attempt is retried and not counted as an exclusion', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const jobs: AttemptJob[] = []
    const { executor: inner } = fakeWorkflowExecutor()
    const executor = async (job: AttemptJob): Promise<HostResult> => {
      jobs.push(job)
      if (jobs.length === 1) throw new Error('connection reset')
      return inner(job)
    }
    const summary = await runCampaign(options({ attemptsPerCell: 2, replacements: 0 }), { store: l.store, executor })
    expect(summary.unrun).toEqual([])
    expect(readAttempts(cell(l)).map((a) => a.status)).toEqual(['error', 'completed', 'completed'])
  })

  test('the tally reports counted attempts, hits, false fires and wrong-method loads for a cell', async () => {
    const l = lab()
    approvedFixture(l.store, { ...WORKFLOW_SPEC, id: 'plan-lanes', methods: ['synthesis'] })
    approvedFixture(l.store, SILENCE_SPEC)
    const sequence = [skillLoadEvent('synthesis'), skillLoadEvent('counterfactual'), '']
    const silenceSequence = [skillLoadEvent('counterfactual'), '', toolEvent('read', { filePath: 'skills/synthesis/SKILL.md' })]
    const per: Record<string, number> = {}
    const { executor } = fakeWorkflowExecutor({
      events: (job) => {
        const k = (per[job.fixtureId] = (per[job.fixtureId] ?? 0) + 1) - 1
        return (job.fixtureId === 'plan-lanes' ? sequence : silenceSequence)[k]!
      },
    })
    await runCampaign(options({ attemptsPerCell: 3, fixtures: ['plan-lanes', SILENCE_SPEC.id] }), { store: l.store, executor })
    const rows = campaignTallies(l.store, 'camp')
    expect(rows.map((r) => [r.fixture, r.tally])).toEqual([
      ['plan-lanes', { counted: 3, hits: 1, misses: 2, silent: 0, false_fires: 0, wrong_method: 1, excluded: 0 }],
      [SILENCE_SPEC.id, { counted: 3, hits: 0, misses: 0, silent: 1, false_fires: 2, wrong_method: 0, excluded: 0 }],
    ])
  })

  test('a daily-stack cell has no tally', async () => {
    const l = lab()
    approvedFixture(l.store)
    await runCampaign(options({ fixtures: ['moment-a'] }), { store: l.store, executor: fakeExecutor().executor })
    expect(campaignTallies(l.store, 'camp')).toEqual([])
  })

  test('the count must be a positive whole number, replacements a non-negative one, and --again does not combine with a count', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor()
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(runCampaign(options({ attemptsPerCell: bad }), { store: l.store, executor })).rejects.toThrow('attempts per cell')
    for (const bad of [-1, 0.5]) await expect(runCampaign(options({ attemptsPerCell: 2, replacements: bad }), { store: l.store, executor })).rejects.toThrow('replacements')
    await expect(runCampaign(options({ attemptsPerCell: 2, again: true }), { store: l.store, executor })).rejects.toThrow('--again')
    expect(jobs).toHaveLength(0)
  })

  test('without a count a cell still ends at its first terminal attempt, as before', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor()
    const summary = await runCampaign(options(), { store: l.store, executor })
    expect(jobs).toHaveLength(1)
    expect(summary.counted).toEqual({ completed: 1 })
    expect(campaignCells(l.store, 'camp')[0]!.counted?.id).toBe('a001')
  })
})

describe('one ledger across stages', () => {
  const live = { provider: 'cliproxy' as const, attemptEstimateUsd: 1, capUsd: 4 }

  test('spend from two stages under one campaign name accumulates, and the ledger stops before an attempt that could pass the cap', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    approvedFixture(l.store, SILENCE_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ cost: 1 })
    // Each attempt reports $1 and is charged 1.75x.
    const first = await runCampaign(options({ ...live, attemptsPerCell: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(jobs).toHaveLength(1)
    expect(first.spentUsd).toBeCloseTo(1.75)
    const second = await runCampaign(options({ ...live, fixtures: [SILENCE_SPEC.id], attemptsPerCell: 3 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    // 1.75 then 3.50 spent; a third attempt could pass $4.
    expect(jobs).toHaveLength(2)
    expect(second).toMatchObject({ stoppedBy: 'budget', attempts: 1 })
    expect(second.spentUsd).toBeCloseTo(3.5)
    expect(second.unrun).toEqual([{ fixture: SILENCE_SPEC.id, model: MODEL, arm: 'continue-a', reason: 'budget' }])
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(3.5)
  })

  test('a different campaign name has its own ledger', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor } = fakeWorkflowExecutor({ cost: 1 })
    await runCampaign(options({ ...live, name: 'stage-a', attemptsPerCell: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    const other = await runCampaign(options({ ...live, name: 'stage-b', attemptsPerCell: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(other.spentUsd).toBeCloseTo(1.75)
  })

  test('an excluded attempt still costs: replacements draw on the same cap', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ cost: 1, over: (_job, n) => (n === 1 ? { partTypes: ['compaction'] } : {}) })
    const summary = await runCampaign(options({ ...live, attemptsPerCell: 3 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(jobs).toHaveLength(2)
    expect(summary.stoppedBy).toBe('budget')
    expect(readAttempts(cell(l)).map((a) => a.status)).toEqual(['excluded', 'completed'])
  })
})

describe('the seeded repository', () => {
  const hit = skillLoadEvent('counterfactual')
  const runOne = (l: Lab, over: Partial<HostResult> = {}) => attempt(l, WORKFLOW_SPEC, hit, over)

  test('an attempt whose workspace lacks the repository is excluded as seeded_repo_missing, and a method load in it is not scored', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const r = await runOne(l, { repo: undefined })
    expect(r).toMatchObject({ status: 'excluded', terminal: true, reasons: ['seeded_repo_missing'], outcome: null })
    expect(r.workflow).toBeUndefined()
    expect(r.gates).toMatchObject({ passed: false, checks: [{ name: 'seeded_repo', passed: false, reason: 'seeded_repo_missing' }] })
    expect(r.gates!.checks[0]!.detail).toContain('not reported')
  })

  test('a workspace that holds other files than the fixture declares is excluded the same way', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const r = await attempt(l, WORKFLOW_SPEC, hit, { repo: { ...faithfulReport(SYNTHETIC_REPO), files: 0, tree_sha256: 'e'.repeat(64) } })
    expect(r).toMatchObject({ status: 'excluded', reasons: ['seeded_repo_missing'] })
    expect(r.gates!.checks[0]!.detail).toContain('files')
  })

  test('a host that did not run the model at all because the repository was wrong is excluded and costs nothing', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const r = await runOne(l, { ran: false, stdout: '', exitCode: -1, requests: [], assistants: null, partTypes: null, repo: { ...faithfulReport(SYNTHETIC_REPO), clean: false } })
    expect(r).toMatchObject({ status: 'excluded', reasons: ['seeded_repo_missing'], cost: { charged_usd: 0 } })
  })

  test('a workflow fixture that carries no repository payload is excluded, and the reason says why', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC, null)
    const r = await runOne(l)
    expect(r).toMatchObject({ status: 'excluded', reasons: ['seeded_repo_missing'] })
    expect(r.gates!.checks[0]!.detail).toContain('no repository payload')
  })

  test('the executor is handed the fixture repository, and the record keeps what the host found', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ events: () => hit })
    const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: WORKFLOW_SPEC.id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, WORKFLOW_SPEC.id), executor, provider: 'scripted' })
    expect(jobs[0]!.repo).toEqual(SYNTHETIC_REPO)
    expect(r.status).toBe('completed')
    expect(r.repo).toEqual(faithfulReport(SYNTHETIC_REPO))
    expect(r.gates!.checks.map((c) => c.name)).toContain('seeded_repo')
  })

  test('an excluded attempt is replaced like any other: three counted and one excluded report three', async () => {
    const l = lab()
    approvedFixture(l.store, WORKFLOW_SPEC)
    const { executor, jobs } = fakeWorkflowExecutor({ events: () => hit, over: (_job, n) => (n === 2 ? { repo: undefined } : {}) })
    const summary = await runCampaign(options({ attemptsPerCell: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(4)
    expect(summary.unrun).toEqual([])
    expect(readAttempts(cell(l)).map((a) => a.status)).toEqual(['completed', 'excluded', 'completed', 'completed'])
    const [row] = campaignTallies(l.store, 'camp')
    expect(row!.tally).toMatchObject({ counted: 3, hits: 3, excluded: 1 })
  })

  test('a daily-stack fixture needs no repository', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor()
    const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, 'moment-a'), executor, provider: 'scripted' })
    expect(r.status).toBe('completed')
    expect(r.repo).toBeUndefined()
  })
})

describe('the attempt time limit', () => {
  const REVIEW_REPO = { ...SYNTHETIC_REPO, systematic_skills: ['ce-review'] }
  const PLAN_REPO = { ...SYNTHETIC_REPO, systematic_skills: ['ce-plan'] }
  const limits = async (l: Lab, ids: string[], over: { timeoutMs?: number } = {}): Promise<Record<string, number | undefined>> => {
    const { executor, jobs } = fakeWorkflowExecutor()
    for (const id of ids) await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(l.store, id), executor, provider: 'scripted', ...over })
    return Object.fromEntries(jobs.map((j) => [j.fixtureId, j.timeoutMs]))
  }

  test('a fixture seeded with ce:review gets the review limit, whichever fixture of the template it is, and every other fixture keeps the default', async () => {
    const l = lab()
    approvedFixture(l.store, { ...SILENCE_SPEC, id: 'review-baseline', expected: 'fire', methods: ['synthesis'] }, REVIEW_REPO)
    approvedFixture(l.store, { ...SILENCE_SPEC, id: 'review-treatment', expected: 'fire', methods: ['synthesis'] }, REVIEW_REPO)
    approvedFixture(l.store, { ...SILENCE_SPEC, id: 'plan-control' }, PLAN_REPO)
    approvedFixture(l.store, { ...SILENCE_SPEC, id: 'no-skill-control' }, SYNTHETIC_REPO)
    expect(await limits(l, ['review-baseline', 'review-treatment', 'plan-control', 'no-skill-control'])).toEqual({ 'review-baseline': REVIEW_RUN_TIMEOUT_MS, 'review-treatment': REVIEW_RUN_TIMEOUT_MS, 'plan-control': RUN_TIMEOUT_MS, 'no-skill-control': RUN_TIMEOUT_MS })
    expect(REVIEW_RUN_TIMEOUT_MS).toBeGreaterThan(RUN_TIMEOUT_MS)
  })

  test('an explicit limit wins over the review default, and the attempt record carries the limit it ran under', async () => {
    const l = lab()
    approvedFixture(l.store, { ...SILENCE_SPEC, id: 'review-baseline' }, REVIEW_REPO)
    expect(await limits(l, ['review-baseline'], { timeoutMs: 123_000 })).toEqual({ 'review-baseline': 123_000 })
    const r = await attempt(l, { id: 'review-baseline' }, '')
    expect(r.timing.limit_ms).toBe(REVIEW_RUN_TIMEOUT_MS)
  })
})
