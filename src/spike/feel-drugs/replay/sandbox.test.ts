import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultUnreadable, sandboxAvailable, sandboxPrefix, sandboxProfile } from './sandbox'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'replay-sandbox-'))
  dirs.push(d)
  return d
}

describe('the sandbox profile', () => {
  test('denies every write, then allows only the listed paths and the terminal devices; secrets are unreadable', () => {
    const profile = sandboxProfile({ writable: ['/work/fixture'], unreadable: ['/home/o/.ssh'] })
    expect(profile.split('\n')).toEqual(['(version 1)', '(allow default)', '(deny file-write*)', expect.stringMatching(/^\(allow file-write\* \(subpath "\/work\/fixture"\) \(literal "\/dev\/null"\)/), '(deny file-read* (subpath "/home/o/.ssh"))', ''])
  })

  test('a relative path is refused, and quotes in a path cannot break out of the string', () => {
    expect(() => sandboxProfile({ writable: ['relative/dir'], unreadable: [] })).toThrow(/absolute/)
    expect(sandboxProfile({ writable: ['/a"b\\c'], unreadable: [] })).toContain('(subpath "/a\\"b\\\\c")')
  })

  test('the default unreadable list is the owner credential directories', () => {
    expect(defaultUnreadable('/home/o')).toEqual(['/home/o/.ssh', '/home/o/.gnupg', '/home/o/.aws', '/home/o/.config/gh', '/home/o/.local/share/opencode'])
  })
})

describe.skipIf(!sandboxAvailable())('the sandbox on this machine', () => {
  const sh = (writable: string, cmd: string) => {
    const prefix = sandboxPrefix({ writable: [writable], unreadable: defaultUnreadable() })
    return spawnSync(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', cmd], { encoding: 'utf8' })
  }

  test('a write inside the writable path works; a touch, a redirect and a script outside it do not', () => {
    const inside = tmp()
    const outside = tmp()
    expect(sh(inside, `echo a > ${inside}/a && cat ${inside}/a`).stdout.trim()).toBe('a')
    expect(sh(inside, `touch ${outside}/t`).status).not.toBe(0)
    expect(sh(inside, `echo x > ${outside}/r`).status).not.toBe(0)
    expect(sh(inside, `python3 -c "open('${outside}/p','w').write('x')"`).status).not.toBe(0)
    for (const f of ['t', 'r', 'p']) expect(existsSync(join(outside, f))).toBe(false)
    expect(sh(inside, 'echo hi > /dev/null && echo ok').stdout.trim()).toBe('ok')
  })

  test('the owner gh directory cannot be read', () => {
    const r = sh(tmp(), `cat ${defaultUnreadable()[3]}/hosts.yml`)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})
