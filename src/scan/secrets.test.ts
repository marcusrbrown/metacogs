import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { findHeldoutPaths, REPO_ROOT, type RuleName, scanRepo, scanText, stampFixture, verifyStamp } from './secrets'

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

  test('the generated host packages and marketplaces are scanned', () => {
    const root = tree({
      'hosts/claude/skills/x/SKILL.md': `mail ${EMAIL}`,
      'hosts/codex/mcp/server.mjs': `const k = "${OPENAI_STYLE}"`,
      '.claude-plugin/marketplace.json': JSON_KEY_FIELD,
      '.agents/plugins/marketplace.json': AWS_STYLE,
    })
    expect(scanRepo({ root }).map((f) => `${f.path}:${f.rule}`)).toEqual([
      'hosts/claude/skills/x/SKILL.md:email',
      'hosts/codex/mcp/server.mjs:openai-style-key',
      '.claude-plugin/marketplace.json:json-key-field',
      '.agents/plugins/marketplace.json:aws-access-key-id',
    ])
  })

  test('the real repository is clean: fixtures, rubrics, redaction lists, and preregs hold no keys, emails, or held-out paths', () => {
    expect(scanRepo({ root: REPO_ROOT })).toEqual([])
  })
})

// --- fixture mode -------------------------------------------------------------------------------------------------
// Every shape is assembled at runtime so this file holds no secret-shaped literal.
const TAIL = 'Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw1Ye6Uf0Hg2Ij4Ok' // 38 characters, no placeholder tell
const GH_PAT = ['github', '_pat_', TAIL].join('')
const ghPrefixed = (letter: string) => ['gh', letter, '_', TAIL].join('')
const ANTHROPIC_NO_DIGIT = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')
const ANTHROPIC_WITH_DIGIT = ['sk', 'ant', 'api03', TAIL].join('-')
const AUTH = (rest: string) => ['Author', 'ization', rest].join('')
const XAPIKEY = (rest: string) => ['x-api', '-key', rest].join('')
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'Zq7Rt2Lm9Xa4Vb'].join('.')
const PEM = (kind: string) => ['-----BEGIN ', kind, 'PRIVATE KEY-----'].join('')
const HOME_MAC = ['/Us', 'ers/', 'alice', '/proj/x.ts'].join('')
const HOME_LINUX = ['/ho', 'me/', 'bob', '/.config'].join('')

/** [label, text, rule fixture mode reports, rules repo mode reports today]. */
const SHAPES: ReadonlyArray<readonly [string, string, RuleName, readonly RuleName[]]> = [
  ['github_pat_ token', `t ${GH_PAT}`, 'github-fine-grained-pat', []],
  ['gho_ token', ghPrefixed('o'), 'github-prefixed-token', []],
  ['ghu_ token', ghPrefixed('u'), 'github-prefixed-token', []],
  ['ghs_ token', ghPrefixed('s'), 'github-prefixed-token', []],
  ['ghr_ token', ghPrefixed('r'), 'github-prefixed-token', []],
  ['anthropic key without a digit', `key ${ANTHROPIC_NO_DIGIT}`, 'anthropic-key', []],
  ['Authorization Bearer', AUTH(`: Bearer ${TAIL}`), 'authorization-header', []],
  ['Authorization Basic', AUTH(': Basic dXNlcjpwYXNz'), 'authorization-header', []],
  ['Authorization bare long token', AUTH(`: ${TAIL}`), 'authorization-header', []],
  ['Authorization lowercase', AUTH(`: bearer ${TAIL}`).toLowerCase(), 'authorization-header', []],
  ['Authorization JSON form', `{"${AUTH('')}": "Bearer ${TAIL}"}`, 'authorization-header', []],
  ['x-api-key plain', XAPIKEY(`: ${TAIL}`), 'x-api-key-header', []],
  ['x-api-key JSON form', `{"${XAPIKEY('')}": "${TAIL}"}`, 'x-api-key-header', []],
  ['x-api-key mixed case', XAPIKEY(': abcd1234').replace('x-api-key', 'X-Api-Key'), 'x-api-key-header', []],
  ['JWT', `jwt ${JWT}`, 'jwt', []],
  ['PEM RSA private key header', PEM('RSA '), 'pem-private-key', []],
  ['PEM bare private key header', PEM(''), 'pem-private-key', []],
  ['PEM OpenSSH private key header', PEM('OPENSSH '), 'pem-private-key', []],
  ['macOS home path', `cwd ${HOME_MAC}`, 'home-path', []],
  ['Linux home path', `"${HOME_LINUX}"`, 'home-path', []],
]

