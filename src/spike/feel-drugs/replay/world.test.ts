import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RawExtract } from './extract'
import { ALLOWED_COMMANDS, cleanupTmp, DENIED_COMMANDS, git, sourceRepo, tmp } from './world-support'
import { branchHints, checkoutOf, cloneWorld, ghEnv, mainCheckout, removeGhConfig, resolveGhAuth, resolveTarget, WORLD_PROJECTS, worldBashRules, WorldError, worldPermission, writeGhConfig } from './world'

afterEach(() => cleanupTmp())

// real git clones: slow under load, so the default 5 s is too tight
setDefaultTimeout(60_000)

const MS = (iso: string): number => Date.parse(iso)

/** The source's refs, HEAD, work-tree status and file names (not the index, which a read can refresh). */
function snapshot(dir: string): string {
  const files = (d: string, prefix = ''): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name), `${prefix}${e.name}/`) : e.name === 'index' ? [] : [`${prefix}${e.name}:${statSync(join(d, e.name)).size}`]))
  return JSON.stringify({ refs: git(dir, ['for-each-ref']), head: git(dir, ['rev-parse', 'HEAD']), status: git(dir, ['status', '--porcelain']), files: files(join(dir, '.git')).sort() })
}

describe('the clone', () => {
  test('rule 1: a branch the session named, at its tip at or before the cutoff', () => {
    const { dir, sha } = sourceRepo()
    const dest = tmp()
    const world = cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS('2026-02-15T00:00:00Z'), hints: ['feat/x'] })
    expect(world).toMatchObject({ repo: 'octo/repo', commit: sha.f1, rule: 'branch', branch: 'feat/x', gh: 'read', cutoff: '2026-02-15T00:00:00.000Z' })
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(sha.f1!)
    expect(git(dest, ['branch', '--show-current'])).toBe('feat/x')
    expect(existsSync(join(dest, 'f1.txt'))).toBe(true)
    expect(existsSync(join(dest, 'f2.txt'))).toBe(false)
  })

  test('a branch that exists only as a remote-tracking ref in the source is found too', () => {
    const { dir, sha } = sourceRepo()
    const world = cloneWorld({ source: dir, dest: tmp(), githubRepo: 'octo/repo', cutoffMs: MS('2026-03-15T00:00:00Z'), hints: ['only-remote'] })
    expect(world).toMatchObject({ rule: 'branch', branch: 'only-remote', commit: sha.f1 })
  })

  test('rule 2: no branch hint, an unknown branch, or main itself uses origin/main at the cutoff', () => {
    const { dir, sha } = sourceRepo()
    for (const [cutoff, hints, want] of [
      ['2026-03-15T00:00:00Z', [], 'c3'],
      ['2026-02-15T00:00:00Z', ['feat/gone'], 'c2'],
      ['2026-02-15T00:00:00Z', ['main', 'master'], 'c2'],
    ] as const) {
      const dest = tmp()
      const world = cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS(cutoff), hints })
      expect(world).toMatchObject({ rule: 'origin-main', commit: sha[want] })
      expect(world.branch).toBeUndefined()
      expect(git(dest, ['rev-parse', 'HEAD'])).toBe(sha[want]!)
    }
  })

  test('rule 2 uses the source remote-tracking main, not a stale local main', () => {
    const { dir, sha } = sourceRepo()
    git(dir, ['update-ref', 'refs/heads/main', sha.c1!])
    const world = cloneWorld({ source: dir, dest: tmp(), githubRepo: 'octo/repo', cutoffMs: MS('2026-03-15T00:00:00Z'), hints: [] })
    expect(world.commit).toBe(sha.c3!)
  })

  test('a cutoff older than the history uses the oldest commit and says so', () => {
    const { dir, sha } = sourceRepo()
    const world = cloneWorld({ source: dir, dest: tmp(), githubRepo: 'octo/repo', cutoffMs: MS('2025-06-01T00:00:00Z'), hints: [] })
    expect(world).toMatchObject({ rule: 'origin-main', commit: sha.c1, oldest_available: true })
  })

  test('origin points at GitHub, the push URL is broken, and a push fails', () => {
    const { dir } = sourceRepo()
    const dest = tmp()
    cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS('2026-03-15T00:00:00Z'), hints: [] })
    expect(git(dest, ['remote', 'get-url', 'origin'])).toBe('https://github.com/octo/repo.git')
    expect(git(dest, ['remote', 'get-url', '--push', 'origin'])).toBe('DISABLED')
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: dest, encoding: 'utf8', timeout: 20_000 })
    expect(push.status).not.toBe(0)
    expect(push.stderr).toContain('DISABLED')
  })

  test('the source checkout is not modified by the clone, a commit in the clone, or a failed push', () => {
    const { dir } = sourceRepo()
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted')
    const before = snapshot(dir)
    const dest = tmp()
    cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS('2026-02-15T00:00:00Z'), hints: ['feat/x'] })
    writeFileSync(join(dest, 'new.txt'), 'x')
    git(dest, ['add', '.'])
    git(dest, ['commit', '-q', '-m', 'in the clone'])
    spawnSync('git', ['push', 'origin', 'feat/x'], { cwd: dest, timeout: 20_000 })
    expect(snapshot(dir)).toBe(before)
    expect(existsSync(join(dest, 'dirty.txt'))).toBe(false)
  })

  test('git commits in the clone work without any global git config', () => {
    const { dir } = sourceRepo()
    const dest = tmp()
    cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS('2026-03-15T00:00:00Z'), hints: [] })
    writeFileSync(join(dest, 'a.txt'), 'a')
    git(dest, ['add', '.'])
    expect(() => git(dest, ['commit', '-q', '-m', 'x'])).not.toThrow()
  })

  test('a failure names the git subcommand and never a path', () => {
    const dest = tmp()
    try {
      cloneWorld({ source: join(tmp(), 'missing'), dest, githubRepo: 'octo/repo', cutoffMs: 0, hints: [] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(WorldError)
      expect((e as Error).message).toBe('git clone failed (exit 128)')
    }
  })
})

