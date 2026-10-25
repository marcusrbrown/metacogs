import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultInstallSignalHandlers, EXIT, main, type MainIO } from './cli'
import { createFixture, destroyFixture } from './env'
import { opencodeAvailability, spawnCapture } from './opencode'
import { parseRubric } from './judge'
import { preregContentHash } from './prereg'
import { sha256 } from './workspace'
import { buildHappyChain, JUDGED_RUBRIC_TEXT, scaffoldMethod, TestRepo, writePrereg } from './test-support'

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
    io: <Partial<MainIO> & { env: Record<string, string> }>{
      out: (l: string) => lines.out.push(l),
      err: (l: string) => lines.err.push(l),
      installSignalHandlers: () => () => {},
      // Refusal tests never launch; they must not depend on the pinned OpenCode being installed.
      opencodeAvailability: () => ({ available: true as const, reason: 'stub' }),
      env: { XDG_STATE_HOME: stateHome } as Record<string, string>,
    },
  }
}

const LIVE = ['--provider', 'live', '--auth-passthrough', 'none']

function chainRepo(rubric?: string, expectations?: { dev?: Record<string, unknown> }) {
  const repo = new TestRepo('metacogs-clitest-')
  cleanup.push(() => repo.destroy())
  const heldout = tmp('metacogs-clitest-held-')
  // A judge this runner can reach: the live GREEN preflight refuses anything else before the prereg is enforced.
  const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout, overrides: { judge_model_id: 'opencode-go/judge-model-x' }, ...(rubric ? { rubric } : {}), ...(expectations ? { expectations } : {}) })
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
      ['green', '--method', 'demo', '--dev-only', '--runs', '1'],
      ['green', '--method', 'demo', '--dev-only', '--fixture', 'd1'],
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
    writeManifest(runDir, { schema_version: 1, run_id: '001-dev-d1-baseline-r1', campaign_id: 'demo-red-1', status: 'completed', outcome: 'fail', reasons: [], method: 'demo', condition: 'baseline', fixture: { id: 'd1', kind: 'dev', hash: 'h' }, prereg: { content_hash: 'a'.repeat(64), epoch: 1 } } as never)
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

  test('a preflight refusal (model routing, unavailable OpenCode, output dir) does not claim the read marker', async () => {
    const repo = new TestRepo('metacogs-clitest-')
    cleanup.push(() => repo.destroy())
    const heldout = tmp('metacogs-clitest-held-')
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout, overrides: { agent_model_id: 'openai/gpt-6-luna', judge_model_id: 'anthropic/claude-haiku-5-5' } })
    buildHappyChain(repo, scaffold)
    const routing = io()
    routing.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], routing.io)).toBe(EXIT.REFUSED)
    expect(routing.lines.err.join('\n')).toContain('--auth-cliproxy')
    expect(existsSync(join(routing.stateHome, 'metacogs', 'heldout'))).toBe(false)

    const sound = chainRepo()
    buildHappyChain(sound.repo, sound.scaffold)
    const missing = io()
    missing.io.env.METACOGS_HELDOUT_DIR = sound.heldout
    expect(await main(['green', '--method', 'demo', '--repo', sound.repo.dir, ...LIVE], { ...missing.io, opencodeAvailability: () => ({ available: false, reason: 'not installed' }) })).toBe(EXIT.ERROR)
    expect(missing.lines.err.join('\n')).toContain('cannot launch the pinned OpenCode')
    expect(existsSync(join(missing.stateHome, 'metacogs', 'heldout'))).toBe(false)

    const outside = io()
    outside.io.env.METACOGS_HELDOUT_DIR = sound.heldout
    expect(await main(['green', '--method', 'demo', '--repo', sound.repo.dir, '--out', join(sound.repo.dir, 'evals', 'runs'), ...LIVE], outside.io)).toBe(EXIT.REFUSED)
    expect(existsSync(join(outside.stateHome, 'metacogs', 'heldout'))).toBe(false)
  })

  test('a content mismatch (here a missing held-out file) is refused before the marker is claimed', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    rmSync(join(heldout, 'h1.md'))
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
  })

  test('once the marker is claimed (here: a near-duplicate refusal after the claim), the next attempt names it and is refused', async () => {
    const base = chainRepo()
    const { repo, heldout } = base
    // the held-out file is a copy of the dev fixture: every hash verifies, then the near-duplicate gate stops the run after the claim
    const fixtureHashes = base.scaffold.prereg.fixture_hashes
    const scaffold = { ...base.scaffold, prereg: { ...base.scaffold.prereg, fixture_hashes: { ...fixtureHashes, heldout: { h1: fixtureHashes.dev.d1! } } } }
    writeFileSync(join(heldout, 'h1.md'), readFileSync(join(repo.dir, 'evals', 'demo', 'fixtures', 'dev', 'd1.md')))
    buildHappyChain(repo, scaffold)
    const first = io()
    first.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], first.io)).toBe(EXIT.REFUSED)
    expect(first.lines.err.join('\n')).toContain('near-duplicate')
    const markerPath = join(first.stateHome, 'metacogs', 'heldout', 'demo', '1.read.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { campaign_id: string; started_at: string; prereg_content_hash: string; heldout_fingerprints: string[] }
    expect(marker.prereg_content_hash).toBe(preregContentHash(scaffold.prereg))
    expect(marker.campaign_id).toMatch(/^demo-green-/)
    expect(Number.isNaN(Date.parse(marker.started_at))).toBe(false)
    expect(marker.heldout_fingerprints).toEqual([sha256(readFileSync(join(heldout, 'h1.md'), 'utf8'))])

    // same state root: the marker, not green.json, stops the second read
    const second = io()
    second.io.env.METACOGS_HELDOUT_DIR = heldout
    second.io.env.XDG_STATE_HOME = first.stateHome
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], second.io)).toBe(EXIT.REFUSED)
    const message = second.lines.err.join('\n')
    expect(message).toContain('already read')
    expect(message).toContain(marker.campaign_id)
    expect(message).toContain(marker.prereg_content_hash.slice(0, 12))
    expect(second.lines.out).toEqual([])
  })

  test('an uncommitted skill is refused before the marker is claimed', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    repo.write('skills/demo/SKILL.md', 'uncommitted edit\n')
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('skill_dirty')
    expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
  })

  test('a GREEN read with no committed skill is refused as skill_missing and claims nothing', async () => {
    const { repo, heldout, scaffold } = chainRepo()
    writePrereg(repo, scaffold)
    repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = heldout
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('[skill_missing]')
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
    writePrereg(repo, scaffold)
    repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
    const t = io()
    expect(await main(['red', '--method', 'demo', '--repo', repo.dir, '--provider', 'live', '--auth-passthrough', 'none'], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('--auth-cliproxy')
    expect(t.lines.out).toEqual([])
  })

  test('a METACOGS_HELDOUT_DIR inside the repo → refused before the marker is claimed or anything launches', async () => {
    const { repo, scaffold } = chainRepo()
    buildHappyChain(repo, scaffold)
    const t = io()
    t.io.env.METACOGS_HELDOUT_DIR = join(repo.dir, 'evals', 'demo', 'heldout')
    expect(await main(['green', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('inside the repository')
    expect(t.lines.out).toEqual([])
    expect(existsSync(join(t.stateHome, 'metacogs', 'heldout'))).toBe(false)
    const report = io()
    report.io.env.METACOGS_HELDOUT_DIR = t.io.env.METACOGS_HELDOUT_DIR
    expect(await main(['report', '--green', '--method', 'demo', '--repo', repo.dir], report.io)).toBe(EXIT.REFUSED)
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
    writePrereg(repo, scaffold)
    repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
    return { repo, scaffold, prereg: preregContentHash(scaffold.prereg) }
  }

  const manifest = (id: string, fixture: string, kind: string, contentHash: string) => ({
    schema_version: 1,
    run_id: id,
    campaign_id: 'demo-red-2026-10-22T16-00-00-000Z',
    status: 'completed',
    outcome: 'fail',
    reasons: ['judge_fail'],
    method: 'demo',
    condition: 'baseline',
    fixture: { id: fixture, kind, hash: 'f'.repeat(64) },
    prereg: { content_hash: contentHash, epoch: 1 },
    opencode: { package: 'opencode-ai', version: '1.19.4' },
    model: { pinned: 'opencode/big-pickle', returned: ['big-pickle'] },
    usage: { input: 1, output: 1, reasoning: 0 },
    wall_clock_ms: 5,
    artifacts: { 'stdout.jsonl': { file: 'stdout.jsonl', sha256: 'a'.repeat(64), bytes: 1 } },
    started_at: '2026-10-22T16:00:00.000Z',
    finished_at: '2026-10-22T16:00:01.000Z',
  })

  async function plant(repo: TestRepo, contentHash: string) {
    const { writeManifest } = await import('./manifest')
    const campaign = join(repo.dir, 'evals', 'runs', 'demo-red-2026-10-22T16-00-00-000Z')
    for (const [i, [fixture, kind]] of [['d1', 'dev'], ['n1', 'negative']].entries()) {
      const id = `00${i + 1}-${kind}-${fixture}-baseline-r1`
      const dir = join(campaign, id)
      require('node:fs').mkdirSync(dir, { recursive: true })
      writeManifest(dir, manifest(id, fixture!, kind!, contentHash) as never)
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
    expect(written.prereg.content_hash).toBe(prereg)
    expect(written.fixtures.map((f: { fail_over_total: string }) => f.fail_over_total)).toEqual(['1/1', '1/1'])
    expect(t.lines.out.join('\n')).toContain('dev/d1: fail 1/1')
  })

  test('report --campaign <pilot dir> is refused even when the pilot ran under the same prereg content', async () => {
    const { repo, prereg } = reportRepo()
    const { writeManifest } = await import('./manifest')
    const dir = join(repo.dir, 'evals', 'runs', 'demo-pilot-2026-10-22T16-00-00-000Z', '001-dev-d1-baseline-r1')
    mkdirSync(dir, { recursive: true })
    writeManifest(dir, { ...manifest('001-dev-d1-baseline-r1', 'd1', 'dev', prereg), campaign_id: 'demo-pilot-2026-10-22T16-00-00-000Z', arm: 'baseline' } as never)
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir, '--campaign', dirname(dir)], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('pilot')
    expect(existsSync(join(repo.dir, 'evals', 'reports', 'demo', 'red.json'))).toBe(false)
  })

  test('latestCampaign ignores pilot directories: a newer pilot never shadows the newest RED campaign', async () => {
    const { repo, prereg } = reportRepo()
    await plant(repo, prereg)
    const { writeManifest } = await import('./manifest')
    const dir = join(repo.dir, 'evals', 'runs', 'demo-pilot-2099-01-01T00-00-00-000Z', '001-dev-d1-baseline-r1')
    mkdirSync(dir, { recursive: true })
    writeManifest(dir, { ...manifest('001-dev-d1-baseline-r1', 'd1', 'dev', prereg), arm: 'baseline' } as never)
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.OK)
    expect(t.lines.out.join('\n')).toContain('dev/d1: fail 1/1')
  })

  test('refuses manifests produced under a different prereg content hash', async () => {
    const { repo } = reportRepo()
    await plant(repo, 'e'.repeat(64))
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('not produced under')
  })

  test('a campaign of legacy-format manifests (prereg.tag/commit_sha) is refused with the format message', async () => {
    const { repo } = reportRepo()
    const { writeFileSync: write, mkdirSync: mk } = require('node:fs')
    const dir = join(repo.dir, 'evals', 'runs', 'demo-red-2026-10-22T16-00-00-000Z', '001-dev-d1-baseline-r1')
    mk(dir, { recursive: true })
    write(join(dir, 'manifest.json'), JSON.stringify({ ...manifest('001-dev-d1-baseline-r1', 'd1', 'dev', 'a'.repeat(64)), prereg: { tag: 'prereg/demo/1', commit_sha: 'f'.repeat(40), epoch: 1 } }))
    const t = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('manifest predates the content-contract format')
  })

  test('editing prereg.json after the campaign ran voids its manifests: the report is refused', async () => {
    const { repo, scaffold, prereg } = reportRepo()
    await plant(repo, prereg)
    const before = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], before.io)).toBe(EXIT.OK)
    require('node:fs').rmSync(join(repo.dir, 'evals', 'reports'), { recursive: true, force: true })
    writePrereg(repo, scaffold, { ...scaffold.prereg, runs_per_condition: scaffold.prereg.runs_per_condition + 1 })
    const after = io()
    expect(await main(['report', '--method', 'demo', '--repo', repo.dir], after.io)).toBe(EXIT.REFUSED)
    expect(after.lines.err.join('\n')).toContain('not produced under')
    expect(existsSync(join(repo.dir, 'evals', 'reports', 'demo', 'red.json'))).toBe(false)
  })

  describe('report --green: the dev regression is recomputed, never read from green-dev.json', () => {
    async function greenRepo() {
      const { repo, heldout, scaffold } = chainRepo()
      buildHappyChain(repo, scaffold)
      const preregHash = preregContentHash(scaffold.prereg)
      const { writeManifest } = await import('./manifest')
      const campaign = join(tmp('metacogs-clitest-green-'), 'demo-green-2026-10-22T16-00-00-000Z')
      const dir = join(campaign, '001-heldout-h1-skill-r1')
      mkdirSync(dir, { recursive: true })
      writeManifest(dir, { ...manifest('001-heldout-h1-skill-r1', 'h1', 'heldout', preregHash), condition: 'skill' } as never)
      return { repo, heldout, campaign, preregHash }
    }
    const run = async (r: Awaited<ReturnType<typeof greenRepo>>) => {
      const t = io()
      t.io.env.METACOGS_HELDOUT_DIR = r.heldout
      const code = await main(['report', '--green', '--method', 'demo', '--repo', r.repo.dir, '--campaign', r.campaign], t.io)
      return { code, err: t.lines.err.join('\n') }
    }

    test('no green-dev.json: refused, nothing written, and the message names the steps that produce it', async () => {
      const r = await greenRepo()
      const { code, err } = await run(r)
      expect(code).toBe(EXIT.REFUSED)
      expect(err).toContain('green-dev.json does not exist')
      expect(err).toContain('green --dev-only')
      expect(err).toContain('report --dev-only')
      expect(existsSync(join(r.repo.dir, 'evals', 'reports', 'demo', 'green.json'))).toBe(false)
    })

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
      const m = (id: string, kind: string) => ({ ...manifest(`001-${kind}-${id}-skill-r1`, id, kind, r.preregHash), condition: 'skill', campaign_id: 'demo-dev-2026-10-22T15-00-00-000Z', verdict_basis: kind === 'dev' ? 'judge' : 'deterministic', skill: { sha256: '9'.repeat(64) }, model: { pinned: 'opencode/big-pickle', returned: [] }, check_failures: [] })
      const prereg = (await import('./prereg')).parsePrereg(readFileSync(join(r.repo.dir, 'evals', 'demo', 'prereg.json'), 'utf8'))
      if (!prereg.ok) throw new Error('prereg')
      const dev = buildDevReport({
        prereg: prereg.prereg,
        contentHash: r.preregHash,
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
      const code = await main(['green', '--dev-only', '--provider', 'scripted', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)
      expect(code).toBe(EXIT.OK)
      const [campaign] = readdirSync(out)
      expect(campaign).toStartWith('demo-dev-')
      expect(readdirSync(join(out, campaign!)).filter((d) => d !== 'summary.json').sort()).toEqual(['001-dev-d1-skill-r1', '002-negative-n1-skill-r1', '003-dev-d1-skill-r2', '004-negative-n1-skill-r2'])
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

describe('pilot', () => {
  const PILOT_PREREG = 'evals/demo/pilot/prereg.json'
  function pilotRepo(prereg?: object) {
    const { repo, heldout, scaffold } = chainRepo()
    repo.write(PILOT_PREREG, `${JSON.stringify(prereg ?? scaffold.prereg, null, 2)}\n`)
    repo.commit('test: pilot prereg', [PILOT_PREREG]) // a pilot prereg is a contract only once committed
    return { repo, heldout, scaffold }
  }

  test('usage: a bad --arm, --arm/--prereg outside pilot, and pilot-incompatible flags', async () => {
    for (const argv of [
      ['red', '--method', 'demo', '--arm', 'baseline'],
      ['green', '--method', 'demo', '--prereg', PILOT_PREREG],
      ['pilot', '--method', 'demo', '--dev-only'],
      ['pilot', '--method', 'demo', '--rehearsal'],
      ['pilot'],
    ]) {
      const t = io()
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
    }
  })

  test('the usage text documents --arm and --prereg with their defaults, and --prereg on rejudge', async () => {
    const t = io()
    expect(await main(['pilot'], t.io)).toBe(EXIT.USAGE)
    const usage = t.lines.err.join('\n')
    expect(usage).toContain('--arm baseline')
    expect(usage).toContain('default: baseline')
    expect(usage).toContain('default: evals/<m>/pilot/prereg.json')
    expect(usage).toMatch(/rejudge --campaign <id\|dir> \[--auth-passthrough opencode-go\] \[--prereg <file>\]/)
    expect(usage).toContain('pilot --method <name> --provider live')
  })

  test('any --arm but baseline is refused with the same generic message, before any repo work', async () => {
    for (const arm of ['instruction', 'skill', 'bogus']) {
      const t = io()
      expect(await main(['pilot', '--method', 'demo', '--arm', arm, '--repo', '/nonexistent'], t.io)).toBe(EXIT.REFUSED)
      const message = t.lines.err.join('\n')
      expect(message).toContain('this runner supports the baseline arm only; see evals/demo/pilot/README.md')
      expect(message).not.toContain('Unit')
    }
  })

  describe('the pilot prereg must be committed and clean, checked before any credential is fetched or model asked', () => {
    const noFetch = (t: ReturnType<typeof io>) => {
      t.io.env.METACOGS_AUTH_CLIPROXY = 'no-such-key' // fetching it would fail with a different message
      t.io.createJudge = (() => {
        throw new Error('the judge must not be built')
      }) as never
    }
    const states: [string, string, (repo: TestRepo, path: string) => void][] = [
      ['untracked', 'prereg_untracked', (repo, path) => repo.write(path, `${JSON.stringify(chainRepoPrereg(), null, 2)}\n`)],
      ['staged only', 'prereg_dirty', (repo, path) => (repo.write(path, `${JSON.stringify(chainRepoPrereg(), null, 2)}\n`), repo.sh(['add', '--', path]))],
      ['modified after the commit', 'prereg_dirty', (repo, path) => (repo.write(path, `${JSON.stringify(chainRepoPrereg(), null, 2)}\n`), repo.commit('c', [path]), repo.write(path, `${JSON.stringify({ ...chainRepoPrereg(), epoch: 9 }, null, 2)}\n`))],
      ['staged then modified again', 'prereg_dirty', (repo, path) => (repo.write(path, `${JSON.stringify(chainRepoPrereg(), null, 2)}\n`), repo.commit('c', [path]), repo.write(path, '{}\n'), repo.sh(['add', '--', path]))],
    ]
    // Any valid prereg will do: the gate refuses before it is parsed.
    const chainRepoPrereg = () => scaffoldPrereg
    let scaffoldPrereg: object = {}

    for (const [name, code, arrange] of states) {
      for (const path of [PILOT_PREREG, 'evals/demo/pilot/other.json']) {
        test(`eval pilot: ${name} (${path}) is refused as ${code}, naming the path`, async () => {
          const { repo, scaffold } = chainRepo()
          scaffoldPrereg = scaffold.prereg
          arrange(repo, path)
          const t = io()
          noFetch(t)
          const argv = ['pilot', '--method', 'demo', '--repo', repo.dir, '--provider', 'live', ...(path === PILOT_PREREG ? [] : ['--prereg', path])]
          expect(await main(argv, t.io)).toBe(EXIT.REFUSED)
          expect(t.lines.err.join('\n')).toContain(`${code}: ${path}`)
          expect(readdirSync(join(repo.dir, 'evals')).includes('runs')).toBe(false)
        })
      }
    }

    test('a committed, clean prereg passes the gate (the next refusal is a different one)', async () => {
      const { repo } = pilotRepo()
      repo.write('evals/demo/fixtures/dev/d1.md', 'edited after the prereg\n')
      const t = io()
      expect(await main(['pilot', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).not.toMatch(/prereg_(dirty|untracked)/)
    })

    describe('rejudge of a pilot campaign', () => {
      const CAMPAIGN = 'demo-pilot-2026-10-24T00-00-00-000Z'
      async function plantedUncommitted(arrange: (repo: TestRepo) => void) {
        const { repo, scaffold } = chainRepo(JUDGED_RUBRIC_TEXT)
        scaffoldPrereg = scaffold.prereg
        arrange(repo)
        const { writeManifest } = await import('./manifest')
        const dir = join(repo.dir, 'evals', 'runs', CAMPAIGN, '001-dev-d1-baseline-r1')
        mkdirSync(dir, { recursive: true })
        writeManifest(dir, { schema_version: 1, run_id: '001-dev-d1-baseline-r1', campaign_id: CAMPAIGN, status: 'completed', outcome: 'pass', reasons: [], verdict_basis: 'judge', method: 'demo', condition: 'baseline', arm: 'baseline', fixture: { id: 'd1', kind: 'dev', hash: scaffold.prereg.fixture_hashes.dev.d1 }, check_failures: [], records: [], artifacts: {}, prereg: { content_hash: 'f'.repeat(64), epoch: 1 }, model: { pinned: 'm', returned: [] } } as never)
        return repo
      }
      const write = (repo: TestRepo, text = `${JSON.stringify(scaffoldPrereg, null, 2)}\n`) => repo.write(PILOT_PREREG, text)
      const arrangements: [string, string, (repo: TestRepo) => void][] = [
        ['untracked', 'prereg_untracked', (repo) => write(repo)],
        ['staged only', 'prereg_dirty', (repo) => (write(repo), repo.sh(['add', '--', PILOT_PREREG]))],
        ['modified after the commit', 'prereg_dirty', (repo) => (write(repo), repo.commit('c', [PILOT_PREREG]), write(repo, `${JSON.stringify({ ...(scaffoldPrereg as object), epoch: 9 }, null, 2)}\n`))],
      ]
      for (const [name, code, arrange] of arrangements) {
        for (const extra of [[], ['--tally-only']]) {
          test(`rejudge${extra.length ? ' --tally-only' : ''}: ${name} is refused as ${code} before credentials or the judge`, async () => {
            const repo = await plantedUncommitted(arrange)
            const t = io()
            noFetch(t)
            expect(await main(['rejudge', '--campaign', CAMPAIGN, '--repo', repo.dir, ...extra], t.io)).toBe(EXIT.REFUSED)
            expect(t.lines.err.join('\n')).toContain(`${code}: ${PILOT_PREREG}`)
          })
        }
      }
    })
  })

  test('a missing pilot prereg is refused, naming the pilot path and not evals/<m>/prereg.json', async () => {
    const { repo, scaffold } = chainRepo()
    writePrereg(repo, scaffold) // the production prereg exists; the pilot one does not
    const t = io()
    expect(await main(['pilot', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('evals/demo/pilot/prereg.json does not exist')
  })

  test('--prereg must stay inside the repository', async () => {
    const { repo } = pilotRepo()
    const t = io()
    expect(await main(['pilot', '--method', 'demo', '--repo', repo.dir, '--prereg', '../elsewhere/prereg.json', ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('outside the repository')
  })

  test('the pilot prereg is enforced like any other: an edited fixture voids it', async () => {
    const { repo } = pilotRepo()
    repo.write('evals/demo/fixtures/dev/d1.md', 'edited after the prereg\n')
    const t = io()
    expect(await main(['pilot', '--method', 'demo', '--repo', repo.dir, ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('dev/d1 mismatch')
  })

  test('--prereg names another repo-relative prereg file', async () => {
    const { repo, scaffold } = chainRepo()
    repo.write('evals/demo/pilot/other.json', `${JSON.stringify(scaffold.prereg)}\n`)
    const t = io()
    expect(await main(['pilot', '--method', 'demo', '--repo', repo.dir, '--prereg', 'evals/demo/pilot/missing.json', ...LIVE], t.io)).toBe(EXIT.REFUSED)
    expect(t.lines.err.join('\n')).toContain('evals/demo/pilot/missing.json does not exist')
  })

  describe('rejudge of a pilot campaign', () => {
    const CAMPAIGN = 'demo-pilot-2026-10-24T00-00-00-000Z'
    const evidence = (te2: 'pass' | 'fail') => ({
      model: { pinned: 'opencode-go/judge-model-x', returned: ['judge-model-x'] },
      system_prompt_sha256: 'a'.repeat(64),
      input_sha256: 'b'.repeat(64),
      redacted_input_sha256: 'c'.repeat(64),
      attempts: 1,
      temperature: 0,
      error_code: null,
      criteria: [
        { id: 'TE1', verdict: 'pass', quote: 'a verbatim quote of the answer', quote_verified: true },
        { id: 'TE2', verdict: te2, quote: 'a verbatim quote of the answer', quote_verified: true },
      ],
      overclaim_flag: false,
      tool_calls: 0,
      wall_ms: 1,
    })
    // What `rejudge --tally-only` computes from the committed rubric; a rejudge records the same hash in rejudge-summary.json.
    const REAL_PROMPT = sha256(parseRubric(JUDGED_RUBRIC_TEXT).systemPrompt)
    const fakeJudge = (hook: (input: unknown) => Promise<unknown>) =>
      (() => ({ hook, spec: { systemPrompt: 'S', declarations: { expectation: true }, criteria: [], overclaimPatterns: [] }, systemPromptSha256: REAL_PROMPT, rubricSha256: 'e'.repeat(64) })) as never

    async function plantedPilot(opts: { prereg?: boolean; summary?: boolean; maxWords?: number; words?: number } = {}) {
      const { repo, scaffold } = chainRepo(JUDGED_RUBRIC_TEXT, opts.maxWords === undefined ? undefined : { dev: { d1: { outcome: 'o', excludedTopics: [], maxWords: opts.maxWords } } })
      if (opts.prereg !== false) {
        repo.write(PILOT_PREREG, `${JSON.stringify(scaffold.prereg, null, 2)}\n`)
        repo.commit('test: pilot prereg', [PILOT_PREREG])
      }
      const { writeManifest } = await import('./manifest')
      const dir = join(repo.dir, 'evals', 'runs', CAMPAIGN, '001-dev-d1-baseline-r1')
      mkdirSync(dir, { recursive: true })
      writeManifest(dir, {
        schema_version: 1,
        run_id: '001-dev-d1-baseline-r1',
        campaign_id: CAMPAIGN,
        status: 'completed',
        outcome: 'pass',
        reasons: [],
        verdict_basis: 'judge',
        method: 'demo',
        condition: 'baseline',
        arm: 'baseline',
        fixture: { id: 'd1', kind: 'dev', hash: scaffold.prereg.fixture_hashes.dev.d1 },
        check_failures: [],
        records: [],
        artifacts: {},
        prereg: { content_hash: 'f'.repeat(64), epoch: 1 },
        model: { pinned: 'opencode/agent-x', returned: [] },
        ...(opts.words !== undefined ? { word_count: opts.words } : {}),
        judge: evidence('pass'),
      } as never)
      const say = (text: string) => JSON.stringify({ type: 'text', timestamp: 2, part: { type: 'text', text } })
      writeFileSync(join(dir, 'stdout.jsonl'), say('The answer.'))
      writeFileSync(join(dir, 'judge.json'), JUDGE_JSON)
      // Default: the state a finished rejudge leaves, so the verdicts on disk are provably from the current judge prompt.
      if (opts.summary !== false) writeSummary(dirname(dir), REAL_PROMPT, [{ run_id: '001-dev-d1-baseline-r1', verdict: 'pass', judge_json_sha256: sha256(JUDGE_JSON) }])
      return { repo, scaffold, dir }
    }
    const JUDGE_JSON = JSON.stringify({ redacted_input_sha256: 'c'.repeat(64), model_pinned: 'm', model_returned: ['m'], criteria: [{ id: 'TE1', verdict: 'pass', quotes: ['q'] }, { id: 'TE2', verdict: 'pass', quotes: ['q'] }], attempts: 1 })
    const writeSummary = (campaignDir: string, prompt: string, runs: object[]) => writeFileSync(join(campaignDir, 'rejudge-summary.json'), JSON.stringify({ judge_prompt_sha256: prompt, runs }))
    /** A second run in the same campaign, copied from the first with `over` applied to its manifest. */
    async function plantSecondRun(dir: string, over: Record<string, unknown>) {
      const { writeManifest, readManifest } = await import('./manifest')
      const second = join(dirname(dir), '002-dev-d1-baseline-r1')
      mkdirSync(second, { recursive: true })
      writeManifest(second, { ...readManifest(join(dir, 'manifest.json')), run_id: '002-dev-d1-baseline-r1', ...over } as never)
      writeFileSync(join(second, 'stdout.jsonl'), readFileSync(join(dir, 'stdout.jsonl')))
      writeFileSync(join(second, 'judge.json'), JUDGE_JSON)
      return second
    }
    const tallyOnlyArgs = (repo: TestRepo) => ['rejudge', '--campaign', CAMPAIGN, '--repo', repo.dir, '--tally-only']
    const pilotJson = (repo: TestRepo) => join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json')
    const rejudgeArgs = (repo: TestRepo) => ['rejudge', '--campaign', CAMPAIGN, '--repo', repo.dir, '--auth-passthrough', 'none']

    test('reads the pilot prereg, rejudges, regenerates pilot.json from the new verdicts, and writes no review sheets', async () => {
      const { repo, scaffold, dir } = await plantedPilot()
      const before = readFileSync(join(dir, 'manifest.json'), 'utf8')
      const t = io()
      t.io.createJudge = fakeJudge(async () => ({ verdict: 'fail', evidence: evidence('fail') }))
      expect(await main(rejudgeArgs(repo), t.io)).toBe(EXIT.OK)
      const written = JSON.parse(readFileSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json'), 'utf8')) as { prereg_content_hash: string; arms: string[]; tally: Record<string, Record<string, { runs: number; criteria: Record<string, number>; all_pass: number }>> }
      expect(written.prereg_content_hash).toBe(preregContentHash(scaffold.prereg))
      expect(written.arms).toEqual(['baseline'])
      expect((written as unknown as { campaigns: object }).campaigns).toEqual({ baseline: CAMPAIGN })
      expect(written.tally.baseline!.d1).toMatchObject({ runs: 1, criteria: { TE1: 1, TE2: 0 }, all_pass: 0 })
      expect(JSON.parse(readFileSync(join(repo.dir, 'evals', 'runs', CAMPAIGN, 'rejudge-summary.json'), 'utf8')).runs[0]).toMatchObject({ run_id: '001-dev-d1-baseline-r1', verdict: 'fail' })
      expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(before)
      expect(existsSync(join(repo.dir, 'evals', 'runs', CAMPAIGN, 'review.md'))).toBe(false)
      expect(t.lines.out.join('\n')).toContain('pilot.json')
    })

    test('--tally-only rebuilds pilot.json from the verdicts on disk without building a judge, reading credentials, or needing OpenCode', async () => {
      const { repo, scaffold, dir } = await plantedPilot()
      const before = readFileSync(join(dir, 'manifest.json'), 'utf8')
      const t = io()
      t.io.createJudge = (() => {
        throw new Error('the judge must not be built')
      }) as never
      t.io.opencodeAvailability = () => ({ available: false as const, reason: 'must not be asked' })
      t.io.env.METACOGS_AUTH_CLIPROXY = 'no-such-key'
      expect(await main(['rejudge', '--campaign', CAMPAIGN, '--repo', repo.dir, '--tally-only'], t.io)).toBe(EXIT.OK)
      const written = JSON.parse(readFileSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json'), 'utf8')) as { prereg_content_hash: string; tally: Record<string, Record<string, object>> }
      expect(written.prereg_content_hash).toBe(preregContentHash(scaffold.prereg))
      expect(written.tally.baseline!.d1).toMatchObject({ runs: 1, criteria: { TE1: 1, TE2: 1 }, all_pass: 1 })
      expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(before)
      expect(readFileSync(join(repo.dir, 'evals', 'runs', CAMPAIGN, 'rejudge-summary.json'), 'utf8')).toContain(REAL_PROMPT) // read, never rewritten
    })

    test('review and review --reconcile refuse a pilot campaign with the message report uses, and write nothing', async () => {
      const { repo, dir } = await plantedPilot()
      const campaignDir = dirname(dir)
      writeFileSync(join(campaignDir, 'review.md'), 'marked')
      writeFileSync(join(campaignDir, 'review-key.md'), 'key')
      for (const extra of [[], ['--reconcile']]) {
        const t = io()
        expect(await main(['review', '--campaign', CAMPAIGN, '--repo', repo.dir, ...extra], t.io)).toBe(EXIT.REFUSED)
        const message = t.lines.err.join('\n')
        expect(message).toContain('1 manifest(s) belong to a pilot campaign (001-dev-d1-baseline-r1 carries arm "baseline"); pilot runs are not reportable')
      }
      expect(readFileSync(join(campaignDir, 'review.md'), 'utf8')).toBe('marked')
      expect(existsSync(join(campaignDir, 'human-review.json'))).toBe(false)
    })

    test('over_limit follows the maxWords of the committed expectation sidecar, not the reasons the run recorded', async () => {
      for (const [maxWords, over] of [[5, 1], [9, 0], [50, 0]] as const) {
        const { repo } = await plantedPilot({ maxWords, words: 9 })
        const t = io()
        expect(await main(tallyOnlyArgs(repo), t.io)).toBe(EXIT.OK)
        const written = JSON.parse(readFileSync(pilotJson(repo), 'utf8')) as { tally: { baseline: { d1: { over_limit: number } } } }
        expect(written.tally.baseline.d1.over_limit).toBe(over)
      }
    })

    test('--tally-only is refused when no rejudge under the current judge prompt backs the verdicts, naming the run dir', async () => {
      const { repo } = await plantedPilot({ summary: false })
      const t = io()
      expect(await main(tallyOnlyArgs(repo), t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).toContain('001-dev-d1-baseline-r1')
      expect(existsSync(pilotJson(repo))).toBe(false)
    })

    test('--tally-only is refused after a rubric edit that was not followed by a rejudge, and accepted once it is', async () => {
      const { repo, dir } = await plantedPilot()
      // The summary is for the judge prompt of the rubric as it was before the edit.
      writeSummary(dirname(dir), 'e'.repeat(64), [{ run_id: '001-dev-d1-baseline-r1', verdict: 'pass', judge_json_sha256: sha256(JUDGE_JSON) }])
      const refused = io()
      expect(await main(tallyOnlyArgs(repo), refused.io)).toBe(EXIT.REFUSED)
      expect(refused.lines.err.join('\n')).toContain('judge prompt')
      expect(existsSync(pilotJson(repo))).toBe(false)
      // The rejudge rewrites judge.json and the summary under the current prompt.
      const rejudge = io()
      rejudge.io.createJudge = fakeJudge(async () => ({ verdict: 'pass', evidence: evidence('pass') }))
      expect(await main(rejudgeArgs(repo), rejudge.io)).toBe(EXIT.OK)
      rmSync(pilotJson(repo))
      const accepted = io()
      expect(await main(tallyOnlyArgs(repo), accepted.io)).toBe(EXIT.OK)
      expect(existsSync(pilotJson(repo))).toBe(true)
    })

    test('--tally-only is refused when the rejudge skipped a run, naming it', async () => {
      const { repo, dir } = await plantedPilot()
      await plantSecondRun(dir, {})
      writeSummary(dirname(dir), REAL_PROMPT, [
        { run_id: '001-dev-d1-baseline-r1', verdict: 'pass', judge_json_sha256: sha256(JUDGE_JSON) },
        { run_id: '002-dev-d1-baseline-r1', prior_outcome: 'pass', verdict: 'skipped', reason: 'fixture missing or changed since the run' },
      ])
      const t = io()
      expect(await main(tallyOnlyArgs(repo), t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).toContain('002-dev-d1-baseline-r1')
      expect(existsSync(pilotJson(repo))).toBe(false)
    })

    test('a full rejudge publishes no tally when it skipped a run (fixture changed since the run), and says which', async () => {
      const { repo, dir } = await plantedPilot({ summary: false })
      await plantSecondRun(dir, { fixture: { id: 'd1', kind: 'dev', hash: 'a'.repeat(64) } })
      const t = io()
      t.io.createJudge = fakeJudge(async () => ({ verdict: 'pass', evidence: evidence('pass') }))
      expect(await main(rejudgeArgs(repo), t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).toContain('002-dev-d1-baseline-r1')
      expect(existsSync(pilotJson(repo))).toBe(false)
    })

    test('manifests that recorded different agent models are refused, and the tally carries the recorded model, not the prereg\'s', async () => {
      const { repo, dir } = await plantedPilot()
      const second = await plantSecondRun(dir, { model: { pinned: 'opencode/agent-y', returned: [] } })
      writeSummary(dirname(dir), REAL_PROMPT, ['001-dev-d1-baseline-r1', '002-dev-d1-baseline-r1'].map((run_id) => ({ run_id, verdict: 'pass', judge_json_sha256: sha256(JUDGE_JSON) })))
      const refused = io()
      expect(await main(tallyOnlyArgs(repo), refused.io)).toBe(EXIT.REFUSED)
      expect(refused.lines.err.join('\n')).toContain('agent model')
      expect(existsSync(pilotJson(repo))).toBe(false)
      rmSync(second, { recursive: true })
      writeSummary(dirname(dir), REAL_PROMPT, [{ run_id: '001-dev-d1-baseline-r1', verdict: 'pass', judge_json_sha256: sha256(JUDGE_JSON) }])
      const ok = io()
      expect(await main(tallyOnlyArgs(repo), ok.io)).toBe(EXIT.OK)
      expect((JSON.parse(readFileSync(pilotJson(repo), 'utf8')) as { agent_model_id: string }).agent_model_id).toBe('opencode/agent-x')
    })

    test('rejudge --prereg on a campaign that is not a pilot is a usage error, before credentials or the judge; review --prereg too', async () => {
      const { repo, dir } = await plantedPilot()
      const { writeManifest, readManifest } = await import('./manifest')
      const redId = 'demo-red-2026-10-24T00-00-00-000Z'
      const plain = join(dirname(dirname(dir)), redId, '001-dev-d1-baseline-r1')
      mkdirSync(plain, { recursive: true })
      const { arm: _arm, ...unarmed } = readManifest(join(dir, 'manifest.json'))
      writeManifest(plain, { ...unarmed, campaign_id: redId })
      for (const argv of [
        ['rejudge', '--campaign', redId, '--repo', repo.dir, '--prereg', PILOT_PREREG],
        ['review', '--campaign', redId, '--repo', repo.dir, '--prereg', PILOT_PREREG],
      ]) {
        const t = io()
        t.io.env.METACOGS_AUTH_CLIPROXY = 'no-such-key' // fetching it would fail with a different message
        t.io.createJudge = (() => {
          throw new Error('the judge must not be built')
        }) as never
        expect(await main(argv, t.io)).toBe(EXIT.USAGE)
        expect(t.lines.err.join('\n')).toContain('--prereg applies to')
      }
      // On the pilot campaign the flag is accepted (the prereg is the one named).
      const t = io()
      expect(await main(['rejudge', '--campaign', CAMPAIGN, '--repo', repo.dir, '--prereg', PILOT_PREREG, '--tally-only'], t.io)).toBe(EXIT.OK)
    })

    test('--tally-only applies to rejudge of a pilot campaign only', async () => {
      const { repo } = await plantedPilot()
      const t = io()
      expect(await main(['review', '--campaign', CAMPAIGN, '--repo', repo.dir, '--tally-only'], t.io)).toBe(EXIT.USAGE)
      expect(t.lines.err.join('\n')).toContain('--tally-only')
    })

    test('a campaign that mixes armed and unarmed manifests is refused before any judge call (with or without --tally-only)', async () => {
      const { repo, dir } = await plantedPilot()
      const { writeManifest, readManifest } = await import('./manifest')
      const plain = join(dirname(dir), '002-dev-d1-baseline-r2')
      mkdirSync(plain, { recursive: true })
      const { arm: _arm, ...unarmed } = readManifest(join(dir, 'manifest.json'))
      writeManifest(plain, { ...unarmed, run_id: '002-dev-d1-baseline-r2' })
      for (const extra of [[], ['--tally-only']]) {
        const t = io()
        t.io.createJudge = (() => {
          throw new Error('the judge must not be built')
        }) as never
        expect(await main([...rejudgeArgs(repo), ...extra], t.io)).toBe(EXIT.REFUSED)
        expect(t.lines.err.join('\n')).toContain('mixes')
      }
      expect(existsSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json'))).toBe(false)
    })

    test('a judge that cannot be reached for any run leaves pilot.json alone', async () => {
      const { repo } = await plantedPilot()
      const t = io()
      t.io.createJudge = fakeJudge(async () => ({ verdict: 'infra_error', kind: 'infra', code: 'timeout' }))
      expect(await main(rejudgeArgs(repo), t.io)).toBe(EXIT.ERROR)
      expect(t.lines.err.join('\n')).toContain('pilot.json was not written')
      expect(existsSync(join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json'))).toBe(false)
    })

    test('a pilot campaign without its pilot prereg is refused, naming the pilot path', async () => {
      const { repo } = await plantedPilot({ prereg: false })
      const t = io()
      t.io.createJudge = fakeJudge(async () => ({ verdict: 'pass' }))
      expect(await main(rejudgeArgs(repo), t.io)).toBe(EXIT.REFUSED)
      expect(t.lines.err.join('\n')).toContain('evals/demo/pilot/prereg.json does not exist')
    })
  })

  test('pilot requires --provider live: a usage error on one line, before credentials, the repo or the prereg are touched', async () => {
    for (const argv of [
      ['pilot', '--method', 'demo', '--repo', '/nonexistent'],
      ['pilot', '--method', 'demo', '--repo', '/nonexistent', '--provider', 'scripted'],
    ]) {
      const t = io()
      t.io.env.METACOGS_AUTH_CLIPROXY = 'no-such-key' // fetching it would fail with a different message
      expect(await main(argv, t.io)).toBe(EXIT.USAGE)
      expect(t.lines.err).toHaveLength(1)
      expect(t.lines.err[0]).toContain('--provider live')
      expect(t.lines.err[0]).not.toContain('\n')
    }
  })

  test('a scripted pilot invocation leaves an existing pilot.json byte-identical', async () => {
    const { repo } = pilotRepo()
    const path = join(repo.dir, 'evals', 'demo', 'pilot', 'pilot.json')
    const sentinel = '{"kept": true}\n'
    repo.write('evals/demo/pilot/pilot.json', sentinel)
    const out = tmp('metacogs-cliout-')
    const t = io()
    expect(await main(['pilot', '--arm', 'baseline', '--provider', 'scripted', '--runs', '1', '--method', 'demo', '--repo', repo.dir, '--out', out], t.io)).toBe(EXIT.USAGE)
    expect(readFileSync(path, 'utf8')).toBe(sentinel)
    expect(readdirSync(out)).toEqual([])
  })
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
      writeManifest(join(campaign, id), { schema_version: 1, run_id: id, campaign_id: campaignId, status: 'completed', reasons: [], method: 'synthesis', condition, fixture: { id: fixture, kind: 'heldout', hash: 'h' }, prereg: { content_hash: 'a'.repeat(64), epoch: 1 } } as never)
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
