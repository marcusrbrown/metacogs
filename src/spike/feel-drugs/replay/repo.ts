/**
 * The seeded repository of a workflow attempt: the files and git history the seed's tool calls read, written into the attempt's
 * workspace, checked against what the fixture declares, and the seed's `/workspace` paths pointed at the real workspace path.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { sha256 } from '../../../runner/workspace'
import type { RepoPayload } from './store'
import { worldPermission } from './world'

/** Where a seed says its workspace is. The attempt's real workspace is a throwaway directory. */
export const SEED_ROOT = '/workspace'
/** Where the seed's skill-text paths point inside the workspace. */
export const SKILLS_DIR_IN_WORKSPACE = '.systematic/skills'

export const canonicalRepo = (payload: RepoPayload): string => `${JSON.stringify(payload, null, 2)}\n`

/** The state of the working tree after the last commit: later commits overwrite earlier files. */
export function finalFiles(payload: RepoPayload): Map<string, string> {
  const files = new Map<string, string>()
  for (const commit of payload.commits) for (const [path, text] of Object.entries(commit.files)) files.set(path, text)
  return files
}

/** One line per file, in path order: the path and the hash of its bytes. The same digest is taken from the payload and from the disk. */
export function treeDigest(files: ReadonlyMap<string, string>): string {
  const lines = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, text]) => `${path}\0${sha256(text)}\n`)
  return sha256(lines.join(''))
}

/** What a fixture says its workspace holds. */
export interface RepoExpectation {
  payload_sha256: string
  tree_sha256: string
  files: number
  commits: number
  skill_dirs: string[]
}

/** What the host found in the workspace after it wrote the repository. */
export interface RepoReport extends RepoExpectation {
  head: string
  branch: string
  /** `git status` lists nothing. */
  clean: boolean
  /** Files under the provided skill directories. */
  skill_files: number
  /** `/workspace` occurrences in the seed that were pointed at the real workspace. */
  seed_path_rewrites: number
}

export function expectedRepo(payload: RepoPayload): RepoExpectation {
  return { payload_sha256: sha256(canonicalRepo(payload)), tree_sha256: treeDigest(finalFiles(payload)), files: finalFiles(payload).size, commits: payload.commits.length, skill_dirs: [...payload.systematic_skills] }
}

// ── writing it ─────────────────────────────────────────────────────────────

const BASE_ENV = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', TZ: 'UTC', LC_ALL: 'C' })

export class RepoError extends Error {
  override name = 'RepoError'
}

/** Runs git without the owner's git config; a failure names the subcommand, never an argument. */
function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...BASE_ENV(), ...env }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new RepoError(`git ${args[0]} failed (exit ${r.status ?? 'null'})`)
  return r.stdout.trim()
}

/**
 * Writes the payload into an empty directory: one git commit per payload commit, with a fixed identity and the payload's dates,
 * so the same payload always gives the same history. `refs/remotes/origin/main` is pinned where the payload says, and
 * `.systematic/` is kept out of `git status`. Returns each commit's id.
 */
export function materializeRepo(dest: string, payload: RepoPayload): string[] {
  git(dest, ['init', '-q', '-b', payload.commits[0]?.branch ?? 'main'])
  const ids: string[] = []
  let current = payload.commits[0]?.branch ?? 'main'
  for (const commit of payload.commits) {
    const branch = commit.branch ?? current
    if (branch !== current) {
      git(dest, ['checkout', '-q', '-b', branch])
      current = branch
    }
    for (const [path, text] of Object.entries(commit.files)) {
      mkdirSync(dirname(join(dest, path)), { recursive: true })
      writeFileSync(join(dest, path), text)
    }
    git(dest, ['add', '-A'])
    const who = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: commit.date }
    git(dest, ['commit', '-q', '-m', commit.message], who)
    ids.push(git(dest, ['rev-parse', 'HEAD']))
  }
  if (payload.origin_main_after !== undefined) git(dest, ['update-ref', 'refs/remotes/origin/main', ids[payload.origin_main_after]!])
  appendFileSync(join(dest, '.git', 'info', 'exclude'), '/.systematic/\n')
  return ids
}

