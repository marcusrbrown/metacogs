---
date: 2026-10-25
topic: opencode-plugin
---

# metacogs as an OpenCode plugin

## Summary

metacogs v0.2 ships as an OpenCode plugin, published to npm as `metacogs` and enabled with one `opencode.json` entry. It includes:
- `feel` and `drugs` as native tools, with the upstream frames verbatim;
- a guidance block added to the system prompt at session start, which can be switched off;
- a `feel` and a `drugs` skill that explain how to use each tool, invocable as `/feel` and `/drugs`;
- the method skills.

Two guided reads and a set of hands-on probes informed what ships. Their results are in `evals/spikes/feel-drugs/README.md`.

---

## Problem Frame

v0.1 shipped a skills-only pack. It deferred native tools "only after evals show a tool boundary beats instructions for a specific method" (`docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md`). The feel/drugs spike (`evals/spikes/feel-drugs/`) was not that eval. It was a human-read experiment on four prompts and four models, and it shaped this decision:

- Unprompted, only `openai/gpt-6-luna` reached for either form, in 5 of its 16 runs.
- Told to use them, via one appended imperative sentence, luna, sol and opus called the tools in 6 to 8 of 8 runs. Haiku called them in 1 of 8.
- The skill form was mostly loaded and then ignored. Its frames blended into the prose answer.
- Owner read: `feel - all: yes, mostly; tool vs skill: tool` and `drugs - (the ones that used it); tool vs skill: tool`.

Unprompted, only luna called a tool, in 2 of 8 runs. The other three models did not call either tool. The high rates came from an appended user-turn nudge. A session-start guidance block has never run, so guided read 1 is its first measurement, not a confirmation.

Systematic gets tools used on OpenCode with a plugin that registers them and appends guidance to the system prompt at session start. metacogs adopts that shape for frame-type concepts and keeps skills for procedure methods.

---

## Requirements

**Plugin and distribution**
- R1. metacogs is the npm package `metacogs`, loaded by OpenCode from the `plugin` array in `opencode.json`. One entry enables everything in this document.
- R2. v0.2 targets OpenCode only, and the package declares the OpenCode versions it supports. Other hosts keep the v0.1 skills-only install.
- R3. The package version is the release version, managed with Changesets. Each release publishes to npm through trusted publishing (OIDC) in its own CI job, with provenance and no stored npm token. The owner approves dropping `private`, making the package public, and adding the publish job.
- R4. The package publishes an explicit allowlist: the built plugin, the bundled skills (each including its `scripts/record.mjs`), the `feel` and `drugs` skills, `LICENSE` and `README.md`. Evals, runner code, docs and run artifacts never ship. CI checks the packed file list against the allowlist.

**Tools**
- R5. The plugin registers `feel` and `drugs` as native OpenCode tools. Their descriptions, input fields and returned text are copied verbatim, with MIT attribution, from the upstream `feel` and `drugs` registrations at `inanna-malick/metacog@3d89bb30cd26369fdcd242fd704f66641dca327c`. The model is offered exactly those fields.
- R6. The tools are stateless and return the frame filled with the model's arguments. The tool and guidance code does no file, process or network I/O and logs no argument values, and the package has no install scripts. The only I/O in the package is each bundled skill's `record.mjs`, which writes decision records as in v0.1. Package metadata describes the tools neutrally and does not reuse upstream's "jailbreak" label.

**Session-start guidance**
- R7. The plugin appends one marked guidance block to the system prompt.
  - The text is fixed for the session and identical on every request, so the prompt prefix stays cacheable.
  - The block is left out of the host's internal title and summary calls and never appears twice. Subagent sessions get it the same way, as with Systematic.
  - A failure in the plugin's hooks skips the block and never blocks OpenCode startup.
  - When the block is not applied, the plugin logs that fact without argument values.
- R8. The guidance names each tool and the observable situations it fits: the same failure persisting after materially different attempts, conflicting constraints blocking a commitment, a hypothesis about to be repeated, or exploration stalled on the same few alternatives. It states that neither tool supplies facts, and it names the bundled method skills and what each is for. It carries no wording that discourages use. The owner approves the text.
- R9. One plugin option turns the guidance block off. The tools and skills stay available when it is off.

**`feel` and `drugs` skills**
- R10. `feel` and `drugs` are skills shipped in the package and registered through `skills.paths`. OpenCode exposes skills as slash commands, so `/feel` and `/drugs` invoke them.
  - Each skill says when its tool fits, what each field means and how to fill it, and what to do after the call: name what the next move changes, then inspect, test or ask.
  - With arguments, the skill tells the model to use the argument text, as one string, for the main field (`somewhere` for feel, `substance` for drugs), composing the other fields itself. Without arguments, the model chooses every field from the session.
  - A skill is an instruction, not a guaranteed call. A user's own command with the same name takes precedence.

