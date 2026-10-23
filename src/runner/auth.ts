/**
 * Credential passthrough for live runs.
 *
 * The unauthenticated free tier rate-limits and stalls under sustained use, so
 * the owner authorizes copying provider entries from the real `auth.json` into
 * each run's throwaway `$XDG_DATA_HOME/opencode/auth.json`. `opencode-go` (the Go
 * subscription) is the default and preferred gateway. `opencode` (Zen) bills
 * credits and is copied only when it is named explicitly. Everything else about isolation is
 * unchanged: `HOME` and `XDG_*` stay fixture-local, no other provider entry is
 * ever copied, and the file dies with the fixture.
 *
 * Rules this module keeps:
 * - Values are read and written programmatically. They are never logged,
 *   returned in an error message, or placed in a manifest. Only provider names
 *   are recorded.
 * - `needlesOf` derives the strings the leak scan must never find in a
 *   manifest, artifact, request body, or report.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Fixture } from './env'
import type { Needle } from './manifest'

/** The only providers a passthrough may name. */
export const PASSTHROUGH_PROVIDERS = ['opencode', 'opencode-go'] as const
export type PassthroughProvider = (typeof PASSTHROUGH_PROVIDERS)[number]

/** Provider name → its `auth.json` entry. Values are secret; never print them. */
export type PassthroughAuth = Readonly<Record<string, Record<string, unknown>>>

export class AuthPassthroughError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthPassthroughError'
  }
}

/** What a live run copies when neither the flag nor the env var says otherwise: Go only, never Zen. */
export const DEFAULT_PASSTHROUGH: readonly PassthroughProvider[] = ['opencode-go']

/**
 * `--auth-passthrough a,b` or `METACOGS_AUTH_PASSTHROUGH=a,b`; the flag wins. Unknown names are refused.
 * `none` copies nothing. When neither is set the result is `fallback` (default: nothing).
 */
export function parseAuthPassthrough(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
  fallback: readonly PassthroughProvider[] = [],
): PassthroughProvider[] {
  const raw = flag ?? env.METACOGS_AUTH_PASSTHROUGH
  if (raw === undefined || raw.trim() === '') return [...fallback]
  if (raw.trim() === 'none') return []
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
  const unknown = names.filter((n) => !(PASSTHROUGH_PROVIDERS as readonly string[]).includes(n))
  if (unknown.length) {
    throw new AuthPassthroughError(`auth passthrough may name only ${PASSTHROUGH_PROVIDERS.join(', ')}; refused: ${unknown.join(', ')}`)
  }
  return names as PassthroughProvider[]
}

/** The real `auth.json`: `$XDG_DATA_HOME/opencode/auth.json`, else `~/.local/share/opencode/auth.json`. */
export function realAuthJsonPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share')
  return join(base, 'opencode', 'auth.json')
}

/**
 * Reads the named provider entries. Throws (without echoing any value) if the
 * file is missing, unparseable, or lacks a requested provider.
 */
export function readPassthroughAuth(providers: readonly string[], path = realAuthJsonPath()): PassthroughAuth {
  if (providers.length === 0) return {}
  if (!existsSync(path)) throw new AuthPassthroughError('auth passthrough requested but the real auth.json does not exist')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new AuthPassthroughError('auth passthrough requested but the real auth.json is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AuthPassthroughError('real auth.json is not an object')
  const out: Record<string, Record<string, unknown>> = {}
  for (const provider of providers) {
    const entry = (raw as Record<string, unknown>)[provider]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AuthPassthroughError(`real auth.json has no entry for provider "${provider}"`)
    }
    out[provider] = { ...(entry as Record<string, unknown>) }
  }
  return out
}

/** Writes only the passed entries into the run's isolated `auth.json` (0600). */
export function writeIsolatedAuth(fixture: Pick<Fixture, 'xdgDataHome'>, auth: PassthroughAuth): void {
  if (Object.keys(auth).length === 0) return
  const dir = join(fixture.xdgDataHome, 'opencode')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'auth.json')
  writeFileSync(path, JSON.stringify(auth), { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Provider names only: what a manifest may say about the passthrough. */
export const passthroughNames = (auth: PassthroughAuth): string[] => Object.keys(auth).sort()

const MIN_SECRET_CHARS = 8

/**
 * Every string value in each entry long enough to be a secret, minus the
 * `type` discriminator. Labels carry the provider and field name, never the value.
 */
export function needlesOf(auth: PassthroughAuth): Needle[] {
  const needles: Needle[] = []
  const seen = new Set<string>()
  for (const [provider, entry] of Object.entries(auth)) {
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'type' || typeof value !== 'string' || value.length < MIN_SECRET_CHARS || seen.has(value)) continue
      seen.add(value)
      needles.push({ label: `auth_passthrough:${provider}.${field}`, value })
    }
  }
  return needles
}
