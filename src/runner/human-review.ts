/**
 * Human review of judge verdicts: parse a marked-up blind `review.md`, compare it with
 * `review-key.md`, and compute agreement, run-outcome flips, and a recomputed verdict.
 *
 * `human-review.json` holds run ids, criterion ids, and counts only (no answers, quotes, or
 * notes), so the GREEN report may project it. Pure functions here; file IO lives in
 * `review.ts` and `cli.ts`.
 */

export type Verdict = 'pass' | 'fail'

export const HUMAN_REVIEW_SCHEMA_VERSION = 1 as const

/** One judged run as the key file records it. */
export interface KeyRun {
  run_id: string
  fixture_id: string
  fixture_kind: string
  condition: string
  /** criterion id → the judge's verdict. */
  judge: Record<string, Verdict>
}

export interface CriterionAgreement {
  /** Runs where both a human mark and a judge verdict exist for this criterion. */
  n: number
  agree: number
  rate: number
  /** Cohen's kappa; only when both labels occur for both raters. */
  kappa?: number
  /** Raw agreement below the prereg floor: the criterion is advisory, not gating. */
  demoted: boolean
}

export interface ReviewedRun {
  run_id: string
  fixture_id: string
  fixture_kind: string
  condition: string
  /** The judge's run outcome: pass iff every criterion passed. */
  judge_outcome: Verdict
  /** The human's run outcome (every criterion marked): pass iff every criterion passed; `null` when marks are missing. */
  human_outcome: Verdict | null
  /** Criteria where human and judge differ. */
  disagreements: string[]
  /** Outcome after demotion: a human mark replaces the judge's where present, and demoted criteria are ignored. */
  effective_outcome: Verdict
}

export interface HumanReview {
  schema_version: typeof HUMAN_REVIEW_SCHEMA_VERSION
  campaign_id: string
  method: string
  agreement_floor: number
  judged_runs: number
  /** Runs whose every criterion carries a human mark. */
  reviewed_runs: number
  criteria: Record<string, CriterionAgreement>
  demoted_criteria: string[]
  runs: ReviewedRun[]
  /** Reviewed runs where the human outcome differs from the judge outcome. */
  flipped_runs: string[]
}

// ── parsing ────────────────────────────────────────────────────────────────

const CRITERION_ID = '[A-Z]{2}\\d+'

/** Splits `## <run-id>` blocks: run id → block text. */
function blocksOf(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = text.split(/^## /m).slice(1)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const id = (nl === -1 ? part : part.slice(0, nl)).trim()
    out.set(id, nl === -1 ? '' : part.slice(nl + 1))
  }
  return out
}

/** `| SY1 | … | human: pass |` → SY1 → pass. Unmarked rows (`human: pass/fail`, blank) are absent. */
export function parseHumanMarks(reviewText: string): Map<string, Map<string, Verdict>> {
  const out = new Map<string, Map<string, Verdict>>()
  const row = new RegExp(`^\\|\\s*(${CRITERION_ID})\\s*\\|.*\\|\\s*human:\\s*(pass|fail)\\s*\\|\\s*$`, 'i')
  for (const [id, block] of blocksOf(reviewText)) {
    const marks = new Map<string, Verdict>()
    for (const line of block.split('\n')) {
      const m = row.exec(line)
      if (m) marks.set(m[1]!, m[2]!.toLowerCase() as Verdict)
    }
    out.set(id, marks)
  }
  return out
}

/** Reads the machine-written key: header lines plus `| SY1 | pass | … |` rows per block. */
export function parseKey(keyText: string): KeyRun[] {
  const runs: KeyRun[] = []
  const row = new RegExp(`^\\|\\s*(${CRITERION_ID})\\s*\\|\\s*(pass|fail)\\s*\\|`)
  for (const [id, block] of blocksOf(keyText)) {
    const fixture = /^- fixture: (\S+) \((\w+)\)$/m.exec(block)
    const condition = /^- condition: (\w+)$/m.exec(block)?.[1]
    if (!fixture || !condition) continue
    const judge: Record<string, Verdict> = {}
    for (const line of block.split('\n')) {
      const m = row.exec(line)
      if (m) judge[m[1]!] = m[2] as Verdict
    }
    if (Object.keys(judge).length === 0) continue
    runs.push({ run_id: id, fixture_id: fixture[1]!, fixture_kind: fixture[2]!, condition, judge })
  }
  return runs
}

