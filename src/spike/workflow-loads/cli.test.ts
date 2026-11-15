import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { type CliIo, main, terminalSafe } from './cli'
import { assertGate, DECLARATION_PATH, type Declaration, recordDeviation, WORKFLOW_LOADS_DIR } from './declaration'
import type { LabelerTransport } from './labeler'
import { readLocks } from './marks'
import { chunkScope, type HiddenView, scanLeaks, viewPath } from './mask'
import { projectionSchema } from './project'
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

async function run(f: Fixture, argv: string[], options: { input?: string; label?: CliIo['label']; flags?: string[]; git?: CliIo['git']; io?: Partial<CliIo> } = {}): Promise<Run> {
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
    // these injected streams are not terminals, so `judge` needs the explicit test option
    allowNonTerminal: true,
    git: options.git ?? f.repo.git,
    env: {},
    ...(options.label ? { label: options.label } : {}),
    ...options.io,
  })
  return { code, out, err, terminal: terminal.join('') }
}

/** Every file under `root` but `.git`'s, and every directory, by relative path: a hash of the content, or `dir`. Ignored files are included. */
function snapshotTree(root: string, rel = ''): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (rel === '' && name === '.git') continue
    const path = rel === '' ? name : `${rel}/${name}`
    if (lstatSync(join(root, path)).isDirectory()) {
      files[`${path}/`] = 'dir'
      Object.assign(files, snapshotTree(root, path))
    } else files[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
  }
  return files
}

/** The paths added, removed or changed between two snapshots, directories left out. */
function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => !path.endsWith('/') && before[path] !== after[path]).sort()
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
    expect(first.code).toBe(4)
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
    expect(first.code).toBe(4)
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
    for (const command of ['freeze', 'view', 'label', 'judge', 'lock', 'status', 'count', 'project', 'purge']) {
      const result = await run(f, [command], { label: { transport: responder() } })
      expect(result.code).toBe(1)
      expect(result.err.join('\n')).toContain('declaration_modified')
    }
    expect(readdirSync(f.privateRoot)).toEqual([])
  })

  test('no step writes into the repository but the counts projection, ignored files and every step through purge included', async () => {
    const f = fixture()
    // an ignore rule, so a stray file that `git status` would hide is still seen by the snapshot
    f.repo.write('.gitignore', '*.log\nignored/\n')
    const countsRel = `${WORKFLOW_LOADS_DIR}/counts.json`
    const steps: { argv: string[]; options?: Parameters<typeof run>[2]; writes: string[] }[] = [
      { argv: ['freeze'], writes: [] },
      { argv: ['view'], writes: [] },
      { argv: ['label'], options: { label: { transport: responder() } }, writes: [] },
      { argv: ['judge'], options: { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS }, writes: [] },
      { argv: ['lock'], writes: [] },
      { argv: ['status'], writes: [] },
      { argv: ['count'], writes: [] },
      { argv: ['project'], writes: [countsRel] },
      { argv: ['purge'], writes: [] },
    ]
    let before = snapshotTree(f.repo.dir)
    for (const step of steps) {
      const result = await run(f, step.argv, step.options)
      expect({ step: step.argv[0], code: result.code, err: result.err }).toEqual({ step: step.argv[0], code: 0, err: [] })
      const after = snapshotTree(f.repo.dir)
      expect({ step: step.argv[0], changed: changedPaths(before, after) }).toEqual({ step: step.argv[0], changed: step.writes })
      before = after
    }
    // the one allowed write is the projection, and it parses against the schema
    expect(projectionSchema.safeParse(JSON.parse(readFileSync(join(f.repo.dir, countsRel), 'utf8'))).success).toBe(true)
    expect(readdirSync(f.dir)).toEqual(['state'])
    expect(readFileSync(f.store.path).length).toBeGreaterThan(0)
  })

  test('a private root inside the repository is refused', async () => {
    const f = fixture()
    const inside = await run(f, ['freeze'], { flags: ['--db', f.store.path, '--private-root', join(f.repo.dir, 'private'), '--repo-root', f.repo.dir] })
    expect(inside.code).toBe(1)
    expect(existsSync(join(f.repo.dir, 'private'))).toBe(false)
  })

  test('usage errors exit 2: no command, an unknown one, a bad slot, an argument a command does not take', async () => {
    const f = fixture()
    expect((await run(f, [])).code).toBe(2)
    expect((await run(f, ['frobnicate'])).code).toBe(2)
    expect((await run(f, ['count', 'extra'])).code).toBe(2)
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

/** One session gives two proposal items (accept, then silence) and one unproposed stimulus (neither method). */
const ONE_SESSION_ANSWERS = 'a\ns\nn\nn\n'

/** Freeze, view, label, judge everything, lock: the stage up to counting. The fixture's stimuli carry no load. */
async function lockedFixture(f: Fixture, answers = PROPOSAL_ANSWERS + OMISSION_ANSWERS): Promise<void> {
  await prepare(f)
  expect((await run(f, ['judge'], { input: answers })).code).toBe(0)
  expect((await run(f, ['lock'])).code).toBe(0)
}

describe('label after judging has started', () => {
  test('is refused with a named reason once a judgment is stored, and sends and stores nothing more', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'a\nq\n' })).code).toBe(4)
    const outcomes = readdirSync(join(f.privateRoot, 'labeler', 'outcomes')).length
    const chunking = readFileSync(join(f.privateRoot, 'marks', 'initial', 'chunking.json'), 'utf8')
    const transport = responder()
    const again = await run(f, ['label', '--budget', '300'], { label: { transport } })
    expect(again.code).toBe(1)
    expect(again.err.join('\n')).toContain('judging_started')
    expect(transport.requests).toBe(0)
    expect(readdirSync(join(f.privateRoot, 'labeler', 'outcomes')).length).toBe(outcomes)
    expect(readFileSync(join(f.privateRoot, 'marks', 'initial', 'chunking.json'), 'utf8')).toBe(chunking)
  })

  test('is refused once an omission answer is stored', async () => {
    const f = fixture()
    await prepare(f)
    // proposals are judged first; the input then answers one sampled stimulus and quits at the next
    expect((await run(f, ['judge'], { input: `${PROPOSAL_ANSWERS}n\nn\nq\n` })).code).toBe(4)
    const again = await run(f, ['label'], { label: { transport: responder() } })
    expect(again.code).toBe(1)
    expect(again.err.join('\n')).toContain('judging_started')
  })

  test('is refused after the lock', async () => {
    const f = fixture()
    await lockedFixture(f)
    const again = await run(f, ['label'], { label: { transport: responder() } })
    expect(again.code).toBe(1)
    expect(again.err.join('\n')).toContain('judging_started')
  })

  test('is allowed again when a judge run was opened and quit with nothing stored', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'q\n' })).code).toBe(4)
    const again = await run(f, ['label'], { label: { transport: responder() } })
    expect(again.code).toBe(0)
  })

  test('the gate is checked first', async () => {
    const f = fixture()
    await prepare(f)
    await run(f, ['judge'], { input: 'a\nq\n' })
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    expect((await run(f, ['label'], { label: { transport: responder() } })).err.join('\n')).toContain('declaration_modified')
  })
})

