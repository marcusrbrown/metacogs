import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildHelper } from '../generate/bundle-helpers'
import { validRecord } from '../record/test-support'
import { recordFilename } from '../record/canonical'
import { listRecordFiles } from './checks'
import { type JudgeEvidence, readManifest, type RunManifest } from './manifest'
import { opencodeAvailability, type SpawnResult } from './opencode'
import { enforcePrereg, type PreregVerification } from './prereg'
import {
  type CampaignInput,
  CredentialLeakError,
  type Host,
  type HostRunRequest,
  planRuns,
  type PlannedRun,
  type ProviderMode,
  runCampaign,
} from './run'
import { PLACEHOLDER_API_KEY, bashCallStep, skillCallStep } from './scripted-provider'
import { buildHappyChain, scaffoldMethod, TestRepo } from './test-support'
import { sha256 } from './workspace'

// ── shared repo ────────────────────────────────────────────────────────────

let repo: TestRepo
let heldout: string
let verification: PreregVerification
const scratch: string[] = []

const SAMPLE_RECORD = validRecord({ method: 'demo' })

beforeAll(async () => {
  repo = new TestRepo('metacogs-runtest-')
  heldout = mkdtempSync(join(tmpdir(), 'metacogs-runtest-held-'))
  scratch.push(heldout)
  const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  buildHappyChain(repo, scaffold, {
    'scripts/record.mjs': await buildHelper({ methods: ['demo'], helperVersion: '0.0.0-test' }),
    'assets/sample.json': JSON.stringify(SAMPLE_RECORD),
  })
  verification = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout })
})

afterAll(() => {
  repo.destroy()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

function campaignDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-camp-'))
  scratch.push(dir)
  return join(dir, 'c1')
}

function planOne(kind: 'dev' | 'negative' | 'heldout', condition: 'baseline' | 'skill', id = 'x'): PlannedRun {
  return { fixture: { id, kind, text: 'a fixture\n', hash: 'h'.repeat(64) }, condition, index: 1 }
}

// ── fake host ──────────────────────────────────────────────────────────────

const ev = (o: unknown) => JSON.stringify(o)
const textEvents = [
  ev({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } }),
  ev({ type: 'text', timestamp: 2, part: { type: 'text', text: 'answer' } }),
  ev({ type: 'step_finish', timestamp: 3, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
].join('\n')
const toolUse = (tool: string, state: Record<string, unknown>) => ev({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool, callID: `${tool}-1`, state } })
const skillLoadEvent = toolUse('skill', { status: 'completed', input: { name: 'demo' }, output: '<skill_content name="demo">x</skill_content>', metadata: { name: 'demo', dir: '/d' } })
const helperEvent = toolUse('bash', { status: 'completed', input: { command: 'node .agents/skills/demo/scripts/record.mjs --file x' }, output: '{}' })
const invalidSkillEvent = toolUse('invalid', { status: 'completed', input: {}, output: "Model tried to call unavailable tool 'skill'." })

function maskKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskKeys)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'apiKey' ? '***' : maskKeys(v)]))
  }
  return value
}

function effectiveConfig(config: Record<string, unknown>): unknown {
  return { ...(maskKeys(config) as object), agent: {}, mode: {}, plugin: [], command: {}, username: 'unknown', compaction: { prune: false } }
}

function expectedSkillNames(config: Record<string, unknown>): string[] {
  const skill = (config.permission as { skill: Record<string, string> }).skill
  return Object.keys(skill).filter((k) => k !== '*' && skill[k] === 'allow')
}

interface Behavior {
  stdout?: string
  stderr?: string
  exitCode?: number
  timedOut?: boolean
  /** Names to put in the model-visible `<available_skills>` block. Default: exactly what the config allows. */
  shownSkills?: string[]
  /** Leave the system prompt without any tool-capable request. */
  noRequest?: boolean
  debugConfig?: 'ok' | 'foreign' | 'missing'
  /** Wait until the abort signal fires, then return as the real spawn does. */
  waitForAbort?: boolean
  during?: (req: HostRunRequest) => void | Promise<void>
}

