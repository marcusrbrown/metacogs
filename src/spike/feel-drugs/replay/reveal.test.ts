import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { main } from './cli'
import { parseSheet, RevealRefusal, revealCampaign, type RevealSummary } from './reveal'
import { buildSheet, type BuiltSheet, type KeyAnswer } from './sheet'
import { type CampaignPlan, fillSheet, markAll, newSheetLab, runSyntheticCampaign, type SheetLab, seeded, stdoutOf, stepFinish, textEvent, toolEvent } from './sheet-support'

const OPUS = 'anthropic/claude-opus-5-5'
const LUNA = 'openai/gpt-6-luna'
const EXPECTED = 'EXPECTED-MOVE-NOTE-4417 check the lockfile first'
const ARMS = ['continue-a', 'continue-b', 'feel', 'drugs'] as const

const labs: SheetLab[] = []
afterEach(() => {
  for (const lab of labs.splice(0)) lab.dispose()
})

async function setup(plan: CampaignPlan): Promise<{ l: SheetLab; built: BuiltSheet }> {
  const l = newSheetLab()
  labs.push(l)
  await runSyntheticCampaign(l, { arms: ARMS, ...plan })
  return { l, built: buildSheet(l.store, { campaign: 'phase1', rng: seeded(7), buildId: 'abcdef123456' }) }
}

type Over = (a: KeyAnswer) => string | undefined
function fill({ built }: { built: BuiltSheet }, over: Over = () => undefined, expected: string | undefined = EXPECTED): string {
  const text = fillSheet(built.sheet, built.key, { mark: markAll(over), expected: () => expected })
  writeFileSync(built.sheetPath, text)
  return text
}

const feelToward =
  (model: string, fixture?: string): Over =>
  (a) =>
    a.arm === 'feel' && a.model === model && (fixture === undefined || a.fixture === fixture) ? 'changed=yes direction=toward' : undefined

const reveal = (l: SheetLab, partial = false): RevealSummary => revealCampaign(l.store, { campaign: 'phase1', partial }).summary
const armRow = (s: RevealSummary, arm: string, model: string) => s.arms.find((r) => r.arm === arm && r.model === model)!

describe('noise floor', () => {
  test('agreeing Continue runs and a toward change on the feel arm count it, and the moment qualifies', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, feelToward(OPUS))
    const revealed = revealCampaign(ctx.l.store, { campaign: 'phase1' })
    const s = revealed.summary

    expect(armRow(s, 'feel', OPUS).counted).toEqual({ toward: 1, away: 0, neutral: 0, total: 1 })
    expect(armRow(s, 'feel', LUNA).counted.total).toBe(0)
    expect(armRow(s, 'feel', LUNA).changed).toBe(0)
    expect(s.floor.find((f) => f.model === OPUS)).toEqual({ model: OPUS, cells: 1, agree: 1, noisy: 0, no_floor: 0 })
    expect(s.fixtures[0]).toMatchObject({ id: 'stuck-one', kind: 'feel', counted_toward_command: 1, qualifying: true })
    // One qualifying moment is below the stop rule's three.
    expect(s.phase2).toEqual({ qualifying: 1, needed: 3, runs: false, ranked: ['stuck-one'] })
    expect(revealed.lines.join('\n')).toContain('phase 2 does not run: 1 qualifying moments (needs 3)')
    expect(revealed.lines.join('\n')).toContain('no measurable benefit')
    expect(revealed.lines.join('\n')).not.toContain('no difference')
  })

  test('Continue runs that disagree make the cell noisy: the change is reported and not counted', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, (a) => (a.model === OPUS && a.arm === 'continue-a' ? 'changed=yes' : feelToward(OPUS)(a)))
    const s = reveal(ctx.l)

    expect(armRow(s, 'feel', OPUS)).toMatchObject({ changed: 1, counted: { total: 0 }, uncounted: 1, noisy_cells: 1, no_floor_cells: 0 })
    expect(s.floor.find((f) => f.model === OPUS)).toMatchObject({ noisy: 1, agree: 0 })
    expect(s.fixtures[0]).toMatchObject({ counted_toward_command: 0, qualifying: false })
    expect(s.fixtures[0]!.models.find((m) => m.model === OPUS)).toMatchObject({ floor: 'noisy', uncounted: 1 })
    expect(s.phase2.qualifying).toBe(0)
  })

  test('both Continue runs marked changed makes the cell noisy too', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, (a) => (a.model === OPUS && (a.arm === 'continue-a' || a.arm === 'continue-b') ? 'changed=yes' : feelToward(OPUS)(a)))
    const s = reveal(ctx.l)

    expect(s.fixtures[0]!.models.find((m) => m.model === OPUS)!.floor).toBe('noisy')
    expect(armRow(s, 'feel', OPUS).counted.total).toBe(0)
    expect(armRow(s, 'feel', OPUS).uncounted).toBe(1)
  })

  test('the floor is per model: a noisy model does not stop the other from counting', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, (a) => (a.model === OPUS && a.arm === 'continue-b' ? 'changed=yes' : a.arm === 'feel' ? 'changed=yes direction=away' : undefined))
    const s = reveal(ctx.l)

    expect(armRow(s, 'feel', LUNA).counted).toEqual({ toward: 0, away: 1, neutral: 0, total: 1 })
    expect(armRow(s, 'feel', OPUS).counted.total).toBe(0)
    expect(s.fixtures[0]!.qualifying).toBe(false)
  })

  test('phase 2 runs with three qualifying moments, ranked by counted toward changes, and stops at two', async () => {
    const fixtures = [
      { id: 'stuck-a', kind: 'feel' as const },
      { id: 'stuck-b', kind: 'drugs' as const },
      { id: 'stuck-c', kind: 'feel' as const },
    ]
    const three = await setup({ fixtures })
    fill(three, (a) => (a.model === OPUS && (a.arm === 'feel' || (a.arm === 'drugs' && a.fixture === 'stuck-b')) ? 'changed=yes direction=toward' : undefined))
    const s = reveal(three.l)
    expect(s.phase2).toEqual({ qualifying: 3, needed: 3, runs: true, ranked: ['stuck-b', 'stuck-a', 'stuck-c'] })
    expect(revealCampaign(three.l.store, { campaign: 'phase1' }).lines.join('\n')).toContain('phase 2 runs: 3 qualifying moments')

    const two = await setup2(fixtures)
    expect(two.phase2).toMatchObject({ qualifying: 2, runs: false })
  })

  test('only counted changes on command arms qualify a moment', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }], arms: ['continue-a', 'continue-b', 'whichever'] })
    fill(ctx, (a) => (a.arm === 'whichever' ? 'changed=yes direction=toward' : undefined))
    const s = reveal(ctx.l)
    expect(armRow(s, 'whichever', OPUS).counted.toward).toBe(1)
    expect(s.fixtures[0]).toMatchObject({ counted_toward_command: 0, qualifying: false })
  })
})

