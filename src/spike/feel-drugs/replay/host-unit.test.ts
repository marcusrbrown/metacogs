import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildExport } from './store'
import { type AttemptJob, createHostExecutor, hostVersion, resolveHarness, shiftTimes } from './host'
import { parseSkillDelivery } from './gates'
import { armMessage } from './gates'
import { MODEL, SYNTHETIC_SPEC } from './test-support'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'replay-host-'))
  dirs.push(d)
  return d
}

describe('shiftTimes', () => {
  test('moves every time in the history by one offset, so it ends shortly before now and keeps its spacing', () => {
    const doc = buildExport(SYNTHETIC_SPEC)
    const before = JSON.stringify(doc)
    const now = Date.UTC(2026, 10, 7, 12, 0, 0)
    shiftTimes(doc, now, 120_000)
    const all: number[] = []
    const walk = (v: unknown, key?: string) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x))
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) key === 'time' && typeof x === 'number' ? all.push(x) : walk(x, k)
    }
    walk(doc)
    expect(Math.max(...all)).toBe(now - 120_000)
    const delta = doc.messages[1]!.info.time.created - buildExport(SYNTHETIC_SPEC).messages[1]!.info.time.created
    expect(doc.messages[3]!.info.time.created - buildExport(SYNTHETIC_SPEC).messages[3]!.info.time.created).toBe(delta)
    expect(JSON.stringify(doc)).not.toBe(before)
    // ids and text are untouched
    expect(doc.info.id).toBe(buildExport(SYNTHETIC_SPEC).info.id)
    expect(doc.messages.map((m) => m.info.id)).toEqual(buildExport(SYNTHETIC_SPEC).messages.map((m) => m.info.id))
  })

  test('a document with no times is left alone', () => {
    const doc = { info: { id: 'x' }, messages: [] }
    shiftTimes(doc, 1)
    expect(doc).toEqual({ info: { id: 'x' }, messages: [] })
  })
})

describe('the harness binary', () => {
  test('METACOGS_HARNESS_BIN wins; otherwise the newest npm-fro-bot-harness install under mise', () => {
    expect(resolveHarness({ METACOGS_HARNESS_BIN: '/x/opencode' }, '/nowhere')).toBe('/x/opencode')
    const home = tmp()
    const root = join(home, '.local/share/mise/installs/npm-fro-bot-harness')
    for (const v of ['1.19.4-harness.aaaa', '1.19.10-harness.bbbb', '1.19.5-harness.cccc', 'global']) mkdirSync(join(root, v), { recursive: true })
    expect(resolveHarness({}, home)).toBe(join(root, '1.19.10-harness.bbbb', 'bin', 'opencode'))
    expect(() => resolveHarness({}, tmp())).toThrow('METACOGS_HARNESS_BIN')
  })

  test('the reported version is read once per binary', () => {
    const dir = tmp()
    const bin = join(dir, 'opencode')
    writeFileSync(bin, '#!/bin/sh\necho "9.9.9+test"\n')
    chmodSync(bin, 0o755)
    expect(hostVersion(bin)).toBe('9.9.9+test')
    writeFileSync(bin, '#!/bin/sh\necho "changed"\n')
    expect(hostVersion(bin)).toBe('9.9.9+test')
  })
})

describe('magic-context text decoration', () => {
  test('a tag, and a tag with a gap marker, are stripped before the skill text is read', () => {
    const body = '# drugs\n\nbody\n\nBase directory for this skill: /p/plugin/skills/drugs\nRelative paths are relative to this base directory.\n\ncaffeine'
    expect(parseSkillDelivery(`§6§ ${body}`)?.receivedArgs).toBe('caffeine')
    expect(parseSkillDelivery(`§6§ <!-- +44w 2d -->\n${body}`)?.receivedArgs).toBe('caffeine')
  })
})

describe('the debug preflight', () => {
  /** A stand-in harness: `--version` works, `debug config` does what the case says. */
  function executorWith(debug: string, preflightTimeoutMs?: number) {
    const dir = tmp()
    const harness = join(dir, 'fake-opencode')
    writeFileSync(harness, `#!/bin/sh\ncase "$1" in\n  --version) echo 9.9.9+fake ;;\n  debug) ${debug} ;;\n  *) exit 9 ;;\nesac\n`)
    chmodSync(harness, 0o755)
    const baseDir = join(dir, 'base')
    mkdirSync(join(baseDir, 'cache'), { recursive: true })
    mkdirSync(join(baseDir, 'opencode-config-dir'), { recursive: true })
    return createHostExecutor({ harness, baseDir, packed: { spec: 'file:///fake-plugin', pluginSkillsDir: '/fake/skills' }, provider: 'scripted', owner: { opencodeDir: null, cortexkitDir: null }, ...(preflightTimeoutMs ? { preflightTimeoutMs } : {}) })
  }
  const job = (over: Partial<AttemptJob> = {}): AttemptJob => ({ fixtureId: SYNTHETIC_SPEC.id, seed: buildExport(SYNTHETIC_SPEC), model: MODEL, arm: 'continue-a', message: armMessage('continue-a', SYNTHETIC_SPEC)!, timeoutMs: 5_000, ...over })

  test('a preflight that times out leaves the arm unsent and keeps the timeout state', async () => {
    const result = await executorWith('sleep 30', 300)(job())
    try {
      expect(result).toMatchObject({ ran: false, stack: null, stackSummary: null, timedOut: true, aborted: false })
    } finally {
      result.cleanup()
    }
  })

  test('a preflight that exits without a config leaves the arm unsent', async () => {
    for (const debug of ['exit 3', 'echo not-json']) {
      const result = await executorWith(debug)(job())
      try {
        expect(result).toMatchObject({ ran: false, stack: null, timedOut: false, aborted: false })
      } finally {
        result.cleanup()
      }
    }
  })

  test('an aborted preflight keeps the abort state', async () => {
    const abort = new AbortController()
    const pending = executorWith('sleep 30')(job({ signal: abort.signal }))
    setTimeout(() => abort.abort(), 300)
    const result = await pending
    try {
      expect(result).toMatchObject({ ran: false, stack: null, aborted: true })
    } finally {
      result.cleanup()
    }
  })
})
