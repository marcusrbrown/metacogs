// Bundles src/record/cli.ts into skills/<name>/scripts/record.mjs for every skill, and mirrors each skill
// directory into the gitignored .agents/skills/ for in-repo dogfooding.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_METHODS } from '../record/contract'
import { helperBanner } from './marker'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const HELPER_RELPATH = join('scripts', 'record.mjs')

export interface BuildOptions {
  /** Shipped-method enum baked into the bundle. Tests inject a fixture method here; production uses SHIPPED_METHODS. */
  methods?: readonly string[]
  /** Defaults to the version in the repo's package.json. */
  helperVersion?: string
}

export interface GenerateOptions extends BuildOptions {
  /** Project root containing `skills/`. Defaults to this repository. */
  root?: string
}

async function repoVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

/** Bundle the helper to a dependency-free ESM string. Deterministic for fixed inputs. */
export async function buildHelper(options: BuildOptions = {}): Promise<string> {
  const methods = options.methods ?? SHIPPED_METHODS
  const helperVersion = options.helperVersion ?? (await repoVersion())
  const result = await Bun.build({
    entrypoints: [join(REPO_ROOT, 'src', 'record', 'cli.ts')],
    root: REPO_ROOT,
    target: 'node',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    splitting: false,
    banner: helperBanner(helperVersion),
    define: {
      __METACOGS_HELPER_VERSION__: JSON.stringify(helperVersion),
      __METACOGS_METHODS__: JSON.stringify(methods.join(',')),
    },
  })
  if (!result.success) {
    throw new Error(`helper bundle failed:\n${result.logs.map(log => log.message).join('\n')}`)
  }
  const [output] = result.outputs
  if (result.outputs.length !== 1 || output === undefined) throw new Error('helper bundle produced an unexpected output set')
  return output.text()
}

/** Names of the `skills/<name>/` directories under `root`, sorted. A missing `skills/` means no skills. */
export async function listSkills(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, 'skills'), { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function generate(options: GenerateOptions = {}): Promise<{ skills: string[]; written: string[] }> {
  const root = resolve(options.root ?? REPO_ROOT)
  const skills = await listSkills(root)
  if (skills.length === 0) return { skills, written: [] }

  const text = await buildHelper(options)
  const written: string[] = []
  for (const name of skills) {
    const skillDir = join(root, 'skills', name)
    const helper = join(skillDir, HELPER_RELPATH)
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(helper, text)
    written.push(relative(root, helper))

    const mirror = join(root, '.agents', 'skills', name)
    await rm(mirror, { recursive: true, force: true })
    await mkdir(dirname(mirror), { recursive: true })
    await cp(skillDir, mirror, { recursive: true })
  }
  return { skills, written }
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