describe('judge output', () => {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  // an ANSI colour sequence, an OSC 52 clipboard write, and a bare carriage return
  const hostile = `${ESC}[31mcolour${ESC}[0m ${ESC}]52;c;SGVsbG8=${BEL}clip then a\rb`
  const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

  /** A labeler whose reason carries terminal sequences, for the first stimulus of each chunk. */
  function hostileResponder(): LabelerTransport {
    return {
      endpoint: ENDPOINT,
      async complete(request) {
        const [first] = (/^stimulus_ids: (.*)$/m.exec(request.user)?.[1] ?? '').split(', ').filter(Boolean)
        const proposals = first ? [{ stimulus_id: first, method: 'counterfactual', label: 'expected_fire', reason: `because ${ESC}[1mbold${ESC}[0m ${ESC}]52;c;QUJD${BEL}end` }] : []
        return { text: JSON.stringify({ proposals }) }
      },
    }
  }

  test('terminal control sequences in a stimulus and in the labeler reason never reach the terminal stream', async () => {
    const f = fixture({}, { texts: (id, i) => `${hostile} ${TEXT_MARKER}_${id}_${i}` })
    await run(f, ['freeze'])
    expect((await run(f, ['view'])).code).toBe(0)
    expect((await run(f, ['label'], { label: { transport: hostileResponder() } })).code).toBe(0)
    // two proposal items, then four sampled stimuli with two answers each
    const judged = await run(f, ['judge'], { input: `a\na\n${'n\n'.repeat(8)}` })
    expect(judged.code).toBe(0)
    expect(judged.terminal).toContain(TEXT_MARKER)
    expect(judged.terminal).toContain('colour')
    expect(judged.terminal).toContain('because')
    expect(judged.terminal).not.toMatch(CONTROLS)
    expect(judged.terminal).not.toContain('SGVsbG8=')
    expect(judged.terminal).not.toContain('QUJD')
    expect(judged.terminal).not.toContain('52;c')
    // a stray control character is shown, not acted on
    expect(judged.terminal).toContain('a^Mb')
  })

  test('terminalSafe removes whole sequences, shows stray controls, and keeps ordinary text, newlines and tabs', () => {
    const ESC = String.fromCharCode(27)
    const ST = `${ESC}\\`
    const cases: [string, string][] = [
      [`a${ESC}[1;31mb${ESC}[0mc`, 'abc'],
      [`a${ESC}]0;title${String.fromCharCode(7)}b`, 'ab'],
      [`a${ESC}]52;c;QUJD${ST}b`, 'ab'],
      [`a${ESC}Pq data${ST}b`, 'ab'],
      [`a${String.fromCharCode(0x9b)}31mb`, 'ab'],
      [`a${String.fromCharCode(0x9d)}52;c;QUJD${String.fromCharCode(0x9c)}b`, 'ab'],
      [`a${ESC}bc`, 'ac'],
      [`a${ESC}`, 'a^['],
      ['a\rb', 'a^Mb'],
      [`a${String.fromCharCode(7)}b${String.fromCharCode(8)}c${String.fromCharCode(127)}`, 'a^Gb^Hc^?'],
      [`a${String.fromCharCode(0x85)}b`, 'a\\x85b'],
      ['line\n\ttabbed — ünïcode', 'line\n\ttabbed — ünïcode'],
    ]
    for (const [input, expected] of cases) expect(terminalSafe(input)).toBe(expected)
  })

  test('newlines and tabs in session text are kept', async () => {
    const f = fixture({}, { texts: (id, i) => `first line\n\tindented ${TEXT_MARKER}_${id}_${i}` })
    await run(f, ['freeze'])
    await run(f, ['view'])
    await run(f, ['label'], { label: { transport: responder() } })
    const judged = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    expect(judged.terminal).toContain('first line\n\tindented')
  })
})

