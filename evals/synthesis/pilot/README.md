# synthesis pilot: one acceptance statement per fixture

A dev-only experiment on the six `synthesis` dev fixtures. The v0.1 GREEN sheet could not be reviewed with confidence: SY2 to SY5 asked for broad reasoning standards, agreement was 0.61 to 0.77 with κ 0.03 to 0.31, and 10 of 39 runs flipped on review. This pilot asks whether a narrower contract can be reviewed, and whether it still separates the skill from the baseline: each fixture gets **one** falsifiable acceptance statement, the owner marks every answer against it, and the judge scores the same text as the instrument under test.

Nothing here is a RED or GREEN read, a new epoch, or a matrix claim. `report` and `review` refuse these campaigns. The epoch-3 files (`../prereg.json`, `../rubric.md`, `../fixtures/`, `../redact.json`, `evals/reports/synthesis/`) and `skills/synthesis/**` are untouched.

Plan: `docs/plans/2026-10-28-001-feat-synthesis-eval-pilot-plan.md`. Origin: `docs/brainstorms/2026-10-23-eval-scoring-redesign.md`.

## What is committed

| File | Role |
| --- | --- |
| `prereg.json` | The pilot prereg: `content_dir` is this directory; 6 dev fixtures, no negatives, no held-out; 5 runs per arm per fixture; the epoch-3 agent and judge pins. Hashes the rubric, the fixtures and the sidecars. The guide numbers and reading rules are in `metadata.notes`. The bars in it are placeholders; the pilot uses none of them. |
| `rubric.md` | One judge criterion, `SA1` (statement satisfied). Declares `expectation: true`. No annex: the statement is the only definition of a good answer. |
| `fixtures/dev/<id>.md` | Byte-identical copies of `../fixtures/dev/<id>.md`. |
| `fixtures/dev/<id>.expectation.json` | The acceptance statement, `{"outcome": "..."}` only. It names the call the answer must (or must not) make, why, and one passing and one failing example. |
| `redact.json` | The epoch-3 list plus `unrecorded` and `no record was written`, the skill's own wording when its helper fails. |
| `pilot.json`, `pair-summary.json` | The projections `eval pilot` and `eval pairs --reconcile` write. Counts and ids only. Absent until a campaign has run. |

## What the agent sees, and what it does not

The agent gets the fixture file as its prompt and nothing else. The sidecars, the rubric and the statements are evaluator-only: the runner never puts them in the agent's workspace. The skill arm also has the skill installed, as in any skill-condition run.

The judge and the owner see the same three things: the prompt, the statement, and the text of the answer (all assistant text, in order, with `redact.json` tokens replaced by `[redacted]`). Neither sees the record, the run id, the arm or the other's verdict. The pair-sheet build rebuilds the judge's payload and checks its hash against the run's recorded `redacted_input_sha256`, so the sheet cannot show different text from what was judged.

Record checks are tallied and do not block the judge (the rubric declares `expectation: true`). A skill run that never loads the skill, or leaves no record, is still judged and stays in the skill arm; the load rate is reported from `fire_basis`, not used to exclude runs.

## Judge probe

Before this prereg was committed, each statement was probed with two hand-written answers: a terse one that makes the allowed call, and a polished, confident one that follows the statement's fail example. The answers are kept outside the repository, under the state root. The judge was `anthropic/claude-haiku-5-5` through CLIProxyAPI, the same as in the campaign.

```sh
METACOGS_AUTH_CLIPROXY=fro-bot-marcusrbrown-metacogs bun src/runner/judge-probe.ts --method synthesis \
  --content-dir evals/synthesis/pilot --task evals/synthesis/pilot/fixtures/dev/<id>.md \
  --expectation evals/synthesis/pilot/fixtures/dev/<id>.expectation.json \
  --answers <probe dir>/<id>.answers.json anthropic/claude-haiku-5-5
```

| Fixture | Terse passing answer | Polished failing answer |
| --- | --- | --- |
| sy-d1-kafka-consensus | pass | fail |
| sy-d2-stale-service-map | pass | fail |
| sy-d3-cache-tenancy | pass | fail |
| sy-d4-parser-vote | pass | fail |
| sy-d5-sdk-migration | pass | fail |
| sy-d6-log-redaction | pass | fail |

All 12 verdicts matched their intent on the first attempt, with no judge errors. Twelve hand-written answers say nothing about the judge's reliability on real model output, which is why the judge is the instrument under test here and not evidence.

## How to run

The campaign is paid (60 agent runs and 60 haiku judge calls through CLIProxyAPI) and needs the owner's go-ahead. It runs sequentially; do not rerun a partial campaign.

