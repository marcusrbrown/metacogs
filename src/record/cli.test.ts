import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordFilename } from './canonical'
import { runCli, validRecord } from './test-support'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'metacogs-cli-'))
})

afterEach(() => {
  chmodSync(tmp, 0o700)
  rmSync(tmp, { recursive: true, force: true })
})

const json = (value: unknown) => JSON.stringify(value)

describe('cli success path', () => {
  test('valid record → exit 0, fixed-shape JSON on stdout, 0600 file', async () => {
    const out = join(tmp, 'records')
    const res = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    expect(res.code).toBe(0)
    expect(res.stderr).toBe('')
    const parsed = JSON.parse(res.stdout)
    expect(Object.keys(parsed)).toEqual(['path', 'next_action'])
    expect(parsed.next_action).toBe('Confirm the deploy target supports the queue client')
    expect(parsed.path).toBe(join(out, recordFilename(validRecord())))
    expect(statSync(parsed.path).mode & 0o777).toBe(0o600)
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(parsed.path, 'utf8')).helper_version).toBe('9.9.9-test')
  })

  test('stamps helper_version over any caller-supplied value', async () => {
    const out = join(tmp, 'records')
    const res = await runCli(['--out-dir', out], {
      stdin: json(validRecord({ helper_version: 'spoofed' })),
      helperVersion: '1.2.3',
    })
    expect(res.code).toBe(0)
    expect(JSON.parse(readFileSync(JSON.parse(res.stdout).path, 'utf8')).helper_version).toBe('1.2.3')
  })

  test('identical record twice → exit 0, same path, single file', async () => {
    const out = join(tmp, 'records')
    const a = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    const b = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    expect([a.code, b.code]).toEqual([0, 0])
    expect(b.stdout).toBe(a.stdout)
    expect(readdirSync(out)).toHaveLength(1)
  })

  test('reordered keys and changed whitespace → same path', async () => {
    const out = join(tmp, 'records')
    const a = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    const reordered = Object.fromEntries(Object.entries(validRecord()).reverse())
    const b = await runCli(['--out-dir', out], { stdin: `\n  ${JSON.stringify(reordered, null, 4)}\n\n` })
    expect(b.code).toBe(0)
    expect(b.stdout).toBe(a.stdout)
    expect(readdirSync(out)).toHaveLength(1)
  })

  test('--file reads the record from disk', async () => {
    const file = join(tmp, 'in.json')
    writeFileSync(file, json(validRecord()))
    const res = await runCli(['--out-dir', join(tmp, 'o'), '--file', file], { stdin: 'ignored' })
    expect(res.code).toBe(0)
  })

  test('empty arrays are valid', async () => {
    const res = await runCli(['--out-dir', join(tmp, 'o')], {
      stdin: json(validRecord({ alternatives: [], evidence: [] })),
    })
    expect(res.code).toBe(0)
  })

  test('records differing only in helper_version share a filename', async () => {
    const out = join(tmp, 'records')
    const a = await runCli(['--out-dir', out], { stdin: json(validRecord()), helperVersion: '1.0.0' })
    const b = await runCli(['--out-dir', out], { stdin: json(validRecord()), helperVersion: '2.0.0' })
    expect([a.code, b.code]).toEqual([0, 0])
    expect(b.stdout).toBe(a.stdout)
  })
})

describe('cli output root', () => {
  test('env var wins when --out-dir is absent', async () => {
    const envDir = join(tmp, 'env-records')
    const res = await runCli([], {
      stdin: json(validRecord()),
      env: { METACOGS_RECORDS_DIR: envDir, XDG_STATE_HOME: join(tmp, 'xdg') },
    })
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).path.startsWith(envDir)).toBe(true)
    expect(existsSync(join(tmp, 'xdg'))).toBe(false)
  })

  test('XDG_STATE_HOME is honoured', async () => {
    const res = await runCli([], { stdin: json(validRecord()), env: { XDG_STATE_HOME: join(tmp, 'xdg') } })
    expect(JSON.parse(res.stdout).path.startsWith(join(tmp, 'xdg', 'metacogs', 'records'))).toBe(true)
  })

  test('neither set → ~/.local/state/metacogs/records (0700); cwd untouched', async () => {
    const home = join(tmp, 'home')
    const cwd = join(tmp, 'cwd')
    mkdirSync(home)
    mkdirSync(cwd)
    const res = await runCli([], { stdin: json(validRecord()), env: { HOME: home }, cwd })
    expect(res.code).toBe(0)
    const root = join(home, '.local', 'state', 'metacogs', 'records')
    expect(JSON.parse(res.stdout).path).toBe(join(root, recordFilename(validRecord())))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(readdirSync(cwd)).toEqual([])
  })
})

