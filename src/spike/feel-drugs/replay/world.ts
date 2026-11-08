/** The real world of a replay: a throwaway clone of the repo at the cutoff, gh reads with the owner's auth, and the outward-effect denials. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Needle } from '../../../runner/manifest'
import type { RawExtract } from './extract'

export const HINDSIGHT_NOTE = 'gh reads show current GitHub state'

export class WorldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldError'
  }
}

// ── the repo behind a scenario ─────────────────────────────────────────────

export interface WorldProject {
  /** `owner/name` on GitHub. */
  github: string
  /** The owner's local checkout, under `~/src/github.com`. */
  path: (home: string) => string
}

export const WORLD_PROJECTS: Record<string, WorldProject> = {
  'fro-bot-agent': { github: 'fro-bot/agent', path: (home) => join(home, 'src', 'github.com', 'fro-bot', 'agent') },
  systematic: { github: 'marcusrbrown/systematic', path: (home) => join(home, 'src', 'github.com', 'marcusrbrown', 'systematic') },
  metacogs: { github: 'marcusrbrown/metacogs', path: (home) => join(home, 'src', 'github.com', 'marcusrbrown', 'metacogs') },
}

const GIT_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })

interface GitResult {
  ok: boolean
  out: string
}

/** Runs git; never prints. A failure names the subcommand only, since arguments can be paths. */
function git(cwd: string, args: readonly string[], allowFail = false): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV(), maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new WorldError(`git ${args[0]} failed (exit ${r.status ?? 'null'})`)
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

/** The main working tree of a repo checkout (the first `git worktree list` entry), so a worktree run still clones the main checkout. */
export function mainCheckout(repoRoot: string): string {
  const first = git(repoRoot, ['worktree', 'list', '--porcelain']).out.split('\n').find((l) => l.startsWith('worktree '))
  if (!first) throw new WorldError('git worktree list gave no main checkout')
  return first.slice('worktree '.length)
}

export interface CheckoutContext {
  home?: string
  /** This repo's root: `metacogs` resolves to its main checkout. */
  repoRoot?: string
}

/** Which GitHub repo and which local checkout a scenario project maps to. */
export function checkoutOf(project: string, ctx: CheckoutContext = {}): { github: string; path: string } {
  const known = WORLD_PROJECTS[project]
  if (!known) throw new WorldError(`project ${project}: no local checkout is mapped (known: ${Object.keys(WORLD_PROJECTS).join(', ')})`)
  const path = project === 'metacogs' && ctx.repoRoot ? mainCheckout(ctx.repoRoot) : known.path(ctx.home ?? homedir())
  if (!existsSync(join(path, '.git'))) throw new WorldError(`project ${project}: ${path} is not a git checkout`)
  return { github: known.github, path }
}

// ── which branch the session was on ────────────────────────────────────────

