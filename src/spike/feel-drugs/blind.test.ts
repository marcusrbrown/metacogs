import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { disposeFixtures } from '../../plugin/fixture'
import { opencodeAvailability } from '../../runner/opencode'
import { sha256 } from '../../runner/workspace'
import {
  type BlindKey,
  buildBlind,
  type KeyCell,
  loadGuidedRuns,
  main,
  parseMarks,
  RevealRefusal,
  renderRevealed,
  reveal,
  type Verdict,
} from './blind'
import { loadPrompts, type SpikePrompt } from './driver'
import { type GuidedArm, type GuidedRecord, loadCodingPrompts, parseGuidedArgs, type Read, runGuided } from './guided'

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const LUNA = 'openai/gpt-6-luna'
const HAIKU = 'anthropic/claude-haiku-5-5'
const SOL = 'openai/gpt-6.1-sol'
const OPUS = 'anthropic/claude-opus-5-5'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
afterAll(disposeFixtures)
const tmp = (prefix = 'blind-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const PROMPTS: SpikePrompt[] = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, text: `Prompt text for ${id}.`, rationale: 'r' }))
const PATHS = { workspaces: ['/tmp/metacogs-run-AAA/workspace'], homes: ['/tmp/metacogs-run-AAA/home'], packages: ['/tmp/metacogs-packed-AAA/unpacked/package'] }
const ZERO_USAGE = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

type Fired = 'none' | 'tool' | 'skill' | 'both'

function record(o: { arm: GuidedArm; model: string; prompt: string; run: number; read?: Read; fired?: Fired; answer?: string; narration?: string; status?: GuidedRecord['status']; unwanted?: string[]; feel?: number; drugs?: number }): GuidedRecord {
  const plugin = o.arm === 'P1' || o.arm === 'P2'
  const fired = o.fired ?? 'none'
  const call = (tool: string) => ({ tool, input: { secret: 'argument-value' }, status: 'completed' })
  const toolCalls = plugin && (fired === 'tool' || fired === 'both') ? [...Array.from({ length: o.feel ?? 1 }, () => call('metacogs_feel')), ...Array.from({ length: o.drugs ?? 0 }, () => call('metacogs_drugs'))] : []
  const answer = o.answer ?? `${plugin ? 'beta' : 'alpha'} answer for ${o.model} ${o.prompt} run ${o.run}`
  return {
    schema_version: 1,
    read: o.read ?? 1,
    arm: o.arm,
    model: o.model,
    host_model: o.model,
    provider: 'live',
    prompt_id: o.prompt,
    prompt_hash: sha256(`Prompt text for ${o.prompt}.`),
    prompt_kind: 'prose',
    run: o.run,
    status: o.status ?? 'completed',
    reasons: [],
    offered_tools: plugin ? ['metacogs_drugs', 'metacogs_feel', 'skill'] : [],
    tool_calls: toolCalls,
    unwanted_calls: o.unwanted ?? [],
    skill_loads: plugin && (fired === 'skill' || fired === 'both') ? ['synthesis'] : [],
    guidance_sha256: plugin ? 'g'.repeat(64) : null,
    tarball_sha256: plugin ? 't'.repeat(64) : null,
    command: null,
    turns: 1,
    second_turn: null,
    answer: `${o.narration ?? ''}${answer}`,
    final_answer: answer,
    isolation: { passed: true, failed: [] },
    paths: PATHS,
    wall_ms: 1,
    usage: ZERO_USAGE,
    returned_models: [],
  }
}

/** A full cell: two nothing runs and two plugin runs. */
const cell = (model: string, prompt: string, fired: Fired = 'tool', read: Read = 1): GuidedRecord[] => {
  const [n, p] = read === 1 ? (['N1', 'P1'] as const) : (['N2', 'P2'] as const)
  return [1, 2].flatMap((run) => [record({ arm: n, model, prompt, run, read }), record({ arm: p, model, prompt, run, read, fired })])
}
/** A control cell: four nothing runs and no plugin run. */
const control = (model: string, prompt: string, read: Read = 1): GuidedRecord[] => [1, 2, 3, 4].map((run) => record({ arm: read === 1 ? 'N1' : 'N2', model, prompt, run, read }))

const constant = (value: number) => () => value
const build = (records: GuidedRecord[], rng = constant(0)) => buildBlind({ records, prompts: PROMPTS, sources: ['read1-campaign'], rng, now: new Date('2026-10-26T00:00:00.000Z') })

const cellOf = (key: BlindKey, model: string, prompt: string): KeyCell => key.cells.find((c) => !c.control && c.model === model && c.prompt_id === prompt)!
/** The verdict that prefers `winner`'s side: `plugin`, `nothing`, or `same`. */
const verdictFor = (c: KeyCell, winner: 'plugin' | 'nothing' | 'same'): Verdict => (winner === 'same' ? 'same' : c.sides.X === (winner === 'plugin' ? 'P' : 'N') ? 'X' : 'Y')
const marksFor = (key: BlindKey, picks: Record<string, 'plugin' | 'nothing' | 'same'>, controlVerdict: Verdict = 'same'): Record<string, Verdict> => {
  const marks: Record<string, Verdict> = {}
  for (const c of key.cells) marks[c.id] = c.control ? controlVerdict : verdictFor(c, picks[`${c.model}@${c.prompt_id}`] ?? 'same')
  return marks
}

describe('buildBlind', () => {
  const records = [...cell(LUNA, 'p1'), ...cell(LUNA, 'p2'), ...cell(HAIKU, 'p1'), ...cell(HAIKU, 'p2'), ...control(SOL, 'p3')]

  test('one numbered cell per prompt and model, plus the one hidden control cell', () => {
    const { key } = build(records)
    expect(key.schema_version).toBe(1)
    expect(key.read).toBe(1)
    expect(key.cells.map((c) => c.id)).toEqual(['cell-01', 'cell-02', 'cell-03', 'cell-04', 'cell-05'])
    expect(key.cells.filter((c) => c.control)).toHaveLength(1)
    expect(key.cells.filter((c) => !c.control).map((c) => `${c.prompt_id}@${c.model}`).sort()).toEqual([`p1@${HAIKU}`, `p1@${LUNA}`, `p2@${HAIKU}`, `p2@${LUNA}`])
  })

  test('the sheet carries answers and prompts only: no arm, offered tool, call event or plugin path', () => {
    const noisy = [...cell(LUNA, 'p1'), ...control(SOL, 'p3')].map((r) =>
      r.arm === 'P1' && r.run === 1 ? { ...r, final_answer: 'read /tmp/metacogs-packed-AAA/unpacked/package/skills/synthesis and /x/node_modules/metacogs/dist/index.js' } : r,
    )
    const { sheet } = build(noisy)
    for (const leak of ['N1', 'P1', 'N2', 'P2', 'metacogs_feel', 'metacogs_drugs', 'Offered tools', 'Tool calls', 'Status', 'Isolation', 'argument-value', 'guidance', 'tarball', '/tmp/', '/x/node_modules', 'metacogs-packed']) {
      expect(sheet).not.toContain(leak)
    }
    expect(sheet).toContain('<pkg>/skills/synthesis')
    expect(sheet).toContain('Prompt text for p1.')
    expect(sheet).toContain(LUNA)
  })

  test('each answer is the text after the last tool call, so the narration before a call is not shown', () => {
    const records = [...cell(LUNA, 'p1'), ...control(SOL, 'p3')].map((r) => (r.arm === 'P1' ? { ...r, answer: `NARRATION before the call\n${r.final_answer}` } : r))
    const { sheet } = build(records)
    expect(sheet).not.toContain('NARRATION')
    expect(sheet).toContain('beta answer')
  })

  test('both runs per side are shown, each answer fenced, and the recorded sides match the sheet', () => {
    const { sheet, key } = build([...cell(LUNA, 'p1'), ...control(SOL, 'p3')])
    const c = cellOf(key, LUNA, 'p1')
    const section = sheet.split(/^## /m).find((s) => s.startsWith(c.id))!
    const [, x, y] = section.split(/^### /m)
    expect(x).toMatch(/^X\n/)
    expect(y).toMatch(/^Y\n/)
    for (const [side, text] of [['X', x!], ['Y', y!]] as const) {
      expect(c.runs[side]).toHaveLength(2)
      for (const run of c.runs[side]) expect(text).toContain(run.answer)
      expect(text.match(/^~~~/gm)?.length).toBe(4)
    }
    expect(new Set([c.sides.X, c.sides.Y])).toEqual(new Set(['N', 'P']))
    expect(c.runs[c.sides.X === 'P' ? 'X' : 'Y'].every((r) => r.arm === 'P1')).toBe(true)
  })

  test('a random draw per cell decides which side holds the plugin runs, and it is recorded', () => {
    const records2 = [...cell(LUNA, 'p1'), ...cell(HAIKU, 'p1'), ...control(SOL, 'p3')]
    const onX = build(records2, constant(0)).key
    const onY = build(records2, constant(0.99)).key
    expect(onX.cells.filter((c) => !c.control).every((c) => c.sides.X === 'P' && c.sides.Y === 'N')).toBe(true)
    expect(onY.cells.filter((c) => !c.control).every((c) => c.sides.X === 'N' && c.sides.Y === 'P')).toBe(true)
  })

  test('the control cell sets two nothing runs against two nothing runs', () => {
    const { key, sheet } = build([...cell(LUNA, 'p1'), ...control(SOL, 'p3')])
    const c = key.cells.find((k) => k.control)!
    expect(c.sides).toEqual({ X: 'N', Y: 'N' })
    expect(c.runs.X).toHaveLength(2)
    expect(c.runs.Y).toHaveLength(2)
    expect(new Set([...c.runs.X, ...c.runs.Y].map((r) => r.run))).toEqual(new Set([1, 2, 3, 4]))
    expect(sheet).not.toMatch(/control/i)
  })

  test('the control cell is placed by the draw, not always last', () => {
    const records3 = [...cell(LUNA, 'p1'), ...cell(HAIKU, 'p1'), ...control(SOL, 'p3')]
    expect(build(records3, constant(0)).key.cells[0]!.control).toBe(true)
    expect(build(records3, constant(0.99)).key.cells.at(-1)!.control).toBe(true)
  })

  test('refuses an incomplete cell, a missing or second control cell, and mixed reads, naming the cell', () => {
    const missingRun = [...cell(LUNA, 'p1')].map((r) => (r.arm === 'P1' && r.run === 2 ? { ...r, status: 'tools_missing' as const } : r))
    expect(() => build([...missingRun, ...control(SOL, 'p3')])).toThrow(/p1@openai\/gpt-6-luna/)
    expect(() => build(cell(LUNA, 'p1'))).toThrow(/control/)
    expect(() => build([...cell(LUNA, 'p1'), ...control(SOL, 'p3'), ...control(HAIKU, 'p4')])).toThrow(/control/)
    expect(() => build([...cell(LUNA, 'p1'), ...control(SOL, 'p3'), ...cell(HAIKU, 'p1', 'tool', 2)])).toThrow(/one read/)
    expect(() => build([...cell(LUNA, 'p1'), ...control(SOL, 'p3').slice(0, 3)])).toThrow(/control/)
  })
})

describe('parseMarks', () => {
  const sheetFor = (verdicts: Record<string, string>) => build([...cell(LUNA, 'p1'), ...control(SOL, 'p3')]).sheet.replace(/^Verdict:.*$/gm, ((i) => () => `Verdict: ${Object.values(verdicts)[i++] ?? ''}`)(0))

  test('reads X, Y and same, case-insensitively, and reports a blank verdict as unmarked', () => {
    const { marks, unmarked, errors } = parseMarks(sheetFor({ a: 'x', b: ' SAME ' }))
    expect(marks).toEqual({ 'cell-01': 'X', 'cell-02': 'same' })
    expect(unmarked).toEqual([])
    expect(errors).toEqual([])
    expect(parseMarks(sheetFor({ a: 'Y', b: '' })).unmarked).toEqual(['cell-02'])
  })

  test('an unknown value or a repeated verdict line is an error naming the cell', () => {
    expect(parseMarks(sheetFor({ a: 'maybe', b: 'x' })).errors).toEqual([expect.stringContaining('cell-01')])
    const twice = sheetFor({ a: 'x', b: 'y' }).replace('## cell-02', 'Verdict: Y\n\n## cell-02')
    expect(parseMarks(twice).errors.join('\n')).toContain('cell-01')
  })

  test('a verdict line inside a fenced answer is not a mark, and an answer cannot add a heading', () => {
    const records = [...cell(LUNA, 'p1'), ...control(SOL, 'p3')].map((r) => (r.arm === 'N1' && r.run === 1 && r.prompt_id === 'p1' ? { ...r, final_answer: 'Verdict: Y\n~~~\n## cell-99\nVerdict: X' } : r))
    const sheet = build(records).sheet.replace(/^Verdict:.*$/gm, 'Verdict: x')
    expect(parseMarks(sheet).marks).toEqual({ 'cell-01': 'X', 'cell-02': 'X' })
  })
})

describe('reveal', () => {
  test('refuses while any cell is unmarked, naming it', () => {
    const { key } = build([...cell(LUNA, 'p1'), ...cell(HAIKU, 'p1'), ...control(SOL, 'p3')])
    const marks = marksFor(key, {})
    delete marks[key.cells[1]!.id]
    const attempt = () => reveal(key, marks)
    expect(attempt).toThrow(RevealRefusal)
    expect(attempt).toThrow(key.cells[1]!.id)
  })

  test('refuses an unmarked control cell too', () => {
    const { key } = build([...cell(LUNA, 'p1'), ...control(SOL, 'p3')])
    const marks = marksFor(key, {})
    delete marks[key.cells.find((c) => c.control)!.id]
    expect(() => reveal(key, marks)).toThrow(/cell-0\d/)
  })

  describe('the rule', () => {
    const models = [LUNA, HAIKU, SOL, OPUS]
    const prompts = ['p1', 'p2', 'p3']
    const all = (fired: Fired = 'tool') => [...models.flatMap((m) => prompts.flatMap((p) => cell(m, p, fired))), ...control(LUNA, 'p4')]
    const picksFor = (perModel: Record<string, ('plugin' | 'nothing' | 'same')[]>) => Object.fromEntries(Object.entries(perModel).flatMap(([model, list]) => list.map((pick, i) => [`${model}@p${i + 1}`, pick])))

    test('met at wins minus losses of 3 with no model at -3 or worse; same counts as neither', () => {
      const { key } = build(all())
      const result = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'plugin'], [HAIKU]: ['plugin', 'same', 'nothing'], [SOL]: ['same', 'same', 'same'], [OPUS]: ['same', 'same', 'same'] })))
      expect(result.total).toMatchObject({ wins: 4, losses: 1, same: 7, net: 3, eligible: 12 })
      expect(result.rule).toMatchObject({ met: true, total_net: 3, failing_models: [] })
      expect(result.models.find((m) => m.model === HAIKU)).toMatchObject({ wins: 1, losses: 1, same: 1, net: 0, eligible: 3 })
    })

    test('a model at -3 is not met even when the total is +4', () => {
      const { key } = build(all())
      const result = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'plugin'], [HAIKU]: ['nothing', 'nothing', 'nothing'], [SOL]: ['plugin', 'plugin', 'plugin'], [OPUS]: ['plugin', 'same', 'same'] })))
      expect(result.total.net).toBe(4)
      expect(result.rule).toMatchObject({ met: false, total_net: 4, failing_models: [HAIKU] })
    })

    test('a model at -2 does not fail the rule; a total of +2 does', () => {
      const { key } = build(all())
      const met = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'plugin'], [HAIKU]: ['nothing', 'nothing', 'same'], [SOL]: ['plugin', 'plugin', 'plugin'], [OPUS]: ['same', 'same', 'same'] })))
      expect(met.rule).toMatchObject({ met: true, total_net: 4 })
      const short = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'same'], [HAIKU]: ['same', 'same', 'same'], [SOL]: ['same', 'same', 'same'], [OPUS]: ['same', 'same', 'same'] })))
      expect(short.rule).toMatchObject({ met: false, total_net: 2 })
    })

    test('a cell where the plugin arm never fired is excluded from the rule and still listed', () => {
      const records = all().map((r) => (r.model === LUNA && r.prompt_id === 'p1' && r.arm === 'P1' ? { ...r, tool_calls: [], skill_loads: [] } : r))
      const { key } = build(records)
      const result = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'plugin'], [HAIKU]: ['same', 'same', 'same'], [SOL]: ['same', 'same', 'same'], [OPUS]: ['same', 'same', 'same'] })))
      expect(result.total).toMatchObject({ wins: 2, net: 2, eligible: 11 })
      expect(result.rule.met).toBe(false)
      expect(result.excluded.map((c) => [c.prompt_id, c.model, c.outcome])).toEqual([['p1', LUNA, 'plugin']])
      expect(result.models.find((m) => m.model === LUNA)).toMatchObject({ eligible: 2, wins: 2 })
    })

    test('the control cell is reported with its verdict and counted nowhere', () => {
      const { key } = build(all())
      const result = reveal(key, marksFor(key, {}, 'X'))
      expect(result.control).toMatchObject({ prompt_id: 'p4', model: LUNA, verdict: 'X' })
      expect(result.total).toMatchObject({ wins: 0, losses: 0, same: 12, net: 0 })
    })

    test('tool firings are reported apart from skill loads, and a win carried only by skills is visible', () => {
      const records = all().map((r) => {
        if (r.arm !== 'P1' || r.model !== LUNA) return r
        if (r.prompt_id === 'p1') return { ...r, tool_calls: [], skill_loads: ['synthesis'] }
        if (r.prompt_id === 'p2') return { ...r, skill_loads: ['synthesis', 'counterfactual'] }
        return r
      })
      const { key } = build(records)
      const result = reveal(key, marksFor(key, picksFor({ [LUNA]: ['plugin', 'plugin', 'plugin'] })))
      const luna = result.models.find((m) => m.model === LUNA)!
      expect(luna.cells.map((c) => [c.prompt_id, c.carried_by])).toEqual([['p1', 'skills'], ['p2', 'both'], ['p3', 'tools']])
      expect(luna).toMatchObject({ wins: 3, win_cells_tools_only: 1, win_cells_skills_only: 1, win_cells_both: 1 })
    })

    test('eligible cells are listed per model, and call counts and unwanted calls are checks per model', () => {
      const records = all().map((r) => (r.arm === 'P1' && r.model === HAIKU && r.prompt_id === 'p1' && r.run === 1 ? { ...r, tool_calls: [...r.tool_calls, { tool: 'metacogs_drugs', input: {}, status: 'completed' }], unwanted_calls: ['metacogs_drugs'] } : r))
      const { key } = build(records)
      const result = reveal(key, marksFor(key, {}))
      expect(result.models.map((m) => m.model)).toEqual([LUNA, HAIKU, SOL, OPUS])
      expect(result.models.find((m) => m.model === HAIKU)!.cells.map((c) => c.prompt_id)).toEqual(['p1', 'p2', 'p3'])
      expect(result.checks.find((c) => c.model === HAIKU)).toMatchObject({ plugin_runs: 6, runs_with_tool_call: 6, feel_calls: 6, drugs_calls: 1, unwanted_calls: 1, runs_with_skill_load: 0 })
    })
  })

  test('the revealed sheet shows arms, verdict outcomes, the rule and redacted answers', () => {
    const records = [...cell(LUNA, 'p1'), ...control(SOL, 'p3')].map((r) => (r.arm === 'P1' ? { ...r, final_answer: 'saw /tmp/metacogs-run-AAA/workspace/x and /tmp/metacogs-packed-AAA/unpacked/package/skills' } : r))
    const { key } = build(records)
    const marks = marksFor(key, { [`${LUNA}@p1`]: 'plugin' })
    const text = renderRevealed(key, marks, reveal(key, marks))
    expect(text).toContain('# Guided read 1: revealed sheet')
    expect(text).toContain('plugin')
    expect(text).toMatch(/Rule: not met/)
    expect(text).toContain('<ws>/x')
    expect(text).toContain('<pkg>/skills')
    expect(text).not.toContain('/tmp/')
    expect(text).toContain('control')
  })
})

