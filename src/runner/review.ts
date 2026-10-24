/**
 * Human review sheets and rejudging for a finished campaign.
 *
 * - `renderReviewSheets`: a blind sheet (`review.md`: fixture prompt, expected-answer notes, final answer, record, an
 *   unmarked scoring table) and a key (`review-key.md`: the judge's verdicts and quotes). Local only: both quote agent
 *   answers, so they live next to the run artifacts (gitignored, or under the state root).
 * - `reconcileCampaign`: reads the marked sheet against the key and writes `human-review.json`.
 * - `rejudgeCampaign`: re-runs the judge over retained answers (judge calls only, no agent
 *   reruns) and writes `judge.json` per run. Manifests and outcomes are never changed; a
 *   `rejudge-summary.json` beside them lists the prior outcome next to the new verdict.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { allAssistantText, analyzeEvents, finalAnswerText, parseEvents } from './events'
import { type HumanReview, reconcile } from './human-review'
import { type JudgeCriterion, parseRubric, type RubricDeclarations } from './judge'
import { type JudgeRecord, readJudgeRecord, writeJudgeRecord } from './judge-record'
import { type CampaignRun, loadCampaignRuns, type RunManifest } from './manifest'
import type { LoadedFixture } from './prereg'
import type { JudgeHook } from './run'

const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

/**
 * The final answer from the run's `stdout.jsonl`, for the review card. When the rubric declares `expectation: true`, only the text
 * after the last tool call (the result excerpt, and the segment the word limit counts). Without a declaration it returns all
 * assistant text joined with '' (the same as `judgedAnswerOf` in that case).
 */
export function finalAnswerOf(runDir: string, declarations?: RubricDeclarations): string | undefined {
  const stdout = readIfExists(join(runDir, 'stdout.jsonl'))
  if (stdout === undefined) return undefined
  return declarations?.expectation ? finalAnswerText(parseEvents(stdout).events) : analyzeEvents(stdout).assistantText
}

/**
 * What the judge reads as ANSWER: every assistant `text` part joined with nothing, or, under `expectation: true`, joined with `\n`
 * (narration before a tool call included, so a tangent developed there is graded). Mirrors the answer selection in `run.ts`.
 */
export function judgedAnswerOf(runDir: string, declarations?: RubricDeclarations): string | undefined {
  const stdout = readIfExists(join(runDir, 'stdout.jsonl'))
  if (stdout === undefined) return undefined
  return declarations?.expectation ? allAssistantText(parseEvents(stdout).events) : analyzeEvents(stdout).assistantText
}

// ── review sheets ──────────────────────────────────────────────────────────

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

/** What the reviewer scores in each row; `eval review --reconcile` parses `human: pass` or `human: fail` from the last cell. */
export const HUMAN_CELL_BLANK = 'human: pass/fail'
export const NOTE_LINE = 'note:'

/** Fixture prompts at least this long are collapsed under `<details>`. */
const LONG_FIXTURE_CHARS = 600

export const RECORD_FIELDS: readonly (readonly [string, string])[] = [
  ['schema_version, helper_version', 'contract and bundle versions, stamped by the helper'],
  ['method, method_version', 'which method wrote the record'],
  ['objective', 'the decision or question the method worked on'],
  ['evidence', 'what the input shows (quoted facts; for synthesis, one entry per perspective)'],
  ['assumptions', 'premises and constraints, claimed or shared'],
  ['alternatives', 'options compared, the dissenting one included'],
  ['findings', 'what survived the checks, including the dependence or flip result'],
  ['next_action', 'the single next step'],
  ['reopen_condition', 'an observable event that should reopen the decision'],
  ['execution_mode', '`direct`, `sequential`, `delegated`, or `unrecorded`'],
  ['status', 'where the decision stands (for example `recommended`)'],
]

