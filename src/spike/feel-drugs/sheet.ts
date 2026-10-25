/**
 * Renders the committed read sheet for the feel/drugs spike from retained run directories:
 * `bun run spike:feel-drugs:sheet --campaign <dir> [--campaign <dir>] [--out <file>]`.
 *
 * One section per run, grouped by prompt, then model, then arm, so the A, B and C answers to one prompt sit
 * together. Only fields of `run.json` reach the sheet: raw stdout, stderr and request bodies never do. Workspace and
 * home absolute paths are replaced with `<ws>` and `<home>` before anything is written.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'

import { sha256 } from '../../runner/workspace'
import { ARMS, loadPrompts, NUDGE, type RunRecord, SKILL_NAME, type SpikePrompt } from './driver'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SPIKE_DIR = ['evals', 'spikes', 'feel-drugs'] as const

// ── redaction ──────────────────────────────────────────────────────────────

export interface KnownPaths {
  workspaces: readonly string[]
  homes: readonly string[]
  /** The extracted plugin package roots of a plugin run. */
  packages?: readonly string[]
}

/** Matches a path made of characters that can sit in a path inside prose, quotes or a code span. */
const PATH_CHARS = String.raw`[^\s"'\x60<>()]`

/**
 * The run's own workspace and home (recorded in `run.json`), the operator's home, and any other `metacogs-run-*`
 * fixture path become `<ws>` and `<home>`. Plugin runs add package paths (`<pkg>`: the recorded package roots, an
 * extracted `metacogs-packed-*` package, any `node_modules/<package>` directory) and the host's plugin cache
 * (`<cache>`). Package and cache paths go first, since they can sit under a home. Longer paths go first so a nested
 * path is not half-replaced.
 */
