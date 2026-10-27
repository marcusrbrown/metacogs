/**
 * `claude plugin validate --strict --json` over the repository root (the marketplace and the plugin manifest it
 * points at) and over `hosts/claude/` (which also checks hooks.json, .mcp.json and the skill frontmatter). It needs
 * no login and no network. CI pins the CLI (2.1.312) and sets METACOGS_HOST_VALIDATE=1; the release job's test run
 * does not, so this suite is skipped there. With the flag set, a missing `claude` CLI fails the suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import { CLAUDE_DIR } from './claude'

const enabled = process.env.METACOGS_HOST_VALIDATE === '1'

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'metacogs-claude-home-'))
  mkdirSync(join(home, '.claude'))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

function validate(path: string) {
  const run = spawnSync('claude', ['plugin', 'validate', '--strict', '--json', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // An isolated home and config directory: nothing from the machine's own Claude setup is read or written.
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  })
  if (run.error !== undefined) throw new Error(`could not run the claude CLI (METACOGS_HOST_VALIDATE=1 requires it): ${run.error.message}`)
  let report: { success?: boolean } | undefined
  try {
    report = JSON.parse(run.stdout)
  } catch {
    // reported through the assertion below with the raw output
  }
  return { status: run.status, report, stdout: run.stdout, stderr: run.stderr }
}

describe.skipIf(!enabled)('claude plugin validate --strict (METACOGS_HOST_VALIDATE=1)', () => {
  test('the repository root: marketplace and plugin manifest', () => {
    const { status, report, stdout, stderr } = validate(REPO_ROOT)
    expect({ status, success: report?.success, stdout, stderr }).toMatchObject({ status: 0, success: true })
  }, 60_000)

  test('hosts/claude/: also hooks, MCP config and skill frontmatter', () => {
    const { status, report, stdout, stderr } = validate(join(REPO_ROOT, CLAUDE_DIR))
    expect({ status, success: report?.success, stdout, stderr }).toMatchObject({ status: 0, success: true })
  }, 60_000)
})
