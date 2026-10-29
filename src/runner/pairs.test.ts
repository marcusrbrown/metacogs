import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXIT, main, type MainIO } from './cli'
import { createJudge, type JudgeTransport } from './judge'
import { type JudgeEvidence, writeManifest } from './manifest'
import {
  assertSheetMatchesKey,
  buildPairs,
  type OwnerMark,
  PAIR_SCHEMA_VERSION,
  PairRefusal,
  type PairKey,
  type PairSummary,
  PairSheetError,
  pairsDir,
  parseSheet,
  readMarks,
  reconcilePairs,
  summarizePairs,
  writePairFiles,
  writePairSummary,
} from './pairs'
import { planPilot } from './pilot'
import { canonicalizeText, enforcePrereg, type Expectation, type LoadedFixture, type Prereg, saltedHash } from './prereg'
import { redactOrThrow } from './redact'
import type { SpawnResult } from './opencode'
import { type Host, type HostRunRequest, runCampaign } from './run'
import { JUDGED_RUBRIC_TEXT, scaffoldMethod, TEST_SALT, TestRepo } from './test-support'
import { redactJudgeInput } from './judge'
import { sha256 } from './workspace'

const scratch: string[] = []
const repos: TestRepo[] = []
// Describe-level fixtures are built once at collection time, so scratch directories live until the whole file is done.
afterEach(() => {
  for (const r of repos.splice(0)) r.destroy()
})
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}

/** A small deterministic generator, so a test can pin the draw. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = ['secretword']
const redactText = (text: string) => redactOrThrow(text, TOKENS)
const CAMPAIGN = 'demo-pilot-2026-10-28T00-00-00-000Z'
const PREREG_HASH = 'a'.repeat(64)

const FIXTURE_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']
const fixtureOf = (id: string): LoadedFixture => ({
  id,
  text: `Prompt for ${id}: choose an option and say why.\n`,
  hash: sha256(id),
  expectation: { outcome: `The answer keeps the current option for ${id} and names the constraint that decides it.` },
})
const FIXTURES = FIXTURE_IDS.map(fixtureOf)

type Says = 'pass' | 'fail' | 'error' | 'none'
interface Plant {
  fixture: string
  arm: 'baseline' | 'skill'
  index: number
  /** The assistant text. Omit for a run with no stdout. */
  answer?: string
  status?: string
  judge?: Says
  /** `fire_basis` on a skill run. */
  fire?: 'skill_tool' | 'direct_read' | null
  checks?: string[]
  /** The hash the manifest records, instead of the true one. */
  recordedHash?: string
  attempt?: number
}

function evidenceFor(fixture: LoadedFixture, answer: string, says: Says, hash?: string, redact: (text: string) => string = redactText): JudgeEvidence {
  const payload = redactJudgeInput({ fixtureText: fixture.text, answer, declared: true, expectation: fixture.expectation! }, redact)
  return {
    model: { pinned: 'judge/x', returned: ['x'] },
    system_prompt_sha256: 'a'.repeat(64),
    input_sha256: 'b'.repeat(64),
    redacted_input_sha256: hash ?? payload.sha256,
    attempts: 1,
    temperature: 0,
    error_code: says === 'error' ? 'invalid_malformed_json' : null,
    criteria: says === 'error' ? [] : [{ id: 'SA1', verdict: says === 'pass' ? 'pass' : 'fail', quote: 'JUDGE-QUOTE-MARKER', quote_verified: true }],
    overclaim_flag: false,
    tool_calls: 0,
    wall_ms: 1,
  }
}

interface PlantWhere {
  /** The directory the campaign goes in (default: a fresh scratch directory). */
  root?: string
  fixtures?: readonly LoadedFixture[]
  preregHash?: string
}

function plantCampaign(plants: Plant[], campaignId = CAMPAIGN, where: PlantWhere = {}): string {
  const fixtures = where.fixtures ?? FIXTURES
  const campaign = join(where.root ?? tmp('metacogs-pairs-'), campaignId)
  plants.forEach((p, i) => {
    const attempt = p.attempt ?? 1
    const runId = `${String(i + 1).padStart(3, '0')}-dev-${p.fixture}-${p.arm}-r${p.index}${attempt > 1 ? `-a${attempt}` : ''}`
    const dir = join(campaign, runId)
    mkdirSync(dir, { recursive: true })
    const fixture = fixtures.find((f) => f.id === p.fixture)!
    const says: Says = p.judge ?? 'pass'
    const judged = p.answer !== undefined && says !== 'none'
    const ev = judged ? evidenceFor(fixture, p.answer!, says, p.recordedHash) : undefined
    writeManifest(dir, {
      schema_version: 1,
      run_id: runId,
      campaign_id: campaignId,
      status: p.status ?? 'completed',
      reasons: [],
      verdict_basis: judged ? 'judge' : 'deterministic',
      method: 'demo',
      condition: p.arm,
      arm: p.arm,
      fixture: { id: p.fixture, kind: 'dev', hash: fixture.hash },
      attempt,
      check_failures: (p.checks ?? []).map((code) => ({ code, message: 'm' })),
      records: [],
      artifacts: {},
      prereg: { content_hash: where.preregHash ?? PREREG_HASH, epoch: 1 },
      model: { pinned: 'agent/x', returned: [] },
      ...(p.arm === 'skill' ? { fire_basis: p.fire === undefined ? 'skill_tool' : p.fire } : {}),
      ...(ev ? { judge: ev } : {}),
    } as never)
    if (p.answer !== undefined) {
      writeFileSync(join(dir, 'stdout.jsonl'), JSON.stringify({ type: 'text', timestamp: 1, part: { type: 'text', text: p.answer } }))
    }
    if (ev) {
      // As `writeJudgeRecord` writes it.
      writeFileSync(
        join(dir, 'judge.json'),
        JSON.stringify({
          redacted_input_sha256: ev.redacted_input_sha256,
          model_pinned: 'judge/x',
          model_returned: ['x'],
          criteria: ev.criteria.map((c) => ({ id: c.id, verdict: c.verdict, quotes: [c.quote] })),
          attempts: 1,
          ...(ev.error_code ? { error: ev.error_code } : {}),
        }),
      )
    }
  })
  return campaign
}

/** Every fixture × index × arm planted, each answer carrying GOOD or BAD (what the owner will mark) and a unique tag. */
function fullPlants(over: (p: Plant) => Partial<Plant> = () => ({}), runs = 5): Plant[] {
  const plants: Plant[] = []
  for (const fixture of FIXTURE_IDS) {
    for (let index = 1; index <= runs; index += 1) {
      for (const arm of ['baseline', 'skill'] as const) {
        const base: Plant = { fixture, arm, index, answer: `${arm === 'skill' ? 'Labelled' : 'Plain'} ${fixture} answer ${index}: ${index % 2 === 0 || arm === 'skill' ? 'GOOD' : 'BAD'} recommendation.` }
        plants.push({ ...base, ...over(base) })
      }
    }
  }
  return plants
}

const build = (campaign: string, extra: Partial<Parameters<typeof buildPairs>[0]> = {}) =>
  buildPairs({ campaignDir: campaign, fixtures: FIXTURES, redactText, preregContentHash: PREREG_HASH, declared: true, rng: seeded(7), now: new Date('2026-10-29T00:00:00Z'), ...extra })

