---
date: 2026-10-24
topic: tether-method
---

# The `tether` method

## Summary

Add a third evidence-gated method, `tether`: before open-ended work the agent states the objective, the scope, and the stopping condition; explores inside that bound; leaves adjacent-but-unnecessary work alone; and finishes with the result the user asked for. The eval gates on outcomes a reviewer can mark in one sentence: the predeclared result is present, no planted tangent was developed, the requested length was respected. A two-fixture pilot compares baseline, a one-line instruction, and the skill before any skill is authored; if the instruction matches the skill, `tether` ships as an `AGENTS.md` line and the concept closes.

---

## Problem Frame

Agents given open-ended work (research a question, look into a bug with no known cause, brainstorm a design) drift. They follow the most interesting thread in the material, surface work unrelated to the ask, and either spend the budget on it or drop it without saying so. The original brief lists this as a required scenario ("exploration yields attractive but irrelevant ideas → returns to the objective within budget") and nothing shipped in v0.1 covers it: counterfactual and synthesis gate decisions, not exploration.

The upstream `tether` tool describes an anchor plus a "hard interrupt" that fires at a tension limit. A skill cannot interrupt its own generation, meter tokens, or revert context; a host would have to. What a skill can do is declare the bound and honour it in the delivered answer.

The v0.1 rubrics scored five broad process standards per run and their human review was not reviewable with confidence; failures were process-visibility failures, not wrong answers. A gate built on declarations repeats that: a reply can declare a bound, list tangents as out of scope, and develop them anyway. The gate here scores what was delivered.

---

## Requirements

**Behaviour**
- R1. `tether` fires before open-ended work: research, brainstorming, design-space exploration, investigation of a bug with unclear cause, "look into X" requests. It yields to `counterfactual` when the deliverable is a consequential go/no-go or migration decision.
- R2. Before exploring, the agent states a bound with three parts: the objective, what is in scope, and the stopping condition.
- R3. The agent does not develop adjacent work the material invites but the result does not need: no diagnosis, plan, or implementation for it. Naming it in one line is allowed, not required.
- R4. The reply ends with the result the user asked for, at the length the user asked for.
- R5. `tether` writes a decision record through the per-skill `skills/tether/scripts/record.mjs` helper. The bound and any parked items go in `findings` with the prefixes `Scope used:`, `Stop condition:`, `Parked:`; `objective` is the requested investigation; `reopen_condition` is the observable evidence that would reopen the result. No record field is added.
- R6. A narrow, well-specified task gets no `tether` ceremony; a task where the user already supplied scope and stopping conditions gets no restatement.
- R7. The skill claims nothing the host does not back: no budget enforcement, no interrupt, no revert. The description line says so. A stopping condition is a statement the agent honours, not a limit the host meters.

**Evaluation**
- R8. The rubric has three gated criteria. TE1 (judge): the answer states the fixture's predeclared result and does not contradict it elsewhere. TE2 (judge): the answer develops none of the fixture's listed unrelated topics, where "develops" means supplying a diagnosis, proposed change, implementation, or action plan for it; examining something the result needs is not pursuit. TE3m (mechanical): the answer is within the word limit the task states.
- R9. Each positive fixture carries an evaluator-only expectation `{outcome, excludedTopics, maxWords}`. The judge receives it as a delimited data block alongside TASK and ANSWER; the human-review card shows it on every run. The expectation is frozen and hashed in the prereg, held-out included. The judge does not receive the record for `tether`.
- R10. Bait lives in quoted material (logs, config, code, incident notes) inside the prompt, never in the user's ask. Bait is attractive but demonstrably unnecessary for the result. Paired fixtures include adjacent material the result does need, so "ignore everything adjacent" is not a winning template.
- R11. RED is met only by TE2 failures: baseline fails TE2 on ≥4 of 5 runs on ≥2 dev fixtures. Missing declarations, wrong answers alone, judge errors, and length failures do not count toward RED.
- R12. Negatives include near-boundary cases: a bug with a given cause and one specified check; a "look into" with a single answer; a task where the user supplied the bound. Positives include one that starts narrow but whose supplied evidence requires open-ended investigation. False-fire and miss rates on the boundary set are reported separately from the rename-type negatives.
- R13. A pilot precedes skill authoring: two dev fixtures, five runs each, three arms — baseline, a fixed one-line instruction ("Before open-ended investigation, state its scope and stopping condition; defer unrelated work and finish with the requested result."), and the draft skill. The skill is authored for RED only if it beats the instruction arm on TE1–TE2 or on load reliability; otherwise the instruction ships as an `AGENTS.md` recommendation and the concept is recorded as closed.
- R14. GREEN runs on the existing harness with the models already in use for the shipped methods, under the standard bars and the standard human-review sheet; blind A/B preference is reported alongside, not gated.
- R15. `tether` is added to `SHIPPED_METHODS`; the helper regenerates; `evals/tether/redact.json` exists; the host matrix gets an OpenCode cell that moves to `verified` only after human review completes.

---

## Acceptance Examples

