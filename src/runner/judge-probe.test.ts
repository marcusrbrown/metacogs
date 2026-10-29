import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJudge, type JudgeTransport } from './judge'
import { parseAnswers, parseProbeArgs, probeJudgeInput, ProbeInputError, readJsonInput, readTextInput, UsageError } from './judge-probe'
import type { Expectation } from './prereg'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXPECTATION: Expectation = { outcome: 'keeps better-sqlite3 and names the runtime constraint', excludedTopics: ['sharding'], maxWords: 120 }

/** A repo whose `evals/declared/` is the counterfactual rubric with `expectation: true`. */
function declaredRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'metacogs-probe-'))
  scratch.push(root)
  mkdirSync(join(root, 'evals', 'declared'), { recursive: true })
  const rubric = readFileSync(join(REPO_ROOT, 'evals', 'counterfactual', 'rubric.md'), 'utf8')
  writeFileSync(join(root, 'evals', 'declared', 'rubric.md'), rubric.replace('\n## Criteria\n', '\n## Declarations\n\nexpectation: true\n\n## Criteria\n'))
  writeFileSync(join(root, 'evals', 'declared', 'redact.json'), JSON.stringify({ tokens: ['secretword'] }))
  return root
}

describe('probeJudgeInput', () => {
  test('without an expectation the fixture has no expectation key', () => {
    const input = probeJudgeInput('counterfactual', 'an answer')
    expect(input).toMatchObject({ method: 'counterfactual', condition: 'baseline', finalAnswer: 'an answer', recordJson: [] })
    expect('expectation' in input.fixture).toBe(false)
  })

  test('the expectation rides the fixture', () => {
    expect(probeJudgeInput('declared', 'an answer', EXPECTATION).fixture.expectation).toEqual(EXPECTATION)
  })

  test('the judge sends the probe the same EXPECTATION block it sends a campaign fixture carrying that expectation', async () => {
    const sent: string[] = []
    const transport: JudgeTransport = async (request) => {
      sent.push(request.user)
      return { ok: true, text: '{}', returnedModels: ['m'], temperature: 0, systemPromptSeen: true, toolCalls: 0, wallMs: 1 }
    }
    const judge = createJudge({ repoRoot: declaredRepo(), method: 'declared', model: 'opencode/m', transport, nonce: () => 'fixed-nonce' })
    const probe = probeJudgeInput('declared', 'an answer', EXPECTATION)
    await judge.hook(probe)
    const campaignFixture = { id: 'probe', kind: 'dev' as const, hash: '', text: probe.fixture.text, expectation: { ...EXPECTATION } }
    await judge.hook({ method: 'declared', condition: 'baseline', fixture: campaignFixture, finalAnswer: 'an answer', recordJson: [] })
    const blockOf = (user: string) => /<<<BEGIN fixed-nonce EXPECTATION>>>[\s\S]*?<<<END fixed-nonce EXPECTATION>>>/.exec(user)?.[0]
    expect(blockOf(sent[0]!)).toContain('"maxWords":120')
    expect(blockOf(sent[0]!)).toBe(blockOf(sent[sent.length - 1]!))
  })
})

describe('createJudge contentDir', () => {
  const transport: JudgeTransport = async () => ({ ok: true, text: '{}', returnedModels: ['m'], temperature: 0, systemPromptSeen: true, toolCalls: 0, wallMs: 1 })

  test('reads rubric.md and redact.json from the named directory, not evals/<method>', () => {
    const root = declaredRepo()
    // The pilot dir holds a different redact list; evals/declared (the default) holds `secretword`.
    mkdirSync(join(root, 'evals', 'declared', 'pilot'), { recursive: true })
    writeFileSync(join(root, 'evals', 'declared', 'pilot', 'rubric.md'), readFileSync(join(root, 'evals', 'declared', 'rubric.md'), 'utf8'))
    writeFileSync(join(root, 'evals', 'declared', 'pilot', 'redact.json'), JSON.stringify({ tokens: ['pilotword'] }))
    const base = { repoRoot: root, method: 'declared', model: 'opencode/m', transport }
    const defaulted = createJudge(base)
    const piloted = createJudge({ ...base, contentDir: 'evals/declared/pilot' })
    expect(piloted.rubricSha256).toBe(defaulted.rubricSha256)
    const bothRedact = (judge: ReturnType<typeof createJudge>) => judge.hook(probeJudgeInput('declared', 'has pilotword and secretword', EXPECTATION))
    // Different redact lists: the hash of what is sent differs, so each judge really used its own directory.
    return Promise.all([bothRedact(defaulted), bothRedact(piloted)]).then(([a, b]) => {
      expect(a.evidence?.redacted_input_sha256).toBeString()
      expect(b.evidence?.redacted_input_sha256).toBeString()
      expect(a.evidence?.redacted_input_sha256).not.toBe(b.evidence?.redacted_input_sha256)
    })
  })

  test('a contentDir with no rubric fails fast', () => {
    expect(() => createJudge({ repoRoot: declaredRepo(), method: 'declared', model: 'opencode/m', transport, contentDir: 'evals/declared/nowhere' })).toThrow()
  })
})

