import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JudgeEvidence, MANIFEST_SCHEMA_VERSION, type RunManifest, writeManifest } from './manifest'
import {
  bucketOf,
  buildDevReport,
  buildRedReport,
  type DevReport,
  devReportPath,
  loadCampaignManifests,
  type RedReport,
  reportPath,
  validateDevReport,
  validateReport,
  wilson95,
  writeDevReport,
  writeReport,
} from './report'
import { parsePrereg, type Prereg, type PreregShas, RUN_OUTCOME_TAXONOMY } from './prereg'
import { sha256 } from './workspace'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

const HEAD = 'a'.repeat(40)
const SHAS: PreregShas = {
  tag: 'prereg/demo/2',
  tagObjectSha: 'b'.repeat(40),
  commitSha: 'c'.repeat(40),
  blobSha: 'd'.repeat(40),
  firstSkillCommit: null,
  skillTreeSha: null,
}

function prereg(): Prereg {
  return {
    schema_version: 1,
    method: 'demo',
    epoch: 2,
    prev_epoch_closing_commit: 'e'.repeat(40),
    salt: 's',
    fixture_hashes: { dev: { 'd1-x': sha256('1'), 'd2-y': sha256('2') }, negative: { 'n1-z': sha256('3') }, heldout: {} },
    rubric_hash: sha256('rubric'),
    runs_per_condition: 5,
    red_bar: { min_baseline_fails_per_fixture: 4, min_fixtures: 2 },
    green_bar: { skill_pooled_pass_min: 17, skill_per_fixture_pass_min: 3, baseline_pooled_pass_max: 10 },
    false_fire_max: 0,
    per_run_timeout_ms: 180_000,
    budget: { max_tool_calls: 20, max_total_tokens: 300_000 },
    infra_error_definition: 'Provider or host outage before skill content loads.',
    run_outcome_taxonomy: [...RUN_OUTCOME_TAXONOMY],
    agreement_floor: 0.8,
    agent_model_id: 'opencode/big-pickle',
    judge_model_id: 'opencode/judge-model-x',
    accepted_error_rates: { false_red: 0.3, false_green: 0.2 },
    metadata: { source_url: 'synthetic', licence: 'MIT' },
  }
}

type Outcome = 'pass' | 'judge_fail' | 'judge_error' | 'timeout' | 'budget' | 'host_crash' | 'check' | 'infra' | 'non_isolated' | 'running'

function judgeEvidence(verdicts: Record<string, 'pass' | 'fail'>, error: string | null = null): JudgeEvidence {
  return {
    model: { pinned: 'opencode/judge-model-x', returned: ['judge-model-x'] },
    system_prompt_sha256: sha256('prompt'),
    input_sha256: sha256('input'),
    attempts: 1,
    temperature: 0,
    error_code: error,
    criteria: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict, quote: verdict === 'fail' && id === 'CF2' ? 'absent' : 'a quoted passage of the answer', quote_verified: true })),
    overclaim_flag: false,
    tool_calls: 0,
    wall_ms: 100,
  }
}

