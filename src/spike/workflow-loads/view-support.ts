/**
 * Shared by the tests that put text through the rendered view and the labeler's pre-send guard: a synthetic repository and store, the
 * view of a one-stimulus workflow session, and a scripted transport that records what it is sent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CompleteRequest } from '../feel-drugs/replay/judge'
import { type LabelerTransport, labelChunks } from './labeler'
import { expect } from 'bun:test'

import type { TestRepo } from '../../runner/test-support'
import type { Declaration } from './declaration'
import { type Chunk, chunkScope, type RenderedSessions, renderSessions, renderStimulusBlock, SCRUB_PLACEHOLDER } from './mask'
import { holdsSecret } from './scrub'
import { freezeManifest, openPrivateRoot, type PrivateRoot, walkManifest } from './store'
import { gatedRepo, SAMPLE_RULE_TEXT, seedWorkflowSession, type SyntheticStore, syntheticStore } from './test-support'

/** A synthetic gated repository, a synthetic session store and a private root, all removed by `cleanup`. */
export interface Fixture {
  repo: TestRepo
  declaration: Declaration
  store: SyntheticStore
  privateRoot: PrivateRoot
}

/** A transport that answers every request with no proposals and keeps what it was sent. */
export type RecordingTransport = LabelerTransport & { requests: CompleteRequest[] }

/** What a run of the labeler returns. */
export type LabelRun = Awaited<ReturnType<typeof labelChunks>>

/** Teardown callbacks of the fixtures made so far; each test file empties it in an `afterEach`. */
export const cleanup: (() => void)[] = []

export function fixture(): Fixture {
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
export function viewOf(call: { input?: Record<string, unknown>; output?: string; tool?: string; user?: string }): { f: Fixture; rendered: RenderedSessions } {
  const f = fixture()
  seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
  f.store.addText(f.store.addMessage('ses_a', 'user'), call.user ?? 'go on')
  f.store.addTool(f.store.addMessage('ses_a', 'assistant'), { tool: call.tool ?? (call.input ? 'write' : 'bash'), input: call.input ?? { command: 'cat f' }, output: call.output ?? 'ok' })
  const input = { git: f.repo.git, db: f.store.path, privateRoot: f.privateRoot }
  freezeManifest(input)
  return { f, rendered: renderSessions(walkManifest({ ...input, skillBodies: { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] } })) }
}

