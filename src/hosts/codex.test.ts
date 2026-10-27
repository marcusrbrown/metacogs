import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { checkGenerated } from '../generate/check'
import { buildTree, REPO_ROOT, type TreeMap, writeTree } from '../generate/tree'
import { validRecord } from '../record/test-support'
import { validateMcpConfig, validatePluginManifest } from './agent-plugins-schema'
import { CLAUDE_MARKETPLACE_PATH } from './claude'
import { CODEX_DIR, CODEX_MARKETPLACE_PATH, hooksConfig, MCP_SCHEMA_URL, marketplaceManifest, mcpConfig, PLUGIN_SCHEMA_URL } from './codex'
import { renderGuidance } from './guidance'
import { CODEX_PROFILE, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME } from './rules'
import { scanHostTrees } from './scan'

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')
const readJson = (path: string): any => JSON.parse(read(path))
const VERSION: string = readJson('package.json').version

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
        'hooks/hooks.json',
        'hooks/session-start.mjs',
        'mcp/server.mjs',
        ...HOST_SKILLS.map(skill => `skills/${skill}/SKILL.md`),
        ...METHOD_SKILLS.map(skill => `skills/${skill}/scripts/record.mjs`),
      ]
        .map(p => `${CODEX_DIR}/${p}`)
        .sort(),
    )
    expect(readdirSync(join(REPO_ROOT, '.agents', 'plugins'))).toEqual(['marketplace.json'])
  })

  test('plugin.json declares the 1.0.0 schema, the package version, an experimental label and the hooks under the OpenAI namespace', () => {
    const plugin = readJson(`${CODEX_DIR}/plugin.json`)
    expect(plugin).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'metacogs',
      version: VERSION,
      description: expect.stringContaining('Experimental Codex package'),
      author: { name: 'Marcus R. Brown', url: 'https://github.com/marcusrbrown' },
      homepage: 'https://github.com/marcusrbrown/metacogs#readme',
      repository: 'https://github.com/marcusrbrown/metacogs',
      license: 'MIT',
      extensions: { 'com.openai': { hooks: './hooks/hooks.json' } },
    })
    expect(plugin.$schema).toBe(PLUGIN_SCHEMA_URL)
    // the declared hooks file is in the package; `skills/` and `mcp.json` are found at fixed paths, so they are not declared
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, plugin.extensions['com.openai'].hooks))).toBe(true)
    expect('skills' in plugin).toBe(false)
    expect('mcpServers' in plugin).toBe(false)
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'skills'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, CODEX_DIR, 'mcp.json'))).toBe(true)
  })

  test('mcp.json declares the stdio server under the server name, run by node from the plugin root, with no env', () => {
    const mcp = readJson(`${CODEX_DIR}/mcp.json`)
    expect(mcp).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/mcp/server.mjs'] } },
    })
    expect(mcp.$schema).toBe(MCP_SCHEMA_URL)
    expect(mcp).toEqual(JSON.parse(JSON.stringify(mcpConfig())))
  })

  test('hooks.json holds one SessionStart command hook with no matcher', () => {
    const hooks = readJson(`${CODEX_DIR}/hooks/hooks.json`)
    expect(hooks).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/hooks/session-start.mjs"' }] }] } })
    expect(JSON.stringify(hooks)).not.toContain('matcher')
    expect(hooks).toEqual(JSON.parse(JSON.stringify(hooksConfig())))
  })

  test('the hook embeds the Codex note and the Codex host', () => {
    const hook = read(`${CODEX_DIR}/hooks/session-start.mjs`)
    expect(hook).toContain(JSON.stringify(renderGuidance(CODEX_PROFILE)))
    expect(hook).not.toContain(JSON.stringify(renderGuidance({ ...CODEX_PROFILE, label: 'Claude Code' })))
    expect(hook).toContain(`// helper_version: ${VERSION}\n`)
  })

  test('the record helper and the MCP bundle are the same bytes as the other copies; LICENSE and ATTRIBUTIONS.md are copies', () => {
    for (const skill of METHOD_SKILLS) {
      expect(read(`${CODEX_DIR}/skills/${skill}/scripts/record.mjs`)).toBe(read(`skills/${skill}/scripts/record.mjs`))
    }
    expect(read(`${CODEX_DIR}/LICENSE`)).toBe(read('LICENSE'))
    expect(read(`${CODEX_DIR}/ATTRIBUTIONS.md`)).toBe(read('ATTRIBUTIONS.md'))
    expect(read(`${CODEX_DIR}/mcp/server.mjs`)).toBe(read('hosts/claude/mcp/server.mjs'))
  })

  test('the renders are the Codex rule-table output of the shared sources', () => {
    expect(read(`${CODEX_DIR}/skills/drugs/SKILL.md`)).toContain('Call the `mcp__metacogs__drugs` tool')
    expect(read(`${CODEX_DIR}/skills/feel/SKILL.md`)).toContain('`$metacogs:feel`')
    expect(read(`${CODEX_DIR}/skills/synthesis/SKILL.md`)).toContain('node "<directory of this SKILL.md>/scripts/record.mjs"')
    expect(read('skills/synthesis/SKILL.md')).toContain('<skill-base-dir>')
    expect(read('plugin/skills/drugs/SKILL.md')).toContain('Call the `drugs` tool (not the `drugs` skill')
  })
})

