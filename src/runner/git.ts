/**
 * Thin, synchronous git wrapper for preregistration checks. Read-only: nothing
 * here stages, commits, tags, or moves refs.
 */
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative } from 'node:path'

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

export interface TagInfo {
  /** SHA of the tag object (annotated) or of the commit (lightweight). */
  objectSha: string
  annotated: boolean
  commitSha: string
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

  /** `merge-base --is-ancestor a b`: true when `a` is `b` or reachable from it. */
  isAncestorOrEqual(a: string, b: string): boolean {
    return this.run(['merge-base', '--is-ancestor', a, b], { allowFailure: true }).status === 0
  }

  /** Strict ancestry: ancestor and not the same commit. */
  isStrictAncestor(a: string, b: string): boolean {
    const ca = this.commitOf(a)
    const cb = this.commitOf(b)
    return ca !== null && cb !== null && ca !== cb && this.isAncestorOrEqual(ca, cb)
  }

  tag(name: string): TagInfo | null {
    const ref = `refs/tags/${name}`
    const objectSha = this.revParse(ref)
    if (!objectSha) return null
    const type = this.run(['cat-file', '-t', objectSha]).stdout.trim()
    const commitSha = this.commitOf(ref)
    if (!commitSha) return null
    return { objectSha, annotated: type === 'tag', commitSha }
  }

  parents(commit: string): string[] {
    const line = this.run(['rev-list', '--parents', '-n', '1', commit]).stdout.trim().split(' ')
    return line.slice(1)
  }

  /** Files changed by `commit` relative to its (single) parent; root commits list everything. */
  touchedFiles(commit: string): string[] {
    return this.run(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit])
      .stdout.split('\n')
      .filter(Boolean)
  }

  /**
   * `git rev-list --reverse --topo-order [<base>..]HEAD -- <paths>`: commits
   * (oldest first) that touched any of `paths`.
   */
  commitsTouching(base: string | null, paths: readonly string[]): string[] {
    const range = base ? `${base}..HEAD` : 'HEAD'
    return this.run(['rev-list', '--reverse', '--topo-order', range, '--', ...paths])
      .stdout.split('\n')
      .filter(Boolean)
  }

  /** Commits (oldest first) reachable from `until` and, when `exclude` is given, not from it, that touched any of `paths`. */
  commitsTouchingBetween(exclude: string | null, until: string, paths: readonly string[]): string[] {
    const range = exclude ? `${exclude}..${until}` : until
    return this.run(['rev-list', '--reverse', '--topo-order', range, '--', ...paths])
      .stdout.split('\n')
      .filter(Boolean)
  }

  /**
   * Blob id the working-tree file would get if committed: `hash-object --path`
   * applies the repository's clean filters and EOL attributes, so a CRLF
   * checkout hashes like the LF blob when `.gitattributes` says so.
   */
  hashObjectPath(repoRelativePath: string): string {
    const absolute = isAbsolute(repoRelativePath) ? repoRelativePath : join(this.toplevel(), repoRelativePath)
    const rel = relative(this.toplevel(), absolute)
    return this.run(['hash-object', `--path=${rel}`, '--', absolute]).stdout.trim()
  }

  /** Blob id of `path` at `rev`. */
  blobAt(rev: string, repoRelativePath: string): string | null {
    return this.revParse(`${rev}:${repoRelativePath}`)
  }

  /** Content of `path` at `rev`. */
  showBlob(rev: string, repoRelativePath: string): string {
    return this.run(['cat-file', 'blob', `${rev}:${repoRelativePath}`]).stdout
  }

  /** Tree id of `path` at `rev`, e.g. `HEAD:skills/demo`. */
  treeAt(rev: string, repoRelativePath: string): string | null {
    return this.revParse(`${rev}:${repoRelativePath}`)
  }

  /** `git status --porcelain` for the given paths; empty string when clean. */
  porcelain(paths: readonly string[]): string {
    return this.run(['status', '--porcelain', '--untracked-files=all', '--', ...paths]).stdout.trim()
  }

  head(): string | null {
    return this.commitOf('HEAD')
  }
}
