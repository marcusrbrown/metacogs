// matrix:check / matrix:render — `matrix.json` is the source of truth for host support; the README
// table is a rendered projection that must not drift. A cell may only claim what its evidence shows.
//
//   bun src/matrix/check.ts            validate matrix.json, its evidence, and the README block
//   bun src/matrix/check.ts --render   rewrite the README block from matrix.json, then exit 0
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const MATRIX_SCHEMA_VERSION = 2
export const STATUSES = ['verified', 'content-compatible-untested', 'unverified', 'unsupported'] as const
export type Status = (typeof STATUSES)[number]

/**
 * A plugin entry is either checked by a person on a real install (`verified`) or not (`unverified`). The method
 * statuses that describe skill discovery (`content-compatible-untested`) do not apply to a plugin package.
 */
export const PLUGIN_STATUSES = ['verified', 'unverified'] as const
export type PluginStatus = (typeof PLUGIN_STATUSES)[number]

/** The host whose plugin has an eval-backed record; every other host needs a manual-run note to claim `verified`. */
const EVAL_HOST = 'opencode'

export const README_START = '<!-- matrix:start -->'
export const README_END = '<!-- matrix:end -->'

/** The two shapes an `evidence_ref` may take. Anything else is rejected before touching the filesystem. */
const INSTALL_REF = /^docs\/install\.md#([a-z0-9][a-z0-9-]*)$/
const REPORT_REF = /^evals\/reports\/([a-z][a-z0-9-]{0,63})\/green\.json$/
const PLUGIN_REF = /^(README\.md|docs\/install\.md|evals\/spikes\/feel-drugs\/README\.md)#([a-z0-9][a-z0-9-]*)$/
const KEY = /^[a-z][a-z0-9-]{0,63}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export interface Host {
  name: string
  project_path: string
}

export interface HistoryEntry {
  status: Status
  evidence_ref: string | null
  date: string
  host_version?: string
  model?: string
  judge_model?: string
  note?: string
}

export interface Cell extends HistoryEntry {
  /** Machine verdict is green but a human has not finished reviewing the judge verdicts. */
  pending_verification?: boolean
  history: HistoryEntry[]
}

/** One host's plugin package: what was checked on it, and where the claim is written down. */
export interface PluginEntry {
  status: PluginStatus
  /** The host release the claim is about. Required for `verified`; an `unverified` entry has no run to name. */
  host_version?: string
  evidence_ref: string
  date: string
  note?: string
  /** What a person installed and invoked by hand, and what they saw. Required for `verified` on every host but OpenCode. */
  manual_run?: string
  experimental?: boolean
}

export interface Matrix {
  schema_version: typeof MATRIX_SCHEMA_VERSION
  hosts: Record<string, Host>
  methods: Record<string, Record<string, Cell>>
  /** Plugin packages keyed by host. */
  plugins?: Record<string, PluginEntry>
}

export interface Problem {
  /** Dotted location, e.g. `methods.synthesis.opencode`. */
  where: string
  message: string
}

// ── structural parse ───────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

/** Reports unknown keys so a typo like `evidence_red` cannot silently weaken a rule. */
function closedKeys(where: string, obj: Record<string, unknown>, allowed: readonly string[], out: Problem[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) out.push({ where, message: `unknown field "${key}"` })
  }
}

function parseEntry(where: string, raw: unknown, out: Problem[], extra: readonly string[] = []): HistoryEntry | null {
  if (!isRecord(raw)) {
    out.push({ where, message: 'must be an object' })
    return null
  }
  closedKeys(where, raw, ['status', 'evidence_ref', 'date', 'host_version', 'model', 'judge_model', 'note', ...extra], out)
  const before = out.length
  if (!STATUSES.includes(raw.status as Status)) out.push({ where, message: `status must be one of ${STATUSES.join(', ')}` })
  if (!(raw.evidence_ref === null || nonEmpty(raw.evidence_ref))) out.push({ where, message: 'evidence_ref must be a non-empty string or null' })
  if (!validDate(raw.date)) out.push({ where, message: 'date must be a real YYYY-MM-DD date' })
  for (const key of ['host_version', 'model', 'judge_model', 'note'] as const) {
    if (raw[key] !== undefined && !nonEmpty(raw[key])) out.push({ where, message: `${key} must be a non-empty string when present` })
  }
  if (out.length > before) return null
  const entry: HistoryEntry = {
    status: raw.status as Status,
    evidence_ref: raw.evidence_ref as string | null,
    date: raw.date as string,
  }
  for (const key of ['host_version', 'model', 'judge_model', 'note'] as const) {
    if (raw[key] !== undefined) entry[key] = raw[key] as string
  }
  return entry
}

