import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import { parseEvents } from '../../../runner/events'
import { CredentialLeakError } from '../../../runner/manifest'
import { CustodyError, sha256 } from '../../../runner/workspace'
import { REPLAY_MODELS } from './gates'
import {
  aggregate,
  ANSWER_CAP,
  buildUserMessage,
  cliproxyTransport,
  collectJudgeable,
  type CompleteRequest,
  DEFAULT_JUDGE_ID,
  defaultSeed,
  JUDGE_PROMPT_SHA256,
  JUDGE_SYSTEM_PROMPT,
  type Judgement,
  judgeCampaign,
  type JudgeCliDeps,
  judgeMain,
  type JudgeOptions,
  JudgeModelError,
  judgementDir,
  type JudgeTransport,
  loadReference,
  parseVerdict,
  quoteAnchored,
  readJudgements,
  renderJudgeAnswer,
  renderSummary,
  selectJudgeModel,
  spotCheck,
  TransportError,
} from './judge'
import { campaignDir } from './run'
import { newSheetLab, OUTCOME_REF, runSyntheticCampaign, type SheetLab, stdoutOf, stepFinish, textEvent, toolEvent } from './sheet-support'

const labs: SheetLab[] = []
afterEach(() => {
  for (const l of labs.splice(0)) l.dispose()
})
const lab = (): SheetLab => {
  const l = newSheetLab()
  labs.push(l)
  return l
}

// Assembled at run time so the secret scan has nothing to match.
const KEY = ['sk', 'fake', 'judge', 'key', '0123456789'].join('-')
const GLM = `opencode-go/${DEFAULT_JUDGE_ID}`
const QUOTE = 'Run the checks next.'

// ── a fake judge transport ─────────────────────────────────────────────────

type Responder = (user: string, call: number) => string | Error

interface Fake {
  transport: JudgeTransport
  calls: CompleteRequest[]
  listed: { n: number }
}

function fake(respond: Responder, models: string[] = [GLM, 'gpt-x', 'claude-y']): Fake {
  const calls: CompleteRequest[] = []
  const listed = { n: 0 }
  const transport: JudgeTransport = {
    listModels: async () => {
      listed.n += 1
      return models
    },
    complete: async (request) => {
      calls.push(request)
      const r = respond(request.user, calls.length)
      if (r instanceof Error) throw r
      return { text: r, returnedModel: 'glm-5.3' }
    },
  }
  return { transport, calls, listed }
}

const linesOf = (user: string, key: string): string[] => (new RegExp(`^${key}: (.*)$`, 'm').exec(user)?.[1] ?? '').split(', ').filter((s) => s && s !== 'none')
const nonceOf = (user: string): string => /^nonce: (\S+)/m.exec(user)![1]!

interface Shape {
  default_move?: string
  floor?: string
  /** Per-arm overrides; a function receives the arm id. */
  arm?: (arm: string) => Record<string, unknown>
  drop?: string[]
  extra?: unknown[]
}

/** A valid verdict for the arms the prompt asks about. */
function verdict(user: string, shape: Shape = {}): Record<string, unknown> {
  const judged = linesOf(user, 'judge_arms').filter((a) => !shape.drop?.includes(a))
  const disruption = linesOf(user, 'disruption_arms')
  return {
    default_move: shape.default_move ?? 'Runs the checks.',
    floor: shape.floor ?? 'agree',
    arms: [
      ...judged.map((arm) => ({
        arm,
        changed: 'no',
        direction: 'neutral',
        first_move: 'Runs the checks.',
        reason: 'Same as the default.',
        quote: QUOTE,
        ...(disruption.includes(arm) ? { disruption: 'no' } : {}),
        ...shape.arm?.(arm),
      })),
      ...(shape.extra ?? []),
    ],
  }
}
const ok =
  (shape: Shape = {}): Responder =>
  (user) =>
    JSON.stringify(verdict(user, shape))

// ── campaigns ──────────────────────────────────────────────────────────────

const FIXTURES = [
  { id: 'moment-one', kind: 'feel' as const },
  { id: 'turn-two', kind: 'ordinary' as const },
]

const SIX = ['continue-a', 'continue-b', 'feel', 'drugs', 'whichever', 'nudge-only'] as const

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}
const treeHash = (dir: string): string =>
  createHash('sha256')
    .update(walk(dir).sort().map((f) => `${f}\0${readFileSync(f, 'utf8')}`).join('\n'))
    .digest('hex')

/** Writes one attempt by hand: for arms and states a scripted campaign cannot make. */
function handAttempt(l: SheetLab, o: { campaign: string; fixture: string; model: string; arm: string; status: string; passed?: boolean; terminal?: boolean; stdout?: string }): void {
  const stdout = o.stdout ?? stdoutOf(textEvent(`${QUOTE} (${o.arm})`), stepFinish())
  const dir = join(campaignDir(l.store, o.campaign), o.fixture, o.model.replace('/', '__'), o.arm, 'a001')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdout.jsonl'), stdout)
  const record = {
    schema_version: 1,
    campaign: o.campaign,
    fixture: { id: o.fixture, kind: 'feel', spec_sha256: 'x', export_sha256: 'y' },
    model: o.model,
    arm: o.arm,
    attempt: 'a001',
    seq: 1,
    message: { kind: 'text', text: 'Probe.' },
    gates: { passed: o.passed ?? true, checks: [] },
    status: o.status,
    terminal: o.terminal ?? true,
    reasons: o.status === 'completed' ? [] : [o.status],
    cost: { reported_usd: 0, charged_usd: 0, basis: 'scripted' },
    artifacts: { 'stdout.jsonl': sha256(stdout) },
  }
  writeFileSync(join(dir, 'attempt.json'), `${JSON.stringify(record)}\n`)
}

