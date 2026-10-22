/**
 * Parser for `opencode run --format json` (opencode-ai 1.19.4).
 *
 * The event schema is undocumented; the shapes below are the ones recorded in
 * `evals/runner/README.md`. Two layers:
 *
 * - `parseEvents` and the small projections (`toolUses`, `skillLoads`,
 *   `assistantText`, `totalUsage`) are loose: promoted unchanged from the
 *   Unit 1 spike, which re-exports them.
 * - `analyzeEvents` is the runner's view. It fails closed: anything it cannot
 *   place (non-JSON lines, unknown event types, a known type with the wrong
 *   shape) is listed in `unrecognized`, and the caller must not trust a
 *   "nothing fired" conclusion drawn from such a stream.
 */

/** Loose view over the (undocumented) `--format json` events. */
export interface OpencodeEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: Record<string, unknown>
  error?: Record<string, unknown>
  [key: string]: unknown
}

export interface ParsedEvents {
  events: OpencodeEvent[]
  /** Lines of stdout that were not valid JSON objects with a string `type`. */
  nonJsonLines: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEvents(stdout: string): ParsedEvents {
  const events: OpencodeEvent[] = []
  const nonJsonLines: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value) && typeof value.type === 'string') {
        events.push(value as OpencodeEvent)
        continue
      }
    } catch {
      // fall through
    }
    nonJsonLines.push(line)
  }
  return { events, nonJsonLines }
}

export interface ToolUse {
  tool: string
  callID: string | undefined
  status: string | undefined
  input: unknown
  output: string | undefined
  metadata: Record<string, unknown> | undefined
  error: string | undefined
  startMs: number | undefined
  endMs: number | undefined
}

/** `tool_use` events → flat records. Field names are the observed ones. */
export function toolUses(events: readonly OpencodeEvent[]): ToolUse[] {
  return events
    .filter((e) => e.type === 'tool_use')
    .map((e) => {
      const part = e.part ?? {}
      const state = isRecord(part.state) ? part.state : {}
      const time = isRecord(state.time) ? state.time : {}
      return {
        tool: String(part.tool),
        callID: typeof part.callID === 'string' ? part.callID : undefined,
        status: typeof state.status === 'string' ? state.status : undefined,
        input: state.input,
        output: typeof state.output === 'string' ? state.output : undefined,
        metadata: isRecord(state.metadata) ? state.metadata : undefined,
        error: typeof state.error === 'string' ? state.error : undefined,
        startMs: typeof time.start === 'number' ? time.start : undefined,
        endMs: typeof time.end === 'number' ? time.end : undefined,
      }
    })
}

export function skillLoads(events: readonly OpencodeEvent[]): ToolUse[] {
  return toolUses(events).filter((t) => t.tool === 'skill')
}

export function assistantText(events: readonly OpencodeEvent[]): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => (typeof e.part?.text === 'string' ? e.part.text : ''))
    .join('')
}

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/** Sum of `step_finish` token counters. */
export function totalUsage(events: readonly OpencodeEvent[]): Usage {
  const total = emptyUsage()
  for (const e of events) {
    if (e.type !== 'step_finish') continue
    const tokens = isRecord(e.part?.tokens) ? e.part.tokens : {}
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    total.input += Number(tokens.input ?? 0)
    total.output += Number(tokens.output ?? 0)
    total.reasoning += Number(tokens.reasoning ?? 0)
    total.cacheRead += Number(cache.read ?? 0)
    total.cacheWrite += Number(cache.write ?? 0)
    total.cost += Number(e.part?.cost ?? 0)
  }
  return total
}

// ── strict layer ───────────────────────────────────────────────────────────

export const KNOWN_EVENT_TYPES = ['step_start', 'step_finish', 'tool_use', 'text', 'error'] as const

export interface HostError {
  name: string | undefined
  message: string | undefined
  /** HTTP status of a provider `APIError`, when the host reports one. */
  statusCode?: number
}

export interface EventSummary {
  toolUses: ToolUse[]
  /** `tool_use` events with `part.tool === "skill"`, any status. */
  skillCalls: ToolUse[]
  assistantText: string
  usage: Usage
  hostErrors: HostError[]
  stepFinishCount: number
  firstTimestamp: number | undefined
  lastTimestamp: number | undefined
  /** Why the stream cannot be fully trusted; empty when every line was understood. */
  unrecognized: string[]
}

/** The name a `skill` tool call asked for, if the input carries one. */
export function skillCallName(call: ToolUse): string | undefined {
  if (isRecord(call.input) && typeof call.input.name === 'string') return call.input.name
  return undefined
}

/**
 * A skill's content reached the model: a completed `skill` call whose output
 * is the `<skill_content …>` block (README: "Skill load").
 */
export function isSkillContentLoad(call: ToolUse, method?: string): boolean {
  if (call.tool !== 'skill' || call.status !== 'completed') return false
  if (!call.output?.includes('<skill_content')) return false
  return method === undefined || skillCallName(call) === method
}

export function analyzeEvents(stdout: string): EventSummary {
  const { events, nonJsonLines } = parseEvents(stdout)
  const unrecognized: string[] = nonJsonLines.map((l) => `non-event stdout line: ${l.slice(0, 120)}`)
  const known = new Set<string>(KNOWN_EVENT_TYPES)
  const hostErrors: HostError[] = []
  let stepFinishCount = 0

  for (const e of events) {
    if (!known.has(e.type)) {
      unrecognized.push(`unknown event type: ${e.type}`)
      continue
    }
    const part = e.part
    switch (e.type) {
      case 'tool_use':
        if (!isRecord(part) || typeof part.tool !== 'string' || !isRecord(part.state)) {
          unrecognized.push('malformed tool_use (missing part.tool or part.state)')
        } else if (typeof part.state.status !== 'string') {
          unrecognized.push(`malformed tool_use ${part.tool} (missing state.status)`)
        }
        break
      case 'text':
        if (!isRecord(part) || typeof part.text !== 'string') unrecognized.push('malformed text (missing part.text)')
        break
      case 'step_finish':
        stepFinishCount += 1
        if (!isRecord(part) || !isRecord(part.tokens)) unrecognized.push('malformed step_finish (missing part.tokens)')
        break
      case 'error': {
        const data = isRecord(e.error?.data) ? e.error.data : {}
        hostErrors.push({
          name: typeof e.error?.name === 'string' ? e.error.name : undefined,
          message: typeof data.message === 'string' ? data.message : undefined,
          ...(typeof data.statusCode === 'number' ? { statusCode: data.statusCode } : {}),
        })
        break
      }
      default:
        break
    }
  }

  const stamps = events.map((e) => e.timestamp).filter((t): t is number => typeof t === 'number')
  const uses = toolUses(events)
  return {
    toolUses: uses,
    skillCalls: uses.filter((t) => t.tool === 'skill'),
    assistantText: assistantText(events),
    usage: totalUsage(events),
    hostErrors,
    stepFinishCount,
    firstTimestamp: stamps.length ? Math.min(...stamps) : undefined,
    lastTimestamp: stamps.length ? Math.max(...stamps) : undefined,
    unrecognized,
  }
}
