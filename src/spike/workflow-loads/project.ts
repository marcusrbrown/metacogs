/**
 * The counts projection: the one thing a history count commits. A fixed-key object of counts, enumerated codes and the declaration
 * hash, checked by a strict schema on the way in and on the way out. No session id, stimulus id, message id, path, model id or
 * free text can be in it, and no date: the declared window is the declaration's to state.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'

import { BUCKETS, type CountReport, COVERAGE_NOTES, MODEL_FAMILIES, OUTCOMES } from './count'
import { DEVIATION_CODES, METHODS, WORKFLOW_LOADS_DIR } from './declaration'
import { scanLeaks } from './mask'
import { EXCLUSION_REASONS } from './store'

/** Repo-relative path of the committed projection. */
export const COUNTS_PATH = `${WORKFLOW_LOADS_DIR}/counts.json`
export const PROJECTION_SCHEMA_VERSION = 1

// ── the schema ─────────────────────────────────────────────────────────────

const count = z.number().int().nonnegative()
const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const buckets = z.strictObject({ hit: count, miss: count, loaded_earlier: count, false_fire: count, correct_silence: count })
const perMethod = <T extends z.ZodType>(value: T) => z.strictObject({ counterfactual: value, synthesis: value })

const methodSchema = z
  .strictObject({
    expected_fire: z.strictObject({ accepted_marks: count, hit: count, miss: count, loaded_earlier: count }),
    expected_silence: z.strictObject({ accepted_marks: count, false_fire: count, correct_silence: count }),
    hits_by_basis: z.strictObject({ skill_call: count, direct_read: count }),
    unmarked_loads: count,
  })
  .refine((method) => method.hits_by_basis.skill_call + method.hits_by_basis.direct_read === method.expected_fire.hit, { message: 'hits_by_basis does not add up to the hits', path: ['hits_by_basis'] })

export const projectionSchema = z
  .strictObject({
    schema_version: z.literal(PROJECTION_SCHEMA_VERSION),
    declaration_hash: hex64,
    outcome: z.enum(OUTCOMES),
    coverage_notes: z.array(z.enum(COVERAGE_NOTES)),
    sessions: z.strictObject({
      considered: count,
      eligible: count,
      sampled: count,
      exclusions: z.strictObject({ child_session: count, outside_window: count, excluded_project_root: count, already_sampled: count, no_workflow_load: count, unfinished: count }),
    }),
    stimuli_in_scope: count,
    unreadable_rows: count,
    methods: perMethod(methodSchema),
    model_families: z.strictObject({ anthropic: perMethod(buckets), openai: perMethod(buckets), google: perMethod(buckets), other: perMethod(buckets) }),
    labeling: z.strictObject({ chunks: count, failed: count, not_attempted: count }),
    scrubbed: z.strictObject({ outputs: count, inputs: count, stimuli: count, redacted_emails: count }),
    omissions: z.strictObject({ sample_size: count, found: count }),
    deviations: z.array(z.enum(DEVIATION_CODES)),
  })
  .refine((p) => p.outcome !== 'clean' || p.coverage_notes.length === 0, { message: 'a clean outcome carries no coverage note', path: ['coverage_notes'] })
  .refine((p) => p.outcome !== 'inconclusive' || p.coverage_notes.length > 0, { message: 'an inconclusive outcome names what was thin', path: ['coverage_notes'] })
  .refine((p) => p.unreadable_rows === 0 || p.coverage_notes.includes('unreadable_rows'), { message: 'unreadable rows are named among the coverage notes', path: ['coverage_notes'] })

export type Projection = z.infer<typeof projectionSchema>

// ── projecting ─────────────────────────────────────────────────────────────

