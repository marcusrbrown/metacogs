---
date: 2026-10-27
topic: multi-host-packaging
---

# metacogs plugins for Claude Code and Codex

## Summary

metacogs ships as a Claude Code plugin and as an experimental Codex plugin, both generated from this repository. Each carries the four skills, the `feel` and `drugs` tools through one shared MCP server, and a short factual guidance note at session start. The OpenCode npm plugin is unchanged.

---

## Problem Frame

metacogs 0.2 is an OpenCode plugin: native `feel` and `drugs` tools, four skills, a guidance block appended to the system prompt, and `/feel` and `/drugs` through the skills. On Claude Code and Codex the only install today is copying the method skills into a skills directory (`docs/install.md`). That copy gives no tools, no `feel` or `drugs` skill, and no guidance. In `matrix.json` the copied skills on both hosts have a listing smoke only, and there is no plugin entry for either host.

The owner does not use Claude Code or Codex day to day. These packages are for other users, so they have to stay cheap to keep current: cutting a release stays a merge of the version PR, with any host checks running in CI.

Neither host lets a plugin register a native tool the way OpenCode does. On both, a tool the model calls with a schema comes from an MCP server; a `bin/` script is only a shell command. Two mature multi-host plugins, Impeccable and the Compound Engineering Plugin, ship skills without MCP and without a session-start guidance hook. The owner's spike read preferred the tool form over the skill form (`evals/spikes/feel-drugs/README.md`), which is why the tools stay.

---

## Requirements

**Tools**
- R1. `feel` and `drugs` reach Claude Code and Codex through one shared stdio MCP server, with the same names, fields and adapted text the OpenCode plugin offers.
- R2. The MCP server needs Node 22 or later on the user's `PATH` and nothing else beyond the plugin. It makes no network calls, reads no files and writes nothing.
- R3. Both tools carry read-only annotations. The docs do not promise that this removes approval prompts.
- R4. The spike's MCP server keeps serving the verbatim upstream text and is not reused for these packages.

**Skills and invocation**
- R5. All four skills (`feel`, `drugs`, `synthesis`, `counterfactual`) ship on both hosts from the same source text as the OpenCode plugin.
- R6. Each host's skill text names the tool, the invocation and the argument handling that host uses. The shared source is not copied verbatim where a host differs.
- R7. On Claude Code, users invoke `/metacogs:feel` and `/metacogs:drugs`. The docs mention that a bare `/feel` also works unless another command already uses that name.
- R8. On Codex, users invoke `$metacogs:feel` and `$metacogs:drugs`, with any arguments as plain text after the mention.
- R9. The record helper in `synthesis` and `counterfactual` runs from the installed plugin location on both hosts and keeps today's output root (`--out-dir`, then `METACOGS_RECORDS_DIR`, then `$XDG_STATE_HOME` or `~/.local/state`). Where a host sandbox denies that write, the run is marked unrecorded, as it is today.

**Guidance**
- R10. Each host gets a session-start note: a factual rewording of `plugin/guidance.md` that says which tools and skills exist and the situations each fits, using that host's tool names and invocation forms.
- R11. The note states facts. It does not instruct the model to call anything, and it does not claim system authority.
- R12. Setting `METACOGS_GUIDANCE=off` suppresses the note on both hosts without uninstalling the plugin. Because hooks may not inherit user environment variables, a `~/.config/metacogs/guidance-off` file, and on Claude Code the plugin's `guidance` option, do the same.
- R13. No forced output style, because only one plugin's forced style can win and it would displace Systematic's.

**Packaging and release**
- R14. The Claude Code and Codex packages are generated from the repository's sources and committed. `generate:check` fails when a committed package differs from what the sources generate.
- R15. This repository serves as the marketplace for both hosts, with a catalog file for each.
- R16. `package.json` holds the one version. Changesets bumps it, and every host manifest follows it in the same version commit.
- R17. Both marketplaces serve `main`, so host packages reach users when a change merges. CI fails any change to the host packages or their generator that carries no changeset, so the version moves with the content.