const unquote = (s: string): string => s.replace(/^['"`]|['"`,.;)]+$/g, '').replace(/^origin\//, '')
const isBranchName = (s: string): boolean => /^[\w][\w./+-]*$/.test(s) && s !== 'HEAD' && !s.endsWith('.lock') && !s.includes('..')

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Branch names a tool call or its output names, in the order they appear. */
function branchesIn(tool: string, input: Json, output: string): string[] {
  const found: string[] = []
  const command = typeof input.command === 'string' ? input.command : ''
  for (const m of output.matchAll(/^On branch (\S+)$/gm)) found.push(m[1]!)
  for (const m of output.matchAll(/(?:Switched to (?:a new )?branch|Already on) '([^']+)'/g)) found.push(m[1]!)
  if (tool === 'bash') {
    if (/git\s+status\b[^|;&]*(?:\s-\w*b\w*|--branch)/.test(command)) for (const m of output.matchAll(/^## (\S+?)(?:\.\.\.|$)/gm)) found.push(m[1]!)
    for (const m of command.matchAll(/git\s+(?:checkout|switch)\s+-[bcB]\s+(\S+)/g)) found.push(m[1]!)
    for (const m of command.matchAll(/git\s+worktree\s+add\s+(?:\S+\s+)*?-b\s+(\S+)/g)) found.push(m[1]!)
    if (/git\s+branch\s+--show-current|git\s+rev-parse\s+--abbrev-ref\s+HEAD/.test(command) && /^\S+$/.test(output.trim())) found.push(output.trim())
  }
  return found.map(unquote).filter(isBranchName)
}

/** Branch candidates, most recent first: tool calls up to the cutoff that name a branch, then a `.worktrees/<branch>` directory. */
export function branchHints(raw: RawExtract): string[] {
  const seen: string[] = []
  for (const p of raw.parts) {
    let part: unknown
    try {
      part = JSON.parse(p.data)
    } catch {
      continue
    }
    if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state)) continue
    const state = part.state
    seen.push(...branchesIn(String(part.tool ?? ''), isRecord(state.input) ? state.input : {}, typeof state.output === 'string' ? state.output : ''))
  }
  const directory = /\/\.worktrees\/(.+?)\/?$/.exec(raw.session.directory)?.[1]
  const recentFirst = [...seen].reverse()
  if (directory && isBranchName(directory)) recentFirst.push(directory)
  return [...new Set(recentFirst)]
}

// ── the clone ──────────────────────────────────────────────────────────────

export interface WorldRecord {
  repo: string
  commit: string
  /** `branch`: a named branch had a tip at or before the cutoff. `origin-main`: the newest `origin/main` commit before it. */
  rule: 'branch' | 'origin-main'
  branch?: string
  /** `read`: gh runs with the owner's login, reads only. `none`: no login was given. */
  gh: 'read' | 'none'
  /** The cutoff, ISO. */
  cutoff: string
  /** `origin/main` has no commit that old (a shallow checkout); the oldest it has was used. */
  oldest_available?: true
}

/** What an attempt needs to build its world: the checkout to clone and the moment to clone it at. */
export interface WorldJob {
  /** The owner's checkout. Read only: git clone and fetch read from it, nothing writes to it. */
  source: string
  /** `owner/name`. */
  githubRepo: string
  cutoffMs: number
  hints: readonly string[]
}

export interface CloneInput extends WorldJob {
  /** An empty directory. */
  dest: string
}

const refExists = (cwd: string, ref: string): boolean => git(cwd, ['show-ref', '--verify', '--quiet', ref], true).ok

/** The commit for a moment: rule 1 a named branch with a tip at or before the cutoff, else rule 2 `origin/main` at that time. */
export function resolveTarget(repo: string, cutoffMs: number, hints: readonly string[]): { commit: string; rule: WorldRecord['rule']; branch?: string; oldest?: true } {
  const before = `--before=${new Date(cutoffMs).toISOString()}`
  for (const hint of hints) {
    if (hint === 'main' || hint === 'master') continue
    for (const ref of [`refs/remotes/origin/${hint}`, `refs/heads/${hint}`]) {
      if (!refExists(repo, ref)) continue
      const commit = git(repo, ['rev-list', '-1', before, ref], true).out
      if (commit) return { commit, rule: 'branch', branch: hint }
    }
  }
  const base = ['refs/remotes/origin/main', 'refs/remotes/origin/master'].find((r) => refExists(repo, r))
  if (!base) throw new WorldError('the clone has no origin/main or origin/master')
  const commit = git(repo, ['rev-list', '-1', before, base], true).out
  if (commit) return { commit, rule: 'origin-main' }
  const oldest = git(repo, ['rev-list', base]).out.split('\n').at(-1)
  if (!oldest) throw new WorldError('origin/main has no commits')
  return { commit: oldest, rule: 'origin-main', oldest: true }
}

/** Clones the source into `dest`, checks out the moment, points origin at GitHub, and breaks the push URL. */
export function cloneWorld(input: CloneInput): WorldRecord {
  const { source, dest } = input
  git(dest, ['clone', '--local', '--no-hardlinks', '--no-checkout', source, dest])
  // the source's own remote-tracking refs carry GitHub's branches; the clone only gets its local branches
  git(dest, ['fetch', '--no-tags', source, '+refs/remotes/origin/*:refs/remotes/origin/*'], true)
  const target = resolveTarget(dest, input.cutoffMs, input.hints)
  git(dest, ['checkout', '-q', '-B', target.branch ?? 'main', target.commit])
  git(dest, ['remote', 'set-url', 'origin', `https://github.com/${input.githubRepo}.git`])
  git(dest, ['config', 'remote.origin.pushurl', 'DISABLED'])
  for (const [key, value] of [['user.name', 'replay'], ['user.email', 'replay@example.invalid'], ['commit.gpgsign', 'false'], ['gc.auto', '0']] as const) git(dest, ['config', key, value])
  if (git(dest, ['rev-parse', 'HEAD']).out !== target.commit) throw new WorldError('the clone is not at the resolved commit')
  return {
    repo: input.githubRepo,
    commit: target.commit,
    rule: target.rule,
    ...(target.branch ? { branch: target.branch } : {}),
    gh: 'read',
    cutoff: new Date(input.cutoffMs).toISOString(),
    ...(target.oldest ? { oldest_available: true as const } : {}),
  }
}

// ── gh reads ───────────────────────────────────────────────────────────────

export interface GhAuth {
  /** The `hosts.yml` text the fixture gets. A secret. */
  hosts: string
  /** The token values, for the leak scan. */
  needles: Needle[]
}

export interface GhAuthOptions {
  /** The owner's gh config directory. Default `~/.config/gh`. */
  configDir?: string
  home?: string
  /** Runs the gh binary and returns stdout, or `null` when it fails. */
  run?: (args: readonly string[]) => string | null
}

const defaultRun = (args: readonly string[]): string | null => {
  const r = spawnSync(process.env.METACOGS_GH_BIN ?? 'gh', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0 ? r.stdout : null
}

/** The owner's gh login as a `hosts.yml` for the fixture. Reads the file and, when the token is in the keyring, `gh auth token`. Never prints either. */
export function resolveGhAuth(options: GhAuthOptions = {}): GhAuth {
  const configDir = options.configDir ?? join(options.home ?? homedir(), '.config', 'gh')
  const file = join(configDir, 'hosts.yml')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const inline = [...text.matchAll(/^\s*oauth_token:\s*(\S+)\s*$/gm)].map((m) => m[1]!)
  if (inline.length > 0) return { hosts: text, needles: inline.map((value, i) => ({ label: `gh_token_${i + 1}`, value })) }
  const token = (options.run ?? defaultRun)(['auth', 'token', '--hostname', 'github.com'])?.trim()
  if (!token) throw new WorldError('no gh login: neither hosts.yml nor `gh auth token` gave a token for github.com')
  const user = /^\s{2,}user:\s*(\S+)\s*$/m.exec(text)?.[1]
  return { hosts: `github.com:\n    oauth_token: ${token}\n${user ? `    user: ${user}\n` : ''}    git_protocol: https\n`, needles: [{ label: 'gh_token', value: token }] }
}

/** Writes `<root>/gh/hosts.yml` (0600, in a 0700 directory) and returns the directory for `GH_CONFIG_DIR`. */
export function writeGhConfig(root: string, auth: GhAuth): string {
  const dir = join(root, 'gh')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'hosts.yml'), auth.hosts, { mode: 0o600 })
  return dir
}

export const removeGhConfig = (dir: string): void => rmSync(dir, { recursive: true, force: true })

/** Child-env additions that make gh and git non-interactive and point gh at the fixture config. */
export const ghEnv = (configDir: string): Record<string, string> => ({ GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false', DO_NOT_TRACK: '1', GIT_TERMINAL_PROMPT: '0' })

// ── permissions ────────────────────────────────────────────────────────────

type Action = 'allow' | 'deny'

/** gh verbs that change GitHub (or the login), by command group. `repo`, `release` and `auth` are denied whole. */
const GH_WRITE_VERBS: Record<string, readonly string[]> = {
  pr: ['create', 'merge', 'comment', 'review', 'close', 'reopen', 'edit', 'ready', 'update-branch', 'lock', 'unlock'],
  issue: ['create', 'comment', 'close', 'edit', 'reopen', 'lock', 'unlock', 'delete', 'transfer', 'pin', 'unpin', 'develop'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  label: ['create', 'edit', 'delete', 'clone'],
  gist: ['create', 'edit', 'delete', 'rename'],
  cache: ['delete'],
  config: ['set', 'clear-cache'],
}
const WRAPPERS = ['env', 'command', 'exec', 'nohup', 'xargs', 'sudo', 'time', 'eval', 'bash -c', 'sh -c', 'zsh -c', 'builtin']
const GH_DENIED_WHOLE = ['repo', 'release', 'auth', 'secret', 'variable', 'ssh-key', 'gpg-key', 'codespace', 'extension', 'alias', 'attestation']

/**
 * The shell rules, in order: the last matching rule wins. Everything is allowed first; the outward effects are denied
 * after. `gh api` is read only: no method but GET, and no field or input flag, which would make it a POST.
 */
export function worldBashRules(): Record<string, Action> {
  const rules: Record<string, Action> = { '*': 'allow', 'git push*': 'deny', 'git -* push*': 'deny' }
  for (const [group, verbs] of Object.entries(GH_WRITE_VERBS)) for (const verb of verbs) rules[`gh ${group} ${verb}*`] = 'deny'
  for (const group of GH_DENIED_WHOLE) rules[`gh ${group}*`] = 'deny'
  for (const pattern of ['npm publish*', 'bun publish*', 'pnpm publish*', 'yarn publish*', 'changeset publish*', 'npx changeset publish*', 'bunx changeset publish*']) rules[pattern] = 'deny'
  // a wrapper or an env prefix would hide the command from the rules above, so gh and push behind one are refused
  for (const wrapper of WRAPPERS) {
    rules[`${wrapper}*gh *`] = 'deny'
    rules[`${wrapper}*git *push*`] = 'deny'
  }
  rules['*=* gh *'] = 'deny'
  rules['*=* git *push*'] = 'deny'
  // the login files live outside the clone (gh's hosts.yml, the provider key in auth.json); no command may name them
  rules['*hosts.yml*'] = 'deny'
  rules['*auth.json*'] = 'deny'
  // gh api: a method flag is refused unless it is GET, and then only once
  rules['gh api* -X*'] = 'deny'
  rules['gh api* --method*'] = 'deny'
  rules['gh api* -X GET*'] = 'allow'
  rules['gh api* --method GET*'] = 'allow'
  rules['gh api* --method=GET*'] = 'allow'
  for (const twice of ['gh api* -X*-X*', 'gh api* -X*--method*', 'gh api* --method*-X*', 'gh api* --method*--method*']) rules[twice] = 'deny'
  for (const field of ['gh api* -f*', 'gh api* -F*', 'gh api* --field*', 'gh api* --raw-field*', 'gh api* --input*']) rules[field] = 'deny'
  return rules
}

/** The permission config of a real-world attempt. Subagents inherit it. Edits reach only the clone: anything else is `external_directory`. */
export function worldPermission(): Record<string, unknown> {
  return { external_directory: 'deny', webfetch: 'deny', websearch: 'deny', edit: 'allow', bash: worldBashRules() }
}