describe('count', () => {
  test('is refused before any lock, with the named reason', async () => {
    const f = fixture()
    await prepare(f)
    const counted = await run(f, ['count'])
    expect(counted.code).toBe(1)
    expect(counted.err.join('\n')).toContain('no_lock')
  })

  test('is refused while a frozen slot has no lock', async () => {
    const f = fixture({ session_cap: 1 })
    await lockedFixture(f, ONE_SESSION_ANSWERS)
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 2 } })
    expect((await run(f, ['freeze', '--slot', 'added'])).code).toBe(0)
    const counted = await run(f, ['count'])
    expect(counted.code).toBe(1)
    expect(counted.err.join('\n')).toContain('slot_not_locked')
  })

  test('prints the outcome, the note codes and the bucket totals, as counts and fixed words', async () => {
    const f = fixture()
    await lockedFixture(f)
    const counted = await run(f, ['count'])
    expect(counted.code).toBe(0)
    expect(fields(lineOf(counted, 'count'))).toMatchObject({ outcome: 'errors_observed', notes: 'minimum_unmet', slots: '1', sampled: '2', stimuli: '6', chunks: '2', failed: '0', not_attempted: '0', omission_sample: '2', omissions: '1' })
    // three counterfactual expected-fire marks and no load anywhere: three misses; two synthesis expected-silence marks: two correct silences
    expect(fields(lineOf(counted, 'counterfactual'))).toMatchObject({ fire_marks: '3', hit: '0', miss: '3', loaded_earlier: '0', silence_marks: '0', false_fire: '0', correct_silence: '0', hits_skill_call: '0', hits_direct_read: '0', unmarked_loads: '0' })
    expect(fields(lineOf(counted, 'synthesis'))).toMatchObject({ fire_marks: '0', miss: '0', silence_marks: '2', correct_silence: '2', false_fire: '0', unmarked_loads: '0' })
    expect([...counted.out, ...counted.err].join('\n')).not.toContain(TEXT_MARKER)
    expect([...counted.out, ...counted.err].join('\n')).not.toContain('s1')
  })

  test('reads nothing but the stored state: it writes no file', async () => {
    const f = fixture()
    await lockedFixture(f)
    const before = f.repo.git.porcelain([])
    await run(f, ['count'])
    expect(f.repo.git.porcelain([])).toBe(before)
  })
})