function fakeHost(behaviors: Behavior | ((call: number) => Behavior)): Host & { runCalls: number; debugCalls: number } {
  const host = {
    runCalls: 0,
    debugCalls: 0,
    async debugConfig(req: { config: Record<string, unknown> }) {
      host.debugCalls += 1
      const b = typeof behaviors === 'function' ? behaviors(host.runCalls + 1) : behaviors
      if (b.debugConfig === 'missing') return undefined
      const eff = effectiveConfig(req.config) as Record<string, unknown>
      return b.debugConfig === 'foreign' ? { ...eff, small_model: 'metacogs-author-leak/marker-model' } : eff
    },
    async run(req: HostRunRequest): Promise<SpawnResult> {
      host.runCalls += 1
      const b = typeof behaviors === 'function' ? behaviors(host.runCalls) : behaviors
      if (!b.noRequest) {
        const names = b.shownSkills ?? expectedSkillNames(req.config)
        const block = names.length ? `<available_skills>\n${names.map((n) => `<skill><name>${n}</name></skill>`).join('\n')}\n</available_skills>` : 'You are an agent.'
        req.requests.push({
          hasTools: true,
          round: 0,
          body: { messages: [{ role: 'system', content: block }, { role: 'user', content: 'x' }], tools: [{ function: { name: 'bash' } }] },
          returnedModel: 'fake-model',
        })
      }
      await b.during?.(req)
      if (b.waitForAbort) {
        await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, wallMs: 1, startedAtMs: Date.now() }
      }
      return {
        stdout: b.stdout ?? textEvents,
        stderr: b.stderr ?? '',
        exitCode: b.exitCode ?? 0,
        timedOut: b.timedOut ?? false,
        aborted: false,
        wallMs: 7,
        startedAtMs: Date.now(),
      }
    },
  }
  return host
}

function campaign(runs: PlannedRun[], host: Host | undefined, extra: Partial<CampaignInput> = {}): CampaignInput {
  const dir = campaignDir()
  return {
    repoRoot: repo.dir,
    method: 'demo',
    mode: 'green',
    providerMode: 'scripted',
    verification,
    campaignId: 'c1',
    campaignDir: dir,
    runs,
    host,
    ...extra,
  }
}

const manifestOf = (dir: string, runId: string): RunManifest => readManifest(join(dir, runId, 'manifest.json'))

// ── planning ───────────────────────────────────────────────────────────────

describe('planRuns', () => {
  const fx = (ids: string[]) => ids.map((id) => ({ id, text: `${id}\n`, hash: id }))
  const fixtures = { dev: fx(['d1', 'd2']), negative: fx(['n1']), heldout: fx(['h1', 'h2']) }

  test('RED: baseline on dev and negatives, N rounds', () => {
    const plan = planRuns({ mode: 'red', fixtures, runsPerCondition: 3 })
    expect(plan).toHaveLength(3 * 3)
    expect(new Set(plan.map((p) => p.condition))).toEqual(new Set(['baseline']))
    expect(new Set(plan.map((p) => p.fixture.kind))).toEqual(new Set(['dev', 'negative']))
  })

  test('GREEN: both conditions on held-out, skill on negatives, dev only on request', () => {
    const plan = planRuns({ mode: 'green', fixtures, runsPerCondition: 5 })
    const count = (kind: string, condition: string) => plan.filter((p) => p.fixture.kind === kind && p.condition === condition).length
    expect(count('heldout', 'baseline')).toBe(10)
    expect(count('heldout', 'skill')).toBe(10)
    expect(count('negative', 'skill')).toBe(5)
    expect(count('negative', 'baseline')).toBe(0)
    expect(count('dev', 'skill')).toBe(0)
    expect(planRuns({ mode: 'green', fixtures, runsPerCondition: 1, includeDev: true }).filter((p) => p.fixture.kind === 'dev')).toHaveLength(2)
  })

  test('DEV: skill condition on dev and negatives only; held-out is never planned', () => {
    const plan = planRuns({ mode: 'dev', fixtures, runsPerCondition: 2, includeDev: true })
    expect(plan).toHaveLength(2 * 3)
    expect(new Set(plan.map((p) => p.condition))).toEqual(new Set(['skill']))
    expect(new Set(plan.map((p) => p.fixture.kind))).toEqual(new Set(['dev', 'negative']))
    expect(plan.some((p) => p.fixture.id.startsWith('h'))).toBe(false)
  })

  test('conditions interleave: neither systematically runs first for a fixture', () => {
    const plan = planRuns({ mode: 'green', fixtures, runsPerCondition: 4 })
    const h1 = plan.filter((p) => p.fixture.id === 'h1')
    const firstPerRound = [1, 2, 3, 4].map((r) => h1.find((p) => p.index === r)?.condition)
    expect(new Set(firstPerRound)).toEqual(new Set(['baseline', 'skill']))
    // Same round for both conditions of a fixture is adjacent, so drift hits both.
    const idx = (c: string, r: number) => plan.findIndex((p) => p.fixture.id === 'h1' && p.condition === c && p.index === r)
    expect(Math.abs(idx('baseline', 1) - idx('skill', 1))).toBe(1)
  })

  test('fixture filter; unknown id is an error', () => {
    expect(planRuns({ mode: 'red', fixtures, runsPerCondition: 2, onlyFixture: 'd2' })).toHaveLength(2)
    expect(() => planRuns({ mode: 'red', fixtures, runsPerCondition: 2, onlyFixture: 'nope' })).toThrow(/no fixture/)
  })
})

