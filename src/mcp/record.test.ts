import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildMcpServer, REPO_ROOT } from '../plugin/build'
import { recordFilename } from '../record/canonical'
import { LIMITS, RECORD_FIELDS } from '../record/contract'
import { runCli, validRecord } from '../record/test-support'
import { type Message, Session } from './test-support'

// Runs the built bundle under `node` from PATH (CI pins Node 22; locally `mise exec node@22 -- bun test`), from a
// directory with no node_modules, with an environment that holds only PATH, HOME and the records root under test.

const VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version

let scratch: string
let bundlePath: string
let counter = 0
const sessions: Session[] = []

interface Sandbox {
  root: string
  home: string
  cwd: string
}

/** A fresh records root, home and cwd. The root does not exist yet: the writer creates it. */
function sandbox(): Sandbox {
  const dir = join(scratch, `sb${counter++}`)
  const home = join(dir, 'home')
  const cwd = join(dir, 'cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd)
  return { root: join(dir, 'records'), home, cwd }
}

async function withRecordServer<T>(box: Sandbox, body: (session: Session) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const env = { PATH: process.env.PATH, HOME: box.home, METACOGS_RECORDS_DIR: box.root, ...extraEnv }
  const session = new Session(bundlePath, box.cwd, env)
  sessions.push(session)
  try {
    await session.initialize()
    return await body(session)
  } finally {
    session.kill()
  }
}

const args = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...validRecord(), ...overrides })
const files = (root: string): string[] => (existsSync(root) ? readdirSync(root) : [])
const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? ''

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-record-mcp-'))
  const installed = join(scratch, 'installed')
  mkdirSync(installed)
  bundlePath = join(installed, 'server.mjs')
  writeFileSync(bundlePath, await buildMcpServer())
})

afterAll(() => {
  for (const session of sessions) session.kill()
  rmSync(scratch, { recursive: true, force: true })
})

