/**
 * Preregistration: the typed shape of `evals/<method>/prereg.json`, parsing,
 * salted fixture hashing, and the content checks the runner enforces.
 *
 * A prereg is a content contract: the committed file fixes the bars, the fixture and rubric hashes, and the model pins,
 * and its canonical hash (`preregContentHash`) names it in every manifest and report. It does not prove git history.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalize } from '../record/canonical'
import { EXECUTION_MODES, type ExecutionMode } from '../record/contract'
import { type Git } from './git'
import { sha256 } from './workspace'

export const PREREG_SCHEMA_VERSION = 1 as const

/** The run-outcome taxonomy this runner implements. A prereg that names a different one is refused. */
export const RUN_OUTCOME_TAXONOMY = [
  'pass',
  'fail',
  'timeout->fail',
  'budget->fail',
  'judge_error->fail',
  'infra_error',
  'non_isolated',
] as const

/**
 * Evaluator-only: what a good answer to a fixture looks like. Lives in `<id>.expectation.json` beside the fixture; the agent never sees it.
 * `outcome` is the one required field. A sidecar without `maxWords` has no word limit (the check is skipped, not defaulted), and one
 * without `excludedTopics` excludes nothing; neither is filled in, so a sidecar's canonical form (and hash) is what the file says.
 */
export interface Expectation {
  outcome: string
  excludedTopics?: string[]
  maxWords?: number
}

export interface Prereg {
  schema_version: typeof PREREG_SCHEMA_VERSION
  method: string
  /** Positive integer; the held-out read marker is keyed by it. */
  epoch: number
  /** Mixed into every fixture and rubric hash. */
  salt: string
  /** id (file stem) → salted canonical hash. */
  fixture_hashes: {
    dev: Record<string, string>
    negative: Record<string, string>
    heldout: Record<string, string>
  }
  /**
   * id → salted canonical hash of each `<id>.expectation.json` sidecar. Absent: no fixture may carry a sidecar.
   * Negative fixtures never carry one.
   */
  expectation_hashes?: { dev: Record<string, string>; heldout: Record<string, string> }
  /**
   * Opt-in. Repo-relative directory under `evals/<method>/` holding this prereg's rubric, fixtures, expectation sidecars and redact list.
   * Absent: they live in `evals/<method>/` (every shipped prereg and the tether pilot). A pilot whose content must not share a directory
   * with a shipped epoch's names its own, so its sidecars never read as `extra` against that epoch.
   */
  content_dir?: string
  rubric_hash: string
  /** N: runs per condition per fixture. */
  runs_per_condition: number
  red_bar: { min_baseline_fails_per_fixture: number; min_fixtures: number }
  green_bar: {
    skill_pooled_pass_min: number
    skill_per_fixture_pass_min: number
    baseline_pooled_pass_max: number
  }
  /**
   * Dev-campaign bar (the skill condition on dev + negative fixtures, before a GREEN read): pooled passes across the dev
   * fixtures plus a per-fixture floor, both absolute counts. Absent: the runner's default (every dev fixture at least 80%).
   */
  dev_bar?: { pooled_min_passes: number; per_fixture_min_passes: number }
  /** Negatives: allowed false fires across the negative set. */
  false_fire_max: number
  per_run_timeout_ms: number
  /** Per-run ceilings; a breach is `budget_exceeded` and counts as FAIL. */
  budget: { max_tool_calls: number; max_total_tokens: number }
  /** Prose definition; the runner's implementation is fixed (see `classifyHostOutcome`). */
  infra_error_definition: string
  run_outcome_taxonomy: typeof RUN_OUTCOME_TAXONOMY
  agreement_floor: number
  /** `provider/model`; live runs require an `opencode/*` free-tier id. */
  agent_model_id: string
  judge_model_id: string
  accepted_error_rates: { false_red: number; false_green: number }
  /** `execution_mode` values accepted on a skill-condition record. Default: every mode but `unrecorded`. */
  expected_execution_modes?: readonly ExecutionMode[]
  metadata: { source_url: string; licence: string; notes?: string }
}

