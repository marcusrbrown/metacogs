# Install

metacogs ships Agent Skills. A skill is a directory with a `SKILL.md` and, for methods that record a decision, a `scripts/record.mjs` helper. Installing means copying that directory to a path your host scans. Nothing else is configured and no host settings change.

Two methods are installable guidance in this release: `synthesis` and `counterfactual`. See [Methods](../README.md#methods).

Three hosts have a second route, a plugin, which provides the same two methods plus the `feel` and `drugs` tools and skills without a copy step: the [OpenCode plugin](#opencode-plugin), the [Claude Code plugin](#claude-code-plugin) and the experimental [Codex plugin](#codex-plugin). Copying skills stays the option for a host without a plugin, or when you want no tools.

## Requirements

- A host from the sections below.
- Node 22 or newer on `PATH`. The copy route and the OpenCode plugin run the record helper with `node`. The helper is one dependency-free file (`scripts/record.mjs`) and needs no `node_modules`. The Claude Code plugin runs its MCP server, which holds the `record` tool, and its session-start hook with `node`. The Codex plugin runs its MCP server with `node`. Without Node the method still runs and the run is marked `unrecorded`.
- On the copy route and in OpenCode, the host must let the agent run one shell command: `node <skill directory>/scripts/record.mjs`. A host that denies shell access gives `unrecorded`. The Claude Code and Codex plugins write records through the `record` tool and need no shell command.

## Copy a skill

From a clone of this repository, in the project that should get the skill:

```sh
mkdir -p .agents/skills
cp -R <metacogs-clone>/skills/synthesis .agents/skills/synthesis
cp -R <metacogs-clone>/skills/counterfactual .agents/skills/counterfactual
```

Copy the whole directory. The skill tells the agent to run the helper from the directory the host reports, so keep `SKILL.md` at the skill directory root and the helper at `scripts/record.mjs` inside it. For Claude Code use `.claude/skills/` instead of `.agents/skills/`.

For all your projects, use the user-level path from the host section instead of the project path.

`skills/*/scripts/record.mjs` is generated from `src/record/`. Never edit it by hand. `bun run generate` rebuilds it and `bun run generate:check` fails when it drifts. The committed helper is minified; `src/record/` is the readable source.

## Records

A method writes its record once, after it finishes: with the helper on the copy route and in OpenCode, and with the plugin's `record` tool on Claude Code and Codex. The record is a JSON file named `<method>-<hash>.json`. The reply the user reads does not depend on the record.

Where records go, first match wins:

1. `--out-dir <dir>` (the helper only; the `record` tool has no path argument)
2. `METACOGS_RECORDS_DIR`
3. `$XDG_STATE_HOME/metacogs/records/`
4. `~/.local/state/metacogs/records/`

A record is rejected, before anything is written, when a string field or list entry is longer than 4096 characters, a list has more than 64 entries, or the record is larger than 64 KiB as compact JSON. The helper and the `record` tool apply the same limits.

The default is outside your repository, so records never land in a commit by accident. The current directory is never used unless you pass a relative path yourself. Directories are created with mode 0700 and files with 0600.

To keep records in a project, opt in explicitly and ignore them:

```sh
export METACOGS_RECORDS_DIR=.metacogs/records
echo '.metacogs/records/' >> .gitignore
```

## `unrecorded`

If the helper or the `record` tool cannot run, the skill does not retry blindly and does not pretend a record exists. It tells the user no record was written, and the run's `execution_mode` is `unrecorded`. This covers: no Node 22, a denied shell command or a denied `record` call, an unwritable records directory (exit 3), and a different record already at the same path (exit 4). A validation error (exit 2) names the field, or `record` when the whole record is over the size limit. Correct that field and retry once. Split a long entry into shorter entries, or trim the record, when a limit caused the error. The `record` tool reports the same errors as `metacogs-record: <kind> (exit N)` with one line per field. An argument that is not a record field, or a value the tool's schema rejects, is refused by the MCP library with its own `Input validation error` text before the tool runs. Both forms name the field and nothing is written.

## OpenCode plugin

The plugin is the `metacogs` npm package. It registers two tools (`feel`, `drugs`) and four skills (`feel`, `drugs`, `synthesis`, `counterfactual`; `/feel` and `/drugs` run the two skills of those names, which are separate from the tools) and a short guidance block. What each one does is in [OpenCode plugin](../README.md#opencode-plugin).

Requirements: OpenCode 1.19.4 (the tested version). Node 22 or newer is still needed for the method skills' record helper, as above. The tools need nothing else.

1. Remove any copy of `synthesis` or `counterfactual` from `.agents/skills/` or another scanned path. The plugin provides skills with the same names, and OpenCode does not guarantee which of two same-named skills wins.
2. Add the package to `opencode.json` in the project, or to `~/.config/opencode/opencode.json` for all projects:

   ```json
   { "plugin": ["metacogs"] }
   ```

   To pin a version, use `"metacogs@0.2.0"`. To keep the tools and skills but drop the guidance block, use `["metacogs", { "guidance": false }]` as the entry.
3. Start OpenCode. OpenCode installs the package on first load.
4. Verify without a model request: `opencode debug skill` lists `feel`, `drugs`, `synthesis` and `counterfactual`, and `opencode debug config` shows the package's `skills/` and `plugin/skills/` directories under `skills.paths` and the package under `plugin_origins`. In a session, the tools are offered as `feel` and `drugs`.

To uninstall, remove the entry. The tools, skills and guidance block go away on the next start. Start a new session afterwards: a resumed session can still hold calls to tools that are no longer offered. The records directory is user data and stays.

## Claude Code plugin

The `metacogs` plugin for Claude Code adds the `feel` and `drugs` tools and a `record` tool (all served by a local MCP server), the four skills `feel`, `drugs`, `synthesis` and `counterfactual`, and a short note at session start. This repository is its marketplace. The plugin is generated into [`hosts/claude/`](../hosts/claude) and the marketplace file is [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json). Docs: https://code.claude.com/docs/en/discover-plugins and https://code.claude.com/docs/en/plugins/marketplace-reference

[Copy a skill](#copy-a-skill) stays the route without tools or a plugin. If you install the plugin, remove copies of `synthesis` and `counterfactual` from `.claude/skills/` so only one version of each method loads.

### Install on Claude Code

In a Claude Code session:

```text
/plugin marketplace add marcusrbrown/metacogs
/plugin install metacogs@metacogs
```

`/plugin install` opens the plugin panel, where you pick an install scope. On Claude Code 2.1.275 or later one command does both steps: `/plugin install metacogs --marketplace marcusrbrown/metacogs`. From a shell, `claude plugin install metacogs --marketplace marcusrbrown/metacogs` does both steps too, or run `claude plugin marketplace add marcusrbrown/metacogs` and then `claude plugin install metacogs@metacogs`. If Claude Code says the plugin needs a reload, run `/reload-plugins`.

To check the install, type `/` and look for `/metacogs:feel`, or run `claude plugin list` in a shell.

### Node 22 on Claude Code

Node 22 or later must be on the `PATH` of the shell that starts Claude Code. The MCP server and the session-start hook both run as `node`. Without Node the hook fails with `node: command not found` (exit 127) and the MCP server does not start, so the `feel`, `drugs` and `record` tools are missing. The skills still load. The reasoning skills say to continue in plain text, and to say so, when their tool is unavailable. A method skill without the `record` tool still runs and the run is `unrecorded`.

### Invoke on Claude Code

| Skill | Command |
| --- | --- |
| `feel` | `/metacogs:feel` |
| `drugs` | `/metacogs:drugs` |
| `synthesis` | `/metacogs:synthesis` |
| `counterfactual` | `/metacogs:counterfactual` |

Text after the command goes to the skill. `/metacogs:drugs caffeine` has the model call the `drugs` tool with `substance` set to `caffeine`. A bare `/feel` or `/drugs` also works unless another command already uses that name. The model can also load a skill on its own when the situation fits its description.

The tools are `mcp__plugin_metacogs_metacogs__feel`, `mcp__plugin_metacogs_metacogs__drugs` and `mcp__plugin_metacogs_metacogs__record`. These are the names that appear in permission rules and in the skill text. `synthesis` and `counterfactual` call `record` at the end of a run.

### Session-start note on Claude Code

When a session starts, a hook prints a short note that says which tools and skills exist and the situations each one fits. It states facts and gives no instructions. Three switches turn it off without removing the plugin. The tools and skills keep working.

- Set `METACOGS_GUIDANCE=off` in the environment of the shell that starts Claude Code.
- Create the file `${XDG_CONFIG_HOME:-~/.config}/metacogs/guidance-off`, for example with `mkdir -p ~/.config/metacogs && touch ~/.config/metacogs/guidance-off`. Delete it to turn the note back on.
- Turn off the plugin's `guidance` option: run `/plugin`, open the Installed tab, select `metacogs`, then choose Configure options. From a shell, run `echo '{"guidance":"false"}' | claude plugin configure metacogs@metacogs --values-stdin`, or install with `claude plugin install metacogs@metacogs --config guidance=false`. Restart Claude Code afterwards. The hook reads the option from `CLAUDE_PLUGIN_OPTION_GUIDANCE`. Claude Code passes the string `true` or `false`, and passes nothing until the option is configured. The hook treats `false`, `0`, `no` and `off` as off, and an unset option as on.

To turn off everything, including the tools and skills, run `/plugin disable metacogs@metacogs`.

### Approvals on Claude Code

Claude Code 2.1.312 shows no approval step for the plugin's MCP server. Each tool call prompts until it is allowed. In non-interactive (`-p`) mode a call that no rule allows is denied, and the model continues without it. For `record` that means the run is reported as `unrecorded`.

`feel` and `drugs` carry read-only annotations. `record` is annotated as a write that is not destructive, is idempotent and touches nothing outside the machine. These are hints to the host, not a promise that the prompt goes away. To allow all three tools, add this rule to `permissions.allow` in `~/.claude/settings.json` (all projects) or in a project settings file:

```json
{ "permissions": { "allow": ["mcp__plugin_metacogs_metacogs__*"] } }
```

The wildcard now also allows writing records. To allow only the `record` tool, so `feel` and `drugs` keep asking:

```json
{ "permissions": { "allow": ["mcp__plugin_metacogs_metacogs__record"] } }
```

### Records on Claude Code

`synthesis` and `counterfactual` write their record through the `record` tool. The MCP server writes the file, not a shell command. The tool has no path argument. The server uses the [records directory](#records): `METACOGS_RECORDS_DIR`, else `$XDG_STATE_HOME/metacogs/records/`, else `~/.local/state/metacogs/records/`. Claude Code passes its environment to the server, so those variables take effect when set where Claude Code starts. The default is outside the project.

Directories are created with mode 0700 and record files with 0600. Records are plain JSON files: delete one with `rm`, or all of them with `rm -r` on the records directory. The plugin keeps no other copy. To keep records in a project, set `METACOGS_RECORDS_DIR` to a directory inside the project and ignore it, as described under [Records](#records).

### Updates and uninstall on Claude Code

Claude Code decides that an installed plugin has an update from the `version` in the plugin manifest. The version changes with each release, so a change merged to `main` between releases does not reach an installed plugin. Auto-update is off by default for third-party marketplaces. Run `/plugin marketplace update metacogs` to refresh the listing, then `claude plugin update metacogs@metacogs` (or Update now on the Installed tab) to update the plugin. You can also turn on auto-update for the marketplace in the Marketplaces tab. A running session keeps the version it loaded; run `/reload-plugins` or start a new session.

To uninstall, run `/plugin uninstall metacogs@metacogs`. `/plugin marketplace remove metacogs` removes the marketplace and every plugin installed from it. Records stay where they are.

### Status of the Claude Code plugin

Status: `verified`. The generated plugin and the marketplace pass `claude plugin validate --strict` (Claude Code 2.1.312), which needs no login. Checked by hand on 2026-10-28 in an interactive Claude Code 2.1.312 session (Sonnet 5.5) with metacogs 0.3.0 installed from the marketplace: install, `/mcp` showing the server connected, the session note quoted in full, the `guidance` option turning the note off, `/metacogs:feel` and `/metacogs:drugs caffeine` calling the tools with the right arguments, `/metacogs:counterfactual` writing a record through the `record` tool with no Bash prompt, and uninstall leaving the records in place. Also checked in scripted headless runs (`claude -p`) of Claude Code 2.1.312: install from the marketplace, the MCP tools, the session note and its off switches, `/metacogs:feel` and `/metacogs:drugs`, and recording through the `record` tool.

The `feel` and `drugs` tools and skills have no eval. `synthesis` and `counterfactual` were evaluated on OpenCode with the text in `skills/` (see [Evidence](../README.md#evidence)). The plugin's copies of these two skills are adapted for Claude Code: the record step calls the `record` tool instead of running the helper, and the compatibility line differs. They are not the exact text that was evaluated.

## Codex plugin

The `metacogs` plugin for Codex is experimental. It adds the `feel` and `drugs` tools and a `record` tool (all served by a local MCP server) and the four skills `feel`, `drugs`, `synthesis` and `counterfactual`. It has no session-start note (see [Session-start note on Codex](#session-start-note-on-codex)). This repository is its marketplace. The plugin is generated into [`hosts/codex/`](../hosts/codex) and the marketplace file is [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json). Docs: https://developers.openai.com/codex/plugins/build

[Copy a skill](#copy-a-skill) stays the route without tools or a plugin. If you install the plugin, remove copies of `synthesis` and `counterfactual` from `.agents/skills/` so only one version of each method loads.

### Install on Codex

In a shell:

```sh
codex plugin marketplace add marcusrbrown/metacogs
codex plugin add metacogs@metacogs
```

The commands are as `codex plugin --help` lists them (Codex CLI 0.162.1). If the first `marketplace add` fails on a dropped clone, run it again. Start a new Codex session afterwards.

### Node 22 on Codex

Node 22 or later must be on the `PATH` of the shell that starts Codex. The MCP server runs as `node`. Without Node the server does not start, so the `feel`, `drugs` and `record` tools are missing. The skills still load. The reasoning skills say to continue in plain text, and to say so, when their tool is unavailable. A method skill without the `record` tool still runs and the run is `unrecorded`.

### Invoke on Codex

| Skill | Mention |
| --- | --- |
| `feel` | `$metacogs:feel` |
| `drugs` | `$metacogs:drugs` |
| `synthesis` | `$metacogs:synthesis` |
| `counterfactual` | `$metacogs:counterfactual` |

Write any arguments as plain text after the mention: `$metacogs:drugs caffeine`. Codex does not fill in arguments; the skill tells the model to read the text that follows the mention. With no text after `$metacogs:feel`, the model picks the fields from the session. A bare `$feel` is not a mention; use `$metacogs:feel`.

The tools are `mcp__metacogs__feel`, `mcp__metacogs__drugs` and `mcp__metacogs__record`.

### Session-start note on Codex

The Codex plugin has no session-start note. Codex discards the hooks of a plugin in the agent-plugins format, which this package uses, so a hook would never run. The `feel` and `drugs` tools and the four skills work without it. `METACOGS_GUIDANCE` and the `guidance-off` file apply to the Claude Code plugin only; they do nothing on Codex.

### Approvals on Codex

Codex asks before an MCP tool call according to your approval policy. `feel` and `drugs` are read-only tools. `record` is a write that is not destructive and touches nothing outside the machine. All three ran without a prompt under the default approval mode in `codex exec` 0.162.1. A tool approval mode of `prompt` or `writes` makes the `record` call fail in a non-interactive run, and the run is reported as `unrecorded`. If you configured a stricter mode, set this in `~/.codex/config.toml`; under the default mode it is not needed, because `record` already runs without a prompt:

```toml
[plugins."metacogs@metacogs".mcp_servers.metacogs]
default_tools_approval_mode = "approve"
```

This approves every tool on the `metacogs` server: `feel`, `drugs` and `record`. Per-tool approval keys have not been verified.

### Records on Codex

`synthesis` and `counterfactual` write their record through the `record` tool. The MCP server runs outside the shell sandbox, so the record is written under `read-only` and under `workspace-write`; no `writable_roots` entry is needed. The tool has no path argument.

In the tested configuration Codex does not forward `XDG_STATE_HOME` or `METACOGS_RECORDS_DIR` to MCP servers, so records go to `~/.local/state/metacogs/records/`. Directories are created with mode 0700 and record files with 0600. Records are plain JSON files: delete one with `rm`, or all of them with `rm -r` on the records directory. The plugin keeps no other copy.

Unattended recording was verified for the default approval configuration only.

### Updates and uninstall on Codex

Codex refreshes the installed copy of a plugin only when the `version` in the plugin manifest changes. At startup Codex upgrades the marketplace clone, but a commit to `main` without a version bump does not reach an installed plugin. The version changes with each release. The installed copy is under `$CODEX_HOME/plugins/cache/metacogs/metacogs/<version>/`. Run `codex plugin marketplace upgrade metacogs` to refresh the marketplace clone by hand.

To uninstall, run `codex plugin remove metacogs@metacogs`. `codex plugin marketplace remove metacogs` removes the marketplace. Records stay where they are.

### Status of the Codex plugin

Status: `verified`, and experimental. The generated `plugin.json` and `mcp.json` validate against the agent-plugins.org 1.0.0 JSON Schemas they declare. Codex ships no validator, so this is schema validation only. Checked by hand on 2026-10-28 in the Codex 0.165.0 TUI (GPT-6-Astra) with metacogs 0.3.0: `codex plugin marketplace add` and `codex plugin add`, the four skills in the `$metacogs:` picker, `/mcp` showing the metacogs server connected with three tools, `$metacogs:feel` and `$metacogs:drugs caffeine`, no session note as expected, `$metacogs:counterfactual` writing a record through the `record` tool with no prompt, and `codex plugin remove` leaving the records in place. Also checked in scripted `codex exec` runs of Codex 0.162.1: `marketplace add` and `plugin add`, the MCP server and its tools, `$metacogs:feel` and `$metacogs:drugs`, and recording through the `record` tool under `workspace-write` and `read-only`.

The `feel` and `drugs` tools and skills have no eval. `synthesis` and `counterfactual` were evaluated on OpenCode with the text in `skills/` (see [Evidence](../README.md#evidence)). The plugin's copies of these two skills are adapted for Codex: the record step calls the `record` tool instead of running the helper, and the compatibility line differs. They are not the exact text that was evaluated.

## Verify an install

Each section lists a listing command. They only list skills; none sends a model request. The smoke runs below used a temporary git project that held only `skills/synthesis/` at the host's project path, plus a control project without it. They did not list `counterfactual`, and the matrix cells say so. Evidence was recorded on 2026-10-23.

## OpenCode

Discovery: project `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` (walking up to the git root), and the user-level `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`. Docs: https://opencode.ai/docs/skills/

Install: copy to `.agents/skills/<method>/` (`synthesis` or `counterfactual`).

Verify: `opencode debug skill` lists `synthesis` next to OpenCode's built-in `customize-opencode`. A permission rule such as `skill: {"*": "deny", "synthesis": "allow"}` limits what the agent may load.

Status: `verified`. This is the one host with a live eval. Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green. See [Evidence](../README.md#evidence).

Evidence:

- Host: `opencode-ai@1.19.4`, the version the evals are pinned to, launched with `bunx opencode-ai@1.19.4`. The OpenCode on the author's `PATH` was a different build (1.19.0) and was not used.
- Method: the Unit 1 instrument in `src/runner/spike/isolation.ts`. It runs OpenCode in a throwaway home with a local scripted provider that replies without a model, copies `skills/synthesis/` to `<project>/.agents/skills/synthesis/`, and reads the `<available_skills>` block from the request the provider received.
- Observed: `<available_skills>` was exactly `["synthesis"]` with the allow rule above. `opencode debug skill` listed `customize-opencode` (built-in) and `synthesis` (project). Control without the copy: `<available_skills>` absent, only the built-in listed.
- Eval evidence: [`evals/reports/synthesis/green.json`](../evals/reports/synthesis/green.json): OpenCode 1.19.4, agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, held-out 19/20 against a baseline of 3/20.

## Pi

Discovery: project `.pi/skills/` and `.agents/skills/` (from the working directory up to the repository root), user-level `~/.pi/agent/skills/` and `~/.agents/skills/`. Docs: https://pi.dev/docs/latest/skills

Install: copy to `.agents/skills/<method>/` (`synthesis` or `counterfactual`).

Verify: start `pi --mode rpc --no-session --offline --approve`, send `{"type":"get_commands"}` on stdin, and look for a command named `skill:synthesis` with `source` `skill`. In an interactive session the skill appears as `/skill:synthesis`. RPC reference: https://pi.dev/docs/latest/rpc-commands

Status: `content-compatible-untested`. The skill is listed; no model has been run against it.

Evidence:

- Host: Pi 1.3.0.
- Observed with `--approve`: three commands, one of them `skill:synthesis` (`source` `skill`, scope `project`, origin `top-level`). Control without the copy: no skill commands.
- Pi lists project skills only for a trusted project. The same run without `--approve` returned two commands and no skill. Pi's documentation advises reviewing project skills before granting project trust.

## Codex

Discovery: project `.agents/skills/`, user-level `$HOME/.agents/skills/`, and `/etc/codex/skills`. Docs: https://developers.openai.com/codex/skills

Install: copy to `.agents/skills/<method>/` (`synthesis` or `counterfactual`).

Verify: run `codex debug prompt-input` in the project. The output is the model-visible prompt as JSON; its skills section has a `synthesis` entry and a skill root that points at the project's `.agents/skills`.

Status: `content-compatible-untested`. The skill is listed; no model has been run against it.

Evidence:

- Host: `codex-cli 0.162.1`.
- Observed: `synthesis` appeared in the available skills with the description from `SKILL.md`, resolved through a root that was the project's `.agents/skills`. Control without the copy: zero occurrences of `synthesis`.

## Claude Code

Discovery: project `.claude/skills/` and user-level `~/.claude/skills/` only. Claude Code does not read `.agents/skills/`. Docs: https://code.claude.com/docs/en/skills

Install: copy to `.claude/skills/<method>/` (`synthesis` or `counterfactual`).

Verify: run `claude -p --output-format stream-json --verbose "hi"` and read the `skills` array in the `system` event with subtype `init`. To make sure no model request leaves your machine, point `ANTHROPIC_BASE_URL` at a closed local port for this check, for example `http://127.0.0.1:9`. In an interactive session `synthesis` appears among the available skills.

Status: `content-compatible-untested`. The skill is listed; no model has been run against it.

Evidence:

- Host: Claude Code 2.1.270.
- Observed: the `init` event's `skills` array contained `synthesis`. The run ended with a synthetic reply, zero tokens, and `total_cost_usd` 0, so no model request was made. Control without the copy: `synthesis` absent. A project that held the skill only under `.agents/skills/` did not list it.

## Status key

| Status | Meaning |
| --- | --- |
| `verified` | An eval ran on this host and model, its report is `green`, and the human review of the judge verdicts is complete. |
| `content-compatible-untested` | The skill follows the Agent Skills format and the host lists it. No behavior evidence on this host. A cell marked "pending human review" has a machine-green eval report whose review is not finished. |
| `unverified` | The smoke could not run, or no one has run it. The cell says why. A plugin entry that no one has installed and invoked on a real install is `unverified`. |
| `unsupported` | The host cannot load the skill. The cell says why. |

A plugin package is recorded separately, once per host, and only `verified` and `unverified` apply to it. Claude Code and Codex plugin entries can be `verified` only with a `manual_run` note that says what a person installed and invoked by hand.

`matrix.json` is the source of truth. `bun run matrix:check` fails when a cell claims more than its evidence shows or when the README tables differ from `matrix.json`; `bun run matrix:render` rewrites the README tables.

## Publishing the package

For maintainers. The release workflow publishes to npm through trusted publishing (OIDC) with provenance, from the `release` environment, after the GitHub Release for the version exists. No npm token is stored. A trusted publisher can only be configured for a package that already exists, so the first publish is manual and happens once:

1. **Publish `0.0.1` by hand.** From a throwaway directory outside this repository, with a `package.json` that has only `name` (`metacogs`) and `version` (`0.0.1`) and a placeholder `README.md`, no `main` and no scripts, run `npm publish --tag bootstrap` and confirm with 2FA.
2. **Check the dist-tags.** `npm view metacogs dist-tags` should list `bootstrap` at `0.0.1`. If `latest` also points at `0.0.1`, that is acceptable: the placeholder does nothing.
3. **Configure the trusted publisher.** On npmjs.com: package Settings, Trusted Publisher, GitHub Actions, owner `marcusrbrown`, repository `metacogs`, workflow `release.yaml` (exact, case-sensitive), environment `release`. Also create the `release` environment in the GitHub repository settings and restrict its deployment branches to `main`. The workflow file name is part of the link, so renaming `release.yaml` breaks it.
4. **After `0.2.0` is published and verified,** set the package's publishing access to "Require two-factor authentication and disallow tokens", remove the placeholder tag with `npm dist-tag rm metacogs bootstrap`, and revoke any automation tokens.

Merging the version PR for `0.2.0` runs the workflow: it creates the `v0.2.0` Release, then `changeset publish --no-git-tag` builds, runs the tests and publishes. `v<version>` is the only tag the workflow creates.

Checks after a publish: `npm view metacogs@0.2.0 version` returns `0.2.0`, `latest` points at it, `dist.attestations` is present, and `npm audit signatures` passes from a clean install outside the repository.

Recovery:

- **The release job fails before a Release exists.** Nothing is published; re-run it. If a `v<version>` tag exists without a Release, do not delete it without checking why.
- **A Release exists and the publish fails before npm accepts it.** Nothing is published. Fix the cause and re-run the job.
- **`npm publish` reports an error after uploading.** Run `npm view metacogs@<version>`. If the version is there, do not publish it again. Right after a manual publish, `changeset publish` can report "cannot publish over previously published versions" for 30 to 60 minutes while registry metadata propagates; check `npm view` before re-running.
- **A published version is broken.** Deprecate it with a message that names the fix, ship a patch release through a changeset, and edit the Release notes. Do not point `latest` back at `0.0.1`. Unpublishing is a last resort and npm limits it to the first 72 hours and to versions without dependents.
