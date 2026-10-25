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
}

/**
 * The run's own workspace and home (recorded in `run.json`), the operator's home, and any other `metacogs-run-*`
 * fixture path become `<ws>` and `<home>`. Longer paths go first so a nested path is not half-replaced.
 */
export function redactPaths(text: string, known: KnownPaths): string {
  const replacements: [string, string][] = [
    ...known.workspaces.map((p): [string, string] => [p, '<ws>']),
    ...[...known.homes, homedir()].map((p): [string, string] => [p, '<home>']),
  ]
  let out = text
  for (const [path, label] of replacements.filter(([p]) => p.length > 1).sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(path).join(label)
  }
  return out
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
    runs.push({ ...record, variant: record.variant ?? 'unprompted' })
  }
  if (runs.length === 0) throw new Error(`no runs found under ${basename(campaignDir)}`)
  return runs
}

// ── rendering ──────────────────────────────────────────────────────────────

/** A fenced block that no backtick run inside the text can close. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
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

function renderRun(run: RunRecord): string {
  const redact = (text: string) => redactPaths(text, run.paths)
  const lines = [`#### ${run.arm} · run ${run.run}`, '', `- Status: ${run.status}${run.reasons.length ? ` (${run.reasons.join(', ')})` : ''}`]
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
  lines.push('', 'Answer:', '', run.answer.trim() ? fenced(redact(run.answer.trim())) : '(no text)', '')
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

export function renderSheet(input: SheetInput): string {
  const { runs, prompts } = input
  const out: string[] = [
    '# feel/drugs spike: read sheet',
    '',
    `Sources: ${input.sources.length ? input.sources.map((s) => `\`${s}\``).join(', ') : '(none)'}`,
    '',
    'Arms: **A** nothing offered; **B** the upstream `feel` and `drugs` registrations over a local stdio MCP; **C** the same frames as a skill the model may load and write in its reply. Every run is shown with the tools the host offered, the tool calls with the arguments the model composed, and the answer. Workspace and home paths are redacted to `<ws>` and `<home>`.',
    '',
    '## Arm C instruction text',
    '',
    `The skill \`${SKILL_NAME}\` as installed in arm C runs (shown once):`,
    '',
    fenced(input.skillInstruction.trimEnd()),
    '',
  ]

  const variantOf = (r: RunRecord) => r.variant ?? 'unprompted'
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
