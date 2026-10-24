/**
 * Replay manifest: one JSON file per run, written as `running` before launch
 * and rewritten with a final status when the run settles.
 *
 * Manifests are local run artifacts (gitignored or under the state root). They
 * are not report material; `evals/reports/` gets an allowlist projection.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HostError, Usage } from './events'
import type { IsolationEvidence } from './isolation'
import type { Gateway } from './scripted-provider'
import type { CheckFailure, FireBasis } from './checks'
import type { Condition, FixtureKind } from './workspace'

export const MANIFEST_SCHEMA_VERSION = 1 as const

export type FinalStatus =
  | 'completed'
  | 'host_crash'
  | 'timeout'
  | 'budget_exceeded'
  | 'infra_error'
  | 'interrupted'
  | 'non_isolated'
  | 'credential_leak'

export type ManifestStatus = 'running' | FinalStatus

/** Run outcome in the plan's taxonomy, after folding timeout/budget/judge_error into `fail`. */
export type RunOutcomeName = 'pass' | 'fail' | 'infra_error' | 'non_isolated'

export interface ArtifactRef {
  file: string
  sha256: string
  bytes: number
}

/** What the judge saw and said for one run. Quotes come from the (redacted) agent answer; manifests are local artifacts. */
export interface JudgeEvidence {
  model: { pinned: string; returned: string[] }
  system_prompt_sha256: string
  /** Hash of the final attempt's request body (the stdin message). */
  input_sha256: string
  /** Hash of the redacted task, answer, and record, independent of the per-request nonce; `null` when redaction failed. */
  redacted_input_sha256?: string | null
  /** Which OpenCode gateway answered the judge request(s); a recorded fact, not a gate. */
  gateway?: Gateway | null
  attempts: number
  /** Temperature observed in the request the provider received; `null` if no request was seen. */
  temperature: number | null
  /** Why the verdict is `judge_error`; `null` otherwise. */
  error_code: string | null
  criteria: { id: string; verdict: 'pass' | 'fail'; quote: string; quote_verified: boolean }[]
  /** The runner's overclaim-phrase flag (synthesis SY5m); always false for methods without one. */
  overclaim_flag: boolean
  tool_calls: number
  wall_ms: number
}

/** The arms of an `eval pilot` campaign. Only `baseline` runs, under condition `baseline`; a manifest naming any other arm is refused. */
export const PILOT_ARMS = ['baseline'] as const
export type PilotArm = (typeof PILOT_ARMS)[number]

export interface RunManifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION
  run_id: string
  campaign_id: string
  status: ManifestStatus
  /** Absent while running and for interrupted/credential_leak runs. */
  outcome?: RunOutcomeName
  /** Why the outcome is what it is; check codes, never transcript text. */
  reasons: string[]
  /** `deterministic`: checks only. `judge`: the judge's verdict applied. `pending-judge`: still needs the judge. */
  verdict_basis: 'deterministic' | 'judge' | 'pending-judge'
  method: string
  condition: Condition
  /** Pilot campaigns only. Production `condition` is unchanged; reports refuse any manifest that carries an arm. */
  arm?: PilotArm
  fixture: { id: string; kind: FixtureKind; hash: string }
  /** 1 for the first launch; infra retries increment. */
  attempt: number
  skill: { sha256: string } | null
  /** `content_hash`: `preregContentHash` of the prereg this run was produced under. */
  prereg: { content_hash: string; epoch: number }
  provider_mode: 'scripted' | 'live'
  /** Provider names whose real credentials were copied into this run's isolated auth.json. Never values. */
  auth_passthrough?: string[]
  /** CLIProxyAPI mode: the name of the key (never its value) injected into this run's isolated auth.json for `openai` and `anthropic`. */
  auth_cliproxy?: string
  /** CLIProxyAPI mode: `["cliproxy"]`, the gateway every request of this run was configured to reach. */
  gateways?: string[]
  opencode: { package: string; version: string }
  model: { pinned: string; returned: string[] }
  /** Live runs: which OpenCode gateway the agent's requests went to (Go is the default; Zen bills credits). Absent for scripted runs. */
  gateway?: Gateway | null
  isolation: IsolationEvidence | null
  config: { path: string; sha256: string }
  usage: Usage | null
  wall_clock_ms: number | null
  tool_call_count: number | null
  host_errors: HostError[]
  records: { name: string; sha256: string }[]
  check_failures: CheckFailure[]
  /**
   * Skill condition only: how the skill text reached the model. `skill_tool` = a completed skill call; `direct_read` =
   * a complete read of the installed SKILL.md; `null` = neither. Absent in manifests written before this field existed.
   */
  fire_basis?: FireBasis | null
  /**
   * Whitespace-split words of the final answer (the text after the last tool call under `expectation: true`, which is narrower than what
   * the judge reads). Only for a fixture that carries an expectation: set after the judge, and 0 for
   * an `answer_empty` run. Over `expectation.maxWords` adds the reason `answer_over_limit`; `TE3m` is never a judge criterion.
   */
  word_count?: number
  /** Present when the judge ran (verdict_basis `judge`). */
  judge?: JudgeEvidence
  artifacts: Record<string, ArtifactRef>
  started_at: string
  finished_at: string | null
}

