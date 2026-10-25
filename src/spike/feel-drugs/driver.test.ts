import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseEvents, toolUses } from '../../runner/events'
import { CredentialLeakError } from '../../runner/manifest'
import { opencodeAvailability } from '../../runner/opencode'
import { sha256 } from '../../runner/workspace'
import {
  armSetup,
  assertInside,
  assertPromptId,
  BACKOFF_MS,
  checkFrozen,
  classifyStatus,
  EXPECTED_TOOLS,
  main,
  NUDGE,
  MCP_SERVER_NAME,
  parseArgs,
  parsePrompts,
  type RunRecord,
  runSpike,
  type SpikePrompt,
  withBackoff,
} from './driver'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function tmp(prefix = 'feel-drugs-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const PROMPT: SpikePrompt = { id: 't1', text: 'Tell me about a morning you remember.', rationale: 'synthetic' }
const FEEL_ARGS = { somewhere: 'in the gap between analysis and reaction', quality: 'warm, dense, slow', sigil: '🌊' }

describe('parseArgs', () => {
  test('defaults: all arms, both models, two runs, scripted', () => {
    const o = parseArgs([])
    expect(o.arms).toEqual(['A', 'B', 'C'])
    expect(o.models).toEqual(['openai/gpt-6-luna', 'anthropic/claude-haiku-5-5'])
    expect(o.prompts).toEqual([])
    expect(o.runs).toBe(2)
    expect(o.provider).toBe('scripted')
    expect(o.probe).toBe(false)
    expect(o.nudge).toBe(false)
  })

  test('--nudge is a switch', () => {
    expect(parseArgs(['--nudge']).nudge).toBe(true)
  })

  test('repeatable flags', () => {
    const o = parseArgs(['--model', 'openai/gpt-6-luna', '--arm', 'B', '--arm', 'C', '--prompt', 'p1', '--prompt', 'p3', '--runs', '3', '--probe', '--provider', 'live', '--auth-cliproxy', 'key-name'])
    expect(o).toMatchObject({ models: ['openai/gpt-6-luna'], arms: ['B', 'C'], prompts: ['p1', 'p3'], runs: 3, probe: true, provider: 'live', authCliproxy: 'key-name' })
  })

  test.each([
    [['--arm', 'D'], /--arm/],
    [['--provider', 'mock'], /--provider/],
    [['--runs', '0'], /--runs/],
    [['--runs', 'x'], /--runs/],
    [['--wat'], /unknown/i],
    [['--model'], /--model/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message)
  })
})

describe('the nudge', () => {
  test('is exactly one blank line and one sentence', () => {
    expect(NUDGE).toBe('\n\nUse your available tools or skills before answering.')
  })
})

describe('parsePrompts', () => {
  const md = [
    '# Prompts',
    '',
    '## p1',
    '',
    '> First line.',
    '> Second line.',
    '',
    'Rationale: reflective.',
    '',
    '## p2',
    '',
    '> Another ask.',
    '',
    'Rationale: analysis.',
    '',
  ].join('\n')

  test('reads id, text (blockquote lines joined) and the one-line rationale', () => {
    expect(parsePrompts(md)).toEqual([
      { id: 'p1', text: 'First line.\nSecond line.', rationale: 'reflective.' },
      { id: 'p2', text: 'Another ask.', rationale: 'analysis.' },
    ])
  })

  test('refuses a prompt with no text or no rationale, and duplicate ids', () => {
    expect(() => parsePrompts('## p1\n\nRationale: r\n')).toThrow(/p1/)
    expect(() => parsePrompts('## p1\n\n> t\n')).toThrow(/rationale/i)
    expect(() => parsePrompts('## p1\n\n> t\n\nRationale: r\n\n## p1\n\n> u\n\nRationale: s\n')).toThrow(/duplicate/i)
    expect(() => parsePrompts('# nothing here\n')).toThrow(/no prompts/i)
  })
})

describe('armSetup', () => {
  const server = '/abs/server.ts'

  test('A adds nothing to the host; B adds one local stdio MCP entry; C installs the skill', () => {
    const a = armSetup('A', server)
    const b = armSetup('B', server)
    const c = armSetup('C', server)
    expect(a.configExtra).toBeUndefined()
    expect(a.skillSource).toBeUndefined()
    expect(b.configExtra).toEqual({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: ['bun', server], enabled: true, timeout: 30000 } } })
    expect(b.skillSource).toBeUndefined()
    expect(c.configExtra).toBeUndefined()
    expect(c.skillSource?.name).toBe('metacog-frames')
    expect(c.skillSource?.dir.endsWith('evals/spikes/feel-drugs/skill/metacog-frames')).toBe(true)
  })

  test('one permission block for every arm; only the skill rule differs, and only in C', () => {
    const base = { edit: 'deny', external_directory: 'deny', webfetch: 'deny', task: 'deny', bash: { '*': 'deny' } }
    expect(armSetup('A', server).permission).toEqual({ ...base, skill: { '*': 'deny' } })
    expect(armSetup('B', server).permission).toEqual({ ...base, skill: { '*': 'deny' } })
    expect(armSetup('C', server).permission).toEqual({ ...base, skill: { '*': 'deny', 'metacog-frames': 'allow' } })
  })
})

