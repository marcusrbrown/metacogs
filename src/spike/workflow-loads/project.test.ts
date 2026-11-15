import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { BUCKETS, type CountReport, COVERAGE_NOTES, MODEL_FAMILIES } from './count'
import { main } from './cli'
import { DEVIATION_CODES, METHODS, WORKFLOW_LOADS_DIR } from './declaration'
import type { LabelerTransport } from './labeler'
import { scanLeaks } from './mask'
import { COUNTS_PATH, projectCounts, type Projection, PROJECTION_SCHEMA_VERSION, ProjectionRefusal, projectionSchema, projectionText, renderCountsTable, renderProjection, writeProjection } from './project'
import { EXCLUDED_ROOT, gatedRepo, seedWorkflowSession, syntheticStore } from './test-support'

const HASH = 'ab'.repeat(32)

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

const zero = () => ({ hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 0 })

/** A report with synthetic numbers; every field is a distinct small count so a swapped field shows. */
function sampleReport(overrides: Partial<CountReport> = {}): CountReport {
  return {
    declarationHash: HASH,
    deviations: ['masking_fix', 'session_cap_raise'],
    outcome: 'errors_observed',
    notes: ['minimum_unmet', 'labeling_incomplete', 'unreadable_rows'],
    counts: {
      stimuli: 310,
      methods: {
        counterfactual: {
          accepted: { expected_fire: 6, expected_silence: 4 },
          buckets: { hit: 2, miss: 3, loaded_earlier: 1, false_fire: 1, correct_silence: 3 },
          hitsByBasis: { skill_call: 1, direct_read: 1 },
          unmarkedLoads: 5,
        },
        synthesis: {
          accepted: { expected_fire: 7, expected_silence: 2 },
          buckets: { hit: 4, miss: 2, loaded_earlier: 1, false_fire: 0, correct_silence: 2 },
          hitsByBasis: { skill_call: 4, direct_read: 0 },
          unmarkedLoads: 0,
        },
      },
      families: {
        anthropic: { counterfactual: { hit: 2, miss: 1, loaded_earlier: 1, false_fire: 1, correct_silence: 3 }, synthesis: { hit: 4, miss: 2, loaded_earlier: 1, false_fire: 0, correct_silence: 1 } },
        openai: { counterfactual: { hit: 0, miss: 2, loaded_earlier: 0, false_fire: 0, correct_silence: 0 }, synthesis: { ...zero(), correct_silence: 1 } },
        google: { counterfactual: zero(), synthesis: zero() },
        other: { counterfactual: zero(), synthesis: zero() },
      },
    },
    sample: { considered: 120, eligible: 41, sampled: 40, exclusions: { child_session: 30, outside_window: 12, excluded_project_root: 4, already_sampled: 0, no_workflow_load: 33, unfinished: 2 } },
    unreadableRows: 3,
    coverage: { chunks: 30, labeled: 29, failed: 1, notAttempted: 0, spendCapReached: false, transportOutage: 0 },
    scrubbed: { scrubbedOutputs: 5, scrubbedInputs: 2, scrubbedStimuli: 1, redactedEmails: 3 },
    omissions: { sampleSize: 20, found: 1 },
    slots: ['initial'],
    ...overrides,
  }
}

/** Every path (as a list of keys) to an object and to a string in a JSON value. */
function walk(value: unknown, path: string[] = [], objects: string[][] = [], strings: string[][] = []): { objects: string[][]; strings: string[][] } {
  if (typeof value === 'string') strings.push(path)
  else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...path, String(i)], objects, strings))
  else if (typeof value === 'object' && value !== null) {
    objects.push(path)
    for (const [key, item] of Object.entries(value)) walk(item, [...path, key], objects, strings)
  }
  return { objects, strings }
}

function withAt(value: unknown, path: readonly string[], change: (target: Record<string, unknown>, key: string) => void): unknown {
  const copy = structuredClone(value) as Record<string, unknown>
  let target: Record<string, unknown> = copy
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
  change(target, path.at(-1) ?? '')
  return copy
}

