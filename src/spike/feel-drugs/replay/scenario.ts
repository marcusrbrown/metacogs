/** Real-world scenarios: the minimal spec, the built history beside it, and the loader a campaign runs from. All of it is private, under the store root. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { sha256 } from '../../../runner/workspace'
import { extractSession, nextHumanTurn } from './extract'
import { assertEndsAtCutoff, buildRealExport, type DroppedParts, type HistoryWindow, type ReplaySeed } from './history'
import { type FixtureKind, type FixtureSpec, ID_PATTERN, KINDS, parseSpec, privateDir, SpecError, type Store, type Turn, writePrivate } from './store'
import { branchHints, type CheckoutContext, checkoutOf, type WorldJob } from './world'

/** The 11 approved moments: the 8 feel and drugs fixtures plus three ordinary ones. */
export const WORLD_SCENARIOS = ['feel-fro-0f4c-25', 'feel-fro-fe3c-94', 'feel-meta-e9d9-17', 'feel-sys-11', 'feel-sys-39', 'feel-sys-52', 'drugs-fro-f677-20', 'drugs-sys-7', 'ord-sys-46', 'ord-sys-20', 'ord-fro-130'] as const

/** What `drugs-substance` sends when the spec names none: caffeine for a /feel moment, psilocybin for a /drugs moment. */
export const defaultSubstance = (kind: FixtureKind): string => (kind === 'drugs' ? 'psilocybin' : 'caffeine')

/** A real-world scenario. Every `_ref` field is private and for the judge only; none is ever sent to the agent. */
export interface WorldSpec {
  id: string
  kind: FixtureKind
  /** A key of `WORLD_PROJECTS`. */
  project: string
  source_session: string
  cutoff_message: string
  /** The `/feel` argument for `feel-somewhere`. */
  somewhere: string
  /** The `/drugs` argument for `drugs-substance`. */
  substance: string
  expected_outcome_ref: string
  /** The author's real next message after the cutoff, for the judge. Absent when none followed. */
  author_next_turn_ref?: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (path: string, want: string): never => {
  throw new SpecError(`${path}: expected ${want}`) // never the value: specs are private
}
const str = (v: unknown, path: string, nonEmpty = true): string => (typeof v === 'string' && (!nonEmpty || v.trim() !== '') ? v : fail(path, nonEmpty ? 'a non-empty string' : 'a string'))

const FIELDS = ['id', 'kind', 'project', 'source_session', 'cutoff_message', 'somewhere', 'substance', 'expected_outcome_ref', 'author_next_turn_ref'] as const

/** Parse, don't validate: a bad spec never becomes a `WorldSpec`. A missing `substance` takes the default for its kind. */
export function parseWorldSpec(input: unknown): WorldSpec {
  if (!isObject(input)) return fail('spec', 'an object')
  const extra = Object.keys(input).find((k) => !(FIELDS as readonly string[]).includes(k))
  if (extra !== undefined) return fail(`spec.${extra}`, `no such field (allowed: ${FIELDS.join(', ')})`)
  const id = str(input.id, 'spec.id')
  if (!ID_PATTERN.test(id)) fail('spec.id', 'lowercase letters, digits and hyphens, up to 64 characters')
  if (!KINDS.includes(input.kind as FixtureKind)) fail('spec.kind', KINDS.join(' | '))
  const kind = input.kind as FixtureKind
  const substance = input.substance === undefined ? defaultSubstance(kind) : str(input.substance, 'spec.substance')
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(substance)) fail('spec.substance', 'one word (letters, digits, hyphens)')
  return {
    id,
    kind,
    project: str(input.project, 'spec.project'),
    source_session: str(input.source_session, 'spec.source_session'),
    cutoff_message: str(input.cutoff_message, 'spec.cutoff_message'),
    somewhere: str(input.somewhere, 'spec.somewhere', false),
    substance,
    expected_outcome_ref: str(input.expected_outcome_ref, 'spec.expected_outcome_ref'),
    ...(input.author_next_turn_ref !== undefined ? { author_next_turn_ref: str(input.author_next_turn_ref, 'spec.author_next_turn_ref') } : {}),
  }
}

// ── on disk ────────────────────────────────────────────────────────────────

