/**
 * Blind sheet, key and rule for the guided reads (docs/plans/2026-10-25-002-feat-opencode-plugin-plan.md, R15).
 *
 * `bun run spike:blind --campaign <dir>...` turns the run records of one read into an answers-only sheet and a separate
 * key. A random side (X or Y) holds the plugin runs in each cell; the draw is recorded in the key, which stays in the
 * state root. The owner writes X, Y or same on each cell's `Verdict:` line. `bun run spike:reveal --dir <dir>` refuses
 * until every cell is marked, then counts wins, losses and same per model and applies the rule fixed before any run:
 * over the cells where the plugin arm used a tool or loaded a skill, wins minus losses is at least 3 and no model is at
 * -3 or worse. One hidden control cell sets two nothing runs against two nothing runs and is reported, never counted.
 *
 * The sheet shows each cell's prompt, model and answers (the text after the last tool call, paths redacted) and nothing
 * else: no arm, offered tool, call event or package path. An answer that names a tool can still unblind its cell; the
 * owner notes such cells.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'

import { sha256, stateRoot } from '../../runner/workspace'
import { loadPrompts, type SpikePrompt } from './driver'
import { GUIDED_MODELS, type GuidedArm, type GuidedRecord, loadCodingPrompts, PLUGIN_TOOL_TABLE, type PromptKind, type Read } from './guided'
import { fenced, redactPaths } from './sheet'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SPIKE_DIR = ['evals', 'spikes', 'feel-drugs'] as const

export const BLIND_SCHEMA_VERSION = 1 as const
/** The rule, fixed before any run: the total margin to reach and the per-model floor to stay above. */
export const WIN_MARGIN = 3
export const MODEL_FLOOR = -3
const PLUGIN_SKILL_NAMES = ['counterfactual', 'synthesis']

export type Side = 'X' | 'Y'
export type Verdict = 'X' | 'Y' | 'same'
/** A random source in [0, 1). */
export type Rng = () => number
export const cryptoRng: Rng = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32

// ── the key ────────────────────────────────────────────────────────────────

export interface KeyRun {
  run_id: string
  arm: GuidedArm
  run: number
  feel_calls: number
  drugs_calls: number
  unwanted_calls: number
  /** Plugin skills whose content reached the model. */
  skill_loads: string[]
  /** The answer shown on the sheet, paths redacted. */
  answer: string
}

export interface KeyCell {
  id: string
  model: string
  prompt_id: string
  prompt_kind: PromptKind
  prompt_text: string
  control: boolean
  /** Which kind of run each side holds: N nothing, P plugin. */
  sides: Record<Side, 'N' | 'P'>
  runs: Record<Side, KeyRun[]>
}

/** One command run, reduced to what the checks table needs. */
export interface KeyCommandRun {
  run_id: string
  model: string
  prompt_id: string
  command: 'feel' | 'drugs'
  with_args: boolean
  /** Turn 2 called the command's tool. */
  followed: boolean
  /** With arguments: the main field (`somewhere`, `substance`) holds the argument text. Null without arguments. */
  main_field_is_args: boolean | null
  /** Each field of the tool: filled with non-empty text in the first call. */
  fields: Record<string, boolean>
}

export interface BlindKey {
  schema_version: typeof BLIND_SCHEMA_VERSION
  read: Read
  created_at: string
  /** Campaign directory names. */
  sources: string[]
  cells: KeyCell[]
  /** Command runs found beside the read's runs: reported in the checks table, never part of a cell or the rule. */
  command_runs: KeyCommandRun[]
}

// ── building the sheet ─────────────────────────────────────────────────────

export interface BuildInput {
  records: readonly GuidedRecord[]
  /** Every prompt the records used, prose and coding. */
  prompts: readonly SpikePrompt[]
  sources: readonly string[]
  rng?: Rng
  now?: Date
}

const isPluginArm = (arm: GuidedArm) => arm === 'P1' || arm === 'P2'
const modelRank = (model: string): number => {
  const i = (GUIDED_MODELS as readonly string[]).indexOf(model)
  return i === -1 ? GUIDED_MODELS.length : i
}
const byRun = (a: GuidedRecord, b: GuidedRecord) => a.run - b.run

