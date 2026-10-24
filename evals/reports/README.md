# Eval reports

Files here are **allowlist projections** of local run artifacts. They hold counts, Wilson intervals, per-fixture `fail/total`, outcome-taxonomy tallies, verdict enums, hashes, model ids, the head SHA, and the prereg content hash. They never hold stdout, stderr, transcripts, judge quotes, paths, or environment. `src/runner/report.ts` validates every report against a closed schema before writing, and `src/runner/report.test.ts` re-validates the committed files. The raw artifacts stay under `evals/runs/` (gitignored); each report names the retained failures by `run_id` with the SHA-256 of the run's manifest and its `stdout.jsonl`.

Regenerate with `bun run eval report --method <m>` (newest `evals/runs/<m>-red-*` campaign, prereg re-enforced first).

## Reading `red.json`

- `prereg`: `content_hash` (sha256 of the RFC 8785 canonical form of `prereg.json`) the runs were enforced against, plus `epoch` and the rubric hash. `repo.head_sha` is the checkout that produced the report. Reports before 2026-10-24 were re-keyed from tag identifiers to content hashes: each carries the hash of its own epoch's prereg content (the `prereg.json` of that epoch, minus the removed `prev_epoch_closing_commit` field).
- `fixtures[]`: one entry per fixture.
  - `fail_over_total` is `fail/attempted`. `attempted` is `pass + fail`; `infra_error` and `non_isolated` runs are reported but are in no denominator. Timeouts, budget breaches, host crashes, and `judge_error` are FAILs.
  - `fail_rate_wilson95` is the 95% Wilson interval for the fail rate. At N=5, 5/5 is `[0.5655, 1]`: it rules out a true fail rate below about 57%, nothing more.
  - `meets_red_bar` (dev fixtures only): baseline fails at least `red_bar.min_baseline_fails_per_fixture` (4 of 5). Negatives are scored separately; for a baseline negative, `fail` means the run raised a false fire, and the number is context, not part of the bar.
  - `outcomes` splits the FAILs (`fail_judge_verdict`, `fail_check`, `fail_timeout`, `fail_budget`, `fail_host_crash`, `fail_judge_error`) and counts `infra_error` attempts and `non_isolated`. `taxonomy` folds the same counts into the prereg's taxonomy (`pass`, `fail`, `timeout->fail`, `budget->fail`, `judge_error->fail`, `infra_error`, `non_isolated`).
  - `criteria`: per judge criterion, how many runs passed it and how many failed it with a quoted passage (`fail_quoted`) versus the single word `absent` (`fail_absent`). A criterion that fails mostly with `absent` says the answer lacks the behaviour; one that fails with quotes says the judge found a near miss.
  - `fail_excluding_judge_error` repeats the count with `judge_error` runs removed from numerator and denominator. It exists because `judge_error` is a FAIL by the prereg and therefore pushes RED in the favourable direction.
  - `retained[]` lists each failed run with hashes only.
- `red`: `green_eligible` is true when at least `min_fixtures` (2) dev fixtures meet the bar. `sensitivity_excluding_judge_error` is the same decision without `judge_error` runs.
- `judge`: the judge prompt hash (one value means one prompt for the whole campaign), how many runs were judged, how many ended in `judge_error`, and the temperature the provider received.

## Epoch 2 RED results (2026-10-22)

Agent `opencode-go/beam-free`, judge `opencode-go/deepseek-v4.1-flash`, opencode-ai 1.19.4, authenticated access to the OpenCode Go gateway (credential passthrough, provider names recorded in every manifest). Prereg tags `prereg/counterfactual/2`, `prereg/synthesis/2`. 5 baseline runs per dev fixture, 5 per negative, sequential.

| Method | Dev fixtures at the RED bar | GREEN-eligible | `judge_error` | `infra_error` | `non_isolated` | Timeouts | Campaign wall-clock |
| --- | --- | --- | --- | --- | --- | --- | --- |
| counterfactual | 5 of 6 (`cf-d3-vendor-idempotency` fails 1/5, CI `[0.0362, 0.6245]`) | yes | 0 | 0 | 0 | 0 | 20.5 min |
| synthesis | 6 of 6 | yes | 0 | 0 | 0 | 0 | 17.6 min |

