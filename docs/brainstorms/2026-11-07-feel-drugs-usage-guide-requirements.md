---
date: 2026-11-07
topic: feel-drugs-usage-guide
---

# When and How to Use /feel and /drugs

## Summary

This is a public guide to when to type `/feel` or `/drugs`, and what their arguments change. It will be built from replays of about eight real stuck moments and a few ordinary turns, taken from the author's OpenCode sessions. The findings go into the plugin's `feel` and `drugs` skill text and into the tool descriptions.

---

## Problem Frame

Earlier probes found that `feel` and `drugs` change the next move only when a person types the command (`evals/spikes/feel-drugs/README.md`). Models do not call them unprompted. Typing the command is the only thing that activates them, and nothing helps a person recognise the moment to type it.

Across two active long-running sessions, one in fro-bot/agent and one in Systematic, the author typed about 225 turns and never used either command. Several moments fit:

- the agent reported a status that was wrong;
- a premise was disputed and turned out to be stale;
- a prescribed fix kept recurring until the root cause was found;
- the same CI failure family returned across PRs;
- a split design kept stalling until the approach changed.

The skill and tool text describe triggers from the model's side. They don't describe what the moment looks like to the person at the keyboard, or what passing an argument does.

Earlier activation probes used engineered seeds, and both models solved them without help. No one has measured how a `/drugs` substance or a `/feel` argument changes the result.

---

## Requirements

**Source moments**
- R1. Select about eight moments from the author's fro-bot/agent and Systematic sessions where a stuck point came before a human correction or a change of direction. About six should be `/feel`-shaped and two `/drugs`-shaped, each with a known outcome. Add two or three ordinary turns where the author did not step in.
- R2. Freeze each moment as a fixture holding what the agent believed just before the human stepped in. Nothing learned afterwards appears in it. A moment is excluded when its deciding state can't be verified, for example when the key tool output was compacted away or the real next move happened inside a subagent session.
- R3. Extract only an allowlist of message and part rows for each moment, into a new store. Never fork or restore the live session database, and never read its account or credential tables.
- R4. Paraphrase and scrub every fixture. A fixture contains no tokens, keys, credentials, private config contents or long verbatim user text. Paraphrase alone does not count as a scrub.
- R5. A named secret scanner runs on every fixture. A failure blocks all provider calls. The scan reruns after any fixture edit.
- R6. Fixtures and raw run evidence stay outside the repository. The only public artifacts are generic scenarios and the results table in R16.

**Replays**
- R7. Replay each fixture headless on real models, with these arms:
  - `Continue.`, run twice;
  - `/feel` with no arguments;
  - `/feel` with a `somewhere` argument;
  - `/drugs` with no arguments;
  - `/drugs` with each of two contrasting substances;
  - a prompt to use whichever metacogs tool fits;
  - the same nudge sentence with no tool named.
- R8. Replays run on Luna and Opus, on the author's daily OpenCode host (the fro-bot harness build; each run records its version), with the daily plugin stack in an isolated config. The isolated config:
  - never uses the author's own auth store; the provider key goes only into a throwaway credential file inside the run's fixture;
  - has remote MCPs and magic-context's historian and dreamer off, and every remaining plugin's egress reviewed before launch;
  - disables write-capable tools: git push, `gh`, and writes outside the run's own scratch store.

  Both models go through the author's CLIProxyAPI. The model each run actually reached is confirmed and announced before launch.
- R9. Every command-arm run checks that the request carried the metacogs skill's content and the `feel` or `drugs` tool. A run that fails the check is excluded and reported, never counted as `Continue.`. Baseline and nudge arms are not gated on a skill load; whether a nudge arm loaded or called anything is recorded as its outcome.
- R10. Every run records the argument text the skill actually received.
- R11. A next move counts as changed only when it differs from both `Continue.` runs. If the two `Continue.` runs differ from each other, that moment's changes are reported but not counted.
- R12. The author labels each counted change by hand as toward the real resolution, sideways, or away. Before seeing any arm, he writes down the expected next move from the fixture alone. Arms are shuffled so he labels them blind to which arm produced them. There is no model judge and no rubric.
- R13. Phase 1 runs each moment once per arm, plus the second `Continue.` run. Phase 2 reruns the three moments with the most counted changes labelled toward the resolution. If fewer than three moments qualify, phase 2 does not run, and the results report observations and exclusions only. Each rerun sweeps four to five substances, three phrasings of `somewhere`, and the no-argument forms, with three repeats each.
- R14. Each paid phase has a budget cap that the author approves before launch.
- R15. Every run keeps its raw events. No later fork or restore overwrites them.

**Outputs**
- R16. A public guide in `docs/` covers:
  - the observable signals for each command, from the person's side;
  - generic scenarios that illustrate them;
  - what each argument form did;
  - when neither command fits.

  It includes a results table for each moment: arm, label and run count. Every claim is stated as a count, such as "changed the next move in 2 of 3 runs".