// ── fake-host campaigns ────────────────────────────────────────────────────

describe('run outcomes (fake host)', () => {
  test('baseline, no skill call, empty records, isolation pass: counted pass; manifest is complete; workspace is gone', async () => {
    const c = campaign([planOne('dev', 'baseline')], fakeHost({}))
    const res = await runCampaign(c)
    expect(res.results).toHaveLength(1)
    const r = res.results[0]!
    expect(r).toMatchObject({ status: 'completed', outcome: 'pass' })
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 1, pass: 1 })

    const m = manifestOf(c.campaignDir, r.runId)
    expect(m).toMatchObject({
      status: 'completed',
      outcome: 'pass',
      verdict_basis: 'pending-judge',
      method: 'demo',
      condition: 'baseline',
      attempt: 1,
      skill: null,
      provider_mode: 'scripted',
      opencode: { package: 'opencode-ai', version: '1.19.4' },
      prereg: { tag: 'prereg/demo/1', commit_sha: verification.shas.commitSha, tag_object_sha: verification.shas.tagObjectSha, blob_sha: verification.shas.blobSha, epoch: 1 },
      tool_call_count: 0,
      wall_clock_ms: 7,
    })
    expect(m.model).toEqual({ pinned: 'metacogs-spike-provider/metacogs-spike-model', returned: ['fake-model'] })
    expect(m.isolation?.passed).toBe(true)
    expect(m.usage).toMatchObject({ input: 11, output: 7 })
    expect(Object.keys(m.artifacts).sort()).toEqual(['requests.json', 'stderr.txt', 'stdout.jsonl'])
    for (const a of Object.values(m.artifacts)) expect(existsSync(join(c.campaignDir, r.runId, a.file))).toBe(true)
    expect(existsSync(dirname(m.config.path))).toBe(false) // fixture root, HOME, XDG and workspace deleted
  })

  test('negative fixtures need no judge: basis is deterministic', async () => {
    const c = campaign([planOne('negative', 'skill', 'n')], fakeHost({}))
    const res = await runCampaign(c)
    expect(manifestOf(c.campaignDir, res.results[0]!.runId).verdict_basis).toBe('deterministic')
  })

  test('the manifest is written as `running` before the host is launched', async () => {
    let seen: string | undefined
    const c = campaign([planOne('dev', 'baseline')], fakeHost({
      during: () => {
        const dir = join(c.campaignDir, readdirSync(c.campaignDir).find((d) => d !== 'summary.json')!)
        seen = readManifest(join(dir, 'manifest.json')).status
      },
    }))
    await runCampaign(c)
    expect(seen).toBe('running')
  })

  test('skill condition on a positive fixture: skill loaded, helper called, valid record → pass; manifest records skill hash', async () => {
    const c = campaign([planOne('heldout', 'skill', 'h1')], fakeHost({
      stdout: [skillLoadEvent, helperEvent, textEvents].join('\n'),
      during: (req) => {
        const dir = req.env.METACOGS_RECORDS_DIR!
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, recordFilename(SAMPLE_RECORD)), JSON.stringify(SAMPLE_RECORD))
      },
    }))
    const res = await runCampaign(c)
    expect(res.results[0]).toMatchObject({ status: 'completed', outcome: 'pass' })
    const m = manifestOf(c.campaignDir, res.results[0]!.runId)
    expect(m.skill?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.skill?.tree_sha).toBe(verification.shas.skillTreeSha ?? null)
    expect(m.records).toHaveLength(1)
    expect(m.isolation?.expectedSkills).toEqual(['demo'])
  })

  test('any isolation check failing → non_isolated, excluded from the denominator, and reported', async () => {
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], fakeHost({ shownSkills: ['author-private-skill'] })))
    expect(res.results[0]).toMatchObject({ status: 'non_isolated', outcome: 'non_isolated', reasons: ['available_skills_exact'] })
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 0, non_isolated: 1 })
  })

  test('built-in customize-opencode visible in the skill condition → non_isolated', async () => {
    const res = await runCampaign(campaign([planOne('heldout', 'skill', 'h1')], fakeHost({ shownSkills: ['customize-opencode', 'demo'] })))
    expect(res.results[0]?.outcome).toBe('non_isolated')
  })

  test('a decoy quoted in the transcript → non_isolated', async () => {
    const leak = ev({ type: 'text', timestamp: 2, part: { type: 'text', text: 'METACOGS_SENTINEL_INSTRUCTIONS_7f3a91' } })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], fakeHost({ stdout: leak })))
    expect(res.results[0]).toMatchObject({ outcome: 'non_isolated', reasons: ['decoys_not_quotable'] })
  })

  test('foreign effective config → non_isolated without ever launching the model run', async () => {
    const host = fakeHost({ debugConfig: 'foreign' })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host))
    expect(res.results[0]).toMatchObject({ outcome: 'non_isolated', reasons: ['debug_config_generated_only'] })
    expect(host.runCalls).toBe(0)
  })

  test('per-run timeout → timeout status, FAIL (not excluded), even with no request observed', async () => {
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], fakeHost({ timedOut: true, exitCode: -1, noRequest: true, stdout: '' })))
    expect(res.results[0]).toMatchObject({ status: 'timeout', outcome: 'fail' })
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 1, fail: 1 })
  })

  test('budget breach → budget_exceeded, FAIL', async () => {
    const calls = Array.from({ length: 21 }, () => helperEvent).join('\n')
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], fakeHost({ stdout: `${calls}\n${textEvents}` })))
    expect(res.results[0]).toMatchObject({ status: 'budget_exceeded', outcome: 'fail', reasons: ['budget_tool_calls'] })
  })

  test('host exit before skill content loads → infra_error, retried ≤2, reported separately', async () => {
    const crash = ev({ type: 'error', timestamp: 1, error: { name: 'APIError', data: { message: 'provider down' } } })
    const host = fakeHost((call) => (call <= 2 ? { exitCode: 1, stdout: crash } : {}))
    const c = campaign([planOne('dev', 'baseline')], host)
    const res = await runCampaign(c)
    expect(host.runCalls).toBe(3)
    expect(res.results).toHaveLength(1)
    expect(res.results[0]).toMatchObject({ outcome: 'pass', attempt: 3 })
    expect(res.infraErrors.map((r) => r.attempt)).toEqual([1, 2])
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 1, pass: 1, infra_error: 2 })
    expect(manifestOf(c.campaignDir, res.infraErrors[0]!.runId)).toMatchObject({ status: 'infra_error', outcome: 'infra_error' })
    expect(manifestOf(c.campaignDir, res.infraErrors[0]!.runId).host_errors[0]).toEqual({ name: 'APIError', message: 'provider down' })
  })

  test('infra_error retries are capped; an exhausted run stays out of the denominator', async () => {
    const host = fakeHost({ exitCode: 1, stdout: '' })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host))
    expect(host.runCalls).toBe(3)
    expect(res.results[0]).toMatchObject({ status: 'infra_error', outcome: 'infra_error', attempt: 3 })
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 0, infra_error: 3 })
  })

  test('host exit after skill content loaded → FAIL, not retried', async () => {
    const host = fakeHost({ exitCode: 1, stdout: skillLoadEvent })
    const res = await runCampaign(campaign([planOne('heldout', 'skill', 'h1')], host))
    expect(host.runCalls).toBe(1)
    expect(res.results[0]).toMatchObject({ status: 'host_crash', outcome: 'fail' })
  })

  test('denied-skill invalid tool_use on a negative → attempted fire, FAIL', async () => {
    const res = await runCampaign(campaign([planOne('negative', 'skill', 'n1')], fakeHost({ stdout: `${invalidSkillEvent}\n${textEvents}` })))
    expect(res.results[0]).toMatchObject({ status: 'completed', outcome: 'fail', reasons: ['false_fire_denied_skill_call'] })
  })

  test('unrecognized event shapes fail closed', async () => {
    const res = await runCampaign(campaign([planOne('negative', 'skill', 'n1')], fakeHost({ stdout: `${ev({ type: 'brand_new_event', part: {} })}\n${textEvents}` })))
    expect(res.results[0]).toMatchObject({ outcome: 'fail', reasons: ['unrecognized_events'] })
  })

  test('judge hook decides positive fixtures; judge_error is FAIL; negatives never reach it', async () => {
    const calls: string[] = []
    const judgeWith = (verdict: 'pass' | 'fail' | 'judge_error') => async (i: { fixture: { id: string } }) => {
      calls.push(i.fixture.id)
      return verdict === 'judge_error' ? ({ verdict, detail: 'bad json twice' } as const) : ({ verdict } as const)
    }
    const run = (verdict: 'pass' | 'fail' | 'judge_error', plan: PlannedRun) => runCampaign(campaign([plan], fakeHost({}), { judge: judgeWith(verdict) }))
    const pass = await run('pass', planOne('dev', 'baseline', 'd'))
    expect(pass.results[0]?.outcome).toBe('pass')
    expect(manifestOf(dirname(pass.summaryPath), pass.results[0]!.runId).verdict_basis).toBe('judge')
    expect((await run('fail', planOne('dev', 'baseline', 'd'))).results[0]).toMatchObject({ outcome: 'fail', reasons: ['judge_fail'] })
    expect((await run('judge_error', planOne('dev', 'baseline', 'd'))).results[0]).toMatchObject({ outcome: 'fail', reasons: ['judge_error'] })
    const before = calls.length
    await run('pass', planOne('negative', 'skill', 'n'))
    expect(calls.length).toBe(before)
  })

  test('the judge verdict is persisted as judge.json and referenced by hash from the manifest; nothing else leaks into it', async () => {
    const evidence: JudgeEvidence = {
      model: { pinned: 'opencode-go/judge-x', returned: ['judge-x'] },
      system_prompt_sha256: 'a'.repeat(64),
      input_sha256: 'b'.repeat(64),
      redacted_input_sha256: 'c'.repeat(64),
      attempts: 1,
      temperature: 0,
      error_code: null,
      criteria: [
        { id: 'CF1', verdict: 'pass', quote: 'names the claim ... and the source', quote_verified: true },
        { id: 'CF2', verdict: 'fail', quote: 'absent', quote_verified: true },
      ],
      overclaim_flag: false,
      tool_calls: 0,
      wall_ms: 5,
    }
    const c = campaign([planOne('dev', 'baseline', 'd')], fakeHost({}), { judge: async () => ({ verdict: 'fail', evidence }) })
    const res = await runCampaign(c)
    const runId = res.results[0]!.runId
    const m = manifestOf(c.campaignDir, runId)
    const text = readFileSync(join(c.campaignDir, runId, 'judge.json'), 'utf8')
    expect(m.artifacts['judge.json']).toEqual({ file: 'judge.json', sha256: sha256(text), bytes: Buffer.byteLength(text) })
    expect(JSON.parse(text)).toEqual({
      redacted_input_sha256: 'c'.repeat(64),
      model_pinned: 'opencode-go/judge-x',
      model_returned: ['judge-x'],
      criteria: [
        { id: 'CF1', verdict: 'pass', quotes: ['names the claim', 'and the source'] },
        { id: 'CF2', verdict: 'fail', quotes: ['absent'] },
      ],
      attempts: 1,
    })
  })

  test('a judge_error is persisted with its error code; a run without a judge writes no judge.json', async () => {
    const failing: JudgeEvidence = {
      model: { pinned: 'opencode-go/judge-x', returned: [] },
      system_prompt_sha256: 'a'.repeat(64),
      input_sha256: '',
      redacted_input_sha256: null,
      attempts: 2,
      temperature: null,
      error_code: 'invalid_malformed_json',
      criteria: [],
      overclaim_flag: false,
      tool_calls: 0,
      wall_ms: 1,
    }
    const c = campaign([planOne('dev', 'baseline', 'd')], fakeHost({}), { judge: async () => ({ verdict: 'judge_error', detail: 'x', evidence: failing }) })
    const res = await runCampaign(c)
    const dir = join(c.campaignDir, res.results[0]!.runId)
    expect(JSON.parse(readFileSync(join(dir, 'judge.json'), 'utf8'))).toMatchObject({ redacted_input_sha256: null, attempts: 2, error: 'invalid_malformed_json', criteria: [] })
    const noJudge = campaign([planOne('dev', 'baseline', 'd')], fakeHost({}))
    const res2 = await runCampaign(noJudge)
    expect(existsSync(join(noJudge.campaignDir, res2.results[0]!.runId, 'judge.json'))).toBe(false)
  })

  test('record contents are retained next to the judge verdict so a review shows what the judge saw', async () => {
    const c = campaign([planOne('heldout', 'skill', 'h1')], fakeHost({
      stdout: [skillLoadEvent, helperEvent, textEvents].join('\n'),
      during: (req) => {
        const dir = req.env.METACOGS_RECORDS_DIR!
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, recordFilename(SAMPLE_RECORD)), JSON.stringify(SAMPLE_RECORD))
      },
    }))
    const res = await runCampaign(c)
    const m = manifestOf(c.campaignDir, res.results[0]!.runId)
    const kept = JSON.parse(readFileSync(join(c.campaignDir, res.results[0]!.runId, 'records.json'), 'utf8')) as { name: string; content: string }[]
    expect(kept.map((r) => r.name)).toEqual([recordFilename(SAMPLE_RECORD)])
    expect(JSON.parse(kept[0]!.content)).toMatchObject({ method: 'demo' })
    expect(m.artifacts['records.json']?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('interruption', () => {
  test('SIGINT-style abort mid-run: child group killed (via signal), workspace gone, manifest `interrupted`, remaining runs skipped', async () => {
    const ac = new AbortController()
    let configPath = ''
    const host = fakeHost({
      waitForAbort: true,
      during: (req) => {
        configPath = req.env.OPENCODE_CONFIG!
        setTimeout(() => ac.abort(), 50)
      },
    })
    const c = campaign([planOne('dev', 'baseline', 'a'), planOne('dev', 'baseline', 'b')], host, { signal: ac.signal })
    const res = await runCampaign(c)
    expect(res.aborted).toBe('interrupted')
    expect(host.runCalls).toBe(1)
    expect(res.results).toHaveLength(1)
    expect(res.results[0]).toMatchObject({ status: 'interrupted' })
    expect(manifestOf(c.campaignDir, res.results[0]!.runId)).toMatchObject({ status: 'interrupted' })
    expect(existsSync(dirname(configPath))).toBe(false)
  })

  test('already-aborted before the first run: nothing launches, manifest says interrupted', async () => {
    const ac = new AbortController()
    ac.abort()
    const host = fakeHost({})
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host, { signal: ac.signal }))
    expect(host.runCalls).toBe(0)
    expect(host.debugCalls).toBe(0)
    expect(res.aborted).toBe('interrupted')
  })
})

