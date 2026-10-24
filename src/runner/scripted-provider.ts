/**
 * Local OpenAI-compatible `/chat/completions` stub used as a fake provider.
 *
 * Deterministic: the reply is a pure function of the request body (the number
 * of completed tool-call rounds), so request ordering and the concurrent
 * title-generation request cannot desynchronise the script.
 *
 * Every request body is recorded. That is itself an isolation instrument: the
 * `tools` array carries the skill tool description (`<available_skills>`) and
 * the `messages` carry the system prompt (including any loaded AGENTS.md), so
 * what the model was actually shown can be inspected without trusting
 * OpenCode's own reporting.
 */

import { CLIPROXY_UPSTREAM } from './cliproxy'

export const SPIKE_PROVIDER_ID = 'metacogs-spike-provider'
export const SPIKE_MODEL_ID = 'metacogs-spike-model'
/** The only key string the runner ever writes to a config. A copy anywhere else is a leak. */
export const PLACEHOLDER_API_KEY = 'placeholder-not-a-secret'

export interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** One model turn: either tool calls or final text. */
export type ScriptedStep =
  | { toolCalls: ScriptedToolCall[] }
  | { text: string }

export interface RecordedRequest {
  hasTools: boolean
  /** Number of completed assistant tool-call rounds in the request history. */
  round: number
  body: unknown
  /** Model id the provider reported in its response; filled in once the response is seen. */
  returnedModel?: string
  /** Where the recording proxy forwarded this request (base URL and path, no query, no headers). Absent for the scripted stub. */
  upstream?: string
}

export interface ScriptedProviderServer {
  /** Base URL including `/v1`. */
  url: string
  /** Every chat-completions request body received, in arrival order. */
  requests: RecordedRequest[]
  stop(): void
}