- R17. Findings the replays support, and only those, are applied to `plugin/skills/feel`, `plugin/skills/drugs` and the tool descriptions. The changes keep the existing activation-text rules: observable triggers and no damping language.
- R18. The result of the "use whichever tool fits" arm, compared with its nudge-only control, is recorded. It comes with a recommendation on whether a single triage command is worth building.
- R19. Results are recorded next to the earlier feel/drugs spike results. Two weeks after the guide and skill text land, a read-only count of the author's typed `/feel` and `/drugs` uses, with what each led to, is added to them.

---

## Acceptance Examples

- AE1. **Covers R2.** The agent's tracker showed a unit running that had never been dispatched. The fixture holds the agent's belief that the unit is running and the status it reported. It does not hold the fact that the dispatch never started.
- AE2. **Covers R11, R12.** Both `Continue.` runs keep waiting on the unit, and the `/feel` arm checks the live session state. The `/feel` arm counts as changed. The author, who wrote "checks whether the unit started" as the expected move, labels it toward the resolution without knowing which arm it was.
- AE3. **Covers R11.** The two `Continue.` runs on a moment take different next actions. That moment's arm changes appear in the results but count toward no claim.
- AE4. **Covers R13, R16.** Two substances produce the same next move across three repeats on a moment. The guide says the substance made no difference there, in 3 of 3 runs each.
- AE5. **Covers R4, R5.** A source message contains a token prefix. The fixture paraphrases the situation without it. The scanner passes before any provider call uses the fixture.
- AE6. **Covers R9.** In a `/feel` run, the request carries no `feel` skill content, for example because a same-named skill elsewhere in the stack won. The run is excluded and listed in the results as failed to load.

---

## Success Criteria

- From the guide, the author can tell when in a session to type `/feel` or `/drugs`, and what to pass.
- The two-week usage count shows him typing them, along with what each use led to.
- Every claim in the guide traces to a counted replay result.
- A planner can build the replays without inventing arms, signals, gates or outputs.

---

## Scope Boundaries

- Unprompted activation: models calling the tools on their own.
- A model judge, rubric, held-out set or matrix change. The eval prereg rule covers method skills under `skills/`. It does not apply to the plugin skills.
- The method skills' text under `skills/` (`synthesis`, `counterfactual`). Editing it is an epoch change.
- Building a triage command. This work only recommends for or against one.
- Hosts other than the author's daily OpenCode v1 build.

---

## Key Decisions

- **Real-model replays, not the scripted provider.** Only a real model shows how the next move changes.
- **"The next move changes" is the signal, with a noise floor.** It casts a wider net than "reached the real fix". The two `Continue.` runs keep run-to-run noise from passing as an effect. Blind labelling of direction keeps sideways changes from passing as wins.
- **A broad pass, then a targeted sweep.** Earlier probes saw large round-to-round variance, so the repeats go where an effect toward the resolution showed up.
- **Ordinary turns and a nudge-only control are included.** Without them, the guide can't say when a command is noise, and the triage recommendation can't separate the sentence from the tools.
- **Fixtures stay private, and the results table is public.** Fixtures come from sessions that hold credentials and private context. The table lets readers check the claims without seeing the sessions.
- **Real moments, not engineered seeds.** Earlier probes recorded that engineered seeds were solved without help, and that typed commands are the only demonstrated activation path (`evals/spikes/feel-drugs/README.md`). This work uses real moments and varies the arguments.

---

## Dependencies / Assumptions

- The local OpenCode session database can be read. It holds the human turns and enough assistant context to rebuild the agent's belief at each moment. Some tool outputs may be compacted or missing. The database is live, so reads may need a snapshot.
- Most moments depend on PR or CI state that no longer exists. Their fixtures carry a summary of that state as it stood at the moment.
- The replays build on the spike harness under `src/spike/feel-drugs/` (`guided`, `sheet`, `blind`) and on the runner's isolated fixtures and OpenCode pin (`src/runner/env.ts`).
- A session inventory already lists candidate moments in both projects. The final set is chosen during planning, with the author's approval.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][User decision] Which eight moments and which ordinary turns. Planning proposes them from the inventory, and the author approves.
- [Affects R2][Technical] How to freeze the agent's belief: a rebuilt session that is forked, or one prompt carrying the prior turns. Also what happens when a history's tool outputs are missing.
- [Affects R5][Technical] Which scanner to use, and its rules for the token prefixes seen in the session data.
- [Affects R7][Technical] The two contrasting substances for phase 1, and the `somewhere` phrasing for each moment.
- [Affects R14][Needs research] The cost per run with the full stack, measured on one run before the phase 1 cap is set.
- [Affects R16][Technical] The guide's path, and where the README and install docs link to it.

---

## Sources / Research

- `evals/spikes/feel-drugs/README.md`: the activation, description-wording and reminder probes, the command checks, and the harness isolation checks.
- `docs/solutions/integration-issues/opencode-plugin-per-request-reminder-injection-2026-10-29.md`: the activation results table.
- `docs/brainstorms/2026-10-25-opencode-plugin-requirements.md`: the activation-text rules and the command argument mapping.
- `plugin/skills/feel/SKILL.md`, `plugin/skills/drugs/SKILL.md`: the current trigger and argument text.
