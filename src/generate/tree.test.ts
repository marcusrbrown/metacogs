import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMcpServer } from '../plugin/build'
import { generate } from './bundle-helpers'
import { checkGenerated } from './check'
import { buildHelper, buildTree, isOwnedPath, listSkills, MCP_SERVER_PATHS, OWNED_ROOTS, REPO_ROOT, type TreeEntry } from './tree'

const entry = (text: string, mode: TreeEntry['mode'] = 0o644): TreeEntry => ({ bytes: new TextEncoder().encode(text), mode })

/** One file under each owned root, one executable. Stands in for what later units generate. */
const OWNED_FIXTURE = new Map<string, TreeEntry>([
  ['hosts/claude/.mcp.json', entry('{"claude":true}\n')],
  ['hosts/claude/hooks/session-start.mjs', entry('#!/usr/bin/env node\n', 0o755)],
  ['hosts/codex/plugin.json', entry('{"codex":true}\n')],
  ['.claude-plugin/marketplace.json', entry('{"market":"claude"}\n')],
  ['.agents/plugins/marketplace.json', entry('{"market":"codex"}\n')],
])

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metacogs-tree-'))
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: fixture\n---\nhand-written\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Every file under `dir` as relative path -> bytes and executable bit. */
function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === '' ? item.name : `${rel}/${item.name}`
    if (item.isDirectory()) Object.assign(out, snapshot(dir, path))
    else out[path] = `${(lstatSync(join(dir, path)).mode & 0o111) === 0 ? '644' : '755'}:${readFileSync(join(dir, path), 'utf8')}`
  }
  return out
}

describe('owned roots', () => {
  test('are exactly the four generated directories', () => {
    expect([...OWNED_ROOTS]).toEqual(['hosts/claude/', 'hosts/codex/', '.claude-plugin/', '.agents/plugins/'])
  })

  test('ownership is by whole directory, never by prefix or by the dev mirror', () => {
    expect(isOwnedPath('hosts/claude/.mcp.json')).toBe(true)
    expect(isOwnedPath('.agents/plugins/marketplace.json')).toBe(true)
    expect(isOwnedPath('hosts/claudette/x')).toBe(false)
    expect(isOwnedPath('.agents/skills/demo/SKILL.md')).toBe(false)
    expect(isOwnedPath('skills/demo/SKILL.md')).toBe(false)
  })
})

