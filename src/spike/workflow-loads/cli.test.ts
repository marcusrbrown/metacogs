import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { type CliIo, main } from './cli'
import { DECLARATION_PATH, type Declaration } from './declaration'
import type { LabelerTransport } from './labeler'
import { readLocks } from './marks'
import { scanLeaks, viewPath } from './mask'
import { gatedRepo, seedWorkflowSession, syntheticStore } from './test-support'

const ENDPOINT = 'https://proxy.example.invalid/v1'
const TEXT_MARKER = 'SESSION_TEXT_MARKER'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

interface Fixture {
  repo: ReturnType<typeof gatedRepo>['repo']
  declaration: Declaration
  store: ReturnType<typeof syntheticStore>
  dir: string
  privateRoot: string
  flags: string[]
}

/** Two workflow sessions of three user-message stimuli each. Every stimulus names a method and carries a text marker. */
function fixture(overrides: Partial<Declaration> = {}, options: { texts?: (session: string, index: number) => string } = {}): Fixture {
  // a wide window, so the skill files committed today are in force for the direct-read bodies
  const { repo, declaration } = gatedRepo({ window: { start: '2020-01-01', end: '2030-12-31' }, omission: { sample_size: 4, limit: 2 }, ...overrides })
  repo.write('skills/counterfactual/SKILL.md', 'body of counterfactual\n')
  repo.write('skills/synthesis/SKILL.md', 'body of synthesis\n')
  repo.commit('skills', ['skills/counterfactual/SKILL.md', 'skills/synthesis/SKILL.md'])
  const store = syntheticStore()
  for (const id of ['s1', 's2']) {
    seedWorkflowSession(store, { id, created: '2026-01-15' })
    for (let i = 0; i < 3; i++) {
      const message = store.addMessage(id, 'user')
      store.addText(message, options.texts?.(id, i) ?? `Should we use counterfactual reasoning here? ${TEXT_MARKER}_${id}_${i}`)
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-cli-'))
  const privateRoot = join(dir, 'state')
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  return { repo, declaration, store, dir, privateRoot, flags: ['--db', store.path, '--private-root', privateRoot, '--repo-root', repo.dir] }
}

interface Run {
  code: number
  out: string[]
  err: string[]
  terminal: string
}

async function run(f: Fixture, argv: string[], options: { input?: string; label?: CliIo['label']; flags?: string[] } = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const terminal: string[] = []
  const input = new PassThrough()
  input.end(options.input ?? '')
  const code = await main([...argv, ...(options.flags ?? f.flags)], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    input,
    terminal: { write: (text) => terminal.push(text) },
    git: f.repo.git,
    env: {},
    ...(options.label ? { label: options.label } : {}),
  })
  return { code, out, err, terminal: terminal.join('') }
}

/** The `key=value` fields of a status line. */
function fields(line: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const token of (line ?? '').split(' ')) {
    const at = token.indexOf('=')
    if (at > 0) result[token.slice(0, at)] = token.slice(at + 1)
  }
  return result
}
const lineOf = (r: Run, word: string): string | undefined => r.out.find((line) => line.startsWith(`${word} `))

interface Responder extends LabelerTransport {
  requests: number
}

/**
 * A labeler that proposes, for the first stimulus of each chunk, one mark for the first method, and for the second stimulus both
 * labels for the second method. The rest get nothing.
 */
function responder(): Responder {
  const self: Responder = {
    endpoint: ENDPOINT,
    requests: 0,
    async complete(request) {
      self.requests += 1
      const ids = (/^stimulus_ids: (.*)$/m.exec(request.user)?.[1] ?? '').split(', ').filter(Boolean)
      const proposals: Record<string, string>[] = []
      const [first, second] = ids
      if (first) proposals.push({ stimulus_id: first, method: 'counterfactual', label: 'expected_fire', reason: 'rests on an unchecked premise' })
      if (second) {
        proposals.push({ stimulus_id: second, method: 'synthesis', label: 'expected_fire', reason: 'agreement nobody examined' })
        proposals.push({ stimulus_id: second, method: 'synthesis', label: 'expected_silence', reason: 'a mechanical step' })
      }
      return { text: JSON.stringify({ proposals }) }
    },
  }
  return self
}

/** Freeze, view, label: the steps before judging. */
async function prepare(f: Fixture, extra: string[] = []): Promise<Responder> {
  const transport = responder()
  expect((await run(f, ['freeze'])).code).toBe(0)
  expect((await run(f, ['view'])).code).toBe(0)
  expect((await run(f, ['label', ...extra], { label: { transport } })).code).toBe(0)
  return transport
}

