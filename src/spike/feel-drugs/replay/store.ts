/** Private replay store: raw extracts, authored fixture specs, built session exports, and the freeze manifest. */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Finding, type FixtureStamp, scanRepo, stampFixture, verifyStamp } from '../../../scan/secrets'
import { CustodyError, isInside, sha256, stateRoot } from '../../../runner/workspace'
import { METHODS, type Method } from './loads'
import { canonicalRepo } from './repo'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/\/$/, '')

// ── custody ────────────────────────────────────────────────────────────────

export interface Store {
  root: string
  repoRoot: string
  now: () => Date
}

export interface StoreOptions {
  /** Default: `<state root>/replay`. */
  root?: string
  repoRoot?: string
  env?: Record<string, string | undefined>
  home?: string
  now?: () => Date
}

/** Private data never lands in the working tree, however the path was spelled. */
export function assertOutsideRepo(path: string, repoRoot = REPO_ROOT): void {
  if (isInside(path, repoRoot)) throw new CustodyError(`refusing ${path}: it resolves inside the repository ${repoRoot}; replay material must live outside the working tree`)
}

export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Atomic, 0600, through a temp file in the same directory. `exclusive` refuses to replace an existing file. */
export function writePrivate(path: string, text: string, exclusive = false): void {
  if (exclusive && existsSync(path)) throw new Error(`${path} already exists; replay evidence is never overwritten`)
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text, { mode: 0o600, flag: 'w' })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function openStore(options: StoreOptions = {}): Store {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const root = resolve(options.root ?? join(stateRoot(options.env, options.home), 'replay'))
  assertOutsideRepo(root, repoRoot)
  privateDir(root)
  privateDir(join(root, 'raw'))
  privateDir(join(root, 'fixtures'))
  return { root, repoRoot, now: options.now ?? (() => new Date()) }
}

// ── the fixture spec ───────────────────────────────────────────────────────

export const KINDS = ['feel', 'drugs', 'ordinary', 'workflow'] as const
export type FixtureKind = (typeof KINDS)[number]

export interface ToolCall {
  callID?: string
  tool: string
  input: Record<string, unknown>
  output: string
  title?: string
}
export type Turn = { role: 'user'; text: string } | { role: 'assistant'; text: string; tools?: ToolCall[] }