describe('project', () => {
  test('is refused before any lock and writes nothing', async () => {
    const f = fixture()
    await prepare(f)
    const projected = await run(f, ['project'])
    expect(projected.code).toBe(1)
    expect(projected.err.join('\n')).toContain('no_lock')
    expect(existsSync(join(f.repo.dir, 'evals', 'spikes', 'workflow-loads', 'counts.json'))).toBe(false)
  })

  test('writes counts.json under the repository spike directory and prints the table, with method names and no other leak', async () => {
    const f = fixture()
    await lockedFixture(f)
    const projected = await run(f, ['project'])
    expect(projected.code).toBe(0)
    const file = join(f.repo.dir, 'evals', 'spikes', 'workflow-loads', 'counts.json')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ schema_version: 1, outcome: 'errors_observed', stimuli_in_scope: 6 })
    const printed = projected.out.join('\n')
    expect(printed).toContain('| counterfactual | expected_fire | 3 | 0 | 3 | 0 | – | – |')
    expect(printed).not.toContain(TEXT_MARKER)
    expect(printed).not.toContain(f.repo.dir)
    expect(scanLeaks(printed).filter((hit) => hit.kind !== 'method')).toEqual([])
    expect(scanLeaks(text).filter((hit) => hit.kind !== 'method')).toEqual([])
  })

  test('is refused when the declaration gate fails, and writes nothing', async () => {
    const f = fixture()
    await lockedFixture(f)
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    expect((await run(f, ['project'])).code).toBe(1)
    expect(existsSync(join(f.repo.dir, 'evals', 'spikes', 'workflow-loads', 'counts.json'))).toBe(false)
  })
})

describe('purge', () => {
  test('is refused until every frozen slot is locked, and deletes nothing', async () => {
    const f = fixture()
    await prepare(f)
    const early = await run(f, ['purge'])
    expect(early.code).toBe(1)
    expect(early.err.join('\n')).toContain('no_lock')
    expect(existsSync(join(f.privateRoot, 'views'))).toBe(true)
    expect(existsSync(join(f.privateRoot, 'labeler', 'replies'))).toBe(true)
  })

  test('is refused while an added slot is frozen but not locked', async () => {
    const f = fixture({ session_cap: 1 })
    await lockedFixture(f, ONE_SESSION_ANSWERS)
    recordDeviation({ git: f.repo.git, entry: { code: 'session_cap_raise', reason: 'too few marks', session_cap: 2 } })
    await run(f, ['freeze', '--slot', 'added'])
    const purged = await run(f, ['purge'])
    expect(purged.code).toBe(1)
    expect(purged.err.join('\n')).toContain('slot_not_locked')
    expect(existsSync(join(f.privateRoot, 'views'))).toBe(true)
  })

  test('deletes the views and the raw replies, keeps the manifests, outcomes, judgments and locks, and prints how many files went', async () => {
    const f = fixture()
    await lockedFixture(f)
    const outcomes = readdirSync(join(f.privateRoot, 'labeler', 'outcomes')).length
    const judgments = readdirSync(join(f.privateRoot, 'marks', 'initial', 'judgments')).length
    const purged = await run(f, ['purge'])
    expect(purged.code).toBe(0)
    expect(fields(lineOf(purged, 'purged'))).toMatchObject({ views: '1', replies: '2' })
    expect(existsSync(join(f.privateRoot, 'views'))).toBe(false)
    expect(existsSync(join(f.privateRoot, 'labeler', 'replies'))).toBe(false)
    expect(existsSync(join(f.privateRoot, 'manifest-initial.json'))).toBe(true)
    expect(existsSync(join(f.privateRoot, 'marks', 'lock-initial.json'))).toBe(true)
    expect(readdirSync(join(f.privateRoot, 'labeler', 'outcomes')).length).toBe(outcomes)
    expect(readdirSync(join(f.privateRoot, 'marks', 'initial', 'judgments')).length).toBe(judgments)
    expect(existsSync(join(f.privateRoot, 'marks', 'initial', 'chunking.json'))).toBe(true)

    // a second purge has nothing to remove, and counting after it names the missing view
    expect(fields(lineOf(await run(f, ['purge']), 'purged'))).toMatchObject({ views: '0', replies: '0' })
    const counted = await run(f, ['count'])
    expect(counted.code).toBe(1)
    expect(counted.err.join('\n')).toContain('view_missing')
  })
})

/** The declaration hash a lock is bound to, read the way the counting step would: from the gate's own pass. */
function lockDeclarationHash(f: Fixture): string {
  const locks = readdirSync(join(f.privateRoot, 'marks')).filter((name) => name.startsWith('lock-'))
  const first = locks[0]
  if (!first) throw new Error('no lock file')
  return (JSON.parse(readFileSync(join(f.privateRoot, 'marks', first), 'utf8')) as { declarationHash: string }).declarationHash
}

