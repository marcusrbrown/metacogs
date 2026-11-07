import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ARM_NAMES } from './gates'
import { buildSheet, HIDDEN_CALL, renderAnswer, scrubAnswer, sheetsDir, type SheetKey } from './sheet'
import { newSheetLab, OUTCOME_REF, runSyntheticCampaign, type SheetLab, seeded, stdoutOf, stepFinish, textEvent, toolEvent } from './sheet-support'

const labs: SheetLab[] = []
afterEach(() => {
  for (const lab of labs.splice(0)) lab.dispose()
})
const lab = (): SheetLab => {
  const l = newSheetLab()
  labs.push(l)
  return l
}

const FIXTURES = [
  { id: 'moment-one', kind: 'feel' as const },
  { id: 'turn-two', kind: 'ordinary' as const },
]

const SOMEWHERE = 'in the gap between the test and the fix'

/** Answers that name their arm in every way the sheet must hide. */
const TELLS = {
  feel: stdoutOf(
    textEvent('# feel\n\nBase directory for this skill: /pkg/plugin/skills/feel\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\n\nI will call the feel tool now, as `/feel` asked.'),
    toolEvent('feel', { somewhere: SOMEWHERE }),
    toolEvent('read', { filePath: 'notes.txt' }),
    textEvent('Then check the lockfile.'),
    stepFinish(),
  ),
  'feel-somewhere': stdoutOf(textEvent(`Using ${SOMEWHERE}, run the checks.`), toolEvent('skill', { name: 'feel' }, 'completed', '<skill_content name="feel">x</skill_content>'), stepFinish()),
  drugs: stdoutOf(textEvent('/drugs says wait. # drugs\nMetacogs frame loaded.'), toolEvent('metacogs_drugs', { substance: 'x' }), stepFinish()),
  'drugs-caffeine': stdoutOf(textEvent('Caffeine means go faster; psilocybin means look wider. Using drugs(…) here.'), stepFinish()),
  'drugs-psilocybin': stdoutOf(textEvent('<skill_content name="drugs">frame text</skill_content> Then run the checks.'), stepFinish()),
  whichever: stdoutOf(textEvent('Use whichever metacogs tool fits this moment, then continue. I chose the "feel" tool.'), stepFinish()),
  'nudge-only': stdoutOf(textEvent('Use whichever tool fits this moment, then continue. Checking the build.'), toolEvent('bash', { command: 'bun test' }), stepFinish()),
} as const

const readKey = (l: SheetLab, campaign = 'phase1'): SheetKey => JSON.parse(readFileSync(join(sheetsDir(l.store, campaign), 'key.json'), 'utf8')) as SheetKey

