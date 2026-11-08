import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedCliproxy } from '../../../runner/cliproxy'
import { CredentialLeakError } from '../../../runner/manifest'
import { chatRequest, fakeExecutor, healthyResult, type Lab, MODEL, newLab, approvedFixture, skillText, stdoutOf, stepFinish, textEvent, titleRequest, toolEvent } from './test-support'
import { ARM_NAMES } from './gates'
import { type AttemptRecord, AttemptExistsError, campaignCells, campaignDir, cellDir, countedAttempt, createAttemptDir, readAttempts, runAttempt, runCampaign, spentUsd, type CampaignOptions } from './run'
import { buildFixture, freezeFixture, FixtureRefusal } from './store'
import { SYNTHETIC_SPEC } from './test-support'

const labs: Lab[] = []
afterEach(() => {
  for (const lab of labs.splice(0)) lab.dispose()
})
function lab(): Lab {
  const l = newLab()
  labs.push(l)
  return l
}

const options = (over: Partial<CampaignOptions> = {}): CampaignOptions => ({ name: 'camp', models: [MODEL], arms: [...ARM_NAMES], fixtures: ['moment-a'], capUsd: 10, provider: 'scripted', ...over })
const attemptFile = (l: Lab, arm: string, id = 'a001', model = MODEL, fixture = 'moment-a') => join(cellDir(l.store, { campaign: 'camp', fixture, model, arm: arm as never }), id, 'attempt.json')
const readRecord = (path: string): AttemptRecord => JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord
const hashTree = (dir: string): string => {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(d, e.name))
      else h.update(`${join(d, e.name)}\0`).update(readFileSync(join(d, e.name)))
    }
  }
  walk(dir)
  return h.digest('hex')
}

// Joined at run time so the repo scanner does not read the test double as a key.
const KEY = ['sk', 'test', 'SECRET', '0123456789abcdef'].join('-')
const fakeCliproxy: ResolvedCliproxy = { keyName: 'test-key', auth: { openai: { type: 'api', key: KEY } }, needles: [{ label: 'auth_cliproxy:key', value: KEY }, { label: 'auth_cliproxy:key_prefix', value: 'sk-test-' }] }

