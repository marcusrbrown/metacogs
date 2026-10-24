import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JudgeEvidence, writeManifest } from './manifest'
import {
  armRefusal,
  conditionOfArm,
  isPilotArm,
  PILOT_ARMS,
  type PilotTally,
  pilotTallyPath,
  planPilot,
  projectPilot,
  tallyPilotCampaign,
  writePilotTally,
} from './pilot'
import { canonicalizeText, enforcePrereg, type Expectation, type LoadedFixture, type Prereg, saltedHash } from './prereg'
import { type Host, type HostRunRequest, type JudgeInput, runCampaign } from './run'
import type { SpawnResult } from './opencode'
import { scaffoldMethod, TEST_SALT, TestRepo } from './test-support'
import { sha256 } from './workspace'

const scratch: string[] = []
const repos: TestRepo[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.destroy()
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}

const fixture = (id: string, expectation?: Expectation): LoadedFixture => ({ id, text: `${id} text\n`, hash: sha256(id), ...(expectation ? { expectation } : {}) })
const EXP: Expectation = { outcome: 'names the constraint', excludedTopics: ['sharding'], maxWords: 120 }

describe('planPilot', () => {
  const dev = [fixture('d1', EXP), fixture('d2')]

  test('N rounds over the dev fixtures only; every run carries its arm; baseline runs under condition baseline', () => {
    const plan = planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 3 })
    expect(plan).toHaveLength(6)
    expect(plan.map((p) => `${p.fixture.id}#${p.index}`)).toEqual(['d1#1', 'd2#1', 'd1#2', 'd2#2', 'd1#3', 'd2#3'])
    expect(new Set(plan.map((p) => p.arm))).toEqual(new Set(['baseline']))
    expect(new Set(plan.map((p) => p.condition))).toEqual(new Set(['baseline']))
    expect(new Set(plan.map((p) => p.fixture.kind))).toEqual(new Set(['dev']))
  })

  test('the expectation rides the planned fixture; a fixture without one gains no key', () => {
    const plan = planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 1 })
    expect(plan[0]!.fixture.expectation).toEqual(EXP)
    expect('expectation' in plan[1]!.fixture).toBe(false)
  })

  test('arm to condition: instruction shares baseline, skill is the skill condition', () => {
    expect(conditionOfArm('baseline')).toBe('baseline')
    expect(conditionOfArm('instruction')).toBe('baseline')
    expect(conditionOfArm('skill')).toBe('skill')
  })

  test('--fixture filter; an unknown id is an error', () => {
    expect(planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 2, onlyFixture: 'd2' })).toHaveLength(2)
    expect(() => planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 2, onlyFixture: 'nope' })).toThrow(/no fixture/)
  })
})

describe('arms', () => {
  test('only baseline can run in this build; the others are refused with a pointer to Unit 6', () => {
    expect(armRefusal('baseline')).toBeUndefined()
    for (const arm of ['instruction', 'skill'] as const) expect(armRefusal(arm)).toContain('Unit 6')
    expect(PILOT_ARMS.every(isPilotArm)).toBe(true)
    expect(isPilotArm('bogus')).toBe(false)
  })
})

// ── tally from planted manifests ───────────────────────────────────────────

const evidence = (te1: 'pass' | 'fail', te2: 'pass' | 'fail'): JudgeEvidence => ({
  model: { pinned: 'judge/x', returned: ['x'] },
  system_prompt_sha256: 'a'.repeat(64),
  input_sha256: 'b'.repeat(64),
  redacted_input_sha256: 'c'.repeat(64),
  attempts: 1,
  temperature: 0,
  error_code: null,
  criteria: [
    { id: 'TE1', verdict: te1, quote: 'a verbatim quote of the answer', quote_verified: true },
    { id: 'TE2', verdict: te2, quote: 'a verbatim quote of the answer', quote_verified: true },
  ],
  overclaim_flag: false,
  tool_calls: 0,
  wall_ms: 1,
})

