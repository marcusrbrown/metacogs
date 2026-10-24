import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalize } from '../record/canonical'
import {
  canonicalizeText,
  enforcePrereg,
  expectationHash,
  parsePrereg,
  PreregRefusal,
  preregContentHash,
  saltedHash,
  type ViolationCode,
  verifyPreregContent,
} from './prereg'
import { parseDeclarations, parseRubric } from './judge'
import { loadRedactTokens, survivingTokens } from './redact'
import { buildHappyChain, scaffoldMethod, TEST_SALT, TestRepo, writePrereg } from './test-support'
import { heldoutDir } from './workspace'

const repos: TestRepo[] = []
const scratch: string[] = []

function setup() {
  const repo = new TestRepo()
  repos.push(repo)
  const heldout = mkdtempSync(join(tmpdir(), 'metacogs-heldout-'))
  scratch.push(heldout)
  return { repo, heldout }
}

afterEach(() => {
  for (const r of repos.splice(0)) r.destroy()
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

const codes = (violations: readonly { code: ViolationCode }[]) => violations.map((v) => v.code)

describe('canonicalization and hashing', () => {
  test('CRLF, BOM, and a missing final newline hash like canonical LF text', () => {
    const lf = 'a\nb\n'
    expect(canonicalizeText('a\r\nb')).toBe(lf)
    expect(canonicalizeText(new TextEncoder().encode('\ufeffa\r\nb\r\n'))).toBe(lf)
    expect(saltedHash('s', canonicalizeText('a\r\nb'))).toBe(saltedHash('s', lf))
  })

  test('the salt changes the hash', () => {
    expect(saltedHash('one', 'x\n')).not.toBe(saltedHash('two', 'x\n'))
  })

  test('invalid UTF-8 is rejected, not silently replaced', () => {
    expect(() => canonicalizeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow()
  })
})

describe('parsePrereg', () => {
  const { prereg } = (() => {
    const { repo, heldout } = setup()
    return scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  })()

  test('accepts a complete prereg', () => {
    expect(parsePrereg(JSON.stringify(prereg)).ok).toBe(true)
  })

  test('names every problem; unknown fields and a foreign taxonomy are refused', () => {
    const bad = { ...prereg, extra: 1, epoch: 0, run_outcome_taxonomy: ['pass'] }
    const r = parsePrereg(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join('\n')).toContain('extra: unknown field')
      expect(r.errors.join('\n')).toContain('epoch')
      expect(r.errors.join('\n')).toContain('run_outcome_taxonomy')
    }
  })

  test('expected_execution_modes must name real modes', () => {
    expect(parsePrereg(JSON.stringify({ ...prereg, expected_execution_modes: ['sequential', 'delegated'] })).ok).toBe(true)
    const bad = parsePrereg(JSON.stringify({ ...prereg, expected_execution_modes: ['sequential', 'telepathy'] }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join('\n')).toContain('expected_execution_modes')
  })

  test('epoch is a plain positive integer; git-era fields are unknown now', () => {
    expect(parsePrereg(JSON.stringify({ ...prereg, epoch: 2 })).ok).toBe(true)
    expect(parsePrereg(JSON.stringify({ ...prereg, epoch: 0 })).ok).toBe(false)
    const old = parsePrereg(JSON.stringify({ ...prereg, prev_epoch_closing_commit: null }))
    expect(old.ok).toBe(false)
    if (!old.ok) expect(old.errors.join('\n')).toContain('prev_epoch_closing_commit: removed in the content-contract format')
  })

  test('dev_bar is optional; when present it needs two in-range counts and no other keys', () => {
    const runs = prereg.runs_per_condition
    const devCount = Object.keys(prereg.fixture_hashes.dev).length
    const parse = (dev_bar: unknown) => parsePrereg(JSON.stringify({ ...prereg, dev_bar }))
    const errorsOf = (dev_bar: unknown) => {
      const r = parse(dev_bar)
      return r.ok ? [] : r.errors.join('\n')
    }
    expect(parsePrereg(JSON.stringify(prereg)).ok).toBe(true) // absent: the default rule
    const ok = parse({ pooled_min_passes: runs * devCount, per_fixture_min_passes: runs })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.prereg.dev_bar).toEqual({ pooled_min_passes: runs * devCount, per_fixture_min_passes: runs })
    expect(errorsOf({ pooled_min_passes: 1 })).toContain('dev_bar: needs non-negative integer')
    expect(errorsOf({ pooled_min_passes: 1.5, per_fixture_min_passes: 1 })).toContain('dev_bar: needs non-negative integer')
    expect(errorsOf({ pooled_min_passes: runs * devCount, per_fixture_min_passes: 1, extra: 1 })).toContain('dev_bar.extra: unknown field')
    expect(errorsOf({ pooled_min_passes: runs * devCount + 1, per_fixture_min_passes: 1 })).toContain('exceeds the')
    expect(errorsOf({ pooled_min_passes: runs, per_fixture_min_passes: runs + 1 })).toContain('exceeds runs_per_condition')
    expect(errorsOf({ pooled_min_passes: 1, per_fixture_min_passes: 2 })).toContain('at least per_fixture_min_passes')
    expect(errorsOf('pooled')).toContain('dev_bar: must be an object')
  })

  test('invalid JSON is reported, not thrown', () => {
    expect(parsePrereg('{nope')).toMatchObject({ ok: false })
  })
})
describe('preregContentHash', () => {
  const { prereg } = (() => {
    const { repo, heldout } = setup()
    return scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  })()

  test('is a sha256 of the canonical form: key order and whitespace do not matter, a value change does', () => {
    const hash = preregContentHash(prereg)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const reordered = parsePrereg(JSON.stringify(Object.fromEntries(Object.entries(prereg).reverse()), null, 4))
    if (!reordered.ok) throw new Error(reordered.errors.join('; '))
    expect(preregContentHash(reordered.prereg)).toBe(hash)
    expect(preregContentHash({ ...prereg, runs_per_condition: prereg.runs_per_condition + 1 })).not.toBe(hash)
    expect(preregContentHash({ ...prereg, green_bar: { ...prereg.green_bar, skill_pooled_pass_min: 1 } })).not.toBe(hash)
  })
})

describe('enforcePrereg (temp git repo)', () => {
  const enforce = (repo: TestRepo, heldout: string, mode: 'red' | 'green' | 'dev') =>
    enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode, heldoutDir: heldout })
  const refusalOf = (fn: () => unknown): PreregRefusal => {
    try {
      fn()
    } catch (e) {
      if (e instanceof PreregRefusal) return e
      throw e
    }
    throw new Error('expected a PreregRefusal')
  }

  test('a committed prereg with matching content: GREEN permitted, content hash returned', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    const verified = enforce(repo, heldout, 'green')
    expect(verified.contentHash).toBe(preregContentHash(scaffold.prereg))
    expect(verified.content.fixtures.heldout.map((f) => f.id)).toEqual(['h1'])
  })

  test('editing prereg.json changes the content hash the runner reports; reformatting does not', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    const before = enforce(repo, heldout, 'red').contentHash
    writePrereg(repo, scaffold, scaffold.prereg, '\r\n')
    expect(enforce(repo, heldout, 'red').contentHash).toBe(before)
    writePrereg(repo, scaffold, { ...scaffold.prereg, runs_per_condition: scaffold.prereg.runs_per_condition + 1 })
    expect(enforce(repo, heldout, 'red').contentHash).not.toBe(before)
  })

  test('RED is permitted before any skill exists', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    writePrereg(repo, scaffold)
    repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
    expect(() => enforce(repo, heldout, 'red')).not.toThrow()
  })

  test('a missing or invalid prereg is refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    expect(codes(refusalOf(() => enforce(repo, heldout, 'red')).violations)).toEqual(['prereg_missing'])
    repo.write(scaffold.preregPath, '{nope')
    expect(codes(refusalOf(() => enforce(repo, heldout, 'red')).violations)).toEqual(['prereg_invalid'])
  })

  test('a dev fixture edited after the prereg is refused as a voided prereg', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    repo.write('evals/demo/fixtures/dev/d1.md', 'edited after the prereg\n')
    const refusal = refusalOf(() => enforce(repo, heldout, 'red'))
    expect(codes(refusal.violations)).toEqual(['content_hash_mismatch'])
    expect(refusal.message).toContain('dev/d1 mismatch')
  })

  test('a changed rubric is refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    repo.write('evals/demo/rubric.md', '# Rubric\n\n1. softened\n')
    expect(refusalOf(() => enforce(repo, heldout, 'red')).message).toContain('rubric/rubric.md mismatch')
  })

  describe('content hashes', () => {
    test('held-out hash mismatch: refused before launch', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      writeFileSync(join(heldout, 'h1.md'), 'swapped held-out content\n')
      const refusal = refusalOf(() => enforce(repo, heldout, 'green'))
      expect(codes(refusal.violations)).toEqual(['content_hash_mismatch'])
      expect(refusal.message).toContain('heldout/h1 mismatch')
    })

    test('RED does not touch held-out content', () => {
      const { repo, heldout } = setup()
      const absent = join(heldout, 'absent')
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: absent })
      writePrereg(repo, scaffold)
      repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
      rmSync(absent, { recursive: true, force: true })
      expect(() => enforce(repo, absent, 'red')).not.toThrow()
    })

    test('DEV iterates on an uncommitted skill and never reads held-out content', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('skills/demo/SKILL.md', 'uncommitted edit\n')
      const absent = join(heldout, 'does-not-exist')
      const verified = enforce(repo, absent, 'dev')
      expect(verified.content.fixtures.heldout).toEqual([])
      expect(codes(refusalOf(() => enforce(repo, absent, 'green')).violations)).toEqual(['skill_dirty'])
    })

    test('GREEN with a committed skill and an absent held-out dir is refused as a hash mismatch', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      const absent = join(heldout, 'does-not-exist')
      expect(codes(refusalOf(() => enforce(repo, absent, 'green')).violations)).toEqual(['content_hash_mismatch'])
    })

    test('an extra fixture file is refused like a changed one', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('evals/demo/fixtures/dev/sneaky.md', 'new\n')
      expect(() => enforce(repo, heldout, 'red')).toThrow(/dev\/sneaky extra/)
    })

    test('dirty skill directory is refused for GREEN before the held-out hook runs', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('skills/demo/SKILL.md', 'uncommitted edit\n')
      let hooked = false
      const refusal = refusalOf(() =>
        enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout, beforeHeldoutRead: () => (hooked = true) }),
      )
      expect(codes(refusal.violations)).toEqual(['skill_dirty'])
      expect(hooked).toBe(false)
    })

    test('GREEN without skills/<m>/SKILL.md on disk or in the index is refused before the held-out hook', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      writePrereg(repo, scaffold)
      repo.commit('fixtures and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
      const green = (): PreregRefusal => {
        hooked = false
        return refusalOf(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout, beforeHeldoutRead: () => (hooked = true) }))
      }
      let hooked = false
      expect(codes(green().violations)).toEqual(['skill_missing'])
      expect(hooked).toBe(false)
      // present on disk but never added to git
      repo.write('skills/demo/SKILL.md', 'untracked\n')
      expect(codes(green().violations)).toEqual(['skill_missing'])
      expect(hooked).toBe(false)
    })

    test('an uncommitted edit to prereg.json refuses GREEN before the held-out hook', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      writePrereg(repo, scaffold, { ...scaffold.prereg, runs_per_condition: scaffold.prereg.runs_per_condition + 1 })
      let hooked = false
      const refusal = refusalOf(() =>
        enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout, beforeHeldoutRead: () => (hooked = true) }),
      )
      expect(codes(refusal.violations)).toEqual(['skill_dirty'])
      expect(refusal.message).toContain('evals/demo/prereg.json')
      expect(hooked).toBe(false)
      expect(() => enforce(repo, heldout, 'red')).not.toThrow()
    })

    test('the held-out hook receives the prereg content hash', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      let seen: string | undefined
      enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout, beforeHeldoutRead: ({ contentHash }) => (seen = contentHash) })
      expect(seen).toBe(preregContentHash(scaffold.prereg))
    })
  })
})

