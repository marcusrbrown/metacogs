/** Gated host probes ($0): history replay, daily-stack isolation, model and command delivery, CLIProxy route, egress. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { disposeFixtures, packedPlugin } from '../../../plugin/fixture'
import { CLIPROXY_UPSTREAM, fetchCliproxyKey } from '../../../runner/cliproxy'
import { buildChildEnv, createFixture, destroyFixture, type Fixture } from '../../../runner/env'
import { systemTexts } from '../../../runner/isolation'
import { PLACEHOLDER_API_KEY, type RecordedRequest, type ScriptRequest, type ScriptedStep, startScriptedProvider } from '../../../runner/scripted-provider'
import { buildConfig, gitInit } from '../../../runner/workspace'
import { userTextsAnyWire } from './wire'

const HARNESS = process.env.METACOGS_HARNESS_BIN ?? join(homedir(), '.local/share/mise/installs/npm-fro-bot-harness/1.19.5-harness.bf7f7dfe/bin/opencode')
const HOST_VERSION = '1.19.5+harness.bf7f7dfe'
const OWNER_CONFIG = join(homedir(), '.config/opencode')
const OFFLINE_NPM = { npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }
const OPUS = 'anthropic/claude-opus-5-5'
const LUNA = 'openai/gpt-6-luna'
const STACK_PLUGINS = ['oh-my-opencode-slim@3.0.7', '@cortexkit/opencode-magic-context@0.49.40', '@cortexkit/aft-opencode@0.63.5', '@fro.bot/systematic@3.31.5']
const HOST_TIMEOUT = 900_000

// ── host process ───────────────────────────────────────────────────────────

interface FileRun {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  wallMs: number
}

/** Stdout and stderr go to files (a pipe cuts `debug config` at 768 KiB); the whole process group dies at the timeout. */
function runToFiles(argv: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; dir: string; tag: string; onSpawn?: (pgid: number) => void }): Promise<FileRun> {
  mkdirSync(o.dir, { recursive: true })
  const outPath = join(o.dir, `${o.tag}.out`)
  const errPath = join(o.dir, `${o.tag}.err`)
  const out = openSync(outPath, 'w')
  const err = openSync(errPath, 'w')
  const [cmd, ...rest] = argv
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd!, rest, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', out, err] })
    if (child.pid !== undefined) o.onSpawn?.(child.pid)
    let timedOut = false
    let settled = false
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig)
      } catch {
        // already gone
      }
    }
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill('SIGKILL')
      closeSync(out)
      closeSync(err)
      resolve({ stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8'), exitCode: timedOut ? -1 : code, timedOut, wallMs: Date.now() - started })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => done(-1), 3000)
    }, o.timeoutMs)
    child.once('error', () => done(-1))
    child.once('close', (code) => done(code ?? -1))
  })
}

// ── the daily-stack lab ────────────────────────────────────────────────────

