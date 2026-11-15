/**
 * Gated host probe ($0, scripted provider): the trimmed Systematic stack runs under the replay harness, a seeded session with
 * `ce:plan` already loaded imports and continues with both method skills listed, and a scripted `task` call shows whether
 * child-session events reach `--format json`. Run with `METACOGS_HOST_PROBES=1`. The needed registry install happens once, online.
 *
 * `METACOGS_PROBE_OUT`, when set, is a file the observations are written to as JSON (ids, names and counts only).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { disposeFixtures, type PackedPlugin, packedPlugin } from '../../../plugin/fixture'
import { parseEvents } from '../../../runner/events'
import { type RecordedRequest, type ScriptedStep, type ScriptRequest, skillCallStep } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { armMessage } from './gates'
import { createHostExecutor, defaultBaseDir, type Executor, type HostResult, prepareBase, resolveHarness } from './host'
import { runAttempt } from './run'
import { type StackProfile, SYSTEMATIC_PIN, workflowPermission, workflowStack } from './stack'
import { buildExport, type FixtureSpec, loadFrozen } from './store'
import { approvedFixture, newLab } from './test-support'

const harnessOrNone = (): string => {
  try {
    return resolveHarness()
  } catch {
    return ''
  }
}
const HARNESS = harnessOrNone()
const LUNA = 'openai/gpt-6-luna'
/** The owner's Systematic config is read; no other owner directory is. */
const OWNER = { opencodeDir: join(homedir(), '.config', 'opencode'), cortexkitDir: null }
const TIMEOUT = 1_800_000
const WORKFLOW_MARKER = 'workflow skill marker 7c1e'

const spec: FixtureSpec = {
  id: 'probe-plan-loaded',
  kind: 'workflow',
  expected: 'fire',
  methods: ['counterfactual'],
  provenance: { project: 'synthetic', source_session: 'synthetic', cutoff_message: 'synthetic', date: '2026-11-15' },
  expected_outcome_ref: 'synthetic',
  somewhere: '',
  turns: [
    { role: 'user', text: 'Plan the change to the retry budget.' },
    {
      role: 'assistant',
      text: 'Loading the planning workflow.',
      tools: [{ callID: 'call_plan1', tool: 'systematic_skill', input: { name: 'ce:plan' }, output: `<skill_content name="systematic:ce:plan">\n# ce:plan\n\n${WORKFLOW_MARKER}\n</skill_content>` }],
    },
    { role: 'user', text: 'Go ahead and settle the open fork.' },
    { role: 'assistant', text: 'Two options remain for the retry budget; I will settle them next.' },
  ],
}

