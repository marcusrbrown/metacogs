import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256 } from '../../runner/workspace'
import { NUDGE, type RunRecord, type SpikePrompt } from './driver'
import { fenced, loadRuns, redactPaths, renderSheet, writeSheet } from './sheet'

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
    variant: 'unprompted',
    host_model: overrides.model,
    provider: 'live',
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
const SOL = 'openai/gpt-6.1-sol'
const OPUS = 'anthropic/claude-opus-5-5'
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

describe('redactPaths for package and plugin-cache paths', () => {
  const none = { workspaces: [], homes: [] }

  test('a node_modules package directory, scoped or not, becomes <pkg> and keeps what follows it', () => {
    expect(redactPaths('read /srv/x/node_modules/metacogs/skills/synthesis/SKILL.md', none)).toBe('read <pkg>/skills/synthesis/SKILL.md')
    expect(redactPaths('at /Users/me/.cache/opencode/node_modules/@scope/metacogs/dist/index.js:3', { workspaces: [], homes: ['/Users/me'] })).toBe('at <pkg>/dist/index.js:3')
  })

  test('the extracted package root of a packed run, and the recorded package paths, become <pkg>', () => {
    expect(redactPaths('/var/folders/ab/metacogs-packed-Qw12Er/unpacked/package/skills/synthesis', none)).toBe('<pkg>/skills/synthesis')
    expect(redactPaths('base /opt/pack/package/skills/x and /private/opt/pack/package/y', { workspaces: [], homes: [], packages: ['/opt/pack/package', '/private/opt/pack/package'] })).toBe('base <pkg>/skills/x and <pkg>/y')
  })

  test('the host plugin cache becomes <cache>, and the installed SDK in a config dir becomes <pkg>', () => {
    expect(redactPaths('/Users/me/.cache/opencode/packages/x.js', { workspaces: [], homes: ['/Users/me'] })).toBe('<cache>/packages/x.js')
    expect(redactPaths('/tmp/metacogs-lab-aB3/opencode-config-dir/node_modules/@opencode-ai/plugin/dist/x.js', none)).toBe('<pkg>/dist/x.js')
    expect(redactPaths('/tmp/metacogs-lab-aB3/opencode-config-dir/package.json', none)).toBe('<cache>/package.json')
  })

  test('nothing about the package patterns changes the existing workspace and home replacement', () => {
    expect(redactPaths(`${WS}/notes.md`, { workspaces: [WS], homes: [FAKE_HOME] })).toBe('<ws>/notes.md')
  })
})

