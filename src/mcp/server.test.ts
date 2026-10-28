import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readHelperVersion } from '../generate/marker'
import { buildMcpServer, REPO_ROOT } from '../plugin/build'

// The protocol tests run the built bundle under `node` from PATH (CI pins Node 22), from a directory that has no
// node_modules and is not the working directory, so nothing resolves through the repository.

const VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version

// Literal pins, written out here and copied from src/plugin/frames-text.test.ts: the MCP server must offer what the
// OpenCode plugin offers, and a change to src/frames/feel-drugs.ts cannot move them silently.
const FEEL_DESCRIPTION = "Pause on a tension you can't yet name, before you choose the next move. This borrows Gendlin's focusing move: attend to what is here before it has words, and leave a handle for it."
const FEEL_FIELDS = {
  somewhere: 'Where the tension sits. Vague is correct — precision comes later. "somewhere in the response to what they said." "in the gap between analysis and reaction."',
  quality: "Synesthetic texture. Weight, temperature, rhythm, color, density, pressure, grain. This is the handle you'll check against — does it still fit?",
  sigil: 'Emoji only. No words. Let the felt sense compress to pure glyphs. These are sigils — each one a compact mark for texture and motion, without routing through language.',
  since_last: 'What happened since you last paused? One sentence. The diff between then and now. If this is your first feel, omit. If not, noticing the delta is the practice.',
}
const FEEL_RETURN =
  '🪨\n\nSince last pause: the pressure eased\n\nAttending: chest\nTexture: tight\n\nThis is a working label, not a report of an inner state. Hold the texture unspoken. Then say in one plain sentence what your next move changes, and check it against evidence.'

const DRUGS_DESCRIPTION =
  'Deliberately change your approach for the next attempt, when the approach itself is the problem. The substance is only a handle: it supplies no facts, adds no capability, and changes nothing about what you may do.'
const DRUGS_FIELDS = {
  substance: 'The handle. Name a specific drug, neurotransmitter, or fictional substance whose usual associations you can spell out in method. Use × to combine.',
  method: 'The change of approach, in task terms. What you will emphasize, what you will set aside, which assumptions you will stop leaning on. Name the tradeoff — every change of approach costs something.',
  displaces: 'The approach this replaces. Name the previous substance, or "baseline" for your default. Naming it keeps to one change at a time, unless you\'re deliberately combining with ×.',
}
const DRUGS_RETURN =
  'APPROACH DISPLACED: baseline.\n\ncaffeine taken as the handle. Emphasize speed of checks; set aside long deliberation.\n\nThis is your approach for the next attempt, not a change to what you may do. Say in one plain sentence what it changes about the work, then check it against evidence.'

const FEEL_ARGS = { somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' }
const DRUGS_ARGS = { substance: 'caffeine', method: 'Emphasize speed of checks; set aside long deliberation.', displaces: 'baseline.' }

interface Message {
  jsonrpc?: string
  id?: number | string
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

/** A running server: requests are matched to responses by `id`, since responses may arrive in any order. */
class Session {
  readonly stdoutLines: string[] = []
  stderr = ''
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ''
  private nextId = 1
  private readonly waiting = new Map<number | string, (message: Message) => void>()
  readonly exited: Promise<number | null>

  constructor(bundle: string, cwd: string) {
    this.proc = spawn('node', [bundle], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        this.stdoutLines.push(line)
        const message = JSON.parse(line) as Message
        if (message.id !== undefined) this.waiting.get(message.id)?.(message)
      }
    })
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
    this.exited = new Promise((resolve, reject) => {
      this.proc.on('error', reject)
      this.proc.on('close', code => resolve(code))
    })
  }

  private write(message: object): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params?: object): Promise<Message> {
    const id = this.nextId++
    const response = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} #${id}; stderr: ${this.stderr}`)), 10_000)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    return response
  }

  notify(method: string): void {
    this.write({ jsonrpc: '2.0', method })
  }

  async initialize(): Promise<Message> {
    const response = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'server-test', version: '0.0.0' } })
    this.notify('notifications/initialized')
    return response
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = await this.request('tools/call', { name, arguments: args })
    if (response.result === undefined) throw new Error(`tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(response.error)}`)
    return response.result as unknown as ToolResult
  }

  /** Close stdin and wait for the server to exit. */
  async end(): Promise<number | null> {
    this.proc.stdin.end()
    return this.exited
  }

  kill(): void {
    this.proc.kill()
  }
}

/**
 * Every module specifier a bundle imports: static, dynamic, re-export and `require` calls. A `require("x")` that
 * sits directly inside a string or template literal is code ajv generates for standalone validators, which the
 * server never runs; those are listed separately by `codegenSpecifiers`.
 */