export const worldRoot = (store: Store): string => join(store.root, 'world')
export const worldDir = (store: Store, id: string): string => {
  if (!ID_PATTERN.test(id)) throw new SpecError('name: expected lowercase letters, digits and hyphens, up to 64 characters')
  return join(worldRoot(store), id)
}
const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** A world spec from the paraphrased fixture's provenance, with the author's real next turn from the DB. */
export function worldSpecFromFixture(fixture: FixtureSpec, authorNextTurn: string | null): WorldSpec {
  return parseWorldSpec({
    id: fixture.id,
    kind: fixture.kind,
    project: fixture.provenance.project,
    source_session: fixture.provenance.source_session,
    cutoff_message: fixture.provenance.cutoff_message,
    somewhere: fixture.somewhere,
    expected_outcome_ref: fixture.expected_outcome_ref,
    ...(authorNextTurn !== null ? { author_next_turn_ref: authorNextTurn } : {}),
  })
}

export interface GenerateOptions {
  /** The session DB, opened read-only. */
  db: string
  ids?: readonly string[]
  /** Replace a spec that already exists (the default keeps it, since it may have been edited). */
  force?: boolean
}

export interface GeneratedSpec {
  id: string
  status: 'written' | 'kept'
  has_author_next_turn: boolean
}

/** Writes `world/<id>/spec.json` for each scenario from the fixture specs already in the store. */
export function generateWorldSpecs(store: Store, options: GenerateOptions): GeneratedSpec[] {
  return (options.ids ?? WORLD_SCENARIOS).map((id) => {
    const source = join(store.root, 'fixtures', id, 'spec.json')
    if (!existsSync(source)) throw new SpecError(`fixture ${id}: no spec under the store; build the fixture first`)
    const fixture = parseSpec(JSON.parse(readFileSync(source, 'utf8')))
    const dir = worldDir(store, id)
    const file = join(dir, 'spec.json')
    if (existsSync(file) && !options.force) return { id, status: 'kept' as const, has_author_next_turn: parseWorldSpec(JSON.parse(readFileSync(file, 'utf8'))).author_next_turn_ref !== undefined }
    const next = nextHumanTurn({ db: options.db, session: fixture.provenance.source_session, cutoff: fixture.provenance.cutoff_message })
    const spec = worldSpecFromFixture(fixture, next)
    privateDir(worldRoot(store))
    privateDir(dir)
    writePrivate(file, canonical(spec))
    return { id, status: 'written' as const, has_author_next_turn: next !== null }
  })
}

const nonEmpty = z.string().refine((v) => v.trim() !== '')
const count = z.record(z.string(), z.number())

/** `meta.json` beside a built scenario. The history gate reads `seed_user_turns`, so a missing or empty list is refused instead of passing vacuously. */
const scenarioMetaSchema = z.strictObject({
  schema_version: z.literal(1),
  id: nonEmpty,
  built_at: z.string(),
  cutoff: z.strictObject({ message: nonEmpty, time_ms: z.number() }),
  window: z.strictObject({
    rule: z.enum(['all', 'compaction', 'compaction_over_budget', 'last_n']),
    messages: z.number(),
    first_message: z.string(),
    total_messages: z.number(),
    token_estimate: z.number(),
    budget: z.number(),
    over_budget: z.boolean(),
    compaction_message: z.string().nullable(),
  }),
  dropped: z.strictObject({ total: z.number(), by_type: count }),
  part_types: count,
  seed_user_turns: z.array(nonEmpty).min(1),
  /** Branches the session named, most recent first. */
  branch_hints: z.array(z.string()),
  original_directory: z.string(),
})
export type ScenarioMeta = z.infer<typeof scenarioMetaSchema>

/** Parse, don't validate. The error names the field, never its value: the file is private. */
export function parseScenarioMeta(input: unknown, id: string): ScenarioMeta {
  const parsed = scenarioMetaSchema.safeParse(input)
  if (parsed.success) return parsed.data
  const fields = [...new Set(parsed.error.issues.map((i) => (i.path.length > 0 ? i.path.join('.') : 'meta')))]
  throw new SpecError(`scenario ${id}: meta.json is unusable (${fields.join(', ')}); rebuild it with \`replay world build\``)
}

export const readWorldSpec = (store: Store, id: string): WorldSpec => {
  const file = join(worldDir(store, id), 'spec.json')
  if (!existsSync(file)) throw new SpecError(`scenario ${id}: no spec under the store; run \`replay world specs\` first`)
  const spec = parseWorldSpec(JSON.parse(readFileSync(file, 'utf8')))
  if (spec.id !== id) fail('spec.id', 'the scenario id')
  return spec
}

