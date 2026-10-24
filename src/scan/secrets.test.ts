import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { findHeldoutPaths, REPO_ROOT, scanRepo, scanText } from './secrets'

const scratch: string[] = []

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'metacogs-scan-'))
  scratch.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Assembled at runtime so this file contains no key-shaped literal.
const OPENAI_STYLE = ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')
const AWS_STYLE = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const GITHUB_STYLE = ['ghp', '_', 'a'.repeat(36)].join('')
const HYPHENATED = ['sk', 'proj', 'Zq7Rt2Lm9Xa4Vb8Nc3Kd'].join('-')
const JSON_KEY_FIELD = ['"ke', 'y": "Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw"'].join('')
const API_KEY_ASSIGNMENT = ['api', '_key: "0123456789abcdefXYZ"'].join('')
const TOKEN_ASSIGNMENT = ['tok', "en='abcdefghijklmnop'"].join('')
const EMAIL = ['someone', 'corp-mail.com'].join('@')

describe('scanText', () => {
  test('flags each key shape with its rule and line, never the matched text', () => {
    const text = ['fine line', `key = ${OPENAI_STYLE}`, `aws ${AWS_STYLE}`, `gh ${GITHUB_STYLE}`, API_KEY_ASSIGNMENT].join('\n')
    const findings = scanText('f.md', text)
    expect(findings).toEqual([
      { path: 'f.md', line: 2, rule: 'openai-style-key' },
      { path: 'f.md', line: 3, rule: 'aws-access-key-id' },
      { path: 'f.md', line: 4, rule: 'github-token' },
      { path: 'f.md', line: 5, rule: 'generic-credential' },
    ])
    expect(JSON.stringify(findings)).not.toContain(OPENAI_STYLE)
  })

  test('generic credential needs a quoted value of at least 16 characters', () => {
    expect(scanText('f', 'secret: "short"')).toEqual([])
    expect(scanText('f', 'TOKEN = ${{ secrets.STAGING_TOKEN }}')).toEqual([])
    expect(scanText('f', TOKEN_ASSIGNMENT)).toEqual([{ path: 'f', line: 1, rule: 'generic-credential' }])
  })

  test('a hyphenated sk- key is flagged once; the prefix a key name derives, and placeholders, are not', () => {
    expect(scanText('f', `key = ${HYPHENATED}`)).toEqual([{ path: 'f', line: 1, rule: 'hyphenated-sk-key' }])
    // reported by the first rule only, not twice
    expect(scanText('f', OPENAI_STYLE).map((f) => f.rule)).toEqual(['openai-style-key'])
    expect(scanText('f', 'prefix sk-fro-bot-marcusrbrown-met- and sk-live-123')).toEqual([])
    expect(scanText('f', `sk-fro-bot-marcusrbrown-met-${'0'.repeat(32)}`)).toEqual([])
    expect(scanText('f', 'sk-someone-else-deadbeef')).toEqual([])
  })

  test('a placeholder is declared by the key label, never by the value', () => {
    expect(scanText('f', "PLACEHOLDER_API_KEY = 'Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw'")).toEqual([])
    expect(scanText('f', ['placeholder_to', 'ken: "Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw"'].join(''))).toEqual([])
    expect(scanText('f', ['api', '_key: "Zq7Rt2Lm9Xa4Vb8Nc3Kd-placeholder-5Pw"'].join(''))).toEqual([{ path: 'f', line: 1, rule: 'generic-credential' }])
    expect(scanText('f', ['{"ke', 'y": "Zq7Rt2Lm9Xa4Vb8Nc3Kd-placeholder-5Pw"}'].join(''))).toEqual([{ path: 'f', line: 1, rule: 'json-key-field' }])
    expect(scanText('f', `real = '${['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')}' # not-a-secret`).map((f) => f.rule)).toEqual(['openai-style-key'])
  })

  test('a quoted JSON key field with a long value is flagged; short values are not', () => {
    expect(scanText('f', `{"openai": {"type": "api", ${JSON_KEY_FIELD}}}`)).toEqual([{ path: 'f', line: 1, rule: 'json-key-field' }])
    expect(scanText('f', ['{"ap', 'iKey": "Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw"}'].join(''))).toEqual([{ path: 'f', line: 1, rule: 'json-key-field' }])
    expect(scanText('f', '{"key": "short"}')).toEqual([])
    expect(scanText('f', "PLACEHOLDER_API_KEY = 'placeholder-not-a-secret'")).toEqual([])
  })

  test('near-misses are not key-shaped', () => {
    expect(scanText('f', `sk-short and sk-${'x'.repeat(19)}`)).toEqual([])
    expect(scanText('f', 'AKIA is a prefix; AKIAshort')).toEqual([])
  })

  test('emails are flagged unless the domain is reserved', () => {
    expect(scanText('f', `contact ${EMAIL} today`)).toEqual([{ path: 'f', line: 1, rule: 'email' }])
    expect(scanText('f', 'user@example.com and a@b.example and test@example.invalid and x@host.test')).toEqual([])
  })
})

