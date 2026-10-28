// The tree map: every generated file as repo-relative path -> { bytes, mode }. `generate` writes it and
// `generate:check` diffs it against disk, so the two cannot disagree about what is generated.
//
// Two kinds of output:
//  - Owned roots are generated wholesale, but only for a tree built with hosts (`ownsRoots`: this repository, or a
//    test that asks). Then `generate` clears every owned root before writing and the check reports any file under
//    one that the map does not contain, so a root the generator now leaves empty is still cleaned. Any other tree,
//    such as a `--root` that is another project, neither clears nor checks the owned roots: its own
//    `.claude-plugin/` and `.agents/plugins/` are not ours. `generate` and the check read the same `ownsRoots`.
//  - Per-file outputs (`skills/<name>/scripts/record.mjs`) sit beside hand-written files. They are written and
//    checked one by one and their directories are never cleared.
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClaudeEntries } from '../hosts/claude'
import { buildCodexEntries } from '../hosts/codex'
import { buildMcpServer } from '../plugin/build'
import { SHIPPED_METHODS } from '../record/contract'
import { helperBanner } from './marker'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where each host package carries its copy of the MCP server bundle. The two copies are the same bytes. */
export const MCP_SERVER_PATHS = ['hosts/claude/mcp/server.mjs', 'hosts/codex/mcp/server.mjs'] as const

/** Directories that are fully generated. Posix, repo-relative, trailing slash. */
export const OWNED_ROOTS = ['hosts/claude/', 'hosts/codex/', '.claude-plugin/', '.agents/plugins/'] as const

/** The per-skill helper, as a posix path below `skills/<name>/`. The map key and the ownership pattern both come from it. */
const HELPER_FILE = 'scripts/record.mjs'
const helperPath = (skill: string): string => `skills/${skill}/${HELPER_FILE}`

