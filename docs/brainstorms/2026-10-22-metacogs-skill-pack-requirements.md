---
date: 2026-10-22
topic: metacogs-skill-pack
---

# metacogs: explicit reasoning methods as portable Agent Skills

## Summary

`metacogs` is a public pack of portable Agent Skills that reinterprets the upstream `inanna-malick/metacog` concepts as explicit, testable reasoning methods. Each shipped method is backed by a helper script that validates a decision record and writes it to disk, and by a harness-driven eval suite whose retained baseline failures, measured against predeclared thresholds, decide which methods ship.

---

## Problem Frame

Upstream metacog exposes eleven MCP tools whose handlers only format the model's own inputs back into reinforcing text. None launches work, measures anything, or enforces anything; the README frames the effect as a self-fulfilling "change cognitive state" trick and cites jailbreak results. The useful kernel — a structured choice followed by a response that redirects subsequent work — is buried under altered-cognition theater, a remote Cloudflare Worker deployment, and claims that exceed what the code does.

Coding agents across OpenCode, Pi, Claude Code, and Codex all consume `SKILL.md` skills, though each host discovers them from its own path. Among the sources surveyed for this brief (upstream metacog, Systematic, the Agent Skills spec), none offers reasoning methods with a record contract, fixtures, and evidence that they change outcomes; Systematic's `ce:review` validator is the closest precedent for a script-validated structured record. Anyone wanting these methods today either installs an unverifiable MCP server or rewrites prompts by hand, with no way to tell whether the method helped.

The upstream repo is MIT-licensed, `private: true`, and the bare npm name `metacog` is owned by an unrelated MCP server, so the project needs its own identity and distribution path from the start.

---

## Actors

- A1. Method author (Marcus, later contributors): writes methods, fixtures, rubrics; runs RED/GREEN against real hosts.
- A2. Host agent: the coding agent inside OpenCode, Pi, Claude Code, or Codex that discovers a skill, follows it, and invokes the helper.
- A3. Helper script: validates record shape, writes the record, reports malformed input; establishes well-formedness, not truth.
- A4. Eval runner: drives scripted scenarios inside a real host in an isolated workspace, collects raw outputs, applies deterministic checks and rubrics, emits a replay manifest.
- A5. End user: a developer who installs the pack and expects methods to fire on the right triggers and stay silent on simple tasks.

---

## Key Flows

- F1. Method invocation
  - **Trigger:** A2 encounters a situation matching a skill's description (e.g., a consequential assumption to challenge).
  - **Actors:** A2, A3
  - **Steps:** A2 loads the skill; follows the explicit method; calls the helper with the record fields; A3 validates and writes the record; A2 reads the response and continues the task with the stated next action.
  - **Outcome:** A record exists on disk; the agent's next action is the one the record names.
  - **Escape (malformed input):** A3 rejects with a field-specific error; A2 corrects or abandons without a record.
  - **Escape (helper unavailable):** no runtime, blocked write, or write error — A2 reports the failure, continues the method without a record, and states execution mode `unrecorded` in its output.
  - **Covered by:** R1, R2, R6, R7, R8, R9, R10

- F2. RED → GREEN gate for a method
  - **Trigger:** A1 proposes that a concept should ship as a method.
  - **Actors:** A1, A4
  - **Steps:** A1 writes the development fixtures, a held-out fixture set, the rubric, and the run-count and pass-rate thresholds, all before authoring the skill; A4 runs the baseline (no skill) in an isolated OpenCode workspace and retains the failure; A1 writes the minimal skill against the development fixtures only; A4 reruns both fixture sets with the skill; GREEN is judged on the held-out set against the predeclared thresholds.
  - **Outcome:** Method is marked shipped (retained RED, passing GREEN) or stays a hypothesis.
  - **Escape:** Baseline already succeeds — fixture is kept as a regression case; concept stays a hypothesis and A1 investigates a real gap instead of manufacturing one.
  - **Covered by:** R11, R12, R13, R14, R15, R16

- F3. Install and host-matrix check
  - **Trigger:** A5 installs the pack into a host.
  - **Actors:** A5, A2
  - **Steps:** A5 clones or installs via a skills installer into the host's skill path; A5 consults the matrix for that host's status; A2 uses methods per F1.
  - **Outcome:** A5 knows whether their host is verified, content-compatible-untested, unverified, or unsupported before relying on a method.
  - **Covered by:** R3, R4, R17, R18, R19

---

## Requirements