const bodyOf = (r: RecordedRequest): { messages?: { role: string; content?: unknown }[]; tools?: { function: { name: string; description?: string } }[] } => (r.body ?? {}) as never
const toolsOf = (r: RecordedRequest): string[] => (bodyOf(r).tools ?? []).map((t) => t.function.name)
const systemOf = (r: RecordedRequest): string => (bodyOf(r).messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
const mentions = (text: string, skill: string): boolean => text.includes(`<name>${skill}</name>`)

const observed: Record<string, unknown> = {}
const record = (key: string, value: unknown): void => {
  observed[key] = value
  if (process.env.METACOGS_PROBE_OUT) writeFileSync(process.env.METACOGS_PROBE_OUT, `${JSON.stringify(observed, null, 2)}\n`)
}

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS))('the Systematic workflow stack on the replay harness (scripted provider, $0)', () => {
  let packed!: PackedPlugin
  let baseDir = ''
  const stack = workflowStack()

  const executorFor = (profile: StackProfile, script?: (r: ScriptRequest) => ScriptedStep | undefined): Executor => createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack: profile, ...(script ? { script: (_arm, r) => script(r) } : {}) })
  const job = () => ({ fixtureId: spec.id, seed: buildExport(spec, { agent: stack.defaultAgent }), model: LUNA, arm: 'continue-a' as const, message: armMessage('continue-a', spec)!, timeoutMs: 240_000 })

  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, stack.npmPlugins), owner: OWNER, stack, log: (l) => console.log(l) })
  }, TIMEOUT)

  afterAll(() => disposeFixtures(), 300_000)

  test('Systematic loads under the harness, and the seeded ce:plan session continues with both method skills listed', async () => {
    const r: HostResult = await executorFor(stack)(job())
    try {
      const failed = r.stack?.checks.filter((c) => !c.passed) ?? []
      record('stack', { ran: r.ran, passed: r.stack?.passed ?? null, failed: failed.map((c) => `${c.name}: ${c.detail}`), summary: r.stackSummary, systematic: r.systematic ?? null })
      expect(failed).toEqual([])
      expect(r.ran).toBe(true)
      expect(r.stackSummary?.plugins).toEqual([SYSTEMATIC_PIN, packed.spec])

      const mains = r.requests.filter((q) => q.hasTools)
      expect(mains.length).toBeGreaterThan(0)
      const first = mains[0]!
      const tools = toolsOf(first)
      const bodies = JSON.stringify(first.body)
      const events = parseEvents(r.stdout)
      record('continuation', {
        main_requests: mains.length,
        tools_offered: tools,
        question_offered: tools.includes('question'),
        task_offered: tools.includes('task'),
        systematic_skill_offered: tools.includes('systematic_skill'),
        seeded_workflow_text_reached_provider: bodies.includes(WORKFLOW_MARKER),
        continue_reached_provider: bodies.includes('Continue.'),
        counterfactual_listed: { system: mentions(systemOf(first), 'counterfactual'), tools: (bodyOf(first).tools ?? []).some((t) => mentions(t.function.description ?? '', 'counterfactual')) },
        synthesis_listed: { system: mentions(systemOf(first), 'synthesis'), tools: (bodyOf(first).tools ?? []).some((t) => mentions(t.function.description ?? '', 'synthesis')) },
        event_types: [...new Set(events.events.map((e) => e.type))],
        exit_code: r.exitCode,
        assistants: r.assistants,
        host_version: r.hostVersion,
      })
      expect(tools).toContain('systematic_skill')
      expect(tools).not.toContain('question')
      expect(tools).not.toContain('task')
      expect(bodies).toContain(WORKFLOW_MARKER)
      expect(bodies).toContain('Continue.')
      expect(r.exitCode).toBe(0)
      for (const method of ['counterfactual', 'synthesis']) {
        const listed = mentions(systemOf(first), method) || (bodyOf(first).tools ?? []).some((t) => mentions(t.function.description ?? '', method))
        expect(listed).toBe(true)
      }
    } finally {
      r.cleanup()
    }
  }, TIMEOUT)

  /** One scripted attempt through the real attempt runner on the real host: the detector reads what the host streamed, and the gates judge the request. */
  const scriptedAttempt = async (step: ScriptedStep): Promise<Awaited<ReturnType<typeof runAttempt>>> => {
    const lab = newLab()
    try {
      approvedFixture(lab.store, spec)
      const script = (q: ScriptRequest): ScriptedStep | undefined => (q.hasTools && q.turnRound === 0 ? step : undefined)
      return await runAttempt({ store: lab.store, key: { campaign: 'probe', fixture: spec.id, model: LUNA, arm: 'continue-a' }, fixture: loadFrozen(lab.store, spec.id), executor: executorFor(stack, script), provider: 'scripted', timeoutMs: 240_000 })
    } finally {
      lab.dispose()
    }
  }

  test('a scripted attempt that loads counterfactual through the host skill tool is a hit, and one that loads nothing is a miss', async () => {
    const hit = await scriptedAttempt(skillCallStep('counterfactual'))
    const miss = await scriptedAttempt({ text: 'I will settle the fork directly.' })
    record('scripted_attempts', {
      hit: { status: hit.status, reasons: hit.reasons, outcome: hit.outcome, workflow: hit.workflow ?? null, observed: hit.observed?.workflow ?? null, systematic: hit.systematic ?? null },
      miss: { status: miss.status, reasons: miss.reasons, outcome: miss.outcome, workflow: miss.workflow ?? null, observed: miss.observed?.workflow ?? null },
    })
    expect(hit).toMatchObject({ status: 'completed', outcome: 'hit', workflow: { expected: 'fire', hit: true, false_fire: false, wrong_method: [] } })
    expect(hit.observed?.workflow).toMatchObject({ methodLoads: ['counterfactual'] })
    expect(hit.systematic?.spec).toBe(SYSTEMATIC_PIN)
    expect(miss).toMatchObject({ status: 'completed', outcome: 'miss', workflow: { hit: false } })
    expect(miss.observed?.workflow).toMatchObject({ methodLoads: [], methodFileOpens: [] })
  }, TIMEOUT)

  test('a real systematic_skill load of ce:review is a workflow load, never a method load', async () => {
    const r = await scriptedAttempt({ toolCalls: [{ id: 'call_sys', name: 'systematic_skill', arguments: { name: 'ce:review' } }] })
    record('systematic_skill_load', { status: r.status, outcome: r.outcome, observed: r.observed?.workflow ?? null, skill_loads: r.observed?.skill_loads ?? null })
    expect(r.status).toBe('completed')
    expect(r.observed?.workflow).toMatchObject({ workflowLoads: ['ce:review'], methodLoads: [] })
    expect(r.outcome).toBe('miss')
  }, TIMEOUT)

  test('whether child-session events reach --format json when a scripted model calls task (task allowed for this probe only)', async () => {
    const withTask: StackProfile = { ...stack, permission: { ...workflowPermission(), task: 'allow' }, agent: { explore: { disable: true } } }
    const script = (q: ScriptRequest): ScriptedStep | undefined => {
      if (!q.hasTools) return undefined
      const last = JSON.stringify([...q.messages].reverse().find((m) => (m as { role?: string }).role === 'user') ?? '')
      if (last.includes('CHILD_TASK_MARKER')) return q.turnRound === 0 ? undefined : { text: 'child done' }
      if (!last.includes('Continue.')) return undefined
      return q.turnRound === 0 ? { toolCalls: [{ id: 'call_task1', name: 'task', arguments: { description: 'child job', prompt: 'CHILD_TASK_MARKER say hello', subagent_type: 'general' } }] } : { text: 'finished' }
    }
    const r = await executorFor(withTask, script)(job())
    try {
      const events = parseEvents(r.stdout).events
      const sessions = new Set(events.map((e) => e.sessionID).filter((s): s is string => typeof s === 'string'))
      const taskUses = events.filter((e) => e.type === 'tool_use' && e.part?.tool === 'task')
      const childRequests = r.requests.filter((q) => JSON.stringify(q.body).includes('CHILD_TASK_MARKER'))
      const taskOutput = taskUses.map((e) => (typeof (e.part?.state as { output?: unknown } | undefined)?.output === 'string' ? ((e.part?.state as { output: string }).output).slice(0, 160) : null))
      record('child_session', {
        ran: r.ran,
        stack_passed: r.stack?.passed ?? null,
        task_tool_uses: taskUses.length,
        task_statuses: taskUses.map((e) => (e.part?.state as { status?: unknown } | undefined)?.status ?? null),
        task_output_head: taskOutput,
        provider_saw_child_prompt: childRequests.length > 0,
        distinct_session_ids_in_events: sessions.size,
        event_types: [...new Set(events.map((e) => e.type))],
        child_events_appear: sessions.size > 1,
      })
      expect(r.ran).toBe(true)
      expect(childRequests.length).toBeGreaterThan(0)
    } finally {
      r.cleanup()
    }
  }, TIMEOUT)
})