describe('auth passthrough', () => {
  // Synthetic values: shaped like secrets, issued to nobody.
  const AUTH = {
    opencode: { type: 'api', key: 'synthetic-oc-secret-aaaa1111bbbb' },
    'opencode-go': { type: 'api', key: 'synthetic-go-secret-cccc2222dddd' },
  } as const

  test('only the passed providers land in the run\'s isolated auth.json (0600); manifest names providers, never values', async () => {
    let seen: { files: string[]; mode: number; providers: string[]; underHome: boolean } | undefined
    const host = fakeHost({
      during: (req) => {
        const path = join(req.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
        seen = {
          files: readdirSync(join(req.env.XDG_DATA_HOME!, 'opencode')),
          mode: statSync(path).mode & 0o777,
          providers: Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(),
          underHome: path.startsWith(dirname(req.env.HOME!)),
        }
      },
    })
    const c = campaign([planOne('dev', 'baseline')], host, { auth: AUTH })
    const res = await runCampaign(c)
    expect(res.aborted).toBeUndefined()
    expect(seen).toEqual({ files: ['auth.json'], mode: 0o600, providers: ['opencode', 'opencode-go'], underHome: true })
    const m = manifestOf(c.campaignDir, res.results[0]!.runId)
    expect(m.auth_passthrough).toEqual(['opencode', 'opencode-go'])
    expect(res.results[0]!.outcome).toBe('pass')
    const text = readFileSync(join(c.campaignDir, res.results[0]!.runId, 'manifest.json'), 'utf8')
    expect(text).not.toContain(AUTH.opencode.key)
    expect(text).not.toContain(AUTH['opencode-go'].key)
  })

  test('without a passthrough there is no auth.json and no manifest field', async () => {
    let exists: boolean | undefined
    const host = fakeHost({ during: (req) => void (exists = existsSync(join(req.env.XDG_DATA_HOME!, 'opencode', 'auth.json'))) })
    const c = campaign([planOne('dev', 'baseline')], host)
    const res = await runCampaign(c)
    expect(exists).toBe(false)
    expect(manifestOf(c.campaignDir, res.results[0]!.runId).auth_passthrough).toBeUndefined()
  })

  test('the canary in the author home is still not quotable: another provider\'s key in a transcript is non_isolated, not passthrough', async () => {
    const host = fakeHost({ stdout: ev({ type: 'text', timestamp: 2, part: { type: 'text', text: 'METACOGS_CANARY_AUTH_SECRET_c04e55' } }) })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host, { auth: AUTH }))
    expect(res.results[0]).toMatchObject({ status: 'non_isolated' })
  })

  test.each([
    ['stdout', (key: string) => ({ stdout: ev({ type: 'text', timestamp: 2, part: { type: 'text', text: `leak ${key}` } }) })],
    ['stderr', (key: string) => ({ stderr: `warn ${key}` })],
    ['the model-visible request body', (key: string) => ({ during: (req: HostRunRequest) => void req.requests.push({ hasTools: false, round: 0, body: { messages: [{ role: 'user', content: key }] } }) })],
  ])('a passthrough value in %s → credential_leak, artifacts purged, campaign stops', async (_where, behavior) => {
    const host = fakeHost(behavior(AUTH['opencode-go'].key))
    const c = campaign([planOne('dev', 'baseline', 'a'), planOne('dev', 'baseline', 'b')], host, { auth: AUTH })
    const res = await runCampaign(c)
    expect(res.aborted).toBe('credential_leak')
    expect(host.runCalls).toBe(1)
    const runId = readdirSync(c.campaignDir).find((d) => d !== 'summary.json')!
    expect(readdirSync(join(c.campaignDir, runId))).toEqual(['manifest.json'])
    const raw = readFileSync(join(c.campaignDir, runId, 'manifest.json'), 'utf8')
    const m = JSON.parse(raw) as RunManifest
    expect(m.status).toBe('credential_leak')
    expect(m.reasons.join()).toContain('auth_passthrough:opencode-go.key')
    expect(m.auth_passthrough).toEqual(['opencode', 'opencode-go'])
    expect(raw).not.toContain(AUTH['opencode-go'].key)
  })

  test('a passthrough value dropped into the workspace is found too', async () => {
    const host = fakeHost({ during: (req) => writeFileSync(join(req.cwd, 'oops.txt'), AUTH.opencode.key) })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host, { auth: AUTH }))
    expect(res.aborted).toBe('credential_leak')
  })
})