describe('projectCounts: the fixed-key projection', () => {
  test('has exactly this shape, from the report', () => {
    expect(projectCounts(sampleReport())).toEqual({
      schema_version: 1,
      declaration_hash: HASH,
      outcome: 'errors_observed',
      coverage_notes: ['minimum_unmet', 'labeling_incomplete', 'unreadable_rows'],
      sessions: { considered: 120, eligible: 41, sampled: 40, exclusions: { child_session: 30, outside_window: 12, excluded_project_root: 4, already_sampled: 0, no_workflow_load: 33, unfinished: 2 } },
      stimuli_in_scope: 310,
      unreadable_rows: 3,
      methods: {
        counterfactual: {
          expected_fire: { accepted_marks: 6, hit: 2, miss: 3, loaded_earlier: 1 },
          expected_silence: { accepted_marks: 4, false_fire: 1, correct_silence: 3 },
          hits_by_basis: { skill_call: 1, direct_read: 1 },
          unmarked_loads: 5,
        },
        synthesis: {
          expected_fire: { accepted_marks: 7, hit: 4, miss: 2, loaded_earlier: 1 },
          expected_silence: { accepted_marks: 2, false_fire: 0, correct_silence: 2 },
          hits_by_basis: { skill_call: 4, direct_read: 0 },
          unmarked_loads: 0,
        },
      },
      model_families: {
        anthropic: { counterfactual: { hit: 2, miss: 1, loaded_earlier: 1, false_fire: 1, correct_silence: 3 }, synthesis: { hit: 4, miss: 2, loaded_earlier: 1, false_fire: 0, correct_silence: 1 } },
        openai: { counterfactual: { hit: 0, miss: 2, loaded_earlier: 0, false_fire: 0, correct_silence: 0 }, synthesis: { hit: 0, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 1 } },
        google: { counterfactual: zero(), synthesis: zero() },
        other: { counterfactual: zero(), synthesis: zero() },
      },
      labeling: { chunks: 30, failed: 1, not_attempted: 0, transport_outage: 0 },
      scrubbed: { outputs: 5, inputs: 2, stimuli: 1, redacted_emails: 3 },
      omissions: { sample_size: 20, found: 1 },
      deviations: ['masking_fix', 'session_cap_raise'],
    } satisfies Projection)
  })

  test('the keys follow the declared lists, so a new method, family or bucket cannot slip in unnamed', () => {
    const projection = projectCounts(sampleReport())
    expect(Object.keys(projection.methods)).toEqual([...METHODS])
    expect(Object.keys(projection.model_families)).toEqual([...MODEL_FAMILIES])
    for (const family of MODEL_FAMILIES) expect(Object.keys(projection.model_families[family])).toEqual([...METHODS])
    for (const method of METHODS) {
      const fixed = [...Object.keys(projection.methods[method].expected_fire), ...Object.keys(projection.methods[method].expected_silence)].filter((key) => key !== 'accepted_marks')
      expect(fixed).toEqual([...BUCKETS])
    }
  })

  test('every string in a projection is an enumerated value or a hex hash, and none is long', () => {
    const projection = projectCounts(sampleReport({ outcome: 'inconclusive', notes: [...COVERAGE_NOTES], deviations: [...DEVIATION_CODES] }))
    const enumerated = new Set<string>([...METHODS, ...MODEL_FAMILIES, ...COVERAGE_NOTES, ...DEVIATION_CODES, 'errors_observed', 'clean', 'inconclusive'])
    const { strings } = walk(projection)
    for (const path of strings) {
      const text = path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], projection) as string
      // keys are not strings in the value tree; only values are checked here
      expect(enumerated.has(text) || /^[0-9a-f]{64}$/.test(text)).toBe(true)
      expect(text.length).toBeLessThanOrEqual(64)
    }
  })

  test('a count that comes from the report of two slots is the report count, not a per-slot one', () => {
    expect(projectCounts(sampleReport({ slots: ['initial', 'added'] })).stimuli_in_scope).toBe(310)
  })

  test('the outcome, notes and deviations are carried as given', () => {
    const projection = projectCounts(sampleReport({ outcome: 'clean', notes: [], deviations: [], unreadableRows: 0 }))
    expect(projection).toMatchObject({ outcome: 'clean', coverage_notes: [], deviations: [] })
  })

  test('the deviation codes come in the order they were recorded', () => {
    expect(projectCounts(sampleReport({ deviations: ['labeler_change', 'masking_fix'] })).deviations).toEqual(['labeler_change', 'masking_fix'])
  })
})

