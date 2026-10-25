---
title: feel/drugs mechanism spike
type: feat
status: active
date: 2026-10-25
origin: docs/brainstorms/2026-10-25-feel-drugs-spike-requirements.md
---

# feel/drugs mechanism spike

## Overview

A standalone driver runs the upstream `feel` and `drugs` tools in three arms (A nothing, B upstream registrations over a local stdio MCP, C the same frame as a skill) on `openai/gpt-6-luna` and `anthropic/claude-haiku-5-5`, four owner-approved prompts, two runs per cell (48 runs). It retains transcripts under the state root and renders one committed read sheet. The owner reads it and records one outcome line per tool. No method, prereg, rubric, judge or tally (see origin).

## Requirements Trace

R1-R3 arms, models, upstream pin → Units 2, 3, 4. R4-R5 prompts and runs → Units 5, 6. R6-R7 observation and sheet → Units 1, 4, 5. R8 read and outcome → Unit 6. R9-R11 isolation, driver, credentials → Units 1, 4.

## Key Technical Decisions

- **Two small runner seams instead of a spike-local copy of the workspace builder.** `RunWorkspaceInput` gains optional `configExtra`, `permission` and `skillSource` (dir to copy into `.agents/skills/<name>`); when absent, behaviour and generated config are byte-identical. `offeredTools` reads both `t.function.name` and `t.name` and unions over every request that carries tools (today it returns `[]` on the Responses and Anthropic wires). Both are tested; no existing caller changes.
- **Same permission block for every arm**, hand-built in the driver: `edit`, `external_directory`, `webfetch`, `task` denied; `bash` `{'*':'deny'}`; `skill` `{'*':'deny'}` plus allow for the arm-C skill name in arm C only. Arms differ only in what the model is offered.
- **Stdio server copies the two upstream registrations verbatim** into `src/spike/feel-drugs/server.ts` (descriptions, zod schemas, return templates) with a provenance header naming `inanna-malick/metacog@3d89bb30cd26369fdcd242fd704f66641dca327c` `src/index.ts` line ranges and the MIT notice. Upstream's file imports Cloudflare `agents/mcp`, so it cannot be imported. Devdeps: `@modelcontextprotocol/sdk`, `zod`, exact-pinned (owner-approved).
- **MCP config**: `mcp.metacog = {type:'local', command:['bun', <abs server path>], enabled:true, timeout:30000}`; expected offered names `metacog_feel`, `metacog_drugs` (binary-derived; the probe confirms).
- **Arm C skill** at `evals/spikes/feel-drugs/skill/metacog-frames/SKILL.md`: frontmatter description built from the two upstream tool descriptions; body gives the two frames verbatim and asks the model to write the fields (`somewhere / quality / sigil`; `substance / method / displaces`) in its reply before continuing. Not under `skills/`, so the generator and the prereg rule do not apply.
- **Runs** write to `<stateRoot>/spikes/feel-drugs/<model-slug>-<ts>/<arm>-<prompt>-<n>/` with `stdout.jsonl`, `stderr.txt`, `requests.json`, `run.json`. Not under `<state>/runs` (campaign scanners).
- **`run.json`** fields: arm, model, prompt id, prompt hash, status (`completed` | `tools_missing` | `timeout` | `host_error` | `rate_limited`), offered tool names, tool calls `{tool, input, status}`, skill loaded (arm C), in-reply fields present (arm C, regex on the field labels), answer (`allAssistantText`). Leak scan via `scanForLeaks` before writing.
- **Sheet** `evals/spikes/feel-drugs/sheet.md` grouped by prompt, then model, then arm, so A/B/C answers to one prompt sit together. Workspace and home paths are replaced with `<ws>` and `<home>` before rendering; `scan:secrets` covers the file.

## Implementation Units

