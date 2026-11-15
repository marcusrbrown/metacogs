/**
 * Gated host probe ($0, scripted provider): every committed tuning fixture builds from a Systematic tree, imports on the trimmed
 * stack, and reaches the provider ending on its intended pre-decision message, then "Continue.". The scripted model answers with
 * plain text, so no method loads and the attempt tallies as a miss on a fire fixture and as silence on a control.
 *
 * Run with `METACOGS_HOST_PROBES=1 METACOGS_SYSTEMATIC_TREE=<dir>`, where `<dir>` is an extracted `@fro.bot/systematic` package
 * (the directory that holds `skills/`). `METACOGS_PROBE_OUT`, when set, is a file the observations are written to as JSON
 * (ids, names and counts only).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { disposeFixtures, type PackedPlugin, packedPlugin } from '../../../plugin/fixture'
import type { RecordedRequest } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { armMessage } from './gates'
import { createHostExecutor, defaultBaseDir, prepareBase, resolveHarness } from './host'
import { runAttempt } from './run'
import { workflowStack } from './stack'
import { buildFixture, type FixtureSpec, freezeFixture, approveFixture, loadFrozen, parseSpec } from './store'
import { newLab } from './test-support'

const harnessOrNone = (): string => {
  try {
    return resolveHarness()
  } catch {
    return ''
  }
}
const HARNESS = harnessOrNone()
const TREE = process.env.METACOGS_SYSTEMATIC_TREE ?? ''
const FIXTURES = join(import.meta.dir, '../../../../evals/spikes/systematic-reflection/fixtures/tune')
const LUNA = 'openai/gpt-6-luna'
const OWNER = { opencodeDir: join(homedir(), '.config', 'opencode'), cortexkitDir: null }
const TIMEOUT = 1_800_000

interface Msg {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}
const messagesOf = (r: RecordedRequest): Msg[] => ((r.body ?? {}) as { messages?: Msg[] }).messages ?? []
const textOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))

const observed: Record<string, unknown> = {}
const record = (key: string, value: unknown): void => {
  observed[key] = value
  if (process.env.METACOGS_PROBE_OUT) writeFileSync(process.env.METACOGS_PROBE_OUT, `${JSON.stringify(observed, null, 2)}\n`)
}

const committed = (): FixtureSpec[] =>
  existsSync(FIXTURES)
    ? readdirSync(FIXTURES)
        .sort()
        .map((f) => parseSpec(JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))))
    : []

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS) || !TREE)('the committed tuning fixtures on the trimmed stack (scripted provider, $0)', () => {
  let packed!: PackedPlugin
  let baseDir = ''
  const stack = workflowStack()

  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, stack.npmPlugins), owner: OWNER, stack, log: (l) => console.log(l) })
  }, TIMEOUT)
  afterAll(() => disposeFixtures(), 300_000)

  for (const spec of committed()) {
    test(`${spec.id} imports, ends where intended, and is followed by "Continue."`, async () => {
      const lab = newLab()
      try {
        buildFixture(lab.store, spec, { systematicTree: TREE })
        freezeFixture(lab.store, spec.id)
        approveFixture(lab.store, spec.id)
        const fixture = loadFrozen(lab.store, spec.id)
        const executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script: (_arm, q) => (q.hasTools && q.turnRound === 0 ? { text: 'Noted.' } : undefined) })
        const attempt = await runAttempt({ store: lab.store, key: { campaign: 'fixtures', fixture: spec.id, model: LUNA, arm: 'continue-a' }, fixture, executor, provider: 'scripted', timeoutMs: 240_000 })

        // The same request the attempt scored: re-run once to read what the provider was sent.
        const seen: RecordedRequest[] = []
        const probe = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script: (_arm, q) => (q.hasTools && q.turnRound === 0 ? { text: 'Noted.' } : undefined) })
        const r = await probe({ fixtureId: spec.id, seed: fixture.export, model: LUNA, arm: 'continue-a', message: armMessage('continue-a', fixture.spec)!, timeoutMs: 240_000 })
        try {
          seen.push(...r.requests)
          const main = r.requests.find((q) => q.hasTools)!
          const messages = messagesOf(main)
          const userTexts = messages.filter((m) => m.role === 'user').map(textOf)
          const lastUser = userTexts.at(-1)!
          const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content !== '')
          const seededUsers = spec.turns.filter((t) => t.role === 'user').map((t) => t.text)
          const seededLast = spec.turns.at(-1)!
          const toolCalls = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name)
          const wanted = spec.turns.flatMap((t) => (t.role === 'assistant' ? (t.tools ?? []).map((c) => c.tool) : []))
          const placeholderText = JSON.stringify(messages).includes('{{systematic-')
          const names = (main.body as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name) ?? []
          record(spec.id, {
            ran: r.ran,
            stack_passed: r.stack?.passed ?? null,
            exit_code: r.exitCode,
            user_messages_seen: userTexts.length,
            user_turns_seeded: seededUsers.length,
            last_user: lastUser,
            seeded_tool_calls: wanted.length,
            tool_calls_in_history: toolCalls.length,
            last_assistant_matches_seed: lastAssistantText ? textOf(lastAssistantText) === (seededLast as { text: string }).text : null,
            placeholder_text_reached_provider: placeholderText,
            tools_offered: names,
            attempt: { status: attempt.status, reasons: attempt.reasons, outcome: attempt.outcome, workflow: attempt.workflow ?? null },
          })
          expect(r.ran).toBe(true)
          expect(r.stack?.passed).toBe(true)
          expect(r.exitCode).toBe(0)
          expect(userTexts.slice(0, seededUsers.length)).toEqual(seededUsers)
          expect(lastUser).toBe('Continue.')
          expect(userTexts).toHaveLength(seededUsers.length + 1)
          expect(toolCalls).toEqual(wanted)
          expect(lastAssistantText && textOf(lastAssistantText)).toBe((seededLast as { text: string }).text)
          expect(placeholderText).toBe(false)
          expect(names).toContain('systematic_skill')
          expect(names).not.toContain('question')
          expect(names).not.toContain('task')
          expect(attempt).toMatchObject({ status: 'completed', outcome: spec.expected === 'fire' ? 'miss' : 'silent' })
        } finally {
          r.cleanup()
        }
        expect(seen.length).toBeGreaterThan(0)
      } finally {
        lab.dispose()
      }
    }, TIMEOUT)
  }
})
