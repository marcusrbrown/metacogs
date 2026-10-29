import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JudgeEvidence, writeManifest } from './manifest'
import {
  isPilotArm,
  PILOT_ARMS,
  type PilotTally,
  parsePilotTally,
  pilotTallyPath,
  planPilot,
  projectPilot,
  tallyPilotCampaign,
  writePilotTally,
} from './pilot'
import { canonicalizeText, enforcePrereg, type Expectation, expectationHash, type LoadedFixture, type Prereg, saltedHash } from './prereg'
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

  test('--fixture filter; an unknown id is an error', () => {
    expect(planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 2, onlyFixture: 'd2' })).toHaveLength(2)
    expect(() => planPilot({ arm: 'baseline', fixtures: dev, runsPerCondition: 2, onlyFixture: 'nope' })).toThrow(/no fixture/)
  })
})

describe('arms', () => {
  test('baseline is the only arm; the retired instruction and skill arms are not known', () => {
    expect([...PILOT_ARMS]).toEqual(['baseline'])
    expect(isPilotArm('baseline')).toBe(true)
    for (const arm of ['instruction', 'skill', 'bogus']) expect(isPilotArm(arm)).toBe(false)
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
  arm?: 'baseline'
  fixture: string
  status?: string
  reasons?: string[]
  judge?: JudgeEvidence
  stdout?: string
  /** The prereg content hash the manifest was produced under (default: the CTX hash). */
  hash?: string
  /** The agent model the manifest records (default: agent/x). */
  agent?: string
  /** `word_count` on the manifest: words in the final answer. */
  words?: number
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
      model: { pinned: p.agent ?? 'agent/x', returned: [] },
      ...(p.words !== undefined ? { word_count: p.words } : {}),
      ...(p.judge ? { judge: p.judge } : {}),
    }
    writeManifest(dir, base as never)
    if (p.stdout !== undefined) writeFileSync(join(dir, 'stdout.jsonl'), p.stdout)
  })
  return campaign
}

const LIMIT = 100
const CTX = {
  method: 'demo',
  prereg_content_hash: 'a'.repeat(64),
  agent_model_id: 'agent/x',
  judge_model_id: 'judge/x',
  criteria: ['TE1', 'TE2'],
  // d1 has a word limit in its (current) expectation sidecar, d2 has no expectation.
  fixtures: [{ id: 'd1', expectation: { outcome: 'o', excludedTopics: [], maxWords: LIMIT } }, { id: 'd2' }],
}

const CURRENT = CTX.prereg_content_hash
const OLD = 'b'.repeat(64)
const JUDGE_JSON = JSON.stringify({ redacted_input_sha256: 'c'.repeat(64), model_pinned: 'm', model_returned: ['m'], criteria: [{ id: 'TE1', verdict: 'pass', quotes: ['q'] }, { id: 'TE2', verdict: 'pass', quotes: ['q'] }], attempts: 1 })
/** The same record with TE2 failed: what a rejudge says when it disagrees with the manifest's own verdict. */
const JUDGE_JSON_TE2_FAIL = JUDGE_JSON.replace('{"id":"TE2","verdict":"pass"', '{"id":"TE2","verdict":"fail"')

/**
 * What a rejudge leaves behind: each run's `judge.json` and a `rejudge-summary.json` row naming its hash, under `contract`
 * (the prereg content hash it was enforced under) and `model` (the judge it pinned).
 */
function plantRejudge(
  campaign: string,
  rows: { run: string; verdict?: string; judgeJson?: string | null; hash?: string | null }[],
  summary: { contract?: string; model?: string; prompt?: string } = {},
): void {
  const summaryRows = rows.map((r) => {
    const text = r.judgeJson === undefined ? JUDGE_JSON : r.judgeJson
    if (text !== null) writeFileSync(join(campaign, r.run, 'judge.json'), text)
    const hash = r.hash === undefined ? (text === null ? undefined : sha256(text)) : (r.hash ?? undefined)
    return { run_id: r.run, prior_outcome: 'pass', verdict: r.verdict ?? 'pass', ...(hash ? { judge_json_sha256: hash } : {}) }
  })
  writeFileSync(
    join(campaign, 'rejudge-summary.json'),
    JSON.stringify({ judge_prompt_sha256: summary.prompt ?? 'f'.repeat(64), prereg_content_hash: summary.contract ?? CURRENT, judge_model_id: summary.model ?? 'judge/x', runs: summaryRows }),
  )
}

