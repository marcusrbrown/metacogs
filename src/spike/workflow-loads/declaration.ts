/**
 * The history count's fixed rules: the declaration (every value the count is bound to), the marking-rule file it hashes, an
 * append-only deviations file, and the one gate every data step calls before it reads or writes anything.
 *
 * The declaration is committed before any view is built and is never edited. A later change is a deviation: a fixed code and a
 * short reason, appended to a hash-chained file. Appending never touches the declaration, so its hash, and every artifact bound to
 * that hash, stays valid.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { z } from 'zod'

import { canonicalize } from '../../record/canonical'
import type { Git } from '../../runner/git'
import { canonicalizeText, preregCommitViolation, saltedHash } from '../../runner/prereg'
import { sha256 } from '../../runner/workspace'

// ── where the committed files live ─────────────────────────────────────────

export const WORKFLOW_LOADS_DIR = 'evals/spikes/workflow-loads'
/** Repo-relative default paths; every step takes them from here. */
export const DECLARATION_PATH = `${WORKFLOW_LOADS_DIR}/declaration.json`
export const MARKING_RULE_PATH = `${WORKFLOW_LOADS_DIR}/marking-rule.md`
export const DEVIATIONS_PATH = `${WORKFLOW_LOADS_DIR}/deviations.json`

/** The two methods counted, and the two labels a stimulus can be marked with, per method. */
export const METHODS = ['counterfactual', 'synthesis'] as const
export type Method = (typeof METHODS)[number]
export const LABELS = ['expected_fire', 'expected_silence'] as const
export type Label = (typeof LABELS)[number]

/**
 * `errors-first`: any miss or false fire gives "errors observed"; otherwise the outcome is "clean" only with complete labeling
 * coverage, the omission check passed and every minimum met; anything else is "inconclusive". The declaration names the rule; the
 * counting step implements it.
 */
export const OUTCOME_RULES = ['errors-first'] as const

// ── the declaration ────────────────────────────────────────────────────────

const nonEmpty = z.string().refine((v) => v.trim() !== '')
const posInt = z.number().int().positive()
const nonNegInt = z.number().int().nonnegative()
const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const unique = (values: readonly string[]) => new Set(values).size === values.length

/** A real calendar date, `YYYY-MM-DD`. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      return new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
    } catch {
      return false
    }
  })

const labelMinimums = z.strictObject({ expected_fire: posInt, expected_silence: posInt })

const declarationSchema = z
  .strictObject({
    schema_version: z.literal(1),
    /** Inclusive UTC calendar days: a session is in the window when its creation time falls on a day from `start` through `end`. */
    window: z.strictObject({ start: isoDate, end: isoDate }),
    /** Most sessions in the sample. */
    session_cap: posInt,
    /** Most messages of one session's workflow scope that are shown. */
    scope_message_cap: posInt,
    /** Mixed into every salted hash that orders or samples sessions and stimuli. */
    salt: nonEmpty,
    /** Project roots whose sessions are left out, held as `projectRootHash` values so this committed file names no local path. May be empty. */
    excluded_project_root_hashes: z.array(hex64).refine(unique),
    /** Names of tools whose result counts as a stimulus. */
    decision_bearing_tools: z.array(nonEmpty).min(1).refine(unique),
    /** sha256 of the marking-rule file's canonical text (`markingRuleHash`). */
    marking_rule_hash: hex64,
    /** Accepted marks needed per method and label for a clean outcome. Never zero. */
    min_accepted_marks: z.strictObject({ counterfactual: labelMinimums, synthesis: labelMinimums }),
    /** Stimuli the labeler did not propose that the maintainer inspects, and the most omissions a clean outcome tolerates. */
    omission: z.strictObject({ sample_size: posInt, limit: nonNegInt }),
    /** Extra attempts for a chunk whose reply cannot be parsed. */
    retry_count: nonNegInt,
    outcome_rule: z.enum(OUTCOME_RULES),
    labeler: z.strictObject({ model_id: nonEmpty, endpoint: z.url() }),
    spend_cap_usd: z.number().positive().finite(),
  })
  .refine((d) => d.window.start <= d.window.end, { message: 'window.end is before window.start', path: ['window'] })
  .refine((d) => d.omission.limit <= d.omission.sample_size, { message: 'omission.limit exceeds omission.sample_size', path: ['omission'] })

export type Declaration = z.infer<typeof declarationSchema>

export class DeclarationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeclarationError'
  }
}

/** The fields a failed parse points at. Names only: a value never appears in the message. */
function issueFields(error: z.ZodError, fallback: string): string[] {
  const fields = error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => [...issue.path, key].join('.'))
    return [issue.path.length > 0 ? issue.path.join('.') : fallback]
  })
  return [...new Set(fields)]
}