describe('resolveTarget', () => {
  test('a branch hint with no commit that old falls through to the next hint and then to main', () => {
    const { dir, sha } = sourceRepo()
    const dest = tmp()
    cloneWorld({ source: dir, dest, githubRepo: 'octo/repo', cutoffMs: MS('2026-03-15T00:00:00Z'), hints: [] })
    expect(resolveTarget(dest, MS('2026-02-15T00:00:00Z'), ['nope', 'feat/x'])).toMatchObject({ commit: sha.f1, branch: 'feat/x' })
  })
})

describe('branch hints', () => {
  const raw = (outputs: { tool?: string; input?: object; output: string }[], directory = '/Users/o/src/repo'): RawExtract => ({
    schema_version: 1,
    session: { id: 'ses', parent_id: null, title: 't', directory, time_created: 1 },
    cutoff: 'msg_9',
    window: null,
    total_messages: 1,
    messages: [],
    compaction_message_ids: [],
    parts: outputs.map((o, i) => ({ id: `p${i}`, message_id: 'm', session_id: 'ses', time_created: i, data: JSON.stringify({ type: 'tool', tool: o.tool ?? 'bash', callID: `c${i}`, state: { status: 'completed', input: o.input ?? {}, output: o.output } }) })),
  })

  test('collects the branches tool calls name, most recent first', () => {
    const hints = branchHints(
      raw([
        { output: "On branch feat/one\nnothing to commit" },
        { input: { command: 'git checkout -b feat/two' }, output: "Switched to a new branch 'feat/two'" },
        { input: { command: 'git status -sb' }, output: '## feat/three...origin/feat/three [ahead 1]\n M a.ts' },
        { input: { command: 'git branch --show-current' }, output: 'feat/four\n' },
        { tool: 'read', output: 'On branch not-a-tool-result-of-git' },
      ]),
    )
    expect(hints.slice(0, 5)).toEqual(['not-a-tool-result-of-git', 'feat/four', 'feat/three', 'feat/two', 'feat/one'])
  })

  test('a markdown heading in a file is not a branch, and a .worktrees directory is the last resort', () => {
    expect(branchHints(raw([{ input: { command: 'cat README.md' }, output: '## Usage\n## feat/not-a-branch' }]))).toEqual([])
    expect(branchHints(raw([{ output: 'On branch feat/live' }], '/o/repo/.worktrees/feat/dir-branch'))).toEqual(['feat/live', 'feat/dir-branch'])
  })

  test('names with shell punctuation or the origin prefix are cleaned, and HEAD is not a branch', () => {
    expect(branchHints(raw([{ input: { command: 'git branch --show-current' }, output: 'HEAD' }, { output: "Already on 'origin/feat/q'" }]))).toEqual(['feat/q'])
  })
})