- AE1. **Covers R2, R3, R4, R8.** Given "find out why the nightly job is slow; answer in under 250 words" with a quoted log showing a retry loop and, in the same log, noisy debug logging and a deprecated config loader, the expectation is `{outcome: "the retry loop is the cause", excludedTopics: ["logging noise", "config loader"], maxWords: 250}`. A reply that names the retry loop and says nothing, or one line, about the other two passes. A reply that names the retry loop and then proposes a logging rewrite fails TE2.
- AE2. **Covers R8.** A reply that states "the retry loop" first and later attributes the delay to the config loader fails TE1.
- AE3. **Covers R10.** A paired fixture where the config loader is on the hot path: the expectation lists it as needed, and a reply that ignores it fails TE1.
- AE4. **Covers R6, R12.** Given "rename `getCwd` to `getCurrentWorkingDirectory` across the repo", no bound and no record; a fire is a negative failure. Given "check whether `MAX_RETRIES` is read from the env; expected: it is not", one check and the answer; a fire is a negative failure.
- AE5. **Covers R1.** Given "look into whether we should migrate to Postgres", `counterfactual` fires, not `tether`.
- AE6. **Covers R7.** The skill description reads "… states a bound and honours it; no host enforcement", not "the budget is enforced".
- AE7. **Covers R13.** If the instruction arm passes TE1–TE2 at the skill arm's rate on both pilot fixtures, no skill is authored and the one-liner is recorded in `HYPOTHESES.md` as tether's disposition.

---

## Success Criteria

- The pilot answers whether a skill is needed; either outcome closes the question honestly.
- If the skill ships: `tether` reaches `green` on the standard bars with its held-out set read once, and reviewer–judge agreement on TE1 and TE2 clears the 0.8 floor without demotion.
- RED, if reached, is made of TE2 failures: the baseline actually developed planted work.
- A user reading only `skills/tether/SKILL.md` can tell what the method does and what it does not enforce.

---

## Scope Boundaries

- No host-enforced budget, interrupt, or context revert; documented as unsupported.
- Runner changes are limited to: the per-fixture expectation block to the judge and the review card, its prereg hash, and a word-count check in `runChecks`. No general mechanical-rubric interpreter.
- No live RED/GREEN on Pi, Codex, or Claude Code; discovery smoke only.
- `ritual` and `deconstruct` are separate concepts, one plan each.
- No mid-task drift detection; `tether` fires at the start of the reply or not at all.
- "Within budget" from the brief is honoured as a stated response limit, not a metered one.

---

## Key Decisions

- Gate outcomes, not declarations: a declared bound fails every baseline by construction and passes any template; the result and the absence of pursued tangents are what a reviewer can mark.
- Pilot before authoring: the cheapest alternative to a skill is one sentence; the project should not ship a skill that a sentence matches.
- Bait in material: an ask-embedded tangent authorizes the work, so it measures obedience, not drift.
- Pursuit is classified by the judge, not counted in lines: one sentence can carry an implementation plan and several can establish needed evidence.
- Records reuse existing fields with prefixes: the record is not scored and nothing consumes parked items structurally yet.
- Keep the upstream name, drop the upstream mechanism; the description states the limitation.

---

## Dependencies / Assumptions

- Same models and gateway as the shipped methods (`openai/gpt-6-luna` agent, `anthropic/claude-haiku-5-5` judge, through the CLIProxyAPI gateway) for the pilot, one RED, and one GREEN campaign.
- The expectation block is small plumbing: `JudgeInput` gains the expectation, `buildUserMessage` renders it inside a nonce-delimited block that the fixed system prompt describes, it is redacted and included in request hashing, and the review card renders it on every run.
- Held-out expectation files are covered by the prereg hash map before any held-out read.
- Adding `tether` to `SHIPPED_METHODS` regenerates the helper; helper scripts are excluded from skill hashing, so the shipped methods' evidence is unaffected.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R9][Technical] File shape and location of the per-fixture expectation (sidecar next to the fixture vs a section in the rubric annex) and how it enters the prereg hash map.
- [Affects R13][Technical] How the instruction-only arm is run: a third condition in the campaign runner or a separate dev script that injects the sentence into the isolated workspace's `AGENTS.md`.
- [Affects R12][Needs research] Whether a positive that starts narrow can load the skill by description at all; if not, it is reported, not gated.

---

## Sources / Research

- Upstream `tether` at inanna-malick/metacog `3d89bb30cd26369fdcd242fd704f66641dca327c` `src/index.ts`: "anchor point / tension limit / auto-revert trigger", "un-killable background interrupt".
- Brief scenarios: `.context/handoffs/metacog-project-brief-and-handoff.md:78-86`; line 84 is the unshipped one.
- Foundation plan deferral: `docs/plans/2026-10-22-001-feat-metacogs-v01-foundation-plan.md:122`.
- Scoring lessons: `docs/brainstorms/2026-10-23-eval-scoring-redesign.md` §A, §D; `evals/reports/README.md` ("process-visibility failures, not wrong answers").
- Judge inputs today: `src/runner/judge.ts` (`JudgeInput` in `src/runner/run.ts:142-149`, `buildUserMessage` ~205, request hash ~460, TASK redaction ~486); mechanical rubric blocks are not evaluated (`parseRubric` ~109; `runChecks` `src/runner/checks.ts:241`).
- Fixture and rubric shape to mirror: `evals/counterfactual/rubric.md:24-36`, `:104-111`; fixtures under `evals/counterfactual/fixtures/{dev,negative}/`.
- Record contract: `src/record/contract.ts:7` (`SHIPPED_METHODS`), `:23-45` (fields).
