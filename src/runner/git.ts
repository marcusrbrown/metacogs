/**
 * Thin, synchronous git wrapper: repo root, HEAD, worktree status, and the tracked-file check. Read-only: nothing
 * here stages, commits, tags, or moves refs.
 */
import { spawnSync } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/

export class Git {
  constructor(
    readonly repo: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Runs git and returns stdout; throws `GitError` on a non-zero exit unless `allowFailure`. */
  run(args: readonly string[], options: { allowFailure?: boolean } = {}): { stdout: string; status: number } {
    const r = spawnSync('git', ['-C', this.repo, ...args], { encoding: 'utf8', env: this.env })
    const status = r.status ?? -1
    if (status !== 0 && !options.allowFailure) {
      throw new GitError(`git ${args.join(' ')} failed (${status}): ${(r.stderr ?? '').trim()}`, args, r.status)
    }
    return { stdout: r.stdout ?? '', status }
  }

  toplevel(): string {
    return this.run(['rev-parse', '--show-toplevel']).stdout.trim()
  }

  /** Full SHA for `rev`, or `null` when it does not resolve. */
  revParse(rev: string): string | null {
    const r = this.run(['rev-parse', '--verify', '--quiet', rev], { allowFailure: true })
    const sha = r.stdout.trim()
    return r.status === 0 && SHA_PATTERN.test(sha) ? sha : null
  }

  commitOf(rev: string): string | null {
    return this.revParse(`${rev}^{commit}`)
  }

  /** `git status --porcelain` for the given paths; empty string when clean. */
  porcelain(paths: readonly string[]): string {
    return this.run(['status', '--porcelain', '--untracked-files=all', '--', ...paths]).stdout.trim()
  }

  /** True when `path` is in the index (`git ls-files --error-unmatch`). */
  isTracked(path: string): boolean {
    return this.run(['ls-files', '--error-unmatch', '--', path], { allowFailure: true }).status === 0
  }

  head(): string | null {
    return this.commitOf('HEAD')
  }
}
