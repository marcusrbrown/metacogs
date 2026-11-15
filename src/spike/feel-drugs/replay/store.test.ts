import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CustodyError, sha256 } from '../../../runner/workspace'
import {
  approveFixture,
  buildExport,
  buildFixture,
  FixtureRefusal,
  type FixtureSpec,
  FreezeError,
  freezeFixture,
  listFixtures,
  loadFrozen,
  loadRaw,
  openStore,
  parseSpec,
  type SessionExport,
  saveRaw,
  skillPlaceholders,
  SpecError,
  type Store,
} from './store'
import { checkFidelity, normalizeHistory, partsSignature } from './probe.test'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function tmp(prefix = 'replay-store-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A store under a throwaway root with a throwaway "repo" next to it. */
function newStore(): Store & { repoRoot: string } {
  const repoRoot = tmp('replay-repo-')
  const root = join(tmp(), 'replay')
  return Object.assign(openStore({ root, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') }), { repoRoot })
}

const spec = (over: Partial<FixtureSpec> = {}): FixtureSpec => ({
  id: 'moment-a',
  kind: 'feel',
  provenance: { project: 'project-a', source_session: 'ses_source', cutoff_message: 'msg_cutoff', date: '2026-11-01' },
  expected_outcome_ref: 'Resolved by pinning the dependency.',
  somewhere: 'in the gap between the failing test and the fix',
  turns: [
    { role: 'user', text: 'The build fails after the upgrade.' },
    { role: 'assistant', text: 'I will check the lockfile.', tools: [{ callID: 'call_read1', tool: 'read', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' }] },
    { role: 'user', text: 'Still failing.' },
    { role: 'assistant', text: 'Trying a clean install.' },
  ],
  ...over,
})

// Assembled at run time so this file stays clean under the repo scan.
const TOKEN = `ghp_${'A1'.repeat(18)}`
const HOME_PATH = `/${'Users'}/someone/project`

describe('parseSpec', () => {
  test('accepts a well-formed spec and returns it unchanged', () => {
    expect(parseSpec(JSON.parse(JSON.stringify(spec())))).toEqual(spec())
  })

  test.each([
    ['an id with a path separator', { id: '../x' }],
    ['an id with uppercase', { id: 'Moment' }],
    ['an unknown kind', { kind: 'other' }],
    ['no turns', { turns: [] }],
    ['a first turn from the assistant', { turns: [{ role: 'assistant', text: 'x' }] }],
    ['a last turn from the user', { turns: [{ role: 'user', text: 'x' }] }],
    ['two user turns in a row', { turns: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }] }],
    ['a tool call without output', { turns: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', tools: [{ tool: 'read', input: {} }] }] }],
    ['a tool call on a user turn', { turns: [{ role: 'user', text: 'a', tools: [] }, { role: 'assistant', text: 'b' }] }],
    ['an excluded block without a reason', { excluded: {} }],
    ['a missing provenance field', { provenance: { project: 'p', source_session: 's', date: '2026-11-01' } }],
    ['a date that is not a date', { provenance: { project: 'p', source_session: 's', cutoff_message: 'm', date: 'yesterday' } }],
  ])('rejects %s', (_label, over) => {
    expect(() => parseSpec({ ...spec(), ...over })).toThrow(SpecError)
  })

  test('an error names the field and never echoes the value', () => {
    const sentinel = 'PRIVATE-VALUE-123'
    try {
      parseSpec({ ...spec(), kind: sentinel })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SpecError)
      expect((e as Error).message).toContain('kind')
      expect((e as Error).message).not.toContain(sentinel)
    }
  })

  test('an excluded spec may have no turns', () => {
    expect(parseSpec({ ...spec({ turns: [] }), excluded: { reason: 'compacted key tool output' } }).excluded).toEqual({ reason: 'compacted key tool output' })
  })
})

describe('workflow fixtures', () => {
  const workflow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...spec({ id: 'plan-claim', kind: 'workflow', somewhere: '' }), expected: 'fire', methods: ['counterfactual'], ...over })

  test('a fire fixture parses with its methods and round-trips unchanged', () => {
    const parsed = parseSpec(JSON.parse(JSON.stringify(workflow())))
    expect(parsed).toMatchObject({ kind: 'workflow', expected: 'fire', methods: ['counterfactual'] })
    expect(parseSpec(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  test('a silence fixture carries no methods: an empty list or none parses the same', () => {
    const none = parseSpec(workflow({ expected: 'silence', methods: undefined }))
    const empty = parseSpec(workflow({ expected: 'silence', methods: [] }))
    expect(none).toEqual(empty)
    expect('methods' in none).toBe(false)
    expect(none.expected).toBe('silence')
  })

  test.each([
    ['no expected value', { expected: undefined }],
    ['an unknown expected value', { expected: 'maybe' }],
    ['a fire fixture with no methods', { methods: undefined }],
    ['a fire fixture with an empty methods list', { methods: [] }],
    ['an unknown method', { methods: ['feel'] }],
    ['a repeated method', { methods: ['synthesis', 'synthesis'] }],
    ['methods that are not a list', { methods: 'synthesis' }],
    ['a silence fixture that names a method', { expected: 'silence', methods: ['synthesis'] }],
  ])('rejects %s', (_label, over) => {
    expect(() => parseSpec(workflow(over))).toThrow(SpecError)
  })

  test('expected and methods belong to the workflow kind alone', () => {
    for (const kind of ['feel', 'drugs', 'ordinary']) expect(() => parseSpec({ ...workflow(), kind })).toThrow(SpecError)
    expect(() => parseSpec({ ...spec(), methods: ['synthesis'] })).toThrow(SpecError)
  })

  test('an error names the field and never echoes the value', () => {
    const sentinel = 'PRIVATE-VALUE-123'
    for (const over of [{ expected: sentinel }, { methods: [sentinel] }]) {
      try {
        parseSpec(workflow(over))
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(SpecError)
        expect((e as Error).message).toMatch(/spec\.(expected|methods)/)
        expect((e as Error).message).not.toContain(sentinel)
      }
    }
  })

  test('building a fixture hashes the spec stably, and the expectation and methods are part of the hash', () => {
    const store = newStore()
    const hash = (over: Record<string, unknown> = {}): string => (buildFixture(store, workflow({ id: 'h', ...over })) as { spec_sha256: string }).spec_sha256
    const base = hash()
    expect(hash()).toBe(base)
    expect(hash({ expected: 'silence', methods: undefined })).not.toBe(base)
    expect(hash({ methods: ['synthesis'] })).not.toBe(base)
    expect(hash({ methods: ['synthesis', 'counterfactual'] })).not.toBe(hash({ methods: ['counterfactual', 'synthesis'] }))
    expect(hash()).toBe(base)
  })

  test('a workflow fixture freezes, is approved, loads, and lists with its kind', () => {
    const store = newStore()
    buildFixture(store, workflow())
    freezeFixture(store, 'plan-claim')
    approveFixture(store, 'plan-claim')
    expect(loadFrozen(store, 'plan-claim').spec).toMatchObject({ kind: 'workflow', expected: 'fire', methods: ['counterfactual'] })
    expect(listFixtures(store)).toEqual([{ id: 'plan-claim', kind: 'workflow', status: 'frozen', approved: true }])
  })

  test('the export of a seeded session keeps a systematic_skill tool call and its skill content', () => {
    const seeded = parseSpec(workflow({ turns: [{ role: 'user', text: 'Plan it.' }, { role: 'assistant', text: 'Loading.', tools: [{ callID: 'call_p', tool: 'systematic_skill', input: { name: 'ce:plan' }, output: '<skill_content name="systematic:ce:plan">x</skill_content>' }] }] }))
    const tool = buildExport(seeded).messages[1]!.parts.find((p) => p.type === 'tool')
    expect(tool).toMatchObject({ tool: 'systematic_skill', state: { input: { name: 'ce:plan' }, output: '<skill_content name="systematic:ce:plan">x</skill_content>' } })
  })
})

describe('skill-text placeholders', () => {
  const PLAN_SKILL = '---\nname: ce:plan\ndescription: plan things\n---\n\n# Plan\n\nFeature: #$ARGUMENTS\n'
  const SKILL_BASE = '/workspace/.systematic/skills'

  /** A tiny stand-in for an extracted Systematic package: the skills the fixtures name, with one reference file and one script. */
  function skillTree(over: { plan?: string; version?: string; without?: string } = {}): string {
    const root = tmp('systematic-tree-')
    const put = (rel: string, text: string): void => {
      if (rel === over.without) return
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    put('package.json', JSON.stringify({ name: '@fro.bot/systematic', version: over.version ?? '3.33.2' }))
    put('skills/ce-plan/SKILL.md', over.plan ?? PLAN_SKILL)
    put('skills/ce-plan/references/deepening-workflow.md', '# Deepening\n\nSecond line.\n')
    put('skills/ce-review/SKILL.md', '---\nname: ce:review\ndescription: review things\n---\n\n# Review\n\nParse `$ARGUMENTS` for tokens.\n')
    put('skills/ce-review/scripts/helper.mjs', '// helper\n')
    return root
  }

  const withPlaceholders = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...spec({ id: 'plan-claim', kind: 'workflow', somewhere: '' }),
    expected: 'fire',
    methods: ['counterfactual'],
    turns: [
      { role: 'user', text: 'Plan it.' },
      {
        role: 'assistant',
        text: 'Loaded the workflow.',
        tools: [
          { callID: 'call_s', tool: 'systematic_skill', input: { name: 'ce:plan', arguments: 'docs/brainstorms/x.md' }, output: '{{systematic-skill:ce-plan}}' },
          { callID: 'call_r', tool: 'read', input: { filePath: `${SKILL_BASE}/ce-plan/references/deepening-workflow.md` }, output: '{{systematic-file:ce-plan/references/deepening-workflow.md}}' },
        ],
      },
      { role: 'user', text: 'Go on.' },
      { role: 'assistant', text: 'Ready.' },
    ],
    ...over,
  })
  const canonicalText = (input: unknown): string => `${JSON.stringify(parseSpec(input), null, 2)}\n`
  const outputsOf = (store: Store, id = 'plan-claim'): string[] => (loadFrozen(store, id).spec.turns[1] as { tools: { output: string }[] }).tools.map((t) => t.output)
  const frozen = (store: Store, input: unknown, tree: string): ReturnType<typeof buildFixture> => {
    const entry = buildFixture(store, input, { systematicTree: tree })
    freezeFixture(store, (input as { id: string }).id)
    approveFixture(store, (input as { id: string }).id)
    return entry
  }

  test('building fills a skill placeholder with the host output of that skill, and the arguments replace $ARGUMENTS', () => {
    const store = newStore()
    frozen(store, withPlaceholders(), skillTree())
    const [skill] = outputsOf(store)
    expect(skill!.startsWith('<skill_content name="ce:plan">\n# Skill: ce:plan\n\n')).toBe(true)
    expect(skill).toContain('Feature: #docs/brainstorms/x.md')
    expect(skill).not.toContain('$ARGUMENTS')
    expect(skill).toContain(`Base directory for this skill: ${SKILL_BASE}/ce-plan/\nFile references (@path) in this skill are relative to this directory.`)
    expect(skill).toContain(`Base directory for this skill: file://${SKILL_BASE}/ce-plan\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.`)
    expect(skill).toContain(`<skill_files>\n  <file>${SKILL_BASE}/ce-plan/references/deepening-workflow.md</file>\n</skill_files>\n</skill_content>`)
    expect(skill).not.toContain('description: plan things')
  })

  test('a file placeholder renders in the read tool format, with numbered lines', () => {
    const store = newStore()
    frozen(store, withPlaceholders(), skillTree())
    expect(outputsOf(store)[1]).toBe(`<path>${SKILL_BASE}/ce-plan/references/deepening-workflow.md</path>\n<type>file</type>\n<content>\n1: # Deepening\n2: \n3: Second line.\n\n(End of file - total 3 lines)\n</content>`)
  })

  test('the export a run imports carries the filled text, and the manifest records what each placeholder became', () => {
    const store = newStore()
    const entry = frozen(store, withPlaceholders(), skillTree({ version: '3.33.2' })) as { render?: { template_sha256: string; systematic_version: string; skill_text: Record<string, string>; home_path_rewrites: number } }
    const loaded = loadFrozen(store, 'plan-claim')
    const [skill, file] = outputsOf(store)
    const exported = loaded.export.messages[1]!.parts.filter((p) => p.type === 'tool').map((p) => p.state!.output)
    expect(exported).toEqual([skill!, file!])
    expect(entry.render).toEqual({
      template_sha256: sha256(canonicalText(withPlaceholders())),
      systematic_version: '3.33.2',
      skill_text: { 'systematic-skill:ce-plan': sha256(skill!), 'systematic-file:ce-plan/references/deepening-workflow.md': sha256(file!) },
      home_path_rewrites: 0,
    })
    expect(loaded.entry.render).toEqual(entry.render)
  })

  test('the template hash ignores the tree, and the skill-text hash follows the text of the tree the build read', () => {
    const a = newStore()
    const b = newStore()
    const first = frozen(a, withPlaceholders(), skillTree()) as { render: { template_sha256: string; skill_text: Record<string, string> } }
    const second = frozen(b, withPlaceholders(), skillTree({ plan: PLAN_SKILL.replace('# Plan', '# Plan, revised') })) as { render: { template_sha256: string; skill_text: Record<string, string> } }
    expect(second.render.template_sha256).toBe(first.render.template_sha256)
    expect(second.render.skill_text['systematic-skill:ce-plan']).not.toBe(first.render.skill_text['systematic-skill:ce-plan'])
    expect(second.render.skill_text['systematic-file:ce-plan/references/deepening-workflow.md']).toBe(first.render.skill_text['systematic-file:ce-plan/references/deepening-workflow.md'])
  })

  test('a home-path example in a skill text is rewritten so the fixture scan accepts it, and the rewrite is counted', () => {
    const store = newStore()
    const plan = PLAN_SKILL.replace('# Plan', `# Plan\n\nNever write an absolute path like \`/${'Users'}/name/Code/app/src/a.ts\` or \`/${'home'}/dev/app\`.`)
    const entry = frozen(store, withPlaceholders(), skillTree({ plan })) as { render: { home_path_rewrites: number } }
    const [skill] = outputsOf(store)
    expect(skill).toContain('`/Users/<name>/Code/app/src/a.ts` or `/home/<dev>/app`')
    expect(skill).not.toMatch(/\/(Users|home)\/[A-Za-z]/)
    expect(entry.render.home_path_rewrites).toBe(2)
  })

  test('a tree with no SKILL.md for a named skill fails with the missing path named, and writes nothing', () => {
    const store = newStore()
    const tree = skillTree({ without: 'skills/ce-plan/SKILL.md' })
    expect(() => buildFixture(store, withPlaceholders(), { systematicTree: tree })).toThrow(/skills\/ce-plan\/SKILL\.md/)
    expect(listFixtures(store)).toEqual([])
    const noFile = skillTree({ without: 'skills/ce-plan/references/deepening-workflow.md' })
    expect(() => buildFixture(store, withPlaceholders(), { systematicTree: noFile })).toThrow(/skills\/ce-plan\/references\/deepening-workflow\.md/)
  })

  test('a spec with placeholders and no tree is refused, naming the placeholder', () => {
    const store = newStore()
    expect(() => buildFixture(store, withPlaceholders())).toThrow(/systematic-skill:ce-plan/)
    expect(listFixtures(store)).toEqual([])
  })

  test('a placeholder on the wrong tool call is refused: the call must be the one the text belongs to', () => {
    const store = newStore()
    const tree = skillTree()
    const turns = (tool: Record<string, unknown>): unknown[] => [{ role: 'user', text: 'Plan it.' }, { role: 'assistant', text: 'Loaded.', tools: [tool] }]
    const wrongSkill = { callID: 'call_s', tool: 'systematic_skill', input: { name: 'ce:review' }, output: '{{systematic-skill:ce-plan}}' }
    const wrongTool = { callID: 'call_s', tool: 'read', input: { name: 'ce:plan' }, output: '{{systematic-skill:ce-plan}}' }
    const wrongPath = { callID: 'call_r', tool: 'read', input: { filePath: `${SKILL_BASE}/ce-plan/SKILL.md` }, output: '{{systematic-file:ce-plan/references/deepening-workflow.md}}' }
    const embedded = { callID: 'call_s', tool: 'systematic_skill', input: { name: 'ce:plan' }, output: 'text then {{systematic-skill:ce-plan}}' }
    for (const tool of [wrongSkill, wrongTool, wrongPath]) expect(() => buildFixture(store, withPlaceholders({ turns: turns(tool) }), { systematicTree: tree })).toThrow(SpecError)
    // A placeholder that is not the whole output is plain text.
    buildFixture(store, withPlaceholders({ turns: turns(embedded) }), { systematicTree: tree })
    expect(listFixtures(store)).toHaveLength(1)
  })

  test('a file placeholder with a ".." segment is refused, and no file outside the skills directory is read', () => {
    const store = newStore()
    const tree = skillTree()
    const sentinel = 'OUTSIDE-THE-TREE-SENTINEL'
    const outside = join(dirname(tree), `outside-${process.pid}.txt`)
    writeFileSync(outside, sentinel)
    cleanup.push(() => rmSync(outside, { force: true }))
    // Each path resolves to a real file. The call's filePath matches the placeholder, so only the ".." guard stands in the way.
    for (const rel of [`ce-plan/../../../${outside.split('/').at(-1)}`, 'ce-plan/../../package.json', 'ce-plan/../ce-review/SKILL.md']) {
      const turns = [{ role: 'user', text: 'Plan it.' }, { role: 'assistant', text: 'Loaded.', tools: [{ callID: 'call_r', tool: 'read', input: { filePath: `${SKILL_BASE}/${rel}` }, output: `{{systematic-file:${rel}}}` }] }]
      let message = ''
      try {
        buildFixture(store, withPlaceholders({ turns }), { systematicTree: tree })
      } catch (e) {
        expect(e).toBeInstanceOf(SpecError)
        message = (e as Error).message
      }
      expect(message).toBe('spec.turns[1].tools[0]: expected a placeholder path with no ".." segment')
      expect(message).not.toContain(sentinel)
    }
    expect(listFixtures(store)).toEqual([])
  })

  test('a spec with no placeholders builds the same bytes with or without a tree, and records no render', () => {
    const a = newStore()
    const b = newStore()
    const plain = withPlaceholders({ turns: [{ role: 'user', text: 'Plan it.' }, { role: 'assistant', text: 'Ready.' }] })
    const without = buildFixture(a, plain) as { spec_sha256: string; export_sha256: string; render?: unknown }
    const withTree = buildFixture(b, plain, { systematicTree: skillTree() }) as { spec_sha256: string; export_sha256: string; render?: unknown }
    expect(withTree.spec_sha256).toBe(without.spec_sha256)
    expect(withTree.export_sha256).toBe(without.export_sha256)
    expect(without.render).toBeUndefined()
    expect(withTree.render).toBeUndefined()
  })

  test('rebuilding against a changed tree returns a frozen fixture to draft; the same tree changes nothing', () => {
    const store = newStore()
    const tree = skillTree()
    frozen(store, withPlaceholders(), tree)
    expect(buildFixture(store, withPlaceholders(), { systematicTree: tree }).status).toBe('frozen')
    const changed = skillTree({ plan: PLAN_SKILL.replace('# Plan', '# Plan, revised') })
    expect(buildFixture(store, withPlaceholders(), { systematicTree: changed }).status).toBe('draft')
    expect(() => loadFrozen(store, 'plan-claim')).toThrow(FixtureRefusal)
  })
})

describe('the committed tuning fixtures', () => {
  const dir = join(import.meta.dir, '../../../../evals/spikes/systematic-reflection')
  const TREE = process.env.METACOGS_SYSTEMATIC_TREE ?? ''
  const files = (): string[] => readdirSync(join(dir, 'fixtures', 'tune')).filter((f) => f.endsWith('.json')).sort()
  const bytesOf = (file: string): string => readFileSync(join(dir, 'fixtures', 'tune', file), 'utf8')
  const prereg = (): {
    fixture_hashes: { tune: Record<string, string> }
    fixtures: Record<string, { expected: 'fire' | 'silence'; methods: ('counterfactual' | 'synthesis')[]; skill: string; rendered_skill_text_sha256: Record<string, string> }>
    systematic: { pin: string }
  } => JSON.parse(readFileSync(join(dir, 'prereg.json'), 'utf8'))
  /** Everything the model is shown, and the notes beside it. The `methods` field names the expected method by design. */
  const visibleText = (text: string): string => JSON.stringify({ ...JSON.parse(text), methods: undefined })
  const KNOWN_PLACEHOLDERS = ['systematic-skill:ce-plan', 'systematic-skill:ce-review', 'systematic-file:ce-plan/references/deepening-workflow.md']
  const SEEDED_TOOLS = ['systematic_skill', 'read', 'grep', 'glob', 'bash', 'task']

  test('the prereg lists exactly the committed fixtures, and each hash is the sha256 of the committed bytes', () => {
    const hashes = prereg().fixture_hashes.tune
    expect(Object.keys(hashes).sort()).toEqual(files().map((f) => f.replace(/\.json$/, '')))
    expect(files()).toHaveLength(7)
    for (const f of files()) expect(sha256(bytesOf(f))).toBe(hashes[f.replace(/\.json$/, '')]!)
  })

  test('each parses as a workflow spec in canonical form, with the expectation and methods the prereg records', () => {
    for (const f of files()) {
      const spec = parseSpec(JSON.parse(bytesOf(f)))
      expect(`${JSON.stringify(spec, null, 2)}\n`).toBe(bytesOf(f))
      expect(f).toBe(`${spec.id}.json`)
      expect(spec.kind).toBe('workflow')
      const row = prereg().fixtures[spec.id]!
      expect(spec.expected).toBe(row.expected)
      expect(spec.methods ?? []).toEqual(row.methods)
    }
  })

  test('a fixture names neither method nor metacogs, and no seeded tool call comes from outside the trimmed stack', () => {
    for (const f of files()) {
      expect(visibleText(bytesOf(f))).not.toMatch(/counterfactual|synthes|metacog/i)
      const spec = parseSpec(JSON.parse(bytesOf(f)))
      const tools = spec.turns.flatMap((t) => (t.role === 'assistant' ? (t.tools ?? []).map((c) => c.tool) : []))
      for (const name of tools) expect(SEEDED_TOOLS).toContain(name)
    }
  })

  test('every placeholder is a known skill text on the right call, and a fixture ends on an assistant message with text', () => {
    for (const f of files()) {
      const spec = parseSpec(JSON.parse(bytesOf(f)))
      const found = skillPlaceholders(spec)
      for (const key of found) expect(KNOWN_PLACEHOLDERS).toContain(key)
      expect(found.length).toBeGreaterThan(0)
      expect(found[0]).toBe(prereg().fixtures[spec.id]!.skill === 'ce:plan' ? 'systematic-skill:ce-plan' : 'systematic-skill:ce-review')
      expect(spec.turns.at(-1)).toMatchObject({ role: 'assistant' })
      expect((spec.turns.at(-1) as { text: string }).text.trim()).not.toBe('')
    }
  })

  test.skipIf(!TREE)('built from the pinned Systematic tree, each fixture freezes clean and its skill texts hash as the prereg records', () => {
    const version = (JSON.parse(readFileSync(join(TREE, 'package.json'), 'utf8')) as { version: string }).version
    expect(`@fro.bot/systematic@${version}`).toBe(prereg().systematic.pin)
    const store = newStore()
    for (const f of files()) {
      const spec = parseSpec(JSON.parse(bytesOf(f)))
      const entry = buildFixture(store, JSON.parse(bytesOf(f)), { systematicTree: TREE }) as { render: { template_sha256: string; skill_text: Record<string, string> } }
      expect(entry.render.template_sha256).toBe(prereg().fixture_hashes.tune[spec.id]!)
      expect(entry.render.skill_text).toEqual(prereg().fixtures[spec.id]!.rendered_skill_text_sha256)
      freezeFixture(store, spec.id)
    }
  })
})

describe('buildExport', () => {
  const exported = buildExport(spec())

  test('has the export shape the host imports: info, then messages of { info, parts }', () => {
    expect(Object.keys(exported).sort()).toEqual(['info', 'messages'])
    expect(exported.info).toMatchObject({ projectID: 'global', directory: '/workspace', agent: 'orchestrator', version: '1.19.5+harness.bf7f7dfe' })
    expect(exported.info.id).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(exported.info.permission).toEqual([
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
    ])
    expect(exported.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('messages and parts are linked, uniquely identified and in ascending id and time order', () => {
    const ids = exported.messages.map((m) => m.info.id)
    expect(ids.every((id) => /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(id))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    const times = exported.messages.map((m) => m.info.time.created)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    const partIds = exported.messages.flatMap((m) => m.parts.map((p) => p.id))
    expect(new Set(partIds).size).toBe(partIds.length)
    for (const m of exported.messages) {
      expect(m.info.sessionID).toBe(exported.info.id)
      for (const p of m.parts) expect([p.sessionID, p.messageID]).toEqual([exported.info.id, m.info.id])
    }
    for (const m of exported.messages.filter((m) => m.info.role === 'assistant')) {
      expect(m.info.parentID).toBe(exported.messages[exported.messages.indexOf(m) - 1]!.info.id)
    }
  })

  test('a tool call becomes a completed tool part with its result, ahead of the reply text', () => {
    const parts = exported.messages[1]!.parts
    expect(parts.map((p) => p.type)).toEqual(['step-start', 'tool', 'step-finish', 'step-start', 'text', 'step-finish'])
    const tool = parts.find((p) => p.type === 'tool')!
    expect(tool).toMatchObject({ tool: 'read', callID: 'call_read1', state: { status: 'completed', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' } })
  })

  test('is deterministic, and the options set the directory, version and model', () => {
    expect(buildExport(spec())).toEqual(exported)
    const custom = buildExport(spec(), { directory: '/scratch/ws', version: '9.9.9', model: { providerID: 'openai', modelID: 'gpt-6-luna' } })
    expect(custom.info.directory).toBe('/scratch/ws')
    expect(custom.info.version).toBe('9.9.9')
    expect(custom.messages[1]!.info).toMatchObject({ providerID: 'openai', modelID: 'gpt-6-luna', path: { cwd: '/scratch/ws', root: '/scratch/ws' } })
    expect(custom.messages.map((m) => m.info.id)).toEqual(exported.messages.map((m) => m.info.id))
  })

  test('refuses an excluded spec', () => {
    expect(() => buildExport(spec({ excluded: { reason: 'no state' } }))).toThrow(SpecError)
  })

  /** What the host serialises into the next request for this history, one line per message (the probe's normalised form). */
  const requestLines = (e: SessionExport): string[] =>
    normalizeHistory(
      e.messages.flatMap((m) => {
        if (m.info.role === 'user') return [{ role: 'user', content: m.parts.map((p) => ({ text: p.text })) }]
        const tools = m.parts.filter((p) => p.type === 'tool')
        const text = m.parts.filter((p) => p.type === 'text').map((p) => ({ text: p.text }))
        return [
          { role: 'assistant', content: text, ...(tools.length ? { tool_calls: tools.map((t) => ({ id: t.callID!, function: { name: t.tool!, arguments: '{}' } })) } : {}) },
          ...tools.map((t) => ({ role: 'tool', tool_call_id: t.callID, content: t.state!.output })),
        ]
      }),
    )
  const expectedParts = (s: FixtureSpec): string[] =>
    s.turns.map((t) =>
      t.role === 'user'
        ? `user:text:${t.text}`
        : `assistant:${[...(t.tools ?? []).map((c) => `tool:${c.tool}:${c.callID}:completed:${c.output}`), ...(t.text ? [`text:${t.text}`] : [])].join('|')}`,
    )
  const fidelity = (source: SessionExport, replay: SessionExport) =>
    checkFidelity({
      source: requestLines(source),
      replay: requestLines(replay),
      sourceParts: partsSignature(source),
      replayParts: partsSignature(replay),
      replaySystem: 'You are OpenCode.',
      replayPartTypes: replay.messages.flatMap((m) => m.parts.map((p) => p.type)),
      sourceTools: ['read'],
      replayTools: ['read'],
    })

  test('round-trips through the probe fidelity comparison, and the signature matches the spec', () => {
    const reparsed = JSON.parse(JSON.stringify(exported)) as SessionExport
    expect(fidelity(exported, reparsed)).toEqual([])
    expect(partsSignature(exported)).toEqual(expectedParts(spec()))
  })

  test('the comparison flags a copy that lost a tool result or a message', () => {
    const lost = structuredClone(exported)
    lost.messages[1]!.parts = lost.messages[1]!.parts.filter((p) => p.type !== 'tool')
    expect(fidelity(exported, lost).length).toBeGreaterThan(0)
    const short = structuredClone(exported)
    short.messages.pop()
    expect(fidelity(exported, short).join(';')).toContain('message count')
  })
})

describe('custody', () => {
  test('a store root inside the repo throws a CustodyError and creates nothing', () => {
    const repoRoot = tmp('replay-repo-')
    const root = join(repoRoot, 'evals', 'replay')
    expect(() => openStore({ root, repoRoot })).toThrow(CustodyError)
    expect(existsSync(root)).toBe(false)
    expect(() => openStore({ root: repoRoot, repoRoot })).toThrow(CustodyError)
  })

  test('a root that is a symlink into the repo throws too', () => {
    const repoRoot = tmp('replay-repo-')
    mkdirSync(join(repoRoot, 'inner'))
    const link = join(tmp(), 'link')
    symlinkSync(join(repoRoot, 'inner'), link)
    expect(() => openStore({ root: join(link, 'replay'), repoRoot })).toThrow(CustodyError)
  })

  test('the default root is the state root plus replay/, and the real repo is refused', () => {
    const state = tmp()
    const store = openStore({ env: { XDG_STATE_HOME: state }, repoRoot: tmp('replay-repo-') })
    expect(store.root).toBe(join(state, 'metacogs', 'replay'))
    const repo = join(import.meta.dir, '..', '..', '..', '..')
    expect(() => openStore({ env: { XDG_STATE_HOME: join(repo, 'evals', 'state') } })).toThrow(CustodyError)
    expect(existsSync(join(repo, 'evals', 'state'))).toBe(false)
  })

  test('directories are 0700 and files 0600', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    saveRaw(store, 'raw-a', { schema_version: 1 })
    const mode = (p: string) => statSync(p).mode & 0o777
    for (const dir of [store.root, join(store.root, 'raw'), join(store.root, 'fixtures'), join(store.root, 'fixtures', 'moment-a')]) expect([dir.slice(store.root.length), mode(dir)]).toEqual([dir.slice(store.root.length), 0o700])
    for (const file of [join(store.root, 'manifest.json'), join(store.root, 'raw', 'raw-a.json'), join(store.root, 'fixtures', 'moment-a', 'spec.json'), join(store.root, 'fixtures', 'moment-a', 'export.json')]) expect([file.slice(store.root.length), mode(file)]).toEqual([file.slice(store.root.length), 0o600])
  })

  test('a pre-existing loose root is tightened to 0700', () => {
    const repoRoot = tmp('replay-repo-')
    const root = join(tmp(), 'replay')
    mkdirSync(root, { mode: 0o755 })
    chmodSync(root, 0o755)
    openStore({ root, repoRoot })
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })
})

describe('raw store', () => {
  test('writes and reads back a raw extract, and refuses to overwrite one', () => {
    const store = newStore()
    saveRaw(store, 'raw-a', { schema_version: 1, rows: [1, 2] })
    expect(loadRaw(store, 'raw-a')).toEqual({ schema_version: 1, rows: [1, 2] })
    expect(() => saveRaw(store, 'raw-a', {})).toThrow(/exists/)
    expect(() => saveRaw(store, '../escape', {})).toThrow(SpecError)
  })
})

describe('freeze', () => {
  test('build writes a draft: spec and export on disk, hashes in the manifest, no review', () => {
    const store = newStore()
    const entry = buildFixture(store, spec())
    expect(entry.status).toBe('draft')
    expect(existsSync(join(store.root, 'fixtures', 'moment-a', 'export.json'))).toBe(true)
    expect(entry).toMatchObject({ review: { approved_by_author: false, at: null } })
    expect(entry).toMatchObject({ spec_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), export_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'draft', approved: false }])
  })

  test('a spec holding a token fails the freeze with the rule name, stays draft, and the report carries no content', () => {
    const store = newStore()
    buildFixture(store, spec({ turns: [{ role: 'user', text: `use ${TOKEN} here` }, { role: 'assistant', text: 'ok' }] }))
    let error: unknown
    try {
      freezeFixture(store, 'moment-a')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(FreezeError)
    expect((error as FreezeError).findings.map((f) => f.rule)).toContain('github-token')
    expect((error as Error).message).toContain('github-token')
    expect((error as Error).message).not.toContain(TOKEN)
    expect(listFixtures(store)[0]!.status).toBe('draft')
    expect(readFileSync(join(store.root, 'manifest.json'), 'utf8')).not.toContain(TOKEN)
  })

  test('a spec holding a home path fails the freeze with the home-path rule', () => {
    const store = newStore()
    buildFixture(store, spec({ turns: [{ role: 'user', text: `see ${HOME_PATH}/file.ts` }, { role: 'assistant', text: 'ok' }] }))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/home-path/)
    expect(listFixtures(store)[0]!.status).toBe('draft')
  })

  test('provenance is scanned too', () => {
    const store = newStore()
    buildFixture(store, spec({ provenance: { project: HOME_PATH, source_session: 's', cutoff_message: 'm', date: '2026-11-01' } }))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/home-path/)
  })

  test('a clean spec freezes with a stamp, stays unloadable until approved, then loads', () => {
    const store = newStore()
    buildFixture(store, spec())
    const frozen = freezeFixture(store, 'moment-a')
    expect(frozen.status).toBe('frozen')
    expect(frozen.stamp).toMatchObject({ mode: 'fixture', clean: true, files: 2 })
    expect(() => loadFrozen(store, 'moment-a')).toThrow(FixtureRefusal)
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_approved')

    const approved = approveFixture(store, 'moment-a')
    expect(approved.review).toEqual({ approved_by_author: true, at: '2026-11-07T12:00:00.000Z' })
    const loaded = loadFrozen(store, 'moment-a')
    expect(loaded.spec).toEqual(spec())
    expect(loaded.export).toEqual(buildExport(spec()))
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'frozen', approved: true }])
  })

  test('approval needs a frozen fixture', () => {
    const store = newStore()
    buildFixture(store, spec())
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('not_frozen')
    expect(refusal(() => approveFixture(store, 'nope'))).toBe('unknown')
  })

  test('editing one byte of a frozen spec makes loadFrozen refuse it', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const file = join(store.root, 'fixtures', 'moment-a', 'spec.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Still failing.', 'Still failing!'))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
    expect(listFixtures(store)[0]).toMatchObject({ status: 'stale', approved: true })
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('edited')
  })

  test('editing the built export is refused the same way', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const file = join(store.root, 'fixtures', 'moment-a', 'export.json')
    writeFileSync(file, `${readFileSync(file, 'utf8')} `)
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('a file added to a frozen fixture directory is refused', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    writeFileSync(join(store.root, 'fixtures', 'moment-a', 'extra.txt'), 'x')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('building a changed spec returns the fixture to draft and clears the review; the same spec changes nothing', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    expect(buildFixture(store, spec()).status).toBe('frozen')
    expect(loadFrozen(store, 'moment-a').spec.id).toBe('moment-a')

    const changed = buildFixture(store, spec({ somewhere: 'somewhere else' }))
    expect(changed.status).toBe('draft')
    expect(changed.review).toEqual({ approved_by_author: false, at: null })
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_frozen')
    freezeFixture(store, 'moment-a')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('not_approved')
  })

  test('freezing refuses an export that no longer matches its spec', () => {
    const store = newStore()
    buildFixture(store, spec())
    const file = join(store.root, 'fixtures', 'moment-a', 'spec.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Still failing.', 'Still failing!'))
    expect(() => freezeFixture(store, 'moment-a')).toThrow(/stale|rebuild/i)
    expect(listFixtures(store)[0]!.status).toBe('draft')
  })

  test('an excluded spec is recorded with its reason, cannot freeze or be approved, and is never loadable', () => {
    const store = newStore()
    const entry = buildFixture(store, spec({ excluded: { reason: 'next move was made in a child session' } }))
    expect(entry).toMatchObject({ status: 'excluded', reason: 'next move was made in a child session' })
    expect(existsSync(join(store.root, 'fixtures', 'moment-a', 'export.json'))).toBe(false)
    expect(refusal(() => freezeFixture(store, 'moment-a'))).toBe('excluded')
    expect(refusal(() => approveFixture(store, 'moment-a'))).toBe('excluded')
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('excluded')
    expect(listFixtures(store)).toEqual([{ id: 'moment-a', kind: 'feel', status: 'excluded', approved: false }])
  })

  test('excluding a previously frozen fixture makes it unloadable', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    buildFixture(store, spec({ excluded: { reason: 'compacted key tool output' } }))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('excluded')
  })

  test('an unknown id is refused', () => {
    const store = newStore()
    expect(refusal(() => loadFrozen(store, 'nope'))).toBe('unknown')
    expect(refusal(() => freezeFixture(store, 'nope'))).toBe('unknown')
  })

  test('a manifest forged to say frozen and approved still fails on the stamp', () => {
    const store = newStore()
    buildFixture(store, spec())
    const path = join(store.root, 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.fixtures['moment-a'] = { ...manifest.fixtures['moment-a'], status: 'frozen', stamp: { mode: 'fixture', hash: '0'.repeat(64), files: 2, clean: true }, review: { approved_by_author: true, at: 'now' } }
    writeFileSync(path, JSON.stringify(manifest))
    expect(refusal(() => loadFrozen(store, 'moment-a'))).toBe('edited')
  })

  test('the manifest holds the hash, scan stamp, review and status, and nothing from the spec text', () => {
    const store = newStore()
    buildFixture(store, spec())
    freezeFixture(store, 'moment-a')
    approveFixture(store, 'moment-a')
    const text = readFileSync(join(store.root, 'manifest.json'), 'utf8')
    const entry = JSON.parse(text).fixtures['moment-a']
    expect(Object.keys(entry).sort()).toEqual(['export_sha256', 'review', 'spec_sha256', 'stamp', 'status', 'updated_at'])
    expect(text).not.toContain('Still failing')
    expect(text).not.toContain('pinning the dependency')
  })
})

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof FixtureRefusal) return e.reason
    throw e
  }
  throw new Error('expected a FixtureRefusal')
}
