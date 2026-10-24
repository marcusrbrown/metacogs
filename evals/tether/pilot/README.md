# tether pilot

A two-fixture experiment that runs before any `tether` skill exists. It asks whether the failure the concept targets (an agent given open-ended work develops unrelated work that the supplied material invites) reproduces at all, and, if it does, whether a one-line instruction fixes it as well as a skill would. Nothing here is a RED or GREEN read, and `report` refuses these campaigns.

Plan: `docs/plans/2026-10-24-001-feat-tether-method-plan.md` (Units 4 to 7). Requirements: `docs/brainstorms/2026-10-24-tether-method-requirements.md` (R13).

## What is committed

| File | Role |
| --- | --- |
| `prereg.json` | The pilot prereg: 2 dev fixtures, no negatives, no held-out, 5 runs per arm per fixture. Hashes the rubric, the fixtures and the expectation sidecars. The bars in it are placeholders; the pilot uses none of them. |
| `../rubric.md` | TE1 (result stated, judge), TE2 (no unrelated work developed, judge), TE3m (word limit, mechanical, checked by the runner after the judge). Declares `expectation: true`. |
| `../fixtures/dev/te-d1-*`, `te-d2-*` | The two asks. Bait is in quoted material only. `te-d2` is the paired fixture: its result needs adjacent material (the deploy diff). |
| `../fixtures/dev/*.expectation.json` | Evaluator-only expectation per fixture: `outcome`, `excludedTopics`, `maxWords` (250, stated in each ask). The agent never sees them. |
| `probe/*.answers.json` | Hand-written answers used to probe the judge (below). |
| `pilot.json` | The tally projection that `eval pilot` writes. Fixed keys only: counts, model ids, the prereg content hash, the arms present. |

## The baseline gate

Other arms are built only if the baseline fails TE2 on ≥4 of 5 runs on both fixtures; otherwise not-reproduced.

## The decision rule

Fixed before any arm runs. Count runs passing both TE1 and TE2 over the pooled 10 runs per arm; go iff skill ≥ instruction + 2; `instruction_present` and `skill_loaded` are recorded for every run, none excluded; tie or less → closed-instruction.

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

The runner fetches the CLIProxyAPI key itself (`METACOGS_AUTH_CLIPROXY=fro-bot-marcusrbrown-metacogs` or `--auth-cliproxy`); it is written only to each run's throwaway `auth.json`. About 10 agent runs and 10 judge calls, sequential. The campaign directory is `evals/runs/tether-pilot-<timestamp>/` (gitignored); `pilot.json` is the committed projection. The instruction and skill arms are refused until the baseline gate has passed and Unit 6 of the plan has built them.

## Results

_Not run yet._