describe('the projection schema', () => {
  const valid = (): unknown => JSON.parse(projectionText(projectCounts(sampleReport())))

  test('accepts the projection it wrote, and the version is the current one', () => {
    expect(projectionSchema.safeParse(valid()).success).toBe(true)
    expect(PROJECTION_SCHEMA_VERSION).toBe(1)
  })

  test('rejects an unknown key at every object level', () => {
    const { objects } = walk(valid())
    expect(objects.length).toBeGreaterThan(10)
    for (const path of objects) {
      const changed = withAt(valid(), [...path, 'extra'], (target, key) => {
        target[key] = 1
      })
      expect(projectionSchema.safeParse(changed).success).toBe(false)
    }
  })

  test('rejects a missing key at every object level', () => {
    const { objects } = walk(valid())
    for (const path of objects) {
      const keys = Object.keys(path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], valid()) as Record<string, unknown>)
      for (const key of keys) {
        const changed = withAt(valid(), [...path, key], (target, k) => {
          delete target[k]
        })
        expect(projectionSchema.safeParse(changed).success).toBe(false)
      }
    }
  })

  test('rejects a session id, a message id, free text or an over-long string wherever a string stands', () => {
    const { strings } = walk(valid())
    expect(strings.length).toBeGreaterThan(0)
    for (const path of strings) {
      for (const bad of ['ses_01H8YQK3N4', 'msg_0a0000001001AAAAAAAAAAAAAA/prt_x', 'the user asked about the deploy', 'x'.repeat(200), 'a'.repeat(64) + 'b', '']) {
        const changed = withAt(valid(), path, (target, key) => {
          target[key] = bad
        })
        expect(projectionSchema.safeParse(changed).success).toBe(false)
      }
    }
  })

  test('rejects a string in an array of notes or deviations that is not a code', () => {
    for (const field of ['coverage_notes', 'deviations'] as const) {
      const changed = withAt(valid(), [field], (target, key) => {
        target[key] = ['not_a_code']
      })
      expect(projectionSchema.safeParse(changed).success).toBe(false)
    }
  })

  test('rejects a count that is negative, fractional or not a number, wherever a count stands', () => {
    const countPaths: string[][] = []
    const visit = (value: unknown, path: string[]): void => {
      if (typeof value === 'number') countPaths.push(path)
      else if (typeof value === 'object' && value !== null && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) visit(v, [...path, k])
    }
    const base = valid() as Record<string, unknown>
    visit(base, [])
    expect(countPaths.length).toBeGreaterThan(40)
    for (const path of countPaths) {
      if (path.join('.') === 'schema_version') continue
      for (const bad of [-1, 1.5, '3']) {
        const changed = withAt(base, path, (target, key) => {
          target[key] = bad
        })
        expect(projectionSchema.safeParse(changed).success).toBe(false)
      }
    }
  })

  test('rejects another schema version, a non-hex declaration hash and a non-enumerated outcome', () => {
    for (const [key, bad] of [['schema_version', 2], ['declaration_hash', 'A'.repeat(64)], ['declaration_hash', HASH.slice(1)], ['outcome', 'passed']] as const) {
      const changed = withAt(valid(), [key], (target, k) => {
        target[k] = bad
      })
      expect(projectionSchema.safeParse(changed).success).toBe(false)
    }
  })

  test('rejects hits by basis that do not add up to the hits', () => {
    const changed = withAt(valid(), ['methods', 'counterfactual', 'hits_by_basis', 'skill_call'], (target, key) => {
      target[key] = 9
    })
    expect(projectionSchema.safeParse(changed).success).toBe(false)
  })

  test('rejects a clean outcome that carries a note, and an inconclusive one that carries none', () => {
    const clean = withAt(withAt(valid(), ['outcome'], (t, k) => (t[k] = 'clean')), ['coverage_notes'], (t, k) => (t[k] = ['minimum_unmet']))
    expect(projectionSchema.safeParse(clean).success).toBe(false)
    const inconclusive = withAt(withAt(valid(), ['outcome'], (t, k) => (t[k] = 'inconclusive')), ['coverage_notes'], (t, k) => (t[k] = []))
    expect(projectionSchema.safeParse(inconclusive).success).toBe(false)
  })

  test('rejects unreadable rows with no note to say so: the count and its note go together', () => {
    const silent = withAt(withAt(valid(), ['coverage_notes'], (t, k) => (t[k] = ['minimum_unmet'])), ['unreadable_rows'], (t, k) => (t[k] = 4))
    expect(projectionSchema.safeParse(silent).success).toBe(false)
    const noted = withAt(withAt(valid(), ['coverage_notes'], (t, k) => (t[k] = ['unreadable_rows'])), ['unreadable_rows'], (t, k) => (t[k] = 4))
    expect(projectionSchema.safeParse(noted).success).toBe(true)
  })

  test('rejects chunks stopped by a proxy outage with no note to say so: the count and its note go together', () => {
    const silent = withAt(withAt(valid(), ['coverage_notes'], (t, k) => (t[k] = ['unreadable_rows'])), ['labeling', 'transport_outage'], (t, k) => (t[k] = 2))
    expect(projectionSchema.safeParse(silent).success).toBe(false)
    const noted = withAt(withAt(valid(), ['coverage_notes'], (t, k) => (t[k] = ['unreadable_rows', 'transport_outage'])), ['labeling', 'transport_outage'], (t, k) => (t[k] = 2))
    expect(projectionSchema.safeParse(noted).success).toBe(true)
  })

  test('the outage count and note come through from the report, and its count shows in the table', () => {
    const projection = projectCounts(
      sampleReport({ outcome: 'inconclusive', notes: ['labeling_incomplete', 'transport_outage'], unreadableRows: 0, coverage: { chunks: 30, labeled: 26, failed: 1, notAttempted: 3, spendCapReached: false, transportOutage: 3 } }),
    )
    expect(projection.labeling).toEqual({ chunks: 30, failed: 1, not_attempted: 3, transport_outage: 3 })
    expect(projection.coverage_notes).toEqual(['labeling_incomplete', 'transport_outage'])
    expect(renderCountsTable(projection)).toContain('| 30 | 1 | 3 | 3 | 5 | 2 | 1 | 3 |')
  })

  test('projectCounts refuses a report that carries text where a code belongs', () => {
    const junk = sampleReport({ deviations: ['a masking fix for session ses_123' as never] })
    expect(() => projectCounts(junk)).toThrow()
    expect(() => projectCounts(sampleReport({ notes: ['see ses_123' as never] }))).toThrow()
    expect(() => projectCounts(sampleReport({ declarationHash: 'ses_123' }))).toThrow()
  })
})

