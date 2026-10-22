import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXIT, main } from './cli'
import { opencodeAvailability } from './opencode'
import { buildHappyChain, scaffoldMethod, TestRepo, writePrereg } from './test-support'

const cleanup: (() => void)[] = []
afterAll(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

function io() {
  const lines = { out: [] as string[], err: [] as string[] }
  return {
    lines,
    io: {
      out: (l: string) => lines.out.push(l),
      err: (l: string) => lines.err.push(l),
      installSignalHandlers: () => () => {},
      env: {} as Record<string, string>,
    },
  }
}

function chainRepo() {
  const repo = new TestRepo('metacogs-clitest-')
  cleanup.push(() => repo.destroy())
  const heldout = tmp('metacogs-clitest-held-')
  const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  return { repo, heldout, scaffold }
}

describe('usage', () => {
  test('missing mode, unknown mode, missing method, bad flags → usage exit', async () => {
    for (const argv of [[], ['blue', '--method', 'demo'], ['red'], ['red', '--method', 'demo', '--runs', '0'], ['red', '--method', 'demo', '--provider', 'bogus'], ['red', '--nope']]) {
      const t = io()
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
      expect(t.lines.err.join('\n')).toContain('usage')
    }
  })
})

describe('refusals happen before anything launches', () => {
  test('no prereg for the method → refused', async () => {
    const { repo } = chainRepo()
    repo.write('README.md', 'x')
    repo.commit('init', ['README.md'])
    const t = io()
    expect(await main(['red', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('REFUSED')
  })

  test('prereg and SKILL.md in one commit → refused, naming the SHAs', async () => {
    const { repo, scaffold } = chainRepo()
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.write('skills/demo/SKILL.md', 'skill\n')
    const both = repo.commit('prereg+skill', [scaffold.preregPath, 'skills/demo'])
    repo.tag('prereg/demo/1')
    const t = io()
    expect(await main(['red', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain(both.slice(0, 12))
    expect(t.lines.out).toEqual([]) // no campaign started
  })

  test('held-out hash mismatch → refused pre-launch', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    rmSync(join(heldout, 'h1.md'))
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('heldout/h1 missing')
  })

  test('held-out output dir inside the repo → refused (nothing written there)', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    const inside = join(repo.dir, 'evals', 'runs')
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, '--out', inside], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('inside the repository')
    expect(existsSync(inside)).toBe(false)
  })
})

describe.skipIf(!opencodeAvailability().available)('scripted end-to-end', () => {
  test(
    'red --provider scripted --runs 1 produces manifests and a summary',
    async () => {
      const { repo, scaffold } = chainRepo()
      buildHappyChain(repo, scaffold)
      const out = tmp('metacogs-cliout-')
      const t = io()
      const code = await main(['red', '--provider', 'scripted', '--runs', '1', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)
      expect(code).toBe(EXIT.OK)
      const [campaign] = readdirSync(out)
      const runs = readdirSync(join(out, campaign!)).filter((d) => d !== 'summary.json').sort()
      expect(runs).toEqual(['001-dev-d1-baseline-r1', '002-negative-n1-baseline-r1'])
      for (const run of runs) expect(existsSync(join(out, campaign!, run, 'manifest.json'))).toBe(true)
      expect(t.lines.out.join('\n')).toContain('dev/d1/baseline: pass 1/1')
      expect(t.lines.err.join('\n')).toContain('deviate from the prereg plan')
    },
    180_000,
  )

  test('stale `running` manifests from an earlier run are reported at startup', async () => {
    const { repo, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    const out = tmp('metacogs-cliout-')
    const t = io()
    // A previous runner died: leave a `running` manifest where the runner looks.
    const { writeManifest } = await import('./manifest')
    const dir = join(repo.dir, 'evals', 'runs', 'old-campaign', '001')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeManifest(dir, { schema_version: 1, run_id: '001', status: 'running', started_at: 'x' } as never)
    await main(['red', '--runs', '1', '--fixture', 'n1', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)
    expect(t.lines.err.join('\n')).toContain('stale "running" manifest')
  }, 180_000)
})