describe('loadGuidedRuns and the command line', () => {
  const writeCampaign = (records: GuidedRecord[]) => {
    const dir = tmp('blind-campaign-')
    for (const r of records) {
      const runDir = join(dir, `${r.arm}-${r.prompt_id}-${r.run}`)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(r))
    }
    return dir
  }

  test('loads the run records of a campaign directory', () => {
    const dir = writeCampaign(cell(LUNA, 'p1'))
    expect(loadGuidedRuns(dir)).toHaveLength(4)
  })

  test('refuses a scripted run and a record of another schema', () => {
    const scripted = writeCampaign([{ ...record({ arm: 'N1', model: LUNA, prompt: 'p1', run: 1 }), provider: 'scripted' }])
    expect(() => loadGuidedRuns(scripted)).toThrow(/live/)
    const old = writeCampaign([{ ...record({ arm: 'N1', model: LUNA, prompt: 'p1', run: 1 }), schema_version: 2 } as unknown as GuidedRecord])
    expect(() => loadGuidedRuns(old)).toThrow(/schema_version/)
    expect(() => loadGuidedRuns(tmp())).toThrow(/no runs/)
  })

  test('blind writes the sheet and the key; reveal refuses an unmarked sheet, then writes the revealed sheet', async () => {
    const campaign = writeCampaign([...cell(LUNA, 'p1'), ...control(SOL, 'p3')])
    const out = join(tmp('blind-out-'), 'read1')
    const logs: string[] = []
    const log = (l: string) => void logs.push(l)
    expect(await main(['blind', '--campaign', campaign, '--out-dir', out], { log, prompts: PROMPTS })).toBe(0)
    expect(existsSync(join(out, 'sheet.md'))).toBe(true)
    expect(existsSync(join(out, 'key.json'))).toBe(true)
    expect(await main(['blind', '--campaign', campaign, '--out-dir', out], { log, prompts: PROMPTS })).toBe(1) // never overwrites a key

    expect(await main(['reveal', '--dir', out], { log })).toBe(2)
    expect(existsSync(join(out, 'revealed.md'))).toBe(false)

    const sheet = readFileSync(join(out, 'sheet.md'), 'utf8').replace(/^Verdict:.*$/gm, 'Verdict: same')
    writeFileSync(join(out, 'sheet.md'), sheet)
    expect(await main(['reveal', '--dir', out], { log })).toBe(0)
    expect(readFileSync(join(out, 'revealed.md'), 'utf8')).toContain('revealed sheet')
    expect(logs.join('\n')).toContain('Rule: not met')
  })
})

