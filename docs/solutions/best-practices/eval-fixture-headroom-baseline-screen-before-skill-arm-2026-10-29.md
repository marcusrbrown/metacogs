---
title: "Eval fixtures need headroom: screen the baseline before spending a skill arm, and probe and vet fixtures first"
date: 2026-10-29
category: best-practices
module: evals
problem_type: best_practice
component: testing_framework
severity: medium
tags: [evals, fixtures, headroom, ceiling, baseline-screen, preregistration, judge-probes, synthesis]
related_components: [development_workflow]
applies_when:
  - "Authoring a new fixture set for a pilot or method whose agent arm is a strong model"
  - "A baseline arm may already pass the fixtures, so a skill arm could not separate from it"
  - "Writing acceptance statements that a model judge scores"
---

# Eval fixtures need headroom: screen the baseline before spending a skill arm, and probe and vet fixtures first

## Context

A fixture set only measures a skill if the baseline can fail it. Three pilots on `openai/gpt-6-luna`, each judged by `anthropic/claude-haiku-5-5`, show how hard that is:

- **Tether pilot.** The baseline failed `TE2` on 0 of 5 runs on each fixture (`evals/tether/pilot/README.md:85`, Gate verdict). The bait could be refuted from the fixture's own evidence, and the exit was `not-reproduced` (`evals/tether/pilot/README.md:89`).
- **Synthesis pilot, epoch 1.** Baseline and skill each passed 30 of 30 (`evals/synthesis/pilot/README.md:112`). Every prompt stated its deciding fact outright (`evals/synthesis/pilot/README.md:116`), so separation was uninformative.
- **Synthesis pilot, epoch 2.** Six fixtures were built so that the deciding fact follows only from joining two or more clues, and nothing states it (`evals/synthesis/pilot-2/README.md:3`). The baseline scored 27 of 30 (`evals/synthesis/pilot-2/README.md:80`).

## Guidance

1. **Preregister a staged baseline screen.** Run the baseline arm alone first, and commit the rule that decides whether the skill arm runs before stage 1 starts. Epoch 2's rule ran the skill arm only if at least 2 of 6 fixtures had baseline passes at or below 3 of 5 (`evals/synthesis/pilot-2/README.md:20`, Design; `evals/synthesis/pilot-2/prereg.json:67`, `metadata.notes`). The tether pilot used the same shape, requiring `TE2` failures on at least 4 of 5 runs on both fixtures (`evals/tether/pilot/README.md:18`).
2. **Write four probes per fixture, not two.** Before committing the prereg, hand-write four answers per statement:
   - a terse correct answer;
   - a polished answer that follows the shared premise;
   - a generic "investigate more" hold that does not name the deciding fact;
   - a correct answer worded differently from the statement and its examples.

   The intended verdicts are pass, fail, fail, pass (`evals/synthesis/pilot-2/README.md:36`). Epoch 1 probed only the first two (`evals/synthesis/pilot/README.md:30`). A judge that fails the reworded pass is too literal, and one that passes the generic hold is too lenient.
3. **Have someone other than the author check derivability.** For each fixture, confirm that the deciding fact follows from the stated clues alone, with no unstated assumption and nothing outside the supplied material. Check the arithmetic and date ranges too.
4. **Give each new fixture set its own pilot directory and prereg.** Epoch 2 lives in `evals/synthesis/pilot-2/`, with `content_dir` set to that directory (`evals/synthesis/pilot-2/prereg.json:29`) and `epoch` set to 2 (`evals/synthesis/pilot-2/prereg.json:4`). Epoch 1's files stay byte-identical. A statement change after the commit but before any run needs a revised contract. After any run it becomes a separately labelled iteration and is never pooled (`evals/synthesis/pilot-2/prereg.json:67`).
5. **Keep ceiling fixtures as regression coverage.** Do not rewrite them to fail (`evals/synthesis/pilot-2/README.md:88`).
6. **Read judge-only counts as the instrument's output.** The owner's marks are the primary score (`evals/synthesis/pilot-2/README.md:22`). Hand-written probes say nothing about how reliable the judge is on real answers (`evals/synthesis/pilot-2/README.md:47`).

## Why This Matters

A fixture set at ceiling costs runs and says nothing about the skill. Epoch 1 spent 60 runs and ended at ceiling in both arms. Epoch 2's staged screen ran 30 baseline runs and then stopped. The skill arm never ran, because only one fixture was off ceiling and the rule needed two (`evals/synthesis/pilot-2/README.md:84`).

Making the premise inferential did not create headroom on this model:
- With stated premises, the baseline passed 30 of 30 across six fixtures (`evals/synthesis/pilot/README.md:112`).
- With two-clue joins, the baseline passed 5 of 5 on five of six fixtures. The sixth, `sy-p2-d3-leaked-deploy-key`, passed 2 of 5 (`evals/synthesis/pilot-2/pilot.json:35-38`).
- The d3 count is the judge's and was not marked by the owner (`evals/synthesis/pilot-2/README.md:92`). The judge's reasons differ on near-identical conditional-rotation wording (PR #59), so the miss may be judge inconsistency rather than headroom.
- A weaker agent model is untested. These pilots used one agent model and one judge model, so nothing here generalises across models (`evals/synthesis/pilot-2/README.md:88`).

## When to Apply

- Writing the next fixture set for any method, or reopening a `not-reproduced` concept. Reopen only with bait that cannot be refuted from the fixture's own evidence (`evals/tether/pilot/README.md:89`).
- Deciding whether a skill arm is worth its paid runs.
- Writing acceptance statements for a model judge.

## Examples

| Fixture set | Baseline passes | Fixtures at 5 of 5 | Skill arm |
| --- | --- | --- | --- |
| Epoch 1, stated premises | 30 of 30 | 6 of 6 | 30 of 30 (uninformative) |
| Epoch 2, joined clues | 27 of 30 | 5 of 6 | Not run (1 of 6 off ceiling; the rule needs 2) |

A probe set for one statement, `evals/synthesis/pilot-2/fixtures/dev/sy-p2-d3-leaked-deploy-key.expectation.json:2` (`outcome`):

- **Terse pass:** revoke the key and rotate the prod DB password, because the prod state in the bucket holds it.
- **Polished fail:** the bucket is read-only and the tarballs are public, so defer.
- **Generic hold:** investigate whether anyone downloaded it.
- **Reworded pass:** the same conclusion in different words.

## Related

- PR #59 (epoch 2 pilot); PR #60 (the output-path fix that makes a separate pilot directory safe; see `docs/solutions/logic-errors/eval-pilot-with-non-default-prereg-overwrites-default-pilot-json-2026-10-29.md`)
- `evals/synthesis/pilot/README.md`, `evals/synthesis/pilot-2/README.md`, `evals/tether/pilot/README.md`
- `HYPOTHESES.md`
