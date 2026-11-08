/** Wire-aware request readers: chat completions, OpenAI Responses and Anthropic messages. */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The text blocks of one message `content`: a bare string, or `text` / `input_text` blocks. Tool results and images are skipped. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => (isRecord(b) && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string' ? [b.text] : typeof b === 'string' ? [b] : []))
}

const messageItems = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  return items.filter(isRecord)
}

/** User-role text per message, one entry each (blocks joined); a message with no text block reads as ''. */
export function userTextsAnyWire(body: Record<string, unknown>): string[] {
  return messageItems(body)
    .filter((item) => item.role === 'user')
    .map((item) => textBlocks(item.content).join(''))
}

/** The text blocks of each user message that has any, in order. The last entry is the user's latest turn, even when tool results follow it. */
export function userMessageParts(body: Record<string, unknown>): string[][] {
  return messageItems(body)
    .filter((item) => item.role === 'user')
    .map((item) => textBlocks(item.content))
    .filter((parts) => parts.length > 0)
}

/** Names of the tools offered: chat completions `function.name`, Responses and Anthropic `name`. */
export function toolNamesAnyWire(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((tool) => {
    if (!isRecord(tool)) return []
    const name = isRecord(tool.function) ? tool.function.name : tool.name
    return typeof name === 'string' && name !== '' ? [name] : []
  })
}

/** The model id the request asked for, on any wire. */
export const requestedModel = (body: Record<string, unknown>): string | undefined => (typeof body.model === 'string' ? body.model : undefined)
