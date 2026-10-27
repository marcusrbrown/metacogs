// Validates the Codex `plugin.json` and `mcp.json` against the agent-plugins.org 1.0.0 JSON Schemas they declare.
// Codex ships no CLI validator and no marketplace schema, so this is schema validation and nothing more: it says the
// files are well-formed Agent Plugins manifests, not that Codex loads them.
//
// The published schemas are vendored unmodified under src/hosts/schemas/agent-plugins-1.0.0/ and pinned by sha256
// below. They are converted to zod with `z.fromJSONSchema()` (zod is already a devDependency; no validator library is
// added). The conversion itself is in memory only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const PLUGIN_SCHEMA_PATH = 'src/hosts/schemas/agent-plugins-1.0.0/plugin.schema.json'
export const MCP_SCHEMA_PATH = 'src/hosts/schemas/agent-plugins-1.0.0/mcp.schema.json'

/** sha256 of the vendored files, fetched from https://agent-plugins.org/schemas/1.0.0/ on 2026-10-27. */
export const SCHEMA_SHA256 = {
  [PLUGIN_SCHEMA_PATH]: '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883',
  [MCP_SCHEMA_PATH]: '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb',
} as const

/** Env keys the MCP schema bans in a stdio server, because the host sets them itself. */
export const RESERVED_ENV_KEYS = ['PLUGIN_ROOT', 'PLUGIN_DATA'] as const

type Json = { [key: string]: Json } | Json[] | string | number | boolean | null

const here = (relative: string): URL => new URL(`../../${relative}`, import.meta.url)
const readSchemaText = (relative: string): string => readFileSync(here(relative), 'utf8')

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The MCP schema's one construct that zod cannot convert: `$defs.stdioServer.properties.env.propertyNames` is a `not`
 * over an enum that bans the reserved names as `env` keys. It is dropped from the in-memory copy and the same rule is
 * checked directly by `reservedEnvKeys`. Anything else that fails to convert is a loud error, never a silent skip.
 */
export function dropUnconvertibleKeyword(schema: Json): void {
  const env = (schema as any)?.$defs?.stdioServer?.properties?.env
  if (env === null || typeof env !== 'object' || !('propertyNames' in env)) {
    throw new Error('mcp.schema.json: expected $defs.stdioServer.properties.env.propertyNames; the schema changed, so review this workaround')
  }
  delete env.propertyNames
}

/** Schema text to a zod type. A conversion failure is rethrown with the schema's name; nothing is skipped silently. */
export function convertSchema(label: string, text: string, prepare?: (schema: Json) => void): z.ZodType {
  const schema = JSON.parse(text) as Json
  prepare?.(schema)
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch (error) {
    throw new Error(`${label}: z.fromJSONSchema() could not convert the schema: ${(error as Error).message}`, { cause: error })
  }
}

let converted: { plugin: z.ZodType; mcp: z.ZodType } | undefined
function schemas(): { plugin: z.ZodType; mcp: z.ZodType } {
  return (converted ??= {
    plugin: convertSchema(PLUGIN_SCHEMA_PATH, readSchemaText(PLUGIN_SCHEMA_PATH)),
    mcp: convertSchema(MCP_SCHEMA_PATH, readSchemaText(MCP_SCHEMA_PATH), dropUnconvertibleKeyword),
  })
}

/** Paths of reserved names used as `env` keys in a stdio server, e.g. `mcpServers.metacogs.env.PLUGIN_ROOT`. */
export function reservedEnvKeys(config: unknown): string[] {
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers
  if (servers === null || typeof servers !== 'object') return []
  const found: string[] = []
  for (const [name, server] of Object.entries(servers)) {
    const env = (server as { env?: unknown } | null)?.env
    if (env === null || typeof env !== 'object') continue
    for (const key of RESERVED_ENV_KEYS) if (Object.hasOwn(env, key)) found.push(`mcpServers.${name}.env.${key}`)
  }
  return found
}

const describeIssues = (error: z.ZodError): string[] => error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)

/** Problems with a `plugin.json` value. Empty means valid. */
export function validatePluginManifest(value: unknown): string[] {
  const result = schemas().plugin.safeParse(value)
  return result.success ? [] : describeIssues(result.error)
}

/** Problems with an `mcp.json` value, including the reserved `env` keys. Empty means valid. */
export function validateMcpConfig(value: unknown): string[] {
  const result = schemas().mcp.safeParse(value)
  return [...(result.success ? [] : describeIssues(result.error)), ...reservedEnvKeys(value).map(path => `${path}: reserved name; the host sets it`)]
}