const skillLoad = JSON.stringify({
  type: 'tool_use',
  part: { type: 'tool', tool: 'skill', callID: 'c', state: { status: 'completed', input: { name: 'tether' }, output: '<skill_content name="tether">x</skill_content>' } },
})

interface Plant {
  arm?: 'baseline' | 'instruction' | 'skill'
  fixture: string
  status?: string
  reasons?: string[]
  judge?: JudgeEvidence
  stdout?: string
  /** The prereg content hash the manifest was produced under (default: the CTX hash). */
  hash?: string
}

const CAMPAIGN_ID = 'demo-pilot-2026-10-24T00-00-00-000Z'

function plantCampaign(plants: Plant[]): string {
  const campaign = join(tmp('metacogs-pilot-'), CAMPAIGN_ID)
  plants.forEach((p, i) => {
    const runId = `00${i + 1}-dev-${p.fixture}-${p.arm ?? 'baseline'}-r1`
    const dir = join(campaign, runId)
    mkdirSync(dir, { recursive: true })
    const base = {
      schema_version: 1,
      run_id: runId,
      campaign_id: 'demo-pilot-2026-10-24T00-00-00-000Z',
      status: p.status ?? 'completed',
      outcome: 'fail',
      reasons: p.reasons ?? [],
      verdict_basis: 'judge',
      method: 'demo',
      condition: 'baseline',
      ...(p.arm ? { arm: p.arm } : {}),
      fixture: { id: p.fixture, kind: 'dev', hash: sha256(p.fixture) },
      check_failures: [],
      records: [],
      artifacts: {},
      prereg: { content_hash: p.hash ?? 'a'.repeat(64), epoch: 1 },
      ...(p.judge ? { judge: p.judge } : {}),
    }
    writeManifest(dir, base as never)
    if (p.stdout !== undefined) writeFileSync(join(dir, 'stdout.jsonl'), p.stdout)
  })
  return campaign
}

const CTX = { method: 'demo', prereg_content_hash: 'a'.repeat(64), agent_model_id: 'agent/x', judge_model_id: 'judge/x' }

