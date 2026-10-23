/**
 * Human review sheets and rejudging for a finished campaign.
 *
 * - `renderReview`: one markdown block per run (final answer, judge verdicts and quotes,
 *   rubric anchors, a blank human line). Local only: the sheet quotes agent answers and
 *   judge text, so it lives next to the run artifacts (gitignored, or under the state root).
 * - `rejudgeCampaign`: re-runs the judge over retained answers (judge calls only, no agent
 *   reruns) and writes `judge.json` per run. Manifests and outcomes are never changed; a
 *   `rejudge-summary.json` beside them lists the prior outcome next to the new verdict.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { analyzeEvents } from './events'
import { type JudgeCriterion, parseRubric } from './judge'
import { type JudgeRecord, readJudgeRecord, writeJudgeRecord } from './judge-record'
import { manifestPath, readManifest, type RunManifest } from './manifest'
import type { LoadedFixture } from './prereg'
import type { JudgeHook } from './run'

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

const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

/** The final answer: the assistant `text` parts of the run's `stdout.jsonl`. */
export function finalAnswerOf(runDir: string): string | undefined {
  const stdout = readIfExists(join(runDir, 'stdout.jsonl'))
  return stdout === undefined ? undefined : analyzeEvents(stdout).assistantText
}

// ── review sheet ───────────────────────────────────────────────────────────

export interface Anchors {
  pass: string
  fail: string
}

/** Pass and fail anchor lines of each judge criterion, as written in the rubric. */
export function rubricAnchors(criteria: readonly JudgeCriterion[]): Map<string, Anchors> {
  const out = new Map<string, Anchors>()
  for (const c of criteria) {
    const pass = /^- \*\*Pass anchor\*\*:\s*(.+)$/m.exec(c.body)?.[1] ?? ''
    const fail = /^- \*\*Fail anchor\*\*:\s*(.+)$/m.exec(c.body)?.[1] ?? ''
    out.set(c.id, { pass, fail })
  }
  return out
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

/** A fence longer than any backtick run inside `text`, so the answer cannot close it early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

export const HUMAN_LINE = 'human: [ ] agree [ ] disagree — note:'

export function renderRunBlock(run: CampaignRun, answer: string | undefined, judge: JudgeRecord | undefined, anchors: Map<string, Anchors>, records: readonly string[] = []): string {
  const { manifest } = run
  const lines: string[] = [
    `## ${manifest.run_id}`,
    '',
    `- fixture: ${manifest.fixture.id} (${manifest.fixture.kind})`,
    `- condition: ${manifest.condition}`,
    `- recorded outcome: ${manifest.outcome ?? manifest.status}${manifest.reasons.length ? ` (${manifest.reasons.join(', ')})` : ''}`,
    '',
    '**Final answer**',
    '',
    answer === undefined ? '_no stdout captured_' : answer.trim() === '' ? '_empty_' : fenced(answer.trimEnd()),
    '',
    ...records.flatMap((r) => ['**Record** (the judge saw this too)', '', fenced(r.trimEnd()), '']),
  ]
  if (!judge) {
    lines.push('**Judge**: no verdict stored for this run.')
  } else {
    lines.push(
      `**Judge** (${judge.model_pinned}; returned ${judge.model_returned.join(', ') || 'none'}; ${judge.attempts} attempt${judge.attempts === 1 ? '' : 's'}${judge.error ? `; error: ${judge.error}` : ''})`,
      '',
    )
    if (judge.criteria.length) {
      lines.push('| criterion | judge | quotes | pass anchor | fail anchor |', '| --- | --- | --- | --- | --- |')
      for (const c of judge.criteria) {
        const a = anchors.get(c.id)
        lines.push(`| ${c.id} | ${c.verdict} | ${cell(c.quotes.map((q) => `"${q}"`).join(' … '))} | ${cell(a?.pass ?? '')} | ${cell(a?.fail ?? '')} |`)
      }
    }
  }
  lines.push('', HUMAN_LINE, '')
  return lines.join('\n')
}

export function renderReview(campaignDir: string, repoRoot: string): string {
  const runs = loadCampaignRuns(campaignDir)
  if (runs.length === 0) throw new Error(`no run manifests in ${campaignDir}`)
  const method = runs[0]!.manifest.method
  const rubric = readFileSync(join(repoRoot, 'evals', method, 'rubric.md'), 'utf8')
  const anchors = rubricAnchors(parseRubric(rubric).criteria)
  const head = [
    `# Review sheet: ${runs[0]!.manifest.campaign_id}`,
    '',
    `Method ${method}. ${runs.length} runs. Local only: this file quotes agent answers and judge text. Mark each block, blind to the judge verdict if you can.`,
    '',
  ]
  const blocks = runs.map((run) => {
    const raw = readIfExists(join(run.dir, 'judge.json'))
    const kept = readIfExists(join(run.dir, 'records.json'))
    const records = kept === undefined ? [] : (JSON.parse(kept) as { content: string }[]).map((r) => r.content)
    return renderRunBlock(run, finalAnswerOf(run.dir), raw === undefined ? undefined : readJudgeRecord(raw), anchors, records)
  })
  return `${head.join('\n')}\n${blocks.join('\n')}`
}

export function writeReview(campaignDir: string, repoRoot: string): string {
  const path = join(campaignDir, 'review.md')
  writeFileSync(path, renderReview(campaignDir, repoRoot), { mode: 0o600 })
  return path
}

// ── rejudge ────────────────────────────────────────────────────────────────

export interface RejudgeInput {
  campaignDir: string
  judge: JudgeHook
  /** Verified, already-hashed fixtures by kind; held-out fixtures are not rejudged here. */
  fixtures: { dev: readonly LoadedFixture[]; negative: readonly LoadedFixture[] }
  judgePromptSha256: string
  log?: (line: string) => void
}

