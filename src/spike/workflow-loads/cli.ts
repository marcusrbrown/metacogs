/**
 * `bun run workflow-loads`: the history count's steps, from freezing the sample to purging the private views. Every step goes
 * through the declaration gate. Status lines hold counts and fixed words, never session text; `judge` is the one place
 * session-derived text is shown, and it goes only to the terminal stream, where the maintainer reads it.
 *
 * The usage text (`--help`) is the reference for every command, option, default and exit code, and ends with the known limits.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { Git } from '../../runner/git'
import { defaultDb } from '../feel-drugs/replay/world-cli'
import { assertOutsideRepo, privateDir, writePrivate } from '../feel-drugs/replay/store'
import { type CountReport, runCount, type SlotLabeling } from './count'
import { assertGate, type GateInput, type GatePass, MARKING_RULE_PATH, METHODS, type Method } from './declaration'
import { createLabelerTransport, deleteLabelerReplies, LABELER_DIR, labelChunks, labelingCoverage, type LabelerTransport, loadLabelerProposals, type Proposal, type ResolveKeyOptions, resolveLabelerKey } from './labeler'
import { collectSkillBodies } from './loads'
import { assertJudgingNotStarted, lockMarks, MarksRefusal, openJudging, openMarking, type OmissionAnswer, pendingOmissions, pendingProposals, type ProposalChoice, readLocks, requireLocks, type StimulusRef } from './marks'
import { auditRendered, buildHiddenView, type Chunk, chunkScope, DEFAULT_CONTEXT, deleteHiddenViews, type HiddenView, type LeakKind, renderForChunk, renderWithContext, viewPath, writeHiddenView } from './mask'
import { COUNTS_PATH, projectCounts, renderProjection, writeProjection } from './project'
import { EXCLUSION_REASONS, freezeManifest, MANIFEST_SLOTS, type ManifestSlot, openPrivateRoot, type PrivateRoot, readManifest, type WalkedSession, walkManifestEach } from './store'

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
  terminal?: { write: (text: string) => unknown; isTTY?: boolean }
  /**
   * Test seam: lets `judge` run on streams that are not terminals. Without it `judge` refuses unless both its input and its output
   * stream are terminals, injected streams included, so session text is never piped anywhere by accident.
   */
  allowNonTerminal?: boolean
  /** The repository holding the committed files, when the test supplies a hermetic one. Default: a `Git` over `--repo-root`. */
  git?: Git
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Test seams for `label`: a transport in place of the proxy, or a key resolver in place of the infra CLI. */
  label?: { transport?: LabelerTransport; resolve?: ResolveKeyOptions['resolve'] }
}

const USAGE = [
  'usage: bun run workflow-loads <command> [options]',
  '       bun run workflow-loads --help          (or: <command> --help) print this text and exit 0',
  '',
  'commands:',
  '  freeze   freeze the manifest of the sample: the sessions that hold a workflow load, each with a content hash of the rows the later',
  '           steps read; a session whose last message was still unfinished is left out (the added slot needs a recorded session-cap raise)',
  '  view     build the hidden view, audit it for leaks, write it (a failed audit writes nothing and exits 1; refused once a judgment, an',
  '           omission answer or a lock is stored for the slot)',
  '  label    send the view to the labeler in chunks and store its proposals (stops at the spend cap or after repeated proxy failures and',
  '           exits 3; refused once judging has started)',
  '  judge    judge each proposal, then the omission sample, at the prompt (a quit saves; a rerun resumes); needs a terminal on both',
  '           standard input and standard output',
  '  lock     lock the slot once every item is judged and answered',
  '  status   counts only, including the labeling coverage: chunks labeled, failed and not attempted, and whether the spend cap or a proxy outage stopped a run',
  '  count    count loads against the locked marks of every slot and print the outcome (needs every frozen slot locked and its stored view',
  '           unchanged since it was judged)',
  '  project  write evals/spikes/workflow-loads/counts.json and print the counts table (counts only; needs the views, as count does)',
  '  purge    delete the hidden views and the raw labeler replies; manifests, outcomes, judgments and locks stay',
  '',
  'options (every command accepts all of them; a command that has no use for one ignores it):',
  '  --slot initial|added     the slot to work on (default: initial); count, project and purge cover every slot whatever this says',
  '  --db <path>              the OpenCode session store to read (default: ~/.local/share/opencode/opencode.db, the real store)',
  '  --private-root <dir>     where the manifests, views, labeler records, judgments and locks are kept (default:',
  '                           $XDG_STATE_HOME/metacogs/workflow-loads, or ~/.local/state/metacogs/workflow-loads); refused inside the repository',
  '  --repo-root <dir>        the repository holding the committed declaration, marking rule and deviations (default: this repository)',
  `  --budget <chars>         label: characters per labeler chunk (default: ${DEFAULT_BUDGET}, or the value the slot was labeled with)`,
  `  --context <n>            label: stimuli of context before a chunk's first stimulus (default: ${DEFAULT_CONTEXT}, or the value the slot was labeled with)`,
  '                           a value that differs from the one the slot was labeled with is refused once labeler outcomes exist',
  '  --auth-cliproxy <name>   label: the CLIProxy key name (default: the METACOGS_AUTH_CLIPROXY environment variable)',
  '  --help, -h               print this text and exit 0, before anything is opened',
  '',
  'exit codes:',
  '  0  done (judge: every item for the slot is answered; label: every chunk labeled; --help)',
  '  1  refused or failed (a failed gate, a step that needs an earlier one, a changed view, a failed leak audit)',
  '  2  usage error',
  '  3  label finished with chunks unlabeled (a failed chunk, the spend cap or a proxy outage)',
  '  4  judge stopped with items remaining to judge or answer',
  '',
  'Known limits:',
  '  - manifest and lock hashes are not anchored outside the private store, so a deliberate edit that recomputes them passes',
  '  - two commands run at the same time on one private root can overwrite each other\'s record',
  '  - a symlinked labeler subdirectory is not checked',
  '  - options are accepted by subcommands that ignore them',
  '  - a bare command reads the real session store by default (see --db)',
].join('\n')

