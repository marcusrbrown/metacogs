// generate:check — rebuild the tree map in memory and report every generated file that is missing, extra, changed
// or has the wrong executable bit: whole owned roots, plus each per-file output.
import { resolve } from 'node:path'
import { type Finding, scanHostTrees } from '../hosts/scan'
import { buildTree, type Drift, diffTree, REPO_ROOT, type TreeOptions } from './tree'

export type CheckOptions = TreeOptions

export interface CheckResult {
  drift: Drift[]
  /** Denylist and positive-token findings over the generated host trees. */
  findings: Finding[]
}

/** Drift between the committed tree and a fresh build, plus the host-tree scan of that build. */
export async function checkGenerated(options: CheckOptions = {}): Promise<CheckResult> {
  const root = resolve(options.root ?? REPO_ROOT)
  const tree = await buildTree({ ...options, root })
  return { drift: await diffTree(root, tree), findings: scanHostTrees(tree) }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--root')
  const root = at === -1 ? undefined : process.argv[at + 1]
  try {
    const { drift, findings } = await checkGenerated(root === undefined ? {} : { root })
    if (drift.length > 0) {
      console.error('generate:check: generated files are stale or hand-edited; run `bun run generate`:')
      for (const { path, kind } of drift) console.error(`  ${kind}: ${path}`)
      process.exitCode = 1
    }
    if (findings.length > 0) {
      console.error('generate:check: the generated host trees fail the rewrite scan:')
      for (const { path, problem } of findings) console.error(`  ${path}: ${problem}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`generate:check: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