/** Rewrites the first stimulus text of the stored view, as an edit to the file on disk would. */
function editStoredView(f: Fixture): void {
  const path = viewPath({ root: f.privateRoot, now: () => new Date() }, 'initial')
  const view = JSON.parse(readFileSync(path, 'utf8')) as HiddenView
  const stimulus = view.scopes[0]?.stimuli[0]
  if (!stimulus) throw new Error('no stimulus to edit')
  stimulus.text = `${stimulus.text} edited`
  writeFileSync(path, `${JSON.stringify(view, null, 2)}\n`)
}

describe('the view after judging has started', () => {
  const storedView = (f: Fixture): string => readFileSync(viewPath({ root: f.privateRoot, now: () => new Date() }, 'initial'), 'utf8')

  test('view is refused once a judgment is stored, and the stored view stays as it was', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'a\nq\n' })).code).toBe(4)
    const before = storedView(f)
    const rebuilt = await run(f, ['view'])
    expect(rebuilt.code).toBe(1)
    expect(rebuilt.err.join('\n')).toContain('judging_started')
    expect(storedView(f)).toBe(before)
  })

  test('view is refused once the slot is locked', async () => {
    const f = fixture()
    await lockedFixture(f)
    const before = storedView(f)
    const rebuilt = await run(f, ['view'])
    expect(rebuilt.code).toBe(1)
    expect(rebuilt.err.join('\n')).toContain('judging_started')
    expect(storedView(f)).toBe(before)
  })

  test('view is still allowed after a judge run that stored nothing', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'q\n' })).code).toBe(4)
    expect((await run(f, ['view'])).code).toBe(0)
  })

  test('a view file altered on disk after judging makes judging refuse', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'a\nq\n' })).code).toBe(4)
    editStoredView(f)
    const again = await run(f, ['judge'], { input: 'a\na\na\n' })
    expect(again.code).toBe(1)
    expect(again.err.join('\n')).toContain('view_changed')
    expect(readdirSync(join(f.privateRoot, 'marks', 'initial', 'judgments'))).toHaveLength(1)
  })

  test('a view file altered on disk after the lock makes locking, counting and projecting refuse', async () => {
    const f = fixture()
    await lockedFixture(f)
    editStoredView(f)
    for (const command of ['count', 'project']) {
      const result = await run(f, [command])
      expect({ command, code: result.code }).toEqual({ command, code: 1 })
      expect(result.err.join('\n')).toContain('view_changed')
    }
    expect(existsSync(join(f.repo.dir, 'evals', 'spikes', 'workflow-loads', 'counts.json'))).toBe(false)
    expect((await run(f, ['status'])).err.join('\n')).toContain('view_changed')
  })

  test('an unaltered view still counts after judging', async () => {
    const f = fixture()
    await lockedFixture(f)
    expect((await run(f, ['count'])).code).toBe(0)
  })
})