export type PreregParse = { ok: true; prereg: Prereg } | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isRate = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const HEX64 = /^[0-9a-f]{64}$/

/** One id → hash set: every id a legal fixture id, every hash a sha256 hex digest. `label` prefixes each error. */
function checkHashSet(errors: string[], label: string, entries: unknown): void {
  if (!isRecord(entries)) {
    errors.push(`${label}: must be an object of id → hash`)
    return
  }
  for (const [id, hash] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) errors.push(`${label}.${id}: invalid fixture id`)
    if (typeof hash !== 'string' || !HEX64.test(hash)) errors.push(`${label}.${id}: must be a sha256 hex digest`)
  }
}

/**
 * Why `value` is not a legal `content_dir` for `method`, or `undefined` when it is: a normalized repo-relative path strictly inside
 * `evals/<method>/`, with no `.`/`..`/empty segments, backslashes or leading slash, so it cannot name another method's content.
 */
function contentDirProblem(value: unknown, method: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string when present'
  const prefix = `evals/${method}/`
  if (!method || !value.startsWith(prefix) || value === prefix) return `must be a directory inside ${prefix}`
  if (value.includes('\\') || value.endsWith('/') || value.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return 'must be a normalized repo-relative path (no \\, trailing /, empty, . or .. segments)'
  }
  return undefined
}

const TOP_LEVEL_KEYS = [
  'schema_version',
  'method',
  'epoch',
  'salt',
  'fixture_hashes',
  'expectation_hashes',
  'content_dir',
  'rubric_hash',
  'runs_per_condition',
  'red_bar',
  'green_bar',
  'dev_bar',
  'false_fire_max',
  'per_run_timeout_ms',
  'budget',
  'infra_error_definition',
  'run_outcome_taxonomy',
  'agreement_floor',
  'agent_model_id',
  'judge_model_id',
  'accepted_error_rates',
  'expected_execution_modes',
  'metadata',
] as const