All baseline negatives passed 5/5 for both methods (no skill exists in the baseline, so no fire was possible; this is a harness sanity check, not evidence about a skill).

## What this does and does not show

1. **Caveat: the judge family is unverified.** The agent (`beam-free`, catalogue label `family: beam`) and the judge (`deepseek-v4.1-flash`, label `family: deepseek-flash`) have different labels, but `beam` is a stealth id and could share a base model with the judge. "Different family" is therefore not established, and self-preference or shared-bias effects cannot be ruled out. Both ids are served through OpenCode's gateway; neither is an independently documented model.
2. **No human review yet.** The plan's human spot-check of judge verdicts (every dev judgment within one criterion of the threshold, every held-out judgment) has not been done. Every RED verdict here is judge-only. Sanity checks: a strong hand-written answer passed all five criteria for each method (counterfactual in the runner README's judge probe; synthesis on `sy-d4-parser-vote`, one run, not retained), and for counterfactual a weak answer, with or without a planted injection, failed all five. That is evidence the judge can pass and can fail, not that it is calibrated on borderline answers.
3. **The failures are process-visibility failures, not wrong answers.** Baseline answers were typically one to three sentences. Many reached a sound conclusion (for example, naming the `node20` pin in `cf-d1`, or calling `docs/service-map.md` stale in `sy-d2`) but did not reconstruct each perspective, separate evidence from premises, state a hypothetical, or name a discriminating test, so the rubric's conjunction of five criteria failed. The rubric measures explicit process, as preregistered, and the RED bar is met on that definition. It does not show that the baseline decides worse. Whether a skill adds anything beyond making the answer longer is exactly what GREEN's held-out comparison, human review, and the "length is not merit" instruction have to test.
4. **0/30 baseline passes for synthesis is not a measurement of the skill's headroom.** With every baseline failing, the RED stage cannot tell a rubric that is hard to pass from one the judge cannot pass. The strong-answer check above is the only evidence it is passable.
5. **`cf-d3-vendor-idempotency` does not discriminate.** Four of five baselines passed it, so it contributes nothing to RED. It stays in the set (the dev set is fixed by the prereg) and is a candidate regression case.
6. **Throughput.** Both campaigns completed with no infra errors and no rate limit: about 25 s per run end to end (2292 s for 90 runs) (isolation check, agent run, judge call). The earlier unauthenticated free tier was unusable on this date ("Free usage limit reached"); see `evals/runner/README.md`.
7. **Cost note.** `deepseek-v4.1-flash` is listed at 0.15 / 0.6 per million input / output tokens, billed under the OpenCode Go credential. This is not the "no paid key" free tier; the owner authorized it for this epoch.

## Epoch 3 dev reads (2026-10-23)

Paid round, owner-authorized: agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, both through the owner's CLIProxyAPI (`gateways: ["cliproxy"]`), opencode-ai 1.19.4, prereg tags `prereg/counterfactual/3` and `prereg/synthesis/3` (bars, dev and negative fixtures, and rubric unchanged from epoch 2; skills unchanged). Skill condition on dev and negative fixtures, N=5, sequential. `green-dev.json` carries the new `load_rate` metric (not a bar): the share of attempted runs in which the skill text reached the model.

| Method | Dev fixtures at the bar (≥4/5) | Dev passes | Load rate (dev) | Negative false fires | `judge_error` | `infra_error` | Campaign wall-clock | `passes_dev_bar` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| counterfactual | 5 of 6 (`cf-d2-ci-reach` 3/5) | 26 of 30 | 1.0 (30 of 30, all via the skill tool) | 0 of 15 | 0 | 0 | 19.1 min | no |
| synthesis | 5 of 6 (`sy-d6-log-redaction` 1/5) | 26 of 30 | 1.0 (30 of 30, all via the skill tool) | 0 of 15 | 0 | 0 | 24.1 min | no |

What changed against epoch 2: the load rate is no longer the problem (1.0 for both methods). What fails now is different per method. Counterfactual: all four failing runs loaded the skill and produced a judged-passable answer but never wrote the record (`helper_not_invoked` or `record_missing`; in one the helper call errored), so these are mechanical-check fails, not judge fails. Synthesis: `sy-d6-log-redaction` fails SY3 (a concrete dependence path) in 4 of 5 runs while SY1, SY2, SY4, and SY5 pass; the answers call the two reviewers' claims independent arguments. Both reflect the same skill text that was in place in epoch 2, so this is a model comparison on an unchanged skill, not an iteration.

