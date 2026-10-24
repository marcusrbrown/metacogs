// Shared fixtures for the record tests. Not a test file itself (no `.test.` suffix).
import { run } from './cli'

export type RecordLike = { method: string; [key: string]: unknown }

export function validRecord(overrides: Record<string, unknown> = {}): RecordLike {
  return {
    schema_version: 1,
    method: 'counterfactual',
    method_version: '1',
    objective: 'Decide whether to adopt a managed queue',
    evidence: ['repo:deploy/README.md#runtime'],
    assumptions: ['The team can operate one more stateful service'],
    alternatives: ['Keep the in-process queue'],
    findings: ['The managed queue conflicts with the pinned deploy target'],
    next_action: 'Confirm the deploy target supports the queue client',
    reopen_condition: 'The deploy target changes',
    execution_mode: 'direct',
    status: 'accepted',
    ...overrides,
  }
}

export const TEST_HELPER_VERSION = '9.9.9-test'

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunCliOptions {
  stdin?: string
  env?: Record<string, string | undefined>
  cwd?: string
  methods?: readonly string[]
  helperVersion?: string
}

/** Run the CLI in-process with captured IO. */
export async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  const code = await run(args, {
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    readStdin: async () => options.stdin ?? '',
    stdout: text => {
      stdout += text
    },
    stderr: text => {
      stderr += text
    },
    ...(options.methods !== undefined ? { methods: options.methods } : {}),
    helperVersion: options.helperVersion ?? TEST_HELPER_VERSION,
  })
  return { code, stdout, stderr }
}