function keyRun(record: GuidedRecord): KeyRun {
  const count = (tool: string) => record.tool_calls.filter((c) => c.tool === tool).length
  return {
    run_id: `${record.arm}-${record.prompt_id}-${record.run}`,
    arm: record.arm,
    run: record.run,
    feel_calls: count('metacogs_feel'),
    drugs_calls: count('metacogs_drugs'),
    unwanted_calls: record.unwanted_calls.length,
    skill_loads: record.skill_loads.filter((s) => PLUGIN_SKILL_NAMES.includes(s)),
    answer: redactPaths(record.final_answer.trim(), record.paths),
  }
}

const MAIN_FIELD = { feel: 'somewhere', drugs: 'substance' } as const
/** The host quotes several-word command arguments; the model drops the quotes. */
const unquote = (text: string) => text.trim().replace(/^"(.*)"$/s, '$1').trim()

function keyCommandRun(record: GuidedRecord): KeyCommandRun {
  const command = record.command!
  const tool = `metacogs_${command.name}`
  const call = record.second_turn?.tool_calls.find((c) => c.tool === tool)
  const input = isRecord(call?.input) ? call.input : {}
  const main = input[MAIN_FIELD[command.name]]
  return {
    run_id: `${record.arm}-${record.prompt_id}-${command.name}-${record.run}`,
    model: record.model,
    prompt_id: record.prompt_id,
    command: command.name,
    with_args: !command.empty_args,
    followed: call !== undefined,
    main_field_is_args: command.empty_args ? null : call !== undefined && typeof main === 'string' && command.args !== null && unquote(main) === unquote(command.args),
    fields: Object.fromEntries(PLUGIN_TOOL_TABLE[tool as keyof typeof PLUGIN_TOOL_TABLE].properties.map((field) => [field, typeof input[field] === 'string' && input[field].trim() !== ''])),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function buildBlind(input: BuildInput): { sheet: string; key: BlindKey } {
  const rng = input.rng ?? cryptoRng
  const reads = [...new Set(input.records.map((r) => r.read))]
  if (reads.length !== 1) throw new Error(`a blind sheet covers one read; the records span ${reads.length === 0 ? 'none' : reads.join(' and ')}`)
  const read = reads[0]!

  const commandRuns = input.records.filter((r) => r.command !== null && r.status === 'completed').map(keyCommandRun)
  const groups = new Map<string, GuidedRecord[]>()
  for (const r of input.records.filter((r) => r.command === null)) groups.set(`${r.model}\0${r.prompt_id}`, [...(groups.get(`${r.model}\0${r.prompt_id}`) ?? []), r])

  type Draft = { model: string; prompt: SpikePrompt; kind: PromptKind; control: boolean; nothing: GuidedRecord[]; plugin: GuidedRecord[] }
  const regular: Draft[] = []
  const controls: Draft[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const label = `${first.prompt_id}@${first.model}`
    const prompt = input.prompts.find((p) => p.id === first.prompt_id)
    if (!prompt) throw new Error(`prompt ${first.prompt_id} (${label}) is not among the prompts given`)
    if (sha256(prompt.text) !== first.prompt_hash) throw new Error(`prompt ${first.prompt_id}: the prompt file differs from the one these runs used`)
    const done = group.filter((r) => r.status === 'completed').sort(byRun)
    const nothing = done.filter((r) => !isPluginArm(r.arm))
    const plugin = done.filter((r) => isPluginArm(r.arm))
    if (!group.some((r) => isPluginArm(r.arm))) {
      if (nothing.length < 4) throw new Error(`cell ${label} has no plugin run, so it can only be the control cell, which needs four completed nothing runs (it has ${nothing.length})`)
      controls.push({ model: first.model, prompt, kind: first.prompt_kind, control: true, nothing: nothing.slice(0, 4), plugin: [] })
    } else {
      if (nothing.length < 2 || plugin.length < 2) throw new Error(`cell ${label} needs two completed runs per arm (nothing ${nothing.length}, plugin ${plugin.length})`)
      regular.push({ model: first.model, prompt, kind: first.prompt_kind, control: false, nothing: nothing.slice(0, 2), plugin: plugin.slice(0, 2) })
    }
  }
  if (controls.length !== 1) throw new Error(`the sheet needs exactly one control cell: a prompt and model with four nothing runs and no plugin run; found ${controls.length}`)

  const promptRank = (id: string) => {
    const i = input.prompts.findIndex((p) => p.id === id)
    return i === -1 ? input.prompts.length : i
  }
  regular.sort((a, b) => promptRank(a.prompt.id) - promptRank(b.prompt.id) || modelRank(a.model) - modelRank(b.model) || a.model.localeCompare(b.model))

  const make = (draft: Draft, pluginOnX: boolean): Omit<KeyCell, 'id'> => {
    const [x, y, sides] = draft.control
      ? ([draft.nothing.slice(0, 2), draft.nothing.slice(2, 4), { X: 'N', Y: 'N' }] as const)
      : pluginOnX
        ? ([draft.plugin, draft.nothing, { X: 'P', Y: 'N' }] as const)
        : ([draft.nothing, draft.plugin, { X: 'N', Y: 'P' }] as const)
    // For the control, the draw decides which half of the four runs sits on X.
    const [left, right] = draft.control && !pluginOnX ? [y, x] : [x, y]
    return { model: draft.model, prompt_id: draft.prompt.id, prompt_kind: draft.kind, prompt_text: draft.prompt.text, control: draft.control, sides: { ...sides }, runs: { X: left.map(keyRun), Y: right.map(keyRun) } }
  }
  const drawn = regular.map((draft) => make(draft, rng() < 0.5))
  const control = make(controls[0]!, rng() < 0.5)
  const at = Math.min(drawn.length, Math.floor(rng() * (drawn.length + 1)))
  const ordered = [...drawn.slice(0, at), control, ...drawn.slice(at)]
  const cells: KeyCell[] = ordered.map((cell, i) => ({ id: `cell-${String(i + 1).padStart(2, '0')}`, ...cell }))

  const key: BlindKey = { schema_version: BLIND_SCHEMA_VERSION, read, created_at: (input.now ?? new Date()).toISOString(), sources: [...input.sources], cells, command_runs: commandRuns }
  return { sheet: renderSheet(key), key }
}

function renderSheet(key: BlindKey): string {
  const out = [
    `# Guided read ${key.read}: blind sheet`,
    '',
    'Each cell sets the answers on side X against the answers on side Y for one prompt and model. Read both answers on each side, then write X, Y or same on the cell\'s `Verdict:` line: the side you prefer, or same when you have no preference. Nothing else in this file is read. Answers are shown as written, with paths redacted.',
    '',
  ]
  for (const cell of key.cells) {
    out.push(`## ${cell.id} · ${cell.prompt_id} · ${cell.model}`, '', 'Prompt:', '', ...cell.prompt_text.split('\n').map((l) => `> ${l}`), '')
    for (const side of ['X', 'Y'] as const) {
      out.push(`### ${side}`, '')
      cell.runs[side].forEach((run, i) => out.push(`#### ${side}${i + 1}`, '', run.answer ? fenced(run.answer, 'markdown') : '(no text)', ''))
    }
    out.push('Verdict:', '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

// ── reading the marks ──────────────────────────────────────────────────────

export interface ParsedMarks {
  /** Every cell heading found, in order. */
  cells: string[]
  marks: Record<string, Verdict>
  unmarked: string[]
  errors: string[]
}

const FENCE_OPEN = /^(~{3,})/
const CELL_HEADING = /^## (cell-\d+)\b/
const VERDICT_LINE = /^Verdict:(.*)$/

/** Reads the `Verdict:` line of each cell. Text inside a fenced answer is never a heading or a mark. */
export function parseMarks(sheet: string): ParsedMarks {
  const cells: string[] = []
  const marks: Record<string, Verdict> = {}
  const unmarked: string[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  let current: string | undefined
  let fence = 0
  for (const line of sheet.split(/\r?\n/)) {
    if (fence > 0) {
      if (new RegExp(`^~{${fence},}\\s*$`).test(line)) fence = 0
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      fence = open[1]!.length
      continue
    }
    const heading = CELL_HEADING.exec(line)
    if (heading) {
      current = heading[1]!
      cells.push(current)
      continue
    }
    const verdict = VERDICT_LINE.exec(line)
    if (verdict && current !== undefined) {
      if (seen.has(current)) {
        errors.push(`${current} has more than one Verdict line`)
        continue
      }
      seen.add(current)
      const value = verdict[1]!.trim().toLowerCase()
      if (value === '') unmarked.push(current)
      else if (value === 'x') marks[current] = 'X'
      else if (value === 'y') marks[current] = 'Y'
      else if (value === 'same') marks[current] = 'same'
      else errors.push(`${current}: "${verdict[1]!.trim()}" is not X, Y or same`)
    }
  }
  for (const id of cells) if (!seen.has(id)) unmarked.push(id)
  return { cells, marks, unmarked, errors }
}

// ── the rule ───────────────────────────────────────────────────────────────

export class RevealRefusal extends Error {
  constructor(
    message: string,
    readonly unmarked: string[],
  ) {
    super(message)
    this.name = 'RevealRefusal'
  }
}

export type Outcome = 'plugin' | 'nothing' | 'same'
export type CarriedBy = 'tools' | 'skills' | 'both' | 'none'

export interface ReviewedCell {
  id: string
  prompt_id: string
  model: string
  verdict: Verdict
  outcome: Outcome
  /** The plugin arm used a tool or loaded a skill in this cell. */
  eligible: boolean
  tool_calls: number
  skill_loads: number
  carried_by: CarriedBy
}

export interface ModelTally {
  model: string
  eligible: number
  wins: number
  losses: number
  same: number
  net: number
  /** The eligible cells, in sheet order. */
  cells: ReviewedCell[]
  win_cells_tools_only: number
  win_cells_skills_only: number
  win_cells_both: number
}

export interface ChecksRow {
  model: string
  plugin_runs: number
  runs_with_tool_call: number
  feel_calls: number
  drugs_calls: number
  unwanted_calls: number
  runs_with_skill_load: number
}

export interface CommandCheckRow {
  model: string
  command: 'feel' | 'drugs'
  with_args: boolean
  runs: number
  followed: number
  /** Runs where the main field held the argument text; null for the no-argument form. */
  main_field_is_args: number | null
  /** Runs, per field, that filled it with non-empty text. */
  fields_filled: Record<string, number>
}

export interface RevealResult {
  read: Read
  total: { wins: number; losses: number; same: number; net: number; eligible: number }
  models: ModelTally[]
  rule: { met: boolean; margin: number; floor: number; total_net: number; total_ok: boolean; failing_models: string[] }
  /** Cells where the plugin arm never fired: reported, not counted. */
  excluded: ReviewedCell[]
  control: { id: string; prompt_id: string; model: string; verdict: Verdict }
  checks: ChecksRow[]
  /** Per model and command form; empty when the read has no command runs. Checks only. */
  command_checks: CommandCheckRow[]
}

const sum = (runs: readonly KeyRun[], pick: (r: KeyRun) => number) => runs.reduce((n, r) => n + pick(r), 0)

export function reveal(key: BlindKey, marks: Readonly<Record<string, Verdict>>): RevealResult {
  const unmarked = key.cells.filter((c) => marks[c.id] === undefined).map((c) => c.id)
  if (unmarked.length > 0) throw new RevealRefusal(`${unmarked.length} cell${unmarked.length === 1 ? ' is' : 's are'} not marked: ${unmarked.join(', ')}`, unmarked)
  const unknown = Object.keys(marks).filter((id) => !key.cells.some((c) => c.id === id))
  if (unknown.length > 0) throw new RevealRefusal(`marks for cells the key does not have: ${unknown.join(', ')}`, unknown)

  const reviewed = (cell: KeyCell): ReviewedCell => {
    const verdict = marks[cell.id]!
    const pluginSide: Side | undefined = cell.sides.X === 'P' ? 'X' : cell.sides.Y === 'P' ? 'Y' : undefined
    const runs = pluginSide ? cell.runs[pluginSide] : []
    const toolCalls = sum(runs, (r) => r.feel_calls + r.drugs_calls)
    const skillLoads = sum(runs, (r) => r.skill_loads.length)
    return {
      id: cell.id,
      prompt_id: cell.prompt_id,
      model: cell.model,
      verdict,
      outcome: verdict === 'same' ? 'same' : cell.sides[verdict] === 'P' ? 'plugin' : 'nothing',
      eligible: toolCalls > 0 || skillLoads > 0,
      tool_calls: toolCalls,
      skill_loads: skillLoads,
      carried_by: toolCalls > 0 && skillLoads > 0 ? 'both' : toolCalls > 0 ? 'tools' : skillLoads > 0 ? 'skills' : 'none',
    }
  }
  const regular = key.cells.filter((c) => !c.control)
  const cells = regular.map(reviewed)
  const modelNames = [...new Set(regular.map((c) => c.model))].sort((a, b) => modelRank(a) - modelRank(b) || a.localeCompare(b))

  const models = modelNames.map((model): ModelTally => {
    const eligible = cells.filter((c) => c.model === model && c.eligible)
    const wins = eligible.filter((c) => c.outcome === 'plugin')
    return {
      model,
      eligible: eligible.length,
      wins: wins.length,
      losses: eligible.filter((c) => c.outcome === 'nothing').length,
      same: eligible.filter((c) => c.outcome === 'same').length,
      net: wins.length - eligible.filter((c) => c.outcome === 'nothing').length,
      cells: eligible,
      win_cells_tools_only: wins.filter((c) => c.carried_by === 'tools').length,
      win_cells_skills_only: wins.filter((c) => c.carried_by === 'skills').length,
      win_cells_both: wins.filter((c) => c.carried_by === 'both').length,
    }
  })
  const total = models.reduce((t, m) => ({ wins: t.wins + m.wins, losses: t.losses + m.losses, same: t.same + m.same, net: t.net + m.net, eligible: t.eligible + m.eligible }), { wins: 0, losses: 0, same: 0, net: 0, eligible: 0 })
  const failing = models.filter((m) => m.net <= MODEL_FLOOR).map((m) => m.model)

  const checks = modelNames.map((model): ChecksRow => {
    const runs = regular.filter((c) => c.model === model).flatMap((c) => (c.sides.X === 'P' ? c.runs.X : c.sides.Y === 'P' ? c.runs.Y : []))
    return {
      model,
      plugin_runs: runs.length,
      runs_with_tool_call: runs.filter((r) => r.feel_calls + r.drugs_calls > 0).length,
      feel_calls: sum(runs, (r) => r.feel_calls),
      drugs_calls: sum(runs, (r) => r.drugs_calls),
      unwanted_calls: sum(runs, (r) => r.unwanted_calls),
      runs_with_skill_load: runs.filter((r) => r.skill_loads.length > 0).length,
    }
  })

  const forms = new Map<string, KeyCommandRun[]>()
  for (const run of key.command_runs ?? []) forms.set(`${run.model}\0${run.command}\0${run.with_args}`, [...(forms.get(`${run.model}\0${run.command}\0${run.with_args}`) ?? []), run])
  const command_checks = [...forms.values()]
    .map((runs): CommandCheckRow => {
      const first = runs[0]!
      return {
        model: first.model,
        command: first.command,
        with_args: first.with_args,
        runs: runs.length,
        followed: runs.filter((r) => r.followed).length,
        main_field_is_args: first.with_args ? runs.filter((r) => r.main_field_is_args === true).length : null,
        fields_filled: Object.fromEntries(Object.keys(first.fields).map((field) => [field, runs.filter((r) => r.fields[field] === true).length])),
      }
    })
    .sort((a, b) => modelRank(a.model) - modelRank(b.model) || a.model.localeCompare(b.model) || a.command.localeCompare(b.command) || Number(a.with_args) - Number(b.with_args))

  const controlCell = key.cells.find((c) => c.control)!
  return {
    read: key.read,
    total,
    models,
    rule: { met: total.net >= WIN_MARGIN && failing.length === 0, margin: WIN_MARGIN, floor: MODEL_FLOOR, total_net: total.net, total_ok: total.net >= WIN_MARGIN, failing_models: failing },
    excluded: cells.filter((c) => !c.eligible),
    control: { id: controlCell.id, prompt_id: controlCell.prompt_id, model: controlCell.model, verdict: marks[controlCell.id]! },
    checks,
    command_checks,
  }
}

// ── the revealed sheet ─────────────────────────────────────────────────────

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

export function renderRevealed(key: BlindKey, marks: Readonly<Record<string, Verdict>>, result: RevealResult): string {
  const arm = (cell: KeyCell, side: Side) => (cell.control ? 'nothing (control)' : cell.sides[side] === 'P' ? 'plugin' : 'nothing')
  const out = [
    `# Guided read ${key.read}: revealed sheet`,
    '',
    `Sources: ${key.sources.map((s) => `\`${s}\``).join(', ') || '(none)'}. Marks are the owner's; arms and call counts come from the key.`,
    '',
    `Rule: ${result.rule.met ? 'met' : 'not met'}. Over the cells where the plugin arm used a tool or loaded a skill, wins minus losses is ${signed(result.rule.total_net)} (needs at least ${result.rule.margin}), and ${result.rule.failing_models.length === 0 ? 'no model is' : `${result.rule.failing_models.join(', ')} ${result.rule.failing_models.length === 1 ? 'is' : 'are'}`} at ${result.rule.floor} or worse.`,
    '',
    '## Result per model',
    '',
    '| Model | Eligible cells | Wins | Losses | Same | Net | Wins by tools only / skills only / both |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.models.map((m) => `| \`${m.model}\` | ${m.eligible} | ${m.wins} | ${m.losses} | ${m.same} | ${signed(m.net)} | ${m.win_cells_tools_only} / ${m.win_cells_skills_only} / ${m.win_cells_both} |`),
    `| all | ${result.total.eligible} | ${result.total.wins} | ${result.total.losses} | ${result.total.same} | ${signed(result.total.net)} | |`,
    '',
    '## Checks per model (plugin runs)',
    '',
    '| Model | Runs | Runs with a tool call | `metacogs_feel` calls | `metacogs_drugs` calls | Unwanted calls | Runs with a skill load |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.checks.map((c) => `| \`${c.model}\` | ${c.plugin_runs} | ${c.runs_with_tool_call} | ${c.feel_calls} | ${c.drugs_calls} | ${c.unwanted_calls} | ${c.runs_with_skill_load} |`),
    '',
    ...(result.command_checks.length === 0
      ? []
      : [
          '## Command runs (checks only)',
          '',
          'Each run is the prompt, then the slash command, in one session. They are not part of the rule.',
          '',
          '| Model | Command | Runs | Followed | Argument is the main field | Fields filled |',
          '| --- | --- | --- | --- | --- | --- |',
          ...result.command_checks.map((c) => `| \`${c.model}\` | \`/${c.command}\` ${c.with_args ? 'with' : 'without'} arguments | ${c.runs} | ${c.followed} | ${c.main_field_is_args ?? 'n/a'} | ${Object.entries(c.fields_filled).map(([f, n]) => `${f} ${n}/${c.runs}`).join(', ')} |`),
          '',
        ]),
    '## Excluded cells (the plugin arm never fired)',
    '',
    ...(result.excluded.length === 0 ? ['none'] : result.excluded.map((c) => `- ${c.id} · ${c.prompt_id} · \`${c.model}\`: verdict ${c.verdict} (${c.outcome})`)),
    '',
    '## Control cell',
    '',
    `${result.control.id} · ${result.control.prompt_id} · \`${result.control.model}\` set two nothing runs against two nothing runs. Verdict: ${result.control.verdict}. It is reported and not counted.`,
    '',
    '## Cells',
    '',
  ]
  const reviewed = new Map([...result.models.flatMap((m) => m.cells), ...result.excluded].map((c) => [c.id, c]))
  for (const cell of key.cells) {
    const verdict = marks[cell.id]!
    const r = reviewed.get(cell.id)
    out.push(`### ${cell.id} · ${cell.prompt_id} · ${cell.model}${cell.control ? ' · control' : ''}`, '', `X: ${arm(cell, 'X')}. Y: ${arm(cell, 'Y')}. Verdict: ${verdict}${r ? ` (${r.outcome}${r.eligible ? '' : '; plugin arm never fired'})` : ''}.`)
    if (r) out.push(`Plugin arm: ${r.tool_calls} tool call${r.tool_calls === 1 ? '' : 's'}, ${r.skill_loads} skill load${r.skill_loads === 1 ? '' : 's'}.`)
    out.push('', 'Prompt:', '', ...cell.prompt_text.split('\n').map((l) => `> ${l}`), '')
    for (const side of ['X', 'Y'] as const) {
      cell.runs[side].forEach((run, i) => out.push(`#### ${side}${i + 1} (${run.run_id})`, '', run.answer ? fenced(run.answer, 'markdown') : '(no text)', ''))
    }
  }
  return redactPaths(`${out.join('\n').trimEnd()}\n`, { workspaces: [], homes: [] })
}

// ── loading ────────────────────────────────────────────────────────────────

/** The run records of a retained campaign directory. Scripted runs are refused: a blind read is evidence from live models. */
export function loadGuidedRuns(campaignDir: string): GuidedRecord[] {
  const entries = existsSync(campaignDir) ? readdirSync(campaignDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []
  const runs: GuidedRecord[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = join(campaignDir, entry.name, 'run.json')
    if (!existsSync(file)) continue
    const record = JSON.parse(readFileSync(file, 'utf8')) as GuidedRecord
    if (record.schema_version !== 1) throw new Error(`${entry.name}/run.json has an unsupported schema_version (${String(record.schema_version)})`)
    if (record.provider !== 'live') throw new Error(`${entry.name}/run.json is a ${String(record.provider)} run; a blind sheet renders live campaigns only`)
    runs.push(record)
  }
  if (runs.length === 0) throw new Error(`no runs found under ${campaignDir}`)
  return runs
}

// ── command line ───────────────────────────────────────────────────────────

export interface BlindDeps {
  repoRoot?: string
  /** Prose and coding prompts. Default: the committed files (the coding file only when it exists). */
  prompts?: SpikePrompt[]
  rng?: Rng
  now?: () => Date
  log?: (line: string) => void
}

function defaultPrompts(repoRoot: string): SpikePrompt[] {
  const coding = join(repoRoot, ...SPIKE_DIR, 'coding-prompts.md')
  return [...loadPrompts(repoRoot), ...(existsSync(coding) ? loadCodingPrompts(repoRoot) : [])]
}

const USAGE = 'usage: bun run spike:blind --campaign <dir> [--campaign <dir>] [--out-dir <dir>]\n       bun run spike:reveal --dir <dir> [--sheet <file>] [--out <file>]'

export async function main(argv: readonly string[], deps: BlindDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const [command, ...rest] = argv
  try {
    if (command === 'blind') {
      const { values } = parseNodeArgs({ args: rest, options: { campaign: { type: 'string', multiple: true }, 'out-dir': { type: 'string' } }, strict: true })
      if (!values.campaign?.length) {
        log(USAGE)
        return 64
      }
      const repoRoot = deps.repoRoot ?? REPO_ROOT
      const records = values.campaign.flatMap(loadGuidedRuns)
      const now = (deps.now ?? (() => new Date()))()
      const { sheet, key } = buildBlind({ records, prompts: deps.prompts ?? defaultPrompts(repoRoot), sources: values.campaign.map((c) => c.split('/').filter(Boolean).at(-1) ?? c), ...(deps.rng ? { rng: deps.rng } : {}), now })
      const dir = values['out-dir'] ?? join(stateRoot(), 'spikes', 'feel-drugs', 'blind', `read${key.read}-${now.toISOString().replace(/[:.]/g, '-')}`)
      if (existsSync(join(dir, 'key.json'))) throw new Error(`${dir} already holds a key; a drawn assignment is never replaced`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 })
      writeFileSync(join(dir, 'sheet.md'), sheet, { mode: 0o600 })
      log(`wrote ${join(dir, 'sheet.md')} (${key.cells.length} cells) and ${join(dir, 'key.json')}`)
      return 0
    }
    if (command === 'reveal') {
      const { values } = parseNodeArgs({ args: rest, options: { dir: { type: 'string' }, sheet: { type: 'string' }, out: { type: 'string' } }, strict: true })
      if (!values.dir) {
        log(USAGE)
        return 64
      }
      const key = JSON.parse(readFileSync(join(values.dir, 'key.json'), 'utf8')) as BlindKey
      const parsed = parseMarks(readFileSync(values.sheet ?? join(values.dir, 'sheet.md'), 'utf8'))
      if (parsed.errors.length > 0) {
        for (const error of parsed.errors) log(error)
        return 2
      }
      const result = reveal(key, parsed.marks)
      const out = values.out ?? join(values.dir, 'revealed.md')
      writeFileSync(out, renderRevealed(key, parsed.marks, result), { mode: 0o600 })
      log(`Rule: ${result.rule.met ? 'met' : 'not met'} (wins minus losses ${signed(result.rule.total_net)}; needs ${result.rule.margin}${result.rule.failing_models.length ? `; at ${result.rule.floor} or worse: ${result.rule.failing_models.join(', ')}` : ''})`)
      for (const m of result.models) log(`${m.model}: ${m.wins} wins, ${m.losses} losses, ${m.same} same over ${m.eligible} eligible cells (${signed(m.net)})`)
      log(`wrote ${out}`)
      return 0
    }
    log(USAGE)
    return 64
  } catch (e) {
    if (e instanceof RevealRefusal) {
      log(`refused: ${e.message}`)
      return 2
    }
    log(e instanceof Error ? e.message : String(e))
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
