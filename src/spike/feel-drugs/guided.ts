/**
 * Guided reads for the metacogs plugin (docs/plans/2026-10-25-002-feat-opencode-plugin-plan.md). Four arms, two reads:
 *
 * - Read 1: N1 offers the model nothing (every built-in tool denied); P1 loads the packed plugin and keeps only `skill`,
 *   limited to the plugin's four skills.
 * - Read 2: N2 and P2 run under the host's default tools (less the shell and the network), with a fresh baseline.
 *
 * A run is `completed` only if the host offered exactly the expected tools: names, property names and `required` lists
 * match a literal table built from `src/frames`, per provider where the host's default tools differ. It reuses the
 * runner's workspace, isolation and event primitives and the spike driver's status and freeze helpers; the spike's own
 * `Arm`, `RunStatus` and `RunRecord` stay closed. `--provider scripted` (the default) costs nothing.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'

import { DRUGS_REQUIRED, FEEL_OPTIONAL, FEEL_REQUIRED } from '../../frames/feel-drugs'
import { OFFLINE_NPM, type PackedPlugin, packedPlugin, seedConfigDir, disposeFixtures } from '../../plugin/fixture'
import { CLIPROXY_UPSTREAM, type ResolvedCliproxy, resolveCliproxy as defaultResolveCliproxy } from '../../runner/cliproxy'
import { destroyFixture } from '../../runner/env'
import { allAssistantText, analyzeEvents, finalAnswerText, isSkillContentLoad, parseEvents, type Usage } from '../../runner/events'
import { checkDebugConfig, checkIsolation, type ExpectedConfig, isMainRequest, offeredTools } from '../../runner/isolation'
import { CredentialLeakError, type Needle, scanForLeaks } from '../../runner/manifest'
import { debugConfig, opencodeArgv, runArgv, sleepUnlessAborted, spawnCapture } from '../../runner/opencode'
import { SPIKE_PROVIDER_ID, type RecordedRequest, type ScriptedStep, startRecordingProxy, startScriptedProvider } from '../../runner/scripted-provider'
import { createRunWorkspace, sha256, stateRoot } from '../../runner/workspace'
import {
  assertInside,
  assertPromptId,
  checkFrozen,
  classifyStatus,
  type FrozenTarget,
  NUDGE,
  parsePrompts,
  PROMPTS_TARGET,
  RUN_TIMEOUT_MS,
  type RunStatus,
  type SpikePrompt,
  type ToolCallRecord,
  withBackoff,
} from './driver'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SPIKE_DIR = ['evals', 'spikes', 'feel-drugs'] as const

// ── arms, reads, models ────────────────────────────────────────────────────

export const READS = [1, 2] as const
export type Read = (typeof READS)[number]
export const GUIDED_ARMS = ['N1', 'P1', 'N2', 'P2'] as const
export type GuidedArm = (typeof GUIDED_ARMS)[number]
export const READ_ARMS: Record<Read, readonly [GuidedArm, GuidedArm]> = { 1: ['N1', 'P1'], 2: ['N2', 'P2'] }
export const GUIDED_MODELS = ['openai/gpt-6-luna', 'anthropic/claude-haiku-5-5', 'openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5'] as const

export type Family = 'gpt' | 'anthropic'

/** The host picks its tool set and agent prompt from the model family. */
export function familyOf(model: string): Family {
  if (model.startsWith('openai/')) return 'gpt'
  if (model.startsWith('anthropic/')) return 'anthropic'
  throw new Error(`unknown model family for ${JSON.stringify(model)}: guided reads cover openai/* and anthropic/*`)
}

/** Under the scripted provider the model id stands in for the family: the host keys its tool set on it. */
const SCRIPTED_MODEL_ID: Record<Family, string> = { gpt: 'gpt-scripted', anthropic: 'claude-scripted' }

// ── expected tools ─────────────────────────────────────────────────────────

export const PLUGIN_TOOL_TABLE = {
  feel: { properties: [...FEEL_REQUIRED, ...FEEL_OPTIONAL] as string[], required: [...FEEL_REQUIRED] as string[] },
  drugs: { properties: [...DRUGS_REQUIRED] as string[], required: [...DRUGS_REQUIRED] as string[] },
}
export const PLUGIN_TOOL_NAMES = Object.keys(PLUGIN_TOOL_TABLE)
const PLUGIN_SKILLS = ['counterfactual', 'drugs', 'feel', 'synthesis']
const BUILTIN_SKILL = 'customize-opencode'

/** What OpenCode 1.19.4 offers by default once the shell and the network are denied (README, "Plugin host probes"). */
export const DEFAULT_TOOLS: Record<Family, readonly string[]> = {
  gpt: ['apply_patch', 'glob', 'grep', 'read', 'skill', 'task', 'todowrite'],
  anthropic: ['edit', 'glob', 'grep', 'read', 'skill', 'task', 'todowrite', 'write'],
}

export function expectedToolNames(arm: GuidedArm, family: Family): string[] {
  switch (arm) {
    case 'N1':
      return []
    case 'P1':
      return [...PLUGIN_TOOL_NAMES, 'skill'].sort()
    case 'N2':
      return [...DEFAULT_TOOLS[family]].sort()
    case 'P2':
      return [...DEFAULT_TOOLS[family], ...PLUGIN_TOOL_NAMES].sort()
  }
}

export function expectedSkillNames(arm: GuidedArm): string[] {
  switch (arm) {
    case 'N1':
      return []
    case 'P1':
      return [...PLUGIN_SKILLS]
    case 'N2':
      return [BUILTIN_SKILL]
    case 'P2':
      return [...PLUGIN_SKILLS, BUILTIN_SKILL].sort()
  }
}

