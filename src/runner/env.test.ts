import { afterEach, describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'

import { buildChildEnv, createFixture, destroyFixture, type Fixture, OPENCODE_PIN } from './env'

const fixtures: Fixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) destroyFixture(f)
})

function fixture(): Fixture {
  const f = createFixture('metacogs-envtest-')
  fixtures.push(f)
  return f
}

const CONFIG = { permission: { skill: { '*': 'deny' } } }

describe('child env allowlist', () => {
  test('exact key set; nothing is inherited from the parent env', () => {
    const planted = { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'x', METACOGS_HELDOUT_DIR: '/x', OPENCODE_CONFIG_CONTENT: '{}' }
    const before = { ...process.env }
    Object.assign(process.env, planted)
    try {
      const env = buildChildEnv({ fixture: fixture(), config: CONFIG, withRecordsDir: true })
      expect(Object.keys(env).sort()).toEqual(
        [
          'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
          'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'NO_COLOR',
          'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
          'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_PRUNE',
          'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
          'BUN_INSTALL_CACHE_DIR', 'METACOGS_RECORDS_DIR',
        ].sort(),
      )
      for (const key of Object.keys(planted)) expect(key in env).toBe(false)
    } finally {
      for (const key of Object.keys(planted)) delete process.env[key]
      Object.assign(process.env, before)
    }
  })

  test('METACOGS_RECORDS_DIR is the only METACOGS_* variable and sits inside the workspace', () => {
    const f = fixture()
    const env = buildChildEnv({ fixture: f, config: CONFIG, withRecordsDir: true })
    expect(Object.keys(env).filter((k) => k.startsWith('METACOGS_'))).toEqual(['METACOGS_RECORDS_DIR'])
    expect(env.METACOGS_RECORDS_DIR?.startsWith(`${f.workspace}/`)).toBe(true)
    expect('METACOGS_RECORDS_DIR' in buildChildEnv({ fixture: f, config: CONFIG })).toBe(false)
  })

  test('HOME and XDG dirs are siblings of the workspace, never inside it', () => {
    const f = fixture()
    const env = buildChildEnv({ fixture: f, config: CONFIG })
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR'] as const) {
      expect(env[key]?.startsWith(f.workspace)).toBe(false)
      expect(env[key]?.startsWith(f.root)).toBe(true)
    }
    expect(dirname(f.workspace)).toBe(f.root)
  })

  test('one config channel: OPENCODE_CONFIG file, never OPENCODE_CONFIG_CONTENT', () => {
    const env = buildChildEnv({ fixture: fixture(), config: CONFIG })
    expect(env.OPENCODE_CONFIG).toBeTruthy()
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  test('the pin is a concrete version, not a range or tag', () => {
    expect(OPENCODE_PIN).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