export function scriptedTransport(): RecordingTransport {
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

export async function sendChunk(f: Fixture, chunks: readonly Chunk[]): Promise<{ transport: RecordingTransport; run: LabelRun }> {
  const transport = scriptedTransport()
  const run = await labelChunks({ git: f.repo.git, privateRoot: f.privateRoot, chunks, ruleText: SAMPLE_RULE_TEXT, transport, nonce: () => 'n0nce', sessionId: () => 's', retryDelayMs: 0 })
  return { transport, run }
}

export const chunkWith = (text: string): Chunk => ({ sessionId: 'ses_1', scopeIndex: 0, ids: ['a1'], contextIds: [], text: renderStimulusBlock({ id: 'a1', kind: 'user_message', text, traffic: [] }, 'stimulus'), oversize: false })


/**
 * Whatever the view renders for a call, the guard accepts: every rendered piece, every chunk text at a range of budgets and contexts,
 * and the chunks sent through the real pre-send guard (each is labeled, none refused).
 */
export async function assertViewAccepted(call: { input?: Record<string, unknown>; output?: string; user?: string }, label: string): Promise<void> {
  const { f, rendered } = viewOf(call)
  for (const scope of rendered.scopes) {
    for (const stimulus of scope.stimuli) {
      for (const text of [stimulus.text, ...stimulus.traffic]) expect([label, holdsSecret(text)]).toEqual([label, false])
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

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Characters from a fixed seed: no run repeats, so a 16-character run names its place in the secret. */
export function randomText(length: number, seed: number): string {
  let state = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff
    out += ALPHABET[state % ALPHABET.length]
  }
  return out
}

/** Every distinct run of `length` characters of the texts: a distinguishing fragment of a secret is any one of them. */
export function runsOf(texts: readonly string[], length = 16): string[] {
  const runs = new Set<string>()
  for (const text of texts) for (let i = 0; i + length <= text.length; i++) runs.add(text.slice(i, i + length))
  return [...runs]
}

/** What a text becomes inside a JSON string: a serialized tool input or a request body. Without the quotes. */
export const jsonEscaped = (text: string): string => JSON.stringify(text).slice(1, -1)

const SHORT_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '/': '/' }

/**
 * A text with every escape sequence replaced by the character it names (`\u0040`, `\x40`, `\n`, `\"`, any number of backslashes
 * before it, and a run of backslashes that names nothing is one), until nothing changes. Written here, apart from the scrub's own
 * unescape, so a mistake in one is not a mistake in the other.
 */
export function unescaped(text: string): string {
  let current = text
  for (let pass = 0; pass < 32; pass++) {
    const next = current
      .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\+x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\+([bfnrt"/])/g, (_, c: string) => SHORT_ESCAPES[c] ?? c)
      .replace(/\\{2,}/g, '\\')
    if (next === current) return next
    current = next
  }
  return current
}

/** The forms a fragment can take: as written, as JSON-escaped (in a serialized input or a body), and with its escapes replaced. Each once. */
export const formsOf = (text: string): string[] => [...new Set([text, jsonEscaped(text), unescaped(text)])]

/**
 * The forms a string is read in: as written, and with its escapes replaced, so layers of escaping, a serialized input and a body
 * are read as the text they hold. A fragment's JSON-escaped form is among the needles, so the string need not be escaped as well.
 */
const readingsOf = (text: string): string[] => [...new Set([text, unescaped(text)])]

/**
 * The first fragment of the secrets found in any of the strings, in any form, or `undefined`. A fragment is a run of 16 characters
 * of a secret, taken from the secret as written, as JSON-escaped and unescaped; and each of `parts`, whole, for a secret whose
 * parts are shorter than a run (the local part and the domain of an address). Each string is read as written and unescaped, so a
 * leak is found whatever form it is in: raw, in a serialized input, or with layers of escapes.
 */
export function findFragment(strings: readonly string[], secrets: readonly string[], parts: readonly string[] = []): string | undefined {
  const needles = [...new Set([...runsOf(secrets.flatMap(formsOf)), ...parts.flatMap(formsOf)])]
  for (const text of strings) {
    for (const form of readingsOf(text)) {
      for (const needle of needles) if (form.includes(needle)) return needle
    }
  }
  return undefined
}

/** Every string the view holds, read directly: each stimulus text and each tool-traffic line. */
export const renderedStrings = (rendered: RenderedSessions): string[] => rendered.scopes.flatMap((scope) => scope.stimuli.flatMap((stimulus) => [stimulus.text, ...stimulus.traffic]))

/** Every string a request holds: the message text the model is sent (system and user), and the request serialized, as a body is. */
export const requestStrings = (transport: { requests: readonly CompleteRequest[] }): string[] => transport.requests.flatMap((r) => [r.system, r.user, JSON.stringify({ model: r.model, system: r.system, user: r.user })])

/** What the transport was sent, as one string. */
export const sentText = (transport: { requests: readonly CompleteRequest[] }): string => transport.requests.map((r) => `${r.system}\n${r.user}`).join('\n')

/** Throws when a fragment of the secrets is in the view. */
export function assertViewHoldsNoFragment(rendered: RenderedSessions, secrets: readonly string[], label: string, parts: readonly string[] = []): void {
  if (findFragment(renderedStrings(rendered), secrets, parts) !== undefined) throw new Error(`${label}: the view holds a fragment of the secret`)
}

/** Throws when a fragment of the secrets is in any request. */
export function assertRequestsHoldNoFragment(transport: { requests: readonly CompleteRequest[] }, secrets: readonly string[], label: string, parts: readonly string[] = []): void {
  if (findFragment(requestStrings(transport), secrets, parts) !== undefined) throw new Error(`${label}: a request holds a fragment of the secret`)
}

export interface FragmentOptions {
  /** Whole strings to look for besides the runs: for a secret whose parts are shorter than a run. */
  parts?: readonly string[]
}

/**
 * Asserts that no fragment of the secrets (see `findFragment`) is in the rendered view, read string by string, or in any request the
 * labeler sends for it. The view's chunk is sent through the real pre-send guard and must go out (coverage complete): withholding is
 * not a refusal.
 */
export async function assertNoFragments(call: { input?: Record<string, unknown>; output?: string; user?: string }, secrets: readonly string[], label: string, options: FragmentOptions = {}): Promise<{ strings: string[]; rendered: RenderedSessions }> {
  const { f, rendered } = viewOf(call)
  assertViewHoldsNoFragment(rendered, secrets, label, options.parts)
  const scope = rendered.scopes[0]
  if (!scope) throw new Error('no scope')
  const { transport, run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
  expect([label, run.coverageComplete]).toEqual([label, true])
  assertRequestsHoldNoFragment(transport, secrets, label, options.parts)
  return { strings: renderedStrings(rendered), rendered }
}

/** As `assertNoFragments`, and the text must have been withheld: the placeholder is in a rendered string and a counter says so. */
export async function assertWithheld(call: { input?: Record<string, unknown>; output?: string; user?: string }, secrets: readonly string[], label: string, options: FragmentOptions = {}): Promise<void> {
  const { strings, rendered } = await assertNoFragments(call, secrets, label, options)
  const { scrubbedOutputs, scrubbedInputs, scrubbedStimuli } = rendered.counters
  expect([label, strings.some((text) => text.includes(SCRUB_PLACEHOLDER)), scrubbedOutputs + scrubbedInputs + scrubbedStimuli >= 1]).toEqual([label, true, true])
}
