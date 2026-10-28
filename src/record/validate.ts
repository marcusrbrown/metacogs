import {
  EXECUTION_MODES,
  LIMITS,
  METHOD_PATTERN,
  type MetacogsRecord,
  RECORD_FIELDS,
  REQUIRED_STRING_FIELDS,
  SCHEMA_VERSION,
  SHIPPED_METHODS,
  STAMPED_FIELD,
  STRING_ARRAY_FIELDS,
} from './contract'

export interface FieldError {
  field: string
  message: string
}

export type ValidationResult = { ok: true; record: MetacogsRecord } | { ok: false; errors: FieldError[] }

export interface ValidateOptions {
  /** Allowed `method` values. Defaults to the shipped-method enum. Injectable for tests and bundling. */
  methods?: readonly string[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Parse untrusted input into a MetacogsRecord, or report every failing field. */
export function validateRecord(input: unknown, options: ValidateOptions = {}): ValidationResult {
  if (!isPlainObject(input)) return fail([{ field: 'record', message: 'must be a JSON object' }])

  // Check the version first: a record from another schema generation has no obligation to match this shape.
  if (input.schema_version !== SCHEMA_VERSION) {
    const got = input.schema_version === undefined ? 'missing' : JSON.stringify(input.schema_version)
    return fail([{ field: 'schema_version', message: `unsupported value ${got}; this helper only accepts ${SCHEMA_VERSION}` }])
  }

  // Size first, so an oversized payload is rejected without a per-field pass over it.
  const payloadBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (payloadBytes > LIMITS.MAX_PAYLOAD_BYTES) {
    return fail([{ field: 'record', message: `is ${payloadBytes} bytes; the limit is ${LIMITS.MAX_PAYLOAD_BYTES}` }])
  }

  const errors: FieldError[] = []
  // Characters are code points, so an emoji counts once. The payload cap above bounds the cost of spreading a string.
  const tooLong = (field: string, value: string): void => {
    const characters = [...value].length
    if (characters > LIMITS.MAX_STRING_LENGTH) {
      errors.push({ field, message: `is ${characters} characters; the limit is ${LIMITS.MAX_STRING_LENGTH}` })
    }
  }
  const methods = options.methods ?? SHIPPED_METHODS

  for (const key of Object.keys(input)) {
    if (!(RECORD_FIELDS as readonly string[]).includes(key)) errors.push({ field: key, message: 'unknown field' })
  }

  if (input[STAMPED_FIELD] !== undefined && typeof input[STAMPED_FIELD] !== 'string') {
    errors.push({ field: STAMPED_FIELD, message: 'must be a string when present' })
  } else if (typeof input[STAMPED_FIELD] === 'string') {
    tooLong(STAMPED_FIELD, input[STAMPED_FIELD])
  }

  const method = input.method
  if (typeof method !== 'string') {
    errors.push({ field: 'method', message: 'is required and must be a string' })
  } else if (!METHOD_PATTERN.test(method)) {
    errors.push({ field: 'method', message: `must match ${METHOD_PATTERN.source}` })
  } else if (!methods.includes(method)) {
    errors.push({ field: 'method', message: `must be one of: ${methods.join(', ')}` })
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field]
    if (!isNonEmptyString(value)) errors.push({ field, message: 'is required and must be a non-empty string' })
    else tooLong(field, value)
  }

  for (const field of STRING_ARRAY_FIELDS) {
    const value = input[field]
    if (!Array.isArray(value)) {
      errors.push({ field, message: 'is required and must be an array of strings' })
      continue
    }
    if (value.length > LIMITS.MAX_ARRAY_ITEMS) {
      errors.push({ field, message: `has ${value.length} entries; the limit is ${LIMITS.MAX_ARRAY_ITEMS}` })
      continue
    }
    value.forEach((entry, index) => {
      if (!isNonEmptyString(entry)) errors.push({ field: `${field}[${index}]`, message: 'must be a non-empty string' })
      else tooLong(`${field}[${index}]`, entry)
    })
  }

  const mode = input.execution_mode
  if (typeof mode !== 'string' || !(EXECUTION_MODES as readonly string[]).includes(mode)) {
    errors.push({ field: 'execution_mode', message: `must be one of: ${EXECUTION_MODES.join(', ')}` })
  }

  if (errors.length > 0) return fail(errors)
  return { ok: true, record: input as unknown as MetacogsRecord }
}

function fail(errors: FieldError[]): ValidationResult {
  return { ok: false, errors }
}