// ── statistics ─────────────────────────────────────────────────────────────

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

/** Cohen's kappa for two binary raters; `undefined` unless both labels occur for both raters (it is undefined or degenerate otherwise). */
export function cohenKappa(pairs: readonly (readonly [Verdict, Verdict])[]): number | undefined {
  const n = pairs.length
  if (n === 0) return undefined
  const count = (pick: (p: readonly [Verdict, Verdict]) => Verdict, v: Verdict) => pairs.filter((p) => pick(p) === v).length
  const aPass = count((p) => p[0], 'pass')
  const bPass = count((p) => p[1], 'pass')
  if (aPass === 0 || aPass === n || bPass === 0 || bPass === n) return undefined
  const observed = pairs.filter((p) => p[0] === p[1]).length / n
  const expected = (aPass / n) * (bPass / n) + ((n - aPass) / n) * ((n - bPass) / n)
  return expected === 1 ? undefined : round4((observed - expected) / (1 - expected))
}

export interface ReconcileInput {
  reviewText: string
  keyText: string
  campaignId: string
  method: string
  /** Prereg `agreement_floor`. */
  agreementFloor: number
}

/** Compares the human marks with the key. Runs the human did not mark at all are counted as judged but not reviewed. */
export function reconcile(input: ReconcileInput): HumanReview {
  const marks = parseHumanMarks(input.reviewText)
  const keyRuns = parseKey(input.keyText)

  const pairsBy = new Map<string, [Verdict, Verdict][]>()
  for (const run of keyRuns) {
    const human = marks.get(run.run_id)
    if (!human) continue
    for (const [criterion, judge] of Object.entries(run.judge)) {
      const mark = human.get(criterion)
      if (mark) (pairsBy.get(criterion) ?? pairsBy.set(criterion, []).get(criterion)!).push([mark, judge])
    }
  }
  const criteria: Record<string, CriterionAgreement> = {}
  for (const id of [...pairsBy.keys()].sort()) {
    const pairs = pairsBy.get(id)!
    const agree = pairs.filter((p) => p[0] === p[1]).length
    const rate = round4(agree / pairs.length)
    const kappa = cohenKappa(pairs)
    criteria[id] = { n: pairs.length, agree, rate, ...(kappa === undefined ? {} : { kappa }), demoted: rate < input.agreementFloor }
  }
  const demoted = Object.keys(criteria).filter((id) => criteria[id]!.demoted)

  const runs: ReviewedRun[] = keyRuns.map((run) => {
    const human = marks.get(run.run_id) ?? new Map<string, Verdict>()
    const ids = Object.keys(run.judge)
    const complete = ids.every((id) => human.has(id))
    const judgeOutcome: Verdict = ids.every((id) => run.judge[id] === 'pass') ? 'pass' : 'fail'
    const effective: Verdict = ids.filter((id) => !demoted.includes(id)).every((id) => (human.get(id) ?? run.judge[id]) === 'pass') ? 'pass' : 'fail'
    return {
      run_id: run.run_id,
      fixture_id: run.fixture_id,
      fixture_kind: run.fixture_kind,
      condition: run.condition,
      judge_outcome: judgeOutcome,
      human_outcome: complete ? (ids.every((id) => human.get(id) === 'pass') ? 'pass' : 'fail') : null,
      disagreements: ids.filter((id) => human.has(id) && human.get(id) !== run.judge[id]),
      effective_outcome: effective,
    }
  })
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    campaign_id: input.campaignId,
    method: input.method,
    agreement_floor: input.agreementFloor,
    judged_runs: runs.length,
    reviewed_runs: runs.filter((r) => r.human_outcome !== null).length,
    criteria,
    demoted_criteria: demoted,
    runs,
    flipped_runs: runs.filter((r) => r.human_outcome !== null && r.human_outcome !== r.judge_outcome).map((r) => r.run_id),
  }
}

