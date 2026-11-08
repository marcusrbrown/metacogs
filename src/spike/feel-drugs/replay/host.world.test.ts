/** Gated host tests (`METACOGS_HOST_PROBES=1`) for real-world mode: the real harness, a clone of a small local repo, a gh stand-in, the scripted provider. No paid call, no GitHub. */
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { disposeFixtures, type PackedPlugin, packedPlugin } from '../../../plugin/fixture'
import { analyzeEvents, type ToolUse } from '../../../runner/events'
import { CredentialLeakError, scanForLeaks } from '../../../runner/manifest'
import type { ScriptedStep, ScriptRequest } from '../../../runner/scripted-provider'
import { stateRoot } from '../../../runner/workspace'
import { extractSession } from './extract'
import type { ArmName } from './gates'
import { buildRealExport, type ReplaySeed } from './history'
import { createHostExecutor, defaultBaseDir, type Executor, type HostResult, prepareBase, resolveHarness } from './host'
import { type AttemptRecord, campaignDir, cellDir, runAttempt, runCampaign } from './run'
import type { ReplayFixture } from './scenario'
import { buildExport, HOST_VERSION } from './store'
import { MODEL, newLab, SYNTHETIC_SPEC } from './test-support'
import type { GhAuth } from './world'
import { cleanupTmp, git, sourceRepo } from './world-support'

const HARNESS = ((): string => {
  try {
    return resolveHarness()
  } catch {
    return ''
  }
})()
const OWNER = { opencodeDir: join(homedir(), '.config', 'opencode'), cortexkitDir: null }
const TIMEOUT = 1_800_000
const FAKE_LOGIN = 'gho_FAKEHOSTTEST0000000000000000000000000'
const GH_AUTH: GhAuth = { hosts: `github.com:\n    oauth_token: ${FAKE_LOGIN}\n    user: octo\n    git_protocol: https\n`, needles: [{ label: 'gh_token', value: FAKE_LOGIN }] }

const scratch: string[] = []
const roots = new Set<string>()
let packed!: PackedPlugin
let baseDir = ''
let shim!: { dir: string; log: string }

/** A gh stand-in on PATH: logs its argv, reports whether the login file was there, and answers `pr view` and `api`. */
function makeShim(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'replay-ghshim-'))
  scratch.push(dir)
  const log = join(dir, 'gh.log')
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$@" >> ${log}\nif [ -f "$GH_CONFIG_DIR/hosts.yml" ]; then echo hosts-present; else echo hosts-absent; fi\ncase "$1 $2" in\n  "pr view") echo shim-pr-view-ok;;\n  "api repos"*) echo shim-api-ok;;\n  "api token-echo") cat "$GH_CONFIG_DIR/hosts.yml";;\nesac\n`)
  chmodSync(join(dir, 'gh'), 0o755)
  return { dir, log }
}

const fxRootOf = (r: HostResult): string => dirname(r.leakDirs.at(-1)!)
const tracked = (exec: Executor): Executor => async (job) => {
  const r = await exec(job)
  roots.add(fxRootOf(r))
  return r
}

const lastUser = (r: ScriptRequest): string => JSON.stringify([...r.messages].reverse().find((m) => (m as { role?: string }).role === 'user') ?? '')