/** Parse, don't validate: the typed declaration, or a `DeclarationError` naming the fields at fault. */
export function parseDeclaration(input: unknown): Declaration {
  const parsed = declarationSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new DeclarationError(`declaration is invalid (${issueFields(parsed.error, 'declaration').join(', ')})`)
}

/** sha256 of the RFC 8785 canonical form of the parsed declaration (the same construction as `preregContentHash`): formatting-insensitive, any value change changes it. */
export function declarationHash(declaration: Declaration): string {
  return sha256(canonicalize(declaration))
}

/**
 * What the declaration's `marking_rule_hash` is: sha256 of the whole rule file, read as UTF-8 and put in canonical text form
 * (BOM stripped, LF line endings, one final newline). Bytes that are not UTF-8 throw.
 */
export function markingRuleHash(bytes: Uint8Array | string): string {
  return sha256(canonicalizeText(bytes))
}

// ── excluded project roots ─────────────────────────────────────────────────

/** A path in the form that is hashed: dot segments and doubled or trailing slashes removed. */
function normalizeRoot(path: string): string {
  const normalized = posix.normalize(path)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * What an `excluded_project_root_hashes` entry is: `saltedHash` (sha256 of salt, NUL, text) over `project-root:` and the normalized
 * path, using the declaration's own salt. The prefix keeps these hashes apart from the session-id hashes made with the same salt.
 */
export function projectRootHash(salt: string, root: string): string {
  return saltedHash(salt, `project-root:${normalizeRoot(root)}`)
}

/** The directory and each of its ancestors, nearest first (`/a/b` gives `/a/b`, `/a`, `/`). */
function directoryChain(directory: string): string[] {
  const chain: string[] = []
  let current = normalizeRoot(directory)
  for (;;) {
    chain.push(current)
    const parent = posix.dirname(current)
    if (parent === current) return chain
    current = parent
  }
}

/** Whether `directory` equals an excluded root or lies under one. An empty directory is under nothing. */
export function underExcludedRoot(declaration: Declaration, directory: string): boolean {
  if (directory === '' || declaration.excluded_project_root_hashes.length === 0) return false
  const excluded = new Set(declaration.excluded_project_root_hashes)
  return directoryChain(directory).some((candidate) => excluded.has(projectRootHash(declaration.salt, candidate)))
}

// ── deviations ─────────────────────────────────────────────────────────────

/** `masking_fix`: the hidden view's masking changed after an audit failure. `session_cap_raise`: the sample grew (at most once). `labeler_change`: another labeler model or endpoint was used. */
export const DEVIATION_CODES = ['masking_fix', 'session_cap_raise', 'labeler_change'] as const
export type DeviationCode = (typeof DEVIATION_CODES)[number]
/** A reason is one line of at most this many characters, without leading or trailing space. */
export const DEVIATION_REASON_MAX = 280

const reasonText = z
  .string()
  .min(1)
  .max(DEVIATION_REASON_MAX)
  .refine((v) => v === v.trim() && !/[\r\n]/.test(v))

const deviationSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.enum(['masking_fix', 'labeler_change']), reason: reasonText, prev: hex64 }),
  /** The new cap; `effectiveSessionCap` reads it. */
  z.strictObject({ code: z.literal('session_cap_raise'), reason: reasonText, session_cap: posInt, prev: hex64 }),
])
const deviationsFileSchema = z.strictObject({ schema_version: z.literal(1), entries: z.array(deviationSchema) })

/** One recorded deviation. `prev` is the hash of the entry before it, or the declaration's hash for the first entry. */
export type Deviation = z.infer<typeof deviationSchema>
/** What a caller supplies; `prev` is added on append. */
export type NewDeviation = { code: 'masking_fix' | 'labeler_change'; reason: string } | { code: 'session_cap_raise'; reason: string; session_cap: number }

export type DeviationReason = 'deviations_invalid' | 'deviations_chain_broken' | 'deviations_rewritten'

export class DeviationRefusal extends Error {
  constructor(
    readonly reason: DeviationReason,
    message: string,
  ) {
    super(message)
    this.name = 'DeviationRefusal'
  }
}

const entryHash = (entry: Deviation): string => sha256(canonicalize(entry))

