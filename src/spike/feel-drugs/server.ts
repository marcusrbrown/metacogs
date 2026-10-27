/**
 * Stdio MCP server for the feel/drugs spike: exactly the upstream `feel` and `drugs` registrations, nothing else.
 *
 * The descriptions, field descriptions and return templates are the verbatim upstream strings in
 * `src/frames/feel-drugs.ts` (provenance and licence there and in `ATTRIBUTIONS.md`); this file builds the zod 4
 * shapes over them and serves them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  type DrugsArgs,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  type FeelArgs,
  feelText,
} from '../../frames/feel-drugs'

export const feelShape = {
  somewhere: z.string().describe(FEEL_FIELD_DESCRIPTIONS.somewhere),
  quality: z.string().describe(FEEL_FIELD_DESCRIPTIONS.quality),
  sigil: z.string().describe(FEEL_FIELD_DESCRIPTIONS.sigil),
  since_last: z.string().optional().describe(FEEL_FIELD_DESCRIPTIONS.since_last),
}

export const drugsShape = {
  substance: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.substance),
  method: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.method),
  displaces: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.displaces),
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'Metacognition Tools', version: '0.5.0' })
  server.tool('feel', FEEL_DESCRIPTION, feelShape, async (args: FeelArgs) => ({
    content: [{ text: feelText(args), type: 'text' as const }],
  }))
  server.tool('drugs', DRUGS_DESCRIPTION, drugsShape, async (args: DrugsArgs) => ({
    content: [{ text: drugsText(args), type: 'text' as const }],
  }))
  return server
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport())
}