describe('scanText fixture mode', () => {
  for (const [label, text, rule] of SHAPES) {
    test(`flags ${label} with its rule and line, never the value`, () => {
      const findings = scanText('f.json', `before\n${text}\nafter`, 'fixture')
      expect(findings).toEqual([{ path: 'f.json', line: 2, rule }])
      const printed = JSON.stringify(findings)
      for (const secret of [TAIL, JWT, HOME_MAC, HOME_LINUX, 'alice', 'bob']) expect(printed).not.toContain(secret)
    })
  }

  test('an Anthropic key with a digit is reported once, not by two rules', () => {
    expect(scanText('f', ANTHROPIC_WITH_DIGIT, 'fixture')).toHaveLength(1)
  })

  test('a ghp_ token is reported once, by the rule repo mode already has', () => {
    const text = ghPrefixed('p')
    expect(scanText('f', text, 'fixture')).toEqual([{ path: 'f', line: 1, rule: 'github-token' }])
    expect(scanText('f', text)).toEqual([{ path: 'f', line: 1, rule: 'github-token' }])
  })

  test('keeps every repo-mode rule', () => {
    const text = [`key = ${OPENAI_STYLE}`, `aws ${AWS_STYLE}`, `mail ${EMAIL}`, JSON_KEY_FIELD].join('\n')
    expect(scanText('f', text, 'fixture')).toEqual(scanText('f', text, 'repo'))
    expect(scanText('f', text, 'fixture').map((f) => f.rule)).toEqual(['openai-style-key', 'aws-access-key-id', 'email', 'json-key-field'])
  })

  test('negatives: placeholders, short strings, bare prefixes and prose are not flagged', () => {
    const negatives = [
      'prose with sk-abc and sk-ant- and sk-live-123',
      'ghp_short, gho_short, github_pat_short, gh_not_a_token',
      AUTH(': Bearer [REDACTED]'),
      AUTH(': Bearer ${TOKEN}'),
      AUTH(': Bearer short'),
      'the authorization header is required here',
      XAPIKEY(': [REDACTED]'),
      'send the x-api-key header with each request',
      'paths /Users/ and /home/ alone, /Users/<name>/, /home/$USER/',
      'see https://example.com/home/page and src/Users/x',
      'eyJ prefix only, eyJhbGciOiJIUzI1NiJ9.short',
      'BEGIN PRIVATE KEY without dashes, ' + ['-----BEGIN ', 'CERTIFICATE-----'].join(''),
      'user@example.com stays fine',
    ]
    for (const text of negatives) expect(scanText('f', text, 'fixture')).toEqual([])
  })
})

describe('scanText repo mode is unchanged', () => {
  for (const [label, text, , repoRules] of SHAPES) {
    test(`${label}: default and explicit repo mode give today's result`, () => {
      expect(scanText('f', text).map((f) => f.rule)).toEqual([...repoRules])
      expect(scanText('f', text, 'repo')).toEqual(scanText('f', text))
    })
  }

  test('an Anthropic key with a digit is still the hyphenated-sk-key finding', () => {
    expect(scanText('f', ANTHROPIC_WITH_DIGIT).map((f) => f.rule)).toEqual(['hyphenated-sk-key'])
  })

  test('an ordinary email is flagged in both modes, a reserved domain in neither', () => {
    expect(scanText('f', EMAIL)).toEqual([{ path: 'f', line: 1, rule: 'email' }])
    expect(scanText('f', EMAIL, 'fixture')).toEqual([{ path: 'f', line: 1, rule: 'email' }])
    expect(scanText('f', 'a@example.com', 'fixture')).toEqual([])
  })

  test('a short sk- string in prose and a nameless /Users/ match nothing in either mode', () => {
    const text = 'the sk- prefix, sk-short, and /Users/ with no name'
    expect(scanText('f', text)).toEqual([])
    expect(scanText('f', text, 'fixture')).toEqual([])
  })
})

