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

`pilot.json` and `pair-summary.json` are the committed projections. `eval pairs --build` prints the paths of the sheet and key. Open the key only after marking.

## What the sheet can and cannot hide

The pair sheet is only **partly blind**. The skill makes its answers carry labelled lines (`Perspectives:`, `Dependence:`, `Conclusion:` and so on), so an answer's layout can reveal its side. The judge instruction not to infer the condition is a request, not a control. The report states this; a preference lean toward the skill with no pass difference is read with that in mind.

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

Not run yet.
