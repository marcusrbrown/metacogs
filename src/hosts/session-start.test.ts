import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSessionStartHook, type HookHost, renderGuidance } from './guidance'
import { CLAUDE_PROFILE, CODEX_PROFILE } from './rules'

// The hook runs as the built bundle under `node` with a minimal environment that the test controls, so no signal
// leaks in from the machine running the tests. Which off signals exist, and which ignore which host, is the contract.

const NOTE = renderGuidance(CLAUDE_PROFILE)
const CODEX_NOTE = renderGuidance(CODEX_PROFILE)
let scratch: string
let home: string
const hooks: Record<HookHost, string> = { claude: '', codex: '' }

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'metacogs-hook-'))
  home = join(scratch, 'home')
  mkdirSync(home)
  for (const host of ['claude', 'codex'] as const) {
    hooks[host] = join(scratch, `${host}.mjs`)
    writeFileSync(hooks[host], await buildSessionStartHook({ host, note: host === 'codex' ? CODEX_NOTE : NOTE, version: '0.0.0' }))
  }
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Run the hook with exactly `env` (PATH only is added). */
function run(env: Record<string, string>, host: HookHost = 'claude') {
  const result = spawnSync('node', [hooks[host]], { cwd: scratch, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const PRINTS = { status: 0, stdout: NOTE, stderr: '' }
const PRINTS_CODEX = { status: 0, stdout: CODEX_NOTE, stderr: '' }
const SILENT = { status: 0, stdout: '', stderr: '' }

describe('the session-start hook', () => {
  test('with no off signal it prints the note and exits 0', () => {
    expect(run({ HOME: home })).toEqual(PRINTS)
    expect(run({ HOME: home }, 'codex')).toEqual(PRINTS_CODEX)
  })

  test('the output is plain text, never JSON-looking, and ends with a newline', () => {
    const { stdout } = run({ HOME: home })
    expect(stdout).not.toMatch(/^\s*[{[]/)
    expect(stdout.endsWith('\n')).toBe(true)
  })

  describe('AE3: each off signal silences it', () => {
    test('METACOGS_GUIDANCE=off, in any case', () => {
      for (const value of ['off', 'OFF', 'Off']) expect(run({ HOME: home, METACOGS_GUIDANCE: value }), value).toEqual(SILENT)
      expect(run({ HOME: home, METACOGS_GUIDANCE: 'off' }, 'codex')).toEqual(SILENT)
    })

    test('the marker file under $HOME/.config', () => {
      const h = mkdtempSync(join(scratch, 'h-'))
      expect(run({ HOME: h })).toEqual(PRINTS)
      mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
      writeFileSync(join(h, '.config', 'metacogs', 'guidance-off'), '')
      expect(run({ HOME: h })).toEqual(SILENT)
      expect(run({ HOME: h }, 'codex')).toEqual(SILENT)
    })

    test('the marker file under XDG_CONFIG_HOME, which wins over $HOME/.config', () => {
      const xdg = mkdtempSync(join(scratch, 'xdg-'))
      mkdirSync(join(xdg, 'metacogs'))
      writeFileSync(join(xdg, 'metacogs', 'guidance-off'), 'off\n')
      expect(run({ HOME: home, XDG_CONFIG_HOME: xdg })).toEqual(SILENT)
      // A marker in the default place is not consulted when XDG_CONFIG_HOME points elsewhere.
      const h = mkdtempSync(join(scratch, 'h-'))
      mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
      writeFileSync(join(h, '.config', 'metacogs', 'guidance-off'), '')
      expect(run({ HOME: h, XDG_CONFIG_HOME: mkdtempSync(join(scratch, 'xdg-')) })).toEqual(PRINTS)
    })

    test('an empty or relative XDG_CONFIG_HOME falls back to $HOME/.config', () => {
      const h = mkdtempSync(join(scratch, 'h-'))
      mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
      writeFileSync(join(h, '.config', 'metacogs', 'guidance-off'), '')
      expect(run({ HOME: h, XDG_CONFIG_HOME: '' })).toEqual(SILENT)
      expect(run({ HOME: h, XDG_CONFIG_HOME: 'relative/dir' })).toEqual(SILENT)
    })

    test('on Claude, an explicit false-like plugin option, in any case', () => {
      for (const value of ['false', 'FALSE', 'False', '0', 'off', 'no', 'No']) {
        expect(run({ HOME: home, CLAUDE_PLUGIN_OPTION_GUIDANCE: value }), value).toEqual(SILENT)
      }
    })

    test('on Codex the Claude plugin option means nothing', () => {
      expect(run({ HOME: home, CLAUDE_PLUGIN_OPTION_GUIDANCE: 'false' }, 'codex')).toEqual(PRINTS_CODEX)
    })
  })

  describe('AE3: nothing set, or a value that is not an off signal, prints the note', () => {
    test('METACOGS_GUIDANCE values other than off', () => {
      for (const value of ['', 'on', 'ON', '1', 'true', 'maybe', 'offf', 'of', ' off', 'off ', 'disabled']) {
        expect(run({ HOME: home, METACOGS_GUIDANCE: value }), JSON.stringify(value)).toEqual(PRINTS)
      }
    })

    test('plugin option values that are true-like, empty or malformed', () => {
      for (const value of ['true', 'TRUE', '1', 'yes', 'on', '', 'null', 'undefined', 'false-ish', '{"a":false}']) {
        expect(run({ HOME: home, CLAUDE_PLUGIN_OPTION_GUIDANCE: value }), JSON.stringify(value)).toEqual(PRINTS)
      }
    })

    test('a missing HOME and no XDG_CONFIG_HOME does not throw', () => {
      expect(run({})).toEqual(PRINTS)
      expect(run({}, 'codex')).toEqual(PRINTS_CODEX)
    })

    // chmod 000 does not block root, so the directory stays readable and the case is not exercised there.
    test.skipIf(process.getuid?.() === 0)('an unreadable config directory fails open', () => {
      const h = mkdtempSync(join(scratch, 'h-'))
      mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
      writeFileSync(join(h, '.config', 'metacogs', 'guidance-off'), '')
      chmodSync(join(h, '.config'), 0o000)
      try {
        // existsSync returns false on EACCES, so the marker is invisible and the note prints.
        expect(run({ HOME: h })).toEqual(PRINTS)
      } finally {
        chmodSync(join(h, '.config'), 0o755)
      }
    })

    test('a dangling marker symlink and a HOME that is not a directory fail open', () => {
      const h = mkdtempSync(join(scratch, 'h-'))
      mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
      symlinkSync(join(h, 'nowhere'), join(h, '.config', 'metacogs', 'guidance-off'))
      expect(run({ HOME: h })).toEqual(PRINTS)
      writeFileSync(join(scratch, 'a-file'), '')
      expect(run({ HOME: join(scratch, 'a-file') })).toEqual(PRINTS)
    })
  })

  test('the signals are independent: any one is enough', () => {
    const xdg = mkdtempSync(join(scratch, 'xdg-'))
    mkdirSync(join(xdg, 'metacogs'))
    writeFileSync(join(xdg, 'metacogs', 'guidance-off'), '')
    expect(run({ HOME: home, XDG_CONFIG_HOME: xdg, METACOGS_GUIDANCE: 'on', CLAUDE_PLUGIN_OPTION_GUIDANCE: 'true' })).toEqual(SILENT)
    expect(run({ HOME: home, METACOGS_GUIDANCE: 'off', CLAUDE_PLUGIN_OPTION_GUIDANCE: 'true' })).toEqual(SILENT)
    expect(run({ HOME: home, METACOGS_GUIDANCE: 'on', CLAUDE_PLUGIN_OPTION_GUIDANCE: 'false' })).toEqual(SILENT)
  })
})

describe('AE3 on Codex: the same hook source, embedded with the Codex note', () => {
  const codex = (env: Record<string, string>) => run(env, 'codex')

  test('the Codex bundle prints the Codex note, not the Claude one', () => {
    expect(codex({ HOME: home })).toEqual(PRINTS_CODEX)
    expect(CODEX_NOTE).not.toBe(NOTE)
    expect(codex({ HOME: home }).stdout).toContain('mcp__metacogs__feel')
    expect(codex({ HOME: home }).stdout).not.toMatch(/^\s*[{[]/)
  })

  test('METACOGS_GUIDANCE=off silences it, in any case', () => {
    for (const value of ['off', 'OFF', 'Off']) expect(codex({ HOME: home, METACOGS_GUIDANCE: value }), value).toEqual(SILENT)
  })

  test('the marker file silences it, under $HOME/.config and under XDG_CONFIG_HOME', () => {
    const h = mkdtempSync(join(scratch, 'h-'))
    expect(codex({ HOME: h })).toEqual(PRINTS_CODEX)
    mkdirSync(join(h, '.config', 'metacogs'), { recursive: true })
    writeFileSync(join(h, '.config', 'metacogs', 'guidance-off'), '')
    expect(codex({ HOME: h })).toEqual(SILENT)

    const xdg = mkdtempSync(join(scratch, 'xdg-'))
    mkdirSync(join(xdg, 'metacogs'))
    writeFileSync(join(xdg, 'metacogs', 'guidance-off'), '')
    expect(codex({ HOME: home, XDG_CONFIG_HOME: xdg })).toEqual(SILENT)
  })

  test('CLAUDE_PLUGIN_OPTION_GUIDANCE=false, in any false-like form, does not silence it', () => {
    for (const value of ['false', 'FALSE', '0', 'off', 'no']) expect(codex({ HOME: home, CLAUDE_PLUGIN_OPTION_GUIDANCE: value }), value).toEqual(PRINTS_CODEX)
  })

  test('values that are not an off signal print the note', () => {
    for (const value of ['', 'on', '1', 'true', 'offf', ' off']) expect(codex({ HOME: home, METACOGS_GUIDANCE: value }), JSON.stringify(value)).toEqual(PRINTS_CODEX)
  })
})