/** An authored, paraphrased moment. All of it is private. */
export interface FixtureSpec {
  id: string
  kind: FixtureKind
  provenance: { project: string; source_session: string; cutoff_message: string; date: string }
  excluded?: { reason: string }
  /** One private line on how the real moment resolved. */
  expected_outcome_ref: string
  turns: Turn[]
  /** The `/feel` argument for this moment. */
  somewhere: string
  /** `workflow` fixtures only: whether a method should load at the point the history stops. */
  expected?: 'fire' | 'silence'
  /** `workflow` fixtures with `expected: fire` only: the methods, any one of which counts as a hit. */
  methods?: Method[]
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const fail = (path: string, want: string): never => {
  throw new SpecError(`${path}: expected ${want}`) // never the value: specs are private
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function object(v: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) return fail(path, 'an object')
  const extra = Object.keys(v).find((k) => !allowed.includes(k))
  if (extra !== undefined) return fail(`${path}.${extra}`, `no such field (allowed: ${allowed.join(', ')})`)
  return v
}
const str = (v: unknown, path: string, nonEmpty = true): string => (typeof v === 'string' && (!nonEmpty || v.trim() !== '') ? v : fail(path, nonEmpty ? 'a non-empty string' : 'a string'))

function parseTool(v: unknown, path: string): ToolCall {
  const o = object(v, path, ['callID', 'tool', 'input', 'output', 'title'])
  if (!isObject(o.input)) fail(`${path}.input`, 'an object')
  return {
    ...(o.callID !== undefined ? { callID: str(o.callID, `${path}.callID`) } : {}),
    tool: str(o.tool, `${path}.tool`),
    input: o.input as Record<string, unknown>,
    output: str(o.output, `${path}.output`, false),
    ...(o.title !== undefined ? { title: str(o.title, `${path}.title`) } : {}),
  }
}

function parseTurn(v: unknown, path: string, index: number): Turn {
  const o = object(v, path, ['role', 'text', 'tools'])
  const want = index % 2 === 0 ? 'user' : 'assistant'
  if (o.role !== want) fail(`${path}.role`, `"${want}" (turns alternate, starting with the user)`)
  const text = str(o.text, `${path}.text`, o.role === 'assistant')
  if (o.role === 'user') {
    if (o.tools !== undefined) fail(`${path}.tools`, 'no tools on a user turn')
    return { role: 'user', text }
  }
  if (o.tools === undefined) return { role: 'assistant', text }
  if (!Array.isArray(o.tools)) return fail(`${path}.tools`, 'an array')
  return { role: 'assistant', text, tools: o.tools.map((t, n) => parseTool(t, `${path}.tools[${n}]`)) }
}

/** Parse, don't validate: a bad spec never becomes a `FixtureSpec`. Messages name fields, never values. */
export function parseSpec(input: unknown): FixtureSpec {
  const o = object(input, 'spec', ['id', 'kind', 'provenance', 'excluded', 'expected_outcome_ref', 'turns', 'somewhere', 'expected', 'methods'])
  const id = str(o.id, 'spec.id')
  if (!ID_PATTERN.test(id)) fail('spec.id', 'lowercase letters, digits and hyphens, up to 64 characters')
  if (!KINDS.includes(o.kind as FixtureKind)) fail('spec.kind', KINDS.join(' | '))
  const workflow = parseWorkflow(o)
  const p = object(o.provenance, 'spec.provenance', ['project', 'source_session', 'cutoff_message', 'date'])
  const date = str(p.date, 'spec.provenance.date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('spec.provenance.date', 'a YYYY-MM-DD date')
  const excluded = o.excluded === undefined ? undefined : { reason: str(object(o.excluded, 'spec.excluded', ['reason']).reason, 'spec.excluded.reason') }
  if (!Array.isArray(o.turns)) fail('spec.turns', 'an array')
  const turns = (o.turns as unknown[]).map((t, n) => parseTurn(t, `spec.turns[${n}]`, n))
  if (!excluded || turns.length > 0) {
    if (turns.length === 0) fail('spec.turns', 'at least one turn')
    if (turns.at(-1)!.role !== 'assistant') fail(`spec.turns[${turns.length - 1}].role`, '"assistant" (the history ends on a finished reply)')
  }
  return {
    id,
    kind: o.kind as FixtureKind,
    provenance: { project: str(p.project, 'spec.provenance.project'), source_session: str(p.source_session, 'spec.provenance.source_session'), cutoff_message: str(p.cutoff_message, 'spec.provenance.cutoff_message'), date },
    ...(excluded ? { excluded } : {}),
    expected_outcome_ref: str(o.expected_outcome_ref, 'spec.expected_outcome_ref'),
    turns,
    somewhere: str(o.somewhere, 'spec.somewhere', false),
    ...workflow,
  }
}

/** `expected` and `methods` for a workflow fixture; neither may appear on any other kind. A silence fixture holds no methods, listed or empty. */
function parseWorkflow(o: Record<string, unknown>): Pick<FixtureSpec, 'expected' | 'methods'> {
  if (o.kind !== 'workflow') {
    if (o.expected !== undefined) fail('spec.expected', 'absent (only a workflow fixture has one)')
    if (o.methods !== undefined) fail('spec.methods', 'absent (only a workflow fixture has any)')
    return {}
  }
  if (o.expected !== 'fire' && o.expected !== 'silence') fail('spec.expected', 'fire | silence')
  if (o.methods !== undefined && !Array.isArray(o.methods)) fail('spec.methods', 'an array')
  const listed = (o.methods ?? []) as unknown[]
  const methods = listed.map((m, n) => ((METHODS as readonly unknown[]).includes(m) ? (m as Method) : fail(`spec.methods[${n}]`, METHODS.join(' | '))))
  if (new Set(methods).size !== methods.length) fail('spec.methods', 'no repeated method')
  if (o.expected === 'silence') {
    if (methods.length > 0) fail('spec.methods', 'none on a silence fixture')
    return { expected: 'silence' }
  }
  if (methods.length === 0) fail('spec.methods', 'at least one method on a fire fixture')
  return { expected: 'fire', methods }
}

// ── the seeded repository ──────────────────────────────────────────────────

/** One commit of a seeded repository. `files` are written and committed; a later commit overwrites an earlier file. */
export interface RepoCommit {
  message: string
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`: author and committer date, so the same payload gives the same history. */
  date: string
  /** The branch this commit lands on. Default: the previous commit's branch, and `main` for the first. A new name branches from the previous commit. */
  branch?: string
  files: Record<string, string>
}

/**
 * The repository a workflow fixture's seed was read from: the files and git history its tool calls show, at the paths they show,
 * written into every attempt's workspace. Kept beside the spec as `repo.json`, in canonical form so its hash is stable.
 */
export interface RepoPayload {
  schema_version: 1
  /** Systematic skill directories (under `skills/`) the seed's paths point into, copied to `.systematic/skills/<name>` from the installed package. */
  systematic_skills: string[]
  commits: RepoCommit[]
  /** The commit (an index into `commits`) that `origin/main` points at. Absent: no `origin/main`. */
  origin_main_after?: number
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** A path inside the workspace, in normal form, outside `.git` and `.systematic`, which the host owns. */
function repoPath(v: unknown, path: string): string {
  const p = str(v, path)
  if (p.includes('\0') || posix.isAbsolute(p) || posix.normalize(p) !== p || p.split('/').includes('..') || p.endsWith('/')) fail(path, 'a relative path in normal form with no ".." segment')
  const top = p.split('/')[0]
  if (top === '.git' || top === '.systematic') fail(path, 'a path outside .git and .systematic')
  return p
}

/** Parse, don't validate: a bad payload never becomes a `RepoPayload`. Messages name fields, never values. */
export function parseRepo(input: unknown): RepoPayload {
  const o = object(input, 'repo', ['schema_version', 'systematic_skills', 'commits', 'origin_main_after'])
  if (o.schema_version !== 1) fail('repo.schema_version', '1')
  if (!Array.isArray(o.systematic_skills)) fail('repo.systematic_skills', 'an array')
  const skills = (o.systematic_skills as unknown[]).map((s, n) => {
    const name = str(s, `repo.systematic_skills[${n}]`)
    return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : fail(`repo.systematic_skills[${n}]`, 'a skill directory name')
  })
  if (new Set(skills).size !== skills.length) fail('repo.systematic_skills', 'no repeated name')
  if (!Array.isArray(o.commits) || o.commits.length === 0) fail('repo.commits', 'a non-empty array')
  const commits = (o.commits as unknown[]).map((c, n): RepoCommit => {
    const at = `repo.commits[${n}]`
    const cm = object(c, at, ['message', 'date', 'branch', 'files'])
    const date = str(cm.date, `${at}.date`)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date) || Number.isNaN(Date.parse(date))) fail(`${at}.date`, 'a UTC time as YYYY-MM-DDTHH:MM:SSZ')
    if (cm.branch !== undefined && (typeof cm.branch !== 'string' || !BRANCH_NAME.test(cm.branch) || cm.branch.includes('..') || cm.branch.endsWith('/') || cm.branch.endsWith('.lock'))) fail(`${at}.branch`, 'a branch name')
    const filesIn = object(cm.files, `${at}.files`, Object.keys(isObject(cm.files) ? cm.files : {}))
    const names = Object.keys(filesIn)
    if (names.length === 0) fail(`${at}.files`, 'at least one file')
    const files: Record<string, string> = {}
    for (const name of names) files[repoPath(name, `${at}.files.<path>`)] = str(filesIn[name], `${at}.files.<path>`, false)
    return { message: str(cm.message, `${at}.message`), date, ...(cm.branch !== undefined ? { branch: cm.branch as string } : {}), files }
  })
  const after = o.origin_main_after
  if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 0 && (after as number) < commits.length)) fail('repo.origin_main_after', 'the index of a commit')
  return { schema_version: 1, systematic_skills: skills, commits, ...(after !== undefined ? { origin_main_after: after as number } : {}) }
}

// ── skill-text placeholders ────────────────────────────────────────────────

/** Where a rendered skill says it lives. A seeded session names no real machine path. */
export const SKILLS_BASE = '/workspace/.systematic/skills'

const SKILL_PLACEHOLDER = /^\{\{(systematic-skill:([a-z0-9-]+))\}\}$/
const FILE_PLACEHOLDER = /^\{\{(systematic-file:([a-z0-9-]+\/[A-Za-z0-9_./-]+))\}\}$/

/** What a build did with the skill-text placeholders: the hash of the unrendered fixture, the Systematic release read, and the hash of each text the model sees. */
export interface RenderRecord {
  template_sha256: string
  systematic_version: string
  skill_text: Record<string, string>
  /** How many home-path examples in the skill texts were rewritten so the fixture scan accepts them. */
  home_path_rewrites: number
}

function treeText(tree: string, rel: string): string {
  const path = join(tree, rel)
  if (!existsSync(path)) throw new SpecError(`systematic tree: ${rel} is missing`)
  return readFileSync(path, 'utf8')
}

/** The same split the plugin makes: a leading `---` block, then the body. The name is the block's `name:` line. */
function skillSource(text: string, rel: string): { name: string; body: string } {
  const match = text.match(/^---\r?\n((?:[\s\S]*?\r?\n)?)---\r?\n([\s\S]*)$/)
  const name = match?.[1]?.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1]
  if (!match || !name) throw new SpecError(`systematic tree: ${rel} has no frontmatter name`)
  return { name, body: match[2] ?? '' }
}

/** The plugin's argument substitution: `$1..$N`, then `$ARGUMENTS`, else the text appended. */
function substituteArguments(body: string, raw: string): string {
  const numbers = [...body.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  let out = body
  if (numbers.length > 0) {
    const last = Math.max(...numbers)
    const args = (raw.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []).map((t) => t.replace(/^["']|["']$/g, ''))
    out = out.replace(/\$(\d+)/g, (_m, n: string) => (Number(n) - 1 >= args.length ? '' : Number(n) === last ? args.slice(Number(n) - 1).join(' ') : (args[Number(n) - 1] ?? '')))
  }
  out = out.replaceAll('$ARGUMENTS', raw)
  return numbers.length === 0 && !body.includes('$ARGUMENTS') && raw.trim().length > 0 ? `${out}\n\n${raw}` : out
}

/** Up to ten files beside `SKILL.md`, depth first in name order, as the plugin lists them. */
function sampledFiles(dir: string, rel: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (found.length >= 10) break
    if (entry.isDirectory()) {
      if (entry.name !== '.git') sampledFiles(join(dir, entry.name), `${rel}/${entry.name}`, found)
    } else if (entry.name !== 'SKILL.md') found.push(`${SKILLS_BASE}/${rel}/${entry.name}`)
  }
  return found
}

/** The text the plugin's skill tool returns for one skill: the same wrapper, base-directory notes and sampled file list. */
function skillToolOutput(tree: string, dirName: string, args: string | undefined): { name: string; output: string } {
  const rel = `skills/${dirName}/SKILL.md`
  const { name, body } = skillSource(treeText(tree, rel), rel)
  const dir = `${SKILLS_BASE}/${dirName}`
  const lead = `Base directory for this skill: ${dir}/\nFile references (@path) in this skill are relative to this directory.\n\n${body.trim()}`.trim()
  const prefixed = name.includes(':') ? name : `systematic:${name}`
  const files = sampledFiles(join(tree, 'skills', dirName), dirName)
  const lines = [`<skill_content name="${prefixed}">`, `# Skill: ${prefixed}`, '', args === undefined ? lead : substituteArguments(lead, args), '', `Base directory for this skill: file://${dir}`, 'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.', 'Note: file list is sampled.']
  if (files.length > 0) lines.push('', '<skill_files>', files.map((f) => `  <file>${f}</file>`).join('\n'), '</skill_files>')
  lines.push('</skill_content>')
  return { name, output: lines.join('\n') }
}

/** The text the read tool returns for a file: its path, numbered lines and a line count. */
export function readToolOutput(path: string, text: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.map((l, i) => `${i + 1}: ${l}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`
}

/**
 * The fixture scan refuses a home path, and the shipped skill texts use `/Users/name/...` as an example of a path never to write.
 * The example keeps its shape with the name in angle brackets. Every arm's text gets the same rewrite, and the count is recorded.
 */
function neutralizeHomePaths(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(/(?<![\w.-])\/(Users|home)\/([A-Za-z0-9._-]+)/g, (_m, root: string, name: string) => ((count += 1), `/${root}/<${name}>`))
  return { text: out, count }
}

/** Placeholder names, in order of appearance. A placeholder is a whole tool output and nothing else. */
export function skillPlaceholders(spec: FixtureSpec): string[] {
  const found: string[] = []
  for (const turn of spec.turns) {
    if (turn.role !== 'assistant') continue
    for (const call of turn.tools ?? []) {
      const key = (SKILL_PLACEHOLDER.exec(call.output) ?? FILE_PLACEHOLDER.exec(call.output))?.[1]
      if (key) found.push(key)
    }
  }
  return found
}

/**
 * Fills each skill-text placeholder from a Systematic package tree (the directory that holds `skills/`). The call that holds a
 * placeholder must be the one the text belongs to, so a seeded history cannot name one skill and show another.
 */
export function renderSkillText(spec: FixtureSpec, tree: string): { spec: FixtureSpec; skillText: Record<string, string>; homePathRewrites: number } {
  const skillText: Record<string, string> = {}
  let homePathRewrites = 0
  const settle = (rendered: string): string => {
    const { text, count } = neutralizeHomePaths(rendered)
    homePathRewrites += count
    return text
  }
  const turns = spec.turns.map((turn, n): Turn => {
    if (turn.role !== 'assistant' || !turn.tools) return turn
    const tools = turn.tools.map((call, t): ToolCall => {
      const path = `spec.turns[${n}].tools[${t}]`
      const skill = SKILL_PLACEHOLDER.exec(call.output)
      const file = skill ? null : FILE_PLACEHOLDER.exec(call.output)
      if (skill) {
        const given = call.input.arguments
        const args = given === undefined || typeof given === 'string' ? given : fail(`${path}.input.arguments`, 'a string')
        const { name, output: raw } = skillToolOutput(tree, skill[2]!, args)
        const output = settle(raw)
        if (call.tool !== 'systematic_skill' || typeof call.input.name !== 'string' || call.input.name.replace(/^systematic:/, '') !== name) fail(path, `a systematic_skill call for the skill the placeholder names`)
        skillText[skill[1]!] = sha256(output)
        return { ...call, output }
      }
      if (file) {
        const rel = file[2]!
        if (rel.split('/').includes('..')) fail(path, 'a placeholder path with no ".." segment')
        const filePath = `${SKILLS_BASE}/${rel}`
        if (call.tool !== 'read' || call.input.filePath !== filePath) fail(path, 'a read call for the file the placeholder names')
        const output = settle(readToolOutput(filePath, treeText(tree, `skills/${rel}`)))
        skillText[file[1]!] = sha256(output)
        return { ...call, output }
      }
      return call
    })
    return { ...turn, tools }
  })
  return { spec: { ...spec, turns }, skillText, homePathRewrites }
}

function systematicVersion(tree: string): string {
  const version = (JSON.parse(treeText(tree, 'package.json')) as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : fail('systematic tree: package.json version', 'a non-empty string')
}

// ── the export builder ─────────────────────────────────────────────────────

export const HOST_VERSION = '1.19.5+harness.bf7f7dfe'
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const BASE_MS = Date.UTC(2026, 0, 1)

export interface ExportToolState {
  status: 'completed'
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number }
}
/** One loose shape for every part kind the builder writes (text, tool, step-start, step-finish). */
export interface ExportPart {
  id: string
  sessionID: string
  messageID: string
  type: 'text' | 'tool' | 'step-start' | 'step-finish'
  text?: string
  time?: { start: number; end: number }
  callID?: string
  tool?: string
  state?: ExportToolState
  reason?: string
  cost?: number
  tokens?: typeof ZERO_TOKENS
}
export interface ExportMessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: { created: number; completed?: number }
  agent: string
  model?: { providerID: string; modelID: string }
  parentID?: string
  mode?: string
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: typeof ZERO_TOKENS
  modelID?: string
  providerID?: string
  finish?: string
}
export interface SessionExport {
  info: {
    id: string
    slug: string
    projectID: string
    directory: string
    path: string
    title: string
    agent: string
    model: { id: string; providerID: string; variant: string }
    version: string
    summary: { additions: number; deletions: number; files: number }
    cost: number
    tokens: typeof ZERO_TOKENS
    permission: { permission: string; pattern: string; action: string }[]
    time: { created: number; updated: number }
  }
  messages: { info: ExportMessageInfo; parts: ExportPart[] }[]
}

export interface BuildOptions {
  /** The import target's workspace. Default: a neutral placeholder, so the frozen export names no real path. */
  directory?: string
  version?: string
  agent?: string
  /** The model recorded on the history's assistant messages. */
  model?: { providerID: string; modelID: string }
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** Host-style id: a prefix, 12 hex digits that sort by time, then 14 characters that do not. */
function hostId(prefix: 'ses' | 'msg' | 'prt', ms: number, seed: string): string {
  const tail = [...createHash('sha256').update(seed).digest().subarray(0, 14)].map((b) => BASE62[b % 62]).join('')
  return `${prefix}_${(ms - BASE_MS + 1).toString(16).padStart(12, '0')}${tail}`
}

/** The session JSON `opencode import` takes. Deterministic: the same spec and options give the same bytes. */
export function buildExport(spec: FixtureSpec, options: BuildOptions = {}): SessionExport {
  if (spec.excluded) throw new SpecError(`spec.excluded: ${spec.id} is excluded and has no export`)
  const directory = options.directory ?? '/workspace'
  const agent = options.agent ?? 'orchestrator'
  const model = options.model ?? { providerID: 'anthropic', modelID: 'claude-opus-5-5' }
  const sessionID = hostId('ses', BASE_MS, `${spec.id}:session`)
  const messages: SessionExport['messages'] = []
  let lastUserId = ''
  spec.turns.forEach((turn, n) => {
    const created = BASE_MS + n * 60_000
    const id = hostId('msg', created, `${spec.id}:msg:${n}`)
    let k = 0
    const part = <T extends Omit<ExportPart, 'id' | 'sessionID' | 'messageID'>>(fields: T): T & Pick<ExportPart, 'id' | 'sessionID' | 'messageID'> => {
      k++
      return { ...fields, id: hostId('prt', created + k, `${spec.id}:prt:${n}:${k}`), sessionID, messageID: id }
    }
    if (turn.role === 'user') {
      lastUserId = id
      messages.push({
        info: { role: 'user', time: { created }, agent, model, id, sessionID },
        parts: [part({ type: 'text', text: turn.text })],
      })
      return
    }
    const tools = turn.tools ?? []
    const parts: ExportPart[] = []
    if (tools.length) {
      parts.push(part({ type: 'step-start' }))
      tools.forEach((call, t) => {
        const start = created + 100 + t * 10
        parts.push(
          part({
            type: 'tool',
            callID: call.callID ?? `call_${hostId('prt', created, `${spec.id}:call:${n}:${t}`).slice(-14)}`,
            tool: call.tool,
            state: { status: 'completed', input: call.input, output: call.output, title: call.title ?? call.tool, metadata: {}, time: { start, end: start + 5 } },
          }),
        )
      })
      parts.push(part({ type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: ZERO_TOKENS }))
    }
    parts.push(part({ type: 'step-start' }), part({ type: 'text', text: turn.text, time: { start: created + 200, end: created + 300 } }), part({ type: 'step-finish', reason: 'stop', cost: 0, tokens: ZERO_TOKENS }))
    messages.push({
      info: { parentID: lastUserId, role: 'assistant', mode: agent, agent, path: { cwd: directory, root: directory }, cost: 0, tokens: ZERO_TOKENS, modelID: model.modelID, providerID: model.providerID, time: { created, completed: created + 5000 }, finish: 'stop', id, sessionID },
      parts,
    })
  })
  return {
    info: {
      id: sessionID,
      slug: spec.id,
      projectID: 'global',
      directory,
      path: '',
      title: `Replay ${spec.id}`,
      agent,
      model: { id: model.modelID, providerID: model.providerID, variant: 'default' },
      version: options.version ?? HOST_VERSION,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: ZERO_TOKENS,
      permission: ['question', 'plan_enter', 'plan_exit'].map((permission) => ({ permission, pattern: '*', action: 'deny' })),
      time: { created: BASE_MS, updated: BASE_MS + spec.turns.length * 60_000 },
    },
    messages,
  }
}

// ── raw extracts ───────────────────────────────────────────────────────────

function checkName(name: string): string {
  if (!ID_PATTERN.test(name)) throw new SpecError(`name: expected lowercase letters, digits and hyphens, up to 64 characters`)
  return name
}

export function saveRaw(store: Store, name: string, raw: unknown): string {
  const path = join(store.root, 'raw', `${checkName(name)}.json`)
  writePrivate(path, `${JSON.stringify(raw)}\n`, true)
  return path
}

export function loadRaw(store: Store, name: string): unknown {
  return JSON.parse(readFileSync(join(store.root, 'raw', `${checkName(name)}.json`), 'utf8'))
}

// ── the manifest ───────────────────────────────────────────────────────────

export interface Review {
  approved_by_author: boolean
  at: string | null
}
export interface ScanReport {
  clean: boolean
  findings: Finding[]
}
export type ManifestEntry =
  | { status: 'draft'; spec_sha256: string; export_sha256: string; last_scan: ScanReport | null; render?: RenderRecord; repo_sha256?: string; review: Review; updated_at: string }
  | { status: 'frozen'; spec_sha256: string; export_sha256: string; stamp: FixtureStamp; render?: RenderRecord; repo_sha256?: string; review: Review; updated_at: string }
  | { status: 'excluded'; spec_sha256: string; reason: string; review: Review; updated_at: string }
type Frozen = Extract<ManifestEntry, { status: 'frozen' }>

interface Manifest {
  schema_version: 1
  fixtures: Record<string, ManifestEntry>
}

const manifestPath = (store: Store) => join(store.root, 'manifest.json')
const fixtureDir = (store: Store, id: string) => join(store.root, 'fixtures', checkName(id))
const UNREVIEWED: Review = { approved_by_author: false, at: null }

function readManifest(store: Store): Manifest {
  if (!existsSync(manifestPath(store))) return { schema_version: 1, fixtures: {} }
  const parsed = JSON.parse(readFileSync(manifestPath(store), 'utf8')) as Partial<Manifest>
  if (parsed.schema_version !== 1 || !isObject(parsed.fixtures)) throw new Error(`${manifestPath(store)} is not a replay manifest`)
  return parsed as Manifest
}

function putEntry(store: Store, id: string, entry: ManifestEntry): ManifestEntry {
  const manifest = readManifest(store)
  manifest.fixtures[id] = entry
  writePrivate(manifestPath(store), `${JSON.stringify(manifest, null, 2)}\n`)
  return entry
}

export type RefusalReason = 'unknown' | 'excluded' | 'not_frozen' | 'edited' | 'not_approved'

export class FixtureRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly id: string,
    detail: string,
  ) {
    super(`fixture ${id}: ${detail}`)
    this.name = 'FixtureRefusal'
  }
}

export class FreezeError extends Error {
  constructor(
    readonly id: string,
    readonly findings: Finding[],
  ) {
    super(`fixture ${id} failed the fixture scan, so it stays draft: ${findings.map((f) => `${f.rule} at ${f.path}${f.line > 0 ? `:${f.line}` : ''}`).join(', ')}`)
    this.name = 'FreezeError'
  }
}

function entryOf(store: Store, id: string): ManifestEntry {
  const entry = readManifest(store).fixtures[checkName(id)]
  if (!entry) throw new FixtureRefusal('unknown', id, 'is not in the manifest')
  return entry
}

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)
const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The files still hash to the entry and the directory still matches its clean scan stamp. */
function intact(store: Store, id: string, entry: Frozen): boolean {
  const dir = fixtureDir(store, id)
  const spec = readText(join(dir, 'spec.json'))
  const built = readText(join(dir, 'export.json'))
  if (spec === null || built === null) return false
  return sha256(spec) === entry.spec_sha256 && sha256(built) === entry.export_sha256 && verifyStamp(dir, entry.stamp)
}

