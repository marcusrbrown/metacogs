// changeset-gate — on a pull request, fail when generated host output or its generator changed and the PR adds no
// changeset. Installs track `main`, so the version (and Claude's update signal) must move with that content, whatever
// the PR does to the version field. Runs only on `pull_request`; the Changesets version PR is exempt by branch.
//
// Env: GITHUB_EVENT_NAME, GITHUB_HEAD_REF, GITHUB_REPOSITORY (all set by Actions) and, passed by ci.yml,
// PR_BASE_SHA (github.event.pull_request.base.sha) and PR_HEAD_REPO (github.event.pull_request.head.repo.full_name).
import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { OWNED_ROOTS } from '../generate/tree'

/** Branch of the Changesets version PR. */
export const VERSION_PR_BRANCH = 'changeset-release/main'

/** Paths whose change needs a changeset: the owned generated roots plus the sources that produce them. */
export const GATED_PREFIXES = [...OWNED_ROOTS, 'src/generate/', 'src/hosts/', 'src/mcp/'] as const

export interface Change {
  /** `git diff --name-status` letter: A, M, D, T. Renames are disabled, so they arrive as a D and an A. */
  status: string
  /** Repo-relative posix path. */
  path: string
}

export interface GateEnv {
  eventName?: string
  headRef?: string
  repository?: string
  headRepo?: string
  baseSha?: string
}

export interface GateDeps {
  env: GateEnv
  /** Files the PR changes relative to `baseSha`. Fetching the base is this function's job. */
  changes: (baseSha: string) => Change[]
  log: (message: string) => void
  error: (message: string) => void
}

export function parseGateEnv(env: Readonly<Record<string, string | undefined>>): GateEnv {
  const pick = (key: string): string | undefined => (env[key] === undefined || env[key] === '' ? undefined : env[key])
  return {
    eventName: pick('GITHUB_EVENT_NAME'),
    headRef: pick('GITHUB_HEAD_REF'),
    repository: pick('GITHUB_REPOSITORY'),
    headRepo: pick('PR_HEAD_REPO'),
    baseSha: pick('PR_BASE_SHA'),
  }
}

export function isGatedPath(path: string): boolean {
  return GATED_PREFIXES.some(prefix => path.startsWith(prefix))
}

/** A new changeset: `.changeset/<name>.md` added directly under the directory, other than its README. */
export function isAddedChangeset({ status, path }: Change): boolean {
  return status === 'A' && /^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md'
}

/**
 * The version PR is exempt by branch name. A fork can pick any branch name, so the head must also be in this
 * repository; a missing repo name fails closed.
 */
function isVersionPr(env: GateEnv): boolean {
  return env.headRef === VERSION_PR_BRANCH && env.headRepo !== undefined && env.headRepo === env.repository
}

/** Returns the process exit code: 0 to pass or skip, 1 to fail or when the diff cannot be read. */
export function runGate(deps: GateDeps): number {
  const { env } = deps
  if (env.eventName !== 'pull_request') {
    deps.log(`changeset-gate: skipped; runs only on pull_request (event: ${env.eventName ?? 'unset'})`)
    return 0
  }
  if (isVersionPr(env)) {
    deps.log(`changeset-gate: ok; ${VERSION_PR_BRANCH} is the Changesets version PR`)
    return 0
  }
  if (env.baseSha === undefined) {
    deps.error('changeset-gate: PR_BASE_SHA is not set; pass github.event.pull_request.base.sha')
    return 1
  }
  let changes: Change[]
  try {
    changes = deps.changes(env.baseSha)
  } catch (error) {
    deps.error(`changeset-gate: could not diff against ${env.baseSha}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const gated = changes.filter(change => isGatedPath(change.path)).map(change => change.path)
  if (gated.length === 0) {
    deps.log('changeset-gate: ok; no generated host output or generator changes')
    return 0
  }
  if (changes.some(isAddedChangeset)) {
    deps.log(`changeset-gate: ok; ${gated.length} gated path(s) changed and a changeset is added`)
    return 0
  }
  deps.error('changeset-gate: this PR changes generated host output or its generator but adds no changeset.')
  deps.error('  Installs track main, so the package version has to move with this content. Run `bunx changeset` and commit the file.')
  deps.error('  Changed paths:')
  for (const path of [...new Set(gated)].sort()) deps.error(`    ${path}`)
  return 1
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** A stalled fetch or diff must fail the gate, not hold the CI job until the platform's own limit. */
export const GIT_TIMEOUT_MS = 120_000

/** `spawnSync`, as far as `git()` uses it; tests pass a stub. */
export type GitRunner = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>

function git(args: string[], cwd: string, run: GitRunner): { status: number | null; stdout: string; stderr: string } {
  // A timed-out child comes back with `error` set, which is thrown below like any other failure to run git.
  const r = run('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS })
  if (r.error) throw new Error(`could not run git: ${r.error.message}`)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
}

/** Parse `git diff --name-status --no-renames -z`: NUL-separated `<status>`, `<path>` pairs. */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split('\0').filter(field => field !== '')
  const changes: Change[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i]![0]!, path: fields[i + 1]! })
  return changes
}

/**
 * Real git reads for a checkout. CI checks out shallow, so the base commit is fetched explicitly (a no-op when
 * it is already present). The diff is two-dot against the base: with the merge ref checked out that is the PR's change.
 */
export function gitChanges(cwd: string, run: GitRunner = spawnSync): (baseSha: string) => Change[] {
  return baseSha => {
    if (!SHA.test(baseSha)) throw new Error(`not a commit SHA: ${JSON.stringify(baseSha)}`)
    if (git(['cat-file', '-e', `${baseSha}^{commit}`], cwd, run).status !== 0) {
      const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', baseSha], cwd, run)
      if (fetched.status !== 0) throw new Error(`git fetch origin ${baseSha} failed: ${fetched.stderr}`)
    }
    const diff = git(['diff', '--name-status', '--no-renames', '-z', baseSha, 'HEAD', '--'], cwd, run)
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`)
    return parseNameStatus(diff.stdout)
  }
}

if (import.meta.main) {
  process.exit(
    runGate({
      env: parseGateEnv(process.env),
      changes: gitChanges(process.cwd()),
      log: message => console.log(message),
      error: message => console.error(message),
    }),
  )
}