function parsePlugins(raw: unknown, hosts: Record<string, Host>, out: Problem[]): Record<string, PluginEntry> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    out.push({ where: 'plugins', message: 'must be an object keyed by host' })
    return undefined
  }
  const plugins: Record<string, PluginEntry> = {}
  for (const [host, value] of Object.entries(raw)) {
    const where = `plugins.${host}`
    if (!Object.hasOwn(hosts, host)) {
      out.push({ where, message: `entry for undeclared host "${host}"` })
      continue
    }
    if (!isRecord(value)) {
      out.push({ where, message: 'must be an object' })
      continue
    }
    const before = out.length
    closedKeys(where, value, ['status', 'host_version', 'evidence_ref', 'date', 'note', 'manual_run', 'experimental'], out)
    if (!PLUGIN_STATUSES.includes(value.status as PluginStatus)) out.push({ where, message: `status must be one of ${PLUGIN_STATUSES.join(', ')}` })
    if (!nonEmpty(value.evidence_ref) || !PLUGIN_REF.test(value.evidence_ref)) {
      out.push({ where, message: 'evidence_ref must be README.md#<section>, docs/install.md#<section> or evals/spikes/feel-drugs/README.md#<section>' })
    }
    if (!validDate(value.date)) out.push({ where, message: 'date must be a real YYYY-MM-DD date' })
    for (const key of ['host_version', 'note', 'manual_run'] as const) {
      if (value[key] !== undefined && !nonEmpty(value[key])) out.push({ where, message: `${key} must be a non-empty string when present` })
    }
    if (value.experimental !== undefined && typeof value.experimental !== 'boolean') out.push({ where, message: 'experimental must be a boolean when present' })
    if (out.length > before) continue
    const entry: PluginEntry = {
      status: value.status as PluginStatus,
      evidence_ref: value.evidence_ref as string,
      date: value.date as string,
    }
    for (const key of ['host_version', 'note', 'manual_run'] as const) {
      if (value[key] !== undefined) entry[key] = value[key] as string
    }
    if (value.experimental !== undefined) entry.experimental = value.experimental as boolean
    plugins[host] = entry
  }
  return plugins
}