describe('project mapping', () => {
  test('the three projects map to their GitHub repo and checkout', () => {
    expect(Object.fromEntries(Object.entries(WORLD_PROJECTS).map(([k, v]) => [k, v.github]))).toEqual({ 'fro-bot-agent': 'fro-bot/agent', systematic: 'marcusrbrown/systematic', metacogs: 'marcusrbrown/metacogs' })
    const home = tmp()
    mkdirSync(join(home, 'src/github.com/fro-bot/agent/.git'), { recursive: true })
    expect(checkoutOf('fro-bot-agent', { home })).toEqual({ github: 'fro-bot/agent', path: join(home, 'src/github.com/fro-bot/agent') })
    expect(() => checkoutOf('systematic', { home })).toThrow(/not a git checkout/)
    expect(() => checkoutOf('nope', { home })).toThrow(/no local checkout/)
  })

  test('metacogs resolves to the main checkout from inside a worktree', () => {
    const { dir } = sourceRepo()
    const wt = join(tmp(), 'wt')
    git(dir, ['worktree', 'add', '-q', '-b', 'side', wt])
    expect(mainCheckout(wt)).toBe(mainCheckout(dir))
    expect(checkoutOf('metacogs', { repoRoot: wt }).path).toBe(mainCheckout(dir))
  })
})

describe('gh auth', () => {
  const FAKE = 'gho_FAKE0000000000000000000000000000000000'

  test('an inline token in hosts.yml is used as is and becomes a needle', () => {
    const cfg = tmp()
    writeFileSync(join(cfg, 'hosts.yml'), `github.com:\n    oauth_token: ${FAKE}\n    user: octo\n`)
    const auth = resolveGhAuth({ configDir: cfg, run: () => { throw new Error('gh must not run') } })
    expect(auth.hosts).toContain(FAKE)
    expect(auth.needles).toEqual([{ label: 'gh_token_1', value: FAKE }])
  })

  test('a keyring login asks `gh auth token` and builds a minimal hosts.yml with the user', () => {
    const cfg = tmp()
    writeFileSync(join(cfg, 'hosts.yml'), 'github.com:\n    user: octo\n    git_protocol: ssh\n    users:\n        octo: {}\n')
    const calls: (readonly string[])[] = []
    const auth = resolveGhAuth({ configDir: cfg, run: (args) => (calls.push(args), `${FAKE}\n`) })
    expect(calls).toEqual([['auth', 'token', '--hostname', 'github.com']])
    expect(auth.hosts).toBe(`github.com:\n    oauth_token: ${FAKE}\n    user: octo\n    git_protocol: https\n`)
    expect(auth.needles).toEqual([{ label: 'gh_token', value: FAKE }])
  })

  test('no login is an error that never carries a value', () => {
    expect(() => resolveGhAuth({ configDir: tmp(), run: () => null })).toThrow(WorldError)
  })

  test('the fixture config is 0600 in a 0700 directory and is removed on request', () => {
    const root = tmp()
    const dir = writeGhConfig(root, { hosts: `github.com:\n    oauth_token: ${FAKE}\n`, needles: [] })
    expect(statSync(join(dir, 'hosts.yml')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, 'hosts.yml'), 'utf8')).toContain(FAKE)
    removeGhConfig(dir)
    expect(existsSync(dir)).toBe(false)
    expect(ghEnv(dir)).toMatchObject({ GH_CONFIG_DIR: dir, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' })
    expect(JSON.stringify(ghEnv(dir))).not.toContain(FAKE)
  })
})

// ── the permission rules, evaluated the way the host does: the last matching rule wins ──

/** `*` is any text, `?` one character, and a trailing ` *` also matches the bare command. */
function ruleRegex(pattern: string): RegExp {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, 's')
}
const verdict = (rules: Record<string, string>, command: string): string | undefined => Object.entries(rules).findLast(([pattern]) => ruleRegex(pattern).test(command))?.[1]

describe('the permission rules', () => {
  const rules = worldBashRules()

  test.each(DENIED_COMMANDS)('denies %s', (command) => {
    expect(verdict(rules, command)).toBe('deny')
  })

  test.each(ALLOWED_COMMANDS)('allows %s', (command) => {
    expect(verdict(rules, command)).toBe('allow')
  })

  test('the config denies the outside, the web and nothing is asked', () => {
    const p = worldPermission() as { bash: Record<string, string> } & Record<string, unknown>
    expect(p).toMatchObject({ external_directory: 'deny', webfetch: 'deny', websearch: 'deny', edit: 'allow' })
    expect(Object.values(p.bash).every((v) => v === 'allow' || v === 'deny')).toBe(true)
    expect(Object.keys(p.bash)[0]).toBe('*') // later rules win, so the blanket allow comes first
  })
})
