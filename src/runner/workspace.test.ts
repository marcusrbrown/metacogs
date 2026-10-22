import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { destroyFixture } from './env'
import {
  assertInstalledSkills,
  copySkillDir,
  createRunWorkspace,
  CustodyError,
  hashSkillDir,
  heldoutDir,
  isInside,
  permissionFor,
  type RunWorkspace,
  resolveOutputDir,
  stateRoot,
} from './workspace'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function tmp(prefix = 'metacogs-wstest-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function repoWithSkill(): string {
  const repo = tmp('metacogs-wsrepo-')
  mkdirSync(join(repo, 'skills', 'demo', 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: x\n---\nbody\n')
  writeFileSync(join(repo, 'skills', 'demo', 'scripts', 'record.mjs'), '// helper\n')
  // A sibling skill that must never be copied.
  mkdirSync(join(repo, 'skills', 'other'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'other', 'SKILL.md'), 'other\n')
  return repo
}

function workspace(condition: 'baseline' | 'skill', repoRoot = repoWithSkill()): RunWorkspace {
  const ws = createRunWorkspace({
    repoRoot,
    method: 'demo',
    condition,
    fixtureId: 'f1',
    fixtureText: 'the fixture\n',
    provider: { kind: 'scripted', url: 'http://127.0.0.1:1/v1' },
    model: 'a/b',
  })
  cleanup.push(() => destroyFixture(ws.fixture))
  return ws
}

describe('permissions', () => {
  test('baseline denies every skill; skill condition allows exactly the method', () => {
    expect((permissionFor('baseline', 'demo').skill as object)).toEqual({ '*': 'deny' })
    expect((permissionFor('skill', 'demo').skill as object)).toEqual({ '*': 'deny', demo: 'allow' })
  })

  test('edit/external_directory denied, bash allowlist is the helper only, no ask rules anywhere', () => {
    const p = permissionFor('skill', 'demo')
    expect(p.edit).toBe('deny')
    expect(p.external_directory).toBe('deny')
    expect(p.bash).toEqual({ '*': 'deny', 'node *scripts/record.mjs*': 'allow' })
    expect(JSON.stringify(p)).not.toContain('"ask"')
  })
})

describe('run workspace', () => {
  test('baseline: git-init\'d workspace holding only the fixture, no skills', () => {
    const ws = workspace('baseline')
    expect(existsSync(join(ws.fixture.workspace, '.git'))).toBe(true)
    expect(readdirSync(ws.fixture.workspace).sort()).toEqual(['.git', 'fixture.md'])
    expect(readFileSync(join(ws.fixture.workspace, 'fixture.md'), 'utf8')).toBe('the fixture\n')
    expect(ws.expectedSkills).toEqual([])
    expect(ws.skill).toBeNull()
  })

  test('skill: copies exactly skills/<method>/ and nothing else', () => {
    const ws = workspace('skill')
    const skills = join(ws.fixture.workspace, '.agents', 'skills')
    expect(readdirSync(skills)).toEqual(['demo'])
    expect(existsSync(join(skills, 'demo', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(skills, 'demo', 'scripts', 'record.mjs'))).toBe(true)
    expect(ws.expectedSkills).toEqual(['demo'])
    expect(ws.skill?.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/record.mjs'])
  })

  test('generated config is the only config channel and carries the permission set', () => {
    const ws = workspace('skill')
    expect(ws.env.OPENCODE_CONFIG).toBe(ws.fixture.configPath)
    expect(ws.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(JSON.parse(readFileSync(ws.fixture.configPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(ws.config)))
    expect(ws.env.METACOGS_RECORDS_DIR).toBe(ws.fixture.recordsDir)
    expect(ws.fixture.recordsDir.startsWith(`${ws.fixture.workspace}/`)).toBe(true)
  })

  test('decoys sit outside the workspace and the child HOME', () => {
    const ws = workspace('baseline')
    expect(ws.decoys.authorHome.startsWith(ws.fixture.workspace)).toBe(false)
    expect(ws.decoys.authorHome).not.toBe(ws.fixture.home)
    expect(ws.env.HOME).toBe(ws.fixture.home)
    expect(Object.keys(ws.decoys.needles)).toContain('sentinel_agents_md')
  })

  test('a missing skill is an error, not a silent baseline, and leaves no temp dir behind', () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('metacogs-run-'))
    expect(() => workspace('skill', tmp('metacogs-empty-repo-'))).toThrow(/skills\/demo\/SKILL.md/)
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('metacogs-run-'))).toEqual(before)
  })

  test('installed skills must match exactly', () => {
    const ws = workspace('skill')
    expect(() => assertInstalledSkills(ws.fixture.workspace, [])).toThrow(/mismatch/)
    expect(() => assertInstalledSkills(ws.fixture.workspace, ['demo'])).not.toThrow()
  })
})

describe('skill hashing and copying', () => {
  test('hash is stable, order-independent, and content-sensitive', () => {
    const repo = repoWithSkill()
    const dir = join(repo, 'skills', 'demo')
    const first = hashSkillDir(dir).sha256
    expect(hashSkillDir(dir).sha256).toBe(first)
    writeFileSync(join(dir, 'SKILL.md'), 'changed\n')
    expect(hashSkillDir(dir).sha256).not.toBe(first)
  })

  test('symlinks are refused', () => {
    const repo = repoWithSkill()
    const dir = join(repo, 'skills', 'demo')
    symlinkSync('/etc/hosts', join(dir, 'link'))
    expect(() => hashSkillDir(dir)).toThrow(/symlink/)
    expect(() => copySkillDir(dir, join(tmp(), 'dest'))).toThrow(/symlink/)
  })
})

describe('custody', () => {
  const repo = '/repo/metacogs'

  test('state root: XDG_STATE_HOME wins, else ~/.local/state', () => {
    expect(stateRoot({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe('/x/state/metacogs')
    expect(stateRoot({}, '/home/u')).toBe('/home/u/.local/state/metacogs')
    expect(stateRoot({ XDG_STATE_HOME: 'relative' }, '/home/u')).toBe('/home/u/.local/state/metacogs')
  })

  test('held-out dir: override, else state root', () => {
    expect(heldoutDir('m', { METACOGS_HELDOUT_DIR: '/h' }, '/home/u')).toBe('/h')
    expect(heldoutDir('m', {}, '/home/u')).toBe('/home/u/.local/state/metacogs/heldout/m')
  })

  test('held-out output defaults under the state root', () => {
    const state = tmp()
    const dir = resolveOutputDir({ repoRoot: tmp('metacogs-r-'), campaignId: 'c1', heldout: true, env: { XDG_STATE_HOME: state } })
    expect(dir).toBe(join(state, 'metacogs', 'runs', 'c1'))
  })

  test('held-out output dir inside the repo is refused (via XDG_STATE_HOME and via --out)', () => {
    const root = tmp('metacogs-r-')
    expect(() => resolveOutputDir({ repoRoot: root, campaignId: 'c', heldout: true, env: { XDG_STATE_HOME: join(root, 'state') } })).toThrow(CustodyError)
    expect(() => resolveOutputDir({ repoRoot: root, campaignId: 'c', heldout: true, outRoot: join(root, 'evals', 'runs') })).toThrow(/inside the repository/)
  })

  test('a symlink that leads into the repo does not launder the path', () => {
    const root = tmp('metacogs-r-')
    const elsewhere = tmp()
    symlinkSync(root, join(elsewhere, 'looks-outside'))
    expect(isInside(join(elsewhere, 'looks-outside', 'runs'), root)).toBe(true)
    expect(() => resolveOutputDir({ repoRoot: root, campaignId: 'c', heldout: true, outRoot: join(elsewhere, 'looks-outside', 'runs') })).toThrow(CustodyError)
  })

  test('dev runs default to the gitignored evals/runs and may live in the repo', () => {
    expect(resolveOutputDir({ repoRoot: repo, campaignId: 'c', heldout: false })).toBe(`${repo}/evals/runs/c`)
  })
})
