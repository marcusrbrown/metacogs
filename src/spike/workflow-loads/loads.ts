/**
 * Load evidence over stored session parts: which method skills reached a session, and how. A stored tool part is adapted to the
 * tool-use shape the runner's detectors take, so a load here means what it means in the eval runner: a completed skill call that
 * returned skill content, or a completed direct read whose output holds the skill's whole body.
 */
import type { RawPart } from '../feel-drugs/replay/extract'
import { isSkillBodyRead } from '../../runner/checks'
import { isSkillContentLoad, type ToolUse } from '../../runner/events'
import type { Git } from '../../runner/git'
import { METHODS, type Method } from './declaration'

/** The workflow skills whose load makes a session eligible and opens a scope. */
export const WORKFLOW_SKILLS = ['ce:plan', 'ce:review'] as const
export type WorkflowSkill = (typeof WORKFLOW_SKILLS)[number]

/** `skill_call`: a completed skill call returned the content. `direct_read`: a completed read (tool or shell reader) returned the whole body. */
export type LoadBasis = 'skill_call' | 'direct_read'

/** Every version of each method's skill file whose body counts as a complete direct read. */
export type SkillBodies = Record<Method, readonly string[]>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export interface StoredToolUse extends ToolUse {
  /** The tool name as stored. `tool` holds the name the detectors expect: `systematic_skill` is normalized to `skill`. */
  storedTool: string
  partId: string
}

/** A stored tool part as the detectors' tool-use shape; `null` for any other part or unreadable JSON. Never throws. */
export function toolUseOfPart(part: RawPart): StoredToolUse | null {
  const data = parseObject(part.data)
  if (!data || data.type !== 'tool' || typeof data.tool !== 'string') return null
  const state = isRecord(data.state) ? data.state : {}
  const time = isRecord(state.time) ? state.time : {}
  return {
    tool: data.tool === 'systematic_skill' ? 'skill' : data.tool,
    storedTool: data.tool,
    partId: part.id,
    callID: typeof data.callID === 'string' ? data.callID : undefined,
    status: typeof state.status === 'string' ? state.status : undefined,
    input: state.input,
    output: typeof state.output === 'string' ? state.output : undefined,
    metadata: isRecord(state.metadata) ? state.metadata : undefined,
    error: typeof state.error === 'string' ? state.error : undefined,
    startMs: typeof time.start === 'number' ? time.start : undefined,
    endMs: typeof time.end === 'number' ? time.end : undefined,
  }
}

const PLUGIN_PREFIX = 'systematic:'

/** The workflow skill a part loaded: a completed call of a skill tool whose input names `ce:plan` or `ce:review` (the plugin's `systematic:` prefix allowed). */
export function workflowLoadOf(part: RawPart): WorkflowSkill | null {
  const use = toolUseOfPart(part)
  if (!use || use.tool !== 'skill' || use.status !== 'completed' || !isRecord(use.input) || typeof use.input.name !== 'string') return null
  const name = use.input.name.startsWith(PLUGIN_PREFIX) ? use.input.name.slice(PLUGIN_PREFIX.length) : use.input.name
  return WORKFLOW_SKILLS.find((skill) => skill === name) ?? null
}

export interface LoadEvent {
  method: Method
  basis: LoadBasis
  partId: string
}

/** The method loads one stored part carries: none, or one per method it loaded. A skill call takes precedence over a read as the basis. */
export function loadEvents(part: RawPart, bodies: SkillBodies): LoadEvent[] {
  const use = toolUseOfPart(part)
  if (!use) return []
  const events: LoadEvent[] = []
  for (const method of METHODS) {
    if (isSkillContentLoad(use, method)) events.push({ method, basis: 'skill_call', partId: part.id })
    else if (bodies[method].some((text) => isSkillBodyRead(use, method, text))) events.push({ method, basis: 'direct_read', partId: part.id })
  }
  return events
}

export interface MethodEvidence {
  /** A load of the method fell in the interval. */
  loaded: boolean
  /** The basis of the first load in the interval; `null` when none. */
  basis: LoadBasis | null
  /** Every load in the interval, in stored order. */
  events: LoadEvent[]
  /** The method was loaded at some point before the interval began, anywhere in the session up to the manifest mark. */
  loadedEarlier: boolean
}
export type IntervalEvidence = Record<Method, MethodEvidence>

/** Per method: loads inside the interval, and whether any load came before it. The caller fixes what "inside" and "before" mean by what it passes. */
export function intervalEvidence(inInterval: readonly LoadEvent[], earlier: readonly LoadEvent[]): IntervalEvidence {
  const evidence = {} as IntervalEvidence
  for (const method of METHODS) {
    const events = inInterval.filter((event) => event.method === method)
    evidence[method] = { loaded: events.length > 0, basis: events[0]?.basis ?? null, events, loadedEarlier: earlier.some((event) => event.method === method) }
  }
  return evidence
}

// ── the skill files' history ───────────────────────────────────────────────

const utcDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10)

/**
 * The texts of each method's `skills/<method>/SKILL.md` that were live at some point in the window (inclusive UTC days of
 * commit dates): the version in force when the window opens (the last commit before it) and every version committed inside it.
 * Identical texts are listed once. A method with no version up to the end of the window throws: an empty list would silently
 * credit no direct read.
 */
export function collectSkillBodies(git: Git, window: { start: string; end: string }): SkillBodies {
  const bodies = {} as Record<Method, string[]>
  for (const method of METHODS) {
    const rel = `skills/${method}/SKILL.md`
    const commits = git
      .run(['log', '--format=%H%x09%cI', '--', rel])
      .stdout.split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [sha = '', iso = ''] = line.split('\t')
        return { sha, at: Date.parse(iso), day: utcDay(iso) }
      })
      .sort((a, b) => b.at - a.at)
    const inForce = commits.find((c) => c.day < window.start)
    const inWindow = commits.filter((c) => c.day >= window.start && c.day <= window.end)
    const texts: string[] = []
    for (const commit of [...(inForce ? [inForce] : []), ...inWindow]) {
      // a commit that deleted the file has no text to show
      const shown = git.run(['show', `${commit.sha}:./${rel}`], { allowFailure: true })
      if (shown.status === 0 && !texts.includes(shown.stdout)) texts.push(shown.stdout)
    }
    if (texts.length === 0) throw new Error(`no version of ${rel} found in the history up to ${window.end}`)
    bodies[method] = texts
  }
  return bodies
}
