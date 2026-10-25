/** Logs `message` at most once per `key`. Messages never carry argument values. */
export type Warn = (key: string, message: string) => void

export interface PluginSettings {
  /** Whether the guidance block is appended to the system prompt. */
  guidance: boolean
}

const describeType = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

/** Only a strict boolean `guidance` is honoured. Anything else leaves the block on and is logged by type. */
export function parseOptions(raw: unknown, warn: Warn): PluginSettings {
  if (raw === undefined) return { guidance: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('options', `plugin options must be an object, got ${describeType(raw)}; using the defaults`)
    return { guidance: true }
  }
  const { guidance } = raw as Record<string, unknown>
  if (guidance === undefined) return { guidance: true }
  if (typeof guidance === 'boolean') return { guidance }
  warn('options.guidance', `the guidance option must be true or false, got ${describeType(guidance)}; the guidance block stays on`)
  return { guidance: true }
}