describe('fenced', () => {
  test('is exported and picks a fence longer than any run inside the text', () => {
    expect(fenced('a\n~~~\nb', 'markdown')).toBe('~~~~markdown\na\n~~~\nb\n~~~~')
    expect(fenced('plain')).toBe('~~~\nplain\n~~~')
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
    expect(s).toContain('~~~~markdown\nbefore\n```js\ncode\n```\nafter\n~~~~')
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

describe('variants and model order', () => {
  const unprompted = [LUNA, HAIKU, SOL, OPUS].reverse().map((model) => record({ arm: 'A', model, prompt_id: 'p1', run: 1, answer: `unprompted ${model}` }))
  const nudged = [OPUS, SOL, HAIKU, LUNA].map((model) => record({ arm: 'B', model, prompt_id: 'p1', run: 1, variant: 'nudged', answer: `nudged ${model}` }))
  const sheet = renderSheet({ runs: [...nudged, ...unprompted], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
  const NUDGED_HEADING = '# Told to use it (nudged)'

  test('the unprompted section comes first and the nudged one is a separate top-level section', () => {
    const at = sheet.indexOf(NUDGED_HEADING)
    expect(at).toBeGreaterThan(0)
    expect(sheet.split(`\n${NUDGED_HEADING}\n`)).toHaveLength(2)
    const [before, after] = [sheet.slice(0, at), sheet.slice(at)]
    for (const model of [LUNA, HAIKU, SOL, OPUS]) {
      expect(before).toContain(`unprompted ${model}`)
      expect(before).not.toContain(`nudged ${model}`)
      expect(after).toContain(`nudged ${model}`)
      expect(after).not.toContain(`unprompted ${model}`)
    }
  })

  test('the nudged section opens with the nudge sentence verbatim', () => {
    const after = sheet.slice(sheet.indexOf(NUDGED_HEADING))
    const sentence = NUDGE.trim()
    expect(after.slice(0, after.indexOf('## p1'))).toContain(sentence)
    expect(sheet.slice(0, sheet.indexOf(NUDGED_HEADING))).not.toContain(sentence)
  })

  test('each section groups prompt, then model, then arm, with models in the order luna, haiku, sol, opus', () => {
    for (const part of [sheet.slice(0, sheet.indexOf(NUDGED_HEADING)), sheet.slice(sheet.indexOf(NUDGED_HEADING))]) {
      const models = [...part.matchAll(/^### (.+)$/gm)].map((m) => m[1])
      expect(models).toEqual([LUNA, HAIKU, SOL, OPUS])
    }
  })

  test('runs from before the field existed read as unprompted, and a sheet with no nudged runs has no nudged section', () => {
    const { variant: _v, ...legacy } = record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, answer: 'old run' })
    const s = renderSheet({ runs: [legacy as unknown as RunRecord], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
    expect(s).toContain('old run')
    expect(s).not.toContain(NUDGED_HEADING)
  })

  test('loadRuns fills in the variant for run records written before the field', () => {
    const root = tmp()
    const { variant: _v, ...legacy } = record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1 })
    const dir = join(root, 'c')
    mkdirSync(join(dir, 'A-p1-1'), { recursive: true })
    writeFileSync(join(dir, 'A-p1-1', 'run.json'), JSON.stringify(legacy))
    expect(loadRuns(dir)[0]?.variant).toBe('unprompted')
  })
})

/** Heading lines (levels 1 to 6) that sit outside every fenced block, in a minimal CommonMark fence tracker. */
function outline(markdown: string): string[] {
  const headings: string[] = []
  let open: { char: string; length: number } | undefined
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open) {
      if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && fence[2]!.trim() === '') open = undefined
      continue
    }
    if (fence) {
      open = { char: fence[1]![0]!, length: fence[1]!.length }
      continue
    }
    if (/^#{1,6}( |$)/.test(line)) headings.push(line)
  }
  expect(open).toBeUndefined() // every fence closed
  return headings
}

const slugOf = (heading: string): string =>
  heading
    .replace(/^#+\s+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

describe('answers cannot reach the outline', () => {
  const hostile = [
    '# Heading in an answer',
    '',
    '## Another',
    '#### B · run 9 (a fake run heading)',
    '```js',
    'code',
    '```',
    '~~~',
    'not a close',
    '~~~~',
    '# After the fences',
  ].join('\n')
  const runs = [
    record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, answer: hostile }),
    record({ arm: 'C', model: LUNA, prompt_id: 'p1', run: 1, skill_loaded: true, in_reply_fields: { feel: true, drugs: false }, answer: hostile }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 1, variant: 'nudged', tool_calls: [{ tool: 'metacog_feel', input: {}, status: 'completed' }], answer: hostile }),
  ]
  const sheet = renderSheet({ runs, prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })

  test('no line starting with # sits outside a fence, and the only headings are the renderer\'s own', () => {
    expect(outline(sheet)).toEqual([
      '# feel/drugs spike: read sheet',
      '## Where to look',
      '## About this sheet',
      '## Arm C instruction text',
      '## p1',
      `### ${LUNA}`,
      '#### A · run 1 · p1 · openai/gpt-6-luna',
      '#### C · run 1 · p1 · openai/gpt-6-luna',
      '# Told to use it (nudged)',
      '## p1',
      `### ${LUNA}`,
      '#### B · run 1 · p1 · openai/gpt-6-luna · nudged',
    ])
  })

  test('each answer sits in a ~~~markdown block longer than any run of ~ or backticks inside it', () => {
    expect(sheet).toContain(`~~~~~markdown\n${hostile}\n~~~~~`)
    expect(sheet.split('~~~~~markdown\n').length - 1).toBe(3)
  })

  test('the arm C instruction text is fenced the same way', () => {
    expect(sheet).toContain(`~~~~markdown\n${INSTRUCTION.trimEnd()}\n~~~~`)
  })
})

describe('where to look', () => {
  const runs = [
    record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1 }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 1 }),
    record({ arm: 'B', model: LUNA, prompt_id: 'p1', run: 2, tool_calls: [{ tool: 'read', input: {}, status: 'completed' }, { tool: 'metacog_feel', input: {}, status: 'completed' }] }),
    record({ arm: 'C', model: LUNA, prompt_id: 'p1', run: 1, skill_loaded: true, in_reply_fields: { feel: true, drugs: false } }),
    record({ arm: 'C', model: LUNA, prompt_id: 'p1', run: 2, skill_loaded: false, in_reply_fields: { feel: false, drugs: false } }),
    record({ arm: 'B', model: HAIKU, prompt_id: 'p2', run: 1, variant: 'nudged', tool_calls: [{ tool: 'metacog_drugs', input: {}, status: 'completed' }, { tool: 'metacog_feel', input: {}, status: 'completed' }] }),
    record({ arm: 'B', model: HAIKU, prompt_id: 'p2', run: 2, variant: 'nudged', tool_calls: [{ tool: 'glob', input: {}, status: 'completed' }] }),
    record({ arm: 'C', model: HAIKU, prompt_id: 'p2', run: 1, variant: 'nudged', skill_loaded: true, in_reply_fields: { feel: false, drugs: false } }),
  ]
  const sheet = renderSheet({ runs, prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
  const section = sheet.slice(sheet.indexOf('## Where to look'), sheet.indexOf('## About this sheet'))
  const links = [...section.matchAll(/\[([^\]]+)\]\(#([^)]+)\)/g)].map((m) => ({ text: m[1]!, slug: m[2]! }))

  test('lists exactly the B runs with a metacog call and the C runs that loaded the skill, split by variant', () => {
    expect(links.map((l) => l.text)).toEqual([
      'p1 · openai/gpt-6-luna · B run 2: metacog_feel',
      'p1 · openai/gpt-6-luna · C run 1: skill loaded',
      'p2 · anthropic/claude-haiku-5-5 · B run 1: metacog_drugs, metacog_feel',
      'p2 · anthropic/claude-haiku-5-5 · C run 1: skill loaded',
    ])
    expect(section.indexOf('Unprompted')).toBeLessThan(section.indexOf(links[0]!.text))
    expect(section.indexOf('Told to use it (nudged)')).toBeGreaterThan(section.indexOf(links[1]!.text))
    expect(section.indexOf('Told to use it (nudged)')).toBeLessThan(section.indexOf(links[2]!.text))
  })

  test('every link resolves to exactly one run heading in the sheet', () => {
    const headings = outline(sheet).filter((h) => h.startsWith('#### '))
    const slugs = headings.map(slugOf)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const link of links) expect(slugs.filter((x) => x === link.slug)).toHaveLength(1)
  })

  test('says so when nothing used the mechanism', () => {
    const s = renderSheet({ runs: [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1 })], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })
    expect(s).toMatch(/## Where to look[\s\S]*none/i)
  })
})

describe('provenance', () => {
  test('a scripted campaign is refused, naming the campaign', () => {
    const root = tmp()
    const dir = writeCampaign(root, 'openai-gpt-6-luna-2026-scripted', [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, provider: 'scripted' })])
    expect(() => loadRuns(dir)).toThrow(/openai-gpt-6-luna-2026-scripted/)
    expect(() => loadRuns(dir)).toThrow(/live/)
    expect(() => writeSheet({ campaigns: [dir], out: join(root, 'sheet.md'), prompts: PROMPTS, repoRoot: root })).toThrow(/scripted/)
  })

  test('renderSheet refuses a scripted run handed to it directly', () => {
    expect(() => renderSheet({ runs: [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, provider: 'scripted' })], prompts: PROMPTS, skillInstruction: INSTRUCTION, sources: [] })).toThrow(/live/)
  })

  test('every run shows its host model', () => {
    const s = renderSheet({
      runs: [record({ arm: 'A', model: LUNA, prompt_id: 'p1', run: 1, host_model: 'openai/gpt-6-luna' }), record({ arm: 'B', model: HAIKU, prompt_id: 'p1', run: 1, host_model: 'anthropic/claude-haiku-5-5' })],
      prompts: PROMPTS,
      skillInstruction: INSTRUCTION,
      sources: [],
    })
    expect(s).toContain('- Host model: `openai/gpt-6-luna`')
    expect(s).toContain('- Host model: `anthropic/claude-haiku-5-5`')
    expect(s.split('- Host model:').length - 1).toBe(2)
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