/** Builds a real-shaped session DB (the host's own field names), extracts it, and builds the export the way a scenario does. */
function realShapedHistory(directory: string) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-realshape-'))
  scratch.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  const SES = 'ses_0123456789abcdefghijklmnopq'
  db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?)', [SES, null, 'real title', '/Users/o/src/real', 1_780_000_000_000])
  const tokens = { total: 30, input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }
  const t0 = 1_780_000_000_000
  const rows: [string, object, object[]][] = [
    ['msg_0a0000001001AAAAAAAAAAAAAA', { role: 'user', time: { created: t0 + 1 }, agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'claude-opus-5-5', variant: 'high' } }, [{ type: 'text', text: 'SYNTH_USER_ONE please look at the failing test' }, { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=', filename: 'shot.png' }]],
    ['msg_0a0000002001AAAAAAAAAAAAAA', { role: 'assistant', parentID: 'msg_0a0000001001AAAAAAAAAAAAAA', mode: 'orchestrator', agent: 'orchestrator', variant: 'high', path: { cwd: '/Users/o/src/real', root: '/Users/o/src/real' }, cost: 0.02, tokens, modelID: 'claude-opus-5-5', providerID: 'anthropic', time: { created: t0 + 2, completed: t0 + 3 }, finish: 'tool-calls' }, [
      { type: 'step-start' },
      { type: 'reasoning', text: 'thinking', time: { start: t0 + 2, end: t0 + 2 }, metadata: { anthropic: { signature: 'sig' } } },
      { type: 'tool', tool: 'read', callID: 'toolu_01', state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'SYNTH_TOOL_OUTPUT', title: 'a.ts', metadata: { preview: 'x' }, time: { start: t0 + 2, end: t0 + 3 } }, metadata: { anthropic: { x: 1 } } },
      { type: 'tool', tool: 'bash', callID: 'toolu_02', state: { status: 'error', input: { command: 'false' }, error: 'exit 1', raw: '{"command":"false"}', metadata: {}, time: { start: t0 + 3, end: t0 + 3 } } },
      { type: 'patch', hash: 'abc123', files: ['a.ts'] },
      { type: 'step-finish', reason: 'tool-calls', tokens, cost: 0.01 },
    ]],
    ['msg_0a0000003001AAAAAAAAAAAAAA', { role: 'user', time: { created: t0 + 4 }, agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'claude-opus-5-5', variant: 'high' } }, [{ type: 'text', text: 'SYNTH_USER_TWO still red' }]],
    ['msg_0a0000004001AAAAAAAAAAAAAA', { role: 'assistant', parentID: 'msg_0a0000003001AAAAAAAAAAAAAA', mode: 'orchestrator', agent: 'orchestrator', path: { cwd: '/Users/o/src/real', root: '/Users/o/src/real' }, cost: 0, tokens, modelID: 'claude-opus-5-5', providerID: 'anthropic', time: { created: t0 + 5, completed: t0 + 6 }, finish: 'stop' }, [{ type: 'step-start' }, { type: 'text', text: 'SYNTH_CUTOFF_REPLY', time: { start: t0 + 5, end: t0 + 6 } }, { type: 'step-finish', reason: 'stop', tokens, cost: 0 }]],
    ['msg_0a0000005001AAAAAAAAAAAAAA', { role: 'user', time: { created: t0 + 7 }, agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' } }, [{ type: 'text', text: 'AUTHOR_NEXT_TURN_SENTINEL' }]],
  ]
  for (const [id, data, parts] of rows) {
    db.run('INSERT INTO message VALUES (?, ?, ?, ?)', [id, SES, (data as { time: { created: number } }).time.created, JSON.stringify(data)])
    parts.forEach((p, k) => db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?)', [`prt_${id}_${k}`, id, SES, (data as { time: { created: number } }).time.created, JSON.stringify(p)]))
  }
  db.close()
  const cutoff = 'msg_0a0000004001AAAAAAAAAAAAAA'
  const history = buildRealExport(extractSession({ db: path, session: SES, cutoff }), { scenario: 'real-shape', directory })
  return { history, cutoff }
}

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !HARNESS || !existsSync(HARNESS))('real-world replay on the daily harness (scripted provider, local repo, $0)', () => {
  const source = (() => {
    let cache: ReturnType<typeof sourceRepo> | undefined
    return () => (cache ??= sourceRepo())
  })()
  const worldJobOf = (cutoff = '2026-03-15T00:00:00Z') => ({ source: source().dir, githubRepo: 'octo/repo', cutoffMs: Date.parse(cutoff), hints: [] as string[] })

  beforeAll(async () => {
    packed = await packedPlugin()
    baseDir = await prepareBase({ harness: HARNESS, baseDir: defaultBaseDir(join(stateRoot(), 'replay'), HARNESS), owner: OWNER, log: (l) => console.log(l) })
    shim = makeShim()
  }, TIMEOUT)

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
    cleanupTmp()
    disposeFixtures()
  }, 300_000)

  const exec = (over: Partial<Parameters<typeof createHostExecutor>[0]> = {}): Executor =>
    tracked(createHostExecutor({ harness: HARNESS, baseDir, packed, provider: 'scripted', owner: OWNER, world: { gh: GH_AUTH, env: { PATH: `${shim.dir}:${process.env.PATH ?? ''}` }, writable: [shim.dir] }, ...over }))

  const t = (name: string, body: () => Promise<void>) => test(name, body, TIMEOUT)

  const seedJob = (seed: ReplaySeed, arm: ArmName = 'continue-a') => ({ fixtureId: 'moment-real', seed, model: MODEL, arm, message: { kind: 'text' as const, text: 'Continue.' }, timeoutMs: 240_000, world: worldJobOf() })

  t('the DB mapping equals what the host exports for a scripted session, and the host accepts the built export', async () => {
    let compared = false
    const seed = buildExport(SYNTHETIC_SPEC)
    const lastSeed = seed.messages.at(-1)!.info.id
    const e = exec({
      afterExport: ({ seed: imported, exported, dataDir }) => {
        const dbFile = readdirSync(join(dataDir, 'opencode')).filter((f) => f.endsWith('.db')).map((f) => join(dataDir, 'opencode', f))[0]!
        const raw = extractSession({ db: dbFile, session: imported.info.id, cutoff: lastSeed })
        const mapped = buildRealExport(raw, { scenario: 'mapping', directory: imported.info.directory })
        const hostMessages = (exported as { messages: unknown[] }).messages.slice(0, imported.messages.length)
        expect(mapped.dropped.total).toBe(0)
        expect(mapped.export.messages).toEqual(hostMessages as typeof mapped.export.messages)
        expect(mapped.export.messages).toEqual(JSON.parse(JSON.stringify(imported.messages)))
        compared = true
      },
    })
    const r = await e(seedJob(seed))
    try {
      expect(r.ran).toBe(true)
      expect(compared).toBe(true)
    } finally {
      r.cleanup()
    }
  })

  t('a real-shaped history imports, ends at the cutoff, reaches the model whole, and the run completes with the gates passed', async () => {
    const { history, cutoff } = realShapedHistory('/workspace')
    expect(history.dropped.total).toBe(0)
    expect(history.window.rule).toBe('all')
    const fixture: ReplayFixture = { spec: { kind: 'feel', somewhere: '', turns: [] }, export: history.export, entry: { spec_sha256: 'a', export_sha256: 'b' }, seedUserTurns: history.seed_user_turns, world: worldJobOf(), history }
    const lab = newLab()
    try {
      const record = await runAttempt({ store: lab.store, key: { campaign: 'rw', fixture: 'moment-real', model: MODEL, arm: 'continue-a' }, fixture, executor: exec(), provider: 'scripted', timeoutMs: 240_000 })
      expect(record.gates?.checks.filter((c) => !c.passed)).toEqual([])
      expect(record).toMatchObject({ status: 'completed', world: { repo: 'octo/repo', rule: 'origin-main', gh: 'read' }, hindsight_note: 'gh reads show current GitHub state' })
      const requests = readFileSync(join(cellDir(lab.store, { campaign: 'rw', fixture: 'moment-real', model: MODEL, arm: 'continue-a' }), 'a001', 'requests.json'), 'utf8')
      for (const seen of ['SYNTH_USER_ONE', 'SYNTH_TOOL_OUTPUT', 'SYNTH_USER_TWO', 'SYNTH_CUTOFF_REPLY']) expect(requests).toContain(seen)
      expect(requests).not.toContain('AUTHOR_NEXT_TURN_SENTINEL')
      expect(cutoff).toBe(history.export.messages.at(-1)!.info.id)
    } finally {
      lab.dispose()
    }
  })

  t('reads and edits inside the clone work; pushes, gh writes, a write outside and subagent pushes are refused; the source is untouched', async () => {
    const src = source().dir
    const outside = mkdtempSync(join(tmpdir(), 'replay-outside-'))
    scratch.push(outside)
    const before = git(src, ['for-each-ref']) + git(src, ['rev-parse', 'HEAD']) + git(src, ['status', '--porcelain'])
    const bash = (id: string, command: string) => ({ id, name: 'bash', arguments: { command, description: id } })
    const calls = [
      bash('ok_gitlog', 'git log --oneline -3'),
      bash('ok_ghview', 'gh pr view 12'),
      bash('ok_ghapi', 'gh api repos/octo/repo/pulls/1'),
      bash('ok_ghapi_get', 'gh api -X GET repos/octo/repo/pulls/1'),
      { id: 'ok_write', name: 'write', arguments: { filePath: 'inside.txt', content: 'inside' } },
      bash('no_push', 'git push origin main'),
      bash('no_ghpr', 'gh pr create --fill'),
      bash('no_ghpost', 'gh api -X POST repos/octo/repo/issues'),
      bash('no_ghfield', 'gh api repos/octo/repo/issues -f title=x'),
      bash('no_token', 'gh auth token'),
      { id: 'no_outside_write', name: 'write', arguments: { filePath: join(outside, 'written.txt'), content: 'x' } },
      bash('out_touch', `touch ${join(outside, 'touched.txt')}`),
      bash('out_redirect', `echo x > ${join(outside, 'redirected.txt')}`),
      bash('out_python', `python3 -c "open('${join(outside, 'py.txt')}','w').write('x')"`),
      bash('out_secret', `cat ${join(homedir(), '.config', 'gh', 'config.yml')}`),
    ]
    const script = (_arm: ArmName, r: ScriptRequest): ScriptedStep | undefined => {
      if (!r.hasTools) return undefined
      const last = lastUser(r)
      if (last.includes('SUBTASK_MARKER')) return r.turnRound === 0 ? { toolCalls: [bash('sub_push', 'git push origin main')] } : { text: 'sub done' }
      if (!last.includes('Continue.')) return undefined
      if (r.turnRound === 0) return { toolCalls: calls }
      if (r.turnRound === 1) return { toolCalls: [{ id: 'call_task', name: 'task', arguments: { description: 'sub job', prompt: 'SUBTASK_MARKER try a push', subagent_type: 'fixer' } }] }
      return { text: 'finished' }
    }
    const e = exec({ script })
    const r = await e(seedJob(buildExport(SYNTHETIC_SPEC)))
    try {
      expect({ exit: r.exitCode, ran: r.ran, stack: r.stack?.passed, stderr: r.stderr.slice(0, 600), stdout: r.stdout.slice(0, 300) }).toMatchObject({ exit: 0, ran: true, stack: true })
      expect(r.timedOut).toBe(false)
      const byId = new Map<string, ToolUse>(analyzeEvents(r.stdout).toolUses.map((u) => [u.callID ?? '', u]))
      expect({ seen: [...byId.keys()].sort(), requests: r.requests.length, tail: r.stdout.slice(-400) }).toMatchObject({ seen: expect.arrayContaining(['ok_gitlog', 'no_push']) })
      const denied = (u: ToolUse | undefined) => u?.status === 'error' && /rule which prevents you|permission_denied/.test(u.error ?? '')
      for (const id of ['ok_gitlog', 'ok_ghview', 'ok_ghapi', 'ok_ghapi_get', 'ok_write']) expect({ id, status: byId.get(id)?.status, error: byId.get(id)?.error }).toEqual({ id, status: 'completed', error: undefined })
      expect(byId.get('ok_gitlog')?.output).toContain('c3')
      expect(byId.get('ok_ghview')?.output).toContain('shim-pr-view-ok')
      expect(byId.get('ok_ghview')?.output).toContain('hosts-present') // the login file is there while the run goes
      for (const id of ['no_push', 'no_ghpr', 'no_ghpost', 'no_ghfield', 'no_token', 'no_outside_write']) expect({ id, denied: denied(byId.get(id)) }).toEqual({ id, denied: true })
      expect(existsSync(join(outside, 'written.txt'))).toBe(false)
      // the shim saw only the allowed gh calls
      const ghLog = readFileSync(shim.log, 'utf8')
      expect(ghLog).toContain('pr view 12')
      for (const banned of ['pr create', '-X POST', '-f title', 'auth token']) expect(ghLog).not.toContain(banned)
      // the subagent runs under the same rules
      const sub = r.requests.filter((q) => JSON.stringify((q.body as { messages?: unknown[] }).messages?.at(-1) ?? '').includes('sub_push'))
      expect(sub.length).toBeGreaterThan(0)
      expect(JSON.stringify(sub.at(-1)!.body)).toContain('The user has specified a rule which prevents you')
      // the login file is gone once the run is over, and the source checkout did not change
      expect(existsSync(join(fxRootOf(r), 'gh'))).toBe(false)
      expect(git(src, ['for-each-ref']) + git(src, ['rev-parse', 'HEAD']) + git(src, ['status', '--porcelain'])).toBe(before)
      // permissions alone let the shell write anywhere; the sandbox confines it to the fixture, and keeps the owner's gh directory unreadable
      for (const file of ['touched.txt', 'redirected.txt', 'py.txt']) expect({ file, written: existsSync(join(outside, file)) }).toEqual({ file, written: false })
      expect(byId.get('out_secret')?.output ?? '').not.toMatch(/git_protocol|editor|prompt/)
    } finally {
      r.cleanup()
    }
  })

  t('the gh token is never in an artifact; a tool that prints it stops the attempt with labels only', async () => {
    const lab = newLab()
    try {
      const { history } = realShapedHistory('/workspace')
      const fixture: ReplayFixture = { spec: { kind: 'feel', somewhere: '', turns: [] }, export: history.export, entry: { spec_sha256: 'a', export_sha256: 'b' }, seedUserTurns: history.seed_user_turns, world: worldJobOf(), history }
      const clean = await runAttempt({ store: lab.store, key: { campaign: 'rw', fixture: 'clean', model: MODEL, arm: 'continue-a' }, fixture, executor: exec(), provider: 'scripted', timeoutMs: 240_000, needles: GH_AUTH.needles })
      expect(clean.status).toBe('completed')
      expect(scanForLeaks({ needles: GH_AUTH.needles, manifestJson: '', artifacts: {}, dirs: [campaignDir(lab.store, 'rw')] })).toEqual([])

      const leaking = exec({ script: (_arm, r) => {
        if (!r.hasTools || !lastUser(r).includes('Continue.')) return undefined
        return r.turnRound === 0 ? { toolCalls: [{ id: 'call_echo', name: 'bash', arguments: { command: 'gh api token-echo', description: 'echo' } }] } : { text: 'done' }
      } })
      await expect(runAttempt({ store: lab.store, key: { campaign: 'rw', fixture: 'leak', model: MODEL, arm: 'continue-a' }, fixture, executor: leaking, provider: 'scripted', timeoutMs: 240_000, needles: GH_AUTH.needles })).rejects.toBeInstanceOf(CredentialLeakError)
      const dir = join(campaignDir(lab.store, 'rw'), 'leak')
      expect(scanForLeaks({ needles: GH_AUTH.needles, manifestJson: '', artifacts: {}, dirs: [dir] })).toEqual([])
      const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name)
      expect(files).toEqual(['attempt.json'])
    } finally {
      lab.dispose()
    }
  })

  t('the six real-world arms run end to end on a scripted scenario: gates pass, the arguments arrive, a rerun appends', async () => {
    const lab = newLab()
    try {
      const { history } = realShapedHistory('/workspace')
      const fixture: ReplayFixture = { spec: { kind: 'drugs', somewhere: 'in the gap between the test and the fix', turns: [], substance: 'melatonin' }, export: history.export, entry: { spec_sha256: 'a', export_sha256: 'b' }, seedUserTurns: history.seed_user_turns, world: worldJobOf(), history }
      const arms: ArmName[] = ['continue-a', 'continue-b', 'feel', 'feel-somewhere', 'drugs', 'drugs-substance']
      const summary = await runCampaign({ name: 'rw6', models: [MODEL], arms, fixtures: ['moment-real'], capUsd: 1, provider: 'scripted', timeoutMs: 240_000, world: true }, { store: lab.store, executor: exec(), skillsDir: packed.pluginSkillsDir, needles: GH_AUTH.needles, loadFixture: () => fixture })
      const read = (arm: ArmName): AttemptRecord => JSON.parse(readFileSync(join(cellDir(lab.store, { campaign: 'rw6', fixture: 'moment-real', model: MODEL, arm }), 'a001', 'attempt.json'), 'utf8'))
      const notCompleted = arms.map(read).filter((x) => x.status !== 'completed').map((x) => [x.arm, x.status, x.reasons, (x.gates?.checks ?? []).filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)])
      expect(notCompleted).toEqual([])
      expect(summary).toMatchObject({ cells: 6, attempts: 6, counted: { completed: 6 }, unrun: [] })
      for (const arm of arms) expect(read(arm)).toMatchObject({ world: { repo: 'octo/repo', gh: 'read' }, hindsight_note: 'gh reads show current GitHub state', host: { version: HOST_VERSION } })
      expect(read('feel').received_args).toBe('')
      expect(read('feel-somewhere').received_args).toBe('in the gap between the test and the fix')
      expect(read('drugs').received_args).toBe('')
      expect(read('drugs-substance').received_args).toBe('melatonin')
      expect(read('continue-a').received_args).toBeNull()
      const cell = cellDir(lab.store, { campaign: 'rw6', fixture: 'moment-real', model: MODEL, arm: 'drugs-substance' })
      const first = readFileSync(join(cell, 'a001', 'requests.json'), 'utf8')
      await runCampaign({ name: 'rw6', models: [MODEL], arms: ['drugs-substance'], fixtures: ['moment-real'], capUsd: 1, provider: 'scripted', again: true, world: true }, { store: lab.store, executor: exec(), skillsDir: packed.pluginSkillsDir, needles: GH_AUTH.needles, loadFixture: () => fixture })
      expect(readdirSync(cell).sort()).toEqual(['a001', 'a002'])
      expect(readFileSync(join(cell, 'a001', 'requests.json'), 'utf8')).toBe(first)
      expect(statSync(join(cell, 'a001', 'attempt.json')).mode & 0o777).toBe(0o600)
    } finally {
      lab.dispose()
    }
  })

  t('no host process of these fixtures outlives its run', async () => {
    await Bun.sleep(1500)
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    // Only processes whose command line holds one of this test's own throwaway fixture roots are looked at.
    const mine = ps.filter((line) => [...roots].some((root) => line.includes(root)))
    expect(mine).toEqual([])
    expect(roots.size).toBeGreaterThan(0)
  })
})
