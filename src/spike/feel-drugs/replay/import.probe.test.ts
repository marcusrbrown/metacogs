/** Gated host probe ($0, no provider call): the host imports a built export and exports back the same history. */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildChildEnv, createFixture, destroyFixture, type Fixture } from '../../../runner/env'
import { buildConfig, gitInit } from '../../../runner/workspace'
import { partsSignature } from './probe.test'
import { buildExport, type FixtureSpec, HOST_VERSION } from './store'

const HARNESS = process.env.METACOGS_HARNESS_BIN ?? join(homedir(), '.local/share/mise/installs/npm-fro-bot-harness/1.19.5-harness.bf7f7dfe/bin/opencode')
const fixtures: Fixture[] = []

const spec: FixtureSpec = {
  id: 'moment-a',
  kind: 'feel',
  provenance: { project: 'project-a', source_session: 'ses_source', cutoff_message: 'msg_cutoff', date: '2026-11-01' },
  expected_outcome_ref: 'synthetic',
  somewhere: 'in the gap',
  turns: [
    { role: 'user', text: 'The build fails after the upgrade.' },
    { role: 'assistant', text: 'Checking the lockfile.', tools: [{ callID: 'call_read1', tool: 'read', input: { filePath: 'notes.txt' }, output: 'synthetic notes line' }] },
    { role: 'user', text: 'Still failing.' },
    { role: 'assistant', text: 'Trying a clean install.' },
  ],
}

describe.skipIf(process.env.METACOGS_HOST_PROBES !== '1' || !existsSync(HARNESS))('built exports on the host (no provider call)', () => {
  afterAll(() => {
    for (const fx of fixtures) destroyFixture(fx)
  })

  test('the host imports a built export and exports the same ids, parts and tool results', () => {
    const fx = createFixture('metacogs-import-')
    fixtures.push(fx)
    gitInit(fx.workspace)
    const env = buildChildEnv({ fixture: fx, config: buildConfig({ permission: { edit: 'deny', bash: { '*': 'deny' } }, extra: { snapshot: false } }), extra: { npm_config_offline: 'true' } })
    const host = (...args: string[]) => spawnSync(HARNESS, args, { cwd: fx.workspace, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })

    const built = buildExport(spec, { directory: realpathSync(fx.workspace) })
    const file = join(fx.root, 'seed-export.json')
    writeFileSync(file, JSON.stringify(built))
    const imported = host('import', file)
    expect(imported.status).toBe(0)
    expect(imported.stdout).toContain(built.info.id)

    const exported = host('export', built.info.id)
    expect(exported.status).toBe(0)
    const back = JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{'))) as typeof built
    expect(back.info.version).toBe(HOST_VERSION)
    expect(back.messages.map((m) => m.info.id)).toEqual(built.messages.map((m) => m.info.id))
    expect(partsSignature(back as never)).toEqual(partsSignature(built as never))
    expect(back.messages.flatMap((m) => m.parts.map((p) => p.id))).toEqual(built.messages.flatMap((m) => m.parts.map((p) => p.id)))
  }, 180_000)
})