class UsageError extends Error {}

/** A step that needs an earlier one. The message is fixed text. */
class StepRefusal extends Error {
  constructor(
    readonly reason: 'view_missing' | 'labeling_not_run' | 'judge_needs_terminal' | 'chunking_changed',
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'StepRefusal'
  }
}

const COMMANDS = ['freeze', 'view', 'label', 'judge', 'lock', 'status', 'count', 'project', 'purge'] as const
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
      help: { type: 'boolean', short: 'h' },
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

/** Exit 0 done, 1 refused or failed (a failed audit included), 2 usage, 3 `label` left chunks unlabeled, 4 `judge` stopped with items left. */
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
    // help comes first: nothing is opened, read or checked for it
    if (parsed.values.help) {
      out(USAGE)
      return 0
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
      case 'count':
        return countCommand(ctx)
      case 'project':
        return projectCommand(ctx)
      case 'purge':
        return purgeCommand(ctx)
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

/** Any labeler outcome is stored under the private root. */
function holdsLabelerOutcomes(ctx: Ctx): boolean {
  const dir = join(ctx.privateRoot.root, LABELER_DIR, 'outcomes')
  return existsSync(dir) && readdirSync(dir).length > 0
}

const chunksOf = (view: HiddenView, chunking: Chunking): Chunk[] => view.scopes.flatMap((scope) => chunkScope(scope, { budget: chunking.budget, contextK: chunking.contextK }))

/**
 * What the view and labeling steps left for the slot: the stored view, how it was cut, the chunks that cut gives and the proposals
 * stored for them. Each part is absent until its step has run. `status`, `load` and the counting steps all read it, so they cannot
 * disagree about which chunks are current.
 */
interface Labeling {
  view: HiddenView | undefined
  chunking: Chunking | undefined
  chunks: Chunk[]
  proposals: Proposal[]
}

function readLabeling(ctx: Ctx, declarationHash: string, view: HiddenView | undefined = readView(ctx)): Labeling {
  const chunking = readChunking(ctx)
  const chunks = view && chunking ? chunksOf(view, chunking) : []
  return { view, chunking, chunks, proposals: view && chunking ? loadLabelerProposals(ctx.privateRoot, chunks, declarationHash) : [] }
}

interface Loaded {
  /** The one gate check of the command; the marking steps reuse it. */
  pass: GatePass
  declarationHash: string
  view: HiddenView
  chunking: Chunking
  proposals: Proposal[]
}

/** The gate, the view, the labeling parameters and the stored proposals, or a refusal naming the step that is missing. */
function load(ctx: Ctx): Loaded {
  const pass = assertGate(gateInput(ctx))
  const { view, chunking, proposals } = readLabeling(ctx, pass.declarationHash)
  if (!view) throw new StepRefusal('view_missing', 'build the view first')
  if (!chunking) throw new StepRefusal('labeling_not_run', 'label the view first')
  return { pass, declarationHash: pass.declarationHash, view, chunking, proposals }
}

const markingInput = (ctx: Ctx, loaded: Loaded) => ({ git: ctx.git, pass: loaded.pass, privateRoot: ctx.privateRoot, slot: ctx.slot, proposals: loaded.proposals, view: loaded.view, repoRoot: ctx.repoRoot })

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
  // a rebuilt view could differ from the one the judgments were made on
  assertJudgingNotStarted(ctx.privateRoot, ctx.slot)
  const skillBodies = collectSkillBodies(ctx.git, pass.declaration.window)
  // the walk is read once, a session at a time: its raw rows are rendered and dropped before the next session is read
  let sessionCount = 0
  let stimuli = 0
  function* tallied(sessions: Iterable<WalkedSession>): Generator<WalkedSession> {
    for (const session of sessions) {
      sessionCount += 1
      stimuli += session.scopes.reduce((n, scope) => n + scope.stimuli.length, 0)
      yield session
    }
  }
  const view = buildHiddenView({ ...gateInput(ctx), sessions: tallied(walkManifestEach({ ...gateInput(ctx), db: ctx.db, privateRoot: ctx.privateRoot, slot: ctx.slot, skillBodies })) })
  const audit = auditRendered(view.scopes)
  const hits = (kind: LeakKind): number => audit.hits.filter((hit) => hit.kind === kind).length
  const leaks = { method: hits('method'), helper: hits('helper'), label: hits('label') }
  if (!audit.ok) {
    // a view that fails its audit is never written: the labeler would be sent what the audit just found
    ctx.io.out(`view ${pairs({ slot: ctx.slot, sessions: sessionCount, stimuli, audit: 'fail', ...leaks, written: 'no' })}`)
    return 1
  }
  writeHiddenView(ctx.privateRoot, view, { slot: ctx.slot, repoRoot: ctx.repoRoot })
  const { counters } = view
  ctx.io.out(
    `view ${pairs({
      slot: ctx.slot,
      sessions: sessionCount,
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
  // an option left out keeps the value the slot was labeled with: the stored outcomes are found by chunk, and a different cut finds none
  const stored = readChunking(ctx)
  const budget = integerOption(ctx.values.budget, 'budget', 1, stored?.budget ?? DEFAULT_BUDGET)
  const contextK = integerOption(ctx.values.context, 'context', 0, stored?.contextK ?? DEFAULT_CONTEXT)
  const pass = assertGate(gateInput(ctx))
  // labeling again would change the proposals, and with them the omission sample, after judging began
  assertJudgingNotStarted(ctx.privateRoot, ctx.slot)
  const view = readView(ctx)
  if (!view) throw new StepRefusal('view_missing', 'build the view first')
  if (stored && (stored.budget !== budget || stored.contextK !== contextK) && holdsLabelerOutcomes(ctx)) {
    // a new cut would start every chunk over and send the whole view again
    throw new StepRefusal('chunking_changed', `this slot was labeled with --budget ${stored.budget} --context ${stored.contextK}; leave the options out or give those values`)
  }
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

// Escape sequences, longest first: a string sequence (OSC, DCS, APC, PM, SOS) to its terminator or the end of the line, then CSI,
// then any other two-character escape. The 8-bit forms of OSC and CSI are included.
const ESCAPE_SEQUENCES = /\u001b[\]PX^_][^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?|[\u009d\u0090\u0098\u009e\u009f][^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -~]/g

/**
 * Text that came from a session or from the labeler, made safe to write to a terminal: escape sequences are removed whole, and any
 * other control character but newline and tab is shown as caret notation (a carriage return as `^M`) instead of acting. Every
 * `judge` write of such text goes through here.
 */
export function terminalSafe(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => `^${String.fromCharCode((c.charCodeAt(0) + 64) % 128)}`).replace(/[\u0080-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`)
}

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

