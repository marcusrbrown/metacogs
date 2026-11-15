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
import { holdsSecret, SCRUB_LIMITS } from './scrub'
import { CREDENTIAL_TEXT_CASES, EMAIL_TEXT_CASES } from './scrub-cases'
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
// The key `password` with its first letter written as a JSON unicode escape: a backslash in the text, not a `p`.
const ESCAPED_KEY = `\\u0070${['ass', 'word'].join('')}`
/** Valid JSON whose first `body` is overwritten by the second: parsing it keeps only `null`. */
const DUPLICATE = `{"body":{"${ESCAPED_KEY}":"${HARBOR}"},"body":null}`
const FENCED = `Here is the config the service reads:\n\n\`\`\`json\n{\n  "db": {\n    "${ESCAPED_KEY}": "${HARBOR}"\n  }\n}\n\`\`\`\n\nLet me know if it looks right.`
const PLANTED_KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')

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
  { name: 'a duplicate property that hides an escaped credential key', secret: HARBOR, text: DUPLICATE },
  { name: 'a duplicate property inside a JSON string', secret: HARBOR, input: { content: JSON.stringify({ body: DUPLICATE }) } },
  { name: 'a duplicate property after a tool label', secret: HARBOR, text: `[tool] write ${DUPLICATE}` },
  { name: 'a multiline JSON object with an escaped key in a fence after prose', secret: HARBOR, text: FENCED },
  { name: 'a labeled array with an escaped key', secret: HARBOR, text: `[tool] read [{"${ESCAPED_KEY}":"${HARBOR}"}]` },
  { name: 'a known-format secret written with escaped hyphens', secret: PLANTED_KEY, text: `key: ${PLANTED_KEY.replaceAll('-', '\\u002d')}` },
  { name: 'an escaped form feed after a key, in a duplicate property', secret: HARBOR, text: `{"body":{"${PASSWORD}\\f":"${HARBOR}"},"body":null}` },
  { name: 'an escaped form feed after a key, in a labeled array', secret: HARBOR, text: `[tool] read [{"${PASSWORD}\\f":"${HARBOR}"}]` },
  { name: 'an escaped form feed after a key, in a fence', secret: HARBOR, text: `Here is the config:\n\n\`\`\`json\n{\n  "db": {\n    "${PASSWORD}\\f": "${HARBOR}"\n  }\n}\n\`\`\`\n` },
  { name: 'an escaped backspace after a key', secret: HARBOR, text: `{"body":{"${PASSWORD}\\b":"${HARBOR}"},"body":null}` },
  { name: 'an escaped form feed after a key with a doubled backslash', secret: HARBOR, text: `{"body":{"${PASSWORD}\\\\f":"${HARBOR}"},"body":null}` },
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
function viewOf(call: { input?: Record<string, unknown>; output?: string; tool?: string }) {
  const f = fixture()
  seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
  f.store.addText(f.store.addMessage('ses_a', 'user'), 'go on')
  f.store.addTool(f.store.addMessage('ses_a', 'assistant'), { tool: call.tool ?? (call.input ? 'write' : 'bash'), input: call.input ?? { command: 'cat f' }, output: call.output ?? 'ok' })
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

describe('an email written with an escape', () => {
  const ENCODED = '{"to":"someone\\u0040corp-mail.com"}'
  const LITERAL = `{"to":"${['someone', 'corp-mail.com'].join('@')}"}`

  test('the view withholds the whole text, since the address cannot be removed in place', () => {
    const { rendered } = viewOf({ output: ENCODED })
    const shown = JSON.stringify(rendered.scopes)
    expect(shown).toContain(SCRUB_PLACEHOLDER)
    expect(shown).not.toContain('corp-mail')
    expect(rendered.counters).toMatchObject({ scrubbedOutputs: 1, redactedEmails: 0 })
  })

  test('a literal address keeps today\'s in-place redaction: the text stays, the address goes', () => {
    const { rendered } = viewOf({ output: LITERAL })
    const shown = JSON.stringify(rendered.scopes)
    expect(shown).toContain('[email]')
    expect(shown).not.toContain('corp-mail')
    expect(rendered.counters).toMatchObject({ scrubbedOutputs: 0, redactedEmails: 1 })
  })

  test('the pre-send guard refuses a chunk that still holds it, and a chunk built from the view is sent', async () => {
    const f = fixture()
    const refused = await sendChunk(f, [chunkWith(`[tool] bash {"command":"cat f"}\n[output] ${ENCODED}`)])
    expect(refused.transport.requests).toHaveLength(0)
    expect(refused.run.results[0]?.outcome).toEqual({ status: 'failed', attempts: 0, reason: 'unscrubbed_input' })

    const { f: g, rendered } = viewOf({ output: ENCODED })
    const scope = rendered.scopes[0]
    if (!scope) throw new Error('no scope')
    const sent = await sendChunk(g, chunkScope(scope, { budget: 100_000 }))
    expect(sent.transport.requests.length).toBeGreaterThan(0)
    expect(sent.run.coverageComplete).toBe(true)
    expect(sent.transport.requests.map((r) => r.user).join('\n')).not.toContain('corp-mail')
  })
})

describe('an escape that names nothing secret is kept', () => {
  const TEXT = 'the caf\\u00e9 menu, a path with a slash\\/ and a byte \\x41, and a tab\\there'

  test('the view keeps it as written', () => {
    const { rendered } = viewOf({ output: TEXT })
    expect(JSON.stringify(rendered.scopes)).toContain('caf')
    expect(JSON.stringify(rendered.scopes)).not.toContain(SCRUB_PLACEHOLDER)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
  })

  test('the pre-send guard lets it through', async () => {
    const f = fixture()
    const { transport } = await sendChunk(f, [chunkWith(TEXT)])
    expect(transport.requests).toHaveLength(1)
  })
})

describe('an address written out and the same one written with an escape', () => {
  const MIXED = `${['someone', 'corp-mail.com'].join('@')} and someone\\u0040corp-mail.com`

  test('the view output passes the guard, so the chunk is sent with neither address in the request', async () => {
    const { f, rendered } = viewOf({ output: MIXED })
    const shown = JSON.stringify(rendered.scopes)
    expect(shown).not.toContain('corp-mail')
    expect(shown).toContain(SCRUB_PLACEHOLDER)
    const scope = rendered.scopes[0]
    if (!scope) throw new Error('no scope')
    const chunks = chunkScope(scope, { budget: 100_000 })
    for (const chunk of chunks) expect(holdsSecret(chunk.text)).toBe(false)
    const { transport, run } = await sendChunk(f, chunks)
    expect(transport.requests.length).toBeGreaterThan(0)
    expect(run.coverageComplete).toBe(true)
    expect(transport.requests.map((r) => `${r.system}\n${r.user}`).join('\n')).not.toContain('corp-mail')
  })

  test('a literal address alone is still redacted in place, and counted', () => {
    const { rendered } = viewOf({ output: `write to ${['someone', 'corp-mail.com'].join('@')} soon` })
    expect(JSON.stringify(rendered.scopes)).toContain('write to [email] soon')
    expect(rendered.counters).toMatchObject({ scrubbedOutputs: 0, redactedEmails: 1 })
  })
})

describe('whatever the view renders, the guard accepts', () => {
  /** Every string the view holds for the scope, and every chunk text the labeler would be sent, for a range of budgets and contexts. */
  async function assertAccepted(call: { input?: Record<string, unknown>; output?: string }, label: string) {
    const { f, rendered } = viewOf(call)
    for (const scope of rendered.scopes) {
      for (const stimulus of scope.stimuli) {
        for (const text of [stimulus.text, ...stimulus.traffic]) expect([label, text, holdsSecret(text)]).toEqual([label, text, false])
      }
      for (const budget of [150, 600, 100_000]) {
        for (const contextK of [0, 1, 3]) {
          for (const chunk of chunkScope(scope, { budget, contextK })) expect([label, holdsSecret(chunk.text)]).toEqual([label, false])
        }
      }
    }
    const scope = rendered.scopes[0]
    if (!scope) throw new Error('no scope')
    const { transport, run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
    expect([label, run.results.map((r) => r.outcome.status)]).toEqual([label, run.results.map(() => 'labeled')])
    expect(transport.requests.length).toBeGreaterThan(0)
  }

  test('every credential text of the shared table, as a tool output', async () => {
    for (const text of CREDENTIAL_TEXT_CASES) await assertAccepted({ output: text }, text.slice(0, 40))
  }, 60_000)

  test('every address text of the shared table, as a tool output', async () => {
    for (const text of EMAIL_TEXT_CASES) await assertAccepted({ output: text }, text.slice(0, 40))
  }, 60_000)

  test('every case of this file, as a tool input or an output', async () => {
    for (const c of CASES) await assertAccepted(c.input ? { input: c.input } : { output: c.text ?? '' }, c.name)
  }, 60_000)
})

describe('a line whose parts are each fine but whose whole is not', () => {
  // a tool named like a credential key, called with an input whose first key is empty: `token {"":1}` reads as `token` then `:`
  const NAME = ['to', 'ken'].join('')

  test('the guard refuses the composed line, so the view withholds it', async () => {
    const line = `[tool] ${NAME} {"":1}`
    expect(holdsSecret(line)).toBe(true)
    expect(holdsSecret('{"":1}')).toBe(false)
    const { f, rendered } = viewOf({ tool: NAME, input: { '': 1 } })
    const [stimulus] = rendered.scopes[0]?.stimuli ?? []
    for (const text of [stimulus?.text ?? '', ...(stimulus?.traffic ?? [])]) expect(holdsSecret(text)).toBe(false)
    expect(JSON.stringify(rendered.scopes)).toContain(SCRUB_PLACEHOLDER)
    const scope = rendered.scopes[0]
    if (!scope) throw new Error('no scope')
    const { run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
    expect(run.coverageComplete).toBe(true)
  })
})

describe('ordinary newline and tab escapes are kept', () => {
  const TEXT = 'first line\\nsecond line\\tindented, and a quote \\" and a backslash \\\\ and a bell \\b'

  test('the view keeps the text as written, and the guard lets it through', async () => {
    const { f, rendered } = viewOf({ output: TEXT })
    expect(JSON.stringify(rendered.scopes)).toContain('second line')
    expect(JSON.stringify(rendered.scopes)).not.toContain(SCRUB_PLACEHOLDER)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
    const { transport } = await sendChunk(f, [chunkWith(TEXT)])
    expect(transport.requests).toHaveLength(1)
  })
})