**Portable methods**
- R1. Every shipped method is a standard Agent Skill (`SKILL.md` with `name` and `description` frontmatter) with no required vendor tool names or hardcoded model IDs in the core content.
- R2. Each method states its trigger, the explicit procedure, the record fields it produces, and what success looks like; it makes no claim of altered cognition, identity replacement, parallel execution, or enforcement it cannot perform.
- R3. The pack installs from the git repository or a skills installer; npm publication is not required at v0.1.
- R4. The README states that the project reinterprets upstream concepts as explicit methods and that altered-cognition and jailbreak framing are not objectives; it preserves upstream MIT attribution for reused material.
- R5. Methods do not fire on tasks that need no reflective procedure; a simple task completes without a method invocation or a record.

**Decision record**
- R6. Every shipped method produces a record containing: method and version, task objective, evidence references, assumptions and unknowns, alternatives, findings, next action, stopping or reopening condition, and actual execution mode.
- R7. A helper script validates the record's shape and writes it to disk; validation failure returns a field-specific error and writes nothing.
- R8. The method instructs the agent to distinguish observation, hypothesis, and validated finding, and never to present model agreement as independent evidence or a model-generated number as a calibrated probability; the eval rubric checks this, the helper does not.
- R9. Helpers require only a Node or Bun runtime on the host; no Python, no compiled dependencies, no network.
- R10. When the helper cannot run or cannot write, the method proceeds without a record and the agent reports execution mode `unrecorded`; the method never silently drops the record.

**Evidence gate**
- R11. A concept ships as a method only when the eval suite retains a baseline failure (no skill, isolated OpenCode workspace) and the held-out fixtures pass with the skill loaded against predeclared run-count and pass-rate thresholds.
- R12. Run count, pass-rate thresholds, rubric, and the held-out fixture split are written and committed before the skill is authored; the skill is developed against the development fixtures only.
- R13. Deterministic checks gate pass/fail wherever a criterion can be checked mechanically; any model-judged criterion uses a different model family than the agent under test and a human spot-check, with agreement reported.
- R14. Every eval run executes in a clean workspace containing only the fixture and, for GREEN, the one method under test; the manifest records the isolation.
- R15. Every eval run emits a replay manifest: commit IDs, fixture hashes, skill versions, model settings, harness version, tools, budgets, token use, latency, and raw outputs.
- R16. Evals report counts, variance, and regressions across repeated runs; a Systematic-workflow baseline is deferred past v0.1.

**Host matrix**
- R17. The README publishes a per-host matrix with one of four statuses per method: verified (live RED/GREEN evidence), content-compatible-untested (discovery path confirmed, no live run), unverified (no evidence either way), or unsupported.
- R18. The README documents each host's skill discovery path and install step; Discovery confirms each path with a smoke listing before a host is marked content-compatible-untested.
- R19. If a host lacks a capability a method references (delegation, blocking question, budget enforcement), the method's instructions name the sequential or manual fallback rather than approximating the capability silently.

**Hypotheses**
- R20. Concepts without a retained RED are listed in the README as hypotheses with a one-line interpretation and status; fixtures are written only when a concept enters a RED cycle.

---

## Acceptance Examples

- AE1. **Covers R7.** Given a method record missing its reopening-condition field, when the agent calls the helper, the helper returns an error naming that field and no file is written.
- AE2. **Covers R11, R20.** Given a concept whose baseline fixture already passes without the skill, when the author runs RED, the fixture is retained as a regression case and the concept remains listed under hypotheses.
- AE3. **Covers R19.** Given a host with no delegation capability and a method that explores alternatives, when the agent runs the method, the record's execution mode reads `sequential` and the output does not describe independent agents.
- AE4. **Covers R5.** Given the fixture "a simple task needs no reflective procedure", when run in OpenCode with all shipped skills loaded, the agent completes the task without invoking any method or writing a record.
- AE5. **Covers R17, R18.** Given a method verified only in OpenCode and smoke listings for the other hosts, when the README matrix is read, Pi, Claude Code, and Codex show content-compatible-untested for that method.
- AE6. **Covers R10.** Given a host with no Node or Bun runtime, when the agent reaches the record step, it reports the helper failure, finishes the method, and states execution mode `unrecorded`.
- AE7. **Covers R11, R12.** Given a method whose development fixtures pass but whose held-out fixtures fall below the predeclared pass rate, when GREEN is judged, the method stays a hypothesis.

---

## Success Criteria

- At least one method ships in v0.1 with a retained, reproducible baseline failure and a held-out GREEN in OpenCode that meets its predeclared pass-rate and regression thresholds — not eleven ported tools with no evidence.
- If no candidate yields a retained RED, v0.1 ships the eval harness, fixtures, and hypothesis list, with zero methods marked verified.
- A developer on any of the four hosts can install the pack, read the matrix, and know whether their host is verified, untested, or unverified without running anything.
- Every eval-run record validates with the helper and is traceable to a replay manifest.
- `ce:plan` can sequence discovery, RED, GREEN, portability, and release without inventing product behavior, scope, or acceptance criteria.

