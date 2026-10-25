import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { DRUGS_DESCRIPTION, DRUGS_FIELD_DESCRIPTIONS, FEEL_DESCRIPTION, FEEL_FIELD_DESCRIPTIONS } from '../../frames/feel-drugs'

const SERVER = new URL('./server.ts', import.meta.url).pathname

let client: Client
beforeAll(async () => {
  client = new Client({ name: 'server-test', version: '0.0.0' })
  await client.connect(new StdioClientTransport({ command: 'bun', args: [SERVER] }))
})
afterAll(async () => {
  await client.close()
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
    // sdk 1.32 + zod 4 serves the schema without additionalProperties; the descriptions, field names and `required` lists are the contract.
    expect(feel?.inputSchema.additionalProperties).toBeUndefined()
    expect(drugs?.inputSchema.additionalProperties).toBeUndefined()
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