**Verification**
- R18. CI checks the generated MCP bundle on its own under Node 22: it starts, lists both tools with the expected schemas, and returns the exact adapted text for valid calls and errors for invalid ones.
- R19. CI runs the pinned Claude CLI's `claude plugin validate --strict --json` over the marketplace and the plugin. CI may use host credentials if the validator needs them.
- R20. CI validates the Codex `plugin.json` and `mcp.json` against the agent-plugins.org 1.0.0 JSON Schemas they declare. Codex ships no CLI validator and no marketplace schema, so the docs call this schema validation.
- R21. `matrix.json` records both host plugins as untested until someone installs and invokes each one by hand. The README and install guide say what was and was not checked.

**Docs**
- R22. The README and `docs/install.md` give, for each host: a one-command install, the Node 22 prerequisite and what happens without it, the invocation forms, how to turn the guidance off, the approval prompts for the MCP server and the record helper with the allow rules that pre-approve them, the Codex `/hooks` trust step for the guidance note, and the sandbox allowance or `METACOGS_RECORDS_DIR` setting that lets records be written.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R7.** Given a user installs metacogs from this repository's Claude Code marketplace, when they type `/metacogs:drugs caffeine`, the model calls the metacogs `drugs` tool with `substance` set to `caffeine` and gets the adapted text back.
- AE2. **Covers R8, R20, R21.** Given a user installs the Codex plugin, when they write `$metacogs:feel` with no arguments, the model loads the `feel` skill and picks the fields from the session. The matrix still shows Codex as untested until someone confirms this by hand.
- AE7. **Covers R10, R22.** Given a user installs the Codex plugin and has not yet trusted its hook, when a session starts, Codex skips the note and warns that hooks need review in `/hooks`. The tools and skills work. After the user trusts the hook, the next session gets the note.
- AE3. **Covers R12.** Given a user has turned the guidance note off, when a new session starts, no metacogs note appears, and the tools and skills still work.
- AE4. **Covers R14, R16.** Given a changeset bumps the version, when the version PR is generated, both host manifests carry the new version and `generate:check` passes on that PR.
- AE5. **Covers R9.** Given `counterfactual` runs on Claude Code from the plugin cache with no sandbox and no records override, when the method writes its record, the helper resolves from the skill's own directory and writes under `$XDG_STATE_HOME` (or `~/.local/state`).
- AE6. **Covers R9, R22.** Given Codex runs in its default workspace-write sandbox and the user has not allowed the records directory, when `synthesis` tries to write its record, the write is denied or needs approval, and a denied run is reported as unrecorded.

---

## Success Criteria

- A Claude Code user and a Codex user can each install metacogs with one command and reach `feel`, `drugs` and the four skills.
- Cutting a release takes the same steps as today: merge the version PR. Host validation runs in CI, never on the owner's machine.
- A planner can build this without inventing behaviour: names, invocation, guidance content and the CI gates are fixed here.

---

## Scope Boundaries

- Install-and-invoke smoke tests on either host. Deferred; R21 keeps the status honest until then. The commands are known: `claude -p --bare --plugin-dir` with `ANTHROPIC_API_KEY`, and `codex exec --dangerously-bypass-hook-trust` with `CODEX_API_KEY`.
- Listing in Codex's public plugin directory. Local stdio MCP servers and lifecycle hooks are submission-limited there; installing from this repository is not.
- A shell `bin/` fallback for the tools.
- Claude Code's non-server plugin tool API ("mods"). It is Claude-only and its availability on current releases is unverified.
- Other hosts (Gemini CLI, Cursor, Pi, Copilot CLI).
- An npm-sourced Codex marketplace entry. This repository is the marketplace.
- Changes to the OpenCode plugin's behaviour, including its guidance wording. It only shares frame text and skill sources with the new packages.

---

## Key Decisions

