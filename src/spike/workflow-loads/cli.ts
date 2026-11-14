/**
 * `bun run workflow-loads`: the history count's steps before counting. Every step goes through the declaration gate. Status lines
 * hold counts and fixed words, never session text; `judge` is the one place session-derived text is shown, and it goes only to
 * the terminal stream, where the maintainer reads it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { Git } from '../../runner/git'
import { defaultDb } from '../feel-drugs/replay/world-cli'
import { assertOutsideRepo, privateDir, writePrivate } from '../feel-drugs/replay/store'
import { assertGate, type GateInput, MARKING_RULE_PATH, METHODS, type Method } from './declaration'
import { createLabelerTransport, labelChunks, type LabelerTransport, loadLabelerProposals, type Proposal, type ResolveKeyOptions, resolveLabelerKey } from './labeler'
import { collectSkillBodies } from './loads'
import { MarksRefusal, answerOmission, judgeProposal, lockMarks, openMarking, type OmissionAnswer, pendingOmissions, pendingProposals, readLocks, type ProposalChoice, type StimulusRef } from './marks'
import { auditLeaks, buildHiddenView, type Chunk, chunkScope, DEFAULT_CONTEXT, type HiddenView, type LeakKind, renderWithContext, viewPath, writeHiddenView } from './mask'
import { EXCLUSION_REASONS, freezeManifest, MANIFEST_SLOTS, type ManifestSlot, openPrivateRoot, type PrivateRoot, readManifest, walkManifest } from './store'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

/** Characters per labeler chunk when `--budget` is not given. */
export const DEFAULT_BUDGET = 24_000

export interface CliIo {
  /** Status lines: counts and fixed words only. */
  out: (line: string) => void
  /** Refusals and failures: a name and a reason, never session text. */
  err: (line: string) => void
  /** Where `judge` reads the maintainer's answers, one line each. Default: standard input. A closed input counts as `quit`. */
  input?: NodeJS.ReadableStream
  /** Where `judge` shows session text and its prompts. Default: standard output. Nothing else is ever written here. */
  terminal?: { write: (text: string) => unknown }
  /** The repository holding the committed files, when the test supplies a hermetic one. Default: a `Git` over `--repo-root`. */
  git?: Git
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Test seams for `label`: a transport in place of the proxy, or a key resolver in place of the infra CLI. */
  label?: { transport?: LabelerTransport; resolve?: ResolveKeyOptions['resolve'] }
}

const USAGE = [
  'usage: bun run workflow-loads freeze | view | label | judge | lock | status',
  '                              [--slot initial|added] [--db <path>] [--private-root <dir>] [--repo-root <dir>]',
  '       bun run workflow-loads label [--budget <chars>] [--context <n>] [--auth-cliproxy <keyname>]',
  '',
  '  freeze   freeze the manifest of the sample (the added slot needs a recorded session-cap raise)',
  '  view     build the hidden view, audit it for leaks, write it (a failed audit writes nothing and exits 1)',
  '  label    send the view to the labeler in chunks and store its proposals',
  '  judge    judge each proposal, then the omission sample, at the prompt (a quit saves; a rerun resumes)',
  '  lock     lock the slot once every item is judged and answered',
  '  status   counts only',
].join('\n')

class UsageError extends Error {}

/** A step that needs an earlier one. The message is fixed text. */
class StepRefusal extends Error {
  constructor(
    readonly reason: 'view_missing' | 'labeling_not_run',
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'StepRefusal'
  }
}

const COMMANDS = ['freeze', 'view', 'label', 'judge', 'lock', 'status'] as const
type Command = (typeof COMMANDS)[number]

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      slot: { type: 'string' },
      db: { type: 'string' },
      'private-root': { type: 'string' },
      'repo-root': { type: 'string' },
      budget: { type: 'string' },
      context: { type: 'string' },
      'auth-cliproxy': { type: 'string' },
    },
  })
}