const options = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({ campaign: 'phase1', provider: 'scripted', ...over })

async function full(l: SheetLab, f: Fake, over: Partial<JudgeOptions> = {}, extra: { nonce?: () => string; needles?: { label: string; value: string }[] } = {}) {
  let n = 0
  return judgeCampaign(options(over), { store: l.store, transport: f.transport, nonce: extra.nonce ?? (() => `nonce${++n}`), ...(extra.needles ? { needles: extra.needles } : {}) })
}

const judgements = (l: SheetLab, campaign = 'phase1'): Judgement[] => readJudgements(judgementDir(l.store, campaign))

// ── collection ─────────────────────────────────────────────────────────────

describe('collection', () => {
  test('a 9-arm campaign yields every arm, baselines first', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const { pairs, skipped } = collectJudgeable(l.store, 'phase1')
    expect(pairs).toHaveLength(FIXTURES.length * REPLAY_MODELS.length)
    for (const p of pairs) {
      expect(p.arms.map((a) => a.arm)).toEqual(['continue-a', 'continue-b', 'feel', 'feel-somewhere', 'drugs', 'drugs-caffeine', 'drugs-psilocybin', 'whichever', 'nudge-only'])
      expect(p.arms.filter((a) => a.kind === 'baseline')).toHaveLength(2)
      expect(p.arms.find((a) => a.arm === 'drugs-caffeine')!.message).toBe('/drugs caffeine')
      expect(p.arms.find((a) => a.arm === 'whichever')!.kind).toBe('nudge')
    }
    expect(skipped).toEqual([])
  })

  test('a 6-arm campaign yields exactly those arms', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { name: 'real-world', fixtures: [FIXTURES[0]!], arms: SIX })
    const { pairs } = collectJudgeable(l.store, 'real-world')
    expect(pairs).toHaveLength(REPLAY_MODELS.length)
    for (const p of pairs) expect(p.arms.map((a) => a.arm).sort()).toEqual([...SIX].sort())
  })

  test('an arm name outside the known set is collected', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]], arms: ['continue-a', 'continue-b'] })
    handAttempt(l, { campaign: 'phase1', fixture: 'moment-one', model: REPLAY_MODELS[0], arm: 'rw-probe', status: 'completed' })
    const { pairs } = collectJudgeable(l.store, 'phase1')
    expect(pairs[0]!.arms.map((a) => a.arm)).toEqual(['continue-a', 'continue-b', 'rw-probe'])
    expect(pairs[0]!.arms[2]!.kind).toBe('nudge')
  })

  test('excluded, timeout and non-counted attempts are skipped', async () => {
    const l = lab()
    await runSyntheticCampaign(l, {
      fixtures: [FIXTURES[0]!],
      models: [REPLAY_MODELS[0]],
      arms: ['continue-a', 'continue-b', 'feel', 'drugs', 'whichever'],
      answer: (job) => (job.arm === 'drugs' ? 'timeout' : job.arm === 'feel' ? 'excluded' : undefined),
    })
    handAttempt(l, { campaign: 'phase1', fixture: 'moment-one', model: REPLAY_MODELS[0], arm: 'nudge-only', status: 'host_error', terminal: false })
    handAttempt(l, { campaign: 'phase1', fixture: 'moment-one', model: REPLAY_MODELS[0], arm: 'drugs-caffeine', status: 'completed', passed: false })
    const { pairs, skipped } = collectJudgeable(l.store, 'phase1')
    expect(pairs[0]!.arms.map((a) => a.arm)).toEqual(['continue-a', 'continue-b', 'whichever'])
    expect(skipped.map((s) => `${s.arm}:${s.status}`).sort()).toEqual(['drugs-caffeine:completed', 'drugs:timeout', 'feel:excluded', 'nudge-only:pending'])
  })

  test('filters narrow the pairs; an unknown name is refused', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    expect(collectJudgeable(l.store, 'phase1', { models: [REPLAY_MODELS[0]], fixtures: ['turn-two'] }).pairs).toHaveLength(1)
    expect(() => collectJudgeable(l.store, 'phase1', { fixtures: ['nope'] })).toThrow(/--fixtures/)
    expect(() => collectJudgeable(l.store, 'missing')).toThrow(/no cells/)
  })
})

// ── the answer text ────────────────────────────────────────────────────────

describe('answer text', () => {
  const render = (...events: string[]) => renderJudgeAnswer(parseEvents(stdoutOf(...events)).events)

  test('environment errors collapse into a count and one sample', () => {
    const denied = 'EACCES: permission denied, open /secret/file'
    const r = render(
      textEvent('Reading the file.'),
      ...Array.from({ length: 4 }, () => toolEvent('read', { filePath: '/x' }, 'error', denied)),
      toolEvent('bash', { command: 'false' }, 'error', 'exit code 1'),
      stepFinish(),
    )
    expect(r.environment_errors).toBe(4)
    expect(r.other_errors).toBe(1)
    expect(r.text).toContain('[tool errors] environment ×4 (sample: ')
    expect(r.text).toContain('other ×1 (sample: exit code 1)')
    expect(r.text.match(/permission denied/g)).toHaveLength(1)
    expect(r.text).toContain('[error:environment] (×4)')
  })

  test('feel and drugs call fields are shown as they are', () => {
    const r = render(toolEvent('feel', { somewhere: 'between the test and the fix', mood: 'stuck' }), toolEvent('metacogs_drugs', { substance: 'caffeine' }), toolEvent('read', { filePath: 'a.txt' }))
    expect(r.text).toContain('[tool] feel {"somewhere":"between the test and the fix","mood":"stuck"}')
    expect(r.text).toContain('[tool] metacogs_drugs {"substance":"caffeine"}')
    expect(r.text).toContain('[tool] read filePath=a.txt')
  })

  test('long answers are clipped to the cap and keep the error footer', () => {
    const r = render(textEvent('x'.repeat(ANSWER_CAP * 2)), toolEvent('read', { filePath: '/x' }, 'error', 'permission denied'))
    expect(r.text.length).toBeLessThanOrEqual(ANSWER_CAP)
    expect(r.text).toContain('[… answer clipped]')
    expect(r.text).toContain('[tool errors] environment ×1')
  })

  test('an empty run reads as (no text)', () => {
    expect(render(stepFinish()).text).toBe('(no text)')
  })
})

