import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import { CampaignUsageError, stackForKinds } from './campaign'
import { mainAsync } from './cli'
import { approvedFixture, fakeExecutor, fakeWorkflowExecutor, MODEL, SEED_USER, SILENCE_SPEC, skillLoadEvent, SYNTHETIC_REPO, SYNTHETIC_SPEC, WORKFLOW_SPEC } from './test-support'
import { approveFixture, buildFixture, freezeFixture, openStore } from './store'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Joined at run time so the repo scanner does not read the test double as a key.
const KEY = ['sk', 'test', 'SECRET', '0123456789abcdef'].join('-')
const resolved: ResolvedCliproxy = { keyName: 'test-key', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }] }

function harness(deps: Parameters<typeof mainAsync>[1] extends infer T ? (T extends { campaign?: infer C } ? C : never) : never = {}) {
  const root = mkdtempSync(join(tmpdir(), 'replay-campaign-'))
  dirs.push(root)
  const state = join(root, 'state')
  const repoRoot = join(root, 'repo')
  mkdirSync(repoRoot)
  const env = { XDG_STATE_HOME: state }
  const store = openStore({ env, repoRoot })
  const out: string[] = []
  const err: string[] = []
  const run = (...argv: string[]) => mainAsync(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, repoRoot, campaign: deps })
  return { run, out, err, store }
}

const base = ['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'moment-a', '--cap', '10']

describe('the stack a campaign runs on', () => {
  test('workflow fixtures run on the trimmed Systematic stack, the other kinds on the daily stack', () => {
    expect(stackForKinds(['workflow', 'workflow']).name).toBe('workflow')
    expect(stackForKinds(['feel', 'drugs', 'ordinary']).name).toBe('daily')
    expect(stackForKinds([]).name).toBe('daily')
  })

  test('a mix is refused', () => {
    expect(() => stackForKinds(['workflow', 'feel'])).toThrow(CampaignUsageError)
    expect(() => stackForKinds(['ordinary', 'workflow'])).toThrow('separate campaigns')
  })
})

/** A stand-in for an extracted Systematic package: the entry file and the one skill the fixture names. */
const systematicTree = (marker = ''): string => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-tree-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'ce-plan'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fro.bot/systematic', version: '3.33.2' }))
  writeFileSync(join(dir, 'skills', 'ce-plan', 'SKILL.md'), `---\nname: ce:plan\ndescription: plan things\n---\n\n# Plan\n${marker}\n`)
  return dir
}

const PLACEHOLDER_SPEC = {
  ...WORKFLOW_SPEC,
  turns: [
    { role: 'user' as const, text: SEED_USER[0]! },
    { role: 'assistant' as const, text: 'Loaded the workflow.', tools: [{ callID: 'call_s', tool: 'systematic_skill', input: { name: 'ce:plan' }, output: '{{systematic-skill:ce-plan}}' }] },
    { role: 'user' as const, text: SEED_USER[1]! },
    { role: 'assistant' as const, text: 'Trying a clean install.' },
  ],
}

