import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLIPROXY_UPSTREAM,
  CliproxyAuthError,
  cliproxyAuth,
  cliproxyModelMismatch,
  cliproxyNeedles,
  cliproxyProviderConfig,
  type CliproxyDeps,
  type ExecResult,
  fetchCliproxyKey,
  infraDir,
  keyPrefixFor,
  parseAuthCliproxy,
  parseKeyList,
  resolveCliproxy,
  selectKey,
} from './cliproxy'
import { createFixture, destroyFixture } from './env'
import { writeIsolatedAuth } from './auth'
import { createRunWorkspace } from './workspace'

// Synthetic values: shaped like gateway keys, issued to nobody.
const NAME = 'fro-bot-marcusrbrown-metacogs'
const PREFIX = 'sk-fro-bot-marcusrbrown-met-'
const MINE = `${PREFIX}0123456789abcdef0123456789abcdef`
const OTHERS = ['sk-fro-bot-marcusrbrown-fro-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sk-someone-else-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'sk-live-123']

/** A mocked `infra cliproxy keys list --json`: records how it was called, returns canned output. */
function fakeInfra(result: Partial<ExecResult> & { stdout?: string }) {
  const calls: { command: string; args: string[]; cwd: string }[] = []
  const deps: Partial<CliproxyDeps> = {
    env: {},
    home: '/home/someone',
    exec: (command, args, options) => {
      calls.push({ command, args: [...args], cwd: options.cwd })
      return { status: 0, stdout: '', stderr: '', ...result }
    },
  }
  return { calls, deps }
}

describe('keyPrefixFor mirrors the setup wizard', () => {
  test('fro-bot-marcusrbrown-metacogs → the 24-character slug the wizard derives', () => {
    expect(keyPrefixFor(NAME)).toBe(PREFIX)
  })
  test('lowercases, splits on non-alphanumerics, and falls back for an empty slug', () => {
    expect(keyPrefixFor('  My Key__Name!! ')).toBe('sk-my-key-name-')
    expect(keyPrefixFor('!!!')).toBe('sk-cliproxy-')
  })
})

describe('parseAuthCliproxy', () => {
  test('flag wins over env; empty is off; odd names are refused', () => {
    expect(parseAuthCliproxy('a-b', { METACOGS_AUTH_CLIPROXY: 'c' })).toBe('a-b')
    expect(parseAuthCliproxy(undefined, { METACOGS_AUTH_CLIPROXY: NAME })).toBe(NAME)
    expect(parseAuthCliproxy(undefined, {})).toBeUndefined()
    expect(parseAuthCliproxy('  ', {})).toBeUndefined()
    expect(() => parseAuthCliproxy('../x', {})).toThrow(CliproxyAuthError)
    expect(() => parseAuthCliproxy('a b', {})).toThrow(CliproxyAuthError)
  })
})

describe('parsing and selecting the key list', () => {
  test('a JSON array of strings parses; anything else fails without echoing the content', () => {
    expect(parseKeyList(JSON.stringify([MINE, ...OTHERS]))).toHaveLength(4)
    for (const bad of ['not json ' + MINE, '{"keys":["' + MINE + '"]}', JSON.stringify([MINE, 5]), '1. ' + MINE]) {
      let message = ''
      try {
        parseKeyList(bad)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(MINE)
    }
  })

  test('exactly one key with the prefix is selected', () => {
    expect(selectKey([...OTHERS, MINE], NAME)).toBe(MINE)
  })

  test('no match and several matches are refused, with counts and no values', () => {
    expect(() => selectKey(OTHERS, NAME)).toThrow(/no CLIProxyAPI key starts with "sk-fro-bot-marcusrbrown-met-" \(3 keys listed\)/)
    const twin = `${PREFIX}ffffffffffffffffffffffffffffffff`
    let message = ''
    try {
      selectKey([MINE, twin], NAME)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('2 CLIProxyAPI keys')
    expect(message).not.toContain(MINE)
    expect(message).not.toContain(twin)
  })

  test('a bare prefix with nothing after it is not a key', () => {
    expect(() => selectKey([PREFIX], NAME)).toThrow(CliproxyAuthError)
  })
})

describe('fetchCliproxyKey (mocked infra CLI)', () => {
  test('runs `infra cliproxy keys list --json` from the infra checkout and returns only the selected key', () => {
    const { calls, deps } = fakeInfra({ stdout: JSON.stringify([...OTHERS, MINE]) })
    expect(fetchCliproxyKey(NAME, deps)).toBe(MINE)
    expect(calls).toEqual([{ command: 'infra', args: ['cliproxy', 'keys', 'list', '--json'], cwd: '/home/someone/src/github.com/marcusrbrown/infra' }])
  })

  test('METACOGS_INFRA_DIR overrides the checkout', () => {
    expect(infraDir({ METACOGS_INFRA_DIR: '/elsewhere/infra' }, '/home/x')).toBe('/elsewhere/infra')
    const { calls, deps } = fakeInfra({ stdout: JSON.stringify([MINE]) })
    fetchCliproxyKey(NAME, { ...deps, env: { METACOGS_INFRA_DIR: '/elsewhere/infra' } })
    expect(calls[0]!.cwd).toBe('/elsewhere/infra')
  })

  test('a failing CLI is reported by exit code; its stdout is never quoted and key-shaped tokens in stderr are scrubbed', () => {
    const { deps } = fakeInfra({ status: 1, stdout: JSON.stringify([MINE]), stderr: `request failed for ${MINE}\nwith a 401` })
    let message = ''
    try {
      fetchCliproxyKey(NAME, deps)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('exit 1')
    expect(message).toContain('401')
    expect(message).not.toContain(MINE)
    expect(message).not.toContain(PREFIX)
  })

  test('a CLI that cannot be spawned is reported', () => {
    const { deps } = fakeInfra({ status: null, error: new Error('spawn infra ENOENT') })
    expect(() => fetchCliproxyKey(NAME, deps)).toThrow(/could not run the infra CLI/)
  })

  test('plain-text output (no --json support) is refused', () => {
    const { deps } = fakeInfra({ stdout: `1. ${MINE}\n2. ${OTHERS[0]}\n` })
    expect(() => fetchCliproxyKey(NAME, deps)).toThrow(/JSON array/)
  })
})

describe('what gets written and scanned', () => {
  test('auth entries are type api for openai and anthropic only', () => {
    expect(cliproxyAuth(MINE)).toEqual({ openai: { type: 'api', key: MINE }, anthropic: { type: 'api', key: MINE } })
  })

  test('provider blocks mirror the wizard: openai and anthropic with only options.baseURL', () => {
    expect(cliproxyProviderConfig('http://127.0.0.1:1/v1')).toEqual({
      openai: { options: { baseURL: 'http://127.0.0.1:1/v1' } },
      anthropic: { options: { baseURL: 'http://127.0.0.1:1/v1' } },
    })
    expect(CLIPROXY_UPSTREAM).toBe('https://cliproxy.fro.bot/v1')
  })

  test('needles: the key, its prefix, and a management key only when the runner holds one', () => {
    expect(cliproxyNeedles(MINE, NAME, {}).map((n) => n.label)).toEqual(['auth_cliproxy:key', 'auth_cliproxy:key_prefix'])
    const withManagement = cliproxyNeedles(MINE, NAME, { CLIPROXY_MANAGEMENT_KEY: 'synthetic-management-key-9f8e7d6c' })
    expect(withManagement.map((n) => n.label)).toEqual(['auth_cliproxy:key', 'auth_cliproxy:key_prefix', 'auth_cliproxy:management_key'])
    expect(withManagement.every((n) => !n.label.includes(MINE))).toBe(true)
  })

  test('the isolated auth.json is 0600 and holds exactly the two entries', () => {
    const fixture = createFixture('metacogs-cliproxy-test-')
    try {
      writeIsolatedAuth(fixture, cliproxyAuth(MINE))
      const path = join(fixture.xdgDataHome, 'opencode', 'auth.json')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort()).toEqual(['anthropic', 'openai'])
    } finally {
      destroyFixture(fixture)
    }
  })
})

describe('model/auth agreement', () => {
  test('openai/* and anthropic/* need the flag; with the flag nothing else is allowed', () => {
    expect(cliproxyModelMismatch(['openai/gpt-6-luna', 'anthropic/claude-haiku-5-5'], true)).toBeUndefined()
    expect(cliproxyModelMismatch(['opencode-go/beam-free', 'opencode-go/deepseek-v4.1-flash'], false)).toBeUndefined()
    expect(cliproxyModelMismatch(['openai/gpt-6-luna', 'opencode-go/x'], false)).toContain('--auth-cliproxy')
    expect(cliproxyModelMismatch(['openai/gpt-6-luna', 'opencode-go/x'], true)).toContain('opencode-go/x')
  })
})

describe('resolveCliproxy', () => {
  const { deps } = fakeInfra({ stdout: JSON.stringify([...OTHERS, MINE]) })

  test('off without a name; scripted mode and a passthrough flag are refused; on returns auth and needles', () => {
    expect(resolveCliproxy(undefined, {}, { live: true }, deps)).toBeUndefined()
    expect(() => resolveCliproxy(NAME, {}, { live: false }, deps)).toThrow(/--provider live/)
    expect(() => resolveCliproxy(NAME, {}, { live: true, passthroughFlag: 'opencode-go' }, deps)).toThrow(/mutually exclusive/)
    const r = resolveCliproxy(undefined, { METACOGS_AUTH_CLIPROXY: NAME }, { live: true }, deps)!
    expect(r.keyName).toBe(NAME)
    expect(Object.keys(r.auth).sort()).toEqual(['anthropic', 'openai'])
    expect(r.needles.some((n) => n.value === MINE)).toBe(true)
  })
})

describe('workspace wiring', () => {
  test('cliproxy mode writes the wizard provider blocks (pointing at the local recording proxy) and the auth.json; no Go or Zen entry', () => {
    const ws = createRunWorkspace({
      repoRoot: tmpdir(),
      method: 'demo',
      condition: 'baseline',
      fixtureId: 'x',
      fixtureText: 'hello\n',
      provider: { kind: 'live', recordingProxyUrl: 'http://127.0.0.1:4242/v1' },
      model: 'openai/gpt-6-luna',
      auth: cliproxyAuth(MINE),
      cliproxy: true,
    })
    try {
      expect(ws.config.provider).toEqual(cliproxyProviderConfig('http://127.0.0.1:4242/v1'))
      const written = JSON.parse(readFileSync(ws.fixture.configPath, 'utf8')) as Record<string, unknown>
      expect(written.provider).toEqual(ws.config.provider)
      // the generated config never carries the key
      expect(readFileSync(ws.fixture.configPath, 'utf8')).not.toContain(MINE)
      const authPath = join(ws.fixture.xdgDataHome, 'opencode', 'auth.json')
      expect(existsSync(authPath)).toBe(true)
      expect(Object.keys(JSON.parse(readFileSync(authPath, 'utf8'))).sort()).toEqual(['anthropic', 'openai'])
    } finally {
      destroyFixture(ws.fixture)
    }
  })

  test('without cliproxy mode only the model\'s own provider is configured', () => {
    const ws = createRunWorkspace({
      repoRoot: tmpdir(),
      method: 'demo',
      condition: 'baseline',
      fixtureId: 'x',
      fixtureText: 'hello\n',
      provider: { kind: 'live', recordingProxyUrl: 'http://127.0.0.1:4242/v1' },
      model: 'opencode-go/beam-free',
    })
    try {
      expect(Object.keys(ws.config.provider as object)).toEqual(['opencode-go'])
    } finally {
      destroyFixture(ws.fixture)
    }
  })
})