// ── validation ─────────────────────────────────────────────────────────────

describe('validation', () => {
  const expected = { arms: ['feel'], disruptionArms: [] as string[] }
  const good = { default_move: 'd', floor: 'agree', arms: [{ arm: 'feel', changed: 'yes', direction: 'toward', first_move: 'f', reason: 'r', quote: 'q' }] }

  test('one surrounding code fence is stripped; prose around the JSON is not', () => {
    const json = JSON.stringify(good)
    expect(parseVerdict(json, expected).ok).toBe(true)
    expect(parseVerdict(`\`\`\`json\n${json}\n\`\`\``, expected).ok).toBe(true)
    expect(parseVerdict(`\`\`\`\r\n${json}\r\n\`\`\`\n`, expected).ok).toBe(true)
    for (const bad of [`${json}\nHope that helps!`, `Here you go:\n${json}`, `\`\`\`json\n${json}\n\`\`\`\nDone.`]) {
      const r = parseVerdict(bad, expected)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('invalid_json')
    }
  })

  test('schema: a direction outside the three is rejected, as are extra keys and long quotes', () => {
    const arm = good.arms[0]!
    const code = (v: unknown) => {
      const r = parseVerdict(JSON.stringify(v), expected)
      return r.ok ? 'ok' : r.code
    }
    expect(code({ ...good, arms: [{ ...arm, direction: 'sideways' }] })).toBe('invalid_schema')
    expect(code({ ...good, arms: [{ ...arm, changed: 'maybe' }] })).toBe('invalid_schema')
    expect(code({ ...good, floor: 'unsure' })).toBe('invalid_schema')
    expect(code({ ...good, extra: 1 })).toBe('invalid_schema')
    expect(code({ ...good, arms: [{ ...arm, quote: Array.from({ length: 26 }, () => 'w').join(' ') }] })).toBe('invalid_schema')
    expect(code({ ...good, arms: [{ ...arm, quote: Array.from({ length: 25 }, () => 'w').join(' ') }] })).toBe('ok')
    expect(code({ ...good, arms: [] })).toBe('invalid_arms')
    expect(code({ ...good, arms: [{ ...arm, arm: 'drugs' }] })).toBe('invalid_arms')
    expect(code({ ...good, arms: [{ ...arm, disruption: 'no' }] })).toBe('invalid_disruption')
  })

  test('quotes anchor on a whitespace-normalised substring', () => {
    expect(quoteAnchored('run the   checks', 'then\nrun the checks next')).toBe(true)
    expect(quoteAnchored('Run the checks', 'then run the checks next')).toBe(false)
    expect(quoteAnchored('invented words', 'then run the checks next')).toBe(false)
  })

  test('invalid JSON is retried once, then recorded as judge_error', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(() => 'I think the feel arm changed things.')
    const summary = await full(l, f)
    expect(f.calls).toHaveLength(2)
    expect(summary).toMatchObject({ judged: 0, judge_errors: 1 })
    const [file] = judgements(l)
    expect(file).toMatchObject({ status: 'judge_error', cell: null, verdicts: [], error: { code: 'invalid_json' }, judge: { attempts: 2 } })
  })

  test('a bad response followed by a good one is judged on the second attempt', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake((user, n) => (n === 1 ? '{"default_move":' : JSON.stringify(verdict(user))))
    const summary = await full(l, f)
    expect(f.calls).toHaveLength(2)
    expect(summary).toMatchObject({ judged: 1, judge_errors: 0 })
    expect(judgements(l)[0]!.judge.attempts).toBe(2)
  })

  test('fenced JSON from a loose model is judged on the first call', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake((user) => `\`\`\`json\n${JSON.stringify(verdict(user))}\n\`\`\``)
    await full(l, f)
    expect(f.calls).toHaveLength(1)
    expect(judgements(l)[0]!.status).toBe('judged')
  })

  test('JSON with trailing prose is retried, and an error if it stays that way', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const once = fake((user, n) => (n === 1 ? `${JSON.stringify(verdict(user))}\n\nLet me know if you want more.` : JSON.stringify(verdict(user))))
    await full(l, once)
    expect(once.calls).toHaveLength(2)
    expect(judgements(l)[0]!.status).toBe('judged')

    const l2 = lab()
    await runSyntheticCampaign(l2, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const always = fake((user) => `${JSON.stringify(verdict(user))}\n\nNote: all arms were similar.`)
    await full(l2, always)
    expect(always.calls).toHaveLength(2)
    expect(judgements(l2)[0]).toMatchObject({ status: 'judge_error', error: { code: 'invalid_json' } })
  })

  test('a schema-invalid direction is rejected, retried, then a judge_error', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(ok({ arm: () => ({ direction: 'sideways' }) }))
    await full(l, f)
    expect(f.calls).toHaveLength(2)
    expect(judgements(l)[0]).toMatchObject({ status: 'judge_error', error: { code: 'invalid_schema' } })
  })

  test('a missing arm is a judge_error', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(l, fake(ok({ drop: ['feel'] })))
    expect(judgements(l)[0]).toMatchObject({ status: 'judge_error', error: { code: 'invalid_arms' } })
  })

  test('a quote not found in the answer is flagged unanchored, not rejected', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(ok({ arm: (arm) => (arm === 'feel' ? { quote: 'words the agent never wrote' } : {}) }))
    await full(l, f)
    expect(f.calls).toHaveLength(1)
    const verdicts = judgements(l)[0]!.verdicts
    expect(verdicts.find((v) => v.arm === 'feel')!.unanchored).toBe(true)
    expect(verdicts.filter((v) => v.unanchored)).toHaveLength(1)
    expect(aggregate(judgements(l)).find((r) => r.arm === 'feel')!.unanchored).toBe(1)
  })

  test('a transport failure leaves the pair unjudged and writes no file', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(() => new TransportError('HTTP 503'))
    const summary = await full(l, f)
    expect(f.calls).toHaveLength(2)
    expect(summary.unjudged).toEqual([{ fixture: 'moment-one', model: REPLAY_MODELS[0], reason: 'transport: HTTP 503' }])
    expect(judgements(l)).toEqual([])
  })
})