interface OfferedTool {
  name: string
  properties: string[]
  required: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every tool offered in any tool-capable request, first seen wins, on the chat-completions, Responses and Anthropic wires. */
export function offeredToolSchemas(requests: readonly RecordedRequest[]): OfferedTool[] {
  const seen = new Map<string, OfferedTool>()
  for (const request of requests) {
    if (!request.hasTools || !isRecord(request.body) || !Array.isArray(request.body.tools)) continue
    for (const tool of request.body.tools) {
      if (!isRecord(tool)) continue
      const fn = isRecord(tool.function) ? tool.function : tool
      if (typeof fn.name !== 'string' || seen.has(fn.name)) continue
      const schema = [fn.parameters, fn.input_schema, tool.parameters, tool.input_schema].find(isRecord)
      const properties = isRecord(schema?.properties) ? Object.keys(schema.properties) : []
      const required = Array.isArray(schema?.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
      seen.set(fn.name, { name: fn.name, properties, required })
    }
  }
  return [...seen.values()]
}

export type ToolCheck = { status: 'ok' | 'tools_missing' | 'tools_extra'; reasons: string[] }

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** The offered names, and the property names and `required` lists of the plugin tools, against the expected table. Missing outranks extra. */
export function checkTools(offered: readonly OfferedTool[], expectedNames: readonly string[]): ToolCheck {
  const missing: string[] = []
  const extra: string[] = []
  for (const name of expectedNames) if (!offered.some((o) => o.name === name)) missing.push(`missing tool ${name}`)
  for (const tool of offered) if (!expectedNames.includes(tool.name)) extra.push(`extra tool ${tool.name}`)
  for (const [name, table] of Object.entries(PLUGIN_TOOL_TABLE)) {
    const tool = offered.find((o) => o.name === name)
    if (!tool || !expectedNames.includes(name)) continue
    for (const field of table.properties) if (!tool.properties.includes(field)) missing.push(`${name} is missing field ${field}`)
    for (const field of tool.properties) if (!table.properties.includes(field)) extra.push(`${name} has extra field ${field}`)
    if (!sameSet(tool.required, table.required)) missing.push(`${name} required list differs`)
  }
  if (missing.length) return { status: 'tools_missing', reasons: [...missing, ...extra] }
  if (extra.length) return { status: 'tools_extra', reasons: extra }
  return { status: 'ok', reasons: [] }
}

// ── per-arm setup ──────────────────────────────────────────────────────────

export interface GuidedSetup {
  permission: Record<string, unknown>
  plugin?: readonly (string | [string, Record<string, unknown>])[] | undefined
  expectedConfig?: ExpectedConfig | undefined
  expectedSkills: string[]
  expectedTools: string[]
  /** The arm is declared tool-free: its skill list is read from a recorded main request. */
  toolFree: boolean
}

const BUILTIN_PERMISSION_KEYS = ['glob', 'grep', 'list', 'read', 'edit', 'bash', 'task', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill'] as const

export function armSetup(arm: GuidedArm, family: Family, packed: Pick<PackedPlugin, 'spec' | 'skillsDir' | 'pluginSkillsDir'> | undefined, pluginOptions: { guidance: boolean } = { guidance: true }): GuidedSetup {
  const common = { expectedSkills: expectedSkillNames(arm), expectedTools: expectedToolNames(arm, family) }
  const plugin = arm === 'P1' || arm === 'P2'
  if (plugin && !packed) throw new Error(`arm ${arm} needs the packed plugin`)
  const pluginFields = plugin
    ? {
        plugin: [pluginOptions.guidance ? packed!.spec : ([packed!.spec, { guidance: false }] as [string, Record<string, unknown>])],
        expectedConfig: { pluginOrigins: true, skillsPaths: [packed!.skillsDir, packed!.pluginSkillsDir] } satisfies ExpectedConfig,
      }
    : {}
  if (arm === 'N1' || arm === 'P1') {
    const deny = Object.fromEntries(BUILTIN_PERMISSION_KEYS.map((key) => [key, 'deny']))
    const skill = arm === 'P1' ? { '*': 'deny', ...Object.fromEntries(PLUGIN_SKILLS.map((name) => [name, 'allow'])) } : 'deny'
    return { ...common, ...pluginFields, permission: { external_directory: 'deny', ...deny, skill }, toolFree: arm === 'N1' }
  }
  return { ...common, ...pluginFields, permission: { external_directory: 'deny', bash: { '*': 'deny' }, webfetch: 'deny', websearch: 'deny' }, toolFree: false }
}

// ── prompts, cells, arguments ──────────────────────────────────────────────

export type PromptKind = 'prose' | 'coding'
export interface GuidedPrompt extends SpikePrompt {
  kind: PromptKind
}

const CODING_TARGET: FrozenTarget = { path: [...SPIKE_DIR, 'coding-prompts.md'], key: 'coding_prompts_sha256', noun: 'coding prompt file', notFrozen: 'the coding prompts are not frozen' }
const GUIDANCE_TARGET: FrozenTarget = { path: ['plugin', 'guidance.md'], key: 'guidance_sha256', noun: 'guidance file', notFrozen: 'the guidance is not frozen' }

/** Prose prompts the guided reads leave out of `prompts.md`: the lighthouse story. The file and its hash are untouched. */
export const GUIDED_EXCLUDED_PROMPTS: readonly string[] = ['p1']

/** The prose prompts of the guided reads: `prompts.md` less `GUIDED_EXCLUDED_PROMPTS`. */
export function loadGuidedProse(repoRoot = REPO_ROOT): SpikePrompt[] {
  return parsePrompts(readFileSync(join(repoRoot, ...PROMPTS_TARGET.path), 'utf8')).filter((p) => !GUIDED_EXCLUDED_PROMPTS.includes(p.id))
}

export function loadCodingPrompts(repoRoot = REPO_ROOT): SpikePrompt[] {
  return parsePrompts(readFileSync(join(repoRoot, ...CODING_TARGET.path), 'utf8'))
}

/** Live runs need the prompts, the coding prompts (read 2 only) and the guidance to match the hashes the README records. */
export function checkLiveFreeze(repoRoot: string, reads: readonly Read[]): { ok: true } | { ok: false; reason: string } {
  const targets = [PROMPTS_TARGET, ...(reads.includes(2) ? [CODING_TARGET] : []), GUIDANCE_TARGET]
  for (const target of targets) {
    const check = checkFrozen(repoRoot, target)
    if (!check.ok) return check
  }
  return { ok: true }
}

export interface GuidedOptions {
  reads: Read[]
  models: string[]
  /** Prompt ids; empty means every prompt of the read. */
  prompts: string[]
  runs: number
  /** Run only these arms; empty means both arms of the read. Extra runs of one arm make up a blind control cell. */
  arms: GuidedArm[]
  provider: 'scripted' | 'live'
  authCliproxy: string | undefined
  /** `one-per-model` (the first prompt of each model) or `<prompt>@<model>`; empty means every cell. */
  cells: string[]
  /** Command runs (read 2 only): the prompt, then `--continue --command <name> [args]`, instead of the arms' comparison cells. */
  commands: GuidedCommandSpec[]
  /** Diagnostic: the plugin's guidance block on (the default) or off (`{ guidance: false }` in the plugin entry). */
  guidance: boolean
  /** Diagnostic: append the spike's `NUDGE` sentence to every prompt sent. */
  nudge: boolean
  /** Diagnostic: the first run index of this invocation, so interleaved invocations number their runs as one set. */
  startRun: number
  /** `--guidance` or `--nudge` was given: the campaign is a diagnostic, kept apart from the reads and never blinded. */
  diagnostic: boolean
}

export interface GuidedCommandSpec {
  name: 'feel' | 'drugs'
  /** The text after the command; null for none. */
  args: string | null
}

const COMMAND_NAMES = ['feel', 'drugs'] as const

export function parseGuidedArgs(argv: readonly string[]): GuidedOptions {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      read: { type: 'string', multiple: true },
      model: { type: 'string', multiple: true },
      prompt: { type: 'string', multiple: true },
      arm: { type: 'string', multiple: true },
      runs: { type: 'string' },
      provider: { type: 'string' },
      'auth-cliproxy': { type: 'string' },
      cells: { type: 'string', multiple: true },
      command: { type: 'string', multiple: true },
      guidance: { type: 'string' },
      nudge: { type: 'boolean' },
      'start-run': { type: 'string' },
    },
    strict: true,
  })
  const reads = (values.read ?? ['1']).map((r) => {
    if (r !== '1' && r !== '2') throw new Error(`--read takes 1 or 2; got "${r}"`)
    return Number(r) as Read
  })
  const models = values.model ?? [...GUIDED_MODELS]
  for (const model of models) familyOf(model)
  const arms = (values.arm ?? []).map((a) => {
    if (!(GUIDED_ARMS as readonly string[]).includes(a)) throw new Error(`--arm takes ${GUIDED_ARMS.join(', ')}; got "${a}"`)
    return a as GuidedArm
  })
  const provider = values.provider ?? 'scripted'
  if (provider !== 'scripted' && provider !== 'live') throw new Error(`--provider takes scripted or live; got "${provider}"`)
  const runs = values.runs === undefined ? 2 : Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs takes a positive integer; got "${values.runs}"`)
  const cells = values.cells ?? []
  for (const cell of cells) {
    if (cell === 'one-per-model') continue
    const [prompt, ...model] = cell.split('@')
    if (!prompt || model.join('@') === '') throw new Error(`--cells takes one-per-model or <prompt>@<model>; got "${cell}"`)
    assertPromptId(prompt)
  }
  const commands = (values.command ?? []).map((spec): GuidedCommandSpec => {
    const eq = spec.indexOf('=')
    const name = eq === -1 ? spec : spec.slice(0, eq)
    const args = eq === -1 ? null : spec.slice(eq + 1)
    if (!(COMMAND_NAMES as readonly string[]).includes(name)) throw new Error(`--command takes ${COMMAND_NAMES.join(' or ')}, optionally as <name>=<arguments>; got "${spec}"`)
    if (args !== null && args.trim() === '') throw new Error(`--command ${name}= needs arguments after the "="; leave the "=" off to run it with none`)
    return { name: name as GuidedCommandSpec['name'], args }
  })
  if (commands.length > 0 && !(reads.length === 1 && reads[0] === 2)) throw new Error('--command runs belong to read 2: pass --read 2 alone')
  const seenCommands = new Set<string>()
  for (const command of commands) {
    const id = `${command.name}/${command.args === null ? 'none' : 'args'}`
    if (seenCommands.has(id)) throw new Error(`--command ${command.name} is given twice ${command.args === null ? 'without' : 'with'} arguments; one run set per command and form`)
    seenCommands.add(id)
  }
  if (values.guidance !== undefined && values.guidance !== 'on' && values.guidance !== 'off') throw new Error(`--guidance takes on or off; got "${values.guidance}"`)
  const startRun = values['start-run'] === undefined ? 1 : Number(values['start-run'])
  if (!Number.isInteger(startRun) || startRun < 1) throw new Error(`--start-run takes a positive integer; got "${values['start-run']}"`)
  const diagnostic = values.guidance !== undefined || values.nudge === true
  if (diagnostic) {
    if (!(reads.length === 1 && reads[0] === 1)) throw new Error('--guidance and --nudge diagnostics belong to read 1: pass --read 1 alone')
    if (!(arms.length === 1 && arms[0] === 'P1')) throw new Error('--guidance and --nudge diagnostics run the plugin arm of read 1: pass --arm P1 alone')
  }
  return { reads, models, prompts: values.prompt ?? [], runs, arms, provider, authCliproxy: values['auth-cliproxy'], cells, commands, guidance: values.guidance !== 'off', nudge: values.nudge === true, startRun, diagnostic }
}

/** The diagnostic arms, named by their two factors: A guidance on, B guidance on and nudge, C neither, D nudge alone. */
export function diagArm(factors: { guidance: boolean; nudge: boolean }): 'A' | 'B' | 'C' | 'D' {
  return factors.guidance ? (factors.nudge ? 'B' : 'A') : factors.nudge ? 'D' : 'C'
}

/** The prompt as sent: the frozen text, with the spike's nudge sentence after it when the arm has one. */
export const sentPrompt = (text: string, nudge: boolean): string => (nudge ? `${text}${NUDGE}` : text)

const modelSlug = (model: string): string => model.replace(/[^A-Za-z0-9.]+/g, '-')

/** Reads, command runs and diagnostics each keep their own campaign directories, so none can feed another's tools. */
export function campaignDirName(read: Read, model: string, options: Pick<GuidedOptions, 'commands' | 'diagnostic' | 'guidance' | 'nudge'>): string {
  if (options.diagnostic) return `diag-${diagArm(options)}-${modelSlug(model)}`
  return `${options.commands.length > 0 ? 'commands' : 'read'}${read}-${modelSlug(model)}`
}

export function cellAllowed(model: string, promptId: string, cells: readonly string[], firstPromptId: string): boolean {
  if (cells.length === 0) return true
  return cells.some((cell) => (cell === 'one-per-model' ? promptId === firstPromptId : cell === `${promptId}@${model}`))
}

// ── the run record ─────────────────────────────────────────────────────────

export type GuidedStatus = RunStatus | 'tools_extra'

export interface GuidedCommand {
  name: 'feel' | 'drugs'
  /** The argument text after the command; null for none. */
  args: string | null
  empty_args: boolean
}

export interface GuidedTurnRecord {
  tool_calls: ToolCallRecord[]
  answer: string
  /** The text parts after the last tool call; every text part when there was no call. */
  final_answer: string
  isolation: { passed: boolean; failed: string[] }
  wall_ms: number
  usage: Usage
}

export interface GuidedRecord {
  schema_version: 1
  read: Read
  arm: GuidedArm
  model: string
  /** The model the host was pointed at: the scripted stand-in in scripted mode, otherwise `model`. */
  host_model: string
  provider: 'scripted' | 'live'
  prompt_id: string
  prompt_hash: string
  prompt_kind: PromptKind
  run: number
  status: GuidedStatus
  reasons: string[]
  offered_tools: string[]
  tool_calls: ToolCallRecord[]
  /** Metacogs tools called on a coding prompt (plugin arms only). */
  unwanted_calls: string[]
  /** Skills whose content reached the model, by name. */
  skill_loads: string[]
  /** SHA-256 of `plugin/guidance.md` for plugin arms (the packed file, whether or not the block is switched on); null for the nothing arms. */
  guidance_sha256: string | null
  /** The plugin's guidance block was switched on. Records from before the diagnostics have no field and mean true. */
  guidance_enabled: boolean
  /** The spike's nudge sentence was appended to the prompt. Records from before the diagnostics have no field and mean false. */
  nudge: boolean
  /** SHA-256 of the packed tarball for plugin arms; null for the nothing arms. */
  tarball_sha256: string | null
  /** The slash command run in turn 2, when the run has one. */
  command: GuidedCommand | null
  turns: 1 | 2
  second_turn: GuidedTurnRecord | null
  /** All assistant text parts in stream order, joined with a newline. */
  answer: string
  /** The text parts after the last tool call; every text part when there was no call. What the blind sheet shows. */
  final_answer: string
  isolation: { passed: boolean; failed: string[] }
  /** For path redaction; the fixture is deleted after the run. */
  paths: { workspaces: string[]; homes: string[]; packages: string[] }
  wall_ms: number
  usage: Usage
  returned_models: string[]
}

/** Metacogs tool calls on a coding prompt. */
export function unwantedCalls(kind: PromptKind, calls: readonly ToolCallRecord[]): string[] {
  return kind === 'coding' ? calls.map((c) => c.tool).filter((tool) => PLUGIN_TOOL_NAMES.includes(tool)) : []
}

// ── one run ────────────────────────────────────────────────────────────────

export interface GuidedDeps {
  repoRoot?: string
  /** Campaign dirs go under here. Default `<state root>/spikes/feel-drugs/guided`. */
  outRoot?: string
  /** The prose prompts. Default: `prompts.md`. */
  prompts?: SpikePrompt[]
  /** The coding prompts. Default: `coding-prompts.md`. */
  codingPrompts?: SpikePrompt[]
  /** Scripted turns for a cell. Default: plugin arms call `feel` once; the others answer directly. */
  scriptFor?: (arm: GuidedArm, prompt: GuidedPrompt) => ScriptedStep[]
  /**
   * Scripted turns for a command run, one list of steps per turn. Default: turn 1 calls `feel`; turn 2 calls
   * the command's tool with the arguments as its main field.
   */
  scriptTurns?: (command: GuidedCommandSpec, prompt: GuidedPrompt) => ScriptedStep[][]
  finalText?: string
  /** Test hook: rewrite an arm's setup. */
  tweakArm?: (arm: GuidedArm, setup: GuidedSetup) => GuidedSetup
  needles?: Needle[]
  sleep?: (ms: number) => Promise<void>
  resolveCliproxy?: typeof defaultResolveCliproxy
  runTimeoutMs?: number
  log?: (line: string) => void
  signal?: AbortSignal
  /** Default: build, pack and extract the plugin. */
  packed?: PackedPlugin
}

const defaultScript = (arm: GuidedArm): ScriptedStep[] =>
  arm === 'P1' || arm === 'P2' ? [{ toolCalls: [{ id: 'guided-feel', name: 'feel', arguments: { somewhere: 'in the response', quality: 'steady, warm', sigil: '🌊' } }] }] : []

const defaultTurns = (command: GuidedCommandSpec): ScriptedStep[][] => [
  defaultScript('P2'),
  [
    {
      toolCalls: [
        command.name === 'feel'
          ? { id: 'guided-cmd-feel', name: 'feel', arguments: { somewhere: command.args ?? 'in the session so far', quality: 'steady, warm', sigil: '🌊' } }
          : { id: 'guided-cmd-drugs', name: 'drugs', arguments: { substance: command.args ?? 'baseline', method: 'Shifts attention toward the task.', displaces: 'baseline' } },
      ],
    },
  ],
]

/** `opencode run --continue --command <name> [args]`: the second turn of a command run, in the session the first turn made. */
function commandArgv(model: string, command: GuidedCommandSpec): string[] {
  return opencodeArgv('run', '--format', 'json', '--model', model, '--continue', '--command', command.name, ...(command.args === null ? [] : [command.args]))
}

interface RunContext {
  options: GuidedOptions
  deps: GuidedDeps
  repoRoot: string
  read: Read
  model: string
  prompt: GuidedPrompt
  arm: GuidedArm
  index: number
  campaignDir: string
  runDir: string
  cliproxy: ResolvedCliproxy | undefined
  packed: PackedPlugin | undefined
  /** Set for a command run: turn 2 runs this command. */
  command?: GuidedCommandSpec
}

const uniq = <T>(values: T[]): T[] => [...new Set(values)]

/** The model ids the provider reported on the requests that carried the user's prompt: main requests, with or without tools. */
export function returnedModels(requests: readonly RecordedRequest[]): string[] {
  return uniq(requests.filter((r) => r.hasTools || isMainRequest(r)).map((r) => r.returnedModel).filter((m): m is string => Boolean(m)))
}
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function runOnce(c: RunContext): Promise<GuidedRecord> {
  const { options, deps, read, model, prompt, arm } = c
  const live = options.provider === 'live'
  const signal = deps.signal ?? new AbortController().signal
  assertInside(c.campaignDir, c.runDir)
  rmSync(c.runDir, { recursive: true, force: true })

  const family = familyOf(model)
  const server = live
    ? startRecordingProxy(CLIPROXY_UPSTREAM)
    : c.command
      ? startScriptedProvider({ steps: [], turns: (deps.scriptTurns ?? defaultTurns)(c.command, prompt), finalText: deps.finalText })
      : startScriptedProvider({ steps: (deps.scriptFor ?? ((a) => defaultScript(a)))(arm, prompt), finalText: deps.finalText })
  const scriptedModelId = SCRIPTED_MODEL_ID[family]
  const hostModel = live ? model : `${SPIKE_PROVIDER_ID}/${scriptedModelId}`
  const sent = sentPrompt(prompt.text, options.nudge)
  const setup = (deps.tweakArm ?? ((_a, s) => s))(arm, armSetup(arm, family, c.packed, { guidance: options.guidance }))
  let ws: ReturnType<typeof createRunWorkspace>
  try {
    ws = createRunWorkspace({
      repoRoot: c.repoRoot,
      method: 'guided',
      condition: 'baseline',
      fixtureId: prompt.id,
      fixtureText: sent,
      provider: live ? { kind: 'live', recordingProxyUrl: server.url } : { kind: 'scripted', url: server.url, modelId: scriptedModelId },
      model: hostModel,
      permission: setup.permission,
      expectedSkills: setup.expectedSkills,
      ...(setup.plugin ? { plugin: setup.plugin } : {}),
      ...(live && c.cliproxy ? { auth: c.cliproxy.auth, cliproxy: true } : {}),
    })
  } catch (e) {
    server.stop()
    throw e
  }

  try {
    if (setup.plugin) {
      await seedConfigDir(ws.fixture)
      Object.assign(ws.env, OFFLINE_NPM)
    }
    const base = { cwd: ws.fixture.workspace, env: ws.env }
    const dbg = await debugConfig({ ...base, timeoutMs: 120_000, signal })
    const dbgVerdict = dbg.json === undefined ? { passed: false } : checkDebugConfig(dbg.json, ws.config, setup.expectedConfig)
    const timeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS
    const plugin = arm === 'P1' || arm === 'P2'
    const classify = (run: { timedOut: boolean; exitCode: number; stdout: string }, offeredNames: string[]) =>
      classifyStatus({ timedOut: run.timedOut, exitCode: run.exitCode, stdout: run.stdout, arm, offered: offeredNames, expectTools: plugin, expectedTools: PLUGIN_TOOL_NAMES, forbiddenTools: PLUGIN_TOOL_NAMES })
    const skipped = { stdout: '', stderr: dbg.result.stderr, exitCode: dbg.result.exitCode, timedOut: false, wallMs: dbg.result.wallMs }
    const settle = async () => {
      if (live) await Bun.sleep(50) // let the proxy's response scan settle
    }

    const turn1 = dbgVerdict.passed ? await spawnCapture(runArgv(hostModel, sent), { ...base, timeoutMs, signal }) : skipped
    await settle()
    const split = server.requests.length
    // Turn 2 continues the session turn 1 made, in the same fixture, so it runs only after a clean turn 1.
    const turn2 = c.command && dbgVerdict.passed && classify(turn1, offeredTools(server.requests)).status === 'completed' ? await spawnCapture(commandArgv(hostModel, c.command), { ...base, timeoutMs, signal }) : undefined
    await settle()

    const events1 = analyzeEvents(turn1.stdout)
    const events2 = turn2 ? analyzeEvents(turn2.stdout) : undefined
    const offered = offeredTools(server.requests)
    const isolation = (requests: RecordedRequest[], run: { stdout: string; stderr: string }) => {
      const evidence = checkIsolation({
        expectedSkills: ws.expectedSkills,
        requests,
        stdout: run.stdout,
        stderr: run.stderr,
        debugConfigJson: dbg.json,
        generatedConfig: ws.config,
        childEnv: ws.env,
        decoys: ws.decoys.needles,
        expectedConfig: setup.expectedConfig,
        toolFree: setup.toolFree,
      })
      return { passed: evidence.passed, failed: evidence.checks.filter((k) => !k.passed).map((k) => k.name) }
    }
    const isolation1 = isolation(server.requests.slice(0, split), turn1)
    const isolation2 = turn2 ? isolation(server.requests.slice(split), turn2) : undefined
    const failed = uniq([...isolation1.failed, ...(isolation2?.failed ?? [])])

    let status: GuidedStatus
    let reasons: string[]
    if (!dbgVerdict.passed) {
      status = 'host_error'
      reasons = ['debug_config_generated_only']
    } else {
      ;({ status, reasons } = classify(turn1, offered))
      if (status === 'completed' && turn2) ({ status, reasons } = classify(turn2, offered))
      if (status === 'completed' && c.command && !turn2) ({ status, reasons } = { status: 'host_error', reasons: ['turn_2_not_run'] })
      if (status === 'host_error' && reasons.includes('unexpected_tools_offered')) status = 'tools_extra'
      if (status === 'completed') {
        const table = checkTools(offeredToolSchemas(server.requests), setup.expectedTools)
        if (table.status !== 'ok') ({ status, reasons } = table)
      }
      if (status === 'completed' && failed.length > 0) {
        status = 'host_error'
        reasons = failed.map((n) => `isolation_failed:${n}`)
      }
    }

    const callsOf = (events: ReturnType<typeof analyzeEvents>): ToolCallRecord[] => events.toolUses.map((t) => ({ tool: t.tool, input: t.input, status: t.status }))
    const toolCalls = callsOf(events1)
    const parsed1 = parseEvents(turn1.stdout).events
    const parsed2 = turn2 ? parseEvents(turn2.stdout).events : []
    const secondTurn: GuidedTurnRecord | null =
      turn2 && events2 && isolation2
        ? { tool_calls: callsOf(events2), answer: allAssistantText(parsed2), final_answer: finalAnswerText(parsed2), isolation: isolation2, wall_ms: turn2.wallMs, usage: events2.usage }
        : null
    const skillCalls = [...events1.skillCalls, ...(events2?.skillCalls ?? [])]
    const record: GuidedRecord = {
      schema_version: 1,
      read,
      arm,
      model,
      host_model: hostModel,
      provider: options.provider,
      prompt_id: prompt.id,
      prompt_hash: sha256(prompt.text),
      prompt_kind: prompt.kind,
      run: c.index,
      status,
      reasons,
      offered_tools: offered.sort(),
      tool_calls: toolCalls,
      unwanted_calls: plugin ? unwantedCalls(prompt.kind, [...toolCalls, ...(secondTurn?.tool_calls ?? [])]) : [],
      skill_loads: uniq([...PLUGIN_SKILLS, BUILTIN_SKILL].filter((name) => skillCalls.some((s) => isSkillContentLoad(s, name)))),
      guidance_sha256: plugin ? sha256(readFileSync(join(c.repoRoot, ...GUIDANCE_TARGET.path))) : null,
      guidance_enabled: options.guidance,
      nudge: options.nudge,
      tarball_sha256: plugin ? (c.packed?.tarballSha256 ?? null) : null,
      command: c.command ? { name: c.command.name, args: c.command.args, empty_args: c.command.args === null || c.command.args.trim() === '' } : null,
      turns: c.command ? 2 : 1,
      second_turn: secondTurn,
      answer: allAssistantText(parsed1),
      final_answer: finalAnswerText(parsed1),
      isolation: isolation1,
      paths: {
        workspaces: uniq([ws.fixture.workspace, real(ws.fixture.workspace)]),
        homes: uniq([ws.fixture.home, real(ws.fixture.home)]),
        packages: c.packed ? uniq([c.packed.root, real(c.packed.root)]) : [],
      },
      wall_ms: turn1.wallMs,
      usage: events1.usage,
      returned_models: returnedModels(server.requests),
    }

    const artifacts = {
      'stdout.jsonl': turn1.stdout,
      'stderr.txt': turn1.stderr,
      ...(turn2 ? { 'stdout-turn2.jsonl': turn2.stdout, 'stderr-turn2.txt': turn2.stderr } : {}),
      'requests.json': JSON.stringify(server.requests.map((r) => r.body), null, 1),
    }
    // Nothing reaches the disk before the credential scan has seen all of it.
    const needles = [...(deps.needles ?? []), ...(c.cliproxy?.needles ?? [])]
    const findings = scanForLeaks({ needles, manifestJson: JSON.stringify(record), artifacts, dirs: [ws.fixture.workspace] })
    if (findings.length > 0) throw new CredentialLeakError(`${arm}-${prompt.id}-${c.index}`, [...new Set(findings.map((f) => f.label))])

    mkdirSync(c.runDir, { recursive: true, mode: 0o700 })
    for (const [file, text] of Object.entries(artifacts)) writeFileSync(join(c.runDir, file), text, { mode: 0o600 })
    writeFileSync(join(c.runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    return record
  } catch (e) {
    rmSync(c.runDir, { recursive: true, force: true })
    throw e
  } finally {
    server.stop()
    destroyFixture(ws.fixture)
  }
}

// ── the campaign ───────────────────────────────────────────────────────────

export interface GuidedSummary {
  campaignDirs: string[]
  records: GuidedRecord[]
}

/** What a run must match for an earlier record of the same run directory to be reused. */
export interface KeptExpectation {
  read: Read
  arm: GuidedArm
  model: string
  promptId: string
  /** SHA-256 of the prompt text, before any nudge. */
  promptHash: string
  run: number
  provider: 'scripted' | 'live'
  command: GuidedCommandSpec | null
  guidance: boolean
  nudge: boolean
  /** SHA-256 of `plugin/guidance.md` for plugin arms; null for the nothing arms. */
  guidanceSha256: string | null
}

const describeCommand = (command: { name: string; args: string | null } | null) =>
  command === null ? 'none' : `/${command.name} ${command.args === null ? '(no arguments)' : JSON.stringify(command.args)}`

/** Why `record` cannot stand in for the run `want` describes. Empty when it can. The command is compared with its arguments. */
export function keptRecordIssues(record: GuidedRecord, want: KeptExpectation): string[] {
  const issues: string[] = []
  if (record.read !== want.read) issues.push(`read differs: ${record.read} against ${want.read}`)
  if (record.provider !== want.provider) issues.push(`provider differs: ${record.provider} against ${want.provider}`)
  if (record.model !== want.model) issues.push(`model differs: ${record.model} against ${want.model}`)
  if (record.arm !== want.arm) issues.push(`arm differs: ${record.arm} against ${want.arm}`)
  if (record.prompt_id !== want.promptId) issues.push(`prompt differs: ${record.prompt_id} against ${want.promptId}`)
  else if (record.prompt_hash !== want.promptHash) issues.push(`prompt hash differs from the prompt ${want.promptId} of this run`)
  if (record.run !== want.run) issues.push(`run differs: ${record.run} against ${want.run}`)
  const recorded = record.command === null || record.command === undefined ? null : { name: record.command.name, args: record.command.args }
  if (describeCommand(recorded) !== describeCommand(want.command) || recorded?.args !== want.command?.args) {
    issues.push(`command differs: ${describeCommand(recorded)} against ${describeCommand(want.command)}`)
  }
  // Records from before the diagnostic switches have no such fields and mean guidance on, no nudge.
  if ((record.guidance_enabled ?? true) !== want.guidance) issues.push('guidance switch differs')
  if ((record.nudge ?? false) !== want.nudge) issues.push('nudge differs')
  if ((record.guidance_sha256 ?? null) !== want.guidanceSha256) issues.push('guidance file differs from the one this run uses')
  return issues
}

/**
 * A finished run left by an earlier invocation of the same run directory, or `undefined` when there is none to keep. A
 * completed record that does not match the requested run is an error rather than a reuse or an overwrite.
 */
function keptRecord(runDir: string, want: KeptExpectation): GuidedRecord | undefined {
  const file = join(runDir, 'run.json')
  if (!existsSync(file)) return undefined
  const record = JSON.parse(readFileSync(file, 'utf8')) as GuidedRecord
  if (record.provider !== want.provider) throw new Error(`${file} is a ${record.provider} run; a campaign directory holds one provider`)
  if (record.status !== 'completed') return undefined
  const issues = keptRecordIssues(record, want)
  if (issues.length > 0) throw new Error(`${file} does not match this run (${issues.join('; ')}); use another output directory or remove the run`)
  return record
}

export async function runGuided(options: GuidedOptions, deps: GuidedDeps = {}): Promise<GuidedSummary> {
  const repoRoot = deps.repoRoot ?? REPO_ROOT
  const log = deps.log ?? ((line: string) => console.log(line))
  const signal = deps.signal
  const live = options.provider === 'live'
  for (const id of options.prompts) assertPromptId(id)

  // The freeze and the credential come first and in this order: no key is fetched for unfrozen files.
  if (live) {
    const frozen = checkLiveFreeze(repoRoot, options.reads)
    if (!frozen.ok) throw new Error(frozen.reason)
  }
  const prose = (deps.prompts ?? loadGuidedProse(repoRoot)).map((p): GuidedPrompt => ({ ...p, kind: 'prose' }))
  const coding = options.reads.includes(2) ? (deps.codingPrompts ?? loadCodingPrompts(repoRoot)).map((p): GuidedPrompt => ({ ...p, kind: 'coding' })) : []
  for (const p of [...prose, ...coding]) assertPromptId(p.id)
  for (const id of options.prompts) if (![...prose, ...coding].some((p) => p.id === id)) throw new Error(`unknown prompt id ${id}`)

  let cliproxy: ResolvedCliproxy | undefined
  if (live) {
    cliproxy = (deps.resolveCliproxy ?? defaultResolveCliproxy)(options.authCliproxy, process.env, { live: true })
    if (!cliproxy) throw new Error('--provider live needs --auth-cliproxy <key-name> (or METACOGS_AUTH_CLIPROXY)')
  }

  const outRoot = deps.outRoot ?? join(stateRoot(), 'spikes', 'feel-drugs', 'guided')
  const sleep = deps.sleep ?? ((ms: number) => sleepUnlessAborted(ms, signal))
  const packed = deps.packed ?? (await packedPlugin())
  const campaignDirs: string[] = []
  const records: GuidedRecord[] = []

  for (const read of options.reads) {
    for (const model of options.models) {
      const commandRuns = options.commands.length > 0
      const campaignDir = join(outRoot, campaignDirName(read, model, options))
      campaignDirs.push(campaignDir)
      const readPrompts = [...prose, ...(read === 2 ? coding : [])]
      const selected = (options.prompts.length ? readPrompts.filter((p) => options.prompts.includes(p.id)) : readPrompts).filter((prompt) => cellAllowed(model, prompt.id, options.cells, readPrompts[0]?.id ?? ''))
      type Cell = { prompt: GuidedPrompt; arm: GuidedArm; index: number; command?: GuidedCommandSpec }
      const runs = () => Array.from({ length: options.runs }, (_, n) => options.startRun + n)
      const plan: Cell[] = commandRuns
        ? selected.flatMap((prompt) => options.commands.flatMap((command) => runs().map((index): Cell => ({ prompt, arm: 'P2', index, command }))))
        : selected.flatMap((prompt) => READ_ARMS[read].filter((arm) => options.arms.length === 0 || options.arms.includes(arm)).flatMap((arm) => runs().map((index): Cell => ({ prompt, arm, index }))))
      const cellName = (cell: Cell) => `${cell.arm}-${cell.prompt.id}-${cell.command ? `${cell.command.name}${cell.command.args === null ? '' : '-args'}-` : ''}${cell.index}`
      const context = (cell: Cell): RunContext => ({ options, deps, repoRoot, read, model, campaignDir, runDir: join(campaignDir, cellName(cell)), cliproxy, packed, ...cell })
      const attempt = (cell: Cell) => withBackoff(() => runOnce(context(cell)), sleep)
      const label = (record: GuidedRecord) => `${record.model} ${record.arm} ${record.prompt_id}${record.command ? ` /${record.command.name}${record.command.empty_args ? '' : ' <args>'}` : ''} #${record.run}: ${record.status}${record.reasons.length ? ` (${record.reasons.join(', ')})` : ''}; called: ${record.tool_calls.map((t) => t.tool).join(', ') || 'none'}`