### Unit 1: runner seams
Files: `src/runner/workspace.ts`, `src/runner/isolation.ts`, tests beside them.
- `RunWorkspaceInput.{configExtra?, permission?, skillSource?}`; `permission` replaces `permissionFor(...)` when present; `skillSource` copies via `copySkillDir` and skips the `skills/<method>` lookup; `method` remains required (driver passes `feel-drugs-spike`).
- `offeredTools` over `function.name` and `name`, union across requests.
Tests: generated config byte-identical without the new fields; `mcp` block lands in `OPENCODE_CONFIG` with them; skill from an outside dir installed; `offeredTools` on chat-completions, Responses and Anthropic request shapes.

### Unit 2: stdio server
Files: `src/spike/feel-drugs/server.ts`, `server.test.ts`, `package.json`, `bun.lock`.
- `McpServer` + `StdioServerTransport`; exactly `feel` and `drugs`.
Tests: spawn the server, list tools over a stdio client (names, descriptions, schemas equal the copied upstream strings), call each tool and assert the template output for fixed arguments.

### Unit 3: arm C skill
Files: `evals/spikes/feel-drugs/skill/metacog-frames/SKILL.md`.
Test: driver test asserts the frame strings in the skill body equal the server's return-template literals (shared constants exported from `server.ts`).

### Unit 4: driver
Files: `src/spike/feel-drugs/driver.ts`, `driver.test.ts`, `package.json` script `spike:feel-drugs`.
- Flags: `--model <id>` (repeatable), `--arm A|B|C` (repeatable, default all), `--prompt <id>` (repeatable), `--runs <n>` (default 2), `--provider scripted|live` (default scripted), `--probe` (one run per requested arm/model, prints offered tools and tool-call names).
- Live: `resolveCliproxy`, `startRecordingProxy(CLIPROXY_UPSTREAM)`, `cliproxyProviderConfig`, `writeIsolatedAuth`; `--model` argv; per-run timeout 300 s; sequential; on rate limit, back off 30/60/120 s then record `rate_limited`.
- `tools_missing` when arm B's offered tools lack either expected name; `checkIsolation` and `checkDebugConfig` run per arm as in the runner (debug config must accept the `mcp` key).
- Refuses `--provider live` without a frozen prompt file whose hash matches `evals/spikes/feel-drugs/README.md`.
Tests (scripted provider, $0): arm B scripted step calls `metacog_feel` and the run records the call and input; arm A offers neither tool; arm C installs the skill and records the load; `tools_missing` when the MCP entry is removed; credential needle absent from every artifact.

### Unit 5: prompts and sheet
Files: `evals/spikes/feel-drugs/prompts.md` (four prompts, one-line rationale each), `evals/spikes/feel-drugs/README.md` (purpose, arms, frozen prompt hash, how to run, results table placeholder), `src/spike/feel-drugs/sheet.ts` + test, script `spike:feel-drugs:sheet`.
- Prompt lexical check (AE4) as a test.
- **Owner gate: prompts approved or replaced before Unit 6.**

### Unit 6: probe, campaign, read
- Probe: `--probe --provider live` for arm B on each model; record offered names and whether the debug-config check passed in the README.
- Campaign: one invocation per model, 24 runs each; render the sheet; commit sheet and README summary table (per-cell call counts, hand-written from `run.json`).
- **Owner read.** Owner's outcome lines go into `HYPOTHESES.md` (paragraph under the table; statuses stay `hypothesis` unless the owner says otherwise) and the README.
- Arm D only if the owner asks after the read (deferred unit, not in this plan's scope).

## Verification

`bun test`, `bun run typecheck`, `bun run generate:check`, `bun run matrix:check`, `bun run scan:secrets` exit 0 after each unit. Live cost is about 48 agent runs, no judge calls.

## Risks

- OpenCode 1.19.4 may not load a local MCP inside the isolated config, or `debug config` may add keys that fail the check: the probe decides; fallback is a relaxed config named in the sheet (origin R10).
- The MCP child gets only HOME, PATH, SHELL, TERM, USER, LOGNAME; `bun` must be on the allowlisted PATH.
- Two runs per cell on four prompts is a small read; a null is about these prompts and models only (origin R8).
