import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  canonicalizeText,
  enforcePrereg,
  parsePrereg,
  PreregRefusal,
  preregContentHash,
  saltedHash,
  type ViolationCode,
  verifyPreregContent,
} from './prereg'
import { buildHappyChain, scaffoldMethod, TestRepo, writePrereg } from './test-support'
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
    if (!old.ok) expect(old.errors.join('\n')).toContain('prev_epoch_closing_commit: unknown field')
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
      expect(() => enforce(repo, absent, 'green')).toThrow(PreregRefusal)
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
        const { problems } = verifyPreregContent(parsed.prereg, { evalDir, heldoutDir: '/nonexistent' }, { includeHeldout: false })
        expect(problems).toEqual([])
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
        const { problems, fixtures } = verifyPreregContent(parsed.prereg, { evalDir, heldoutDir: dir }, { includeHeldout: true })
        expect(problems).toEqual([])
        expect(fixtures.heldout).toHaveLength(4)
      })
    })
  }
})
