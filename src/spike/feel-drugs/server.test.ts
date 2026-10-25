import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  DRUGS_FRAME,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  FEEL_FRAME,
  feelText,
  UPSTREAM,
} from './server'

const SERVER = new URL('./server.ts', import.meta.url).pathname

let client: Client
beforeAll(async () => {
  client = new Client({ name: 'server-test', version: '0.0.0' })
  await client.connect(new StdioClientTransport({ command: 'bun', args: [SERVER] }))
})
afterAll(async () => {
  await client.close()
})

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('provenance', () => {
  test('names the pinned upstream commit and licence', () => {
    expect(UPSTREAM).toEqual({
      repo: 'inanna-malick/metacog',
      commit: '3d89bb30cd26369fdcd242fd704f66641dca327c',
      file: 'src/index.ts',
      lines: { feel: '34-88', drugs: '91-133' },
      licence: 'MIT',
    })
  })

  // Pinned from a byte-for-byte comparison against the upstream file at that commit (substring match of every
  // description and template literal in src/index.ts). A change here means the copy drifted from upstream.
  test('descriptions and field descriptions match the pinned digests', () => {
    expect(sha([FEEL_DESCRIPTION, FEEL_FIELD_DESCRIPTIONS])).toBe(FEEL_DIGEST)
    expect(sha([DRUGS_DESCRIPTION, DRUGS_FIELD_DESCRIPTIONS])).toBe(DRUGS_DIGEST)
  })
})

describe('over stdio', () => {
  test('serves exactly feel and drugs', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['drugs', 'feel'])
  })

  test('descriptions and parameter schemas equal the copied upstream strings', async () => {
    const { tools } = await client.listTools()
    const feel = tools.find((t) => t.name === 'feel')
    const drugs = tools.find((t) => t.name === 'drugs')
    expect(feel?.description).toBe(FEEL_DESCRIPTION)
    expect(drugs?.description).toBe(DRUGS_DESCRIPTION)

    const props = (tool: typeof feel) => Object.fromEntries(Object.entries((tool?.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>).map(([k, v]) => [k, v]))
    expect(Object.keys(props(feel))).toEqual(['somewhere', 'quality', 'sigil', 'since_last'])
    for (const [key, text] of Object.entries(FEEL_FIELD_DESCRIPTIONS)) {
      expect(props(feel)[key]).toMatchObject({ type: 'string', description: text })
    }
    expect(feel?.inputSchema.required).toEqual(['somewhere', 'quality', 'sigil'])

    expect(Object.keys(props(drugs))).toEqual(['substance', 'method', 'displaces'])
    for (const [key, text] of Object.entries(DRUGS_FIELD_DESCRIPTIONS)) {
      expect(props(drugs)[key]).toMatchObject({ type: 'string', description: text })
    }
    expect(drugs?.inputSchema.required).toEqual(['substance', 'method', 'displaces'])
    // The schema the model sees depends on the sdk/zod versions: upstream resolves sdk 1.25.2 + zod 3.25.76 and emits
    // additionalProperties:false; sdk 1.32 + zod 4 does not. Bumping either changes the arm B tool definition.
    expect(feel?.inputSchema.additionalProperties).toBe(false)
    expect(drugs?.inputSchema.additionalProperties).toBe(false)
  })

  test('feel echoes the fields inside the fixed frame', async () => {
    const result = await client.callTool({ name: 'feel', arguments: { somewhere: 'in the gap between analysis and reaction', quality: 'warm, dense, slow', sigil: '🌊' } })
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '🌊\n\nAttending: in the gap between analysis and reaction\nTexture: warm, dense, slow\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.',
      },
    ])
  })

  test('feel with since_last adds the delta line', async () => {
    const result = await client.callTool({ name: 'feel', arguments: { somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' } })
    expect((result.content as { text: string }[])[0]?.text).toBe(
      '🪨\n\nSince last pause: the pressure eased\n\nAttending: chest\nTexture: tight\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.',
    )
  })

  test('drugs echoes the fields inside the fixed frame and trims trailing dots and spaces from displaces', async () => {
    const result = await client.callTool({ name: 'drugs', arguments: { substance: 'caffeine', method: 'Amplifies vigilance, suppresses patience.', displaces: 'baseline. ' } })
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'SUBSTRATE DISPLACED: baseline. What it gave you is gone.\n\ncaffeine ingested. Amplifies vigilance, suppresses patience.\n\nThe substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.',
      },
    ])
  })

  test('a call missing a required field is an error, not an echo', async () => {
    const result = await client.callTool({ name: 'feel', arguments: { somewhere: 'x' } })
    expect(result.isError).toBe(true)
  })
})

describe('frames', () => {
  test('the exported frames are the builders rendered with placeholders', () => {
    expect(FEEL_FRAME).toBe(feelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' }))
    expect(DRUGS_FRAME).toBe(drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' }))
    expect(FEEL_FRAME).toBe('<sigil>\n\nAttending: <somewhere>\nTexture: <quality>\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.')
    expect(DRUGS_FRAME).toBe('SUBSTRATE DISPLACED: <displaces>. What it gave you is gone.\n\n<substance> ingested. <method>\n\nThe substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.')
  })
})

// Filled in after the comparison against upstream; see the comment in 'provenance'.
const FEEL_DIGEST = '8bb89d7ccdb674ac4fbb462ae49da1eca22c2399d74ccde9c94f1aec45367253'
const DRUGS_DIGEST = 'd1b34c924255e81586ccc3da4cf55624a32aefac360b691230423a070f9323bd'