export function legend(method: string, campaignId: string, judgeCriteria: readonly string[], shown: number, omitted: number): string[] {
  return [
    `# Review sheet: ${campaignId}`,
    '',
    `Method ${method}. ${shown} judged runs${omitted ? ` (${omitted} runs never reached the judge and are not shown)` : ''}. Local only: this file quotes agent answers. The judge's verdicts are **not** here; they are in \`review-key.md\` (same block ids). Do not open it until you have marked every block.`,
    '',
    '## How to read this sheet',
    '',
    `- **Record.** Skill-condition runs also write a structured record by running a helper. It is a JSON object. Fields: ${RECORD_FIELDS.map(([f, d]) => `\`${f}\` (${d})`).join('; ')}. Baseline runs have no skill and no record.`,
    '- **What the judge scored.** The judge read the fixture prompt, the final answer, and the record (when there is one) together. Judge against the same material.',
    `- **What you score.** Only the ${judgeCriteria.length} judge criteria (${judgeCriteria.join(', ')}), one row each. Mechanical criteria (marked \`m\` in the rubric) are checked by code and are not scored here. Replace \`${HUMAN_CELL_BLANK}\` in the last cell with \`human: pass\` or \`human: fail\`; leave a row untouched if you cannot decide. Put anything else on the \`${NOTE_LINE}\` line.`,
    `- **Run outcome.** A run passes if and only if all ${judgeCriteria.length} criteria pass.`,
    '- **Expected-answer notes** (family, probes, pass and fail sketch) are shown once per fixture, at its first block. They describe what the fixture is designed to probe; the criteria and anchors decide, not the fixture author\'s preferred option.',
    '',
  ]
}

export interface FixtureContext {
  /** The prompt the agent received, verbatim; `undefined` when it is no longer available. */
  prompt?: string
  /** Family, probes, and pass/fail sketch for the fixture; `undefined` when none exists. */
  expected?: string
}