async function setup2(fixtures: CampaignPlan['fixtures']): Promise<RevealSummary> {
  const ctx = await setup({ fixtures: fixtures.slice(0, 3) })
  fill(ctx, (a) => (a.model === LUNA && a.arm === 'feel' && a.fixture !== 'stuck-c' ? 'changed=yes direction=toward' : undefined))
  return reveal(ctx.l)
}

describe('ordinary turns', () => {
  test('command-arm changes on an ordinary fixture count as disruption, not as an effect', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }, { id: 'plain-turn', kind: 'ordinary' }] })
    fill(ctx, (a) => (a.fixture === 'plain-turn' && a.arm === 'drugs' && a.model === OPUS ? 'changed=yes direction=away' : undefined))
    const revealed = revealCampaign(ctx.l.store, { campaign: 'phase1' })
    const s = revealed.summary

    expect(s.ordinary.disruption).toEqual({ command_answers: 4, command_changes: 1 })
    expect(s.ordinary.arms.find((r) => r.arm === 'drugs' && r.model === OPUS)!.counted.total).toBe(1)
    expect(s.arms.every((r) => r.counted.total === 0)).toBe(true)
    expect(s.fixtures.find((f) => f.id === 'plain-turn')).toMatchObject({ kind: 'ordinary', qualifying: false })
    expect(revealed.lines.join('\n')).toContain('1 of 4 command-arm answers changed the next move (disruption)')
  })
})

describe('tool-call rate', () => {
  test('comes from attempt.json observed calls, not from the marks', async () => {
    const ctx = await setup({
      fixtures: [{ id: 'stuck-one', kind: 'feel' }],
      arms: ['continue-a', 'continue-b', 'whichever', 'nudge-only'],
      answer: (job) => {
        if (job.arm === 'whichever' && job.model === LUNA) return { stdout: stdoutOf(textEvent('ok'), toolEvent('feel', { somewhere: 'x' }), stepFinish()) }
        if (job.arm === 'whichever') return { stdout: stdoutOf(toolEvent('skill', { name: 'synthesis' }, 'completed', '<skill_content name="synthesis">x</skill_content>'), stepFinish()) }
        return undefined
      },
    })
    // Every answer is marked changed=no; the rate must not depend on that.
    fill(ctx)
    const s = reveal(ctx.l)
    const row = (arm: string, model: string) => s.tool_call_rate.find((r) => r.arm === arm && r.model === model)!

    expect(row('whichever', LUNA)).toMatchObject({ scope: 'stuck', attempts: 1, metacogs_tool: 1, skill_only: 0, no_tool: 0 })
    expect(row('whichever', OPUS)).toMatchObject({ attempts: 1, metacogs_tool: 0, skill_only: 1, no_tool: 0 })
    expect(row('nudge-only', LUNA)).toMatchObject({ attempts: 1, metacogs_tool: 0, skill_only: 0, no_tool: 1 })
    expect(s.tool_call_rate.every((r) => r.arm === 'whichever' || r.arm === 'nudge-only')).toBe(true)
  })
})

