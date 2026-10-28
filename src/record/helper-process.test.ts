import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../generate/tree'

// The committed, bundled helper run as a real process under `node` (CI pins Node 22), with hostile input on stdin.
// These are the cases that threw out of the helper before: stack overflow on nesting, and lone surrogates.

const HELPER = join(REPO_ROOT, 'skills', 'synthesis', 'scripts', 'record.mjs')
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'metacogs-helper-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function run(input: string): { status: number | null; stdout: string; stderr: string } {
  const out = join(tmp, 'records')
  const result = spawnSync('node', [HELPER, '--out-dir', out], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const NO_STACK = /RangeError|TypeError|Maximum call stack|\n\s+at /

describe('the bundled helper as a process', () => {
  test('10,000 nested arrays in an unknown field exit 2 with a validation message, no stack trace and no file', () => {
    const depth = 10_000
    const input = `{"schema_version":1,"junk":${'['.repeat(depth)}${']'.repeat(depth)}}`
    const res = run(input)
    expect(res.status).toBe(2)
    expect(res.stdout).toBe('')
    expect(res.stderr).toStartWith('metacogs-record: validation failed\n')
    expect(res.stderr).toContain('junk: unknown field')
    expect(res.stderr).not.toMatch(NO_STACK)
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })

  test('deep nesting in schema_version and in a known field is also exit 2 with no stack trace', () => {
    const nested = `${'['.repeat(10_000)}${']'.repeat(10_000)}`
    for (const input of [`{"schema_version":${nested}}`, `{"schema_version":1,"objective":${nested}}`]) {
      const res = run(input)
      expect(res.status).toBe(2)
      expect(res.stderr).not.toMatch(NO_STACK)
    }
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })

  test('a lone surrogate escape in a string field is exit 2, not an I/O failure', () => {
    const record = JSON.stringify({
      schema_version: 1, method: 'synthesis', method_version: '1', objective: 'x', evidence: [], assumptions: [], alternatives: [], findings: [],
      next_action: 'n', reopen_condition: 'r', execution_mode: 'direct', status: 's',
    })
    const res = run(record.replace('"objective":"x"', '"objective":"a\\ud800b"'))
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('objective: contains a lone surrogate')
    expect(res.stderr).not.toMatch(NO_STACK)
    expect(existsSync(join(tmp, 'records'))).toBe(false)
  })
})
