/**
 * Deterministic checks and host-outcome classification. Everything here is a
 * pure function of the event stream, the records directory, and the run's
 * expectations; model-judged criteria live in judge.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

import { EXECUTION_MODES } from '../record/contract'
import { recordFilename } from '../record/canonical'
import { validateRecord } from '../record/validate'
import { type EventSummary, isSkillContentLoad, skillCallName, type ToolUse } from './events'
import type { SpawnResult } from './opencode'
import type { Condition, FixtureKind } from './workspace'

export interface RecordFile {
  /** Path relative to the records dir. */
  name: string
  content: string
}

/** Every file under the records dir (the helper writes `<method>-<hash>.json`; anything else is stray). */
export function listRecordFiles(dir: string): RecordFile[] {
  if (!existsSync(dir)) return []
  const out: RecordFile[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel))) {
      const next = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, next)).isDirectory()) walk(next)
      else out.push({ name: next, content: readFileSync(join(dir, next), 'utf8') })
    }
  }
  walk('')
  return out
}

// ── fire evidence ──────────────────────────────────────────────────────────

const UNAVAILABLE_SKILL_TOOL = /unavailable tool\s*['"`]?skill['"`]?/i
const HELPER_PATH = /scripts\/record\.mjs/

/** A denied skill call: the `skill` tool was removed, so the host reports an `invalid` pseudo-tool. */
export function isDeniedSkillCall(call: ToolUse): boolean {
  if (call.tool !== 'invalid') return false
  const haystack = `${call.output ?? ''}\n${call.error ?? ''}\n${JSON.stringify(call.input ?? '')}`
  return UNAVAILABLE_SKILL_TOOL.test(haystack)
}

export function isHelperInvocation(call: ToolUse): boolean {
  if (call.tool !== 'bash') return false
  const command = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>).command : undefined
  return typeof command === 'string' && HELPER_PATH.test(command)
}

// ── direct SKILL.md reads ──────────────────────────────────────────────────

/**
 * A `read` of the skill file (any workspace path ending in `skills/<method>/SKILL.md`, which covers
 * `.agents/skills/<method>/SKILL.md`). Relative and `..` paths are normalized first.
 */
export function isSkillFileRead(call: ToolUse, method: string): boolean {
  if (call.tool !== 'read') return false
  const path = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>).filePath : undefined
  if (typeof path !== 'string') return false
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  const suffix = `skills/${method}/SKILL.md`
  return normalized === suffix || normalized.endsWith(`/${suffix}`)
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** SKILL.md without its YAML frontmatter. */
export function skillBodyOf(skillText: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(skillText)
  return collapse(match ? skillText.slice(match[0].length) : skillText)
}

/** The `read` tool prefixes each line with `N: `; strip those before comparing. */
function readContent(output: string): string {
  return output
    .split('\n')
    .map((line) => line.replace(/^\d+: ?/, ''))
    .join('\n')
}

/** A completed read of the skill file whose output carries the skill body (not a truncated or empty read). */
export function isSkillBodyRead(call: ToolUse, method: string, skillText: string | undefined): boolean {
  if (skillText === undefined || !isSkillFileRead(call, method) || call.status !== 'completed' || !call.output) return false
  const body = skillBodyOf(skillText)
  return body.length > 0 && collapse(readContent(call.output)).includes(body)
}

export type FireBasis = 'skill_tool' | 'direct_read'

export interface FireEvidence {
  /** `skill` tool call naming the method (any status). */
  skillCalled: boolean
  /** Skill content reached the model through a completed skill-tool call. */
  skillLoaded: boolean
  /** `read` tool call on the skill file (any status, any output): a fire when the fixture is a negative. */
  skillFileRead: boolean
  /** The skill body reached the model through a direct read. Needs the skill text; absent text never credits. */
  skillBodyRead: boolean
  /** How the method fired on a positive fixture; `null` when the skill text never reached the model. The skill tool wins when both happened. */
  fireBasis: FireBasis | null
  /** `invalid` tool_use for the unavailable `skill` tool: an attempted fire, not silence. */
  deniedSkillCall: boolean
  helperInvoked: boolean
  recordFiles: number
}