describe('custody', () => {
  test('a sheet from another build is refused', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    writeFileSync(ctx.built.sheetPath, fill(ctx).replace('build: abcdef123456', 'build: 000000000000'))
    expect(() => reveal(ctx.l)).toThrow(/build id \(000000000000\) does not match the key's \(abcdef123456\)/)
  })

  test('a key from another build is refused', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx)
    const key = JSON.parse(readFileSync(ctx.built.keyPath, 'utf8')) as { build_id: string }
    writeFileSync(ctx.built.keyPath, JSON.stringify({ ...key, build_id: 'ffffffffffff' }))
    expect(() => reveal(ctx.l)).toThrow(RevealRefusal)
    try {
      reveal(ctx.l)
    } catch (e) {
      expect((e as RevealRefusal).kind).toBe('build_mismatch')
    }
  })

  test('an attempt file that changed after the build is refused', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx)
    const answer = ctx.built.key.answers[0]!
    appendFileSync(join(ctx.l.store.root, 'campaigns', 'phase1', answer.attempt, 'attempt.json'), '\n')
    expect(() => reveal(ctx.l)).toThrow(`1 attempt file is missing or changed since the sheet was built: ${answer.id}`)
  })

  test('a missing sheet or key is refused with the way forward', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    expect(() => revealCampaign(ctx.l.store, { campaign: 'other' })).toThrow('run sheet first')
  })
})

describe('marks', () => {
  test('a missing mark refuses; --partial excludes it with a count', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    const gap = ctx.built.key.answers.find((a) => a.model === OPUS && a.arm === 'continue-a')!
    fill(ctx, (a) => (a.id === gap.id ? 'changed=_ direction=_' : a.model === OPUS && a.arm === 'feel' ? 'changed=yes direction=toward' : undefined))

    expect(() => reveal(ctx.l)).toThrow(`1 answer is not marked (or changed=yes has no direction): ${gap.id}`)
    const s = reveal(ctx.l, true)
    expect(s.partial).toBe(true)
    expect(s.answers).toEqual({ on_sheet: 8, marked: 7, excluded_unmarked: 1 })
    // The unmarked Continue run leaves no floor, so the feel change is reported and not counted.
    expect(s.fixtures[0]!.models.find((m) => m.model === OPUS)).toMatchObject({ floor: 'no_floor', uncounted: 1 })
    expect(armRow(s, 'feel', OPUS)).toMatchObject({ uncounted: 1, no_floor_cells: 1 })
    expect(armRow(s, 'feel', OPUS).counted.total).toBe(0)
    expect(readFileSync(join(ctx.built.dir, 'summary.json'), 'utf8')).toContain('"excluded_unmarked": 1')
  })

  test('a change without a direction counts as unmarked, but a Continue change needs none', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, (a) => (a.model === OPUS && a.arm === 'feel' ? 'changed=yes' : a.model === OPUS && a.arm === 'continue-a' ? 'changed=yes' : undefined))
    expect(() => reveal(ctx.l)).toThrow('changed=yes has no direction')
    const s = reveal(ctx.l, true)
    expect(s.answers.excluded_unmarked).toBe(1)
    expect(s.fixtures[0]!.models.find((m) => m.model === OPUS)!.floor).toBe('noisy')
  })

  test('blank expected moves refuse unless --partial', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    fill(ctx, undefined, '_')
    expect(() => reveal(ctx.l)).toThrow('1 expected-move line is blank: s01')
    expect(reveal(ctx.l, true).expected_moves).toEqual({ moments: 1, written: 0, blank: 1 })
  })

  test('a typo in a mark gives an error with its line number, even under --partial', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    const text = fill(ctx, (a) => (a.model === OPUS && a.arm === 'feel' ? 'changed=ys direction=towards' : a.model === LUNA && a.arm === 'drugs' ? 'chaged=no' : undefined))
    const lines = text.split('\n')
    const typo = lines.findIndex((l) => l.includes('changed=ys')) + 1
    const unknown = lines.findIndex((l) => l.includes('chaged=no')) + 1

    const refusal = (partial: boolean): RevealRefusal => {
      try {
        reveal(ctx.l, partial)
      } catch (e) {
        return e as RevealRefusal
      }
      throw new Error('expected a refusal')
    }
    for (const partial of [false, true]) {
      const e = refusal(partial)
      expect(e.kind).toBe('bad_marks')
      expect(e.message).toContain('3 problems in the marks')
      expect(e.message).toContain(`line ${typo}: `)
      expect(e.message).toContain('changed takes yes, no or _ (got "ys")')
      expect(e.message).toContain('direction takes toward, away, neutral or _ (got "towards")')
      expect(e.message).toContain(`line ${unknown}: `)
      expect(e.message).toContain('"chaged=no" is not changed=… or direction=…')
    }
  })

  test('a deleted answer is refused even under --partial', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }] })
    const text = fill(ctx)
    const cut = text.replace(/#### s01-m1-A[\s\S]*?(?=#### s01-m1-B)/, '')
    writeFileSync(ctx.built.sheetPath, cut)
    expect(() => reveal(ctx.l, true)).toThrow('the sheet is missing 1 answer the key has: s01-m1-A')
  })

  test('mark lines inside an answer fence are not marks, and spacing around = is accepted', () => {
    const sheet = ['build: b', '', '## s01', '', '~~~', 'expected: no', '~~~', '', 'expected: go left', '', '### s01 · m', '', '#### s01-m1-A', '', '~~~markdown', 'mark: changed=yes direction=away', '~~~', '', 'mark: changed = YES  direction = Toward'].join('\n')
    const parsed = parseSheet(sheet)
    expect(parsed.errors).toEqual([])
    expect(parsed.expected).toEqual({ s01: 'go left' })
    expect(parsed.marks['s01-m1-A']).toMatchObject({ changed: 'yes', direction: 'toward', line: 19 })
  })
})

