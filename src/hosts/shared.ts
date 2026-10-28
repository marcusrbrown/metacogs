// What every host package takes from the repository the same way: author, package.json fields, the one-line summary
// of what ships, and the byte helpers the builders use. Each host builder (claude.ts, codex.ts) owns its layout.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TreeEntry } from '../generate/tree'

export const AUTHOR = { name: 'Marcus R. Brown', url: 'https://github.com/marcusrbrown' } as const

/** What the package ships and what it needs. A host may add its own label in front. */
export const TOOLS_SUMMARY =
  'Two reasoning tools, feel and drugs, a record tool for decision records, and four skills: feel, drugs, synthesis and counterfactual. The tools run through an MCP server that needs Node 22 or later on PATH.'

export interface PackageFields {
  license: string
  homepage: string
  repository: string
}

export async function packageFields(repoRoot: string): Promise<PackageFields> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    license: string
    homepage: string
    repository: { url: string }
  }
  // `git+https://github.com/o/r.git` -> `https://github.com/o/r`
  return { license: pkg.license, homepage: pkg.homepage, repository: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') }
}

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const json = (value: unknown): Uint8Array => encode(`${JSON.stringify(value, null, 2)}\n`)
export const file = (bytes: Uint8Array): TreeEntry => ({ bytes, mode: 0o644 })
