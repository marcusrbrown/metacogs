// generate:check — rebuild the tree map in memory and report every generated file that is missing, extra, changed
// or has the wrong executable bit: whole owned roots, plus each per-file output.
import { resolve } from 'node:path'
import { buildTree, type Drift, diffTree, REPO_ROOT, type TreeOptions } from './tree'

export type CheckOptions = TreeOptions

/** Drift between the committed tree and a fresh build, sorted by path. Empty means none. */
export async function checkTree(options: CheckOptions = {}): Promise<Drift[]> {
  const root = resolve(options.root ?? REPO_ROOT)
  return diffTree(root, await buildTree({ ...options, root }))
}

if (import.meta.main) {
  const at = process.argv.indexOf('--root')
  const root = at === -1 ? undefined : process.argv[at + 1]
  try {
    const drift = await checkTree(root === undefined ? {} : { root })
    if (drift.length > 0) {
      console.error('generate:check: generated files are stale or hand-edited; run `bun run generate`:')
      for (const { path, kind } of drift) console.error(`  ${kind}: ${path}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`generate:check: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
