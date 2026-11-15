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

/** Every distinct run of `length` characters of the texts: a distinguishing fragment of a secret is any one of them. */
export function runsOf(texts: readonly string[], length = 16): string[] {
  const runs = new Set<string>()
  for (const text of texts) for (let i = 0; i + length <= text.length; i++) runs.add(text.slice(i, i + length))
  return [...runs]
}

/** What the transport was sent, as one string. */
export const sentText = (transport: { requests: readonly CompleteRequest[] }): string => transport.requests.map((r) => `${r.system}\n${r.user}`).join('\n')

/**
 * Asserts that no run of 16 characters of the secrets is in the rendered view or in any request the labeler sends for it. The view's
 * chunk is sent through the real pre-send guard and must go out (coverage complete): withholding is not a refusal.
 */
export async function assertNoFragments(call: { input?: Record<string, unknown>; output?: string; user?: string }, secrets: readonly string[], label: string): Promise<{ shown: string; rendered: RenderedSessions }> {
  const { f, rendered } = viewOf(call)
  const shown = JSON.stringify(rendered.scopes)
  const runs = runsOf(secrets)
  for (const run of runs) if (shown.includes(run)) throw new Error(`${label}: the view holds a fragment of the secret`)
  const scope = rendered.scopes[0]
  if (!scope) throw new Error('no scope')
  const { transport, run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
  expect([label, run.coverageComplete]).toEqual([label, true])
  const sent = sentText(transport)
  for (const fragment of runs) if (sent.includes(fragment)) throw new Error(`${label}: a request holds a fragment of the secret`)
  return { shown, rendered }
}

/** As `assertNoFragments`, and the text must have been withheld: the placeholder is in the view and a counter says so. */
export async function assertWithheld(call: { input?: Record<string, unknown>; output?: string; user?: string }, secrets: readonly string[], label: string): Promise<void> {
  const { shown, rendered } = await assertNoFragments(call, secrets, label)
  const { scrubbedOutputs, scrubbedInputs, scrubbedStimuli } = rendered.counters
  expect([label, shown.includes(SCRUB_PLACEHOLDER), scrubbedOutputs + scrubbedInputs + scrubbedStimuli >= 1]).toEqual([label, true, true])
}
