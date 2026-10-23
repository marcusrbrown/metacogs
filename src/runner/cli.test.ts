import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultInstallSignalHandlers, EXIT, main } from './cli'
import { createFixture, destroyFixture } from './env'
import { opencodeAvailability, spawnCapture } from './opencode'
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
  // Every invocation gets its own state root, so a held-out read marker never lands in the developer's real one.
  const stateHome = tmp('metacogs-clitest-state-')
  return {
    lines,
    stateHome,
    io: {
      out: (l: string) => lines.out.push(l),
      err: (l: string) => lines.err.push(l),
      installSignalHandlers: () => () => {},
      env: { XDG_STATE_HOME: stateHome } as Record<string, string>,
    },
  }
}

const LIVE = ['--provider', 'live', '--auth-passthrough', 'none']

function chainRepo() {
  const repo = new TestRepo('metacogs-clitest-')
  cleanup.push(() => repo.destroy())
  const heldout = tmp('metacogs-clitest-held-')
  const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  return { repo, heldout, scaffold }
}

describe('usage', () => {
  test('missing mode, unknown mode, missing method, bad flags → usage exit', async () => {
    for (const argv of [
      [],
      ['blue', '--method', 'demo'],
      ['red'],
      ['red', '--method', 'demo', '--runs', '0'],
      ['red', '--method', 'demo', '--provider', 'bogus'],
      ['red', '--nope'],
      ['red', '--method', 'demo', '--dev-only'],
      ['red', '--method', 'demo', '--rehearsal'],
      ['green', '--method', 'demo', '--rehearsal', '--dev-only'],
      ['green', '--method', 'demo', '--rehearsal', '--provider', 'live'],
      ['green', '--method', 'demo', '--include-dev', ...LIVE],
    ]) {
      const t = io()
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
      expect(t.lines.err.join('\n')).toContain('usage')
    }
  })
})

