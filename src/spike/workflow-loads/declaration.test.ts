import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalize } from '../../record/canonical'
import { sha256 } from '../../runner/workspace'
import {
  appendDeviationText,
  assertGate,
  checkGate,
  DECLARATION_PATH,
  DEVIATION_CODES,
  DEVIATION_REASON_MAX,
  DEVIATIONS_PATH,
  type Declaration,
  DeclarationError,
  declarationHash,
  type Deviation,
  DeviationRefusal,
  effectiveSessionCap,
  GateRefusal,
  type GateResult,
  MARKING_RULE_PATH,
  markingRuleHash,
  type NewDeviation,
  parseDeclaration,
  parseDeviations,
  recordDeviation,
} from './declaration'
import { gatedRepo, SAMPLE_RULE_TEXT, sampleDeclaration, writeDeclaration } from './test-support'
import type { TestRepo } from '../../runner/test-support'

const repos: TestRepo[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.destroy()
})
function gated(overrides: Partial<Declaration> = {}) {
  const fixture = gatedRepo(overrides)
  repos.push(fixture.repo)
  return fixture
}

const reasonOf = (result: GateResult) => (result.ok ? 'ok' : result.reason)
const mask = { code: 'masking_fix', reason: 'tightened the token replacement' } as const satisfies NewDeviation
const labeler = { code: 'labeler_change', reason: 'the declared labeler was unavailable' } as const satisfies NewDeviation

/** Builds a deviations file text by appending each entry in turn. */
function chain(declaration: Declaration, entries: readonly NewDeviation[]): string {
  let text: string | undefined
  for (const entry of entries) text = appendDeviationText(text, declaration, entry)
  return text ?? ''
}

const rewrite = (text: string, edit: (entries: Record<string, unknown>[]) => void): string => {
  const file = JSON.parse(text) as { entries: Record<string, unknown>[] }
  edit(file.entries)
  return `${JSON.stringify(file, null, 2)}\n`
}