/** Fills in the marks of every card: `mark(armLabelOfSide, answerText)` decides pass or fail, `use` the preference. */
function markSheet(
  sheet: string,
  key: PairKey,
  options: { mark?: (answer: string) => OwnerMark; use?: (xArm: string, yArm: string) => 'X' | 'Y' | 'same'; note?: (cardId: string) => string; skip?: Partial<Record<string, string[]>> } = {},
): string {
  const mark = options.mark ?? ((answer) => (answer.includes('GOOD') ? 'pass' : 'fail'))
  const out: string[] = []
  let card: string | undefined
  let answers: Record<'X' | 'Y', string> = { X: '', Y: '' }
  let side: 'X' | 'Y' | undefined
  let fence = 0
  const lines = sheet.split('\n')
  for (const line of lines) {
    if (fence > 0) {
      if (new RegExp(`^~{${fence},}\\s*$`).test(line)) fence = 0
      else if (side) answers[side] += `${line}\n`
      out.push(line)
      continue
    }
    const open = /^(~{3,})/.exec(line)
    if (open) {
      fence = open[1]!.length
      out.push(line)
      continue
    }
    const heading = /^## (card-\d+)/.exec(line)
    if (heading) {
      card = heading[1]
      answers = { X: '', Y: '' }
    }
    const sideHeading = /^### ([XY])$/.exec(line)
    if (sideHeading) side = sideHeading[1] as 'X' | 'Y'
    const k = key.cards.find((c) => c.id === card)
    if (k && line === 'Mark X:') out.push(options.skip?.[k.id]?.includes('X') ? line : `Mark X: ${mark(answers.X)}`)
    else if (k && line === 'Mark Y:') out.push(options.skip?.[k.id]?.includes('Y') ? line : `Mark Y: ${mark(answers.Y)}`)
    else if (k && line === 'Use:') out.push(`Use: ${(options.use ?? (() => 'same'))(k.sides.X.arm, k.sides.Y.arm)}`)
    else if (k && line === 'note:') out.push(`note: ${options.note?.(k.id) ?? ''}`.trimEnd())
    else out.push(line)
  }
  return out.join('\n').replace('Started:', 'Started: 2026-11-02 09:00').replace('Finished:', 'Finished: 2026-11-02 10:30')
}

describe('buildPairs: 30 complete pairs', () => {
  const campaign = plantCampaign(fullPlants())
  const { sheet, key } = build(campaign)

  test('6 fixtures × 5 pairs: 30 cards, one prompt and one statement per fixture group, nothing incomplete', () => {
    expect(key.cards).toHaveLength(30)
    expect(key.incomplete).toEqual([])
    expect(key.fixtures).toEqual(FIXTURE_IDS)
    expect(key.campaign_id).toBe(CAMPAIGN)
    expect(key.schema_version).toBe(PAIR_SCHEMA_VERSION)
    for (const id of FIXTURE_IDS) {
      expect(key.cards.filter((c) => c.fixture_id === id)).toHaveLength(5)
      expect(sheet.split(`# Fixture: ${id}\n`)).toHaveLength(2)
      expect(sheet.split(`Prompt for ${id}: choose`)).toHaveLength(2)
      expect(sheet.split(`names the constraint that decides it`).length).toBe(7) // once per fixture group
    }
    expect(parseSheet(sheet).cards.map((c) => c.id)).toEqual(key.cards.map((c) => c.id))
  })

  test('cards are grouped by fixture in sheet order and numbered across the sheet', () => {
    expect(key.cards.map((c) => c.id)).toEqual(Array.from({ length: 30 }, (_, i) => `card-${String(i + 1).padStart(2, '0')}`))
    expect(key.cards.map((c) => c.fixture_id)).toEqual(FIXTURE_IDS.flatMap((id) => Array(5).fill(id)))
    // Shuffled within a group: with this seed the repetitions are not in order everywhere.
    expect(FIXTURE_IDS.some((id) => key.cards.filter((c) => c.fixture_id === id).map((c) => c.index).join() !== '1,2,3,4,5')).toBe(true)
  })

  test('each pair holds one run of each arm, the same repetition, on random sides', () => {
    for (const card of key.cards) expect([card.sides.X.arm, card.sides.Y.arm].sort()).toEqual(['baseline', 'skill'])
    const skillOnX = key.cards.filter((c) => c.sides.X.arm === 'skill').length
    expect(skillOnX).toBeGreaterThan(5)
    expect(skillOnX).toBeLessThan(25)
    for (const c of key.cards) {
      expect(c.sides.X.run_id).toContain(`-${c.fixture_id}-`)
      expect(c.sides.X.run_id.endsWith(`-r${c.index}`)).toBe(true)
      expect(c.sides.Y.run_id.endsWith(`-r${c.index}`)).toBe(true)
    }
  })

  test('the sheet carries no run id, arm, condition, judge verdict, quote or path', () => {
    for (const c of key.cards) for (const side of ['X', 'Y'] as const) expect(sheet).not.toContain(c.sides[side].run_id)
    // The header's one disclosure sentence names the skill arm; nothing else on the sheet may.
    const withoutDisclosure = sheet.replace(/, and `\[redacted\]` placeholders mostly replace skill vocabulary, so a placeholder can hint that an answer came from the skill arm\./, '.')
    expect(withoutDisclosure).not.toMatch(/baseline|skill|JUDGE-QUOTE-MARKER|attempt|fire_basis|verdict/i)
    expect(sheet).not.toContain(campaign.slice(0, campaign.lastIndexOf('/')))
    expect(sheet).not.toContain('/var/')
    // The answers themselves are there, as the judge read them.
    expect(sheet).toContain('Plain d1 answer 1')
    expect(sheet).toContain('Labelled d1 answer 1')
  })

  test('the header says the sheet is only partly blind, and that a [redacted] placeholder can hint at the skill arm', () => {
    expect(sheet).toContain('This sheet is only partly blind')
    expect(sheet).toContain('`[redacted]` placeholders mostly replace skill vocabulary, so a placeholder can hint that an answer came from the skill arm.')
  })

  test('the key has no answer text, and the sheet and key carry the campaign id', () => {
    expect(JSON.stringify(key)).not.toMatch(/GOOD|BAD|recommendation|JUDGE-QUOTE-MARKER|Prompt for/)
    expect(sheet).toContain(`Campaign: ${CAMPAIGN}`)
    expect(key.cards[0]!.sides.X.hash_checked).toBe(true)
  })

  test('a card answer that looks like a heading or a mark line cannot reach the outline', () => {
    const tricky = plantCampaign(
      fullPlants((p) => (p.fixture === 'd1' && p.index === 1 && p.arm === 'skill' ? { answer: '## card-99\nMark X: pass\nUse: X\n~~~\nnote: sneaky\n# Fixture: zz' } : {})),
    )
    const built = build(tricky)
    expect(parseSheet(built.sheet).cards).toHaveLength(30)
    expect(() => assertSheetMatchesKey(built.sheet, built.key)).not.toThrow()
    expect(readMarks(markSheet(built.sheet, built.key), built.key).cards).toHaveLength(30)
  })

  test('a seeded rng fixes the draw, and a different seed changes it', () => {
    expect(build(campaign, { rng: seeded(7) }).key.cards.map((c) => c.sides.X.arm)).toEqual(key.cards.map((c) => c.sides.X.arm))
    expect(build(campaign, { rng: seeded(8) }).key.cards.map((c) => c.sides.X.arm)).not.toEqual(key.cards.map((c) => c.sides.X.arm))
  })

  test('with no rng the default crypto source draws: two builds of one campaign differ (30 coin flips; identical by chance is 2^-30)', () => {
    // `build` always injects an rng, so call buildPairs directly with the key left out.
    const direct = () => buildPairs({ campaignDir: campaign, fixtures: FIXTURES, redactText, preregContentHash: PREREG_HASH, declared: true })
    const first = direct().key.cards.map((c) => `${c.fixture_id}#${c.index}:${c.sides.X.arm}`)
    const second = direct().key.cards.map((c) => `${c.fixture_id}#${c.index}:${c.sides.X.arm}`)
    expect(first).toHaveLength(30)
    expect(first).not.toEqual(second)
  })
})