describe('a campaign on a local Systematic tree', () => {
  test('the stack loads the tree\'s own entry, and only a workflow campaign may name one', () => {
    const tree = systematicTree()
    const stack = stackForKinds(['workflow'], tree)
    expect(stack.npmPlugins).toEqual([`file://${tree}/dist/index.js`])
    expect(stack.systematicTree?.dir).toBe(tree)
    expect(() => stackForKinds(['feel'], tree)).toThrow(CampaignUsageError)
    expect(stackForKinds(['workflow']).systematicTree).toBeUndefined()
  })

  const withTreeArgs = (id: string, tree: string) => ['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', id, '--cap', '10', '--attempts-per-cell', '1', '--systematic-tree', tree]

  test('a fixture rendered from that tree runs; one rendered from another tree, or from none, is refused (exit 2) and nothing runs', async () => {
    const tree = systematicTree()
    const { executor, jobs } = fakeWorkflowExecutor()
    const h = harness({ executor })
    const build = (id: string, from?: string): void => {
      buildFixture(h.store, { ...PLACEHOLDER_SPEC, id }, { ...(from ? { systematicTree: from } : {}), repo: SYNTHETIC_REPO })
      freezeFixture(h.store, id)
      approveFixture(h.store, id)
    }
    build('from-this-tree', tree)
    build('from-another-tree', systematicTree('a different line'))
    buildFixture(h.store, { ...WORKFLOW_SPEC, id: 'no-render' }, { repo: SYNTHETIC_REPO })
    freezeFixture(h.store, 'no-render')
    approveFixture(h.store, 'no-render')

    expect(await h.run(...withTreeArgs('from-another-tree', tree))).toBe(2)
    expect(h.err.join('\n')).toContain('from-another-tree')
    expect(h.err.join('\n')).toContain('different Systematic tree')
    h.err.length = 0
    expect(await h.run(...withTreeArgs('no-render', tree))).toBe(2)
    expect(h.err.join('\n')).toContain('no-render')
    expect(jobs).toHaveLength(0)

    expect(await h.run(...withTreeArgs('from-this-tree', tree))).toBe(0)
    expect(jobs).toHaveLength(1)
  })

  test('a campaign without --systematic-tree takes fixtures as before, whatever tree they were rendered from', async () => {
    const { executor, jobs } = fakeWorkflowExecutor()
    const h = harness({ executor })
    buildFixture(h.store, { ...PLACEHOLDER_SPEC, id: 'rendered' }, { systematicTree: systematicTree(), repo: SYNTHETIC_REPO })
    freezeFixture(h.store, 'rendered')
    approveFixture(h.store, 'rendered')
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', 'rendered', '--cap', '10', '--attempts-per-cell', '1')).toBe(0)
    expect(jobs).toHaveLength(1)
  })
})