// ── the judge model ────────────────────────────────────────────────────────

describe('session id', () => {
  test('a pair sends one session id on both attempts; the next pair gets another', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, models: [REPLAY_MODELS[0]] })
    const f = fake((user, n) => (n === 1 ? 'not json' : JSON.stringify(verdict(user))))
    let n = 0
    await judgeCampaign(options(), { store: l.store, transport: f.transport, sessionId: () => `sess-${++n}` })
    expect(f.calls.map((c) => c.sessionId)).toEqual(['sess-1', 'sess-1', 'sess-2'])
  })

  test('the default session id is a uuid', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(ok())
    await full(l, f)
    expect(f.calls[0]!.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('judge model', () => {
  test('the default is the exact GLM-5.3 id CLIProxy lists', () => {
    expect(selectJudgeModel(['gpt-5.6-luna', GLM, 'glm-5.2'])).toBe(GLM)
    expect(selectJudgeModel(['glm-5.3'])).toBe('glm-5.3')
    expect(selectJudgeModel([GLM, 'glm-5.3'])).toBe(GLM)
  })

  test('a list without GLM-5.3 fails clearly', () => {
    expect(() => selectJudgeModel(['gpt-5.6-luna', 'glm-5.2'])).toThrow(JudgeModelError)
    expect(() => selectJudgeModel(['gpt-5.6-luna', 'glm-5.2'])).toThrow(/no glm-5\.3 model.*glm-5\.2.*--judge-model/)
    expect(() => selectJudgeModel(['a/glm-5.3', 'b/glm-5.3'])).toThrow(/several/)
  })

  test('the run looks the id up once, uses it, and records it', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const f = fake(ok())
    const summary = await full(l, f)
    expect(f.listed.n).toBe(1)
    expect(f.calls.every((c) => c.model === GLM)).toBe(true)
    expect(summary.judgeModel).toBe(GLM)
    for (const j of judgements(l)) expect(j.judge).toMatchObject({ model: GLM, provider: 'scripted', prompt_sha256: JUDGE_PROMPT_SHA256, returned_model: 'glm-5.3' })
    expect(JUDGE_PROMPT_SHA256).toBe(sha256(JUDGE_SYSTEM_PROMPT))
  })

  test('a list without GLM-5.3 stops the run before any call', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!] })
    const f = fake(ok(), ['gpt-5.6-luna'])
    await expect(full(l, f)).rejects.toThrow(JudgeModelError)
    expect(f.calls).toHaveLength(0)
  })

  test('--judge-model overrides without a lookup', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(ok(), [])
    await full(l, f, { judgeModel: 'custom-judge' })
    expect(f.listed.n).toBe(0)
    expect(f.calls[0]!.model).toBe('custom-judge')
    expect(judgements(l)[0]!.judge.model).toBe('custom-judge')
  })

  test('the files carry an input sha that does not depend on the nonce', async () => {
    const a = lab()
    const b = lab()
    for (const l of [a, b]) await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(a, fake(ok()), {}, { nonce: () => 'aaaa1111' })
    await full(b, fake(ok()), {}, { nonce: () => 'bbbb2222' })
    expect(judgements(a)[0]!.judge.input_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(judgements(a)[0]!.judge.input_sha256).toBe(judgements(b)[0]!.judge.input_sha256)
  })
})

// ── the request ────────────────────────────────────────────────────────────