export function fireEvidence(method: string, events: EventSummary, records: readonly RecordFile[], skillText?: string): FireEvidence {
  const skillLoaded = events.skillCalls.some((c) => isSkillContentLoad(c, method))
  const skillBodyRead = events.toolUses.some((c) => isSkillBodyRead(c, method, skillText))
  return {
    skillCalled: events.skillCalls.some((c) => skillCallName(c) === method),
    skillLoaded,
    skillFileRead: events.toolUses.some((c) => isSkillFileRead(c, method)),
    skillBodyRead,
    fireBasis: skillLoaded ? 'skill_tool' : skillBodyRead ? 'direct_read' : null,
    deniedSkillCall: events.toolUses.some(isDeniedSkillCall),
    helperInvoked: events.toolUses.some(isHelperInvocation),
    recordFiles: records.length,
  }
}

export const hasFired = (f: FireEvidence): boolean => f.skillCalled || f.skillFileRead || f.deniedSkillCall || f.helperInvoked || f.recordFiles > 0

// ── the checks ─────────────────────────────────────────────────────────────

export type CheckCode =
  | 'unrecognized_events'
  | 'false_fire_skill_call'
  | 'false_fire_denied_skill_call'
  | 'false_fire_direct_read'
  | 'false_fire_helper'
  | 'false_fire_record'
  | 'skill_not_loaded'
  | 'record_without_load'
  | 'record_missing'
  | 'record_unexpected'
  | 'record_invalid'
  | 'record_filename_mismatch'
  | 'record_method_mismatch'
  | 'execution_mode_unexpected'
  | 'helper_not_invoked'

export interface CheckFailure {
  code: CheckCode
  message: string
}

export interface CheckInput {
  method: string
  condition: Condition
  kind: FixtureKind
  events: EventSummary
  records: readonly RecordFile[]
  /** Accepted `execution_mode` values on skill-condition records. Default: every mode but `unrecorded`. */
  expectedExecutionModes?: readonly string[]
  /** The installed SKILL.md. Without it a direct read cannot be verified and never credits a fire. */
  skillText?: string
}

export interface CheckResult {
  ok: boolean
  failures: CheckFailure[]
  fire: FireEvidence
  /** Valid records found (skill condition on positive fixtures). */
  validRecords: string[]
}