describe('the context the judge sees', () => {
  const CONTEXT_K = 2
  const contextIdsOf = (block: string): string[] => [...block.matchAll(/^### \[context\] (\S+) /gm)].map((m) => m[1] ?? '')
  const blockOf = (terminal: string, id: string): string => terminal.split('\n--- ').find((block) => block.includes(`### [stimulus] ${id} `)) ?? ''

  /** A budget at which some chunk starts mid-scope with only part of the context the size asks for. */
  function trimmingBudget(view: HiddenView): number {
    for (let budget = 100; budget < 3000; budget += 5) {
      const trimmed = view.scopes.some((scope) =>
        chunkScope(scope, { budget, contextK: CONTEXT_K }).some((chunk) => {
          const first = scope.stimuli.findIndex((s) => s.id === chunk.ids[0])
          return first > 0 && chunk.contextIds.length > 0 && chunk.contextIds.length < Math.min(CONTEXT_K, first)
        }),
      )
      if (trimmed) return budget
    }
    throw new Error('no budget trims the context')
  }

  test('a proposal from a chunk that trimmed its context is shown with the same trimmed context', async () => {
    const f = fixture({}, { texts: (id, i) => `ordinary text number ${i} of ${id} with some padding to give each stimulus weight ${TEXT_MARKER}` })
    await run(f, ['freeze'])
    await run(f, ['view'])
    const view = JSON.parse(readFileSync(viewPath({ root: f.privateRoot, now: () => new Date() }, 'initial'), 'utf8')) as HiddenView
    const budget = trimmingBudget(view)
    expect((await run(f, ['label', '--budget', String(budget), '--context', String(CONTEXT_K)], { label: { transport: responder() } })).code).toBe(0)
    const judged = await run(f, ['judge'], { input: 'r\n'.repeat(40) })

    let checked = 0
    for (const scope of view.scopes) {
      for (const chunk of chunkScope(scope, { budget, contextK: CONTEXT_K })) {
        const first = scope.stimuli.findIndex((s) => s.id === chunk.ids[0])
        const id = chunk.ids[0]
        if (!id || first === 0) continue
        // the responder proposes for the first stimulus of every chunk, so each of these is judged
        expect(contextIdsOf(blockOf(judged.terminal, id))).toEqual(chunk.contextIds)
        if (chunk.contextIds.length < Math.min(CONTEXT_K, first)) checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('an omission item keeps the configured context', async () => {
    const f = fixture()
    await prepare(f)
    const judged = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })
    const omissions = judged.terminal.split('\n--- omission').slice(1)
    expect(omissions).toHaveLength(2)
    // each session's third stimulus is the unproposed one, with the two before it as context
    for (const block of omissions) expect(contextIdsOf(block)).toHaveLength(2)
  })
})

describe('judge and the terminal', () => {
  const tty = (input: string): { input: PassThrough; terminal: { write: (text: string) => void; isTTY: boolean } } => {
    const stream = Object.assign(new PassThrough(), { isTTY: true })
    stream.end(input)
    return { input: stream, terminal: { write: () => undefined, isTTY: true } }
  }

  test('with streams that are not terminals it refuses, names the reason, reads nothing and stores nothing', async () => {
    const f = fixture()
    await prepare(f)
    const refused = await run(f, ['judge'], { input: 'a\n', io: { allowNonTerminal: false } })
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('judge_needs_terminal')
    expect(refused.err.join('\n')).toContain('terminal')
    expect(refused.terminal).toBe('')
    expect(existsSync(join(f.privateRoot, 'marks', 'initial', 'judgments'))).toBe(false)
  })

  test('it refuses when only one of the two streams is a terminal', async () => {
    const f = fixture()
    await prepare(f)
    const { input } = tty('a\n')
    const piped = await run(f, ['judge'], { io: { input, terminal: { write: () => undefined }, allowNonTerminal: false } })
    expect(piped.code).toBe(1)
    expect(piped.err.join('\n')).toContain('judge_needs_terminal')
    const { terminal } = tty('')
    const pipedIn = await run(f, ['judge'], { io: { input: new PassThrough(), terminal, allowNonTerminal: false } })
    expect(pipedIn.code).toBe(1)
    expect(pipedIn.err.join('\n')).toContain('judge_needs_terminal')
  })

  test('streams that are terminals pass without the test option', async () => {
    const f = fixture()
    await prepare(f)
    const { input, terminal } = tty('q\n')
    const result = await run(f, ['judge'], { io: { input, terminal, allowNonTerminal: false } })
    expect(result.err).toEqual([])
    expect(result.code).toBe(4)
  })

  test('the option is off by default: a bare call with injected plain streams is refused', async () => {
    const f = fixture()
    await prepare(f)
    const out: string[] = []
    const err: string[] = []
    const code = await main(['judge', ...f.flags], { out: (l) => out.push(l), err: (l) => err.push(l), input: new PassThrough(), terminal: { write: () => undefined }, git: f.repo.git, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('judge_needs_terminal')
  })
})

describe('judge and the gate', () => {
  /** A git handle that counts every call made through it. */
  function counted(git: Fixture['repo']['git']): { git: Fixture['repo']['git']; calls: () => number } {
    let n = 0
    const proxy = new Proxy(git, {
      get(target, prop) {
        const value = Reflect.get(target, prop)
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              n += 1
              return value.apply(target, args)
            }
          : value
      },
    })
    return { git: proxy, calls: () => n }
  }

  test('a session of many judgments runs the git-backed gate once', async () => {
    const f = fixture()
    await prepare(f)
    const gate = counted(f.repo.git)
    assertGate({ git: gate.git })
    const onePass = gate.calls()
    expect(onePass).toBeGreaterThan(0)

    const spy = counted(f.repo.git)
    const judged = await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS, git: spy.git })
    expect(fields(lineOf(judged, 'judge'))).toMatchObject({ proposals_judged: '4', omission_answered: '2' })
    expect(spy.calls()).toBe(onePass)
  })

  test('what a session stored still resumes: the in-memory state matches the log', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: 'a\ns\nq\n' })).code).toBe(4)
    const resumed = await run(f, ['judge'], { input: 'a\ns\n' + OMISSION_ANSWERS })
    expect(resumed.terminal).not.toContain('--- proposal 1 of 4')
    expect(resumed.terminal).not.toContain('--- proposal 2 of 4')
    expect(fields(lineOf(resumed, 'judge'))).toMatchObject({ proposals_judged: '4', ready_to_lock: 'yes' })
  })
})