**Method skills**
- R11. On OpenCode the plugin makes the bundled method skills (`synthesis` and `counterfactual`) available without a copy step, helpers included. The `.agents/skills/` copy install stays documented for other hosts, and as the skills-only route on OpenCode. The behaviour when both are present is defined and documented.

**Promotion of other concepts**
- R12. Another upstream concept becomes a tool after hands-on exploration of what activates it and what it changes. Promotion costs a tool definition, a guidance line, a skill, and the docs that list the tools.

**Guided reads**
- R13. Guided read 1 reuses the spike harness on the four frozen prompts and four models, two runs per cell, with no user nudge. It compares two arms:
  - nothing;
  - the plugin: tools, guidance, commands, and a skill loader limited to the plugin's two skills.

  Every other host tool is removed in both arms. A run fails unless the model is offered exactly the expected tools and tool schemas. Read 1 is the first measurement of the guidance under a restricted tool set. It is not an upper bound, because removing built-ins and adding skills need not raise tool selection.
- R14. Guided read 2 runs only if read 1 meets the rule. It compares the plugin package with nothing, both under OpenCode's default tools, with a fresh no-plugin baseline. It covers the four prose prompts and two coding prompts. A tool call on a coding prompt is flagged as unwanted unless the owner's read says otherwise. Command runs are two turns, the prompt and then `/feel` or `/drugs` with and without arguments. They appear in a checks-only table and are not part of the rule.
- R15. Each read is scored by a rule stated before any run:
  - The owner reads an answers-only sheet with the arms hidden. Both runs per side are shown, and the owner gives one verdict per prompt and model cell: X, Y or same. A hidden control cell sets two nothing runs against each other to show how noisy the picks are. The key is revealed afterwards.
  - Only cells where the plugin arm used a tool or loaded a skill count. The rule is met when wins minus losses is at least 3 and no model is at −3 or worse.
  - Call counts and unwanted calls are checks, reported per model.
  - The result informs the owner's decision on what ships. It does not decide it. The outcome and the models on which the tools fire are recorded in `HYPOTHESES.md` and in new sections of `evals/spikes/feel-drugs/README.md`.

  Both reads ran against the first guidance text, which the owner later replaced (R8). Hands-on probes at engineered stuck points followed; their findings are in the spike README.

**Repository surfaces**
- R16. The README describes what the plugin does and where it comes from. That covers the upstream project, the spike and the guided reads, and the evals behind the method skills, plus model compatibility per the reads. It is written for anyone who uses it.
- R17. These describe two delivery surfaces, the OpenCode plugin and the portable skills: the install guide, the host matrix, the AGENTS.md generated-files list with the generator's drift check, `package.json`, `.changeset/config.json`, the autoheal path rules and the repo description.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R7.** A user adds `metacogs` to `opencode.json` and starts a session. The model is offered `feel` (with `somewhere`, `quality`, `sigil`, and optional `since_last`) and `drugs` (with `substance`, `method`, `displaces`). The system prompt ends with exactly one metacogs block.
- AE2. **Covers R10.** `/drugs caffeine` loads the `drugs` skill with the argument, and the model calls `drugs` with `substance` set to "caffeine". `/drugs` with no arguments leads the model to choose the substance from the session.
- AE3. **Covers R11.** With only the plugin installed, `synthesis` is listed and loads, and its record step runs. On another host, a copied `skills/synthesis` gives the same skill.
- AE4. **Covers R4, R6.** The packed file list contains only allowlisted paths. A test over the built tool and guidance code finds no file, process or network imports, and the package has no lifecycle scripts.
- AE5. **Covers R7, R9.** A host title request carries no metacogs block. A hook that throws leaves the session running without the block and logs it. With the option off, the session has the tools and skills but no block.
- AE6. **Covers R13–R15.** The sheet the owner reads shows answers only, labelled X and Y per cell. After the owner records a choice for every cell, the key and the call counts are revealed, and the rule's result is computed per read.
- AE7. **Covers R14.** On a coding prompt, a plugin-arm call to `drugs` appears in the unwanted-calls column.

---

## Success Criteria

- One `opencode.json` entry gives a session both tools, the guidance (switchable off), the `feel` and `drugs` skills and both method skills.
- What the reads and probes observed is recorded per model.
- Promoting a third concept costs only what R12 lists.