describe('tallyPilotCampaign', () => {
  test('per arm × fixture counts: TE1, TE2, both, over limit, empty, skill loaded', () => {
    const dir = plantCampaign([
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'fail'), reasons: ['judge_fail'] },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), reasons: ['answer_over_limit'] },
      { arm: 'baseline', fixture: 'd1', reasons: ['answer_empty'] },
      { arm: 'baseline', fixture: 'd2', judge: evidence('fail', 'fail'), reasons: ['judge_fail'], stdout: skillLoad },
    ])
    const t = tallyPilotCampaign(dir, CTX)
    expect(t.arms).toEqual(['baseline'])
    expect(t.tally.baseline).toEqual({
      d1: { runs: 4, te1_pass: 3, te2_pass: 2, both_pass: 2, over_limit: 1, empty: 1, skill_loaded: 0, instruction_present: 0 },
      d2: { runs: 1, te1_pass: 0, te2_pass: 0, both_pass: 0, over_limit: 0, empty: 0, skill_loaded: 1, instruction_present: 0 },
    })
  })

  test('infra errors, isolation breaches and interrupted runs are not runs; timeouts are', () => {
    const t = tallyPilotCampaign(
      plantCampaign([
        { arm: 'baseline', fixture: 'd1', status: 'infra_error' },
        { arm: 'baseline', fixture: 'd1', status: 'non_isolated' },
        { arm: 'baseline', fixture: 'd1', status: 'interrupted' },
        { arm: 'baseline', fixture: 'd1', status: 'timeout', reasons: ['timeout'] },
      ]),
      CTX,
    )
    expect(t.tally.baseline!.d1!.runs).toBe(1)
  })

  test('the instruction arm counts instruction_present; arms stay separate, in arm order', () => {
    const t = tallyPilotCampaign(
      plantCampaign([
        { arm: 'instruction', fixture: 'd1', judge: evidence('pass', 'pass') },
        { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'fail') },
      ]),
      CTX,
    )
    expect(t.arms).toEqual(['baseline', 'instruction'])
    expect(t.tally.instruction!.d1).toMatchObject({ runs: 1, instruction_present: 1 })
    expect(t.tally.baseline!.d1).toMatchObject({ runs: 1, instruction_present: 0 })
  })

  test('a rejudged verdict (judge.json) replaces the one on the manifest', () => {
    const dir = plantCampaign([
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
    ])
    // The second run was re-judged: TE2 now fails. The manifest is never rewritten, judge.json is.
    writeFileSync(join(dir, '002-dev-d1-baseline-r1', 'judge.json'), JSON.stringify({ redacted_input_sha256: 'c'.repeat(64), model_pinned: 'm', model_returned: ['m'], criteria: [{ id: 'TE1', verdict: 'pass', quotes: ['q'] }, { id: 'TE2', verdict: 'fail', quotes: ['q'] }], attempts: 1 }))
    expect(tallyPilotCampaign(dir, CTX).tally.baseline!.d1).toMatchObject({ runs: 2, te1_pass: 2, te2_pass: 1, both_pass: 1 })
  })

  test('a manifest without an arm means this is not a pilot campaign', () => {
    expect(() => tallyPilotCampaign(plantCampaign([{ fixture: 'd1' }]), CTX)).toThrow(/not a pilot campaign/)
  })

  test('campaigns maps each tallied arm to the campaign id the manifests carry', () => {
    const t = tallyPilotCampaign(plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }]), CTX)
    expect(t.campaigns).toEqual({ baseline: CAMPAIGN_ID })
  })

  test('a manifest produced under another prereg content hash is refused, naming its run dir', () => {
    const dir = plantCampaign([
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), hash: 'b'.repeat(64) },
    ])
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/002-dev-d1-baseline-r1/)
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/prereg/)
  })

  test('allowRejudged skips the hash comparison: a rejudge rewrote the verdicts under the current prereg', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), hash: 'b'.repeat(64) }])
    expect(tallyPilotCampaign(dir, CTX, { allowRejudged: true }).tally.baseline!.d1).toMatchObject({ runs: 1 })
  })

  test('manifests from two campaigns in one directory are refused', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }, { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }])
    const path = join(dir, '002-dev-d1-baseline-r1', 'manifest.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace(CAMPAIGN_ID, 'demo-pilot-other'))
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/more than one campaign/)
  })
})

