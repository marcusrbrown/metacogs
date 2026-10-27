// Stdio MCP server offering `feel` and `drugs` to hosts that cannot register a native tool (Claude Code, Codex).
// The text comes from src/frames/feel-drugs.ts, so it matches what the OpenCode plugin offers. The entry always
// starts the server, so it is only ever run as the built bundle (src/plugin/build.ts, `buildMcpServer`).
//
// Stdout carries JSON-RPC and nothing else; the bundle does no file, network or process I/O beyond the stdio
// transport. Imports are deep and stdio-only, so no HTTP or auth code is bundled.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  feelText,
} from '../frames/feel-drugs'

/** Defined by the bundler from package.json. There is no fallback: an unbundled run fails here, not with a made-up version. */
declare const __METACOGS_MCP_VERSION__: string

const READ_ONLY = { readOnlyHint: true } as const

const server = new McpServer({ name: 'metacogs', version: __METACOGS_MCP_VERSION__ })

server.registerTool(
  'feel',
  {
    description: FEEL_DESCRIPTION,
    inputSchema: {
      somewhere: z.string().describe(FEEL_FIELD_DESCRIPTIONS.somewhere),
      quality: z.string().describe(FEEL_FIELD_DESCRIPTIONS.quality),
      sigil: z.string().describe(FEEL_FIELD_DESCRIPTIONS.sigil),
      since_last: z.string().optional().describe(FEEL_FIELD_DESCRIPTIONS.since_last),
    },
    annotations: READ_ONLY,
  },
  async args => ({ content: [{ type: 'text' as const, text: feelText(args) }] }),
)

server.registerTool(
  'drugs',
  {
    description: DRUGS_DESCRIPTION,
    inputSchema: {
      substance: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.substance),
      method: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.method),
      displaces: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.displaces),
    },
    annotations: READ_ONLY,
  },
  async args => ({ content: [{ type: 'text' as const, text: drugsText(args) }] }),
)

await server.connect(new StdioServerTransport())