describe('declaration schema', () => {
  test('a valid declaration parses and has a stable content hash', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const hash = declarationHash(declaration)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(declarationHash(parseDeclaration(JSON.parse(JSON.stringify(declaration))))).toBe(hash)
    // Key order and formatting do not matter; it is the canonical form that is hashed.
    const reversed = Object.fromEntries(Object.entries(sampleDeclaration()).reverse())
    expect(declarationHash(parseDeclaration(reversed))).toBe(hash)
    expect(hash).toBe(sha256(canonicalize(declaration)))
  })

  test('any changed value changes the hash', () => {
    const base = declarationHash(parseDeclaration(sampleDeclaration()))
    const changed = [
      sampleDeclaration({ session_cap: 41 }),
      sampleDeclaration({ salt: 'other' }),
      sampleDeclaration({ spend_cap_usd: 11 }),
      sampleDeclaration({ window: { start: '2026-01-02', end: '2026-02-28' } }),
    ]
    for (const d of changed) expect(declarationHash(parseDeclaration(d))).not.toBe(base)
  })

  test('the default paths sit together under one directory', () => {
    const paths = [DECLARATION_PATH, MARKING_RULE_PATH, DEVIATIONS_PATH]
    expect(new Set(paths).size).toBe(3)
    for (const p of paths) expect(p.startsWith('evals/spikes/workflow-loads/')).toBe(true)
  })

  test('an unknown top-level key is refused', () => {
    expect(() => parseDeclaration({ ...sampleDeclaration(), extra: 1 })).toThrow(DeclarationError)
  })

  test('an unknown nested key is refused', () => {
    expect(() => parseDeclaration({ ...sampleDeclaration(), labeler: { model_id: 'm', endpoint: 'https://proxy.example.invalid/v1', fallback: 'x' } })).toThrow(DeclarationError)
    expect(() => parseDeclaration({ ...sampleDeclaration(), omission: { sample_size: 20, limit: 2, extra: true } })).toThrow(DeclarationError)
    const marks = sampleDeclaration().min_accepted_marks
    expect(() => parseDeclaration({ ...sampleDeclaration(), min_accepted_marks: { ...marks, feel: marks.synthesis } })).toThrow(DeclarationError)
  })

  test('a minimum of zero is refused, for every method and label', () => {
    for (const method of ['counterfactual', 'synthesis'] as const) {
      for (const label of ['expected_fire', 'expected_silence'] as const) {
        const marks = sampleDeclaration().min_accepted_marks
        const zeroed = { ...marks, [method]: { ...marks[method], [label]: 0 } }
        expect(() => parseDeclaration({ ...sampleDeclaration(), min_accepted_marks: zeroed })).toThrow(DeclarationError)
      }
    }
  })

  test('a missing method or label minimum is refused', () => {
    const marks = sampleDeclaration().min_accepted_marks
    expect(() => parseDeclaration({ ...sampleDeclaration(), min_accepted_marks: { counterfactual: marks.counterfactual } })).toThrow(DeclarationError)
    expect(() => parseDeclaration({ ...sampleDeclaration(), min_accepted_marks: { ...marks, synthesis: { expected_fire: 5 } } })).toThrow(DeclarationError)
  })

  test('a missing field is refused', () => {
    const { marking_rule_hash: _omitted, ...rest } = sampleDeclaration()
    expect(() => parseDeclaration(rest)).toThrow(DeclarationError)
  })

  test('caps, counts and the spend cap must be sound numbers', () => {
    const bad: Record<string, unknown>[] = [
      { session_cap: 0 },
      { session_cap: 2.5 },
      { scope_message_cap: 0 },
      { retry_count: -1 },
      { retry_count: 1.5 },
      { spend_cap_usd: 0 },
      { spend_cap_usd: Number.POSITIVE_INFINITY },
      { omission: { sample_size: 0, limit: 0 } },
      { omission: { sample_size: 20, limit: -1 } },
      { omission: { sample_size: 2, limit: 3 } },
    ]
    for (const override of bad) expect(() => parseDeclaration({ ...sampleDeclaration(), ...override })).toThrow(DeclarationError)
  })

  test('a retry count and an omission limit of zero are allowed', () => {
    expect(() => parseDeclaration({ ...sampleDeclaration(), retry_count: 0, omission: { sample_size: 20, limit: 0 } })).not.toThrow()
  })

  test('the window must be real calendar dates in order', () => {
    const bad = [
      { start: '2026-02-30', end: '2026-03-01' },
      { start: '2026-1-1', end: '2026-03-01' },
      { start: '2026-03-02', end: '2026-03-01' },
      { start: '2026-01-01T00:00:00Z', end: '2026-03-01' },
    ]
    for (const window of bad) expect(() => parseDeclaration({ ...sampleDeclaration(), window })).toThrow(DeclarationError)
    expect(() => parseDeclaration({ ...sampleDeclaration(), window: { start: '2026-03-01', end: '2026-03-01' } })).not.toThrow()
  })

  test('the rule hash, strings, lists, outcome rule and endpoint are checked', () => {
    const bad: Record<string, unknown>[] = [
      { marking_rule_hash: 'abc' },
      { marking_rule_hash: 'A'.repeat(64) },
      { salt: '' },
      { salt: '   ' },
      { decision_bearing_tools: [] },
      { decision_bearing_tools: ['task', 'task'] },
      { decision_bearing_tools: [''] },
      { excluded_project_roots: [''] },
      { excluded_project_roots: ['/a', '/a'] },
      { outcome_rule: 'anything-goes' },
      { labeler: { model_id: '', endpoint: 'https://proxy.example.invalid/v1' } },
      { labeler: { model_id: 'm', endpoint: 'not a url' } },
      { schema_version: 2 },
    ]
    for (const override of bad) expect(() => parseDeclaration({ ...sampleDeclaration(), ...override })).toThrow(DeclarationError)
  })

  test('an empty excluded-roots list is allowed', () => {
    expect(() => parseDeclaration({ ...sampleDeclaration(), excluded_project_roots: [] })).not.toThrow()
  })

  test('a refusal names the field and never echoes the value', () => {
    const sentinel = 'sentinel-value-that-must-not-leak'
    try {
      parseDeclaration({ ...sampleDeclaration(), labeler: { model_id: 'm', endpoint: sentinel } })
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(DeclarationError)
      expect((e as Error).message).toContain('labeler.endpoint')
      expect((e as Error).message).not.toContain(sentinel)
    }
  })

  test('input that is not an object is refused', () => {
    for (const input of [null, 'x', 3, []]) expect(() => parseDeclaration(input)).toThrow(DeclarationError)
  })
})