function importSpecifiers(text: string): string[] {
  const found = new Set<string>()
  const patterns = [/\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?["']([^"']+)["']/g, /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g, /(?<![`'"])\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g]
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1] ?? '')
  return [...found].sort()
}

/** Specifiers of `require("x")` calls that open a string or template literal. */
function codegenSpecifiers(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/[`'"]require\("([^"]+)"\)/g)) found.add(match[1] ?? '')
  return [...found].sort()
}

let scratch: string
let bundleText: string
let bundlePath: string
let elsewhere: string
const sessions: Session[] = []

/** Start a server on the built bundle, run `body`, and always reap the process. */
async function withServer<T>(body: (session: Session) => Promise<T>): Promise<T> {
  const session = new Session(bundlePath, elsewhere)
  sessions.push(session)
  try {
    return await body(session)
  } finally {
    session.kill()
  }
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-mcp-'))
  bundleText = await buildMcpServer()
  // A directory with no node_modules, as an installed plugin cache has none.
  const installed = join(scratch, 'installed')
  mkdirSync(installed)
  bundlePath = join(installed, 'server.mjs')
  writeFileSync(bundlePath, bundleText)
  elsewhere = join(scratch, 'cwd')
  mkdirSync(elsewhere)
})

afterAll(() => {
  for (const session of sessions) session.kill()
  rmSync(scratch, { recursive: true, force: true })
})

describe('over stdio: happy path', () => {
  test('initialize names the server metacogs at the package version', async () => {
    await withServer(async session => {
      const response = await session.initialize()
      expect(response.error).toBeUndefined()
      expect(response.result?.serverInfo).toEqual({ name: 'metacogs', version: VERSION })
      expect(response.result?.capabilities).toHaveProperty('tools')
    })
  })

  test('tools/list offers exactly feel and drugs, with the adapted text, required fields and read-only hints', async () => {
    await withServer(async session => {
      await session.initialize()
      const { result } = await session.request('tools/list')
      const tools = result?.tools as {
        name: string
        description: string
        annotations?: Record<string, unknown>
        inputSchema: { properties: Record<string, { type?: string; description?: string }>; required?: string[] }
      }[]
      expect(tools.map(tool => tool.name).sort()).toEqual(['drugs', 'feel'])
      const feel = tools.find(tool => tool.name === 'feel')!
      const drugs = tools.find(tool => tool.name === 'drugs')!

      expect(feel.description).toBe(FEEL_DESCRIPTION)
      expect(Object.keys(feel.inputSchema.properties)).toEqual(['somewhere', 'quality', 'sigil', 'since_last'])
      for (const [key, text] of Object.entries(FEEL_FIELDS)) expect(feel.inputSchema.properties[key]).toMatchObject({ type: 'string', description: text })
      expect(feel.inputSchema.required).toEqual(['somewhere', 'quality', 'sigil'])
      expect(feel.annotations?.readOnlyHint).toBe(true)

      expect(drugs.description).toBe(DRUGS_DESCRIPTION)
      expect(Object.keys(drugs.inputSchema.properties)).toEqual(['substance', 'method', 'displaces'])
      for (const [key, text] of Object.entries(DRUGS_FIELDS)) expect(drugs.inputSchema.properties[key]).toMatchObject({ type: 'string', description: text })
      expect(drugs.inputSchema.required).toEqual(['substance', 'method', 'displaces'])
      expect(drugs.annotations?.readOnlyHint).toBe(true)
    })
  })

  test('feel returns exactly the adapted text', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('feel', FEEL_ARGS)
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: FEEL_RETURN }])
    })
  })

  test('feel without since_last omits the delta line', async () => {
    await withServer(async session => {
      await session.initialize()
      const { since_last: _omitted, ...required } = FEEL_ARGS
      const result = await session.call('feel', required)
      expect(result.content[0]?.text).toBe(
        '🪨\n\nAttending: chest\nTexture: tight\n\nThis is a working label, not a report of an inner state. Hold the texture unspoken. Then say in one plain sentence what your next move changes, and check it against evidence.',
      )
    })
  })

  test('drugs returns exactly the adapted text', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('drugs', DRUGS_ARGS)
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: DRUGS_RETURN }])
    })
  })

  test('drugs trims trailing dots and spaces from displaces', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('drugs', { ...DRUGS_ARGS, displaces: 'baseline. . ' })
      expect(result.content[0]?.text).toBe(DRUGS_RETURN)
    })
  })

  test('concurrent requests are each answered, matched by id', async () => {
    await withServer(async session => {
      await session.initialize()
      const [feel, list, drugs] = await Promise.all([session.call('feel', FEEL_ARGS), session.request('tools/list'), session.call('drugs', DRUGS_ARGS)])
      expect(feel.content[0]?.text).toBe(FEEL_RETURN)
      expect((list.result?.tools as unknown[]).length).toBe(2)
      expect(drugs.content[0]?.text).toBe(DRUGS_RETURN)
    })
  })

  test('a happy-path session writes only JSON-RPC to stdout, nothing to stderr, and exits 0 on stdin EOF', async () => {
    await withServer(async session => {
      await session.initialize()
      await session.request('tools/list')
      await session.call('feel', FEEL_ARGS)
      await session.call('drugs', DRUGS_ARGS)
      expect(await session.end()).toBe(0)

      expect(session.stdoutLines.length).toBe(4)
      for (const line of session.stdoutLines) {
        const message = JSON.parse(line) as Message
        expect(message.jsonrpc).toBe('2.0')
        expect(typeof message.id === 'number' || typeof message.id === 'string').toBe(true)
        expect(message.result !== undefined || message.error !== undefined).toBe(true)
      }
      expect(session.stderr).toBe('')
    })
  })
})