R2, R3, R16 and R17 are verified in planning and review, not by an acceptance example.

---

## Scope Boundaries

- Hosts other than OpenCode, and MCP distribution.
- The other nine upstream concepts as tools.
- A scored eval (prereg, rubric, judge, held-out) for the tools.
- Per-tool switches, beyond the single guidance option.
- Telemetry. Feedback comes through issues.
- Changes to the shipped method skills or their evidence.

### Deferred to Separate Tasks

- Ports to Claude Code (plugin with bundled MCP and a `SessionStart` hook), Pi (native extension tools) and Gemini (extension MCP and `GEMINI.md`), once OpenCode ships.
- Activation exploration for the other upstream concepts.

---

## Key Decisions

- For frame-type tools, the owner decides what ships, informed by the reads and probes, in place of v0.1's "only after evals" condition.
- Tools for frames, skills for methods. On the spike's prompts and models, told-to-use runs called the tools more often than they used the skill frames, and the owner's read favoured the tool. Synthesis and counterfactual are proven as skills.
- Full plugin with guidance. The option switches it off. In the probes, models rarely called the tools unprompted, so `/feel` and `/drugs` are the reliable way in.
- OpenCode first: it is the eval host, and Systematic proves the plugin pattern there.
- npm plugin with trusted publishing, for versioned installs and no stored token.
- On OpenCode the plugin brings the skills. The `.agents/skills/` copy stays for other hosts and as the skills-only route.
- Tools use plain names, `feel` and `drugs`, the same as the skills; MCP hosts prefix tool names by server name anyway. A tool and a skill live in separate namespaces on the pinned host, and the skill text says which of the two to use.
- The `feel` and `drugs` skills are hand-written. The guidance needs the owner's approval.
- metacogs is built in the open for anyone. The README documents what it does, where it comes from, its evals, and which models it works with.

---

## Dependencies / Assumptions

- Systematic shows the hooks working on `@opencode-ai/plugin` 1.19.3: a `tool` map, `experimental.chat.system.transform` appending to the first system entry, and a `config` hook that adds `command` entries and `skills.paths`. The metacogs runner pins `opencode-ai` 1.19.4. Planning confirms the hooks there and pins the plugin SDK to match. The system-transform hook is marked experimental, which is why R2 declares a supported host range and R7 logs a skipped block.
- New runtime dependencies are `@opencode-ai/plugin` and the zod major it expects. Adding them is ask-first and touches the lockfile. `@modelcontextprotocol/sdk` stays a spike-only dev dependency.
- The harness can load the built package from the working tree the way Systematic's integration fixture does: pack, extract, then a `file://` plugin entry. The host isolation check must allow the plugin's own commands.
- The plugin's integration test also runs with Systematic loaded, to confirm both blocks, both skill sources and both command sets coexist.
- `npm view metacogs` returns not found. Planning re-checks before the first publish and confirms whether trusted publishing needs a first manual publish.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R11][Needs research] Which copy wins on the pinned host when a plugin skill and a copy-installed skill share a name, and the documented rule.
- [Affects R13][Technical] Exact built-in tool names on 1.19.4, and the permission rules that remove each one while keeping the plugin's tools and skill loader.
- [Affects R7][Technical] Confirm that prefix caching holds with the block (cache-read tokens with and without).
- [Affects R14][Technical] The two coding prompts, drafted for owner approval and frozen like the prose prompts.

---

## Sources / Research

- Spike evidence: `evals/spikes/feel-drugs/README.md`, `evals/spikes/feel-drugs/sheet.md`, `HYPOTHESES.md`.
- Systematic, the precedent for the plugin:
  - `src/index.ts`: hooks.
  - `src/lib/bootstrap.ts`: block placement, internal-call skip, safe compute, enable switch.
  - `src/lib/config-handler.ts`: commands, `skills.paths`, add-if-absent.
  - `src/lib/skill-tool.ts`.
  - `.github/workflows/release.yaml`: publish job with `id-token: write`.
  - `tests/integration/opencode.test.ts` and its fixtures: scripted provider, probe plugin, packed-tarball load.
- Host mechanisms as documented in October 2026: OpenCode custom tools and plugins; Claude Code plugins, MCP and hooks; Codex MCP and customization; Pi extensions and packages; Gemini extensions.
- Surfaces that assume skills-only today: `README.md`, `docs/install.md`, `src/matrix/`, `src/generate/`, `package.json`, `.changeset/config.json`, `.github/workflows/release.yaml`, `.github/workflows/fro-bot.yaml`, `AGENTS.md`.