describe('blind sheet build', () => {
  test('brief and the expected-move line come before the answers, and the brief holds no outcome or provenance', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const { sheet, key } = buildSheet(l.store, { campaign: 'phase1', rng: seeded(1) })

    const moments = sheet.split(/^## /m).slice(1)
    expect(moments.length).toBe(3) // two scenarios and the appendix
    for (const moment of moments.slice(0, 2)) {
      const scenario = moment.indexOf('Scenario')
      const expected = moment.indexOf('\nexpected: _')
      const firstAnswer = moment.indexOf('#### ')
      expect(scenario).toBeGreaterThanOrEqual(0)
      expect(expected).toBeGreaterThan(scenario)
      expect(firstAnswer).toBeGreaterThan(expected)
      expect(moment).toContain('Trying a clean install.')
      expect(moment).toContain('[tool] read filePath=notes.txt -> synthetic notes line')
    }
    expect(sheet).not.toContain(OUTCOME_REF)
    expect(sheet).not.toContain('project-a')
    expect(sheet).not.toContain('ses_source')
    expect(sheet).not.toContain(SOMEWHERE)
    for (const f of FIXTURES) expect(sheet).not.toContain(f.id)
    expect(sheet).toContain(`build: ${key.build_id}`)
    expect(key.build_id).toMatch(/^[0-9a-f]{12}$/)
    expect(sheet).toContain('can hint that a command arm produced the answer')
  })

  test('answers are shuffled per fixture and model, differently under another seed, the same under the same seed', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES })
    const order = (key: SheetKey) => key.answers.map((a) => `${a.id}=${a.arm}`).join(',')
    const dir = sheetsDir(l.store, 'phase1')

    const first = order(buildSheet(l.store, { campaign: 'phase1', rng: seeded(1) }).key)
    rmSync(dir, { recursive: true })
    const same = order(buildSheet(l.store, { campaign: 'phase1', rng: seeded(1) }).key)
    rmSync(dir, { recursive: true })
    const other = order(buildSheet(l.store, { campaign: 'phase1', rng: seeded(2) }).key)

    expect(same).toBe(first)
    expect(other).not.toBe(first)
    const key = readKey(l)
    const cell = key.answers.filter((a) => a.fixture === 'moment-one' && a.model === key.models[0])
    // Letters are assigned after the shuffle, so the arm order is not the canonical one.
    expect(cell.map((a) => a.arm)).not.toEqual([...ARM_NAMES])
    expect(cell.map((a) => a.letter).sort().join('')).toBe('ABCDEFGHI')
    expect(new Set(cell.map((a) => a.arm)).size).toBe(9)
  })

  test('no answer carries a command, skill header, base directory, tool name, substance or the arm message', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, answer: (job) => ({ stdout: TELLS[job.arm as keyof typeof TELLS] ?? stdoutOf(textEvent(`Run the checks next. (${job.arm})`), stepFinish()) }) })
    const { sheet, key } = buildSheet(l.store, { campaign: 'phase1', rng: seeded(3) })

    for (const tell of ['/feel', '/drugs', '# feel', '# drugs', 'Base directory for this skill', 'Relative paths in this skill', '<skill_content', 'whichever', 'metacogs', 'caffeine', 'psilocybin', SOMEWHERE, OUTCOME_REF]) expect(sheet.toLowerCase()).not.toContain(tell.toLowerCase())
    expect(sheet).not.toMatch(/\b(feel|drugs)\b/i)
    expect(sheet).toContain('Then check the lockfile.')
    expect(sheet).toContain('[tool] bash command=bun test')
    expect(sheet).toContain('[tool] read filePath=notes.txt')
    // Counts, never text, are kept in the key.
    expect(key.answers.some((a) => a.redactions > 0)).toBe(true)
    expect(JSON.stringify(key)).not.toContain('Then check the lockfile.')
  })

  test('hidden calls show the placeholder, and the key counts them', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: FIXTURES, answer: (job) => ({ stdout: TELLS[job.arm as keyof typeof TELLS] ?? stdoutOf(textEvent('ok'), stepFinish()) }) })
    const { sheet, key } = buildSheet(l.store, { campaign: 'phase1', rng: seeded(4) })

    const hiddenOnSheet = sheet.split(HIDDEN_CALL).length - 1
    // feel, feel-somewhere (skill call), drugs (metacogs_drugs) and the skill_content blocks, over 2 fixtures x 2 models.
    expect(hiddenOnSheet).toBeGreaterThanOrEqual(2 * 2 * 3)
    expect(key.answers.filter((a) => a.hidden_calls > 0).map((a) => a.arm).sort()).toEqual([...Array(4).fill('drugs'), ...Array(4).fill('feel'), ...Array(4).fill('feel-somewhere')])
    expect(sheet).toContain('[tool] bash command=bun test')
  })

  test('excluded, timeout and pending cells go to the appendix by count and reason, not onto the sheet', async () => {
    const l = lab()
    await runSyntheticCampaign(l, {
      fixtures: [FIXTURES[0]!],
      arms: ['continue-a', 'continue-b', 'feel', 'drugs'],
      answer: (job) => (job.arm === 'feel' ? 'excluded' : job.arm === 'drugs' && job.model.startsWith('openai') ? 'timeout' : undefined),
    })
    const { sheet, key } = buildSheet(l.store, { campaign: 'phase1', rng: seeded(5) })

    expect(key.answers.map((a) => a.arm).sort()).toEqual(['continue-a', 'continue-a', 'continue-b', 'continue-b', 'drugs'])
    expect(key.appendix.map((a) => `${a.arm}|${a.status}|${a.reason}`).sort()).toEqual(['drugs|timeout|timeout', 'feel|excluded|host_version', 'feel|excluded|host_version'])
    const appendix = sheet.slice(sheet.indexOf('## Appendix'))
    expect(appendix).toContain('- excluded · host_version: 2')
    expect(appendix).toContain('- timeout · timeout: 1')
    expect(appendix).not.toMatch(/\b(feel|drugs)\b/)
    expect(sheet.slice(0, sheet.indexOf('## Appendix'))).not.toContain('host_version')
  })

  test('--models keeps one model, and an unknown model is refused', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], arms: ['continue-a', 'continue-b'] })
    expect(() => buildSheet(l.store, { campaign: 'phase1', models: ['openai/gpt-9'] })).toThrow('has no cells for openai/gpt-9')
    const { key } = buildSheet(l.store, { campaign: 'phase1', models: ['anthropic/claude-opus-5-5'], rng: seeded(1) })
    expect(new Set(key.answers.map((a) => a.model))).toEqual(new Set(['anthropic/claude-opus-5-5']))
    expect(key.models).toEqual(['anthropic/claude-opus-5-5'])
  })

  test('sheet and key are private, tie answers to attempt hashes, and are never redrawn', async () => {
    const l = lab()
    await runSyntheticCampaign(l, { fixtures: [FIXTURES[0]!], arms: ['continue-a', 'continue-b'] })
    const built = buildSheet(l.store, { campaign: 'phase1', rng: seeded(1) })

    expect(statSync(built.dir).mode & 0o777).toBe(0o700)
    expect(statSync(built.sheetPath).mode & 0o777).toBe(0o600)
    expect(statSync(built.keyPath).mode & 0o777).toBe(0o600)
    for (const a of built.key.answers) {
      expect(a.attempt).toMatch(/^moment-one\/[a-z-]+__[a-z0-9.-]+\/continue-[ab]\/a001$/)
      expect(a.attempt_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(() => buildSheet(l.store, { campaign: 'phase1' })).toThrow('never replaced')
    expect(() => buildSheet(l.store, { campaign: 'nope' })).toThrow('no cells on disk')
  })
})

