/** The seeded repository: its payload, the git history written from it, what is read back, and the seed's paths. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { canonicalRepo, expectedRepo, finalFiles, inspectRepo, materializeRepo, provideSkills, repoPermission, repoShellEnv, rewriteSeedPaths, treeDigest } from './repo'
import { parseRepo, type RepoPayload, SpecError } from './store'
import { SYNTHETIC_REPO } from './test-support'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'replay-repo-'))
  dirs.push(d)
  return d
}
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`)
  return r.stdout.trim()
}

/** Two commits on two branches, `origin/main` at the first: the shape of a branch under review. */
const BRANCHED: RepoPayload = {
  schema_version: 1,
  systematic_skills: ['ce-review'],
  commits: [
    { message: 'base', date: '2026-11-09T09:00:00Z', branch: 'main', files: { 'src/job.ts': 'export const job = 1\n', 'AGENTS.md': '# AGENTS.md\n' } },
    { message: 'feat: change the job', date: '2026-11-10T09:00:00Z', branch: 'feat/retry', files: { 'src/job.ts': 'export const job = 2\n', 'src/retry.ts': 'export {}\n' } },
  ],
  origin_main_after: 0,
}

describe('parseRepo', () => {
  test('takes a payload and gives back the same fields in the same order, with no value of its own added', () => {
    expect(parseRepo(JSON.parse(JSON.stringify(BRANCHED)))).toEqual(BRANCHED)
    expect(Object.keys(parseRepo(BRANCHED))).toEqual(['schema_version', 'systematic_skills', 'commits', 'origin_main_after'])
    expect(parseRepo(SYNTHETIC_REPO)).toEqual(SYNTHETIC_REPO)
  })

  const bad = (over: Record<string, unknown>) => ({ ...BRANCHED, ...over })
  const commit = (over: Record<string, unknown>) => bad({ commits: [{ ...BRANCHED.commits[0]!, ...over }] })
  const cases: [string, unknown, string][] = [
    ['an extra field', bad({ extra: 1 }), 'repo.extra'],
    ['a wrong schema version', bad({ schema_version: 2 }), 'repo.schema_version'],
    ['no commits', bad({ commits: [] }), 'repo.commits'],
    ['a commit with no files', commit({ files: {} }), 'files'],
    ['an absolute path', commit({ files: { '/etc/passwd': 'x' } }), 'relative path'],
    ['a parent segment', commit({ files: { '../escape.txt': 'x' } }), 'relative path'],
    ['a path that is not in normal form', commit({ files: { 'src//a.ts': 'x' } }), 'relative path'],
    ['a path into .git', commit({ files: { '.git/hooks/pre-commit': 'x' } }), '.git'],
    ['a path into .systematic', commit({ files: { '.systematic/skills/x/SKILL.md': 'x' } }), '.systematic'],
    ['a file whose content is not a string', commit({ files: { 'a.txt': 1 } }), 'string'],
    ['a date that is not UTC seconds', commit({ date: '2026-11-09' }), 'date'],
    ['a branch name with a parent segment', commit({ branch: 'a..b' }), 'branch'],
    ['an origin/main index past the commits', bad({ origin_main_after: 2 }), 'origin_main_after'],
    ['a skill name with a path in it', bad({ systematic_skills: ['../x'] }), 'systematic_skills'],
    ['a repeated skill name', bad({ systematic_skills: ['ce-plan', 'ce-plan'] }), 'repeated'],
  ]
  for (const [name, input, field] of cases) {
    test(`refuses ${name}, naming the field and never the value`, () => {
      let error: unknown
      try {
        parseRepo(input)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(SpecError)
      expect((error as Error).message).toContain(field)
      expect((error as Error).message).not.toContain('passwd')
    })
  }
})

describe('the payload hash and the tree digest', () => {
  test('the same payload hashes the same, and any change to a file, a message or the skills changes the payload hash', () => {
    const base = expectedRepo(BRANCHED)
    expect(expectedRepo(parseRepo(JSON.parse(canonicalRepo(BRANCHED))))).toEqual(base)
    const edited = structuredClone(BRANCHED)
    edited.commits[1]!.files['src/retry.ts'] = 'export const x = 1\n'
    expect(expectedRepo(edited).payload_sha256).not.toBe(base.payload_sha256)
    expect(expectedRepo(edited).tree_sha256).not.toBe(base.tree_sha256)
    const renamed = structuredClone(BRANCHED)
    renamed.commits[1]!.message = 'feat: other'
    expect(expectedRepo(renamed).payload_sha256).not.toBe(base.payload_sha256)
    expect(expectedRepo(renamed).tree_sha256).toBe(base.tree_sha256)
  })

  test('the working tree is the last write of each path, and the digest does not depend on order', () => {
    expect([...finalFiles(BRANCHED)].sort()).toEqual([['AGENTS.md', '# AGENTS.md\n'], ['src/job.ts', 'export const job = 2\n'], ['src/retry.ts', 'export {}\n']])
    expect(expectedRepo(BRANCHED)).toMatchObject({ files: 3, commits: 2, skill_dirs: ['ce-review'] })
    expect(treeDigest(new Map([['a', '1'], ['b', '2']]))).toBe(treeDigest(new Map([['b', '2'], ['a', '1']])))
    expect(treeDigest(new Map([['a', '1'], ['b', '2']]))).not.toBe(treeDigest(new Map([['a', '1'], ['b', '3']])))
  })
})

describe('materializeRepo', () => {
  test('writes the files and a real history: branches, origin/main, a merge base, a diff, and a clean tree', () => {
    const dest = scratch()
    const ids = materializeRepo(dest, BRANCHED)
    expect(readFileSync(join(dest, 'src/job.ts'), 'utf8')).toBe('export const job = 2\n')
    expect(readFileSync(join(dest, 'AGENTS.md'), 'utf8')).toBe('# AGENTS.md\n')
    expect(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/retry')
    expect(git(dest, 'rev-parse', 'origin/main')).toBe(ids[0]!)
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(ids[1]!)
    expect(git(dest, 'merge-base', 'HEAD', 'origin/main')).toBe(ids[0]!)
    expect(git(dest, 'diff', '--name-only', 'origin/main').split('\n')).toEqual(['src/job.ts', 'src/retry.ts'])
    expect(git(dest, 'log', '--format=%s', 'origin/main..HEAD')).toBe('feat: change the job')
    expect(git(dest, 'status', '--porcelain')).toBe('')
    expect(git(dest, 'log', '-1', '--format=%an <%ae> %at %ct')).toBe(`fixture <fixture@example.invalid> ${Date.parse('2026-11-10T09:00:00Z') / 1000} ${Date.parse('2026-11-10T09:00:00Z') / 1000}`)
  })

  test('the same payload gives the same commit ids in any directory', () => {
    const a = scratch()
    const b = scratch()
    expect(materializeRepo(a, BRANCHED)).toEqual(materializeRepo(b, BRANCHED))
  })

  test('a single-commit payload stays on main and has no origin/main', () => {
    const dest = scratch()
    materializeRepo(dest, SYNTHETIC_REPO)
    expect(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/main'], { cwd: dest }).status).not.toBe(0)
  })
})

describe('inspectRepo', () => {
  const skillsDir = (): string => {
    const dir = join(scratch(), 'skills')
    mkdirSync(join(dir, 'ce-review', 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'ce-review', 'SKILL.md'), '# ce-review\n')
    writeFileSync(join(dir, 'ce-review', 'scripts', 'validate-review.mjs'), 'export {}\n')
    return dir
  }

  test('reads back what the payload says, with the provided skills beside it and left out of the tree and of git status', () => {
    const dest = scratch()
    materializeRepo(dest, BRANCHED)
    provideSkills(dest, skillsDir(), BRANCHED.systematic_skills)
    const report = inspectRepo(dest, BRANCHED)
    expect(report).toMatchObject({ ...expectedRepo(BRANCHED), branch: 'feat/retry', clean: true, skill_files: 2 })
    expect(report.head).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(dest, '.systematic/skills/ce-review/scripts/validate-review.mjs'), 'utf8')).toBe('export {}\n')
  })

  test('a missing file, an extra file, an edited file or an uncommitted change shows in the report', () => {
    const want = expectedRepo(BRANCHED)
    const fresh = (): string => {
      const dest = scratch()
      materializeRepo(dest, BRANCHED)
      provideSkills(dest, skillsDir(), BRANCHED.systematic_skills)
      return dest
    }
    const missing = fresh()
    rmSync(join(missing, 'src/retry.ts'))
    expect(inspectRepo(missing, BRANCHED)).toMatchObject({ files: 2, clean: false })
    expect(inspectRepo(missing, BRANCHED).tree_sha256).not.toBe(want.tree_sha256)
    const extra = fresh()
    writeFileSync(join(extra, 'stray.txt'), 'x')
    expect(inspectRepo(extra, BRANCHED).files).toBe(4)
    const edited = fresh()
    writeFileSync(join(edited, 'src/job.ts'), 'export const job = 3\n')
    expect(inspectRepo(edited, BRANCHED)).toMatchObject({ files: 3, clean: false })
    expect(inspectRepo(edited, BRANCHED).tree_sha256).not.toBe(want.tree_sha256)
  })

  test('a skill directory that did not arrive is not listed', () => {
    const bare = scratch()
    materializeRepo(bare, BRANCHED)
    expect(inspectRepo(bare, BRANCHED)).toMatchObject({ skill_dirs: [], skill_files: 0 })
  })
})

describe('provideSkills', () => {
  test('names the skill that is missing from the installed package', () => {
    const dest = scratch()
    const empty = scratch()
    expect(() => provideSkills(dest, empty, ['ce-plan'])).toThrow('ce-plan/SKILL.md is missing')
  })
})

describe('rewriteSeedPaths', () => {
  const WS = '/private/var/tmp/replay-run-x/workspace'

  test('points every /workspace in the seed at the real workspace: read paths, cwd, skill base directories and file URLs', () => {
    const seed = {
      info: { directory: WS },
      messages: [
        { info: { path: { cwd: '/workspace', root: '/workspace' } }, parts: [{ type: 'tool', state: { input: { filePath: '/workspace/src/a.ts' }, output: '<path>/workspace/src/a.ts</path>' } }] },
        { parts: [{ text: 'Base directory for this skill: file:///workspace/.systematic/skills/ce-plan\nSKILL_DIR="/workspace/.systematic/skills/ce-review"' }] },
      ],
    }
    const moved = rewriteSeedPaths(seed, WS)
    const text = JSON.stringify(seed)
    expect(text).not.toMatch(/(?<![\w./-])\/workspace(?![\w-])/)
    expect(text).toContain(`"${WS}/src/a.ts"`)
    expect(text).toContain(`file://${WS}/.systematic/skills/ce-plan`)
    expect(text).toContain(`SKILL_DIR=\\"${WS}/.systematic/skills/ce-review\\"`)
    expect(seed.messages[0]!.info!.path).toEqual({ cwd: WS, root: WS })
    expect(moved).toBe(6)
    expect(rewriteSeedPaths(seed, WS)).toBe(0)
  })

  test('leaves other words and paths alone: a workspace without the leading root, a directory that only ends in workspace, a longer name', () => {
    const seed = { a: 'surfaced the workspace may differ', b: '<workspace or repo>', c: 'src/workspace/index.ts', d: '/home/x/workspace/a', e: '/workspaces/a', f: '/workspace-old/a' }
    const before = structuredClone(seed)
    expect(rewriteSeedPaths(seed, WS)).toBe(0)
    expect(seed).toEqual(before)
  })
})

describe('repoPermission', () => {
  test('keeps question and task denied, allows a shell, and keeps pushes and gh refused', () => {
    const p = repoPermission() as { question: string; task: string; external_directory: string; bash: Record<string, string> }
    expect(p).toMatchObject({ question: 'deny', task: 'deny', external_directory: 'deny' })
    expect(p.bash['*']).toBe('allow')
    expect(p.bash['git push*']).toBe('deny')
    expect(p.bash['gh pr create*']).toBe('deny')
  })

  test('with no readable directory every outside path stays refused, as before', () => {
    expect(repoPermission().external_directory).toBe('deny')
    expect(repoPermission([]).external_directory).toBe('deny')
  })

  test('a readable directory is allowed after a blanket deny, so only it opens and the later rule wins', () => {
    const rules = (repoPermission(['/cache/skills', '/real/cache/skills']) as { external_directory: Record<string, string> }).external_directory
    expect(Object.keys(rules)).toEqual(['*', '/cache/skills/*', '/real/cache/skills/*'])
    expect(rules).toEqual({ '*': 'deny', '/cache/skills/*': 'allow', '/real/cache/skills/*': 'allow' })
  })

  test('opening the skills never loosens the other rules', () => {
    const { external_directory: _open, ...restOpen } = repoPermission(['/cache/skills']) as Record<string, unknown>
    const { external_directory: _shut, ...restShut } = repoPermission() as Record<string, unknown>
    expect(restOpen).toEqual(restShut)
  })
})

describe('repoShellEnv', () => {
  test('puts zsh heredoc temp files under the attempt temp dir, where the write sandbox allows them', () => {
    expect(repoShellEnv('/fx/tmp')).toEqual({ TMPPREFIX: '/fx/tmp/zsh' })
  })
})