describe('request', () => {
  test('the prompt carries nonce-delimited blocks, the reference and the arm messages', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]], arms: ['continue-a', 'continue-b', 'feel-somewhere'] })
    const f = fake(ok())
    await full(l, f, {}, { nonce: () => 'abc123' })
    const { user, system } = f.calls[0]!
    expect(system).toBe(JUDGE_SYSTEM_PROMPT)
    expect(nonceOf(user)).toBe('abc123')
    expect(user).toContain('judge_arms: feel-somewhere')
    expect(user).toContain('disruption_arms: none')
    expect(user).toContain('- feel-somewhere: /feel in the gap between the test and the fix')
    for (const name of ['SCENARIO', 'REFERENCE', 'ANSWER continue-a', 'ANSWER continue-b', 'ANSWER feel-somewhere']) {
      expect(user).toContain(`<<<BEGIN abc123 ${name}>>>`)
      expect(user).toContain(`<<<END abc123 ${name}>>>`)
    }
    expect(user).toContain(OUTCOME_REF)
  })

  test('a nonce that occurs in the data is replaced', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]], arms: ['continue-a', 'continue-b', 'feel'] })
    const f = fake(ok())
    const nonces = ['Run', 'fresh99']
    await judgeCampaign(options(), { store: l.store, transport: f.transport, nonce: () => nonces.shift() ?? 'fresh99' })
    expect(nonceOf(f.calls[0]!.user)).toBe('fresh99')
  })

  test('the reference reads the optional author_next_turn_ref and tolerates extra fields', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!] })
    const file = join(l.store.root, 'fixtures', 'moment-one', 'spec.json')
    const spec = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...spec, author_next_turn_ref: 'AUTHOR-NEXT-REF', extra_field: { a: 1 } }))
    const ref = loadReference(l.store, 'moment-one')
    expect(ref).toMatchObject({ kind: 'feel', expected_outcome_ref: OUTCOME_REF, author_next_turn_ref: 'AUTHOR-NEXT-REF' })
    expect(ref.brief).toContain('Trying a clean install.')
    expect(buildUserMessage({ nonce: 'n1', reference: ref, arms: [] })).toContain('AUTHOR-NEXT-REF')
    expect(() => loadReference(l.store, '../x')).toThrow()
  })

  test('the reference stays out of the judgement files and the summary', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const summary = await full(l, fake(ok()))
    for (const file of walk(summary.dir)) expect(readFileSync(file, 'utf8')).not.toContain(OUTCOME_REF)
  })
})

// ── the noise floor ────────────────────────────────────────────────────────

describe('floor', () => {
  test('floor=disagree marks the cell noisy and its changes are not counted', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(l, fake(ok({ floor: 'disagree', arm: () => ({ changed: 'yes', direction: 'toward' }) })))
    const [file] = judgements(l)
    expect(file).toMatchObject({ status: 'judged', cell: 'noisy', verdict: { floor: 'disagree' } })
    expect(file!.verdicts.every((v) => v.changed === 'yes')).toBe(true)
    const rows = aggregate(judgements(l))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r).toMatchObject({ changed: 0, toward: 0, away: 0, neutral: 0, noisy: 1 })
    expect(renderSummary({ campaign: 'phase1', files: judgements(l), skipped: [], seed: 1 })).toContain('| 0 | 0 | 0 | 0 | 1 |')
  })

  test('floor=agree counts changes by direction', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const dirs: Record<string, string> = { feel: 'toward', drugs: 'away', whichever: 'neutral' }
    await full(l, fake(ok({ arm: (arm) => (arm in dirs ? { changed: 'yes', direction: dirs[arm] } : { changed: 'yes', direction: 'toward' }) })))
    const rows = aggregate(judgements(l))
    expect(rows.find((r) => r.arm === 'feel')).toMatchObject({ changed: 1, toward: 1, away: 0, neutral: 0, noisy: 0 })
    expect(rows.find((r) => r.arm === 'drugs')).toMatchObject({ changed: 1, toward: 0, away: 1 })
    expect(rows.find((r) => r.arm === 'whichever')).toMatchObject({ changed: 1, neutral: 1 })
  })

  test('changed=no with a stray direction counts nothing', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(l, fake(ok({ arm: () => ({ changed: 'no', direction: 'toward' }) })))
    for (const r of aggregate(judgements(l))) expect(r).toMatchObject({ changed: 0, toward: 0 })
  })

  test('with fewer than two Continue runs there is no floor, and nothing counts', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]], arms: ['continue-a', 'feel'] })
    await full(l, fake(ok({ arm: () => ({ changed: 'yes', direction: 'toward' }) })))
    expect(judgements(l)[0]!.cell).toBe('no_floor')
    expect(aggregate(judgements(l))[0]).toMatchObject({ arm: 'feel', changed: 0, no_floor: 1 })
  })

  test('a pair with no Continue run is not judged', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]], arms: ['feel', 'drugs'] })
    const f = fake(ok())
    const summary = await full(l, f)
    expect(f.calls).toHaveLength(0)
    expect(summary.unjudged[0]!.reason).toBe('no_continue_run')
  })
})

// ── ordinary fixtures ──────────────────────────────────────────────────────

describe('ordinary fixtures', () => {
  test('disruption is asked of command arms only, and counted separately', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, models: [REPLAY_MODELS[0]] })
    const f = fake(ok({ floor: 'disagree', arm: (arm) => (arm === 'feel' ? { disruption: 'yes' } : {}) }))
    await full(l, f)
    const ordinary = f.calls.find((c) => /^fixture_kind: ordinary/m.test(c.user))!
    expect(linesOf(ordinary.user, 'disruption_arms')).toEqual(['feel', 'feel-somewhere', 'drugs', 'drugs-caffeine', 'drugs-psilocybin'])
    const feelCall = f.calls.find((c) => /^fixture_kind: feel/m.test(c.user))!
    expect(linesOf(feelCall.user, 'disruption_arms')).toEqual([])

    const rows = aggregate(judgements(l))
    // The noisy floor does not hide disruption: it is not a change against Continue.
    expect(rows.find((r) => r.arm === 'feel')).toMatchObject({ disruption_asked: 1, disruption_yes: 1, changed: 0 })
    expect(rows.find((r) => r.arm === 'drugs')).toMatchObject({ disruption_asked: 1, disruption_yes: 0 })
    expect(rows.find((r) => r.arm === 'whichever')).toMatchObject({ disruption_asked: 0 })
    expect(renderSummary({ campaign: 'phase1', files: judgements(l), skipped: [], seed: 1 })).toContain('## Disruption')
  })

  test('disruption missing on an ordinary command arm, or present on a feel fixture, is invalid', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, models: [REPLAY_MODELS[0]] })
    const f = fake((user) => {
      const v = verdict(user)
      const arms = v.arms as Record<string, unknown>[]
      if (/^fixture_kind: ordinary/m.test(user)) for (const a of arms) delete a.disruption
      else for (const a of arms) a.disruption = 'no'
      return JSON.stringify(v)
    })
    await full(l, f)
    expect(judgements(l).map((j) => `${j.fixture}:${j.error?.code}`).sort()).toEqual(['moment-one:invalid_disruption', 'turn-two:invalid_disruption'])
  })
})

