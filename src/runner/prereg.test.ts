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

  test('expected_execution_modes must name real modes', () => {
    expect(parsePrereg(JSON.stringify({ ...prereg, expected_execution_modes: ['sequential', 'delegated'] })).ok).toBe(true)
    const bad = parsePrereg(JSON.stringify({ ...prereg, expected_execution_modes: ['sequential', 'telepathy'] }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join('\n')).toContain('expected_execution_modes')
  })

  test('RED and DEV pin no skill tree: the field is null, not absent', () => {
    const { repo, heldout } = setup()
    const scaffold = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
    buildHappyChain(repo, scaffold)
    for (const mode of ['red', 'dev'] as const) {
      expect(enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode, heldoutDir: heldout }).shas.skillTreeSha).toBeNull()
    }
    expect(enforcePrereg({ git: repo.git, repoRoot: repo.dir, method: 'demo', mode: 'green', heldoutDir: heldout }).shas.skillTreeSha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('epoch > 1 needs a closing commit SHA; epoch 1 needs null', () => {
    const e1 = parsePrereg(JSON.stringify({ ...prereg, prev_epoch_closing_commit: 'a'.repeat(40) }))
    expect(e1.ok).toBe(false)
    const e2 = parsePrereg(JSON.stringify({ ...prereg, epoch: 2, prev_epoch_closing_commit: null }))
    expect(e2.ok).toBe(false)
    const ok = parsePrereg(JSON.stringify({ ...prereg, epoch: 2, prev_epoch_closing_commit: 'a'.repeat(40) }))
    expect(ok.ok).toBe(true)
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

  describe('a tag on an unmerged side branch', () => {
    // Epoch 1 closes on main. Epoch 2's skill edit, prereg commit and tag live on a side branch that main never merges;
    // main then carries a byte-identical copy of the prereg file, so the working-tree blob check passes.
    function unmergedSideTag() {
      const { repo, heldout } = setup()
      const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      const chain1 = buildHappyChain(repo, s1)
      repo.write('evals/demo/report.txt', 'epoch 1 read\n')
      const closing = repo.commit('epoch 1 close', ['evals/demo/report.txt'])
      const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: closing, heldoutDir: heldout })
      repo.sh(['checkout', '-q', '-b', 'side'])
      repo.write('skills/demo/SKILL.md', 'edited on the side branch\n')
      repo.commit('side skill edit', ['skills/demo'])
      writePrereg(repo, s2)
      repo.commit('epoch 2 prereg (side)', [s2.preregPath])
      repo.tag('prereg/demo/2')
      repo.sh(['checkout', '-q', 'main'])
      writePrereg(repo, s2)
      repo.commit('copy of the prereg on main', [s2.preregPath])
      return { repo, s2, chain1 }
    }

    test('tag_not_in_history: the tagged commit is not an ancestor of HEAD', () => {
      const { repo, s2 } = unmergedSideTag()
      const { violations } = checkPreregOrdering(repo.git, s2.prereg, 'red')
      expect(codes(violations)).toContain('tag_not_in_history')
      expect(violations.find((v) => v.code === 'tag_not_in_history')?.message).toContain(repo.git.tag('prereg/demo/2')!.commitSha.slice(0, 12))
    })

    test('skill_changed_since_tag: HEAD carries a different skill tree than the tag, with no skill commit in the epoch to explain it', () => {
      const { repo, s2 } = unmergedSideTag()
      const { violations } = checkPreregOrdering(repo.git, s2.prereg, 'green')
      expect(codes(violations)).toContain('skill_changed_since_tag')
      expect(codes(violations)).toContain('tag_not_in_history')
    })
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

    describe('carry-over: the skill already exists and no skill commit follows the new tag', () => {
      function epoch2WithoutSkillEdit() {
        const { repo, heldout } = setup()
        const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
        buildHappyChain(repo, s1)
        repo.write('evals/demo/report.txt', 'epoch 1 read\n')
        const closing = repo.commit('epoch 1 close (reports only)', ['evals/demo/report.txt'])
        const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: closing, heldoutDir: heldout })
        writePrereg(repo, s2)
        const pre2 = repo.commit('epoch 2 prereg', [s2.preregPath])
        repo.tag('prereg/demo/2')
        return { repo, s2, pre2 }
      }

      test('tag strictly before HEAD, skill unchanged: GREEN permitted, no first skill commit reported', () => {
        const { repo, s2, pre2 } = epoch2WithoutSkillEdit()
        repo.write('evals/demo/dev-report.txt', 'dev read\n')
        repo.commit('dev reads', ['evals/demo/dev-report.txt'])
        const r = checkPreregOrdering(repo.git, s2.prereg, 'green')
        expect(r.violations).toEqual([])
        expect(r.shas.commitSha).toBe(pre2)
        expect(r.shas.firstSkillCommit).toBeNull()
        expect(r.shas.skillTreeSha).toBe(repo.git.treeAt('HEAD', 'skills/demo') ?? undefined)
      })

      test('HEAD is the tagged commit itself: refused until something is committed after the tag', () => {
        const { repo, s2 } = epoch2WithoutSkillEdit()
        expect(codes(checkPreregOrdering(repo.git, s2.prereg, 'green').violations)).toEqual(['tag_equals_head'])
      })

      test('a skill edit before the new tag does not count as this epoch; one after it follows the normal rule', () => {
        const { repo, s2 } = epoch2WithoutSkillEdit()
        repo.write('skills/demo/SKILL.md', 'edited after the epoch 2 tag\n')
        const edit = repo.commit('skill edit', ['skills/demo'])
        const r = checkPreregOrdering(repo.git, s2.prereg, 'green')
        expect(r.violations).toEqual([])
        expect(r.shas.firstSkillCommit).toBe(edit)
      })
    })

    describe('the previous epoch\'s read', () => {
      const report = (epoch: number) => `${JSON.stringify({ prereg: { epoch }, verdict: 'green-miss' })}\n`
      const NEW_HELDOUT = { h9: 'e'.repeat(64) }

      /** Epoch 1 → (optional read report) → (optional skill edit) → epoch 2 prereg and tag. Returns the pieces tests vary. */
      function twoEpochs(opts: { read?: 'green.json' | 'green.epoch1.json'; edit?: boolean; closing: 'skill' | 'read' | 'edit'; newHeldout?: boolean }) {
        const { repo, heldout } = setup()
        const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
        const chain1 = buildHappyChain(repo, s1)
        let readCommit: string | null = null
        if (opts.read) {
          repo.write(`evals/reports/demo/${opts.read}`, report(1))
          readCommit = repo.commit('epoch 1 read', [`evals/reports/demo/${opts.read}`])
        }
        let editCommit: string | null = null
        if (opts.edit) {
          repo.write('skills/demo/SKILL.md', 'edited after the read\n')
          editCommit = repo.commit('skill edit', ['skills/demo'])
        }
        const closing = { skill: chain1.skillCommit, read: readCommit, edit: editCommit }[opts.closing]
        if (!closing) throw new Error('test setup: closing commit does not exist')
        const base = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: closing, heldoutDir: heldout })
        const s2 = opts.newHeldout ? { ...base, prereg: { ...base.prereg, fixture_hashes: { ...base.prereg.fixture_hashes, heldout: NEW_HELDOUT } } } : base
        writePrereg(repo, s2)
        repo.commit('epoch 2 prereg', [s2.preregPath])
        repo.tag('prereg/demo/2')
        return { repo, s1, s2, readCommit, editCommit, chain1 }
      }

      test('epoch_base_before_prior_read: a base after the epoch 1 tag but before its read report is refused', () => {
        const { repo, s2, readCommit } = twoEpochs({ read: 'green.json', closing: 'skill', newHeldout: true })
        const { violations } = checkPreregOrdering(repo.git, s2.prereg, 'red')
        expect(codes(violations)).toEqual(['epoch_base_before_prior_read'])
        expect(violations[0]?.message).toContain(readCommit!.slice(0, 12))
      })

      test('a base at the read report commit, or after it, is permitted', () => {
        const exact = twoEpochs({ read: 'green.json', closing: 'read', newHeldout: true })
        expect(checkPreregOrdering(exact.repo.git, exact.s2.prereg, 'red').violations).toEqual([])
        const later = twoEpochs({ read: 'green.json', edit: true, closing: 'edit', newHeldout: true })
        expect(checkPreregOrdering(later.repo.git, later.s2.prereg, 'red').violations).toEqual([])
      })

      test('the anchor is the commit that first added the report, even after it is renamed to green.epoch1.json', () => {
        const early = twoEpochs({ read: 'green.epoch1.json', closing: 'skill', newHeldout: true })
        expect(codes(checkPreregOrdering(early.repo.git, early.s2.prereg, 'red').violations)).toEqual(['epoch_base_before_prior_read'])
        const ok = twoEpochs({ read: 'green.epoch1.json', closing: 'read', newHeldout: true })
        expect(checkPreregOrdering(ok.repo.git, ok.s2.prereg, 'red').violations).toEqual([])
      })

      test('no read report on record: the rule is skipped', () => {
        const { repo, s2 } = twoEpochs({ closing: 'skill', newHeldout: true })
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
      })

      test('a report that belongs to another epoch is not this epoch\'s read', () => {
        const { repo, heldout } = setup()
        const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
        const chain1 = buildHappyChain(repo, s1)
        repo.write('evals/reports/demo/green.json', report(7))
        repo.commit('some other epoch\'s report', ['evals/reports/demo/green.json'])
        const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: chain1.skillCommit, heldoutDir: heldout })
        writePrereg(repo, s2)
        repo.commit('epoch 2 prereg', [s2.preregPath])
        repo.tag('prereg/demo/2')
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
      })

      test('a report added after the epoch 2 tag does not move the anchor', () => {
        const { repo, s2, chain1 } = twoEpochs({ closing: 'skill', newHeldout: true })
        repo.write('evals/reports/demo/green.json', report(1))
        repo.commit('late report', ['evals/reports/demo/green.json'])
        expect(chain1.skillCommit).toBeTruthy()
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
      })

      test('heldout_reused_after_skill_edit: a read, then a skill edit, then the same held-out fixtures: refused', () => {
        const { repo, s2, editCommit } = twoEpochs({ read: 'green.json', edit: true, closing: 'edit' })
        const { violations } = checkPreregOrdering(repo.git, s2.prereg, 'red')
        expect(codes(violations)).toEqual(['heldout_reused_after_skill_edit'])
        expect(violations[0]?.message).toContain('h1')
        expect(violations[0]?.message).toContain(editCommit!.slice(0, 12))
      })

      test('a partly reused held-out set is still refused', () => {
        const { repo, s1, s2 } = twoEpochs({ read: 'green.json', edit: true, closing: 'edit', newHeldout: true })
        const partial = { ...s2.prereg, fixture_hashes: { ...s2.prereg.fixture_hashes, heldout: { ...s2.prereg.fixture_hashes.heldout, h1: s1.prereg.fixture_hashes.heldout.h1! } } }
        expect(codes(checkPreregOrdering(repo.git, partial, 'red').violations)).toEqual(['heldout_reused_after_skill_edit'])
      })

      test('a read, a skill edit, and a new held-out set: permitted', () => {
        const { repo, s2 } = twoEpochs({ read: 'green.json', edit: true, closing: 'edit', newHeldout: true })
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
      })

      test('heldout_salt_changed_after_read: a new salt hides the reuse from the hash comparison; the salt change itself is refused', () => {
        const { repo, s1, s2 } = twoEpochs({ read: 'green.json', edit: true, closing: 'edit' })
        const resalted = { ...s2.prereg, salt: `${s1.prereg.salt}-new`, fixture_hashes: { ...s2.prereg.fixture_hashes, heldout: NEW_HELDOUT } }
        const { violations } = checkPreregOrdering(repo.git, resalted, 'red')
        expect(codes(violations)).toEqual(['heldout_salt_changed_after_read'])
      })

      test('a post-read epoch with a skill edit must keep the salt even for a genuinely new held-out set', () => {
        const { repo, s1, s2 } = twoEpochs({ read: 'green.json', edit: true, closing: 'edit', newHeldout: true })
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
        const resalted = { ...s2.prereg, salt: `${s1.prereg.salt}-new` }
        expect(codes(checkPreregOrdering(repo.git, resalted, 'red').violations)).toEqual(['heldout_salt_changed_after_read'])
      })

      test('a new salt is fine when the previous epoch never read (a red-retained method)', () => {
        const unread = twoEpochs({ edit: true, closing: 'edit', newHeldout: true })
        const a = { ...unread.s2.prereg, salt: `${unread.s1.prereg.salt}-new` }
        expect(checkPreregOrdering(unread.repo.git, a, 'red').violations).toEqual([])
      })

      test('the same held-out set is fine when the previous epoch never read it (a red-retained method)', () => {
        const { repo, s2 } = twoEpochs({ edit: true, closing: 'edit' })
        expect(checkPreregOrdering(repo.git, s2.prereg, 'red').violations).toEqual([])
      })

      test('a read set carried into the next epoch is fine when the skill was not edited between those tags', () => {
        // Epoch 2 reads its own held-out set; epoch 3 keeps both the skill and that set. (The read itself is the one-shot guard's job.)
        const { repo, heldout } = setup()
        const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
        buildHappyChain(repo, s1)
        const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: repo.head(), heldoutDir: heldout })
        const s2n = { ...s2, prereg: { ...s2.prereg, fixture_hashes: { ...s2.prereg.fixture_hashes, heldout: NEW_HELDOUT } } }
        writePrereg(repo, s2n)
        repo.commit('epoch 2 prereg', [s2n.preregPath])
        repo.tag('prereg/demo/2')
        repo.write('evals/reports/demo/green.json', report(2))
        const read2 = repo.commit('epoch 2 read', ['evals/reports/demo/green.json'])
        const s3 = scaffoldMethod(repo, 'demo', { epoch: 3, prevClosing: read2, heldoutDir: heldout, overrides: { fixture_hashes: s2n.prereg.fixture_hashes } })
        writePrereg(repo, s3)
        repo.commit('epoch 3 prereg', [s3.preregPath])
        repo.tag('prereg/demo/3')
        expect(checkPreregOrdering(repo.git, s3.prereg, 'red').violations).toEqual([])
        // The same chain with a skill edit after the epoch 2 read is the burn case.
        const { repo: r2, heldout: h2 } = setup()
        const t1 = scaffoldMethod(r2, 'demo', { heldoutDir: h2 })
        buildHappyChain(r2, t1)
        const t2 = scaffoldMethod(r2, 'demo', { epoch: 2, prevClosing: r2.head(), heldoutDir: h2 })
        const t2n = { ...t2, prereg: { ...t2.prereg, fixture_hashes: { ...t2.prereg.fixture_hashes, heldout: NEW_HELDOUT } } }
        writePrereg(r2, t2n)
        r2.commit('epoch 2 prereg', [t2n.preregPath])
        r2.tag('prereg/demo/2')
        r2.write('evals/reports/demo/green.json', report(2))
        r2.commit('epoch 2 read', ['evals/reports/demo/green.json'])
        r2.write('skills/demo/SKILL.md', 'edited after epoch 2 read\n')
        const edit2 = r2.commit('skill edit', ['skills/demo'])
        const t3 = scaffoldMethod(r2, 'demo', { epoch: 3, prevClosing: edit2, heldoutDir: h2, overrides: { fixture_hashes: t2n.prereg.fixture_hashes } })
        writePrereg(r2, t3)
        r2.commit('epoch 3 prereg', [t3.preregPath])
        r2.tag('prereg/demo/3')
        expect(codes(checkPreregOrdering(r2.git, t3.prereg, 'red').violations)).toEqual(['heldout_reused_after_skill_edit'])
      })
    })

    test('epoch_base_before_prior_tag: the base may not precede the previous epoch\'s own prereg tag', () => {
      const { repo, heldout } = setup()
      const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      const chain1 = buildHappyChain(repo, s1)
      // The epoch 1 fixtures commit is an ancestor of the epoch 1 prereg tag, so epoch 2 would reach back into epoch 1.
      const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: chain1.fixturesCommit, heldoutDir: heldout })
      writePrereg(repo, s2)
      repo.commit('epoch 2 prereg', [s2.preregPath])
      repo.tag('prereg/demo/2')
      const { violations } = checkPreregOrdering(repo.git, s2.prereg, 'red')
      expect(codes(violations)).toContain('epoch_base_before_prior_tag')
      expect(violations.find((v) => v.code === 'epoch_base_before_prior_tag')?.message).toContain(chain1.preregCommit.slice(0, 12))
    })

    test('epoch_base_before_prior_tag: the previous epoch\'s tag must exist', () => {
      const { repo, heldout } = setup()
      const s1 = scaffoldMethod(repo, 'demo', { heldoutDir: heldout })
      buildHappyChain(repo, s1)
      repo.sh(['tag', '-d', 'prereg/demo/1'])
      repo.write('evals/demo/report.txt', 'x\n')
      const closing = repo.commit('close', ['evals/demo/report.txt'])
      const s2 = scaffoldMethod(repo, 'demo', { epoch: 2, prevClosing: closing, heldoutDir: heldout })
      writePrereg(repo, s2)
      repo.commit('epoch 2 prereg', [s2.preregPath])
      repo.tag('prereg/demo/2')
      expect(codes(checkPreregOrdering(repo.git, s2.prereg, 'red').violations)).toContain('epoch_base_before_prior_tag')
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
        // Epoch 3 was the first paid CLIProxyAPI round; later epochs keep its pins. Which epoch is current is the committed file's business:
        // a literal here would break on every new epoch, so it is read from the file and only bounded.
        expect(prereg.epoch).toBeGreaterThanOrEqual(3)
        expect(prereg.prev_epoch_closing_commit).toMatch(/^[0-9a-f]{40}$/)
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