export interface RejudgeRow {
  run_id: string
  prior_outcome: string
  verdict: 'pass' | 'fail' | 'judge_error' | 'skipped'
  reason?: string
  judge_json_sha256?: string
}

/**
 * Which runs would have reached the judge originally: positive fixtures that completed
 * and passed the deterministic checks. Everything else is skipped with a reason.
 */
export function skipReason(m: RunManifest, hasStdout: boolean): string | undefined {
  if (m.fixture.kind === 'negative') return 'negative fixture (never judged)'
  if (m.fixture.kind === 'heldout') return 'held-out fixture (not rejudged by this command)'
  if (m.status !== 'completed') return `status ${m.status}`
  if (m.check_failures.length) return 'failed a deterministic check (never reached the judge)'
  if (!hasStdout) return 'no stdout.jsonl retained'
  return undefined
}

export async function rejudgeCampaign(input: RejudgeInput): Promise<RejudgeRow[]> {
  const rows: RejudgeRow[] = []
  for (const run of loadCampaignRuns(input.campaignDir)) {
    const { manifest } = run
    const prior = manifest.outcome ?? manifest.status
    const answer = finalAnswerOf(run.dir)
    const skip = skipReason(manifest, answer !== undefined)
    if (skip) {
      rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: 'skipped', reason: skip })
      continue
    }
    const fixture = (manifest.fixture.kind === 'dev' ? input.fixtures.dev : input.fixtures.negative).find((f) => f.id === manifest.fixture.id)
    if (!fixture || fixture.hash !== manifest.fixture.hash) {
      rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: 'skipped', reason: 'fixture missing or changed since the run' })
      continue
    }
    let recordJson: string[] = []
    if (manifest.condition === 'skill' && manifest.records.length) {
      const raw = readIfExists(join(run.dir, 'records.json'))
      if (raw === undefined) {
        rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: 'skipped', reason: 'record contents not retained' })
        continue
      }
      recordJson = (JSON.parse(raw) as { content: string }[]).map((r) => r.content)
    }
    const verdict = await input.judge({ method: manifest.method, condition: manifest.condition, fixture: { id: fixture.id, kind: manifest.fixture.kind, text: fixture.text, hash: fixture.hash }, finalAnswer: answer!, recordJson })
    const ref = verdict.evidence ? writeJudgeRecord(run.dir, verdict.evidence) : undefined
    rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: verdict.verdict, ...(ref ? { judge_json_sha256: ref.sha256 } : {}) })
    input.log?.(`${manifest.run_id}: ${prior} → ${verdict.verdict}`)
  }
  const summary = { judge_prompt_sha256: input.judgePromptSha256, runs: rows }
  const text = `${JSON.stringify(summary, null, 2)}\n`
  writeFileSync(join(input.campaignDir, 'rejudge-summary.json'), text, { mode: 0o600 })
  return rows
}
