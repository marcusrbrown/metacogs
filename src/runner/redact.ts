/**
 * Redaction for judge input. `evals/<method>/redact.json` lists tokens that
 * name the method under test (its record field names, its skill path, its
 * vocabulary). Stripping them keeps the judge from recognizing which condition
 * produced an answer, so it scores content rather than method branding.
 *
 * Matching is literal and case-insensitive, after NFKC normalization and
 * removal of zero-width characters, so `Load-Bearing` and `load\u200b-bearing`
 * are both caught. The runner re-scans the redacted text and refuses to send
 * a request if any token survives.
 */
import { readFileSync } from 'node:fs'

export const REDACTION_PLACEHOLDER = '[redacted]'

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g

export class RedactionFailed extends Error {
  constructor(readonly surviving: readonly string[]) {
    super(`redaction_failed: ${surviving.length} token(s) survived redaction`)
    this.name = 'RedactionFailed'
  }
}

/** Canonical form used for matching: NFKC, zero-width characters removed. */
export function normalizeForRedaction(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '')
}

/**
 * Accepts the bare-array form (`["a", "b"]`) and `{"tokens": ["a", "b"]}`.
 * Tokens are trimmed, de-duplicated, and returned longest first so a long
 * token is replaced before any shorter token it contains.
 */
export function parseRedactTokens(text: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`redact list is not valid JSON: ${(e as Error).message}`)
  }
  const list = Array.isArray(raw) ? raw : isTokensObject(raw) ? raw.tokens : undefined
  if (!list) throw new Error('redact list must be an array of strings or {"tokens": [...]}')
  const tokens = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error('redact list entries must be non-empty strings')
    const token = normalizeForRedaction(entry.trim())
    if (token.toLowerCase().includes(REDACTION_PLACEHOLDER) || REDACTION_PLACEHOLDER.includes(token.toLowerCase())) {
      throw new Error(`redact token "${entry}" overlaps the placeholder ${REDACTION_PLACEHOLDER}`)
    }
    tokens.add(token)
  }
  if (tokens.size === 0) throw new Error('redact list is empty')
  return [...tokens].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
}

function isTokensObject(value: unknown): value is { tokens: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { tokens?: unknown }).tokens)
}

export function loadRedactTokens(path: string): string[] {
  return parseRedactTokens(readFileSync(path, 'utf8'))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces every token occurrence with the placeholder. Returns the normalized, redacted text. */
export function redact(text: string, tokens: readonly string[]): string {
  let out = normalizeForRedaction(text)
  for (const token of tokens) out = out.replace(new RegExp(escapeRegExp(token), 'gi'), REDACTION_PLACEHOLDER)
  return out
}

/** Tokens still present in `text` (case-insensitive, after the same normalization). */
export function survivingTokens(text: string, tokens: readonly string[]): string[] {
  const haystack = normalizeForRedaction(text).toLowerCase()
  return tokens.filter((token) => haystack.includes(token.toLowerCase()))
}

/** `redact`, then assert nothing survived; throws `RedactionFailed` otherwise. */
export function redactOrThrow(text: string, tokens: readonly string[]): string {
  const out = redact(text, tokens)
  const surviving = survivingTokens(out, tokens)
  if (surviving.length) throw new RedactionFailed(surviving)
  return out
}
