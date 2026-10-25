import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFixture, destroyFixture } from './env'
import { heldoutFingerprints } from './prereg'
import { toolUses } from './events'
import { opencodeAvailability } from './opencode'
import { plantSkill, runOpencode } from './spike/isolation'
import { scriptedProviderConfig } from './scripted-provider'
import {
  assertInstalledSkills,
  buildConfig,
  claimHeldoutRead,
  copySkillDir,
  createRunWorkspace,
  CustodyError,
  hashSkillDir,
  heldoutDir,
  isInside,
  permissionFor,
  type RunWorkspace,
  resolveOutputDir,
  sha256,
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
    const p = permissionFor('skill', 'demo', ['/ws'])
    expect(p.edit).toBe('deny')
    expect(p.external_directory).toBe('deny')
    const bash = p.bash as Record<string, string>
    expect(bash['*']).toBe('deny')
    const allowed = Object.entries(bash).filter(([, v]) => v === 'allow').map(([k]) => k)
    expect(allowed).toContain('node .agents/skills/demo/scripts/record.mjs*')
    expect(allowed).toContain('node "/ws/.agents/skills/demo/scripts/record.mjs*')
    expect(allowed).toContain("node './.agents/skills/demo/scripts/record.mjs*")
    // every allow rule starts with the helper path, so no flag or other script can come first
    expect(allowed.every((k) => /^node ["']?(\.\/|\.agents\/|\/ws\/\.agents\/)/.test(k))).toBe(true)
    expect(allowed.every((k) => k.includes('/demo/scripts/record.mjs'))).toBe(true)
    expect(JSON.stringify(p)).not.toContain('"ask"')
  })
})