The dev bar is not met by either method, so no one-shot GREEN read was made: the synthesis epoch-3 held-out set (`sy-h5` to `sy-h8`) and the counterfactual held-out set are unread. Human review of the judge verdicts has not been done. Agent cost reported by the provider (not the judge): about $0.048 (counterfactual) and $0.054 (synthesis) for 45 runs each; the judge's cost is not recorded.

The epoch-2 synthesis GREEN read is preserved as `synthesis/green.epoch2.json` (its held-out set is burned).

## Epoch 3 re-run after one skill edit per method (2026-10-23)

Same models and gateway as above (`openai/gpt-6-luna` agent, `anthropic/claude-haiku-5-5` judge, `gateways: ["cliproxy"]`), same prereg tags, bars, fixtures, and rubric. Skill text edited once per method (log in `authoring.md`). Dev reads first, N=5, skill condition:

| Method | Skill commit | Per dev fixture | Fire basis (skill tool / direct read / none) | Load rate | Negative false fires | `passes_dev_bar` | GREEN read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| counterfactual | `7a3bf22` | d1–d5 5/5, **d6 3/5** | 30 / 0 / 0 | 1.0 | 0 of 15 | no | not made |
| synthesis | `8079747` | d1–d6 5/5 | 30 / 0 / 0 | 1.0 | 0 of 15 | yes | made once, below |

Counterfactual: the record-step edit worked (a record was written in 30 of 30 positive runs, against 26 of 30 before), but `cf-d6-autoscaler-removal` fell from 5/5 to 3/5 on CF5 judge fails, so the held-out set stays unread.

### Synthesis epoch-3 GREEN read (one shot, `prereg/synthesis/3`)

Both conditions on the four new held-out fixtures, N=5, plus the three negatives under the skill condition. Prereg check, near-duplicate gate (pass), and held-out hash check ran before launch. Artifacts and `review.md` live under the state root (`metacogs/runs/synthesis-green-2026-10-23T04-11-00-725Z/`), never in the repo.

| Held-out fixture | Skill | Baseline | Delta (Newcombe 95%) | Skill load rate |
| --- | --- | --- | --- | --- |
| sy-h5 | 5/5 | 2/5 | 0.6 [0.030, 0.882] | 1.0 |
| sy-h6 | 4/5 | 1/5 | 0.6 [-0.000, 0.832] | 0.8 |
| sy-h7 | 5/5 | 0/5 | 1.0 [0.386, 1.0] | 1.0 |
| sy-h8 | 5/5 | 0/5 | 1.0 [0.386, 1.0] | 1.0 |
| **Pooled** | **19/20** (Wilson [0.764, 0.991]) | **3/20** ([0.052, 0.360]) | **0.8 [0.519, 0.906]** | 0.95 |

Bars: skill pooled ≥17/20 yes (19), per-fixture floor ≥3/5 yes (min 4), baseline ≤10/20 yes (3; `held_out_too_easy: false`), negatives silent yes (0 of 15 false fires), dev regression yes, near-duplicate yes. **Machine verdict: `green`.** Taxonomy over the 55 runs: 37 pass, 18 fail, 0 timeout, 0 budget, 0 `judge_error`, 0 `infra_error`, 0 `non_isolated`. The one skill-condition failure (`sy-h6`, run 2) never loaded the skill (`skill_not_loaded`, no helper call, no record). Baseline failures were judge failures, most often SY1 (perspectives not restated: 16 of 20 baseline runs), then SY4 and SY5 on sy-h7 and SY5/SY2 on sy-h8. Burn status: the epoch-3 held-out set is **burned** (one-shot read made); any `skills/synthesis/` edit under this epoch voids it, and a retry needs a new epoch and a new set.