/** Structural validation only: shapes, enums, key sets. Evidence is checked by `checkEvidence`. */
export function parseMatrix(raw: unknown): { matrix: Matrix | null; problems: Problem[] } {
  const problems: Problem[] = []
  if (!isRecord(raw)) return { matrix: null, problems: [{ where: 'matrix.json', message: 'must be a JSON object' }] }
  closedKeys('matrix.json', raw, ['schema_version', 'hosts', 'methods', 'plugins'], problems)
  if (raw.schema_version !== MATRIX_SCHEMA_VERSION) {
    problems.push({ where: 'schema_version', message: `must be ${MATRIX_SCHEMA_VERSION}` })
  }

  const hosts: Record<string, Host> = {}
  if (!isRecord(raw.hosts) || Object.keys(raw.hosts).length === 0) {
    problems.push({ where: 'hosts', message: 'must be a non-empty object' })
  } else {
    for (const [key, value] of Object.entries(raw.hosts)) {
      const where = `hosts.${key}`
      if (!KEY.test(key)) problems.push({ where, message: 'host key must match ^[a-z][a-z0-9-]{0,63}$' })
      if (!isRecord(value)) {
        problems.push({ where, message: 'must be an object' })
        continue
      }
      closedKeys(where, value, ['name', 'project_path'], problems)
      if (!nonEmpty(value.name)) problems.push({ where, message: 'name must be a non-empty string' })
      if (!nonEmpty(value.project_path)) problems.push({ where, message: 'project_path must be a non-empty string' })
      if (nonEmpty(value.name) && nonEmpty(value.project_path)) hosts[key] = { name: value.name, project_path: value.project_path }
    }
  }

  const plugins = parsePlugins(raw.plugins, hosts, problems)

  const methods: Record<string, Record<string, Cell>> = {}
  if (!isRecord(raw.methods) || Object.keys(raw.methods).length === 0) {
    problems.push({ where: 'methods', message: 'must be a non-empty object' })
  } else {
    for (const [method, cells] of Object.entries(raw.methods)) {
      const methodWhere = `methods.${method}`
      if (!KEY.test(method)) problems.push({ where: methodWhere, message: 'method key must match ^[a-z][a-z0-9-]{0,63}$' })
      if (!isRecord(cells)) {
        problems.push({ where: methodWhere, message: 'must be an object keyed by host' })
        continue
      }
      for (const host of Object.keys(hosts)) {
        if (!(host in cells)) problems.push({ where: methodWhere, message: `missing cell for host "${host}"` })
      }
      const parsed: Record<string, Cell> = {}
      for (const [host, value] of Object.entries(cells)) {
        const where = `${methodWhere}.${host}`
        if (!Object.hasOwn(hosts, host)) {
          problems.push({ where, message: `cell for undeclared host "${host}"` })
          continue
        }
        const entry = parseEntry(where, value, problems, ['pending_verification', 'history'])
        const cellRaw = value as Record<string, unknown>
        const history: HistoryEntry[] = []
        let historyOk = true
        if (isRecord(cellRaw) && !Array.isArray(cellRaw.history)) {
          problems.push({ where, message: 'history must be an array (use [] when empty)' })
          historyOk = false
        } else if (isRecord(cellRaw)) {
          ;(cellRaw.history as unknown[]).forEach((h, i) => {
            const e = parseEntry(`${where}.history[${i}]`, h, problems)
            if (e === null) historyOk = false
            else history.push(e)
          })
        }
        if (isRecord(cellRaw) && cellRaw.pending_verification !== undefined && typeof cellRaw.pending_verification !== 'boolean') {
          problems.push({ where, message: 'pending_verification must be a boolean when present' })
          historyOk = false
        }
        if (entry && historyOk) {
          const cell: Cell = { ...entry, history }
          if (cellRaw.pending_verification !== undefined) cell.pending_verification = cellRaw.pending_verification as boolean
          parsed[host] = cell
        }
      }
      methods[method] = parsed
    }
  }

  // History is the audit trail for downgrades: a verified entry without its evidence is useless.
  for (const [method, cells] of Object.entries(methods)) {
    for (const [host, cell] of Object.entries(cells)) {
      cell.history.forEach((h, i) => {
        if (h.status === 'verified' && h.evidence_ref === null) {
          problems.push({ where: `methods.${method}.${host}.history[${i}]`, message: 'a verified history entry must keep its evidence_ref' })
        }
      })
    }
  }

  if (problems.length > 0) return { matrix: null, problems }
  return { matrix: { schema_version: MATRIX_SCHEMA_VERSION, hosts, methods, ...(plugins ? { plugins } : {}) }, problems }
}

// ── evidence ───────────────────────────────────────────────────────────────

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

/** The body of the section whose heading slugs to `anchor`, or null. Headings inside code fences are ignored. */
export function sectionByAnchor(markdown: string, anchor: string): string | null {
  const lines = markdown.split(/\r\n|\r|\n/)
  let fence = false
  let start = -1
  let level = 0
  const body: string[] = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const heading = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const depth = (heading[1] ?? '').length
      if (start >= 0 && depth <= level) break
      if (start < 0 && slug(heading[2] ?? '') === anchor) {
        start = 1
        level = depth
        continue
      }
    }
    if (start >= 0) body.push(line)
  }
  return start >= 0 ? body.join('\n') : null
}

function readRepoFile(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  // Refs are matched against closed regexes first, so this is belt and braces against traversal.
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) return null
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

interface GreenReport {
  kind?: unknown
  method?: unknown
  verdict?: unknown
  opencode?: { version?: unknown }
  models?: { agent_pinned?: unknown; judge_pinned?: unknown }
  human_review?: { status?: unknown; recomputed?: { verdict?: unknown } }
}

function loadGreenReport(root: string, ref: string, where: string, out: Problem[]): GreenReport | null {
  const text = readRepoFile(root, ref)
  if (text === null) {
    out.push({ where, message: `evidence_ref ${ref} does not exist` })
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) return parsed as GreenReport
  } catch {
    // fall through
  }
  out.push({ where, message: `${ref} is not a JSON object` })
  return null
}

