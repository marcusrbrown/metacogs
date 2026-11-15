/**
 * Credential text through both boundaries: the rendered view and the labeler's pre-send guard. A text with a credential key next to
 * an assignment is withheld from the view, and a chunk that still holds one is never sent. Each case runs through both.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { gatedRepo, seedWorkflowSession, syntheticStore } from './test-support'
import { type CompleteRequest } from '../feel-drugs/replay/judge'
import { type LabelerTransport, labelChunks } from './labeler'
import { type Chunk, chunkScope, renderSessions, renderStimulusBlock, SCRUB_PLACEHOLDER } from './mask'
import { SCRUB_LIMITS } from './scrub'
import { freezeManifest, openPrivateRoot, walkManifest } from './store'
import { SAMPLE_RULE_TEXT } from './test-support'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

// Assembled at runtime so this file holds no credential-shaped literal.
const HARBOR = ['harbor', 'Moon42'].join('')
const ACTUAL = ['actual', 'pass42'].join('')
const PASSWORD = ['pass', 'word'].join('')
const TOKEN = ['to', 'ken'].join('')

/** A secret that must never survive: the case's input, as a structured tool input or as text, and the value inside it. */
interface Case {
  name: string
  secret: string
  /** A tool input object, as the host stores it. */
  input?: Record<string, unknown>
  /** Text in a tool output. */
  text?: string
}

/** JSON text wrapped in JSON string layers. Each layer escapes the one inside it, so the text grows by about half again per layer. */
const wrap = (inner: string, layers: number): string => {
  let text = inner
  for (let i = 0; i < layers; i++) text = JSON.stringify({ body: text })
  return text
}

/** A value nested in `depth` objects. */
const nest = (leaf: unknown, depth: number): unknown => {
  let value = leaf
  for (let i = 0; i < depth; i++) value = { a: value }
  return value
}

const CASES: Case[] = [
  { name: 'a password whose value is an array', secret: HARBOR, input: { [PASSWORD]: [HARBOR] } },
  { name: 'a token whose value is an object', secret: HARBOR, input: { [TOKEN]: { value: HARBOR } } },
  { name: 'a quoted password after the view\'s own email placeholder', secret: ACTUAL, text: `${PASSWORD}="[email]${ACTUAL}"` },
  { name: 'an unquoted password after a bracketed placeholder', secret: HARBOR, text: `${PASSWORD}=[REDACTED]${HARBOR}` },
  { name: 'a tab-separated assignment nested deeper than the container limit', secret: ACTUAL, input: { content: nest(`${PASSWORD}\t=\t${ACTUAL}`, SCRUB_LIMITS.containerDepth + 20) } },
  { name: 'a tab-separated assignment wrapped in more JSON strings than the decode limit', secret: ACTUAL, input: { content: wrap(`${PASSWORD}\t=\t${ACTUAL}`, SCRUB_LIMITS.decodeDepth + 5) } },
  { name: 'an assignment inside JSON text inside a string', secret: ACTUAL, input: { payload: JSON.stringify({ body: `${PASSWORD}\t=\t${ACTUAL}` }) } },
  { name: 'a nested password that contains escaped quotes', secret: ACTUAL, input: { content: JSON.stringify({ a: { [PASSWORD]: `${ACTUAL}"x"` } }) } },
  { name: 'an environment variable reference after a token', secret: 'GH_TOKEN', text: `${TOKEN}: \${GH_TOKEN}` },
  { name: 'a placeholder value with its key', secret: '<redacted>', input: { env: { [PASSWORD]: '<redacted>' } } },
]

function fixture() {
  const { repo, declaration } = gatedRepo()
  const store = syntheticStore()
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-credentials-'))
  const privateRoot = openPrivateRoot({ root: join(dir, 'state') })
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  return { repo, declaration, store, privateRoot }
}

/** The view of a one-stimulus workflow session whose assistant turn made one tool call. */
function viewOf(call: { input?: Record<string, unknown>; output?: string }) {
  const f = fixture()
  seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
  f.store.addText(f.store.addMessage('ses_a', 'user'), 'go on')
  f.store.addTool(f.store.addMessage('ses_a', 'assistant'), { tool: call.input ? 'write' : 'bash', input: call.input ?? { command: 'cat f' }, output: call.output ?? 'ok' })
  const input = { git: f.repo.git, db: f.store.path, privateRoot: f.privateRoot }
  freezeManifest(input)
  return { f, rendered: renderSessions(walkManifest({ ...input, skillBodies: { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] } })) }
}

function scriptedTransport(): LabelerTransport & { requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = []
  return {
    endpoint: 'https://proxy.example.invalid/v1',
    requests,
    async complete(request) {
      requests.push(request)
      return { text: JSON.stringify({ proposals: [] }) }
    },
  }
}

