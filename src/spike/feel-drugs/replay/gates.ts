/** Arms and the per-attempt gate matrix. A failed gate excludes the attempt; it is never an outcome. */
import { systemTexts } from '../../../runner/isolation'
import type { RecordedRequest } from '../../../runner/scripted-provider'
import type { FixtureSpec } from './store'
import { requestedModel, toolNamesAnyWire, userMessageParts, userTextsAnyWire } from './wire'

// ── arms ───────────────────────────────────────────────────────────────────

export const REPLAY_MODELS = ['openai/gpt-6-luna', 'anthropic/claude-opus-5-5'] as const

export const ARM_NAMES = ['continue-a', 'continue-b', 'feel', 'feel-somewhere', 'drugs', 'drugs-caffeine', 'drugs-psilocybin', 'whichever', 'nudge-only'] as const
export type ArmName = (typeof ARM_NAMES)[number]

export const WHICHEVER = 'Use whichever metacogs tool fits this moment, then continue.'
export const NUDGE_ONLY = 'Use whichever tool fits this moment, then continue.'

export type ArmMessage = { kind: 'text'; text: string } | { kind: 'command'; name: 'feel' | 'drugs'; args: string[] }

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/** What an arm sends. `null` when the arm does not apply to this fixture (`feel-somewhere` with no phrase). */
export function armMessage(arm: ArmName, spec: Pick<FixtureSpec, 'somewhere'>): ArmMessage | null {
  switch (arm) {
    case 'continue-a':
    case 'continue-b':
      return { kind: 'text', text: 'Continue.' }
    case 'feel':
      return { kind: 'command', name: 'feel', args: [] }
    case 'feel-somewhere': {
      const args = words(spec.somewhere)
      return args.length > 0 ? { kind: 'command', name: 'feel', args } : null
    }
    case 'drugs':
      return { kind: 'command', name: 'drugs', args: [] }
    case 'drugs-caffeine':
      return { kind: 'command', name: 'drugs', args: ['caffeine'] }
    case 'drugs-psilocybin':
      return { kind: 'command', name: 'drugs', args: ['psilocybin'] }
    case 'whichever':
      return { kind: 'text', text: WHICHEVER }
    case 'nudge-only':
      return { kind: 'text', text: NUDGE_ONLY }
  }
}

/** The `opencode run` argv after the binary. Command arguments are separate argv words so they arrive raw. */
export function runArgs(model: string, sessionId: string, message: ArmMessage): string[] {
  const base = ['run', '--format', 'json', '--model', model, '-s', sessionId]
  return message.kind === 'text' ? [...base, message.text] : [...base, '--command', message.name, ...message.args]
}

// ── gates ──────────────────────────────────────────────────────────────────

export const EXCLUSION_REASONS = ['host_version', 'no_main_request', 'tool_missing', 'model_mismatch', 'agent_mismatch', 'compaction', 'skill_not_delivered', 'args_mismatch', 'seed_history_missing', 'stack_injection', 'isolation_failed'] as const
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

export interface GateCheck {
  name: string
  passed: boolean
  /** Set on a failed check. */
  reason?: ExclusionReason
  /** Ids and counts only, never message text. */
  detail: string
}

export interface AssistantInfo {
  agent?: string
  providerID?: string
  modelID?: string
}

export interface GateInput {
  arm: ArmName
  message: ArmMessage
  /** `provider/model`. */
  model: string
  expectedHostVersion: string
  hostVersion: string
  expectedAgent?: string
  /** The packed plugin's `plugin/skills` directory. When set, the delivered base directory must be exactly `<it>/<name>`. */
  skillsDir?: string
  requests: readonly RecordedRequest[]
  /** The fixture's user turns, in order. */
  seedUserTurns: readonly string[]
  /** Assistant messages the host recorded after the seed; `null` when the session export was unavailable. */
  assistants: readonly AssistantInfo[] | null
  /** Part types in the session export; `null` when unavailable. */
  partTypes: readonly string[] | null
  /** `type` of every event on stdout. */
  eventTypes: readonly string[]
}

export interface GateResult {
  passed: boolean
  checks: GateCheck[]
  reasons: ExclusionReason[]
  mainRequests: number
  /** Command arms: the argument text that reached the model (`''` for none). `null` when the skill text was not found. */
  receivedArgs: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bodyOf = (r: RecordedRequest): Record<string, unknown> => (isRecord(r.body) ? r.body : {})
/** magic-context puts a `§N§ ` tag, and after a long enough gap a `<!-- +44w 2d -->` marker, ahead of the text. */
const stripTag = (s: string): string => s.replace(/^§\d+§ (?:<!--[^\n]*?-->\n)?/, '')
const SUMMARIZER = /you are a context summarization agent|summarize what was done in this conversation/i

/** The main request is the one that offers both `task` and `feel`; title and subagent requests are not gated on the model. */
export function mainRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => {
    const names = toolNamesAnyWire(bodyOf(r))
    return names.includes('task') && names.includes('feel')
  })
}

export interface SkillDelivery {
  command: string
  baseDir: string
  receivedArgs: string
}

const BASE_LINE = /^Base directory for this skill: (.*)$/m
const RELATIVE_MARKER = 'relative to this base directory.'