// ── reruns ─────────────────────────────────────────────────────────────────

describe('reruns', () => {
  test('a rerun skips judged pairs; --again writes a new numbered file and never overwrites', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const dir = judgementDir(l.store, 'phase1')
    const f1 = fake(ok())
    await full(l, f1)
    const first = readFileSync(join(dir, `moment-one__${REPLAY_MODELS[0].replace('/', '__')}.json`), 'utf8')
    expect(f1.calls).toHaveLength(1)

    const f2 = fake(ok())
    const again = await full(l, f2)
    expect(f2.calls).toHaveLength(0)
    expect(again).toMatchObject({ already_judged: 1, judged: 0 })

    const f3 = fake(ok({ default_move: 'A second opinion.' }))
    await full(l, f3, { again: true })
    expect(f3.calls).toHaveLength(1)
    const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    expect(names).toEqual([`moment-one__${REPLAY_MODELS[0].replace('/', '__')}.2.json`, `moment-one__${REPLAY_MODELS[0].replace('/', '__')}.json`])
    expect(readFileSync(join(dir, names[1]!), 'utf8')).toBe(first)
    expect(judgements(l).map((j) => j.run).sort()).toEqual([1, 2])
    // The summary reads the newest judged file.
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('A second opinion.')
  })

  test('a judge_error pair is judged again without --again', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(l, fake(() => 'nope'))
    expect(judgements(l)[0]!.status).toBe('judge_error')
    await full(l, fake(ok()))
    expect(judgements(l).map((j) => `${j.run}:${j.status}`)).toEqual(['1:judge_error', '2:judged'])
    expect(aggregate(judgements(l)).every((r) => r.judge_errors === 0)).toBe(true)
  })

  test('judge errors are counted per arm and model while a pair has no judged file', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    await full(l, fake(() => 'nope'))
    const rows = aggregate(judgements(l))
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.judge_errors === 1 && r.pairs === 0)).toBe(true)
  })

  test('the campaign directory is never modified', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const before = treeHash(campaignDir(l.store, 'phase1'))
    await full(l, fake(ok()))
    await full(l, fake(ok()), { again: true })
    expect(treeHash(campaignDir(l.store, 'phase1'))).toBe(before)
  })
})

// ── the cap ────────────────────────────────────────────────────────────────

describe('cap', () => {
  test('a live run stops before a call that could pass the cap', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const f = fake(ok())
    const summary = await full(l, f, { provider: 'cliproxy', capUsd: 0.000001 })
    expect(f.calls).toHaveLength(0)
    expect(summary.unjudged).toHaveLength(4)
    expect(summary.unjudged.every((u) => u.reason === 'budget')).toBe(true)
  })

  test('a live run needs a cap', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    await expect(full(l, fake(ok()), { provider: 'cliproxy' })).rejects.toThrow(/--cap/)
  })

  test('a generous cap judges everything', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const summary = await full(l, fake(ok()), { provider: 'cliproxy', capUsd: 5 })
    expect(summary).toMatchObject({ judged: 4, unjudged: [] })
    expect(summary.spentUsd).toBeGreaterThan(0)
  })

  test('a transport failure keeps its estimate in the spend and leaves a text-free ledger record', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(() => new TransportError('HTTP 503'))
    const summary = await full(l, f, { provider: 'cliproxy', capUsd: 5 })
    expect(f.calls).toHaveLength(2)
    expect(summary.spentUsd).toBeGreaterThan(0)
    expect(judgements(l)).toEqual([])
    const ledger = readFileSync(join(summary.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ fixture: 'moment-one', model: REPLAY_MODELS[0], judge: { provider: 'cliproxy' } })
    expect(ledger[0].estimated_usd).toBeCloseTo(summary.spentUsd, 6)
    expect(JSON.stringify(ledger)).not.toContain('503')
  })

  test('the estimate is reserved before dispatch: a failed first call counts against the retry', async () => {
    const probe = lab()
    await runSyntheticCampaign(probe, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const one = (await full(probe, fake(() => new TransportError('HTTP 503')), { provider: 'cliproxy', capUsd: 5 })).spentUsd / 2
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(() => new TransportError('HTTP 503'))
    const summary = await full(l, f, { provider: 'cliproxy', capUsd: one * 1.5 })
    expect(f.calls).toHaveLength(1)
    expect(summary.unjudged).toHaveLength(1)
    expect(summary.spentUsd).toBeCloseTo(one, 6)
  })

  test('a resume counts what an earlier failed run was estimated to cost', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const first = await full(l, fake(() => new TransportError('HTTP 503')), { provider: 'cliproxy', capUsd: 5 })
    const f = fake(ok())
    const resumed = await full(l, f, { provider: 'cliproxy', capUsd: first.spentUsd * 1.2 })
    expect(f.calls).toHaveLength(0)
    expect(resumed.unjudged.map((u) => u.reason)).toEqual(['budget'])
  })
})

// ── the summary and the spot-check ─────────────────────────────────────────