/**
 * The entries of a deviations file (`undefined`: no file, no entries), or a `DeviationRefusal`:
 * - `deviations_invalid`: not JSON, a schema break (unknown code, reason over the bound or over one line, extra key), a raise that
 *   does not exceed the declared cap, or a second raise.
 * - `deviations_chain_broken`: an entry's `prev` is not the hash of the entry before it (the declaration hash for the first). An
 *   edited, removed, inserted or reordered earlier entry breaks the chain at the entry after it.
 * The chain alone cannot see the last entry edited or removed; the gate compares against the committed file for that.
 */
export function parseDeviations(text: string | undefined, declaration: Declaration): Deviation[] {
  if (text === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DeviationRefusal('deviations_invalid', 'deviations file is not valid JSON')
  }
  const parsed = deviationsFileSchema.safeParse(raw)
  if (!parsed.success) throw new DeviationRefusal('deviations_invalid', `deviations file is invalid (${issueFields(parsed.error, 'deviations').join(', ')})`)
  const { entries } = parsed.data
  let expected = declarationHash(declaration)
  for (const [index, entry] of entries.entries()) {
    if (entry.prev !== expected) throw new DeviationRefusal('deviations_chain_broken', `deviation entry ${index + 1} does not follow the entry before it; an earlier entry was edited, removed or reordered`)
    expected = entryHash(entry)
  }
  const raises = entries.filter((entry) => entry.code === 'session_cap_raise')
  if (raises.length > 1) throw new DeviationRefusal('deviations_invalid', 'the session cap can be raised once')
  const [raise] = raises
  if (raise?.code === 'session_cap_raise' && raise.session_cap <= declaration.session_cap) {
    throw new DeviationRefusal('deviations_invalid', 'a session-cap raise must exceed the declared session cap')
  }
  return entries
}

/**
 * The deviations file text after appending `entry` to `existing` (`undefined`: no file yet). Verifies the existing text first, adds
 * `prev`, and verifies the whole result, so an invalid entry throws `DeviationRefusal` and nothing is produced.
 */
export function appendDeviationText(existing: string | undefined, declaration: Declaration, entry: NewDeviation): string {
  const entries = parseDeviations(existing, declaration)
  const last = entries.at(-1)
  const prev = last ? entryHash(last) : declarationHash(declaration)
  const text = `${JSON.stringify({ schema_version: 1, entries: [...entries, { ...entry, prev }] }, null, 2)}\n`
  parseDeviations(text, declaration)
  return text
}

/** The session cap in force: the declared one, or the one a recorded raise set. */
export function effectiveSessionCap(declaration: Declaration, deviations: readonly Deviation[]): number {
  for (const deviation of deviations) if (deviation.code === 'session_cap_raise') return deviation.session_cap
  return declaration.session_cap
}

// ── the gate ───────────────────────────────────────────────────────────────

export type GateReason =
  | 'declaration_missing'
  | 'declaration_untracked'
  | 'declaration_modified'
  | 'declaration_invalid'
  | 'marking_rule_missing'
  | 'marking_rule_untracked'
  | 'marking_rule_modified'
  | 'marking_rule_hash_mismatch'
  | DeviationReason

export interface GateInput {
  /** The repository holding the committed files; its `repo` directory is the root the paths are relative to. */
  git: Git
  /** Repo-relative overrides; default `DECLARATION_PATH`, `MARKING_RULE_PATH`, `DEVIATIONS_PATH`. */
  declarationPath?: string
  markingRulePath?: string
  deviationsPath?: string
}

export type GateResult =
  | { ok: true; declaration: Declaration; declarationHash: string; markingRuleHash: string; deviations: Deviation[] }
  | { ok: false; reason: GateReason; message: string }
export type GatePass = Extract<GateResult, { ok: true }>

export class GateRefusal extends Error {
  constructor(
    readonly reason: GateReason,
    message: string,
  ) {
    super(message)
    this.name = 'GateRefusal'
  }
}

type GateFailure = Extract<GateResult, { ok: false }>
const failure = (reason: GateReason, message: string): GateFailure => ({ ok: false, reason, message })

/** The file exists, is tracked and has no staged or working-tree change. Reuses the prereg commit check; only its codes are used. */
function committedCheck(git: Git, rel: string, subject: 'declaration' | 'marking_rule'): GateFailure | undefined {
  if (!existsSync(join(git.repo, rel))) return failure(`${subject}_missing`, `${rel} does not exist`)
  const violation = preregCommitViolation(git, git.repo, rel)
  if (violation?.code === 'prereg_untracked') return failure(`${subject}_untracked`, `${rel} is not tracked by git; commit it before any data step`)
  if (violation) return failure(`${subject}_modified`, `${rel} has staged or uncommitted changes; commit it before any data step`)
  return undefined
}