const stubModel = (id: string) => ({ id, name: id, attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: '2026-10-22', limit: { context: 200_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {} })
const STUB_MODELS = { anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], openai: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra'] } as const

/** The two provider ids the live replays use, both pointed at the chat-completions stub. */
const stubProviders = (baseURL: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(STUB_MODELS).map(([id, models]) => [id, { name: id, npm: '@ai-sdk/openai-compatible', env: [], models: Object.fromEntries(models.map((m) => [m, stubModel(m)])), options: { apiKey: PLACEHOLDER_API_KEY, baseURL } }]))

const fixtures: Fixture[] = []

/** Per-plugin configs: the owner's slim and Systematic files with the egress switches set; AFT and magic-context are written from their schemas. */
function writeStackConfigs(fx: Fixture): void {
  const oc = join(fx.xdgConfigHome, 'opencode')
  mkdirSync(join(oc, 'oh-my-opencode-slim'), { recursive: true })
  const slim = Bun.JSONC.parse(readFileSync(join(OWNER_CONFIG, 'oh-my-opencode-slim.jsonc'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(oc, 'oh-my-opencode-slim.jsonc'), JSON.stringify({ ...slim, autoUpdate: false, disabled_mcps: ['context7', 'gh_grep'] }))
  const systematic = Bun.JSONC.parse(readFileSync(join(OWNER_CONFIG, 'systematic.jsonc'), 'utf8')) as { search?: Record<string, unknown> }
  writeFileSync(join(oc, 'systematic.jsonc'), JSON.stringify({ ...systematic, search: { ...systematic.search, allow_project_sources: [] } }))
  for (const f of ['orchestrator_append.md', 'designer_append.md']) {
    if (existsSync(join(OWNER_CONFIG, 'oh-my-opencode-slim', f))) copyFileSync(join(OWNER_CONFIG, 'oh-my-opencode-slim', f), join(oc, 'oh-my-opencode-slim', f))
  }
  const ck = join(fx.xdgConfigHome, 'cortexkit')
  mkdirSync(ck, { recursive: true })
  writeFileSync(join(ck, 'aft.jsonc'), JSON.stringify({ auto_update: false, indexes: { semantic: false } }))
  writeFileSync(join(ck, 'magic-context.jsonc'), JSON.stringify({ auto_update: false, historian: { disable: true }, dreamer: { disable: true }, embedding: { provider: 'off' } }))
}

function newLab(): Fixture {
  const fx = createFixture('metacogs-replay-')
  fixtures.push(fx)
  gitInit(fx.workspace)
  writeStackConfigs(fx)
  return fx
}

/** A new lab that clones an installed one's plugin cache and config dir (APFS clone, no npm install). */
function cloneLab(from: Fixture): Fixture {
  const fx = newLab()
  const clone = spawnSync('cp', ['-cR', `${from.xdgCacheHome}/.`, fx.xdgCacheHome])
  if (clone.status !== 0) cpSync(from.xdgCacheHome, fx.xdgCacheHome, { recursive: true })
  cpSync(from.opencodeConfigDir, fx.opencodeConfigDir, { recursive: true })
  return fx
}

interface HostRun {
  run: FileRun
  requests: RecordedRequest[]
}

interface HostRunOptions {
  tag: string
  script?: (r: ScriptRequest) => ScriptedStep | undefined
  online?: boolean
  timeoutMs?: number
  env?: Record<string, string>
  onSpawn?: (pgid: number) => void
}

async function hostRun(fx: Fixture, args: string[], o: HostRunOptions): Promise<HostRun> {
  const provider = startScriptedProvider({ steps: [], ...(o.script ? { script: o.script } : {}) })
  try {
    const packed = await packedPlugin()
    const config = buildConfig({
      permission: { edit: 'deny', bash: { '*': 'deny' } },
      provider: stubProviders(provider.url) as never,
      extra: {
        plugin: [...STACK_PLUGINS, packed.spec],
        agent: { general: { disable: true }, explore: { disable: true } },
        compaction: { auto: false, prune: false },
        experimental: { openTelemetry: false },
        lsp: true,
        snapshot: false,
      },
    })
    const env = buildChildEnv({ fixture: fx, config, extra: { ...(o.online ? {} : OFFLINE_NPM), ...o.env } })
    const run = await runToFiles([HARNESS, ...args], { cwd: fx.workspace, env, timeoutMs: o.timeoutMs ?? 180_000, dir: join(fx.root, 'logs'), tag: o.tag, ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}) })
    return { run, requests: provider.requests }
  } finally {
    provider.stop()
  }
}

const runArgs = (model: string, ...rest: string[]): string[] => ['run', '--format', 'json', '--model', model, ...rest]
/** Slim's orchestrator prompt never says "OpenCode", so `isMainRequest` misses it; the main request is the one offering both `task` and `feel`. */
const mains = (requests: readonly RecordedRequest[]): RecordedRequest[] => requests.filter((r) => r.hasTools && toolNames(r).includes('task') && toolNames(r).includes('feel'))

// ── request accessors ──────────────────────────────────────────────────────

interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}
interface ChatBody {
  model?: string
  messages: ChatMessage[]
  tools?: { function: { name: string } }[]
}

const chatBody = (r: RecordedRequest): ChatBody => r.body as ChatBody
const toolNames = (r: RecordedRequest): string[] => (chatBody(r).tools ?? []).map((t) => t.function.name).sort()
const systemOf = (r: RecordedRequest): string => systemTexts(r.body as Record<string, unknown>).join('\n')

/** Skill names inside the system prompt's `<available_skills>` block. */
function skillList(r: RecordedRequest): string[] {
  const text = systemOf(r)
  const open = text.indexOf('<available_skills>')
  return [...text.slice(open).matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '').sort()
}