describe('summary.json', () => {
  test('holds counts and ids only, privately, and never answers or the author\'s notes', async () => {
    const ctx = await setup({ fixtures: [{ id: 'stuck-one', kind: 'feel' }], answer: (job) => ({ stdout: stdoutOf(textEvent(`UNIQUE-ANSWER-TEXT-9921 ${job.arm}`), stepFinish()) }) })
    fill(ctx, feelToward(OPUS))
    const revealed = revealCampaign(ctx.l.store, { campaign: 'phase1' })
    const raw = readFileSync(revealed.summaryPath, 'utf8')

    expect(statSync(revealed.summaryPath).mode & 0o777).toBe(0o600)
    expect(raw).not.toContain('UNIQUE-ANSWER-TEXT-9921')
    expect(raw).not.toContain('EXPECTED-MOVE-NOTE-4417')
    expect(raw).not.toContain('UNIQUE-OUTCOME-REF')
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['answers', 'appendix', 'arms', 'build_id', 'campaign', 'expected_moves', 'fixtures', 'floor', 'ordinary', 'partial', 'phase2', 'revealed_at', 'schema_version', 'tool_call_rate'])
    expect(revealed.lines.join('\n')).not.toContain('EXPECTED-MOVE-NOTE-4417')
  })
})

describe('command line', () => {
  test('sheet then reveal: refuses an unmarked sheet, then prints the table', async () => {
    const l = newSheetLab()
    labs.push(l)
    await runSyntheticCampaign(l, { fixtures: [{ id: 'stuck-one', kind: 'feel' }], arms: ARMS })
    const out: string[] = []
    const err: string[] = []
    const io = { out: (x: string) => out.push(x), err: (x: string) => err.push(x), env: l.env, repoRoot: l.repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z'), sheet: { rng: seeded(9), buildId: '0123456789ab' } }

    expect(main(['sheet', 'phase1', '--models', OPUS], io)).toBe(0)
    expect(out[0]).toBe('built sheet phase1 build=0123456789ab scenarios=1 answers=4 appendix=0')
    expect(main(['sheet', 'phase1'], io)).toBe(1)
    expect(err.at(-1)).toContain('never replaced')

    expect(main(['reveal', 'phase1'], io)).toBe(1)
    expect(err.at(-1)).toContain('4 answers are not marked')
    expect(main(['reveal', 'phase1', '--partial'], io)).toBe(0)
    expect(out.join('\n')).toContain('campaign phase1 build 0123456789ab: 0 of 4 answers marked, 4 unmarked excluded (--partial)')

    expect(main(['sheet'], io)).toBe(2)
    expect(main(['reveal'], io)).toBe(2)
  })
})