async function sendChunk(f: ReturnType<typeof fixture>, chunks: readonly Chunk[]) {
  const transport = scriptedTransport()
  const run = await labelChunks({ git: f.repo.git, privateRoot: f.privateRoot, chunks, ruleText: SAMPLE_RULE_TEXT, transport, nonce: () => 'n0nce', sessionId: () => 's', retryDelayMs: 0 })
  return { transport, run }
}

const chunkWith = (text: string): Chunk => ({ sessionId: 'ses_1', scopeIndex: 0, ids: ['a1'], contextIds: [], text: renderStimulusBlock({ id: 'a1', kind: 'user_message', text, traffic: [] }, 'stimulus'), oversize: false })

/** What the host's text for a tool call looks like once rendered unscrubbed: the call, then its output. */
const callText = (c: Case): string => (c.input ? `[tool] write ${JSON.stringify(c.input)}` : `[tool] bash {"command":"cat f"}\n[output] ${c.text}`)

describe('credential text is withheld from the view and never sent', () => {
  for (const c of CASES) {
    test(`${c.name}: the view withholds it`, () => {
      const { rendered } = viewOf(c.input ? { input: c.input } : { output: c.text ?? '' })
      const shown = JSON.stringify(rendered.scopes)
      expect(shown).toContain(SCRUB_PLACEHOLDER)
      expect(shown).not.toContain(c.secret)
      expect(rendered.counters.scrubbedInputs + rendered.counters.scrubbedOutputs).toBe(1)
    })

    test(`${c.name}: the pre-send guard refuses the unscrubbed chunk and nothing is sent`, async () => {
      const f = fixture()
      const { transport, run } = await sendChunk(f, [chunkWith(callText(c))])
      expect(transport.requests).toHaveLength(0)
      expect(run.results[0]?.outcome).toEqual({ status: 'failed', attempts: 0, reason: 'unscrubbed_input' })
      expect(JSON.stringify(run)).not.toContain(c.secret)
    })

    test(`${c.name}: a view built from it reaches the transport without it`, async () => {
      const { f, rendered } = viewOf(c.input ? { input: c.input } : { output: c.text ?? '' })
      const scope = rendered.scopes[0]
      if (!scope) throw new Error('no scope')
      const { transport } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
      expect(transport.requests.length).toBeGreaterThan(0)
      expect(transport.requests.map((r) => `${r.system}\n${r.user}`).join('\n')).not.toContain(c.secret)
    })
  }
})

describe('prose that only mentions the words is kept and sent', () => {
  const PROSE = ['the token expired', 'rotate the password', 'max_tokens: 4096', 'author: a colleague']

  test('the view keeps it, whole', () => {
    const { rendered } = viewOf({ output: PROSE.join('; ') })
    const shown = JSON.stringify(rendered.scopes)
    for (const text of PROSE) expect(shown).toContain(text)
    expect(shown).not.toContain(SCRUB_PLACEHOLDER)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
  })

  test('the pre-send guard lets it through', async () => {
    const f = fixture()
    const { transport, run } = await sendChunk(f, [chunkWith(PROSE.join('; '))])
    expect(transport.requests).toHaveLength(1)
    expect(run.results[0]?.outcome.status).toBe('labeled')
  })
})

describe('a limit hit is withheld and never sent', () => {
  const LIMITS: { name: string; input: Record<string, unknown> }[] = [
    { name: 'an input nested deeper than the container limit', input: { content: nest('leaf', SCRUB_LIMITS.containerDepth + 10) } },
    { name: 'a string wrapped in JSON more times than the decode limit', input: { content: wrap('leaf', SCRUB_LIMITS.decodeDepth + 5) } },
    { name: 'a text longer than the size limit', input: { content: 'x'.repeat(SCRUB_LIMITS.chars + 10) } },
  ]

  for (const { name, input } of LIMITS) {
    test(`${name}: the view withholds it`, () => {
      const { rendered } = viewOf({ input })
      expect(JSON.stringify(rendered.scopes)).toContain(SCRUB_PLACEHOLDER)
      expect(rendered.counters.scrubbedInputs).toBe(1)
    })

    test(`${name}: the pre-send guard refuses it`, async () => {
      const f = fixture()
      const { transport, run } = await sendChunk(f, [chunkWith(`[tool] write ${JSON.stringify(input)}`)])
      expect(transport.requests).toHaveLength(0)
      expect(run.results[0]?.outcome).toEqual({ status: 'failed', attempts: 0, reason: 'unscrubbed_input' })
    })
  }
})