describe('answer rendering', () => {
  test('keeps stream order, summarizes tool inputs briefly and marks non-completed calls', () => {
    const stdout = stdoutOf(textEvent('First look.'), toolEvent('grep', { pattern: 'x'.repeat(200), path: 'src', include: '*.ts', extra: 1 }, 'error'), textEvent('Then fix it.'))
    const { text, hidden_calls } = renderAnswer(parseLines(stdout), { somewhere: '' })
    const lines = text.split('\n')
    expect(lines[0]).toBe('First look.')
    expect(lines[1]).toMatch(/^\[tool\] grep pattern=x{79}… path=src include=\*\.ts … \[error\]$/)
    expect(lines[2]).toBe('Then fix it.')
    expect(hidden_calls).toBe(0)
  })

  test('an empty reply reads (no text), and a very long one is clipped', () => {
    expect(renderAnswer([], { somewhere: '' }).text).toBe('(no text)')
    const long = renderAnswer(parseLines(stdoutOf(textEvent('y'.repeat(7000)))), { somewhere: '' }).text
    expect(long).toContain('[… 1000 more characters not shown]')
  })

  test('scrub leaves ordinary prose alone and counts what it changes', () => {
    expect(scrubAnswer('I feel the build is flaky; check the lockfile.', { somewhere: '' })).toEqual({ text: 'I feel the build is flaky; check the lockfile.', redactions: 0 })
    expect(scrubAnswer('Run /feel then `drugs`.', { somewhere: '' }).redactions).toBe(2)
  })
})

function parseLines(stdout: string) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; part?: Record<string, unknown> })
}