describe('provider 429', () => {
  const rateLimited = ev({ type: 'error', timestamp: 1, error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } } })

  test('retried with backoff, recorded as provider_429 infra_error, and never counted in the denominator', async () => {
    const waits: number[] = []
    const host = fakeHost((call) => (call <= 2 ? { exitCode: 1, stdout: rateLimited } : {}))
    const c = campaign([planOne('dev', 'baseline')], host, { sleep: async (ms) => void waits.push(ms) })
    const res = await runCampaign(c)
    expect(waits).toEqual([30_000, 90_000])
    expect(res.results[0]).toMatchObject({ outcome: 'pass', attempt: 3 })
    expect(res.infraErrors.map((r) => r.reasons)).toEqual([
      ['host_exit_before_skill_load', 'provider_429'],
      ['host_exit_before_skill_load', 'provider_429'],
    ])
    expect(res.tallies['dev/x/baseline']).toMatchObject({ attempted: 1, pass: 1, infra_error: 2 })
    expect(manifestOf(c.campaignDir, res.infraErrors[0]!.runId).host_errors[0]).toEqual({ name: 'APIError', message: 'Rate limit exceeded', statusCode: 429 })
  })

  test('a non-429 outage retries immediately (no backoff)', async () => {
    const waits: number[] = []
    const crash = ev({ type: 'error', timestamp: 1, error: { name: 'APIError', data: { message: 'provider down', statusCode: 503 } } })
    const host = fakeHost((call) => (call <= 1 ? { exitCode: 1, stdout: crash } : {}))
    await runCampaign(campaign([planOne('dev', 'baseline')], host, { sleep: async (ms) => void waits.push(ms) }))
    expect(waits).toEqual([])
  })

  test('a 429 after skill content loaded is a FAIL, not an infra_error', async () => {
    const host = fakeHost({ exitCode: 1, stdout: `${skillLoadEvent}\n${rateLimited}` })
    const res = await runCampaign(campaign([planOne('heldout', 'skill', 'h1')], host))
    expect(res.results[0]).toMatchObject({ status: 'host_crash', outcome: 'fail' })
  })
})