/** Proposal items in the order of the fixture: per session, a single-label item, then a both-labels item. */
const PROPOSAL_ANSWERS = 'a\ns\na\ns\n'
/** Two sampled stimuli: the first gets one expected-fire answer, the rest are neither. */
const OMISSION_ANSWERS = 'f\nn\nn\nn\n'

describe('freeze', () => {
  test('freezes the sample and prints counts only; a second run reports the frozen sample', async () => {
    const f = fixture()
    const first = await run(f, ['freeze'])
    expect(first.code).toBe(0)
    expect(fields(lineOf(first, 'frozen'))).toMatchObject({ slot: 'initial', sessions: '2', eligible: '2' })
    const second = await run(f, ['freeze'])
    expect(second.code).toBe(0)
    expect(fields(lineOf(second, 'exists'))).toMatchObject({ slot: 'initial', sessions: '2' })
    expect([...first.out, ...first.err].join('\n')).not.toContain('s1')
  })

  test('the added slot is refused until a session-cap raise is recorded', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    const added = await run(f, ['freeze', '--slot', 'added'])
    expect(added.code).toBe(1)
    expect(added.err.join('\n')).toContain('session_cap_not_raised')
  })
})

describe('view', () => {
  test('builds and writes the hidden view, and prints the audit as counts by kind', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    const view = await run(f, ['view'])
    expect(view.code).toBe(0)
    expect(fields(lineOf(view, 'view'))).toMatchObject({ slot: 'initial', sessions: '2', scopes: '2', stimuli: '6', audit: 'pass', method: '0', helper: '0', label: '0' })
    expect(existsSync(viewPath({ root: f.privateRoot, now: () => new Date() }, 'initial'))).toBe(true)
    expect(view.out.join('\n')).not.toContain(TEXT_MARKER)
  })

  test('a failed audit exits non-zero, prints counts by kind, and writes no view', async () => {
    // a labelled reply line in a user message is not a method name, so the masking leaves it in place
    const f = fixture({}, { texts: (_, i) => (i === 0 ? `Flip test: ${TEXT_MARKER}` : `plain ${TEXT_MARKER}`) })
    await run(f, ['freeze'])
    const view = await run(f, ['view'])
    expect(view.code).toBe(1)
    expect(fields(lineOf(view, 'view'))).toMatchObject({ audit: 'fail', method: '0', helper: '0', label: '2' })
    expect([...view.out, ...view.err].join('\n')).not.toContain(TEXT_MARKER)
    expect(existsSync(viewPath({ root: f.privateRoot, now: () => new Date() }, 'initial'))).toBe(false)
  })

  test('is refused before the manifest is frozen', async () => {
    const f = fixture()
    const view = await run(f, ['view'])
    expect(view.code).toBe(1)
    expect(view.err.join('\n')).toContain('manifest_missing')
  })
})

describe('label', () => {
  test('labels the view with the transport and prints totals', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    const transport = responder()
    const label = await run(f, ['label'], { label: { transport } })
    expect(label.code).toBe(0)
    expect(fields(lineOf(label, 'label'))).toMatchObject({ slot: 'initial', chunks: '2', labeled: '2', failed: '0', proposals: '6', coverage: 'complete' })
    expect(transport.requests).toBe(2)
    expect(label.out.join('\n')).not.toContain(TEXT_MARKER)
  })

  test('without a proxy key it fails closed: nothing is sent and nothing is stored', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    const label = await run(f, ['label'], { label: { resolve: () => undefined } })
    expect(label.code).toBe(1)
    expect(label.err.join('\n')).toContain('proxy_key_missing')
    expect(existsSync(join(f.privateRoot, 'labeler'))).toBe(false)
  })

  test('the chunk budget is an option, and later steps read the proposals the labeling stored without it', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    const label = await run(f, ['label', '--budget', '300', '--context', '1'], { label: { transport: responder() } })
    expect(label.code).toBe(0)
    const totals = fields(lineOf(label, 'label'))
    expect(Number(totals.chunks)).toBeGreaterThan(2)
    const status = fields(lineOf(await run(f, ['status']), 'status'))
    expect(status.proposals).toBe(totals.proposals)
  })

  test('a bad budget is a usage error', async () => {
    const f = fixture()
    expect((await run(f, ['label', '--budget', 'lots'])).code).toBe(2)
    expect((await run(f, ['label', '--budget', '0'])).code).toBe(2)
  })
})