export interface BuildOptions {
  db: string
  /** Token budget of the history. Default 120k. */
  budget?: number
}

/** Extracts the session up to the cutoff from the DB and writes the real history beside the spec. Rewrites a previous build. */
export function buildWorldScenario(store: Store, id: string, options: BuildOptions): ScenarioMeta {
  const spec = readWorldSpec(store, id)
  const raw = extractSession({ db: options.db, session: spec.source_session, cutoff: spec.cutoff_message })
  const history = buildRealExport(raw, { scenario: id, ...(options.budget ? { budget: options.budget } : {}) })
  assertEndsAtCutoff(history.export, spec.cutoff_message)
  const meta: ScenarioMeta = {
    schema_version: 1,
    id,
    built_at: store.now().toISOString(),
    cutoff: history.cutoff,
    window: history.window,
    dropped: history.dropped,
    part_types: history.part_types,
    seed_user_turns: history.seed_user_turns,
    branch_hints: branchHints(raw),
    original_directory: history.original_directory,
  }
  const dir = worldDir(store, id)
  writePrivate(join(dir, 'export.json'), canonical(history.export))
  writePrivate(join(dir, 'meta.json'), canonical(meta))
  return meta
}

// ── the loader ─────────────────────────────────────────────────────────────

/** What an attempt runs from: a frozen paraphrased fixture satisfies it, and so does a built real-world scenario. */
export interface ReplayFixture {
  spec: { kind: FixtureKind; somewhere: string; turns: readonly Turn[]; substance?: string }
  export: ReplaySeed
  entry: { spec_sha256: string; export_sha256: string }
  /** Texts the first request must hold; default: the spec's user turns. */
  seedUserTurns?: readonly string[]
  world?: WorldJob
  history?: { window: HistoryWindow; dropped: DroppedParts; part_types: Record<string, number> }
}

export interface LoadContext extends CheckoutContext {
  /** Skip the checkout lookup (tests that never clone). */
  noCheckout?: boolean
}

/** Loads a built scenario. Refuses one whose export does not end on its cutoff, or whose repo has no local checkout. */
export function loadWorldFixture(store: Store, id: string, ctx: LoadContext = {}): ReplayFixture {
  const dir = worldDir(store, id)
  const specText = existsSync(join(dir, 'spec.json')) ? readFileSync(join(dir, 'spec.json'), 'utf8') : ''
  const exportFile = join(dir, 'export.json')
  const metaFile = join(dir, 'meta.json')
  if (!specText) throw new SpecError(`scenario ${id}: no spec under the store; run \`replay world specs\` first`)
  if (!existsSync(exportFile) || !existsSync(metaFile)) throw new SpecError(`scenario ${id}: not built; run \`replay world build\``)
  const spec = parseWorldSpec(JSON.parse(specText))
  const exportText = readFileSync(exportFile, 'utf8')
  const seed = JSON.parse(exportText) as ReplaySeed
  const meta = parseScenarioMeta(JSON.parse(readFileSync(metaFile, 'utf8')), id)
  assertEndsAtCutoff(seed, spec.cutoff_message)
  if (meta.cutoff.message !== spec.cutoff_message) throw new SpecError(`scenario ${id}: the built history is for another cutoff; rebuild it`)
  const checkout = ctx.noCheckout ? { github: '', path: '' } : checkoutOf(spec.project, ctx)
  return {
    spec: { kind: spec.kind, somewhere: spec.somewhere, turns: [], substance: spec.substance },
    export: seed,
    entry: { spec_sha256: sha256(specText), export_sha256: sha256(exportText) },
    seedUserTurns: meta.seed_user_turns,
    world: { source: checkout.path, githubRepo: checkout.github, cutoffMs: meta.cutoff.time_ms, hints: meta.branch_hints },
    history: { window: meta.window, dropped: meta.dropped, part_types: meta.part_types },
  }
}

export function listWorldScenarios(store: Store): { id: string; built: boolean }[] {
  const root = worldRoot(store)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'spec.json')))
    .map((e) => ({ id: e.name, built: existsSync(join(root, e.name, 'export.json')) && existsSync(join(root, e.name, 'meta.json')) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