describe('help and usage', () => {
  const COMMAND_WORDS = ['freeze', 'view', 'label', 'judge', 'lock', 'status', 'count', 'project', 'purge']
  const OPTION_WORDS = ['--slot', '--db', '--private-root', '--repo-root', '--budget', '--context', '--auth-cliproxy', '--help']

  test('--help prints the usage and exits 0 before any private root is opened', async () => {
    const f = fixture()
    const helped = await run(f, ['--help'])
    expect(helped.code).toBe(0)
    expect(helped.err).toEqual([])
    const text = helped.out.join('\n')
    for (const command of COMMAND_WORDS) expect(text).toContain(`  ${command} `)
    for (const option of OPTION_WORDS) expect(text).toContain(option)
    // the defaults, including the real session store
    expect(text).toContain('opencode.db')
    expect(text).toContain('24000')
    expect(text).toContain('initial')
    expect(text).toContain('workflow-loads')
    expect(existsSync(f.privateRoot)).toBe(false)
  })

  test('the usage names every exit code', async () => {
    const f = fixture()
    const text = (await run(f, ['--help'])).out.join('\n')
    for (const line of ['0 ', '1 ', '2 ', '3 ', '4 ']) expect(text).toMatch(new RegExp(`^\\s+${line}`, 'm'))
    expect(text).toContain('items remain')
  })

  test('<command> --help prints the same usage, whatever the gate or the arguments say', async () => {
    const f = fixture()
    const reference = (await run(f, ['--help'])).out.join('\n')
    writeFileSync(join(f.repo.dir, DECLARATION_PATH), '{}\n')
    for (const command of COMMAND_WORDS) {
      const result = await run(f, [command, '--help'])
      expect({ command, code: result.code, text: result.out.join('\n'), err: result.err }).toEqual({ command, code: 0, text: reference, err: [] })
    }
    expect(existsSync(f.privateRoot)).toBe(false)
  })

  test('a usage error prints the same usage with exit 2', async () => {
    const f = fixture()
    const bad = await run(f, ['frobnicate'])
    expect(bad.code).toBe(2)
    expect(bad.err.join('\n')).toContain('opencode.db')
  })

  test('the usage states the known limits plainly', async () => {
    const f = fixture()
    const text = (await run(f, ['--help'])).out.join('\n')
    expect(text).toContain('Known limits')
    for (const limit of ['not anchored outside the private store', 'at the same time on one private root', 'symlinked labeler subdirectory', 'options are accepted by subcommands that ignore them', 'reads the real session store']) expect(text).toContain(limit)
  })
})

describe('judge exit codes', () => {
  test('0 only when every item for the slot is answered', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['judge'], { input: PROPOSAL_ANSWERS + OMISSION_ANSWERS })).code).toBe(0)
  })

  test('4 when it stopped with proposals left, and again with omission items left', async () => {
    const f = fixture()
    await prepare(f)
    const early = await run(f, ['judge'], { input: 'a\nq\n' })
    expect(early.code).toBe(4)
    expect(fields(lineOf(early, 'judge'))).toMatchObject({ ready_to_lock: 'no', stopped: 'yes' })
    const late = await run(f, ['judge'], { input: 's\na\ns\n' })
    expect(late.code).toBe(4)
    expect(fields(lineOf(late, 'judge'))).toMatchObject({ ready_to_lock: 'no' })
  })
})