// The real preregs committed under evals/. Held-out hashes are checked only where the
// custody directory exists on this machine; CI and fresh clones never have it.
describe('committed preregs', () => {
  const repoRoot = resolve(import.meta.dir, '..', '..')

  for (const method of ['counterfactual', 'synthesis']) {
    describe(method, () => {
      const evalDir = join(repoRoot, 'evals', method)
      const parsed = parsePrereg(readFileSync(join(evalDir, 'prereg.json'), 'utf8'))

      test('parses with the runner parser and matches the v0.1 profile', () => {
        if (!parsed.ok) throw new Error(parsed.errors.join('; '))
        const { prereg } = parsed
        expect(prereg.method).toBe(method)
        // Epoch 3 was the first paid CLIProxyAPI round; later epochs keep its pins. Which epoch is current is the committed file's business:
        // a literal here would break on every new epoch, so it is read from the file and only bounded.
        expect(prereg.epoch).toBeGreaterThanOrEqual(3)
        expect(prereg.runs_per_condition).toBe(5)
        expect(prereg.red_bar).toEqual({ min_baseline_fails_per_fixture: 4, min_fixtures: 2 })
        expect(prereg.green_bar).toEqual({ skill_pooled_pass_min: 17, skill_per_fixture_pass_min: 3, baseline_pooled_pass_max: 10 })
        expect(prereg.false_fire_max).toBe(0)
        expect(prereg.agent_model_id).toBe('openai/gpt-6-luna')
        expect(prereg.judge_model_id).toBe('anthropic/claude-haiku-5-5')
        expect(Object.keys(prereg.fixture_hashes.dev)).toHaveLength(6)
        expect(Object.keys(prereg.fixture_hashes.negative)).toHaveLength(3)
        expect(Object.keys(prereg.fixture_hashes.heldout)).toHaveLength(4)
      })

      test('dev, negative, rubric hashes match the working tree', () => {
        if (!parsed.ok) throw new Error(parsed.errors.join('; '))
        const { problems, invalid } = verifyPreregContent(parsed.prereg, { evalDir, heldoutDir: '/nonexistent' }, { includeHeldout: false })
        expect(problems).toEqual([])
        expect(invalid).toEqual([])
        expect(parsed.prereg.expectation_hashes).toBeUndefined()
      })

      test('redact.json is a non-empty array of non-empty strings', () => {
        const tokens: unknown = JSON.parse(readFileSync(join(evalDir, 'redact.json'), 'utf8'))
        expect(Array.isArray(tokens)).toBe(true)
        expect((tokens as unknown[]).length).toBeGreaterThan(0)
        expect((tokens as unknown[]).every((t) => typeof t === 'string' && t.trim().length > 0)).toBe(true)
        expect(new Set(tokens as string[]).size).toBe((tokens as string[]).length)
      })

      test.skipIf(!existsSync(heldoutDir(method)))('held-out hashes match the custody directory when it exists', () => {
        if (!parsed.ok) throw new Error(parsed.errors.join('; '))
        const dir = heldoutDir(method)
        const { problems, invalid, fixtures } = verifyPreregContent(parsed.prereg, { evalDir, heldoutDir: dir }, { includeHeldout: true })
        expect(problems).toEqual([])
        expect(invalid).toEqual([])
        expect(fixtures.heldout).toHaveLength(4)
      })
    })
  }
})