/** The fixed-key projection of a report. Parsed against the schema before it is returned, so a field that is not a count or a code throws. */
export function projectCounts(report: CountReport): Projection {
  const { counts } = report
  const methods = Object.fromEntries(
    METHODS.map((method) => {
      const m = counts.methods[method]
      return [
        method,
        {
          expected_fire: { accepted_marks: m.accepted.expected_fire, hit: m.buckets.hit, miss: m.buckets.miss, loaded_earlier: m.buckets.loaded_earlier },
          expected_silence: { accepted_marks: m.accepted.expected_silence, false_fire: m.buckets.false_fire, correct_silence: m.buckets.correct_silence },
          hits_by_basis: { skill_call: m.hitsByBasis.skill_call, direct_read: m.hitsByBasis.direct_read },
          unmarked_loads: m.unmarkedLoads,
        },
      ]
    }),
  )
  const bucketCounts = (source: Record<(typeof BUCKETS)[number], number>) => Object.fromEntries(BUCKETS.map((bucket) => [bucket, source[bucket]]))
  const families = Object.fromEntries(MODEL_FAMILIES.map((family) => [family, Object.fromEntries(METHODS.map((method) => [method, bucketCounts(counts.families[family][method])]))]))
  return projectionSchema.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    declaration_hash: report.declarationHash,
    outcome: report.outcome,
    coverage_notes: report.notes,
    sessions: {
      considered: report.sample.considered,
      eligible: report.sample.eligible,
      sampled: report.sample.sampled,
      exclusions: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, report.sample.exclusions[reason]])),
    },
    stimuli_in_scope: counts.stimuli,
    unreadable_rows: report.unreadableRows,
    methods,
    model_families: families,
    labeling: { chunks: report.coverage.chunks, failed: report.coverage.failed, not_attempted: report.coverage.notAttempted },
    scrubbed: { outputs: report.scrubbed.scrubbedOutputs, inputs: report.scrubbed.scrubbedInputs, stimuli: report.scrubbed.scrubbedStimuli, redacted_emails: report.scrubbed.redactedEmails },
    omissions: { sample_size: report.omissions.sampleSize, found: report.omissions.found },
    deviations: report.deviations,
  })
}

/** The committed file's text: the projection as indented JSON with one trailing newline. */
export const projectionText = (projection: Projection): string => `${JSON.stringify(projection, null, 2)}\n`

/**
 * Writes the projection to `path` (parent directories created), and only there. The schema runs first, so an invalid projection
 * throws and nothing is written. The text goes to a temporary file in the same directory and is renamed into place, so a failed
 * write leaves an existing file as it was; the temporary file is removed on failure. Callers pass the path: tests use a temporary
 * repository.
 */
export function writeProjection(path: string, projection: Projection): void {
  const text = projectionText(projectionSchema.parse(projection))
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, text, { flag: 'wx' })
    renameSync(temporary, path)
  } catch (e) {
    rmSync(temporary, { force: true })
    throw e
  }
}

