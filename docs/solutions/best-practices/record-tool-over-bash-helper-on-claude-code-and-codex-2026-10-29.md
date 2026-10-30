---
title: "Record decisions on Claude Code and Codex through an MCP `record` tool, not a Bash helper"
date: 2026-10-29
category: best-practices
module: mcp
problem_type: architecture_pattern
component: tooling
severity: medium
tags: [mcp, record-tool, claude-code, codex, sandbox, permissions, annotations, host-rewrite]
related_components: [development_workflow, configuration]
applies_when:
  - "A skill must write a file unattended on a host whose shell is approval-gated or sandboxed"
  - "A host plugin needs a write path that the model cannot aim at an arbitrary location"
  - "Host-specific skill wording must change without editing canonical `skills/**`"
---

# Record decisions on Claude Code and Codex through an MCP `record` tool, not a Bash helper

## Context

`synthesis` and `counterfactual` end by writing a decision record. The canonical skill text does this with a bundled Bash helper fed a JSON heredoc: the `node "<skill-base-dir>/scripts/record.mjs" <<'EOF'` step in `skills/synthesis/SKILL.md:27-29` and `skills/counterfactual/SKILL.md:28-30`. That works on OpenCode. On Claude Code and Codex it did not record unattended:

- **Claude Code 2.1.312.** Every Bash command that contains a brace followed by a quote is held for approval ("Contains brace with quote character"), and every JSON heredoc qualifies. An allow rule did not clear the hold, and the prompt offered no "always allow". Headless runs ended `unrecorded`.
- **Codex 0.162.1.** The helper's write to the records directory, which is outside the workspace, was denied under the `workspace-write` and `read-only` sandboxes.

Both findings come from local host-check evidence, not committed. The PR #49 body records the same two findings.

## Guidance

Add a `record` tool to the shipped MCP server, so the write happens in the server process instead of a shell command. Share the validate-stamp-write core with the CLI, and rewrite only the record step in the host renders.

1. **Register the tool with write-but-safe annotations.** `server.registerTool('record', …)` is at `src/mcp/server.ts:59-63`, with `RECORD_ANNOTATIONS` at `src/mcp/record-tool.ts:36`:

   ```ts
   export const RECORD_ANNOTATIONS = {
     readOnlyHint: false,
     destructiveHint: false,
     idempotentHint: true,
     openWorldHint: false,
   } as const
   ```

   `feel` and `drugs` stay `readOnlyHint: true` (`src/mcp/server.ts:26`). `src/mcp/record.test.ts:78` pins the record annotations.

2. **Give the tool no path argument.** `recordInputSchema` (`src/mcp/record-tool.ts:21-34`) lists only record fields. The output root comes from the server's environment, resolved by `resolveRoot` in `runRecord` (`src/record/run.ts:54`), so the model cannot choose where a record goes. `src/mcp/record.test.ts:87` asserts there is no `path` property.

3. **Parse arguments strictly.** `recordInputSchema` is a `z.strictObject` (`src/mcp/record-tool.ts:21`), so an extra argument is an error, not silently dropped. `src/mcp/record.test.ts:237-240` sends `path`, `helper_version` and an invented field and expects rejection.

4. **Share one core with the CLI.** `runRecord` (`src/record/run.ts:43-62`) validates, stamps `helper_version`, resolves the root and writes. The CLI and `recordTool` (`src/mcp/record-tool.ts:55-60`) both call it, so the same input gives the same filename and bytes. `src/mcp/record.test.ts:321-329` compares the two paths.

5. **Keep payload limits in the contract, not the transport.** `LIMITS` (`src/record/contract.ts:34-41`) is enforced by `validateRecord` (`src/record/validate.ts:45-52`, `86-89`, `111-113`), so the CLI and the tool agree:

   ```ts
   export const LIMITS = {
     MAX_STRING_LENGTH: 4096, // per string or entry, in code points
     MAX_ARRAY_ITEMS: 64, // per array field
     MAX_PAYLOAD_BYTES: 65536, // compact JSON, UTF-8 bytes
   } as const
   ```

6. **Make validation total.**
   - Validate the stamped record, not only the input. `runRecord` validates again after stamping `helper_version` (`src/record/run.ts:47-51`). Without this, a record exactly at the limit passed on input and then failed the same validator on read-back.
   - Check shape before size. `validateRecord` rejects unknown fields and wrong types first (`src/record/validate.ts:55-101`) and calls `JSON.stringify` last, inside a `try` that turns a throw into a validation error (`src/record/validate.ts:105-113`). Deeply nested junk in an unknown field used to throw `RangeError` out of the helper. `src/record/run.test.ts:196-212` covers 10,000-deep nesting.
   - Report a lone surrogate as a validation error. `checkText` uses `isWellFormed()` (`src/record/validate.ts:51`), with the test at `src/record/run.test.ts:216-225`.
   - `runRecord` wraps the validator so that hostile input ends as a validation error, never a throw (`src/record/run.ts:34-41`).