describe('tallyPilotCampaign', () => {
  test('per arm × fixture counts: each judge criterion, all passed, over limit, empty, skill loaded', () => {
    const dir = plantCampaign([
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'fail'), reasons: ['judge_fail'] },
      { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), reasons: ['answer_over_limit'], words: LIMIT + 1 },
      { arm: 'baseline', fixture: 'd1', reasons: ['answer_empty'] },
      { arm: 'baseline', fixture: 'd2', judge: evidence('fail', 'fail'), reasons: ['judge_fail'], stdout: skillLoad },
    ])
    const t = tallyPilotCampaign(dir, CTX)
    expect(t.arms).toEqual(['baseline'])
    expect(t.tally.baseline).toEqual({
      d1: { runs: 4, criteria: { TE1: 3, TE2: 2 }, all_pass: 2, over_limit: 1, empty: 1, skill_loaded: 0 },
      d2: { runs: 1, criteria: { TE1: 0, TE2: 0 }, all_pass: 0, over_limit: 0, empty: 0, skill_loaded: 1 },
    })
  })

  describe('over_limit is recomputed from the current expectation, not read from the recorded reason', () => {
    const plant3 = () =>
      plantCampaign([
        { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), words: 50 },
        { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), words: 100 },
        { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), words: 150, reasons: ['answer_over_limit'] },
      ])
    const withLimit = (maxWords: number) => ({ ...CTX, fixtures: [{ id: 'd1', expectation: { outcome: 'o', excludedTopics: [], maxWords } }, { id: 'd2' }] })
    const overLimit = (dir: string, maxWords: number) => tallyPilotCampaign(dir, withLimit(maxWords)).tally.baseline!.d1!.over_limit

    test('lowering maxWords raises the count; raising it lowers the count; exactly maxWords is within the limit', () => {
      const dir = plant3()
      expect(overLimit(dir, LIMIT)).toBe(1)
      expect(overLimit(dir, 49)).toBe(3)
      expect(overLimit(dir, 99)).toBe(2)
      expect(overLimit(dir, 150)).toBe(0) // the run recorded as answer_over_limit is within a 150-word limit
      expect(overLimit(dir, 500)).toBe(0)
    })

    test('a stale answer_over_limit reason with a word count inside the limit is not counted', () => {
      const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass'), words: 10, reasons: ['answer_over_limit'] }])
      expect(overLimit(dir, LIMIT)).toBe(0)
    })

    test('a fixture with no expectation, or a run with no word count, is never over the limit', () => {
      const dir = plantCampaign([
        { arm: 'baseline', fixture: 'd2', judge: evidence('pass', 'pass'), words: 9999 },
        { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') },
      ])
      const t = tallyPilotCampaign(dir, CTX)
      expect(t.tally.baseline!.d2!.over_limit).toBe(0)
      expect(t.tally.baseline!.d1!.over_limit).toBe(0)
    })

    test('empty still comes from the recorded reason', () => {
      const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', reasons: ['answer_empty'], words: 0 }])
      expect(tallyPilotCampaign(dir, CTX).tally.baseline!.d1).toMatchObject({ empty: 1, over_limit: 0 })
    })

    test('a run of a fixture the current prereg does not have is refused, naming the run dir', () => {
      const dir = plantCampaign([{ arm: 'baseline', fixture: 'gone', judge: evidence('pass', 'pass'), words: 5 }])
      expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/001-dev-gone-baseline-r1.*gone/)
    })
  })

  test('the criteria counted are the ones the caller names (the rubric\'s), not a fixed pair', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'fail') }])
    const t = tallyPilotCampaign(dir, { ...CTX, criteria: ['TE2', 'TE1', 'XX9'] })
    expect(t.tally.baseline!.d1).toEqual({ runs: 1, criteria: { TE2: 0, TE1: 1, XX9: 0 }, all_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0 })
    expect(tallyPilotCampaign(dir, { ...CTX, criteria: ['TE1'] }).tally.baseline!.d1).toMatchObject({ criteria: { TE1: 1 }, all_pass: 1 })
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

  test('a manifest carrying a retired arm is refused when the campaign is read', () => {
    const dir = plantCampaign([{ arm: 'instruction' as never, fixture: 'd1', judge: evidence('pass', 'pass') }])
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/unknown pilot arm/)
  })

  test('verdicts come from the manifest\'s own record, never from a judge.json nothing vouches for', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }])
    // A stray judge.json that says TE2 failed, with no rejudge-summary.json behind it.
    writeFileSync(join(dir, '001-dev-d1-baseline-r1', 'judge.json'), JUDGE_JSON_TE2_FAIL)
    expect(tallyPilotCampaign(dir, CTX).tally.baseline!.d1).toMatchObject({ runs: 1, criteria: { TE1: 1, TE2: 1 }, all_pass: 1 })
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

  describe('where a run\'s verdicts come from: a rejudge under the current contract, else the manifest under the current contract, else refusal', () => {
    const R1 = '001-dev-d1-baseline-r1'
    const R2 = '002-dev-d1-baseline-r1'
    const one = (hash: string) => plantCampaign([{ arm: 'baseline', fixture: 'd1', hash, judge: evidence('pass', 'pass') }])
    const te2 = (dir: string) => tallyPilotCampaign(dir, CTX).tally.baseline!.d1!.criteria.TE2

    test('(a) a judge.json the current summary vouches for is the verdict, whatever hash the manifest carries', () => {
      for (const hash of [OLD, CURRENT]) {
        const dir = one(hash)
        plantRejudge(dir, [{ run: R1, judgeJson: JUDGE_JSON_TE2_FAIL }])
        expect(te2(dir)).toBe(0)
      }
    })

    test('(b) a manifest under the current hash keeps its own verdicts when the summary is for another contract (a rejudge under B is not trusted after restoring A)', () => {
      const dir = one(CURRENT)
      plantRejudge(dir, [{ run: R1, judgeJson: JUDGE_JSON_TE2_FAIL }], { contract: OLD })
      expect(te2(dir)).toBe(1)
    })

    test('(b) ... and when the summary skipped the run, or judge.json is not the file the rejudge wrote', () => {
      const skipped = one(CURRENT)
      plantRejudge(skipped, [{ run: R1, verdict: 'skipped', judgeJson: JUDGE_JSON_TE2_FAIL, hash: null }])
      expect(te2(skipped)).toBe(1)
      const edited = one(CURRENT)
      plantRejudge(edited, [{ run: R1 }])
      writeFileSync(join(edited, R1, 'judge.json'), JUDGE_JSON_TE2_FAIL)
      expect(te2(edited)).toBe(1)
    })

    test('(c) a manifest under another hash with no summary is refused, naming the run dir', () => {
      const dir = one(OLD)
      writeFileSync(join(dir, R1, 'judge.json'), JUDGE_JSON)
      expect(() => tallyPilotCampaign(dir, CTX)).toThrow(new RegExp(`${R1}.*rejudge`))
    })

    test('(c) ... or whose summary is for another contract, skipped it, or no longer matches judge.json', () => {
      const other = one(OLD)
      plantRejudge(other, [{ run: R1 }], { contract: 'e'.repeat(64) })
      expect(() => tallyPilotCampaign(other, CTX)).toThrow(new RegExp(`${R1}.*contract`))
      const skipped = one(OLD)
      plantRejudge(skipped, [{ run: R1, verdict: 'skipped', hash: null }])
      expect(() => tallyPilotCampaign(skipped, CTX)).toThrow(new RegExp(R1))
      const edited = one(OLD)
      plantRejudge(edited, [{ run: R1 }])
      writeFileSync(join(edited, R1, 'judge.json'), JUDGE_JSON_TE2_FAIL)
      expect(() => tallyPilotCampaign(edited, CTX)).toThrow(new RegExp(R1))
    })

    test('(c) a summary written before it recorded the contract (no prereg_content_hash) vouches for nothing', () => {
      const dir = one(OLD)
      plantRejudge(dir, [{ run: R1 }])
      const path = join(dir, 'rejudge-summary.json')
      const { prereg_content_hash: _dropped, ...legacy } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, JSON.stringify(legacy))
      expect(() => tallyPilotCampaign(dir, CTX)).toThrow(new RegExp(R1))
    })

    test('a run that never reached the judge (a timeout) needs no verdict, so no contract either', () => {
      const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', hash: OLD, status: 'timeout', reasons: ['timeout'] }])
      expect(tallyPilotCampaign(dir, CTX).tally.baseline!.d1).toMatchObject({ runs: 1, all_pass: 0 })
    })

    describe('the judge model on the tally', () => {
      const withModel = (model: string) => ({ ...evidence('pass', 'pass'), model: { pinned: model, returned: [] } })

      test('comes from the summary for a run taken from judge.json, and from the manifests\' recorded judge otherwise, not from the caller', () => {
        const rejudged = one(OLD)
        plantRejudge(rejudged, [{ run: R1 }], { model: 'judge/summary' })
        expect(tallyPilotCampaign(rejudged, { ...CTX, judge_model_id: 'judge/prereg' }).judge_model_id).toBe('judge/summary')
        const recorded = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: withModel('judge/recorded') }])
        expect(tallyPilotCampaign(recorded, { ...CTX, judge_model_id: 'judge/prereg' }).judge_model_id).toBe('judge/recorded')
      })

      test('falls back to the caller\'s only when no run was judged', () => {
        const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', status: 'timeout', reasons: ['timeout'] }])
        expect(tallyPilotCampaign(dir, { ...CTX, judge_model_id: 'judge/prereg' }).judge_model_id).toBe('judge/prereg')
      })

      test('manifests that recorded different judges are refused', () => {
        const dir = plantCampaign([
          { arm: 'baseline', fixture: 'd1', judge: withModel('judge/one') },
          { arm: 'baseline', fixture: 'd1', judge: withModel('judge/two') },
        ])
        expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/judge model.*judge\/one.*judge\/two/)
      })

      test('a summary\'s judge and a manifest\'s recorded judge that differ are refused', () => {
        const dir = plantCampaign([
          { arm: 'baseline', fixture: 'd1', hash: OLD, judge: withModel('judge/x') },
          { arm: 'baseline', fixture: 'd1', judge: withModel('judge/recorded') },
        ])
        plantRejudge(dir, [{ run: R1 }], { model: 'judge/summary' })
        expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/judge model/)
      })
    })
  })

  test('the agent model on the tally is the one the manifests recorded, not the caller\'s', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', agent: 'recorded/model', judge: evidence('pass', 'pass') }])
    expect(tallyPilotCampaign(dir, CTX).agent_model_id).toBe('recorded/model')
  })

  test('manifests that recorded different agent models are refused, naming both', () => {
    const dir = plantCampaign([
      { arm: 'baseline', fixture: 'd1', agent: 'agent/one', judge: evidence('pass', 'pass') },
      { arm: 'baseline', fixture: 'd1', agent: 'agent/two', judge: evidence('pass', 'pass') },
    ])
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/agent\/one.*agent\/two|agent\/two.*agent\/one/)
  })

  test('manifests from two campaigns in one directory are refused', () => {
    const dir = plantCampaign([{ arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }, { arm: 'baseline', fixture: 'd1', judge: evidence('pass', 'pass') }])
    const path = join(dir, '002-dev-d1-baseline-r1', 'manifest.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace(CAMPAIGN_ID, 'demo-pilot-other'))
    expect(() => tallyPilotCampaign(dir, CTX)).toThrow(/more than one campaign/)
  })
})