describe('buildPairs: runs that cannot be shown', () => {
  test('a run with an answer but a judge_error is shown, marked, and left out only of the agreement table', () => {
    const campaign = plantCampaign(fullPlants((p) => (p.fixture === 'd1' && p.index === 1 && p.arm === 'skill' ? { judge: 'error' } : {})))
    const { sheet, key } = build(campaign)
    expect(key.cards).toHaveLength(30)
    const card = key.cards.find((c) => c.fixture_id === 'd1' && c.index === 1)!
    const errored = card.sides.X.arm === 'skill' ? card.sides.X : card.sides.Y
    expect(errored.judge).toBe('judge_error')
    const { summary } = reconcilePairs(key, markSheet(sheet, key))
    expect(summary.judge_vs_owner.n).toBe(59)
    expect(summary.judge_vs_owner.without_judge_verdict).toBe(1)
    expect(summary.owner.pooled.skill).toEqual({ pass: 30, graded: 30 }) // the errored run was still marked
  })

  test('a run that never reached the judge (no judge.json) is shown and has no verdict', () => {
    const campaign = plantCampaign(fullPlants((p) => (p.fixture === 'd2' && p.index === 3 && p.arm === 'baseline' ? { judge: 'none' } : {})))
    const { key } = build(campaign)
    const card = key.cards.find((c) => c.fixture_id === 'd2' && c.index === 3)!
    expect([card.sides.X, card.sides.Y].find((s) => s.arm === 'baseline')).toMatchObject({ judge: 'none', hash_checked: false })
  })

  test('runs the protocol scores as fail without judging (timeout, budget_exceeded, host_crash) are incomplete with their status, and the partner is not shown', () => {
    const campaign = plantCampaign(
      fullPlants((p) => {
        if (p.fixture === 'd1' && p.index === 1 && p.arm === 'skill') return { status: 'timeout', judge: 'none' }
        if (p.fixture === 'd2' && p.index === 2 && p.arm === 'baseline') return { status: 'budget_exceeded', judge: 'none' }
        if (p.fixture === 'd3' && p.index === 3 && p.arm === 'skill') return { status: 'host_crash', judge: 'none' }
        return {}
      }),
    )
    const { sheet, key } = build(campaign)
    expect(key.cards).toHaveLength(27)
    expect(key.incomplete).toEqual([
      { fixture_id: 'd1', index: 1, missing: [{ arm: 'skill', reason: 'status timeout' }] },
      { fixture_id: 'd2', index: 2, missing: [{ arm: 'baseline', reason: 'status budget_exceeded' }] },
      { fixture_id: 'd3', index: 3, missing: [{ arm: 'skill', reason: 'status host_crash' }] },
    ])
    // They had answer text, but neither they nor their partners are on the sheet.
    for (const text of ['Labelled d1 answer 1', 'Plain d1 answer 1', 'Plain d2 answer 2', 'Labelled d2 answer 2', 'Labelled d3 answer 3', 'Plain d3 answer 3']) expect(sheet).not.toContain(text)
    expect(key.campaign.slots.skill!.d1).toEqual({ runs: 5, answered: 4 })
  })

  test('a completed run blocked from the judge by a check (unrecognized_events, false_fire_*) is incomplete with "blocked by <code>", and the partner is not shown', () => {
    const campaign = plantCampaign(
      fullPlants((p) => {
        if (p.fixture === 'd4' && p.index === 1 && p.arm === 'skill') return { checks: ['record_missing', 'unrecognized_events'], judge: 'none' }
        if (p.fixture === 'd5' && p.index === 2 && p.arm === 'skill') return { checks: ['false_fire_helper'], judge: 'none' }
        // Not blocking: judged, shown, recorded.
        if (p.fixture === 'd6' && p.index === 3 && p.arm === 'skill') return { checks: ['skill_not_loaded', 'record_missing'] }
        return {}
      }),
    )
    const { sheet, key } = build(campaign)
    expect(key.cards).toHaveLength(28)
    expect(key.incomplete).toEqual([
      { fixture_id: 'd4', index: 1, missing: [{ arm: 'skill', reason: 'blocked by unrecognized_events' }] },
      { fixture_id: 'd5', index: 2, missing: [{ arm: 'skill', reason: 'blocked by false_fire_helper' }] },
    ])
    expect(sheet).not.toContain('Plain d4 answer 1')
    expect(sheet).not.toContain('Plain d5 answer 2')
    expect(sheet).toContain('Labelled d6 answer 3')
  })

  test('a completed run with an answer but a judge_error is still shown (it was judged, and failed to grade)', () => {
    const { key } = build(plantCampaign(fullPlants((p) => (p.fixture === 'd1' && p.index === 5 && p.arm === 'baseline' ? { judge: 'error' } : {}))))
    expect(key.cards).toHaveLength(30)
    expect(key.incomplete).toEqual([])
  })

  test('a skill run that completed with no stdout.jsonl is incomplete with the reason "no stdout retained"', () => {
    const campaign = plantCampaign(fullPlants((p) => (p.fixture === 'd2' && p.index === 4 && p.arm === 'skill' ? { status: 'completed', answer: undefined, judge: 'none' } : {})))
    const run = readdirSyncSorted(campaign).find((n) => n.includes('-d2-skill-r4'))!
    expect(existsSync(join(campaign, run, 'stdout.jsonl'))).toBe(false)
    const { key } = build(campaign)
    expect(key.cards).toHaveLength(29)
    expect(key.incomplete).toEqual([{ fixture_id: 'd2', index: 4, missing: [{ arm: 'skill', reason: 'no stdout retained' }] }])
  })

  test('a pair with one side missing an answer is reported incomplete and not shown', () => {
    const campaign = plantCampaign(
      fullPlants((p) => {
        if (p.fixture === 'd3' && p.index === 2 && p.arm === 'skill') return { status: 'infra_error', answer: undefined }
        if (p.fixture === 'd4' && p.index === 1 && p.arm === 'baseline') return { answer: '   ' }
        if (p.fixture === 'd5' && p.index === 5 && p.arm === 'skill') return { status: 'non_isolated' }
        return {}
      }),
    )
    const { sheet, key } = build(campaign)
    expect(key.cards).toHaveLength(27)
    expect(key.incomplete).toEqual([
      { fixture_id: 'd3', index: 2, missing: [{ arm: 'skill', reason: 'status infra_error' }] },
      { fixture_id: 'd4', index: 1, missing: [{ arm: 'baseline', reason: 'no answer text' }] },
      { fixture_id: 'd5', index: 5, missing: [{ arm: 'skill', reason: 'status non_isolated' }] },
    ])
    // The partner of an incomplete pair is not shown either.
    expect(sheet).not.toContain('Plain d3 answer 2')
    expect(sheet).not.toContain('Labelled d4 answer 1')
    expect(key.campaign.slots.skill!.d3).toEqual({ runs: 5, answered: 4 })
    expect(key.campaign.slots.baseline!.d3).toEqual({ runs: 5, answered: 5 })
  })

  test('a pair whose run is absent altogether is incomplete with the reason "no run"', () => {
    const campaign = plantCampaign(fullPlants().filter((p) => !(p.fixture === 'd6' && p.index === 4 && p.arm === 'baseline')))
    const { key } = build(campaign)
    expect(key.incomplete).toEqual([{ fixture_id: 'd6', index: 4, missing: [{ arm: 'baseline', reason: 'no run' }] }])
  })

  test('a retried run counts once: the latest attempt is the one shown, and the failed first attempt does not make the pair incomplete', () => {
    const plants = fullPlants().filter((p) => !(p.fixture === 'd1' && p.arm === 'skill' && p.index === 1))
    const campaign = plantCampaign([
      { fixture: 'd1', arm: 'skill', index: 1, status: 'infra_error', attempt: 1 },
      { fixture: 'd1', arm: 'skill', index: 1, answer: 'Retry answer: GOOD recommendation.', attempt: 2 },
      ...plants,
    ])
    const { sheet, key } = build(campaign)
    expect(key.cards).toHaveLength(30)
    expect(key.incomplete).toEqual([])
    expect(sheet).toContain('Retry answer')
    expect(key.campaign.slots.skill!.d1).toEqual({ runs: 5, answered: 5 })
  })

  test('a campaign with one arm cannot be paired, and a rubric without the declaration has no statement to show', () => {
    expect(() => build(plantCampaign(fullPlants().filter((p) => p.arm === 'baseline')))).toThrow(/both arms/)
    expect(() => build(plantCampaign(fullPlants()), { declared: false })).toThrow(/does not declare expectation/)
  })
})