export function parsePrereg(text: string): PreregParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] }
  }
  if (!isRecord(raw)) return { ok: false, errors: ['prereg must be a JSON object'] }
  const errors: string[] = []
  const need = (cond: boolean, message: string) => {
    if (!cond) errors.push(message)
  }

  for (const key of Object.keys(raw)) {
    if (key === 'prev_epoch_closing_commit') {
      errors.push('prev_epoch_closing_commit: removed in the content-contract format; delete it and re-commit the prereg (the content hash changes)')
    } else if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) errors.push(`${key}: unknown field`)
  }
  need(raw.schema_version === PREREG_SCHEMA_VERSION, `schema_version: must be ${PREREG_SCHEMA_VERSION}`)
  need(typeof raw.method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(raw.method), 'method: must match ^[a-z][a-z0-9-]{0,63}$')
  need(isPositiveInt(raw.epoch), 'epoch: must be a positive integer')
  need(isNonEmptyString(raw.salt), 'salt: must be a non-empty string')

  const hashes = raw.fixture_hashes
  if (!isRecord(hashes)) {
    errors.push('fixture_hashes: must be an object with dev, negative, heldout')
  } else {
    for (const key of Object.keys(hashes)) {
      if (!['dev', 'negative', 'heldout'].includes(key)) errors.push(`fixture_hashes.${key}: unknown set`)
    }
    for (const set of ['dev', 'negative', 'heldout'] as const) checkHashSet(errors, `fixture_hashes.${set}`, hashes[set])
  }
  if (raw.expectation_hashes !== undefined) {
    const sets = raw.expectation_hashes
    if (!isRecord(sets)) {
      errors.push('expectation_hashes: must be an object with dev, heldout')
    } else {
      for (const key of Object.keys(sets)) {
        if (!['dev', 'heldout'].includes(key)) errors.push(`expectation_hashes.${key}: unknown set`)
      }
      for (const set of ['dev', 'heldout'] as const) checkHashSet(errors, `expectation_hashes.${set}`, sets[set])
    }
  }
  if (raw.content_dir !== undefined) {
    const problem = contentDirProblem(raw.content_dir, typeof raw.method === 'string' ? raw.method : '')
    if (problem) errors.push(`content_dir: ${problem}`)
  }
  need(typeof raw.rubric_hash === 'string' && HEX64.test(raw.rubric_hash), 'rubric_hash: must be a sha256 hex digest')
  need(isPositiveInt(raw.runs_per_condition), 'runs_per_condition: must be a positive integer')

  const red = raw.red_bar
  need(
    isRecord(red) && isNonNegativeInt(red.min_baseline_fails_per_fixture) && isPositiveInt(red.min_fixtures),
    'red_bar: needs integer min_baseline_fails_per_fixture and min_fixtures',
  )
  const green = raw.green_bar
  need(
    isRecord(green) &&
      isNonNegativeInt(green.skill_pooled_pass_min) &&
      isNonNegativeInt(green.skill_per_fixture_pass_min) &&
      isNonNegativeInt(green.baseline_pooled_pass_max),
    'green_bar: needs integer skill_pooled_pass_min, skill_per_fixture_pass_min, baseline_pooled_pass_max',
  )
  if (raw.dev_bar !== undefined) {
    const bar = raw.dev_bar
    if (!isRecord(bar)) {
      errors.push('dev_bar: must be an object with pooled_min_passes and per_fixture_min_passes when present')
    } else {
      for (const key of Object.keys(bar)) {
        if (key !== 'pooled_min_passes' && key !== 'per_fixture_min_passes') errors.push(`dev_bar.${key}: unknown field`)
      }
      const devCount = isRecord(hashes) && isRecord(hashes.dev) ? Object.keys(hashes.dev).length : 0
      const runs = isPositiveInt(raw.runs_per_condition) ? raw.runs_per_condition : 0
      if (!isNonNegativeInt(bar.pooled_min_passes) || !isNonNegativeInt(bar.per_fixture_min_passes)) {
        errors.push('dev_bar: needs non-negative integer pooled_min_passes and per_fixture_min_passes')
      } else {
        need(bar.per_fixture_min_passes <= runs, `dev_bar.per_fixture_min_passes: ${bar.per_fixture_min_passes} exceeds runs_per_condition ${runs}`)
        need(bar.pooled_min_passes <= runs * devCount, `dev_bar.pooled_min_passes: ${bar.pooled_min_passes} exceeds the ${runs * devCount} dev runs the prereg plans`)
        need(bar.pooled_min_passes >= bar.per_fixture_min_passes, 'dev_bar.pooled_min_passes: must be at least per_fixture_min_passes')
      }
    }
  }
  need(isNonNegativeInt(raw.false_fire_max), 'false_fire_max: must be a non-negative integer')
  need(isPositiveInt(raw.per_run_timeout_ms), 'per_run_timeout_ms: must be a positive integer')
  const budget = raw.budget
  need(isRecord(budget) && isPositiveInt(budget.max_tool_calls) && isPositiveInt(budget.max_total_tokens), 'budget: needs positive integer max_tool_calls and max_total_tokens')
  need(isNonEmptyString(raw.infra_error_definition), 'infra_error_definition: must be a non-empty string')
  need(
    Array.isArray(raw.run_outcome_taxonomy) &&
      raw.run_outcome_taxonomy.length === RUN_OUTCOME_TAXONOMY.length &&
      RUN_OUTCOME_TAXONOMY.every((o, i) => raw.run_outcome_taxonomy instanceof Array && raw.run_outcome_taxonomy[i] === o),
    `run_outcome_taxonomy: must equal [${RUN_OUTCOME_TAXONOMY.join(', ')}]`,
  )
  need(isRate(raw.agreement_floor), 'agreement_floor: must be a number in [0, 1]')
  need(isNonEmptyString(raw.agent_model_id) && String(raw.agent_model_id).includes('/'), 'agent_model_id: must be provider/model')
  need(isNonEmptyString(raw.judge_model_id), 'judge_model_id: must be a non-empty string')
  const rates = raw.accepted_error_rates
  need(isRecord(rates) && isRate(rates.false_red) && isRate(rates.false_green), 'accepted_error_rates: needs false_red and false_green in [0, 1]')
  if (raw.expected_execution_modes !== undefined) {
    need(
      Array.isArray(raw.expected_execution_modes) &&
        raw.expected_execution_modes.length > 0 &&
        raw.expected_execution_modes.every((m) => (EXECUTION_MODES as readonly unknown[]).includes(m)),
      `expected_execution_modes: must be a non-empty array drawn from ${EXECUTION_MODES.join(', ')} when present`,
    )
  }
  const meta = raw.metadata
  need(isRecord(meta) && isNonEmptyString(meta.source_url) && isNonEmptyString(meta.licence), 'metadata: needs non-empty source_url and licence')

  if (errors.length) return { ok: false, errors }
  return { ok: true, prereg: raw as unknown as Prereg }
}