describe('writing the projection', () => {
  test('writes counts.json only at the given path, as the schema-checked projection, with a trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-project-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const target = join(dir, 'nested', 'counts.json')
    const projection = projectCounts(sampleReport())
    writeProjection(target, projection)
    const text = readFileSync(target, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(projection)
    expect(text).toBe(projectionText(projection))
    expect(readdirSync(dir)).toEqual(['nested'])
    expect(readdirSync(join(dir, 'nested'))).toEqual(['counts.json'])
  })

  test('refuses a projection that is not valid, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-project-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const bad = { ...projectCounts(sampleReport()), extra: 'ses_123' } as unknown as Projection
    expect(() => writeProjection(join(dir, 'counts.json'), bad)).toThrow()
    expect(existsSync(join(dir, 'counts.json'))).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)('a write that fails leaves an existing counts file byte-identical and no temporary file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-project-'))
    cleanup.push(() => {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    })
    const target = join(dir, 'counts.json')
    const earlier = projectionText(projectCounts(sampleReport({ outcome: 'clean', notes: [], deviations: [], unreadableRows: 0 })))
    writeFileSync(target, earlier)
    // the file itself stays writable, so only a write that goes through a new file in the directory is stopped
    chmodSync(dir, 0o500)
    expect(() => writeProjection(target, projectCounts(sampleReport()))).toThrow()
    chmodSync(dir, 0o700)
    expect(readFileSync(target, 'utf8')).toBe(earlier)
    expect(readdirSync(dir)).toEqual(['counts.json'])
  })

  test('a rename that fails removes the temporary file and leaves the target as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-project-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    // a directory where the file belongs: the projection is written, but cannot be renamed over it
    mkdirSync(join(dir, 'counts.json'))
    writeFileSync(join(dir, 'counts.json', 'keep'), 'kept')
    expect(() => writeProjection(join(dir, 'counts.json'), projectCounts(sampleReport()))).toThrow()
    expect(readdirSync(dir)).toEqual(['counts.json'])
    expect(readdirSync(join(dir, 'counts.json'))).toEqual(['keep'])
    expect(readFileSync(join(dir, 'counts.json', 'keep'), 'utf8')).toBe('kept')
  })

  test('the default path is the committed spike directory', () => {
    expect(COUNTS_PATH).toBe(`${WORKFLOW_LOADS_DIR}/counts.json`)
  })
})