/** Report-backed rules shared by `verified` cells and cells awaiting human review. */
function checkReportEvidence(
  root: string,
  method: string,
  host: string,
  cell: Cell,
  where: string,
  out: Problem[],
): GreenReport | null {
  const ref = cell.evidence_ref
  const match = ref === null ? null : REPORT_REF.exec(ref)
  if (ref === null || match === null) {
    out.push({ where, message: `evidence_ref must be evals/reports/${method}/green.json` })
    return null
  }
  if (match[1] !== method) out.push({ where, message: `evidence_ref ${ref} belongs to method "${match[1]}", not "${method}"` })
  if (host !== 'opencode') {
    out.push({ where, message: 'only OpenCode has a live eval runner; other hosts cannot cite a green report' })
  }
  const report = loadGreenReport(root, ref, where, out)
  if (report === null) return null
  if (report.kind !== 'green' || report.method !== method) {
    out.push({ where, message: `${ref} is not a green report for "${method}"` })
  }
  if (report.verdict !== 'green') out.push({ where, message: `${ref} verdict is "${String(report.verdict)}", not "green"` })
  if (nonEmpty(cell.host_version) && report.opencode?.version !== cell.host_version) {
    out.push({ where, message: `host_version "${cell.host_version}" differs from the report's OpenCode version "${String(report.opencode?.version)}"` })
  }
  if (!nonEmpty(cell.host_version)) out.push({ where, message: 'host_version is required for report-backed evidence' })
  if (cell.model !== report.models?.agent_pinned) {
    out.push({ where, message: `model "${String(cell.model)}" differs from the report's pinned agent "${String(report.models?.agent_pinned)}"` })
  }
  if (cell.judge_model !== report.models?.judge_pinned) {
    out.push({ where, message: `judge_model "${String(cell.judge_model)}" differs from the report's pinned judge "${String(report.models?.judge_pinned)}"` })
  }
  return report
}

function checkInstallRef(root: string, host: string, cell: Cell, where: string, out: Problem[]): void {
  const ref = cell.evidence_ref
  const match = ref === null ? null : INSTALL_REF.exec(ref)
  if (ref === null || match === null) {
    out.push({ where, message: `evidence_ref must be docs/install.md#${host}${cell.status === 'content-compatible-untested' ? '' : ' or null'}` })
    return
  }
  if (match[1] !== host) out.push({ where, message: `evidence_ref ${ref} must point at this host's section (#${host})` })
  const doc = readRepoFile(root, 'docs/install.md')
  if (doc === null) {
    out.push({ where, message: 'evidence_ref points into docs/install.md, which does not exist' })
    return
  }
  const section = sectionByAnchor(doc, match[1] ?? '')
  if (section === null) {
    out.push({ where, message: `docs/install.md has no section for #${match[1]}` })
  } else if (!/https?:\/\/[^\s)>\]]+/.test(section)) {
    out.push({ where, message: `docs/install.md#${match[1]} cites no primary discovery URL` })
  }
}

function checkPluginEvidence(host: string, plugin: PluginEntry, root: string, out: Problem[]): void {
  const where = `plugins.${host}`
  const match = PLUGIN_REF.exec(plugin.evidence_ref)
  if (match !== null) {
    const doc = readRepoFile(root, match[1] ?? '')
    if (doc === null) out.push({ where, message: `evidence_ref points into ${match[1]}, which does not exist` })
    else if (sectionByAnchor(doc, match[2] ?? '') === null) out.push({ where, message: `${match[1]} has no section for #${match[2]}` })
  }
  switch (plugin.status) {
    case 'verified': {
      if (!nonEmpty(plugin.host_version)) out.push({ where, message: 'a verified plugin needs host_version' })
      // OpenCode's claim rests on the recorded scripted-provider suite; the other hosts have no runner, so a person must say what they ran.
      if (host !== EVAL_HOST && !nonEmpty(plugin.manual_run)) {
        out.push({ where, message: 'verified requires a manual_run note saying what was installed and invoked by hand on a real install' })
      }
      break
    }
    case 'unverified': {
      if (!nonEmpty(plugin.note)) out.push({ where, message: 'unverified requires a note giving the reason' })
      if (plugin.manual_run !== undefined) out.push({ where, message: 'manual_run is only valid on verified entries' })
      break
    }
  }
}

