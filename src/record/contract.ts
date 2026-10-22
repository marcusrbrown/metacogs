// The record contract: the single source of truth for what a metacogs decision record is.
// The validator (validate.ts), the helper CLI (cli.ts), and the eval runner all import from here.

export const SCHEMA_VERSION = 1 as const

/** Methods that ship in this pack. A record's `method` must be one of these (and match METHOD_PATTERN). */
export const SHIPPED_METHODS = ['counterfactual', 'synthesis'] as const

export const METHOD_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export const EXECUTION_MODES = [
  'direct',
  'sequential',
  'delegated',
  'unrecorded',
  'counterfactual',
  'synthesis',
] as const

export type ExecutionMode = (typeof EXECUTION_MODES)[number]

/** Non-empty string fields (after trimming). */
export const REQUIRED_STRING_FIELDS = ['method_version', 'objective', 'next_action', 'reopen_condition', 'status'] as const

/** Arrays of non-empty strings. Empty arrays are valid. Entries are opaque; refs are never dereferenced. */
export const STRING_ARRAY_FIELDS = ['evidence', 'assumptions', 'alternatives', 'findings'] as const

/** The one field the helper stamps and the canonical hash excludes. */
export const STAMPED_FIELD = 'helper_version' as const

export const RECORD_FIELDS = [
  'schema_version',
  'helper_version',
  'method',
  'method_version',
  'objective',
  'evidence',
  'assumptions',
  'alternatives',
  'findings',
  'next_action',
  'reopen_condition',
  'execution_mode',
  'status',
] as const

export interface MetacogsRecord {
  schema_version: typeof SCHEMA_VERSION
  /** Stamped by the helper at write time; optional on input, excluded from the canonical hash. */
  helper_version?: string
  method: string
  method_version: string
  objective: string
  evidence: string[]
  assumptions: string[]
  alternatives: string[]
  findings: string[]
  next_action: string
  reopen_condition: string
  execution_mode: ExecutionMode
  status: string
}

export type StampedRecord = MetacogsRecord & { helper_version: string }

/** Helper exit codes. Shared vocabulary for the CLI and the eval runner. */
export const EXIT = {
  OK: 0,
  VALIDATION: 2,
  IO: 3,
  COLLISION: 4,
  USAGE: 64,
} as const
