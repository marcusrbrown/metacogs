// The Codex package (experimental): `hosts/codex/` (the plugin, in the agent-plugins.org 1.0.0 layout) and
// `.agents/plugins/marketplace.json` (this repository as a marketplace whose one entry points at the plugin
// directory). The plugin is self-contained in `hosts/codex/`; Codex installs a copy of it under its plugin cache.
//
// Codex finds `skills/` and `mcp.json` at fixed paths, so the manifest declares neither. There is no session-start
// hook: Codex discards the hooks of an agent-plugins package (a root `plugin.json` with an agent-plugins `$schema`),
// so the Codex package has the tools and skills and no session note. Codex reads the first marketplace file it finds
// (`.agents/plugins/` before `.claude-plugin/`), so both catalogs can be committed and each host sees its own.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TreeEntry } from '../generate/tree'
import { applyRules, codexRules, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME, readSkillSource } from './rules'
import { AUTHOR, encode, file, json, type PackageFields, packageFields, TOOLS_SUMMARY } from './shared'

export const CODEX_DIR = 'hosts/codex'
export const CODEX_MARKETPLACE_PATH = '.agents/plugins/marketplace.json'

export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const CODEX_DESCRIPTION = `Experimental Codex package, not yet installed and run on a real Codex. ${TOOLS_SUMMARY}`

export interface CodexInputs {
  /** The one version, from package.json. `plugin.json` carries it as a literal field. */
  version: string
  /** The record helper, built once for every host. `buildTree` adds the MCP server bundle beside these entries. */
  helper: Uint8Array
  /** Repository that holds the shared sources, LICENSE and ATTRIBUTIONS.md. */
  repoRoot: string
}

/** The portable manifest. Skills and `mcp.json` are found at fixed paths, so they are not declared. */
export function pluginManifest(version: string, fields: PackageFields): object {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: PLUGIN_NAME,
    version,
    description: CODEX_DESCRIPTION,
    author: AUTHOR,
    homepage: fields.homepage,
    repository: fields.repository,
    license: fields.license,
  }
}

/** `${PLUGIN_ROOT}` is substituted by Codex in `command`, `args` and `env`. */
export function mcpConfig(): object {
  return {
    $schema: MCP_SCHEMA_URL,
    mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/mcp/server.mjs'] } },
  }
}

/**
 * The catalog entry. `policy.authentication` is `ON_USE`: the plugin needs no authentication, so nothing asks for it at
 * install (Codex accepts `ON_INSTALL` or `ON_USE`). `source.path` is relative to the marketplace root, which is this
 * repository.
 */
export function marketplaceManifest(): object {
  return {
    name: PLUGIN_NAME,
    interface: { displayName: PLUGIN_NAME },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./${CODEX_DIR}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Developer Tools',
      },
    ],
  }
}

/** Every generated file of the Codex package, keyed by repo-relative path. */
export async function buildCodexEntries(input: CodexInputs): Promise<Map<string, TreeEntry>> {
  const fields = await packageFields(input.repoRoot)
  const entries = new Map<string, TreeEntry>()
  const put = (path: string, bytes: Uint8Array): void => {
    entries.set(path, file(bytes))
  }

  put(CODEX_MARKETPLACE_PATH, json(marketplaceManifest()))
  put(`${CODEX_DIR}/plugin.json`, json(pluginManifest(input.version, fields)))
  put(`${CODEX_DIR}/mcp.json`, json(mcpConfig()))

  const rules = codexRules()
  for (const skill of HOST_SKILLS) put(`${CODEX_DIR}/skills/${skill}/SKILL.md`, encode(applyRules(rules, skill, await readSkillSource(input.repoRoot, skill))))
  for (const skill of METHOD_SKILLS) put(`${CODEX_DIR}/skills/${skill}/scripts/record.mjs`, input.helper)

  // The renders adapt upstream MIT text, so the notice travels with the package.
  put(`${CODEX_DIR}/LICENSE`, await readFile(join(input.repoRoot, 'LICENSE')))
  put(`${CODEX_DIR}/ATTRIBUTIONS.md`, await readFile(join(input.repoRoot, 'ATTRIBUTIONS.md')))
  return entries
}