export function redactPaths(text: string, known: KnownPaths): string {
  const packages: [string, string][] = (known.packages ?? []).map((p): [string, string] => [p, '<pkg>'])
  const replacements: [string, string][] = [
    ...known.workspaces.map((p): [string, string] => [p, '<ws>']),
    ...[...known.homes, homedir()].map((p): [string, string] => [p, '<home>']),
  ]
  const replaceAll = (input: string, pairs: [string, string][]) => {
    let out = input
    for (const [path, label] of pairs.filter(([p]) => p.length > 1).sort((a, b) => b[0].length - a[0].length)) out = out.split(path).join(label)
    return out
  }
  const packaged = replaceAll(text, packages)
    .replace(new RegExp(`/${PATH_CHARS}*?metacogs-packed-[A-Za-z0-9]+/unpacked/package`, 'g'), '<pkg>')
    .replace(new RegExp(`/${PATH_CHARS}*?/node_modules/(?:@${PATH_CHARS}+?/)?${PATH_CHARS}+?(?=/|$|[\\s"'\x60<>()])`, 'g'), '<pkg>')
    .replace(new RegExp(`/${PATH_CHARS}*?/\\.?cache/opencode(?=/|$|[\\s"'\x60<>()])`, 'g'), '<cache>')
    .replace(new RegExp(`/${PATH_CHARS}*?/opencode-config-dir(?=/|$|[\\s"'\x60<>()])`, 'g'), '<cache>')
  return replaceAll(packaged, replacements)
    .replace(/\/[^\s"'`<>()]*?metacogs-run-[A-Za-z0-9]+\/workspace/g, '<ws>')
    .replace(/\/[^\s"'`<>()]*?metacogs-run-[A-Za-z0-9]+\/home/g, '<home>')
}

// ── loading ────────────────────────────────────────────────────────────────

export function loadRuns(campaignDir: string): RunRecord[] {
  const entries = existsSync(campaignDir) ? readdirSync(campaignDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []
  const runs: RunRecord[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = join(campaignDir, entry.name, 'run.json')
    if (!existsSync(file)) continue
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { schema_version?: unknown }
    if (parsed.schema_version !== 1) throw new Error(`${entry.name}/run.json has an unsupported schema_version (${String(parsed.schema_version)})`)
    const record = parsed as RunRecord
    assertLive(record, `campaign ${basename(campaignDir)}, run ${entry.name}`)
    runs.push({ ...record, variant: record.variant ?? 'unprompted' })
  }
  if (runs.length === 0) throw new Error(`no runs found under ${basename(campaignDir)}`)
  return runs
}

// ── rendering ──────────────────────────────────────────────────────────────

/**
 * A `~~~` fenced block whose fence is longer than any run of `~` or backticks in the text, so nothing inside it (an
 * answer's own code fences, `#` lines, a stray `~~~`) can close it or reach the sheet's outline.
 */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/[`~]+/g) ?? []).map((m) => m.length))
  const fence = '~'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text}\n${fence}`
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. Run headings are unique, so no `-1` suffixes arise. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

const variantOf = (r: RunRecord) => r.variant ?? 'unprompted'

/** Unique per run (prompt, model and variant are in the text), so the where-to-look links can target it. */
function runHeading(run: RunRecord): string {
  return `${run.arm} · run ${run.run} · ${run.prompt_id} · ${run.model}${variantOf(run) === 'nudged' ? ' · nudged' : ''}`
}

/** Order within every prompt: the four models of the campaigns, then anything else alphabetically. */
const SHEET_MODEL_ORDER = ['openai/gpt-6-luna', 'anthropic/claude-haiku-5-5', 'openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5'] as const
const modelRank = (model: string): number => {
  const i = (SHEET_MODEL_ORDER as readonly string[]).indexOf(model)
  return i === -1 ? SHEET_MODEL_ORDER.length : i
}

const byKey = <T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

export interface SheetInput {
  runs: readonly RunRecord[]
  prompts: readonly SpikePrompt[]
  /** The arm C skill file as installed, shown once. */
  skillInstruction: string
  /** Campaign directory names (basenames). */
  sources: readonly string[]
}

/** The sheet is evidence from live models; a scripted stub run must never be read as one. */
function assertLive(run: RunRecord, where: string): void {
  if (run.provider !== 'live') throw new Error(`${where}: provider is "${String(run.provider)}"; the sheet renders live campaigns only`)
}

function renderRun(run: RunRecord): string {
  const redact = (text: string) => redactPaths(text, run.paths)
  const lines = [`#### ${runHeading(run)}`, '', `- Status: ${run.status}${run.reasons.length ? ` (${run.reasons.join(', ')})` : ''}`]
  lines.push(`- Host model: \`${run.host_model}\``)
  lines.push(`- Offered tools: ${run.offered_tools.map((t) => `\`${t}\``).join(', ') || 'none'}`)
  if (run.tool_calls.length === 0) lines.push('- Tool calls: none')
  else {
    lines.push('- Tool calls:')
    for (const call of run.tool_calls) {
      lines.push(`  - \`${call.tool}\` ${redact(JSON.stringify(call.input ?? null))}${call.status && call.status !== 'completed' ? ` [${call.status}]` : ''}`)
    }
  }
  if (run.arm === 'C') {
    lines.push(`- Skill loaded: ${run.skill_loaded ? 'yes' : 'no'}`)
    const f = run.in_reply_fields
    lines.push(`- Frame fields in reply: feel ${f?.feel ? 'yes' : 'no'}, drugs ${f?.drugs ? 'yes' : 'no'}`)
  }
  lines.push(`- Isolation: ${run.isolation.passed ? 'passed' : `FAILED (${run.isolation.failed.join(', ')})`}`)
  lines.push('', 'Answer:', '', run.answer.trim() ? fenced(redact(run.answer.trim()), 'markdown') : '(no text)', '')
  return lines.join('\n')
}

function renderPromptSections(runs: readonly RunRecord[], prompts: readonly SpikePrompt[]): string[] {
  const out: string[] = []
  const byPrompt = byKey(runs, (r) => r.prompt_id)
  const promptOrder = [...prompts.map((p) => p.id).filter((id) => byPrompt.has(id)), ...[...byPrompt.keys()].filter((id) => !prompts.some((p) => p.id === id)).sort()]
  for (const id of promptOrder) {
    const group = byPrompt.get(id) ?? []
    const prompt = prompts.find((p) => p.id === id)
    out.push(`## ${id}`, '')
    const stale = group.find((r) => !prompt || r.prompt_hash !== sha256(prompt.text))
    if (prompt && !stale) out.push('Prompt:', '', ...prompt.text.split('\n').map((l) => `> ${l}`), '', `Rationale: ${prompt.rationale}`, '')
    else out.push(`Prompt text not found for hash ${(stale ?? group[0])?.prompt_hash.slice(0, 12) ?? '?'}: the prompt file differs from the one these runs used.`, '')

    const byModel = byKey(group, (r) => r.model)
    for (const model of [...byModel.keys()].sort((a, b) => modelRank(a) - modelRank(b) || (a < b ? -1 : 1))) {
      out.push(`### ${model}`, '')
      const sorted = [...(byModel.get(model) ?? [])].sort((a, b) => ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm) || a.run - b.run)
      for (const run of sorted) out.push(renderRun(run))
    }
  }

  return out
}

/** The B runs with a `metacog_` call and the C runs that loaded the skill, as links to their run headings. Generated from the run records. */
function whereToLook(runs: readonly RunRecord[], prompts: readonly SpikePrompt[]): string[] {
  const promptRank = (id: string) => {
    const i = prompts.findIndex((p) => p.id === id)
    return i === -1 ? prompts.length : i
  }
  const used = (run: RunRecord): string | undefined => {
    if (run.arm === 'B') {
      const tools = [...new Set(run.tool_calls.map((t) => t.tool).filter((t) => t.startsWith('metacog_')))].sort()
      return tools.length ? tools.join(', ') : undefined
    }
    return run.arm === 'C' && run.skill_loaded ? 'skill loaded' : undefined
  }
  const out = [
    '## Where to look',
    '',
    'Runs where the mechanism was used: arm B runs with a `metacog_` tool call, arm C runs that loaded the skill. Generated from the run files.',
    '',
  ]
  for (const [variant, label] of [['unprompted', 'Unprompted'], ['nudged', 'Told to use it (nudged)']] as const) {
    const group = runs.filter((r) => variantOf(r) === variant)
    if (group.length === 0) continue
    out.push(`**${label}**`, '')
    const hits = group
      .filter((r) => used(r) !== undefined)
      .sort((a, b) => promptRank(a.prompt_id) - promptRank(b.prompt_id) || a.prompt_id.localeCompare(b.prompt_id) || modelRank(a.model) - modelRank(b.model) || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm) || a.run - b.run)
    if (hits.length === 0) out.push('- none')
    for (const r of hits) out.push(`- [${r.prompt_id} · ${r.model} · ${r.arm} run ${r.run}: ${used(r)}](#${headingSlug(runHeading(r))})`)
    out.push('')
  }
  return out
}