/** Copies the named skill directories of an installed Systematic package to `.systematic/skills/<name>`, where the seed's paths point. */
export function provideSkills(dest: string, installedSkillsDir: string, names: readonly string[]): void {
  for (const name of names) {
    const from = join(installedSkillsDir, name)
    if (!existsSync(join(from, 'SKILL.md'))) throw new RepoError(`systematic skills: ${name}/SKILL.md is missing from the installed package`)
    cpSync(from, join(dest, SKILLS_DIR_IN_WORKSPACE, name), { recursive: true })
  }
}

// ── reading it back ────────────────────────────────────────────────────────

const LEFT_OUT = new Set(['.git', '.systematic'])

function walk(root: string, dir = '', out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (dir === '' && LEFT_OUT.has(entry.name)) continue
    if (entry.isDirectory()) walk(root, rel, out)
    else if (entry.isFile()) out.set(rel, readFileSync(join(root, rel), 'utf8'))
  }
  return out
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1), 0)
}

/** What the workspace holds right now, read from the disk and from git: the same fields a fixture's expectation names. */
export function inspectRepo(dest: string, payload: RepoPayload, seedPathRewrites = 0): RepoReport {
  const files = walk(dest)
  const skillRoot = join(dest, SKILLS_DIR_IN_WORKSPACE)
  const skill_dirs = payload.systematic_skills.filter((name) => existsSync(join(skillRoot, name, 'SKILL.md')))
  return {
    payload_sha256: sha256(canonicalRepo(payload)),
    tree_sha256: treeDigest(files),
    files: files.size,
    commits: Number(git(dest, ['rev-list', '--all', '--count'])),
    skill_dirs,
    head: git(dest, ['rev-parse', 'HEAD']),
    branch: git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']),
    clean: git(dest, ['status', '--porcelain']) === '',
    skill_files: skill_dirs.reduce((n, name) => n + countFiles(join(skillRoot, name)), 0),
    seed_path_rewrites: seedPathRewrites,
  }
}

// ── the seed's paths ───────────────────────────────────────────────────────

/**
 * Points the seed's `/workspace` at the attempt's real workspace path, in every string of the export. A seeded read of
 * `/workspace/src/a.ts` becomes a read of a file that exists, inside the project the host allows. Returns how many places moved.
 */
export function rewriteSeedPaths(seed: unknown, workspace: string): number {
  let count = 0
  const swap = (text: string): string =>
    text.replaceAll(`file://${SEED_ROOT}`, () => ((count += 1), `file://${workspace}`)).replace(/(?<![\w./-])\/workspace(?![\w-])/g, () => ((count += 1), workspace))
  const walkValue = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v)
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        v[i] = walkValue(x)
      })
      return v
    }
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) o[k] = walkValue(o[k])
      return o
    }
    return v
  }
  walkValue(seed)
  return count
}

// ── the host's rules for such an attempt ───────────────────────────────────

/**
 * The seeded sessions ran git, a skill's helper scripts and file tools in a real repository, so a seeded attempt gets a shell too:
 * the real-world permission set (no pushes, `gh`, publishes or login files), with `question` and `task` denied as on the workflow
 * stack. The host runs it write-confined to the fixture, as in a real-world attempt.
 */
export const repoPermission = (readable: readonly string[] = []): Record<string, unknown> => ({
  ...worldPermission(),
  question: 'deny',
  task: 'deny',
  // The skills a seeded session loads point at their installed files. Only those directories open: the blanket deny comes first and the later rules win.
  ...(readable.length > 0 ? { external_directory: { '*': 'deny', ...Object.fromEntries(readable.map((dir) => [`${dir}/*`, 'allow'])) } } : {}),
})

/** zsh writes a heredoc's temp file under `TMPPREFIX` (default `/tmp/zsh`), which the write sandbox refuses. Pointing it at the attempt's own temp dir lets a heredoc run. */
export const repoShellEnv = (tmpDir: string): Record<string, string> => ({ TMPPREFIX: join(tmpDir, 'zsh') })