describe('review and rejudge', () => {
  test('both need --campaign; an unknown campaign is an error that names it', async () => {
    for (const mode of ['review', 'rejudge']) {
      const noArg = io()
      expect(await main([mode], noArg.io)).toBe(EXIT.USAGE)
      const { repo } = chainRepo()
      repo.write('README.md', 'x')
      repo.commit('init', ['README.md'])
      const missing = io()
      expect(await main([mode, '--campaign', 'no-such-campaign', '--repo', repo.dir], missing.io)).toBe(EXIT.ERROR)
      expect(missing.lines.err.join('\n')).toContain('no-such-campaign')
    }
  })

  test('review writes review.md into a campaign addressed by id', async () => {
    const { repo } = chainRepo()
    repo.write('README.md', 'x')
    repo.commit('init', ['README.md'])
    repo.write('evals/demo/rubric.md', '## What is being measured\n\nx\n\n## Criteria\n\n### CF1: t\n\n- `id`: CF1\n- `check`: judge\n- **Pass anchor**: p\n- **Fail anchor**: f\n\n## Judge instructions\n\n1. s\n')
    const { writeManifest } = await import('./manifest')
    const runDir = join(repo.dir, 'evals', 'runs', 'demo-red-1', '001-dev-d1-baseline-r1')
    require('node:fs').mkdirSync(runDir, { recursive: true })
    writeManifest(runDir, { schema_version: 1, run_id: '001-dev-d1-baseline-r1', campaign_id: 'demo-red-1', status: 'completed', outcome: 'fail', reasons: [], method: 'demo', condition: 'baseline', fixture: { id: 'd1', kind: 'dev', hash: 'h' } } as never)
    require('node:fs').writeFileSync(join(runDir, 'judge.json'), JSON.stringify({ redacted_input_sha256: null, model_pinned: 'm', model_returned: ['m'], criteria: [{ id: 'CF1', verdict: 'fail', quotes: ['q'] }], attempts: 1 }))
    const t = io()
    expect(await main(['review', '--campaign', 'demo-red-1', '--repo', repo.dir], t.io)).toBe(EXIT.OK)
    const dir = join(repo.dir, 'evals', 'runs', 'demo-red-1')
    const sheet = require('node:fs').readFileSync(join(dir, 'review.md'), 'utf8') as string
    const key = require('node:fs').readFileSync(join(dir, 'review-key.md'), 'utf8') as string
    expect(sheet).toContain('## 001-dev-d1-baseline-r1')
    expect(sheet).toContain('| CF1 | p | f | human: pass/fail |')
    expect(sheet).not.toContain('"q"')
    expect(key).toContain('| CF1 | fail | "q" |')
    expect(t.lines.out.join('\n')).toContain('review-key.md')
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
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('heldout/h1 missing')
  })

  test('green without --provider live, or with --provider scripted, is refused before any held-out content is loaded or marked', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    for (const extra of [[], ['--provider', 'scripted']]) {
      const t = io()
      t.io.env.METACOGS_HELDOUT_DIR = heldout
      expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...extra], t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).toContain('REFUSED: green requires --provider live')
      expect(t.lines.out).toEqual([])
      expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
    }
  })

  test('the first GREEN attempt claims a read marker even when it is refused afterwards; the next attempt names the marker and is refused', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    rmSync(join(heldout, 'h1.md')) // the first attempt loads the set, finds a hash mismatch, and stops
    const first = io()
    first.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], first.io)).toBe(EXIT.REFUSED)
    expect(first.lines.err.join('\n')).toContain('heldout/h1 missing')
    const markerPath = join(first.stateHome, 'metacogs', 'heldout', 'demo', '1.read.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { campaign_id: string; started_at: string; prereg_tag: string }
    expect(marker.prereg_tag).toBe('prereg/demo/1')
    expect(marker.campaign_id).toMatch(/^demo-green-/)
    expect(Number.isNaN(Date.parse(marker.started_at))).toBe(false)

    // same state root, restored set: the marker, not green.json, stops the second read
    writeFileSync(join(heldout, 'h1.md'), 'Held-out fixture: pick a queue.\n')
    const second = io()
    second.io.env.METACOGS_HELDOUT_DIR = heldout
    second.io.env.XDG_STATE_HOME = first.stateHome
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], second.io)).toBe(EXIT.REFUSED)
    const message = second.lines.err.join('\n')
    expect(message).toContain('already read')
    expect(message).toContain(marker.campaign_id)
    expect(message).toContain('prereg/demo/1')
    expect(second.lines.out).toEqual([])
  })

  test('a git-ordering refusal happens before the marker is claimed', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.write('skills/demo/SKILL.md', 'skill\n')
    repo.commit('prereg+skill', [scaffold.preregPath, 'skills/demo'])
    repo.tag('prereg/demo/1')
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
  })

  test('a GREEN report already exists → the one-shot read is refused before anything launches', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    repo.write('evals/reports/demo/green.json', '{}\n')
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('held-out set was read once')
    expect(t.lines.out).toEqual([])
  })

  test('a live GREEN read refuses --runs and --fixture: the one read follows the prereg plan', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, '--provider', 'live', '--auth-passthrough', 'none', '--runs', '1'], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('must follow the prereg plan')
  })

  test('--auth-cliproxy is live-only and excludes --auth-passthrough; both are usage errors raised before the infra CLI is called', async () => {
    for (const argv of [
      ['red', '--method', 'demo', '--auth-cliproxy', 'fro-bot-marcusrbrown-metacogs'],
      ['red', '--method', 'demo', '--provider', 'live', '--auth-cliproxy', 'fro-bot-marcusrbrown-metacogs', '--auth-passthrough', 'opencode-go'],
      ['red', '--method', 'demo', '--provider', 'live', '--auth-cliproxy', '../etc'],
    ]) {
      const t = io()
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
      expect(t.lines.err.join('\n')).toMatch(/--provider live|mutually exclusive|key name/)
    }
  })

  test('a prereg that pins openai/* or anthropic/* is refused without --auth-cliproxy, before anything launches', async () => {
    const repo = new TestRepo('metacogs-clitest-')
    cleanup.push(() => repo.destroy())
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: tmp('metacogs-clitest-held-'), overrides: { agent_model_id: 'openai/gpt-6-luna', judge_model_id: 'anthropic/claude-haiku-5-5' } })
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.commit('prereg', [scaffold.preregPath])
    repo.tag('prereg/demo/1')
    const t = io()
    expect(await main(['red', '--method', 'demo', '--repo', repo.dir, '--provider', 'live', '--auth-passthrough', 'none'], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('--auth-cliproxy')
    expect(t.lines.out).toEqual([])
  })

  test('held-out output dir inside the repo → refused (nothing written there)', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    const inside = join(repo.dir, 'evals', 'runs')
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, '--out', inside, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('inside the repository')
    expect(existsSync(inside)).toBe(false)
  })
})