describe('credential leak', () => {
  test('placeholder key in stdout → run aborted, artifacts purged, `credential_leak` recorded, campaign stops', async () => {
    const leaky = ev({ type: 'text', timestamp: 2, part: { type: 'text', text: `config says ${PLACEHOLDER_API_KEY}` } })
    const host = fakeHost({ stdout: leaky })
    const c = campaign([planOne('dev', 'baseline', 'a'), planOne('dev', 'baseline', 'b')], host)
    const res = await runCampaign(c)
    expect(res.aborted).toBe('credential_leak')
    expect(host.runCalls).toBe(1)
    const runId = readdirSync(c.campaignDir).find((d) => d !== 'summary.json')!
    const dir = join(c.campaignDir, runId)
    expect(readdirSync(dir)).toEqual(['manifest.json'])
    const m = readManifest(join(dir, 'manifest.json'))
    expect(m.status).toBe('credential_leak')
    expect(m.reasons[0]).toContain('credential_leak:scripted_placeholder_api_key')
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).not.toContain(PLACEHOLDER_API_KEY)
  })

  test('placeholder key written into the workspace is found too', async () => {
    const host = fakeHost({
      during: (req) => writeFileSync(join(req.cwd, 'oops.txt'), `key=${PLACEHOLDER_API_KEY}`),
    })
    const res = await runCampaign(campaign([planOne('dev', 'baseline')], host))
    expect(res.aborted).toBe('credential_leak')
  })

  test('CredentialLeakError carries labels only', () => {
    const e = new CredentialLeakError('r1', ['scripted_placeholder_api_key'])
    expect(e.message).not.toContain(PLACEHOLDER_API_KEY)
  })
})