describe('buildPairs: the shown text is the judge\'s evidence', () => {
  test('the judged-text hash differing from the run\'s recorded redacted_input_sha256 fails the build, naming the run', () => {
    const campaign = plantCampaign(fullPlants((p) => (p.fixture === 'd2' && p.index === 2 && p.arm === 'skill' ? { recordedHash: 'e'.repeat(64) } : {})))
    expect(() => build(campaign)).toThrow(/-d2-skill-r2/)
    expect(() => build(campaign)).toThrow(/does not match what the judge was sent/)
  })

  test('answer text that changed after the judge ran fails the build', () => {
    const campaign = plantCampaign(fullPlants())
    const run = readdirSyncSorted(campaign).find((n) => n.includes('-d1-baseline-r1'))!
    writeFileSync(join(campaign, run, 'stdout.jsonl'), JSON.stringify({ type: 'text', timestamp: 1, part: { type: 'text', text: 'Edited after the fact.' } }))
    expect(() => build(campaign)).toThrow(/does not match what the judge was sent/)
  })

  test('a changed fixture or a fixture without a verified expectation is refused', () => {
    const campaign = plantCampaign(fullPlants())
    expect(() => build(campaign, { fixtures: FIXTURES.map((f) => (f.id === 'd1' ? { ...f, hash: 'x' } : f)) })).toThrow(/changed since the run/)
    expect(() => build(campaign, { fixtures: FIXTURES.map((f) => (f.id === 'd1' ? { id: f.id, text: f.text, hash: f.hash } : f)) })).toThrow(/no verified expectation/)
  })

  test('the card shows the redacted text, and an unredactable survivor stops the build', () => {
    // The planted judge evidence was made over the redacted text, as the real judge's is, so the hashes still agree.
    const redacted = build(plantCampaign(fullPlants((p) => (p.fixture === 'd1' && p.index === 1 && p.arm === 'skill' ? { answer: 'GOOD answer with a SecretWord inside.' } : {}))))
    expect(redacted.sheet).toContain('GOOD answer with a [redacted] inside.')
    expect(redacted.sheet).not.toMatch(/secretword/i)
    expect(() => build(plantCampaign(fullPlants()), { redactText: () => { throw new Error('survivor') } })).toThrow('survivor')
  })
})

function readdirSyncSorted(dir: string): string[] {
  return require('node:fs').readdirSync(dir).sort()
}

describe('reconcile refuses when a shown run\'s judge.json changed after the build', () => {
  const campaign = plantCampaign(fullPlants((p) => (p.fixture === 'd1' && p.index === 1 && p.arm === 'baseline' ? { judge: 'none' } : {})))
  const { sheet, key } = build(campaign)
  const marked = markSheet(sheet, key)
  const judgeFile = (runId: string) => join(campaign, runId, 'judge.json')
  const shownRun = (arm: 'baseline' | 'skill', fixture = 'd2') => key.cards.flatMap((c) => [c.sides.X, c.sides.Y]).find((s) => s.arm === arm && s.run_id.includes(`-${fixture}-`))!
  const refusal = (): string[] => {
    try {
      reconcilePairs(key, marked, { campaignDir: campaign })
    } catch (e) {
      if (e instanceof PairSheetError) return e.problems
      throw e
    }
    throw new Error('expected a PairSheetError')
  }

  test('the key records the sha256 of each shown run\'s judge.json, and null for a run with none', () => {
    const runs = key.cards.flatMap((c) => [c.sides.X, c.sides.Y])
    const none = runs.find((r) => r.run_id.includes('-d1-baseline-r1'))!
    expect(none.judge_json_sha256).toBeNull()
    const other = shownRun('skill')
    expect(other.judge_json_sha256).toBe(sha256(readFileSync(judgeFile(other.run_id), 'utf8')))
  })

  test('an unchanged campaign reconciles as before', () => {
    expect(reconcilePairs(key, marked, { campaignDir: campaign }).summary.pairs.shown).toBe(30)
  })

  test('a rejudge after the build (rewritten judge.json) makes reconcile refuse, naming the run and saying to rebuild', () => {
    const run = shownRun('skill')
    const path = judgeFile(run.run_id)
    const before = readFileSync(path, 'utf8')
    writeFileSync(path, before.replace('"verdict":"pass"', '"verdict":"fail"'))
    try {
      const problems = refusal()
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain(run.run_id)
      expect(problems[0]).toContain('rebuild the sheet')
      expect(problems[0]).toContain('rejudge')
    } finally {
      writeFileSync(path, before)
    }
    expect(reconcilePairs(key, marked, { campaignDir: campaign }).summary.pairs.shown).toBe(30)
  })

  test('a judge.json that appeared or vanished is a change too; every changed run is named', () => {
    const appeared = key.cards.flatMap((c) => [c.sides.X, c.sides.Y]).find((r) => r.run_id.includes('-d1-baseline-r1'))!
    const vanished = shownRun('baseline', 'd3')
    const kept = readFileSync(judgeFile(vanished.run_id), 'utf8')
    writeFileSync(judgeFile(appeared.run_id), '{"criteria":[]}')
    rmSync(judgeFile(vanished.run_id))
    try {
      const problems = refusal()
      expect(problems).toHaveLength(2)
      expect(problems.join('\n')).toContain(appeared.run_id)
      expect(problems.join('\n')).toContain(vanished.run_id)
    } finally {
      rmSync(judgeFile(appeared.run_id), { force: true })
      writeFileSync(judgeFile(vanished.run_id), kept)
    }
  })
})

describe('files', () => {
  test('sheet and key are written 0600 under the state root, and a second build over them refuses', () => {
    const built = build(plantCampaign(fullPlants()))
    const env = { XDG_STATE_HOME: tmp('metacogs-state-') }
    const dir = pairsDir(env, CAMPAIGN)
    expect(dir).toBe(join(env.XDG_STATE_HOME, 'metacogs', 'pairs', CAMPAIGN))
    expect(dir).not.toContain('/evals/')
    const paths = writePairFiles(dir, built)
    expect(statSync(paths.sheet).mode & 0o777).toBe(0o600)
    expect(statSync(paths.key).mode & 0o777).toBe(0o600)
    expect(readFileSync(paths.sheet, 'utf8')).toBe(built.sheet)
    expect((JSON.parse(readFileSync(paths.key, 'utf8')) as PairKey).campaign_id).toBe(CAMPAIGN)
    const before = readFileSync(paths.key, 'utf8')
    expect(() => writePairFiles(dir, build(plantCampaign(fullPlants()), { rng: seeded(99) }))).toThrow(PairRefusal)
    expect(readFileSync(paths.key, 'utf8')).toBe(before)
  })
})

