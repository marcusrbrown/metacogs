# Install

metacogs ships Agent Skills. A skill is a directory with a `SKILL.md` and, for methods that record a decision, a `scripts/record.mjs` helper. Installing means copying that directory to a path your host scans. Nothing else is configured and no host settings change.

Two methods are installable guidance in this release: `synthesis` and `counterfactual`. See [Methods](../README.md#methods).

## Requirements

- A host from the sections below.
- Node 22 or newer on `PATH`, for the record helper only. The helper is one dependency-free file (`scripts/record.mjs`) and needs no `node_modules`. Without Node the method still runs and the run is marked `unrecorded`.
- The host must let the agent run one shell command: `node <skill directory>/scripts/record.mjs`. A host that denies shell access also gives `unrecorded`.

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

A method writes its record with the helper, once, after it finishes. The record is a JSON file named `<method>-<hash>.json`. The reply the user reads does not depend on the record.

Where records go, first match wins:

1. `--out-dir <dir>`
2. `METACOGS_RECORDS_DIR`
3. `$XDG_STATE_HOME/metacogs/records/`
4. `~/.local/state/metacogs/records/`

The default is outside your repository, so records never land in a commit by accident. The current directory is never used unless you pass a relative path yourself. Directories are created with mode 0700 and files with 0600.

To keep records in a project, opt in explicitly and ignore them:

```sh
export METACOGS_RECORDS_DIR=.metacogs/records
echo '.metacogs/records/' >> .gitignore
```

## `unrecorded`

If the helper cannot run, the skill does not retry blindly and does not pretend a record exists. It tells the user no record was written, and the run's `execution_mode` is `unrecorded`. This covers: no Node 22, a denied shell command, an unwritable records directory (exit 3), and a different record already at the same path (exit 4). A validation error (exit 2) names the field; the agent fixes it and reruns once.

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
| `unverified` | The smoke could not run. The cell says why. |
| `unsupported` | The host cannot load the skill. The cell says why. |

`matrix.json` is the source of truth. `bun run matrix:check` fails when a cell claims more than its evidence shows or when the README table differs from `matrix.json`; `bun run matrix:render` rewrites the README table.