describe('over stdio: error path', () => {
  // The SDK reports invalid arguments and unknown tools as a tool result, not a JSON-RPC error.
  test('a missing required field is a result with isError: true', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('feel', { somewhere: 'chest' })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('-32602')
      expect(result.content[0]?.text).not.toContain('Attending:')
    })
  })

  test('a wrong-typed field is a result with isError: true', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('drugs', { ...DRUGS_ARGS, substance: 5 })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('-32602')
      expect(result.content[0]?.text).not.toContain('taken as the handle')
    })
  })

  test('an unknown tool is a result with isError: true', async () => {
    await withServer(async session => {
      await session.initialize()
      const result = await session.call('nope', {})
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('-32602')
    })
  })

  test('an unknown method is a JSON-RPC -32601 error', async () => {
    await withServer(async session => {
      await session.initialize()
      const response = await session.request('nope/nothing')
      expect(response.result).toBeUndefined()
      expect(response.error?.code).toBe(-32601)
    })
  })

  test('the server survives errors and still answers afterwards', async () => {
    await withServer(async session => {
      await session.initialize()
      await session.call('feel', {})
      await session.request('nope/nothing')
      expect((await session.call('drugs', DRUGS_ARGS)).content[0]?.text).toBe(DRUGS_RETURN)
      expect(await session.end()).toBe(0)
      for (const line of session.stdoutLines) expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0')
      expect(session.stderr).toBe('')
    })
  })
})

describe('over stdio: edge cases', () => {
  test('stdin EOF before any request exits 0 with no output', async () => {
    await withServer(async session => {
      expect(await session.end()).toBe(0)
      expect(session.stdoutLines).toEqual([])
      expect(session.stderr).toBe('')
    })
  })
})

describe('the built bundle', () => {
  test('is deterministic', async () => {
    expect(await buildMcpServer()).toBe(bundleText)
  })

  test('imports only node:process', () => {
    expect(importSpecifiers(bundleText)).toEqual(['node:process'])
  })

  test('the only other require("…") text is ajv codegen inside string literals', () => {
    expect(codegenSpecifiers(bundleText)).toEqual(['ajv-formats/dist/formats', 'ajv/dist/runtime/equal', 'ajv/dist/runtime/ucs2length', 'ajv/dist/runtime/uri', 'ajv/dist/runtime/validation_error'])
  })

  test('the specifier finder separates real imports from codegen strings', () => {
    const text = ['import p from "node:process"', 'const a = require("node:fs")', 'x.code = \'require("ajv/dist/runtime/uri").default\'', 'y = _`require("ajv/dist/runtime/equal").default`'].join('\n')
    expect(importSpecifiers(text)).toEqual(['node:fs', 'node:process'])
    expect(codegenSpecifiers(text)).toEqual(['ajv/dist/runtime/equal', 'ajv/dist/runtime/uri'])
  })

  test('carries the version in line 2 of its banner and in the server, not a fixed string', async () => {
    expect(readHelperVersion(bundleText)).toBe(VERSION)
    const other = await buildMcpServer({ version: '9.9.9-test' })
    expect(readHelperVersion(other)).toBe('9.9.9-test')
    expect(other).toContain('"9.9.9-test"')
    expect(other).not.toContain(`"${VERSION}"`)
  })

  test('embeds no absolute path of this checkout', () => {
    expect(bundleText).not.toContain(REPO_ROOT)
  })

  test('carries none of the unused upstream frame text', () => {
    for (const text of ['previous mode of processing is unavailable', 'Alter your cognitive substrate', 'UPSTREAM_']) expect(bundleText).not.toContain(text)
  })
})

describe('the committed host copies', () => {
  const copies = ['hosts/claude/mcp/server.mjs', 'hosts/codex/mcp/server.mjs']

  // Modes are covered by generate:check; this pins the bytes where `bun test` alone would otherwise miss drift.
  test('exist and match the fresh build byte for byte', () => {
    for (const path of copies) expect(readFileSync(join(REPO_ROOT, path), 'utf8')).toBe(bundleText)
  })
})