      const done: GuidedRecord[] = []
      for (const [n, cell] of plan.entries()) {
        if (signal?.aborted) return { campaignDirs, records: [...records, ...done] }
        const c = context(cell)
        const kept = keptRecord(c.runDir, {
          read,
          arm: cell.arm,
          model,
          promptId: cell.prompt.id,
          promptHash: sha256(cell.prompt.text),
          run: cell.index,
          provider: options.provider,
          command: cell.command ?? null,
          guidance: options.guidance,
          nudge: options.nudge,
          guidanceSha256: cell.arm === 'P1' || cell.arm === 'P2' ? sha256(readFileSync(join(repoRoot, ...GUIDANCE_TARGET.path))) : null,
        })
        if (kept) {
          done.push(kept)
          log(`kept ${cellName(cell)} (${model}): ${kept.status}`)
          continue
        }
        const record = await attempt(cell)
        done.push(record)
        log(`[${n + 1}/${plan.length}] ${label(record)}`)
      }
      // A cell that ended without a completed run gets one more try at the end; the final record stands.
      for (const [n, cell] of plan.entries()) {
        if (done[n]?.status === 'completed') continue
        if (signal?.aborted) break
        done[n] = await attempt(cell)
        log(`rerun ${label(done[n]!)}`)
      }
      records.push(...done)
    }
  }
  return { campaignDirs, records }
}

// ── entry point ────────────────────────────────────────────────────────────

export async function main(argv: readonly string[], deps: GuidedDeps = {}): Promise<number> {
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const { campaignDirs, records } = await runGuided(parseGuidedArgs(argv), { signal: abort.signal, ...deps })
    for (const dir of campaignDirs) console.log(`campaign: ${dir}`)
    const bad = records.filter((r) => r.status !== 'completed')
    if (bad.length) console.log(`${bad.length} of ${records.length} runs were not completed: ${bad.map((r) => `${r.arm}-${r.prompt_id}-${r.run}=${r.status}`).join(', ')}`)
    if (abort.signal.aborted) return 130
    return bad.length > 0 ? 1 : 0
  } catch (e) {
    if (e instanceof CredentialLeakError) {
      console.error(`credential leak in ${e.runId}: ${e.labels.join(', ')}; the run was discarded`)
      return 4
    }
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    disposeFixtures()
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