export interface BuildFixtureOptions {
  /** A Systematic package tree (the directory that holds `skills/`). Needed when the spec holds skill-text placeholders. */
  systematicTree?: string
  /** The seeded repository, as parsed JSON: written beside the spec as `repo.json`. Absent: the fixture carries none, and a workflow attempt on it is excluded. */
  repo?: unknown
}

/**
 * Writes the spec and its export and records a draft. The same bytes again change nothing; different bytes drop any freeze and review.
 * A spec with skill-text placeholders is filled from the tree first: the stored spec is the filled one, and the manifest records the hash
 * of the unrendered spec and of each filled text.
 */
export function buildFixture(store: Store, input: unknown, options: BuildFixtureOptions = {}): ManifestEntry {
  const template = parseSpec(input)
  const placeholders = skillPlaceholders(template)
  let spec = template
  let render: RenderRecord | undefined
  if (placeholders.length > 0) {
    if (!options.systematicTree) throw new SpecError(`spec has skill-text placeholders (${placeholders.join(', ')}); building it needs a Systematic tree`)
    const filled = renderSkillText(template, options.systematicTree)
    spec = filled.spec
    render = { template_sha256: sha256(canonical(template)), systematic_version: systematicVersion(options.systematicTree), skill_text: filled.skillText, home_path_rewrites: filled.homePathRewrites }
  }
  const repo = options.repo === undefined ? undefined : parseRepo(options.repo)
  const repoText = repo ? canonicalRepo(repo) : undefined
  const repoHash = repoText === undefined ? undefined : sha256(repoText)
  const dir = fixtureDir(store, spec.id)
  privateDir(dir)
  const specText = canonical(spec)
  const specHash = sha256(specText)
  const exportPath = join(dir, 'export.json')
  const now = store.now().toISOString()
  const prior = readManifest(store).fixtures[spec.id]
  writePrivate(join(dir, 'spec.json'), specText)
  if (repoText !== undefined && !spec.excluded) writePrivate(join(dir, 'repo.json'), repoText)
  else rmSync(join(dir, 'repo.json'), { force: true })

  if (spec.excluded) {
    rmSync(exportPath, { force: true })
    return putEntry(store, spec.id, { status: 'excluded', spec_sha256: specHash, reason: spec.excluded.reason, review: UNREVIEWED, updated_at: now })
  }
  const exportText = canonical(buildExport(spec))
  const exportHash = sha256(exportText)
  writePrivate(exportPath, exportText)
  if (prior?.status === 'frozen' && prior.spec_sha256 === specHash && prior.export_sha256 === exportHash && prior.repo_sha256 === repoHash) return prior
  return putEntry(store, spec.id, { status: 'draft', spec_sha256: specHash, export_sha256: exportHash, last_scan: null, ...(render ? { render } : {}), ...(repoHash ? { repo_sha256: repoHash } : {}), review: UNREVIEWED, updated_at: now })
}