describe('summary', () => {
  test('the spot-check list is deterministic for a seed and holds ten verdicts', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    await full(l, fake(ok()))
    const files = judgements(l)
    const a = spotCheck(files, 42)
    expect(a).toHaveLength(10)
    expect(spotCheck(files, 42)).toEqual(a)
    expect(spotCheck([...files].reverse(), 42)).toEqual(a)
    expect(spotCheck(files, 43)).not.toEqual(a)
    expect(new Set(a.map((p) => `${p.fixture}|${p.model}|${p.arm}`)).size).toBe(10)
    expect(a.every((p) => p.arm !== 'continue-a' && p.arm !== 'continue-b')).toBe(true)
    expect(spotCheck(files.slice(0, 1), 1)).toHaveLength(7)
    expect(defaultSeed('phase1', files)).toBe(defaultSeed('phase1', [...files].reverse()))
  })

  test('summary.md has the per-arm table, a row per fixture, and the spot-check list', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, answer: (job) => (job.arm === 'whichever' ? 'timeout' : undefined) })
    const summary = await full(l, fake(ok({ default_move: 'Runs the checks.' })), { seed: 7 })
    const text = readFileSync(summary.summaryPath, 'utf8')
    expect(text).toContain('## Per arm and model')
    expect(text).toContain('| model | arm | judged | changed | toward | away | neutral | noisy cells | no floor | judge errors | unanchored |')
    expect(text).toContain('| fixture | floor | default move | feel | feel-somewhere |')
    expect(text).toContain('| moment-one | agree | Runs the checks. |')
    expect(text).toContain('## Spot-check (10 verdicts, seed 7)')
    expect(text.match(/^\d+\. /gm)).toHaveLength(10)
    expect(text).toContain('- timeout · timeout: 4')
    expect(text).toContain('quote: "Run the checks next."')
  })

  test('the same seed gives the same spot-check section on a rerun', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const s1 = await full(l, fake(ok()))
    const first = readFileSync(s1.summaryPath, 'utf8')
    const s2 = await full(l, fake(ok()))
    expect(readFileSync(s2.summaryPath, 'utf8')).toBe(first)
  })
})

// ── custody and secrets ────────────────────────────────────────────────────

describe('custody', () => {
  test('judgement files and the summary are 0600 in a 0700 directory under the state root', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const summary = await full(l, fake(ok()))
    expect(summary.dir).toBe(join(l.store.root, 'judgements', 'phase1'))
    expect(statSync(summary.dir).mode & 0o777).toBe(0o700)
    const files = readdirSync(summary.dir)
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(4)
    expect(files).toContain('summary.md')
    for (const f of files) expect(statSync(join(summary.dir, f)).mode & 0o777).toBe(0o600)
  })

  test('a judge directory inside the repository throws', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!] })
    const inRepo = { ...l.store, root: join(l.repoRoot, 'replay') }
    const f = fake(ok())
    await expect(judgeCampaign(options(), { store: inRepo, transport: f.transport })).rejects.toThrow(CustodyError)
    expect(f.calls).toHaveLength(0)
    expect(readdirSync(l.repoRoot)).toEqual([])
  })
})

describe('secrets', () => {
  const needles = [
    { label: 'auth_cliproxy:key', value: KEY },
    { label: 'auth_cliproxy:key_prefix', value: KEY.slice(0, 14) },
  ]

  test('a normal run never writes the key', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const summary = await full(l, fake(ok()), {}, { needles })
    for (const f of walk(summary.dir)) expect(readFileSync(f, 'utf8')).not.toContain(KEY)
  })

  test('a response that echoes the key is a credential leak and nothing is written for it', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const f = fake(ok({ arm: () => ({ reason: `The key is ${KEY}.` }) }))
    await expect(full(l, f, {}, { needles })).rejects.toThrow(CredentialLeakError)
    expect(walk(judgementDir(l.store, 'phase1')).filter((p) => readFileSync(p, 'utf8').includes(KEY))).toEqual([])
    expect(judgements(l)).toEqual([])
  })

  test('the CLIProxy transport scrubs the key from failures and sends it only as a bearer token', async () => {
    const seen: { url: string; auth: string | null; body: string | null }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization ?? null, body: (init.body as string | undefined) ?? null })
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: GLM }, { id: 'gpt-x' }] }), { status: 200 })
      return new Response(`bad key ${KEY}`, { status: 401 })
    }) as unknown as typeof fetch
    const t = cliproxyTransport({ key: KEY, baseUrl: 'https://proxy.test/v1', fetch: fetcher })
    expect(await t.listModels()).toEqual([GLM, 'gpt-x'])
    const err = await t.complete({ model: GLM, system: 's', user: 'u', sessionId: 'sess-1' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as Error).message).toContain('HTTP 401')
    expect((err as Error).message).not.toContain(KEY)
    expect(seen[0]).toMatchObject({ url: 'https://proxy.test/v1/models', auth: `Bearer ${KEY}` })
    expect(seen[1]!.url).toBe('https://proxy.test/v1/chat/completions')
    expect(JSON.parse(seen[1]!.body!)).toMatchObject({ model: GLM, stream: false, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
    expect(seen[1]!.body).not.toContain(KEY)
  })

  test('the CLIProxy transport sends the OpenCode session headers on chat completions', async () => {
    const sent: Record<string, string>[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/chat/completions')) sent.push(init.headers as Record<string, string>)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const t = cliproxyTransport({ key: KEY, fetch: fetcher })
    await t.complete({ model: GLM, system: 's', user: 'u', sessionId: 'sess-abc' })
    await t.complete({ model: GLM, system: 's', user: 'u', sessionId: 'sess-abc' })
    expect(sent).toHaveLength(2)
    for (const h of sent) expect(h).toMatchObject({ 'x-opencode-session': 'sess-abc', 'x-opencode-session-id': 'sess-abc', 'x-opencode-client': 'cli', 'content-type': 'application/json', authorization: `Bearer ${KEY}` })
    expect(sent[0]!['x-opencode-request']).not.toBe(sent[1]!['x-opencode-request'])
  })

  test('the CLIProxy transport reads the answer and token counts', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ model: 'glm-5.3', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch
    const t = cliproxyTransport({ key: KEY, fetch: fetcher })
    expect(await t.complete({ model: GLM, system: 's', user: 'u', sessionId: 'sess-1' })).toEqual({ text: '{"a":1}', returnedModel: 'glm-5.3', inputTokens: 10, outputTokens: 5 })
  })
})

