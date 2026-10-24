import { createHash } from 'node:crypto'
import { STAMPED_FIELD } from './contract'

/**
 * RFC 8785 (JCS) canonical JSON.
 *
 * - Objects: members sorted by UTF-16 code units of the key (default JS string order), no whitespace.
 * - Numbers: ECMAScript Number::toString, which is what JSON.stringify emits and what RFC 8785 section 3.2.2.3 mandates.
 * - Strings: JSON.stringify escaping (the minimal escapes RFC 8785 section 3.2.2.2 prescribes).
 *
 * Strictness beyond the RFC's I-JSON requirement: anything that is not null/boolean/finite number/
 * well-formed string/array/plain object throws, instead of being silently dropped or coerced.
 * No deviations otherwise.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number')
      return JSON.stringify(value)
    case 'string':
      if (!value.isWellFormed()) throw new TypeError('canonicalize: string contains a lone surrogate')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalize: only plain objects are supported')
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([key, val]) => `${canonicalize(key)}:${canonicalize(val)}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`)
  }
}

/** The hashed payload: the record's canonical form with `helper_version` removed. */
export function canonicalPayload(record: object): string {
  const { [STAMPED_FIELD]: _stamped, ...payload } = record as Record<string, unknown>
  return canonicalize(payload)
}

/** Full sha256 hex digest of the canonical payload. */
export function recordHash(record: object): string {
  return createHash('sha256').update(canonicalPayload(record), 'utf8').digest('hex')
}

/** `<method>-<first 16 hex of the payload hash>.json` */
export function recordFilename(record: { method: string }): string {
  return `${record.method}-${recordHash(record).slice(0, 16)}.json`
}
