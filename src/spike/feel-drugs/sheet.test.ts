import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256 } from '../../runner/workspace'
import type { RunRecord, SpikePrompt } from './driver'
import { loadRuns, redactPaths, renderSheet, writeSheet } from './sheet'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
const tmp = (prefix = 'feel-drugs-sheet-'): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const WS = '/var/folders/zz/abc123/T/metacogs-run-AbCd12/workspace'
const FAKE_HOME = '/var/folders/zz/abc123/T/metacogs-run-AbCd12/home'
const PROMPTS: SpikePrompt[] = [
  { id: 'p1', text: 'Write a short story about a lighthouse keeper.', rationale: 'creative' },
  { id: 'p2', text: 'Give me your view on rewriting a billing service.', rationale: 'stance' },
]

function record(overrides: Partial<RunRecord> & Pick<RunRecord, 'arm' | 'model' | 'prompt_id' | 'run'>): RunRecord {
  const prompt = PROMPTS.find((p) => p.id === overrides.prompt_id)!
  return {
    schema_version: 1,
    host_model: 'metacogs-spike-provider/metacogs-spike-model',
    provider: 'scripted',
    prompt_hash: sha256(prompt.text),
    status: 'completed',
    reasons: [],
    offered_tools: ['glob', 'grep', 'read'],
    tool_calls: [],
    skill_loaded: null,
    in_reply_fields: null,
    answer: 'An answer.',
    isolation: { passed: true, failed: [] },
    paths: { workspaces: [WS], homes: [FAKE_HOME] },
    wall_ms: 10,
    usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    returned_models: [],
    ...overrides,
  }
}

function writeCampaign(root: string, name: string, records: RunRecord[]): string {
  const dir = join(root, name)
  for (const r of records) {
    const runDir = join(dir, `${r.arm}-${r.prompt_id}-${r.run}`)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(r))
    writeFileSync(join(runDir, 'stdout.jsonl'), 'raw stdout that must never reach the sheet\n')
  }
  return dir
}

const LUNA = 'openai/gpt-6-luna'
const HAIKU = 'anthropic/claude-haiku-5-5'
const INSTRUCTION = '---\nname: metacog-frames\n---\n\n```\n<sigil>\n```\n'

describe('redactPaths', () => {
  test('replaces the run workspace and home, the operator home, and any other fixture path', () => {
    const text = [`wrote ${WS}/notes.md`, `home is ${FAKE_HOME}/.config`, `mine: ${homedir()}/src/x`, '/tmp/metacogs-run-Zz99/workspace/a.txt', '/private/tmp/metacogs-run-Zz99/home/b'].join('\n')
    const out = redactPaths(text, { workspaces: [WS], homes: [FAKE_HOME] })
    expect(out).toBe(['wrote <ws>/notes.md', 'home is <home>/.config', 'mine: <home>/src/x', '<ws>/a.txt', '<home>/b'].join('\n'))
    expect(out).not.toContain(WS)
    expect(out).not.toContain(homedir())
  })

  test('the longer of two overlapping paths is replaced first', () => {
    expect(redactPaths('/a/b/c/file', { workspaces: ['/a/b/c'], homes: ['/a/b'] })).toBe('<ws>/file')
  })

  test('text with no path is returned as is', () => {
    expect(redactPaths('plain', { workspaces: [], homes: [] })).toBe('plain')
  })
})

describe('loadRuns', () => {
  test('reads every run.json under a campaign and nothing else', () => {
    const root = tmp()
    const dir = writeCampaign(root, 'c1', [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1 }), record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 1 })])
    expect(loadRuns(dir).map((r) => r.arm).sort()).toEqual(['A', 'B'])
  })

  test('refuses a run record from another schema, and an empty campaign', () => {
    const root = tmp()
    const dir = join(root, 'c')
    mkdirSync(join(dir, 'A-p1-1'), { recursive: true })
    writeFileSync(join(dir, 'A-p1-1', 'run.json'), JSON.stringify({ schema_version: 2 }))
    expect(() => loadRuns(dir)).toThrow(/schema/)
    expect(() => loadRuns(join(root, 'empty'))).toThrow(/no runs/i)
  })
})