/** Scans the fixture directory in fixture mode and, only if it is clean, stamps it. Any finding leaves the fixture draft. */
export function freezeFixture(store: Store, id: string): Frozen {
  const entry = entryOf(store, id)
  if (entry.status === 'excluded') throw new FixtureRefusal('excluded', id, `is excluded (${entry.reason})`)
  const dir = fixtureDir(store, id)
  const specText = readText(join(dir, 'spec.json'))
  const exportText = readText(join(dir, 'export.json'))
  if (specText === null || exportText === null) throw new FixtureRefusal('edited', id, 'is missing its spec or export; rebuild it')
  const spec = parseSpec(JSON.parse(specText))
  if (spec.id !== id || spec.excluded || canonical(buildExport(spec)) !== exportText) {
    throw new FixtureRefusal('edited', id, 'has an export that is stale against its spec; rebuild it before freezing')
  }
  const now = store.now().toISOString()
  const findings = scanRepo({ root: dir, mode: 'fixture' })
  if (findings.length > 0) {
    putEntry(store, id, { status: 'draft', spec_sha256: sha256(specText), export_sha256: sha256(exportText), last_scan: { clean: false, findings }, ...(entry.status === 'draft' && entry.render ? { render: entry.render } : {}), ...(entry.repo_sha256 ? { repo_sha256: entry.repo_sha256 } : {}), review: UNREVIEWED, updated_at: now })
    throw new FreezeError(id, findings)
  }
  const frozen: Frozen = { status: 'frozen', spec_sha256: sha256(specText), export_sha256: sha256(exportText), stamp: stampFixture(dir), ...(entry.render ? { render: entry.render } : {}), ...(entry.repo_sha256 ? { repo_sha256: entry.repo_sha256 } : {}), review: UNREVIEWED, updated_at: now }
  putEntry(store, id, frozen)
  return frozen
}