7. **Rewrite only the record step per host.** `recordRules` (`src/hosts/rules.ts:184-240`) swaps the helper command and its exit-code outcomes for a tool call and tool outcomes. `bun run generate` writes the renders to `hosts/claude/skills/*` and `hosts/codex/skills/*`, which are never hand-edited. Canonical `skills/**` stays untouched, because skill text is an eval contract and an edit there needs a new epoch.

8. **Allow the tool on Claude Code with a single-tool rule.** `docs/install.md:132-136` documents:

   ```json
   { "permissions": { "allow": ["mcp__plugin_metacogs_metacogs__record"] } }
   ```

   The wildcard `mcp__plugin_metacogs_metacogs__*` also works, and it also allows record writes (`docs/install.md:129-132`). With no rule, Claude Code prompts on each call, and in `-p` mode it denies the call and the model reports `unrecorded` (`docs/install.md:124`).

## Why This Matters

- An MCP tool call is not a shell command, so Claude Code's brace-and-quote hold does not apply.
- The MCP server runs outside the Codex exec sandbox. Records land under `workspace-write`, under `read-only` and in untrusted projects (`docs/install.md:207`). Under the `record` annotations, Codex's default approval mode runs the tool without a prompt (`docs/install.md:196`).
- With no path argument, a hostile prompt cannot redirect the write.
- One shared core and total validation give the CLI and the tool a single contract, and a written record always validates on read-back (`src/record/run.ts:47-48`).

Results:
- **Claude Code 2.1.312.** With the allow rule the record was written with no prompt. Without it the call was denied and reported `unrecorded`. A hand check showed `/metacogs:counterfactual` writing a record with no Bash prompt (`docs/install.md:152`).
- **Codex.** `$metacogs:counterfactual` recorded under both `workspace-write` and `read-only` with no prompt on 0.162.1. A hand check on 0.165.0 matched (PR #51).

## When to Apply

- A skill must write a record unattended on a host whose shell holds heredocs or sandboxes writes outside the workspace.
- A tool takes model-authored content and writes it to disk. Use a strict schema, no path argument, limits in the shared contract, and validation of the stored form.
- A host render needs different wording for one step. Use exact-count rewrite rules, and never edit canonical `skills/**`.

## Examples

**Before.** The canonical step is a shell call with a heredoc (`skills/synthesis/SKILL.md:27-29`):

```text
node "<skill-base-dir>/scripts/record.mjs" <<'EOF'
{ …JSON… }
EOF
```

**After.** On the Codex render, step 7 reads "call the `mcp__metacogs__record` tool once, before replying. Its arguments are the fields of this JSON:" (`hosts/codex/skills/synthesis/SKILL.md:24`), with outcomes at `hosts/codex/skills/synthesis/SKILL.md:33-34`. On Claude Code the tool is `mcp__plugin_metacogs_metacogs__record` (`hosts/claude/skills/synthesis/SKILL.md:24`).

**Failure shape.** A failure is a tool result with `isError`, reading `metacogs-record: <kind> (exit N)` and then one `  <field>: <message>` line per error (`src/mcp/record-tool.ts:51-59`). The kinds are `validation` (2), `io` (3) and `collision` (4) (`src/record/contract.ts:82-88`).

**Records directory on Codex.** Codex forwards only a few environment variables to MCP servers. `XDG_STATE_HOME` and `METACOGS_RECORDS_DIR` did not reach the server in the tested configuration, so Codex records go to `~/.local/state/metacogs/records/` (`docs/install.md:209`). Claude Code passes the environment through (`docs/install.md:140`).

**Rejected.**
- A Claude Code `PreToolUse` hook that auto-allows the helper. It is Claude-only, and the plugin would be approving its own shell commands.
- A heredoc-free CLI. It still needs a Bash rule and a write approval, and it does nothing for the Codex sandbox.

## Related

- **Codex skips hooks in agent-plugins packages.** Codex discards the hooks of a plugin in the agent-plugins format (a root `plugin.json` with an agent-plugins `$schema`), so a hook there never runs. The Codex package therefore has no session-start note (`src/hosts/codex.ts:5-8`, `docs/install.md:192`), and `METACOGS_GUIDANCE` and the `guidance-off` file do nothing on Codex. PR #45 traces the loader behavior to `core-plugins/src/loader.rs` in openai/codex at `rust-v0.162.1`.
- `docs/install.md` (Approvals, Records and Status sections for both hosts)
- PRs #45, #49, #51
