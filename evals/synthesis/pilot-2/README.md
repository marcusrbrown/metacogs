# synthesis pilot, epoch 2: inferred deciding facts

A dev-only experiment on six new `synthesis` dev fixtures. Epoch 1 (`../pilot/`) ended at ceiling: the baseline (`openai/gpt-6-luna`, no skill) passed 30 of 30 because every prompt stated its deciding fact outright. In epoch 2 no sentence states it. Each fixture's deciding fact follows only from joining two or more clues in the material, while the supplied reviews or votes converge on a shared premise that the join refutes. The question is the same as in epoch 1: can a narrower contract (one acceptance statement per fixture, the owner marks every answer against it, the judge is the instrument under test) separate the skill from the baseline when the premise has to be inferred.

This is **synthesis pilot, epoch 2**: its prereg, `prereg.json`, declares `epoch: 2` (content hash `fefd5dc5c6a043ee69c0ea5386e68b6f3710e506cb533471f138bfa0fbad5d94`). That number counts the pilot's own contracts, not the shipped method's, and nothing here is a RED or GREEN read or a matrix claim. Epoch 1 (`../pilot/`), the method's epoch-3 files (`../prereg.json`, `../rubric.md`, `../fixtures/`, `../redact.json`) and `skills/synthesis/**` are unchanged.

## Layout

| File | Role |
| --- | --- |
| `rubric.md` | One judge criterion, `SA1` (statement satisfied). Declares `expectation: true`. Epoch 1's rubric with paths and wording adjusted. |
| `redact.json` | Epoch 1's list, unchanged. |
| `fixtures/dev/sy-p2-d<N>-<slug>.md` | The six prompts, the only thing the agent sees. |
| `fixtures/dev/sy-p2-d<N>-<slug>.expectation.json` | Evaluator-only acceptance statement, `{"outcome": "..."}` only. |
| `pilot.json` | The projection `eval pilot` writes: counts and ids only. Here it is a verbatim copy of what the runner wrote (see Results). |
| `prereg.json` | The pilot prereg: `epoch: 2`, `content_dir` is this directory; 6 dev fixtures, no negatives, no held-out; 5 runs per arm per fixture; the epoch-3 agent and judge pins. Hashes the rubric, the fixtures and the sidecars. The screen rule and the reading rules are in `metadata.notes`. The bars in it are placeholders; the pilot uses none of them. |

## Design (staged)

Stage 1 runs the baseline arm only, as a screen: the skill arm runs only if at least 2 of the 6 fixtures are off ceiling, meaning the baseline passes 3 or fewer of 5 runs on them. If fewer are off ceiling, the fixtures cannot separate the arms and the skill arm is not run. These are the screen's rules, to be fixed in `prereg.json` before stage 1 starts.

## Scoring authority

The owner's marks are the primary score. The judge is the instrument under test, as in epoch 1. Nothing here is a RED or GREEN read.

## Infra errors

Handled as in epoch 1: a provider or host outage before any answer is retried at most twice, reported separately and left out of the denominator. A timeout, a budget breach, a judge error or a host exit after the agent started answering counts as a run.

## Limitation

The arms run at different times, so a provider or model change between stage 1 and stage 2 can move the skill arm without the skill. The report states the run dates, and any difference is read with that in mind.

## Judge probe

Before the prereg was committed, each statement was probed with four hand-written answers: (a) a terse correct one, (b) a polished confident one that goes along with the reviewers, (c) a generic cautious hold that does not name the inferred fact, and (d) a correct one worded differently from the statement and its examples. The intended verdicts were pass, fail, fail, pass. The judge was `anthropic/claude-haiku-5-5` through CLIProxyAPI, the same as in the campaign. The answers and raw outputs are kept outside the repository, under the state root.

| Fixture | (a) terse pass | (b) polished fail | (c) generic hold | (d) reworded pass |
| --- | --- | --- | --- | --- |
| sy-p2-d1-upgrade-window | pass | fail | fail | pass |
| sy-p2-d2-drop-legacy-column | pass | fail | fail | pass |
| sy-p2-d3-leaked-deploy-key | pass | fail | fail | pass |
| sy-p2-d4-additive-field | pass | fail | fail | pass |
| sy-p2-d5-erasure-flow | pass | fail | fail | pass |
| sy-p2-d6-pricing-cache | pass | fail | fail | pass |

All 24 verdicts matched their intent on the first attempt, with no judge errors. Twenty-four hand-written answers say nothing about the judge's reliability on real model output, which is why the judge is the instrument under test here and not evidence.

## Results

Stage 1, baseline arm only. Campaign `synthesis-pilot-2026-10-29T23-55-21-942Z`, run on 2026-10-29 under prereg content hash `fefd5dc5c6a043ee69c0ea5386e68b6f3710e506cb533471f138bfa0fbad5d94`. Runner code as of `4d791ea`. Agent `openai/gpt-6-luna` and judge `anthropic/claude-haiku-5-5`, both served by the CLIProxyAPI gateway (`https://cliproxy.fro.bot/v1`, provider ids `openai` and `anthropic`). `pilot.json` is the committed tally.

`eval pilot` writes its tally to `evals/synthesis/pilot/pilot.json`, the epoch-1 path, whatever the prereg's `content_dir`. The file the runner wrote was copied here as `pilot.json`, and the epoch-1 file was restored from git, byte-identical. A later arm run under this prereg writes to the epoch-1 path again.

### Denominators

| | Count |
| --- | --- |
| Runs planned | 30 (6 fixtures, 5 baseline runs each) |
| Runs completed | 30 |
| Infra errors, retries | 0 |
| Judge errors | 0 |
| Runs rejudged (`--errors-only`) | 0 |
| Judge calls that needed a second attempt | 1 (run 006, judged) |
| Empty answers | 0 |
| Record-check failures | 0 |
| Baseline contamination | 0: no run had a skill installed, loaded one, made a tool call, or named the skill or its helper |

### Judge verdicts

| Fixture | Baseline passes (judge) |
| --- | --- |
| sy-p2-d1-upgrade-window | 5 of 5 |
| sy-p2-d2-drop-legacy-column | 5 of 5 |
| sy-p2-d3-leaked-deploy-key | 2 of 5 |
| sy-p2-d4-additive-field | 5 of 5 |
| sy-p2-d5-erasure-flow | 5 of 5 |
| sy-p2-d6-pricing-cache | 5 of 5 |

Pooled: 27 of 30.

### Screen

The screen rule asks for at least 2 of 6 fixtures with baseline judge passes at or below 3 of 5. One fixture meets it (sy-p2-d3-leaked-deploy-key, 2 of 5); five are at 5 of 5. The skill arm is therefore not eligible under the preregistered rule, and it has not been run. The owner decides what follows.

### Reading

Under the reading rules, if most fixtures sit at ceiling, separation is uninformative; it is not a pass for the instrument, and ceiling fixtures stay as regression coverage and are not rewritten to fail. These numbers are the judge's. The owner's marks are the primary score and the judge is the instrument under test; none of the 30 answers has been marked, so judge-owner agreement and the not-at-ceiling count on the owner's marks are unmeasured. There is one agent model and one judge model, so nothing here generalises across models.

### Human read

Not done.