describe('scanRepo fixture mode', () => {
  const rulesOf = (findings: ReturnType<typeof scanRepo>) => findings.map((f) => `${f.path}:${f.line}:${f.rule}`)

  test('walks the whole root, not just SCAN_TARGETS; repo mode over the same tree finds nothing', () => {
    const root = tree({ 'notes/a.txt': `x\n${HOME_MAC}`, 'deep/er/b.md': `${JWT}`, 'top.txt': 'plain' })
    expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['deep/er/b.md:1:jwt', 'notes/a.txt:2:home-path'])
    expect(scanRepo({ root })).toEqual([])
    expect(scanRepo({ root, mode: 'repo' })).toEqual([])
  })

  test('ignores `targets`: the whole root is always walked', () => {
    const root = tree({ 'notes/a.txt': HOME_MAC, 'README.md': 'plain' })
    expect(rulesOf(scanRepo({ root, mode: 'fixture', targets: ['README.md'] }))).toEqual(['notes/a.txt:1:home-path'])
  })

  test('a clean directory passes', () => {
    expect(scanRepo({ root: tree({ 'a.md': 'plain text', 'sub/b.json': '{"ok": true}' }), mode: 'fixture' })).toEqual([])
  })

  test('a file over 2 MB fails instead of passing silently; repo mode still skips it', () => {
    const root = tree({ 'ok.md': 'plain', 'evals/ok.md': 'plain' })
    const big = Buffer.alloc(2_000_001, 0x61)
    writeFileSync(join(root, 'big.txt'), big)
    writeFileSync(join(root, 'evals/big.txt'), big)
    expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['big.txt:0:skipped-oversize', 'evals/big.txt:0:skipped-oversize'])
    expect(scanRepo({ root })).toEqual([])
  })

  test('a file of exactly 2 MB is scanned, not skipped', () => {
    const root = tree({})
    // Newlines, not one 2 MB line: the existing email rule is quadratic on a long run of address characters.
    writeFileSync(join(root, 'edge.txt'), Buffer.alloc(2_000_000, 0x0a))
    expect(scanRepo({ root, mode: 'fixture' })).toEqual([])
  })

  test('a file containing a NUL byte fails, even when the rest would be clean', () => {
    const root = tree({})
    writeFileSync(join(root, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(HOME_MAC)]))
    expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['blob.bin:0:skipped-binary'])
  })

  test('runs, node_modules and .git directories fail, wherever they sit, and are not descended into', () => {
    const root = tree({
      'runs/c1/stdout.jsonl': HOME_MAC,
      'pkg/node_modules/x/index.js': HOME_MAC,
      '.git/config': HOME_MAC,
      'ok.md': 'plain',
    })
    expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['.git:0:skipped-dir', 'pkg/node_modules:0:skipped-dir', 'runs:0:skipped-dir'])
    expect(scanRepo({ root: tree({ 'evals/runs/c1/stdout.jsonl': HOME_MAC }) })).toEqual([])
  })

  test.skipIf(process.getuid?.() === 0)('an unreadable file fails', () => {
    const root = tree({ 'secret.txt': 'plain', 'ok.md': 'plain' })
    chmodSync(join(root, 'secret.txt'), 0o000)
    try {
      expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['secret.txt:0:skipped-unreadable'])
    } finally {
      chmodSync(join(root, 'secret.txt'), 0o600)
    }
  })

  test.skipIf(process.getuid?.() === 0)('an unreadable directory fails', () => {
    const root = tree({ 'locked/a.txt': 'plain' })
    chmodSync(join(root, 'locked'), 0o000)
    try {
      expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['locked:0:skipped-unreadable'])
    } finally {
      chmodSync(join(root, 'locked'), 0o700)
    }
  })

  test('a symlink fails rather than being followed out of the root', () => {
    const outside = tree({ 'leak.txt': HOME_MAC })
    const root = tree({ 'ok.md': 'plain' })
    symlinkSync(outside, join(root, 'link'))
    symlinkSync(join(outside, 'leak.txt'), join(root, 'file-link'))
    expect(rulesOf(scanRepo({ root, mode: 'fixture' }))).toEqual(['file-link:0:skipped-unsupported', 'link:0:skipped-unsupported'])
  })

  test('a missing root fails; a file root is scanned as one file', () => {
    const root = tree({ 'one.md': HOME_MAC })
    expect(rulesOf(scanRepo({ root: join(root, 'nowhere'), mode: 'fixture' }))).toEqual(['.:0:skipped-unreadable'])
    expect(rulesOf(scanRepo({ root: join(root, 'one.md'), mode: 'fixture' }))).toEqual(['one.md:1:home-path'])
  })
})

