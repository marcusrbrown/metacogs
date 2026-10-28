// Record helper: validates a decision record read from stdin or --file and writes it atomically.
// This file is the single source for every skill's generated `scripts/record.mjs` (see src/generate/).
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EXIT, SHIPPED_METHODS, type StampedRecord } from './contract'
import { validateRecord } from './validate'
import { RecordCollisionError, RecordIoError, resolveRoot, writeRecord } from './write'

// Replaced at bundle time by Bun.build `define` (see src/generate/tree.ts). Undeclared when run from source.
declare const __METACOGS_HELPER_VERSION__: string | undefined
declare const __METACOGS_METHODS__: string | undefined

const PROGRAM = 'metacogs-record'

const USAGE = `usage: ${PROGRAM} [--out-dir <dir>] [--file <path>]
  Reads one JSON record from stdin (or --file), validates it, and writes <method>-<hash>.json.
  Output root: --out-dir, else $METACOGS_RECORDS_DIR, else $XDG_STATE_HOME/metacogs/records,
               else ~/.local/state/metacogs/records.
  Prints {"path": ..., "next_action": ...} on success.
  Exit codes: 0 written, 2 validation, 3 I/O, 4 collision, 64 usage.
`

/** Thrown by a stdin reader when there is no input to read (for example an interactive terminal). */
export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  readStdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Allowed `method` values. Defaults to the build-time enum, else SHIPPED_METHODS. */
  methods?: readonly string[]
  /** Stamped into every record. Defaults to the build-time constant (package.json version), else '0.0.0-source'. */
  helperVersion?: string
}

type ParsedArgs = { kind: 'help' } | { kind: 'run'; outDir?: string; file?: string } | { kind: 'usage'; message: string }

function parseArgs(argv: readonly string[]): ParsedArgs {
  let outDir: string | undefined
  let file: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    if (flag !== '--out-dir' && flag !== '--file') return { kind: 'usage', message: `unexpected argument: ${arg}` }
    let value: string | undefined
    if (flag === arg) {
      value = argv[++i]
    } else {
      value = arg.slice(eq + 1)
    }
    if (value === undefined || value === '') return { kind: 'usage', message: `${flag} requires a value` }
    if (flag === '--out-dir') {
      if (outDir !== undefined) return { kind: 'usage', message: '--out-dir given more than once' }
      outDir = value
    } else {
      if (file !== undefined) return { kind: 'usage', message: '--file given more than once' }
      file = value
    }
  }
  return { kind: 'run', ...(outDir !== undefined ? { outDir } : {}), ...(file !== undefined ? { file } : {}) }
}

function buildMethods(): readonly string[] {
  return typeof __METACOGS_METHODS__ === 'string' ? __METACOGS_METHODS__.split(',') : SHIPPED_METHODS
}

// Running from source (not a generated helper) has no package.json version baked in.
const SOURCE_HELPER_VERSION = '0.0.0-source'

function buildHelperVersion(): string {
  return typeof __METACOGS_HELPER_VERSION__ === 'string' ? __METACOGS_HELPER_VERSION__ : SOURCE_HELPER_VERSION
}

export async function run(argv: readonly string[], ctx: CliContext): Promise<number> {
  const err = (text: string) => ctx.stderr(`${PROGRAM}: ${text}\n`)
  const args = parseArgs(argv)
  if (args.kind === 'help') {
    ctx.stdout(USAGE)
    return EXIT.OK
  }
  if (args.kind === 'usage') {
    ctx.stderr(`${PROGRAM}: ${args.message}\n${USAGE}`)
    return EXIT.USAGE
  }

  let raw: string
  try {
    raw = args.file !== undefined ? await readFile(args.file, 'utf8') : await ctx.readStdin()
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(`${PROGRAM}: ${error.message}\n${USAGE}`)
      return EXIT.USAGE
    }
    err(`cannot read input: ${(error as Error).message}`)
    return EXIT.IO
  }

  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    err('validation failed\n  $: input is not valid JSON')
    return EXIT.VALIDATION
  }

  const checked = validateRecord(input, { methods: ctx.methods ?? buildMethods() })
  if (!checked.ok) {
    err(`validation failed\n${checked.errors.map(e => `  ${e.field}: ${e.message}`).join('\n')}`)
    return EXIT.VALIDATION
  }

  const record: StampedRecord = { ...checked.record, helper_version: ctx.helperVersion ?? buildHelperVersion() }

  try {
    const root = resolveRoot({
      outDir: args.outDir,
      env: ctx.env,
      cwd: ctx.cwd,
      home: ctx.env.HOME || homedir(),
    })
    const { path } = await writeRecord({ root, record })
    ctx.stdout(`${JSON.stringify({ path, next_action: record.next_action })}\n`)
    return EXIT.OK
  } catch (error) {
    if (error instanceof RecordCollisionError) {
      err(`collision: ${error.message}`)
      return EXIT.COLLISION
    }
    err(`I/O failure: ${error instanceof RecordIoError ? error.message : (error as Error).message}`)
    return EXIT.IO
  }
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('no input: pipe a JSON record on stdin or pass --file')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: readProcessStdin,
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
  })
}