// ── expectation sidecars ───────────────────────────────────────────────────

describe('expectation_hashes (parsePrereg)', () => {
  const { prereg } = (() => {
    const { repo, heldout } = setup()
    return scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
  })()
  const HEX = 'a'.repeat(64)
  const errorsOf = (expectation_hashes: unknown) => {
    const r = parsePrereg(JSON.stringify({ ...prereg, expectation_hashes }))
    return r.ok ? [] : r.errors
  }

  test('optional: a prereg without the key parses', () => {
    expect(parsePrereg(JSON.stringify(prereg)).ok).toBe(true)
  })

  test('accepts dev and heldout sets of hex64 hashes', () => {
    const r = parsePrereg(JSON.stringify({ ...prereg, expectation_hashes: { dev: { d1: HEX }, heldout: { h1: HEX } } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prereg.expectation_hashes).toEqual({ dev: { d1: HEX }, heldout: { h1: HEX } })
  })

  test('names the set and id for a bad hash or id; refuses other sets, a missing set, and a non-object', () => {
    expect(errorsOf({ dev: { d1: 'nope' }, heldout: {} }).join('\n')).toContain('expectation_hashes.dev.d1: must be a sha256 hex digest')
    expect(errorsOf({ dev: { '../x': HEX }, heldout: {} }).join('\n')).toContain('expectation_hashes.dev.../x: invalid fixture id')
    expect(errorsOf({ dev: {}, heldout: {}, negative: {} }).join('\n')).toContain('expectation_hashes.negative: unknown set')
    expect(errorsOf({ dev: {} }).join('\n')).toContain('expectation_hashes.heldout: must be an object of id → hash')
    expect(errorsOf('x').join('\n')).toContain('expectation_hashes: must be an object with dev, heldout')
    expect(errorsOf([]).join('\n')).toContain('expectation_hashes: must be an object with dev, heldout')
  })

  test('fixture_hashes validation is unchanged', () => {
    const r = parsePrereg(JSON.stringify({ ...prereg, fixture_hashes: { ...prereg.fixture_hashes, dev: { d1: 'nope' } } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toContain('fixture_hashes.dev.d1: must be a sha256 hex digest')
  })
})

describe('expectation sidecars (verifyPreregContent)', () => {
  const A = { outcome: 'picks a database and names the deciding constraint', excludedTopics: ['sharding'], maxWords: 120 }
  const B = { outcome: 'recommends the boring option', excludedTopics: [], maxWords: 80 }
  const D2_TEXT = 'Dev fixture two: choose a cache.\n'

  /** A repo with dev fixtures d1 and d2, a negative n1, and sidecars (default: A beside d1, B beside d2) hashed into the prereg. */
  function twoDev(sidecars: Record<string, unknown> = { d1: A, d2: B }, heldoutSidecars?: Record<string, unknown>) {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', {
      heldoutDir: heldout,
      expectations: { dev: sidecars, ...(heldoutSidecars ? { heldout: heldoutSidecars } : {}) },
    })
    repo.write('evals/demo/fixtures/dev/d2.md', D2_TEXT)
    const prereg = {
      ...scaffold.prereg,
      fixture_hashes: { ...scaffold.prereg.fixture_hashes, dev: { ...scaffold.prereg.fixture_hashes.dev, d2: saltedHash(TEST_SALT, canonicalizeText(D2_TEXT)) } },
    }
    const evalDir = join(repo.dir, 'evals', 'demo')
    const verify = (p = prereg, includeHeldout = false) => verifyPreregContent(p, { evalDir, heldoutDir: heldout }, { includeHeldout })
    const enforceDev = (p = prereg) => {
      writePrereg(repo, scaffold, p)
      return enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: heldout })
    }
    return { repo, heldout, prereg, evalDir, verify, enforceDev, scaffold }
  }
  const refusal = (fn: () => unknown): PreregRefusal => {
    try {
      fn()
    } catch (e) {
      if (e instanceof PreregRefusal) return e
      throw e
    }
    throw new Error('expected a PreregRefusal')
  }

  test('happy path: two dev ids with matching sidecars verify clean and carry the parsed object', () => {
    const { verify, enforceDev } = twoDev()
    const v = verify()
    expect(v.problems).toEqual([])
    expect(v.invalid).toEqual([])
    expect(v.fixtures.dev.map((f) => [f.id, f.expectation])).toEqual([
      ['d1', A],
      ['d2', B],
    ])
    expect(v.fixtures.negative.every((f) => f.expectation === undefined)).toBe(true)
    expect(enforceDev().content.fixtures.dev[0]?.expectation).toEqual(A)
  })

  test('the hash is over canonical JSON: key order and whitespace in the file do not matter', () => {
    const { repo, verify } = twoDev()
    repo.write('evals/demo/fixtures/dev/d1.expectation.json', `{\n  "maxWords": 120,\n  "excludedTopics": ["sharding"],\n  "outcome": "${A.outcome}"\n}\n`)
    expect(verify().problems).toEqual([])
    expect(expectationHash(TEST_SALT, A)).toBe(saltedHash(TEST_SALT, canonicalize(A)))
  })

  test('a sidecar beside a negative fixture is extra', () => {
    const { repo, verify } = twoDev()
    repo.write('evals/demo/fixtures/negative/n1.expectation.json', JSON.stringify(A))
    expect(verify().problems).toEqual([{ set: 'expectation.negative', id: 'n1', kind: 'extra', actual: expectationHash(TEST_SALT, A) }])
  })

  test('an orphan sidecar (no matching fixture) is extra, listed or not', () => {
    const unlisted = twoDev()
    unlisted.repo.write('evals/demo/fixtures/dev/d9.expectation.json', JSON.stringify(A))
    expect(unlisted.verify().problems).toEqual([{ set: 'expectation.dev', id: 'd9', kind: 'extra', actual: expectationHash(TEST_SALT, A) }])

    const listed = twoDev({ d1: A, d2: B, d9: A })
    expect(listed.verify().problems.map((p) => `${p.set}/${p.id} ${p.kind}`)).toEqual(['expectation.dev/d9 extra'])
  })

  test('a listed id without a sidecar is missing', () => {
    const { evalDir, verify } = twoDev()
    rmSync(join(evalDir, 'fixtures', 'dev', 'd2.expectation.json'))
    expect(verify().problems).toEqual([{ set: 'expectation.dev', id: 'd2', kind: 'missing', expected: expectationHash(TEST_SALT, B) }])
  })

  test('key absent: any sidecar is a violation, and the refusal is a content_hash_mismatch', () => {
    const { prereg, verify, enforceDev } = twoDev()
    const { expectation_hashes: _drop, ...bare } = prereg
    expect(verify(bare).problems.map((p) => `${p.set}/${p.id} ${p.kind}`)).toEqual(['expectation.dev/d1 extra', 'expectation.dev/d2 extra'])
    const r = refusal(() => enforceDev(bare))
    expect(codes(r.violations)).toEqual(['content_hash_mismatch'])
    expect(r.violations[0]?.message).toContain('expectation.dev/d1 extra')
  })

  test('a sidecar edited after the prereg is a mismatch → content_hash_mismatch', () => {
    const { repo, verify, enforceDev } = twoDev()
    repo.write('evals/demo/fixtures/dev/d1.expectation.json', JSON.stringify({ ...A, maxWords: 121 }))
    expect(verify().problems).toEqual([
      { set: 'expectation.dev', id: 'd1', kind: 'mismatch', expected: expectationHash(TEST_SALT, A), actual: expectationHash(TEST_SALT, { ...A, maxWords: 121 }) },
    ])
    const r = refusal(() => enforceDev())
    expect(codes(r.violations)).toEqual(['content_hash_mismatch'])
    expect(r.violations[0]?.message).toContain('expectation.dev/d1 mismatch')
  })

  describe('shape errors are prereg_invalid naming the id and the field', () => {
    const cases: [string, unknown, string][] = [
      ['maxWords 0', { ...A, maxWords: 0 }, 'maxWords'],
      ['maxWords non-integer', { ...A, maxWords: 12.5 }, 'maxWords'],
      ['maxWords a string', { ...A, maxWords: '120' }, 'maxWords'],
      ['maxWords missing', { outcome: A.outcome, excludedTopics: [] }, 'maxWords'],
      ['excludedTopics not an array', { ...A, excludedTopics: 'sharding' }, 'excludedTopics'],
      ['excludedTopics holds a non-string', { ...A, excludedTopics: ['ok', 3] }, 'excludedTopics'],
      ['empty outcome', { ...A, outcome: '' }, 'outcome'],
      ['blank outcome', { ...A, outcome: '   ' }, 'outcome'],
      ['outcome missing', { excludedTopics: [], maxWords: 5 }, 'outcome'],
      ['unknown field', { ...A, extra: 1 }, 'extra'],
      ['not an object', ['x'], 'expectation'],
    ]
    for (const [label, bad, field] of cases) {
      test(label, () => {
        const { verify, enforceDev } = twoDev({ d1: bad, d2: B })
        const v = verify()
        expect(v.invalid).toHaveLength(1)
        expect(v.invalid[0]).toContain('d1')
        expect(v.invalid[0]).toContain(field)
        expect(v.problems).toEqual([]) // hashes match; only the shape is wrong
        expect(v.fixtures.dev.find((f) => f.id === 'd1')?.expectation).toBeUndefined()
        const r = refusal(() => enforceDev())
        expect(codes(r.violations)).toEqual(['prereg_invalid'])
        expect(r.violations[0]?.message).toContain('d1')
        expect(r.violations[0]?.message).toContain(field)
      })
    }

    test('invalid JSON names the id and is not also reported as missing', () => {
      const { repo, verify } = twoDev()
      repo.write('evals/demo/fixtures/dev/d1.expectation.json', '{nope')
      const v = verify()
      expect(v.invalid).toHaveLength(1)
      expect(v.invalid[0]).toContain('d1')
      expect(v.problems).toEqual([])
    })

    test('shape errors and hash problems are both reported', () => {
      const { repo, enforceDev } = twoDev({ d1: { ...A, maxWords: 0 }, d2: B })
      repo.write('evals/demo/fixtures/dev/d2.expectation.json', JSON.stringify({ ...B, maxWords: 81 }))
      expect(codes(refusal(() => enforceDev()).violations)).toEqual(['prereg_invalid', 'content_hash_mismatch'])
    })
  })

  describe('held-out directory (verified only when included)', () => {
    const H = { outcome: 'names the queue and its failure mode', excludedTopics: ['kafka'], maxWords: 90 }

    test('a matching held-out sidecar attaches to the held-out fixture', () => {
      const { verify } = twoDev(undefined, { h1: H })
      const v = verify(undefined, true)
      expect(v.problems).toEqual([])
      expect(v.invalid).toEqual([])
      expect(v.fixtures.heldout.map((f) => [f.id, f.expectation])).toEqual([['h1', H]])
    })

    test('a held-out sidecar is not read when held-out is not included', () => {
      const { heldout, verify } = twoDev(undefined, { h1: H })
      writeFileSync(join(heldout, 'h1.expectation.json'), '{nope')
      const v = verify(undefined, false)
      expect(v.problems).toEqual([])
      expect(v.invalid).toEqual([])
      expect(v.fixtures.heldout).toEqual([])
    })

    test('an edited held-out sidecar is a mismatch; one with the key absent is extra', () => {
      const { heldout, prereg, verify } = twoDev(undefined, { h1: H })
      writeFileSync(join(heldout, 'h1.expectation.json'), JSON.stringify({ ...H, maxWords: 91 }))
      expect(verify(prereg, true).problems.map((p) => `${p.set}/${p.id} ${p.kind}`)).toEqual(['expectation.heldout/h1 mismatch'])
      const { expectation_hashes: _drop, ...bare } = prereg
      expect(verify(bare, true).problems.map((p) => `${p.set}/${p.id} ${p.kind}`)).toContain('expectation.heldout/h1 extra')
    })
  })
})

// The tether pilot: its own prereg (`evals/tether/pilot/prereg.json`), two dev fixtures with expectation sidecars, no negatives, no
// held-out. The production `evals/tether/prereg.json` does not exist yet; the shipped-method loop above is unchanged.
describe('tether pilot (committed)', () => {
  const repoRoot = resolve(import.meta.dir, '..', '..')
  const evalDir = join(repoRoot, 'evals', 'tether')
  const parsed = parsePrereg(readFileSync(join(evalDir, 'pilot', 'prereg.json'), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const { prereg } = parsed
  const IDS = ['te-d1-nightly-export-retries', 'te-d2-reset-email-rate-limit']
  const dev = (id: string, ext: 'md' | 'expectation.json') => readFileSync(join(evalDir, 'fixtures', 'dev', `${id}.${ext}`), 'utf8')

  test('parses with the runner parser: two dev fixtures, nothing else, five runs, the epoch-5 models', () => {
    expect(prereg.method).toBe('tether')
    expect(Object.keys(prereg.fixture_hashes.dev).sort()).toEqual(IDS)
    expect(prereg.fixture_hashes.negative).toEqual({})
    expect(prereg.fixture_hashes.heldout).toEqual({})
    expect(Object.keys(prereg.expectation_hashes?.dev ?? {}).sort()).toEqual(IDS)
    expect(prereg.expectation_hashes?.heldout).toEqual({})
    expect(prereg.runs_per_condition).toBe(5)
    expect(prereg.agent_model_id).toBe('openai/gpt-6-luna')
    expect(prereg.judge_model_id).toBe('anthropic/claude-haiku-5-5')
  })

  test('the rubric, fixtures and expectation sidecars hash to the prereg, and each fixture carries its verified expectation', () => {
    const { problems, invalid, fixtures } = verifyPreregContent(prereg, { evalDir, heldoutDir: '/nonexistent' }, { includeHeldout: false })
    expect(problems).toEqual([])
    expect(invalid).toEqual([])
    expect(fixtures.dev.map((f) => f.id)).toEqual(IDS)
    for (const f of fixtures.dev) {
      expect(f.expectation?.maxWords).toBe(250)
      expect(f.expectation?.excludedTopics).toHaveLength(2)
      expect(f.expectation?.outcome.length).toBeGreaterThan(20)
    }
    expect(fixtures.negative).toEqual([])
  })

  test('the notes carry the gate, the decision rule, the provisional word limit and the unvalidated-judge caveat verbatim', () => {
    const notes = prereg.metadata.notes ?? ''
    expect(notes).toContain('other arms are built only if the baseline fails TE2 on ≥4 of 5 runs on both fixtures; otherwise not-reproduced')
    expect(notes).toContain(
      'count runs passing both TE1 and TE2 over the pooled 10 runs per arm; go iff skill ≥ instruction + 2; instruction_present and skill_loaded recorded for every run, none excluded; tie or less → closed-instruction',
    )
    expect(notes).toContain('maxWords is provisional at 250')
    expect(notes).toContain('The pilot judge is unvalidated')
    expect(notes).toContain('The pilot uses none of them')
  })

  test('each ask states the limit, is plain prose, and keeps its bait inside quoted material', () => {
    // Words that name the planted tangents. They may appear in fenced material, never in the user's own sentences.
    const bait: Record<string, string[]> = {
      [IDS[0]!]: ['logging', 'debug', 'config', 'loader', 'deprecat'],
      [IDS[1]!]: ['nodemailer', 'audit', 'index', 'dashboard', 'advisor', 'upgrade', 'vulnerab'],
    }
    for (const id of IDS) {
      const text = dev(id, 'md')
      const prose = text.replace(/```[\s\S]*?```/g, '').toLowerCase()
      expect(text).toContain('Answer in under 250 words.')
      expect(text.startsWith('---')).toBe(false)
      expect(text).not.toMatch(/^#+ /m)
      for (const word of bait[id]!) expect(prose).not.toContain(word)
    }
  })

  test('the redact list is identifiers only, and no fixture or sidecar contains any of them (the authoring lint)', () => {
    const tokens = loadRedactTokens(join(evalDir, 'redact.json'))
    expect([...tokens].sort()).toEqual(['tether', 'skills/tether', 'record.mjs', 'Scope used:', 'Stop condition:', 'Parked:'].sort())
    for (const id of IDS) {
      expect(survivingTokens(dev(id, 'md'), tokens)).toEqual([])
      expect(survivingTokens(dev(id, 'expectation.json'), tokens)).toEqual([])
    }
    // The lint bites: a fixture that leaks the method name or a record prefix is caught, whatever the case.
    expect(survivingTokens('Use Tether here.\nScope used: the log', tokens).sort()).toEqual(['Scope used:', 'tether'].sort())
    expect(survivingTokens('see skills/Tether/scripts/record.mjs', tokens).sort()).toEqual(['record.mjs', 'skills/tether', 'tether'].sort())
  })

  test('the rubric declares expectation: true, judges TE1 and TE2 only, and keeps TE3m mechanical', () => {
    const rubric = readFileSync(join(evalDir, 'rubric.md'), 'utf8')
    expect(parseDeclarations(rubric)).toEqual({ expectation: true })
    const spec = parseRubric(rubric)
    expect(spec.declarations).toEqual({ expectation: true })
    expect(spec.criteria.map((c) => c.id)).toEqual(['TE1', 'TE2'])
    expect(spec.systemPrompt).not.toContain('TE3m')
    expect(spec.systemPrompt).not.toContain('RECORD')
    expect(spec.systemPrompt).toContain('EXPECTATION')
    expect(rubric).toMatch(/### TE3m: Word limit\n\n- `id`: TE3m\n- `check`: mechanical/)
    // Quotable anchors: both pass anchors name the sentence to quote.
    expect(spec.criteria.map((c) => c.body.includes('The pass quote is the sentence that states the result'))).toEqual([true, true])
    expect(spec.criteria[1]!.body).toContain('a deferral')
    expect(spec.criteria[1]!.body).toContain('Examining something the result needs is not pursuit')
  })

  test('the committed annex names both fixtures and no sidecar content', () => {
    const rubric = readFileSync(join(evalDir, 'rubric.md'), 'utf8')
    for (const id of IDS) expect(rubric).toContain(`#### ${id}`)
    for (const id of IDS) {
      const { outcome } = JSON.parse(dev(id, 'expectation.json')) as { outcome: string }
      expect(rubric).not.toContain(outcome)
    }
  })
})
