---
title: "Scope an LLM-review policy rule to the files the invariant protects, not a directory glob"
date: 2026-10-29
category: best-practices
module: repo-ops
problem_type: best_practice
component: development_workflow
severity: low
tags: [fro-bot, review-policy, llm-review, prereg, epoch, github-actions, path-glob]
related_components: [documentation]
applies_when:
  - "Writing or editing a path-based blocking rule in an LLM review prompt"
  - "The invariant behind the rule lives in specific contract files, not in the whole directory"
  - "A rule keeps blocking PRs that touch only READMEs, recorded results or runner docs"
---

# Scope an LLM-review policy rule to the files the invariant protects, not a directory glob

## Context

`PR_REVIEW_PROMPT` in `.github/workflows/fro-bot.yaml:43` holds Fro Bot's review instructions, including a blocking epoch rule. PR #8 added the rule as a directory glob: any change under `evals/**` blocked unless the PR declared a new epoch. What the rule protects is narrower: the eval contracts a prereg pins. `evals/**` also holds READMEs, recorded results and runner documentation, and none of those can change a prereg outcome.

Fro Bot returned CONDITIONAL on two PRs that touched only that kind of file:

- **#54**, a probe record in `evals/spikes/feel-drugs/README.md`. The review said the policy "applies to **any** `evals/**` change, including unscored documentation". The PR merged only after an "epoch 3" was declared for a doc write-up.
- **#57**, a paragraph in `evals/runner/README.md`. The review said the policy "explicitly makes any such change blocking, including documentation outside prereg hash coverage".

## Guidance

Write the rule against the files the invariant protects. Name file types or exact paths, then name the look-alike paths the rule does not cover. After #58, `.github/workflows/fro-bot.yaml:49-53` names contract artifacts instead of a directory. It names the non-contracts too: READMEs, recorded results and `evals/runner/**`. It keeps one glob, `skills/**`, because all skill text is a contract there; only the generated helper is excepted, and `hashSkillDir` skips it (`src/runner/workspace.ts:267`).

## Why This Matters

- An epoch declaration means something only for files a contract pins. `Prereg` in `src/runner/prereg.ts` pins fixtures, expectation sidecars (`src/runner/prereg.ts:58`, `expectation_hashes`) and the rubric (`src/runner/prereg.ts:65`, `rubric_hash`). An epoch on a README pins nothing.
- A blocking rule that fires outside its invariant teaches authors to treat the declaration as a formality. The next real contract change then gets the same reflex.
- A reviewer model applies the rule text literally. On #57 it noted that the file was outside hash coverage and blocked anyway, so the exemption has to be in the rule text itself.

## When to Apply

- Any blocking or high-severity rule in an LLM review prompt that is keyed on a path.
- Before turning "no changes under X/" into a prompt rule, list what actually lives under X.
- When a reviewer keeps raising a finding that the author calls meaningless, check whether the rule's path scope is wider than its invariant.

## Examples

The rule before #58, at `.github/workflows/fro-bot.yaml:49-51`:

```text
- Any change under `evals/**` or to skill text under `skills/**` (the
  generated `skills/*/scripts/record.mjs` excepted) is blocking unless the
  PR declares a new epoch
```

The rule after #58, at `.github/workflows/fro-bot.yaml:49-53`:

```text
- A change to an eval contract (`prereg.json`, `rubric.md`, `redact.json`,
  fixtures or expectation sidecars under `evals/**`) or to skill text under
  `skills/**` (the generated `skills/*/scripts/record.mjs` excepted) is
  blocking unless the PR declares a new epoch. READMEs, recorded results
  and `evals/runner/**` are not contracts and need no epoch
```

The outcome on #57: Fro Bot re-reviewed the rebased head under the new rule, withdrew the finding ("The only `evals/**` change is runner documentation, which is explicitly exempt") and returned PASS.

For contrast, the autoheal write boundary at `.github/workflows/fro-bot.yaml:147-148` keeps `evals/**` under `YOU MUST NEVER CHANGE`. A directory glob is correct there, because that rule is a deny-by-default write scope, not a contract rule.

## Related

- PRs #8 (introduced the rule), #54 and #57 (false blocks), #58 (fix)
- `evals/runner/README.md:250` (what the skill hash covers)