const isTerminal = (stream: unknown): boolean => typeof stream === 'object' && stream !== null && (stream as { isTTY?: unknown }).isTTY === true

async function judgeCommand(ctx: Ctx): Promise<number> {
  const input = ctx.io.input ?? process.stdin
  const terminal: Terminal = ctx.io.terminal ?? process.stdout
  // session text goes to the terminal stream only: with a pipe on either side it could land in a file or another program
  if (!ctx.io.allowNonTerminal && !(isTerminal(input) && isTerminal(terminal))) throw new StepRefusal('judge_needs_terminal', 'run judge in a terminal; it shows session text on the screen and reads your answers from the keyboard')
  const loaded = load(ctx)
  // one gate check and one read of the stored judgments for the whole session; each write updates this state in memory
  const session = openJudging(markingInput(ctx, loaded))
  const { marking } = session
  if (marking.lock) throw new MarksRefusal('slot_locked')
  const reader = lineReader(input)
  const contextK = loaded.chunking.contextK
  const chunks = chunksOf(loaded.view, loaded.chunking)

  /**
   * The stimulus with its preceding stimuli. A proposal is shown with the context of the chunk that carried it, which the budget may
   * have trimmed, so the judge sees what the labeler saw; an omission stimulus carried no proposal and gets the configured context.
   */
  const show = (ref: StimulusRef, proposed: boolean): void => {
    const scope = loaded.view.scopes.find((s) => s.sessionId === ref.sessionId && s.scopeIndex === ref.scopeIndex)
    const index = scope?.stimuli.findIndex((s) => s.id === ref.stimulusId) ?? -1
    if (!scope || index < 0) throw new Error('an item names a stimulus the view does not hold')
    const chunk = proposed ? chunks.find((c) => c.sessionId === ref.sessionId && c.scopeIndex === ref.scopeIndex && c.ids.includes(ref.stimulusId)) : undefined
    terminal.write(`${terminalSafe(chunk ? renderForChunk(scope.stimuli, chunk, ref.stimulusId) : renderWithContext(scope.stimuli, index, contextK))}\n\n`)
  }

  let stopped = false
  try {
    const items = marking.items
    for (const item of pendingProposals(marking)) {
      terminal.write(`\n--- proposal ${items.indexOf(item) + 1} of ${items.length}\n`)
      show(item, true)
      // The judge sees the method and label proposed: that is the question being put, and it is shown on these lines only.
      for (const entry of item.proposed) terminal.write(`proposal: ${item.method} · ${entry.label} · ${terminalSafe(entry.reason)}\n`)
      const both = item.proposed.length === 2
      const choice = await choose<ProposalChoice>(reader, terminal, both ? '[f] expected_fire  [s] expected_silence  [r]eject  [q]uit > ' : '[a]ccept  [r]eject  re[l]abel  [q]uit > ', both ? BOTH_CHOICES : SINGLE_CHOICES)
      if (choice === 'quit') {
        stopped = true
        break
      }
      session.judge(item, choice)
    }
    if (!stopped) {
      const sample = marking.sample
      for (const ref of pendingOmissions(marking)) {
        terminal.write(`\n--- omission ${sample.findIndex((s) => s.sessionId === ref.sessionId && s.scopeIndex === ref.scopeIndex && s.stimulusId === ref.stimulusId) + 1} of ${sample.length}\n`)
        show(ref, false)
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
        session.answer(ref, Object.fromEntries(METHODS.map((method) => [method, answers[method] ?? 'neither'])) as Record<Method, OmissionAnswer>)
      }
    }
  } finally {
    reader.close()
  }
  const pendingNow = pendingProposals(marking).length + pendingOmissions(marking).length
  ctx.io.out(
    `judge ${pairs({
      slot: ctx.slot,
      proposals_judged: marking.judgments.size,
      proposals_total: marking.items.length,
      omission_answered: marking.answers.size,
      omission_total: marking.sample.length,
      ready_to_lock: pendingNow === 0 ? 'yes' : 'no',
      stopped: stopped ? 'yes' : 'no',
    })}`,
  )
  // 4: stopped with items left, so a script can tell a finished session from a saved one
  return pendingNow === 0 ? 0 : 4
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
  const { view, chunking, proposals } = readLabeling(ctx, pass.declarationHash)
  const locks = readLocks(ctx.privateRoot, pass.declarationHash)
  const counts = { proposals: 0, items: 0, judged: 0, omission_sample: 0, omission_answered: 0 }
  const coverage = { chunks: 0, labeled: 0, failed: 0, not_attempted: 0, spend_cap: 'no', transport_outage: 0 }
  if (view && chunking) {
    const found = labelingCoverage(ctx.privateRoot, chunksOf(view, chunking), pass.declarationHash)
    Object.assign(coverage, { chunks: found.chunks, labeled: found.labeled, failed: found.failed, not_attempted: found.notAttempted, spend_cap: found.spendCapReached ? 'yes' : 'no', transport_outage: found.transportOutage })
    const marking = openMarking({ ...markingInput(ctx, { pass, declarationHash: pass.declarationHash, view, chunking, proposals }) })
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
      // the real coverage, not whether a run happened: a run that stopped early leaves chunks unlabeled
      labeling: !chunking ? 'pending' : coverage.chunks > 0 && coverage.labeled === coverage.chunks ? 'complete' : 'incomplete',
      ...coverage,
      ...counts,
      locked: locks.some((lock) => lock.slot === ctx.slot) ? 'yes' : 'no',
      locks: locks.length,
    })}`,
  )
  return 0
}

// ── count, project, purge ──────────────────────────────────────────────────

/**
 * The count over every locked slot, whatever `--slot` says. Each locked slot needs its stored view and labeling cut: its chunks
 * give the labeling coverage, and its view the scrub counters. Refused with `view_missing` or `labeling_not_run` otherwise, which
 * is why `purge` comes last.
 */
function countReport(ctx: Ctx): CountReport {
  const pass = assertGate(gateInput(ctx))
  const labeling: Partial<Record<ManifestSlot, SlotLabeling>> = {}
  // the marks were judged on the stored views: a view that changed since is refused before anything is counted
  const views: Partial<Record<ManifestSlot, HiddenView>> = {}
  for (const slot of MANIFEST_SLOTS) {
    const view = readView({ ...ctx, slot })
    if (view) views[slot] = view
  }
  for (const lock of requireLocks(ctx.privateRoot, pass.declarationHash, views)) {
    const slotCtx: Ctx = { ...ctx, slot: lock.slot }
    const { view, chunking, chunks } = readLabeling(slotCtx, pass.declarationHash, views[lock.slot])
    if (!view) throw new StepRefusal('view_missing', `the ${lock.slot} view is not stored; counting reads its coverage and scrub counters`)
    if (!chunking) throw new StepRefusal('labeling_not_run', `the ${lock.slot} view was not labeled`)
    if (view.declarationHash !== pass.declarationHash) throw new MarksRefusal('view_declaration_mismatch')
    labeling[lock.slot] = { coverage: labelingCoverage(ctx.privateRoot, chunks, pass.declarationHash), counters: view.counters }
  }
  return runCount({ ...gateInput(ctx), db: ctx.db, privateRoot: ctx.privateRoot, skillBodies: collectSkillBodies(ctx.git, pass.declaration.window), labeling })
}

function countCommand(ctx: Ctx): number {
  const report = countReport(ctx)
  const { counts, coverage, sample, omissions } = report
  ctx.io.out(
    `count ${pairs({
      outcome: report.outcome,
      notes: report.notes.length > 0 ? report.notes.join(',') : 'none',
      slots: report.slots.length,
      sampled: sample.sampled,
      stimuli: counts.stimuli,
      chunks: coverage.chunks,
      failed: coverage.failed,
      not_attempted: coverage.notAttempted,
      omission_sample: omissions.sampleSize,
      omissions: omissions.found,
    })}`,
  )
  for (const method of METHODS) {
    const m = counts.methods[method]
    ctx.io.out(
      `${method} ${pairs({
        fire_marks: m.accepted.expected_fire,
        hit: m.buckets.hit,
        miss: m.buckets.miss,
        loaded_earlier: m.buckets.loaded_earlier,
        silence_marks: m.accepted.expected_silence,
        false_fire: m.buckets.false_fire,
        correct_silence: m.buckets.correct_silence,
        hits_skill_call: m.hitsByBasis.skill_call,
        hits_direct_read: m.hitsByBasis.direct_read,
        unmarked_loads: m.unmarkedLoads,
      })}`,
    )
  }
  return 0
}

/** Writes the projection into the repository's spike directory and prints the table. The leak scan runs before anything is written. */
function projectCommand(ctx: Ctx): number {
  const projection = projectCounts(countReport(ctx))
  const { table } = renderProjection(projection)
  writeProjection(join(ctx.repoRoot, COUNTS_PATH), projection)
  ctx.io.out(`projected ${pairs({ file: COUNTS_PATH, outcome: projection.outcome, notes: projection.coverage_notes.length > 0 ? projection.coverage_notes.join(',') : 'none' })}`)
  ctx.io.out(table)
  return 0
}

/** Deletes the hidden views and the raw labeler replies, once every frozen slot is locked. Manifests, outcomes, judgments and locks stay. */
function purgeCommand(ctx: Ctx): number {
  const pass = assertGate(gateInput(ctx))
  requireLocks(ctx.privateRoot, pass.declarationHash)
  ctx.io.out(`purged ${pairs({ views: deleteHiddenViews(ctx.privateRoot), replies: deleteLabelerReplies(ctx.privateRoot) })}`)
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