function manifestFor(seq: number, kind: 'dev' | 'negative', fixture: string, index: number, outcome: Outcome): RunManifest {
  const base = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: `${String(seq).padStart(3, '0')}-${kind}-${fixture}-baseline-r${index}`,
    campaign_id: 'demo-red-2026-10-22T16-00-00-000Z',
    reasons: [] as string[],
    verdict_basis: 'judge' as const,
    method: 'demo',
    condition: 'baseline' as const,
    fixture: { id: fixture, kind, hash: sha256(fixture) },
    attempt: 1,
    skill: null,
    prereg: { tag: SHAS.tag, tag_object_sha: SHAS.tagObjectSha, commit_sha: SHAS.commitSha, blob_sha: SHAS.blobSha, epoch: 2 },
    provider_mode: 'live' as const,
    opencode: { package: 'opencode-ai', version: '1.19.4' },
    model: { pinned: 'opencode/big-pickle', returned: ['big-pickle'] },
    isolation: null,
    config: { path: '/secret/config/path.json', sha256: sha256('cfg') },
    usage: { input: 100, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    wall_clock_ms: 1000,
    tool_call_count: 1,
    host_errors: [],
    records: [],
    check_failures: [],
    artifacts: { 'stdout.jsonl': { file: 'stdout.jsonl', sha256: sha256(`stdout-${seq}`), bytes: 10 } },
    started_at: '2026-10-22T16:00:00.000Z',
    finished_at: '2026-10-22T16:00:30.000Z',
  }
  const m = base as unknown as RunManifest
  switch (outcome) {
    case 'pass':
      return { ...m, status: 'completed', outcome: 'pass', judge: judgeEvidence({ CF1: 'pass', CF2: 'pass' }) }
    case 'judge_fail':
      return { ...m, status: 'completed', outcome: 'fail', reasons: ['judge_fail'], judge: judgeEvidence({ CF1: 'pass', CF2: 'fail', CF3: 'fail' }) }
    case 'judge_error':
      return { ...m, status: 'completed', outcome: 'fail', reasons: ['judge_error'], judge: { ...judgeEvidence({}, 'invalid_malformed_json') } }
    case 'timeout':
      return { ...m, status: 'timeout', outcome: 'fail', reasons: ['timeout'] }
    case 'budget':
      return { ...m, status: 'budget_exceeded', outcome: 'fail', reasons: ['budget_tool_calls'] }
    case 'host_crash':
      return { ...m, status: 'host_crash', outcome: 'fail', reasons: ['host_exit_after_skill_load'] }
    case 'check':
      return { ...m, status: 'completed', outcome: 'fail', reasons: ['unrecognized_events'], verdict_basis: 'deterministic' }
    case 'infra':
      return { ...m, status: 'infra_error', outcome: 'infra_error', reasons: ['host_exit_before_skill_load'] }
    case 'non_isolated':
      return { ...m, status: 'non_isolated', outcome: 'non_isolated', reasons: ['x'] }
    case 'running':
      return { ...m, status: 'running', finished_at: null }
  }
}

function campaign(plan: [kind: 'dev' | 'negative', fixture: string, outcomes: Outcome[]][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-report-'))
  scratch.push(dir)
  let seq = 0
  for (const [kind, fixture, outcomes] of plan) {
    outcomes.forEach((outcome, i) => {
      seq += 1
      const m = manifestFor(seq, kind, fixture, i + 1, outcome)
      const runDir = join(dir, m.run_id)
      mkdirSync(runDir)
      writeManifest(runDir, m)
    })
  }
  return dir
}

const reportFor = (dir: string, plannedRuns = 99): RedReport =>
  buildRedReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs: loadCampaignManifests(dir), plannedRuns })

describe('wilson95', () => {
  test('known values', () => {
    expect(wilson95(5, 5)).toEqual([0.5655, 1])
    expect(wilson95(0, 5)).toEqual([0, 0.4345])
    expect(wilson95(4, 5)).toEqual([0.3755, 0.9638])
    expect(wilson95(3, 10)[0]).toBeCloseTo(0.1078, 3)
  })
  test('no trials: the vacuous interval', () => {
    expect(wilson95(0, 0)).toEqual([0, 1])
  })
})

describe('bucketOf', () => {
  test.each([
    ['pass', 'pass'],
    ['judge_fail', 'fail_judge_verdict'],
    ['judge_error', 'fail_judge_error'],
    ['timeout', 'fail_timeout'],
    ['budget', 'fail_budget'],
    ['host_crash', 'fail_host_crash'],
    ['check', 'fail_check'],
    ['infra', 'infra_error'],
    ['non_isolated', 'non_isolated'],
    ['running', 'incomplete'],
  ] as const)('%s → %s', (outcome, bucket) => {
    expect(bucketOf(manifestFor(1, 'dev', 'd1-x', 1, outcome))).toBe(bucket)
  })
})