describe('the record tool: listing', () => {
  test('is registered with the exact annotations, strict arguments, no path argument and a description on every field', async () => {
    await withRecordServer(sandbox(), async session => {
      const { result } = await session.request('tools/list')
      const tools = result?.tools as {
        name: string
        description: string
        annotations: Record<string, unknown>
        inputSchema: { properties: Record<string, { description?: string; enum?: string[]; const?: unknown }>; required?: string[]; additionalProperties?: unknown }
      }[]
      const record = tools.find(tool => tool.name === 'record')!
      expect(record.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      expect(record.inputSchema.additionalProperties).toBe(false)
      // 1:1 with the record fields, minus the one the tool stamps itself.
      expect(Object.keys(record.inputSchema.properties).sort()).toEqual(RECORD_FIELDS.filter(field => field !== 'helper_version').sort())
      expect(record.inputSchema.required?.slice().sort()).toEqual(Object.keys(record.inputSchema.properties).sort())
      for (const [name, property] of Object.entries(record.inputSchema.properties)) expect(property.description, name).toBeTruthy()
      expect(record.inputSchema.properties.execution_mode?.enum).toEqual(['direct', 'sequential', 'delegated'])
      expect(record.inputSchema.properties.method?.enum).toEqual(['counterfactual', 'synthesis'])
      expect(record.inputSchema.properties.schema_version?.const).toBe(1)
      expect(record.inputSchema.properties).not.toHaveProperty('path')
      expect(record.description).toContain('"path","next_action"')
    })
  })
})

describe('the record tool: success', () => {
  test('returns {path, next_action} and writes a stamped 0600 file into the records root, creating it 0700', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const result = await session.call('record', args())
      expect(result.isError).toBeUndefined()
      expect(result.content).toHaveLength(1)
      const parsed = JSON.parse(textOf(result)) as { path: string; next_action: string }
      expect(Object.keys(parsed)).toEqual(['path', 'next_action'])
      expect(parsed.next_action).toBe('Confirm the deploy target supports the queue client')
      expect(parsed.path).toBe(join(box.root, recordFilename(validRecord())))
      expect(statSync(parsed.path).mode & 0o777).toBe(0o600)
      expect(statSync(box.root).mode & 0o777).toBe(0o700)
      const written = JSON.parse(readFileSync(parsed.path, 'utf8')) as Record<string, unknown>
      expect(written.helper_version).toBe(VERSION)
      expect(written).toEqual({ ...validRecord(), helper_version: VERSION })
      expect(files(box.root)).toEqual([recordFilename(validRecord())])
    })
  })

  test('all three execution modes are accepted', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      for (const mode of ['direct', 'sequential', 'delegated']) {
        const result = await session.call('record', args({ execution_mode: mode, objective: `Mode ${mode}` }))
        expect(result.isError, mode).toBeUndefined()
        expect(JSON.parse(readFileSync((JSON.parse(textOf(result)) as { path: string }).path, 'utf8')).execution_mode).toBe(mode)
      }
      expect(files(box.root)).toHaveLength(3)
    })
  })

  test('without METACOGS_RECORDS_DIR or XDG_STATE_HOME the root is under the server HOME', async () => {
    const box = sandbox()
    const env = { PATH: process.env.PATH, HOME: box.home }
    const session = new Session(bundlePath, box.cwd, env)
    sessions.push(session)
    try {
      await session.initialize()
      const parsed = JSON.parse(textOf(await session.call('record', args()))) as { path: string }
      expect(parsed.path).toBe(join(box.home, '.local', 'state', 'metacogs', 'records', recordFilename(validRecord())))
    } finally {
      session.kill()
    }
  })

  test('XDG_STATE_HOME is honoured when METACOGS_RECORDS_DIR is unset', async () => {
    const box = sandbox()
    const xdg = join(box.home, 'xdg')
    const session = new Session(bundlePath, box.cwd, { PATH: process.env.PATH, HOME: box.home, XDG_STATE_HOME: xdg })
    sessions.push(session)
    try {
      await session.initialize()
      const parsed = JSON.parse(textOf(await session.call('record', args()))) as { path: string }
      expect(parsed.path).toBe(join(xdg, 'metacogs', 'records', recordFilename(validRecord())))
    } finally {
      session.kill()
    }
  })

  test('concurrent identical calls yield one file and every call succeeds', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const results = await Promise.all(Array.from({ length: 8 }, () => session.call('record', args())))
      expect(results.every(result => result.isError === undefined)).toBe(true)
      expect(new Set(results.map(textOf)).size).toBe(1)
      expect(files(box.root)).toEqual([recordFilename(validRecord())])
    })
  })

  test('stdout carries only JSON-RPC, stderr is empty and the server exits 0 on stdin EOF', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      await session.request('tools/list')
      await session.call('record', args())
      await session.call('record', args({ objective: '' }))
      await session.call('record', { nonsense: true })
      expect(await session.end()).toBe(0)
      expect(session.stdoutLines.length).toBe(5)
      for (const line of session.stdoutLines) {
        const message = JSON.parse(line) as Message
        expect(message.jsonrpc).toBe('2.0')
        expect(message.result !== undefined || message.error !== undefined).toBe(true)
      }
      expect(session.stderr).toBe('')
    })
  })
})

