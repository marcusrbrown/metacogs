/**
 * Preregistration: the typed shape of `evals/<method>/prereg.json`, parsing,
 * salted fixture hashing, and the git-ordering checks the runner enforces.
 *
 * This is an audit trail, not a lock: it makes post-hoc edits visible.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

export interface Prereg {
  schema_version: typeof PREREG_SCHEMA_VERSION
  method: string
  /** Tag `prereg/<method>/<epoch>` marks the prereg commit. */
  epoch: number
  /** Closing commit of epoch `epoch - 1` (the base of this epoch's history); `null` for epoch 1 (base = root). */
  prev_epoch_closing_commit: string | null
  /** Mixed into every fixture and rubric hash. */
  salt: string
  /** id (file stem) → salted canonical hash. */
  fixture_hashes: {
    dev: Record<string, string>
    negative: Record<string, string>
    heldout: Record<string, string>
  }
  rubric_hash: string
  /** N: runs per condition per fixture. */
  runs_per_condition: number
  red_bar: { min_baseline_fails_per_fixture: number; min_fixtures: number }
  green_bar: {
    skill_pooled_pass_min: number
    skill_per_fixture_pass_min: number
    baseline_pooled_pass_max: number
  }
  /** Negatives: allowed false fires across the negative set. */
  false_fire_max: number
  per_run_timeout_ms: number
  /** Per-run ceilings; a breach is `budget_exceeded` and counts as FAIL. */
  budget: { max_tool_calls: number; max_total_tokens: number }
  /** Prose definition; the runner's implementation is fixed (see `classifyHostOutcome`). */
  infra_error_definition: string
  run_outcome_taxonomy: string[]
  agreement_floor: number
  /** `provider/model`; live runs require an `opencode/*` free-tier id. */
  agent_model_id: string
  judge_model_id: string
  accepted_error_rates: { false_red: number; false_green: number }
  /** `execution_mode` values accepted on a skill-condition record. Default: every mode but `unrecorded`. */
  expected_execution_modes?: string[]
  metadata: { source_url: string; licence: string; notes?: string }
}

export type PreregParse = { ok: true; prereg: Prereg } | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isRate = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const HEX64 = /^[0-9a-f]{64}$/
const SHA40 = /^[0-9a-f]{40}$/

const TOP_LEVEL_KEYS = [
  'schema_version',
  'method',
  'epoch',
  'prev_epoch_closing_commit',
  'salt',
  'fixture_hashes',
  'rubric_hash',
  'runs_per_condition',
  'red_bar',
  'green_bar',
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
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) errors.push(`${key}: unknown field`)
  }
  need(raw.schema_version === PREREG_SCHEMA_VERSION, `schema_version: must be ${PREREG_SCHEMA_VERSION}`)
  need(typeof raw.method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(raw.method), 'method: must match ^[a-z][a-z0-9-]{0,63}$')
  need(isPositiveInt(raw.epoch), 'epoch: must be a positive integer')
  if (raw.epoch === 1) {
    need(raw.prev_epoch_closing_commit === null, 'prev_epoch_closing_commit: must be null for epoch 1')
  } else {
    need(
      typeof raw.prev_epoch_closing_commit === 'string' && SHA40.test(raw.prev_epoch_closing_commit),
      'prev_epoch_closing_commit: must be a 40-hex commit SHA for epoch > 1',
    )
  }
  need(isNonEmptyString(raw.salt), 'salt: must be a non-empty string')

  const hashes = raw.fixture_hashes
  if (!isRecord(hashes)) {
    errors.push('fixture_hashes: must be an object with dev, negative, heldout')
  } else {
    for (const key of Object.keys(hashes)) {
      if (!['dev', 'negative', 'heldout'].includes(key)) errors.push(`fixture_hashes.${key}: unknown set`)
    }
    for (const set of ['dev', 'negative', 'heldout'] as const) {
      const entries = hashes[set]
      if (!isRecord(entries)) {
        errors.push(`fixture_hashes.${set}: must be an object of id → hash`)
        continue
      }
      for (const [id, hash] of Object.entries(entries)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) errors.push(`fixture_hashes.${set}.${id}: invalid fixture id`)
        if (typeof hash !== 'string' || !HEX64.test(hash)) errors.push(`fixture_hashes.${set}.${id}: must be a sha256 hex digest`)
      }
    }
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
      Array.isArray(raw.expected_execution_modes) && raw.expected_execution_modes.length > 0 && raw.expected_execution_modes.every(isNonEmptyString),
      'expected_execution_modes: must be a non-empty array of strings when present',
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