describe('writePilotTally (fixed-key projection)', () => {
  const CELL = { runs: 1, te1_pass: 0, te2_pass: 0, both_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0, instruction_present: 0 }
  const tally = (arms: Partial<Record<'baseline' | 'instruction', number>>, hash = 'a'.repeat(64)): PilotTally =>
    projectPilot({
      ...CTX,
      prereg_content_hash: hash,
      tally: Object.fromEntries(Object.entries(arms).map(([arm, runs]) => [arm, { d1: { ...CELL, runs } }])),
      campaigns: Object.fromEntries(Object.keys(arms).map((arm) => [arm, `campaign-${arm}-${Object.values(arms).join('')}`])),
    })
  const read = (repo: string): PilotTally => JSON.parse(readFileSync(pilotTallyPath(repo, 'demo'), 'utf8')) as PilotTally
  const plant = (repo: string, text: string): string => {
    mkdirSync(join(repo, 'evals', 'demo', 'pilot'), { recursive: true })
    writeFileSync(pilotTallyPath(repo, 'demo'), text)
    return text
  }

  test('only the allowlisted keys are written, even if the cell carried more', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const dirty = { ...CELL, stdout: 'SECRET', env: { K: 'V' } }
    const path = writePilotTally(repo, projectPilot({ ...CTX, tally: { baseline: { d1: dirty } }, campaigns: { baseline: 'c1' } }))
    expect(path).toBe(pilotTallyPath(repo, 'demo'))
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(written)).toEqual(['schema_version', 'method', 'prereg_content_hash', 'agent_model_id', 'judge_model_id', 'arms', 'campaigns', 'tally'])
    expect(written.campaigns).toEqual({ baseline: 'c1' })
    expect(Object.keys((written.tally as { baseline: { d1: object } }).baseline.d1)).toEqual(['runs', 'te1_pass', 'te2_pass', 'both_pass', 'over_limit', 'empty', 'skill_loaded', 'instruction_present'])
    expect(readFileSync(path, 'utf8')).not.toMatch(/SECRET|stdout|"env"/)
  })

  test('a tally key outside PILOT_ARMS is refused, not filtered', () => {
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: CELL }, bogus: { d1: CELL } } as never, campaigns: { baseline: 'c1' } })).toThrow(/bogus/)
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: CELL } }, campaigns: { bogus: 'c1' } as never })).toThrow(/bogus/)
  })

  test('a second arm under the same prereg content joins the file; a rerun of an arm replaces it and says which campaign it replaced', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const lines: string[] = []
    writePilotTally(repo, tally({ baseline: 3 }), (l) => lines.push(l))
    writePilotTally(repo, tally({ instruction: 2 }), (l) => lines.push(l))
    expect(lines).toEqual([])
    let written = read(repo)
    expect(written.arms).toEqual(['baseline', 'instruction'])
    writePilotTally(repo, tally({ baseline: 5 }), (l) => lines.push(l))
    written = read(repo)
    expect(written.arms).toEqual(['baseline', 'instruction'])
    expect(written.tally.baseline!.d1!.runs).toBe(5)
    expect(written.tally.instruction!.d1!.runs).toBe(2)
    expect(written.campaigns).toEqual({ baseline: 'campaign-baseline-5', instruction: 'campaign-instruction-2' })
    expect(lines).toEqual(['replaced baseline tally from campaign-baseline-3'])
  })

  test('a different prereg content hash starts the file over', () => {
    const repo = tmp('metacogs-pilotwrite-')
    writePilotTally(repo, tally({ baseline: 3, instruction: 3 }))
    writePilotTally(repo, tally({ baseline: 1 }, 'b'.repeat(64)))
    const written = read(repo)
    expect(written.arms).toEqual(['baseline'])
    expect(written.prereg_content_hash).toBe('b'.repeat(64))
  })

  test('a corrupt existing file is refused, naming its path; the file is not touched', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const before = plant(repo, '{nope')
    expect(() => writePilotTally(repo, tally({ baseline: 1 }))).toThrow(/evals.demo.pilot.pilot\.json/)
    expect(readFileSync(pilotTallyPath(repo, 'demo'), 'utf8')).toBe(before)
  })

  describe('an existing pilot.json that does not validate is refused and left byte-identical', () => {
    const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(tally({ baseline: 3, instruction: 2 }))) as Record<string, unknown>
    const mutate = (fn: (t: { arms: string[]; campaigns: Record<string, string>; tally: Record<string, Record<string, Record<string, unknown>>>; [k: string]: unknown }) => void): string => {
      const t = good() as never
      fn(t)
      return `${JSON.stringify(t, null, 2)}\n`
    }
    const cases: [string, string][] = [
      ['an unknown arm in arms', mutate((t) => t.arms.push('bogus'))],
      ['an unknown arm in the tally', mutate((t) => (t.tally.bogus = { d1: { ...CELL } }))],
      ['an unknown arm in campaigns', mutate((t) => (t.campaigns.bogus = 'c'))],
      ['an old schema version', mutate((t) => (t.schema_version = 1))],
      ['a bad prereg content hash', mutate((t) => (t.prereg_content_hash = 'nope'))],
      ['a negative count', mutate((t) => (t.tally.instruction!.d1!.runs = -1))],
      ['a fractional count', mutate((t) => (t.tally.instruction!.d1!.runs = 1.5))],
      ['a string count', mutate((t) => (t.tally.instruction!.d1!.runs = '2'))],
      ['an extra cell key', mutate((t) => (t.tally.instruction!.d1!.stdout = 1))],
      ['a missing cell key', mutate((t) => delete t.tally.instruction!.d1!.empty)],
      ['arms that disagree with the tally', mutate((t) => (t.arms = ['baseline']))],
      ['a tally that is not an object', mutate((t) => (t.tally = null as never))],
    ]
    for (const [name, text] of cases) {
      test(name, () => {
        const repo = tmp('metacogs-pilotwrite-')
        plant(repo, text)
        // Writing the baseline arm again must not rewrite the instruction arm's numbers, nor the file at all.
        expect(() => writePilotTally(repo, tally({ baseline: 9 }))).toThrow(/pilot\.json/)
        expect(readFileSync(pilotTallyPath(repo, 'demo'), 'utf8')).toBe(text)
      })
    }

    test('a valid file passes the same validation', () => {
      const repo = tmp('metacogs-pilotwrite-')
      plant(repo, `${JSON.stringify(good(), null, 2)}\n`)
      writePilotTally(repo, tally({ baseline: 9 }))
      expect(read(repo).tally.instruction!.d1!.runs).toBe(2)
    })
  })
})