describe('judge', () => {
  test('the whole path: judge, answer the sample, lock, and status counts at each step', async () => {
    const f = fixture()
    await prepare(f)

    const before = fields(lineOf(await run(f, ['status']), 'status'))
    expect(before).toMatchObject({ slot: 'initial', manifest: 'present', sessions: '2', view: 'present', stimuli: '6', proposals: '6', items: '4', judged: '0', omission_sample: '2', omission_answered: '0', locked: 'no', locks: '0' })

    const judged = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    expect(judged.code).toBe(0)
    expect(fields(lineOf(judged, 'judge'))).toMatchObject({ proposals_judged: '4', proposals_total: '4', omission_answered: '2', omission_total: '2', ready_to_lock: 'yes', stopped: 'no' })

    const after = fields(lineOf(await run(f, ['status']), 'status'))
    expect(after).toMatchObject({ judged: '4', omission_answered: '2', locked: 'no' })

    const locked = await run(f, ['lock'])
    expect(locked.code).toBe(0)
    expect(fields(lineOf(locked, 'locked'))).toMatchObject({ slot: 'initial', marks: '5', proposal_marks: '4', omission_marks: '1', omission_sample: '2', omissions: '1' })

    const [lock] = readLocks({ root: f.privateRoot, now: () => new Date() }, lockDeclarationHash(f))
    expect(lock?.marks).toHaveLength(5)
    expect(fields(lineOf(await run(f, ['status']), 'status'))).toMatchObject({ locked: 'yes', locks: '1' })
  })

  test('quit saves what was judged and a rerun resumes at the first unjudged item', async () => {
    const f = fixture()
    await prepare(f)
    const first = await run(f, ['judge'], { input: 'a\nq\n' })
    expect(first.code).toBe(0)
    expect(fields(lineOf(first, 'judge'))).toMatchObject({ proposals_judged: '1', proposals_total: '4', stopped: 'yes', ready_to_lock: 'no' })

    const second = await run(f, ['judge'], { input: 's\na\ns\n' + OMISSION_ANSWERS })
    expect(fields(lineOf(second, 'judge'))).toMatchObject({ proposals_judged: '4', omission_answered: '2', ready_to_lock: 'yes', stopped: 'no' })
    // the resumed run began with the second item, which has both labels
    expect(second.terminal).toContain('--- proposal 2 of 4')
    expect(second.terminal).not.toContain('--- proposal 1 of 4')
    expect((await run(f, ['lock'])).code).toBe(0)
  })

  test('the end of the input is a quit, and a half-answered stimulus is asked again', async () => {
    const f = fixture()
    await prepare(f)
    const first = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + 'f\n' })
    expect(first.code).toBe(0)
    expect(fields(lineOf(first, 'judge'))).toMatchObject({ proposals_judged: '4', omission_answered: '0', stopped: 'yes' })
    const second = await run(f, ['judge'], { input: OMISSION_ANSWERS })
    expect(fields(lineOf(second, 'judge'))).toMatchObject({ omission_answered: '2', ready_to_lock: 'yes' })
  })

  test('an unknown key asks again; the words work like the keys', async () => {
    const f = fixture()
    await prepare(f)
    const judged = await run(f, ['judge'], { input: 'x\naccept\nboth\nsilence\nreject\nfire\n' + OMISSION_ANSWERS })
    expect(fields(lineOf(judged, 'judge'))).toMatchObject({ proposals_judged: '4' })
    expect(judged.terminal).toContain('?')
  })

  test('relabel and reject are stored as judged: relabel keeps the mark under the other label, reject drops it', async () => {
    const f = fixture()
    await prepare(f)
    // item 1 relabel, item 2 reject, item 3 reject, item 4 reject
    await run(f, ['judge'], { input: 'l\nr\nr\nr\n' + 'n\nn\nn\nn\n' })
    const locked = await run(f, ['lock'])
    expect(fields(lineOf(locked, 'locked'))).toMatchObject({ marks: '1', proposal_marks: '1', omission_marks: '0', omissions: '0' })
    const [lock] = readLocks({ root: f.privateRoot, now: () => new Date() }, lockDeclarationHash(f))
    expect(lock?.marks[0]).toMatchObject({ method: 'counterfactual', label: 'expected_silence', source: 'proposal' })
  })

  test('session text goes to the terminal only, and an item shows nothing from the leak list but its own proposal line', async () => {
    const f = fixture()
    await prepare(f)
    const judged = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    expect(judged.terminal).toContain(TEXT_MARKER)
    // the neutral token stands where the stimuli named a method
    expect(judged.terminal).toContain('<method>')
    expect([...judged.out, ...judged.err].join('\n')).not.toContain(TEXT_MARKER)

    // The judge necessarily sees which method a proposal is about, so each proposal line is left out of the leak check; the rest
    // of every item (the stimuli and their context, the prompt) must hold nothing from the list. The omission prompts name
    // the method they ask about too, so the check covers the proposals only.
    const proposals = judged.terminal.split('--- omission')[0] ?? ''
    expect(proposals).toContain('--- proposal 4 of 4')
    const rest = proposals
      .split('\n')
      .filter((line) => !line.startsWith('proposal: '))
      .join('\n')
    expect(scanLeaks(rest)).toEqual([])
    expect(proposals.split('\n').filter((line) => line.startsWith('proposal: ')).length).toBe(6)
  })

  test('is refused after the lock', async () => {
    const f = fixture()
    await prepare(f)
    await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    await run(f, ['lock'])
    const again = await run(f, ['judge'], { input: 'r\n' })
    expect(again.code).toBe(1)
    expect(again.err.join('\n')).toContain('slot_locked')
    expect((await run(f, ['lock'])).code).toBe(1)
  })

  test('is refused before the view, and before labeling', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    const noView = await run(f, ['judge'])
    expect(noView.code).toBe(1)
    expect(noView.err.join('\n')).toContain('view_missing')
    await run(f, ['view'])
    const noLabels = await run(f, ['judge'])
    expect(noLabels.code).toBe(1)
    expect(noLabels.err.join('\n')).toContain('labeling_not_run')
  })
})