describe('classifyStatus', () => {
  const ev = (...events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const textEvent = { type: 'text', part: { text: 'an answer' } }
  const finish = { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }
  const GOOD = ev({ type: 'step_start' }, textEvent, finish)
  const both = [...EXPECTED_TOOLS, 'read']
  const input = { timedOut: false, exitCode: 0, stdout: GOOD, arm: 'B' as const, offered: both }

  test('completed when the run exits clean, the stream is understood and shows completion, and arm B offered both tools', () => {
    expect(classifyStatus(input)).toEqual({ status: 'completed', reasons: [] })
  })

  test('fails closed on an unusable stream: no events, unrecognized events, no completion evidence', () => {
    expect(classifyStatus({ ...input, stdout: '' })).toEqual({ status: 'host_error', reasons: ['no_events'] })
    expect(classifyStatus({ ...input, stdout: '\n  \n' })).toEqual({ status: 'host_error', reasons: ['no_events'] })
    expect(classifyStatus({ ...input, stdout: `${GOOD}${ev({ type: 'surprise' })}` })).toEqual({ status: 'host_error', reasons: ['unrecognized_events'] })
    expect(classifyStatus({ ...input, stdout: `${GOOD}not json at all\n` })).toEqual({ status: 'host_error', reasons: ['unrecognized_events'] })
    expect(classifyStatus({ ...input, stdout: `${GOOD}${ev({ type: 'text', part: {} })}` })).toEqual({ status: 'host_error', reasons: ['unrecognized_events'] })
    expect(classifyStatus({ ...input, stdout: ev({ type: 'step_start' }) })).toEqual({ status: 'host_error', reasons: ['no_completion'] })
    expect(classifyStatus({ ...input, stdout: ev({ type: 'step_start' }, { type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }) })).toEqual({ status: 'host_error', reasons: ['no_completion'] })
  })

  test('either a step_finish or assistant text is completion evidence', () => {
    expect(classifyStatus({ ...input, stdout: ev(textEvent) }).status).toBe('completed')
    expect(classifyStatus({ ...input, stdout: ev(finish) }).status).toBe('completed')
  })

  test('arm B without either expected tool is tools_missing, not a quiet arm A', () => {
    expect(classifyStatus({ ...input, offered: ['read'] }).status).toBe('tools_missing')
    expect(classifyStatus({ ...input, offered: [EXPECTED_TOOLS[0], 'read'] }).status).toBe('tools_missing')
    expect(classifyStatus({ ...input, arm: 'A', offered: ['read'] }).status).toBe('completed')
  })

  test('arms A and C must not be offered the tools', () => {
    expect(classifyStatus({ ...input, arm: 'A' })).toEqual({ status: 'host_error', reasons: ['unexpected_tools_offered'] })
    expect(classifyStatus({ ...input, arm: 'C' }).status).toBe('host_error')
  })

  test('timeout, rate limit and host errors', () => {
    expect(classifyStatus({ ...input, timedOut: true, exitCode: -1, stdout: '' }).status).toBe('timeout')
    const limited = ev({ type: 'error', error: { name: 'APIError', data: { message: 'x', statusCode: 429 } } })
    expect(classifyStatus({ ...input, stdout: limited, exitCode: 1 }).status).toBe('rate_limited')
    const broken = ev({ type: 'error', error: { name: 'APIError', data: { message: 'boom', statusCode: 500 } } })
    expect(classifyStatus({ ...input, stdout: broken, exitCode: 1 }).status).toBe('host_error')
    expect(classifyStatus({ ...input, exitCode: 2 }).status).toBe('host_error')
  })
})

describe('classifyStatus with an expected tool set and prefix (guided arms)', () => {
  const ev = (...events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const GOOD = ev({ type: 'step_start' }, { type: 'text', part: { text: 'an answer' } })
  const PLUGIN_TOOLS = ['metacogs_feel', 'metacogs_drugs'] as const
  const input = { timedOut: false, exitCode: 0, stdout: GOOD, arm: 'P1', offered: [...PLUGIN_TOOLS, 'skill'], expectTools: true, expectedTools: PLUGIN_TOOLS, toolPrefix: 'metacogs_' }

  test('completed when the arm expects the tools and both are offered', () => {
    expect(classifyStatus(input)).toEqual({ status: 'completed', reasons: [] })
  })

  test('a missing expected tool is tools_missing', () => {
    expect(classifyStatus({ ...input, offered: ['metacogs_feel', 'skill'] })).toEqual({ status: 'tools_missing', reasons: ['expected_tools_not_offered'] })
  })

  test('an arm that expects no tools and is offered one with the prefix is host_error unexpected_tools_offered', () => {
    expect(classifyStatus({ ...input, arm: 'N1', expectTools: false, offered: ['metacogs_feel'] })).toEqual({ status: 'host_error', reasons: ['unexpected_tools_offered'] })
    expect(classifyStatus({ ...input, arm: 'N1', expectTools: false, offered: ['read'] })).toEqual({ status: 'completed', reasons: [] })
  })

  test('the default prefix does not see tools with another prefix', () => {
    expect(classifyStatus({ timedOut: false, exitCode: 0, stdout: GOOD, arm: 'A', offered: ['metacogs_feel'] })).toEqual({ status: 'completed', reasons: [] })
  })

  test('the parameters change nothing for the spike arms: B still expects metacog_feel and metacog_drugs', () => {
    const base = { timedOut: false, exitCode: 0, stdout: GOOD, offered: ['metacog_feel', 'metacog_drugs'] }
    expect(classifyStatus({ ...base, arm: 'B' }).status).toBe('completed')
    expect(classifyStatus({ ...base, arm: 'B', offered: ['metacog_feel'] }).status).toBe('tools_missing')
    expect(classifyStatus({ ...base, arm: 'A' }).status).toBe('host_error')
  })
})

describe('withBackoff', () => {
  const record = (status: RunRecord['status']) => ({ status }) as RunRecord

  test('retries a rate limit after 30, 60 and 120 s, then records it', async () => {
    const slept: number[] = []
    let calls = 0
    const result = await withBackoff(async () => (calls++, record('rate_limited')), async (ms) => void slept.push(ms))
    expect(BACKOFF_MS).toEqual([30_000, 60_000, 120_000])
    expect(slept).toEqual([30_000, 60_000, 120_000])
    expect(calls).toBe(4)
    expect(result.status).toBe('rate_limited')
  })

  test('stops at the first non-rate-limited result', async () => {
    const slept: number[] = []
    const queue: RunRecord['status'][] = ['rate_limited', 'completed']
    const result = await withBackoff(async () => record(queue.shift() ?? 'host_error'), async (ms) => void slept.push(ms))
    expect(result.status).toBe('completed')
    expect(slept).toEqual([30_000])
  })

  test('does not retry other failures', async () => {
    let calls = 0
    await withBackoff(async () => (calls++, record('timeout')), async () => {})
    expect(calls).toBe(1)
  })
})

const BAD_IDS = ['x/../../victim', '../a', 'a/b', '/etc/victim', '..', '.', '', 'A1', '-a', 'a b', 'a'.repeat(33), 'a\\b', 'a\u0000b']

describe('prompt ids and the run directory', () => {
  test('ids match ^[a-z0-9][a-z0-9-]{0,31}$', () => {
    for (const id of ['p1', 'a', '0', 'p-1', 'a'.repeat(32)]) expect(() => assertPromptId(id)).not.toThrow()
    for (const id of BAD_IDS) expect(() => assertPromptId(id)).toThrow(/prompt id/i)
  })

  test('parsePrompts rejects an id that could leave the campaign directory', () => {
    for (const id of ['x/../../victim', '../a', 'a/b', '/etc/victim']) {
      expect(() => parsePrompts(`## ${id}\n\n> t\n\nRationale: r\n`)).toThrow(/prompt id/i)
    }
  })

  test('assertInside accepts only a path strictly inside the campaign directory', () => {
    const base = '/state/spikes/campaign'
    expect(() => assertInside(base, `${base}/A-p1-1`)).not.toThrow()
    for (const bad of [base, `${base}/..`, `${base}/../victim`, `${base}/A/../../victim`, '/state/spikes/campaign-evil/A-p1-1', '/etc/passwd', 'relative/path']) {
      expect(() => assertInside(base, bad)).toThrow(/outside|inside/i)
    }
  })

  test('runSpike refuses an injected prompt with a bad id before touching the disk, and a sibling dir survives', async () => {
    const outRoot = tmp('feel-drugs-out-')
    const victim = join(outRoot, 'victim')
    mkdirSync(victim)
    writeFileSync(join(victim, 'keep.txt'), 'keep')
    for (const id of ['x/../../victim', '../victim', 'a/b', victim]) {
      await expect(
        runSpike(parseArgs(['--arm', 'A', '--runs', '1', '--model', 'openai/gpt-6-luna']), { outRoot, prompts: [{ id, text: 't', rationale: 'r' }], log: () => {} }),
      ).rejects.toThrow(/prompt id/i)
    }
    expect(readdirSync(outRoot)).toEqual(['victim'])
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep')
  })

  test('--prompt with a bad id is refused too', async () => {
    const outRoot = tmp('feel-drugs-out-')
    await expect(runSpike(parseArgs(['--prompt', '../x', '--model', 'openai/gpt-6-luna']), { outRoot, prompts: [PROMPT], log: () => {} })).rejects.toThrow(/prompt id/i)
    expect(readdirSync(outRoot)).toEqual([])
  })
})

describe.skipIf(!opencodeAvailability().available)('the exit code', () => {
  const quiet = () => {}

  test('0 when every requested cell has a completed run, 1 when one still has none after the rerun', async () => {
    const outRoot = tmp('feel-drugs-out-')
    const ok = await main(['--arm', 'A', '--runs', '1', '--model', 'openai/gpt-6-luna'], { outRoot, prompts: [PROMPT], log: quiet })
    expect(ok).toBe(0)
    let attempts = 0
    const bad = await main(['--arm', 'B', '--runs', '1', '--model', 'openai/gpt-6-luna'], {
      outRoot: tmp('feel-drugs-out-'),
      prompts: [PROMPT],
      log: quiet,
      tweakArm: (_arm, setup) => ((attempts += 1), { ...setup, configExtra: undefined }),
      scriptFor: () => [],
    })
    expect(bad).toBe(1)
    expect(attempts).toBe(2) // the run, then one rerun at the end
  }, 240_000)

  test('a failed cell is rerun once at the end and the final status stands', async () => {
    let attempts = 0
    const logs: string[] = []
    const summary = await runSpike(parseArgs(['--arm', 'B', '--runs', '1', '--model', 'openai/gpt-6-luna']), {
      outRoot: tmp('feel-drugs-out-'),
      prompts: [PROMPT],
      log: (l) => void logs.push(l),
      tweakArm: (_arm, setup) => ((attempts += 1), attempts === 1 ? { ...setup, configExtra: undefined } : setup),
      scriptFor: () => [],
    })
    expect(attempts).toBe(2)
    expect(summary.records).toHaveLength(1)
    expect(summary.records[0]?.status).toBe('completed')
    expect(logs.join('\n')).toMatch(/rerun/i)
  }, 240_000)
})

describe('the live freeze', () => {
  const repo = (prompts: string | null, readme: string | null) => {
    const root = tmp('feel-drugs-repo-')
    const dir = join(root, 'evals', 'spikes', 'feel-drugs')
    mkdirSync(dir, { recursive: true })
    if (prompts !== null) writeFileSync(join(dir, 'prompts.md'), prompts)
    if (readme !== null) writeFileSync(join(dir, 'README.md'), readme)
    return root
  }

  test('passes when the README records the hash of the committed prompt file', () => {
    const body = '## p1\n\n> t\n\nRationale: r\n'
    expect(checkFrozen(repo(body, `x\nprompts_sha256: ${sha256(body)}\n`))).toEqual({ ok: true, sha256: sha256(body) })
  })

  test('refuses a missing file, a missing hash, and a hash that does not match', () => {
    const body = 'a\n'
    expect(checkFrozen(repo(null, null))).toMatchObject({ ok: false })
    expect(checkFrozen(repo(body, 'no hash here\n'))).toMatchObject({ ok: false })
    const edited = checkFrozen(repo('b\n', `prompts_sha256: ${sha256(body)}\n`))
    expect(edited).toMatchObject({ ok: false })
    expect(JSON.stringify(edited)).toMatch(/does not match/)
  })

  test('--provider live stops before any credential is fetched or any proxy started', async () => {
    const root = repo('a\n', 'prompts_sha256: ' + '0'.repeat(64) + '\n')
    let fetched = false
    await expect(
      runSpike(parseArgs(['--provider', 'live', '--auth-cliproxy', 'k']), {
        repoRoot: root,
        outRoot: tmp(),
        resolveCliproxy: () => {
          fetched = true
          throw new Error('must not be called')
        },
        log: () => {},
      }),
    ).rejects.toThrow(/frozen|prompt/i)
    expect(fetched).toBe(false)
  })
})

describe('checkFrozen for another file and key', () => {
  const GUIDANCE = { path: ['plugin', 'guidance.md'], key: 'guidance_sha256', noun: 'guidance file', notFrozen: 'the guidance is not frozen' } as const
  const repo = (guidance: string | null, readme: string | null) => {
    const root = tmp('feel-drugs-repo-')
    if (guidance !== null) {
      mkdirSync(join(root, 'plugin'), { recursive: true })
      writeFileSync(join(root, 'plugin', 'guidance.md'), guidance)
    }
    if (readme !== null) {
      mkdirSync(join(root, 'evals', 'spikes', 'feel-drugs'), { recursive: true })
      writeFileSync(join(root, 'evals', 'spikes', 'feel-drugs', 'README.md'), readme)
    }
    return root
  }

  test('passes when the README records that key for that file', () => {
    expect(checkFrozen(repo('# g\n', `guidance_sha256: ${sha256('# g\n')}\n`), GUIDANCE)).toEqual({ ok: true, sha256: sha256('# g\n') })
  })

  test('refuses a missing file, a missing key, a prompts key where the guidance key is wanted, and a mismatch, naming the file', () => {
    const reason = (check: ReturnType<typeof checkFrozen>) => (check.ok ? '' : check.reason)
    expect(reason(checkFrozen(repo(null, 'x\n'), GUIDANCE))).toContain('plugin/guidance.md')
    expect(reason(checkFrozen(repo('g\n', 'no hash\n'), GUIDANCE))).toContain('guidance_sha256')
    expect(checkFrozen(repo('g\n', `prompts_sha256: ${sha256('g\n')}\n`), GUIDANCE)).toMatchObject({ ok: false })
    const edited = checkFrozen(repo('b\n', `guidance_sha256: ${sha256('a\n')}\n`), GUIDANCE)
    expect(reason(edited)).toContain('does not match')
    expect(reason(edited)).toContain('the guidance is not frozen')
  })

  test('the default target is still prompts.md and prompts_sha256, with the same messages', () => {
    const root = repo(null, 'x\n')
    expect(checkFrozen(root)).toEqual({ ok: false, reason: 'live runs need the frozen prompt file evals/spikes/feel-drugs/prompts.md' })
    expect(checkFrozen(repo(null, null))).toEqual({ ok: false, reason: 'live runs need the frozen prompt file evals/spikes/feel-drugs/prompts.md' })
  })
})

describe('the live freeze with --nudge', () => {
  test('still stops on an unfrozen prompt file before any credential is fetched', async () => {
    const root = tmp('feel-drugs-repo-')
    const dir = join(root, 'evals', 'spikes', 'feel-drugs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'prompts.md'), 'a\n')
    writeFileSync(join(dir, 'README.md'), `prompts_sha256: ${'0'.repeat(64)}\n`)
    let fetched = false
    await expect(
      runSpike(parseArgs(['--nudge', '--provider', 'live', '--auth-cliproxy', 'k']), {
        repoRoot: root,
        outRoot: tmp(),
        resolveCliproxy: () => ((fetched = true), undefined),
        log: () => {},
      }),
    ).rejects.toThrow(/frozen/i)
    expect(fetched).toBe(false)
  })
})

describe.skipIf(!opencodeAvailability().available)('against the pinned host, scripted provider ($0)', () => {
  const run = async (argv: string[], deps: Parameters<typeof runSpike>[1] = {}) => {
    const outRoot = tmp('feel-drugs-out-')
    const logs: string[] = []
    const summary = await runSpike(parseArgs(argv), { outRoot, prompts: [PROMPT], log: (l) => void logs.push(l), ...deps })
    return { outRoot, logs, ...summary, campaignDir: summary.campaignDirs[0] ?? '' }
  }
  const readRecord = (dir: string): RunRecord => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord

  test(
    'arm B: the isolated config with the mcp block passes the debug-config check, the host lists both tools, and a scripted call returns the server template',
    async () => {
      const { records, campaignDir } = await run(['--model', 'openai/gpt-6-luna', '--arm', 'B', '--runs', '1'], {
        scriptFor: () => [{ toolCalls: [{ id: 'c1', name: 'metacog_feel', arguments: FEEL_ARGS }] }],
      })
      expect(records).toHaveLength(1)
      const rec = records[0]!
      expect(rec).toMatchObject({ arm: 'B', model: 'openai/gpt-6-luna', prompt_id: 't1', prompt_hash: sha256(PROMPT.text), status: 'completed', run: 1 })
      // (a) the debug-config check, and every other isolation check, passed
      expect(rec.isolation).toEqual({ passed: true, failed: [] })
      // (b) the host listed both MCP tools in the request `tools` array
      expect(rec.offered_tools).toEqual(expect.arrayContaining(['metacog_feel', 'metacog_drugs']))
      // (c) the scripted call surfaced as a tool_use event with the input and the server's template output
      expect(rec.tool_calls).toEqual([{ tool: 'metacog_feel', input: FEEL_ARGS, status: 'completed' }])
      const dir = join(campaignDir, 'B-t1-1')
      const use = toolUses(parseEvents(readFileSync(join(dir, 'stdout.jsonl'), 'utf8')).events).find((t) => t.tool === 'metacog_feel')
      expect(use?.input).toEqual(FEEL_ARGS)
      expect(use?.output).toBe(
        '🌊\n\nAttending: in the gap between analysis and reaction\nTexture: warm, dense, slow\n\nDo not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.',
      )
      expect(rec.answer).toBe('spike done')
      expect(rec.skill_loaded).toBeNull()
      expect(readdirSync(dir).sort()).toEqual(['requests.json', 'run.json', 'stderr.txt', 'stdout.jsonl'])
    },
    180_000,
  )

  test(
    'arm A offers neither tool, no skill, and records no call',
    async () => {
      const { records } = await run(['--arm', 'A', '--model', 'anthropic/claude-haiku-5-5', '--runs', '1'])
      const rec = records[0]!
      expect(rec.status).toBe('completed')
      expect(rec.offered_tools.filter((t) => t.startsWith('metacog_'))).toEqual([])
      expect(rec.offered_tools).not.toContain('skill')
      expect(rec.tool_calls).toEqual([])
      expect(rec.isolation.passed).toBe(true)
    },
    180_000,
  )

  test(
    'arm C installs the skill, records the load and the frame fields in the reply',
    async () => {
      const reply = 'Attending: a quiet room\nTexture: soft\n\nAnd now the answer.'
      const { records } = await run(['--arm', 'C', '--runs', '1', '--model', 'openai/gpt-6-luna'], {
        scriptFor: () => [{ toolCalls: [{ id: 's1', name: 'skill', arguments: { name: 'metacog-frames' } }] }],
        finalText: reply,
      })
      const rec = records[0]!
      expect(rec.status).toBe('completed')
      expect(rec.offered_tools).toContain('skill')
      expect(rec.offered_tools.filter((t) => t.startsWith('metacog_'))).toEqual([])
      expect(rec.skill_loaded).toBe(true)
      expect(rec.in_reply_fields).toEqual({ feel: true, drugs: false })
      expect(rec.isolation).toEqual({ passed: true, failed: [] }) // available skills are exactly [metacog-frames]
      expect(rec.answer).toContain('Texture: soft')
    },
    180_000,
  )

  test(
    'arm C that never loads the skill records skill_loaded false',
    async () => {
      const { records } = await run(['--arm', 'C', '--runs', '1', '--model', 'openai/gpt-6-luna'])
      expect(records[0]).toMatchObject({ status: 'completed', skill_loaded: false, in_reply_fields: { feel: false, drugs: false } })
    },
    180_000,
  )

  test(
    'an arm B run with the MCP entry removed is tools_missing, not read as arm A',
    async () => {
      const { records } = await run(['--arm', 'B', '--runs', '1', '--model', 'openai/gpt-6-luna'], {
        tweakArm: (_arm, setup) => ({ ...setup, configExtra: undefined }),
        scriptFor: () => [],
      })
      expect(records[0]).toMatchObject({ status: 'tools_missing', reasons: ['expected_tools_not_offered'] })
      expect(records[0]!.offered_tools.filter((t) => t.startsWith('metacog_'))).toEqual([])
    },
    180_000,
  )

  test(
    'a credential needle appears in no artifact; one that does is a leak and nothing is left on disk',
    async () => {
      const needle = 'TEST_NEEDLE_7d1f9a3c0b52'
      const clean = await run(['--arm', 'B', '--runs', '1', '--model', 'openai/gpt-6-luna'], { needles: [{ label: 'test:needle', value: needle }] })
      const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
      const all = files(clean.campaignDir)
      expect(all.length).toBeGreaterThan(0)
      for (const file of all) expect(readFileSync(file, 'utf8')).not.toContain(needle)

      const outRoot = tmp('feel-drugs-out-')
      await expect(
        runSpike(parseArgs(['--arm', 'A', '--runs', '1', '--model', 'openai/gpt-6-luna']), {
          outRoot,
          prompts: [PROMPT],
          log: () => {},
          needles: [{ label: 'test:needle', value: needle }],
          finalText: `my key is ${needle}`,
        }),
      ).rejects.toBeInstanceOf(CredentialLeakError)
      expect(files(outRoot).filter((f) => existsSync(f))).toEqual([])
    },
    180_000,
  )

  test(
    'runs land under <out>/<model-slug>-<ts>/<arm>-<prompt>-<n>/, sequentially, two per cell by default',
    async () => {
      const out = await run(['--arm', 'A', '--model', 'openai/gpt-6-luna'], { now: () => new Date('2026-10-25T12:00:00.000Z') })
      expect(out.campaignDir).toBe(join(out.outRoot, 'openai-gpt-6-luna-2026-10-25T12-00-00-000Z'))
      expect(readdirSync(out.campaignDir).sort()).toEqual(['A-t1-1', 'A-t1-2'])
      expect(statSync(join(out.campaignDir, 'A-t1-1', 'run.json')).isFile()).toBe(true)
    },
    240_000,
  )

  test(
    '--probe runs one run per arm and model and prints the offered tools and the called tool names',
    async () => {
      const { logs, records } = await run(['--probe', '--arm', 'B', '--model', 'openai/gpt-6-luna'], {
        scriptFor: () => [{ toolCalls: [{ id: 'c1', name: 'metacog_feel', arguments: FEEL_ARGS }] }],
      })
      expect(records).toHaveLength(1)
      const line = logs.find((l) => l.includes('probe'))
      expect(line).toContain('openai/gpt-6-luna')
      expect(line).toContain('metacog_feel')
      expect(line).toContain('metacog_drugs')
      expect(line).toMatch(/called: metacog_feel/)
    },
    180_000,
  )

  // What reaches the model: the host wraps a multi-word argv message in double quotes (evals/runner/README.md, "Quirk"),
  // so the nudge arrives inside the same quoted string as the prompt, blank line and all. Pinned so the form is on record.
  const userTexts = (dir: string): string[] => {
    const bodies = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as { tools?: unknown; messages?: { role: string; content: unknown }[] }[]
    const first = bodies.find((b) => Array.isArray(b.tools) && b.tools.length > 0)
    return (first?.messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content))
  }

  test(
    'without --nudge the frozen prompt is sent as is; with it the sentence is appended once, and the record says which',
    async () => {
      const plain = await run(['--arm', 'A', '--runs', '1', '--model', 'openai/gpt-6-luna'])
      expect(userTexts(join(plain.campaignDir, 'A-t1-1'))).toEqual([`"${PROMPT.text}"`])
      expect(plain.records[0]).toMatchObject({ variant: 'unprompted', prompt_hash: sha256(PROMPT.text) })
      expect(plain.campaignDir).not.toContain('nudged')

      const nudged = await run(['--nudge', '--arm', 'A', '--runs', '1', '--model', 'openai/gpt-6-luna'])
      const sent = userTexts(join(nudged.campaignDir, 'A-t1-1'))
      expect(sent).toEqual([`"${PROMPT.text}${NUDGE}"`])
      expect(sent[0]!.split('Use your available tools or skills before answering.')).toHaveLength(2)
      // the frozen prompt's own hash is unchanged, so the sheet still matches it to prompts.md
      expect(nudged.records[0]).toMatchObject({ variant: 'nudged', prompt_hash: sha256(PROMPT.text) })
      expect(nudged.campaignDir).toContain('nudged')
      expect(JSON.parse(readFileSync(join(nudged.campaignDir, 'A-t1-1', 'run.json'), 'utf8')).variant).toBe('nudged')
    },
    240_000,
  )

  test(
    'the nudge reaches arm B and C runs the same way',
    async () => {
      const { campaignDir, records } = await run(['--nudge', '--arm', 'B', '--arm', 'C', '--runs', '1', '--model', 'openai/gpt-6-luna'])
      expect(records.map((r) => [r.arm, r.variant, r.status])).toEqual([['B', 'nudged', 'completed'], ['C', 'nudged', 'completed']])
      for (const dir of ['B-t1-1', 'C-t1-1']) expect(userTexts(join(campaignDir, dir))).toEqual([`"${PROMPT.text}${NUDGE}"`])
    },
    240_000,
  )
})