describe('label resumes with the parameters it was run with', () => {
  const chunkingFile = (f: Fixture): string => join(f.privateRoot, 'marks', 'initial', 'chunking.json')
  const labeledTwice = async (f: Fixture) => {
    await run(f, ['freeze'])
    await run(f, ['view'])
    const first = responder()
    const firstRun = await run(f, ['label', '--budget', '300', '--context', '1'], { label: { transport: first } })
    expect(firstRun.code).toBe(0)
    return { first, chunks: fields(lineOf(firstRun, 'label')).chunks }
  }

  test('without --budget and --context a rerun uses the stored values: the same chunks, resumed, and nothing is sent again', async () => {
    const f = fixture()
    const { first, chunks } = await labeledTwice(f)
    expect(first.requests).toBeGreaterThan(0)
    const stored = readFileSync(chunkingFile(f), 'utf8')
    const again = responder()
    const rerun = await run(f, ['label'], { label: { transport: again } })
    expect(rerun.code).toBe(0)
    expect(fields(lineOf(rerun, 'label'))).toMatchObject({ chunks, calls: '0', coverage: 'complete' })
    expect(again.requests).toBe(0)
    expect(readFileSync(chunkingFile(f), 'utf8')).toBe(stored)
  })

  test('one option given and the other left out: the left-out one is the stored value', async () => {
    const f = fixture()
    const { chunks } = await labeledTwice(f)
    const again = responder()
    const rerun = await run(f, ['label', '--budget', '300'], { label: { transport: again } })
    expect(fields(lineOf(rerun, 'label'))).toMatchObject({ chunks, calls: '0' })
    expect(again.requests).toBe(0)
    const other = await run(f, ['label', '--context', '1'], { label: { transport: again } })
    expect(fields(lineOf(other, 'label'))).toMatchObject({ chunks, calls: '0' })
  })

  test('a value that differs from the stored one is refused while labeler outcomes exist, with nothing sent and the stored values kept', async () => {
    const f = fixture()
    await labeledTwice(f)
    const stored = readFileSync(chunkingFile(f), 'utf8')
    for (const flags of [['--budget', '400'], ['--context', '2'], ['--budget', '400', '--context', '1']]) {
      const transport = responder()
      const refused = await run(f, ['label', ...flags], { label: { transport } })
      expect([flags.join(' '), refused.code]).toEqual([flags.join(' '), 1])
      expect(refused.err.join('\n')).toContain('chunking_changed')
      expect(transport.requests).toBe(0)
    }
    expect(readFileSync(chunkingFile(f), 'utf8')).toBe(stored)
  })

  test('with no stored parameters, or no outcomes, the options are free', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    expect((await run(f, ['label', '--budget', '300', '--context', '1'], { label: { transport: responder() } })).code).toBe(0)
    rmSync(join(f.privateRoot, 'labeler'), { recursive: true, force: true })
    const free = await run(f, ['label', '--budget', '500', '--context', '2'], { label: { transport: responder() } })
    expect(free.code).toBe(0)
    expect(JSON.parse(readFileSync(chunkingFile(f), 'utf8'))).toMatchObject({ budget: 500, contextK: 2 })
  })
})

describe('status reports the labeling coverage', () => {
  const coverageOf = async (f: Fixture) => fields(lineOf(await run(f, ['status']), 'status'))

  test('pending before labeling, then complete with the counts', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    expect(await coverageOf(f)).toMatchObject({ labeling: 'pending', chunks: '0', labeled: '0', failed: '0', not_attempted: '0', spend_cap: 'no', transport_outage: '0' })
    await run(f, ['label'], { label: { transport: responder() } })
    expect(await coverageOf(f)).toMatchObject({ labeling: 'complete', chunks: '2', labeled: '2', failed: '0', not_attempted: '0', spend_cap: 'no', transport_outage: '0' })
  })

  test('chunks that failed are counted, and the labeling is incomplete', async () => {
    const f = fixture()
    await run(f, ['freeze'])
    await run(f, ['view'])
    const garbage: LabelerTransport = { endpoint: ENDPOINT, complete: async () => ({ text: 'not json' }) }
    expect((await run(f, ['label'], { label: { transport: garbage } })).code).toBe(3)
    expect(await coverageOf(f)).toMatchObject({ labeling: 'incomplete', chunks: '2', labeled: '0', failed: '2', not_attempted: '0', spend_cap: 'no' })
  })

  test('a run stopped by the spend cap says so', async () => {
    const f = fixture({ spend_cap_usd: 0.000001 })
    await run(f, ['freeze'])
    await run(f, ['view'])
    expect((await run(f, ['label'], { label: { transport: responder() } })).code).toBe(3)
    expect(await coverageOf(f)).toMatchObject({ labeling: 'incomplete', labeled: '0', not_attempted: '2', spend_cap: 'yes', transport_outage: '0' })
  })

  test('a run stopped by a proxy outage says so, with the chunks it left', async () => {
    const f = fixture({ retry_count: 0 })
    await run(f, ['freeze'])
    await run(f, ['view'])
    const down: LabelerTransport = {
      endpoint: ENDPOINT,
      async complete() {
        throw new Error('proxy down')
      },
    }
    expect((await run(f, ['label', '--budget', '1', '--context', '0'], { label: { transport: down } })).code).toBe(3)
    const status = await coverageOf(f)
    expect(status).toMatchObject({ labeling: 'incomplete', chunks: '6', labeled: '0', failed: '3', not_attempted: '3', spend_cap: 'no', transport_outage: '3' })
  })

  test('no labeling field says done', async () => {
    const f = fixture()
    await prepare(f)
    expect((await run(f, ['status'])).out.join('\n')).not.toContain('labeling=done')
  })
})
