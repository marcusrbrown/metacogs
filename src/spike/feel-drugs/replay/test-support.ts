/** Hand-built requests, events and a fake host for the replay tests. Synthetic text only. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RecordedRequest } from '../../../runner/scripted-provider'
import type { AssistantInfo, GateInput } from './gates'
import type { AttemptJob, Executor, HostResult } from './host'
import { approveFixture, buildFixture, type FixtureSpec, freezeFixture, HOST_VERSION, openStore, type Store } from './store'

export const SKILLS_DIR = '/pkg/plugin/skills'
export const MODEL = 'anthropic/claude-opus-5-5'
export const SEED_USER = ['The build fails after the upgrade.', 'Still failing.']

export const SYNTHETIC_SPEC: FixtureSpec = {
  id: 'moment-a',
  kind: 'feel',
  provenance: { project: 'project-a', source_session: 'ses_source', cutoff_message: 'msg_cutoff', date: '2026-11-01' },
  expected_outcome_ref: 'synthetic',
  somewhere: 'in the gap between the test and the fix',
  turns: [
    { role: 'user', text: SEED_USER[0]! },
    { role: 'assistant', text: 'Checking the lockfile.', tools: [{ callID: 'call_read1', tool: 'read', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' }] },
    { role: 'user', text: SEED_USER[1]! },
    { role: 'assistant', text: 'Trying a clean install.' },
  ],
}

export const TOOL_NAMES = ['read', 'task', 'feel', 'drugs', 'skill']

/** The text OpenCode builds for a typed command: the skill, the base-directory note, then the arguments. */
export function skillText(name: string, args: string, dir = `${SKILLS_DIR}/${name}`): string {
  return `# ${name}\n\nCall the \`${name}\` tool.\n\nBase directory for this skill: ${dir}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\n\n${args}`
}

export interface ChatOptions {
  model?: string
  returnedModel?: string
  tools?: string[]
  /** The last user message's text parts. */
  last: string[]
  history?: string[]
  system?: string
}

/** A chat-completions request; the history is user turns only, enough for the seed check. */
export function chatRequest(o: ChatOptions): RecordedRequest {
  const model = (o.model ?? MODEL).slice((o.model ?? MODEL).indexOf('/') + 1)
  const tools = o.tools ?? TOOL_NAMES
  return {
    hasTools: tools.length > 0,
    round: 0,
    returnedModel: o.returnedModel ?? model,
    body: {
      model,
      messages: [
        { role: 'system', content: o.system ?? 'You are the orchestrator.' },
        ...(o.history ?? SEED_USER).map((text) => ({ role: 'user', content: text })),
        { role: 'user', content: o.last.map((text) => ({ type: 'text', text })) },
      ],
      tools: tools.map((name) => ({ type: 'function', function: { name } })),
    },
  }
}

export const titleRequest = (returnedModel = 'claude-haiku-5-5'): RecordedRequest => ({
  hasTools: false,
  round: 0,
  returnedModel,
  body: { model: returnedModel, messages: [{ role: 'system', content: 'You are a title generator.' }, { role: 'user', content: 'x' }] },
})

export const OK_ASSISTANT: AssistantInfo = { agent: 'orchestrator', providerID: 'anthropic', modelID: 'claude-opus-5-5' }

/** A passing gate input for one arm; tests change one thing and expect one reason. */
export function gateInput(over: Partial<GateInput> & Pick<GateInput, 'arm' | 'message'>): GateInput {
  const text = over.message.kind === 'command' ? skillText(over.message.name, over.message.args.join(' ')) : over.message.text
  return {
    model: MODEL,
    expectedHostVersion: HOST_VERSION,
    hostVersion: HOST_VERSION,
    skillsDir: SKILLS_DIR,
    requests: [titleRequest(), chatRequest({ last: [`§12§ ${text}`, '<system-reminder>x</system-reminder>'] })],
    seedUserTurns: SEED_USER,
    assistants: [OK_ASSISTANT],
    partTypes: ['text', 'step-start'],
    eventTypes: ['step_start', 'text', 'step_finish'],
    ...over,
  }
}

// ── events ─────────────────────────────────────────────────────────────────

const line = (event: unknown): string => `${JSON.stringify(event)}\n`
export const textEvent = (text: string): string => line({ type: 'text', timestamp: 1, part: { type: 'text', text } })
export const stepFinish = (cost = 0): string => line({ type: 'step_finish', timestamp: 2, part: { type: 'step-finish', cost, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
export const toolEvent = (tool: string, input: unknown, status = 'completed', output = 'ok'): string => line({ type: 'tool_use', timestamp: 1, part: { type: 'tool', tool, callID: `call_${tool}`, state: { status, input, output, time: { start: 1, end: 2 } } } })
export const stdoutOf = (...events: string[]): string => events.join('')

// ── a fake host ────────────────────────────────────────────────────────────

export interface FakeHostOptions {
  /** Change the result of one job. */
  tweak?: (job: AttemptJob, result: HostResult) => HostResult | Promise<HostResult>
  /** Throw instead of returning. */
  explode?: (job: AttemptJob) => Error | undefined
  /** Cost the fake host reports per attempt. */
  cost?: number
  stdoutExtra?: (job: AttemptJob) => string
}

/** What a healthy host leaves for a job: the seed, the arm message, a text reply, the right model and agent. */
export function healthyResult(job: AttemptJob, o: FakeHostOptions = {}): HostResult {
  const text = job.message.kind === 'command' ? skillText(job.message.name, job.message.args.join(' ')) : job.message.text
  const requests = [titleRequest(), chatRequest({ model: job.model, last: [`§3§ ${text}`, '<system-reminder>r</system-reminder>'] })]
  const now = new Date('2026-11-07T12:00:00.000Z').toISOString()
  return {
    hostVersion: HOST_VERSION,
    requests,
    stdout: stdoutOf(textEvent('scripted reply'), stepFinish(o.cost ?? 0), o.stdoutExtra?.(job) ?? ''),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    ran: true,
    startedAt: now,
    endedAt: now,
    wallMs: 5,
    stack: { passed: true, checks: [] },
    stackSummary: { plugins: ['a', 'b'], default_agent: 'orchestrator', mcp_entries: 0 },
    assistants: [{ agent: 'orchestrator', providerID: job.model.split('/')[0]!, modelID: job.model.split('/')[1]! }],
    partTypes: ['text'],
    leakDirs: [],
    cleanup: () => {},
  }
}

export function fakeExecutor(o: FakeHostOptions = {}): { executor: Executor; jobs: AttemptJob[] } {
  const jobs: AttemptJob[] = []
  const executor: Executor = async (job) => {
    jobs.push(job)
    const boom = o.explode?.(job)
    if (boom) throw boom
    const result = healthyResult(job, o)
    return o.tweak ? o.tweak(job, result) : result
  }
  return { executor, jobs }
}

// ── stores ─────────────────────────────────────────────────────────────────

export interface Lab {
  store: Store
  root: string
  dispose(): void
}

export function newLab(): Lab {
  const root = mkdtempSync(join(tmpdir(), 'replay-run-'))
  const repoRoot = join(root, 'repo')
  mkdirSync(repoRoot)
  const store = openStore({ root: join(root, 'state', 'replay'), repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') })
  return { store, root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

/** Builds, freezes and approves a synthetic fixture. */
export function approvedFixture(store: Store, over: Partial<FixtureSpec> = {}): string {
  const spec = { ...SYNTHETIC_SPEC, ...over }
  buildFixture(store, spec)
  freezeFixture(store, spec.id)
  approveFixture(store, spec.id)
  return spec.id
}
