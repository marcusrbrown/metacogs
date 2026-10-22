import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AuthPassthroughError,
  needlesOf,
  parseAuthPassthrough,
  passthroughNames,
  readPassthroughAuth,
  realAuthJsonPath,
  writeIsolatedAuth,
} from './auth'
import { createFixture, destroyFixture } from './env'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

// Synthetic values: shaped like secrets, issued to nobody.
const OC = 'synthetic-oc-secret-aaaa1111bbbb'
const GO = 'synthetic-go-secret-cccc2222dddd'
const OTHER = 'synthetic-other-secret-eeee3333ffff'

function realAuth(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-realauth-'))
  scratch.push(dir)
  const path = join(dir, 'auth.json')
  writeFileSync(path, JSON.stringify(body))
  return path
}

const FULL = {
  opencode: { type: 'api', key: OC },
  'opencode-go': { type: 'api', key: GO },
  anthropic: { type: 'api', key: OTHER },
}

describe('parseAuthPassthrough', () => {
  test('flag wins over env; comma list; de-duplicated', () => {
    expect(parseAuthPassthrough('opencode,opencode-go,opencode', { METACOGS_AUTH_PASSTHROUGH: 'opencode' })).toEqual(['opencode', 'opencode-go'])
    expect(parseAuthPassthrough(undefined, { METACOGS_AUTH_PASSTHROUGH: ' opencode-go ' })).toEqual(['opencode-go'])
  })
  test('absent or empty → no passthrough', () => {
    expect(parseAuthPassthrough(undefined, {})).toEqual([])
    expect(parseAuthPassthrough('', {})).toEqual([])
  })
  test('any other provider is refused', () => {
    expect(() => parseAuthPassthrough('opencode,anthropic', {})).toThrow('refused: anthropic')
  })
})

describe('readPassthroughAuth', () => {
  test('copies only the named entries; never another provider', () => {
    const auth = readPassthroughAuth(['opencode', 'opencode-go'], realAuth(FULL))
    expect(Object.keys(auth).sort()).toEqual(['opencode', 'opencode-go'])
    expect(JSON.stringify(auth)).not.toContain(OTHER)
  })
  test('nothing requested → nothing read (the file need not exist)', () => {
    expect(readPassthroughAuth([], '/nonexistent/auth.json')).toEqual({})
  })
  test('errors never echo a value', () => {
    for (const [providers, path] of [
      [['opencode'], '/nonexistent/auth.json'],
      [['opencode'], realAuth({ anthropic: { key: OTHER } })],
      [['opencode'], (() => { const p = realAuth(FULL); writeFileSync(p, `{ not json ${OC}`); return p })()],
    ] as const) {
      let message = ''
      try {
        readPassthroughAuth(providers, path)
      } catch (e) {
        expect(e).toBeInstanceOf(AuthPassthroughError)
        message = (e as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(OC)
      expect(message).not.toContain(OTHER)
    }
  })
  test('real path honors XDG_DATA_HOME, else ~/.local/share', () => {
    expect(realAuthJsonPath({ XDG_DATA_HOME: '/x/data' }, '/h')).toBe('/x/data/opencode/auth.json')
    expect(realAuthJsonPath({}, '/h')).toBe('/h/.local/share/opencode/auth.json')
  })
})

describe('writeIsolatedAuth', () => {
  test('writes the passed entries to the fixture data dir with mode 0600', () => {
    const fixture = createFixture('metacogs-authtest-')
    try {
      writeIsolatedAuth(fixture, readPassthroughAuth(['opencode', 'opencode-go'], realAuth(FULL)))
      const path = join(fixture.xdgDataHome, 'opencode', 'auth.json')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      const written = JSON.parse(readFileSync(path, 'utf8'))
      expect(Object.keys(written).sort()).toEqual(['opencode', 'opencode-go'])
      expect(readFileSync(path, 'utf8')).not.toContain(OTHER)
      expect(path.startsWith(fixture.root)).toBe(true)
    } finally {
      destroyFixture(fixture)
    }
  })
  test('an empty passthrough writes nothing', () => {
    const fixture = createFixture('metacogs-authtest-')
    try {
      writeIsolatedAuth(fixture, {})
      expect(existsSync(join(fixture.xdgDataHome, 'opencode'))).toBe(false)
    } finally {
      destroyFixture(fixture)
    }
  })
  test('the file dies with the fixture', () => {
    const fixture = createFixture('metacogs-authtest-')
    writeIsolatedAuth(fixture, { opencode: { type: 'api', key: OC } })
    destroyFixture(fixture)
    expect(existsSync(fixture.root)).toBe(false)
  })
})

describe('needlesOf / passthroughNames', () => {
  const auth = { opencode: { type: 'api', key: OC }, 'opencode-go': { type: 'api', key: OC, refresh: GO, short: 'abc' } }
  test('secret-length string values, de-duplicated, labelled by provider.field', () => {
    const needles = needlesOf(auth)
    expect(needles.map((n) => n.value).sort()).toEqual([GO, OC].sort())
    expect(needles.map((n) => n.label)).toEqual(['auth_passthrough:opencode.key', 'auth_passthrough:opencode-go.refresh'])
    expect(needles.every((n) => !n.label.includes(OC) && !n.label.includes(GO))).toBe(true)
  })
  test('names only', () => {
    expect(passthroughNames(auth)).toEqual(['opencode', 'opencode-go'])
  })
})