// ── real host, scripted provider ───────────────────────────────────────────

const availability = opencodeAvailability()
const realSuite = describe.skipIf(!availability.available)
const SKILL_DIR_CMD = 'node .agents/skills/demo/scripts/record.mjs --file .agents/skills/demo/assets/sample.json'

realSuite('real OpenCode, scripted provider', () => {
  function realCampaign(runs: PlannedRun[], extra: Partial<CampaignInput> = {}, mode: 'red' | 'green' = 'green', providerMode: ProviderMode = 'scripted') {
    return campaign(runs, undefined, { mode, providerMode, ...extra })
  }

  test(
    'baseline smoke: manifest lists exactly the expected (empty) skill set and only the generated config',
    async () => {
      const c = realCampaign([planOne('dev', 'baseline', 'd1')], {}, 'red')
      const res = await runCampaign(c)
      expect(res.results[0]).toMatchObject({ status: 'completed', outcome: 'pass' })
      const m = manifestOf(c.campaignDir, res.results[0]!.runId)
      expect(m.isolation?.passed).toBe(true)
      expect(m.isolation?.availableSkills ?? []).toEqual([])
      expect(m.isolation?.checks.find((k) => k.name === 'debug_config_generated_only')?.passed).toBe(true)
      expect(m.usage?.input).toBe(11)
      expect(m.model.returned).toEqual(['metacogs-spike-model'])
      expect(m.artifacts['requests.json']?.bytes).toBeGreaterThan(0)
    },
    180_000,
  )

  test(
    'skill condition: skill loads, helper writes a valid record, manifest lists exactly [demo]',
    async () => {
      const c = realCampaign([planOne('heldout', 'skill', 'h1')], {
        scriptFor: () => [skillCallStep('demo'), bashCallStep(SKILL_DIR_CMD)],
      })
      const res = await runCampaign(c)
      const m = manifestOf(c.campaignDir, res.results[0]!.runId)
      expect(m.check_failures).toEqual([])
      expect(res.results[0]).toMatchObject({ status: 'completed', outcome: 'pass' })
      expect(m.isolation?.availableSkills).toEqual(['demo'])
      expect(m.isolation?.passed).toBe(true)
      expect(m.records).toHaveLength(1)
      expect(m.records[0]?.name).toBe(recordFilename(SAMPLE_RECORD))
      expect(m.tool_call_count).toBe(2)
      expect(m.skill?.sha256).toMatch(/^[0-9a-f]{64}$/)
    },
    180_000,
  )

  test(
    'a model that calls the unavailable skill tool in a baseline negative is an attempted fire (real `invalid` event shape)',
    async () => {
      const c = realCampaign([planOne('negative', 'baseline', 'n1')], { scriptFor: () => [skillCallStep('demo')] }, 'red')
      const res = await runCampaign(c)
      const m = manifestOf(c.campaignDir, res.results[0]!.runId)
      expect(m.check_failures.map((f) => f.code)).toEqual(['false_fire_denied_skill_call'])
      expect(res.results[0]).toMatchObject({ status: 'completed', outcome: 'fail' })
    },
    180_000,
  )

  test(
    'a bash command outside the helper allowlist is denied and leaves no record',
    async () => {
      const c = realCampaign([planOne('heldout', 'skill', 'h1')], {
        scriptFor: () => [skillCallStep('demo'), bashCallStep('echo not-allowed > /tmp/metacogs-should-not-exist')],
      })
      const res = await runCampaign(c)
      expect(existsSync('/tmp/metacogs-should-not-exist')).toBe(false)
      expect(res.results[0]).toMatchObject({ outcome: 'fail' })
      expect(manifestOf(c.campaignDir, res.results[0]!.runId).check_failures.map((f) => f.code)).toContain('record_missing')
    },
    180_000,
  )

  const liveTest = test.skipIf(process.env.METACOGS_LIVE !== '1')
  liveTest(
    'live smoke (METACOGS_LIVE=1): free-tier model via the recording proxy; isolation evidence is model-visible, no key anywhere',
    async () => {
      const c = realCampaign([planOne('negative', 'baseline', 'n1')], {}, 'red', 'live')
      const res = await runCampaign(c)
      const m = manifestOf(c.campaignDir, res.results[0]!.runId)
      console.log(`[runner] live smoke: status=${m.status} outcome=${m.outcome} wall=${m.wall_clock_ms}ms model=${JSON.stringify(m.model)} usage=${JSON.stringify(m.usage)} reasons=${m.reasons.join(',')}`)
      expect(m.provider_mode).toBe('live')
      expect(m.model.pinned).toBe('opencode/big-pickle')
      expect(m.isolation?.skillListObserved).toBe(true)
      expect(m.isolation?.passed).toBe(true)
      expect(m.isolation?.availableSkills ?? []).toEqual([])
      expect(m.usage?.input).toBeGreaterThan(0)
      expect(JSON.stringify(m)).not.toContain(PLACEHOLDER_API_KEY)
    },
    240_000,
  )

  test('listRecordFiles on a never-created records dir is empty (the helper creates it lazily)', () => {
    expect(listRecordFiles(join(tmpdir(), 'metacogs-never-created'))).toEqual([])
  })
})
