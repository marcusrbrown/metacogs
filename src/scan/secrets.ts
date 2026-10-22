// scan:secrets — fail on key-shaped strings and emails in committed content, and on any
// `evals/*/heldout/` path in the working tree (held-out fixtures live outside the repo).
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Roots scanned, relative to the repo root. Missing entries are skipped. */
export const SCAN_TARGETS = ['evals', 'skills', 'README.md', 'HYPOTHESES.md'] as const

/** Never descended into: gitignored run artifacts, dependencies, VCS data. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'runs'])
const MAX_FILE_BYTES = 2_000_000

export type RuleName = 'openai-style-key' | 'aws-access-key-id' | 'github-token' | 'generic-credential' | 'email' | 'heldout-path'

interface Rule {
  name: RuleName
  pattern: RegExp
}

const RULES: readonly Rule[] = [
  { name: 'openai-style-key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'generic-credential', pattern: /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"\n]{16,}/gi },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
]

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
export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r\n|\r|\n/)
  lines.forEach((content, index) => {
    for (const { name, pattern } of RULES) {
      pattern.lastIndex = 0
      for (const match of content.matchAll(pattern)) {
        if (name === 'email' && RESERVED_EMAIL_DOMAIN.test(match[0].slice(match[0].lastIndexOf('@') + 1))) continue
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

export interface ScanOptions {
  root?: string
  targets?: readonly string[]
}

export function scanRepo(options: ScanOptions = {}): Finding[] {
  const root = resolve(options.root ?? REPO_ROOT)
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

if (import.meta.main) {
  const at = process.argv.indexOf('--root')
  const root = at === -1 ? undefined : process.argv[at + 1]
  const findings = scanRepo(root === undefined ? {} : { root })
  if (findings.length > 0) {
    console.error('scan:secrets: key-shaped strings, emails, or held-out paths found (matched text is not printed):')
    for (const f of findings) console.error(`  ${f.path}${f.line > 0 ? `:${f.line}` : ''}  ${f.rule}`)
    process.exitCode = 1
  }
}
