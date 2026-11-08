// scan:secrets — fail on key-shaped strings and emails in committed content, and on any
// `evals/*/heldout/` path in the working tree (held-out fixtures live outside the repo).
//
// Two modes. `repo` (the default) scans the fixed SCAN_TARGETS and silently skips what it cannot read, as `bun run
// scan:secrets` always has. `fixture` scans one whole directory with extra rules for tokens, auth headers, JWTs, PEM
// headers and home paths, and fails closed: anything it cannot scan is a finding, never a silent pass.
import { createHash } from 'node:crypto'
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Roots scanned, relative to the repo root. Missing entries are skipped. */
export const SCAN_TARGETS = [
  'evals',
  'plugin',
  'skills',
  'src',
  'docs',
  'README.md',
  'HYPOTHESES.md',
  'AGENTS.md',
  '.github',
  '.changeset',
  'SECURITY.md',
  'package.json',
  'CHANGELOG.md',
  'hosts',
  '.claude-plugin',
  '.agents/plugins',
] as const

/** Never descended into: gitignored run artifacts, dependencies, VCS data. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'runs'])
const MAX_FILE_BYTES = 2_000_000

export type RuleName =
  | 'openai-style-key'
  | 'hyphenated-sk-key'
  | 'aws-access-key-id'
  | 'github-token'
  | 'generic-credential'
  | 'json-key-field'
  | 'email'
  | 'heldout-path'
  // fixture mode: content rules
  | 'github-fine-grained-pat'
  | 'github-prefixed-token'
  | 'anthropic-key'
  | 'authorization-header'
  | 'x-api-key-header'
  | 'jwt'
  | 'pem-private-key'
  | 'home-path'
  // fixture mode: entries that could not be scanned. Each one is a failure.
  | 'skipped-dir'
  | 'skipped-oversize'
  | 'skipped-binary'
  | 'skipped-unreadable'
  | 'skipped-unsupported'

export type ScanMode = 'repo' | 'fixture'

interface Rule {
  name: RuleName
  pattern: RegExp
  /** A match that cannot be a secret: a placeholder, a reserved address. `line` is the text the match was found in. */
  skip?: (match: RegExpMatchArray, line: string) => boolean
}

/** A run of ten identical characters (`0000…`, `aaaa…`): a placeholder, never the tail of a random key. */
const REPEATED_RUN = /(.)\1{9,}/s
/** Labels that say what they hold. Only ever tested against the key's name, never its value: a real key can contain any word. */
const DECLARED_PLACEHOLDER = /placeholder|not-a-secret/i
/** The identifier a credential key name sits in (`placeholder_` in `placeholder_token`) plus the key name itself. */
const labelOf = (match: RegExpMatchArray, line: string) => `${/[\w-]*$/.exec(line.slice(0, match.index))![0]}${match[1]}`