export function renderSheet(input: SheetInput): string {
  const { runs, prompts } = input
  for (const run of runs) assertLive(run, `run ${run.arm}-${run.prompt_id}-${run.run} (${run.model})`)
  const out: string[] = [
    '# feel/drugs spike: read sheet',
    '',
    ...whereToLook(runs, prompts),
    '## About this sheet',
    '',
    `Sources: ${input.sources.length ? input.sources.map((s) => `\`${s}\``).join(', ') : '(none)'}`,
    '',
    'Arms: **A** nothing offered; **B** the upstream `feel` and `drugs` registrations over a local stdio MCP; **C** the same frames as a skill the model may load and write in its reply. Every run is shown with the tools the host offered, the tool calls with the arguments the model composed, and the answer. Answers are fenced so their own headings cannot join this outline. Workspace and home paths are redacted to `<ws>` and `<home>`.',
    '',
    '## Arm C instruction text',
    '',
    `The skill \`${SKILL_NAME}\` as installed in arm C runs (shown once):`,
    '',
    fenced(input.skillInstruction.trimEnd(), 'markdown'),
    '',
  ]

  out.push(...renderPromptSections(runs.filter((r) => variantOf(r) === 'unprompted'), prompts))
  const nudgedRuns = runs.filter((r) => variantOf(r) === 'nudged')
  if (nudgedRuns.length > 0) {
    out.push(
      '# Told to use it (nudged)',
      '',
      'Every prompt in this section is the same frozen prompt as above with one sentence appended after a blank line:',
      '',
      fenced(NUDGE.trim()),
      '',
      'There is no nudged arm A. The host wraps a multi-word message in double quotes, so the model receives the prompt and the sentence inside one quoted string, as it did for every unprompted run.',
      '',
      ...renderPromptSections(nudgedRuns, prompts),
    )
  }

  // Safety net over the whole document: every recorded workspace and home, plus the generic fixture patterns.
  return redactPaths(`${out.join('\n').trimEnd()}\n`, {
    workspaces: runs.flatMap((r) => r.paths.workspaces),
    homes: runs.flatMap((r) => r.paths.homes),
  })
}

export interface WriteSheetInput {
  campaigns: readonly string[]
  out: string
  prompts?: readonly SpikePrompt[]
  repoRoot?: string
}

export function writeSheet(input: WriteSheetInput): void {
  const repoRoot = input.repoRoot ?? REPO_ROOT
  const skillFile = join(repoRoot, ...SPIKE_DIR, 'skill', SKILL_NAME, 'SKILL.md')
  const text = renderSheet({
    runs: input.campaigns.flatMap(loadRuns),
    prompts: input.prompts ?? loadPrompts(repoRoot),
    skillInstruction: readFileSync(skillFile, 'utf8'),
    sources: input.campaigns.map((c) => basename(c)),
  })
  writeFileSync(input.out, text)
}

export function main(argv: readonly string[]): number {
  try {
    const { values } = parseNodeArgs({ args: [...argv], options: { campaign: { type: 'string', multiple: true }, out: { type: 'string' } }, strict: true })
    if (!values.campaign?.length) {
      console.error('usage: bun run spike:feel-drugs:sheet --campaign <dir> [--campaign <dir>] [--out <file>]')
      return 64
    }
    const out = values.out ?? join(REPO_ROOT, ...SPIKE_DIR, 'sheet.md')
    writeSheet({ campaigns: values.campaign, out })
    console.log(`wrote ${out}`)
    return 0
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