describe('marking rule hash', () => {
  test('line endings, a BOM and a missing final newline do not change it', () => {
    const lf = 'a\nb\n'
    const hash = markingRuleHash(lf)
    expect(markingRuleHash('a\r\nb')).toBe(hash)
    expect(markingRuleHash(new TextEncoder().encode('\ufeffa\r\nb\r\n'))).toBe(hash)
    expect(hash).toBe(sha256(lf))
  })

  test('a content change changes it', () => {
    expect(markingRuleHash('a\n')).not.toBe(markingRuleHash('b\n'))
  })

  test('bytes that are not UTF-8 are refused, not replaced', () => {
    expect(() => markingRuleHash(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow()
  })
})

describe('gate', () => {
  test('passes on a committed, unmodified declaration and rule, and returns what it verified', () => {
    const { repo, declaration } = gated()
    const result = checkGate({ git: repo.git })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.declaration).toEqual(parseDeclaration(declaration))
    expect(result.declarationHash).toBe(declarationHash(parseDeclaration(declaration)))
    expect(result.markingRuleHash).toBe(declaration.marking_rule_hash)
    expect(result.deviations).toEqual([])
  })

  test('fails with a named reason when the declaration is missing', () => {
    const { repo } = gated()
    rmSync(join(repo.dir, DECLARATION_PATH))
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_missing')
  })

  test('fails with a named reason when the declaration is untracked', () => {
    const { repo } = gated()
    repo.sh(['rm', '-q', '--cached', '--', DECLARATION_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_untracked')
  })

  test('fails when the declaration was never committed', () => {
    const { repo } = gated()
    writeDeclaration(repo, sampleDeclaration({ session_cap: 9 }), 'elsewhere/declaration.json')
    expect(reasonOf(checkGate({ git: repo.git, declarationPath: 'elsewhere/declaration.json' }))).toBe('declaration_untracked')
  })

  test('fails when the declaration has an uncommitted working-tree change', () => {
    const { repo, declaration } = gated()
    writeDeclaration(repo, { ...declaration, session_cap: 99 })
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_modified')
  })

  test('fails when the declaration has a staged-only change', () => {
    const { repo, declaration } = gated()
    writeDeclaration(repo, { ...declaration, session_cap: 99 })
    repo.sh(['add', '--', DECLARATION_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_modified')
  })

  test('fails when the committed declaration is not valid JSON or breaks the schema', () => {
    const { repo, declaration } = gated()
    repo.write(DECLARATION_PATH, 'not json')
    repo.commit('broken', [DECLARATION_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_invalid')
    writeDeclaration(repo, { ...declaration, unknown_key: true } as Declaration)
    repo.commit('unknown key', [DECLARATION_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_invalid')
  })

  test('fails when the rule file is missing', () => {
    const { repo } = gated()
    rmSync(join(repo.dir, MARKING_RULE_PATH))
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('marking_rule_missing')
  })

  test('fails when the rule file is untracked', () => {
    const { repo } = gated()
    repo.sh(['rm', '-q', '--cached', '--', MARKING_RULE_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('marking_rule_untracked')
  })

  test('fails when the rule file is modified, even if the edit is staged', () => {
    const { repo } = gated()
    writeFileSync(join(repo.dir, MARKING_RULE_PATH), `${SAMPLE_RULE_TEXT}one more line\n`)
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('marking_rule_modified')
    repo.sh(['add', '--', MARKING_RULE_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('marking_rule_modified')
  })

  test('fails when the committed rule file differs from the declared hash', () => {
    const { repo } = gated()
    repo.write(MARKING_RULE_PATH, `${SAMPLE_RULE_TEXT}committed edit\n`)
    repo.commit('edit the rule', [MARKING_RULE_PATH])
    const result = checkGate({ git: repo.git })
    expect(reasonOf(result)).toBe('marking_rule_hash_mismatch')
    if (!result.ok) expect(result.message).toContain(MARKING_RULE_PATH)
  })

  test('fails on a rule file that is not UTF-8, as a hash mismatch', () => {
    const { repo } = gated()
    repo.write(MARKING_RULE_PATH, new Uint8Array([0xff, 0xfe, 0xfd]))
    repo.commit('binary rule', [MARKING_RULE_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('marking_rule_hash_mismatch')
  })

  test('a committed rule with CRLF line endings still matches the declared hash', () => {
    const { repo } = gated()
    repo.write(MARKING_RULE_PATH, SAMPLE_RULE_TEXT.replace(/\n/g, '\r\n'))
    repo.commit('crlf', [MARKING_RULE_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('ok')
  })

  test('reports the declaration problem first when the declaration and the rule both fail', () => {
    const { repo, declaration } = gated()
    writeDeclaration(repo, { ...declaration, session_cap: 99 })
    writeFileSync(join(repo.dir, MARKING_RULE_PATH), 'changed\n')
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('declaration_modified')
  })

  test('honours custom paths', () => {
    const { repo } = gated()
    repo.write('other/rule.md', SAMPLE_RULE_TEXT)
    writeDeclaration(repo, sampleDeclaration(), 'other/declaration.json')
    repo.commit('other', ['other/rule.md', 'other/declaration.json'])
    const result = checkGate({ git: repo.git, declarationPath: 'other/declaration.json', markingRulePath: 'other/rule.md', deviationsPath: 'other/deviations.json' })
    expect(result.ok).toBe(true)
  })

  test('assertGate returns the pass and throws a GateRefusal that carries the reason', () => {
    const { repo, declaration } = gated()
    expect(assertGate({ git: repo.git }).declarationHash).toBe(declarationHash(parseDeclaration(declaration)))
    writeFileSync(join(repo.dir, MARKING_RULE_PATH), 'changed\n')
    try {
      assertGate({ git: repo.git })
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(GateRefusal)
      expect((e as GateRefusal).reason).toBe('marking_rule_modified')
      expect((e as Error).message).toContain('marking_rule_modified')
    }
  })
})

describe('deviations', () => {
  test('appending a deviation leaves the declaration and its hash unchanged, and the gate still passes', () => {
    const { repo } = gated()
    const before = assertGate({ git: repo.git })
    const declarationBytes = readFileSync(join(repo.dir, DECLARATION_PATH))
    const entry = recordDeviation({ git: repo.git, entry: mask })
    expect(entry.code).toBe('masking_fix')
    expect(entry.prev).toBe(before.declarationHash)
    expect(readFileSync(join(repo.dir, DECLARATION_PATH)).equals(declarationBytes)).toBe(true)
    expect(repo.git.porcelain([DECLARATION_PATH, MARKING_RULE_PATH])).toBe('')
    const after = assertGate({ git: repo.git })
    expect(after.declarationHash).toBe(before.declarationHash)
    expect(after.markingRuleHash).toBe(before.markingRuleHash)
    expect(after.deviations).toEqual([entry])
  })

  test('the gate still passes once the deviations are committed, and more can be appended', () => {
    const { repo } = gated()
    recordDeviation({ git: repo.git, entry: mask })
    repo.commit('deviation', [DEVIATIONS_PATH])
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('ok')
    recordDeviation({ git: repo.git, entry: labeler })
    expect(assertGate({ git: repo.git }).deviations.map((d) => d.code)).toEqual(['masking_fix', 'labeler_change'])
  })

  test('each entry carries the hash of the one before it, and the first carries the declaration hash', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const entries = parseDeviations(chain(declaration, [mask, labeler, mask]), declaration)
    expect(entries).toHaveLength(3)
    expect(entries[0]?.prev).toBe(declarationHash(declaration))
    expect(entries[1]?.prev).toBe(sha256(canonicalize(entries[0])))
    expect(entries[2]?.prev).toBe(sha256(canonicalize(entries[1])))
  })

  test('a missing file is no deviations', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    expect(parseDeviations(undefined, declaration)).toEqual([])
  })

  test('every listed code can be recorded', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    expect(DEVIATION_CODES).toEqual(['masking_fix', 'session_cap_raise', 'labeler_change'])
    for (const code of DEVIATION_CODES) {
      const entry: NewDeviation = code === 'session_cap_raise' ? { code, reason: 'raise once', session_cap: 80 } : { code, reason: 'recorded' }
      expect(parseDeviations(appendDeviationText(undefined, declaration, entry), declaration)).toHaveLength(1)
    }
  })

  test('an unknown code is refused', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const entry = { code: 'change_the_rule', reason: 'no' } as unknown as NewDeviation
    expect(() => appendDeviationText(undefined, declaration, entry)).toThrow(DeviationRefusal)
  })

  test('a reason over the bound, empty, multi-line or padded is refused; one at the bound is accepted', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const append = (reason: string) => appendDeviationText(undefined, declaration, { code: 'masking_fix', reason })
    expect(() => append('x'.repeat(DEVIATION_REASON_MAX))).not.toThrow()
    expect(() => append('x'.repeat(DEVIATION_REASON_MAX + 1))).toThrow(DeviationRefusal)
    expect(() => append('')).toThrow(DeviationRefusal)
    expect(() => append('   ')).toThrow(DeviationRefusal)
    expect(() => append('two\nlines')).toThrow(DeviationRefusal)
    expect(() => append(' padded')).toThrow(DeviationRefusal)
  })

  test('an extra key on an entry is refused', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const entry = { ...mask, note: 'extra' } as unknown as NewDeviation
    expect(() => appendDeviationText(undefined, declaration, entry)).toThrow(DeviationRefusal)
  })

  test('a session-cap raise must carry a cap above the declared one, and only one raise is allowed', () => {
    const declaration = parseDeclaration(sampleDeclaration({ session_cap: 40 }))
    const raise = (session_cap: number): NewDeviation => ({ code: 'session_cap_raise', reason: 'inconclusive on coverage', session_cap })
    expect(() => appendDeviationText(undefined, declaration, raise(40))).toThrow(DeviationRefusal)
    expect(() => appendDeviationText(undefined, declaration, raise(20))).toThrow(DeviationRefusal)
    expect(() => appendDeviationText(undefined, declaration, raise(60.5))).toThrow(DeviationRefusal)
    expect(() => appendDeviationText(undefined, declaration, { code: 'session_cap_raise', reason: 'no cap' } as unknown as NewDeviation)).toThrow(DeviationRefusal)
    const once = appendDeviationText(undefined, declaration, raise(60))
    expect(() => appendDeviationText(once, declaration, raise(80))).toThrow(DeviationRefusal)
    expect(() => appendDeviationText(once, declaration, mask)).not.toThrow()
  })

  test('a cap on a code that is not a raise is refused', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const entry = { ...mask, session_cap: 80 } as unknown as NewDeviation
    expect(() => appendDeviationText(undefined, declaration, entry)).toThrow(DeviationRefusal)
  })

  test('the effective session cap is the declared one until a raise is recorded', () => {
    const declaration = parseDeclaration(sampleDeclaration({ session_cap: 40 }))
    const none = parseDeviations(chain(declaration, [mask]), declaration)
    expect(effectiveSessionCap(declaration, none)).toBe(40)
    const raised = parseDeviations(chain(declaration, [mask, { code: 'session_cap_raise', reason: 'once', session_cap: 70 }]), declaration)
    expect(effectiveSessionCap(declaration, raised)).toBe(70)
  })

  test('editing an earlier entry is detected', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const text = chain(declaration, [mask, labeler, mask])
    const edited = rewrite(text, (entries) => {
      if (entries[0]) entries[0].reason = 'a different reason'
    })
    expect(() => parseDeviations(edited, declaration)).toThrow(DeviationRefusal)
    try {
      parseDeviations(edited, declaration)
    } catch (e) {
      expect((e as DeviationRefusal).reason).toBe('deviations_chain_broken')
    }
  })

  test('removing an earlier entry is detected', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const text = chain(declaration, [mask, labeler, mask])
    for (const index of [0, 1]) {
      const removed = rewrite(text, (entries) => {
        entries.splice(index, 1)
      })
      try {
        parseDeviations(removed, declaration)
        throw new Error('expected a refusal')
      } catch (e) {
        expect((e as DeviationRefusal).reason).toBe('deviations_chain_broken')
      }
    }
  })

  test('reordering entries is detected', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const reordered = rewrite(chain(declaration, [mask, labeler]), (entries) => {
      entries.reverse()
    })
    expect(() => parseDeviations(reordered, declaration)).toThrow(DeviationRefusal)
  })

  test('a chain built for another declaration is refused', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const other = parseDeclaration(sampleDeclaration({ salt: 'other-salt' }))
    expect(() => parseDeviations(chain(other, [mask]), declaration)).toThrow(DeviationRefusal)
  })

  test('a file that is not JSON or breaks the schema is refused', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    for (const text of ['not json', '{}', '{"schema_version":1,"entries":[],"extra":1}', '{"schema_version":2,"entries":[]}']) {
      try {
        parseDeviations(text, declaration)
        throw new Error('expected a refusal')
      } catch (e) {
        expect((e as DeviationRefusal).reason).toBe('deviations_invalid')
      }
    }
  })

  test('a tampered file in the working tree fails the gate: edited middle entry', () => {
    const { repo, declaration } = gated()
    const parsed = parseDeclaration(declaration)
    const path = join(repo.dir, DEVIATIONS_PATH)
    const text = chain(parsed, [mask, labeler])
    repo.write(DEVIATIONS_PATH, text)
    repo.commit('deviations', [DEVIATIONS_PATH])
    writeFileSync(
      path,
      rewrite(text, (entries) => {
        if (entries[0]) entries[0].reason = 'rewritten'
      }),
    )
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('deviations_chain_broken')
  })

  test('a committed entry cannot be removed or edited even when the chain still verifies', () => {
    const { repo, declaration } = gated()
    const parsed = parseDeclaration(declaration)
    const path = join(repo.dir, DEVIATIONS_PATH)
    const text = chain(parsed, [mask, labeler])
    repo.write(DEVIATIONS_PATH, text)
    repo.commit('deviations', [DEVIATIONS_PATH])

    // Remove the last entry: the shorter chain is internally sound.
    writeFileSync(path, chain(parsed, [mask]))
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('deviations_rewritten')

    // Edit the last entry: no later entry points at it, so the chain alone cannot tell.
    writeFileSync(
      path,
      rewrite(text, (entries) => {
        if (entries[1]) entries[1].reason = 'edited last entry'
      }),
    )
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('deviations_rewritten')

    // Rebuild the whole chain with a different first entry: every link is consistent.
    writeFileSync(path, chain(parsed, [{ code: 'masking_fix', reason: 'a different first entry' }, labeler]))
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('deviations_rewritten')

    // Delete the file.
    rmSync(path)
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('deviations_rewritten')

    // Restoring the committed text passes again.
    writeFileSync(path, text)
    expect(reasonOf(checkGate({ git: repo.git }))).toBe('ok')
  })

  test('recordDeviation refuses when the gate fails and writes nothing', () => {
    const { repo } = gated()
    writeFileSync(join(repo.dir, MARKING_RULE_PATH), 'changed\n')
    try {
      recordDeviation({ git: repo.git, entry: mask })
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(GateRefusal)
      expect((e as GateRefusal).reason).toBe('marking_rule_modified')
    }
    expect(existsSync(join(repo.dir, DEVIATIONS_PATH))).toBe(false)
  })

  test('recordDeviation refuses an invalid entry and leaves the file as it was', () => {
    const { repo } = gated()
    recordDeviation({ git: repo.git, entry: mask })
    const before = readFileSync(join(repo.dir, DEVIATIONS_PATH), 'utf8')
    expect(() => recordDeviation({ git: repo.git, entry: { code: 'masking_fix', reason: 'x'.repeat(DEVIATION_REASON_MAX + 1) } })).toThrow(DeviationRefusal)
    expect(readFileSync(join(repo.dir, DEVIATIONS_PATH), 'utf8')).toBe(before)
  })
})

describe('deviation entry types', () => {
  test('a recorded entry has the documented shape', () => {
    const declaration = parseDeclaration(sampleDeclaration())
    const [entry] = parseDeviations(appendDeviationText(undefined, declaration, { code: 'session_cap_raise', reason: 'once', session_cap: 80 }), declaration)
    const expected: Deviation = { code: 'session_cap_raise', reason: 'once', prev: declarationHash(declaration), session_cap: 80 }
    expect(entry).toEqual(expected)
  })
})
