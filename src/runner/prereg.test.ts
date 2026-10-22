import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  canonicalizeText,
  checkPreregOrdering,
  enforcePrereg,
  parsePrereg,
  PreregRefusal,
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

  test('epoch > 1 needs a closing commit SHA; epoch 1 needs null', () => {
    const e1 = parsePrereg(JSON.stringify({ ...prereg, prev_epoch_closing_commit: 'a'.repeat(40) }))
    expect(e1.ok).toBe(false)
    const e2 = parsePrereg(JSON.stringify({ ...prereg, epoch: 2, prev_epoch_closing_commit: null }))
    expect(e2.ok).toBe(false)
    const ok = parsePrereg(JSON.stringify({ ...prereg, epoch: 2, prev_epoch_closing_commit: 'a'.repeat(40) }))
    expect(ok.ok).toBe(true)
  })

  test('invalid JSON is reported, not thrown', () => {
    expect(parsePrereg('{nope')).toMatchObject({ ok: false })
  })
})

describe('prereg ordering (temp git repo)', () => {
  test('fixtures → prereg-only commit → annotated tag → skill commit: GREEN permitted', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    const chain = buildHappyChain(repo, scaffold)
    const result = checkPreregOrdering(repo.git, scaffold.prereg, 'green')
    expect(result.violations).toEqual([])
    expect(result.shas.commitSha).toBe(chain.preregCommit)
    expect(result.shas.firstSkillCommit).toBe(chain.skillCommit)
    expect(result.shas.tagObjectSha).not.toBe(chain.preregCommit) // annotated: tag object ≠ commit
    expect(result.shas.blobSha).toBe(repo.git.blobAt('HEAD', scaffold.preregPath) ?? undefined)

    const verified = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout })
    expect(verified.shas.tag).toBe('prereg/demo/1')
    expect(verified.content.fixtures.heldout.map((f) => f.id)).toEqual(['h1'])
  })

  test('RED is permitted before any skill exists; GREEN is refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.commit('prereg', [scaffold.preregPath])
    repo.tag('prereg/demo/1')
    expect(checkPreregOrdering(repo.git, scaffold.prereg, 'red').violations).toEqual([])
    expect(codes(checkPreregOrdering(repo.git, scaffold.prereg, 'green').violations)).toEqual(['no_skill_commit'])
  })

  test('prereg and SKILL.md in one commit: refused (tag equals first skill commit)', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.write('skills/demo/SKILL.md', '---\nname: demo\ndescription: x\n---\n')
    const both = repo.commit('prereg + skill', [scaffold.preregPath, 'skills/demo'])
    repo.tag('prereg/demo/1')
    const { violations } = checkPreregOrdering(repo.git, scaffold.prereg, 'green')
    expect(codes(violations)).toContain('tag_equals_skill_commit')
    expect(codes(violations)).toContain('prereg_commit_not_alone')
    // refusal names the SHA involved
    expect(violations.find((v) => v.code === 'tag_equals_skill_commit')?.message).toContain(both.slice(0, 12))
  })

  test('prereg commit touching a second file: refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.write('NOTES.md', 'stray\n')
    repo.commit('prereg + stray', [scaffold.preregPath, 'NOTES.md'])
    repo.tag('prereg/demo/1')
    const { violations } = checkPreregOrdering(repo.git, scaffold.prereg, 'red')
    expect(codes(violations)).toEqual(['prereg_commit_not_alone'])
    expect(violations[0]?.message).toContain('NOTES.md')
  })

  test('fixtures committed after the prereg commit: refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    const [first, ...rest] = scaffold.fixturePaths
    repo.commit('some fixtures', [first as string])
    writePrereg(repo, scaffold)
    repo.commit('prereg', [scaffold.preregPath])
    repo.tag('prereg/demo/1')
    const late = repo.commit('late fixtures', rest)
    const { violations } = checkPreregOrdering(repo.git, scaffold.prereg, 'red')
    expect(codes(violations)).toEqual(['fixtures_after_prereg'])
    expect(violations[0]?.message).toContain(late.slice(0, 12))
  })

  test('a dev fixture edited after the tag is refused as a voided prereg', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    repo.write('evals/demo/fixtures/dev/d1.md', 'edited after the tag\n')
    repo.commit('edit dev fixture', ['evals/demo/fixtures/dev/d1.md'])
    let refusal: unknown
    try {
      enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'red', heldoutDir: heldout })
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(PreregRefusal)
    expect(codes((refusal as PreregRefusal).violations)).toContain('fixtures_after_prereg')
  })

  test('lightweight and missing tags are refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    repo.commit('fixtures', scaffold.fixturePaths)
    writePrereg(repo, scaffold)
    repo.commit('prereg', [scaffold.preregPath])
    expect(codes(checkPreregOrdering(repo.git, scaffold.prereg, 'red').violations)).toEqual(['tag_missing'])
    repo.tag('prereg/demo/1', false)
    expect(codes(checkPreregOrdering(repo.git, scaffold.prereg, 'red').violations)).toEqual(['tag_not_annotated'])
  })

  test('a skill commit that is not a descendant of the tag is refused', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    const fixtures = repo.commit('fixtures', scaffold.fixturePaths)
    // A side branch carries the skill off the fixtures commit, bypassing the prereg commit.
    repo.sh(['checkout', '-q', '-b', 'side'])
    repo.write('skills/demo/SKILL.md', 'early skill\n')
    repo.commit('early skill', ['skills/demo'])
    repo.sh(['checkout', '-q', 'main'])
    writePrereg(repo, scaffold)
    repo.commit('prereg', [scaffold.preregPath])
    repo.tag('prereg/demo/1')
    repo.sh(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    const { violations } = checkPreregOrdering(repo.git, scaffold.prereg, 'red')
    expect(codes(violations)).toContain('skill_commit_not_after_tag')
    expect(fixtures).toBeTruthy()
  })

  describe('working-tree prereg vs tagged blob (hash-object --path)', () => {
    test('content edited after tagging: refused', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      writePrereg(repo, scaffold, { ...scaffold.prereg, runs_per_condition: 99 })
      const { violations } = checkPreregOrdering(repo.git, scaffold.prereg, 'green')
      expect(codes(violations)).toEqual(['prereg_blob_mismatch'])
    })

    test('CRLF rewrite with no EOL attributes: refused (raw bytes differ, and so does the blob)', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      writePrereg(repo, scaffold, scaffold.prereg, '\r\n')
      expect(codes(checkPreregOrdering(repo.git, scaffold.prereg, 'green').violations)).toEqual(['prereg_blob_mismatch'])
    })

    test('CRLF checkout under an eol=lf attribute hashes like the tagged blob: permitted', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      repo.write('.gitattributes', '*.json text eol=lf\n')
      repo.commit('attrs', ['.gitattributes'])
      buildHappyChain(repo, scaffold)
      writePrereg(repo, scaffold, scaffold.prereg, '\r\n') // what a Windows checkout would hold
      expect(checkPreregOrdering(repo.git, scaffold.prereg, 'green').violations).toEqual([])
    })
  })

  describe('epochs', () => {
    test('epoch 2 after the epoch 1 close: permitted; epoch 1 base is the root', () => {
      const { repo, heldout } = setup()
      const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      const chain1 = buildHappyChain(repo, s1)
      // Epoch 1 is burned: a later skill edit closes it.
      repo.write('skills/demo/SKILL.md', 'edited and burned\n')
      const closing = repo.commit('epoch 1 close', ['skills/demo'])
      expect(checkPreregOrdering(repo.git, s1.prereg, 'green').shas.firstSkillCommit).toBe(chain1.skillCommit)

      // Epoch 2: new held-out set, new fixtures, new prereg, new tag; then a new skill commit.
      const s2 = scaffoldMethod(repo, 'demo', {
        epoch: 2,
        prevClosing: closing,
        heldoutDir: heldout,
      })
      repo.write('evals/demo/fixtures/dev/d2.md', 'epoch two dev fixture\n')
      const fx2 = repo.commit('epoch 2 fixtures', [...s2.fixturePaths, 'evals/demo/fixtures/dev/d2.md'])
      writePrereg(repo, s2)
      const pre2 = repo.commit('epoch 2 prereg', [s2.preregPath])
      repo.tag('prereg/demo/2')
      repo.write('skills/demo/SKILL.md', 'epoch two skill\n')
      const skill2 = repo.commit('epoch 2 skill', ['skills/demo'])

      const r = checkPreregOrdering(repo.git, s2.prereg, 'green')
      expect(r.violations).toEqual([])
      expect(fx2).toBeTruthy()
      expect(r.shas.firstSkillCommit).toBe(skill2)
      expect(r.shas.commitSha).toBe(pre2)
    })

    test('epoch 2 prereg whose closing commit is unknown or not before the tag: refused', () => {
      const { repo, heldout } = setup()
      const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, s1)
      repo.write('skills/demo/SKILL.md', 'edited\n')
      const closing = repo.commit('close', ['skills/demo'])
      const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: closing, heldoutDir: heldout })
      writePrereg(repo, s2)
      repo.commit('epoch 2 prereg', [s2.preregPath])
      repo.tag('prereg/demo/2')
      repo.write('skills/demo/SKILL.md', 'later\n')
      const later = repo.commit('later', ['skills/demo'])

      const unknown = checkPreregOrdering(repo.git, { ...s2.prereg, prev_epoch_closing_commit: 'f'.repeat(40) }, 'red')
      expect(codes(unknown.violations)).toContain('epoch_base_invalid')
      const afterTag = checkPreregOrdering(repo.git, { ...s2.prereg, prev_epoch_closing_commit: later }, 'red')
      expect(codes(afterTag.violations)).toContain('epoch_base_invalid')
    })
  })

  describe('content hashes', () => {
    test('held-out hash mismatch: refused before launch', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      writeFileSync(join(heldout, 'h1.md'), 'swapped held-out content\n')
      let refusal: unknown
      try {
        enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout })
      } catch (e) {
        refusal = e
      }
      expect(refusal).toBeInstanceOf(PreregRefusal)
      expect(codes((refusal as PreregRefusal).violations)).toEqual(['content_hash_mismatch'])
      expect((refusal as PreregRefusal).message).toContain('heldout/h1 mismatch')
    })

    test('RED does not touch held-out content', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: join(heldout, 'absent') })
      repo.commit('fixtures', scaffold.fixturePaths)
      writePrereg(repo, scaffold)
      repo.commit('prereg', [scaffold.preregPath])
      repo.tag('prereg/demo/1')
      rmSync(join(heldout, 'absent'), { recursive: true, force: true })
      expect(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'red', heldoutDir: join(heldout, 'absent') })).not.toThrow()
    })

    test('DEV iterates on an uncommitted skill and never reads held-out content', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('skills/demo/SKILL.md', 'uncommitted edit\n')
      const absent = join(heldout, 'does-not-exist')
      const verified = enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'dev', heldoutDir: absent })
      expect(verified.content.fixtures.heldout).toEqual([])
      expect(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: absent })).toThrow(PreregRefusal)
    })

    test('an extra fixture file is refused like a changed one', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('evals/demo/fixtures/dev/sneaky.md', 'new\n')
      expect(() => enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'red', heldoutDir: heldout })).toThrow(/dev\/sneaky extra/)
    })

    test('dirty skill directory is refused for GREEN', () => {
      const { repo, heldout } = setup()
      const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, scaffold)
      repo.write('skills/demo/SKILL.md', 'uncommitted edit\n')
      expect(codes(checkPreregOrdering(repo.git, scaffold.prereg, 'green').violations)).toEqual(['skill_dirty'])
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
        // Epoch 2 supersedes epoch 1 (whose judge needed a paid key); it closes at the epoch-1 prereg commit.
        expect(prereg.epoch).toBe(2)
        expect(prereg.prev_epoch_closing_commit).toBe(method === 'counterfactual' ? '0aee5ff5d2c828a0121a7e88171abe0c7e68fe92' : 'e8ab1e839dbf47ae6ff8b18f10746c6ac5aa6e8d')
        expect(prereg.runs_per_condition).toBe(5)
        expect(prereg.red_bar).toEqual({ min_baseline_fails_per_fixture: 4, min_fixtures: 2 })
        expect(prereg.green_bar).toEqual({ skill_pooled_pass_min: 17, skill_per_fixture_pass_min: 3, baseline_pooled_pass_max: 10 })
        expect(prereg.false_fire_max).toBe(0)
        expect(prereg.agent_model_id).toBe('opencode-go/beam-free')
        expect(prereg.judge_model_id).toBe('opencode-go/deepseek-v4.1-flash')
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

      test('held-out hashes match the custody directory when it exists', () => {
        if (!parsed.ok) throw new Error(parsed.errors.join('; '))
        const dir = heldoutDir(method)
        if (!existsSync(dir)) {
          console.log(`held-out hashes for ${method} not verified: ${dir} does not exist on this machine`)
          return
        }
        const { problems, fixtures } = verifyPreregContent(parsed.prereg, { evalDir, heldoutDir: dir }, { includeHeldout: true })
        expect(problems).toEqual([])
        expect(fixtures.heldout).toHaveLength(4)
      })
    })
  }
})