const stripTag = (s: string): string => s.replace(/^§\d+§ /, '')
const partText = (content: unknown): string[] => (typeof content === 'string' ? [content] : Array.isArray(content) ? (content as { text?: string }[]).map((p) => p.text ?? '') : [])

/** The last user message's first text part (the typed command lands here), tag stripped. */
function lastUserText(r: RecordedRequest): string {
  const last = chatBody(r).messages.findLast((m) => m.role === 'user')
  return stripTag(partText(last?.content)[0] ?? '')
}

// ── history fidelity ───────────────────────────────────────────────────────

/** One line per non-system message: plugin-injected reminders and magic-context tags are dropped, everything else kept. */
export function normalizeHistory(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const text = partText(m.content).filter((t) => !t.startsWith('<system-reminder>')).map(stripTag).join('|')
      if (m.role === 'tool') return `T:${m.tool_call_id}:${text}`
      if (m.role === 'assistant') return `A:${text}${m.tool_calls ? ` TC[${m.tool_calls.map((c) => `${c.id}:${c.function.name}`).join(',')}]` : ''}`
      return `U:${text}`
    })
}

interface ExportedPart {
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: { status?: string; output?: string }
}
export interface SessionExport {
  info: { id: string; directory: string; version: string; agent?: string; permission?: unknown }
  messages: { info: { role: string; agent?: string; providerID?: string; modelID?: string }; parts: ExportedPart[] }[]
}

/** Role and content of every message in an export, without ids or times. */
export function partsSignature(exported: SessionExport): string[] {
  return exported.messages.map((m) => {
    const parts = m.parts
      .filter((p) => p.type !== 'step-start' && p.type !== 'step-finish')
      .map((p) => (p.type === 'text' ? `text:${p.text}` : p.type === 'tool' ? `tool:${p.tool}:${p.callID}:${p.state?.status}:${p.state?.output}` : p.type))
    return `${m.info.role}:${parts.join('|')}`
  })
}

export interface FidelityInput {
  source: string[]
  replay: string[]
  sourceParts: string[]
  replayParts: string[]
  replaySystem: string
  replayPartTypes: string[]
  sourceTools: string[]
  replayTools: string[]
}

/** Empty when the replayed history matches the source in count, order and content, keeps each tool call with its result, and shows no compaction. */
export function checkFidelity(i: FidelityInput): string[] {
  const problems: string[] = []
  if (i.source.length !== i.replay.length) problems.push(`message count ${i.replay.length} != source ${i.source.length}`)
  const at = i.source.findIndex((line, n) => line !== i.replay[n])
  if (at >= 0 && at < Math.min(i.source.length, i.replay.length)) problems.push(`message ${at} differs from the source`)
  for (const line of i.replay) {
    for (const call of line.match(/TC\[[^\]]*\]/)?.[0].slice(3, -1).split(',') ?? []) {
      const id = call.split(':')[0]
      if (!i.replay.some((l) => l.startsWith(`T:${id}:`))) problems.push(`tool call ${id} has no result`)
    }
  }
  if (i.sourceParts.length !== i.replayParts.length) problems.push(`part-level message count ${i.replayParts.length} != source ${i.sourceParts.length}`)
  else if (i.sourceParts.some((s, n) => s !== i.replayParts[n])) problems.push('part content differs from the source')
  const extra = i.replayTools.filter((t) => !i.sourceTools.includes(t))
  const lost = i.sourceTools.filter((t) => !i.replayTools.includes(t))
  if (extra.length || lost.length) problems.push(`tool set differs: ${[...extra.map((t) => `+${t}`), ...lost.map((t) => `-${t}`)].join(' ')}`)
  if (/you are a context summarization agent|summarize what was done in this conversation/i.test(i.replaySystem) || i.replayPartTypes.includes('compaction')) problems.push('compaction present')
  return problems
}

// ── the scripted source history ────────────────────────────────────────────

const TURNS: Record<string, ScriptedStep[]> = {
  alpha: [{ toolCalls: [{ id: 'call_read1', name: 'read', arguments: { filePath: 'notes.txt' } }] }, { text: 'answer one' }],
  beta: [{ toolCalls: [{ id: 'call_task1', name: 'task', arguments: { description: 'sub job', prompt: 'SUBTASK_MARKER please look', subagent_type: 'explorer' } }] }, { text: 'answer two' }],
  gamma: [{ text: 'answer three' }],
}