describe('the record tool: errors', () => {
  test('a validation failure is isError with the CLI kind and exit code, one line per field, and nothing is written', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const result = await session.call('record', args({ objective: ' ', evidence: ['ok', ' '] }))
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(
        ['metacogs-record: validation (exit 2)', '  objective: is required and must be a non-empty string', '  evidence[1]: must be a non-empty string'].join('\n'),
      )
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('a collision is isError (exit 4) and the existing bytes are unchanged', async () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    const target = join(box.root, recordFilename(validRecord()))
    writeFileSync(target, '{"different":true}\n')
    await withRecordServer(box, async session => {
      const result = await session.call('record', args())
      expect(result.isError).toBe(true)
      expect(textOf(result)).toStartWith('metacogs-record: collision (exit 4)\n  $: ')
      expect(textOf(result)).toContain('refusing to overwrite')
      expect(readFileSync(target, 'utf8')).toBe('{"different":true}\n')
      expect(files(box.root)).toEqual([recordFilename(validRecord())])
    })
  })

  test('an unusable records root is isError (exit 3) and leaves nothing behind', async () => {
    const box = sandbox()
    const blocker = join(box.home, 'blocker')
    writeFileSync(blocker, 'x')
    await withRecordServer(
      { ...box, root: join(blocker, 'records') },
      async session => {
        const result = await session.call('record', args())
        expect(result.isError).toBe(true)
        expect(textOf(result)).toStartWith('metacogs-record: io (exit 3)\n  $: ')
        expect(readdirSync(box.home)).toEqual(['blocker'])
      },
    )
  })

  test('the legacy execution modes are rejected by the schema and write nothing', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      for (const mode of ['unrecorded', 'counterfactual', 'synthesis', 'other']) {
        const result = await session.call('record', args({ execution_mode: mode }))
        expect(result.isError, mode).toBe(true)
        expect(textOf(result), mode).toContain('execution_mode')
      }
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('an unknown argument is rejected, not dropped: a path, a stamped field and an invented one', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      for (const extra of [{ path: join(box.home, 'elsewhere') }, { helper_version: 'spoofed' }, { surprise: 1 }]) {
        const result = await session.call('record', args(extra))
        expect(result.isError, JSON.stringify(extra)).toBe(true)
        expect(textOf(result), JSON.stringify(extra)).toContain(Object.keys(extra)[0]!)
      }
      expect(existsSync(box.root)).toBe(false)
      expect(existsSync(join(box.home, 'elsewhere'))).toBe(false)
    })
  })

  // Errors from the SDK's own schema check never reach the callback, so they keep the SDK's form rather than the
  // `metacogs-record: <kind> (exit N)` envelope. Both forms are isError results that name the field.
  test('a schema error keeps the SDK envelope, a record error uses the metacogs-record envelope', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const schema = await session.call('record', args({ evidence: 'not a list', method: '../escape' }))
      expect(schema.isError).toBe(true)
      expect(textOf(schema)).toStartWith('MCP error -32602: Input validation error: Invalid arguments for tool record')
      expect(textOf(schema)).toContain('evidence')
      expect(textOf(schema)).toContain('method')
      const record = await session.call('record', args({ objective: '' }))
      expect(textOf(record)).toStartWith('metacogs-record: validation (exit 2)')
      expect(existsSync(box.root)).toBe(false)
      expect(existsSync(join(box.root, '..', 'escape'))).toBe(false)
    })
  })

  test('traversal through method is rejected before anything is written', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      for (const method of ['../escape', '../../etc/passwd', 'a/b', 'synthesis/../x']) {
        expect((await session.call('record', args({ method }))).isError, method).toBe(true)
      }
      expect(readdirSync(join(box.root, '..')).sort()).toEqual(['cwd', 'home'])
    })
  })

  test('the server survives errors and still records afterwards', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      await session.call('record', {})
      await session.call('record', args({ objective: '' }))
      expect((await session.call('record', args())).isError).toBeUndefined()
    })
  })
})

describe('the record tool: limits', () => {
  test('oversized strings, arrays and total payload are rejected with no file created', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const cases: [string, Record<string, unknown>, string][] = [
        ['string', { objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }, `objective: is ${LIMITS.MAX_STRING_LENGTH + 1} characters; the limit is ${LIMITS.MAX_STRING_LENGTH}`],
        ['entry', { findings: ['ok', 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1)] }, 'findings[1]'],
        ['array', { evidence: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS + 1 }, (_, i) => `e${i}`) }, `evidence: has ${LIMITS.MAX_ARRAY_ITEMS + 1} entries; the limit is ${LIMITS.MAX_ARRAY_ITEMS}`],
        ['payload', { assumptions: Array.from({ length: 20 }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH)) }, `the limit is ${LIMITS.MAX_PAYLOAD_BYTES}`],
      ]
      for (const [name, overrides, expected] of cases) {
        const result = await session.call('record', args(overrides))
        expect(result.isError, name).toBe(true)
        expect(textOf(result), name).toStartWith('metacogs-record: validation (exit 2)')
        expect(textOf(result), name).toContain(expected)
      }
      // The size error names the record, which the rendered retry rule covers ("a field or the record's size").
      const big = await session.call('record', args({ assumptions: Array.from({ length: 20 }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH)) }))
      expect(textOf(big)).toMatch(/^metacogs-record: validation \(exit 2\)\n {2}record: is \d+ bytes; the limit is 65536$/)
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('a record at the limits is accepted', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const result = await session.call('record', args({ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH), findings: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS }, (_, i) => `finding ${i}`) }))
      expect(result.isError).toBeUndefined()
    })
  })
})