describe('lock', () => {
  test('is refused with a named reason while items remain, and writes no lock', async () => {
    const f = fixture()
    await prepare(f)
    await run(f, ['judge'], { input: 'a\nq\n' })
    const locked = await run(f, ['lock'])
    expect(locked.code).toBe(1)
    expect(locked.err.join('\n')).toContain('items_remaining')
    expect(existsSync(join(f.privateRoot, 'marks', 'lock-initial.json'))).toBe(false)
    expect(fields(lineOf(await run(f, ['status']), 'status'))).toMatchObject({ locked: 'no', locks: '0' })
  })
})

describe('guards', () => {
  test('every step is refused when the declaration gate fails, and writes nothing', async () => {
    const f = fixture()
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    for (const command of ['freeze', 'view', 'label', 'judge', 'lock', 'status']) {
      const result = await run(f, [command], { label: { transport: responder() } })
      expect(result.code).toBe(1)
      expect(result.err.join('\n')).toContain('declaration_modified')
    }
    expect(readdirSync(f.privateRoot)).toEqual([])
  })

  test('nothing is written outside the private root', async () => {
    const f = fixture()
    const before = f.repo.git.porcelain([])
    await prepare(f)
    await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    await run(f, ['lock'])
    await run(f, ['status'])
    expect(f.repo.git.porcelain([])).toBe(before)
    expect(readdirSync(f.dir)).toEqual(['state'])
    expect(readFileSync(f.store.path).length).toBeGreaterThan(0)
  })

  test('a private root inside the repository is refused', async () => {
    const f = fixture()
    const inside = await run(f, ['freeze'], { flags: ['--db', f.store.path, '--private-root', join(f.repo.dir, 'private'), '--repo-root', f.repo.dir] })
    expect(inside.code).toBe(1)
    expect(existsSync(join(f.repo.dir, 'private'))).toBe(false)
  })

  test('usage errors exit 2: no command, an unknown one, the unbuilt counting steps, a bad slot', async () => {
    const f = fixture()
    expect((await run(f, [])).code).toBe(2)
    expect((await run(f, ['frobnicate'])).code).toBe(2)
    expect((await run(f, ['count'])).code).toBe(2)
    expect((await run(f, ['project'])).code).toBe(2)
    expect((await run(f, ['freeze', '--slot', 'third'])).code).toBe(2)
    expect((await run(f, ['status', 'extra'])).code).toBe(2)
  })
})

describe('status', () => {
  test('before any step it prints zeros and absent artifacts, and no text', async () => {
    const f = fixture()
    const status = await run(f, ['status'])
    expect(status.code).toBe(0)
    expect(fields(lineOf(status, 'status'))).toMatchObject({ manifest: 'absent', sessions: '0', view: 'absent', stimuli: '0', proposals: '0', judged: '0', omission_answered: '0', locks: '0' })
  })
})

/** The declaration hash a lock is bound to, read the way the counting step would: from the gate's own pass. */
function lockDeclarationHash(f: Fixture): string {
  const locks = readdirSync(join(f.privateRoot, 'marks')).filter((name) => name.startsWith('lock-'))
  const first = locks[0]
  if (!first) throw new Error('no lock file')
  return (JSON.parse(readFileSync(join(f.privateRoot, 'marks', first), 'utf8')) as { declarationHash: string }).declarationHash
}
