/**
 * Load evidence over stored session parts: which method skills reached a session, and how. A stored tool part is adapted to the
 * tool-use shape the runner's detectors take, so a load here means what it means in the eval runner: a completed skill call that
 * returned skill content, or a completed direct read whose output holds the skill's whole body.
 */
import type { RawPart } from '../feel-drugs/replay/extract'
import { isSkillBodyRead, skillFileAccess } from '../../runner/checks'
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

/** The JSON object in a stored `data` column; `null` for text that is not JSON or not an object. Never throws. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
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
  const data = parseJsonObject(part.data)
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

/** Every spelling of a workflow skill's name a completed load may carry: bare, or with the plugin prefix. */
export const WORKFLOW_SKILL_NAMES: readonly string[] = WORKFLOW_SKILLS.flatMap((skill) => [skill, `${PLUGIN_PREFIX}${skill}`])

/** The workflow skill a part loaded: a completed call of a skill tool whose input names `ce:plan` or `ce:review` (the plugin's `systematic:` prefix allowed). */
export function workflowLoadOf(part: RawPart): WorkflowSkill | null {
  const use = toolUseOfPart(part)
  if (!use || use.tool !== 'skill' || use.status !== 'completed' || !isRecord(use.input) || typeof use.input.name !== 'string') return null
  const name = use.input.name.startsWith(PLUGIN_PREFIX) ? use.input.name.slice(PLUGIN_PREFIX.length) : use.input.name
  return WORKFLOW_SKILLS.find((skill) => skill === name) ?? null
}

// ── calls that touch a method ──────────────────────────────────────────────

const SKILL_TOOLS: ReadonlySet<string> = new Set(['skill', 'systematic_skill'])
const SHELL_TOOL = 'bash'
const NAME_BOUNDARY_PREFIX = '(?<![A-Za-z0-9])'
const NAME_BOUNDARY_SUFFIX = '(?![A-Za-z0-9])'
/** A method's name as a whole word, in any case. Letters and digits join a word; `_`, `-`, `/` and `:` do not. */
export const nameRegex = (): RegExp => new RegExp(`${NAME_BOUNDARY_PREFIX}(?:${METHODS.join('|')})${NAME_BOUNDARY_SUFFIX}`, 'gi')
/** The same name matched alone, as a leak-list entry. */
export const wholeWordRegex = (word: string): RegExp => new RegExp(`${NAME_BOUNDARY_PREFIX}${word}${NAME_BOUNDARY_SUFFIX}`, 'i')
const HELPER_CALL = /scripts\/record\.mjs/i

/** `skill_call`: a skill tool naming a method. `file_read`: access to a method's skill file. `helper_call`: a shell call to the record helper. */
export type MethodCall = 'skill_call' | 'file_read' | 'helper_call'

/**
 * Whether a call loads or records a method, decided from the tool's name and its input alone: a failed call and a successful one
 * are alike. The hidden view drops these calls, and the walk never takes one for a stimulus, so a load stays in the interval it fell in.
 */
export function methodCallOf(use: StoredToolUse): MethodCall | null {
  const input = isRecord(use.input) ? use.input : {}
  if (SKILL_TOOLS.has(use.storedTool) && typeof input.name === 'string' && nameRegex().test(input.name)) return 'skill_call'
  if (METHODS.some((method) => skillFileAccess(use, method) !== null)) return 'file_read'
  if (use.storedTool === SHELL_TOOL && typeof input.command === 'string' && HELPER_CALL.test(input.command)) return 'helper_call'
  return null
}

export interface LoadEvent {
  method: Method
  basis: LoadBasis
  partId: string
}

/**
 * The use as the runner's detectors take it: a skill call that names the skill with the plugin's one `systematic:` prefix names it
 * bare, because the detector compares the name with the method exactly. Any other name is left as it is. The runner's code is not
 * changed. (`methodCallOf` is wider on purpose: it matches a method name anywhere in a skill name, so the view drops every call
 * that could be a load, while a load is counted only for the names the plugin accepts.)
 */
function withBareSkillName(use: StoredToolUse): StoredToolUse {
  if (use.tool !== 'skill' || !isRecord(use.input) || typeof use.input.name !== 'string' || !use.input.name.startsWith(PLUGIN_PREFIX)) return use
  return { ...use, input: { ...use.input, name: use.input.name.slice(PLUGIN_PREFIX.length) } }
}

/** The method loads one stored part carries: none, or one per method it loaded. A skill call takes precedence over a read as the basis. */
export function loadEvents(part: RawPart, bodies: SkillBodies): LoadEvent[] {
  const stored = toolUseOfPart(part)
  if (!stored) return []
  const use = withBareSkillName(stored)
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