describe('buildRedReport', () => {
  const dir = campaign([
    ['dev', 'd1-x', ['judge_fail', 'judge_fail', 'judge_fail', 'judge_fail', 'pass']],
    ['dev', 'd2-y', ['judge_fail', 'timeout', 'judge_error', 'judge_fail', 'infra']],
    ['negative', 'n1-z', ['pass', 'pass', 'check', 'non_isolated', 'running']],
  ])
  const report = reportFor(dir, 15)
  const fx = (id: string) => report.fixtures.find((f) => f.id === id)!

  test('per-fixture fail/total, interval, and RED-bar verdict', () => {
    expect(fx('d1-x')).toMatchObject({ attempted: 5, pass: 1, fail: 4, fail_over_total: '4/5', fail_rate_wilson95: [0.3755, 0.9638], meets_red_bar: true })
    expect(fx('d2-y')).toMatchObject({ attempted: 4, fail: 4, fail_over_total: '4/4', meets_red_bar: true })
  })

  test('taxonomy tallies: timeouts, judge_error, infra_error and non_isolated are separate and outside the pass/fail denominator where specified', () => {
    expect(fx('d2-y').taxonomy).toEqual({ pass: 0, fail: 2, 'timeout->fail': 1, 'budget->fail': 0, 'judge_error->fail': 1, infra_error: 1, non_isolated: 0 })
    expect(fx('d2-y').outcomes.infra_error).toBe(1)
    expect(fx('d2-y').attempted).toBe(4)
    expect(fx('n1-z')).toMatchObject({ attempted: 3, pass: 2, fail: 1, meets_red_bar: false })
    expect(fx('n1-z').outcomes.non_isolated).toBe(1)
    expect(report.campaign).toMatchObject({ planned_runs: 15, executed_manifests: 15, incomplete_manifests: 1 })
  })

  test('negatives never count toward the RED bar', () => {
    expect(report.red.dev_fixtures_meeting_bar).toBe(2)
    expect(report.red.green_eligible).toBe(true)
  })

  test('sensitivity: removing judge_error runs can flip a fixture below the bar', () => {
    expect(fx('d2-y').fail_excluding_judge_error).toEqual({ fail: 3, attempted: 3, meets_red_bar: false })
    expect(report.red.sensitivity_excluding_judge_error).toEqual({ dev_fixtures_meeting_bar: 1, green_eligible: false })
  })

  test('criterion verdict tallies separate quoted fails from absent fails', () => {
    expect(fx('d1-x').criteria.CF2).toEqual({ pass: 1, fail_quoted: 0, fail_absent: 4 })
    expect(fx('d1-x').criteria.CF3).toEqual({ pass: 0, fail_quoted: 4, fail_absent: 0 })
  })

  test('retained failure artifacts are hashes only', () => {
    expect(fx('d1-x').retained).toHaveLength(4)
    for (const r of fx('d1-x').retained) {
      expect(r.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.stdout_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('judge and model identity are recorded', () => {
    expect(report.models).toEqual({ agent_pinned: 'opencode/big-pickle', agent_returned: ['big-pickle'], judge_pinned: 'opencode/judge-model-x', judge_returned: ['judge-model-x'], gateways: [] })
    expect(report.judge).toMatchObject({ judge_error_runs: 1, temperature_observed: [0] })
    expect(report.judge.system_prompt_sha256).toEqual([sha256('prompt')])
    expect(report.prereg).toMatchObject({ tag: 'prereg/demo/2', epoch: 2 })
  })

  test('refuses a skill-condition manifest', () => {
    const d = campaign([['dev', 'd1-x', ['pass']]])
    const m = loadCampaignManifests(d)
    m[0]!.manifest.condition = 'skill'
    expect(() => buildRedReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs: m, plannedRuns: 1 })).toThrow('baseline')
  })
})

describe('allowlist projection', () => {
  const dir = campaign([
    ['dev', 'd1-x', ['judge_fail', 'pass', 'timeout', 'judge_error', 'infra']],
    ['negative', 'n1-z', ['pass']],
  ])
  const report = reportFor(dir)

  test('a built report validates', () => {
    expect(validateReport(report)).toEqual([])
  })

  test('nothing from the manifests that could leak ends up in the serialized report', () => {
    const text = JSON.stringify(report)
    expect(text).not.toContain('/secret/config/path.json')
    expect(text).not.toContain('a quoted passage of the answer')
    expect(text).not.toMatch(/stdout\.jsonl|stderr|"env"|"config"|\/tmp|\/var\/|\/Users\//)
  })

  test.each([
    ['an extra top-level key', (r: Record<string, unknown>) => (r.stdout = 'x'), 'stdout: key is not in the allowlist'],
    ['an extra nested key', (r: Record<string, any>) => (r.campaign.dir = 'x'), 'campaign.dir: key is not in the allowlist'],
    ['an extra key inside a fixture', (r: Record<string, any>) => (r.fixtures[0].transcript = 'x'), 'fixtures[0].transcript: key is not in the allowlist'],
    ['a path where a hash belongs', (r: Record<string, any>) => (r.fixtures[0].retained[0].stdout_sha256 = '/tmp/run/stdout.jsonl'), 'allowlisted pattern'],
    ['a path-shaped model id', (r: Record<string, any>) => (r.models.agent_returned = ['/etc/passwd']), 'allowlisted pattern'],
    ['a missing key', (r: Record<string, any>) => delete r.red, 'red: missing'],
    ['a non-integer count', (r: Record<string, any>) => (r.totals.attempted = 1.5), 'non-negative integer'],
    ['a free-text criterion key', (r: Record<string, any>) => (r.fixtures[0].criteria['quote: hello'] = { pass: 1, fail_quoted: 0, fail_absent: 0 }), 'key is not in the allowlist'],
  ])('rejects %s', (_name, mutate, expected) => {
    const copy = structuredClone(report) as unknown as Record<string, unknown>
    mutate(copy)
    expect(validateReport(copy).join('\n')).toContain(expected)
  })

  test('writeReport validates, then writes stable JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'metacogs-reportroot-'))
    scratch.push(root)
    const path = writeReport(root, report)
    expect(path).toBe(reportPath(root, 'demo'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)))
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true)
    const bad = { ...report, leak: 'x' } as unknown as RedReport
    expect(() => writeReport(root, bad)).toThrow('allowlist')
  })
})

