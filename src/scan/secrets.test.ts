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

describe('scanText', () => {
  test('flags each key shape with its rule and line, never the matched text', () => {
    const text = ['fine line', `key = ${OPENAI_STYLE}`, `aws ${AWS_STYLE}`, `gh ${GITHUB_STYLE}`, 'api_key: "0123456789abcdefXYZ"'].join('\n')
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
    expect(scanText('f', "token='abcdefghijklmnop'")).toEqual([{ path: 'f', line: 1, rule: 'generic-credential' }])
  })

  test('near-misses are not key-shaped', () => {
    expect(scanText('f', `sk-short and sk-${'x'.repeat(19)}`)).toEqual([])
    expect(scanText('f', 'AKIA is a prefix; AKIAshort')).toEqual([])
  })

  test('emails are flagged unless the domain is reserved', () => {
    expect(scanText('f', 'contact someone@corp-mail.com today')).toEqual([{ path: 'f', line: 1, rule: 'email' }])
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
  test('scans evals, skills, README.md, and HYPOTHESES.md', () => {
    const root = tree({
      'evals/m/fixtures/dev/d.md': `leak ${OPENAI_STYLE}`,
      'skills/m/SKILL.md': `mail someone@corp-mail.com`,
      'README.md': `${AWS_STYLE}`,
      'HYPOTHESES.md': `${GITHUB_STYLE}`,
      'src/ignored.ts': `${OPENAI_STYLE}`,
    })
    expect(scanRepo({ root }).map((f) => `${f.path}:${f.rule}`)).toEqual([
      'evals/m/fixtures/dev/d.md:openai-style-key',
      'skills/m/SKILL.md:email',
      'README.md:aws-access-key-id',
      'HYPOTHESES.md:github-token',
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

  test('the real repository is clean: fixtures, rubrics, redaction lists, and preregs hold no keys, emails, or held-out paths', () => {
    expect(scanRepo({ root: REPO_ROOT })).toEqual([])
  })
})
