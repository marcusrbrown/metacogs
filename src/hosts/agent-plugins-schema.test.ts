import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import {
  convertSchema,
  dropUnconvertibleKeyword,
  MCP_SCHEMA_PATH,
  PLUGIN_SCHEMA_PATH,
  RESERVED_ENV_KEYS,
  reservedEnvKeys,
  SCHEMA_SHA256,
  sha256,
  validateMcpConfig,
  validatePluginManifest,
} from './agent-plugins-schema'
import { at, type JsonValue, parseJson, str } from './test-support'

const readRepo = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')
const readJson = (path: string): JsonValue => parseJson(readRepo(path))

const PLUGIN_SCHEMA_URL: string = str(at(readJson(PLUGIN_SCHEMA_PATH), '$id'))
const MCP_SCHEMA_URL: string = str(at(readJson(MCP_SCHEMA_PATH), '$id'))

const goodPlugin = (): Record<string, unknown> => ({ $schema: PLUGIN_SCHEMA_URL, name: 'metacogs', version: '1.0.0', extensions: { 'com.openai': { hooks: './hooks/hooks.json' } } })
/** The stdio server entry the tests edit one field of at a time; every field a test deletes or adds is optional here. */
interface StdioServerFixture {
  type?: string
  command?: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  extra?: boolean
}
interface McpFixture {
  $schema: string
  mcpServers: { metacogs: StdioServerFixture }
}
const goodMcp = (): McpFixture => ({ $schema: MCP_SCHEMA_URL, mcpServers: { metacogs: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/mcp/server.mjs'] } } })

describe('the vendored agent-plugins.org 1.0.0 schemas', () => {
  test('stay byte-identical to the published files (recorded sha256)', () => {
    expect(SCHEMA_SHA256).toEqual({
      'src/hosts/schemas/agent-plugins-1.0.0/plugin.schema.json': '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883',
      'src/hosts/schemas/agent-plugins-1.0.0/mcp.schema.json': '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb',
    })
    for (const path of [PLUGIN_SCHEMA_PATH, MCP_SCHEMA_PATH] as const) expect(sha256(readRepo(path)), path).toBe(SCHEMA_SHA256[path])
  })

  test('are unmodified: they still carry the keyword the validator drops in memory, and name their own ids', () => {
    expect(at(readJson(MCP_SCHEMA_PATH), '$defs', 'stdioServer', 'properties', 'env', 'propertyNames')).toEqual({ not: { enum: ['PLUGIN_ROOT', 'PLUGIN_DATA'] } })
    expect(PLUGIN_SCHEMA_URL).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(MCP_SCHEMA_URL).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  })
})

describe('the converted plugin schema rejects', () => {
  test('a good manifest passes, with and without the optional fields', () => {
    expect(validatePluginManifest(goodPlugin())).toEqual([])
    expect(validatePluginManifest({ $schema: PLUGIN_SCHEMA_URL, name: 'a' })).toEqual([])
  })

  test('a missing $schema', () => {
    const { $schema: _, ...rest } = goodPlugin()
    expect(validatePluginManifest(rest).join('\n')).toContain('$schema')
  })

  test('a $schema that names another schema', () => {
    expect(validatePluginManifest({ ...goodPlugin(), $schema: MCP_SCHEMA_URL })).not.toEqual([])
  })

  test('a bad name', () => {
    for (const name of ['Bad Name', 'UPPER', '-lead', 'trail-', 'a--b', 'a..b', '', 'x'.repeat(65)]) {
      expect(validatePluginManifest({ ...goodPlugin(), name }), JSON.stringify(name)).not.toEqual([])
    }
    expect(validatePluginManifest({ ...goodPlugin(), name: 'Bad Name' }).join('\n')).toContain('name')
  })

  test('an unknown top-level key', () => {
    expect(validatePluginManifest({ ...goodPlugin(), hooks: './hooks/hooks.json' }).join('\n')).toContain('hooks')
  })

  test('an unknown key in author, and a non-object extension namespace', () => {
    expect(validatePluginManifest({ ...goodPlugin(), author: { name: 'x', nick: 'y' } })).not.toEqual([])
    expect(validatePluginManifest({ ...goodPlugin(), extensions: { 'com.openai': 'x' } })).not.toEqual([])
  })

  test('input that is not an object', () => {
    for (const value of [null, 'x', 3, []]) expect(validatePluginManifest(value), JSON.stringify(value)).not.toEqual([])
  })
})

describe('the converted MCP schema rejects', () => {
  test('a good config passes', () => {
    expect(validateMcpConfig(goodMcp())).toEqual([])
    expect(validateMcpConfig({ ...goodMcp(), mcpServers: { a: { type: 'streamable-http', url: 'https://example.com/mcp' } } })).toEqual([])
  })

  test('a missing $schema and a missing mcpServers', () => {
    const { $schema: _, ...noSchema } = goodMcp()
    expect(validateMcpConfig(noSchema).join('\n')).toContain('$schema')
    expect(validateMcpConfig({ $schema: MCP_SCHEMA_URL }).join('\n')).toContain('mcpServers')
  })

  test('an mcpServers entry with no command', () => {
    const config = goodMcp()
    delete config.mcpServers.metacogs.command
    expect(validateMcpConfig(config)).not.toEqual([])
    config.mcpServers.metacogs.command = ''
    expect(validateMcpConfig(config)).not.toEqual([])
  })

  test('an entry with no type, an unknown type or an unknown key', () => {
    const noType = goodMcp()
    delete noType.mcpServers.metacogs.type
    expect(validateMcpConfig(noType)).not.toEqual([])
    const badType = goodMcp()
    badType.mcpServers.metacogs.type = 'websocket'
    expect(validateMcpConfig(badType)).not.toEqual([])
    const extra = goodMcp()
    extra.mcpServers.metacogs.extra = true
    expect(validateMcpConfig(extra)).not.toEqual([])
  })

  test('an unknown top-level key', () => {
    expect(validateMcpConfig({ ...goodMcp(), servers: {} })).not.toEqual([])
  })

  test('a cwd that is not plugin-relative', () => {
    const config = goodMcp()
    config.mcpServers.metacogs.cwd = '/tmp'
    expect(validateMcpConfig(config)).not.toEqual([])
    config.mcpServers.metacogs.cwd = '${PLUGIN_ROOT}/mcp'
    expect(validateMcpConfig(config)).toEqual([])
  })
})

describe('the reserved env names (the keyword zod cannot convert, checked directly)', () => {
  test('PLUGIN_ROOT and PLUGIN_DATA are rejected as env keys, by name and by path', () => {
    expect([...RESERVED_ENV_KEYS]).toEqual(['PLUGIN_ROOT', 'PLUGIN_DATA'])
    for (const key of RESERVED_ENV_KEYS) {
      const config = goodMcp()
      config.mcpServers.metacogs.env = { [key]: '/x', OTHER: 'ok' }
      expect(reservedEnvKeys(config)).toEqual([`mcpServers.metacogs.env.${key}`])
      expect(validateMcpConfig(config).join('\n')).toContain(`mcpServers.metacogs.env.${key}: reserved name`)
    }
    const both = goodMcp()
    both.mcpServers.metacogs.env = { PLUGIN_ROOT: 'a', PLUGIN_DATA: 'b' }
    expect(reservedEnvKeys(both)).toEqual(['mcpServers.metacogs.env.PLUGIN_ROOT', 'mcpServers.metacogs.env.PLUGIN_DATA'])
  })

  test('other env keys, near-miss names and a missing env pass', () => {
    const config = goodMcp()
    config.mcpServers.metacogs.env = { PLUGIN_ROOT_X: 'a', plugin_root: 'b', HOME: 'c' }
    expect(reservedEnvKeys(config)).toEqual([])
    expect(validateMcpConfig(config)).toEqual([])
    expect(reservedEnvKeys(goodMcp())).toEqual([])
  })

  test('input of any other shape is not a crash', () => {
    for (const value of [null, undefined, 'x', 3, [], {}, { mcpServers: null }, { mcpServers: { a: null } }, { mcpServers: { a: { env: null } } }]) {
      expect(reservedEnvKeys(value), JSON.stringify(value)).toEqual([])
    }
  })
})

describe('conversion fails loudly', () => {
  test('the MCP schema as published does not convert: the dropped keyword is the reason, and it is the only one', () => {
    const text = readRepo(MCP_SCHEMA_PATH)
    expect(() => convertSchema('mcp', text)).toThrow('mcp: z.fromJSONSchema() could not convert the schema')
    expect(() => convertSchema('mcp', text, dropUnconvertibleKeyword)).not.toThrow()
  })

  test('another unconvertible keyword is an error naming the schema, not a skipped check', () => {
    const schema = JSON.parse(readRepo(MCP_SCHEMA_PATH))
    schema.$defs.stdioServer.properties.args.items = { not: { enum: ['x'] } }
    expect(() => convertSchema('mcp', JSON.stringify(schema), dropUnconvertibleKeyword)).toThrow('mcp: z.fromJSONSchema() could not convert the schema')
  })

  test('a schema that no longer has the dropped keyword is an error: the workaround is stale', () => {
    const schema = JSON.parse(readRepo(MCP_SCHEMA_PATH))
    delete schema.$defs.stdioServer.properties.env.propertyNames
    expect(() => convertSchema('mcp', JSON.stringify(schema), dropUnconvertibleKeyword)).toThrow('the schema changed, so review this workaround')
  })
})