export function checkEvidence(matrix: Matrix, root: string): Problem[] {
  const out: Problem[] = []
  for (const [host, plugin] of Object.entries(matrix.plugins ?? {})) checkPluginEvidence(host, plugin, root, out)
  for (const [method, cells] of Object.entries(matrix.methods)) {
    // A method may be listed only when it shipped: a skill exists and its GREEN read was green.
    if (readRepoFile(root, `skills/${method}/SKILL.md`) === null) {
      out.push({ where: `methods.${method}`, message: `skills/${method}/SKILL.md does not exist` })
    }
    const gate = readRepoFile(root, `evals/reports/${method}/green.json`)
    let gateVerdict: unknown
    try {
      gateVerdict = gate === null ? undefined : (JSON.parse(gate) as GreenReport).verdict
    } catch {
      gateVerdict = undefined
    }
    if (gateVerdict !== 'green') {
      out.push({ where: `methods.${method}`, message: `evals/reports/${method}/green.json must exist with verdict "green" before ${method} appears in the matrix` })
    }

    for (const [host, cell] of Object.entries(cells)) {
      const where = `methods.${method}.${host}`
      switch (cell.status) {
        case 'verified': {
          if (cell.pending_verification) out.push({ where, message: 'a verified cell cannot also be pending_verification' })
          const report = checkReportEvidence(root, method, host, cell, where, out)
          if (report !== null) {
            const review = report.human_review
            if (review?.status !== 'complete') {
              out.push({ where, message: `verified requires human_review.status "complete" in ${cell.evidence_ref}; it is "${String(review?.status)}" (use content-compatible-untested with pending_verification until review lands)` })
            } else if (review.recomputed !== undefined && review.recomputed.verdict !== 'green') {
              out.push({ where, message: `human review recomputed the verdict to "${String(review.recomputed.verdict)}"; the cell cannot be verified` })
            }
          }
          break
        }
        case 'content-compatible-untested': {
          if (cell.pending_verification === true) {
            const report = checkReportEvidence(root, method, host, cell, where, out)
            if (report !== null && report.human_review?.status === 'complete') {
              out.push({ where, message: 'human review is complete in the evidence report: promote the cell to verified and drop pending_verification' })
            }
          } else if (cell.evidence_ref !== null && REPORT_REF.test(cell.evidence_ref)) {
            out.push({ where, message: 'report-backed evidence on a non-verified cell requires pending_verification: true' })
          } else {
            checkInstallRef(root, host, cell, where, out)
          }
          break
        }
        case 'unverified':
        case 'unsupported': {
          if (cell.pending_verification) out.push({ where, message: `pending_verification is only valid on content-compatible-untested cells` })
          if (!nonEmpty(cell.note)) out.push({ where, message: `${cell.status} requires a note giving the reason` })
          if (cell.evidence_ref !== null) checkInstallRef(root, host, cell, where, out)
          break
        }
      }
    }
  }
  return out
}

// ── README projection ──────────────────────────────────────────────────────

const escapeCell = (text: string) => text.replace(/\|/g, '\\|')

function cellText(host: Host, cell: Cell): string {
  const head = `\`${cell.status}\`${cell.pending_verification ? ' (pending human review)' : ''}`
  const detail: string[] = []
  if (cell.host_version) detail.push(`${host.name} ${cell.host_version}`)
  if (cell.model) detail.push(`model \`${cell.model}\``)
  if (cell.judge_model) detail.push(`judge \`${cell.judge_model}\``)
  detail.push(cell.date)
  if (cell.evidence_ref) detail.push(`[evidence](${cell.evidence_ref})`)
  const lines = [head, detail.join(' · ')]
  if (cell.note) lines.push(cell.note)
  return escapeCell(lines.join('<br>'))
}

/** The README table for `matrix`: one row per host, one column per method. Deterministic. */
export function renderTable(matrix: Matrix): string {
  const methods = Object.keys(matrix.methods)
  const rows = [
    `| Host | Project skills path | ${methods.join(' | ')} |`,
    `| --- | --- | ${methods.map(() => '---').join(' | ')} |`,
  ]
  for (const [key, host] of Object.entries(matrix.hosts)) {
    const cols = methods.map(m => {
      const cell = matrix.methods[m]?.[key]
      return cell ? cellText(host, cell) : ''
    })
    rows.push(`| [${host.name}](docs/install.md#${key}) | \`${host.project_path}\` | ${cols.join(' | ')} |`)
  }
  return rows.join('\n')
}

