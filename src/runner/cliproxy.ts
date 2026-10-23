/**
 * Opt-in CLIProxyAPI auth for isolated live runs (`--auth-cliproxy <key-name>`).
 *
 * The owner provisioned a per-repo API key on the CLIProxyAPI gateway (OpenAI-compatible `/v1`, providers
 * `openai` and `anthropic`). The runner never calls the management API and never reads the infra
 * repository's `.env`. At spawn time it shells out to the infra CLI (`infra cliproxy keys list --json`,
 * run from the infra checkout so the CLI finds its own management credentials), parses stdout in-process,
 * picks the one key whose value starts with the prefix the setup wizard derives from the key name, and
 * writes it into the run's throwaway `auth.json` as `type: api` entries for `openai` and `anthropic`.
 *
 * Rules this module keeps:
 * - The command's raw output is parsed in memory and dropped. Only the selected key survives. Errors say
 *   what failed, never what was printed: stderr is scrubbed of `sk-` tokens before it is quoted, stdout never is.
 * - The key is never logged, returned in an error, or written to a manifest. Manifests carry the key *name*.
 * - `cliproxyNeedles` feeds the credential-leak scan: the key, its distinctive prefix, and the management
 *   key when the runner's own environment happens to hold one (the infra CLI usually reads it from its own
 *   `.env`, which this module does not touch, so that needle is best-effort).
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PassthroughAuth } from './auth'
import type { Needle } from './manifest'

/** The wizard's provider list for the OpenCode harness (`setup-core/templates.ts`). */
export const CLIPROXY_PROVIDERS = ['openai', 'anthropic'] as const
export type CliproxyProvider = (typeof CLIPROXY_PROVIDERS)[number]

/** `<url>/v1`, as in the wizard's generated `OPENCODE_CONFIG`. */
export const CLIPROXY_UPSTREAM = 'https://cliproxy.fro.bot/v1'

export class CliproxyAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliproxyAuthError'
  }
}

/**
 * Mirrors `buildApiKeyValue` in the infra CLI (`agent/setup-core/prompts.ts`): the slug is the key name
 * lowercased, split on non-alphanumerics, joined with `-` and cut to 24 characters; the key is
 * `sk-<slug>-<random>`. `fro-bot-marcusrbrown-metacogs` therefore yields `sk-fro-bot-marcusrbrown-met-`.
 */
export function keyPrefixFor(keyName: string): string {
  const slug = (keyName.trim().toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-').slice(0, 24)
  return `sk-${slug || 'cliproxy'}-`
}

/** `--auth-cliproxy <name>` or `METACOGS_AUTH_CLIPROXY`; the flag wins. Empty means off. */
export function parseAuthCliproxy(flag: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (flag ?? env.METACOGS_AUTH_CLIPROXY)?.trim()
  if (!raw) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) {
    throw new CliproxyAuthError('--auth-cliproxy takes a key name such as "fro-bot-marcusrbrown-metacogs" (letters, digits, ".", "_", "-")')
  }
  return raw
}

/** Parses the CLI's `--json` output: a JSON array of strings. Never echoes content. */
export function parseKeyList(stdout: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new CliproxyAuthError('the infra CLI did not print a JSON array (is --json supported by this version?)')
  }
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
    throw new CliproxyAuthError('the infra CLI printed JSON, but not an array of strings')
  }
  return raw as string[]
}

/** Exactly one key must start with the name's prefix. Counts are reported, values never. */
export function selectKey(keys: readonly string[], keyName: string): string {
  const prefix = keyPrefixFor(keyName)
  const matches = keys.filter((k) => k.startsWith(prefix) && k.length > prefix.length)
  if (matches.length === 0) throw new CliproxyAuthError(`no CLIProxyAPI key starts with "${prefix}" (${keys.length} keys listed)`)
  if (matches.length > 1) throw new CliproxyAuthError(`${matches.length} CLIProxyAPI keys start with "${prefix}"; refusing to guess`)
  return matches[0]!
}