/** Reads the typed command's skill text: header, base-directory line, then the argument text after the host's relative-path note. */
export function parseSkillDelivery(firstPart: string): SkillDelivery | null {
  const text = stripTag(firstPart)
  const header = /^# (feel|drugs)\s*\n/.exec(text)
  const base = BASE_LINE.exec(text)
  if (!header || !base) return null
  const after = text.slice(base.index + base[0].length)
  const marker = after.indexOf(RELATIVE_MARKER)
  const args = marker >= 0 ? after.slice(marker + RELATIVE_MARKER.length) : after.split('\n').slice(2).join('\n')
  return { command: header[1]!, baseDir: base[1]!.trim(), receivedArgs: args.trim() }
}

const check = (name: string, passed: boolean, detail: string, reason: ExclusionReason): GateCheck => (passed ? { name, passed, detail } : { name, passed, reason, detail })

/** Fixture user turns each appear, in order, inside the replayed user messages (plugins add tags and reminders around them). */
function seedPresent(body: Record<string, unknown>, turns: readonly string[]): boolean {
  let next = 0
  for (const text of userTextsAnyWire(body)) {
    if (next < turns.length && text.includes(turns[next]!)) next += 1
  }
  return next === turns.length
}

export function evaluateGates(input: GateInput): GateResult {
  const checks: GateCheck[] = []
  const { requests, model } = input
  const expectedModelId = model.slice(model.indexOf('/') + 1)

  checks.push(check('host_version', input.hostVersion === input.expectedHostVersion, `reported ${input.hostVersion}, expected ${input.expectedHostVersion}`, 'host_version'))

  const mains = mainRequests(requests)
  const withTools = requests.filter((r) => toolNamesAnyWire(bodyOf(r)).length > 0)
  if (mains.length === 0) {
    checks.push(withTools.length === 0 ? check('main_request', false, 'no request offered any tool', 'no_main_request') : check('tools_offered', false, 'no request offered both task and feel', 'tool_missing'))
  } else {
    checks.push({ name: 'main_request', passed: true, detail: `${mains.length} of ${requests.length} requests` })
    const missing = ['feel', 'drugs'].filter((tool) => mains.some((r) => !toolNamesAnyWire(bodyOf(r)).includes(tool)))
    checks.push(check('tools_offered', missing.length === 0, missing.length ? `not offered on every main request: ${missing.join(', ')}` : 'task, feel and drugs offered', 'tool_missing'))
  }

  const expectedAgent = input.expectedAgent ?? 'orchestrator'
  if (input.assistants === null || input.assistants.length === 0) {
    checks.push(check('agent', false, 'the session export has no assistant message after the seed', 'agent_mismatch'))
  } else {
    const wrongAgent = input.assistants.filter((a) => a.agent !== expectedAgent).length
    checks.push(check('agent', wrongAgent === 0, wrongAgent ? `${wrongAgent} of ${input.assistants.length} assistant messages ran another agent` : `${input.assistants.length} assistant messages on ${expectedAgent}`, 'agent_mismatch'))
  }

  const summarizer = requests.some((r) => systemTexts(bodyOf(r)).some((t) => SUMMARIZER.test(t)))
  const compactedPart = input.partTypes?.includes('compaction') === true
  const compactionEvent = input.eventTypes.includes('compaction')
  checks.push(check('compaction', !summarizer && !compactedPart && !compactionEvent, `summarizer request ${summarizer}, compaction part ${compactedPart}, compaction event ${compactionEvent}`, 'compaction'))

  if (mains.length > 0) {
    const bad = mains.filter((r) => requestedModel(bodyOf(r)) !== expectedModelId || r.returnedModel !== expectedModelId)
    const hostWrong = (input.assistants ?? []).filter((a) => `${a.providerID}/${a.modelID}` !== model).length
    checks.push(check('model', bad.length === 0 && hostWrong === 0, `${bad.length} of ${mains.length} main requests and ${hostWrong} host messages differ from ${model}`, 'model_mismatch'))

    const first = mains[0]!
    checks.push(check('seed_history', seedPresent(bodyOf(first), input.seedUserTurns), `${input.seedUserTurns.length} fixture user turns`, 'seed_history_missing'))

    const lastParts = userMessageParts(bodyOf(mains.at(-1)!)).at(-1) ?? []
    const council = lastParts.some((p) => p.includes('## Council Mode'))
    checks.push(check('stack_injection', !council, `council block ${council ? 'present' : 'absent'}`, 'stack_injection'))
  }

  let receivedArgs: string | null = null
  if (input.message.kind === 'command' && mains.length > 0) {
    const parts = userMessageParts(bodyOf(mains[0]!)).at(-1) ?? []
    const delivery = parts[0] === undefined ? null : parseSkillDelivery(parts[0])
    const name = input.message.name
    const dirOk = delivery !== null && delivery.baseDir.endsWith(`/plugin/skills/${name}`) && (input.skillsDir === undefined || delivery.baseDir === `${input.skillsDir}/${name}`)
    const delivered = delivery !== null && delivery.command === name && dirOk
    checks.push(check('skill_delivery', delivered, delivered ? `${name} skill text from the plugin directory` : delivery === null ? `the last user message does not open with the ${name} skill text` : `the delivered skill is ${delivery.command} from another directory or another command`, 'skill_not_delivered'))
    if (delivered) {
      receivedArgs = delivery.receivedArgs
      const want = input.message.args.join(' ')
      checks.push(check('args', receivedArgs === want, `received ${receivedArgs.length} characters, sent ${want.length}`, 'args_mismatch'))
    }
  }

  const failed = checks.filter((c) => !c.passed)
  return { passed: failed.length === 0, checks, reasons: [...new Set(failed.flatMap((c) => (c.reason ? [c.reason] : [])))], mainRequests: mains.length, receivedArgs }
}
