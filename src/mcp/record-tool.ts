// The `record` tool: the MCP form of the record helper, for hosts whose shell is sandboxed or approval-gated (Claude
// Code, Codex). It validates, stamps and writes through the same core as the CLI (src/record/run.ts), so a record
// written here has the same filename, bytes and collision behaviour as one the helper writes.
//
// The tool takes no path: the output root comes from the server's environment, exactly as for the CLI without
// `--out-dir`. The model cannot choose where a record goes.
import { z } from 'zod'

import { EXECUTION_MODES, SCHEMA_VERSION, SHIPPED_METHODS } from '../record/contract'
import { runRecord } from '../record/run'

/** The tool executions an MCP-written record can claim. The other `execution_mode` values are for the eval runner. */
export const MCP_EXECUTION_MODES = ['direct', 'sequential', 'delegated'] as const satisfies readonly (typeof EXECUTION_MODES)[number][]

export const RECORD_DESCRIPTION =
  'Write the decision record that a metacogs method skill (synthesis, counterfactual) ends with. The arguments are the fields of the skill\'s JSON record. On success the result is {"path","next_action"}. On an error the record was not written.'

const entries = (what: string) => z.array(z.string()).describe(`${what} One string per entry. An empty list is allowed.`)

/** Strict: an argument that is not a record field is an error, never silently dropped. There is no path argument. */
export const recordInputSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION).describe(`Always ${SCHEMA_VERSION}.`),
  method: z.enum(SHIPPED_METHODS).describe('The method skill whose run this records.'),
  method_version: z.string().describe('The method version shown in the skill\'s record template, as a string.'),
  objective: z.string().describe('The decision, restated.'),
  evidence: entries('What the input shows. For synthesis, one entry per perspective, starting with its label.'),
  assumptions: entries('What is assumed, asserted or inferred rather than shown.'),
  alternatives: entries('The options compared or the adjusted plan, including the dissent.'),
  findings: entries('What survives the checks, and the conclusion.'),
  next_action: z.string().describe('The next action. The result returns it to you.'),
  reopen_condition: z.string().describe('An observable event that should reopen the decision. Not the next action.'),
  execution_mode: z.enum(MCP_EXECUTION_MODES).describe('direct: you applied the steps. sequential: no delegation was available. delegated: only if you delegated.'),
  status: z.string().describe('The outcome label, for example "recommended".'),
})

export const RECORD_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

export interface RecordToolContext {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  /** Stamped as the record's `helper_version`. */
  version: string
}

export interface RecordToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: true
}

/**
 * Handle one call. A failure is a tool result with `isError`, reading `metacogs-record: <kind> (exit N)` and one
 * `  <field>: <message>` line per error. `<kind>` and `N` are the CLI's: validation 2, io 3, collision 4.
 */
export async function recordTool(args: z.infer<typeof recordInputSchema>, ctx: RecordToolContext): Promise<RecordToolResult> {
  const result = await runRecord({ input: args, methods: SHIPPED_METHODS, helperVersion: ctx.version, env: ctx.env, cwd: ctx.cwd })
  if (result.ok) return { content: [{ type: 'text', text: JSON.stringify({ path: result.path, next_action: result.next_action }) }] }
  const lines = result.errors.map(error => `  ${error.field}: ${error.message}`)
  return { content: [{ type: 'text', text: [`metacogs-record: ${result.kind} (exit ${result.exit})`, ...lines].join('\n') }], isError: true }
}
