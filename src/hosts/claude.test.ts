import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkGenerated } from '../generate/check'
import { buildTree, REPO_ROOT, type TreeMap, writeTree } from '../generate/tree'
import { CLAUDE_DIR, CLAUDE_MARKETPLACE_PATH, hooksConfig, marketplaceManifest, mcpConfig } from './claude'
import { validRecord } from '../record/test-support'
import { renderGuidance } from './guidance'
import { CLAUDE_PROFILE, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME } from './rules'
import { scanHostTrees } from './scan'
import { arr, at, obj, type RpcMessage, readJsonFile, str } from './test-support'

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')
const readJson = (path: string) => readJsonFile(REPO_ROOT, path)
const VERSION: string = str(at(readJson('package.json'), 'version'))

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-claude-'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the committed Claude package', () => {
  test('matches what the sources generate, and passes the rewrite scan (generate:check)', async () => {
    expect(await checkGenerated()).toEqual({ drift: [], findings: [] })
  })

  test('has exactly the planned files', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
    expect(walk(CLAUDE_DIR).sort()).toEqual(
      [
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'ATTRIBUTIONS.md',
        'LICENSE',
        'hooks/hooks.json',
        'hooks/session-start.mjs',
        'mcp/server.mjs',
        ...HOST_SKILLS.map(skill => `skills/${skill}/SKILL.md`),
        ...METHOD_SKILLS.map(skill => `skills/${skill}/scripts/record.mjs`),
      ]
        .map(p => `${CLAUDE_DIR}/${p}`)
        .sort(),
    )
    expect(readdirSync(join(REPO_ROOT, '.claude-plugin'))).toEqual(['marketplace.json'])
  })

  test('plugin.json carries the package version, the metadata --strict wants and a boolean guidance option', () => {
    const plugin = obj(readJson(`${CLAUDE_DIR}/.claude-plugin/plugin.json`))
    expect(plugin).toMatchObject({
      name: 'metacogs',
      version: VERSION,
      author: { name: 'Marcus R. Brown' },
      homepage: 'https://github.com/marcusrbrown/metacogs#readme',
      repository: 'https://github.com/marcusrbrown/metacogs',
      license: 'MIT',
    })
    expect(typeof plugin.description).toBe('string')
    expect(plugin.userConfig).toEqual({
      guidance: { type: 'boolean', title: expect.any(String), description: expect.any(String), default: true },
    })
  })

  test('the marketplace has an owner and a description, and its entry points at the plugin directory with no version', () => {
    const market = obj(readJson(CLAUDE_MARKETPLACE_PATH))
    expect(market.name).toBe('metacogs')
    expect(at(market, 'owner', 'name')).toBe('Marcus R. Brown')
    expect(str(at(market, 'metadata', 'description')).length).toBeGreaterThan(0)
    expect(market.plugins).toHaveLength(1)
    const entry = obj(arr(market.plugins)[0])
    expect(entry).toMatchObject({ name: PLUGIN_NAME, source: './hosts/claude' })
    expect('version' in entry).toBe(false)
    expect(existsSync(join(REPO_ROOT, str(entry.source), '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(market).toEqual(JSON.parse(JSON.stringify(marketplaceManifest())))
  })

  test('.mcp.json runs the bundled server from the plugin root under the server name', () => {
    const mcp = readJson(`${CLAUDE_DIR}/.mcp.json`)
    expect(mcp).toEqual({ mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'] } } })
    expect(mcp).toEqual(JSON.parse(JSON.stringify(mcpConfig())))
  })

  test('hooks.json holds one SessionStart command hook with no matcher', () => {
    const hooks = readJson(`${CLAUDE_DIR}/hooks/hooks.json`)
    expect(hooks).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"' }] }] } })
    expect(JSON.stringify(hooks)).not.toContain('matcher')
    expect(hooks).toEqual(JSON.parse(JSON.stringify(hooksConfig())))
  })

  test('the record helper is the same bytes as the repo-level helper, LICENSE and ATTRIBUTIONS.md are copies', () => {
    for (const skill of METHOD_SKILLS) {
      expect(read(`${CLAUDE_DIR}/skills/${skill}/scripts/record.mjs`)).toBe(read(`skills/${skill}/scripts/record.mjs`))
    }
    expect(read(`${CLAUDE_DIR}/LICENSE`)).toBe(read('LICENSE'))
    expect(read(`${CLAUDE_DIR}/ATTRIBUTIONS.md`)).toBe(read('ATTRIBUTIONS.md'))
    expect(read(`${CLAUDE_DIR}/mcp/server.mjs`)).toBe(read('hosts/codex/mcp/server.mjs'))
  })

  test('the renders are the rule-table output of the shared sources', () => {
    expect(read(`${CLAUDE_DIR}/skills/drugs/SKILL.md`)).toContain('mcp__plugin_metacogs_metacogs__drugs')
    expect(read(`${CLAUDE_DIR}/skills/synthesis/SKILL.md`)).toContain('node "${CLAUDE_SKILL_DIR}/scripts/record.mjs"')
    // the shared sources themselves are untouched
    expect(read('skills/synthesis/SKILL.md')).toContain('<skill-base-dir>')
    expect(read('plugin/skills/drugs/SKILL.md')).toContain('Call the `drugs` tool (not the `drugs` skill')
  })
})

describe('the generated Claude tree and the rewrite scan', () => {
  const text = (tree: TreeMap, path: string): string => new TextDecoder().decode(tree.get(path)?.bytes)

  test('passes the denylist and the positive check', async () => {
    expect(scanHostTrees(await buildTree({}))).toEqual([])
  })

  test('a leftover in a generated render fails the scan', async () => {
    const tree = new Map(await buildTree({}))
    const path = 'hosts/claude/skills/counterfactual/SKILL.md'
    const entry = tree.get(path)
    if (entry === undefined) throw new Error('missing render')
    tree.set(path, { ...entry, bytes: new TextEncoder().encode(`${text(tree, path)}\nnode "<skill-base-dir>/scripts/record.mjs"\n`) })
    expect(scanHostTrees(tree)).toContainEqual({ path, problem: 'denylisted: skill base directory placeholder' })
  })

  test('a render that lost its Claude tool name fails the scan', async () => {
    const tree = new Map(await buildTree({}))
    const path = 'hosts/claude/skills/drugs/SKILL.md'
    const entry = tree.get(path)
    if (entry === undefined) throw new Error('missing render')
    tree.set(path, { ...entry, bytes: new TextEncoder().encode(text(tree, path).replaceAll('mcp__plugin_metacogs_metacogs__drugs', 'drugs')) })
    const problems = scanHostTrees(tree).filter(f => f.path === path).map(f => f.problem)
    expect(problems).toContain('missing token: mcp__plugin_metacogs_metacogs__drugs')
    expect(problems).toContain('denylisted: tool called by its bare name')
  })
})

describe('AE4: a version bump moves both manifests and the check still passes', () => {
  test('the manifests, the hook banner and the server banner carry the new version', async () => {
    const root = mkdtempSync(join(scratch, 'bump-'))
    const options = { root, hosts: true, helperVersion: '9.8.7' } as const
    const tree = await buildTree(options)
    await writeTree(root, tree, true)

    expect(JSON.parse(readFileSync(join(root, CLAUDE_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe('9.8.7')
    expect('version' in JSON.parse(readFileSync(join(root, CLAUDE_MARKETPLACE_PATH), 'utf8')).plugins[0]).toBe(false)
    for (const path of ['hooks/session-start.mjs', 'mcp/server.mjs', 'skills/synthesis/scripts/record.mjs']) {
      expect(readFileSync(join(root, CLAUDE_DIR, path), 'utf8')).toContain('// helper_version: 9.8.7\n')
    }
    expect(await checkGenerated(options)).toEqual({ drift: [], findings: [] })

    // The same tree checked against the real version differs only in the version-bearing files.
    const stale = (await checkGenerated({ root, hosts: true })).drift.map(d => d.path)
    expect(stale).toContain(`${CLAUDE_DIR}/.claude-plugin/plugin.json`)
    expect(stale).toContain(`${CLAUDE_DIR}/hooks/session-start.mjs`)
    expect(stale).not.toContain(`${CLAUDE_DIR}/hooks/hooks.json`)
    expect(stale).not.toContain(CLAUDE_MARKETPLACE_PATH)
  }, 60_000)
})

// Relocation: Claude copies the plugin into its cache. The copy has no node_modules and the commands run from an
// unrelated working directory, so nothing may resolve through the repository.
describe('the package relocated to a directory outside the repository', () => {
  let relocated: string
  let elsewhere: string

  beforeAll(() => {
    const root = mkdtempSync(join(scratch, 'cache-'))
    relocated = join(root, 'plugins', 'cache', 'metacogs', 'metacogs', VERSION)
    mkdirSync(dirname(relocated), { recursive: true })
    cpSync(join(REPO_ROOT, CLAUDE_DIR), relocated, { recursive: true })
    elsewhere = mkdtempSync(join(root, 'cwd-'))
  })

  /** The command Claude would run: the manifest string with ${CLAUDE_PLUGIN_ROOT} resolved by the shell's environment. */
  const hookCommand = (): string => str(at(readJson(`${CLAUDE_DIR}/hooks/hooks.json`), 'hooks', 'SessionStart', 0, 'hooks', 0, 'command'))

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

  test("the hook's own command prints the note from the relocated plugin root, from another cwd", () => {
    const result = spawnSync('sh', ['-c', hookCommand()], {
      cwd: elsewhere,
      env: { PATH: process.env.PATH ?? '', HOME: elsewhere, CLAUDE_PLUGIN_ROOT: relocated },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(renderGuidance(CLAUDE_PROFILE))
  })

  test("the MCP config's own command starts a server that answers tools/list from the relocated root", async () => {
    const server = obj(at(readJson(`${CLAUDE_DIR}/.mcp.json`), 'mcpServers', MCP_SERVER_NAME))
    const command = str(server.command)
    const args = arr(server.args).map(arg => str(arg))
    const proc = spawn(command, args.map(arg => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', relocated)), { cwd: elsewhere, stdio: ['pipe', 'pipe', 'pipe'] })
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
      expect(tools.map(tool => tool.name).sort()).toEqual(['drugs', 'feel'])
      for (const tool of tools) expect(obj(tool.annotations).readOnlyHint).toBe(true)
    } finally {
      proc.kill()
    }
  }, 30_000)

  test('the record helper in the relocated skill writes a record from its own directory (AE5, runtime part)', () => {
    const records = mkdtempSync(join(elsewhere, 'records-'))
    const helper = join(relocated, 'skills', 'synthesis', 'scripts', 'record.mjs')
    const result = spawnSync('node', [helper], {
      cwd: elsewhere,
      env: { PATH: process.env.PATH ?? '', HOME: elsewhere, METACOGS_RECORDS_DIR: records },
      input: JSON.stringify(validRecord({ method: 'synthesis' })),
      encoding: 'utf8',
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(readdirSync(records, { recursive: true }).some(name => String(name).endsWith('.json'))).toBe(true)
  })
})

function send(proc: ChildProcessWithoutNullStreams, message: object): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`)
}
