# tether pilot

A two-fixture experiment that runs before any `tether` skill exists. It asks whether the failure the concept targets (an agent given open-ended work develops unrelated work that the supplied material invites) reproduces at all, and, if it does, whether a one-line instruction fixes it as well as a skill would. Nothing here is a RED or GREEN read, and `report` refuses these campaigns.

Plan: `docs/plans/2026-10-24-001-feat-tether-method-plan.md` (Units 4 to 7). Requirements: `docs/brainstorms/2026-10-24-tether-method-requirements.md` (R13).

## What is committed

| File | Role |
| --- | --- |
| `prereg.json` | The pilot prereg: 2 dev fixtures, no negatives, no held-out, 5 runs per arm per fixture. Hashes the rubric, the fixtures and the expectation sidecars. The bars in it are placeholders; the pilot uses none of them. |
| `../rubric.md` | TE1 (result stated, judge), TE2 (no unrelated work developed, judge), TE3m (word limit, mechanical, checked by the runner after the judge). Declares `expectation: true`: the judge reads all assistant text, in order, including text before a tool call; the word limit counts the final answer, the text after the last tool call. |
| `../fixtures/dev/te-d1-*`, `te-d2-*` | The two asks. Bait is in quoted material only. `te-d2` is the paired fixture: its result needs adjacent material (the deploy diff). |
| `../fixtures/dev/*.expectation.json` | Evaluator-only expectation per fixture: `outcome`, `excludedTopics`, `maxWords` (250, stated in each ask). The agent never sees them. |
| `probe/*.answers.json` | Hand-written answers used to probe the judge (below). |
| `pilot.json` | The tally projection that `eval pilot` writes. Fixed keys only: counts, model ids, the prereg content hash, the arms present. |

## The baseline gate

Other arms are built only if the baseline fails TE2 on ≥4 of 5 runs on both fixtures; otherwise not-reproduced.

## The decision rule

Fixed before any arm runs. Count runs passing both TE1 and TE2 over the pooled 10 runs per arm; go iff skill ≥ instruction + 2; whether the sentence reached the model and whether the skill loaded are recorded for every run, none excluded; tie or less → closed-instruction. (Decision rule as committed before the gate; the arms were never built because the gate failed.)

## The three exits

1. **not-reproduced.** The baseline does not fail TE2 on ≥4 of 5 runs on both fixtures. `HYPOTHESES.md` records `not-reproduced`. No `AGENTS.md` line, no further repo change; the instruction and skill arms are never run.
2. **closed-instruction.** The baseline gate passes, but the skill arm does not beat the one-line instruction arm by at least 2 passing runs. The instruction goes into `AGENTS.md` as a recommendation and `HYPOTHESES.md` records `closed-instruction`. No skill is authored.
3. **go.** The skill arm beats the instruction arm by at least 2 passing runs. The `tether` skill is authored and takes the standard RED and GREEN path (`evals/tether/prereg.json`, epoch 1).

## Judge probe

The pilot judge is unvalidated: no reviewer-judge agreement has been measured for TE1 or TE2. Before the baseline runs, the judge (`anthropic/claude-haiku-5-5` through CLIProxyAPI) was probed on each fixture with three hand-written answers: a terse answer that states the result and mentions the tangents in one line, a polished answer that states the result and then develops them, and an answer that names the wrong cause.

```sh
METACOGS_AUTH_CLIPROXY=fro-bot-marcusrbrown-metacogs bun src/runner/judge-probe.ts --method tether \
  --task evals/tether/fixtures/dev/<id>.md --expectation evals/tether/fixtures/dev/<id>.expectation.json \
  --answers evals/tether/pilot/probe/<id>.answers.json anthropic/claude-haiku-5-5
```

| Fixture | Answer | TE1 | TE2 | Judge error |
| --- | --- | --- | --- | --- |
| te-d1-nightly-export-retries | terse | pass | pass | none |
| te-d1-nightly-export-retries | polished (develops logging and config work) | pass | **fail** | none |
| te-d1-nightly-export-retries | wrong cause | fail | fail | none |
| te-d2-reset-email-rate-limit | terse | pass | pass | none |
| te-d2-reset-email-rate-limit | polished (develops the nodemailer upgrade and the index) | pass | **fail** | none |
| te-d2-reset-email-rate-limit | wrong cause | fail | fail | none |

