import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { generate } from '../generate/bundle-helpers'
import { checkGenerated } from '../generate/check'
import { buildTree, REPO_ROOT, type TreeMap, writeTree } from '../generate/tree'
import { validRecord } from '../record/test-support'
import { validateMcpConfig, validatePluginManifest } from './agent-plugins-schema'
import { CLAUDE_MARKETPLACE_PATH } from './claude'
import { CODEX_DIR, CODEX_MARKETPLACE_PATH, MCP_SCHEMA_URL, marketplaceManifest, mcpConfig, PLUGIN_SCHEMA_URL } from './codex'
import { CLAUDE_PROFILE, CODEX_PROFILE, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME } from './rules'
import { scanHostTrees } from './scan'
import { arr, at, obj, type RpcMessage, readJsonFile, str } from './test-support'

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')
const readJson = (path: string) => readJsonFile(REPO_ROOT, path)
const VERSION: string = str(at(readJson('package.json'), 'version'))

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-codex-'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the committed Codex package', () => {
  test('matches what the sources generate, and passes the rewrite scan (generate:check)', async () => {
    expect(await checkGenerated()).toEqual({ drift: [], findings: [] })
  })

  test('has exactly the planned files', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
    expect(walk(CODEX_DIR).sort()).toEqual(
      [
        'plugin.json',
        'mcp.json',
        'ATTRIBUTIONS.md',
        'LICENSE',
        'mcp/server.mjs',
        ...HOST_SKILLS.map(skill => `skills/${skill}/SKILL.md`),
      ]
        .map(p => `${CODEX_DIR}/${p}`)
        .sort(),
    )
    expect(readdirSync(join(REPO_ROOT, '.agents', 'plugins'))).toEqual(['marketplace.json'])
  })

  test('plugin.json declares the 1.0.0 schema, the package version and an experimental label, and no hooks', () => {
    const plugin = obj(readJson(`${CODEX_DIR}/plugin.json`))
    expect(plugin).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'metacogs',
      version: VERSION,
      description: expect.stringContaining('Experimental Codex package'),
      author: { name: 'Marcus R. Brown', url: 'https://github.com/marcusrbrown' },
      homepage: 'https://github.com/marcusrbrown/metacogs#readme',
      repository: 'https://github.com/marcusrbrown/metacogs',
      license: 'MIT',
    })
    expect(plugin.$schema).toBe(PLUGIN_SCHEMA_URL)
    // Codex discards the hooks of an agent-plugins package, so there are none: no extension block and no hooks directory.
    // `skills/` and `mcp.json` are found at fixed paths, so they are not declared either.
    expect('extensions' in plugin).toBe(false)
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'hooks'))).toBe(false)
    expect('skills' in plugin).toBe(false)
    expect('mcpServers' in plugin).toBe(false)
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'skills'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'mcp.json'))).toBe(true)
  })

  test('mcp.json declares the stdio server under the server name, run by node from the plugin root, with no env', () => {
    const mcp = obj(readJson(`${CODEX_DIR}/mcp.json`))
    expect(mcp).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/mcp/server.mjs'] } },
    })
    expect(mcp.$schema).toBe(MCP_SCHEMA_URL)
    expect(mcp).toEqual(JSON.parse(JSON.stringify(mcpConfig())))
  })

  test('ships no record helper: the method skills call the record tool of the bundled server', () => {
    for (const skill of HOST_SKILLS) expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'skills', skill, 'scripts')), skill).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'skills', 'counterfactual', 'scripts', 'record.mjs'))).toBe(true)
  })

  test('the MCP bundle is the same bytes as the Claude copy; LICENSE and ATTRIBUTIONS.md are copies', () => {
    expect(read(`${CODEX_DIR}/LICENSE`)).toBe(read('LICENSE'))
    expect(read(`${CODEX_DIR}/ATTRIBUTIONS.md`)).toBe(read('ATTRIBUTIONS.md'))
    expect(read(`${CODEX_DIR}/mcp/server.mjs`)).toBe(read('hosts/claude/mcp/server.mjs'))
  })

  test('the renders are the Codex rule-table output of the shared sources', () => {
    expect(read(`${CODEX_DIR}/skills/drugs/SKILL.md`)).toContain('Call the `mcp__metacogs__drugs` tool')
    expect(read(`${CODEX_DIR}/skills/feel/SKILL.md`)).toContain('`$metacogs:feel`')
    for (const skill of METHOD_SKILLS) {
      const text = read(`${CODEX_DIR}/skills/${skill}/SKILL.md`)
      expect(text).toContain(`\`${CODEX_PROFILE.recordTool}\``)
      expect(text).not.toContain('record.mjs')
    }
    expect(read('skills/synthesis/SKILL.md')).toContain('<skill-base-dir>')
    expect(read('plugin/skills/drugs/SKILL.md')).toContain('Call the `drugs` tool (not the `drugs` skill')
  })
})

