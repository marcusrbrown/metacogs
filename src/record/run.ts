// The shared core of the record helper and the MCP `record` tool: validate, stamp `helper_version`, resolve the output
// root and write. It does no IO of its own beyond that write. The CLI (cli.ts) and the MCP server (src/mcp/server.ts)
// each format the result for their own channel; the exit codes are the CLI's, and the MCP tool reports them by number.
import { homedir } from 'node:os'
import { EXIT, type StampedRecord } from './contract'
import { type FieldError, validateRecord } from './validate'
import { RecordCollisionError, RecordIoError, resolveRoot, writeRecord } from './write'

export interface RunRecordInput {
  /** The untrusted record, already parsed. */
  input: unknown
  /** Allowed `method` values. */
  methods: readonly string[]
  /** Stamped into the record, over any value the caller supplied. */
  helperVersion: string
  /** The CLI's `--out-dir`. The MCP tool has no equivalent. */
  outDir?: string | undefined
  env: Readonly<Record<string, string | undefined>>
  cwd: string
}

export type RunRecordFailure =
  | { ok: false; kind: 'validation'; exit: typeof EXIT.VALIDATION; errors: FieldError[] }
  | { ok: false; kind: 'collision'; exit: typeof EXIT.COLLISION; errors: FieldError[] }
  | { ok: false; kind: 'io'; exit: typeof EXIT.IO; errors: FieldError[] }

export type RunRecordResult =
  | { ok: true; exit: typeof EXIT.OK; path: string; next_action: string; status: 'written' | 'exists' }
  | RunRecordFailure

/** Collision and I/O failures carry one message, not a field; `$` is the validator's name for the whole record. */
const whole = (message: string): FieldError[] => [{ field: '$', message }]

export async function runRecord({ input, methods, helperVersion, outDir, env, cwd }: RunRecordInput): Promise<RunRecordResult> {
  const checked = validateRecord(input, { methods })
  if (!checked.ok) return { ok: false, kind: 'validation', exit: EXIT.VALIDATION, errors: checked.errors }

  const record: StampedRecord = { ...checked.record, helper_version: helperVersion }

  try {
    const root = resolveRoot({ outDir, env, cwd, home: env.HOME || homedir() })
    const { path, status } = await writeRecord({ root, record })
    return { ok: true, exit: EXIT.OK, path, next_action: record.next_action, status }
  } catch (error) {
    if (error instanceof RecordCollisionError) return { ok: false, kind: 'collision', exit: EXIT.COLLISION, errors: whole(error.message) }
    const message = error instanceof RecordIoError ? error.message : (error as Error).message
    return { ok: false, kind: 'io', exit: EXIT.IO, errors: whole(message) }
  }
}