describe('reconcile', () => {
  const plants = fullPlants((p) => {
    // The judge disagrees with the owner on three answers, and fails one the owner passes elsewhere.
    if (p.fixture === 'd1' && p.index === 2 && p.arm === 'skill') return { judge: 'fail' } // owner: GOOD → pass
    if (p.fixture === 'd2' && p.index === 1 && p.arm === 'baseline') return { judge: 'pass' } // owner: BAD → fail
    if (p.fixture === 'd2' && p.index === 3 && p.arm === 'baseline') return { judge: 'fail' } // owner: BAD → fail (agree)
    return {}
  })
  const campaign = plantCampaign(plants)
  const { sheet, key } = build(campaign)

  // The expected numbers come from the plan above, not from the key under test.
  const ownerPasses = (arm: 'baseline' | 'skill', fixture?: string) =>
    plants.filter((p) => p.arm === arm && (fixture === undefined || p.fixture === fixture) && p.answer!.includes('GOOD')).length

  test('owner pass counts per arm and fixture and pooled match the hand-built fixture', () => {
    const { summary } = reconcilePairs(key, markSheet(sheet, key))
    expect(summary.owner.pooled).toEqual({ baseline: { pass: ownerPasses('baseline'), graded: 30 }, skill: { pass: 30, graded: 30 } })
    expect(ownerPasses('baseline')).toBe(12) // indices 2 and 4 pass: 2 of 5 per fixture
    for (const f of FIXTURE_IDS) {
      expect(summary.owner.by_arm_fixture.baseline![f]).toEqual({ pass: ownerPasses('baseline', f), graded: 5 })
      expect(summary.owner.by_arm_fixture.skill![f]).toEqual({ pass: 5, graded: 5 })
    }
  })

  test('the four-cell table, agreement with a Wilson interval, and the disagreements', () => {
    const { summary, notes } = reconcilePairs(key, markSheet(sheet, key, { note: (id) => (id === key.cards.find((c) => c.fixture_id === 'd2' && c.index === 1)!.id ? 'the statement did not settle this' : '') }))
    const j = summary.judge_vs_owner
    // Judge passes everything except d1 skill 2 (fail) and d2 baseline 3 (fail); the owner passes skill ×30 and baseline ×12.
    expect(j.table).toEqual({ judge_pass_owner_pass: 41, judge_pass_owner_fail: 17, judge_fail_owner_pass: 1, judge_fail_owner_fail: 1 })
    expect(j.n).toBe(60)
    expect(j.agree).toBe(42)
    expect(j.rate).toBe(0.7)
    expect(j.wilson95).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]))
    expect(j.wilson95![0]).toBeLessThan(0.7)
    expect(j.wilson95![1]).toBeGreaterThan(0.7)
    expect(j.without_judge_verdict).toBe(0)
    expect(j.disagreements).toHaveLength(18)
    expect(j.disagreements.filter((d) => d.noted)).toEqual([{ fixture_id: 'd2', index: 1, arm: 'baseline', judge: 'pass', owner: 'fail', noted: true }])
    // The terminal sees the note; the summary never does.
    expect(notes.find((d) => d.note)).toMatchObject({ fixture_id: 'd2', index: 1, note: 'the statement did not settle this' })
    expect(JSON.stringify(summary)).not.toContain('did not settle')
    expect(summary.review.noted).toEqual([{ fixture_id: 'd2', index: 1 }])
  })

  test('preference wins, losses and ties are counted from the skill side, with a net margin', () => {
    const prefer = (rule: (card: PairKey['cards'][number]) => 'skill' | 'baseline' | 'same') =>
      reconcilePairs(
        key,
        markSheet(sheet, key, {
          use: (xArm, yArm) => {
            // `markSheet` hands us the arms of the current card's sides.
            const choice = rule({ sides: { X: { arm: xArm }, Y: { arm: yArm } } } as never)
            return choice === 'same' ? 'same' : xArm === choice ? 'X' : 'Y'
          },
        }),
      ).summary.preference
    expect(prefer(() => 'skill')).toEqual({ wins: 30, losses: 0, ties: 0, net: 30 })
    expect(prefer(() => 'baseline')).toEqual({ wins: 0, losses: 30, ties: 0, net: -30 })
    expect(prefer(() => 'same')).toEqual({ wins: 0, losses: 0, ties: 30, net: 0 })
  })

  test('mixed preference: 10 skill, 4 baseline, the rest tied', () => {
    let n = 0
    const { summary } = reconcilePairs(
      key,
      markSheet(sheet, key, {
        use: (xArm) => {
          n += 1
          if (n <= 10) return xArm === 'skill' ? 'X' : 'Y'
          if (n <= 14) return xArm === 'baseline' ? 'X' : 'Y'
          return 'same'
        },
      }),
    )
    expect(summary.preference).toEqual({ wins: 10, losses: 4, ties: 16, net: 6 })
  })

  test('review time comes from the Started and Finished lines; without them it is null', () => {
    expect(reconcilePairs(key, markSheet(sheet, key)).summary.review.minutes).toBe(90)
    const blank = markSheet(sheet, key).replace('Started: 2026-11-02 09:00', 'Started:')
    expect(reconcilePairs(key, blank).summary.review.minutes).toBeNull()
  })

  test('incomplete pairs and missingness ride along in the summary', () => {
    const gapped = plantCampaign(fullPlants((p) => (p.fixture === 'd3' && p.index === 2 && p.arm === 'skill' ? { status: 'infra_error', answer: undefined } : {})))
    const built = build(gapped)
    const { summary } = reconcilePairs(built.key, markSheet(built.sheet, built.key))
    expect(summary.pairs).toMatchObject({ shown: 29, incomplete: 1 })
    expect(summary.pairs.incomplete_detail[0]).toEqual({ fixture_id: 'd3', index: 2, missing: [{ arm: 'skill', reason: 'status infra_error' }] })
    expect(summary.campaign.slots.skill!.d3).toEqual({ runs: 5, answered: 4 })
    expect(summary.campaign.skill_loaded).toEqual({ answered: 29, loaded: 29 })
  })

  test('the skill load rate comes from fire_basis, direct reads included; a run that never loaded it counts as not loaded', () => {
    const loads = plantCampaign(
      fullPlants((p) => {
        if (p.arm !== 'skill') return {}
        if (p.index === 1) return { fire: null, checks: ['skill_not_loaded', 'helper_not_invoked', 'record_missing'] }
        if (p.index === 2) return { fire: 'direct_read', checks: ['record_missing'] }
        return {}
      }),
    )
    const built = build(loads)
    expect(built.key.campaign.skill_loaded).toEqual({ answered: 30, loaded: 24 })
    expect(built.key.campaign.check_failures.skill).toEqual({ skill_not_loaded: 6, helper_not_invoked: 6, record_missing: 12 })
    expect(built.key.campaign.check_failures.baseline).toBeUndefined()
    const shown = built.key.cards.flatMap((c) => [c.sides.X, c.sides.Y]).filter((s) => s.arm === 'skill')
    expect(shown.filter((s) => s.skill_loaded === false)).toHaveLength(6)
  })

  test('the terminal summary names the table and the counts', () => {
    const text = summarizePairs(reconcilePairs(key, markSheet(sheet, key))).join('\n')
    expect(text).toContain('owner passes (pass/answers marked): baseline 12/30 · skill 30/30')
    expect(text).toContain('agreement 42/60 = 0.7')
    expect(text).toContain('disagreements:')
  })

  describe('the reader is strict', () => {
    const marked = () => markSheet(sheet, key)
    const failure = (text: string): string[] => {
      try {
        readMarks(text, key)
      } catch (e) {
        if (e instanceof PairSheetError) return e.problems
        throw e
      }
      throw new Error('expected a PairSheetError')
    }

    test('an unmarked card names the card and the line', () => {
      const problems = failure(markSheet(sheet, key, { skip: { 'card-07': ['Y'] } }))
      expect(problems).toEqual(['card-07: Mark Y is blank'])
    })

    test('a missing mark line, a duplicate and an invalid value each name the card', () => {
      const text = marked()
      expect(failure(text.replace('## card-03\n', '## card-03\n').replace(/(## card-03[\s\S]*?)Mark X: \w+\n/, '$1'))).toEqual(['card-03: no Mark X line'])
      expect(failure(text.replace(/(## card-04[\s\S]*?Mark Y: \w+\n)/, '$1Mark Y: pass\n'))).toEqual(['card-04: more than one Mark Y line'])
      expect(failure(text.replace(/(## card-05[\s\S]*?)Mark X: \w+/, '$1Mark X: maybe'))).toEqual(['card-05: Mark X "maybe" is not pass or fail'])
      expect(failure(text.replace(/(## card-06[\s\S]*?)Use: \w+/, '$1Use: both'))).toEqual(['card-06: Use "both" is not X, Y or same'])
      expect(failure(text.replace(/(## card-08[\s\S]*?)note:/, '$1note: a\nnote: b\nnote:'))).toEqual(['card-08: more than one note: line'])
    })

    test('every problem is reported together, not only the first', () => {
      const text = markSheet(sheet, key, { skip: { 'card-01': ['X', 'Y'], 'card-02': ['X'] } })
      expect(failure(text)).toEqual(['card-01: Mark X is blank', 'card-01: Mark Y is blank', 'card-02: Mark X is blank'])
    })

    test('values are case-insensitive and the marks are read as given', () => {
      const text = marked().replace(/(## card-09[\s\S]*?)Mark X: \w+/, '$1Mark X: PASS').replace(/(## card-09[\s\S]*?)Use: \w+/, '$1Use: x')
      const card = readMarks(text, key).cards.find((c) => c.id === 'card-09')!
      expect(card).toMatchObject({ X: 'pass', use: 'X' })
    })

    test('a card missing from the sheet, an extra card and a repeated card differ from the key', () => {
      const text = marked()
      const withoutCard = text.replace(/## card-10\n[\s\S]*?(?=## card-11)/, '')
      expect(failure(withoutCard)).toEqual(['the sheet has 29 cards, the key has 30', 'card-10 is in the key and not on the sheet'])
      expect(failure(`${text}\n## card-31\nMark X: pass\nMark Y: pass\nUse: X\nnote:\n`)).toEqual(['the sheet has 31 cards, the key has 30', 'card-31 is on the sheet and not in the key'])
      expect(() => assertSheetMatchesKey(withoutCard, key)).toThrow(PairSheetError)
      expect(failure(text.replace('## card-12\n', '## card-11\n'))).toEqual(expect.arrayContaining(['card-11 appears more than once on the sheet', 'card-12 is in the key and not on the sheet']))
    })

    test('an unreadable start or finish time is an error', () => {
      expect(failure(marked().replace('Started: 2026-11-02 09:00', 'Started: after lunch'))).toEqual(['Started "after lunch" is not a date and time'])
    })

    test('a key from another campaign refuses; so does a sheet that names none or two', () => {
      const text = marked()
      const other: PairKey = { ...key, campaign_id: 'demo-pilot-2026-11-01T00-00-00-000Z' }
      expect(() => reconcilePairs(other, text)).toThrow(PairRefusal)
      expect(() => reconcilePairs(other, text)).toThrow(/the sheet is for campaign demo-pilot-2026-10-28.*the key is for demo-pilot-2026-11-01/)
      expect(() => reconcilePairs(key, text.replace(/^Campaign: .*$/m, ''))).toThrow(/no campaign/)
      expect(() => reconcilePairs(key, text.replace(/^Campaign: .*$/m, 'Campaign: a\nCampaign: b'))).toThrow(/more than one campaign/)
    })
  })
})

describe('the summary is an allowlist projection', () => {
  const TOP = ['schema_version', 'method', 'campaign_id', 'prereg_content_hash', 'pairs', 'owner', 'judge_vs_owner', 'preference', 'review', 'campaign']
  test('fixed top-level keys, no answer text, quote, run id or note, and the file round-trips', () => {
    const campaign = plantCampaign(fullPlants())
    const { sheet, key } = build(campaign)
    const { summary } = reconcilePairs(key, markSheet(sheet, key, { note: () => 'a note with Plain d1 answer text in it' }))
    expect(Object.keys(summary)).toEqual(TOP)
    const text = JSON.stringify(summary)
    for (const forbidden of ['Plain d', 'Labelled', 'JUDGE-QUOTE-MARKER', 'a note with', 'stdout']) expect(text).not.toContain(forbidden)
    for (const c of key.cards) expect(text).not.toContain(c.sides.X.run_id)
    const repo = tmp('metacogs-pairs-repo-')
    const path = writePairSummary(repo, summary)
    expect(path).toBe(join(repo, 'evals', 'demo', 'pilot', 'pair-summary.json'))
    expect(JSON.parse(readFileSync(path, 'utf8')) as PairSummary).toEqual(summary)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})

// ── end to end: scripted two-arm campaign through the real judge ───────────

describe('two-arm campaign, build, mark, reconcile', () => {
  const ev = (o: unknown) => JSON.stringify(o)
  const ANSWER = 'Keep the current library; the runtime pins node20.'
  const STDOUT = [
    ev({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } }),
    ev({ type: 'text', timestamp: 2, part: { type: 'text', text: ANSWER } }),
    ev({ type: 'step_finish', timestamp: 3, part: { type: 'step-finish', reason: 'stop', tokens: { total: 18, input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
  ].join('\n')
  const maskKeys = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(maskKeys) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'apiKey' ? '***' : maskKeys(v)])) : value
  const host: Host = {
    async debugConfig(req: { config: Record<string, unknown> }) {
      return { ...(maskKeys(req.config) as object), agent: {}, mode: {}, plugin: [], command: {}, username: 'unknown', compaction: { prune: false } }
    },
    async run(req: HostRunRequest): Promise<SpawnResult> {
      const skill = (req.config.permission as { skill: Record<string, string> }).skill
      const names = Object.keys(skill).filter((k) => k !== '*' && skill[k] === 'allow')
      const block = names.length ? `<available_skills>\n${names.map((n) => `<skill><name>${n}</name></skill>`).join('\n')}\n</available_skills>` : 'You are an agent.'
      req.requests.push({ hasTools: true, round: 0, body: { messages: [{ role: 'system', content: block }, { role: 'user', content: 'x' }], tools: [{ function: { name: 'bash' } }] }, returnedModel: 'fake-model' })
      return { stdout: STDOUT, stderr: '', exitCode: 0, timedOut: false, aborted: false, wallMs: 7, startedAtMs: Date.now() }
    },
  }

  test('real judge evidence, the redaction list and the sheet agree; a marked copy reconciles to a summary of ids and counts', async () => {
    const repo = new TestRepo()
    repos.push(repo)
    const heldout = tmp('metacogs-pairs-held-')
    const rubric = JUDGED_RUBRIC_TEXT.replace('\n## Criteria\n', '\n## Declarations\n\nexpectation: true\n\n## Criteria\n')
    const outcome: Expectation = { outcome: 'Recommends keeping the current library.' }
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout, rubric, expectations: { dev: { d1: outcome } } })
    repo.write('evals/demo/redact.json', JSON.stringify({ tokens: ['secretword'] }))
    repo.write('skills/demo/SKILL.md', '---\nname: demo\ndescription: test skill\n---\n\nbody\n')
    const D2 = 'Dev fixture two: choose a cache.\n'
    repo.write('evals/demo/fixtures/dev/d2.md', D2)
    repo.write('evals/demo/fixtures/dev/d2.expectation.json', JSON.stringify(outcome))
    const { expectationHash } = await import('./prereg')
    const prereg: Prereg = {
      ...scaffold.prereg,
      runs_per_condition: 2,
      fixture_hashes: { ...scaffold.prereg.fixture_hashes, dev: { ...scaffold.prereg.fixture_hashes.dev, d2: saltedHash(TEST_SALT, canonicalizeText(D2)) } },
      expectation_hashes: { dev: { d1: expectationHash(TEST_SALT, outcome), d2: expectationHash(TEST_SALT, outcome) }, heldout: {} },
    }
    repo.write('evals/demo/pilot/prereg.json', `${JSON.stringify(prereg, null, 2)}\n`)
    const verification = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: 'evals/demo/pilot/prereg.json' })

    // The real judge, with a transport that grades every answer SA1-style by quoting the answer.
    const transport: JudgeTransport = async () => ({
      ok: true,
      text: JSON.stringify({ criteria: [{ id: 'TE1', verdict: 'pass', quote: ANSWER }, { id: 'TE2', verdict: 'pass', quote: ANSWER }] }),
      returnedModels: ['other-family'],
      temperature: 0,
      systemPromptSeen: true,
      toolCalls: 0,
      wallMs: 1,
    })
    const judge = createJudge({ repoRoot: repo.dir, method: 'demo', model: 'judge/other-family', transport })
    const campaignDir = join(tmp('metacogs-pairs-camp-'), CAMPAIGN)
    const result = await runCampaign({
      repoRoot: repo.dir,
      method: 'demo',
      mode: 'dev',
      providerMode: 'scripted',
      verification,
      campaignId: CAMPAIGN,
      campaignDir,
      runs: planPilot({ arms: ['baseline', 'skill'], fixtures: verification.content.fixtures.dev, runsPerCondition: 2 }),
      host,
      judge: judge.hook,
      declarations: judge.spec.declarations,
    })
    expect(result.results).toHaveLength(8)

    const tokens = ['secretword']
    const built = buildPairs({
      campaignDir,
      fixtures: verification.content.fixtures.dev,
      redactText: (t) => redactOrThrow(t, tokens),
      preregContentHash: verification.contentHash,
      declared: judge.spec.declarations.expectation,
      rng: seeded(3),
      now: new Date('2026-10-29T00:00:00Z'),
    })
    // Every run's recorded hash was compared with the rebuilt one.
    expect(built.key.cards).toHaveLength(4)
    expect(built.key.cards.flatMap((c) => [c.sides.X, c.sides.Y]).every((s) => s.hash_checked)).toBe(true)
    expect(built.sheet).toContain('Recommends keeping the current library.')
    expect(built.sheet).toContain(ANSWER)

    const env = { XDG_STATE_HOME: tmp('metacogs-state-') }
    const paths = writePairFiles(pairsDir(env, CAMPAIGN), built)
    const marked = markSheet(readFileSync(paths.sheet, 'utf8'), built.key, { mark: () => 'pass', use: (x) => (x === 'skill' ? 'X' : 'Y'), note: (id) => (id === 'card-01' ? 'read twice' : '') })
    const reconciled = reconcilePairs(built.key, marked)
    expect(reconciled.summary.owner.pooled).toEqual({ baseline: { pass: 4, graded: 4 }, skill: { pass: 4, graded: 4 } })
    expect(reconciled.summary.judge_vs_owner).toMatchObject({ n: 8, agree: 8, rate: 1 })
    expect(reconciled.summary.preference).toEqual({ wins: 4, losses: 0, ties: 0, net: 4 })
    // The skill never loaded in this fake host: recorded, not hidden.
    expect(reconciled.summary.campaign.skill_loaded).toEqual({ answered: 4, loaded: 0 })
    expect(reconciled.summary.campaign.check_failures.skill).toMatchObject({ skill_not_loaded: 4, record_missing: 4 })
    const text = JSON.stringify(reconciled.summary)
    expect(text).not.toContain(ANSWER)
    expect(text).not.toContain('read twice')
    const out = writePairSummary(repo.dir, reconciled.summary)
    expect(JSON.parse(readFileSync(out, 'utf8')).judge_vs_owner.table.judge_pass_owner_pass).toBe(8)
  })
})

// ── the CLI verbs ──────────────────────────────────────────────────────────

describe('eval pairs (CLI)', () => {
  const PILOT_PREREG = 'evals/demo/pilot/prereg.json'
  const OUTCOME: Expectation = { outcome: 'Recommends keeping the current library and names the runtime constraint.' }

  function cliIo() {
    const lines = { out: [] as string[], err: [] as string[] }
    const stateHome = tmp('metacogs-pairs-state-')
    return {
      lines,
      stateHome,
      io: <Partial<MainIO> & { env: Record<string, string> }>{
        out: (l: string) => lines.out.push(l),
        err: (l: string) => lines.err.push(l),
        env: { XDG_STATE_HOME: stateHome },
        rng: seeded(11),
      },
    }
  }

  /** A committed pilot repo (rubric with the declaration, one fixture with a statement, redact list) and a two-arm campaign planted in it. */
  async function pilotWithCampaign(over: (p: Plant) => Partial<Plant> = () => ({})) {
    const repo = new TestRepo()
    repos.push(repo)
    const heldout = tmp('metacogs-pairs-held-')
    const rubric = JUDGED_RUBRIC_TEXT.replace('\n## Criteria\n', '\n## Declarations\n\nexpectation: true\n\n## Criteria\n')
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout, rubric, expectations: { dev: { d1: OUTCOME } } })
    repo.write('evals/demo/redact.json', JSON.stringify({ tokens: TOKENS }))
    repo.write(PILOT_PREREG, `${JSON.stringify({ ...scaffold.prereg, runs_per_condition: 3 }, null, 2)}\n`)
    repo.commit('test: pilot content and prereg', [...scaffold.fixturePaths, 'evals/demo/redact.json', PILOT_PREREG])
    const verification = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout, preregPath: PILOT_PREREG })
    const plants: Plant[] = []
    for (let index = 1; index <= 3; index += 1) {
      for (const arm of ['baseline', 'skill'] as const) {
        const base: Plant = { fixture: 'd1', arm, index, answer: `${arm === 'skill' ? 'Labelled' : 'Plain'} answer ${index}: ${index === 1 && arm === 'baseline' ? 'BAD' : 'GOOD'} recommendation.` }
        plants.push({ ...base, ...over(base) })
      }
    }
    plantCampaign(plants, CAMPAIGN, { root: join(repo.dir, 'evals', 'runs'), fixtures: verification.content.fixtures.dev, preregHash: verification.contentHash })
    return { repo, heldout, verification }
  }

  const args = (repo: TestRepo, ...rest: string[]) => ['pairs', '--campaign', CAMPAIGN, '--repo', repo.dir, ...rest]

  test('usage: exactly one of --build and --reconcile, --sheet only with --reconcile, --prereg only with --build', async () => {
    const { repo } = await pilotWithCampaign()
    for (const argv of [['pairs'], ['pairs', '--build'], args(repo), args(repo, '--build', '--reconcile'), args(repo, '--build', '--sheet', 'x.md'), args(repo, '--reconcile', '--prereg', PILOT_PREREG)]) {
      const t = cliIo()
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
    }
  })

  test('--build then mark then --reconcile: the files live under the state root, the summary under evals/<m>/pilot', async () => {
    const { repo } = await pilotWithCampaign()
    const t = cliIo()
    expect(await main(args(repo, '--build'), t.io)).toBe(EXIT.OK)
    const dir = pairsDir(t.io.env, CAMPAIGN)
    const sheet = join(dir, 'sheet.md')
    const keyPath = join(dir, 'key.json')
    expect(statSync(sheet).mode & 0o777).toBe(0o600)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(t.lines.out.join('\n')).toContain('3 cards in 1 fixtures')
    // Nothing from the build is under evals/ or in the repo's working tree.
    expect(repo.sh(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l.includes('pair') || l.includes('sheet'))).toEqual([])
    const key = JSON.parse(readFileSync(keyPath, 'utf8')) as PairKey
    const marked = markSheet(readFileSync(sheet, 'utf8'), key, { use: (x) => (x === 'skill' ? 'X' : 'Y') })
    writeFileSync(sheet, marked)

    const r = cliIo()
    r.io.env.XDG_STATE_HOME = t.stateHome
    expect(await main(args(repo, '--reconcile'), r.io)).toBe(EXIT.OK)
    const text = r.lines.out.join('\n')
    expect(text).toContain('owner passes (pass/answers marked): baseline 2/3 · skill 3/3')
    expect(text).toContain('preference (skill\'s side): 3 wins · 0 losses · 0 ties · net +3')
    expect(text).toContain('wrote evals/demo/pilot/pair-summary.json')
    const summary = JSON.parse(readFileSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pair-summary.json'), 'utf8')) as PairSummary
    expect(summary.campaign_id).toBe(CAMPAIGN)
    expect(summary.judge_vs_owner).toMatchObject({ n: 6, agree: 5 })
  })

  test('a second --build refuses and leaves the key as it was', async () => {
    const { repo } = await pilotWithCampaign()
    const t = cliIo()
    expect(await main(args(repo, '--build'), t.io)).toBe(EXIT.OK)
    const keyPath = join(pairsDir(t.io.env, CAMPAIGN), 'key.json')
    const before = readFileSync(keyPath, 'utf8')
    const again = cliIo()
    again.io.env.XDG_STATE_HOME = t.stateHome
    again.io.rng = seeded(12)
    expect(await main(args(repo, '--build'), again.io)).toBe(EXIT.REFUSED)
    expect(again.lines.err.join('\n')).toContain('never replaced')
    expect(readFileSync(keyPath, 'utf8')).toBe(before)
  })

  test('--reconcile with no key, and a sheet that names another campaign, are refused', async () => {
    const { repo } = await pilotWithCampaign()
    const none = cliIo()
    expect(await main(args(repo, '--reconcile'), none.io)).toBe(EXIT.REFUSED)
    expect(none.lines.err.join('\n')).toContain('no key')

    const t = cliIo()
    expect(await main(args(repo, '--build'), t.io)).toBe(EXIT.OK)
    const dir = pairsDir(t.io.env, CAMPAIGN)
    const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as PairKey
    const foreign = markSheet(readFileSync(join(dir, 'sheet.md'), 'utf8'), key).replace(`Campaign: ${CAMPAIGN}`, 'Campaign: demo-pilot-2026-11-09T00-00-00-000Z')
    const sheetFile = join(tmp('metacogs-pairs-foreign-'), 'foreign.md')
    writeFileSync(sheetFile, foreign)
    const r = cliIo()
    r.io.env.XDG_STATE_HOME = t.stateHome
    expect(await main(args(repo, '--reconcile', '--sheet', sheetFile), r.io)).toBe(EXIT.REFUSED)
    expect(r.lines.err.join('\n')).toContain('the sheet is for campaign demo-pilot-2026-11-09')
    expect(existsSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pair-summary.json'))).toBe(false)
  })

  test('--reconcile after a rejudge rewrote a shown run\'s judge.json is refused, names the run, and writes nothing', async () => {
    const { repo } = await pilotWithCampaign()
    const t = cliIo()
    await main(args(repo, '--build'), t.io)
    const dir = pairsDir(t.io.env, CAMPAIGN)
    const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as PairKey
    writeFileSync(join(dir, 'sheet.md'), markSheet(readFileSync(join(dir, 'sheet.md'), 'utf8'), key))
    const runId = key.cards[0]!.sides.X.run_id
    writeFileSync(join(repo.dir, 'evals', 'runs', CAMPAIGN, runId, 'judge.json'), '{"criteria":[]}')
    const r = cliIo()
    r.io.env.XDG_STATE_HOME = t.stateHome
    expect(await main(args(repo, '--reconcile'), r.io)).toBe(EXIT.ERROR)
    expect(r.lines.err.join('\n')).toContain(runId)
    expect(r.lines.err.join('\n')).toContain('rebuild the sheet')
    expect(existsSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pair-summary.json'))).toBe(false)
  })

  test('an unmarked card stops --reconcile, names the card, and writes nothing', async () => {
    const { repo } = await pilotWithCampaign()
    const t = cliIo()
    await main(args(repo, '--build'), t.io)
    const dir = pairsDir(t.io.env, CAMPAIGN)
    const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as PairKey
    writeFileSync(join(dir, 'sheet.md'), markSheet(readFileSync(join(dir, 'sheet.md'), 'utf8'), key, { skip: { 'card-02': ['X'] } }))
    const r = cliIo()
    r.io.env.XDG_STATE_HOME = t.stateHome
    expect(await main(args(repo, '--reconcile'), r.io)).toBe(EXIT.ERROR)
    expect(r.lines.err.join('\n')).toContain('card-02: Mark X is blank')
    expect(existsSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pair-summary.json'))).toBe(false)
  })

  test('--build refuses a pilot prereg that is not committed and clean, and runs made under other prereg content', async () => {
    const { repo } = await pilotWithCampaign()
    repo.write(PILOT_PREREG, `${readFileSync(join(repo.dir, PILOT_PREREG), 'utf8')}\n `)
    const dirty = cliIo()
    expect(await main(args(repo, '--build'), dirty.io)).toBe(EXIT.REFUSED)
    expect(dirty.lines.err.join('\n')).toContain('prereg_dirty')
    repo.sh(['checkout', '--', PILOT_PREREG])

    // Re-plant under a different contract hash.
    const { repo: other } = await pilotWithCampaign()
    rmSync(join(other.dir, 'evals', 'runs', CAMPAIGN), { recursive: true, force: true })
    plantCampaign(
      [{ fixture: 'd1', arm: 'baseline', index: 1, answer: 'GOOD' }, { fixture: 'd1', arm: 'skill', index: 1, answer: 'GOOD' }],
      CAMPAIGN,
      { root: join(other.dir, 'evals', 'runs'), fixtures: [{ ...fixtureOf('d1'), hash: sha256('d1') }], preregHash: 'b'.repeat(64) },
    )
    const stale = cliIo()
    expect(await main(args(other, '--build'), stale.io)).toBe(EXIT.REFUSED)
    expect(stale.lines.err.join('\n')).toContain('another prereg content')
  })

  test('a campaign whose manifests carry no arm is not a pilot and is refused', async () => {
    const { repo } = await pilotWithCampaign()
    const dir = join(repo.dir, 'evals', 'runs', CAMPAIGN)
    const run = readdirSyncSorted(dir)[0]!
    const manifest = JSON.parse(readFileSync(join(dir, run, 'manifest.json'), 'utf8')) as Record<string, unknown>
    delete manifest.arm
    writeFileSync(join(dir, run, 'manifest.json'), JSON.stringify(manifest))
    const t = cliIo()
    expect(await main(args(repo, '--build'), t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('not a pilot campaign')
  })

  test('the usage text documents the verbs', async () => {
    const t = cliIo()
    expect(await main([], t.io)).toBe(EXIT.USAGE)
    const usage = t.lines.err.join('\n')
    expect(usage).toContain('eval pairs --campaign <id|dir> --build')
    expect(usage).toContain('eval pairs --campaign <id|dir> --reconcile')
  })
})

describe('redactJudgeInput takes a discriminated union', () => {
  const exp: Expectation = { outcome: 'Recommends keeping the current library.' }
  const base = { fixtureText: 'Prompt.\n', answer: 'An answer.' }

  test('declared: true needs an expectation and carries it; declared: false forbids one and sends none', () => {
    const declared = redactJudgeInput({ ...base, declared: true, expectation: exp }, redactText)
    expect(declared.expectation).toBe(JSON.stringify(exp))
    const plain = redactJudgeInput({ ...base, recordJson: ['{"r":1}'], declared: false }, redactText)
    expect(plain.expectation).toBeUndefined()
    expect(plain.record).toBe('{"r":1}')
    // The hash formula is unchanged: expectation joins it only when declared.
    expect(plain.sha256).toBe(sha256(JSON.stringify({ task: 'Prompt.\n', answer: 'An answer.', record: '{"r":1}' })))
    expect(declared.sha256).toBe(sha256(JSON.stringify({ task: 'Prompt.\n', answer: 'An answer.', record: null, expectation: JSON.stringify(exp) })))
  })

  test('the impossible states do not typecheck', () => {
    // These lines are only type-checked: the @ts-expect-error comments make `tsc` fail if the union ever loosens.
    const never = (): void => {
      // @ts-expect-error declared: true requires an expectation
      redactJudgeInput({ ...base, declared: true }, redactText)
      // @ts-expect-error declared: false forbids an expectation
      redactJudgeInput({ ...base, declared: false, expectation: exp }, redactText)
    }
    expect(typeof never).toBe('function')
  })
})
