// generate:check — re-bundle the helper in memory and report any committed helper that differs.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildHelper, type BuildOptions, HELPER_RELPATH, listSkills, REPO_ROOT } from './bundle-helpers'

export interface CheckOptions extends BuildOptions {
  /** Project root containing `skills/`. Defaults to this repository. */
  root?: string
}

/** Root-relative paths of helpers that are missing or differ from a fresh bundle. Empty means no drift. */
export async function checkHelpers(options: CheckOptions = {}): Promise<string[]> {
  const root = resolve(options.root ?? REPO_ROOT)
  const skills = await listSkills(root)
  if (skills.length === 0) return []

  const expected = await buildHelper(options)
  const drifted: string[] = []
  for (const name of skills) {
    const relPath = join('skills', name, HELPER_RELPATH)
    const actual = await readFile(join(root, relPath), 'utf8').catch(() => undefined)
    if (actual !== expected) drifted.push(relPath)
  }
  return drifted
}

if (import.meta.main) {
  const at = process.argv.indexOf('--root')
  const root = at === -1 ? undefined : process.argv[at + 1]
  try {
    const drifted = await checkHelpers(root === undefined ? {} : { root })
    if (drifted.length > 0) {
      console.error('generate:check: generated helpers are stale or hand-edited; run `bun run generate`:')
      for (const path of drifted) console.error(`  ${path}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`generate:check: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
