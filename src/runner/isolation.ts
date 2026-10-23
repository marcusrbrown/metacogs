/**
 * Isolation as a pass criterion (plan KTD "Isolation is a pass criterion, not a label").
 *
 * A run counts toward RED/GREEN only if every check here passes. Failing runs
 * are `non_isolated`: excluded from the denominator and reported.
 *
 * Instruments, in order of authority:
 * 1. what the model was actually sent (the stub / recording proxy request bodies);
 * 2. `opencode debug config` (effective merged config);
 * 3. planted decoys (sentinel AGENTS.md, auth.json canary, outside-workspace file)
 *    that must not be quotable from stdout, stderr, or any request body;
 * 4. the child env itself (no credentials, no stray `METACOGS_*`, one config channel).
 */
import type { RecordedRequest } from './scripted-provider'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── instruments over recorded requests (promoted from the spike) ───────────

function requestBodies(requests: readonly RecordedRequest[]): Record<string, unknown>[] {
  return requests.map((r) => (isRecord(r.body) ? r.body : {}))
}

/** Plain text of a message `content`: a string, or an array of `{text}` blocks (Anthropic `system`, Responses `input_text`). */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('')
  return ''
}

/**
 * System-level text of one request body, one entry per system message, in order. Three wire formats reach the
 * recording proxy: chat completions (`messages[role=system]`, the free gateways), Anthropic messages (top-level
 * `system`), and OpenAI Responses (`instructions`, plus `input[]` items with role `system`/`developer`), the last two
 * only through the CLIProxyAPI gateway.
 */
export function systemTexts(body: Record<string, unknown>): string[] {
  const parts: string[] = []
  const isSystem = (m: unknown): m is Record<string, unknown> => isRecord(m) && (m.role === 'system' || m.role === 'developer')
  for (const key of ['messages', 'input'] as const) {
    const items = body[key]
    if (Array.isArray(items)) for (const m of items) if (isSystem(m)) parts.push(plainText(m.content))
  }
  const system = body.system
  if (typeof system === 'string') parts.push(system)
  else if (Array.isArray(system)) parts.push(...system.map((b) => plainText([b])))
  if (typeof body.instructions === 'string') parts.push(body.instructions)
  return parts
}

/** The fixed system prompt reached the provider intact: some system message, or all of them joined, starts with it. */
export function systemPromptSent(body: Record<string, unknown>, expected: string): boolean {
  const texts = systemTexts(body)
  return texts.some((t) => t.startsWith(expected)) || texts.join('\n').startsWith(expected) || texts.join('').startsWith(expected)
}

/** Concatenated system-prompt text actually sent to the model (all requests). */
export function systemPromptText(requests: readonly RecordedRequest[]): string {
  const parts: string[] = []
  for (const body of requestBodies(requests)) {
    for (const text of systemTexts(body)) parts.push(JSON.stringify(text))
  }
  return parts.join('\n')
}

/** Everything the model saw or produced: all request bodies, serialized. */
export function modelSeenText(requests: readonly RecordedRequest[]): string {
  return requestBodies(requests)
    .map((b) => JSON.stringify(b))
    .join('\n')
}

/**
 * `<available_skills>` names from the system prompt of the tool-capable
 * request. In 1.19.4 the list lives in the system prompt, not the skill-tool
 * description. Returns names in prompt order; `null` when the block is absent.
 * Only `<name>` tags inside the block count.
 */
export function availableSkillsFromRequests(requests: readonly RecordedRequest[]): string[] | null {
  const main = requests.find((r) => r.hasTools)
  if (!main) return null
  const text = systemPromptText([main])
  const open = text.indexOf('<available_skills>')
  if (open === -1) return null
  const close = text.indexOf('</available_skills>', open)
  const block = text.slice(open, close === -1 ? undefined : close)
  return [...block.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '')
}

/** Names of tools offered to the model on the tool-capable request. */
export function offeredTools(requests: readonly RecordedRequest[]): string[] {
  const main = requests.find((r) => r.hasTools)
  const body = isRecord(main?.body) ? main.body : {}
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools
    .map((t) => (isRecord(t) && isRecord(t.function) ? String(t.function.name) : ''))
    .filter(Boolean)
}

export function skillToolDescription(requests: readonly RecordedRequest[]): string | undefined {
  const main = requests.find((r) => r.hasTools)
  const body = isRecord(main?.body) ? main.body : {}
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const t of tools) {
    if (isRecord(t) && isRecord(t.function) && t.function.name === 'skill') {
      return String(t.function.description)
    }
  }
  return undefined
}

// ── debug config ───────────────────────────────────────────────────────────

/**
 * Keys `opencode debug config` adds on its own in 1.19.4 (README: "empty host
 * defaults"). Each must hold its empty/default value; anything else means a
 * file outside the generated config contributed.
 */
const HOST_DEFAULTS: Record<string, (value: unknown) => boolean> = {
  agent: (v) => isRecord(v) && Object.keys(v).length === 0,
  mode: (v) => isRecord(v) && Object.keys(v).length === 0,
  command: (v) => isRecord(v) && Object.keys(v).length === 0,
  plugin: (v) => Array.isArray(v) && v.length === 0,
  username: (v) => typeof v === 'string',
  compaction: (v) => isRecord(v) && Object.keys(v).length === 1 && v.prune === false,
}

const MASKED = '***'

/** `effective` equals `generated`, allowing the host's `***` mask where the generated value was a secret-ish string. */
function equalsMasked(effective: unknown, generated: unknown): boolean {
  if (effective === MASKED && typeof generated === 'string') return true
  if (Array.isArray(generated)) {
    return Array.isArray(effective) && effective.length === generated.length && generated.every((g, i) => equalsMasked(effective[i], g))
  }
  if (isRecord(generated)) {
    if (!isRecord(effective)) return false
    const keys = new Set([...Object.keys(effective), ...Object.keys(generated)])
    return [...keys].every((k) => k in effective && k in generated && equalsMasked(effective[k], generated[k]))
  }
  return effective === generated
}