- Shared MCP over skill-only: the owner preferred the tool form in the spike, and one server covers both hosts.
- Committed generated packages over a sync bot or an orphan branch: it matches how `record.mjs` is already handled and adds no workflow or credential.
- Factual guidance note: Claude's docs warn against out-of-band imperative instructions, and Systematic keeps its session-start hook to facts for the same reason.
- Ship the Codex guidance hook: it costs one static file, the tools and skills work without it, and the CLI loads it once the user trusts it.
- Codex is experimental: its docs contradict each other on plugin hooks (the CLI source has no desktop gate), it has no CLI validator, and nobody has run the package on a real install.

---

## Dependencies / Assumptions

Checked 2026-10-27 against code.claude.com docs and `openai/codex@4d3ed3f3`; neither CLI was run.

- **Claude Code.** Plugin stdio MCP servers and `SessionStart` hooks load when the plugin is enabled. `${CLAUDE_PLUGIN_ROOT}` resolves in the server's `command` and `args`. The tool is `mcp__plugin_metacogs_metacogs__feel`, and `mcp__plugin_metacogs_metacogs__*` pre-approves both. Hook stdout becomes context, capped at 10,000 characters, and the docs ask for factual statements. Skills get `${CLAUDE_SKILL_DIR}` substituted in their text, not in the Bash environment. `claude plugin validate --strict --json` validates a directory holding both marketplace and plugin from v2.1.289. Whether it needs login is unverified.
- **Codex CLI.** A root `mcp.json` (agent-plugins.org 1.0.0 schema) can declare a stdio server. `${PLUGIN_ROOT}` is substituted in `command`, `args` and `env`. The tool is `mcp__metacogs__feel` when the server key is `metacogs`. Plugin skills are namespaced as `metacogs:feel` and invoked with `$`. The model receives each skill's path, so the helper resolves from that path's directory. There is no `$ARGUMENTS` substitution. Plugin hooks load after `/hooks` trust, with no desktop gate in the source. Git marketplaces auto-upgrade at startup.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R14, R15][Technical] Where the generated host packages live in the repository, and whether one directory can serve both hosts.
- [Affects R6][Technical] How the generator rewrites tool names and invocation lines in skill text, and how a test catches a missed rewrite.
- [Affects R19][Needs research] Which Claude CLI version to pin (2.1.289 or later), and whether its validator needs credentials in CI.
- [Affects R8][Needs research] Whether Codex also resolves a bare `$feel` for a plugin skill, and whether text after the mention reaches the model unchanged.

---

## Sources / Research

- `src/frames/feel-drugs.ts`, `src/plugin/`, `plugin/guidance.md`, `plugin/skills/`, `skills/`: current OpenCode surfaces.
- `src/spike/feel-drugs/server.ts`: the spike MCP server (verbatim upstream text).
- marcusrbrown/systematic `scripts/build-claude-code-plugin.ts`: build-time skill translation, factual `SessionStart` hook.
- marcusrbrown/dev-like `.claude-plugin/`: root plugin, unversioned marketplace entry, version sync script.
- pbakaus/impeccable @ d34c87e1 and EveryInc/compound-engineering-plugin @ 00d0a5bb: generated host trees, literal manifest versions synced by script (CEP `scripts/release/sync-metadata.ts`), no MCP, no per-host smoke tests.
- Claude Code docs: plugin MCP servers and tool naming, hooks ("add context for Claude"), output styles (`force-for-plugin`), skills command names, `claude plugin validate`.
- Codex docs: plugins (build: path rules, bundled MCP servers and lifecycle hooks, marketplace metadata; deploy: desktop-only plugins), hooks (review and trust, plugin-bundled hooks, `SessionStart`), MCP, skills, custom prompts (deprecated).
- openai/codex @ 4d3ed3f3: `codex-rs/codex-mcp/src/agent_plugin_config.rs` (stdio entries, `${PLUGIN_ROOT}`), `codex-rs/codex-mcp/src/tools.rs` (the `mcp__` prefix), `codex-rs/ext/skills/src/loader/environment.rs` (the `metacogs:` namespace), `codex-rs/core/src/session/mod.rs` (plugin hook sources), `codex-rs/cli/src/plugin_cmd.rs` (no validate command).
- agent-plugins.org 1.0.0 `plugin.schema.json` and `mcp.schema.json`.