describe('committed reports', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..')
  for (const method of ['counterfactual', 'synthesis']) {
    test(`evals/reports/${method}/red.json is allowlist-only and names the epoch-2 prereg tag`, () => {
      const path = reportPath(REPO_ROOT, method)
      expect(existsSync(path)).toBe(true) // generated by `bun run eval report`
      const report = JSON.parse(readFileSync(path, 'utf8')) as RedReport
      expect(validateReport(report)).toEqual([])
      expect(report.method).toBe(method)
      expect(report.prereg.tag).toBe(`prereg/${method}/2`)
      const prereg = parsePrereg(readFileSync(join(REPO_ROOT, 'evals', method, 'prereg.json'), 'utf8'))
      expect(prereg.ok && prereg.prereg.judge_model_id).toBe(`${report.models.judge_pinned}`)
    })
  }
})

describe('buildDevReport (skill condition, dev + negative fixtures)', () => {
  const SKILL = sha256('skill-tree')
  const asSkillRun = (m: RunManifest, kind: 'dev' | 'negative'): { manifest: RunManifest; manifestSha256: string } => ({
    manifest: {
      ...m,
      condition: 'skill',
      campaign_id: 'demo-dev-2026-10-22T16-00-00-000Z',
      run_id: m.run_id.replace('-baseline-', '-skill-'),
      skill: { sha256: SKILL, tree_sha: null },
      fixture: { ...m.fixture, kind },
    },
    manifestSha256: sha256(m.run_id),
  })
  const runsFor = (plan: [kind: 'dev' | 'negative', fixture: string, outcomes: Outcome[]][]) => {
    let seq = 0
    return plan.flatMap(([kind, fixture, outcomes]) => outcomes.map((o, i) => asSkillRun(manifestFor((seq += 1), kind, fixture, i + 1, o), kind)))
  }
  const build = (plan: [kind: 'dev' | 'negative', fixture: string, outcomes: Outcome[]][], skillSha256 = SKILL) =>
    buildDevReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs: runsFor(plan), plannedRuns: 99, skillSha256 })

  test('the dev bar is 4/5 per dev fixture and no negative false fire; the report is allowlist-valid and names held-out as untouched', () => {
    const report = build([
      ['dev', 'd1-x', ['pass', 'pass', 'pass', 'pass', 'judge_fail']],
      ['dev', 'd2-y', ['pass', 'pass', 'pass', 'pass', 'pass']],
      ['negative', 'n1-z', ['pass', 'pass', 'pass', 'pass', 'pass']],
    ])
    expect(validateDevReport(report)).toEqual([])
    expect(report.held_out).toBe('untouched')
    expect(report.fixtures.map((f) => [f.id, f.pass_over_total, f.meets_dev_bar])).toEqual([
      ['d1-x', '4/5', true],
      ['d2-y', '5/5', true],
      ['n1-z', '5/5', true],
    ])
    expect(report.dev).toEqual({
      dev_fixtures: 2,
      dev_fixtures_meeting_bar: 2,
      negative_fixtures: 1,
      negative_false_fires: 0,
      fire_basis: { skill_tool: 0, direct_read: 0, none: 10 },
      passes_dev_bar: true,
    })
  })

  test('fire_basis is tallied per fixture and summed over dev fixtures; infra_error attempts are not counted', () => {
    const runs = runsFor([
      ['dev', 'd1-x', ['pass', 'pass', 'pass', 'infra', 'judge_fail']],
      ['dev', 'd2-y', ['pass', 'pass']],
      ['negative', 'n1-z', ['pass']],
    ])
    const bases = ['skill_tool', 'direct_read', 'direct_read', 'skill_tool', null, 'skill_tool', null, null] as const
    runs.forEach((r, i) => {
      r.manifest.fire_basis = bases[i]
    })
    const report = buildDevReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs, plannedRuns: 8, skillSha256: SKILL })
    expect(validateDevReport(report)).toEqual([])
    expect(report.fixtures.map((f) => f.fire_basis)).toEqual([
      { skill_tool: 1, direct_read: 2, none: 1 },
      { skill_tool: 1, direct_read: 0, none: 1 },
      { skill_tool: 0, direct_read: 0, none: 1 },
    ])
    expect(report.dev.fire_basis).toEqual({ skill_tool: 2, direct_read: 2, none: 2 })
  })

  test('3/5 on a dev fixture, or one false fire on a negative, fails the dev bar', () => {
    const slow = build([
      ['dev', 'd1-x', ['pass', 'pass', 'pass', 'judge_fail', 'judge_fail']],
      ['negative', 'n1-z', ['pass', 'pass', 'pass', 'pass', 'pass']],
    ])
    expect(slow.fixtures[0]!.meets_dev_bar).toBe(false)
    expect(slow.dev.passes_dev_bar).toBe(false)
    const fires = build([
      ['dev', 'd1-x', ['pass', 'pass', 'pass', 'pass', 'pass']],
      ['negative', 'n1-z', ['pass', 'pass', 'check', 'pass', 'pass']],
    ])
    expect(fires.dev.negative_false_fires).toBe(1)
    expect(fires.dev.passes_dev_bar).toBe(false)
  })

  test('timeouts and judge_error are failures; infra_error is outside the denominator', () => {
    const report = build([
      ['dev', 'd1-x', ['pass', 'timeout', 'judge_error', 'infra', 'pass', 'pass']],
      ['negative', 'n1-z', ['pass']],
    ])
    const d1 = report.fixtures[0]!
    expect([d1.pass_over_total, d1.outcomes.fail_timeout, d1.outcomes.fail_judge_error, d1.outcomes.infra_error]).toEqual(['3/5', 1, 1, 1])
  })

  test('a campaign that ran a different skill than the one checked out is refused', () => {
    expect(() => build([['dev', 'd1-x', ['pass']]], sha256('edited-since'))).toThrow('different skill')
  })

  test('baseline manifests are refused', () => {
    const baseline = { manifest: manifestFor(1, 'dev', 'd1-x', 1, 'pass'), manifestSha256: sha256('x') }
    expect(() => buildDevReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs: [baseline], plannedRuns: 1, skillSha256: SKILL })).toThrow('skill-condition')
  })

  test('check codes are counted per fixture; extra keys are rejected by the allowlist', () => {
    const runs = runsFor([['dev', 'd1-x', ['pass', 'check']]])
    runs[1]!.manifest.check_failures = [{ code: 'helper_not_invoked', message: '/secret/path leaked here' }]
    const report = buildDevReport({ prereg: prereg(), shas: SHAS, headSha: HEAD, runs, plannedRuns: 2, skillSha256: SKILL })
    expect(report.fixtures[0]!.check_codes).toEqual({ helper_not_invoked: 1 })
    expect(JSON.stringify(report)).not.toContain('secret')
    const root = mkdtempSync(join(tmpdir(), 'metacogs-devreport-'))
    scratch.push(root)
    const path = writeDevReport(root, report)
    expect(path).toBe(devReportPath(root, 'demo'))
    expect(() => writeDevReport(root, { ...report, leak: 'x' } as never)).toThrow('allowlist')
  })
})

describe('committed dev reports', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..')
  for (const method of ['counterfactual', 'synthesis']) {
    const path = devReportPath(REPO_ROOT, method)
    test.skipIf(!existsSync(path))(`evals/reports/${method}/green-dev.json is allowlist-only, names the epoch-2 tag, and leaves held-out untouched`, () => {
      const report = JSON.parse(readFileSync(path, 'utf8')) as DevReport
      expect(validateDevReport(report)).toEqual([])
      expect(report.method).toBe(method)
      expect(report.prereg.tag).toBe(`prereg/${method}/2`)
      expect(report.held_out).toBe('untouched')
      expect(report.fixtures.every((f) => f.kind === 'dev' || f.kind === 'negative')).toBe(true)
    })
  }
})