describe('findHeldoutPaths', () => {
  test('flags evals/<method>/heldout as a directory or a file', () => {
    const root = tree({ 'evals/counterfactual/heldout/h1.md': 'x', 'evals/synthesis/heldout': 'file', 'evals/other/fixtures/dev/d.md': 'x' })
    expect(findHeldoutPaths(root).map((f) => f.path).sort()).toEqual(['evals/counterfactual/heldout', 'evals/synthesis/heldout'])
  })

  test('flags a dangling symlink named heldout', () => {
    const root = tree({ 'evals/m/rubric.md': 'x' })
    symlinkSync(join(root, 'nowhere'), join(root, 'evals/m/heldout'))
    expect(findHeldoutPaths(root).map((f) => f.path)).toEqual(['evals/m/heldout'])
  })

  test('a clean tree has none', () => {
    expect(findHeldoutPaths(tree({ 'evals/m/fixtures/dev/d.md': 'x' }))).toEqual([])
    expect(findHeldoutPaths(tree({ 'README.md': 'x' }))).toEqual([])
  })
})

describe('scanRepo', () => {
  test('scans evals, skills, src, docs, the root documents, and .github', () => {
    const root = tree({
      'evals/m/fixtures/dev/d.md': `leak ${OPENAI_STYLE}`,
      'skills/m/SKILL.md': `mail ${EMAIL}`,
      'src/runner/x.ts': `const k = '${HYPHENATED}'`,
      'docs/plans/p.md': JSON_KEY_FIELD,
      'README.md': `${AWS_STYLE}`,
      'HYPOTHESES.md': `${GITHUB_STYLE}`,
      'AGENTS.md': `${OPENAI_STYLE}`,
      '.github/workflows/ci.yml': `token: "${'x'.repeat(20)}"`,
      'elsewhere/ignored.ts': `${OPENAI_STYLE}`,
    })
    expect(scanRepo({ root }).map((f) => `${f.path}:${f.rule}`)).toEqual([
      'evals/m/fixtures/dev/d.md:openai-style-key',
      'skills/m/SKILL.md:email',
      'src/runner/x.ts:hyphenated-sk-key',
      'docs/plans/p.md:json-key-field',
      'README.md:aws-access-key-id',
      'HYPOTHESES.md:github-token',
      'AGENTS.md:openai-style-key',
      '.github/workflows/ci.yml:generic-credential',
    ])
  })

  test('a held-out path fails even when its contents are clean', () => {
    const root = tree({ 'evals/m/heldout/h1.md': 'harmless text' })
    expect(scanRepo({ root }).map((f) => f.rule)).toContain('heldout-path')
  })

  test('skips gitignored run artifacts and binary files', () => {
    const root = tree({ 'evals/runs/c1/stdout.jsonl': OPENAI_STYLE, 'evals/m/blob.bin': `\u0000${OPENAI_STYLE}` })
    expect(scanRepo({ root })).toEqual([])
  })

  test('a missing target is skipped, a clean tree is clean', () => {
    expect(scanRepo({ root: tree({ 'evals/m/rubric.md': 'plain text' }) })).toEqual([])
  })

  test('a nonexistent target is skipped silently', () => {
    const root = tree({ 'README.md': 'plain text' })
    expect(scanRepo({ root, targets: ['.changeset', 'SECURITY.md', 'nope/at/all.md', 'README.md'] })).toEqual([])
  })

  test('a planted key under .changeset is caught', () => {
    const root = tree({ '.changeset/x.md': `leak ${OPENAI_STYLE}` })
    expect(scanRepo({ root }).map((f) => `${f.path}:${f.line}:${f.rule}`)).toEqual(['.changeset/x.md:1:openai-style-key'])
  })

  test('SECURITY.md, package.json, and CHANGELOG.md are scanned', () => {
    const root = tree({ 'SECURITY.md': `mail ${EMAIL}`, 'package.json': `{ ${JSON_KEY_FIELD} }`, 'CHANGELOG.md': AWS_STYLE })
    expect(scanRepo({ root }).map((f) => `${f.path}:${f.rule}`)).toEqual([
      'SECURITY.md:email',
      'package.json:json-key-field',
      'CHANGELOG.md:aws-access-key-id',
    ])
  })

  test('the real repository is clean: fixtures, rubrics, redaction lists, and preregs hold no keys, emails, or held-out paths', () => {
    expect(scanRepo({ root: REPO_ROOT })).toEqual([])
  })
})