describe('parity with the CLI', () => {
  // Same input, same root, same hash. The two entry points stamp their own version, so the bytes differ in that field only.
  const cli = async (box: Sandbox, input: unknown) => runCli([], { stdin: JSON.stringify(input), env: { METACOGS_RECORDS_DIR: box.root, HOME: box.home }, cwd: box.cwd, helperVersion: '0.0.0-cli' })

  test('the same input gives the same filename, and bytes equal apart from helper_version', async () => {
    const viaCli = sandbox()
    const viaMcp = sandbox()
    const cliOut = await cli(viaCli, validRecord())
    expect(cliOut.code).toBe(0)
    const cliPath = (JSON.parse(cliOut.stdout) as { path: string }).path
    const mcpPath = await withRecordServer(viaMcp, async session => (JSON.parse(textOf(await session.call('record', args()))) as { path: string }).path)

    expect(files(viaCli.root)).toEqual(files(viaMcp.root))
    expect(cliPath.slice(viaCli.root.length)).toBe(mcpPath.slice(viaMcp.root.length))
    const cliBytes = readFileSync(cliPath, 'utf8')
    const mcpBytes = readFileSync(mcpPath, 'utf8')
    expect(cliBytes).not.toBe(mcpBytes)
    expect(cliBytes.replace('"helper_version":"0.0.0-cli"', '"helper_version":"X"')).toBe(mcpBytes.replace(`"helper_version":"${VERSION}"`, '"helper_version":"X"'))
    expect(cliBytes.replace('0.0.0-cli', VERSION)).toBe(mcpBytes)
  })

  test('key order and whitespace in the CLI input do not change the filename the tool produces', async () => {
    const box = sandbox()
    const reordered = Object.fromEntries(Object.entries(validRecord()).reverse())
    expect((await cli(box, reordered)).code).toBe(0)
    await withRecordServer(box, async session => {
      expect((await session.call('record', args())).isError).toBeUndefined()
    })
    expect(files(box.root)).toHaveLength(1)
  })

  test('an equivalent retry succeeds across entry points and leaves the first writer\'s bytes', async () => {
    const box = sandbox()
    const first = await cli(box, validRecord())
    const path = (JSON.parse(first.stdout) as { path: string }).path
    const before = readFileSync(path, 'utf8')
    await withRecordServer(box, async session => {
      const retry = await session.call('record', args())
      expect(retry.isError).toBeUndefined()
      expect(JSON.parse(textOf(retry))).toEqual({ path, next_action: 'Confirm the deploy target supports the queue client' })
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect((await cli(box, validRecord())).code).toBe(0)
    expect(files(box.root)).toHaveLength(1)
  })

  test('a differing file at the final name collides in both, with the same exit code, and stays unchanged', async () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    const target = join(box.root, recordFilename(validRecord()))
    writeFileSync(target, 'not a record\n')
    const cliOut = await cli(box, validRecord())
    expect(cliOut.code).toBe(4)
    expect(cliOut.stderr).toStartWith('metacogs-record: collision: ')
    await withRecordServer(box, async session => {
      const result = await session.call('record', args())
      expect(textOf(result)).toStartWith('metacogs-record: collision (exit 4)')
    })
    expect(readFileSync(target, 'utf8')).toBe('not a record\n')
  })

  test('both refuse the same oversized and invalid inputs with exit 2 and write nothing', async () => {
    const viaCli = sandbox()
    const viaMcp = sandbox()
    const bad = [{ objective: 'x'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }, { evidence: Array.from({ length: LIMITS.MAX_ARRAY_ITEMS + 1 }, () => 'e') }, { objective: '' }]
    await withRecordServer(viaMcp, async session => {
      for (const overrides of bad) {
        const cliOut = await cli(viaCli, validRecord(overrides))
        expect(cliOut.code).toBe(2)
        const mcp = await session.call('record', args(overrides))
        expect(textOf(mcp)).toStartWith('metacogs-record: validation (exit 2)')
        // The same field messages, whichever channel reports them.
        const fieldLines = (text: string) => text.split('\n').filter(line => line.startsWith('  '))
        expect(fieldLines(textOf(mcp))).toEqual(fieldLines(cliOut.stderr))
      }
    })
    expect(existsSync(viaCli.root)).toBe(false)
    expect(existsSync(viaMcp.root)).toBe(false)
  })
})

describe('the record tool: hostile input', () => {
  const NO_STACK = /RangeError|TypeError|Maximum call stack|\n\s+at /
  const callRaw = (session: Session, argumentsJson: string) =>
    session.requestRaw(id => `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"record","arguments":${argumentsJson}}}`)

  test('deeply nested junk in an unknown field is refused as a tool error with no stack trace, writes nothing, and the server keeps answering', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const depth = 10_000
      const fields = JSON.stringify(args()).slice(0, -1)
      const response = await callRaw(session, `${fields},"junk":${'['.repeat(depth)}${']'.repeat(depth)}}`)
      const result = response.result as unknown as { isError?: boolean; content: { text: string }[] }
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('junk')
      expect(textOf(result)).not.toMatch(NO_STACK)
      expect(existsSync(box.root)).toBe(false)
      expect((await session.call('record', args())).isError).toBeUndefined()
      expect(session.stderr).toBe('')
    })
  })

  test('deeply nested junk in a known field is refused the same way', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const nested = `${'['.repeat(10_000)}${']'.repeat(10_000)}`
      const fields = JSON.stringify(args({ objective: 'x' })).replace('"objective":"x"', `"objective":${nested}`)
      const result = (await callRaw(session, fields)).result as unknown as { isError?: boolean; content: { text: string }[] }
      expect(result.isError).toBe(true)
      expect(textOf(result)).not.toMatch(NO_STACK)
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('a lone surrogate is a validation error (exit 2) naming the field, not an I/O failure', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const result = await session.call('record', args({ objective: 'before \ud800 after', findings: ['ok', 'bad \udc00'] }))
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(['metacogs-record: validation (exit 2)', '  objective: contains a lone surrogate', '  findings[1]: contains a lone surrogate'].join('\n'))
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('a multibyte payload under the limit in UTF-16 units and over it in UTF-8 bytes is refused', async () => {
    const box = sandbox()
    await withRecordServer(box, async session => {
      const euro = '€'.repeat(LIMITS.MAX_STRING_LENGTH)
      const overrides = { evidence: Array.from({ length: 6 }, () => euro) }
      expect(JSON.stringify(args(overrides)).length).toBeLessThan(LIMITS.MAX_PAYLOAD_BYTES)
      const result = await session.call('record', args(overrides))
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/^metacogs-record: validation \(exit 2\)\n {2}record: is \d+ bytes; the limit is 65536$/)
      expect(existsSync(box.root)).toBe(false)
    })
  })

  test('the stamp counts: a record that is exactly the limit before stamping is refused, and one that is exactly the limit stamped is written and replays through the CLI', async () => {
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
    const padded = (target: number): Record<string, unknown> => {
      for (let full = 0; full < LIMITS.MAX_ARRAY_ITEMS; full++) {
        const filler = Array.from({ length: full }, () => 'a'.repeat(LIMITS.MAX_STRING_LENGTH))
        const last = target - bytes(args({ findings: filler })) - 2 - (full > 0 ? 1 : 0)
        if (last >= 1 && last <= LIMITS.MAX_STRING_LENGTH) return args({ findings: [...filler, 'b'.repeat(last)] })
      }
      throw new Error('no padding fits')
    }
    const stampBytes = bytes({ ...args(), helper_version: VERSION }) - bytes(args())
    const box = sandbox()
    await withRecordServer(box, async session => {
      const exact = padded(LIMITS.MAX_PAYLOAD_BYTES)
      expect(bytes(exact)).toBe(LIMITS.MAX_PAYLOAD_BYTES)
      const refused = await session.call('record', exact)
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toMatch(/^metacogs-record: validation \(exit 2\)\n {2}record: is \d+ bytes; the limit is 65536$/)
      expect(existsSync(box.root)).toBe(false)

      const fits = await session.call('record', padded(LIMITS.MAX_PAYLOAD_BYTES - stampBytes))
      expect(fits.isError).toBeUndefined()
      const { path } = JSON.parse(textOf(fits)) as { path: string }
      expect(bytes(JSON.parse(readFileSync(path, 'utf8')))).toBe(LIMITS.MAX_PAYLOAD_BYTES)
      const replay = await runCli(['--out-dir', join(box.root, '..', 'replayed'), '--file', path], { helperVersion: VERSION })
      expect({ code: replay.code, stderr: replay.stderr }).toEqual({ code: 0, stderr: '' })
    })
  })
})