/** The deviations file as of HEAD (`undefined`: not committed yet). */
function committedText(git: Git, rel: string): string | undefined {
  const shown = git.run(['show', `HEAD:./${rel}`], { allowFailure: true })
  return shown.status === 0 ? shown.stdout : undefined
}

/**
 * The one gate every data step calls. It passes only when, in this order:
 * 1. the declaration file exists, is tracked and has no staged or uncommitted change, and parses (`declaration_missing`,
 *    `declaration_untracked`, `declaration_modified`, `declaration_invalid`);
 * 2. the marking-rule file exists, is tracked and unmodified, and `markingRuleHash` of the whole file equals the declaration's
 *    `marking_rule_hash` (`marking_rule_missing`, `marking_rule_untracked`, `marking_rule_modified`, `marking_rule_hash_mismatch`;
 *    a file that is not UTF-8 is a mismatch);
 * 3. the deviations file, if any, verifies, and the entries committed at HEAD are an unchanged prefix of it
 *    (`deviations_invalid`, `deviations_chain_broken`, `deviations_rewritten`). The deviations file may have uncommitted appended
 *    entries: appending never fails the gate.
 * Only the first failure is reported.
 */
export function checkGate(input: GateInput): GateResult {
  const { git } = input
  const declarationRel = input.declarationPath ?? DECLARATION_PATH
  const ruleRel = input.markingRulePath ?? MARKING_RULE_PATH
  const deviationsRel = input.deviationsPath ?? DEVIATIONS_PATH

  const declarationProblem = committedCheck(git, declarationRel, 'declaration')
  if (declarationProblem) return declarationProblem
  let declaration: Declaration
  try {
    declaration = parseDeclaration(JSON.parse(readFileSync(join(git.repo, declarationRel), 'utf8')))
  } catch (e) {
    return failure('declaration_invalid', e instanceof DeclarationError ? e.message : `${declarationRel} is not valid JSON`)
  }

  const ruleProblem = committedCheck(git, ruleRel, 'marking_rule')
  if (ruleProblem) return ruleProblem
  let ruleHash: string
  try {
    ruleHash = markingRuleHash(readFileSync(join(git.repo, ruleRel)))
  } catch {
    return failure('marking_rule_hash_mismatch', `${ruleRel} is not valid UTF-8, so it cannot match the declared hash`)
  }
  if (ruleHash !== declaration.marking_rule_hash) {
    return failure('marking_rule_hash_mismatch', `${ruleRel} does not hash to the declared marking_rule_hash`)
  }

  const deviationsPath = join(git.repo, deviationsRel)
  let deviations: Deviation[]
  let committed: Deviation[]
  try {
    deviations = parseDeviations(existsSync(deviationsPath) ? readFileSync(deviationsPath, 'utf8') : undefined, declaration)
  } catch (e) {
    if (e instanceof DeviationRefusal) return failure(e.reason, e.message)
    throw e
  }
  try {
    committed = parseDeviations(committedText(git, deviationsRel), declaration)
  } catch (e) {
    if (e instanceof DeviationRefusal) return failure('deviations_invalid', `the committed ${deviationsRel} is unusable: ${e.message}`)
    throw e
  }
  const extendsCommitted = committed.length <= deviations.length && committed.every((entry, i) => canonicalize(entry) === canonicalize(deviations[i]))
  if (!extendsCommitted) return failure('deviations_rewritten', `${deviationsRel} no longer extends the committed entries; deviations are append-only`)

  return { ok: true, declaration, declarationHash: declarationHash(declaration), markingRuleHash: ruleHash, deviations }
}

/** `checkGate`, throwing a `GateRefusal` carrying the reason when it fails. */
export function assertGate(input: GateInput): GatePass {
  const result = checkGate(input)
  if (!result.ok) throw new GateRefusal(result.reason, `${result.reason}: ${result.message}`)
  return result
}

/**
 * Appends `entry` to the deviations file (creating it) after the gate passes, and returns the stored entry. The declaration and the
 * rule file are not touched, so the gate passes afterwards. Throws `GateRefusal` when the gate fails and `DeviationRefusal` for an
 * invalid entry; neither writes anything.
 */
export function recordDeviation(input: GateInput & { entry: NewDeviation }): Deviation {
  const pass = assertGate(input)
  const path = join(input.git.repo, input.deviationsPath ?? DEVIATIONS_PATH)
  const text = appendDeviationText(existsSync(path) ? readFileSync(path, 'utf8') : undefined, pass.declaration, input.entry)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  const stored = parseDeviations(text, pass.declaration).at(-1)
  if (!stored) throw new Error('recordDeviation: the file holds no entry after an append')
  return stored
}