describe('the counts table', () => {
  const projection = projectCounts(sampleReport())

  test('is generated from the projection alone, as text with the numbers in their rows', () => {
    const table = renderCountsTable(projection)
    expect(table).toBe(renderCountsTable(structuredClone(projection)))
    expect(table).toContain('Outcome: errors_observed; coverage notes: minimum_unmet, labeling_incomplete, unreadable_rows')
    expect(table).toContain('| counterfactual | expected_fire | 6 | 2 | 3 | 1 | – | – |')
    expect(table).toContain('| counterfactual | expected_silence | 4 | – | – | – | 1 | 3 |')
    expect(table).toContain('| synthesis | expected_fire | 7 | 4 | 2 | 1 | – | – |')
    expect(table).toContain('| synthesis | expected_silence | 2 | – | – | – | 0 | 2 |')
    expect(table).toContain('| counterfactual | 1 | 1 | 5 |')
    expect(table).toContain('| anthropic | counterfactual | 2 | 1 | 1 | 1 | 3 |')
    expect(table).toContain('| 120 | 41 | 40 | 310 | 20 | 1 | 3 |')
    expect(table).toContain('| 30 | 12 | 4 | 0 | 33 | 2 |')
    expect(table).toContain('Unfinished')
    expect(table).toContain('Unreadable rows')
    expect(table).toContain('| 30 | 1 | 0 | 0 | 5 | 2 | 1 | 3 |')
    expect(table).toContain('Stopped by outage')
    expect(table).toContain('Deviations: masking_fix, session_cap_raise')
    expect(table).toContain(`Declaration hash: ${HASH}`)
    expect(table.endsWith('\n')).toBe(true)
  })

  test('names no notes and no deviations as "none"', () => {
    const table = renderCountsTable(projectCounts(sampleReport({ outcome: 'clean', notes: [], deviations: [], unreadableRows: 0 })))
    expect(table).toContain('Outcome: clean; coverage notes: none')
    expect(table).toContain('Deviations: none')
  })

  test('holds nothing from the leak list but the method names the projection itself keys on', () => {
    expect(scanLeaks(renderCountsTable(projection)).filter((hit) => hit.kind !== 'method')).toEqual([])
    expect(scanLeaks(projectionText(projection)).filter((hit) => hit.kind !== 'method')).toEqual([])
  })
})