describe.skipIf(!opencodeAvailability().available)('a scripted campaign through sheet, marks and reveal', () => {
  test(
    'gives the rule result a hand computation gives',
    async () => {
      const prose = loadPrompts(ROOT).slice(0, 2)
      const outRoot = tmp('blind-run-')
      const common = { outRoot, prompts: prose, codingPrompts: loadCodingPrompts(ROOT), log: () => {} }
      // p1: full cell where the plugin arm calls metacogs_feel; p2: four nothing runs (the control).
      const cellRun = await runGuided(parseGuidedArgs(['--model', LUNA, '--runs', '2', '--prompt', 'p1']), common)
      const controlRun = await runGuided(parseGuidedArgs(['--model', LUNA, '--runs', '4', '--prompt', 'p2', '--arm', 'N1']), common)
      const records = [...cellRun.records, ...controlRun.records.filter((r) => r.prompt_id === 'p2')]
      expect(records.every((r) => r.status === 'completed')).toBe(true)

      const { key, sheet } = buildBlind({ records, prompts: prose, sources: ['scripted'], rng: constant(0) })
      expect(key.cells).toHaveLength(2)
      expect(sheet).not.toContain('metacogs_feel')

      // Hand computation: one eligible cell (the plugin arm fired); the owner prefers the plugin side, so +1; the control is a draw.
      const marks = marksFor(key, { [`${LUNA}@p1`]: 'plugin' }, 'Y')
      const result = reveal(key, marks)
      expect(result.total).toEqual({ wins: 1, losses: 0, same: 0, net: 1, eligible: 1 })
      expect(result.rule).toMatchObject({ met: false, total_net: 1 })
      expect(result.control).toMatchObject({ verdict: 'Y', prompt_id: 'p2' })
      expect(result.checks.find((c) => c.model === LUNA)).toMatchObject({ plugin_runs: 2, runs_with_tool_call: 2, feel_calls: 2 })
    },
    900_000,
  )
})