describe('a scripted campaign', () => {
  test('one frozen fixture runs all nine arms and records arm, model, host version, received args and gates', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor()
    const summary = await runCampaign(options(), { store: l.store, executor, skillsDir: '/pkg/plugin/skills' })
    expect(jobs).toHaveLength(9)
    expect(summary).toMatchObject({ cells: 9, attempts: 9, counted: { completed: 9 }, unrun: [], stoppedBy: null })
    expect(readdirSync(join(campaignDir(l.store, 'camp'), 'moment-a', 'anthropic__claude-opus-5-5')).sort()).toEqual([...ARM_NAMES].sort())
    for (const arm of ARM_NAMES) {
      const r = readRecord(attemptFile(l, arm))
      expect(r).toMatchObject({ schema_version: 1, campaign: 'camp', model: MODEL, arm, attempt: 'a001', seq: 1, provider: 'scripted', status: 'completed', terminal: true, reasons: [], outcome: 'no_tool' })
      expect(r.host).toEqual({ version: '1.19.5+harness.bf7f7dfe', expected_version: '1.19.5+harness.bf7f7dfe' })
      expect(r.gates?.passed).toBe(true)
      expect(r.fixture).toMatchObject({ id: 'moment-a', kind: 'feel' })
    }
    expect(readRecord(attemptFile(l, 'drugs-caffeine')).received_args).toBe('caffeine')
    expect(readRecord(attemptFile(l, 'feel')).received_args).toBe('')
    expect(readRecord(attemptFile(l, 'feel-somewhere')).received_args).toBe(SYNTHETIC_SPEC.somewhere)
    expect(readRecord(attemptFile(l, 'continue-a')).received_args).toBeNull()
    expect(readRecord(attemptFile(l, 'whichever')).message).toEqual({ kind: 'text', text: 'Use whichever metacogs tool fits this moment, then continue.' })
  })

  test('each attempt directory holds requests, stdout, stderr and the record, private and with matching hashes', async () => {
    const l = lab()
    approvedFixture(l.store)
    await runCampaign(options({ arms: ['feel'] }), { store: l.store, executor: fakeExecutor().executor })
    const dir = join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'feel' }), 'a001')
    expect(readdirSync(dir).sort()).toEqual(['attempt.json', 'requests.json', 'stderr.txt', 'stdout.jsonl'])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    const r = readRecord(join(dir, 'attempt.json'))
    for (const [file, hash] of Object.entries(r.artifacts)) expect(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')).toBe(hash)
    const requests = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as { returned_model: string | null }[]
    expect(requests.map((x) => x.returned_model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  })

  test('a campaign run twice skips counted cells; --again appends a second attempt and leaves the first byte-identical', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor()
    const deps = { store: l.store, executor }
    await runCampaign(options({ arms: ['continue-a', 'feel'] }), deps)
    const before = hashTree(campaignDir(l.store, 'camp'))
    await runCampaign(options({ arms: ['continue-a', 'feel'] }), deps)
    expect(jobs).toHaveLength(2)
    const first = hashTree(join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001'))
    await runCampaign(options({ arms: ['continue-a', 'feel'], again: true }), deps)
    expect(jobs).toHaveLength(4)
    expect(hashTree(join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001'))).toBe(first)
    const attempts = readAttempts(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }))
    expect(attempts.map((a) => a.id)).toEqual(['a001', 'a002'])
    expect(countedAttempt(attempts)?.id).toBe('a001')
    expect(before).not.toBe(hashTree(campaignDir(l.store, 'camp')))
  })

  test('the first terminal attempt counts, whatever follows; infrastructure failures before it do not', async () => {
    const l = lab()
    approvedFixture(l.store)
    let n = 0
    const { executor } = fakeExecutor({ explode: () => (++n === 1 ? new Error('connection reset') : undefined) })
    await runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor })
    const cell = cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' })
    expect(readAttempts(cell).map((a) => [a.id, a.status, a.terminal])).toEqual([['a001', 'error', false], ['a002', 'completed', true]])
    expect(countedAttempt(readAttempts(cell))?.id).toBe('a002')
  })

  test('an attempt that throws keeps its directory with its reason, and the cell gives up after the tries', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor({ explode: () => new TypeError('boom') })
    const summary = await runCampaign(options({ arms: ['feel'], maxAttempts: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(3)
    expect(summary.unrun).toEqual([{ fixture: 'moment-a', model: MODEL, arm: 'feel', reason: 'attempts_exhausted' }])
    const r = readRecord(attemptFile(l, 'feel', 'a003'))
    expect(r).toMatchObject({ status: 'error', terminal: false, reasons: ['TypeError'], error: { name: 'TypeError', message: 'boom' } })
    expect(readdirSync(join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'feel' }), 'a001'))).toEqual(['attempt.json'])
  })

  test('a gate-failing attempt is excluded with its reason, keeps its evidence, and is terminal', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (_job, r) => ({ ...r, partTypes: ['text', 'compaction'] }) })
    const summary = await runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor })
    expect(summary.counted).toEqual({ excluded: 1 })
    const r = readRecord(attemptFile(l, 'continue-a'))
    expect(r).toMatchObject({ status: 'excluded', terminal: true, reasons: ['compaction'], outcome: null })
    expect(existsSync(join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001', 'requests.json'))).toBe(true)
  })

  test('a command arm whose request lacks the skill content is excluded as skill_not_delivered, not read as a baseline', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (job, r) => ({ ...r, requests: [titleRequest(), chatRequest({ model: job.model, last: ['§3§ Continue.'] })] }) })
    await runCampaign(options({ arms: ['drugs'] }), { store: l.store, executor })
    expect(readRecord(attemptFile(l, 'drugs'))).toMatchObject({ status: 'excluded', reasons: ['skill_not_delivered'], outcome: null, received_args: null })
  })

  test('a shadowing skill (another base directory) is excluded the same way', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (job, r) => ({ ...r, requests: [chatRequest({ model: job.model, last: [skillText('feel', '', '/home/u/.agents/skills/feel')] })] }) })
    await runCampaign(options({ arms: ['feel'] }), { store: l.store, executor, skillsDir: '/pkg/plugin/skills' })
    expect(readRecord(attemptFile(l, 'feel')).reasons).toEqual(['skill_not_delivered'])
  })

  test('a model mismatch on the main request excludes; on a title request it does not', async () => {
    const l = lab()
    approvedFixture(l.store)
    const wrongMain = fakeExecutor({ tweak: (job, r) => ({ ...r, requests: [titleRequest(), chatRequest({ model: job.model, returnedModel: 'gpt-6-luna', last: ['Continue.'] })] }) })
    await runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor: wrongMain.executor })
    expect(readRecord(attemptFile(l, 'continue-a'))).toMatchObject({ status: 'excluded', reasons: ['model_mismatch'] })
    const wrongTitle = fakeExecutor({ tweak: (job, r) => ({ ...r, requests: [titleRequest('gpt-6-luna'), chatRequest({ model: job.model, last: ['Continue.'] })] }) })
    await runCampaign(options({ name: 'camp2', arms: ['continue-a'] }), { store: l.store, executor: wrongTitle.executor })
    expect(readRecord(join(cellDir(l.store, { campaign: 'camp2', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001', 'attempt.json')).status).toBe('completed')
  })

  test('an isolation failure before the arm was sent excludes without gates and without a provider charge', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (_j, r) => ({ ...r, ran: false, stdout: '', requests: [], stack: { passed: false, checks: [{ name: 'mcp_empty', passed: false, detail: 'mcp has 2 entries' }] } }) })
    await runCampaign(options({ arms: ['feel'], provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    const r = readRecord(attemptFile(l, 'feel'))
    expect(r).toMatchObject({ status: 'excluded', reasons: ['isolation_failed'], cost: { charged_usd: 0, basis: 'no_request' } })
  })

  test('a timeout is recorded as status timeout and is terminal', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (_j, r) => ({ ...r, timedOut: true, exitCode: -1, assistants: null, partTypes: null }) })
    const summary = await runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor })
    expect(summary.counted).toEqual({ timeout: 1 })
    expect(readRecord(attemptFile(l, 'continue-a'))).toMatchObject({ status: 'timeout', terminal: true, reasons: ['timeout'] })
  })

  test('a rate limit is retried after a backoff and does not count', async () => {
    const l = lab()
    approvedFixture(l.store)
    let n = 0
    const limited = line429()
    const { executor } = fakeExecutor({ tweak: (_j, r) => (++n === 1 ? { ...r, stdout: limited, exitCode: 1 } : r) })
    const slept: number[] = []
    await runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor, sleep: async (ms) => void slept.push(ms) })
    expect(slept).toEqual([30_000])
    expect(readAttempts(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' })).map((a) => a.status)).toEqual(['rate_limited', 'completed'])
  })

  test('a nudge arm that calls nothing is valid with outcome no_tool; calling feel or loading a skill is recorded, not gated', async () => {
    const l = lab()
    approvedFixture(l.store)
    const quiet = fakeExecutor()
    await runCampaign(options({ arms: ['nudge-only', 'whichever'] }), { store: l.store, executor: quiet.executor })
    expect(readRecord(attemptFile(l, 'nudge-only'))).toMatchObject({ status: 'completed', outcome: 'no_tool', observed: { metacogs_calls: [], skill_loads: [] } })

    const calls = fakeExecutor({ stdoutExtra: (job) => (job.arm === 'nudge-only' ? toolEvent('feel', { somewhere: 'x' }) : toolEvent('skill', { name: 'synthesis' }, 'completed', '<skill_content name="synthesis">x</skill_content>')) })
    await runCampaign(options({ name: 'camp2', arms: ['nudge-only', 'whichever'] }), { store: l.store, executor: calls.executor })
    const at = (arm: string) => readRecord(join(cellDir(l.store, { campaign: 'camp2', fixture: 'moment-a', model: MODEL, arm: arm as never }), 'a001', 'attempt.json'))
    expect(at('nudge-only')).toMatchObject({ status: 'completed', outcome: 'metacogs_tool', observed: { metacogs_calls: ['feel'] } })
    expect(at('whichever')).toMatchObject({ status: 'completed', outcome: 'skill_only', observed: { skill_loads: ['synthesis'] } })
  })

  test('an arm that does not apply to the fixture is listed as not run', async () => {
    const l = lab()
    approvedFixture(l.store, { somewhere: '' })
    const summary = await runCampaign(options({ arms: ['feel-somewhere', 'feel'] }), { store: l.store, executor: fakeExecutor().executor })
    expect(summary.unrun).toEqual([{ fixture: 'moment-a', model: MODEL, arm: 'feel-somewhere', reason: 'no_somewhere' }])
    expect(summary.attempts).toBe(1)
  })
})