const RULES: readonly Rule[] = [
  { name: 'openai-style-key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  // Gateway and project keys carry hyphens (`sk-proj-…`, `sk-<name>-…`), which the rule above stops at. A random tail has a
  // digit and ends on a letter or digit; `sk-<key-name>-`, the prefix a key name derives, does neither, so it is not a key.
  { name: 'hyphenated-sk-key', pattern: /sk-(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{15,}[A-Za-z0-9](?![A-Za-z0-9-])/g, skip: (m) => REPEATED_RUN.test(m[0]) },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'generic-credential', pattern: /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"\n]{16,}/gi, skip: (m, line) => DECLARED_PLACEHOLDER.test(labelOf(m, line)) },
  // A quoted JSON field, as in an `auth.json` entry: `"key": "…"` or `"apiKey": "…"`.
  { name: 'json-key-field', pattern: /["'](?:api[_-]?key|key)["']\s*:\s*["'][^"'\n]{20,}["']/gi },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
]

/** A character class for the value of a header: base64, base64url, and the punctuation tokens use. No brackets, quotes or `$`, so `[REDACTED]` and `${TOKEN}` are not values. */
const HEADER_VALUE = '[A-Za-z0-9._~+/=-]'

/** Added in fixture mode only. Repo mode keeps `RULES` exactly. */
const FIXTURE_RULES: readonly Rule[] = [
  { name: 'github-fine-grained-pat', pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  // `ghp_` is the repo rule `github-token`; this covers the other prefixes (OAuth, user-to-server, server-to-server, refresh).
  { name: 'github-prefixed-token', pattern: /gh[ousr]_[A-Za-z0-9]{36,}/g },
  // Reported only when `hyphenated-sk-key` did not already claim the same key (it needs a digit; Anthropic keys need not have one).
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // `Authorization: Bearer x`, `Authorization: Basic x`, `"Authorization": "Bearer x"`, or a bare long token.
  { name: 'authorization-header', pattern: new RegExp(`authorization["']?\\s*[:=]\\s*["']?(?:(?:bearer|basic)\\s+${HEADER_VALUE}{8,}|${HEADER_VALUE}{20,})`, 'gi') },
  { name: 'x-api-key-header', pattern: new RegExp(`x-api-key["']?\\s*[:=]\\s*["']?${HEADER_VALUE}{8,}`, 'gi') },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { name: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  // `/Users/<name>` or `/home/<name>`. The lookbehind keeps `example.com/home/page` and `src/Users/x` out; a name is required.
  { name: 'home-path', pattern: /(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
]

const FIXTURE_ALL_RULES: readonly Rule[] = [...RULES, ...FIXTURE_RULES]

/** RFC 2606 / 6761 reserved names: an address here cannot belong to a real person. */
const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[^.]+\.(?:invalid|example|test|localhost)|invalid|example|test|localhost)$/i

export interface Finding {
  /** Repo-relative, forward-slash path. */
  path: string
  /** 1-based; 0 for path-level findings. */
  line: number
  rule: RuleName
}

/** Findings for one file's text. The matched text is never returned, so reports cannot leak it. */
export function scanText(path: string, text: string, mode: ScanMode = 'repo'): Finding[] {
  const findings: Finding[] = []
  const rules = mode === 'fixture' ? FIXTURE_ALL_RULES : RULES
  const lines = text.split(/\r\n|\r|\n/)
  lines.forEach((content, index) => {
    const flaggedSk = new Set<number>() // where an `sk-` key was already reported on this line
    for (const { name, pattern, skip } of rules) {
      pattern.lastIndex = 0
      for (const match of content.matchAll(pattern)) {
        if (skip?.(match, content)) continue
        if (name === 'email' && RESERVED_EMAIL_DOMAIN.test(match[0].slice(match[0].lastIndexOf('@') + 1))) continue
        if ((name === 'hyphenated-sk-key' || name === 'anthropic-key') && flaggedSk.has(match.index)) continue
        if (name === 'openai-style-key' || name === 'hyphenated-sk-key') flaggedSk.add(match.index)
        findings.push({ path, line: index + 1, rule: name })
      }
    }
  })
  return findings
}

const toPosix = (path: string) => path.split(sep).join('/')

/** Any `evals/<x>/heldout` entry (file, directory, or symlink) in the working tree. */
export function findHeldoutPaths(root: string): Finding[] {
  const evals = join(root, 'evals')
  if (!existsSync(evals)) return []
  const out: Finding[] = []
  for (const entry of readdirSync(evals, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(evals, entry.name, 'heldout')
    // lstat, so a dangling symlink named heldout still counts.
    if (lstatSync(candidate, { throwIfNoEntry: false })) {
      out.push({ path: toPosix(relative(root, candidate)), line: 0, rule: 'heldout-path' })
    }
  }
  return out
}

function* walk(path: string): Generator<string> {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isFile()) {
    yield path
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue
    yield* walk(join(path, entry.name))
  }
}

type FixtureEntry = { kind: 'file'; path: string; bytes: Buffer } | { kind: 'skip'; path: string; rule: RuleName }

const skipped = (path: string, rule: RuleName): FixtureEntry => ({ kind: 'skip', path, rule })
const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** One file for fixture mode. Oversized, binary and unreadable files come back as skips, never as nothing. */
function fixtureFile(absolute: string, path: string): FixtureEntry {
  try {
    if (statSync(absolute).size > MAX_FILE_BYTES) return skipped(path, 'skipped-oversize')
    const bytes = readFileSync(absolute)
    if (bytes.length > MAX_FILE_BYTES) return skipped(path, 'skipped-oversize') // grew between stat and read
    if (bytes.includes(0)) return skipped(path, 'skipped-binary')
    return { kind: 'file', path, bytes }
  } catch {
    return skipped(path, 'skipped-unreadable')
  }
}

/**
 * Every entry under a directory, sorted by name. Symlinks are not followed (a link could point out of the root) and
 * `node_modules`, `.git` and `runs` are not descended into; both are reported so they cannot pass unscanned.
 */
function* fixtureDir(absolute: string, path: string): Generator<FixtureEntry> {
  let entries: Dirent[]
  try {
    entries = readdirSync(absolute, { withFileTypes: true }).sort(byName)
  } catch {
    yield skipped(path === '' ? '.' : path, 'skipped-unreadable')
    return
  }
  for (const entry of entries) {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`
    const childAbsolute = join(absolute, entry.name)
    if (entry.isSymbolicLink()) yield skipped(childPath, 'skipped-unsupported')
    else if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) yield skipped(childPath, 'skipped-dir')
      else yield* fixtureDir(childAbsolute, childPath)
    } else if (entry.isFile()) yield fixtureFile(childAbsolute, childPath)
    else yield skipped(childPath, 'skipped-unsupported')
  }
}

/** The root may be a directory (walked whole) or a single file (scanned as one). Anything else is a failure. */
function* fixtureEntries(root: string): Generator<FixtureEntry> {
  const stat = statSync(root, { throwIfNoEntry: false })
  if (!stat) yield skipped('.', 'skipped-unreadable')
  else if (stat.isDirectory()) yield* fixtureDir(root, '')
  else if (stat.isFile()) yield fixtureFile(root, basename(root))
  else yield skipped('.', 'skipped-unsupported')
}

/** Fixture-mode scan of one root: findings, plus a hash over every entry's path and bytes, taken in the same pass. */
function scanFixtureTree(root: string): { findings: Finding[]; hash: string; files: number } {
  const hash = createHash('sha256')
  const findings: Finding[] = []
  let files = 0
  for (const entry of fixtureEntries(root)) {
    if (entry.kind === 'skip') {
      findings.push({ path: entry.path, line: 0, rule: entry.rule })
      hash.update(`skip\0${entry.path}\0${entry.rule}\0`)
      continue
    }
    files++
    findings.push(...scanText(entry.path, entry.bytes.toString('utf8'), 'fixture'))
    // Length-prefixed, so no file's bytes can read as the next entry's header.
    hash.update(`file\0${entry.path}\0${entry.bytes.length}\0`)
    hash.update(entry.bytes)
    hash.update('\0')
  }
  return { findings, hash: hash.digest('hex'), files }
}

/** A scan result bound to the exact bytes it covered. Editing, adding, removing or renaming any file changes `hash`. */
export interface FixtureStamp {
  mode: 'fixture'
  /** sha256 over every scanned entry's relative path and bytes. Independent of where the directory sits. */
  hash: string
  /** Files that were read and scanned. */
  files: number
  /** True only when the scan had no findings and no skipped entries. */
  clean: boolean
}

export function stampFixture(root: string): FixtureStamp {
  const { findings, hash, files } = scanFixtureTree(resolve(root))
  return { mode: 'fixture', hash, files, clean: findings.length === 0 }
}

/** True only if the directory still hashes to the stamp AND scans clean now. A stamp with a forged `clean` fails the rescan. */
export function verifyStamp(root: string, stamp: FixtureStamp): boolean {
  if (stamp.mode !== 'fixture' || !stamp.clean) return false
  const now = scanFixtureTree(resolve(root))
  return now.findings.length === 0 && now.hash === stamp.hash
}

export interface ScanOptions {
  root?: string
  /** Repo mode only; fixture mode always walks the whole root. */
  targets?: readonly string[]
  /** Default `repo`. */
  mode?: ScanMode
}

export function scanRepo(options: ScanOptions = {}): Finding[] {
  const root = resolve(options.root ?? REPO_ROOT)
  if (options.mode === 'fixture') return scanFixtureTree(root).findings
  const findings: Finding[] = [...findHeldoutPaths(root)]
  for (const target of options.targets ?? SCAN_TARGETS) {
    for (const file of walk(join(root, target))) {
      if (statSync(file).size > MAX_FILE_BYTES) continue
      const bytes = readFileSync(file)
      if (bytes.includes(0)) continue // binary
      findings.push(...scanText(toPosix(relative(root, file)), bytes.toString('utf8')))
    }
  }
  return findings
}

const report = (findings: readonly Finding[]) => {
  for (const f of findings) console.error(`  ${f.path}${f.line > 0 ? `:${f.line}` : ''}  ${f.rule}`)
}

/**
 * `bun src/scan/secrets.ts [--root <dir>]`                 repo mode, as before.
 * `bun src/scan/secrets.ts --mode fixture --root <dir>`   fixture mode over any directory (or file); `--root` is required.
 * Exit 0 clean, 1 on any finding or skipped entry, 2 on a usage error.
 */
if (import.meta.main) {
  const flag = (name: string) => {
    const at = process.argv.indexOf(name)
    return at === -1 ? undefined : (process.argv[at + 1] ?? null) // null: the flag is there with no value
  }
  const modeFlag = flag('--mode')
  const mode = modeFlag === undefined ? 'repo' : modeFlag
  const root = flag('--root')
  if (mode !== 'repo' && mode !== 'fixture') {
    console.error('scan:secrets: --mode takes `repo` or `fixture`')
    process.exitCode = 2
  } else if (mode === 'fixture') {
    if (typeof root !== 'string') {
      console.error('scan:secrets: --mode fixture needs --root <dir>')
      process.exitCode = 2
    } else {
      const { findings, hash, files } = scanFixtureTree(resolve(root))
      if (findings.length > 0) {
        console.error('scan:secrets: fixture scan failed: secrets, tokens, headers, home paths, or entries that could not be scanned (matched text is not printed):')
        report(findings)
        process.exitCode = 1
      } else console.log(`scan:secrets: fixture clean, ${files} files, sha256 ${hash}`)
    }
  } else {
    const findings = scanRepo(typeof root === 'string' ? { root } : {})
    if (findings.length > 0) {
      console.error('scan:secrets: key-shaped strings, emails, or held-out paths found (matched text is not printed):')
      report(findings)
      process.exitCode = 1
    }
  }
}
