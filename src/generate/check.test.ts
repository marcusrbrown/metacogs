import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordFilename } from '../record/canonical'
import { SHIPPED_METHODS } from '../record/contract'
import { runCli, validRecord } from '../record/test-support'
import { buildHelper, generate, REPO_ROOT } from './bundle-helpers'
import { checkHelpers } from './check'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metacogs-gen-'))
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: fixture\n---\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const HELPER = join('skills', 'demo', 'scripts', 'record.mjs')

describe('generate', () => {
  test('zero skills is graceful (no skills dir, empty skills dir)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'metacogs-empty-'))
    try {
      expect((await generate({ root: empty })).skills).toEqual([])
      mkdirSync(join(empty, 'skills'))
      expect((await generate({ root: empty })).skills).toEqual([])
      expect(await checkHelpers({ root: empty })).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('emits scripts/record.mjs per skill with the banner, and a .agents/skills copy', async () => {
    const result = await generate({ root })
    expect(result.skills).toEqual(['demo'])
    const text = readFileSync(join(root, HELPER), 'utf8')
    expect(text.startsWith('// generated — do not edit; run `bun run generate`\n')).toBe(true)
    expect(readFileSync(join(root, '.agents', 'skills', 'demo', 'scripts', 'record.mjs'), 'utf8')).toBe(text)
    expect(existsSync(join(root, '.agents', 'skills', 'demo', 'SKILL.md'))).toBe(true)
  })

  test('is deterministic and free of absolute paths and non-builtin imports', async () => {
    await generate({ root })
    const first = readFileSync(join(root, HELPER), 'utf8')
    await generate({ root })
    expect(readFileSync(join(root, HELPER), 'utf8')).toBe(first)
    expect(await buildHelper({})).toBe(first)
    expect(first).not.toContain(REPO_ROOT)
    expect(first).not.toContain(root)
    const specifiers = [...first.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const spec of specifiers) expect(spec).toMatch(/^node:/)
    expect(first).not.toContain('node_modules')
  })

  test('bakes the package.json version in as helper_version', async () => {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
    expect(await buildHelper({})).toContain(JSON.stringify(version))
  })

  test('regeneration refreshes the .agents copy and drops removed files', async () => {
    await generate({ root })
    writeFileSync(join(root, 'skills', 'demo', 'extra.md'), 'x')
    await generate({ root })
    expect(existsSync(join(root, '.agents', 'skills', 'demo', 'extra.md'))).toBe(true)
    rmSync(join(root, 'skills', 'demo', 'extra.md'))
    await generate({ root })
    expect(existsSync(join(root, '.agents', 'skills', 'demo', 'extra.md'))).toBe(false)
  })
})

describe('generate:check', () => {
  test('clean after generate', async () => {
    await generate({ root })
    expect(await checkHelpers({ root })).toEqual([])
  })

  test('reports a missing helper', async () => {
    expect(await checkHelpers({ root })).toEqual([HELPER])
  })

  test('hand-editing a bundled helper fails the check naming the path (library and CLI)', async () => {
    await generate({ root })
    const file = join(root, HELPER)
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// sneaky hand edit\n`)
    expect(await checkHelpers({ root })).toEqual([HELPER])
    const proc = spawnSync('bun', [join(REPO_ROOT, 'src', 'generate', 'check.ts'), '--root', root], { encoding: 'utf8' })
    expect(proc.status).toBe(1)
    expect(proc.stderr).toContain(HELPER)
  })

  test('CLI exits 0 when clean', async () => {
    await generate({ root })
    const proc = spawnSync('bun', [join(REPO_ROOT, 'src', 'generate', 'check.ts'), '--root', root], { encoding: 'utf8' })
    expect(proc.status).toBe(0)
  })
})

describe('bundle parity under plain node', () => {
  const methods = [...SHIPPED_METHODS, 'demo']

  test('node is at least v22', () => {
    const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim()
    expect(Number(nodeVersion.replace(/^v/, '').split('.')[0])).toBeGreaterThanOrEqual(22)
  })

  test('record.mjs matches the TypeScript CLI on exit code, stdout, stderr and file bytes', async () => {
    await generate({ root, methods, helperVersion: '9.9.9-test' })
    const helper = join(root, HELPER)
    const home = join(root, 'home')
    mkdirSync(home)

    const { reopen_condition: _omit, ...missingReopen } = validRecord({ method: 'demo' })
    const reordered = Object.fromEntries(Object.entries(validRecord({ method: 'demo' })).reverse())
    const corpus: { name: string; stdin: string; args?: string[]; prepare?: (out: string) => void }[] = [
      { name: 'valid', stdin: JSON.stringify(validRecord({ method: 'demo' })) },
      { name: 'valid again', stdin: JSON.stringify(validRecord({ method: 'demo' })) },
      { name: 'reordered', stdin: JSON.stringify(reordered, null, 2) },
      { name: 'shipped method', stdin: JSON.stringify(validRecord()) },
      { name: 'empty arrays', stdin: JSON.stringify(validRecord({ evidence: [], alternatives: [] })) },
      { name: 'missing reopen_condition', stdin: JSON.stringify(missingReopen) },
      { name: 'empty reopen_condition', stdin: JSON.stringify(validRecord({ reopen_condition: '' })) },
      { name: 'schema_version 2', stdin: JSON.stringify(validRecord({ schema_version: 2 })) },
      { name: 'traversal method', stdin: JSON.stringify(validRecord({ method: '../x' })) },
      { name: 'slash method', stdin: JSON.stringify(validRecord({ method: 'a/b' })) },
      { name: 'unknown method', stdin: JSON.stringify(validRecord({ method: 'nope' })) },
      { name: 'invalid json', stdin: '{nope' },
      { name: 'usage', stdin: '', args: ['--bogus'] },
      {
        name: 'collision (truncated)',
        stdin: JSON.stringify(validRecord({ objective: 'collide' })),
        prepare: out => {
          mkdirSync(out, { recursive: true })
          writeFileSync(join(out, recordFilename(validRecord({ objective: 'collide' }))), '{"trunc')
        },
      },
    ]

    for (const entry of corpus) {
      // `valid again` must hit the same dir as `valid` to prove idempotence; others get their own.
      const key = entry.name === 'valid again' ? 'valid' : entry.name
      const tsOut = join(root, 'ts', key.replace(/\W/g, '_'))
      const nodeOut = join(root, 'node', key.replace(/\W/g, '_'))
      entry.prepare?.(tsOut)
      entry.prepare?.(nodeOut)
      const args = entry.args ?? ['--out-dir', '@OUT@']

      const ts = await runCli(
        args.map(a => (a === '@OUT@' ? tsOut : a)),
        { stdin: entry.stdin, methods, helperVersion: '9.9.9-test', env: { HOME: home } },
      )
      const node = spawnSync('node', [helper, ...args.map(a => (a === '@OUT@' ? nodeOut : a))], {
        input: entry.stdin,
        encoding: 'utf8',
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: home, NODE_PATH: '' },
      })

      const norm = (text: string, dir: string) => text.replaceAll(dir, '<OUT>')
      expect([entry.name, node.status]).toEqual([entry.name, ts.code])
      expect([entry.name, norm(node.stdout, nodeOut)]).toEqual([entry.name, norm(ts.stdout, tsOut)])
      expect([entry.name, norm(node.stderr, nodeOut)]).toEqual([entry.name, norm(ts.stderr, tsOut)])
      if (ts.code === 0) {
        const written: string = JSON.parse(ts.stdout).path
        const nodeWritten = written.replace(tsOut, nodeOut)
        expect(readFileSync(nodeWritten, 'utf8')).toBe(readFileSync(written, 'utf8'))
      }
    }
  })

  test('the shipped (default-enum) bundle rejects the fixture method', async () => {
    await generate({ root })
    const proc = spawnSync('node', [join(root, HELPER), '--out-dir', join(root, 'o')], {
      input: JSON.stringify(validRecord({ method: 'demo' })),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NODE_PATH: '' },
    })
    expect(proc.status).toBe(2)
    expect(proc.stderr).toContain('method')
  })
})