describe('bun run replay campaign', () => {
  test('runs a scripted campaign, prints counts and ids only, then status lists every cell', async () => {
    const { executor, jobs } = fakeExecutor()
    const h = harness({ executor, skillsDir: '/pkg/plugin/skills' })
    approvedFixture(h.store)
    expect(await h.run(...base)).toBe(0)
    expect(jobs).toHaveLength(9)
    const text = h.out.join('\n')
    expect(text).toContain('campaign camp cells=9 attempts=9 spent=$0.0000 cap=$10.0000')
    expect(text).toContain('counted: completed=9')
    expect(text).not.toContain(SYNTHETIC_SPEC.turns[0]!.text)
    expect(text).not.toContain(SYNTHETIC_SPEC.somewhere)

    h.out.length = 0
    expect(await h.run('status', 'camp')).toBe(0)
    expect(h.out).toHaveLength(11)
    expect(h.out[0]).toBe(`moment-a\t${MODEL}\tcontinue-a\tattempts=1\tcounted=a001:completed\tall=a001:completed`)
    expect(h.out.at(-1)).toBe('counted: completed=9')
    expect(h.out.at(-2)).toBe('campaign camp cells=9 attempts=9 spent=$0.0000')
    expect(h.out.join('\n')).not.toContain(SYNTHETIC_SPEC.somewhere)
  })

  test('--arms takes a list, --again appends attempts, and --fixtures all takes only frozen, approved fixtures', async () => {
    const { executor, jobs } = fakeExecutor()
    const h = harness({ executor })
    approvedFixture(h.store)
    buildFixture(h.store, { ...SYNTHETIC_SPEC, id: 'draft-moment' })
    buildFixture(h.store, { ...SYNTHETIC_SPEC, id: 'frozen-moment' })
    freezeFixture(h.store, 'frozen-moment')
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a,drugs-caffeine', '--fixtures', 'all', '--cap', '1')).toBe(0)
    expect(jobs.map((j) => `${j.fixtureId}/${j.arm}`)).toEqual(['moment-a/continue-a', 'moment-a/drugs-caffeine'])
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', 'moment-a', '--cap', '1', '--again')).toBe(0)
    expect(jobs).toHaveLength(3)
  })

  test('an unapproved fixture is refused (exit 1) and no key is fetched for it', async () => {
    let fetched = 0
    const h = harness({ executor: fakeExecutor().executor, resolveCliproxy: () => (fetched++, resolved) })
    buildFixture(h.store, SYNTHETIC_SPEC)
    freezeFixture(h.store, 'moment-a')
    expect(await h.run(...base, '--provider', 'cliproxy', '--attempt-estimate', '1', '--auth-cliproxy', 'test-key')).toBe(1)
    expect(h.err.join('\n')).toContain('FixtureRefusal')
    expect(fetched).toBe(0)
  })

  test('a cliproxy campaign takes the key name from the flag or METACOGS_AUTH_CLIPROXY, never prints the key, and exits 3 at the cap', async () => {
    const seen: (string | undefined)[] = []
    const { executor, jobs } = fakeExecutor({ cost: 1 })
    const h = harness({ executor, resolveCliproxy: (flag) => (seen.push(flag), resolved) })
    approvedFixture(h.store)
    const code = await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'moment-a', '--cap', '4', '--provider', 'cliproxy', '--attempt-estimate', '1', '--auth-cliproxy', 'test-key')
    expect(code).toBe(3)
    expect(seen).toEqual(['test-key'])
    expect(jobs).toHaveLength(2)
    const text = [...h.out, ...h.err].join('\n')
    expect(text).not.toContain(KEY)
    expect(text).toContain('not run\tmoment-a\tanthropic/claude-opus-5-5\tdrugs\tbudget')
    expect(text).toContain('stopped before the next provider attempt')
    expect(text).toContain('spent=$3.5000 cap=$4.0000')
  })

  test.each([
    [['campaign'], '--name'],
    [['campaign', '--name', 'camp', '--models', 'openai/other', '--arms', 'all', '--fixtures', 'x', '--cap', '1'], '--models takes'],
    [['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'nope', '--fixtures', 'x', '--cap', '1'], '--arms takes'],
    [['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'x', '--cap', '0'], '--cap takes'],
    [['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'x', '--cap', '1', '--provider', 'live'], '--provider takes'],
    [['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'x', '--cap', '1', '--provider', 'cliproxy'], '--attempt-estimate'],
    [['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'all', '--fixtures', 'x', '--cap', '1', '--bogus'], 'bogus'],
  ])('usage error (exit 2): %j', async (argv, needle) => {
    const h = harness({ executor: fakeExecutor().executor })
    expect(await h.run(...argv)).toBe(2)
    expect(h.err.join('\n')).toContain(needle)
  })

  test('--attempts-per-cell runs three scored attempts per cell and prints each workflow cell tally, in the run and in status', async () => {
    const { executor, jobs } = fakeWorkflowExecutor({ events: (_job, n) => (n === 2 ? '' : skillLoadEvent('counterfactual')) })
    const h = harness({ executor })
    approvedFixture(h.store, WORKFLOW_SPEC)
    const argv = ['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', WORKFLOW_SPEC.id, '--cap', '10', '--attempts-per-cell', '3']
    expect(await h.run(...argv)).toBe(0)
    expect(jobs).toHaveLength(3)
    expect(h.out).toContain('campaign camp cells=1 attempts=3 spent=$0.0000 cap=$10.0000')
    expect(h.out).toContain('counted: completed=1')
    const tally = `tally\t${WORKFLOW_SPEC.id}\t${MODEL}\tcontinue-a\tcounted=3\thits=2\tmisses=1\tsilent=0\tfalse_fires=0\twrong_method=0\texcluded=0`
    expect(h.out).toContain(tally)

    h.out.length = 0
    expect(await h.run('status', 'camp')).toBe(0)
    expect(h.out).toContain(tally)
    expect(h.out[0]).toBe(`${WORKFLOW_SPEC.id}\t${MODEL}\tcontinue-a\tattempts=3\tcounted=a001:completed\tall=a001:completed,a002:completed,a003:completed`)

    h.out.length = 0
    expect(await h.run(...argv)).toBe(0)
    expect(jobs).toHaveLength(3)
    expect(h.out).toContain('campaign camp cells=1 attempts=0 spent=$0.0000 cap=$10.0000')
  })

  test('--replacements bounds the replacements of excluded attempts, and a cell it cannot fill exits 3', async () => {
    const { executor, jobs } = fakeWorkflowExecutor({ over: () => ({ partTypes: ['compaction'] }) })
    const h = harness({ executor })
    approvedFixture(h.store, SILENCE_SPEC)
    const argv = ['campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', SILENCE_SPEC.id, '--cap', '10', '--attempts-per-cell', '2']
    expect(await h.run(...argv, '--replacements', '0')).toBe(3)
    expect(jobs).toHaveLength(1)
    expect(h.out.join('\n')).toContain(`not run\t${SILENCE_SPEC.id}\t${MODEL}\tcontinue-a\tattempts_exhausted`)
    expect(h.out).toContain(`tally\t${SILENCE_SPEC.id}\t${MODEL}\tcontinue-a\tcounted=0\thits=0\tmisses=0\tsilent=0\tfalse_fires=0\twrong_method=0\texcluded=1`)
  })

  test.each([
    [['--attempts-per-cell', '0'], '--attempts-per-cell takes'],
    [['--attempts-per-cell', '1.5'], '--attempts-per-cell takes'],
    [['--attempts-per-cell', 'many'], '--attempts-per-cell takes'],
    [['--attempts-per-cell', '3', '--replacements=-1'], '--replacements takes'],
    [['--attempts-per-cell', '3', '--replacements', '0.5'], '--replacements takes'],
    [['--replacements', '1'], '--replacements needs --attempts-per-cell'],
    [['--attempts-per-cell', '3', '--again'], '--again'],
  ])('usage error (exit 2): %j', async (extra, needle) => {
    const h = harness({ executor: fakeWorkflowExecutor().executor })
    approvedFixture(h.store, WORKFLOW_SPEC)
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', WORKFLOW_SPEC.id, '--cap', '1', ...extra)).toBe(2)
    expect(h.err.join('\n')).toContain(needle)
  })

  test('a campaign that mixes workflow fixtures with daily-stack fixtures is a usage error: they run on different stacks', async () => {
    const { executor, jobs } = fakeWorkflowExecutor()
    const h = harness({ executor })
    approvedFixture(h.store, WORKFLOW_SPEC)
    approvedFixture(h.store)
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', `${WORKFLOW_SPEC.id},moment-a`, '--cap', '1')).toBe(2)
    expect(h.err.join('\n')).toContain('workflow')
    expect(jobs).toHaveLength(0)
  })

  test('a campaign without the new flags is unchanged: one attempt per cell, no tally line', async () => {
    const { executor, jobs } = fakeExecutor()
    const h = harness({ executor })
    approvedFixture(h.store)
    expect(await h.run('campaign', '--name', 'camp', '--models', MODEL, '--arms', 'continue-a', '--fixtures', 'moment-a', '--cap', '1')).toBe(0)
    expect(jobs).toHaveLength(1)
    expect(h.out.some((l) => l.startsWith('tally\t'))).toBe(false)
  })

  test('a cliproxy campaign without a key name is a usage error', async () => {
    const h = harness({ executor: fakeExecutor().executor, resolveCliproxy: () => undefined })
    approvedFixture(h.store)
    expect(await h.run(...base, '--provider', 'cliproxy', '--attempt-estimate', '1')).toBe(2)
    expect(h.err.join('\n')).toContain('--auth-cliproxy')
  })

  test('status of an unknown campaign fails; status with no name is a usage error; the old subcommands still run', async () => {
    const h = harness()
    expect(await h.run('status', 'nothing')).toBe(1)
    expect(await h.run('status')).toBe(2)
    expect(await h.run('list')).toBe(0)
  })
})
