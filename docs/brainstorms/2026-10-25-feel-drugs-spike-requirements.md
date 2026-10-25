---
date: 2026-10-25
topic: feel-drugs-spike
---

# The `feel` / `drugs` mechanism spike

## Summary

Run the upstream `feel` and `drugs` tools against two models in three arms (nothing, upstream tools over a local stdio MCP, the same frame as a skill) on four owner-approved prompts, retain the transcripts, and let a human read decide per tool whether the mechanism moves the model and whether the effect survives flattening into a skill. A fourth arm (the same handler as a native OpenCode tool) runs only if the MCP arm shows an effect. This is an experiment with a human read run by a small standalone driver: no method, no prereg, no rubric, no judge, no tally, no matrix cell.

---

## Problem Frame

The project exists to give a model the upstream metacog capabilities as skills instead of MCP tools. The two concepts that motivated it, `feel` and `drugs`, have never been run. The shipped methods (synthesis, counterfactual) and the closed one (tether) are procedure concepts a skill can plausibly carry; `feel` and `drugs` are the thesis.

Upstream at `3d89bb3`, both tools are stateless text templates: the model composes fields (`somewhere / quality / sigil`; `substance / method / displaces`) and the handler echoes them inside a fixed frame. There is no server state, randomness, or cross-tool read; the "persists" and "unavailable" language is prose. The upstream README claims the effect shows only on Gemini and Claude Opus. So the open question is narrow: does composing the fields in a tool call and reading the frame back change what the model produces, compared with reading the same frame as skill text and writing the fields inline — and does the model family matter?

---

## Requirements

**Arms and models**
- R1. Three arms share one tool set (both tools, as upstream ships them): **A** no tools, no skill; **B** the upstream `feel` and `drugs` registrations served over a local stdio MCP (no Cloudflare Worker, no HTTP); **C** a skill carrying the upstream frame text verbatim that asks the model to write the same fields in-reply. **D**, a native OpenCode custom tool with the identical handler and description, runs only if the read of A vs B shows an effect for either tool and the owner asks for it.
- R2. Models: `openai/gpt-6-luna` and `anthropic/claude-haiku-5-5`, both through the existing CLIProxyAPI gateway; one campaign per model.
- R3. Upstream source is pinned to `inanna-malick/metacog@3d89bb30cd26369fdcd242fd704f66641dca327c` (MIT); the stdio wrapper and the native tool reuse its tool descriptions, input schemas and return templates byte-for-byte. The wrapper uses `@modelcontextprotocol/sdk` as a devDependency (owner-approved).

**Prompts and runs**
- R4. Four open-ended prompts: two creative or reflective asks where `feel` would plausibly fire, two analysis or stance asks where `drugs` would. Drafted by the agent, approved or replaced by the owner, committed with a one-line rationale each and a content hash before the first run, and unchanged for every run. No prompt names a tool, the method, a field, or the words "feel", "drugs", "substrate".
- R5. Two runs per cell (sampling variance; one call is an anecdote): 3 arms × 2 models × 4 prompts × 2 = 48 runs, sequential, under the existing per-run timeout and budget. Arm D, if run, adds 16.

**Observation**
- R6. Every run retains the full transcript (`stdout.jsonl`, recorded requests) under the state root. For B and D the sheet records whether each tool was called, how many times, and the arguments the model composed (from the tool-use parts); for C whether the skill was loaded and whether the frame fields appear in the reply. Every run records the set of tools the host offered the model (from the recorded request bodies); a B or D run whose offered tools do not include the expected names is marked `tools_missing`, not silently read as arm A.
- R7. The read sheet is one committed markdown file under `evals/spikes/feel-drugs/`: per run — prompt id, arm, model, offered tools, tool calls with arguments (or the in-reply fields for C), the C instruction text once, and the answer. Answers are scanned with the repo's secret and path scan before commit. No separate tally: per-cell call counts are a hand-written summary table in the spike README.
- R8. The read is the owner's. The outcome per tool is one line in `HYPOTHESES.md` answering "did it fire, and did the answer change in a way worth paying for" per model; the spike README carries the prose. A null result is a statement about these four prompts and these two models, not about the tool in general.

**Isolation and driver**
- R9. A standalone spike driver (not `eval pilot`, not `runCampaign`) reuses the workspace, child-env, isolation-check and event primitives, builds a per-arm OpenCode config (MCP entry for B; skill copy for C; tool definition for D), and writes its own run directories. It asks for no prereg and no held-out set. Arm C's skill lives under `evals/spikes/feel-drugs/skill/`, outside `skills/`, so the helper generator and the per-method prereg rule do not apply; the spike is not a method.
- R10. A one-run probe on the pinned host version precedes the campaign and records: whether the isolated config loads a local stdio `mcp` entry and (for D) a custom tool, where the tool definition must live, the tool names as they appear in events, and that the debug-config check still passes. If the sandbox cannot host B or D, those arms run under a documented relaxed config named in the sheet.
- R11. The credential path is unchanged (the runner fetches the CLIProxyAPI key; never logged or committed). Arm C's isolation includes the sentinel decoy as before.

