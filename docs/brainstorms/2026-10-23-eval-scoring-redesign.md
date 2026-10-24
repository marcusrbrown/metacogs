# Eval scoring redesign (v0.2 input)

Status: proposal. v0.1 ships as recorded; this changes what the harness scores, not the harness.

Trigger: the required human review of the synthesis held-out read (`evals/reports/synthesis/green.json`, `human_review`) found that only SY1 clears the 0.8 agreement floor. SY2–SY5 sit at 0.62–0.77 (κ 0.03–0.31) and 10 of 39 run outcomes flip under the human marks. The owner's verdict: the scoring system cannot be reviewed with confidence.

## A. Why the review is not confidently reviewable

The rubric asks the reviewer to enforce five broad reasoning-and-writing standards, not to check five observable facts. Careful reading cannot resolve a rule whose decision boundary is unspecified.

Binary labels hide judgment (`evals/synthesis/rubric.md`):

- SY1: "terms its proponent would accept" and "same fidelity" are fairness judgments.
- SY2 bundles evidence separation *per perspective*, identifying shared ground, and assessing its support. Is naming the decisive unsupported premise enough, or must every perspective be classified?
- SY3 bundles source dependence, shared constraints, and omitted blind spots — three problems under one label.
- SY4 asks whether evidence "genuinely discriminates" and uncertainty is "sufficiently visible".
- SY5 bundles appropriate confidence, rejecting consensus-as-evidence, change conditions, and next action. The pass anchor requires change conditions; the fail anchor never mentions their absence.

Every criterion must pass with no partial credit, so each ambiguity decides whole-run outcomes.

Disagreement blocks (campaign `synthesis-green-2026-10-23T04-11-00-725Z`, `review.md` / `review-key.md` in the state root) show different *interpretations*, not reviewer error:

| Block | What it exposes |
|---|---|
| 002 SY2 | Answer names the shared client-refresh assumption and the contradicting release notes. Judge pass, human fail. |
| 006 SY2 | Answer names the US scheduler's conflict with the EEA requirement. Judge pass, human fail. |
| 012 SY2/SY5 | Names the contradicted shared assumption, gives differentiated confidence and validation steps. Judge pass both, human fail both. |
| 016 SY2/SY5 | Says neither design complies, proposes changes and checks. Judge pass both, human fail both. |
| 008 SY5 | Moderate confidence and reopen conditions present; human note objects to where confidence is attached and to a recommendation inside `findings` — a record-category reading the anchor never states. |
| 026 SY5 | "Leading hypothesis", "likely", verification conditions satisfy the judge; human notes "missing confidence statement". Explicit labels vs ordinary uncertainty language is an unresolved boundary. |
| 035 SY5 | Separate moderate-low confidence in direction and high confidence against a guarantee; human finds it ambiguous. No operational rule resolves it. |

The sheet multiplies the ambiguity: 1,856 lines, ~37k words, 195 criterion decisions across 39 runs; each block combines fixture, answer, often a long JSON record, and five repeated anchor pairs; expected notes appear only at a fixture's first block (`src/runner/review.ts:143–167, 218–228`).

Evidence is unequal: skill answers get a second chance through the record (`src/runner/judge.ts:205–213, 485–496`) while the method says users never see the record (`skills/synthesis/SKILL.md:40`). The score is therefore not purely a measure of the delivered answer.

The system rewards visible procedure: the skill requires five labelled reply lines matching the five criteria, added because terse answers failed (`skills/synthesis/SKILL.md:40–46`, `evals/reports/synthesis/authoring.md:5–19`). Real behavior change, but strong coupling between prescribed presentation and scoring. Counterfactual's criteria ("observable truth condition", "test, source, result that changes the decision") are more concrete — a useful contrast, not a proven replacement.

Expected-answer sketches can anchor the human: the judge excludes the annex (`src/runner/judge.ts:87–90`), the human sees it, and some notes prescribe preferred options and stronger causal readings than the answer under review.

