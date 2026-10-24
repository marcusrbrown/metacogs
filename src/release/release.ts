// release — idempotent: create GitHub Release `v<version>` (which also creates the tag) when the CHANGELOG has a
// `## <version>` section and no Release exists yet. Zero dependencies beyond `gh` and `git`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractChangelogSection } from './changelog'

export interface ReleaseDeps {
  version: string
  /** CHANGELOG.md text, or `null` when the file does not exist. */
  changelog: string | null
  /** First-parent commit on the current branch that introduced `version` into package.json, or `null` when none is found. */
  introducingSha: () => string | null
  /** Fallback target when `introducingSha` finds nothing (fresh-clone edge). */
  headSha: () => string
  releaseExists: (tag: string) => boolean
  createRelease: (release: { tag: string; sha: string; notes: string; prerelease: boolean }) => void
  log: (message: string) => void
  error: (message: string) => void
}

/** Returns the process exit code: 0 for created or nothing to do, 1 when `gh` fails. */
export function runRelease(deps: ReleaseDeps): number {
  const tag = `v${deps.version}`
  try {
    if (deps.releaseExists(tag)) {
      deps.log(`release: ${tag} already has a GitHub Release; nothing to do`)
      return 0
    }
    const section = deps.changelog === null ? null : extractChangelogSection(deps.changelog, deps.version)
    if (!section) {
      deps.log(`release: notice: CHANGELOG.md has no "## ${deps.version}" section; skipping ${tag}`)
      return 0
    }
    let sha = deps.introducingSha()
    if (sha === null) {
      sha = deps.headSha()
      deps.log(`release: notice: no commit found that introduced version ${deps.version}; targeting HEAD (${sha})`)
    }
    deps.createRelease({ tag, sha, notes: section.body, prerelease: section.prerelease })
    deps.log(`release: created GitHub Release ${tag}${section.prerelease ? ' (prerelease)' : ''}`)
    return 0
  } catch (error) {
    deps.error(`release: failed for ${tag}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function gh(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('gh', args, { encoding: 'utf8' })
  if (r.error) throw new Error(`could not run gh: ${r.error.message}`)
  return { status: r.status, stderr: r.stderr.trim() }
}

function ghReleaseExists(tag: string): boolean {
  const r = gh(['release', 'view', tag])
  if (r.status === 0) return true
  if (/release not found/i.test(r.stderr)) return false
  throw new Error(`gh release view ${tag} failed: ${r.stderr}`)
}

function ghCreateRelease({ tag, sha, notes, prerelease }: { tag: string; sha: string; notes: string; prerelease: boolean }): void {
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-release-'))
  try {
    const notesFile = join(dir, 'notes.md')
    writeFileSync(notesFile, `${notes}\n`)
    const args = ['release', 'create', tag, '--target', sha, '--title', tag, '--notes-file', notesFile]
    if (prerelease) args.push('--prerelease')
    const r = gh(args)
    if (r.status !== 0) throw new Error(`gh release create ${tag} failed: ${r.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.error) throw new Error(`could not run git: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** Oldest first-parent commit whose diff adds or removes the exact `"version": "<v>"` line in package.json. */
function introducingCommit(root: string, version: string): string | null {
  const needle = `"version": "${version}"`
  const lines = git(root, ['log', '--first-parent', '--format=%H', `-S${needle}`, '--', 'package.json'])
    .split('\n')
    .filter(Boolean)
  return lines.at(-1) ?? null
}

function main(): number {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const changelogPath = join(root, 'CHANGELOG.md')
  return runRelease({
    version,
    changelog: existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null,
    introducingSha: () => introducingCommit(root, version),
    headSha: () => git(root, ['rev-parse', 'HEAD']),
    releaseExists: ghReleaseExists,
    createRelease: ghCreateRelease,
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  })
}

if (import.meta.main) process.exit(main())
