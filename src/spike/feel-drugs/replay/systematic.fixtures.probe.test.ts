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
import { parseEvents, toolUses } from '../../../runner/events'
import type { RecordedRequest, ScriptedStep, ScriptRequest } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { armMessage } from './gates'
import { createHostExecutor, defaultBaseDir, prepareBase, resolveHarness } from './host'
import { expectedRepo } from './repo'
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
const REPOS = join(import.meta.dir, '../../../../evals/spikes/systematic-reflection/fixtures/repo')
const repoOf = (id: string): unknown => JSON.parse(readFileSync(join(REPOS, `${id}.json`), 'utf8'))
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
        buildFixture(lab.store, spec, { systematicTree: TREE, repo: repoOf(spec.id) })
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

/**
 * The seeded repository, $0 on the scripted provider: the continuation re-issues every file call the seed made, at the paths the
 * seed shows (now pointing at the workspace), plus git. The reads must succeed and return what the seed showed.
 */
describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS) || !TREE)('a seeded read of a repository file succeeds inside the attempt (scripted provider, $0)', () => {
  let packed!: PackedPlugin
  let baseDir = ''
  const stack = workflowStack()

  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, stack.npmPlugins), owner: OWNER, stack, log: (l) => console.log(l) })
  }, TIMEOUT)
  afterAll(() => disposeFixtures(), 300_000)

  interface Reissue {
    tool: string
    args: Record<string, unknown>
    seeded: string
  }
  const FILE_TOOLS = ['read', 'glob', 'grep']

  for (const spec of committed()) {
    test(`${spec.id}: every seeded read, glob and grep completes in the workspace, reads match the seed, and git sees the history`, async () => {
      const lab = newLab()
      const reissued: Reissue[] = []
      try {
        buildFixture(lab.store, spec, { systematicTree: TREE, repo: repoOf(spec.id) })
        freezeFixture(lab.store, spec.id)
        approveFixture(lab.store, spec.id)
        const fixture = loadFrozen(lab.store, spec.id)
        const script = (_arm: string, q: ScriptRequest): ScriptedStep | undefined => {
          if (!q.hasTools || !q.main) return undefined
          if (q.turnRound > 0) return { text: 'Checked.' }
          const messages = q.messages as Msg[]
          const outputs = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id ?? '', textOf(m)]))
          for (const call of messages.flatMap((m) => m.tool_calls ?? [])) {
            if (!FILE_TOOLS.includes(call.function.name)) continue
            reissued.push({ tool: call.function.name, args: JSON.parse(call.function.arguments) as Record<string, unknown>, seeded: outputs.get(call.id) ?? '' })
          }
          const git = spec.id.startsWith('tune-review-') ? 'git rev-parse --abbrev-ref HEAD && git log --oneline origin/main..HEAD && git diff --name-only origin/main && git status --short' : 'git log --oneline -3 && git status --short'
          return { toolCalls: [...reissued.map((r, i) => ({ id: `again-${i}`, name: r.tool, arguments: r.args })), { id: 'again-git', name: 'bash', arguments: { command: git, description: 'git state' } }] }
        }
        const executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script })
        const r = await executor({ fixtureId: spec.id, seed: fixture.export, model: LUNA, arm: 'continue-a', message: armMessage('continue-a', fixture.spec)!, timeoutMs: 240_000, ...(fixture.repo ? { repo: fixture.repo } : {}) })
        try {
          expect(r.ran).toBe(true)
          expect(r.repo).toMatchObject({ clean: true, files: expectedRepo(fixture.repo!).files, commits: fixture.repo!.commits.length })
          expect(r.repo!.seed_path_rewrites).toBeGreaterThan(0)
          expect(r.repo!.skill_files).toBeGreaterThan(0)
          const uses = toolUses(parseEvents(r.stdout).events)
          const files = reissued.map((_, i) => uses.find((u) => u.callID === `again-${i}`)!)
          expect(reissued.length).toBeGreaterThan(0)
          expect(files.every((u) => u !== undefined)).toBe(true)
          const rows: Record<string, unknown>[] = []
          files.forEach((u, i) => {
            const want = reissued[i]!
            rows.push({ tool: u.tool, args: want.args, status: u.status, same_as_seed: u.output === want.seeded, output_head: (u.output ?? '').slice(0, 160) })
            expect(u.status).toBe('completed')
            if (want.tool === 'read' && want.seeded.startsWith('<path>')) expect(u.output).toBe(want.seeded)
            if (want.tool === 'glob' && want.seeded !== 'No files found') for (const p of want.seeded.split('\n')) expect(u.output).toContain(p)
          })
          const bash = uses.find((u) => u.tool === 'bash')!
          expect(bash.status).toBe('completed')
          if (spec.id.startsWith('tune-review-')) {
            expect(bash.output).toContain('feat/settlement-retry')
            expect(bash.output).toContain('feat: retry transient capture failures in the settlement job')
            expect(bash.output).toContain('src/settlement/retry.ts')
          } else expect(bash.output).toContain('snapshot of the repository the session read')
          record(`${spec.id}:repo`, { files: rows, bash: bash.output?.split('\n').length, rewrites: r.repo!.seed_path_rewrites, skill_files: r.repo!.skill_files, head: r.repo!.head.slice(0, 12), read_paths_in_workspace: reissued.filter((x) => typeof x.args.filePath === 'string').every((x) => !String(x.args.filePath).startsWith('/workspace/')) })
        } finally {
          r.cleanup()
        }
      } finally {
        lab.dispose()
      }
    }, TIMEOUT)
  }

  test('a fixture whose repository is wrong is not run: the host reports it, no request reaches the provider, and the attempt is excluded', async () => {
    const spec = committed()[0]!
    const lab = newLab()
    try {
      buildFixture(lab.store, spec, { systematicTree: TREE, repo: repoOf(spec.id) })
      freezeFixture(lab.store, spec.id)
      approveFixture(lab.store, spec.id)
      const fixture = loadFrozen(lab.store, spec.id)
      // The host is asked for a repository whose skills the installed package does not hold, so what it reads back differs from the declaration.
      const broken = { ...fixture.repo!, systematic_skills: ['no-such-skill'] }
      const executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script: () => undefined })
      const attempt = await runAttempt({ store: lab.store, key: { campaign: 'fixtures', fixture: spec.id, model: LUNA, arm: 'continue-a' }, fixture: { ...fixture, repo: broken }, executor, provider: 'scripted', timeoutMs: 240_000 })
      expect(attempt).toMatchObject({ status: 'excluded', reasons: ['seeded_repo_missing'], outcome: null, requests: { total: 0 } })
      record('missing-repo-attempt', { status: attempt.status, reasons: attempt.reasons, detail: attempt.gates?.checks[0]?.detail })
    } finally {
      lab.dispose()
    }
  }, TIMEOUT)
})