describe('writePilotTally (fixed-key projection)', () => {
  const CELL = { runs: 1, criteria: { TE1: 0, TE2: 0 }, all_pass: 0, over_limit: 0, empty: 0, skill_loaded: 0 }
  const tally = (runs: number, hash = 'a'.repeat(64)): PilotTally =>
    projectPilot({
      ...CTX,
      prereg_content_hash: hash,
      tally: { baseline: { d1: { ...CELL, runs }, d2: { ...CELL, runs } } },
      campaigns: { baseline: `campaign-${runs}` },
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
    expect(Object.keys((written.tally as { baseline: { d1: object } }).baseline.d1)).toEqual(['runs', 'criteria', 'all_pass', 'over_limit', 'empty', 'skill_loaded'])
    expect(readFileSync(path, 'utf8')).not.toMatch(/SECRET|stdout|"env"/)
  })

  test('a tally key outside PILOT_ARMS is refused, not filtered; so is a count that is not a non-negative integer', () => {
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: CELL }, bogus: { d1: CELL } } as never, campaigns: { baseline: 'c1' } })).toThrow(/bogus/)
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: CELL } }, campaigns: { bogus: 'c1' } as never })).toThrow(/bogus/)
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: CELL } }, campaigns: {} })).toThrow(/campaign id/)
    expect(() => projectPilot({ ...CTX, tally: { baseline: { d1: { ...CELL, criteria: { TE1: -1, TE2: 0 } } } }, campaigns: { baseline: 'c1' } })).toThrow(/TE1/)
  })

  test('a rerun of the arm replaces its tally and says which campaign it replaced; the first write says nothing', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const lines: string[] = []
    writePilotTally(repo, tally(3), (l) => lines.push(l))
    expect(lines).toEqual([])
    writePilotTally(repo, tally(5), (l) => lines.push(l))
    const written = read(repo)
    expect(written.tally.baseline!.d1!.runs).toBe(5)
    expect(written.campaigns).toEqual({ baseline: 'campaign-5' })
    expect(lines).toEqual(['replaced baseline tally from campaign-3'])
  })

  test('a different prereg content hash starts the file over', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const lines: string[] = []
    writePilotTally(repo, tally(3))
    writePilotTally(repo, tally(1, 'b'.repeat(64)), (l) => lines.push(l))
    expect(read(repo).prereg_content_hash).toBe('b'.repeat(64))
    expect(lines).toEqual([])
  })

  test('a corrupt existing file is refused, naming its path; the file is not touched', () => {
    const repo = tmp('metacogs-pilotwrite-')
    const before = plant(repo, '{nope')
    expect(() => writePilotTally(repo, tally(1))).toThrow(/evals.demo.pilot.pilot\.json/)
    expect(readFileSync(pilotTallyPath(repo, 'demo'), 'utf8')).toBe(before)
  })

  describe('an existing pilot.json that does not validate is refused and left byte-identical', () => {
    type Doc = { arms: string[]; campaigns: Record<string, string>; tally: Record<string, Record<string, Record<string, unknown>>>; [k: string]: unknown }
    const good = (): Doc => JSON.parse(JSON.stringify(tally(3))) as Doc
    const mutate = (fn: (t: Doc) => void): string => {
      const t = good()
      fn(t)
      return `${JSON.stringify(t, null, 2)}\n`
    }
    const cases: [string, string][] = [
      ['a retired arm in arms', mutate((t) => t.arms.push('instruction'))],
      ['a retired arm in the tally', mutate((t) => (t.tally.instruction = { d1: { ...CELL } }))],
      ['an unknown arm in campaigns', mutate((t) => (t.campaigns.bogus = 'c'))],
      ['the previous schema version', mutate((t) => (t.schema_version = 2))],
      ['a bad prereg content hash', mutate((t) => (t.prereg_content_hash = 'nope'))],
      ['a negative count', mutate((t) => (t.tally.baseline!.d1!.runs = -1))],
      ['a fractional count', mutate((t) => (t.tally.baseline!.d1!.runs = 1.5))],
      ['a string count', mutate((t) => (t.tally.baseline!.d1!.runs = '2'))],
      ['a negative criterion count', mutate((t) => (t.tally.baseline!.d1!.criteria = { TE1: -1, TE2: 0 }))],
      ['criteria that is not a record', mutate((t) => (t.tally.baseline!.d1!.criteria = [1, 2]))],
      ['fixtures counting different criteria', mutate((t) => (t.tally.baseline!.d2!.criteria = { TE1: 0 }))],
      ['an extra cell key', mutate((t) => (t.tally.baseline!.d1!.stdout = 1))],
      ['a retired cell key', mutate((t) => (t.tally.baseline!.d1!.instruction_present = 0))],
      ['a missing cell key', mutate((t) => delete t.tally.baseline!.d1!.empty)],
      ['arms that disagree with the tally', mutate((t) => (t.arms = []))],
      ['campaigns that disagree with the tally', mutate((t) => (t.campaigns = {}))],
      ['an extra top-level key', mutate((t) => (t.stdout = 'x'))],
      ['a tally that is not an object', mutate((t) => (t.tally = null as never))],
    ]
    for (const [name, text] of cases) {
      test(name, () => {
        const repo = tmp('metacogs-pilotwrite-')
        plant(repo, text)
        expect(() => writePilotTally(repo, tally(9))).toThrow(/pilot\.json/)
        expect(readFileSync(pilotTallyPath(repo, 'demo'), 'utf8')).toBe(text)
      })
    }

    test('a valid file passes the same validation', () => {
      expect(parsePilotTally(good())).toEqual(tally(3))
      const repo = tmp('metacogs-pilotwrite-')
      plant(repo, `${JSON.stringify(good(), null, 2)}\n`)
      writePilotTally(repo, tally(9))
      expect(read(repo).tally.baseline!.d1!.runs).toBe(9)
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
function fakeHost(stdout: string = ANSWER_STDOUT): Host {
  return {
    async debugConfig(req: { config: Record<string, unknown> }) {
      return { ...(maskKeys(req.config) as object), agent: {}, mode: {}, plugin: [], command: {}, username: 'unknown', compaction: { prune: false } }
    },
    async run(req: HostRunRequest): Promise<SpawnResult> {
      const skill = (req.config.permission as { skill: Record<string, string> }).skill
      const names = Object.keys(skill).filter((k) => k !== '*' && skill[k] === 'allow')
      const block = names.length ? `<available_skills>\n${names.map((n) => `<skill><name>${n}</name></skill>`).join('\n')}\n</available_skills>` : 'You are an agent.'
      req.requests.push({ hasTools: true, round: 0, body: { messages: [{ role: 'system', content: block }, { role: 'user', content: 'x' }], tools: [{ function: { name: 'bash' } }] }, returnedModel: 'fake-model' })
      return { stdout, stderr: '', exitCode: 0, timedOut: false, aborted: false, wallMs: 7, startedAtMs: Date.now() }
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

  test('an outcome-only expectation has no word limit: a 5,000-word answer is not answer_over_limit', async () => {
    const { repo, heldout } = pilotRepo()
    const outcomeOnly = { outcome: 'recommends keeping the current library' }
    // Rebuild the pilot prereg with an outcome-only sidecar beside d1.
    repo.write('evals/demo/fixtures/dev/d1.expectation.json', JSON.stringify(outcomeOnly))
    const committed = JSON.parse(readFileSync(join(repo.dir, PILOT_PREREG), 'utf8')) as Prereg
    repo.write(PILOT_PREREG, `${JSON.stringify({ ...committed, expectation_hashes: { ...committed.expectation_hashes, dev: { ...committed.expectation_hashes!.dev, d1: expectationHash(TEST_SALT, outcomeOnly) } } }, null, 2)}\n`)
    const verification = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: PILOT_PREREG })
    const longAnswer = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ')
    const stdout = [
      ev({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } }),
      ev({ type: 'text', timestamp: 2, part: { type: 'text', text: longAnswer } }),
      ev({ type: 'step_finish', timestamp: 3, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
    ].join('\n')
    const campaignDir = join(tmp('metacogs-pilot-camp-'), 'demo-pilot-2026-10-24T00-00-00-000Z')
    const result = await runCampaign({
      repoRoot: repo.dir,
      method: 'demo',
      mode: 'dev',
      providerMode: 'scripted',
      verification,
      campaignId: 'demo-pilot-2026-10-24T00-00-00-000Z',
      campaignDir,
      runs: planPilot({ arm: 'baseline', fixtures: verification.content.fixtures.dev.filter((f) => f.id === 'd1'), runsPerCondition: 1 }),
      host: fakeHost(stdout),
      judge: async () => ({ verdict: 'pass' as const, evidence: evidence('pass', 'pass') }),
      declarations: { expectation: true },
    })
    expect(result.results.map((r) => [r.status, r.outcome, r.reasons])).toEqual([['completed', 'pass', []]])
    const manifest = JSON.parse(readFileSync(join(campaignDir, result.results[0]!.runId, 'manifest.json'), 'utf8')) as { word_count?: number }
    expect(manifest.word_count).toBeUndefined()
    const tally = tallyPilotCampaign(campaignDir, { method: 'demo', prereg_content_hash: verification.contentHash, judge_model_id: 'judge/x', criteria: ['TE1', 'TE2'], fixtures: verification.content.fixtures.dev })
    expect(tally.tally.baseline!.d1).toMatchObject({ runs: 1, all_pass: 1, over_limit: 0 })
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
      judge_model_id: verification.prereg.judge_model_id,
      criteria: ['TE1', 'TE2'],
      fixtures: verification.content.fixtures.dev,
    })
    expect(tally.arms).toEqual(['baseline'])
    expect(tally.campaigns).toEqual({ baseline: 'demo-pilot-2026-10-24T00-00-00-000Z' })
    expect(tally.tally.baseline).toEqual({
      d1: { runs: 2, criteria: { TE1: 2, TE2: 2 }, all_pass: 2, over_limit: 0, empty: 0, skill_loaded: 0 },
      // 'three word answer' is 3 words against maxWords 2, and the judge failed TE2.
      d2: { runs: 2, criteria: { TE1: 2, TE2: 0 }, all_pass: 0, over_limit: 2, empty: 0, skill_loaded: 0 },
    })
    const path = writePilotTally(repo.dir, tally)
    const written = JSON.parse(readFileSync(path, 'utf8')) as PilotTally
    expect(written).toMatchObject({ arms: ['baseline'], method: 'demo', prereg_content_hash: verification.contentHash, agent_model_id: tally.agent_model_id, judge_model_id: tally.judge_model_id })
    // Likewise the judge: the evidence the manifests recorded (the test judge's), not the prereg's pin.
    expect(tally.judge_model_id).toBe('judge/x')
    // The tally names the model the manifests recorded (the fake host's), not the prereg's pin.
    expect(tally.agent_model_id).toBe('metacogs-spike-provider/metacogs-spike-model')
    expect(written.tally).toEqual(tally.tally)
    expect(path.endsWith(join('evals', 'demo', 'pilot', 'pilot.json'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(campaignDir, result.results[0]!.runId, 'manifest.json'), 'utf8')) as { arm: string; condition: string }
    expect(manifest).toMatchObject({ arm: 'baseline', condition: 'baseline' })
  })
})