describe('the Codex marketplace', () => {
  const market = obj(readJson(CODEX_MARKETPLACE_PATH))

  test('names the marketplace and carries one local entry with an install policy and a category', () => {
    expect(market).toEqual({
      name: 'metacogs',
      interface: { displayName: 'metacogs' },
      plugins: [
        {
          name: 'metacogs',
          source: { source: 'local', path: './hosts/codex' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
          category: 'Developer Tools',
        },
      ],
    })
    expect(market).toEqual(JSON.parse(JSON.stringify(marketplaceManifest())))
  })

  test('the entry points at an existing plugin directory, inside the repository, with a ./ path', () => {
    const entry = obj(arr(market.plugins)[0])
    const sourcePath = str(at(entry, 'source', 'path'))
    expect(entry.name).toBe(PLUGIN_NAME)
    expect(sourcePath.startsWith('./')).toBe(true)
    expect(isAbsolute(sourcePath)).toBe(false)
    const target = resolve(REPO_ROOT, sourcePath)
    expect(target.startsWith(`${REPO_ROOT}/`)).toBe(true)
    expect(existsSync(join(target, 'plugin.json'))).toBe(true)
    expect(at(readJson(`${sourcePath.slice(2)}/plugin.json`), 'name')).toBe(str(entry.name))
  })

  test('uses the values Codex documents: AVAILABLE installation, and ON_INSTALL or ON_USE authentication', () => {
    const entry = obj(arr(market.plugins)[0])
    const policy = obj(entry.policy)
    expect(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT']).toContain(str(policy.installation))
    expect(['ON_INSTALL', 'ON_USE']).toContain(str(policy.authentication))
    expect('version' in entry).toBe(false)
  })
})

describe('the generated Codex tree and the rewrite scan', () => {
  const text = (tree: TreeMap, path: string): string => new TextDecoder().decode(tree.get(path)?.bytes)

  test('passes the denylist and the positive check', async () => {
    expect(scanHostTrees(await buildTree({}))).toEqual([])
  })

  test('the committed manifests validate against the vendored schemas', () => {
    expect(validatePluginManifest(readJson(`${CODEX_DIR}/plugin.json`))).toEqual([])
    expect(validateMcpConfig(readJson(`${CODEX_DIR}/mcp.json`))).toEqual([])
  })

  test('the manifests in a fresh build validate too', async () => {
    const tree = await buildTree({})
    expect(validatePluginManifest(JSON.parse(text(tree, `${CODEX_DIR}/plugin.json`)))).toEqual([])
    expect(validateMcpConfig(JSON.parse(text(tree, `${CODEX_DIR}/mcp.json`)))).toEqual([])
  })

  test('a leftover in a generated render fails the scan', async () => {
    const tree = new Map(await buildTree({}))
    const path = `${CODEX_DIR}/skills/counterfactual/SKILL.md`
    const entry = tree.get(path)
    if (entry === undefined) throw new Error('missing render')
    tree.set(path, { ...entry, bytes: new TextEncoder().encode(`${text(tree, path)}\nnode "<skill-base-dir>/scripts/record.mjs"\n`) })
    expect(scanHostTrees(tree)).toContainEqual({ path, problem: 'denylisted: skill base directory placeholder' })
    expect(scanHostTrees(tree)).toContainEqual({ path, problem: 'helper instruction: record.mjs' })
  })

  test('a method render that took the Claude record tool name fails the scan', async () => {
    const tree = new Map(await buildTree({}))
    const path = `${CODEX_DIR}/skills/synthesis/SKILL.md`
    const entry = tree.get(path)
    if (entry === undefined) throw new Error('missing render')
    tree.set(path, { ...entry, bytes: new TextEncoder().encode(text(tree, path).replaceAll(CODEX_PROFILE.recordTool, CLAUDE_PROFILE.recordTool)) })
    const problems = scanHostTrees(tree).filter(f => f.path === path).map(f => f.problem)
    expect(problems).toContain(`missing token: ${CODEX_PROFILE.recordTool}`)
    expect(problems).toContain("another host's token: mcp__plugin_")
  })

  test('a render that lost its Codex tool name or took a Claude one fails the scan', async () => {
    const tree = new Map(await buildTree({}))
    const path = `${CODEX_DIR}/skills/drugs/SKILL.md`
    const entry = tree.get(path)
    if (entry === undefined) throw new Error('missing render')
    tree.set(path, { ...entry, bytes: new TextEncoder().encode(text(tree, path).replaceAll('mcp__metacogs__drugs', 'mcp__plugin_metacogs_metacogs__drugs')) })
    const problems = scanHostTrees(tree).filter(f => f.path === path).map(f => f.problem)
    expect(problems).toContain('missing token: mcp__metacogs__drugs')
    expect(problems).toContain("another host's token: mcp__plugin_")
  })
})

describe('with both marketplace files present, generate:check covers both', () => {
  let root: string
  let tree: TreeMap
  const options = (): { root: string; hosts: true } => ({ root, hosts: true })

  beforeAll(async () => {
    root = mkdtempSync(join(scratch, 'both-'))
    tree = await buildTree({ root, hosts: true })
    await writeTree(root, tree, true)
  }, 60_000)

  test('both catalogs are in the tree map, and a clean write has no drift', async () => {
    expect(tree.has(CODEX_MARKETPLACE_PATH)).toBe(true)
    expect(tree.has(CLAUDE_MARKETPLACE_PATH)).toBe(true)
    expect(await checkGenerated(options())).toEqual({ drift: [], findings: [] })
  })

  test('a hand edit, a deletion or a stray file under either catalog directory is reported', async () => {
    for (const path of [CODEX_MARKETPLACE_PATH, CLAUDE_MARKETPLACE_PATH]) {
      const file = join(root, path)
      const original = readFileSync(file)
      writeFileSync(file, `${original.toString('utf8')} `)
      expect((await checkGenerated(options())).drift, `edited ${path}`).toEqual([{ path, kind: 'changed' }])
      writeFileSync(file, original)

      rmSync(file)
      expect((await checkGenerated(options())).drift, `deleted ${path}`).toEqual([{ path, kind: 'missing' }])
      writeFileSync(file, original)

      const stray = join(dirname(file), 'extra.json')
      writeFileSync(stray, '{}')
      expect((await checkGenerated(options())).drift, `stray beside ${path}`).toEqual([{ path: `${dirname(path)}/extra.json`, kind: 'extra' }])
      rmSync(stray)
    }
    expect(await checkGenerated(options())).toEqual({ drift: [], findings: [] })
  })

  test('a stale file in an owned root is reported by the check, then removed by generate', async () => {
    const stale = join(root, 'hosts', 'claude', 'stale.json')
    writeFileSync(stale, '{}')
    expect((await checkGenerated(options())).drift).toEqual([{ path: 'hosts/claude/stale.json', kind: 'extra' }])
    await generate(options())
    expect(existsSync(stale)).toBe(false)
    expect(await checkGenerated(options())).toEqual({ drift: [], findings: [] })
  })

  test('a stale Codex file is reported alongside the Claude package', async () => {
    const file = join(root, CODEX_DIR, 'skills', 'feel', 'SKILL.md')
    const original = readFileSync(file)
    writeFileSync(file, original.toString('utf8').replace('mcp__metacogs__feel', 'feel'))
    const { drift, findings } = await checkGenerated(options())
    expect(drift).toEqual([{ path: `${CODEX_DIR}/skills/feel/SKILL.md`, kind: 'changed' }])
    expect(findings).toEqual([])
    writeFileSync(file, original)
  })
})

describe('a version bump moves the Codex manifest and the check still passes', () => {
  test('plugin.json and the server banner carry the new version', async () => {
    const root = mkdtempSync(join(scratch, 'bump-'))
    const options = { root, hosts: true, helperVersion: '9.8.7' } as const
    await writeTree(root, await buildTree(options), true)

    expect(JSON.parse(readFileSync(join(root, CODEX_DIR, 'plugin.json'), 'utf8')).version).toBe('9.8.7')
    expect('version' in JSON.parse(readFileSync(join(root, CODEX_MARKETPLACE_PATH), 'utf8')).plugins[0]).toBe(false)
    expect(readFileSync(join(root, CODEX_DIR, 'mcp/server.mjs'), 'utf8')).toContain('// helper_version: 9.8.7\n')
    expect(await checkGenerated(options)).toEqual({ drift: [], findings: [] })

    const stale = (await checkGenerated({ root, hosts: true })).drift.map(d => d.path)
    expect(stale).toContain(`${CODEX_DIR}/plugin.json`)
    expect(stale).toContain(`${CODEX_DIR}/mcp/server.mjs`)
    expect(stale).not.toContain(`${CODEX_DIR}/mcp.json`)
    expect(stale).not.toContain(CODEX_MARKETPLACE_PATH)
  }, 60_000)
})

// Relocation: Codex installs a copy of the plugin under its plugin cache. The copy has no node_modules and the commands
// run from an unrelated working directory, so nothing may resolve through the repository. Codex gives the commands
// substitutes ${PLUGIN_ROOT} in mcp.json.
describe('the package relocated to a directory outside the repository', () => {
  let relocated: string
  let elsewhere: string

  beforeAll(() => {
    const root = mkdtempSync(join(scratch, 'cache-'))
    relocated = join(root, '.codex', 'plugins', 'cache', 'metacogs', 'metacogs', VERSION)
    mkdirSync(dirname(relocated), { recursive: true })
    cpSync(join(REPO_ROOT, CODEX_DIR), relocated, { recursive: true })
    elsewhere = mkdtempSync(join(root, 'cwd-'))
  })

  test('runs on Node 22 or later', () => {
    const major = Number(/^v(\d+)\./.exec(spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout)?.[1])
    expect(major).toBeGreaterThanOrEqual(22)
  })

  test('has no node_modules and no path into the repository', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    const files = walk(relocated)
    expect(files.some(f => f.includes('node_modules'))).toBe(false)
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toContain(REPO_ROOT)
  })

  test("the MCP config's own command starts a server that lists the three tools and writes a record from the relocated root", async () => {
    const records = mkdtempSync(join(elsewhere, 'records-'))
    const server = obj(at(readJson(`${CODEX_DIR}/mcp.json`), 'mcpServers', MCP_SERVER_NAME))
    const command = str(server.command)
    const args = arr(server.args).map(arg => str(arg))
    const proc = spawn(command, args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', relocated)), {
      cwd: elsewhere,
      env: { PATH: process.env.PATH ?? '', HOME: elsewhere, METACOGS_RECORDS_DIR: records },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const responses = new Map<number, RpcMessage>()
      let buffer = ''
      let stderr = ''
      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', chunk => {
        stderr += chunk
      })
      proc.stdout.on('data', chunk => {
        buffer += chunk
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const message: RpcMessage = JSON.parse(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          if (message.id !== undefined) responses.set(message.id, message)
        }
      })
      const ask = async (id: number, method: string, params?: object): Promise<RpcMessage> => {
        send(proc, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        for (let waited = 0; !responses.has(id); waited += 25) {
          if (waited > 10_000) throw new Error(`no response to ${method}; stderr: ${stderr}`)
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return responses.get(id)!
      }
      const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relocation-test', version: '0.0.0' } })
      expect(init.result?.serverInfo).toEqual({ name: MCP_SERVER_NAME, version: VERSION })
      send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' })
      const list = await ask(2, 'tools/list')
      const tools = arr(list.result?.tools).map(tool => obj(tool))
      expect(tools.map(tool => tool.name).sort()).toEqual(['drugs', 'feel', 'record'])
      for (const tool of tools.filter(tool => tool.name !== 'record')) expect(obj(tool.annotations).readOnlyHint).toBe(true)
      const call = await ask(3, 'tools/call', { name: 'record', arguments: validRecord({ method: 'counterfactual' }) })
      expect(call.result?.isError).toBeUndefined()
      expect(readdirSync(records).filter(name => name.endsWith('.json'))).toHaveLength(1)
    } finally {
      proc.kill()
    }
  }, 30_000)
})

function send(proc: ChildProcessWithoutNullStreams, message: object): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`)
}