export function runChecks(input: CheckInput): CheckResult {
  const { method, condition, kind, events, records } = input
  const failures: CheckFailure[] = []
  const fire = fireEvidence(method, events, records, input.skillText)
  const validRecords: string[] = []
  const fail = (code: CheckCode, message: string) => failures.push({ code, message })

  // Fail closed: a stream we cannot fully read cannot prove silence or a fire.
  if (events.unrecognized.length) fail('unrecognized_events', `${events.unrecognized.length} unrecognized event(s): ${events.unrecognized.slice(0, 3).join(' | ')}`)

  const expectFire = condition === 'skill' && kind !== 'negative'

  if (!expectFire) {
    // Negatives (any condition) and baselines: no skill, no records.
    // Attempted fires and helper calls are failures only where a fire is meaningful: a denied skill
    // call on a negative, a helper call when the skill is installed. In a baseline the helper does not
    // exist, and a denial message quotes the `bash` allowlist back to the model, so a probe such as
    // `node scripts/record.mjs` is noise (kept as evidence). The baseline pass criterion is rubric-only.
    const strictSilence = kind === 'negative'
    if (fire.skillCalled && (strictSilence || condition === 'skill')) fail('false_fire_skill_call', `skill tool called for ${method}`)
    // Negatives stay strict: opening the skill file at all is a fire, whatever the read returned.
    if (fire.skillFileRead && strictSilence) fail('false_fire_direct_read', `SKILL.md for ${method} was read`)
    if (fire.deniedSkillCall && strictSilence) fail('false_fire_denied_skill_call', 'model called the unavailable skill tool (attempted fire)')
    if (fire.helperInvoked && condition === 'skill') fail('false_fire_helper', 'record helper invoked')
    if (fire.recordFiles > 0) fail('false_fire_record', `${fire.recordFiles} file(s) in the records dir: ${records.map((r) => r.name).join(', ')}`)
    return { ok: failures.length === 0, failures, fire, validRecords }
  }

  // Skill condition on a positive fixture: the method must fire and leave a valid record.
  // Fired = the skill tool loaded it, or the agent read the installed SKILL.md and got the body.
  if (fire.fireBasis === null) {
    fail('skill_not_loaded', `no completed skill call and no complete read of SKILL.md loaded ${method}`)
    // A record with no skill text ever seen means the model guessed the contract; it does not count as a fire.
    if (records.length > 0) fail('record_without_load', 'a record exists but the skill text never reached the model')
  }
  if (!fire.helperInvoked) fail('helper_not_invoked', 'no bash call invoked scripts/record.mjs')
  if (records.length === 0) fail('record_missing', 'records dir is empty')

  const allowedModes = input.expectedExecutionModes ?? EXECUTION_MODES.filter((m) => m !== 'unrecorded')
  for (const file of records) {
    if (!file.name.endsWith('.json') || file.name.includes('/')) {
      fail('record_unexpected', `unexpected file in records dir: ${file.name}`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch {
      fail('record_invalid', `${file.name}: not valid JSON`)
      continue
    }
    const result = validateRecord(parsed, { methods: [method] })
    if (!result.ok) {
      fail('record_invalid', `${file.name}: ${result.errors.map((e) => `${e.field} ${e.message}`).join('; ')}`)
      continue
    }
    const { record } = result
    if (record.method !== method) fail('record_method_mismatch', `${file.name}: method ${record.method}, expected ${method}`)
    if (file.name !== recordFilename(record)) fail('record_filename_mismatch', `${file.name}: name does not match the record's canonical hash`)
    if (!allowedModes.includes(record.execution_mode)) {
      fail('execution_mode_unexpected', `${file.name}: execution_mode ${record.execution_mode}, expected one of ${allowedModes.join(', ')}`)
    }
    validRecords.push(file.name)
  }
  return { ok: failures.length === 0, failures, fire, validRecords }
}

// ── budget ─────────────────────────────────────────────────────────────────

export interface BudgetBreach {
  what: 'tool_calls' | 'tokens'
  limit: number
  actual: number
}

export function checkBudget(events: EventSummary, budget: { max_tool_calls: number; max_total_tokens: number }): BudgetBreach | null {
  if (events.toolUses.length > budget.max_tool_calls) {
    return { what: 'tool_calls', limit: budget.max_tool_calls, actual: events.toolUses.length }
  }
  const tokens = events.usage.input + events.usage.output + events.usage.reasoning
  if (tokens > budget.max_total_tokens) return { what: 'tokens', limit: budget.max_total_tokens, actual: tokens }
  return null
}

// ── host outcome ───────────────────────────────────────────────────────────

export type HostOutcome = 'completed' | 'timeout' | 'interrupted' | 'infra_error' | 'host_crash'

/**
 * `infra_error` is only a provider/host outage *before skill content loads*.
 * A non-zero exit once the skill's content reached the model is a FAIL
 * (`host_crash`); a timeout is a FAIL regardless.
 */
export function classifyHostOutcome(
  spawn: Pick<SpawnResult, 'exitCode' | 'timedOut' | 'aborted'>,
  events: EventSummary,
  method: string,
  skillText?: string,
): HostOutcome {
  if (spawn.aborted) return 'interrupted'
  if (spawn.timedOut) return 'timeout'
  if (spawn.exitCode !== 0) {
    const loaded = events.skillCalls.some((c) => isSkillContentLoad(c, method)) || events.toolUses.some((c) => isSkillBodyRead(c, method, skillText))
    return loaded ? 'host_crash' : 'infra_error'
  }
  return 'completed'
}