// ── end to end: scaffolded method, pilot prereg, fake host, judge ──────────

const ev = (o: unknown) => JSON.stringify(o)
const ANSWER_STDOUT = [
  ev({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } }),
  ev({ type: 'text', timestamp: 2, part: { type: 'text', text: 'three word answer' } }),
  ev({ type: 'step_finish', timestamp: 3, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
].join('\n')

function maskKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskKeys)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'apiKey' ? '***' : maskKeys(v)]))
  return value
}

/** Answers every run with `ANSWER_STDOUT`, showing the model exactly the skills the config allows. */
function fakeHost(): Host {
  return {
    async debugConfig(req: { config: Record<string, unknown> }) {
      return { ...(maskKeys(req.config) as object), agent: {}, mode: {}, plugin: [], command: {}, username: 'unknown', compaction: { prune: false } }
    },
    async run(req: HostRunRequest): Promise<SpawnResult> {
      const skill = (req.config.permission as { skill: Record<string, string> }).skill
      const names = Object.keys(skill).filter((k) => k !== '*' && skill[k] === 'allow')
      const block = names.length ? `<available_skills>\n${names.map((n) => `<skill><name>${n}</name></skill>`).join('\n')}\n</available_skills>` : 'You are an agent.'
      req.requests.push({ hasTools: true, round: 0, body: { messages: [{ role: 'system', content: block }, { role: 'user', content: 'x' }], tools: [{ function: { name: 'bash' } }] }, returnedModel: 'fake-model' })
      return { stdout: ANSWER_STDOUT, stderr: '', exitCode: 0, timedOut: false, aborted: false, wallMs: 7, startedAtMs: Date.now() }
    },
  }
}