describe('the Codex marketplace', () => {
  const market = readJson(CODEX_MARKETPLACE_PATH)

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
    const [entry] = market.plugins
    expect(entry.name).toBe(PLUGIN_NAME)
    expect(entry.source.path.startsWith('./')).toBe(true)
    expect(isAbsolute(entry.source.path)).toBe(false)
    const target = resolve(REPO_ROOT, entry.source.path)
    expect(target.startsWith(`${REPO_ROOT}/`)).toBe(true)
    expect(existsSync(join(target, 'plugin.json'))).toBe(true)
    expect(readJson(`${entry.source.path.slice(2)}/plugin.json`).name).toBe(entry.name)
  })

  test('uses the values Codex documents: AVAILABLE installation, and ON_INSTALL or ON_USE authentication', () => {
    const { policy } = market.plugins[0]
    expect(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT']).toContain(policy.installation)
    expect(['ON_INSTALL', 'ON_USE']).toContain(policy.authentication)
    expect('version' in market.plugins[0]).toBe(false)
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
    await writeTree(root, tree)
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
  test('plugin.json, the hook banner and the server banner carry the new version', async () => {
    const root = mkdtempSync(join(scratch, 'bump-'))
    const options = { root, hosts: true, helperVersion: '9.8.7' } as const
    await writeTree(root, await buildTree(options))

    expect(JSON.parse(readFileSync(join(root, CODEX_DIR, 'plugin.json'), 'utf8')).version).toBe('9.8.7')
    expect('version' in JSON.parse(readFileSync(join(root, CODEX_MARKETPLACE_PATH), 'utf8')).plugins[0]).toBe(false)
    for (const path of ['hooks/session-start.mjs', 'mcp/server.mjs', 'skills/synthesis/scripts/record.mjs']) {
      expect(readFileSync(join(root, CODEX_DIR, path), 'utf8')).toContain('// helper_version: 9.8.7\n')
    }
    expect(await checkGenerated(options)).toEqual({ drift: [], findings: [] })

    const stale = (await checkGenerated({ root, hosts: true })).drift.map(d => d.path)
    expect(stale).toContain(`${CODEX_DIR}/plugin.json`)
    expect(stale).toContain(`${CODEX_DIR}/hooks/session-start.mjs`)
    expect(stale).not.toContain(`${CODEX_DIR}/hooks/hooks.json`)
    expect(stale).not.toContain(`${CODEX_DIR}/mcp.json`)
    expect(stale).not.toContain(CODEX_MARKETPLACE_PATH)
  }, 60_000)
})

// Relocation: Codex installs a copy of the plugin under its plugin cache. The copy has no node_modules and the commands
// run from an unrelated working directory, so nothing may resolve through the repository. Codex gives the commands
// PLUGIN_ROOT in the environment (hooks) and substitutes ${PLUGIN_ROOT} in mcp.json.
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

  const hookCommand = (): string => readJson(`${CODEX_DIR}/hooks/hooks.json`).hooks.SessionStart[0].hooks[0].command

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

  test("the hook's own command prints the Codex note from the relocated plugin root, from another cwd", () => {
    const result = spawnSync('sh', ['-c', hookCommand()], {
      cwd: elsewhere,
      env: { PATH: process.env.PATH ?? '', HOME: elsewhere, PLUGIN_ROOT: relocated },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(renderGuidance(CODEX_PROFILE))
    expect(result.stdout).not.toMatch(/^\s*[{[]/)
  })

  test("the relocated hook is silenced by METACOGS_GUIDANCE=off, and the Claude option does not silence it", () => {
    const run = (env: Record<string, string>) =>
      spawnSync('sh', ['-c', hookCommand()], { cwd: elsewhere, env: { PATH: process.env.PATH ?? '', HOME: elsewhere, PLUGIN_ROOT: relocated, ...env }, encoding: 'utf8' })
    expect(run({ METACOGS_GUIDANCE: 'off' })).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(run({ CLAUDE_PLUGIN_OPTION_GUIDANCE: 'false' }).stdout).toBe(renderGuidance(CODEX_PROFILE))
  })

  test("the MCP config's own command starts a server that answers tools/list from the relocated root", async () => {
    const { command, args } = readJson(`${CODEX_DIR}/mcp.json`).mcpServers[MCP_SERVER_NAME] as { command: string; args: string[] }
    const proc = spawn(command, args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', relocated)), { cwd: elsewhere, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const responses = new Map<number, any>()
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
          const message = JSON.parse(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          if (message.id !== undefined) responses.set(message.id, message)
        }
      })
      const ask = async (id: number, method: string, params?: object): Promise<any> => {
        send(proc, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        for (let waited = 0; !responses.has(id); waited += 25) {
          if (waited > 10_000) throw new Error(`no response to ${method}; stderr: ${stderr}`)
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return responses.get(id)
      }
      const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relocation-test', version: '0.0.0' } })
      expect(init.result.serverInfo).toEqual({ name: MCP_SERVER_NAME, version: VERSION })
      send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' })
      const list = await ask(2, 'tools/list')
      expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['drugs', 'feel'])
      for (const tool of list.result.tools) expect(tool.annotations.readOnlyHint).toBe(true)
    } finally {
      proc.kill()
    }
  }, 30_000)

  test('the record helper in the relocated skill writes a record from its own directory', () => {
    const records = mkdtempSync(join(elsewhere, 'records-'))
    const helper = join(relocated, 'skills', 'counterfactual', 'scripts', 'record.mjs')
    const result = spawnSync('node', [helper], {
      cwd: elsewhere,
      env: { PATH: process.env.PATH ?? '', HOME: elsewhere, METACOGS_RECORDS_DIR: records },
      input: JSON.stringify(validRecord({ method: 'counterfactual' })),
      encoding: 'utf8',
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(readdirSync(records, { recursive: true }).some(name => String(name).endsWith('.json'))).toBe(true)
  })
})

function send(proc: ChildProcessWithoutNullStreams, message: object): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`)
}