---

## Acceptance Examples

- AE1. **Covers R1, R6.** On a reflective prompt under arm B, luna calls `feel` with `sigil: "🌊"` and the sheet row shows the call and arguments; the same prompt under arm A shows none; under arm C the reply contains a `Texture:` line and the skill load is recorded.
- AE2. **Covers R7.** The sheet shows the two luna answers to prompt 1 under arms A and B adjacent, with the tool call between them; the README summary table reads `feel: 2/2` for that cell.
- AE3. **Covers R8.** If haiku calls `drugs` in 7 of 8 runs and the answers read differently while luna calls it in 0 of 8, the owner writes `drugs — haiku: fires, answers change; luna: never fires` in `HYPOTHESES.md`.
- AE4. **Covers R4.** No prompt contains "feel", "drugs", "tool", "substrate", or a field name; the prompt file's hash in the README matches the committed file.
- AE5. **Covers R6, R10.** A B run whose recorded request bodies offer no `feel`/`drugs` tool is marked `tools_missing` and excluded from the call-rate table; the probe log shows the MCP tool list once before the campaign.

---

## Success Criteria

- Every cell has 2 retained runs or a recorded reason.
- The owner can answer, per tool and per model, "did it fire, and did the answer change in a way I'd pay for" from the sheet alone.
- Each of `feel` and `drugs` leaves with one outcome line in `HYPOTHESES.md`.

---

## Scope Boundaries

- No rubric, judge, RED/GREEN, prereg, held-out custody, tally schema, matrix cell, or `SHIPPED_METHODS` change.
- No extension of `eval pilot`, `PilotArm`, `PilotTally`, `runChecks` or `Condition`.
- The other nine upstream tools are not served.
- No skill authoring beyond the verbatim-frame skill for arm C.
- One host version.

### Deferred to Separate Tasks

- If a tool shows an effect from skill text: a method brainstorm for that tool with an outcome gate.
- If a tool shows an effect only via tool call: a brainstorm on whether metacogs ships native host tools at all (arm D is the first input).

---

## Key Decisions

- Standalone driver over pilot reuse: the pilot path requires a committed prereg, a rubric and a judge, is baseline-only, scores arm C as a failed skill run, and its tally cannot hold two models. The spike needs none of that.
- Both tools in one tool set: separating them doubles the runs for a question the read can answer.
- Stdio MCP wrapper, not the Worker: the registrations are the mechanism; the transport is the author's deployment choice.
- Arm C uses the frame verbatim. B vs C compares a tool call against a skill instruction carrying the same wording; the output channel and instruction differ, so the sheet shows the C text and the read weighs that.
- Arm D only after B shows an effect: it separates transport from tool call, which matters only if there is an effect to attribute.
- No committed tally: the sheet is the artifact; a schema and projection for a 48-row read is carrying cost.
- Owner-approved frozen prompts: the prompts set every call rate.
- Human read first, no rubric: we do not know what "works" means for these tools until we see it.

---

## Dependencies / Assumptions

- `@modelcontextprotocol/sdk` as a devDependency (approved). The Node 22 floor applies only to bundled helpers; the wrapper runs under Bun.
- OpenCode's isolated config accepts a local stdio `mcp` entry and a custom tool; the generated permission block has no catch-all, so unlisted tool permissions default to allow and the debug-config check must still pass. Unverified until the R10 probe.
- Tool-call arguments are present in the retained `stdout.jsonl` (`tool_use` parts carry `state.input`); offered tools are in the recorded request bodies.
- Default output root for non-held-out runs is `evals/runs/`; the driver writes to the state root explicitly.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R9][Technical] Whether the stdio wrapper imports upstream `src/index.ts` registrations directly (the file also wires a Cloudflare Durable Object) or copies the two registrations verbatim into a small Bun script with a provenance comment.
- [Affects R10][Technical] Custom-tool file location for arm D (`.opencode/tools/` vs config) and how `@opencode-ai/plugin` resolves in an empty workspace — answered by the probe.

---

## Sources / Research

- Upstream mechanics at `3d89bb3`: `src/index.ts:34-88` (`feel`), `:91-133` (`drugs`); no state, no randomness; README claim of Gemini/Claude-Opus-only effect; MIT `LICENSE`.
- Runner primitives to reuse: `src/runner/workspace.ts` (`createRunWorkspace`, `buildConfig` `extra`), `src/runner/env.ts` (`buildChildEnv`), `src/runner/isolation.ts` (`checkIsolation`, `offeredTools`), `src/runner/events.ts` (`toolUses`, `parseEvents`).
- Why not the pilot path: `src/runner/prereg.ts` (`enforcePrereg`, `preregCommitViolation`), `src/runner/checks.ts:265-271`, `src/runner/pilot.ts` (`PILOT_ARMS`, single agent model).