describe.skipIf(!opencodeAvailability().available)('the shell allowlist against OpenCode 1.19.4', () => {
  test(
    'the helper runs in every spelling the models used; `node -e`, `--eval`, another script first, other workspaces, and chains are denied',
    async () => {
      const fixture = createFixture('metacogs-permtest-')
      cleanup.push(() => destroyFixture(fixture))
      const real = realpathSync(fixture.workspace)
      const rel = '.agents/skills/demo/scripts/record.mjs'
      const heredoc = (p: string) => `node "${p}" <<'EOF'\n{"a":1}\nEOF`
      const cases: [name: string, command: string, allowed: boolean][] = [
        ['rel', `node ${rel} --file x`, true],
        ['rel dquoted', `node "${rel}"`, true],
        ['rel squoted', `node '${rel}' --file x`, true],
        ['rel ./', `node ./${rel}`, true],
        ['abs', `node ${fixture.workspace}/${rel}`, true],
        ['abs realpath dquoted', `node "${real}/${rel}"`, true],
        ['abs heredoc', heredoc(`${real}/${rel}`), true],
        ['rel heredoc', heredoc(rel), true],
        ['node -e', `node -e "console.log('EVAL_RAN')" ${rel}`, false],
        ['node --eval abs', `node --eval "console.log('EVAL_RAN')" ${real}/${rel}`, false],
        ['node -p', `node -p 1 scripts/record.mjs`, false],
        ['other script then the helper path', `node /tmp/other.js ${real}/${rel}`, false],
        ['same path in another workspace', `node /tmp/elsewhere/${rel}`, false],
        ['chain', `node ${rel}; echo CHAINED`, false],
        ['command substitution', `node ${rel} $(echo SUBST)`, false],
        ['cat of the helper', `cat ${rel}`, false],
      ]
      const outcome = await runOpencode({
        fixture,
        prompt: 'go',
        permission: permissionFor('skill', 'demo', [fixture.workspace, real]),
        prepare: (fx) => {
          const dir = plantSkill(fx.workspace, 'demo', 'body')
          mkdirSync(join(dir, 'scripts'), { recursive: true })
          writeFileSync(join(dir, 'scripts', 'record.mjs'), "console.log('HELPER_RAN')\n")
        },
        steps: [{ toolCalls: cases.map(([name, command], i) => ({ id: `c${i}`, name: 'bash', arguments: { command, description: name } })) }],
      })
      const byCall = new Map(toolUses(outcome.parsed.events).map((t) => [t.callID, t]))
      for (const [i, [name, , allowed]] of cases.entries()) {
        const call = byCall.get(`c${i}`)
        expect(`${name}: ${call?.status === 'completed' ? 'allowed' : 'denied'}`).toBe(`${name}: ${allowed ? 'allowed' : 'denied'}`)
        if (allowed) expect(call?.output).toContain('HELPER_RAN')
        else expect(call?.output ?? '').not.toMatch(/EVAL_RAN|HELPER_RAN|CHAINED|SUBST/)
      }
    },
    300_000,
  )
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
    expect(ws.skill?.files.map((f) => f.path)).toEqual(['SKILL.md']) // the hash covers method text, not the helper
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

describe('run workspace seams (configExtra, permission, skillSource)', () => {
  const scriptedUrl = 'http://127.0.0.1:1/v1'
  const base = (repoRoot: string, extra: Partial<Parameters<typeof createRunWorkspace>[0]> = {}) => {
    const ws = createRunWorkspace({
      repoRoot,
      method: 'demo',
      condition: 'baseline',
      fixtureId: 'f1',
      fixtureText: 'x\n',
      provider: { kind: 'scripted', url: scriptedUrl },
      model: 'a/b',
      ...extra,
    })
    cleanup.push(() => destroyFixture(ws.fixture))
    return ws
  }
  const outsideSkill = (name = 'frames') => {
    const dir = join(tmp('metacogs-outside-skill-'), name)
    mkdirSync(join(dir, 'refs'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`)
    writeFileSync(join(dir, 'refs', 'a.md'), 'ref\n')
    return dir
  }

  test('without the new fields the generated config is byte-identical to the pre-seam construction', () => {
    for (const condition of ['baseline', 'skill'] as const) {
      const ws = base(repoWithSkill(), { condition })
      const roots = [...new Set([ws.fixture.workspace, realpathSync(ws.fixture.workspace)])]
      const legacy = buildConfig({ permission: permissionFor(condition, 'demo', roots), provider: scriptedProviderConfig(scriptedUrl) })
      expect(JSON.stringify(ws.config)).toBe(JSON.stringify(legacy))
      expect(readFileSync(ws.fixture.configPath, 'utf8')).toBe(JSON.stringify(legacy))
      expect(Object.keys(ws.config)).toEqual(['$schema', 'autoupdate', 'share', 'permission', 'provider'])
    }
  })

  test('configExtra lands in the config file the host reads, after the provider block', () => {
    const mcp = { metacog: { type: 'local', command: ['bun', '/abs/server.ts'], enabled: true, timeout: 30000 } }
    const ws = base(repoWithSkill(), { configExtra: { mcp } })
    expect(Object.keys(ws.config).at(-1)).toBe('mcp')
    expect(JSON.parse(readFileSync(ws.fixture.configPath, 'utf8')).mcp).toEqual(mcp)
    expect(ws.env.OPENCODE_CONFIG).toBe(ws.fixture.configPath)
  })

  test('permission replaces permissionFor when given', () => {
    const permission = { edit: 'deny', skill: { '*': 'deny' }, bash: { '*': 'deny' } }
    const ws = base(repoWithSkill(), { permission })
    expect(ws.config.permission).toEqual(permission)
    expect(JSON.parse(readFileSync(ws.fixture.configPath, 'utf8')).permission).toEqual(permission)
  })

  test('skillSource installs a skill from outside skills/<method>/ under its own name', () => {
    const dir = outsideSkill('frames')
    const ws = base(tmp('metacogs-empty-repo-'), { condition: 'skill', skillSource: { name: 'frames', dir } })
    const skills = join(ws.fixture.workspace, '.agents', 'skills')
    expect(readdirSync(skills)).toEqual(['frames'])
    expect(existsSync(join(skills, 'frames', 'refs', 'a.md'))).toBe(true)
    expect(ws.expectedSkills).toEqual(['frames'])
    expect(ws.skill?.sha256).toBe(hashSkillDir(dir).sha256)
  })

  test('skillSource with the baseline condition is refused and leaves no temp dir behind', () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('metacogs-run-'))
    expect(() => base(repoWithSkill(), { condition: 'baseline', skillSource: { name: 'frames', dir: outsideSkill() } })).toThrow(/skillSource/)
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('metacogs-run-'))).toEqual(before)
  })

  test('a skillSource without SKILL.md is an error', () => {
    expect(() => base(repoWithSkill(), { condition: 'skill', skillSource: { name: 'frames', dir: tmp() } })).toThrow(/SKILL.md/)
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

  test('the generated helper under scripts/ is not hashed', () => {
    const repo = repoWithSkill()
    const dir = join(repo, 'skills', 'demo')
    const first = hashSkillDir(dir)
    writeFileSync(join(dir, 'scripts', 'record.mjs'), '// regenerated for another version\n')
    const second = hashSkillDir(dir)
    expect(second.sha256).toBe(first.sha256)
    expect(second.files.map((f) => f.path)).toEqual(['SKILL.md'])
  })

  test('a one-byte change to SKILL.md changes the hash', () => {
    const dir = join(repoWithSkill(), 'skills', 'demo')
    const first = hashSkillDir(dir).sha256
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    writeFileSync(join(dir, 'SKILL.md'), `${text}x`)
    expect(hashSkillDir(dir).sha256).not.toBe(first)
  })

  test('no scripts/, an empty scripts/ and a populated scripts/ all hash alike', () => {
    const make = (scripts: 'none' | 'empty' | 'file'): string => {
      const dir = join(tmp(), 'demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), 'body\n')
      if (scripts !== 'none') mkdirSync(join(dir, 'scripts'))
      if (scripts === 'file') writeFileSync(join(dir, 'scripts', 'record.mjs'), '// helper\n')
      return hashSkillDir(dir).sha256
    }
    expect(make('empty')).toBe(make('none'))
    expect(make('file')).toBe(make('none'))
  })

  test('the helper still ships in the copy', () => {
    const dir = join(repoWithSkill(), 'skills', 'demo')
    const dest = join(tmp(), 'dest')
    copySkillDir(dir, dest)
    expect(existsSync(join(dest, 'scripts', 'record.mjs'))).toBe(true)
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

  test('a held-out dir inside the repo is refused, however it is spelled; one outside is fine', () => {
    const root = tmp('metacogs-r-')
    const outside = tmp()
    expect(() => heldoutDir('m', { METACOGS_HELDOUT_DIR: join(root, 'evals', 'm', 'heldout') }, '/home/u', root)).toThrow(CustodyError)
    expect(() => heldoutDir('m', { METACOGS_HELDOUT_DIR: root }, '/home/u', root)).toThrow(/inside the repository/)
    expect(() => heldoutDir('m', { XDG_STATE_HOME: join(root, 'state') }, '/home/u', root)).toThrow(CustodyError)
    symlinkSync(root, join(outside, 'looks-outside'))
    expect(() => heldoutDir('m', { METACOGS_HELDOUT_DIR: join(outside, 'looks-outside', 'h') }, '/home/u', root)).toThrow(CustodyError)
    expect(heldoutDir('m', { METACOGS_HELDOUT_DIR: join(outside, 'h') }, '/home/u', root)).toBe(join(outside, 'h'))
    // without a repo root there is nothing to compare against
    expect(heldoutDir('m', { METACOGS_HELDOUT_DIR: join(root, 'h') }, '/home/u')).toBe(join(root, 'h'))
  })

  describe('held-out read marker', () => {
    const markerIn = (dir: string, epoch: number) => join(dir, 'heldout', 'm', `${epoch}.read.json`)
    const marker = (campaign: string, texts: string[]) => ({
      campaign_id: campaign,
      started_at: '2026-10-23T00:00:00.000Z',
      prereg_content_hash: 'a'.repeat(64),
      heldout_fingerprints: heldoutFingerprints(texts.map((text) => ({ text }))),
    })

    test('fingerprints are sorted, unsalted sha256 of the canonical text', () => {
      expect(heldoutFingerprints([{ text: 'b\r\n' }, { text: 'a' }])).toEqual([sha256('a\n'), sha256('b\n')].sort())
    })

    test('a new epoch that reuses one held-out file is refused, naming the prior epoch; a disjoint set is claimed', () => {
      const state = tmp()
      claimHeldoutRead(markerIn(state, 1), marker('c1', ['one\n', 'two\n']))
      expect(() => claimHeldoutRead(markerIn(state, 2), marker('c2', ['two\n', 'three\n']))).toThrow(/epoch 1 \(campaign c1\)/)
      expect(existsSync(markerIn(state, 2))).toBe(false)
      claimHeldoutRead(markerIn(state, 2), marker('c2', ['three\n', 'four\n']))
      expect(JSON.parse(readFileSync(markerIn(state, 2), 'utf8')).heldout_fingerprints).toEqual(heldoutFingerprints([{ text: 'three\n' }, { text: 'four\n' }]))
    })

    test('a marker without the field (legacy) records no fingerprints but still blocks its own epoch', () => {
      const state = tmp()
      mkdirSync(join(state, 'heldout', 'm'), { recursive: true })
      writeFileSync(markerIn(state, 1), JSON.stringify({ campaign_id: 'old', started_at: '2026-10-22T00:00:00.000Z', prereg_content_hash: 'b'.repeat(64) }))
      claimHeldoutRead(markerIn(state, 2), marker('c2', ['one\n']))
      expect(() => claimHeldoutRead(markerIn(state, 1), marker('c3', ['zzz\n']))).toThrow(/already read/)
    })

    test('a marker for the same method elsewhere does not count, and an unreadable sibling is ignored', () => {
      const state = tmp()
      claimHeldoutRead(join(state, 'heldout', 'other', '1.read.json'), marker('c1', ['one\n']))
      mkdirSync(join(state, 'heldout', 'm'), { recursive: true })
      writeFileSync(markerIn(state, 1), '{broken')
      claimHeldoutRead(markerIn(state, 2), marker('c2', ['one\n']))
    })
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