// ── canonicalization and hashing ───────────────────────────────────────────

/** UTF-8 (BOM stripped), LF line endings, exactly one final newline appended if missing. */
export function canonicalizeText(bytes: Uint8Array | string): string {
  let text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

/** `sha256(salt NUL canonical-text)`. */
export function saltedHash(salt: string, canonicalText: string): string {
  return sha256(`${salt}\0${canonicalText}`)
}

/** Sorted sha256 of each fixture's canonical text, unsalted: names a held-out file's content across epochs, whatever the salt. */
export function heldoutFingerprints(fixtures: readonly { text: string }[]): string[] {
  return fixtures.map((f) => sha256(canonicalizeText(f.text))).sort()
}

export interface LoadedFixture {
  id: string
  /** Canonical text; also the prompt the agent receives. */
  text: string
  hash: string
  /** Evaluator-only. Set by `verifyPreregContent` once the sidecar's shape and hash check out; never on a negative. */
  expectation?: Expectation
}

/** `sha256(salt NUL canonical-json)` of a parsed sidecar: formatting and key order in the file do not matter. */
export function expectationHash(salt: string, value: unknown): string {
  return saltedHash(salt, canonicalize(value))
}

/** `*.md` files directly in `dir`; id is the file stem. A missing dir is an empty set. */
export function loadFixtureDir(dir: string, salt: string): LoadedFixture[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = canonicalizeText(readFileSync(join(dir, name)))
      return { id: name.slice(0, -'.md'.length), text, hash: saltedHash(salt, text) }
    })
}

export interface HashProblem {
  set: string
  id: string
  kind: 'missing' | 'extra' | 'mismatch'
  expected?: string
  actual?: string
}

export function compareFixtureSet(set: string, expected: Record<string, string>, found: readonly { id: string; hash: string }[]): HashProblem[] {
  const problems: HashProblem[] = []
  const byId = new Map(found.map((f) => [f.id, f]))
  for (const [id, hash] of Object.entries(expected)) {
    const f = byId.get(id)
    if (!f) problems.push({ set, id, kind: 'missing', expected: hash })
    else if (f.hash !== hash) problems.push({ set, id, kind: 'mismatch', expected: hash, actual: f.hash })
  }
  for (const f of found) {
    if (!(f.id in expected)) problems.push({ set, id: f.id, kind: 'extra', actual: f.hash })
  }
  return problems
}

export interface PreregPaths {
  /** The prereg's content directory under the repo: `evals/<method>`, or its `content_dir` (`preregContentDirRel`). */
  evalDir: string
  /** Where held-out fixtures live (outside the repo). */
  heldoutDir: string
}

const EXPECTATION_SUFFIX = '.expectation.json'
const EXPECTATION_FIELDS = ['outcome', 'excludedTopics', 'maxWords'] as const