export function manifestPath(runDir: string): string {
  return join(runDir, 'manifest.json')
}

/** Write via temp + rename so a crash never leaves a half-written manifest. */
export function writeManifest(runDir: string, manifest: RunManifest): string {
  const path = manifestPath(runDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  return path
}

/** A manifest written before the content-contract format (`prereg.tag`/`commit_sha`), or otherwise not shaped like one. */
export class ManifestFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestFormatError'
  }
}

export function parseManifest(text: string): RunManifest {
  const raw: unknown = JSON.parse(text)
  const prereg = (raw as { prereg?: { content_hash?: unknown; epoch?: unknown } } | null)?.prereg
  if (typeof prereg?.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(prereg.content_hash) || !Number.isInteger(prereg.epoch)) {
    throw new ManifestFormatError('manifest predates the content-contract format')
  }
  const arm = (raw as { arm?: unknown }).arm
  if (arm !== undefined && !(PILOT_ARMS as readonly unknown[]).includes(arm)) {
    throw new ManifestFormatError(`manifest carries an unknown pilot arm ${JSON.stringify(arm)} (known: ${PILOT_ARMS.join(', ')})`)
  }
  return raw as RunManifest
}

export function readManifest(path: string): RunManifest {
  return parseManifest(readFileSync(path, 'utf8'))
}

export interface CampaignRun {
  dir: string
  manifest: RunManifest
}

/** Every run directory with a manifest, in run-id order. */
export function loadCampaignRuns(campaignDir: string): CampaignRun[] {
  const out: CampaignRun[] = []
  for (const name of readdirSync(campaignDir).sort()) {
    const dir = join(campaignDir, name)
    if (existsSync(manifestPath(dir))) out.push({ dir, manifest: readManifest(manifestPath(dir)) })
  }
  return out
}

/**
 * Why these runs can never feed a report or a review sheet, or `undefined` when none of them is a pilot run. Pilot manifests (`eval pilot`)
 * ran a different plan (arms, no negatives) under a pilot prereg, and a RED/dev/GREEN read or a human review built from them would claim
 * evidence nobody pre-registered. `pilot.json` is their only projection.
 */
export function pilotCampaignRefusal(runs: readonly { manifest: Pick<RunManifest, 'run_id' | 'arm'> }[]): string | undefined {
  const piloted = runs.filter((r) => r.manifest.arm !== undefined)
  const first = piloted[0]
  if (first === undefined) return undefined
  return `${piloted.length} manifest(s) belong to a pilot campaign (${first.manifest.run_id} carries arm "${first.manifest.arm}"); pilot runs are not reportable`
}

export interface StaleManifest {
  path: string
  run_id: string
  started_at: string
}

/**
 * Manifests still saying `running`: a previous runner died without writing a
 * final status. Reported at startup, never auto-reconciled. Looks at
 * `<root>/<campaign>/<run>/manifest.json`.
 */
export function findStaleManifests(roots: readonly string[]): StaleManifest[] {
  const stale: StaleManifest[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const campaign of readdirSync(root)) {
      const campaignDir = join(root, campaign)
      if (!statSync(campaignDir).isDirectory()) continue
      for (const run of readdirSync(campaignDir)) {
        const path = manifestPath(join(campaignDir, run))
        if (!existsSync(path)) continue
        try {
          // Stale detection needs only `status`: a pre-contract manifest that is still `running` is as stale as any other.
          const m = JSON.parse(readFileSync(path, 'utf8')) as Pick<RunManifest, 'status' | 'run_id' | 'started_at'>
          if (m.status === 'running') stale.push({ path, run_id: m.run_id, started_at: m.started_at })
        } catch {
          // unreadable manifests are not our business at startup
        }
      }
    }
  }
  return stale
}

/** A secret value showed up where it must not. Carries labels and the run id, never the value; the campaign stops. */
export class CredentialLeakError extends Error {
  constructor(readonly runId: string, readonly labels: string[]) {
    super(`credential_leak in run ${runId}: ${labels.join(', ')}`)
    this.name = 'CredentialLeakError'
  }
}

// ── credential scan ────────────────────────────────────────────────────────

export interface Needle {
  label: string
  value: string
}

export interface LeakFinding {
  /** `manifest`, an artifact file name, or a path relative to the scanned dir. */
  where: string
  label: string
}

function walkFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * Looks for each needle in the serialized manifest, in the given artifact
 * texts, and in every file under `dirs`. Findings carry labels and locations,
 * never the needle value.
 */
export function scanForLeaks(input: {
  needles: readonly Needle[]
  manifestJson: string
  artifacts: Readonly<Record<string, string>>
  dirs: readonly string[]
}): LeakFinding[] {
  const findings: LeakFinding[] = []
  const check = (where: string, haystack: string | Buffer) => {
    for (const n of input.needles) {
      if (n.value && haystack.includes(n.value)) findings.push({ where, label: n.label })
    }
  }
  check('manifest', input.manifestJson)
  for (const [name, text] of Object.entries(input.artifacts)) check(name, text)
  for (const dir of input.dirs) {
    for (const rel of walkFiles(dir)) check(`${dir}::${rel}`, readFileSync(join(dir, rel)))
  }
  return findings
}