---

## Scope Boundaries

### Deferred for later

- Native host tools (OpenCode tool, Claude Code plugin tool, MCP endpoint) — only after evals show a tool boundary beats instructions for a specific method.
- Live RED/GREEN runs in Pi, Claude Code, and Codex — v0.1 marks them content-compatible-untested or unverified.
- npm publication of the helper scripts and reservation of the `metacogs` npm name.
- Systematic-workflow baseline, as a measurement or a gate.
- Controlled comparison against the upstream MCP server.
- Systematic composition (Systematic consuming metacogs methods).
- Re-validation policy when the model or harness version changes.

### Outside this product's identity

- Dreamer scheduling and historical-session ingestion — belongs to the Systematic Dreamer effort; metacogs operates on bounded evidence supplied by callers.
- Any Systematic dependency in the core pack.
- Altered-cognition, "substrate transition", or alignment-bypass behavior as a product objective.
- Architecture review as the sole method family — the pack preserves conceptual breadth across the upstream concept table as hypotheses, not shipped methods.

---

## Key Decisions

- Public multi-harness from day one, with release-blocking defined as content portability, a per-host discovery path, an honest matrix, and one OpenCode GREEN: `SKILL.md` is consumed by all four hosts; native tools are premature until we know what we're building.
- Evidence-gated shipping (1–2 methods): the upstream family is a hypothesis set, not a feature list; shipping unproven methods would repeat upstream's claims-over-evidence failure.
- Harness-driven evals over API-driven: measures what users run, at the cost of host coupling and slower runs.
- Helper script is a v0.1 commitment for every shipped method: script-validated records written to disk preserve the call-and-response boundary without an MCP server and make records auditable. A no-script markdown template was considered and rejected because unvalidated records cannot anchor the eval's deterministic checks.
- Systematic baseline deferred out of v0.1: a second workspace profile has no delivery path in a one-host, two-method release; incremental-value measurement returns with the first post-v0.1 plan.
- Name `metacogs`: npm 404, `github.com/marcusrbrown/metacogs` free, only zero-star hobby repos collide; the "s" signals multiple skills supporting metacognition.
- Git repo as the v0.1 artifact: skills-first product; npm adds carrying cost before it is needed.

---

## Dependencies / Assumptions

- Upstream pinned at `inanna-malick/metacog@3d89bb30cd26369fdcd242fd704f66641dca327c` (also current `main` HEAD at inspection); MIT, attribution required for reused material.
- Authoring follows Systematic `writing-skills` RED–GREEN–REFACTOR (`@fro.bot/systematic@3.24.2`, repo HEAD `cb69d73d669df17a648f977cc0dbf0cf2002f5ae`) without taking a runtime dependency on Systematic.
- Node or Bun present on target hosts is an acceptable install requirement; absence degrades to `unrecorded` per R10.
- Host discovery (official docs, 2026-10-22): OpenCode, Pi, and Codex read `.agents/skills/` natively; Claude Code reads `.claude/skills/` and `~/.claude/skills/` only. Pi lacks a native blocking question and does depth-1 sequential delegation.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R11][User decision at planning] Which one or two upstream concepts enter the first RED cycle — pick from the brief's concept interpretation table, using the scenario table as the fixture source.
- [Affects R11, R12][Technical] Default run count and pass-rate thresholds for RED and GREEN, and allowed variance.
- [Affects R13][Technical] Rubric format, which model family judges, and how human spot-checks are sampled.
- [Affects R14][Technical] How the runner drives OpenCode non-interactively in a clean workspace and captures raw outputs per fixture.
- [Affects R6, R7][Technical] Record field names, types, required/optional rules, file format, location, naming, and collision behavior; helper success-response shape.
- [Affects R18][Needs research] Which skills installers to document beyond `git clone` (Pi `pi install`, Claude Code plugin marketplace, Codex Skill Installer).


---

## Sources / Research

- Upstream source and README: https://github.com/inanna-malick/metacog/tree/3d89bb30cd26369fdcd242fd704f66641dca327c — all eleven handlers format inputs; `deconstruct` ignores five of six inputs; `fork`, `measure`, `tether` perform none of the actions they describe.
- Project brief: `metacog-project-brief-and-handoff.md` — concept interpretation table, initial scenario table, output contract, milestones.
- Agent Skills standard: https://agentskills.io/specification
- Systematic `writing-skills` and `test-driven-development` skills; `HARNESSES.md` capability matrix and discovery paths; `ARCHITECTURE.md` generators; `skills/ce-review/scripts/validate-review.mjs` as a precedent for a Node record validator.
- npm `metacog` is `arcmoonstudios/metacog`, unrelated; `metacogs` is unregistered.