function pluginCellText(host: Host, plugin: PluginEntry): string {
  const head = `\`${plugin.status}\`${plugin.experimental ? ' (experimental)' : ''}`
  const detail: string[] = []
  if (plugin.host_version) detail.push(`${host.name} ${plugin.host_version}`)
  detail.push(plugin.date)
  detail.push(`[evidence](${plugin.evidence_ref})`)
  const lines = [head, detail.join(' · ')]
  if (plugin.manual_run) lines.push(`Manual run: ${plugin.manual_run}`)
  if (plugin.note) lines.push(plugin.note)
  return escapeCell(lines.join('<br>'))
}

/** The plugin packages, one row per host, or null when the matrix records none. Deterministic. */
export function renderPlugins(matrix: Matrix): string | null {
  const entries = Object.entries(matrix.plugins ?? {})
  if (entries.length === 0) return null
  const rows = ['| Host | Plugin package |', '| --- | --- |']
  for (const [key, plugin] of entries) {
    const host = matrix.hosts[key]
    if (host) rows.push(`| ${host.name} | ${pluginCellText(host, plugin)} |`)
  }
  return rows.join('\n')
}

/** Everything between the README markers: the method table, then the plugin table when there is one. */
export function renderMatrix(matrix: Matrix): string {
  const plugins = renderPlugins(matrix)
  return plugins === null ? renderTable(matrix) : `${renderTable(matrix)}\n\n${plugins}`
}

interface Block {
  before: string
  inner: string
  after: string
}

function splitBlock(readme: string): Block | string {
  const starts = readme.split(README_START).length - 1
  const ends = readme.split(README_END).length - 1
  if (starts !== 1 || ends !== 1) return `README.md must contain exactly one ${README_START} and one ${README_END} marker`
  const s = readme.indexOf(README_START)
  const e = readme.indexOf(README_END)
  if (e < s) return `README.md has ${README_END} before ${README_START}`
  return { before: readme.slice(0, s), inner: readme.slice(s + README_START.length, e), after: readme.slice(e + README_END.length) }
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').trim()

export function checkReadme(matrix: Matrix, readme: string): Problem[] {
  const block = splitBlock(readme)
  if (typeof block === 'string') return [{ where: 'README.md', message: block }]
  if (normalize(block.inner) !== normalize(renderMatrix(matrix))) {
    return [{ where: 'README.md', message: 'matrix table differs from matrix.json; run `bun run matrix:render`' }]
  }
  return []
}

export function renderReadme(matrix: Matrix, readme: string): string {
  const block = splitBlock(readme)
  if (typeof block === 'string') throw new Error(block)
  return `${block.before}${README_START}\n${renderMatrix(matrix)}\n${README_END}${block.after}`
}

// ── entry points ───────────────────────────────────────────────────────────

export interface CheckOptions {
  root?: string
}

export function loadMatrix(root: string): { matrix: Matrix | null; problems: Problem[] } {
  const text = readRepoFile(root, 'matrix.json')
  if (text === null) return { matrix: null, problems: [{ where: 'matrix.json', message: 'does not exist' }] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { matrix: null, problems: [{ where: 'matrix.json', message: `invalid JSON: ${(error as Error).message}` }] }
  }
  return parseMatrix(raw)
}

export function checkMatrix(options: CheckOptions = {}): Problem[] {
  const root = resolve(options.root ?? REPO_ROOT)
  const { matrix, problems } = loadMatrix(root)
  if (matrix === null) return problems
  const readme = readRepoFile(root, 'README.md')
  return [
    ...checkEvidence(matrix, root),
    ...(readme === null ? [{ where: 'README.md', message: 'does not exist' }] : checkReadme(matrix, readme)),
  ]
}

function report(problems: Problem[]): void {
  console.error('matrix:check failed:')
  for (const p of problems) console.error(`  ${p.where}: ${p.message}`)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const render = args.includes('--render')
  const unknown = args.filter(a => a !== '--render')
  if (unknown.length > 0) {
    console.error('usage: bun src/matrix/check.ts [--render]')
    process.exit(64)
  }
  if (render) {
    const { matrix, problems } = loadMatrix(REPO_ROOT)
    if (matrix === null) {
      report(problems)
      process.exit(1)
    }
    const path = join(REPO_ROOT, 'README.md')
    try {
      writeFileSync(path, renderReadme(matrix, readFileSync(path, 'utf8')))
    } catch (error) {
      console.error(`matrix:render failed: ${(error as Error).message}`)
      process.exit(1)
    }
    console.log('matrix:render: README.md matrix block updated')
  } else {
    const problems = checkMatrix()
    if (problems.length > 0) {
      report(problems)
      process.exitCode = 1
    }
  }
}