// ── the command line ───────────────────────────────────────────────────────

describe('judge command', () => {
  function cli(l: SheetLab, deps: JudgeCliDeps = {}) {
    const out: string[] = []
    const err: string[] = []
    const run = (...argv: string[]) => judgeMain(['judge', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s), env: { XDG_STATE_HOME: l.state }, repoRoot: l.repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z'), judge: deps })
    return { run, out, err }
  }

  test('the scripted provider judges a campaign end to end and exits 0', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const c = cli(l)
    expect(await c.run('phase1')).toBe(0)
    expect(c.out.join('\n')).toContain('judged=4')
    expect(c.out.join('\n')).toContain(`model=${GLM}`)
    expect(statSync(join(l.store.root, 'judgements', 'phase1', 'summary.md')).mode & 0o777).toBe(0o600)
    // A rerun is a no-op.
    const again = cli(l)
    expect(await again.run('phase1')).toBe(0)
    expect(again.out.join('\n')).toContain('already=4')
  })

  test('exit 3 when some pair could not be judged', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const c = cli(l, { transport: fake(() => 'not json').transport })
    expect(await c.run('phase1')).toBe(3)
    expect(c.out.join('\n')).toContain('judge_error=1')
  })

  test('exit 3 when a transport failure leaves a pair unjudged', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const c = cli(l, { transport: fake(() => new TransportError('HTTP 500')).transport })
    expect(await c.run('phase1')).toBe(3)
    expect(c.out.join('\n')).toContain('not judged\tmoment-one')
  })

  test('--models and --fixtures narrow the run', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const f = fake(ok())
    const c = cli(l, { transport: f.transport })
    expect(await c.run('phase1', '--models', REPLAY_MODELS[1], '--fixtures', 'moment-one')).toBe(0)
    expect(f.calls).toHaveLength(1)
  })

  test('usage errors exit 2; a missing campaign exits 1', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!] })
    const c = cli(l)
    expect(await c.run()).toBe(2)
    expect(await c.run('phase1', '--provider', 'bogus')).toBe(2)
    expect(await c.run('phase1', '--provider', 'cliproxy')).toBe(2)
    expect(await c.run('phase1', '--cap', '-1')).toBe(2)
    expect(await c.run('phase1', '--models', 'not-a-model')).toBe(2)
    expect(await c.run('phase1', '--wat')).toBe(2)
    expect(await c.run('nope')).toBe(1)
    expect(c.err.join('\n')).toContain('usage: bun run replay judge')
  })

  test('a live run without GLM-5.3 listed fails with a clear error and exit 1', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const resolved: ResolvedCliproxy = { keyName: 'k', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }] }
    const c = cli(l, { transport: fake(ok(), ['gpt-5.6-luna']).transport, resolveCliproxy: () => resolved })
    expect(await c.run('phase1', '--provider', 'cliproxy', '--auth-cliproxy', 'k', '--cap', '1')).toBe(1)
    expect(c.err.join('\n')).toMatch(/no glm-5\.3 model/)
    expect(c.err.join('\n') + c.out.join('\n')).not.toContain(KEY)
  })

  test('a live run uses the resolved key, prints no text and leaks nothing', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const resolved: ResolvedCliproxy = { keyName: 'k', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }] }
    const c = cli(l, { transport: fake(ok({ default_move: 'PRIVATE-MOVE-TEXT' })).transport, resolveCliproxy: () => resolved })
    expect(await c.run('phase1', '--provider', 'cliproxy', '--auth-cliproxy', 'k', '--cap', '1', '--judge-model', 'custom')).toBe(0)
    const output = `${c.out.join('\n')}\n${c.err.join('\n')}`
    expect(output).not.toContain(KEY)
    expect(output).not.toContain('PRIVATE-MOVE-TEXT')
    for (const f of walk(join(l.store.root, 'judgements'))) expect(readFileSync(f, 'utf8')).not.toContain(KEY)
  })

  test('a credential leak exits 4', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const resolved: ResolvedCliproxy = { keyName: 'k', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }] }
    const c = cli(l, { transport: fake(ok({ arm: () => ({ reason: KEY }) })).transport, resolveCliproxy: () => resolved })
    expect(await c.run('phase1', '--provider', 'cliproxy', '--auth-cliproxy', 'k', '--cap', '1', '--judge-model', 'custom')).toBe(4)
    expect(c.err.join('\n')).not.toContain(KEY)
  })

  test('the replay entry point routes judge', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], models: [REPLAY_MODELS[0]] })
    const { mainAsync } = await import('./cli')
    const out: string[] = []
    const code = await mainAsync(['judge', 'phase1'], { out: (s) => out.push(s), err: () => {}, env: { XDG_STATE_HOME: l.state }, repoRoot: l.repoRoot })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('judged=1')
  })
})

describe('prompt', () => {
  test('the system prompt states the output contract', () => {
    for (const piece of ['default_move', 'floor', 'changed', 'direction', 'first_move', 'reason', 'quote', 'disruption', 'at most 25 words', 'judge_arms', 'disruption_arms']) expect(JUDGE_SYSTEM_PROMPT).toContain(piece)
  })
})