describe('rendering the projection for output', () => {
  const projection = projectCounts(sampleReport())

  test('returns the file text and the table when the leak scan finds nothing, method names being keys of the projection', () => {
    const rendered = renderProjection(projection)
    expect(rendered.json).toBe(projectionText(projection))
    expect(rendered.table).toBe(renderCountsTable(projection))
    expect(scanLeaks(rendered.json).some((hit) => hit.kind === 'method')).toBe(true)
  })

  test('refuses when either text holds the record helper path or a labelled reply line, naming the entry and not the text around it', () => {
    for (const [field, planted, entry] of [
      ['json', 'see scripts/record.mjs for it', 'record.mjs'],
      ['table', 'Flip test: something', 'Flip test:'],
      ['table', 'x Perspectives: y', 'Perspectives:'],
    ] as const) {
      const render = { json: (p: Projection) => (field === 'json' ? `${projectionText(p)}${planted}` : projectionText(p)), table: (p: Projection) => (field === 'table' ? `${renderCountsTable(p)}${planted}` : renderCountsTable(p)) }
      let refusal: unknown
      try {
        renderProjection(projection, render)
      } catch (e) {
        refusal = e
      }
      expect(refusal).toBeInstanceOf(ProjectionRefusal)
      expect((refusal as ProjectionRefusal).reason).toBe('leak_found')
      expect((refusal as ProjectionRefusal).message).toContain(entry)
      expect((refusal as ProjectionRefusal).message).not.toContain('see scripts')
    }
  })

  test('a method name alone is never a refusal', () => {
    const render = { json: projectionText, table: (p: Projection) => `${renderCountsTable(p)}\ncounterfactual synthesis\n` }
    expect(() => renderProjection(projection, render)).not.toThrow()
  })
})

// ── the whole path, over a synthetic store ─────────────────────────────────

const ENDPOINT = 'https://proxy.example.invalid/v1'
type Proposed = { stimulus_id: string; method: 'counterfactual' | 'synthesis'; label: 'expected_fire' | 'expected_silence' }

/** A labeler that answers each chunk from a table of stimulus id to proposals. */
function scriptedLabeler(table: Record<string, Pick<Proposed, 'method' | 'label'>>): LabelerTransport {
  return {
    endpoint: ENDPOINT,
    async complete(request) {
      const ids = (/^stimulus_ids: (.*)$/m.exec(request.user)?.[1] ?? '').split(', ').filter(Boolean)
      const proposals = ids.flatMap((id) => {
        const entry = table[id]
        return entry ? [{ stimulus_id: id, method: entry.method, label: entry.label, reason: 'a scripted reason' }] : []
      })
      return { text: JSON.stringify({ proposals }) }
    },
  }
}