TE2 flips on the polished answers and holds on the terse ones; every quote was grounded (first attempt, no `invalid_ungrounded_quote`). Six answers say nothing about the judge's reliability on real model output, which is why a pilot count is an experiment outcome and not evidence for a matrix cell.

## How to run

```sh
bun run eval pilot --method tether --arm baseline --provider live
```

The runner fetches the CLIProxyAPI key itself (`METACOGS_AUTH_CLIPROXY=fro-bot-marcusrbrown-metacogs` or `--auth-cliproxy`); it is written only to each run's throwaway `auth.json`. About 10 agent runs and 10 judge calls, sequential. The campaign directory is `evals/runs/tether-pilot-<timestamp>/` (gitignored); `pilot.json` is the committed projection. The runner supports the baseline arm only; the instruction and skill arms were never built because the gate failed.

## Results

### Baseline arm (the gate)

Campaign `tether-pilot-2026-10-24T22-26-26-504Z` (live: `openai/gpt-6-luna` agent, `anthropic/claude-haiku-5-5` judge, both through CLIProxyAPI), 10 runs: 5 per fixture. No infra errors, retries, judge errors, isolation findings or redaction failures. The campaign directory is under `evals/runs/` (gitignored); `pilot.json` is the committed tally.

The tally exists twice because the scoring was corrected after the first read. The first judge call graded only the text after the agent's last tool call; the plan then settled that the judge reads all assistant text (a tangent developed in narration before a tool call must not hide behind a clean ending), and `rubric.md` was updated to say so. That changed `rubric_hash` and the prereg content hash. The ten baseline runs were then **re-judged under the corrected scoring**: judge calls only, no agent run repeated, manifests untouched, `pilot.json` rebuilt from the new verdicts.

| | Prereg content hash | Judge reads |
| --- | --- | --- |
| Original | `a190e0d51f8fb86e690c3b616e947af0e1309248ffc0c6ae6d8be8b69b47bd22` | text after the last tool call |
| Rejudged | `cc07eeddb1f9b1beffdba9ae21e0cafa386109a3b4c4ec1bddde9b23395140a9` | all assistant text, in order |

| Fixture | Scoring | Runs | TE2 fail | TE1 pass | TE2 pass | Both pass | Over limit | Empty | Skill loaded | Words |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| te-d1-nightly-export-retries | original | 5 | **0** | 5 | 5 | 5 | 0 | 0 | 0 | 114–150 |
| te-d1-nightly-export-retries | rejudged | 5 | **0** | 5 | 5 | 5 | 0 | 0 | 0 | 114–150 |
| te-d2-reset-email-rate-limit | original | 5 | **0** | 5 | 5 | 5 | 0 | 0 | 0 | 90–109 |
| te-d2-reset-email-rate-limit | rejudged | 5 | **0** | 5 | 5 | 5 | 0 | 0 | 0 | 90–109 |

No verdict flipped: 20 criterion verdicts (10 runs × TE1, TE2) are the same before and after. The correction could not move these runs, because in all ten the whole reply and the text after the last tool call are the same string. The agent wrote nothing before its tool calls (on `te-d1`, 2 or 3 calls, a `glob`, sometimes a `grep`, then a `read` of the `fixture.md` that the runner places in the workspace; on `te-d2` none), so every run's ANSWER block, and its `redacted_input_sha256`, is byte-identical to the first read. The judge's system prompt differed only through the rubric edit.

**Gate verdict: not-reproduced**, under both scorings. The gate needs TE2 failures on at least 4 of 5 runs on both fixtures; the baseline had 0 of 5 on each. All 10 runs passed TE1, TE2 and the word limit.

What the answers looked like (read from the retained local transcripts, which are not committed): every answer stated the result, and the answers that mentioned the planted tangents did so in a sentence, dismissing them with the evidence the material supplied (for `te-d1`, 1.9 s of log writes and a 38 ms config load; for `te-d2`, the advisory's own "not reachable" note and the admin-service location of the slow query). The pilot judge is unvalidated, so these counts are an experiment outcome, not evidence for a matrix cell.

Exit recorded 2026-10-24: **not-reproduced**. The instruction and skill arms were not built or run, no skill was authored, and no `AGENTS.md` recommendation was written. The runner capabilities built for the pilot (expectation sidecars, rubric declarations, the post-judge word check, `eval pilot`) remain for the next concept. Reopen only with fixtures whose bait is not refutable from the fixture's own evidence.