/** The author's sign-off on a frozen fixture, valid only while its bytes still match the stamp. */
export function approveFixture(store: Store, id: string): Frozen {
  const entry = entryOf(store, id)
  if (entry.status === 'excluded') throw new FixtureRefusal('excluded', id, `is excluded (${entry.reason})`)
  if (entry.status !== 'frozen') throw new FixtureRefusal('not_frozen', id, 'is not frozen; freeze it first')
  if (!intact(store, id, entry)) throw new FixtureRefusal('edited', id, 'no longer matches its scan stamp; rebuild, freeze and review it again')
  const approved: Frozen = { ...entry, review: { approved_by_author: true, at: store.now().toISOString() }, updated_at: store.now().toISOString() }
  putEntry(store, id, approved)
  return approved
}

export interface LoadedFixture {
  spec: FixtureSpec
  export: SessionExport
  entry: Frozen
  /** The seeded repository, when the fixture carries one. */
  repo?: RepoPayload
}

/** The only way a fixture reaches a run: frozen, scanned clean as of now, unedited, and approved. */
export function loadFrozen(store: Store, id: string): LoadedFixture {
  const entry = entryOf(store, id)
  if (entry.status === 'excluded') throw new FixtureRefusal('excluded', id, `is excluded (${entry.reason})`)
  if (entry.status !== 'frozen') throw new FixtureRefusal('not_frozen', id, 'is not frozen')
  if (!intact(store, id, entry)) throw new FixtureRefusal('edited', id, 'was edited after it was frozen or no longer scans clean; it needs a new scan and review')
  if (!entry.review.approved_by_author) throw new FixtureRefusal('not_approved', id, 'has not been approved by the author')
  const dir = fixtureDir(store, id)
  const repoText = readText(join(dir, 'repo.json'))
  return {
    spec: parseSpec(JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'))),
    export: JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8')) as SessionExport,
    entry,
    ...(repoText !== null ? { repo: parseRepo(JSON.parse(repoText)) } : {}),
  }
}

export interface FixtureListing {
  id: string
  kind: FixtureKind | null
  /** `stale` is a frozen entry whose bytes no longer match. */
  status: ManifestEntry['status'] | 'stale'
  approved: boolean
}

export function listFixtures(store: Store): FixtureListing[] {
  const fixtures = readManifest(store).fixtures
  return Object.keys(fixtures)
    .sort()
    .map((id) => {
      const entry = fixtures[id]!
      let kind: FixtureKind | null = null
      try {
        kind = parseSpec(JSON.parse(readFileSync(join(fixtureDir(store, id), 'spec.json'), 'utf8'))).kind
      } catch {
        // an unreadable spec lists with no kind
      }
      return { id, kind, status: entry.status === 'frozen' && !intact(store, id, entry) ? 'stale' : entry.status, approved: entry.review.approved_by_author }
    })
}