describe('buildTree', () => {
  test('helpers regenerate byte-identical to the committed record.mjs, with mode 644', async () => {
    const tree = await buildTree({})
    const skills = await listSkills(REPO_ROOT)
    expect(skills.length).toBeGreaterThan(0)
    expect([...tree.keys()].filter(path => path.startsWith('skills/')).sort()).toEqual(skills.map(name => `skills/${name}/scripts/record.mjs`))
    for (const [path, built] of [...tree].filter(([path]) => path.startsWith('skills/'))) {
      expect(Buffer.compare(built.bytes, readFileSync(join(REPO_ROOT, path)))).toBe(0)
      expect(built.mode).toBe(0o644)
      expect((lstatSync(join(REPO_ROOT, path)).mode & 0o111) === 0).toBe(true)
    }
  })

  test('the repository tree carries the same MCP server bundle in both host directories, mode 644', async () => {
    const tree = await buildTree({})
    expect([...tree.keys()].filter(path => path.startsWith('hosts/') && path.endsWith('/mcp/server.mjs')).sort()).toEqual([...MCP_SERVER_PATHS])
    const [claude, codex] = MCP_SERVER_PATHS.map(path => tree.get(path))
    expect(claude?.mode).toBe(0o644)
    expect(codex?.mode).toBe(0o644)
    expect(Buffer.compare(claude!.bytes, codex!.bytes)).toBe(0)
    expect(Buffer.from(claude!.bytes).toString('utf8')).toBe(await buildMcpServer())
  })

  test('a fixture root gets no MCP bundle', async () => {
    expect([...(await buildTree({ root })).keys()]).toEqual(['skills/demo/scripts/record.mjs'])
  })

  test('the helper entry is exactly buildHelper output', async () => {
    const tree = await buildTree({ root, methods: ['demo'], helperVersion: '1.2.3-test' })
    const text = await buildHelper({ methods: ['demo'], helperVersion: '1.2.3-test' })
    expect(Buffer.from(tree.get('skills/demo/scripts/record.mjs')!.bytes).toString('utf8')).toBe(text)
  })

  test('no skills and no extra entries is an empty map', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'metacogs-empty-'))
    try {
      expect((await buildTree({ root: empty })).size).toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('merges extra entries after the built ones', async () => {
    const tree = await buildTree({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(tree.size).toBe(OWNED_FIXTURE.size + 1)
    expect(tree.get('hosts/claude/hooks/session-start.mjs')?.mode).toBe(0o755)
  })

  test.each([
    ['a hand-written skill file', 'skills/demo/SKILL.md'],
    ['a file at the repo root', 'package.json'],
    ['the dev mirror', '.agents/skills/demo/SKILL.md'],
    ['a prefix lookalike', 'hosts/claudette/x.json'],
    ['a traversal out of an owned root', 'hosts/claude/../../package.json'],
    ['a dot segment', 'hosts/claude/./x.json'],
    ['an empty segment', 'hosts/claude//x.json'],
    ['an absolute path', '/hosts/claude/x.json'],
    ['a backslash path', 'hosts\\claude\\x.json'],
  ])('rejects %s', async (_name, path) => {
    await expect(buildTree({ root, extraEntries: new Map([[path, entry('x')]]) })).rejects.toThrow(/tree:/)
  })

  test('rejects a path generated twice', async () => {
    const path = 'skills/demo/scripts/record.mjs'
    await expect(buildTree({ root, extraEntries: new Map([[path, entry('x')]]) })).rejects.toThrow(/duplicate/)
  })
})

describe('generate over the tree map', () => {
  test('writes the owned roots and per-file outputs, with the executable bit', async () => {
    const { written } = await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(written).toEqual([...OWNED_FIXTURE.keys(), 'skills/demo/scripts/record.mjs'].sort())
    expect(readFileSync(join(root, 'hosts/codex/plugin.json'), 'utf8')).toBe('{"codex":true}\n')
    expect(lstatSync(join(root, 'hosts/claude/hooks/session-start.mjs')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(root, 'hosts/claude/.mcp.json')).mode & 0o111).toBe(0)
  })

  test('is idempotent: a second run changes nothing', async () => {
    const options = { root, ownedRoots: true, extraEntries: OWNED_FIXTURE }
    await generate(options)
    const first = snapshot(root)
    await generate(options)
    expect(snapshot(root)).toEqual(first)
  })

  test('clears owned roots: a stray file and a stale subdirectory are removed', async () => {
    mkdirSync(join(root, 'hosts', 'claude', 'old', 'deep'), { recursive: true })
    writeFileSync(join(root, 'hosts', 'claude', 'old', 'deep', 'stale.txt'), 'x')
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(join(root, '.agents', 'plugins', 'stray.json'), '{}')
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(existsSync(join(root, 'hosts', 'claude', 'old'))).toBe(false)
    expect(existsSync(join(root, '.agents', 'plugins', 'stray.json'))).toBe(false)
    expect(existsSync(join(root, 'hosts', 'claude', '.mcp.json'))).toBe(true)
  })

  test('a tree that does not own the roots leaves them alone when there is nothing to generate', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'metacogs-empty-'))
    try {
      mkdirSync(join(empty, 'hosts', 'codex'), { recursive: true })
      writeFileSync(join(empty, 'hosts', 'codex', 'stray.json'), '{}')
      await generate({ root: empty })
      expect(existsSync(join(empty, 'hosts', 'codex', 'stray.json'))).toBe(true)
      expect((await checkGenerated({ root: empty })).drift).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('a foreign root keeps its own .claude-plugin/ and .agents/plugins/, and the check is clean after generate', async () => {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"theirs"}\n')
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), '{"name":"theirs"}\n')
    await generate({ root })
    expect(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).toBe('{"name":"theirs"}\n')
    expect(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8')).toBe('{"name":"theirs"}\n')
    expect(existsSync(join(root, 'skills', 'demo', 'scripts', 'record.mjs'))).toBe(true)
    expect((await checkGenerated({ root })).drift).toEqual([])
  })

  test('a tree that owns the roots clears every one, including a root the generator emits nothing under', async () => {
    mkdirSync(join(root, 'hosts', 'claude'), { recursive: true })
    writeFileSync(join(root, 'hosts', 'claude', 'stale.json'), '{}')
    mkdirSync(join(root, 'hosts', 'codex'), { recursive: true })
    writeFileSync(join(root, 'hosts', 'codex', 'stale.json'), '{}')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'stale.json'), '{}')
    // Only hosts/claude/ has an entry; the other three roots are emptied.
    const options = { root, ownedRoots: true, extraEntries: new Map([['hosts/claude/.mcp.json', entry('{}\n')]]) }
    expect((await checkGenerated(options)).drift).toEqual([
      { path: '.claude-plugin/stale.json', kind: 'extra' },
      { path: 'hosts/claude/.mcp.json', kind: 'missing' },
      { path: 'hosts/claude/stale.json', kind: 'extra' },
      { path: 'hosts/codex/stale.json', kind: 'extra' },
      { path: 'skills/demo/scripts/record.mjs', kind: 'missing' },
    ])
    await generate(options)
    expect(existsSync(join(root, 'hosts', 'claude', 'stale.json'))).toBe(false)
    expect(existsSync(join(root, 'hosts', 'codex'))).toBe(false)
    expect(existsSync(join(root, '.claude-plugin'))).toBe(false)
    expect(existsSync(join(root, 'hosts', 'claude', '.mcp.json'))).toBe(true)
    expect((await checkGenerated(options)).drift).toEqual([])
  })

  test('entries under an owned root are an error for a tree that does not own the roots', async () => {
    await expect(buildTree({ root, extraEntries: new Map([['hosts/claude/.mcp.json', entry('{}\n')]]) })).rejects.toThrow(/does not own the owned roots/)
  })

  test('a hand-written SKILL.md survives, and so do other files beside the helper', async () => {
    const skillText = readFileSync(join(root, 'skills', 'demo', 'SKILL.md'), 'utf8')
    writeFileSync(join(root, 'skills', 'demo', 'notes.md'), 'keep')
    mkdirSync(join(root, 'skills', 'demo', 'scripts'), { recursive: true })
    writeFileSync(join(root, 'skills', 'demo', 'scripts', 'other.mjs'), 'keep')
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(readFileSync(join(root, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(skillText)
    expect(readFileSync(join(root, 'skills', 'demo', 'notes.md'), 'utf8')).toBe('keep')
    expect(readFileSync(join(root, 'skills', 'demo', 'scripts', 'other.mjs'), 'utf8')).toBe('keep')
  })

  test('the .agents/skills dev mirror survives clearing .agents/plugins', async () => {
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(readFileSync(join(root, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain('hand-written')
    expect(existsSync(join(root, '.agents', 'skills', 'demo', 'scripts', 'record.mjs'))).toBe(true)
    expect(existsSync(join(root, '.agents', 'plugins', 'marketplace.json'))).toBe(true)
  })

  test('restores the mode of a file that lost or gained the executable bit, including a helper', async () => {
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    chmodSync(join(root, 'hosts/claude/hooks/session-start.mjs'), 0o644)
    chmodSync(join(root, 'hosts/codex/plugin.json'), 0o755)
    chmodSync(join(root, 'skills/demo/scripts/record.mjs'), 0o755)
    await generate({ root, ownedRoots: true, extraEntries: OWNED_FIXTURE })
    expect(lstatSync(join(root, 'hosts/claude/hooks/session-start.mjs')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(root, 'hosts/codex/plugin.json')).mode & 0o111).toBe(0)
    expect(lstatSync(join(root, 'skills/demo/scripts/record.mjs')).mode & 0o111).toBe(0)
  })

  test('a rejected tree writes and clears nothing', async () => {
    mkdirSync(join(root, 'hosts', 'claude'), { recursive: true })
    writeFileSync(join(root, 'hosts', 'claude', 'keep.json'), '{}')
    await expect(generate({ root, extraEntries: new Map([['skills/demo/SKILL.md', entry('x')]]) })).rejects.toThrow(/tree:/)
    expect(existsSync(join(root, 'hosts', 'claude', 'keep.json'))).toBe(true)
  })
})