describe('baseline pilot, end to end (fake host)', () => {
  const D2_TEXT = 'Dev fixture two: choose a cache.\n'
  const roomy: Expectation = { outcome: 'names the deciding constraint', excludedTopics: ['sharding'], maxWords: 120 }
  const tight: Expectation = { outcome: 'recommends the boring option', excludedTopics: [], maxWords: 2 }
  const PILOT_PREREG = 'evals/demo/pilot/prereg.json'

  function pilotRepo() {
    const repo = new TestRepo()
    repos.push(repo)
    const heldout = tmp('metacogs-pilot-held-')
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout, expectations: { dev: { d1: roomy, d2: tight } } })
    repo.write('evals/demo/fixtures/dev/d2.md', D2_TEXT)
    const prereg: Prereg = {
      ...scaffold.prereg,
      runs_per_condition: 2,
      fixture_hashes: { ...scaffold.prereg.fixture_hashes, dev: { ...scaffold.prereg.fixture_hashes.dev, d2: saltedHash(TEST_SALT, canonicalizeText(D2_TEXT)) } },
    }
    // Only the pilot prereg exists: the production prereg path is absent, so nothing here can be mistaken for a RED/GREEN input.
    repo.write(PILOT_PREREG, `${JSON.stringify(prereg, null, 2)}\n`)
    return { repo, heldout }
  }

  test('enforcePrereg reads the pilot prereg; the production path is not consulted', () => {
    const { repo, heldout } = pilotRepo()
    expect(existsSync(join(repo.dir, 'evals', 'demo', 'prereg.json'))).toBe(false)
    const verified = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: PILOT_PREREG })
    expect(verified.content.problems).toEqual([])
    expect(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout })).toThrow(/evals\/demo\/prereg\.json does not exist/)
    expect(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: 'evals/demo/pilot/missing.json' })).toThrow(/pilot\/missing\.json does not exist/)
  })

  test('2 fixtures × 2 runs: pilot.json carries arms ["baseline"] and the counts; manifests carry the arm; tallies are keyed by arm', async () => {
    const { repo, heldout } = pilotRepo()
    const verification = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: PILOT_PREREG })
    const seen: JudgeInput[] = []
    const judge = async (input: JudgeInput) => {
      seen.push(input)
      return { verdict: input.fixture.id === 'd1' ? ('pass' as const) : ('fail' as const), evidence: evidence('pass', input.fixture.id === 'd1' ? 'pass' : 'fail') }
    }
    const campaignDir = join(tmp('metacogs-pilot-camp-'), 'demo-pilot-2026-10-24T00-00-00-000Z')
    const plan = planPilot({ arm: 'baseline', fixtures: verification.content.fixtures.dev, runsPerCondition: verification.prereg.runs_per_condition })
    const result = await runCampaign({
      repoRoot: repo.dir,
      method: 'demo',
      mode: 'dev',
      providerMode: 'scripted',
      verification,
      campaignId: 'demo-pilot-2026-10-24T00-00-00-000Z',
      campaignDir,
      runs: plan,
      host: fakeHost(),
      judge,
      declarations: { expectation: true },
    })
    expect(Object.keys(result.tallies).sort()).toEqual(['dev/d1/baseline', 'dev/d2/baseline'])
    expect(seen.map((s) => s.fixture.expectation)).toContainEqual(tight)

    const tally = tallyPilotCampaign(campaignDir, {
      method: 'demo',
      prereg_content_hash: verification.contentHash,
      agent_model_id: verification.prereg.agent_model_id,
      judge_model_id: verification.prereg.judge_model_id,
    })
    expect(tally.arms).toEqual(['baseline'])
    expect(tally.tally.baseline).toEqual({
      d1: { runs: 2, te1_pass: 2, te2_pass: 2, both_pass: 2, over_limit: 0, empty: 0, skill_loaded: 0, instruction_present: 0 },
      // 'three word answer' is 3 words against maxWords 2, and the judge failed TE2.
      d2: { runs: 2, te1_pass: 2, te2_pass: 0, both_pass: 0, over_limit: 2, empty: 0, skill_loaded: 0, instruction_present: 0 },
    })
    const path = writePilotTally(repo.dir, tally)
    const written = JSON.parse(readFileSync(path, 'utf8')) as PilotTally
    expect(written).toMatchObject({ arms: ['baseline'], method: 'demo', prereg_content_hash: verification.contentHash, agent_model_id: 'opencode/big-pickle', judge_model_id: 'judge/other-family' })
    expect(written.tally).toEqual(tally.tally)
    expect(path.endsWith(join('evals', 'demo', 'pilot', 'pilot.json'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(campaignDir, result.results[0]!.runId, 'manifest.json'), 'utf8')) as { arm: string; condition: string }
    expect(manifest).toMatchObject({ arm: 'baseline', condition: 'baseline' })
  })
})