export interface LoadedFixture {
  id: string
  /** Canonical text; also the prompt the agent receives. */
  text: string
  hash: string
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

export function compareFixtureSet(set: string, expected: Record<string, string>, found: readonly LoadedFixture[]): HashProblem[] {
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
  /** `evals/<method>` under the repo. */
  evalDir: string
  /** Where held-out fixtures live (outside the repo). */
  heldoutDir: string
}

export interface ContentVerification {
  problems: HashProblem[]
  fixtures: { dev: LoadedFixture[]; negative: LoadedFixture[]; heldout: LoadedFixture[] }
}

/**
 * Re-hashes dev and negative fixtures and the rubric (and held-out fixtures
 * when `includeHeldout`) against the prereg. Any mismatch voids the prereg.
 */
export function verifyPreregContent(prereg: Prereg, paths: PreregPaths, options: { includeHeldout: boolean }): ContentVerification {
  const dev = loadFixtureDir(join(paths.evalDir, 'fixtures', 'dev'), prereg.salt)
  const negative = loadFixtureDir(join(paths.evalDir, 'fixtures', 'negative'), prereg.salt)
  const heldout = options.includeHeldout ? loadFixtureDir(paths.heldoutDir, prereg.salt) : []
  const problems = [
    ...compareFixtureSet('dev', prereg.fixture_hashes.dev, dev),
    ...compareFixtureSet('negative', prereg.fixture_hashes.negative, negative),
    ...(options.includeHeldout ? compareFixtureSet('heldout', prereg.fixture_hashes.heldout, heldout) : []),
  ]
  const rubricPath = join(paths.evalDir, 'rubric.md')
  if (!existsSync(rubricPath)) {
    problems.push({ set: 'rubric', id: 'rubric.md', kind: 'missing', expected: prereg.rubric_hash })
  } else {
    const actual = saltedHash(prereg.salt, canonicalizeText(readFileSync(rubricPath)))
    if (actual !== prereg.rubric_hash) problems.push({ set: 'rubric', id: 'rubric.md', kind: 'mismatch', expected: prereg.rubric_hash, actual })
  }
  return { problems, fixtures: { dev, negative, heldout } }
}

// ── git ordering ───────────────────────────────────────────────────────────

export type ViolationCode =
  | 'prereg_missing'
  | 'prereg_invalid'
  | 'content_hash_mismatch'
  | 'tag_missing'
  | 'tag_not_annotated'
  | 'tag_not_in_history'
  | 'prereg_commit_parents'
  | 'prereg_commit_not_alone'
  | 'prereg_blob_mismatch'
  | 'epoch_base_invalid'
  | 'fixtures_after_prereg'
  | 'tag_equals_skill_commit'
  | 'skill_commit_not_after_tag'
  | 'no_skill_commit'
  | 'skill_dirty'

export interface Violation {
  code: ViolationCode
  message: string
}

export interface PreregShas {
  tag: string
  tagObjectSha: string
  commitSha: string
  /** Blob id of `prereg.json` at the tagged commit. */
  blobSha: string
  firstSkillCommit: string | null
  /** Tree id of `skills/<method>` at HEAD, when a skill exists. */
  skillTreeSha: string | null
}

export interface OrderingResult {
  violations: Violation[]
  shas: Partial<PreregShas>
}

export const preregTagName = (method: string, epoch: number) => `prereg/${method}/${epoch}`
export const preregRelPath = (method: string) => `evals/${method}/prereg.json`

const short = (sha: string) => sha.slice(0, 12)

/**
 * The commit-ordering half of enforcement. `red` requires a well-formed prereg
 * and, if skill commits already exist, that all of them follow the tag; `green`
 * additionally requires a clean, committed skill.
 */
export function checkPreregOrdering(git: Git, prereg: Prereg, mode: 'red' | 'green'): OrderingResult {
  const { method, epoch } = prereg
  const violations: Violation[] = []
  const shas: Partial<PreregShas> = {}
  const add = (code: ViolationCode, message: string) => violations.push({ code, message })

  const tagName = preregTagName(method, epoch)
  const preregPath = preregRelPath(method)
  const tag = git.tag(tagName)
  if (!tag) {
    add('tag_missing', `tag ${tagName} does not exist`)
    return { violations, shas }
  }
  shas.tag = tagName
  shas.tagObjectSha = tag.objectSha
  shas.commitSha = tag.commitSha
  if (!tag.annotated) add('tag_not_annotated', `tag ${tagName} is lightweight (points at ${short(tag.commitSha)}); create it with git tag -a`)

  const head = git.head()
  if (!head || !git.isAncestorOrEqual(tag.commitSha, head)) {
    add('tag_not_in_history', `tagged commit ${short(tag.commitSha)} is not an ancestor of HEAD`)
  }

  // (2) is a single-file commit with exactly one parent.
  const parents = git.parents(tag.commitSha)
  if (parents.length !== 1) add('prereg_commit_parents', `prereg commit ${short(tag.commitSha)} must have exactly one parent, has ${parents.length}`)
  const touched = git.touchedFiles(tag.commitSha)
  if (touched.length !== 1 || touched[0] !== preregPath) {
    add('prereg_commit_not_alone', `prereg commit ${short(tag.commitSha)} must touch only ${preregPath}; it touches: ${touched.join(', ') || '(nothing)'}`)
  }

  // The working-tree file is what the runner parsed: it must be byte-for-byte what the tag holds.
  const tagged = git.blobAt(tag.commitSha, preregPath)
  const working = git.hashObjectPath(preregPath)
  if (tagged) shas.blobSha = tagged
  if (!tagged || tagged !== working) {
    add('prereg_blob_mismatch', `working-tree ${preregPath} hashes to ${short(working)} but tag ${tagName} holds ${tagged ? short(tagged) : '(no such blob)'}`)
  }

  // Epoch base.
  let base: string | null = null
  if (epoch > 1) {
    const closing = prereg.prev_epoch_closing_commit
    const closingCommit = closing ? git.commitOf(closing) : null
    if (!closingCommit) {
      add('epoch_base_invalid', `prev_epoch_closing_commit ${closing ?? '(null)'} does not resolve to a commit`)
    } else if (!git.isStrictAncestor(closingCommit, tag.commitSha)) {
      add('epoch_base_invalid', `epoch ${epoch} prereg ${short(tag.commitSha)} does not strictly follow the epoch ${epoch - 1} closing commit ${short(closingCommit)}`)
    } else {
      base = closingCommit
    }
    if (!base) return { violations, shas }
  }

  // Fixtures and rubric (1) must all precede (2).
  const fixtureCommits = git.commitsTouching(base, [
    `evals/${method}/fixtures`,
    `evals/${method}/rubric.md`,
    `evals/${method}/redact.json`,
  ])
  const late = fixtureCommits.filter((c) => !git.isStrictAncestor(c, tag.commitSha))
  if (late.length) {
    add(
      'fixtures_after_prereg',
      `fixture/rubric commits not strictly before prereg commit ${short(tag.commitSha)}: ${late.map(short).join(', ')}`,
    )
  }

  // Skill (3) must come strictly after the tag.
  const skillCommits = git.commitsTouching(base, [`skills/${method}`])
  const first = skillCommits[0] ?? null
  shas.firstSkillCommit = first
  if (first === null) {
    if (mode === 'green') add('no_skill_commit', `no commit under skills/${method} in this epoch; commit the skill before a GREEN run`)
  } else {
    for (const c of skillCommits) {
      if (c === tag.commitSha) {
        add('tag_equals_skill_commit', `tag ${tagName} (${short(tag.commitSha)}) is the same commit as the first skills/${method} commit ${short(first)}`)
      } else if (!git.isStrictAncestor(tag.commitSha, c)) {
        add('skill_commit_not_after_tag', `skills/${method} commit ${short(c)} is not a descendant of tag ${tagName} (${short(tag.commitSha)}); first skill commit is ${short(first)}`)
      }
    }
  }
  if (mode === 'green') {
    const dirty = git.porcelain([`skills/${method}`])
    if (dirty) add('skill_dirty', `skills/${method} has uncommitted changes; the run must use a committed skill`)
    shas.skillTreeSha = git.treeAt('HEAD', `skills/${method}`)
  }

  return { violations, shas }
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
  /** `dev` is authoring-time iteration: RED's ordering rules (an uncommitted skill is fine) and no held-out read. */
  mode: 'red' | 'green' | 'dev'
  heldoutDir: string
}

export interface PreregVerification {
  prereg: Prereg
  shas: PreregShas
  content: ContentVerification
}

/**
 * Everything that must hold before the first model request: parse, git
 * ordering, content hashes. Throws `PreregRefusal` naming every violated rule
 * and the SHAs involved.
 */
export function enforcePrereg(input: EnforceInput): PreregVerification {
  const { git, repoRoot, method, mode } = input
  const path = join(repoRoot, preregRelPath(method))
  if (!existsSync(path)) throw new PreregRefusal([{ code: 'prereg_missing', message: `${preregRelPath(method)} does not exist` }], `prereg for ${method}`)
  const parsed = parsePrereg(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new PreregRefusal(parsed.errors.map((message) => ({ code: 'prereg_invalid' as const, message })), `prereg for ${method} is invalid`)
  const { prereg } = parsed
  if (prereg.method !== method) {
    throw new PreregRefusal([{ code: 'prereg_invalid', message: `prereg.method is ${prereg.method}, expected ${method}` }], 'prereg method mismatch')
  }

  const ordering = checkPreregOrdering(git, prereg, mode === 'green' ? 'green' : 'red')
  if (ordering.violations.length) throw new PreregRefusal(ordering.violations, `prereg ordering for ${method} epoch ${prereg.epoch}`)

  const content = verifyPreregContent(prereg, { evalDir: join(repoRoot, 'evals', method), heldoutDir: input.heldoutDir }, { includeHeldout: mode === 'green' })
  if (content.problems.length) {
    const lines = content.problems.map((p) => `${p.set}/${p.id} ${p.kind}`)
    throw new PreregRefusal(
      [{ code: 'content_hash_mismatch', message: `fixture/rubric hashes do not match the prereg (voided): ${lines.join(', ')}` }],
      `prereg content for ${method}`,
    )
  }
  return { prereg, shas: ordering.shas as PreregShas, content }
}
