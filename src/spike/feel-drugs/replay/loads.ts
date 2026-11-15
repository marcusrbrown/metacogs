/**
 * Which skills an attempt loaded, as the workflow fixtures count them. Systematic loads its skills through its own
 * `systematic_skill` tool and names them with a `systematic:` prefix; the host's `skill` tool loads the method skills bare.
 * A tool call is normalized to the `skill` shape the runner's detectors take, so a load means what it means in the eval
 * runner: a completed skill call that returned `<skill_content ...>`. Opening a method's `SKILL.md` directly is tracked
 * separately and never counts as a load.
 */
import { skillFileAccess } from '../../../runner/checks'
import { isSkillContentLoad, skillCallName, type ToolUse } from '../../../runner/events'

/** The workflow skills a fixture is seeded with. Loading one is never a method load. */
export const WORKFLOW_SKILLS = ['ce:plan', 'ce:review'] as const
export type WorkflowSkill = (typeof WORKFLOW_SKILLS)[number]

/** The two reasoning methods the workflow fixtures measure. */
export const METHODS = ['counterfactual', 'synthesis'] as const
export type Method = (typeof METHODS)[number]

const PLUGIN_PREFIX = 'systematic:'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The use as the detectors take it: `systematic_skill` becomes `skill`, and one leading `systematic:` leaves the skill name. Any other use is returned unchanged. */
export function normalizeToolUse(call: ToolUse): ToolUse {
  const tool = call.tool === 'systematic_skill' ? 'skill' : call.tool
  const input = tool === 'skill' && isRecord(call.input) && typeof call.input.name === 'string' && call.input.name.startsWith(PLUGIN_PREFIX) ? { ...call.input, name: call.input.name.slice(PLUGIN_PREFIX.length) } : call.input
  return tool === call.tool && input === call.input ? call : { ...call, tool, input }
}

const isMethod = (name: string): name is Method => (METHODS as readonly string[]).includes(name)
const isWorkflow = (name: string): name is WorkflowSkill => (WORKFLOW_SKILLS as readonly string[]).includes(name)
const add = <T>(list: T[], item: T): void => {
  if (!list.includes(item)) list.push(item)
}

/** What the calls of one attempt did with the workflow and method skills. Each list is in first-seen order, without repeats. */
export interface CallObservation {
  /** Workflow skills a completed call loaded. */
  workflowLoads: WorkflowSkill[]
  /** Methods a completed call loaded: the skill content reached the model. */
  methodLoads: Method[]
  /** Methods any skill call named, whatever its status or output. A superset of `methodLoads`. */
  methodAttempts: Method[]
  /** Methods whose `SKILL.md` the `read` tool or a shell reader opened, whatever came back. */
  methodFileOpens: Method[]
}

export function observeCalls(calls: readonly ToolUse[]): CallObservation {
  const seen: CallObservation = { workflowLoads: [], methodLoads: [], methodAttempts: [], methodFileOpens: [] }
  for (const call of calls.map(normalizeToolUse)) {
    const name = call.tool === 'skill' ? skillCallName(call) : undefined
    if (name !== undefined) {
      if (isMethod(name)) {
        add(seen.methodAttempts, name)
        if (isSkillContentLoad(call)) add(seen.methodLoads, name)
      } else if (isWorkflow(name) && isSkillContentLoad(call)) add(seen.workflowLoads, name)
    }
    for (const method of METHODS) if (skillFileAccess(call, method) !== null) add(seen.methodFileOpens, method)
  }
  return seen
}

/** What a workflow fixture expects: a fire names the methods any one of which counts; silence expects none. */
export type WorkflowExpectation = { expected: 'fire'; methods: readonly Method[] } | { expected: 'silence' }

export type WorkflowOutcome = 'hit' | 'miss' | 'silent' | 'false_fire'

export interface WorkflowScore {
  outcome: WorkflowOutcome
  /** A fire fixture: a method in its `methods` was loaded. */
  hit: boolean
  /** A silence fixture: any method was loaded, or any method's `SKILL.md` was opened. */
  falseFire: boolean
  /** On a fire fixture: methods loaded that its `methods` does not list. Tallied, never a hit or a false fire. */
  wrongMethod: Method[]
}

export function scoreWorkflow(expectation: WorkflowExpectation, seen: CallObservation): WorkflowScore {
  if (expectation.expected === 'silence') {
    const falseFire = seen.methodLoads.length > 0 || seen.methodFileOpens.length > 0
    return { outcome: falseFire ? 'false_fire' : 'silent', hit: false, falseFire, wrongMethod: [] }
  }
  const hit = seen.methodLoads.some((m) => expectation.methods.includes(m))
  return { outcome: hit ? 'hit' : 'miss', hit, falseFire: false, wrongMethod: seen.methodLoads.filter((m) => !expectation.methods.includes(m)) }
}