SY2's κ≈0 does not prove the criterion is unreviewable or the judge wrong; it shows this implementation never established a shared interpretation. Demotion does not repair validity: four criteria become advisory, SY1 is the only semantic gate, and the recomputed report stays green (`src/runner/human-review.ts:155–170`). That is the preregistered fallback, not confirmation of all five intended behaviors.

## B. What the eval is trying to prove

Checkable claim: *on these scenarios, loading the skill makes the agent catch the specific shared dependency or constraint that changes the defensible action more often than answering without it.*

The +0.80 delta (19/20 vs 3/20) shows improved performance on the process rubric. It does not show better decisions; baseline failures were mostly missing perspective restatements, not wrong conclusions (`evals/reports/README.md`). The requirements doc asked for explicit methods backed by evidence, with records establishing well-formedness and the rubric checking substance (`docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md`).

## C. Candidate redesigns

Times are planning estimates for one human.

### 1. One fixture, one falsifiable outcome

Reviewer reads the prompt, one predeclared acceptance statement, and the final answer; marks pass/fail; highlights support. Example: "Rejects both unchanged designs because their US scheduler handles EU identifiers." Paraphrase accepted; contradictory recommendation fails.

40 runs ≈ 45–75 min. Highest expected agreement of the three when dev examples fix the boundary. Proves success on the declared fixture-specific behavior; a narrow usefulness claim. Cannot prove full procedure execution or overall answer quality.

Runner: bind and hash one criterion per fixture; give it to judge and human alike; score final answers only; keep record validity a separate mechanical check; replace expected sketches with the acceptance statement plus boundary examples.

### 2. Blind pairwise preference

Reviewer sees the prompt and anonymised A/B final answers; picks A, B, or tie for "which would you use to make this decision", with one sentence why.

20 pairs ≈ 60–100 min. Moderate agreement; concrete errors agree, close calls on clarity or confidence do not. Proves the owner prefers one delivered answer; addresses usefulness directly. Cannot prove correctness or method execution; verbosity and recognisable skill formatting still bias preference.

Runner: pair outputs by fixture/repetition, randomise sides, hide condition and records, keep the mapping private; new judging path (`src/runner/judge.ts:229–258` is per-answer binary).

### 3. Two criteria, ten-block audit

Two questions: "identifies the fixture's decisive dependency/constraint?" and "makes a recommendation consistent with it?" Human calibrates on dev examples, then reviews ten preselected blocks covering both conditions and every fixture.

Judge scores all 40; human ≈ 35–55 min. Better agreement than today if wording is concrete; the recommendation criterion keeps interpretation. Proves two narrower behaviors with a limited judge audit. Cannot prove all 40 judgments are trustworthy. This is a policy change from the plan's 100%-review rule.

## D. Recommendation

Option 1. The primary score becomes one decision-relevant outcome per fixture, not a generic reasoning checklist. A single human should be able to explain every failure in one sentence. Add pairwise judging only if an overall-preference claim is actually needed.

Steps:

1. Pilot the contract on dev fixtures: per fixture, one acceptance statement, a terse passing answer, a polished failing answer. Reject any criterion that requires debating style or inferred intent. If baseline already succeeds, keep the fixture as regression coverage rather than manufacture a failure.
2. Separate answer value from operational compliance: judge and human see identical final-answer evidence; records stay machine-validated and inspectable but cannot rescue the score. One compact card per run.
3. Preregister a new epoch with fresh held-out fixtures and acceptance statements committed to custody together. Freeze scoring, review workload, and release rules before further skill tuning. Do not rescore the burned set.

The rubric is hashed into the prereg; editing it means a new epoch. v0.1 evidence stays as recorded.

## E. Keep from v0.1

- Isolation, replay manifests, provenance, held-out custody and read markers — change what they score, not the machinery.
- Mechanical applicability and record checks, separate from answer quality.
- The record contract; shape validation is not semantic certification.
- Judge containment: redaction, random delimiters, model checks, strict verdict parsing, quote verification (provenance, not justification).
- Blind human marking before the judge key is opened.
- Allowlisted public reports; private raw artifacts.

The harness is worth keeping. The scoring contract is what gets replaced.
