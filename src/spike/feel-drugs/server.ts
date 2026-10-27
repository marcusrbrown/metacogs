/**
 * Stdio MCP server for the feel/drugs spike: exactly the upstream `feel` and `drugs` registrations, nothing else.
 *
 * The descriptions, field descriptions and return templates are the verbatim upstream strings
 * (`UPSTREAM_*`) in `src/spike/feel-drugs/upstream-frames.ts` (provenance and licence there and in `ATTRIBUTIONS.md`); this file
 * builds the zod 4 shapes over them and serves them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { type DrugsArgs, type FeelArgs } from '../../frames/feel-drugs'
import {
  UPSTREAM_DRUGS_DESCRIPTION,
  UPSTREAM_DRUGS_FIELD_DESCRIPTIONS,
  UPSTREAM_FEEL_DESCRIPTION,
  UPSTREAM_FEEL_FIELD_DESCRIPTIONS,
  upstreamDrugsText,
  upstreamFeelText,
} from './upstream-frames'

export const feelShape = {
  somewhere: z.string().describe(UPSTREAM_FEEL_FIELD_DESCRIPTIONS.somewhere),
  quality: z.string().describe(UPSTREAM_FEEL_FIELD_DESCRIPTIONS.quality),
  sigil: z.string().describe(UPSTREAM_FEEL_FIELD_DESCRIPTIONS.sigil),
  since_last: z.string().optional().describe(UPSTREAM_FEEL_FIELD_DESCRIPTIONS.since_last),
}

export const drugsShape = {
  substance: z.string().describe(UPSTREAM_DRUGS_FIELD_DESCRIPTIONS.substance),
  method: z.string().describe(UPSTREAM_DRUGS_FIELD_DESCRIPTIONS.method),
  displaces: z.string().describe(UPSTREAM_DRUGS_FIELD_DESCRIPTIONS.displaces),
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'Metacognition Tools', version: '0.5.0' })
  server.tool('feel', UPSTREAM_FEEL_DESCRIPTION, feelShape, async (args: FeelArgs) => ({
    content: [{ text: upstreamFeelText(args), type: 'text' as const }],
  }))
  server.tool('drugs', UPSTREAM_DRUGS_DESCRIPTION, drugsShape, async (args: DrugsArgs) => ({
    content: [{ text: upstreamDrugsText(args), type: 'text' as const }],
  }))
  return server
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport())
}