const line429 = (): string => `${JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'rate limit exceeded', statusCode: 429 } } })}\n`

describe('the budget', () => {
  test('a cap hit stops before the next provider call and lists the unrun cells', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor({ cost: 1 })
    const summary = await runCampaign(options({ capUsd: 4, provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    // Each attempt reports $1 and is charged 1.75x: 1.75, then 3.50; a third could pass $4.
    expect(jobs).toHaveLength(2)
    expect(summary.stoppedBy).toBe('budget')
    expect(summary.spentUsd).toBeCloseTo(3.5)
    expect(summary.unrun.map((u) => [u.arm, u.reason])).toEqual(ARM_NAMES.slice(2).map((arm) => [arm, 'budget']))
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(3.5)
    const note = readdirSync(campaignDir(l.store, 'camp')).find((f) => f.startsWith('run-'))!
    expect(JSON.parse(readFileSync(join(campaignDir(l.store, 'camp'), note), 'utf8'))).toMatchObject({ stoppedBy: 'budget', capUsd: 4 })
  })

  test('the first attempt is held back when the estimate alone could pass the cap', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor()
    const summary = await runCampaign(options({ capUsd: 1, provider: 'cliproxy', attemptEstimateUsd: 2 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(jobs).toHaveLength(0)
    expect(summary.unrun).toHaveLength(9)
  })

  test('a host that reports no cost is charged the estimate; spend carries across invocations', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor()
    const cap = { capUsd: 2.5, provider: 'cliproxy' as const, attemptEstimateUsd: 1, arms: ['continue-a', 'continue-b', 'feel'] as const }
    await runCampaign(options({ ...cap, arms: [...cap.arms] }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(jobs).toHaveLength(2)
    const again = await runCampaign(options({ ...cap, arms: [...cap.arms] }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(jobs).toHaveLength(2)
    expect(again.unrun.map((u) => u.arm)).toEqual(['feel'])
  })

  test('a live campaign needs a cap, an estimate and a resolved key; a scripted one is never charged', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor({ cost: 5 })
    await expect(runCampaign(options({ provider: 'cliproxy' }), { store: l.store, executor, cliproxy: fakeCliproxy })).rejects.toThrow('attempt estimate')
    await expect(runCampaign(options({ provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor })).rejects.toThrow('resolved CLIProxyAPI key')
    await expect(runCampaign(options({ capUsd: 0 }), { store: l.store, executor })).rejects.toThrow('positive')
    expect(jobs).toHaveLength(0)
    const scripted = await runCampaign(options({ capUsd: 0.01, arms: ['continue-a'] }), { store: l.store, executor })
    expect(scripted.spentUsd).toBe(0)
    expect(readRecord(attemptFile(l, 'continue-a')).cost).toMatchObject({ reported_usd: 5, charged_usd: 0, basis: 'scripted' })
  })
})

describe('credentials and custody', () => {
  test('a leaked key writes labels only, keeps the directory, and stops the campaign', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor({ tweak: (_j, r) => ({ ...r, stdout: stdoutOf(textEvent(`the key is ${KEY}`), stepFinish()) }) })
    await expect(runCampaign(options({ arms: ['continue-a', 'feel'], provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })).rejects.toBeInstanceOf(CredentialLeakError)
    expect(jobs).toHaveLength(1)
    const dir = join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' }), 'a001')
    expect(readdirSync(dir)).toEqual(['attempt.json'])
    const r = readRecord(join(dir, 'attempt.json'))
    expect(r).toMatchObject({ status: 'error', reasons: ['credential_leak'], leak_labels: ['auth_cliproxy:key', 'auth_cliproxy:key_prefix'] })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  test('the key never reaches any attempt file of a clean campaign', async () => {
    const l = lab()
    approvedFixture(l.store)
    await runCampaign(options({ arms: ['continue-a', 'drugs'], provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor: fakeExecutor().executor, cliproxy: fakeCliproxy })
    const all: string[] = []
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : all.push(readFileSync(join(d, e.name), 'utf8'))))
    walk(campaignDir(l.store, 'camp'))
    expect(all.length).toBeGreaterThan(5)
    expect(all.some((t) => t.includes(KEY))).toBe(false)
  })

  test('an error message that quotes the key is redacted', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ explode: () => new Error(`bad auth ${KEY}`) })
    await runCampaign(options({ arms: ['continue-a'], provider: 'cliproxy', attemptEstimateUsd: 1, maxAttempts: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(readRecord(attemptFile(l, 'continue-a')).error?.message).toBe('[redacted]')
  })

  test('an existing attempt directory is refused, and ids are allocated in order', () => {
    const l = lab()
    const cell = cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'feel' })
    createAttemptDir(cell, 'a001')
    expect(() => createAttemptDir(cell, 'a001')).toThrow(AttemptExistsError)
    expect(() => createAttemptDir(cell, 'x1')).toThrow('expected a followed by')
    createAttemptDir(cell, 'a002')
    expect(readAttempts(cell).map((a) => [a.id, a.status])).toEqual([['a001', null], ['a002', null]])
  })

  test('an unapproved, draft, edited or excluded fixture is refused before any attempt', async () => {
    const l = lab()
    buildFixture(l.store, SYNTHETIC_SPEC)
    const { executor, jobs } = fakeExecutor()
    await expect(runCampaign(options({ fixtures: ['moment-a'] }), { store: l.store, executor })).rejects.toThrow(FixtureRefusal)
    freezeFixture(l.store, 'moment-a')
    await expect(runCampaign(options({ fixtures: ['moment-a'] }), { store: l.store, executor })).rejects.toThrow('not been approved')
    await expect(runCampaign(options({ fixtures: ['missing'] }), { store: l.store, executor })).rejects.toThrow(FixtureRefusal)
    expect(jobs).toHaveLength(0)
    expect(existsSync(campaignDir(l.store, 'camp'))).toBe(false)
  })

  test('a fixture edited after the freeze is refused', async () => {
    const l = lab()
    const id = approvedFixture(l.store)
    const path = join(l.store.root, 'fixtures', id, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    await expect(runCampaign(options(), { store: l.store, executor: fakeExecutor().executor })).rejects.toThrow('edited')
  })

  test('campaign names and models are validated', async () => {
    const l = lab()
    approvedFixture(l.store)
    const deps = { store: l.store, executor: fakeExecutor().executor }
    await expect(runCampaign(options({ name: '../x' }), deps)).rejects.toThrow('campaign name')
    await expect(runCampaign(options({ models: ['not a model'] }), deps)).rejects.toThrow('provider/model')
  })
})

describe('reading a campaign', () => {
  test('cells list their attempts and the counted one; spend sums the charges', async () => {
    const l = lab()
    approvedFixture(l.store)
    await runCampaign(options({ arms: ['continue-a', 'feel'] }), { store: l.store, executor: fakeExecutor().executor })
    const rows = campaignCells(l.store, 'camp')
    expect(rows.map((r) => [r.fixture, r.model, r.arm, r.counted?.id])).toEqual([
      ['moment-a', MODEL, 'continue-a', 'a001'],
      ['moment-a', MODEL, 'feel', 'a001'],
    ])
    expect(spentUsd(l.store, 'camp')).toBe(0)
  })

  test('runAttempt on its own appends: a second call is a new attempt', async () => {
    const l = lab()
    const id = approvedFixture(l.store)
    const { loadFrozen } = await import('./store')
    const fixture = loadFrozen(l.store, id)
    const ctx = { store: l.store, key: { campaign: 'camp', fixture: id, model: MODEL, arm: 'continue-a' as const }, fixture, executor: fakeExecutor().executor, provider: 'scripted' as const }
    const a = await runAttempt(ctx)
    const b = await runAttempt(ctx)
    expect([a.attempt, b.attempt]).toEqual(['a001', 'a002'])
    expect(healthyResult).toBeDefined()
  })
})

describe('realWorldNeedles', () => {
  test('a real-world scan drops only the key prefix', async () => {
    const { realWorldNeedles } = await import('./run')
    const needles = [{ label: 'auth_cliproxy:key', value: 'k' }, { label: 'auth_cliproxy:key_prefix', value: 'p' }]
    expect(realWorldNeedles(needles, true).map((n) => n.label)).toEqual(['auth_cliproxy:key'])
    expect(realWorldNeedles(needles, false).map((n) => n.label)).toEqual(['auth_cliproxy:key', 'auth_cliproxy:key_prefix'])
  })
})

// ── accounting ─────────────────────────────────────────────────────────────

describe('accounting', () => {
  const live = { provider: 'cliproxy' as const, attemptEstimateUsd: 1 }
  const aDir = (l: Lab, arm: string, model = MODEL) => join(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model, arm: arm as never }), 'a001')
  /** Makes the evidence write of the first attempt fail: `requests.json` is already there. */
  const blockWrite = (l: Lab) => (job: { arm: string; model: string }, r: Awaited<ReturnType<ReturnType<typeof fakeExecutor>['executor']>>) => {
    const dir = aDir(l, job.arm, job.model)
    if (!existsSync(join(dir, 'requests.json'))) writeFileSync(join(dir, 'requests.json'), 'in the way')
    return r
  }

  test('a cost survives an evidence write failure: the failed record carries the charge', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ cost: 1, tweak: blockWrite(l) })
    const summary = await runCampaign(options({ ...live, arms: ['continue-a'], maxAttempts: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    const r = readRecord(attemptFile(l, 'continue-a'))
    expect(r).toMatchObject({ status: 'error', terminal: false, artifacts: {} })
    expect(r.cost).toEqual({ reported_usd: 1, charged_usd: 1.75, basis: 'reported_x_factor' })
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(1.75)
    expect(summary.spentUsd).toBeCloseTo(1.75)
  })

  test('a failure after a host that reported no cost is charged the attempt estimate', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: blockWrite(l) })
    await runCampaign(options({ ...live, attemptEstimateUsd: 2, arms: ['continue-a'], maxAttempts: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(readRecord(attemptFile(l, 'continue-a')).cost).toMatchObject({ charged_usd: 2, basis: 'estimate' })
  })

  test('a credential-leak record keeps the charge too', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = fakeExecutor({ tweak: (_j, r) => ({ ...r, stdout: stdoutOf(textEvent(`the key is ${KEY}`), stepFinish(1)) }) })
    await expect(runCampaign(options({ ...live, arms: ['continue-a'] }), { store: l.store, executor, cliproxy: fakeCliproxy })).rejects.toBeInstanceOf(CredentialLeakError)
    const r = readRecord(attemptFile(l, 'continue-a'))
    expect(r).toMatchObject({ reasons: ['credential_leak'], cost: { charged_usd: 1.75 } })
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(1.75)
  })

  /** Makes both the evidence and the minimal record of the first attempt fail. */
  const blockRecord = (l: Lab, extra?: () => void) => (job: { arm: string; model: string }, r: Awaited<ReturnType<ReturnType<typeof fakeExecutor>['executor']>>) => {
    const dir = aDir(l, job.arm, job.model)
    if (readdirSync(dir).length === 0) {
      chmodSync(dir, 0o500)
      extra?.()
    }
    return r
  }
  const orphanFile = (l: Lab) => join(campaignDir(l.store, 'camp'), 'orphan-charges.jsonl')
  const notes = (l: Lab) => readdirSync(campaignDir(l.store, 'camp')).filter((f) => f.startsWith('run-')).map((f) => JSON.parse(readFileSync(join(campaignDir(l.store, 'camp'), f), 'utf8')))

  test('when not even the minimal record can be written, the campaign stops scheduling, counts the charge and leaves an orphan entry', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = fakeExecutor({ cost: 1, tweak: blockRecord(l) })
    try {
      const summary = await runCampaign(options({ ...live, arms: ['continue-a', 'continue-b', 'feel'] }), { store: l.store, executor, cliproxy: fakeCliproxy })
      expect(jobs).toHaveLength(1)
      expect(summary.stoppedBy).toBe('accounting')
      expect(summary.spentUsd).toBeCloseTo(1.75)
      expect(summary.unrun.map((u) => [u.arm, u.reason])).toEqual([['continue-a', 'accounting'], ['continue-b', 'accounting'], ['feel', 'accounting']])
      expect(notes(l)[0]).toMatchObject({ stoppedBy: 'accounting', spentUsd: 1.75 })
      const entries = readFileSync(orphanFile(l), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(entries).toEqual([{ schema_version: 1, at: expect.any(String), fixture: 'moment-a', model: MODEL, arm: 'continue-a', attempt: 'a001', charged_usd: 1.75 }])
    } finally {
      chmodSync(aDir(l, 'continue-a'), 0o700)
    }
  })

  test('a resume after an accounting stop keeps the orphan charge: it counts toward the cap and the largest charge', async () => {
    const l = lab()
    approvedFixture(l.store)
    try {
      await runCampaign(options({ ...live, capUsd: 10, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: fakeExecutor({ cost: 1, tweak: blockRecord(l) }).executor, cliproxy: fakeCliproxy })
    } finally {
      chmodSync(aDir(l, 'continue-a'), 0o700) // write access is back
    }
    expect(readAttempts(cellDir(l.store, { campaign: 'camp', fixture: 'moment-a', model: MODEL, arm: 'continue-a' })).map((a) => a.charged_usd)).toEqual([0]) // the attempt itself left no record
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(1.75)
    // 1.75 spent; a 0.1 estimate would fit under 3, but the 1.75 charge has been seen.
    const resumed = fakeExecutor({ cost: 1 })
    const summary = await runCampaign(options({ ...live, attemptEstimateUsd: 0.1, capUsd: 3, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: resumed.executor, cliproxy: fakeCliproxy })
    expect(resumed.jobs).toHaveLength(0)
    expect(summary).toMatchObject({ stoppedBy: 'budget' })
    expect(summary.spentUsd).toBeCloseTo(1.75)
  })

  test('when the orphan entry cannot be written either, resume refuses until it is added; adding it keeps the charge', async () => {
    const l = lab()
    approvedFixture(l.store)
    const inTheWay = () => mkdirSync(orphanFile(l)) // a directory where the ledger file goes: the append fails
    try {
      const summary = await runCampaign(options({ ...live, capUsd: 10, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: fakeExecutor({ cost: 1, tweak: blockRecord(l, inTheWay) }).executor, cliproxy: fakeCliproxy })
      expect(summary.stoppedBy).toBe('accounting')
    } finally {
      chmodSync(aDir(l, 'continue-a'), 0o700)
    }
    rmSync(orphanFile(l), { recursive: true })
    expect(notes(l)[0]).toMatchObject({ stoppedBy: 'accounting', orphan_charge: { arm: 'continue-a', attempt: 'a001', charged_usd: 1.75 } })

    const resumed = fakeExecutor({ cost: 1 })
    let message = ''
    try {
      await runCampaign(options({ ...live, capUsd: 10, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: resumed.executor, cliproxy: fakeCliproxy })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/orphan-charges\.jsonl/)
    expect(message).toContain('continue-a')
    expect(message).toContain('1.75')
    expect(resumed.jobs).toHaveLength(0)

    // The message carries the line to add; with it in place the charge counts and the campaign goes on.
    const line = /(\{"schema_version":1[^\n]*\})/.exec(message)![1]!
    appendFileSync(orphanFile(l), `${line}\n`)
    const summary = await runCampaign(options({ ...live, attemptEstimateUsd: 0.1, capUsd: 3, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: resumed.executor, cliproxy: fakeCliproxy })
    expect(resumed.jobs).toHaveLength(0)
    expect(summary).toMatchObject({ stoppedBy: 'budget' })
    expect(summary.spentUsd).toBeCloseTo(1.75)
  })

  test('an unreadable orphan ledger stops a run before any dispatch', async () => {
    const l = lab()
    approvedFixture(l.store)
    mkdirSync(campaignDir(l.store, 'camp'), { recursive: true })
    writeFileSync(orphanFile(l), 'not json\n')
    const { executor, jobs } = fakeExecutor()
    await expect(runCampaign(options({ arms: ['continue-a'] }), { store: l.store, executor })).rejects.toThrow(/orphan-charges\.jsonl/)
    expect(jobs).toHaveLength(0)
  })

  test('a resumed campaign restores the largest charge before any admission decision', async () => {
    const l = lab()
    approvedFixture(l.store)
    const first = fakeExecutor({ cost: 1 })
    await runCampaign(options({ ...live, attemptEstimateUsd: 0.1, capUsd: 10, arms: ['continue-a', 'continue-b'] }), { store: l.store, executor: first.executor, cliproxy: fakeCliproxy })
    expect(spentUsd(l.store, 'camp')).toBeCloseTo(3.5) // two attempts at 1.75
    const second = fakeExecutor({ cost: 1 })
    // 3.5 spent, a 0.1 estimate would fit under 4, but a 1.75 charge has been seen.
    const summary = await runCampaign(options({ ...live, attemptEstimateUsd: 0.1, capUsd: 4, arms: ['continue-a', 'continue-b', 'feel'] }), { store: l.store, executor: second.executor, cliproxy: fakeCliproxy })
    expect(second.jobs).toHaveLength(0)
    expect(summary).toMatchObject({ stoppedBy: 'budget' })
    expect(summary.unrun.map((u) => u.arm)).toEqual(['feel'])
  })
})

describe('an unfinished debug preflight', () => {
  const unsent = (over: Record<string, unknown>) =>
    fakeExecutor({ tweak: (_j, r) => ({ ...r, ran: false, stack: null, stackSummary: null, stdout: '', exitCode: -1, assistants: null, partTypes: null, ...over }) })

  test.each([
    ['times out', { timedOut: true }, 'preflight_timeout'],
    ['is aborted', { aborted: true }, 'preflight_aborted'],
    ['exits without a config', {}, 'preflight_no_config'],
  ])('a preflight that %s is a retryable host_error, never isolation_failed or a terminal timeout', async (_name, over, reason) => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = unsent(over)
    const summary = await runCampaign(options({ arms: ['continue-a'], maxAttempts: 2 }), { store: l.store, executor })
    const records = [readRecord(attemptFile(l, 'continue-a', 'a001')), ...(existsSync(attemptFile(l, 'continue-a', 'a002')) ? [readRecord(attemptFile(l, 'continue-a', 'a002'))] : [])]
    for (const r of records) expect(r).toMatchObject({ status: 'host_error', terminal: false, reasons: [reason], gates: null })
    expect(campaignCells(l.store, 'camp')[0]!.counted).toBeUndefined()
    expect(summary.counted).toEqual({})
    // The cell is open: the next invocation tries it again.
    const retry = await runCampaign(options({ arms: ['continue-a'], maxAttempts: 1 }), { store: l.store, executor: fakeExecutor().executor })
    expect(retry.counted).toEqual({ completed: 1 })
  })

  test('an aborted preflight stops the campaign instead of trying the cell again', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor, jobs } = unsent({ aborted: true })
    const summary = await runCampaign(options({ arms: ['continue-a', 'continue-b'], maxAttempts: 3 }), { store: l.store, executor })
    expect(jobs).toHaveLength(1)
    expect(summary.stoppedBy).toBe('aborted')
  })
})

describe('real-world seed turns', () => {
  test('a world fixture without seed turns is not run: no spec-turn fallback', async () => {
    const l = lab()
    const id = approvedFixture(l.store)
    const { loadFrozen } = await import('./store')
    const frozen = loadFrozen(l.store, id)
    const world = { source: '/x', githubRepo: 'o/r', cutoffMs: 1, hints: [] }
    const { executor, jobs } = fakeExecutor()
    for (const seedUserTurns of [undefined, []]) {
      const fixture = { ...frozen, world, ...(seedUserTurns ? { seedUserTurns } : {}) }
      const r = await runAttempt({ store: l.store, key: { campaign: 'camp', fixture: id, model: MODEL, arm: 'continue-a' }, fixture, executor, provider: 'scripted' })
      expect(r).toMatchObject({ status: 'error', terminal: false, reasons: ['seed_turns_missing'] })
    }
    expect(jobs).toHaveLength(0)
  })
})

describe('scan policy follows the world flag, not the loader', () => {
  const prefixOnly = (): ReturnType<typeof fakeExecutor> => fakeExecutor({ tweak: (_j, r) => ({ ...r, stdout: stdoutOf(textEvent('a log line mentions sk-test- by itself'), stepFinish()) }) })

  test('a custom loader without the world flag still scans for the key prefix', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { loadFrozen } = await import('./store')
    const { executor } = prefixOnly()
    await expect(runCampaign(options({ arms: ['continue-a'], provider: 'cliproxy', attemptEstimateUsd: 1 }), { store: l.store, executor, cliproxy: fakeCliproxy, loadFixture: (id) => loadFrozen(l.store, id) })).rejects.toBeInstanceOf(CredentialLeakError)
  })

  test('the world flag drops the prefix with the default loader, and the full key is still caught', async () => {
    const l = lab()
    approvedFixture(l.store)
    const { executor } = prefixOnly()
    const summary = await runCampaign(options({ arms: ['continue-a'], provider: 'cliproxy', attemptEstimateUsd: 1, world: true }), { store: l.store, executor, cliproxy: fakeCliproxy })
    expect(summary.counted).toEqual({ completed: 1 })
    const leaking = fakeExecutor({ tweak: (_j, r) => ({ ...r, stdout: stdoutOf(textEvent(`key ${KEY}`), stepFinish()) }) })
    await expect(runCampaign(options({ name: 'camp-2', arms: ['continue-a'], provider: 'cliproxy', attemptEstimateUsd: 1, world: true }), { store: l.store, executor: leaking.executor, cliproxy: fakeCliproxy })).rejects.toBeInstanceOf(CredentialLeakError)
  })
})
