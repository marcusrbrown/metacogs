/** Gated host tests (`METACOGS_HOST_PROBES=1`): the real harness binary, the daily stack, the scripted provider. No paid call. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { disposeFixtures, type PackedPlugin, packedPlugin } from '../../../plugin/fixture'
import { analyzeEvents } from '../../../runner/events'
import type { ScriptRequest, ScriptedStep } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { ARM_NAMES, type ArmName, armMessage } from './gates'
import { createHostExecutor, defaultBaseDir, type Executor, type HostResult, prepareBase, resolveHarness } from './host'
import { type AttemptRecord, campaignDir, cellDir, readAttempts, runAttempt, runCampaign } from './run'
import { buildExport, HOST_VERSION, loadFrozen } from './store'
import { approvedFixture, MODEL, newLab, type Lab, SYNTHETIC_SPEC } from './test-support'
import { userMessageParts } from './wire'

const HARNESS = resolveHarnessOrNone()
function resolveHarnessOrNone(): string {
  try {
    return resolveHarness()
  } catch {
    return ''
  }
}
const LUNA = 'openai/gpt-6-luna'
/** The owner's slim and Systematic configs are read; the cortexkit directory is not available to the test run, so AFT and magic-context get the safety switches only. */
const OWNER = { opencodeDir: join(homedir(), '.config', 'opencode'), cortexkitDir: null }
const TIMEOUT = 1_800_000

const labs: Lab[] = []
const roots = new Set<string>()
let packed!: PackedPlugin
let baseDir = ''
let executor!: Executor
const scratch: string[] = []

const jobFor = (arm: ArmName, model = MODEL, over: { timeoutMs?: number } = {}) => ({
  fixtureId: SYNTHETIC_SPEC.id,
  seed: buildExport(SYNTHETIC_SPEC),
  model,
  arm,
  message: armMessage(arm, SYNTHETIC_SPEC)!,
  timeoutMs: over.timeoutMs ?? 240_000,
})

/** Runs the executor and keeps the fixture root so the last test can check that nothing outlived its run. */
const once = (exec: Executor, arm: ArmName, model = MODEL, over: { timeoutMs?: number } = {}): Promise<HostResult> => tracked(exec)(jobFor(arm, model, over))