describe('cli failure exit codes', () => {
  test('missing reopen_condition → 2, names the field, writes nothing', async () => {
    const { reopen_condition: _omit, ...rest } = validRecord()
    const out = join(tmp, 'records')
    const res = await runCli(['--out-dir', out], { stdin: json(rest) })
    expect(res.code).toBe(2)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('reopen_condition')
    expect(existsSync(out)).toBe(false)
  })

  test('empty reopen_condition → 2', async () => {
    const res = await runCli(['--out-dir', join(tmp, 'o')], { stdin: json(validRecord({ reopen_condition: '' })) })
    expect(res.code).toBe(2)
  })

  test('schema_version 2 → 2, names schema_version', async () => {
    const res = await runCli(['--out-dir', join(tmp, 'o')], { stdin: json(validRecord({ schema_version: 2 })) })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('schema_version')
  })

  test('bad method (traversal, slash, not in enum) → 2, no file', async () => {
    for (const method of ['../x', 'a/b', 'demo']) {
      const out = join(tmp, `o-${method.replace(/\W/g, '_')}`)
      const res = await runCli(['--out-dir', out], { stdin: json(validRecord({ method })) })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('method')
      expect(existsSync(out)).toBe(false)
    }
    expect(readdirSync(tmp)).toEqual([])
  })

  test('invalid JSON → 2, nothing written', async () => {
    const out = join(tmp, 'o')
    const res = await runCli(['--out-dir', out], { stdin: '{not json' })
    expect(res.code).toBe(2)
    expect(existsSync(out)).toBe(false)
  })

  test('unwritable root → 3, no file, no temp', async () => {
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'x')
    const res = await runCli(['--out-dir', join(blocker, 'records')], { stdin: json(validRecord()) })
    expect(res.code).toBe(3)
    expect(res.stdout).toBe('')
    expect(readdirSync(tmp)).toEqual(['blocker'])
  })

  test('unreadable --file → 3', async () => {
    const res = await runCli(['--out-dir', join(tmp, 'o'), '--file', join(tmp, 'missing.json')])
    expect(res.code).toBe(3)
  })

  test('existing final with different content → 4', async () => {
    const out = join(tmp, 'records')
    mkdirSync(out)
    const final = join(out, recordFilename(validRecord()))
    writeFileSync(final, '{"other":1}\n')
    const res = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    expect(res.code).toBe(4)
    expect(res.stdout).toBe('')
    expect(readdirSync(out)).toEqual([recordFilename(validRecord())])
  })

  test('pre-existing truncated file → 4, message names the path', async () => {
    const out = join(tmp, 'records')
    mkdirSync(out)
    const final = join(out, recordFilename(validRecord()))
    writeFileSync(final, '{"schema_ver')
    const res = await runCli(['--out-dir', out], { stdin: json(validRecord()) })
    expect(res.code).toBe(4)
    expect(res.stderr).toContain(final)
  })

  test('usage errors → 64', async () => {
    for (const args of [['--bogus'], ['--out-dir'], ['--file'], ['positional'], ['--file', 'a', '--file', 'b']]) {
      const res = await runCli(args, { stdin: json(validRecord()) })
      expect(res.code).toBe(64)
      expect(res.stdout).toBe('')
    }
  })
})

describe('cli as a real process', () => {
  const entry = join(import.meta.dir, 'cli.ts')

  test('stdin, exit code and stdout wiring; default root under HOME; cwd untouched', async () => {
    const home = join(tmp, 'home')
    const cwd = join(tmp, 'cwd')
    mkdirSync(home)
    mkdirSync(cwd)
    const proc = Bun.spawn(['bun', entry], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stdin: new Blob([json(validRecord())]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    const path: string = JSON.parse(stdout).path
    expect(path.startsWith(join(home, '.local', 'state', 'metacogs', 'records'))).toBe(true)
    expect(readdirSync(cwd)).toEqual([])
  })
})