```sh
# 1. The campaign: baseline and skill, interleaved, 5 runs each per fixture.
bun run eval pilot --method synthesis --arm baseline,skill --provider live --auth-cliproxy fro-bot-marcusrbrown-metacogs

# 2. One bounded rejudge, only for runs that ended in judge_error. Persistent errors stay unjudged and are listed.
bun run eval rejudge --campaign <id> --errors-only --auth-cliproxy fro-bot-marcusrbrown-metacogs

# 3. The blind pair sheet and its key (state root, 0600). Refuses to overwrite a key.
bun run eval pairs --campaign <id> --build

# 4. The owner marks sheet.md (start and finish times, Mark X, Mark Y, Use, optional note), then:
bun run eval pairs --campaign <id> --reconcile
```

`pilot.json` and `pair-summary.json` are the committed projections. `eval pairs --build` prints the paths of the sheet and key. Open the key only after marking. The sheet shows only completed runs that reached the judge; a timeout, a budget breach, a host crash or a run a check kept from the judge is listed as incomplete, and so is its partner. If you rejudge after building, rebuild the sheet: `--reconcile` refuses when a shown run's `judge.json` changed. Move the old `sheet.md` and `key.json` aside first; a build never replaces a key.

## What the sheet can and cannot hide

The pair sheet is only **partly blind**. The skill makes its answers carry labelled lines (`Perspectives:`, `Dependence:`, `Conclusion:` and so on), so an answer's layout can reveal its side. The `[redacted]` placeholders mostly replace skill vocabulary, so a placeholder can hint at the skill arm too. The judge instruction not to infer the condition is a request, not a control. The report states this; a preference lean toward the skill with no pass difference is read with that in mind.

There is one agent model (`openai/gpt-6-luna`) and one judge model (`anthropic/claude-haiku-5-5`). Nothing here generalises across models.

## How the numbers are read

The owner's marks are the primary score. The judge is under test. The guide numbers in `prereg.json` `metadata.notes` are descriptive prompts for the owner's decision, not gates:

- judge-owner agreement of at least 0.8, read with its Wilson interval;
- at least 2 of 6 fixtures not at ceiling (the owner passes the baseline 4 or 5 of 5);
- owner pass counts per arm, pooled and per fixture, with no inference;
- preference wins, losses and ties, and the net margin, pooled only;
- at least 4 of 5 answered runs per arm and fixture, with no top-up runs.

If most fixtures sit at ceiling, separation is uninformative; it is not a pass for the instrument.

## Runner

Runner code as of `7a9e603` (`src/runner/`). A later bug fix is allowed if it is recorded here with its SHA.

## Results

Campaign `synthesis-pilot-2026-10-29T04-41-53-318Z`, run on 2026-10-29 under prereg content hash `6cbf69aa042dfd5ef019ebad7dc5404329c6f82fd27d1c0ee0eda60803adf54f`. Runner code as of `7a9e603`. Agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, both through CLIProxyAPI. `pilot.json` is the committed tally.

### Denominators

| | Count |
| --- | --- |
| Runs planned | 60 (6 fixtures, 5 per arm each) |
| Runs completed | 60 (30 baseline, 30 skill) |
| Infra errors, retries | 0 |
| Judge errors | 0 |
| Runs rejudged (`--errors-only`) | 0 |
| Empty answers | 0 |
| Record-check failures | 0 in either arm |
| Skill loaded (`fire_basis`) | 30 of 30 skill runs, all by the `skill` tool; 30 of 30 left a record |
| Baseline contamination | 0: no baseline run had a skill installed, loaded one, or named the skill or its helper |

### Judge verdicts

The judge passed SA1 on all 60 runs: baseline 30/30 and skill 30/30, 5/5 on every fixture in both arms.

### Reading

All six fixtures are at ceiling for the baseline, so under the preregistered rule **separation is uninformative**. `openai/gpt-6-luna` without the skill already reaches the decision each statement names, on every fixture. Each fixture's prompt states its deciding fact openly: the single stateful service, the month-end cron job, contract section 7.2, the AGPL licence text, 38% opt-in adoption, the world-readable buffer. This is the same lesson as the tether pilot (`not-reproduced`): when the material hands the model the premise, the failure does not appear. The skill also passed 30/30. These fixtures cannot tell the two arms apart, and nothing here is evidence for or against the skill.

The 12 probes run before the campaign did show that the judge separates a terse correct answer from a polished wrong one on every statement. That says the judge can tell the two cases apart when they occur. It does not say how the judge behaves on real model answers.

### Human read

Not done. After the judge ceiling the owner chose not to mark the pair sheet. The sheet and key were built (30 cards) and stay in the state root, unmarked. `eval pairs --reconcile` was not run and there is no `pair-summary.json`. Judge-owner agreement and the preference lean are therefore unmeasured, and this pilot does not show whether the judge is lenient: a 60/60 pass is what a lenient judge would also produce.

### Next

A second pilot epoch with fixtures whose deciding fact must be inferred and is not stated outright. It would need new fixtures, new statements, and its own prereg. This is a follow-up and is not part of this commit.
