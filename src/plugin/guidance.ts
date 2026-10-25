import GUIDANCE_MD from '../../plugin/guidance.md'

export const GUIDANCE_OPEN = '<METACOGS_GUIDANCE>'
export const GUIDANCE_CLOSE = '</METACOGS_GUIDANCE>'
export const GUIDANCE_TEXT: string = GUIDANCE_MD
export const GUIDANCE_BLOCK = `${GUIDANCE_OPEN}\n${GUIDANCE_TEXT.trimEnd()}\n${GUIDANCE_CLOSE}`

/**
 * Starts of the system prompts OpenCode 1.19.4 uses for its own calls: the session title, compaction and the session
 * summary. The last entry is Systematic's older compaction wording, kept so a host that still sends it is skipped.
 * Compared case-insensitively against the joined system text.
 */
export const INTERNAL_SIGNATURES = [
  'You are a title generator',
  'You are a context summarization agent',
  'Summarize what was done in this conversation',
  'You are a helpful AI assistant tasked with summarizing conversations',
] as const

const SEPARATOR = '\n\n'

/** Removes every closed guidance block from `entry`, with up to two newlines before it. An unclosed marker stays. */
export function stripGuidance(entry: string): string {
  let text = entry
  for (let from = 0; ; ) {
    const open = text.indexOf(GUIDANCE_OPEN, from)
    if (open === -1) return text
    const close = text.indexOf(GUIDANCE_CLOSE, open + GUIDANCE_OPEN.length)
    if (close === -1) return text
    let start = open
    while (start > open - SEPARATOR.length && text[start - 1] === '\n') start -= 1
    text = text.slice(0, start) + text.slice(close + GUIDANCE_CLOSE.length)
    from = start
  }
}

/**
 * The system entries with exactly one guidance block at the end of the first, or `null` for one of the host's own
 * calls. Pure: the input is not changed, and the same input gives the same output.
 */
export function withGuidance(system: readonly string[]): string[] | null {
  const stripped = system.map(stripGuidance)
  const joined = stripped.join('\n').toLowerCase()
  if (INTERNAL_SIGNATURES.some((signature) => joined.includes(signature.toLowerCase()))) return null
  const [first, ...rest] = stripped
  if (first === undefined) return [GUIDANCE_BLOCK]
  return [first === '' ? GUIDANCE_BLOCK : `${first}${SEPARATOR}${GUIDANCE_BLOCK}`, ...rest]
}