describe('end to end: freeze, view, label, judge, lock, count, project, purge', () => {
  test('a synthetic store with a scripted labeler and scripted judgments gives the expected projection and table', async () => {
    const { repo } = gatedRepo({
      window: { start: '2020-01-01', end: '2030-12-31' },
      omission: { sample_size: 1, limit: 0 },
      min_accepted_marks: { counterfactual: { expected_fire: 1, expected_silence: 1 }, synthesis: { expected_fire: 1, expected_silence: 2 } },
    })
    repo.write('skills/counterfactual/SKILL.md', 'body of counterfactual\n')
    repo.write('skills/synthesis/SKILL.md', 'body of synthesis\n')
    repo.commit('skills', ['skills/counterfactual/SKILL.md', 'skills/synthesis/SKILL.md'])
    const store = syntheticStore()
    const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-e2e-'))
    cleanup.push(() => {
      store.destroy()
      repo.destroy()
      rmSync(dir, { recursive: true, force: true })
    })

    const anthropic = { providerID: 'anthropic', modelID: 'claude-x' }
    const openai = { providerID: 'openai', modelID: 'gpt-x' }
    const user = (session: string, text: string): string => {
      const id = store.addMessage(session, 'user')
      store.addText(id, text)
      return id
    }

    // sampled session one: the first assistant message is another family, so the interval's own message must decide
    seedWorkflowSession(store, { id: 'ses_alpha', created: '2026-01-15', assistantData: { providerID: 'google', modelID: 'gemini-x' } })
    const a1 = user('ses_alpha', 'question one')
    store.addSkillCall(store.addMessage('ses_alpha', 'assistant', anthropic), 'counterfactual')
    const a2 = user('ses_alpha', 'question two')
    store.addRead(store.addMessage('ses_alpha', 'assistant', anthropic), '/pkg/skills/synthesis/SKILL.md', 'body of synthesis')
    const a3 = user('ses_alpha', 'question three')
    store.addText(store.addMessage('ses_alpha', 'assistant', anthropic), 'an answer')
    // sampled session two: the last stimulus has no assistant message after it, so the session's first one decides
    seedWorkflowSession(store, { id: 'ses_beta', created: '2026-01-16', assistantData: openai })
    const b1 = user('ses_beta', 'question four')
    store.addText(store.addMessage('ses_beta', 'assistant', openai), 'an answer')
    const b2 = user('ses_beta', 'question five')
    const answer = store.addMessage('ses_beta', 'assistant', openai)
    store.addSkillCall(answer, 'counterfactual')
    store.addSkillCall(answer, 'synthesis')
    const b3 = user('ses_beta', 'question six')
    // sessions the sample leaves out, one per reason
    store.addSession({ id: 'ses_child', created: '2026-01-15', parent: 'ses_alpha' })
    seedWorkflowSession(store, { id: 'ses_old', created: '2019-06-01' })
    seedWorkflowSession(store, { id: 'ses_excluded', created: '2026-01-15', directory: EXCLUDED_ROOT })
    store.addSession({ id: 'ses_plain', created: '2026-01-15' })
    store.addText(store.addMessage('ses_plain', 'user'), 'no workflow here')

    const privateRoot = join(dir, 'state')
    const flags = ['--db', store.path, '--private-root', privateRoot, '--repo-root', repo.dir]
    const out: string[] = []
    const err: string[] = []
    const run = async (argv: string[], options: { input?: string; transport?: LabelerTransport } = {}): Promise<number> => {
      const input = new PassThrough()
      input.end(options.input ?? '')
      return main([...argv, ...flags], { out: (l) => out.push(l), err: (l) => err.push(l), input, terminal: { write: () => undefined }, allowNonTerminal: true, git: repo.git, env: {}, ...(options.transport ? { label: { transport: options.transport } } : {}) })
    }

    expect(await run(['freeze'])).toBe(0)
    expect(await run(['view'])).toBe(0)
    const labeler = scriptedLabeler({
      [a1]: { method: 'counterfactual', label: 'expected_fire' },
      [a2]: { method: 'synthesis', label: 'expected_silence' },
      [a3]: { method: 'counterfactual', label: 'expected_fire' },
      [b1]: { method: 'synthesis', label: 'expected_fire' },
      [b3]: { method: 'counterfactual', label: 'expected_silence' },
    })
    expect(await run(['label'], { transport: labeler })).toBe(0)
    // five proposal items, all accepted; one omission stimulus (b2, the only one unproposed): counterfactual should fire, synthesis neither
    expect(await run(['judge'], { input: `${'a\n'.repeat(5)}f\nn\n` })).toBe(0)
    expect(await run(['lock'])).toBe(0)

    out.length = 0
    expect(await run(['count'])).toBe(0)
    expect(err).toEqual([])
    const counted = out.join('\n')
    expect(counted).toContain('count outcome=errors_observed notes=minimum_unmet,omission_limit_exceeded')

    out.length = 0
    expect(await run(['project'])).toBe(0)
    expect(err).toEqual([])
    const file = join(repo.dir, COUNTS_PATH)
    const written = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const expected: Projection = {
      schema_version: 1,
      declaration_hash: (written as Projection).declaration_hash,
      outcome: 'errors_observed',
      coverage_notes: ['minimum_unmet', 'omission_limit_exceeded'],
      sessions: { considered: 6, eligible: 2, sampled: 2, exclusions: { child_session: 1, outside_window: 1, excluded_project_root: 1, already_sampled: 0, no_workflow_load: 1, unfinished: 0 } },
      stimuli_in_scope: 6,
      unreadable_rows: 0,
      methods: {
        counterfactual: {
          expected_fire: { accepted_marks: 3, hit: 2, miss: 0, loaded_earlier: 1 },
          expected_silence: { accepted_marks: 1, false_fire: 0, correct_silence: 1 },
          hits_by_basis: { skill_call: 2, direct_read: 0 },
          unmarked_loads: 0,
        },
        synthesis: {
          expected_fire: { accepted_marks: 1, hit: 0, miss: 1, loaded_earlier: 0 },
          expected_silence: { accepted_marks: 1, false_fire: 1, correct_silence: 0 },
          hits_by_basis: { skill_call: 0, direct_read: 0 },
          unmarked_loads: 1,
        },
      },
      model_families: {
        anthropic: { counterfactual: { hit: 1, miss: 0, loaded_earlier: 1, false_fire: 0, correct_silence: 0 }, synthesis: { hit: 0, miss: 0, loaded_earlier: 0, false_fire: 1, correct_silence: 0 } },
        openai: { counterfactual: { hit: 1, miss: 0, loaded_earlier: 0, false_fire: 0, correct_silence: 1 }, synthesis: { hit: 0, miss: 1, loaded_earlier: 0, false_fire: 0, correct_silence: 0 } },
        google: { counterfactual: zero(), synthesis: zero() },
        other: { counterfactual: zero(), synthesis: zero() },
      },
      labeling: { chunks: 2, failed: 0, not_attempted: 0, transport_outage: 0 },
      scrubbed: { outputs: 0, inputs: 0, stimuli: 0, redacted_emails: 0 },
      omissions: { sample_size: 1, found: 1 },
      deviations: [],
    }
    expect(written).toEqual(expected)
    expect(projectionSchema.safeParse(written).success).toBe(true)
    const table = out.join('\n')
    expect(table).toContain(renderCountsTable(expected))
    expect(table).toContain('| counterfactual | expected_fire | 3 | 2 | 0 | 1 | – | – |')
    expect(table).toContain('| synthesis | expected_silence | 1 | – | – | – | 1 | 0 |')

    // nothing session-derived reached the file, the table or the status lines
    const everything = [readFileSync(file, 'utf8'), table, counted, ...out, ...err].join('\n')
    for (const id of [a1, a2, a3, b1, b2, b3, 'ses_', 'question', EXCLUDED_ROOT]) expect(everything).not.toContain(id)
    expect(statSync(file).isFile()).toBe(true)

    // after the stage ends, the views and raw replies go and the manifests, outcomes, judgments and locks stay
    out.length = 0
    expect(await run(['purge'])).toBe(0)
    expect(existsSync(join(privateRoot, 'views'))).toBe(false)
    expect(existsSync(join(privateRoot, 'labeler', 'replies'))).toBe(false)
    expect(readdirSync(join(privateRoot, 'labeler', 'outcomes')).length).toBe(2)
    expect(existsSync(join(privateRoot, 'manifest-initial.json'))).toBe(true)
    expect(existsSync(join(privateRoot, 'marks', 'lock-initial.json'))).toBe(true)
    expect(readdirSync(join(privateRoot, 'marks', 'initial', 'judgments')).length).toBe(6)
  })
})