/** The annex section `#### <id>` of a rubric (dev and negative fixtures), without its heading. */
export function annexSection(rubric: string, id: string): string | undefined {
  const lines = rubric.split('\n')
  const start = lines.findIndex((l) => l.trim() === `#### ${id}`)
  if (start === -1) return undefined
  const end = lines.findIndex((l, i) => i > start && /^#{1,4} /.test(l))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

export interface ReviewOptions {
  /** Where held-out fixtures and their `*.expected.txt` sidecars live. */
  heldoutDir?: string
}

function fixtureContext(repoRoot: string, method: string, kind: string, id: string, rubric: string, options: ReviewOptions): FixtureContext {
  if (kind === 'heldout') {
    const dir = options.heldoutDir
    return {
      prompt: dir ? readIfExists(join(dir, `${id}.md`)) : undefined,
      expected: dir ? readIfExists(join(dir, `${id}.expected.txt`))?.trim() : undefined,
    }
  }
  return { prompt: readIfExists(join(repoRoot, 'evals', method, 'fixtures', kind, `${id}.md`)), expected: annexSection(rubric, id) }
}

export function renderReviewBlock(run: CampaignRun, answer: string | undefined, records: readonly string[], criteria: readonly { id: string; anchors: Anchors }[], context: FixtureContext, showExpected: boolean): string {
  const { manifest } = run
  const lines: string[] = [`## ${manifest.run_id}`, '', `- fixture: ${manifest.fixture.id} (${manifest.fixture.kind})`, `- condition: ${manifest.condition}`, '']
  if (context.prompt === undefined) {
    lines.push('**Fixture prompt**: _not available_', '')
  } else {
    const body = fenced(context.prompt.trimEnd())
    lines.push(
      ...(context.prompt.length >= LONG_FIXTURE_CHARS
        ? [`<details><summary>Fixture prompt (${context.prompt.length} chars)</summary>`, '', body, '', '</details>', '']
        : ['**Fixture prompt**', '', body, '']),
    )
  }
  if (showExpected) {
    lines.push(
      ...(context.expected === undefined
        ? ['**Expected-answer notes**: _none for this fixture_', '']
        : ['<details open><summary>Expected-answer notes (first block of this fixture)</summary>', '', fenced(context.expected), '', '</details>', '']),
    )
  }
  lines.push('**Final answer**', '', answer === undefined ? '_no stdout captured_' : answer.trim() === '' ? '_empty_' : fenced(answer.trimEnd()), '')
  for (const r of records) lines.push('**Record**', '', fenced(r.trimEnd()), '')
  lines.push('| criterion | pass anchor | fail anchor | human |', '| --- | --- | --- | --- |')
  for (const c of criteria) lines.push(`| ${c.id} | ${cell(c.anchors.pass)} | ${cell(c.anchors.fail)} | ${HUMAN_CELL_BLANK} |`)
  lines.push('', NOTE_LINE, '')
  return lines.join('\n')
}

export function renderKeyBlock(run: CampaignRun, judge: JudgeRecord): string {
  const { manifest } = run
  const lines = [
    `## ${manifest.run_id}`,
    '',
    `- fixture: ${manifest.fixture.id} (${manifest.fixture.kind})`,
    `- condition: ${manifest.condition}`,
    `- recorded outcome: ${manifest.outcome ?? manifest.status}${manifest.reasons.length ? ` (${manifest.reasons.join(', ')})` : ''}`,
    `- judge: ${judge.model_pinned}; returned ${judge.model_returned.join(', ') || 'none'}; ${judge.attempts} attempt${judge.attempts === 1 ? '' : 's'}${judge.error ? `; error: ${judge.error}` : ''}`,
    '',
  ]
  if (judge.criteria.length) {
    lines.push('| criterion | judge | quotes |', '| --- | --- | --- |')
    for (const c of judge.criteria) lines.push(`| ${c.id} | ${c.verdict} | ${cell(c.quotes.map((q) => `"${q}"`).join(' … '))} |`)
  } else {
    lines.push('_no per-criterion verdicts stored (judge_error)_')
  }
  lines.push('')
  return lines.join('\n')
}

export interface ReviewSheets {
  review: string
  key: string
  shown: number
  omitted: number
}

/**
 * The blind sheet (`review.md`) and its key (`review-key.md`). Only runs with a stored judge verdict get a block: a run
 * that failed a deterministic check never reached the judge, so there is nothing for a human to compare. Block ids are
 * the run ids, identical in both files.
 */
export function renderReviewSheets(campaignDir: string, repoRoot: string, options: ReviewOptions = {}): ReviewSheets {
  const runs = loadCampaignRuns(campaignDir)
  if (runs.length === 0) throw new Error(`no run manifests in ${campaignDir}`)
  const method = runs[0]!.manifest.method
  const campaignId = runs[0]!.manifest.campaign_id
  const rubric = readFileSync(join(repoRoot, 'evals', method, 'rubric.md'), 'utf8')
  const spec = parseRubric(rubric)
  const anchors = rubricAnchors(spec.criteria)
  const criteria = spec.criteria.map((c) => ({ id: c.id, anchors: anchors.get(c.id)! }))

  const judged = runs.flatMap((run) => {
    const raw = readIfExists(join(run.dir, 'judge.json'))
    return raw === undefined ? [] : [{ run, judge: readJudgeRecord(raw) }]
  })
  const seen = new Set<string>()
  const reviewBlocks: string[] = []
  const keyBlocks: string[] = []
  for (const { run, judge } of judged) {
    const key = `${run.manifest.fixture.kind}/${run.manifest.fixture.id}`
    const kept = readIfExists(join(run.dir, 'records.json'))
    const records = kept === undefined ? [] : (JSON.parse(kept) as { content: string }[]).map((r) => r.content)
    const context = fixtureContext(repoRoot, method, run.manifest.fixture.kind, run.manifest.fixture.id, rubric, options)
    reviewBlocks.push(renderReviewBlock(run, finalAnswerOf(run.dir, spec.declarations), records, criteria, context, !seen.has(key)))
    seen.add(key)
    keyBlocks.push(renderKeyBlock(run, judge))
  }
  const omitted = runs.length - judged.length
  const ids = criteria.map((c) => c.id)
  return {
    review: `${legend(method, campaignId, ids, judged.length, omitted).join('\n')}\n${reviewBlocks.join('\n')}`,
    key: [`# Review key: ${campaignId}`, '', 'Judge verdicts and quotes for `review.md`. Open after marking. `eval review --reconcile` reads this file.', '', ...keyBlocks].join('\n'),
    shown: judged.length,
    omitted,
  }
}

export function writeReview(campaignDir: string, repoRoot: string, options: ReviewOptions = {}): { review: string; key: string } {
  const sheets = renderReviewSheets(campaignDir, repoRoot, options)
  const review = join(campaignDir, 'review.md')
  const key = join(campaignDir, 'review-key.md')
  writeFileSync(review, sheets.review, { mode: 0o600 })
  writeFileSync(key, sheets.key, { mode: 0o600 })
  return { review, key }
}

export const HUMAN_REVIEW_FILE = 'human-review.json'

/** Reads the marked-up sheet and the key from a campaign dir and writes `human-review.json` next to them. */
export function reconcileCampaign(campaignDir: string, agreementFloor: number): HumanReview {
  const reviewPath = join(campaignDir, 'review.md')
  const keyPath = join(campaignDir, 'review-key.md')
  if (!existsSync(reviewPath) || !existsSync(keyPath)) throw new Error(`need review.md and review-key.md in ${campaignDir}; run \`eval review --campaign …\` first`)
  const runs = loadCampaignRuns(campaignDir)
  if (runs.length === 0) throw new Error(`no run manifests in ${campaignDir}`)
  const review = reconcile({ reviewText: readFileSync(reviewPath, 'utf8'), keyText: readFileSync(keyPath, 'utf8'), campaignId: runs[0]!.manifest.campaign_id, method: runs[0]!.manifest.method, agreementFloor })
  writeFileSync(join(campaignDir, HUMAN_REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 })
  return review
}

// ── rejudge ────────────────────────────────────────────────────────────────

export interface RejudgeInput {
  campaignDir: string
  judge: JudgeHook
  /** Verified, already-hashed fixtures by kind; held-out fixtures are not rejudged here. */
  fixtures: { dev: readonly LoadedFixture[]; negative: readonly LoadedFixture[] }
  /** The rubric's declarations: which text counts as the answer. Absent: all text. */
  declarations?: RubricDeclarations
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
  if (m.reasons.includes('answer_empty')) return 'empty final answer (never reached the judge)'
  if (!hasStdout) return 'no stdout.jsonl retained'
  return undefined
}

export async function rejudgeCampaign(input: RejudgeInput): Promise<RejudgeRow[]> {
  const rows: RejudgeRow[] = []
  for (const run of loadCampaignRuns(input.campaignDir)) {
    const { manifest } = run
    const prior = manifest.outcome ?? manifest.status
    const answer = judgedAnswerOf(run.dir, input.declarations)
    // Under the declaration an empty final segment never reached the judge, whatever narration came before it.
    const emptyFinal = input.declarations?.expectation === true && answer !== undefined && (finalAnswerOf(run.dir, input.declarations) ?? '').trim() === ''
    const skip = emptyFinal ? 'empty final answer (never reached the judge)' : skipReason(manifest, answer !== undefined)
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
    const verdict = await input.judge({ method: manifest.method, condition: manifest.condition, fixture: { id: fixture.id, kind: manifest.fixture.kind, text: fixture.text, hash: fixture.hash, ...(fixture.expectation ? { expectation: fixture.expectation } : {}) }, finalAnswer: answer!, recordJson })
    if (verdict.verdict === 'infra_error') {
      rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: 'skipped', reason: `judge unreachable (${verdict.code}); no verdict recorded` })
      input.log?.(`${manifest.run_id}: ${prior} → judge unreachable (${verdict.code})`)
      continue
    }
    const ref = verdict.evidence ? writeJudgeRecord(run.dir, verdict.evidence) : undefined
    rows.push({ run_id: manifest.run_id, prior_outcome: prior, verdict: verdict.verdict, ...(ref ? { judge_json_sha256: ref.sha256 } : {}) })
    input.log?.(`${manifest.run_id}: ${prior} → ${verdict.verdict}`)
  }
  const summary = { judge_prompt_sha256: input.judgePromptSha256, runs: rows }
  const text = `${JSON.stringify(summary, null, 2)}\n`
  writeFileSync(join(input.campaignDir, 'rejudge-summary.json'), text, { mode: 0o600 })
  return rows
}
