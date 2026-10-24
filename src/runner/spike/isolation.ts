/**
 * Unit 1 spike driver: run `opencode run --format json` under an allowlisted
 * env, capture its events, and expose the instruments used to prove isolation.
 *
 * Nothing here is imported from Systematic; the shapes (process-group reaping,
 * memoized availability probe, scripted provider) are reimplemented minimally.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { basePermission, buildConfig as buildGeneratedConfig, gitInit } from '../workspace'

import { buildChildEnv, createFixture, type Fixture } from '../env'
import { type ParsedEvents, parseEvents } from '../events'
import { opencodeArgv, type SpawnResult, spawnCapture } from '../opencode'
import {
  type RecordedRequest,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  scriptedProviderConfig,
  type ScriptedProviderServer,
  type ScriptedStep,
  startRecordingProxy,
  startScriptedProvider,
} from '../scripted-provider'

export { OPENCODE_PIN } from '../env'

export const SPIKE_MODEL = `${SPIKE_PROVIDER_ID}/${SPIKE_MODEL_ID}`
/** Free-tier live model. Recorded in the README; id availability is probed, not assumed. */
export const LIVE_MODEL = 'opencode/big-pickle'

// Re-exported from the runner modules so the spike suite keeps its imports.
export {
  type Availability,
  opencodeArgv,
  opencodeAvailability,
  type SpawnResult,
  spawnCapture,
} from '../opencode'
export { basePermission, gitInit } from '../workspace'
export {
  assistantText,
  type OpencodeEvent,
  type ParsedEvents,
  parseEvents,
  skillLoads,
  type ToolUse,
  toolUses,
  totalUsage,
  type Usage,
} from '../events'

// ── a scripted/live run ────────────────────────────────────────────────────

export interface RunSpec {
  prompt: string
  /** `provider/model`. Default: the scripted spike model. */
  model?: string
  /** Settings merged into the generated config (provider block is added in scripted mode). */
  permission: Record<string, unknown>
  /** Extra top-level config keys. */
  configExtra?: Record<string, unknown>
  /** Scripted turns. Omit for live runs (no stub is started). */
  steps?: readonly ScriptedStep[]
  finalText?: string
  /** Live mode: route the `opencode` provider through a body-recording proxy. */
  recordLive?: boolean
  /** Pass `--dir <workspace>` and run from a different cwd. */
  useDirFlag?: boolean
  injection?: 'file' | 'content' | 'both'
  /** Called after the fixture exists, before launch (plant skills, canaries, ...). */
  prepare?: (fixture: Fixture) => void
  /** Env override applied last (test-only). */
  extraEnv?: Record<string, string>
  /** Replace the allowlisted env entirely (control runs). */
  envOverride?: (fixture: Fixture, config: Record<string, unknown>) => Record<string, string>
  timeoutMs?: number
  /** Where to persist raw stdout/stderr/requests for inspection. */
  artifactDir?: string
  /** Reuse an existing fixture (caller destroys). */
  fixture?: Fixture
}

export interface RunOutcome extends SpawnResult {
  fixture: Fixture
  config: Record<string, unknown>
  env: Record<string, string>
  parsed: ParsedEvents
  requests: RecordedRequest[]
}

export function plantSkill(
  workspace: string,
  name: string,
  body: string,
  base = '.agents/skills',
): string {
  const dir = join(workspace, base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Spike skill ${name}.\n---\n\n${body}\n`,
  )
  return dir
}

export function buildConfig(
  spec: Pick<RunSpec, 'permission' | 'configExtra'>,
  providerUrl: string | undefined,
): Record<string, unknown> {
  return buildGeneratedConfig({
    permission: spec.permission,
    provider: providerUrl ? scriptedProviderConfig(providerUrl) : undefined,
    extra: spec.configExtra,
  })
}

export async function runOpencode(spec: RunSpec): Promise<RunOutcome> {
  const fixture = spec.fixture ?? createFixture()
  gitInit(fixture.workspace)
  spec.prepare?.(fixture)

  let server: ScriptedProviderServer | undefined
  if (spec.steps) {
    server = startScriptedProvider({ steps: spec.steps, finalText: spec.finalText })
  } else if (spec.recordLive) {
    server = startRecordingProxy()
  }
  try {
    const config = buildConfig(
      spec.recordLive
        ? {
            ...spec,
            configExtra: {
              provider: { opencode: { options: { baseURL: server?.url } } },
              ...spec.configExtra,
            },
          }
        : spec,
      spec.steps ? server?.url : undefined,
    )
    const env = spec.envOverride
      ? spec.envOverride(fixture, config)
      : buildChildEnv({
          fixture,
          config,
          injection: spec.injection,
          extra: spec.extraEnv,
        })
    const args = ['run', '--format', 'json', '--model', spec.model ?? SPIKE_MODEL]
    let cwd = fixture.workspace
    if (spec.useDirFlag) {
      args.push('--dir', fixture.workspace)
      cwd = fixture.tmp
    }
    args.push(spec.prompt)
    const result = await spawnCapture(opencodeArgv(...args), {
      cwd,
      env,
      timeoutMs: spec.timeoutMs ?? 120_000,
    })
    const outcome: RunOutcome = {
      ...result,
      fixture,
      config,
      env,
      parsed: parseEvents(result.stdout),
      requests: server?.requests ?? [],
    }
    if (spec.artifactDir) persistArtifacts(spec.artifactDir, outcome)
    return outcome
  } finally {
    server?.stop()
  }
}

function persistArtifacts(dir: string, outcome: RunOutcome): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdout.jsonl'), outcome.stdout)
  writeFileSync(join(dir, 'stderr.txt'), outcome.stderr)
  writeFileSync(join(dir, 'requests.json'), JSON.stringify(outcome.requests, null, 1))
}

// ── instruments ────────────────────────────────────────────────────────────

export {
  availableSkillsFromRequests,
  modelSeenText,
  offeredTools,
  systemPromptText,
} from '../isolation'

export interface CommandOutcome extends SpawnResult {
  json: unknown
}

/** `opencode debug <sub>` under the same env/cwd as a run. Output parsed as JSON when possible. */
export async function debugCommand(
  sub: string[],
  fixture: Fixture,
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<CommandOutcome> {
  const result = await spawnCapture(opencodeArgv('debug', ...sub), {
    cwd: fixture.workspace,
    env,
    timeoutMs,
  })
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = undefined
  }
  return { ...result, json }
}