export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export interface CliproxyDeps {
  /** Runs the command; the default is `spawnSync` with the runner's own env (outside any child sandbox). */
  exec: (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => ExecResult
  env: Record<string, string | undefined>
  home: string
}

const defaultDeps = (): CliproxyDeps => ({
  exec: (command, args, options) => {
    const r = spawnSync(command, [...args], { cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
  },
  env: process.env,
  home: homedir(),
})

/** Where the infra CLI is run from: `METACOGS_INFRA_DIR`, else `~/src/github.com/marcusrbrown/infra`. */
export function infraDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const override = env.METACOGS_INFRA_DIR?.trim()
  return override || join(home, 'src', 'github.com', 'marcusrbrown', 'infra')
}

const scrub = (text: string): string => text.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[scrubbed]').replace(/\s+/g, ' ').trim().slice(0, 200)

/**
 * Fetches the named key via `infra cliproxy keys list --json`. The returned string is the only secret that
 * survives the call; the listing (which holds every key on the gateway) is dropped.
 */
export function fetchCliproxyKey(keyName: string, overrides: Partial<CliproxyDeps> = {}): string {
  const deps = { ...defaultDeps(), ...overrides }
  const result = deps.exec('infra', ['cliproxy', 'keys', 'list', '--json'], { cwd: infraDir(deps.env, deps.home), timeoutMs: 60_000 })
  if (result.error) throw new CliproxyAuthError(`could not run the infra CLI: ${scrub(String(result.error.message))}`)
  if (result.status !== 0) throw new CliproxyAuthError(`infra cliproxy keys list failed (exit ${result.status ?? 'null'}): ${scrub(result.stderr)}`)
  return selectKey(parseKeyList(result.stdout), keyName)
}

/**
 * The wizard's `OPENCODE_CONFIG` provider blocks (`{provider: {openai: {options: {baseURL}}, anthropic: {...}}}`),
 * with `baseURL` pointing at the local recording proxy that forwards to `CLIPROXY_UPSTREAM`.
 */
export function cliproxyProviderConfig(baseURL: string): Record<string, unknown> {
  return Object.fromEntries(CLIPROXY_PROVIDERS.map((p) => [p, { options: { baseURL } }]))
}

/** `auth.json` entries for the isolated data dir: `type: api` for each provider, nothing else. */
export function cliproxyAuth(key: string): PassthroughAuth {
  return Object.fromEntries(CLIPROXY_PROVIDERS.map((p) => [p, { type: 'api', key }]))
}

/** Management key from the runner's own env, when one is exported. */
const MANAGEMENT_ENV = 'CLIPROXY_MANAGEMENT_KEY'

/** Everything the leak scan must never find: the key, its prefix, and the management key if the runner holds it. */
export function cliproxyNeedles(key: string, keyName: string, env: Record<string, string | undefined> = process.env): Needle[] {
  const needles: Needle[] = [
    { label: 'auth_cliproxy:key', value: key },
    { label: 'auth_cliproxy:key_prefix', value: keyPrefixFor(keyName) },
  ]
  const management = env[MANAGEMENT_ENV]
  if (management && management.length >= 8) needles.push({ label: 'auth_cliproxy:management_key', value: management })
  return needles
}

/** Agent and judge ids that only the CLIProxyAPI gateway serves. */
export const isCliproxyModel = (model: string): boolean => CLIPROXY_PROVIDERS.some((p) => model.startsWith(`${p}/`))

/**
 * The auth mode and the pinned ids must agree: `openai/*` and `anthropic/*` have no credential without
 * `--auth-cliproxy`, and in that mode the isolated `auth.json` holds nothing else (no Go or Zen entry).
 */
export function cliproxyModelMismatch(models: readonly string[], cliproxyOn: boolean): string | undefined {
  if (!cliproxyOn) {
    const needs = models.filter(isCliproxyModel)
    return needs.length ? `${needs.join(', ')} are served by the CLIProxyAPI gateway; pass --auth-cliproxy <key-name> (or METACOGS_AUTH_CLIPROXY)` : undefined
  }
  const foreign = models.filter((m) => !isCliproxyModel(m))
  return foreign.length ? `--auth-cliproxy authenticates only openai/* and anthropic/* models; the prereg pins ${foreign.join(', ')}` : undefined
}

export interface ResolvedCliproxy {
  keyName: string
  /** `auth.json` entries for the isolated data dir. Secret. */
  auth: PassthroughAuth
  /** Leak-scan needles. Secret. */
  needles: Needle[]
}

/** `undefined` when the mode is off. Throws `CliproxyAuthError` (no secret in the message) when it is on but unusable. */
export function resolveCliproxy(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  context: { live: boolean; passthroughFlag?: string | undefined },
  deps: Partial<CliproxyDeps> = {},
): ResolvedCliproxy | undefined {
  const keyName = parseAuthCliproxy(flag, env)
  if (!keyName) return undefined
  if (!context.live) throw new CliproxyAuthError('--auth-cliproxy needs --provider live')
  if (context.passthroughFlag !== undefined) throw new CliproxyAuthError('--auth-cliproxy and --auth-passthrough are mutually exclusive')
  const key = fetchCliproxyKey(keyName, { env, ...deps })
  return { keyName, auth: cliproxyAuth(key), needles: cliproxyNeedles(key, keyName, env) }
}