describe('renderSheet', () => {
  const runs = [
    // out of order on purpose
    record({ arm: 'C', model: LUNA, prompt_id: 'p1', run: 1, skill_loaded: true, in_reply_fields: { feel: true, drugs: false }, answer: 'Attending: a lamp\nTexture: warm\n\nThe story.' }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 2, offered_tools: ['read', 'metacog_feel', 'metacog_drugs'], answer: 'B second' }),
    record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, answer: 'A answer' }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 1, offered_tools: ['read', 'metacog_feel', 'metacog_drugs'], tool_calls: [{ tool: 'metacog_feel', input: { somewhere: 'in the gap', quality: 'warm', sigil: '🌊' }, status: 'completed' }], answer: 'B answer' }),
    record({ arm: 'A', model: HAIKU, prompt_id: 'p2', run: 1, answer: 'haiku A' }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p2', run: 1, status: 'tools_missing', reasons: ['expected_tools_not_offered'], answer: 'quiet arm A' }),
  ]
  const sheet = renderSheet({ runs, prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: ['luna-2026'] })

  test('groups by prompt, then model, then arm, so A and B answers to one prompt sit together', () => {
    const order = ['## p1', `### ${LUNA}`, '#### A · run 1', '#### B · run 1', '#### B · run 2', '#### C · run 1', '## p2', `### ${LUNA}`, `### ${HAIKU}`]
    let at = -1
    for (const heading of order) {
      const next = sheet.indexOf(heading, at + 1)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(sheet.indexOf('A answer')).toBeLessThan(sheet.indexOf('B answer'))
    expect(sheet.indexOf('B answer')).toBeLessThan(sheet.indexOf('Attending: a lamp'))
  })

  test('shows the prompt text and rationale, the offered tools, and the composed arguments of each call', () => {
    expect(sheet).toContain('Write a short story about a lighthouse keeper.')
    expect(sheet).toContain('Rationale: creative')
    expect(sheet).toContain('metacog_feel')
    expect(sheet).toContain('"somewhere":"in the gap"')
    expect(sheet).toContain('🌊')
    expect(sheet).toMatch(/Offered tools: .*metacog_feel.*metacog_drugs/)
  })

  test('arm C rows say whether the skill was loaded and whether the frame fields are in the reply', () => {
    const c = sheet.slice(sheet.indexOf('#### C · run 1'), sheet.indexOf('## p2'))
    expect(c).toContain('Skill loaded: yes')
    expect(c).toContain('Frame fields in reply: feel yes, drugs no')
  })

  test('a run that is not completed carries its status and reasons', () => {
    const b = sheet.slice(sheet.indexOf('## p2'))
    expect(b).toContain('tools_missing')
    expect(b).toContain('expected_tools_not_offered')
  })

  test('the arm C instruction text appears once, not per run', () => {
    expect(sheet.split('name: metacog-frames').length - 1).toBe(1)
  })

  test('raw stdout and stderr are not part of the sheet', () => {
    expect(sheet).not.toContain('raw stdout')
  })

  test('an answer holding a code fence cannot break out of its block', () => {
    const s = renderSheet({ runs: [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, answer: 'before\n```js\ncode\n```\nafter' })], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
    expect(s).toContain('````\nbefore\n```js\ncode\n```\nafter\n````')
  })

  test('workspace and home paths in answers and tool inputs are redacted', () => {
    const s = renderSheet({
      runs: [
        record({
          arm: 'B',
          model: LUNA,
          prompt_id: 'p1',
          run: 1,
          answer: `I looked in ${WS}/fixture.md and under ${FAKE_HOME}/.cache and ${homedir()}/secret.`,
          tool_calls: [{ tool: 'read', input: { filePath: `${WS}/fixture.md` }, status: 'completed' }],
        }),
      ],
      prompts: PROMPTS,
      skillInstruction: INSTRUCTION,
      sources: [],
    })
    expect(s).toContain('I looked in <ws>/fixture.md and under <home>/.cache and <home>/secret.')
    expect(s).toContain('"filePath":"<ws>/fixture.md"')
    expect(s).not.toContain(WS)
    expect(s).not.toContain(FAKE_HOME)
    expect(s).not.toContain(homedir())
  })

  test('a prompt whose text changed since the run is flagged, not silently shown', () => {
    const stale = record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, prompt_hash: 'f'.repeat(64) })
    const s = renderSheet({ runs: [stale], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
    expect(s).toMatch(/prompt text not found/i)
  })
})

describe('writeSheet', () => {
  test('reads campaign dirs and writes the sheet, redacted, naming campaigns by basename only', () => {
    const root = tmp()
    const campaign = writeCampaign(root, 'openai-gpt-6-luna-2026-10-25T12-00-00-000Z', [
      record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, answer: `see ${WS}/x` }),
    ])
    const out = join(root, 'sheet.md')
    const repo = tmp('feel-drugs-sheet-repo-')
    mkdirSync(join(repo, 'evals', 'spikes', 'feel-drugs', 'skill', 'metacog-frames'), { recursive: true })
    writeFileSync(join(repo, 'evals', 'spikes', 'feel-drugs', 'skill', 'metacog-frames', 'SKILL.md'), INSTRUCTION)
    writeSheet({ campaigns: [campaign], out, prompts: PROMPTS, repoRoot: repo })
    const text = readFileSync(out, 'utf8')
    expect(text).toContain('openai-gpt-6-luna-2026-10-25T12-00-00-000Z')
    expect(text).not.toContain(root)
    expect(text).toContain('see <ws>/x')
    expect(text).toContain('name: metacog-frames')
  })
})
