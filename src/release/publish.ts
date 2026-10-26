// publish-release — the Changesets `publish-script`. Publishes to npm only when the GitHub Release for the current version
// exists, because `release.ts` exits 0 without creating one when the CHANGELOG has no section for it. `changeset publish`
// skips versions already on the registry, and npm runs `prepublishOnly` (build and tests) only when it publishes.
// `--no-git-tag` keeps `v<version>`, created by `release.ts`, as the only tag.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ghReleaseExists } from './release'

export interface PublishDeps {
  version: string
  releaseExists: (tag: string) => boolean
  /** Runs `changeset publish --no-git-tag`; returns its exit code. */
  publish: () => number
  log: (message: string) => void
  error: (message: string) => void
}

/** Returns the process exit code: 0 when it skipped or published, the publish command's code or 1 otherwise. */
export function runPublish(deps: PublishDeps): number {
  const tag = `v${deps.version}`
  try {
    if (!deps.releaseExists(tag)) {
      deps.log(`publish: no GitHub Release for ${tag}; not publishing`)
      return 0
    }
    return deps.publish()
  } catch (error) {
    deps.error(`publish: failed for ${tag}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function changesetPublish(root: string): number {
  const r = spawnSync('bunx', ['changeset', 'publish', '--no-git-tag'], { cwd: root, stdio: 'inherit' })
  if (r.error) throw new Error(`could not run changeset: ${r.error.message}`)
  return r.status ?? 1
}

function main(): number {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  return runPublish({
    version,
    releaseExists: ghReleaseExists,
    publish: () => changesetPublish(root),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  })
}

if (import.meta.main) process.exit(main())