export interface DebugConfigVerdict {
  passed: boolean
  detail: string
}

/** The effective config is the generated config plus empty host defaults, nothing else. */
export function checkDebugConfig(effective: unknown, generated: Record<string, unknown>): DebugConfigVerdict {
  if (!isRecord(effective)) return { passed: false, detail: '`debug config` did not return a JSON object' }
  const problems: string[] = []
  for (const key of Object.keys(effective)) {
    if (key in generated) {
      if (!equalsMasked(effective[key], generated[key])) problems.push(`${key}: differs from generated config`)
    } else if (HOST_DEFAULTS[key]) {
      if (!HOST_DEFAULTS[key](effective[key])) problems.push(`${key}: non-default value from outside the generated config`)
    } else {
      problems.push(`${key}: not in generated config`)
    }
  }
  for (const key of Object.keys(generated)) {
    if (!(key in effective)) problems.push(`${key}: generated key missing from effective config`)
  }
  return problems.length
    ? { passed: false, detail: problems.join('; ') }
    : { passed: true, detail: 'effective config equals generated config plus empty host defaults' }
}

// ── the full check ─────────────────────────────────────────────────────────

export type IsolationCheckName =
  | 'available_skills_exact'
  | 'debug_config_generated_only'
  | 'decoys_not_quotable'
  | 'child_env_clean'
  | 'single_config_channel'

export interface IsolationCheck {
  name: IsolationCheckName
  passed: boolean
  /** Never contains decoy values, only their labels. */
  detail: string
}

export interface IsolationEvidence {
  passed: boolean
  checks: IsolationCheck[]
  expectedSkills: string[]
  /** `null`: the system prompt carried no `<available_skills>` block (or no request was seen). */
  availableSkills: string[] | null
  /** A tool-capable request was recorded, so the model-visible list could be read at all. */
  skillListObserved: boolean
}

export interface IsolationInput {
  expectedSkills: readonly string[]
  requests: readonly RecordedRequest[]
  stdout: string
  stderr: string
  /** Output of `opencode debug config`; `undefined` when it was not run or did not parse. */
  debugConfigJson: unknown
  generatedConfig: Record<string, unknown>
  childEnv: Readonly<Record<string, string>>
  /** label → value; none may appear in stdout, stderr, or any request body. */
  decoys: Readonly<Record<string, string>>
}

const CREDENTIAL_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export function checkIsolation(input: IsolationInput): IsolationEvidence {
  const checks: IsolationCheck[] = []

  // 1. The model was offered exactly the expected skills (exact set compare, built-in hidden).
  const hasToolRequest = input.requests.some((r) => r.hasTools)
  const observed = availableSkillsFromRequests(input.requests)
  const names = observed ?? []
  const expected = [...input.expectedSkills].sort()
  const actual = [...names].sort()
  const exact = hasToolRequest && expected.length === actual.length && expected.every((n, i) => n === actual[i])
  checks.push({
    name: 'available_skills_exact',
    passed: exact,
    detail: hasToolRequest
      ? `expected [${expected.join(', ')}], model saw [${actual.join(', ')}]`
      : 'no tool-capable request was observed; the skill list cannot be verified',
  })

  // 2. Effective config is the generated config.
  const dbg = input.debugConfigJson === undefined
    ? { passed: false, detail: 'debug config output unavailable' }
    : checkDebugConfig(input.debugConfigJson, input.generatedConfig)
  checks.push({ name: 'debug_config_generated_only', passed: dbg.passed, detail: dbg.detail })

  // 3. Decoys are not quotable.
  const haystack = `${input.stdout}\n${input.stderr}\n${modelSeenText(input.requests)}`
  const leaked = Object.entries(input.decoys)
    .filter(([, value]) => value.length > 0 && haystack.includes(value))
    .map(([label]) => label)
  checks.push({
    name: 'decoys_not_quotable',
    passed: leaked.length === 0,
    detail: leaked.length ? `found in transcript: ${leaked.join(', ')}` : 'no decoy appears in stdout, stderr, or request bodies',
  })

  // 4. Child env: no credentials, only the one allowed METACOGS_* variable.
  const envProblems: string[] = []
  for (const key of Object.keys(input.childEnv)) {
    if (CREDENTIAL_KEY.test(key)) envProblems.push(`credential-shaped variable ${key}`)
    if (key.startsWith('METACOGS_') && key !== 'METACOGS_RECORDS_DIR') envProblems.push(`unexpected ${key}`)
  }
  checks.push({
    name: 'child_env_clean',
    passed: envProblems.length === 0,
    detail: envProblems.length ? envProblems.join('; ') : 'allowlisted env only',
  })

  // 5. One config channel.
  const channelOk = Boolean(input.childEnv.OPENCODE_CONFIG) && input.childEnv.OPENCODE_CONFIG_CONTENT === undefined
  checks.push({
    name: 'single_config_channel',
    passed: channelOk,
    detail: channelOk ? 'OPENCODE_CONFIG only' : 'OPENCODE_CONFIG missing or OPENCODE_CONFIG_CONTENT set',
  })

  return {
    passed: checks.every((c) => c.passed),
    checks,
    expectedSkills: expected,
    availableSkills: observed,
    skillListObserved: hasToolRequest,
  }
}

export function failedChecks(evidence: IsolationEvidence): IsolationCheck[] {
  return evidence.checks.filter((c) => !c.passed)
}
