// `generate`: builds the tree map (src/generate/tree.ts), clears the owned roots, writes the map, and mirrors each
// skill directory into the gitignored .agents/skills/ for in-repo dogfooding.
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildTree, listSkills, REPO_ROOT, type TreeOptions, writeTree } from './tree'

// Kept here so importers (the runner tests, src/record/cli.ts comments) need not know where the builder lives.
export { buildHelper, type BuildOptions, HELPER_RELPATH, listSkills, REPO_ROOT } from './tree'

export type GenerateOptions = TreeOptions

export async function generate(options: GenerateOptions = {}): Promise<{ skills: string[]; written: string[] }> {
  const root = resolve(options.root ?? REPO_ROOT)
  const tree = await buildTree({ ...options, root })
  await writeTree(root, tree)

  const skills = await listSkills(root)
  for (const name of skills) {
    const mirror = join(root, '.agents', 'skills', name)
    await rm(mirror, { recursive: true, force: true })
    await mkdir(dirname(mirror), { recursive: true })
    await cp(join(root, 'skills', name), mirror, { recursive: true })
  }
  return { skills, written: [...tree.keys()].sort() }
}

function parseRoot(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--root')
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined) throw new Error('--root requires a value')
  return value
}

if (import.meta.main) {
  try {
    const root = parseRoot(process.argv.slice(2))
    const { skills, written } = await generate(root === undefined ? {} : { root })
    if (skills.length === 0) console.log('generate: no skills found; nothing to do')
    for (const path of written) console.log(`generate: wrote ${path}`)
  } catch (error) {
    console.error(`generate: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