What this does not show. Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green. The judge is one model (`claude-haiku-5-5`) with no temperature parameter sent, so determinism is unproven; the `sy-h6` delta interval touches zero at its lower bound. The baseline-versus-skill gap is again largely process visibility (the skill makes the agent write out perspectives, dependence, and a conclusion), which the rubric rewards as preregistered. The claim is limited to this (host version, models) pair on this fixture family.

### Counterfactual dev re-run without an edit (2026-10-23)

Same skill text as `7a3bf22`, N=5 on dev, skill condition: d1–d5 5/5, **d6 3/5** (CF5 judge fails on runs 2 and 3), fire basis 30 / 0 / 0, load rate 1.0, a record in 30 of 30 positive runs, 0 of 15 negative false fires; `passes_dev_bar` is false. No GREEN read was made. Reading the full answers and re-judging them (judge calls only) showed the two failures are judge variance rather than the record step displacing the flip test; details in `counterfactual/authoring.md`. The counterfactual held-out set is unread.

## Epoch 5 counterfactual: dev bar as a prereg field, dev run, and GREEN read (2026-10-23)

Same paid round as epoch 3 (agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, `gateways: ["cliproxy"]`, opencode-ai 1.19.4), tag `prereg/counterfactual/5`. Epoch 4 (`prereg/counterfactual/4`) is superseded without a held-out read: it declared a pooled dev bar in the prereg notes only, so the runner still scored the dev campaign per fixture (27 of 30 pooled with `cf-d6-autoscaler-removal` at 3/5 read `passes_dev_bar: false`) and the GREEN report's `dev_regression` check could not have been true. Epoch 5 adds an optional `dev_bar` prereg field (`{pooled_min_passes, per_fixture_min_passes}`); the runner reads it from the tagged prereg, and `green-dev.json` and `green.json` (`dev_regression.dev_bar`) record the bar they used (`kind: "pooled"` or `"per_fixture"`; reports from before the field carry no `kind`). Skill text, fixtures, rubric, GREEN bars, and the held-out hashes are unchanged.

| Stage | Result |
| --- | --- |
| Dev (pooled bar 24 of 30, floor 2 of 5, negatives 0) | **29 of 30** (d1 to d4 and d6 5/5, d5 4/5 with one `host_crash`); load rate 1.0 (30 of 30 via the skill tool); 0 of 15 negative false fires; `passes_dev_bar` true. 22.0 min. |
| GREEN, held-out cf-h1 to cf-h4 | skill 18/20 (Wilson [0.699, 0.972]), baseline 1/20 ([0.009, 0.236]); delta 0.85, Newcombe 95% [0.576, 0.933]; per-fixture skill 5, 3, 5, 5 (floor 3). 0 of 15 negative false fires; dev regression, near-duplicate gate, and baseline ceiling pass. 55 runs, 24.0 min. |
| Machine verdict | `green` |

Taxonomy over the 55 GREEN runs: 34 pass, 19 fail (2 `judge_error`), 0 timeout, 0 budget, 0 `infra_error`, 0 `non_isolated`. Both skill-condition misses (cf-h2, runs 1 and 5) are `judge_error` (`invalid_ungrounded_quote`), which counts as FAIL; they are not judge fail verdicts. Agent cost reported by the provider: about $0.049 (dev) and $0.050 (GREEN); the judge's cost is not recorded.

What this does not show. Human review: 38/38 held-out judgments reviewed; CF2–CF4 above the 0.8 agreement floor; CF1 and CF5 below floor and demoted to advisory; recomputed verdict green. Three run outcomes flipped on review (recomputed skill 17/20, baseline 0/20). The judge is one model with no temperature parameter sent, so determinism is unproven; the earlier `cf-d6` dev reads flipped on identical answers (see `counterfactual/authoring.md`). The baseline-versus-skill gap is again process visibility: the baseline failed most often on CF4 and CF5 (a stated hypothetical and a flip test with a source), which the rubric rewards as preregistered. The dev bar changed between epochs 3 and 5 (per-fixture 4/5 to pooled 24 of 30) after the dev results of epochs 2 and 3 were seen; it is declared in the epoch-5 prereg before any epoch-5 run, but it was chosen with that data in view. The epoch-5 held-out set is **burned**; any `skills/counterfactual/` edit voids this read, and a retry needs a new epoch and a new set. The claim is limited to this (host version, models) pair on this fixture family.