/** Generated files that live beside hand-written ones. */
const PER_FILE_OUTPUT = new RegExp(`^skills/[^/]+/${HELPER_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

/** Git only tracks the executable bit, so a file's mode is one of these two. */
export type FileMode = 0o644 | 0o755

export interface TreeEntry {
  bytes: Uint8Array
  mode: FileMode
}

/** Repo-relative posix path -> content and mode. */
export type TreeMap = Map<string, TreeEntry>

export interface BuildOptions {
  /** Shipped-method enum baked into the bundle. Tests inject a fixture method here; production uses SHIPPED_METHODS. */
  methods?: readonly string[]
  /** Defaults to the version in the repo's package.json. */
  helperVersion?: string
}

export interface TreeOptions extends BuildOptions {
  /** Project root containing `skills/`. Defaults to this repository. */
  root?: string
  /**
   * Whether to build the host packages (MCP bundle, Claude and Codex packages), which come from this repository's own sources.
   * Defaults to true for this repository and false for any other root; tests set it to build into a temp root.
   */
  hosts?: boolean
  /**
   * Whether the owned roots are generated and checked. Defaults to `hosts`. Tests set it to true to inject stand-in
   * entries (`extraEntries`) into a fixture root without building the real host packages.
   */
  ownedRoots?: boolean
  /** Tests inject entries under an owned root here, since the real owned roots start empty. Needs `ownedRoots`. Merged after the built ones. */
  extraEntries?: ReadonlyMap<string, TreeEntry>
}

function hostsOf(options: TreeOptions, root: string): boolean {
  return options.hosts ?? root === REPO_ROOT
}

/**
 * Whether `generate` clears the owned roots and the check diffs them. One answer for both, so they cannot disagree.
 * Pass the same options that built the tree.
 */
export function ownsRoots(options: TreeOptions = {}): boolean {
  return options.ownedRoots ?? hostsOf(options, resolve(options.root ?? REPO_ROOT))
}

export type DriftKind = 'missing' | 'extra' | 'changed' | 'mode'

export interface Drift {
  path: string
  kind: DriftKind
}

export function isOwnedPath(path: string): boolean {
  return OWNED_ROOTS.some(owned => path.startsWith(owned))
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

function assertGeneratedPath(path: string): void {
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error(`tree: not a clean repo-relative posix path: ${JSON.stringify(path)}`)
  }
  if (!isOwnedPath(path) && !PER_FILE_OUTPUT.test(path)) {
    throw new Error(`tree: ${path} is neither under an owned root (${OWNED_ROOTS.join(', ')}) nor a per-file output`)
  }
}

/** Every generated file under `options.root`. Throws on a path that generation does not own. */
export async function buildTree(options: TreeOptions = {}): Promise<TreeMap> {
  const root = resolve(options.root ?? REPO_ROOT)
  const tree: TreeMap = new Map()
  const add = (path: string, entry: TreeEntry): void => {
    assertGeneratedPath(path)
    if (tree.has(path)) throw new Error(`tree: duplicate generated path ${path}`)
    tree.set(path, entry)
  }

  const skills = await listSkills(root)
  // The host packages are built from this repository's sources, so a fixture root (tests) has none unless asked.
  const withHosts = hostsOf(options, root)
  let helper: Uint8Array | undefined
  const helperBytes = async (): Promise<Uint8Array> => (helper ??= new TextEncoder().encode(await buildHelper(options)))
  for (const name of skills) add(helperPath(name), { bytes: await helperBytes(), mode: 0o644 })
  if (withHosts) {
    const version = options.helperVersion ?? (await repoVersion())
    const server = new TextEncoder().encode(await buildMcpServer({ version }))
    for (const path of MCP_SERVER_PATHS) add(path, { bytes: server, mode: 0o644 })
    for (const [path, entry] of await buildClaudeEntries({ version, helper: await helperBytes(), repoRoot: REPO_ROOT })) add(path, entry)
    for (const [path, entry] of await buildCodexEntries({ version, helper: await helperBytes(), repoRoot: REPO_ROOT })) add(path, entry)
  }
  for (const [path, entry] of options.extraEntries ?? []) add(path, entry)
  if (!ownsRoots(options)) {
    const stray = [...tree.keys()].find(isOwnedPath)
    if (stray !== undefined) throw new Error(`tree: ${stray} is under an owned root, but this tree does not own the owned roots (set hosts or ownedRoots)`)
  }
  return tree
}

const fsPath = (root: string, path: string): string => join(root, ...path.split('/'))

/**
 * Write the map. With `owned` (see `ownsRoots`), first clear every owned root, whether or not the map has entries
 * under it. Without it the owned roots are not touched: another project's `.claude-plugin/` or `.agents/plugins/`
 * is not ours to delete. Per-file outputs are overwritten in place; their siblings stay.
 */
export async function writeTree(root: string, tree: TreeMap, owned: boolean): Promise<void> {
  if (owned) for (const dir of OWNED_ROOTS) await rm(fsPath(root, dir.slice(0, -1)), { recursive: true, force: true })
  for (const [path, entry] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = fsPath(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, entry.bytes)
    // writeFile ignores `mode` for an existing file and applies the umask to a new one.
    await chmod(file, entry.mode)
  }
}

interface Actual {
  kind: 'file' | 'other'
  mode: FileMode
}

function modeOf(mode: number): FileMode {
  return (mode & 0o111) === 0 ? 0o644 : 0o755
}

/** lstat as an `Actual`, or a directory marker, or `undefined` when nothing is there. */
async function statActual(root: string, path: string): Promise<Actual | 'dir' | undefined> {
  try {
    const stat = await lstat(fsPath(root, path))
    if (stat.isDirectory()) return 'dir'
    return { kind: stat.isFile() ? 'file' : 'other', mode: modeOf(stat.mode) }
  } catch (error) {
    // ENOTDIR: a parent in the path is a file, so nothing can be at this path.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Every non-directory entry under `rel` (symlinks are not followed). A root that is itself not a directory lists as one entry. */
async function walk(root: string, rel: string, found: Map<string, Actual>): Promise<void> {
  const here = await statActual(root, rel)
  if (here === undefined) return
  if (here !== 'dir') {
    found.set(rel, here)
    return
  }
  for (const entry of await readdir(fsPath(root, rel), { withFileTypes: true })) await walk(root, `${rel}/${entry.name}`, found)
}

/** Compare the map with what is on disk. Empty means no drift. With `owned` (see `ownsRoots`), every owned root is diffed, extras included. */
export async function diffTree(root: string, tree: TreeMap, owned: boolean): Promise<Drift[]> {
  const drift: Drift[] = []

  const compare = async (path: string, actual: Actual | undefined): Promise<void> => {
    const expected = tree.get(path)
    if (expected === undefined) {
      if (actual !== undefined) drift.push({ path, kind: 'extra' })
    } else if (actual === undefined) {
      drift.push({ path, kind: 'missing' })
    } else if (actual.kind !== 'file' || !Buffer.from(await readFile(fsPath(root, path))).equals(expected.bytes)) {
      drift.push({ path, kind: 'changed' })
    } else if (actual.mode !== expected.mode) {
      drift.push({ path, kind: 'mode' })
    }
  }

  const paths = new Set<string>()
  for (const dir of owned ? OWNED_ROOTS : []) {
    const found = new Map<string, Actual>()
    await walk(root, dir.slice(0, -1), found)
    for (const [path, actual] of found) {
      paths.add(path)
      await compare(path, actual)
    }
  }
  for (const path of tree.keys()) {
    if (paths.has(path)) continue
    const actual = await statActual(root, path)
    await compare(path, actual === 'dir' ? { kind: 'other', mode: 0o644 } : actual)
  }
  return drift.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1))
}