/** Turn is read from the last user text because magic-context adds user messages of its own. */
function script(r: ScriptRequest): ScriptedStep | undefined {
  const last = (r.messages as ChatMessage[]).findLast((m) => m.role === 'user')
  const text = JSON.stringify(last?.content ?? '')
  if (text.includes('SUBTASK_MARKER')) return { text: 'sub result' }
  if (!r.hasTools) return undefined
  const turn = Object.keys(TURNS).find((w) => text.includes(`§ ${w}`))
  return turn ? (TURNS[turn]![r.turnRound] ?? { text: 'fallback' }) : { text: 'next move' }
}

const sessionIds = async (fx: Fixture, tag: string): Promise<string[]> => {
  const { run } = await hostRun(fx, ['session', 'list', '--format', 'json'], { tag })
  return (JSON.parse(run.stdout) as { id: string }[]).map((s) => s.id)
}

const exportSession = async (fx: Fixture, id: string, tag: string): Promise<SessionExport> => {
  const { run } = await hostRun(fx, ['export', id], { tag })
  return JSON.parse(run.stdout) as SessionExport
}

// ── egress ─────────────────────────────────────────────────────────────────

/** A local proxy that refuses every tunnel and logs host:port only. */
async function startEgressSink(): Promise<{ port: number; seen: Set<string>; stop: () => void }> {
  const seen = new Set<string>()
  const server = createServer((req, res) => {
    seen.add(`http:${req.headers.host ?? 'unknown'}`)
    res.writeHead(403).end()
  })
  server.on('connect', (req, socket) => {
    seen.add(`connect:${req.url}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    seen,
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/** Non-loopback remote endpoints held open by the process group right now. */
function sampleRemotes(pgid: number, into: Set<string>, loopback = false): void {
  const r = spawnSync('lsof', ['-nP', '-i', '-a', '-g', String(pgid)], { encoding: 'utf8', timeout: 5000 })
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /->(\[[^\]]+\]|[^:\s]+):(\d+)/.exec(line)
    if (m && (loopback || !/^(127\.0\.0\.1|\[::1\]|localhost)$/.test(m[1]!))) into.add(`${m[1]}:${m[2]}`)
  }
}

// ── the probes ─────────────────────────────────────────────────────────────

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !existsSync(HARNESS))('feel/drugs replay on the daily harness (scripted provider, $0)', () => {
  let source!: Fixture
  let sourceId = ''
  let sourceExport!: SessionExport
  let sourceNorm: string[] = []
  let sourceTools: string[] = []
  let imported!: Fixture
  const probe = (name: string, body: () => Promise<void>) => test(name, body, HOST_TIMEOUT)

  beforeAll(() => {
    source = newLab()
  })

  afterAll(() => {
    for (const fx of fixtures) destroyFixture(fx)
    disposeFixtures()
  }, 300_000)

  probe('the harness reports the recorded version', async () => {
    const r = spawnSync(HARNESS, ['--version'], { encoding: 'utf8', timeout: 60_000 })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(HOST_VERSION)
  })

  probe('the daily stack loads in the fixture: five plugins, slim default agent, no MCP, historian and dreamer off', async () => {
    const packed = await packedPlugin()
    const { run } = await hostRun(source, ['debug', 'config'], { tag: 'dbg', online: true, timeoutMs: 600_000 })
    expect(run.exitCode).toBe(0)
    const cfg = JSON.parse(run.stdout) as Record<string, any>
    expect((cfg.plugin_origins as { spec: string; source: string }[]).map((o) => o.spec)).toEqual([...STACK_PLUGINS, packed.spec])
    expect((cfg.plugin_origins as { source: string }[]).every((o) => o.source === source.configPath)).toBe(true)
    expect(JSON.stringify(cfg.plugin)).not.toMatch(/anthropic-auth|openai-auth/)
    expect(cfg.default_agent).toBe('orchestrator')
    expect(cfg.mcp).toEqual({})
    expect(Object.keys(cfg.agent)).toEqual(expect.arrayContaining(['orchestrator', 'explorer', 'oracle', 'designer', 'fixer', 'council', 'fast-generic', 'systematic-implementer', 'repo-research-analyst']))
    expect(Object.keys(cfg.command)).toEqual(expect.arrayContaining(['interview', 'implement', 'deepwork', 'reflect', 'ctx-status', 'aft-status', 'systematic:git-commit', 'ce:plan']))
    expect(Object.keys(cfg.command)).not.toContain('feel')
    expect(Object.keys(cfg.command)).not.toContain('drugs')
    expect((cfg.skills as { paths: string[] }).paths).toContain(packed.pluginSkillsDir)
    expect(cfg.compaction).toEqual({ auto: false, prune: false })
    const log = readFileSync(join(source.tmp, 'opencode', 'magic-context', 'magic-context.log'), 'utf8')
    expect(log).toContain('dreamer.disable is true')
  })

  probe('a three-turn history with a tool call and a subagent handoff runs on the stack with no background requests', async () => {
    writeFileSync(join(source.workspace, 'notes.txt'), 'synthetic notes line one\nline two\n')
    const turns = [['alpha'], ['--continue', 'beta'], ['--continue', 'gamma']]
    const counts: number[] = []
    let gamma!: RecordedRequest
    for (const [n, extra] of turns.entries()) {
      const { run, requests } = await hostRun(source, runArgs(OPUS, ...extra), { tag: `seed${n}`, script })
      expect(run.exitCode).toBe(0)
      expect(run.timedOut).toBe(false)
      counts.push(requests.length)
      if (n === 2) gamma = mains(requests).at(-1)!
    }
    expect(counts).toEqual([3, 3, 1])
    expect(readFileSync(join(source.tmp, 'opencode', 'magic-context', 'magic-context.log'), 'utf8')).toContain('dreaming=false')
    sourceId = (await sessionIds(source, 'ls0'))[0]!
    sourceExport = await exportSession(source, sourceId, 'export0')
    expect(sourceExport.info.version).toBe(HOST_VERSION)
    expect(sourceExport.info.agent).toBe('orchestrator')
    const tools = sourceExport.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool')
    expect(tools.map((p) => [p.tool, p.callID, p.state?.status])).toEqual([['read', 'call_read1', 'completed'], ['task', 'call_task1', 'completed']])
    sourceNorm = [...normalizeHistory(chatBody(gamma).messages), 'A:answer three', 'U:Continue.']
    sourceTools = toolNames(gamma)
    expect(sourceNorm.filter((l) => l.startsWith('U:') && !l.includes('session-history'))).toEqual(['U:alpha', 'U:beta', 'U:gamma', 'U:Continue.'])
    expect(sourceNorm.find((l) => l.startsWith('T:call_task1:'))).toContain('<task id=')
    expect(sourceTools).toContain('feel')
    expect(sourceTools).toContain('drugs')
    expect(sourceTools).not.toContain('question')
  })

  const fidelity = (replay: RecordedRequest, exported: SessionExport): string[] =>
    checkFidelity({
      source: sourceNorm,
      replay: normalizeHistory(chatBody(replay).messages),
      sourceParts: partsSignature(sourceExport),
      replayParts: partsSignature(exported).slice(0, sourceExport.messages.length),
      replaySystem: systemOf(replay),
      replayPartTypes: exported.messages.flatMap((m) => m.parts.map((p) => p.type)),
      sourceTools,
      replayTools: toolNames(replay),
    })

  probe('mechanism (b), -s --fork from the seeded session: history intact, but the host offers the question tool the source denies', async () => {
    const { run, requests } = await hostRun(source, runArgs(OPUS, '-s', sourceId, '--fork', 'Continue.'), { tag: 'fork', script })
    expect(run.exitCode).toBe(0)
    expect(run.timedOut).toBe(false)
    const forkId = (await sessionIds(source, 'ls1')).find((id) => id !== sourceId)!
    const exported = await exportSession(source, forkId, 'export1')
    expect(mains(requests)).toHaveLength(1)
    expect(fidelity(mains(requests)[0]!, exported)).toEqual(['tool set differs: +question'])
    expect(exported.info.permission).not.toEqual(sourceExport.info.permission)
  })

  probe('mechanism (a), import of the exported JSON into a fresh lab, then -s: history, parts and tool set match the source; no compaction', async () => {
    imported = cloneLab(source)
    const doc = structuredClone(sourceExport)
    doc.info.directory = realpathSync(imported.workspace)
    const file = join(imported.root, 'seed-export.json')
    writeFileSync(file, JSON.stringify(doc))
    const imp = await hostRun(imported, ['import', file], { tag: 'import' })
    expect(imp.run.exitCode).toBe(0)
    expect(imp.run.stdout).toContain(sourceId)
    expect(await sessionIds(imported, 'ls2')).toEqual([sourceId])

    const { run, requests } = await hostRun(imported, runArgs(OPUS, '-s', sourceId, 'Continue.'), { tag: 'import-run', script })
    expect(run.exitCode).toBe(0)
    expect(run.timedOut).toBe(false)
    expect(requests).toHaveLength(1)
    expect(mains(requests)).toHaveLength(1)
    const exported = await exportSession(imported, sourceId, 'export2')
    expect(fidelity(mains(requests)[0]!, exported)).toEqual([])
    expect(chatBody(mains(requests)[0]!).model).toBe('claude-opus-5-5')
  })

  probe('the fidelity check reports a truncated, reordered, result-less or compacted seed', async () => {
    const parts = partsSignature(sourceExport)
    const base: FidelityInput = { source: sourceNorm, replay: sourceNorm, sourceParts: parts, replayParts: parts, replaySystem: 'You are OpenCode.', replayPartTypes: ['text', 'tool'], sourceTools: ['read'], replayTools: ['read'] }
    expect(checkFidelity(base)).toEqual([])
    expect(checkFidelity({ ...base, replay: sourceNorm.slice(0, -3) }).join(';')).toContain('message count')
    expect(checkFidelity({ ...base, replay: [...sourceNorm.slice(0, 3), sourceNorm[4]!, sourceNorm[3]!, ...sourceNorm.slice(5)] }).join(';')).toContain('differs from the source')
    const noResult = sourceNorm.filter((l) => !l.startsWith('T:call_read1:'))
    expect(checkFidelity({ ...base, source: noResult, replay: noResult }).join(';')).toContain('tool call call_read1 has no result')
    expect(checkFidelity({ ...base, replayParts: parts.slice(0, -2) }).join(';')).toContain('part-level message count')
    expect(checkFidelity({ ...base, replaySystem: 'You are a context summarization agent.' })).toContain('compaction present')
    expect(checkFidelity({ ...base, replayPartTypes: ['compaction'] })).toContain('compaction present')
    expect(checkFidelity({ ...base, replayTools: ['read', 'question'] })).toEqual(['tool set differs: +question'])
  })

  probe('--model reaches the stub for both models, the default agent stays orchestrator, and only the main request carries the model', async () => {
    for (const [model, wire, provider] of [[LUNA, 'gpt-6-luna', 'openai'], [OPUS, 'claude-opus-5-5', 'anthropic']] as const) {
      const { run, requests } = await hostRun(imported, runArgs(model, '-s', sourceId, 'Continue.'), { tag: `model-${wire}`, script })
      expect(run.exitCode).toBe(0)
      expect(mains(requests).map((r) => chatBody(r).model)).toEqual([wire])
      expect(requests.filter((r) => !mains(requests).includes(r)).map((r) => chatBody(r).model)).toEqual([])
      const last = (await exportSession(imported, sourceId, `export-${wire}`)).messages.findLast((m) => m.info.role === 'assistant')!.info
      expect([last.providerID, last.modelID, last.agent]).toEqual([provider, wire, 'orchestrator'])
    }
  })

  probe('typed /feel and /drugs arrive as the skill text in the user message with the arguments last; both tools and skills are offered', async () => {
    const packed = await packedPlugin()
    const base = `Base directory for this skill: ${packed.pluginSkillsDir}`
    const argsOf = (t: string): string => t.split('relative to this base directory.')[1]!.trim()
    const cases: [string, string[], string, boolean][] = [
      ['feel', ['--command', 'feel'], '', false],
      ['drugs', ['--command', 'drugs', 'strong', 'black', 'coffee'], 'strong black coffee', true],
      ['drugs', ['--command', 'drugs', 'strong black coffee'], '"strong black coffee"', false],
      ['drugs', ['--command', 'drugs', 'caffeine'], 'caffeine', false],
    ]
    for (const [i, [name, extra, args, council]] of cases.entries()) {
      const { run, requests } = await hostRun(imported, runArgs(OPUS, '-s', sourceId, ...extra), { tag: `cmd${i}`, script })
      expect(run.exitCode).toBe(0)
      const main = mains(requests).at(-1)!
      const text = lastUserText(main)
      expect(text.startsWith(`# ${name}\n\nCall the \`${name}\` tool`)).toBe(true)
      expect(text).toContain(`${base}/${name}`)
      expect(text).not.toContain('<skill_content')
      expect(argsOf(text)).toBe(args)
      expect(userTextsAnyWire(main.body as Record<string, unknown>).at(-1)?.startsWith('§')).toBe(true)
      const parts = partText(chatBody(main).messages.findLast((m) => m.role === 'user')?.content)
      expect(parts.slice(1).some((p) => p.includes('## Council Mode'))).toBe(council)
      expect(toolNames(main)).toEqual(expect.arrayContaining(['feel', 'drugs']))
      expect(skillList(main)).toEqual(expect.arrayContaining(['feel', 'drugs', 'synthesis', 'counterfactual']))
    }
  })

  probe('the Responses and Anthropic user-text shapes read the same way', async () => {
    const text = '# drugs\n\nbody\n\nstrong black coffee'
    expect(userTextsAnyWire({ input: [{ role: 'developer', content: 'x' }, { role: 'user', content: [{ type: 'input_text', text }] }] })).toEqual([text])
    expect(userTextsAnyWire({ system: 'x', messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'r' }, { type: 'text', text }] }] })).toEqual([text])
  })

  test.skipIf(!process.env.METACOGS_AUTH_CLIPROXY)('CLIProxyAPI lists claude-opus-5-5 and a Luna id (ids only, free GET)', async () => {
    const key = fetchCliproxyKey(process.env.METACOGS_AUTH_CLIPROXY!)
    const res = await fetch(`${CLIPROXY_UPSTREAM}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
    expect(res.status).toBe(200)
    const data = ((await res.json()) as { data: { id: string; owned_by: string }[] }).data
    const ids = data.map((m) => m.id)
    expect(ids).toContain('claude-opus-5-5')
    expect(ids).toContain('gpt-6-luna')
    expect(data.find((m) => m.id === 'claude-opus-5-5')?.owned_by).toBe('anthropic')
    expect(data.find((m) => m.id === 'gpt-6-luna')?.owned_by).toBe('openai')
    expect(ids.filter((id) => id.startsWith('opencode-go/') && /luna/.test(id))).toEqual([])
  }, 120_000)

  probe('the egress instruments see a known connection (controls)', async () => {
    const sink = await startEgressSink()
    const proxyEnv = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${sink.port}` }
    await new Promise((resolve) => spawn('curl', ['-sS', '--max-time', '5', 'https://egress-control.invalid/'], { env: proxyEnv, stdio: 'ignore' }).once('close', resolve))
    expect([...sink.seen]).toEqual(['connect:egress-control.invalid:443'])
    sink.stop()

    const listener = createServer().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => listener.once('listening', resolve))
    const port = (listener.address() as { port: number }).port
    const child = spawn('bun', ['-e', `require('node:net').connect(${port}, '127.0.0.1'); setTimeout(() => {}, 3000)`], { detached: true, stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const seen = new Set<string>()
    sampleRemotes(child.pid!, seen, true)
    process.kill(-child.pid!, 'SIGKILL')
    listener.close()
    expect([...seen]).toEqual([`127.0.0.1:${port}`])
  })

  probe('with the switches set, a full turn under a refusing proxy shows no egress', async () => {
    const fx = cloneLab(source)
    const sink = await startEgressSink()
    const remotes = new Set<string>()
    let timer: ReturnType<typeof setInterval> | undefined
    const proxy = `http://127.0.0.1:${sink.port}`
    try {
      const { run } = await hostRun(fx, runArgs(OPUS, 'hello'), {
        tag: 'egress',
        script,
        env: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' },
        onSpawn: (pgid) => {
          timer = setInterval(() => sampleRemotes(pgid, remotes), 250)
        },
      })
      expect(run.exitCode).toBe(0)
    } finally {
      clearInterval(timer)
      sink.stop()
    }
    expect([...sink.seen]).toEqual([])
    expect([...remotes]).toEqual([])
  })

  probe('no host process outlives its run', async () => {
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    const alive = ps.filter((line) => fixtures.some((fx) => line.includes(fx.root)))
    for (const line of alive) process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL')
    expect(alive).toEqual([])
  })
})
