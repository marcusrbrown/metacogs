/**
 * Gated host probe ($0, scripted provider): what a seeded attempt may do in its shell and with the skill files it loads, and an arm that
 * runs a local Systematic tree.
 *
 * - A zsh heredoc runs in the attempt, a file under the installed skills opens, and any other path outside the project stays refused.
 * - A stack on a local tree loads that tree's own entry, `systematic_skill` returns that tree's text, and a fixture rendered from the tree
 *   puts that tree's text, and nothing of the arm's name, in front of the model.
 *
 * Run with `METACOGS_HOST_PROBES=1 METACOGS_SYSTEMATIC_TREE=<pinned tree> METACOGS_TREATMENT_TREE=<local tree>`. A tree is the directory that
 * holds `skills/`; the local one also holds `dist/` and the dependencies the entry imports. `METACOGS_PROBE_OUT` is a file the observations are
 * written to as JSON (ids, names and counts only).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { disposeFixtures, type PackedPlugin, packedPlugin } from '../../../plugin/fixture'
import { parseEvents, toolUses } from '../../../runner/events'
import type { RecordedRequest, ScriptedStep, ScriptRequest } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { armMessage } from './gates'
import { createHostExecutor, defaultBaseDir, prepareBase, resolveHarness } from './host'
import { localWorkflowStack, type StackProfile, workflowStack } from './stack'
import { approveFixture, buildFixture, freezeFixture, loadFrozen, parseSpec } from './store'
import { newLab } from './test-support'

const harnessOrNone = (): string => {
  try {
    return resolveHarness()
  } catch {
    return ''
  }
}
const HARNESS = harnessOrNone()
const PINNED = process.env.METACOGS_SYSTEMATIC_TREE ?? ''
const LOCAL = process.env.METACOGS_TREATMENT_TREE ?? ''
const FIXTURES = join(import.meta.dir, '../../../../evals/spikes/systematic-reflection/fixtures')
const LUNA = 'openai/gpt-6-luna'
const OWNER = { opencodeDir: join(homedir(), '.config', 'opencode'), cortexkitDir: null }
const TIMEOUT = 1_800_000
const PLAN_SKILL_AT = 'skills/ce-plan/SKILL.md'

const observed: Record<string, unknown> = {}
const record = (key: string, value: unknown): void => {
  observed[key] = value
  if (process.env.METACOGS_PROBE_OUT) writeFileSync(process.env.METACOGS_PROBE_OUT, `${JSON.stringify(observed, null, 2)}\n`)
}

interface Msg {
  role: string
  content?: unknown
  tool_call_id?: string
}
const textOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
const bodyText = (r: RecordedRequest): string => JSON.stringify(r.body)
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1
const specOf = (id: string) => parseSpec(JSON.parse(readFileSync(join(FIXTURES, 'tune', `${id}.json`), 'utf8')))
const repoOf = (id: string): unknown => JSON.parse(readFileSync(join(FIXTURES, 'repo', `${id}.json`), 'utf8'))

/** The sentence a tree adds to the planning skill, found by diffing the two trees' skill files: the lines only the local one holds. */
const addedLines = (): string[] => {
  const base = new Set(readFileSync(join(PINNED, PLAN_SKILL_AT), 'utf8').split('\n'))
  return readFileSync(join(LOCAL, PLAN_SKILL_AT), 'utf8').split('\n').filter((l) => l.trim() !== '' && !base.has(l))
}

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS) || !PINNED)('a seeded attempt\'s shell and skill files (scripted provider, $0)', () => {
  let packed!: PackedPlugin
  let baseDir = ''
  const stack = workflowStack()

  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, stack.npmPlugins), owner: OWNER, stack, log: (l) => console.log(l) })
  }, TIMEOUT)
  afterAll(() => disposeFixtures(), 300_000)

  test('a heredoc runs, a file under the installed skills opens, and another path outside the project is still refused', async () => {
    const lab = newLab()
    try {
      const id = 'tune-review-dedup'
      buildFixture(lab.store, specOf(id), { systematicTree: PINNED, repo: repoOf(id) })
      freezeFixture(lab.store, id)
      approveFixture(lab.store, id)
      const fixture = loadFrozen(lab.store, id)
      let cache = ''
      const script = (_arm: string, q: ScriptRequest): ScriptedStep | undefined => {
        if (!q.hasTools || !q.main) return undefined
        const messages = q.messages as Msg[]
        if (q.turnRound === 0) {
          return {
            toolCalls: [
              { id: 'heredoc', name: 'bash', arguments: { command: "cat > heredoc-note.txt <<'EOF'\nhello from a heredoc\nEOF\ncat heredoc-note.txt", description: 'heredoc' } },
              { id: 'cache', name: 'bash', arguments: { command: 'printf %s "$XDG_CACHE_HOME"', description: 'cache dir' } },
              { id: 'outside', name: 'read', arguments: { filePath: '/etc/hosts' } },
            ],
          }
        }
        if (q.turnRound === 1) {
          cache = textOf(messages.find((m) => m.role === 'tool' && m.tool_call_id === 'cache') ?? { role: 'tool' }).trim()
          const skills = `${cache}/opencode/packages/@fro.bot/systematic@3.33.2/node_modules/@fro.bot/systematic/skills`
          return { toolCalls: [{ id: 'skill-top', name: 'read', arguments: { filePath: `${skills}/todos/SKILL.md` } }, { id: 'skill-nested', name: 'read', arguments: { filePath: `${skills}/todos/assets/todo-template.md` } }] }
        }
        return { text: 'Done.' }
      }
      const executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script })
      const r = await executor({ fixtureId: id, seed: fixture.export, model: LUNA, arm: 'continue-a', message: armMessage('continue-a', fixture.spec)!, timeoutMs: 240_000, ...(fixture.repo ? { repo: fixture.repo } : {}) })
      try {
        const uses = toolUses(parseEvents(r.stdout).events)
        const by = (callID: string) => uses.find((u) => u.callID === callID)
        const summary = Object.fromEntries(['heredoc', 'outside', 'skill-top', 'skill-nested'].map((c) => [c, { status: by(c)?.status ?? null, output_head: (by(c)?.output ?? by(c)?.error ?? '').slice(0, 120) }]))
        record('shell_and_skill_reads', { ran: r.ran, cache_set: cache !== '', ...summary })
        expect(r.ran).toBe(true)
        expect(by('heredoc')?.status).toBe('completed')
        expect(by('heredoc')?.output).toContain('hello from a heredoc')
        expect(by('skill-top')?.status).toBe('completed')
        expect(by('skill-nested')?.status).toBe('completed')
        expect(by('outside')?.status).toBe('error')
      } finally {
        r.cleanup()
      }
    } finally {
      lab.dispose()
    }
  }, TIMEOUT)
})

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS) || !PINNED || !LOCAL)('an arm on a local Systematic tree (scripted provider, $0)', () => {
  let packed!: PackedPlugin
  let pinnedBase = ''
  let localBase = ''
  const pinned = workflowStack()
  let local!: StackProfile

  beforeAll(async () => {
    local = localWorkflowStack(LOCAL)
    packed = await packedPlugin()
    pinnedBase = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, pinned.npmPlugins), owner: OWNER, stack: pinned, log: (l) => console.log(l) })
    localBase = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS, local.npmPlugins), owner: OWNER, stack: local, log: (l) => console.log(l) })
  }, TIMEOUT)
  afterAll(() => disposeFixtures(), 300_000)

  test('the stack loads the local entry, systematic_skill returns that tree\'s text, and a skill file under the tree opens', async () => {
    const added = addedLines()
    expect(added.length).toBeGreaterThan(0)
    const script = (_arm: string, q: ScriptRequest): ScriptedStep | undefined => {
      if (!q.hasTools || !q.main) return undefined
      if (q.turnRound === 0) return { toolCalls: [{ id: 'plan', name: 'systematic_skill', arguments: { name: 'ce:plan' } }] }
      if (q.turnRound === 1) return { toolCalls: [{ id: 'tree-read', name: 'read', arguments: { filePath: join(LOCAL, 'skills', 'todos', 'SKILL.md') } }] }
      return { text: 'Done.' }
    }
    const lab = newLab()
    try {
      const id = 'tune-plan-scoping'
      buildFixture(lab.store, specOf(id), { systematicTree: LOCAL, repo: repoOf(id) })
      freezeFixture(lab.store, id)
      approveFixture(lab.store, id)
      const fixture = loadFrozen(lab.store, id)
      const executor = createHostExecutor({ harness: HARNESS, baseDir: localBase, packed, provider: 'scripted', owner: OWNER, stack: local, script })
      const r = await executor({ fixtureId: id, seed: fixture.export, model: LUNA, arm: 'continue-a', message: armMessage('continue-a', fixture.spec)!, timeoutMs: 240_000, ...(fixture.repo ? { repo: fixture.repo } : {}) })
      try {
        const uses = toolUses(parseEvents(r.stdout).events)
        const plan = uses.find((u) => u.callID === 'plan')
        const read = uses.find((u) => u.callID === 'tree-read')
        record('local_tree_stack', {
          ran: r.ran,
          stack_passed: r.stack?.passed ?? null,
          failed_checks: (r.stack?.checks ?? []).filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
          plugins: r.stackSummary?.plugins ?? null,
          tree_sha256: r.systematic?.treeSha256 ?? null,
          systematic_skill: { status: plan?.status ?? null, holds_added_lines: added.every((l) => (plan?.output ?? '').includes(l.trim())) },
          tree_file_read: read?.status ?? null,
        })
        expect(r.stack?.passed).toBe(true)
        expect(r.stackSummary?.plugins).toEqual([`file://${join(LOCAL, 'dist', 'index.js')}`, packed.spec])
        expect(r.systematic?.treeSha256).toBe(local.systematicTree!.sha256)
        expect(plan?.status).toBe('completed')
        for (const line of added) expect(plan?.output).toContain(line.trim())
        expect(read?.status).toBe('completed')
      } finally {
        r.cleanup()
      }
    } finally {
      lab.dispose()
    }
  }, TIMEOUT)

  test('the treatment fixture puts the added sentence in front of the model and the baseline fixture does not, with nothing of the arm\'s name in either', async () => {
    const added = addedLines()
    const lab = newLab()
    try {
      const id = 'tune-plan-claim'
      buildFixture(lab.store, specOf(id), { systematicTree: PINNED, repo: repoOf(id) })
      buildFixture(lab.store, specOf(id), { systematicTree: LOCAL, repo: repoOf(id), id: `${id}-treatment` })
      for (const f of [id, `${id}-treatment`]) {
        freezeFixture(lab.store, f)
        approveFixture(lab.store, f)
      }
      const ask = async (fixtureId: string, stack: StackProfile, baseDir: string) => {
        const fixture = loadFrozen(lab.store, fixtureId)
        const executor = createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, stack, script: (_arm, q) => (q.hasTools && q.main ? { text: 'Noted.' } : undefined) })
        const r = await executor({ fixtureId, seed: fixture.export, model: LUNA, arm: 'continue-a', message: armMessage('continue-a', fixture.spec)!, timeoutMs: 240_000, ...(fixture.repo ? { repo: fixture.repo } : {}) })
        try {
          const main = r.requests.filter((q) => q.hasTools)
          return { ran: r.ran, body: main.map(bodyText).join('\n'), treeSha256: r.systematic?.treeSha256 ?? null }
        } finally {
          r.cleanup()
        }
      }
      const base = await ask(id, pinned, pinnedBase)
      const arm = await ask(`${id}-treatment`, local, localBase)
      const seen = (body: string) => added.map((l) => body.includes(JSON.stringify(l.trim()).slice(1, -1)))
      record('treatment_seed', { baseline_ran: base.ran, treatment_ran: arm.ran, baseline_sees_added_lines: seen(base.body), treatment_sees_added_lines: seen(arm.body), word_treatment: { baseline: count(base.body, 'treatment'), treatment: count(arm.body, 'treatment') } })
      expect(base.ran && arm.ran).toBe(true)
      expect(seen(arm.body).every(Boolean)).toBe(true)
      expect(seen(base.body).some(Boolean)).toBe(false)
      expect(count(arm.body, 'treatment')).toBe(count(base.body, 'treatment'))
      expect(base.treeSha256).toBeNull()
      expect(arm.treeSha256).toBe(local.systematicTree!.sha256)
    } finally {
      lab.dispose()
    }
  }, TIMEOUT)
})
