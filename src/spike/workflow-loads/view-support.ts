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

import { type Chunk, chunkScope, renderSessions, renderStimulusBlock } from './mask'
import { holdsSecret } from './scrub'
import { freezeManifest, openPrivateRoot, walkManifest } from './store'
import { gatedRepo, SAMPLE_RULE_TEXT, seedWorkflowSession, syntheticStore } from './test-support'

/** Teardown callbacks of the fixtures made so far; each test file empties it in an `afterEach`. */
export const cleanup: (() => void)[] = []

export function fixture() {
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
export function viewOf(call: { input?: Record<string, unknown>; output?: string; tool?: string; user?: string }) {
  const f = fixture()
  seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
  f.store.addText(f.store.addMessage('ses_a', 'user'), call.user ?? 'go on')
  f.store.addTool(f.store.addMessage('ses_a', 'assistant'), { tool: call.tool ?? (call.input ? 'write' : 'bash'), input: call.input ?? { command: 'cat f' }, output: call.output ?? 'ok' })
  const input = { git: f.repo.git, db: f.store.path, privateRoot: f.privateRoot }
  freezeManifest(input)
  return { f, rendered: renderSessions(walkManifest({ ...input, skillBodies: { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] } })) }
}

export function scriptedTransport(): LabelerTransport & { requests: CompleteRequest[] } {
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

export async function sendChunk(f: ReturnType<typeof fixture>, chunks: readonly Chunk[]) {
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
