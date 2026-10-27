import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlugin, PLUGIN_EXTERNALS, packPlugin, REPO_ROOT, writePlugin } from './build'

/** Every module specifier a bundle imports: static, dynamic, re-export and `require`. */
function importSpecifiers(text: string): string[] {
  const found = new Set<string>()
  const patterns = [/\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?["']([^"']+)["']/g, /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g, /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g]
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1] ?? '')
  return [...found].sort()
}

/** Specifiers the bundle may not import, bare or with the `node:` prefix. */
const FORBIDDEN_MODULES = ['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'dgram']
const forbidden = (specifier: string): boolean => FORBIDDEN_MODULES.includes(specifier.replace(/^node:/, ''))
const notAllowed = (specifiers: readonly string[]): string[] => specifiers.filter((s) => !(PLUGIN_EXTERNALS as readonly string[]).includes(s))

const ALLOWED_PATHS = [/^dist\//, /^skills\//, /^plugin\//, /^ATTRIBUTIONS\.md$/, /^LICENSE$/, /^README\.md$/, /^package\.json$/]

function walk(root: string, dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(root, rel) : [rel]
  })
}

let scratch: string
let bundle: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-package-'))
  await writePlugin()
  bundle = readFileSync(join(REPO_ROOT, 'dist', 'index.js'), 'utf8')
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('importSpecifiers', () => {
  test('finds static, side-effect, re-export, dynamic and require forms, with and without node:', () => {
    const text = [
      `import { a } from "node:fs";`,
      `import b from 'child_process'`,
      `import * as c from "net"`,
      `import "http"`,
      `export * from "https"`,
      `export { d } from "node:dgram"`,
      `const e = await import("fs/promises")`,
      `const f = require("node:fs")`,
    ].join('\n')
    expect(importSpecifiers(text)).toEqual(['child_process', 'fs/promises', 'http', 'https', 'net', 'node:dgram', 'node:fs'])
    expect(importSpecifiers(text).every(forbidden)).toBe(true)
  })
})

describe('the built bundle', () => {
  test('is deterministic', async () => {
    expect(await buildPlugin()).toBe(bundle)
  })

  test('imports only @opencode-ai/plugin: no fs, child_process, net, http, https or dgram, and no other external', () => {
    const specifiers = importSpecifiers(bundle)
    expect(specifiers).toEqual(['@opencode-ai/plugin'])
    expect(specifiers.filter(forbidden)).toEqual([])
    expect(notAllowed(specifiers)).toEqual([])
  })

  test('uses no process, network or dynamic-code global', () => {
    for (const pattern of [/\bBun\./, /\bprocess\./, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\beval\s*\(/, /\bnew Function\b/]) expect(bundle).not.toMatch(pattern)
  })

  test('embeds the guidance file as raw markdown', () => {
    expect(bundle).toContain(readFileSync(join(REPO_ROOT, 'plugin', 'guidance.md'), 'utf8').trimEnd().split('\n')[0] ?? '')
    expect(bundle).not.toContain('<p>')
  })
})

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; files: string[]; private?: boolean }

  test('has no lifecycle script that runs on a consumer\'s install', () => {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts[name]).toBeUndefined()
  })

  test('lists exactly the allowlisted files and builds before publishing', () => {
    expect(pkg.files).toEqual(['dist', 'skills', 'plugin', 'ATTRIBUTIONS.md', 'LICENSE', 'README.md'])
    expect(pkg.scripts.build).toBe('bun src/plugin/build.ts')
    expect(pkg.scripts.prepublishOnly).toBe('bun run build && bun test')
  })
})

describe('the packed package', () => {
  test('npm pack --dry-run lists only allowlisted paths, with the notices and plugin files present and evals and src absent', () => {
    const { files } = packPlugin({ dest: scratch, dryRun: true })
    expect(files.filter((f) => !ALLOWED_PATHS.some((re) => re.test(f)))).toEqual([])
    for (const required of ['LICENSE', 'ATTRIBUTIONS.md', 'README.md', 'package.json', 'dist/index.js', 'plugin/guidance.md', 'plugin/skills/feel/SKILL.md', 'plugin/skills/drugs/SKILL.md', 'skills/synthesis/SKILL.md', 'skills/synthesis/scripts/record.mjs', 'skills/counterfactual/SKILL.md', 'skills/counterfactual/scripts/record.mjs']) {
      expect(files).toContain(required)
    }
    expect(files.some((f) => f.startsWith('evals/') || f.startsWith('src/') || f.startsWith('docs/') || /\.test\.[cm]?[jt]s$/.test(f))).toBe(false)
  })

  test('the packed skills/ tree matches the source byte for byte, record.mjs included', () => {
    const { tarball } = packPlugin({ dest: scratch })
    const unpacked = join(scratch, 'unpacked')
    mkdirSync(unpacked)
    const tar = Bun.spawnSync(['tar', '-xzf', tarball, '-C', unpacked])
    expect(tar.exitCode).toBe(0)
    const packedSkills = join(unpacked, 'package', 'skills')
    const sourceSkills = join(REPO_ROOT, 'skills')
    const files = walk(sourceSkills)
    expect(walk(packedSkills)).toEqual(files)
    expect(files.some((f) => f.endsWith('scripts/record.mjs'))).toBe(true)
    for (const file of files) {
      expect(Buffer.compare(readFileSync(join(packedSkills, file)), readFileSync(join(sourceSkills, file)))).toBe(0)
    }
  })
})