export function summarize(review: HumanReview): string[] {
  const lines = [`reviewed ${review.reviewed_runs} of ${review.judged_runs} judged runs (agreement floor ${review.agreement_floor})`]
  for (const [id, c] of Object.entries(review.criteria)) {
    lines.push(`  ${id}: agree ${c.agree}/${c.n} = ${c.rate}${c.kappa === undefined ? '' : ` · kappa ${c.kappa}`}${c.demoted ? ' · BELOW FLOOR → advisory' : ''}`)
  }
  lines.push(`run outcome flips: ${review.flipped_runs.length}${review.flipped_runs.length ? ` (${review.flipped_runs.join(', ')})` : ''}`)
  return lines
}

// ── the GREEN report's human_review block ──────────────────────────────────

export interface GreenBars {
  skill_pooled_pass_min: number
  skill_per_fixture_pass_min: number
  baseline_pooled_pass_max: number
}

export interface HumanReviewBlock {
  status: 'pending' | 'partial' | 'complete'
  judged_runs: number
  reviewed: number
  agreement?: Record<string, CriterionAgreement>
  flipped_runs?: string[]
  demoted_criteria?: string[]
  recomputed?: {
    skill_pooled_pass: number
    baseline_pooled_pass: number
    per_fixture_skill_pass: Record<string, number>
    checks: { skill_pooled: boolean; per_fixture_floor: boolean; baseline_ceiling: boolean }
    /** Machine checks that human review cannot change (negatives, dev regression, near-duplicate) stay as reported. */
    verdict: 'green' | 'green-miss'
  }
}

/**
 * Recomputes the held-out pass counts from the human marks (demoted criteria ignored, a human mark replacing the
 * judge's where present; runs never judged stay failures) and the verdict from the same bars. The three checks
 * the review cannot touch are taken from the machine report.
 */
export function humanReviewBlock(review: HumanReview, bars: GreenBars, fixedChecks: { negatives_silent: boolean; dev_regression: boolean; near_duplicate: boolean }, fixtureIds: readonly string[]): HumanReviewBlock {
  const heldout = review.runs.filter((r) => r.fixture_kind === 'heldout')
  const passes = (condition: string, fixture?: string) => heldout.filter((r) => r.condition === condition && r.effective_outcome === 'pass' && (fixture === undefined || r.fixture_id === fixture)).length
  const perFixture = Object.fromEntries(fixtureIds.map((id) => [id, passes('skill', id)]))
  const skill = passes('skill')
  const baseline = passes('baseline')
  const checks = {
    skill_pooled: skill >= bars.skill_pooled_pass_min,
    per_fixture_floor: Object.values(perFixture).every((n) => n >= bars.skill_per_fixture_pass_min),
    baseline_ceiling: baseline <= bars.baseline_pooled_pass_max,
  }
  const status = review.reviewed_runs === 0 ? 'pending' : review.reviewed_runs < review.judged_runs ? 'partial' : 'complete'
  return {
    status,
    judged_runs: review.judged_runs,
    reviewed: review.reviewed_runs,
    ...(review.reviewed_runs === 0
      ? {}
      : {
          agreement: review.criteria,
          flipped_runs: review.flipped_runs,
          demoted_criteria: review.demoted_criteria,
          recomputed: {
            skill_pooled_pass: skill,
            baseline_pooled_pass: baseline,
            per_fixture_skill_pass: perFixture,
            checks,
            verdict: Object.values({ ...checks, ...fixedChecks }).every(Boolean) ? ('green' as const) : ('green-miss' as const),
          },
        }),
  }
}