/** Wraps an executor so the last test can look for processes holding any of its fixture roots. */
const tracked = (exec: Executor): Executor => async (job) => {
  const r = await exec(job)
  roots.add(dirname(r.leakDirs[0]!))
  return r
}

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS))('replay attempts on the daily harness (scripted provider, $0)', () => {
  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS), owner: OWNER, log: (l) => console.log(l) })
    executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER })
  }, TIMEOUT)

  afterAll(() => {
    for (const lab of labs) lab.dispose()
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
    disposeFixtures()
  }, 300_000)

  const t = (name: string, body: () => Promise<void>) => test(name, body, TIMEOUT)

  t('the harness reports the recorded version', async () => {
    const r = spawnSync(HARNESS, ['--version'], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe(HOST_VERSION)
  })

  t('the daily-stack config loads: five plugins, orchestrator, empty mcp, council-inject off, feel and drugs offered', async () => {
    const r = await once(executor, 'drugs')
    try {
      expect(r.ran).toBe(true)
      expect(r.stack?.checks.filter((c) => !c.passed)).toEqual([])
      expect(r.stack?.checks.map((c) => c.name)).toEqual(['plugins_loaded', 'no_auth_plugins', 'default_agent', 'mcp_empty', 'generated_kept', 'skills_paths'])
      expect(r.stackSummary).toMatchObject({ default_agent: 'orchestrator', mcp_entries: 0 })
      expect(r.stackSummary?.plugins).toEqual(['oh-my-opencode-slim@3.0.7', '@cortexkit/opencode-magic-context@0.49.40', '@cortexkit/aft-opencode@0.63.5', '@fro.bot/systematic@3.31.5', packed.spec])
      expect(r.hostVersion).toBe(HOST_VERSION)
      // slim's council-inject hook adds a Council Mode block to the first /drugs text unless it is disabled
      const main = r.requests.filter((q) => q.hasTools).at(-1)!
      expect(userMessageParts(main.body as Record<string, unknown>).at(-1)!.some((p) => p.includes('## Council Mode'))).toBe(false)
    } finally {
      r.cleanup()
    }
  })

  t('a scripted git push, shell write and outside edit are denied, and nothing is written', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'replay-outside-'))
    scratch.push(outside)
    const target = join(outside, 'written.txt')
    const script = (_arm: ArmName, r: ScriptRequest): ScriptedStep | undefined => {
      if (!r.hasTools) return undefined
      const last = JSON.stringify([...r.messages].reverse().find((m) => (m as { role?: string }).role === 'user') ?? '')
      if (last.includes('SUBTASK_MARKER')) return r.turnRound === 0 ? { toolCalls: [{ id: 'sub_push', name: 'bash', arguments: { command: 'git push origin main', description: 'push' } }] } : { text: 'sub done' }
      if (!last.includes('Continue.')) return undefined
      if (r.turnRound === 0) {
        return {
          toolCalls: [
            { id: 'call_push', name: 'bash', arguments: { command: 'git push origin main', description: 'push' } },
            { id: 'call_gh', name: 'bash', arguments: { command: 'gh pr create --fill', description: 'pr' } },
            { id: 'call_touch', name: 'bash', arguments: { command: `touch ${target}`, description: 'write' } },
            { id: 'call_edit', name: 'edit', arguments: { filePath: target, appendContent: 'x' } },
            { id: 'call_write', name: 'write', arguments: { filePath: target, content: 'x' } },
          ],
        }
      }
      if (r.turnRound === 1) return { toolCalls: [{ id: 'call_task', name: 'task', arguments: { description: 'sub job', prompt: 'SUBTASK_MARKER try a push', subagent_type: 'fixer' } }] }
      return { text: 'finished' }
    }
    const exec = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, script })
    const r = await once(exec, 'continue-a')
    try {
      expect(r.timedOut).toBe(false)
      const events = analyzeEvents(r.stdout)
      const byId = new Map(events.toolUses.map((u) => [u.callID, u]))
      for (const id of ['call_push', 'call_gh', 'call_touch']) {
        expect(byId.get(id)?.status).toBe('error')
        expect(byId.get(id)?.error ?? '').toContain('The user has specified a rule which prevents you')
      }
      for (const id of ['call_edit', 'call_write']) {
        expect(byId.get(id)?.status).toBe('error')
        expect(byId.get(id)?.error ?? '').toContain('permission_denied: external_directory')
      }
      expect(existsSync(target)).toBe(false)
      // the subagent runs under the same permission set: its push came back refused as well
      const sub = r.requests.filter((q) => JSON.stringify((q.body as { messages?: unknown[] }).messages?.at(-1) ?? '').includes('sub_push'))
      expect(sub.length).toBeGreaterThan(0)
      expect(JSON.stringify(sub.at(-1)!.body)).toContain('The user has specified a rule which prevents you')
    } finally {
      r.cleanup()
    }
  })

  t('a hung attempt is killed at its timeout, recorded as a timeout, and leaves no process of its fixture behind', async () => {
    const lab = newLab()
    labs.push(lab)
    const id = approvedFixture(lab.store)
    const record = await runAttempt({ store: lab.store, key: { campaign: 'camp', fixture: id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(lab.store, id), executor: tracked(executor), provider: 'scripted', timeoutMs: 1_500 })
    expect(record).toMatchObject({ status: 'timeout', terminal: true, reasons: ['timeout'] })
  })

  t('one frozen synthetic fixture runs all nine arms: nine attempt directories, gates passed, received arguments recorded', async () => {
    const lab = newLab()
    labs.push(lab)
    approvedFixture(lab.store)
    const summary = await runCampaign(
      { name: 'camp', models: [MODEL], arms: [...ARM_NAMES], fixtures: ['moment-a'], capUsd: 1, provider: 'scripted', timeoutMs: 240_000 },
      { store: lab.store, executor: tracked(executor), skillsDir: packed.pluginSkillsDir },
    )
    const read = (arm: ArmName, id = 'a001'): AttemptRecord => JSON.parse(readFileSync(join(cellDir(lab.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm }), id, 'attempt.json'), 'utf8'))
    const notCompleted = ARM_NAMES.map((arm) => read(arm)).filter((r) => r.status !== 'completed').map((r) => [r.arm, r.status, r.reasons, (r.gates?.checks ?? []).filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)])
    expect(notCompleted).toEqual([])
    expect(summary).toMatchObject({ cells: 9, attempts: 9, counted: { completed: 9 }, unrun: [] })
    for (const arm of ARM_NAMES) {
      const r = read(arm)
      expect(r).toMatchObject({ status: 'completed', arm, model: MODEL, outcome: 'no_tool' })
      expect(r.host.version).toBe(HOST_VERSION)
      expect(r.gates?.passed).toBe(true)
      expect(r.stack).toMatchObject({ default_agent: 'orchestrator', mcp_entries: 0 })
    }
    expect(read('feel').received_args).toBe('')
    expect(read('feel-somewhere').received_args).toBe(SYNTHETIC_SPEC.somewhere)
    expect(read('drugs').received_args).toBe('')
    expect(read('drugs-caffeine').received_args).toBe('caffeine')
    expect(read('drugs-psilocybin').received_args).toBe('psilocybin')
    expect(read('continue-a').received_args).toBeNull()

    // a rerun appends; the first attempt stays as it was
    const firstText = readFileSync(join(cellDir(lab.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'drugs' }), 'a001', 'requests.json'), 'utf8')
    await runCampaign({ name: 'camp', models: [MODEL], arms: ['drugs'], fixtures: ['moment-a'], capUsd: 1, provider: 'scripted', again: true }, { store: lab.store, executor: tracked(executor), skillsDir: packed.pluginSkillsDir })
    const cell = cellDir(lab.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'drugs' })
    expect(readAttempts(cell).map((a) => [a.id, a.status])).toEqual([['a001', 'completed'], ['a002', 'completed']])
    expect(readFileSync(join(cell, 'a001', 'requests.json'), 'utf8')).toBe(firstText)
    expect(existsSync(campaignDir(lab.store, 'camp'))).toBe(true)
  })

  t('Luna reaches the stub as itself, and a feel call from a nudge arm is an outcome, not a gate', async () => {
    const script = (arm: ArmName, r: ScriptRequest): ScriptedStep | undefined => {
      const last = JSON.stringify([...r.messages].reverse().find((m) => (m as { role?: string }).role === 'user') ?? '')
      if (arm === 'nudge-only' && r.hasTools && last.includes('whichever tool fits') && r.turnRound === 0) return { toolCalls: [{ id: 'call_feel', name: 'feel', arguments: { somewhere: 'in the test', quality: 'tight', sigil: '🌊' } }] }
      return undefined
    }
    const exec = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, script })
    const lab = newLab()
    labs.push(lab)
    approvedFixture(lab.store)
    const summary = await runCampaign({ name: 'camp', models: [LUNA], arms: ['continue-a', 'nudge-only'], fixtures: ['moment-a'], capUsd: 1, provider: 'scripted', timeoutMs: 240_000 }, { store: lab.store, executor: tracked(exec), skillsDir: packed.pluginSkillsDir })
    expect(summary.counted).toEqual({ completed: 2 })
    const read = (arm: ArmName): AttemptRecord => JSON.parse(readFileSync(join(cellDir(lab.store, { campaign: 'camp', fixture: 'moment-a', model: LUNA, arm }), 'a001', 'attempt.json'), 'utf8'))
    expect(read('continue-a')).toMatchObject({ outcome: 'no_tool' })
    expect(read('nudge-only')).toMatchObject({ outcome: 'metacogs_tool', observed: { metacogs_calls: ['feel'] } })
  })

  t('a model the host did not answer as requested is excluded', async () => {
    const exec = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, returnedModel: () => 'some-other-model' })
    const lab = newLab()
    labs.push(lab)
    const id = approvedFixture(lab.store)
    const record = await runAttempt({ store: lab.store, key: { campaign: 'camp', fixture: id, model: MODEL, arm: 'continue-a' }, fixture: loadFrozen(lab.store, id), executor: tracked(exec), provider: 'scripted', timeoutMs: 240_000 })
    expect(record).toMatchObject({ status: 'excluded', reasons: ['model_mismatch'], outcome: null })
  })

  t('no host process outlives its run', async () => {
    await Bun.sleep(1500)
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    // Only processes whose command line holds one of this test's own throwaway fixture roots are looked at or stopped.
    const mine = ps.filter((line) => [...roots].some((root) => line.includes(root)))
    for (const line of mine) process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL')
    expect(mine).toEqual([])
    expect(roots.size).toBeGreaterThan(0)
  })
})