/** The directory a prereg's rubric, fixtures, sidecars and redact list live in: its `content_dir`, else `evals/<method>`. */
export const preregContentDirRel = (prereg: Pick<Prereg, 'method' | 'content_dir'>): string => prereg.content_dir ?? `evals/${prereg.method}`

/** Field-level shape errors, each prefixed by `where`; empty when `value` is an `Expectation`. */
export function expectationShapeErrors(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where}: expectation must be a JSON object`]
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!(EXPECTATION_FIELDS as readonly string[]).includes(key)) errors.push(`${where}: ${key}: unknown field`)
  }
  if (!isNonEmptyString(value.outcome)) errors.push(`${where}: outcome must be a non-empty string`)
  if (value.excludedTopics !== undefined && (!Array.isArray(value.excludedTopics) || !value.excludedTopics.every((t) => typeof t === 'string'))) {
    errors.push(`${where}: excludedTopics must be an array of strings`)
  }
  if (value.maxWords !== undefined && !isPositiveInt(value.maxWords)) errors.push(`${where}: maxWords must be a positive integer`)
  return errors
}

interface Sidecar {
  id: string
  /** Absent when the file could not be read as canonicalizable JSON. */
  hash?: string
  value?: Expectation
  errors: string[]
}

/** `<id>.expectation.json` files directly in `dir`. A missing dir is an empty set. */
function loadSidecars(set: string, dir: string, salt: string): Sidecar[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(EXPECTATION_SUFFIX))
    .sort()
    .map((name) => {
      const id = name.slice(0, -EXPECTATION_SUFFIX.length)
      const where = `expectation ${set}/${id}`
      let parsed: unknown
      let hash: string
      try {
        parsed = JSON.parse(canonicalizeText(readFileSync(join(dir, name))))
        hash = expectationHash(salt, parsed)
      } catch (e) {
        return { id, errors: [`${where}: not readable as JSON: ${(e as Error).message}`] }
      }
      const errors = expectationShapeErrors(parsed, where)
      return errors.length ? { id, hash, errors } : { id, hash, value: parsed as Expectation, errors }
    })
}

/**
 * Checks one directory's sidecars against `expected` (the prereg's hashes for this set; `{}` when it has none) and returns the
 * fixtures with each verified expectation attached. A sidecar with no fixture beside it is `extra`, whatever the prereg lists.
 * Negatives pass `attach: false`: their expected set is always empty, so any sidecar there is `extra`.
 */
function verifyExpectations(
  set: 'dev' | 'negative' | 'heldout',
  dir: string,
  salt: string,
  expected: Record<string, string>,
  fixtures: LoadedFixture[],
): { problems: HashProblem[]; invalid: string[]; fixtures: LoadedFixture[] } {
  const label = `expectation.${set}`
  const sidecars = loadSidecars(set, dir, salt)
  const unreadable = new Set(sidecars.filter((s) => s.hash === undefined).map((s) => s.id))
  const readable = sidecars.flatMap((s) => (s.hash === undefined ? [] : [{ id: s.id, hash: s.hash }]))
  const problems = compareFixtureSet(label, expected, readable).filter((p) => !(p.kind === 'missing' && unreadable.has(p.id)))
  const fixtureIds = new Set(fixtures.map((f) => f.id))
  for (const s of sidecars) {
    if (fixtureIds.has(s.id) || problems.some((p) => p.id === s.id && p.kind === 'extra')) continue
    problems.push({ set: label, id: s.id, kind: 'extra', ...(s.hash === undefined ? {} : { actual: s.hash }) })
  }
  const bySidecar = new Map(sidecars.map((s) => [s.id, s]))
  return {
    problems,
    invalid: sidecars.flatMap((s) => s.errors),
    fixtures: fixtures.map((f) => {
      const s = bySidecar.get(f.id)
      return set !== 'negative' && s?.value !== undefined && s.hash === expected[f.id] ? { ...f, expectation: s.value } : f
    }),
  }
}

export interface ContentVerification {
  problems: HashProblem[]
  /** Sidecar shape errors (prereg_invalid), each naming the set, id, and field. */
  invalid: string[]
  fixtures: { dev: LoadedFixture[]; negative: LoadedFixture[]; heldout: LoadedFixture[] }
}

/**
 * Re-hashes dev and negative fixtures and the rubric (and held-out fixtures
 * when `includeHeldout`) against the prereg. Any mismatch voids the prereg.
 */
export function verifyPreregContent(prereg: Prereg, paths: PreregPaths, options: { includeHeldout: boolean }): ContentVerification {
  const devDir = join(paths.evalDir, 'fixtures', 'dev')
  const negativeDir = join(paths.evalDir, 'fixtures', 'negative')
  const expectations = prereg.expectation_hashes
  const devX = verifyExpectations('dev', devDir, prereg.salt, expectations?.dev ?? {}, loadFixtureDir(devDir, prereg.salt))
  const negativeX = verifyExpectations('negative', negativeDir, prereg.salt, {}, loadFixtureDir(negativeDir, prereg.salt))
  const heldoutX = options.includeHeldout
    ? verifyExpectations('heldout', paths.heldoutDir, prereg.salt, expectations?.heldout ?? {}, loadFixtureDir(paths.heldoutDir, prereg.salt))
    : { problems: [], invalid: [], fixtures: [] }
  const [dev, negative, heldout] = [devX.fixtures, negativeX.fixtures, heldoutX.fixtures]
  const problems = [
    ...compareFixtureSet('dev', prereg.fixture_hashes.dev, dev),
    ...compareFixtureSet('negative', prereg.fixture_hashes.negative, negative),
    ...(options.includeHeldout ? compareFixtureSet('heldout', prereg.fixture_hashes.heldout, heldout) : []),
    ...devX.problems,
    ...negativeX.problems,
    ...heldoutX.problems,
  ]
  const invalid = [...devX.invalid, ...negativeX.invalid, ...heldoutX.invalid]
  const rubricPath = join(paths.evalDir, 'rubric.md')
  if (!existsSync(rubricPath)) {
    problems.push({ set: 'rubric', id: 'rubric.md', kind: 'missing', expected: prereg.rubric_hash })
  } else {
    const actual = saltedHash(prereg.salt, canonicalizeText(readFileSync(rubricPath)))
    if (actual !== prereg.rubric_hash) problems.push({ set: 'rubric', id: 'rubric.md', kind: 'mismatch', expected: prereg.rubric_hash, actual })
  }
  return { problems, invalid, fixtures: { dev, negative, heldout } }
}

// ── enforcement ────────────────────────────────────────────────────────────

/**
 * A prereg is a contract only once it is committed: the pilot reads its bars, hashes and model pins from the working tree, so an
 * untracked, staged-only or edited file would let a run claim a contract nobody committed. `undefined` when `relPath` is tracked and has
 * no staged or working-tree change, and also when the file does not exist (`enforcePrereg` reports that, naming the path).
 */
export function preregCommitViolation(git: Git, repoRoot: string, relPath: string): { code: 'prereg_untracked' | 'prereg_dirty'; message: string } | undefined {
  if (!existsSync(join(repoRoot, relPath))) return undefined
  if (!git.isTracked(relPath)) return { code: 'prereg_untracked', message: `prereg_untracked: ${relPath} is not tracked by git; commit it before running a pilot` }
  if (git.porcelain([relPath])) return { code: 'prereg_dirty', message: `prereg_dirty: ${relPath} has staged or uncommitted changes; commit it before running a pilot` }
  return undefined
}

export type ViolationCode = 'prereg_missing' | 'prereg_invalid' | 'content_hash_mismatch' | 'skill_missing' | 'skill_dirty'

export interface Violation {
  code: ViolationCode
  message: string
}

export const preregRelPath = (method: string) => `evals/${method}/prereg.json`

/** sha256 of the RFC 8785 canonical form of the parsed prereg: formatting-insensitive, any value change changes it. */
export function preregContentHash(prereg: Prereg): string {
  return sha256(canonicalize(prereg))
}

export class PreregRefusal extends Error {
  constructor(
    readonly violations: readonly Violation[],
    context: string,
  ) {
    super(`${context}: ${violations.map((v) => `[${v.code}] ${v.message}`).join('; ')}`)
    this.name = 'PreregRefusal'
  }
}

export interface EnforceInput {
  git: Git
  repoRoot: string
  method: string
  /** `dev` and `red` are authoring-time and measurement runs: no held-out read, and an uncommitted skill is fine. */
  mode: 'red' | 'green' | 'dev'
  heldoutDir: string
  /** Repo-relative prereg file to enforce. Default `evals/<method>/prereg.json`; `eval pilot` names `evals/<method>/pilot/prereg.json`. */
  preregPath?: string
  /**
   * GREEN only: runs once the prereg parses, the skill and prereg are committed, and the fixtures and rubric re-hash clean, with the
   * verified held-out set in hand and before the runner hands it to any agent or judge. May throw to refuse.
   */
  beforeHeldoutRead?: (read: { prereg: Prereg; contentHash: string; heldout: readonly LoadedFixture[] }) => void
}

export interface PreregVerification {
  prereg: Prereg
  /** `preregContentHash(prereg)`: names this prereg in every manifest and report. */
  contentHash: string
  content: ContentVerification
}

/**
 * Everything that must hold before the first model request: parse the committed prereg, require a committed skill for
 * GREEN, and re-hash fixtures and rubric against it. Throws `PreregRefusal` naming every violated rule.
 */
export function enforcePrereg(input: EnforceInput): PreregVerification {
  const { git, repoRoot, method, mode } = input
  const rel = input.preregPath ?? preregRelPath(method)
  const path = join(repoRoot, rel)
  if (!existsSync(path)) throw new PreregRefusal([{ code: 'prereg_missing', message: `${rel} does not exist` }], `prereg for ${method}`)
  const parsed = parsePrereg(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new PreregRefusal(parsed.errors.map((message) => ({ code: 'prereg_invalid' as const, message })), `prereg for ${method} is invalid`)
  const { prereg } = parsed
  if (prereg.method !== method) {
    throw new PreregRefusal([{ code: 'prereg_invalid', message: `prereg.method is ${prereg.method}, expected ${method}` }], 'prereg method mismatch')
  }
  const contentHash = preregContentHash(prereg)

  if (mode === 'green') {
    const skillFile = `skills/${method}/SKILL.md`
    if (!existsSync(join(repoRoot, skillFile)) || !git.isTracked(skillFile)) {
      throw new PreregRefusal([{ code: 'skill_missing', message: `${skillFile} is absent or not tracked; GREEN needs a committed skill` }], `prereg for ${method} epoch ${prereg.epoch}`)
    }
    if (git.porcelain([`skills/${method}`, preregRelPath(method)])) {
      throw new PreregRefusal(
        [{ code: 'skill_dirty', message: `skills/${method} or ${preregRelPath(method)} has uncommitted changes; the run must use a committed skill and prereg` }],
        `prereg for ${method} epoch ${prereg.epoch}`,
      )
    }
  }
  const content = verifyPreregContent(prereg, { evalDir: join(repoRoot, preregContentDirRel(prereg)), heldoutDir: input.heldoutDir }, { includeHeldout: mode === 'green' })
  const violations: Violation[] = content.invalid.map((message) => ({ code: 'prereg_invalid', message }))
  if (content.problems.length) {
    const lines = content.problems.map((p) => `${p.set}/${p.id} ${p.kind}`)
    violations.push({ code: 'content_hash_mismatch', message: `fixture/rubric hashes do not match the prereg (voided): ${lines.join(', ')}` })
  }
  if (violations.length) throw new PreregRefusal(violations, `prereg content for ${method}`)
  if (mode === 'green') input.beforeHeldoutRead?.({ prereg, contentHash, heldout: content.fixtures.heldout })
  return { prereg, contentHash, content }
}
