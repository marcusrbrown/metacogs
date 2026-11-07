import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { opencodeArgv, OPENCODE_PIN, runArgv, spawnCapture } from './opencode'

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A shell that backgrounds a long sleep, prints its pid, and waits: the sleep is a grandchild in the same group. */
const SLEEPER = ['sh', '-c', 'sleep 300 & echo $!; wait']

describe('spawnCapture', () => {
  test('captures stdout, stderr, and exit code', async () => {
    const r = await spawnCapture(['sh', '-c', 'echo out; echo err >&2; exit 3'], { cwd: '/', env, timeoutMs: 10_000 })
    expect(r).toMatchObject({ stdout: 'out\n', stderr: 'err\n', exitCode: 3, timedOut: false, aborted: false })
  })

  test('timeout kills the whole process group, including grandchildren', async () => {
    const r = await spawnCapture(SLEEPER, { cwd: '/', env, timeoutMs: 400, killGraceMs: 500 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBe(-1)
    const pid = Number(r.stdout.trim())
    expect(pid).toBeGreaterThan(1)
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })

  test('abort kills the group and reports aborted, not a timeout', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 400)
    const r = await spawnCapture(SLEEPER, { cwd: '/', env, timeoutMs: 60_000, signal: ac.signal, killGraceMs: 500 })
    expect(r).toMatchObject({ aborted: true, timedOut: false, exitCode: -1 })
    await Bun.sleep(100)
    expect(alive(Number(r.stdout.trim()))).toBe(false)
  })

  test('an already-aborted signal never lets the child run to completion', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await spawnCapture(['sh', '-c', 'sleep 30'], { cwd: '/', env, timeoutMs: 60_000, signal: ac.signal, killGraceMs: 500 })
    expect(r.aborted).toBe(true)
    expect(r.wallMs).toBeLessThan(10_000)
  })

  test('a missing binary reports failure instead of throwing', async () => {
    const r = await spawnCapture(['definitely-not-a-binary-xyz'], { cwd: '/', env, timeoutMs: 5_000 })
    expect(r.exitCode).toBe(-1)
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })
})

describe('argv', () => {
  test('pinned launcher and run flags', () => {
    expect(opencodeArgv('--version')).toEqual(['bunx', `opencode-ai@${OPENCODE_PIN}`, '--version'])
    expect(runArgv('p/m', 'do it')).toEqual(['bunx', `opencode-ai@${OPENCODE_PIN}`, 'run', '--format', 'json', '--model', 'p/m', 'do it'])
    expect(runArgv('p/m', 'x')).not.toContain('--auto')
  })
})

describe('spawnCapture with output files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-files-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('stdout and stderr land in the files and in the result; output past a pipe limit is whole', async () => {
    const stdoutPath = join(dir, 'a.out')
    const stderrPath = join(dir, 'a.err')
    const r = await spawnCapture(['sh', '-c', 'head -c 1500000 /dev/zero | tr "\\0" x; echo err >&2'], { cwd: '/', env, timeoutMs: 20_000, stdoutPath, stderrPath })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.length).toBe(1_500_000)
    expect(readFileSync(stdoutPath, 'utf8')).toBe(r.stdout)
    expect(readFileSync(stderrPath, 'utf8')).toBe('err\n')
    expect(r.stderr).toBe('err\n')
  })

  test('a timeout kills the group and keeps what was written so far', async () => {
    const stdoutPath = join(dir, 'b.out')
    const r = await spawnCapture(['sh', '-c', 'echo partial; sleep 300 & echo $! >&2; wait'], { cwd: '/', env, timeoutMs: 600, killGraceMs: 500, stdoutPath, stderrPath: join(dir, 'b.err') })
    expect(r.timedOut).toBe(true)
    expect(r.stdout).toBe('partial\n')
    await Bun.sleep(100)
    expect(alive(Number(r.stderr.trim()))).toBe(false)
  })

  test('a spawn error still reaches the stderr text', async () => {
    const r = await spawnCapture(['definitely-not-a-binary-xyz'], { cwd: '/', env, timeoutMs: 5_000, stdoutPath: join(dir, 'c.out'), stderrPath: join(dir, 'c.err') })
    expect(r.exitCode).toBe(-1)
    expect(r.stderr).toContain('definitely-not-a-binary-xyz')
  })
})