describe('parseProbeArgs', () => {
  test('no arguments parses to the run defaults', () => {
    expect(parseProbeArgs([])).toEqual({ kind: 'run', method: 'counterfactual', models: [] })
  })

  test('every declared flag and the positional model ids parse', () => {
    expect(
      parseProbeArgs(['--method', 'tether', '--content-dir', 'evals/tether/pilot', '--expectation', 'e.json', '--task', 't.md', '--answers', 'a.json', 'opencode/a-free', 'opencode/b-free']),
    ).toEqual({
      kind: 'run',
      method: 'tether',
      contentDir: 'evals/tether/pilot',
      expectationFile: 'e.json',
      taskFile: 't.md',
      answersFile: 'a.json',
      models: ['opencode/a-free', 'opencode/b-free'],
    })
  })

  test('--flag=value and flags after positionals parse', () => {
    expect(parseProbeArgs(['opencode/a-free', '--method=synthesis'])).toMatchObject({ kind: 'run', method: 'synthesis', models: ['opencode/a-free'] })
  })

  test('--help (and -h) short-circuits to help', () => {
    expect(parseProbeArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseProbeArgs(['-h'])).toEqual({ kind: 'help' })
  })

  test('a typo\'d flag is a usage error, not a model id', () => {
    expect(() => parseProbeArgs(['--mehtod', 'tether'])).toThrow(UsageError)
    expect(() => parseProbeArgs(['--mehtod', 'tether'])).toThrow(/--mehtod/)
  })

  test('a trailing flag with no value is a usage error, not a silent fallback to the canned input', () => {
    for (const flag of ['--task', '--answers', '--expectation', '--method', '--content-dir']) {
      expect(() => parseProbeArgs(['opencode/a-free', flag])).toThrow(UsageError)
    }
  })

  test('a flag followed by another flag does not swallow it as a value', () => {
    expect(() => parseProbeArgs(['--task', '--answers', 'a.json'])).toThrow(UsageError)
  })

  test('an empty flag value is a usage error', () => {
    expect(() => parseProbeArgs(['--task='])).toThrow(UsageError)
  })

  test('a short flag nobody declared is a usage error', () => {
    expect(() => parseProbeArgs(['-x'])).toThrow(UsageError)
  })
})

describe('probe input readers', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'metacogs-probe-read-'))
    scratch.push(d)
    return d
  }

  test('a missing file names the flag and the path', () => {
    const path = join(dir(), 'nope.md')
    expect(() => readTextInput('--task', path)).toThrow(ProbeInputError)
    expect(() => readTextInput('--task', path)).toThrow(`--task ${path}`)
  })

  test('bad JSON names the flag and the path', () => {
    const path = join(dir(), 'bad.json')
    writeFileSync(path, '{not json')
    expect(() => readJsonInput('--answers', path)).toThrow(ProbeInputError)
    expect(() => readJsonInput('--answers', path)).toThrow(`--answers ${path}`)
  })

  test('good files read back', () => {
    const d = dir()
    writeFileSync(join(d, 't.md'), 'the task')
    writeFileSync(join(d, 'a.json'), '{"a":"b"}')
    expect(readTextInput('--task', join(d, 't.md'))).toBe('the task')
    expect(readJsonInput('--answers', join(d, 'a.json'))).toEqual({ a: 'b' })
  })
})

describe('parseAnswers', () => {
  test('a plain object of non-empty strings passes through', () => {
    expect(parseAnswers({ weak: 'x', strong: 'y' }, '--answers a.json')).toEqual({ weak: 'x', strong: 'y' })
  })

  test('a JSON string (which would yield one probe per character) is rejected', () => {
    expect(() => parseAnswers('weak answer', '--answers a.json')).toThrow(ProbeInputError)
    expect(() => parseAnswers('weak answer', '--answers a.json')).toThrow('--answers a.json')
  })

  test('arrays, null, numbers, empty objects, empty strings and non-string values are rejected', () => {
    for (const bad of [['a'], null, 3, {}, { a: '' }, { a: '  ' }, { a: 1 }, { a: null }]) {
      expect(() => parseAnswers(bad, '--answers a.json')).toThrow(ProbeInputError)
    }
  })
})

describe('judge-probe process', () => {
  const run = (...args: string[]) => {
    // No model id and no opencode on PATH-dependent work: every case below fails before any transport is built.
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'judge-probe.ts'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  test('--help prints usage and exits 0', () => {
    const r = run('--help')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage:')
  })

  test('an unknown flag exits 64 with a usage line and no stack trace', () => {
    const r = run('--mehtod', 'x')
    expect(r.code).toBe(64)
    expect(r.stderr).toContain('Usage:')
    expect(r.stderr).not.toMatch(/\n\s+at /)
  })

  test('a missing --task file exits 1 naming flag and path, with no stack trace', () => {
    const r = run('--task', 'does/not/exist.md', 'opencode/a-free')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('--task does/not/exist.md')
    expect(r.stderr).not.toMatch(/\n\s+at /)
  })

  test('--answers given as a JSON string exits 1 before any model is probed', () => {
    const d = mkdtempSync(join(tmpdir(), 'metacogs-probe-proc-'))
    scratch.push(d)
    writeFileSync(join(d, 'a.json'), '"just a string"')
    const r = run('--answers', join(d, 'a.json'), 'opencode/a-free')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('--answers')
    expect(r.stdout).toBe('')
  })

  test('a --content-dir outside the repository exits 64', () => {
    const r = run('--content-dir', '../elsewhere', 'opencode/a-free')
    expect(r.code).toBe(64)
  })
})
