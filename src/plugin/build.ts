// Bundles src/plugin/index.ts into the gitignored dist/index.js, with guidance.md embedded as raw
// text. The host SDK stays external; everything else is inlined. Also bundles the stdio MCP server
// (src/mcp/server.ts) that the Claude Code and Codex packages ship, and wraps `npm pack` for the package tests.
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helperBanner } from '../generate/marker'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PLUGIN_ENTRY = join(REPO_ROOT, 'src', 'plugin', 'index.ts')
export const MCP_ENTRY = join(REPO_ROOT, 'src', 'mcp', 'server.ts')
export const DIST_FILE = join(REPO_ROOT, 'dist', 'index.js')

/** The only module the built plugin may import at run time. */
export const PLUGIN_EXTERNALS = ['@opencode-ai/plugin'] as const

/** Bundle the plugin to an ESM string. Deterministic for fixed inputs. */
export async function buildPlugin(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [PLUGIN_ENTRY],
    root: REPO_ROOT,
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    splitting: false,
    external: [...PLUGIN_EXTERNALS],
    loader: { '.md': 'text' },
  })
  if (!result.success) throw new Error(`plugin bundle failed:\n${result.logs.map((log) => log.message).join('\n')}`)
  const [output] = result.outputs
  if (result.outputs.length !== 1 || output === undefined) throw new Error('plugin bundle produced an unexpected output set')
  return output.text()
}

/**
 * Bundle the MCP server to one self-contained ESM string for Node 22: only `node:*` imports remain, so it runs
 * from a directory with no `node_modules`. `root` is the repository root, which keeps the output identical across
 * checkouts. The version is stamped in the banner and defined into the server; it defaults to package.json's.
 */
export async function buildMcpServer(options: { version?: string } = {}): Promise<string> {
  const version = options.version ?? (JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const result = await Bun.build({
    entrypoints: [MCP_ENTRY],
    root: REPO_ROOT,
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    splitting: false,
    banner: helperBanner(version),
    define: { __METACOGS_MCP_VERSION__: JSON.stringify(version) },
  })
  if (!result.success) throw new Error(`mcp bundle failed:\n${result.logs.map((log) => log.message).join('\n')}`)
  const [output] = result.outputs
  if (result.outputs.length !== 1 || output === undefined) throw new Error('mcp bundle produced an unexpected output set')
  return output.text()
}

/** Builds and writes `dist/index.js`; returns its path. */
export async function writePlugin(): Promise<string> {
  const text = await buildPlugin()
  await mkdir(dirname(DIST_FILE), { recursive: true })
  await writeFile(DIST_FILE, text)
  return DIST_FILE
}

export interface PackResult {
  /** Absolute path of the tarball; empty for a dry run. */
  tarball: string
  /** Package-relative paths of every file in the package. */
  files: string[]
}

/** `npm pack --ignore-scripts` of this repository. A dry run lists the files and writes nothing. */
export function packPlugin(options: { dest: string; dryRun?: boolean }): PackResult {
  const args = ['pack', '--json', '--ignore-scripts', ...(options.dryRun ? ['--dry-run'] : ['--pack-destination', options.dest])]
  const run = spawnSync('npm', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
  })
  if (run.status !== 0) throw new Error(`npm pack failed (status ${run.status}): ${run.stderr.slice(0, 500)}`)
  type PackInfo = { filename: string; files: { path: string }[] }
  // npm 11 and earlier print an array; newer npm prints an object keyed by package name.
  const parsed = JSON.parse(run.stdout) as PackInfo[] | Record<string, PackInfo>
  const [info] = Array.isArray(parsed) ? parsed : Object.values(parsed)
  if (info === undefined) throw new Error('npm pack printed no package')
  return { tarball: options.dryRun ? '' : join(options.dest, info.filename), files: info.files.map((file) => file.path).sort() }
}

if (import.meta.main) {
  try {
    console.log(`build: wrote ${await writePlugin()}`)
  } catch (error) {
    console.error(`build: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
