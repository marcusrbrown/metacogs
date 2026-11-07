import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import { mainAsync } from './cli'
import { approvedFixture, fakeExecutor, MODEL, SYNTHETIC_SPEC } from './test-support'
import { buildFixture, freezeFixture, openStore } from './store'

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
