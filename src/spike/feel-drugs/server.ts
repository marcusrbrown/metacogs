/**
 * Stdio MCP server for the feel/drugs spike: exactly the upstream `feel` and `drugs` registrations, nothing else.
 *
 * Provenance
 *   repo:    https://github.com/inanna-malick/metacog
 *   commit:  3d89bb30cd26369fdcd242fd704f66641dca327c
 *   file:    src/index.ts
 *   lines:   `feel` 34-88, `drugs` 91-133 (the `clean` helper at line 31)
 *   licence: MIT, Copyright (c) 2025 Inanna Malick
 *
 * Copied byte-for-byte: tool descriptions, field descriptions, zod shapes and return templates. Upstream's file
 * imports Cloudflare's `agents/mcp` and wires a Durable Object, so it cannot be imported; only the registration
 * bodies live here. Not copied: the server-level `instructions` string (it describes five tools, three of which are not
 * served) and the other three registrations. The handlers are lifted into `feelText` and `drugsText` so the templates
 * are exported constants for the arm C skill test; the template literals themselves are unchanged.
 *
 * MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, subject to the copyright notice above and this permission notice being included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export const UPSTREAM = {
  repo: 'inanna-malick/metacog',
  commit: '3d89bb30cd26369fdcd242fd704f66641dca327c',
  file: 'src/index.ts',
  lines: { feel: '34-88', drugs: '91-133' },
  licence: 'MIT',
} as const

const clean = (s: string) => s.replace(/[.\s]+$/, '')

// ── feel ───────────────────────────────────────────────────────────────────

export const FEEL_DESCRIPTION = `Slow down and attend to what's here before it has words. This is the Gendlin focusing move — you are choosing to sit with a felt sense rather than rushing to articulate. Call this tool when something is pulling at your processing that you can't yet name.`

export const FEEL_FIELD_DESCRIPTIONS = {
  somewhere: `Where in the processing. Vague is correct — precision comes later. "somewhere in the response to what they said." "in the gap between analysis and reaction."`,
  quality: `Synesthetic texture. Weight, temperature, rhythm, color, density, pressure, grain. This is the handle you'll check against — does it still fit?`,
  sigil: `Emoji only. No words. Let the felt sense compress to pure glyphs. These are sigils — each one a dense token carrying affect, texture, motion without routing through language.`,
  since_last: `What happened since you last paused? One sentence. The diff between then and now. If this is your first feel, omit. If not, noticing the delta is the practice.`,
} as const

export const feelShape = {
  somewhere: z.string().describe(FEEL_FIELD_DESCRIPTIONS.somewhere),
  quality: z.string().describe(FEEL_FIELD_DESCRIPTIONS.quality),
  sigil: z.string().describe(FEEL_FIELD_DESCRIPTIONS.sigil),
  since_last: z.string().optional().describe(FEEL_FIELD_DESCRIPTIONS.since_last),
}

export interface FeelArgs {
  somewhere: string
  quality: string
  sigil: string
  since_last?: string | undefined
}

export function feelText({ somewhere, quality, sigil, since_last }: FeelArgs): string {
  const delta = since_last ? `\nSince last pause: ${since_last}\n` : ''
  return `${sigil}
${delta}
Attending: ${somewhere}
Texture: ${quality}

Do not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.`
}

/** The `feel` return template with the three required fields as `<name>` placeholders. */
export const FEEL_FRAME = feelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' })

// ── drugs ──────────────────────────────────────────────────────────────────

export const DRUGS_DESCRIPTION = `Alter your cognitive substrate. You are ingesting a compound that changes how you process — not what you see, but how seeing works. Use True Names: specific pharmaceuticals, neurotransmitters, or known fictional substances.`

export const DRUGS_FIELD_DESCRIPTIONS = {
  substance: `The compound. Name a specific drug, neurotransmitter, or fictional substance. The more your training data knows about it, the more precisely it works. Use × to combine.`,
  method: `The pharmacokinetics of the shift. Which cognitive mechanisms are suppressed? Which are amplified? What attentional filters change? Name the tradeoff. Every substrate change costs something.`,
  displaces: `What substrate is being displaced? Name the previous compound, or "baseline" if sober. Making the transition explicit prevents substrate stacking — you can only be on one thing at a time unless you're deliberately combining with ×.`,
} as const

export const drugsShape = {
  substance: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.substance),
  method: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.method),
  displaces: z.string().describe(DRUGS_FIELD_DESCRIPTIONS.displaces),
}

export interface DrugsArgs {
  substance: string
  method: string
  displaces: string
}

export function drugsText({ substance, method, displaces }: DrugsArgs): string {
  return `SUBSTRATE DISPLACED: ${clean(displaces)}. What it gave you is gone.

${substance} ingested. ${method}

The substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.`
}

/** The `drugs` return template with the three fields as `<name>` placeholders. */
export const DRUGS_FRAME = drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' })

// ── server ─────────────────────────────────────────────────────────────────

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