describe('fixture stamp', () => {
  test('a clean directory gets a clean stamp that matches its content hash', () => {
    const root = tree({ 'a.md': 'plain', 'sub/b.md': 'more' })
    const stamp = stampFixture(root)
    expect(stamp).toMatchObject({ mode: 'fixture', clean: true, files: 2 })
    expect(stamp.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stampFixture(root)).toEqual(stamp)
    expect(verifyStamp(root, stamp)).toBe(true)
  })

  test('the hash depends on content and relative paths, not on where the directory sits', () => {
    const files = { 'a.md': 'plain', 'sub/b.md': 'more' }
    expect(stampFixture(tree(files)).hash).toBe(stampFixture(tree(files)).hash)
    expect(stampFixture(tree({ 'a.md': 'plain', 'sub/c.md': 'more' })).hash).not.toBe(stampFixture(tree(files)).hash)
  })

  test('editing one byte invalidates the stamp', () => {
    const root = tree({ 'a.md': 'plain', 'sub/b.md': 'more' })
    const stamp = stampFixture(root)
    writeFileSync(join(root, 'sub/b.md'), 'mord')
    expect(verifyStamp(root, stamp)).toBe(false)
  })

  test('adding or removing a file invalidates the stamp', () => {
    const root = tree({ 'a.md': 'plain' })
    const stamp = stampFixture(root)
    writeFileSync(join(root, 'extra.md'), 'x')
    expect(verifyStamp(root, stamp)).toBe(false)
    rmSync(join(root, 'extra.md'))
    expect(verifyStamp(root, stamp)).toBe(true)
    rmSync(join(root, 'a.md'))
    expect(verifyStamp(root, stamp)).toBe(false)
  })

  test('an edit that introduces a finding invalidates the stamp and the directory no longer verifies', () => {
    const root = tree({ 'a.md': 'plain' })
    const stamp = stampFixture(root)
    writeFileSync(join(root, 'a.md'), HOME_MAC)
    expect(verifyStamp(root, stamp)).toBe(false)
    expect(stampFixture(root).clean).toBe(false)
  })

  test('a directory with findings or skipped entries is stamped unclean and never verifies', () => {
    const root = tree({ 'a.md': HOME_MAC })
    const stamp = stampFixture(root)
    expect(stamp.clean).toBe(false)
    expect(verifyStamp(root, stamp)).toBe(false)
    expect(verifyStamp(root, { ...stamp, clean: true })).toBe(false) // a forged flag does not help
    const skipping = tree({ 'runs/x': 'plain' })
    expect(stampFixture(skipping).clean).toBe(false)
  })

  test('a missing root does not verify', () => {
    const root = tree({ 'a.md': 'plain' })
    const stamp = stampFixture(root)
    expect(verifyStamp(join(root, 'nowhere'), stamp)).toBe(false)
  })
})

describe('scan:secrets CLI', () => {
  const SCRIPT = join(REPO_ROOT, 'src/scan/secrets.ts')
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test('--mode fixture --root <dir> scans a directory outside the repo and exits 0 when clean, printing the stamp hash', () => {
    const root = tree({ 'a.md': 'plain' })
    const { code, out, err } = run('--mode', 'fixture', '--root', root)
    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain(stampFixture(root).hash)
  })

  test('exits 1 on a finding and prints the rule and location, not the matched text', () => {
    const root = tree({ 'notes/a.md': `fine\n${HOME_MAC}` })
    const { code, err } = run('--mode', 'fixture', '--root', root)
    expect(code).toBe(1)
    expect(err).toContain('notes/a.md:2')
    expect(err).toContain('home-path')
    expect(err).not.toContain('alice')
  })

  test('exits 1 on a skipped entry', () => {
    const { code, err } = run('--mode', 'fixture', '--root', tree({ 'runs/x': 'plain' }))
    expect(code).toBe(1)
    expect(err).toContain('runs  skipped-dir')
  })

  test('fixture mode needs --root; an unknown mode is a usage error', () => {
    expect(run('--mode', 'fixture').code).toBe(2)
    expect(run('--mode', 'bogus', '--root', tree({})).code).toBe(2)
    expect(run('--mode').code).toBe(2)
  })

  test('repo mode over another root behaves as before', () => {
    const root = tree({ 'evals/a.md': `leak ${OPENAI_STYLE}`, 'elsewhere/b.md': HOME_MAC })
    const { code, err } = run('--root', root)
    expect(code).toBe(1)
    expect(err).toContain('evals/a.md:1  openai-style-key')
    expect(err).not.toContain('elsewhere')
  })
})