// ── the table ──────────────────────────────────────────────────────────────

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`
const NONE = '–'

/**
 * The README's counts, generated from the projection and nothing else: the outcome with its notes, the buckets per method and
 * label, hits by basis and unmarked loads, the buckets per model family, and the sample, labeling and scrub totals. Ends with a
 * newline. Small counts are directions, not rates; the README says so beside this table.
 */
export function renderCountsTable(projection: Projection): string {
  const lines: string[] = []
  lines.push(`Outcome: ${projection.outcome}; coverage notes: ${projection.coverage_notes.length > 0 ? projection.coverage_notes.join(', ') : 'none'}`)
  lines.push('')
  lines.push(row(['Method', 'Label', 'Accepted marks', 'Hit', 'Miss', 'Loaded earlier', 'False fire', 'Correct silence']))
  lines.push(row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:']))
  for (const method of METHODS) {
    const m = projection.methods[method]
    lines.push(row([method, 'expected_fire', m.expected_fire.accepted_marks, m.expected_fire.hit, m.expected_fire.miss, m.expected_fire.loaded_earlier, NONE, NONE]))
    lines.push(row([method, 'expected_silence', m.expected_silence.accepted_marks, NONE, NONE, NONE, m.expected_silence.false_fire, m.expected_silence.correct_silence]))
  }
  lines.push('')
  lines.push(row(['Method', 'Hits by skill call', 'Hits by direct read', 'Unmarked loads']))
  lines.push(row(['---', '---:', '---:', '---:']))
  for (const method of METHODS) {
    const m = projection.methods[method]
    lines.push(row([method, m.hits_by_basis.skill_call, m.hits_by_basis.direct_read, m.unmarked_loads]))
  }
  lines.push('')
  lines.push(row(['Model family', 'Method', 'Hit', 'Miss', 'Loaded earlier', 'False fire', 'Correct silence']))
  lines.push(row(['---', '---', '---:', '---:', '---:', '---:', '---:']))
  for (const family of MODEL_FAMILIES) {
    for (const method of METHODS) lines.push(row([family, method, ...BUCKETS.map((bucket) => projection.model_families[family][method][bucket])]))
  }
  lines.push('')
  lines.push(row(['Sessions considered', 'Eligible', 'Sampled', 'Stimuli in scope', 'Omission sample', 'Omissions found', 'Unreadable rows']))
  lines.push(row(['---:', '---:', '---:', '---:', '---:', '---:', '---:']))
  lines.push(row([projection.sessions.considered, projection.sessions.eligible, projection.sessions.sampled, projection.stimuli_in_scope, projection.omissions.sample_size, projection.omissions.found, projection.unreadable_rows]))
  lines.push('')
  lines.push(row(['Child session', 'Outside window', 'Excluded project root', 'Already sampled', 'No workflow load', 'Unfinished']))
  lines.push(row(['---:', '---:', '---:', '---:', '---:', '---:']))
  const e = projection.sessions.exclusions
  lines.push(row([e.child_session, e.outside_window, e.excluded_project_root, e.already_sampled, e.no_workflow_load, e.unfinished]))
  lines.push('')
  lines.push(row(['Labeling chunks', 'Failed', 'Not attempted', 'Scrubbed outputs', 'Scrubbed inputs', 'Scrubbed stimuli', 'Redacted emails']))
  lines.push(row(['---:', '---:', '---:', '---:', '---:', '---:', '---:']))
  lines.push(row([projection.labeling.chunks, projection.labeling.failed, projection.labeling.not_attempted, projection.scrubbed.outputs, projection.scrubbed.inputs, projection.scrubbed.stimuli, projection.scrubbed.redacted_emails]))
  lines.push('')
  lines.push(`Deviations: ${projection.deviations.length > 0 ? projection.deviations.join(', ') : 'none'}`)
  lines.push(`Declaration hash: ${projection.declaration_hash}`)
  return `${lines.join('\n')}\n`
}

// ── the leak scan ──────────────────────────────────────────────────────────

export class ProjectionRefusal extends Error {
  constructor(
    readonly reason: 'leak_found',
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'ProjectionRefusal'
  }
}

export interface ProjectionRenderers {
  json: (projection: Projection) => string
  table: (projection: Projection) => string
}

/**
 * The file text and the table, after the leak scan. The two method names are keys of the projection and words of the table, so
 * the method kind of the leak list is left out of this scan on purpose; the helper's path and the labelled reply lines stay in
 * it. Throws `leak_found` naming the entries found, never the text around them. `render` is a seam for tests.
 */
export function renderProjection(projection: Projection, render: ProjectionRenderers = { json: projectionText, table: renderCountsTable }): { json: string; table: string } {
  const json = render.json(projection)
  const table = render.table(projection)
  const hits = [...scanLeaks(json), ...scanLeaks(table)].filter((hit) => hit.kind !== 'method')
  if (hits.length > 0) throw new ProjectionRefusal('leak_found', `the projection text holds ${[...new Set(hits.map((hit) => hit.entry))].join(', ')}`)
  return { json, table }
}