export interface ScriptedProviderOptions {
  /** Tool-capable turns, by round. Past the end the stub answers `finalText`. */
  steps: readonly ScriptedStep[]
  finalText?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function countToolRounds(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  return messages.filter(
    (m) =>
      isRecord(m) &&
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0,
  ).length
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: 'spike-response',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: SPIKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/** Fixed fake usage so the `step_finish.tokens` mapping is observable. */
export const SCRIPTED_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

function usageChunk() {
  return {
    id: 'spike-response',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: SPIKE_MODEL_ID,
    choices: [],
    usage: SCRIPTED_USAGE,
  }
}

function stepChunks(step: ScriptedStep) {
  return [...stepContentChunks(step), usageChunk()]
}

function stepContentChunks(step: ScriptedStep) {
  if ('toolCalls' in step) {
    return [
      ...step.toolCalls.map((call, index) =>
        chunk(
          {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
          null,
        ),
      ),
      chunk({}, 'tool_calls'),
    ]
  }
  return [
    chunk({ role: 'assistant' }, null),
    chunk({ content: step.text }, null),
    chunk({}, 'stop'),
  ]
}

export function skillCallStep(name: string, id = 'spike-skill-call'): ScriptedStep {
  return { toolCalls: [{ id, name: 'skill', arguments: { name } }] }
}

export function bashCallStep(command: string, id = 'spike-bash-call'): ScriptedStep {
  return {
    toolCalls: [
      { id, name: 'bash', arguments: { command, description: 'spike probe' } },
    ],
  }
}

export function startScriptedProvider(
  options: ScriptedProviderOptions,
): ScriptedProviderServer {
  const requests: RecordedRequest[] = []
  const finalText = options.finalText ?? 'spike done'

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      const body: unknown = await request.json()
      const record = isRecord(body) ? body : {}
      const hasTools = Array.isArray(record.tools) && record.tools.length > 0
      const round = countToolRounds(record.messages)
      requests.push({ hasTools, round, body, returnedModel: SPIKE_MODEL_ID })

      let step: ScriptedStep
      if (!hasTools) {
        // Background title-generation turn: no tools offered.
        step = { text: 'spike title' }
      } else {
        step = options.steps[round] ?? { text: finalText }
      }

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          for (const c of stepChunks(step)) controller.enqueue(encoder.encode(sse(c)))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => {
      void server.stop(true)
    },
  }
}

/** Provider block for `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT`. Placeholder key, zero cost. */
export function scriptedProviderConfig(baseUrl: string): Record<string, unknown> {
  return {
    [SPIKE_PROVIDER_ID]: {
      name: 'Metacogs Spike Provider',
      id: SPIKE_PROVIDER_ID,
      env: [],
      npm: '@ai-sdk/openai-compatible',
      models: {
        [SPIKE_MODEL_ID]: {
          id: SPIKE_MODEL_ID,
          name: 'Metacogs Spike Model',
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: '2026-10-22',
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: PLACEHOLDER_API_KEY, baseURL: baseUrl },
    },
  }
}

/** Reads at most 64 KiB of a response stream looking for the provider-reported model id. */
async function scanReturnedModel(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  try {
    while (seen.length < 65_536) {
      const { done, value } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
      const match = /"model"\s*:\s*"([^"]+)"/.exec(seen)
      if (match) return match[1]
    }
  } catch {
    // scanning is best-effort; the pinned id is still recorded
  } finally {
    void reader.cancel().catch(() => {})
  }
  return undefined
}

export const ZEN_UPSTREAM = 'https://opencode.ai/zen/v1'
/** OpenCode Go's OpenAI-compatible endpoint (`api.url` of the `opencode-go` provider in the 1.19.4 catalogue). */
export const GO_UPSTREAM = 'https://opencode.ai/inference/go/openai/v1'

/**
 * Live runs reach OpenCode's gateway (`opencode-go/*` is the default and preferred; `opencode/*` is Zen, which bills credits,
 * and stays accepted when a prereg or flag names it) or, only with `--auth-cliproxy`, the owner's CLIProxyAPI
 * (`openai/*` and `anthropic/*`). The runner CLI refuses a CLIProxyAPI id without that flag.
 */
export const LIVE_PROVIDERS = ['opencode', 'opencode-go', 'openai', 'anthropic'] as const
export const isLiveModel = (model: string): boolean => LIVE_PROVIDERS.some((p) => model.startsWith(`${p}/`))
export const providerOf = (model: string): string => model.slice(0, model.indexOf('/'))
export const upstreamFor = (providerId: string): string =>
  providerId === 'opencode-go' ? GO_UPSTREAM : providerId === 'openai' || providerId === 'anthropic' ? CLIPROXY_UPSTREAM : ZEN_UPSTREAM

/** Which gateway answered: `go` (subscription), `zen` (credit-billed), `cliproxy` (the owner's CLIProxyAPI), or `mixed` if a run used more than one. */
export type Gateway = 'go' | 'zen' | 'cliproxy' | 'mixed'

/** A recorded fact, not a gate: derived from where the recording proxy forwarded. `null` when nothing was forwarded. */
export function gatewayOf(upstreams: readonly (string | undefined)[]): Gateway | null {
  const kinds = new Set<'go' | 'zen' | 'cliproxy'>()
  for (const u of upstreams) {
    if (u?.startsWith(CLIPROXY_UPSTREAM)) kinds.add('cliproxy')
    else if (u?.includes('/inference/go/')) kinds.add('go')
    else if (u?.includes('/zen/')) kinds.add('zen')
  }
  if (kinds.size === 0) return null
  return kinds.size >= 2 ? 'mixed' : [...kinds][0]!
}

/**
 * Recording pass-through for live mode: the `opencode` provider's `baseURL`
 * is pointed here, request bodies are recorded (headers are never stored, so
 * no credential can reach a transcript), and the request is forwarded to the
 * free-tier endpoint. Gives live runs the same model-visible-prompt
 * instrument the scripted stub gives scripted runs.
 */
export function startRecordingProxy(upstream = ZEN_UPSTREAM): ScriptedProviderServer {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    // Reasoning models stay silent for well over Bun's default 10 s idle limit before the first token.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      let body: unknown = {}
      try {
        body = JSON.parse(text)
      } catch {
        // non-JSON body: record nothing useful
      }
      const rec = isRecord(body) ? body : {}
      const target = `${upstream}${url.pathname.replace(/^\/v1/, '')}`
      const recorded: RecordedRequest = {
        hasTools: Array.isArray(rec.tools) && rec.tools.length > 0,
        round: countToolRounds(rec.messages),
        body,
        upstream: target,
      }
      requests.push(recorded)
      // Forward the client's own headers untouched (the free tier checks the
      // OpenCode client headers). They are never recorded.
      const headers = new Headers(request.headers)
      for (const h of ['host', 'content-length', 'connection', 'accept-encoding']) headers.delete(h)
      const res = await fetch(target, {
        method: request.method,
        headers,
        body: text,
      })
      let passthrough = res.body
      if (res.body) {
        // Tee the response: one branch goes to OpenCode untouched, the other is only
        // scanned for the first `"model":"..."` so the manifest can state what answered.
        const [toClient, toScan] = res.body.tee()
        passthrough = toClient
        void scanReturnedModel(toScan).then((model) => {
          if (model) recorded.returnedModel = model
        })
      }
      return new Response(passthrough, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => {
      void server.stop(true)
    },
  }
}
