// The Claude Code package: `hosts/claude/` (the plugin) and `.claude-plugin/marketplace.json` (this repository as a
// marketplace whose one entry points at the plugin directory). Everything is self-contained in `hosts/claude/`,
// because Claude copies the plugin into its cache and nothing outside the directory travels with it.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TreeEntry } from '../generate/tree'
import { buildSessionStartHook, renderGuidance } from './guidance'
import { applyRules, CLAUDE_PROFILE, claudeRules, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME, readSkillSource } from './rules'
import { AUTHOR, encode, file, json, type PackageFields, packageFields, TOOLS_SUMMARY } from './shared'

export const CLAUDE_DIR = 'hosts/claude'
export const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json'

const MARKETPLACE_DESCRIPTION = 'The metacogs plugin for Claude Code: reasoning tools and decision-method skills.'

export interface ClaudeInputs {
  /** The one version, from package.json. Both manifests carry it as a literal field. */
  version: string
  /** The record helper, built once for every host. `buildTree` adds the MCP server bundle beside these entries. */
  helper: Uint8Array
  /** Repository that holds the shared sources, LICENSE and ATTRIBUTIONS.md. */
  repoRoot: string
}

/** `plugin.json`. Its `version` is what Claude uses to detect updates, so the marketplace entry carries none. */
export function pluginManifest(version: string, fields: PackageFields): object {
  return {
    name: PLUGIN_NAME,
    version,
    description: TOOLS_SUMMARY,
    author: AUTHOR,
    homepage: fields.homepage,
    repository: fields.repository,
    license: fields.license,
    userConfig: {
      guidance: {
        type: 'boolean',
        title: 'Session-start note',
        description: 'Print a short factual note about the metacogs tools and skills when a session starts.',
        default: true,
      },
    },
  }
}

export function marketplaceManifest(): object {
  return {
    name: PLUGIN_NAME,
    owner: { name: AUTHOR.name },
    metadata: { description: MARKETPLACE_DESCRIPTION },
    plugins: [{ name: PLUGIN_NAME, source: `./${CLAUDE_DIR}`, description: TOOLS_SUMMARY }],
  }
}

export function mcpConfig(): object {
  return { mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'] } } }
}

/** No matcher, so the hook runs on every session source (startup, resume, clear, compact). */
export function hooksConfig(): object {
  return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"' }] }] } }
}

/** Every generated file of the Claude package, keyed by repo-relative path. */
export async function buildClaudeEntries(input: ClaudeInputs): Promise<Map<string, TreeEntry>> {
  const fields = await packageFields(input.repoRoot)
  const entries = new Map<string, TreeEntry>()
  const put = (path: string, bytes: Uint8Array): void => {
    entries.set(path, file(bytes))
  }

  put(CLAUDE_MARKETPLACE_PATH, json(marketplaceManifest()))
  put(`${CLAUDE_DIR}/.claude-plugin/plugin.json`, json(pluginManifest(input.version, fields)))
  put(`${CLAUDE_DIR}/.mcp.json`, json(mcpConfig()))
  put(`${CLAUDE_DIR}/hooks/hooks.json`, json(hooksConfig()))
  put(
    `${CLAUDE_DIR}/hooks/session-start.mjs`,
    encode(await buildSessionStartHook({ host: 'claude', note: renderGuidance(CLAUDE_PROFILE), version: input.version })),
  )

  const rules = claudeRules()
  for (const skill of HOST_SKILLS) put(`${CLAUDE_DIR}/skills/${skill}/SKILL.md`, encode(applyRules(rules, skill, await readSkillSource(input.repoRoot, skill))))
  for (const skill of METHOD_SKILLS) put(`${CLAUDE_DIR}/skills/${skill}/scripts/record.mjs`, input.helper)

  // The renders adapt upstream MIT text, so the notice travels with the package.
  put(`${CLAUDE_DIR}/LICENSE`, await readFile(join(input.repoRoot, 'LICENSE')))
  put(`${CLAUDE_DIR}/ATTRIBUTIONS.md`, await readFile(join(input.repoRoot, 'ATTRIBUTIONS.md')))
  return entries
}