function integerOption(value: string | undefined, name: string, min: number, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} takes an integer of at least ${min}`)
  return n
}

interface Ctx {
  git: Git
  repoRoot: string
  privateRoot: PrivateRoot
  db: string
  slot: ManifestSlot
  io: Required<Pick<CliIo, 'out' | 'err'>> & CliIo
  values: ReturnType<typeof parse>['values']
}

/** Exit 0 done, 1 refused or failed (a failed audit included), 2 usage, 3 `label` left chunks unlabeled. */
export async function main(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  try {
    let parsed: ReturnType<typeof parse>
    try {
      parsed = parse(argv)
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : 'bad arguments')
    }
    const [command, ...extra] = parsed.positionals
    if (command === undefined) throw new UsageError('no command given')
    if (!COMMANDS.includes(command as Command)) throw new UsageError(`unknown command ${command}`)
    if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])} for ${command}`)
    const { values } = parsed
    const slot = values.slot ?? 'initial'
    if (!MANIFEST_SLOTS.includes(slot as ManifestSlot)) throw new UsageError(`--slot takes ${MANIFEST_SLOTS.join(' or ')}`)
    const repoRoot = resolve(values['repo-root'] ?? io.git?.repo ?? REPO_ROOT)
    const ctx: Ctx = {
      git: io.git ?? new Git(repoRoot),
      repoRoot,
      privateRoot: openPrivateRoot({ ...(values['private-root'] ? { root: values['private-root'] } : {}), repoRoot, ...(io.env ? { env: io.env } : {}), ...(io.now ? { now: io.now } : {}) }),
      db: resolve(values.db ?? defaultDb()),
      slot: slot as ManifestSlot,
      io: { ...io, out, err },
      values,
    }
    switch (command as Command) {
      case 'freeze':
        return freezeCommand(ctx)
      case 'view':
        return viewCommand(ctx)
      case 'label':
        return await labelCommand(ctx)
      case 'judge':
        return await judgeCommand(ctx)
      case 'lock':
        return lockCommand(ctx)
      case 'status':
        return statusCommand(ctx)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n${USAGE}`)
      return 2
    }
    // Our own errors name fields, rules and reasons, never session text.
    err(e instanceof Error ? `${e.name}: ${e.message}` : 'unexpected error')
    return 1
  }
}

const gateInput = (ctx: Ctx): GateInput => ({ git: ctx.git })
const pairs = (fields: Record<string, string | number>): string => Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')

// ── the stored view and the labeling parameters ────────────────────────────

const viewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  declarationHash: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(
    z.strictObject({
      sessionId: z.string().min(1),
      scopeIndex: z.number().int().nonnegative(),
      workflow: z.enum(['ce:plan', 'ce:review']),
      stimuli: z.array(z.strictObject({ id: z.string().min(1), kind: z.enum(['user_message', 'tool_result']), text: z.string(), traffic: z.array(z.string()) })),
    }),
  ),
  counters: z.strictObject({ scrubbedOutputs: z.number(), scrubbedInputs: z.number(), scrubbedStimuli: z.number(), redactedEmails: z.number() }),
})

/** The slot's stored view, or `undefined` when none was written. A view built under another declaration is refused later, by the marks step. */
function readView(ctx: Ctx): HiddenView | undefined {
  const path = viewPath(ctx.privateRoot, ctx.slot)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('the stored hidden view is not valid JSON')
  }
  const parsed = viewSchema.safeParse(raw)
  if (!parsed.success) throw new Error('the stored hidden view does not have the view shape')
  return parsed.data
}

const chunkingSchema = z.strictObject({ schemaVersion: z.literal(1), budget: z.number().int().positive(), contextK: z.number().int().nonnegative() })
type Chunking = z.infer<typeof chunkingSchema>

const chunkingPath = (ctx: Ctx): string => join(ctx.privateRoot.root, 'marks', ctx.slot, 'chunking.json')

/**
 * How the last `label` run cut the view. Stored so `judge` and `status` rebuild the same chunks without being told, because the
 * stored proposals are found by chunk: a different cut would find none, and the whole view would look unproposed.
 */
function readChunking(ctx: Ctx): Chunking | undefined {
  const path = chunkingPath(ctx)
  if (!existsSync(path)) return undefined
  try {
    return chunkingSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    throw new Error('the stored chunking parameters are unreadable')
  }
}

function writeChunking(ctx: Ctx, chunking: Chunking): void {
  assertOutsideRepo(ctx.privateRoot.root, ctx.repoRoot)
  privateDir(ctx.privateRoot.root)
  privateDir(join(ctx.privateRoot.root, 'marks'))
  privateDir(join(ctx.privateRoot.root, 'marks', ctx.slot))
  writePrivate(chunkingPath(ctx), `${JSON.stringify(chunking, null, 2)}\n`)
}

const chunksOf = (view: HiddenView, chunking: Chunking): Chunk[] => view.scopes.flatMap((scope) => chunkScope(scope, { budget: chunking.budget, contextK: chunking.contextK }))

interface Loaded {
  declarationHash: string
  view: HiddenView
  chunking: Chunking
  proposals: Proposal[]
}

/** The gate, the view, the labeling parameters and the stored proposals, or a refusal naming the step that is missing. */
function load(ctx: Ctx): Loaded {
  const pass = assertGate(gateInput(ctx))
  const view = readView(ctx)
  if (!view) throw new StepRefusal('view_missing', 'build the view first')
  const chunking = readChunking(ctx)
  if (!chunking) throw new StepRefusal('labeling_not_run', 'label the view first')
  return { declarationHash: pass.declarationHash, view, chunking, proposals: loadLabelerProposals(ctx.privateRoot, chunksOf(view, chunking), pass.declarationHash) }
}

const markingInput = (ctx: Ctx, loaded: Loaded) => ({ git: ctx.git, privateRoot: ctx.privateRoot, slot: ctx.slot, proposals: loaded.proposals, view: loaded.view, repoRoot: ctx.repoRoot })

// ── freeze, view, label ────────────────────────────────────────────────────

function freezeCommand(ctx: Ctx): number {
  const { manifest, created } = freezeManifest({ ...gateInput(ctx), db: ctx.db, privateRoot: ctx.privateRoot, slot: ctx.slot })
  ctx.io.out(
    `${created ? 'frozen' : 'exists'} ${pairs({
      slot: ctx.slot,
      sessions: manifest.sessions.length,
      considered: manifest.considered,
      eligible: manifest.eligible,
      cap: manifest.session_cap,
      ...Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, manifest.exclusions[reason]])),
    })}`,
  )
  return 0
}

function viewCommand(ctx: Ctx): number {
  const pass = assertGate(gateInput(ctx))
  const skillBodies = collectSkillBodies(ctx.git, pass.declaration.window)
  const sessions = walkManifest({ ...gateInput(ctx), db: ctx.db, privateRoot: ctx.privateRoot, slot: ctx.slot, skillBodies })
  const audit = auditLeaks(sessions)
  const hits = (kind: LeakKind): number => audit.hits.filter((hit) => hit.kind === kind).length
  const leaks = { method: hits('method'), helper: hits('helper'), label: hits('label') }
  const stimuli = sessions.reduce((sum, s) => sum + s.scopes.reduce((n, scope) => n + scope.stimuli.length, 0), 0)
  if (!audit.ok) {
    // a view that fails its audit is never written: the labeler would be sent what the audit just found
    ctx.io.out(`view ${pairs({ slot: ctx.slot, sessions: sessions.length, stimuli, audit: 'fail', ...leaks, written: 'no' })}`)
    return 1
  }
  const view = buildHiddenView({ ...gateInput(ctx), sessions })
  writeHiddenView(ctx.privateRoot, view, { slot: ctx.slot, repoRoot: ctx.repoRoot })
  const { counters } = view
  ctx.io.out(
    `view ${pairs({
      slot: ctx.slot,
      sessions: sessions.length,
      scopes: view.scopes.length,
      stimuli,
      scrubbed_outputs: counters.scrubbedOutputs,
      scrubbed_inputs: counters.scrubbedInputs,
      scrubbed_stimuli: counters.scrubbedStimuli,
      redacted_emails: counters.redactedEmails,
      audit: 'pass',
      ...leaks,
      written: 'yes',
    })}`,
  )
  return 0
}

async function labelCommand(ctx: Ctx): Promise<number> {
  const budget = integerOption(ctx.values.budget, 'budget', 1, DEFAULT_BUDGET)
  const contextK = integerOption(ctx.values.context, 'context', 0, DEFAULT_CONTEXT)
  const pass = assertGate(gateInput(ctx))
  const view = readView(ctx)
  if (!view) throw new StepRefusal('view_missing', 'build the view first')
  const chunking: Chunking = { schemaVersion: 1, budget, contextK }
  const transport =
    ctx.io.label?.transport ??
    createLabelerTransport({
      declaration: pass.declaration,
      key: resolveLabelerKey({ ...(ctx.values['auth-cliproxy'] ? { keyName: ctx.values['auth-cliproxy'] } : {}), env: ctx.io.env ?? process.env, ...(ctx.io.label?.resolve ? { resolve: ctx.io.label.resolve } : {}) }),
    })
  const run = await labelChunks({ ...gateInput(ctx), privateRoot: ctx.privateRoot, chunks: chunksOf(view, chunking), ruleText: readFileSync(join(ctx.repoRoot, MARKING_RULE_PATH), 'utf8'), transport, repoRoot: ctx.repoRoot })
  // recorded once the run returns, so an interrupted run leaves the earlier parameters, which still match the earlier outcomes
  writeChunking(ctx, chunking)
  const { totals } = run
  ctx.io.out(
    `label ${pairs({
      slot: ctx.slot,
      chunks: totals.chunks,
      calls: totals.calls,
      labeled: totals.labeled,
      failed: totals.failed,
      not_attempted: totals.notAttempted,
      proposals: totals.proposals,
      discarded: totals.discarded,
      spend_usd: totals.spendUsd,
      coverage: run.coverageComplete ? 'complete' : 'incomplete',
    })}`,
  )
  return run.coverageComplete ? 0 : 3
}

// ── judge ──────────────────────────────────────────────────────────────────

type Terminal = NonNullable<CliIo['terminal']>

/** Reads the maintainer's answers one line at a time. A closed input ends as `null`. */
function lineReader(input: NodeJS.ReadableStream): { next: () => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  const lines = rl[Symbol.asyncIterator]()
  return {
    async next() {
      const step = await lines.next()
      return step.done ? null : step.value
    },
    close: () => rl.close(),
  }
}

/** Asks until the answer is one of the table's keys or words; the end of the input is a quit. */
async function choose<T>(reader: ReturnType<typeof lineReader>, terminal: Terminal, prompt: string, table: Readonly<Record<string, T>>): Promise<T | 'quit'> {
  for (;;) {
    terminal.write(prompt)
    const line = await reader.next()
    if (line === null) {
      terminal.write('\n')
      return 'quit'
    }
    const key = line.trim().toLowerCase()
    if (key === 'q' || key === 'quit') return 'quit'
    if (Object.hasOwn(table, key)) return table[key] as T
    terminal.write('? ')
  }
}

const SINGLE_CHOICES: Readonly<Record<string, ProposalChoice>> = { a: { action: 'accept' }, accept: { action: 'accept' }, r: { action: 'reject' }, reject: { action: 'reject' }, l: { action: 'relabel' }, relabel: { action: 'relabel' } }
const BOTH_CHOICES: Readonly<Record<string, ProposalChoice>> = {
  f: { action: 'pick', label: 'expected_fire' },
  fire: { action: 'pick', label: 'expected_fire' },
  s: { action: 'pick', label: 'expected_silence' },
  silence: { action: 'pick', label: 'expected_silence' },
  r: { action: 'reject' },
  reject: { action: 'reject' },
}
const OMISSION_CHOICES: Readonly<Record<string, OmissionAnswer>> = { f: 'expected_fire', fire: 'expected_fire', s: 'expected_silence', silence: 'expected_silence', n: 'neither', neither: 'neither' }

async function judgeCommand(ctx: Ctx): Promise<number> {
  const loaded = load(ctx)
  const input = markingInput(ctx, loaded)
  const opened = openMarking(input)
  if (opened.lock) throw new MarksRefusal('slot_locked')
  const terminal: Terminal = ctx.io.terminal ?? process.stdout
  const reader = lineReader(ctx.io.input ?? process.stdin)
  const contextK = loaded.chunking.contextK

  /** The stimulus with its preceding stimuli, as the labeler saw it. */
  const show = (ref: StimulusRef): void => {
    const scope = loaded.view.scopes.find((s) => s.sessionId === ref.sessionId && s.scopeIndex === ref.scopeIndex)
    const index = scope?.stimuli.findIndex((s) => s.id === ref.stimulusId) ?? -1
    if (!scope || index < 0) throw new Error('an item names a stimulus the view does not hold')
    terminal.write(`${renderWithContext(scope.stimuli, index, contextK)}\n\n`)
  }

  let stopped = false
  try {
    const items = opened.items
    for (const item of pendingProposals(opened)) {
      terminal.write(`\n--- proposal ${items.indexOf(item) + 1} of ${items.length}\n`)
      show(item)
      // The judge sees the method and label proposed: that is the question being put, and it is shown on these lines only.
      for (const entry of item.proposed) terminal.write(`proposal: ${item.method} · ${entry.label} · ${entry.reason}\n`)
      const both = item.proposed.length === 2
      const choice = await choose<ProposalChoice>(reader, terminal, both ? '[f] expected_fire  [s] expected_silence  [r]eject  [q]uit > ' : '[a]ccept  [r]eject  re[l]abel  [q]uit > ', both ? BOTH_CHOICES : SINGLE_CHOICES)
      if (choice === 'quit') {
        stopped = true
        break
      }
      judgeProposal(input, item, choice)
    }
    if (!stopped) {
      const sample = opened.sample
      for (const ref of pendingOmissions(openMarking(input))) {
        terminal.write(`\n--- omission ${sample.findIndex((s) => s.sessionId === ref.sessionId && s.scopeIndex === ref.scopeIndex && s.stimulusId === ref.stimulusId) + 1} of ${sample.length}\n`)
        show(ref)
        const answers: Partial<Record<Method, OmissionAnswer>> = {}
        for (const method of METHODS) {
          const answer = await choose<OmissionAnswer>(reader, terminal, `${method}: [f] expected_fire  [s] expected_silence  [n] neither  [q]uit > `, OMISSION_CHOICES)
          if (answer === 'quit') {
            stopped = true
            break
          }
          answers[method] = answer
        }
        if (stopped) break
        // one answer per method, stored together: a quit part-way through a stimulus stores nothing for it
        answerOmission(input, ref, Object.fromEntries(METHODS.map((method) => [method, answers[method] ?? 'neither'])) as Record<Method, OmissionAnswer>)
      }
    }
  } finally {
    reader.close()
  }
  const after = openMarking(input)
  const pendingNow = pendingProposals(after).length + pendingOmissions(after).length
  ctx.io.out(
    `judge ${pairs({
      slot: ctx.slot,
      proposals_judged: after.judgments.size,
      proposals_total: after.items.length,
      omission_answered: after.answers.size,
      omission_total: after.sample.length,
      ready_to_lock: pendingNow === 0 ? 'yes' : 'no',
      stopped: stopped ? 'yes' : 'no',
    })}`,
  )
  return 0
}

// ── lock and status ────────────────────────────────────────────────────────

function lockCommand(ctx: Ctx): number {
  const loaded = load(ctx)
  const lock = lockMarks(markingInput(ctx, loaded))
  const fromProposals = lock.marks.filter((mark) => mark.source === 'proposal').length
  ctx.io.out(
    `locked ${pairs({
      slot: ctx.slot,
      marks: lock.marks.length,
      proposal_marks: fromProposals,
      omission_marks: lock.marks.length - fromProposals,
      omission_sample: lock.omissionSampleSize,
      omissions: lock.omissionsFound,
      lock_hash: lock.lockHash.slice(0, 12),
    })}`,
  )
  return 0
}

function statusCommand(ctx: Ctx): number {
  const pass = assertGate(gateInput(ctx))
  const manifest = readManifest(ctx.privateRoot, ctx.slot, pass.declarationHash)
  const view = readView(ctx)
  const chunking = readChunking(ctx)
  const locks = readLocks(ctx.privateRoot, pass.declarationHash)
  const counts = { proposals: 0, items: 0, judged: 0, omission_sample: 0, omission_answered: 0 }
  if (view && chunking) {
    const proposals = loadLabelerProposals(ctx.privateRoot, chunksOf(view, chunking), pass.declarationHash)
    const marking = openMarking({ ...markingInput(ctx, { declarationHash: pass.declarationHash, view, chunking, proposals }) })
    counts.items = marking.items.length
    counts.proposals = marking.items.reduce((sum, item) => sum + item.proposed.length, 0)
    counts.judged = marking.judgments.size
    counts.omission_sample = marking.sample.length
    counts.omission_answered = marking.answers.size
  }
  ctx.io.out(
    `status ${pairs({
      slot: ctx.slot,
      manifest: manifest ? 'present' : 'absent',
      sessions: manifest?.sessions.length ?? 0,
      view: view ? 'present' : 'absent',
      stimuli: view?.scopes.reduce((sum, scope) => sum + scope.stimuli.length, 0) ?? 0,
      labeling: chunking ? 'done' : 'pending',
      ...counts,
      locked: locks.some((lock) => lock.slot === ctx.slot) ? 'yes' : 'no',
      locks: locks.length,
    })}`,
  )
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