describe('report', () => {
  function reportRepo() {
    const { repo, scaffold } = chainRepo()
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    const prereg = repo.commit('prereg', [scaffold.preregPath])
    repo.tag('prereg/demo/1')
    return { repo, prereg }
  }

  const manifest = (id: string, fixture: string, kind: string, commit: string) => ({
    schema_version: 1,
    run_id: id,
    campaign_id: 'demo-red-2026-10-22T16-00-00-000Z',
    status: 'completed',
    outcome: 'fail',
    reasons: ['judge_fail'],
    method: 'demo',
    condition: 'baseline',
    fixture: { id: fixture, kind, hash: 'f'.repeat(64) },
    prereg: { tag: 'prereg/demo/1', commit_sha: commit, epoch: 1 },
    opencode: { package: 'opencode-ai', version: '1.19.4' },
    model: { pinned: 'opencode/big-pickle', returned: ['big-pickle'] },
    usage: { input: 1, output: 1, reasoning: 0 },
    wall_clock_ms: 5,
    artifacts: { 'stdout.jsonl': { file: 'stdout.jsonl', sha256: 'a'.repeat(64), bytes: 1 } },
    started_at: '2026-10-22T16:00:00.000Z',
    finished_at: '2026-10-22T16:00:01.000Z',
  })

  async function plant(repo: TestRepo, commit: string) {
    const { writeManifest } = await import('./manifest')
    const campaign = join(repo.dir, 'evals', 'runs', 'demo-red-2026-10-22T16-00-00-000Z')
    for (const [i, [fixture, kind]] of [['d1', 'dev'], ['n1', 'negative']].entries()) {
      const id = `00${i + 1}-${kind}-${fixture}-baseline-r1`
      const dir = join(campaign, id)
      require('node:fs').mkdirSync(dir, { recursive: true })
      writeManifest(dir, manifest(id, fixture!, kind!, commit) as never)
    }
  }

  test('writes an allowlist-valid red.json for the newest RED campaign', async () => {
    const { repo, prereg } = reportRepo()
    await plant(repo, prereg)
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.OK)
    const { reportPath, validateReport } = await import('./report')
    const written = JSON.parse(require('node:fs').readFileSync(reportPath(repo.dir, 'demo'), 'utf8'))
    expect(validateReport(written)).toEqual([])
    expect(written.prereg.commit_sha).toBe(prereg)
    expect(written.fixtures.map((f: { fail_over_total: string }) => f.fail_over_total)).toEqual(['1/1', '1/1'])
    expect(t.lines.out.join('\n')).toContain('dev/d1: fail 1/1')
  })

  test('refuses manifests produced under a different prereg commit', async () => {
    const { repo } = reportRepo()
    await plant(repo, 'e'.repeat(40))
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('not produced under')
  })

  describe('report --green: the dev regression is recomputed, never read from green-dev.json', () => {
    async function greenRepo() {
      const { repo, heldout, scaffold } = chainRepo()
      const { preregCommit } = buildHappyChain(repo, scaffold)
      const { writeManifest } = await import('./manifest')
      const campaign = join(tmp('metacogs-clitest-green-'), 'demo-green-2026-10-22T16-00-00-000Z')
      const dir = join(campaign, '001-heldout-h1-skill-r1')
      mkdirSync(dir, { recursive: true })
      writeManifest(dir, { ...manifest('001-heldout-h1-skill-r1', 'h1', 'heldout', preregCommit), condition: 'skill' } as never)
      return { repo, heldout, campaign, preregCommit }
    }
    const run = async (r: Awaited<ReturnType<typeof greenRepo>>) => {
      const t = io()
      t.io.env.METACOGS_HELDOUT_DIR = r.heldout
      const code = await main(['report', '--green', '--method', 'demo', '--repo', r.repo.dir, '--campaign', r.campaign], t.io)
      return { code, err: t.lines.err.join('\n') }
    }

    test('a green-dev.json that is not a valid dev report is refused', async () => {
      const r = await greenRepo()
      r.repo.write('evals/reports/demo/green-dev.json', '{"dev":{"passes_dev_bar":true},"skill":{"sha256":"x"}}\n')
      const { code, err } = await run(r)
      expect(code).toBe(EXIT.REFUSED)
      expect(err).toContain('is not a valid dev report')
    })

    test('a valid-looking green-dev.json whose campaign manifests are not here is refused, not trusted', async () => {
      const r = await greenRepo()
      const { buildDevReport } = await import('./report')
      const m = (id: string, kind: string) => ({ ...manifest(`001-${kind}-${id}-skill-r1`, id, kind, r.preregCommit), condition: 'skill', campaign_id: 'demo-dev-2026-10-22T15-00-00-000Z', verdict_basis: kind === 'dev' ? 'judge' : 'deterministic', skill: { sha256: '9'.repeat(64), tree_sha: null }, model: { pinned: 'opencode/big-pickle', returned: [] }, check_failures: [] })
      const prereg = (await import('./prereg')).parsePrereg(readFileSync(join(r.repo.dir, 'evals', 'demo', 'prereg.json'), 'utf8'))
      if (!prereg.ok) throw new Error('prereg')
      const dev = buildDevReport({
        prereg: prereg.prereg,
        shas: { tag: 'prereg/demo/1', tagObjectSha: 'b'.repeat(40), commitSha: r.preregCommit, blobSha: 'd'.repeat(40), firstSkillCommit: null, skillTreeSha: null },
        headSha: 'a'.repeat(40),
        runs: [m('d1', 'dev'), m('n1', 'negative')].map((x) => ({ manifest: x as never, manifestSha256: 'f'.repeat(64) })),
        plannedRuns: 2,
        skillSha256: '9'.repeat(64),
      })
      r.repo.write('evals/reports/demo/green-dev.json', `${JSON.stringify(dev)}\n`)
      const { code, err } = await run(r)
      expect(code).toBe(EXIT.REFUSED)
      expect(err).toContain('demo-dev-2026-10-22T15-00-00-000Z')
      expect(err).toContain('the committed file is not trusted')
    })
  })

  test('no campaign → error, nothing written', async () => {
    const { repo } = reportRepo()
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.ERROR)
    expect(t.lines.err.join('\n')).toContain('no RED campaign')
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
      // no judge is wired in scripted mode: the positive-fixture run has no outcome and is not in the denominator
      expect(t.lines.out.join('\n')).toContain('dev/d1/baseline: pass 0/0 (planned 1)')
      expect(t.lines.out.join('\n')).toContain('negative/n1/baseline: pass 1/1 (planned 1)')
      expect(t.lines.out.join('\n')).toContain('not graded (no judge)')
      expect(t.lines.err.join('\n')).toContain('deviate from the prereg plan')
    },
    180_000,
  )

  test(
    'green --dev-only runs the skill on dev + negatives without any held-out content',
    async () => {
      const { repo, scaffold } = chainRepo()
      buildHappyChain(repo, scaffold)
      const out = tmp('metacogs-cliout-')
      const t = io()
      t.io.env.METACOGS_HELDOUT_DIR = join(tmp('metacogs-clitest-nohold-'), 'absent')
      const code = await main(['green', '--dev-only', '--provider', 'scripted', '--runs', '1', '--fixture', 'n1', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)
      expect(code).toBe(EXIT.OK)
      const [campaign] = readdirSync(out)
      expect(campaign).toStartWith('demo-dev-')
      expect(readdirSync(join(out, campaign!)).filter((d) => d !== 'summary.json')).toEqual(['001-negative-n1-skill-r1'])
      expect(t.lines.err.join('\n')).not.toContain('REFUSED')
    },
    180_000,
  )

  test(
    'green --rehearsal is scripted, plans no held-out fixture, and claims no read marker',
    async () => {
      const { repo, scaffold } = chainRepo()
      buildHappyChain(repo, scaffold)
      const out = tmp('metacogs-cliout-')
      const t = io()
      t.io.env.METACOGS_HELDOUT_DIR = join(tmp('metacogs-clitest-nohold-'), 'absent')
      const code = await main(['green', '--rehearsal', '--runs', '1', '--fixture', 'n1', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)
      expect(code).toBe(EXIT.OK)
      const [campaign] = readdirSync(out)
      expect(campaign).toStartWith('demo-rehearsal-')
      expect(readdirSync(join(out, campaign!)).filter((d) => d !== 'summary.json')).toEqual(['001-negative-n1-skill-r1'])
      expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
      expect(existsSync(join(repo.dir, 'evals', 'reports', 'demo', 'green.json'))).toBe(false)
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

describe('defaultInstallSignalHandlers', () => {
  const COUNTS = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s))

  test('the first signal aborts; the second kills live process groups, deletes live fixtures, and exits 130; uninstalling removes every listener', async () => {
    const before = COUNTS()
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const fixture = createFixture('metacogs-sigtest-')
    const child = spawnCapture(['sleep', '60'], { cwd: fixture.workspace, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 120_000 })
    let aborts = 0
    const uninstall = defaultInstallSignalHandlers(() => void (aborts += 1))
    try {
      expect(COUNTS()).toEqual(before.map((n) => n + 1))

      process.emit('SIGINT')
      expect(aborts).toBe(1)
      expect(exit).not.toHaveBeenCalled()
      expect(existsSync(fixture.root)).toBe(true)

      process.emit('SIGTERM')
      expect(exit).toHaveBeenCalledWith(EXIT.INTERRUPTED)
      expect(EXIT.INTERRUPTED).toBe(130)
      expect(existsSync(fixture.root)).toBe(false) // removed synchronously, before the exit
      const result = await child // the group was SIGKILLed: the spawn resolves long before its 60 s sleep ends
      expect(result.wallMs).toBeLessThan(30_000)
    } finally {
      uninstall()
      exit.mockRestore()
      destroyFixture(fixture)
    }
    expect(COUNTS()).toEqual(before)
  })

  test('SIGHUP counts as an interrupt', () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    let aborts = 0
    const uninstall = defaultInstallSignalHandlers(() => void (aborts += 1))
    try {
      process.emit('SIGHUP')
      expect(aborts).toBe(1)
    } finally {
      uninstall()
      exit.mockRestore()
    }
  })
})

describe('review --reconcile', () => {
  const REAL = join(import.meta.dir, '..', '..')
  const greenPath = join(REAL, 'evals', 'reports', 'synthesis', 'green.json')

  test.skipIf(!existsSync(greenPath))('writes human-review.json and refreshes only the human_review block of the matching GREEN report', async () => {
    const repo = new TestRepo('metacogs-clitest-')
    cleanup.push(() => repo.destroy())
    const green = JSON.parse(readFileSync(greenPath, 'utf8')) as { campaign: { id: string }; verdict: string; heldout: { id: string }[]; checks: Record<string, boolean> }
    repo.write('evals/synthesis/prereg.json', readFileSync(join(REAL, 'evals', 'synthesis', 'prereg.json'), 'utf8'))
    repo.write('evals/reports/synthesis/green.json', readFileSync(greenPath, 'utf8'))
    repo.commit('init', ['evals'])

    const campaignId = green.campaign.id
    const campaign = join(repo.dir, 'evals', 'runs', campaignId)
    const runs = [
      ['001-heldout-sy-h5-skill-r1', 'sy-h5', 'skill'],
      ['002-heldout-sy-h5-baseline-r1', 'sy-h5', 'baseline'],
    ] as const
    const criteria = ['SY1', 'SY2', 'SY3', 'SY4', 'SY5']
    const { writeManifest } = await import('./manifest')
    for (const [id, fixture, condition] of runs) {
      mkdirSync(join(campaign, id), { recursive: true })
      writeManifest(join(campaign, id), { schema_version: 1, run_id: id, campaign_id: campaignId, status: 'completed', reasons: [], method: 'synthesis', condition, fixture: { id: fixture, kind: 'heldout', hash: 'h' } } as never)
    }
    const keyRows = (verdict: (i: number) => string) => criteria.map((c, i) => `| ${c} | ${verdict(i)} | "q" |`).join('\n')
    const header = (id: string, condition: string) => `## ${id}\n\n- fixture: sy-h5 (heldout)\n- condition: ${condition}\n- recorded outcome: pass\n\n| criterion | judge | quotes |\n| --- | --- | --- |\n`
    writeFileSync(join(campaign, 'review-key.md'), `# key\n\n${header(runs[0][0], 'skill')}${keyRows(() => 'pass')}\n\n${header(runs[1][0], 'baseline')}${keyRows((i) => (i === 0 ? 'fail' : 'pass'))}\n`)
    const markRows = (mark: (i: number) => string) => criteria.map((c, i) => `| ${c} | a | b | human: ${mark(i)} |`).join('\n')
    // the human agrees on the skill run and fails SY2 on the baseline run the judge failed only on SY1
    writeFileSync(join(campaign, 'review.md'), `# sheet\n\n## ${runs[0][0]}\n\n${markRows(() => 'pass')}\n\nnote:\n\n## ${runs[1][0]}\n\n${markRows((i) => (i === 0 || i === 1 ? 'fail' : 'pass'))}\n\nnote:\n`)

    const t = io()
    expect(await main(['review', '--campaign', campaignId, '--reconcile', '--repo', repo.dir], t.io)).toBe(EXIT.OK)
    expect(t.lines.out.join('\n')).toContain('reviewed 2 of 2 judged runs')
    expect(t.lines.out.join('\n')).toContain('SY1: agree 2/2')
    const review = JSON.parse(readFileSync(join(campaign, 'human-review.json'), 'utf8')) as { flipped_runs: string[]; criteria: Record<string, { rate: number }> }
    expect(review.flipped_runs).toEqual([]) // judge failed the baseline run and so did the human
    expect(review.criteria.SY2!.rate).toBe(0.5)

    const updated = JSON.parse(readFileSync(join(repo.dir, 'evals', 'reports', 'synthesis', 'green.json'), 'utf8')) as typeof green & { human_review: { status: string; reviewed: number; demoted_criteria: string[]; recomputed?: { verdict: string } } }
    expect(updated.verdict).toBe(green.verdict) // the machine verdict is never rewritten
    expect(updated.human_review).toMatchObject({ status: 'complete', reviewed: 2, demoted_criteria: ['SY2'] })
    expect(updated.human_review.recomputed?.verdict).toBeDefined()

    // a campaign with no marked sheet is an error that says what to run
    const t2 = io()
    expect(await main(['review', '--campaign', join(repo.dir, 'evals', 'runs'), '--reconcile', '--repo', repo.dir], t2.io)).toBe(EXIT.ERROR)
  })
})
