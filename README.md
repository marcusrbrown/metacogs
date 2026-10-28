# metacogs

Explicit, testable reasoning methods packaged as portable [Agent Skills](https://agentskills.io/specification). Each method is a short written procedure plus a helper that validates and stores a decision record. A method is included only after an eval shows it changes what a model does on tasks where it should apply, and stays silent on tasks where it should not. The package is also an [OpenCode plugin](#opencode-plugin), a [Claude Code plugin](#claude-code-plugin) and an experimental [Codex plugin](#codex-plugin).

## Stance

Altered cognition and jailbreak framing are not objectives of this project. It reinterprets the concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) as ordinary, inspectable procedures: a structured choice, then a response that redirects work. A method structures the model's own reasoning; nothing in it enforces anything. Upstream attribution is in [Attribution](#attribution-and-license).

The OpenCode plugin keeps upstream's tool names, including `drugs`. Here `drugs` is a handle for a deliberate change of approach: the model names a substance as a short label and says what it will do differently on the next attempt. It does not change the model, adds no capability, and nothing in this project claims it improves results. `feel` is a pause on an unnamed tension. Neither supplies facts or checks anything.

## Install

Copy a skill directory to a path your host scans:

```sh
mkdir -p .agents/skills
cp -R <metacogs-clone>/skills/synthesis .agents/skills/synthesis
cp -R <metacogs-clone>/skills/counterfactual .agents/skills/counterfactual
```

`.agents/skills/` works for OpenCode, Pi, and Codex. Claude Code reads `.claude/skills/` only. Per-host paths, listing commands, and the smoke evidence are in [docs/install.md](docs/install.md).

- **Helper runtime.** The record helper is one dependency-free file that needs Node 22 or newer. The agent runs it with `node`; no install step. The Claude Code and Codex plugins write records through a `record` tool instead, and ship no helper.
- **Records.** Records go to `$XDG_STATE_HOME/metacogs/records/` (default `~/.local/state/metacogs/records/`), outside your repository. `METACOGS_RECORDS_DIR` or `--out-dir` overrides it. To keep records in a project, opt in with `METACOGS_RECORDS_DIR=.metacogs/records` and add `.metacogs/records/` to `.gitignore`.
- **`unrecorded`.** If the helper cannot run (no Node 22, a denied shell command, an unwritable directory), the skill says no record was written and the run is marked `unrecorded`. It never claims a record that does not exist.

## OpenCode plugin

metacogs is also an [OpenCode](https://opencode.ai) plugin. It adds:

- **Two tools**, `feel` and `drugs`. Their descriptions and return text are adapted from upstream. `feel` pauses on a tension that has no name yet. `drugs` states a deliberate change of approach for the next attempt. Neither supplies facts, checks anything, or guarantees a result.
- **Four skills**: `feel`, `drugs`, `synthesis` and `counterfactual`. OpenCode lists every skill as a slash command, so `/feel` and `/drugs` run the first two, with or without arguments (`/drugs caffeine`). The `feel` and `drugs` skills have the same names as the tools but are separate: a skill is instructions the model loads, and a tool is what it calls. The skills say when to call each tool and how to fill its fields, and `/feel` loads the skill, which then has the model call the tool. `synthesis` and `counterfactual` are the methods described below; the plugin loads them from the package, so no copy under `.agents/skills/` is needed.
- **A guidance block** of a few lines in the system prompt of normal requests (not the host's title and summary calls). It names the tools and skills and the situations each one fits, and does not require their use. To keep the tools and skills and drop the block:

```json
{ "plugin": [["metacogs", { "guidance": false }]] }
```

### Plugin install

Add the package to `plugin` in `opencode.json` (project) or `~/.config/opencode/opencode.json` (user):

```json
{ "plugin": ["metacogs"] }
```

OpenCode installs the package on the next start. It is tested on OpenCode 1.19.4.

If you copied `synthesis` or `counterfactual` into `.agents/skills/` or another scanned path, remove those copies. The plugin provides the same skill names, and OpenCode does not guarantee which of two same-named skills wins. The method skills still write their records as described under Install above.

### Where it comes from

`feel` and `drugs` are the tools from [inanna-malick/metacog](https://github.com/inanna-malick/metacog). Their descriptions and return text are adapted from upstream at the pinned commit, with the claims about changing how the model processes removed (see [Attribution](#attribution-and-license)); the skill text around them is this project's. `synthesis` and `counterfactual` carry the evals under [Evidence](#evidence). The tools and the `feel` and `drugs` skills have no eval of that kind.

### Model notes

Observed on OpenCode 1.19.4 with GPT-6 Luna, GPT-6.1 Sol, Claude Haiku 5.5 and Claude Opus 5.5. The samples are small and these are observations, not measurements.

- Models rarely call the `feel` or `drugs` tools on their own.
- `/feel` and `/drugs` reliably lead to the tools being called. In 32 of 32 runs across the four models, the command was followed by a tool call. Those runs used an earlier form of the commands; the skill form was checked on GPT-6 Luna and Claude Opus 5.5.
- At a stuck point, such as a requirement that conflicts with a test or a platform limit, models tend to reach for `counterfactual` first. In four such sessions on GPT-6 Luna and Claude Opus 5.5, each loaded `counterfactual` and none called a tool unprompted.

How the plugin was tested is recorded in [`evals/spikes/feel-drugs/README.md`](evals/spikes/feel-drugs/README.md).

## Claude Code plugin

metacogs is also a [Claude Code](https://code.claude.com) plugin, served from this repository. It adds the `feel` and `drugs` tools and a `record` tool through a local MCP server, the four skills, and a short factual note at session start.

```text
/plugin install metacogs --marketplace marcusrbrown/metacogs
```

That one-step form needs Claude Code 2.1.275 or later. The two-step form is `/plugin marketplace add marcusrbrown/metacogs`, then `/plugin install metacogs@metacogs`.

- **Node.** Node 22 or newer must be on `PATH`. Without it the session-start hook fails with `node: command not found` and the MCP server does not start, so the skills continue in plain text and a method run is `unrecorded`.
- **Invoke.** `/metacogs:feel`, `/metacogs:drugs`, `/metacogs:synthesis`, `/metacogs:counterfactual`. The tools are `mcp__plugin_metacogs_metacogs__feel`, `mcp__plugin_metacogs_metacogs__drugs` and `mcp__plugin_metacogs_metacogs__record`.
- **Records.** `synthesis` and `counterfactual` call the `record` tool. Allow it with the rule `mcp__plugin_metacogs_metacogs__record`; the wildcard `mcp__plugin_metacogs_metacogs__*` allows all three tools. Records go to `$XDG_STATE_HOME/metacogs/records/` or `~/.local/state/metacogs/records/`, and `METACOGS_RECORDS_DIR` overrides it.
- **Session-start note.** Set `METACOGS_GUIDANCE=off`, create `${XDG_CONFIG_HOME:-~/.config}/metacogs/guidance-off`, or turn off the plugin's `guidance` option.
- **Status.** The package passes `claude plugin validate --strict`. Checked in scripted headless runs (`claude -p`) of Claude Code 2.1.312: install from the marketplace, the MCP tools, the session note and its off switches, `/metacogs:feel` and `/metacogs:drugs`, and recording through the `record` tool. The interactive session has not been checked by hand. Its `synthesis` and `counterfactual` skills are adapted for the host and are not the exact text that was evaluated.

Approvals, records, updates and uninstall are in [docs/install.md](docs/install.md#claude-code-plugin). Updates follow the plugin manifest `version`, which changes with each release.

## Codex plugin

metacogs is also an experimental [Codex](https://developers.openai.com/codex) plugin, served from this repository. It adds the same tools (`feel`, `drugs` and `record`) and skills. It has no session-start note.

```sh
codex plugin marketplace add marcusrbrown/metacogs
codex plugin add metacogs@metacogs
```

- **Node.** Node 22 or newer must be on `PATH`. Without it the MCP server does not start, the skills continue in plain text and a method run is `unrecorded`.
- **Invoke.** `$metacogs:feel`, `$metacogs:drugs`, `$metacogs:synthesis`, `$metacogs:counterfactual`, with any arguments as text after the mention. A bare `$feel` is not a mention. The tools are `mcp__metacogs__feel`, `mcp__metacogs__drugs` and `mcp__metacogs__record`.
- **Records.** `synthesis` and `counterfactual` call the `record` tool. The MCP server runs outside the shell sandbox, so records are written under `read-only` and `workspace-write` alike. In the tested configuration they go to `~/.local/state/metacogs/records/`.
- **Session-start note.** None. Codex discards the hooks of a plugin in the agent-plugins format, so the tools and skills work without a note. `METACOGS_GUIDANCE` and the `guidance-off` file apply to the Claude Code plugin only.
- **Status.** The manifests validate against the agent-plugins.org 1.0.0 schemas. Checked in scripted `codex exec` runs of Codex 0.162.1: `marketplace add` and `plugin add`, the MCP server and its tools, `$metacogs:feel` and `$metacogs:drugs`, and recording through the `record` tool under `workspace-write` and `read-only`. The interactive TUI has not been checked by hand. Its `synthesis` and `counterfactual` skills are adapted for the host and are not the exact text that was evaluated.

Approvals, records, updates and uninstall are in [docs/install.md](docs/install.md#codex-plugin). Codex refreshes an installed plugin only when the manifest `version` changes, which happens with each release.

## Methods

### synthesis

Use when several analyses, reviews, votes, or proposals disagree or converge on a decision. The agent restates each perspective in its own terms, finds the premises they share, names the concrete path that ties them together, and concludes no more strongly than what survives. Agreement that rests on one source counts once.

The record holds `objective`, `evidence[]`, `assumptions[]`, `alternatives[]`, `findings[]`, `next_action`, `reopen_condition`, `execution_mode` (`direct`, `sequential`, `delegated`, or `unrecorded`), and `status`, plus `schema_version`, `helper_version`, `method`, and `method_version`. A malformed record is rejected with the name of the field and nothing is written.

### counterfactual

Use when a decision rests on an assumption that could be wrong. The agent finds the one premise the decision depends on, states what changes if it is false, and names the evidence that would flip the decision and where to get it. The record uses the same helper and fields as synthesis.

Without the skill, a model fails the preregistered rubric on 5 of 6 dev fixtures. In the epoch-5 read the dev campaign passed the preregistered pooled bar (29 of 30, 0 of 15 negative false fires). The one-shot held-out read scored skill 18/20 against baseline 1/20, delta +0.85 (95% interval 0.58 to 0.93), with 0 of 15 false fires on negative fixtures. Both skill-condition misses are `judge_error` results, not judge fail verdicts. Human review: 38/38 held-out judgments reviewed; CF2–CF4 above the 0.8 agreement floor; CF1 and CF5 below floor and demoted to advisory; recomputed verdict green. Three run outcomes flipped on review, giving a recomputed skill 17/20 against baseline 0/20.

The dev bar changed from a per-fixture 4 of 5 to a pooled 24 of 30 in epoch 5, after the dev results of epochs 2 to 4 were seen. It is declared in the epoch-5 prereg before any epoch-5 run, but it was chosen with that data in view. The epoch-5 held-out set is burned; any edit to the skill voids the read.

The other nine upstream concepts are listed in [HYPOTHESES.md](HYPOTHESES.md) with one-line interpretations. None has fixtures or a skill.

## Host matrix

<!-- matrix:start -->
| Host | Project skills path | synthesis | counterfactual |
| --- | --- | --- | --- |
| [OpenCode](docs/install.md#opencode) | `.agents/skills/` | `verified`<br>OpenCode 1.19.4 · model `openai/gpt-6-luna` · judge `anthropic/claude-haiku-5-5` · 2026-10-23 · [evidence](evals/reports/synthesis/green.json)<br>Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green. | `verified`<br>OpenCode 1.19.4 · model `openai/gpt-6-luna` · judge `anthropic/claude-haiku-5-5` · 2026-10-23 · [evidence](evals/reports/counterfactual/green.json)<br>Human review: 38/38 held-out judgments reviewed; CF2–CF4 above the 0.8 agreement floor; CF1 and CF5 below floor and demoted to advisory; recomputed verdict green. |
| [Pi](docs/install.md#pi) | `.agents/skills/` | `content-compatible-untested`<br>Pi 1.3.0 · 2026-10-23 · [evidence](docs/install.md#pi)<br>Listing smoke only. Project skills load after trusting the project (`--approve`). | `content-compatible-untested`<br>Pi 1.3.0 · 2026-10-23 · [evidence](docs/install.md#pi)<br>Listing smoke ran on synthesis only; counterfactual was not listed on this host. Project skills load after trusting the project (`--approve`). |
| [Codex](docs/install.md#codex) | `.agents/skills/` | `content-compatible-untested`<br>Codex 0.162.1 · 2026-10-23 · [evidence](docs/install.md#codex)<br>Listing smoke only. | `content-compatible-untested`<br>Codex 0.162.1 · 2026-10-23 · [evidence](docs/install.md#codex)<br>Listing smoke ran on synthesis only; counterfactual was not listed on this host. |
| [Claude Code](docs/install.md#claude-code) | `.claude/skills/` | `content-compatible-untested`<br>Claude Code 2.1.270 · 2026-10-23 · [evidence](docs/install.md#claude-code)<br>Listing smoke only. Reads `.claude/skills/`, not `.agents/skills/`. | `content-compatible-untested`<br>Claude Code 2.1.270 · 2026-10-23 · [evidence](docs/install.md#claude-code)<br>Listing smoke ran on synthesis only; counterfactual was not listed on this host. Reads `.claude/skills/`, not `.agents/skills/`. |

| Host | Plugin package |
| --- | --- |
| OpenCode | `verified`<br>OpenCode 1.19.4 · 2026-10-26 · [evidence](evals/spikes/feel-drugs/README.md#plugin-reads)<br>Tested on the pinned OpenCode release with the packed package: scripted-provider integration suite, host probes and guided reads. |
| Claude Code | `unverified`<br>2026-10-27 · [evidence](docs/install.md#claude-code-plugin)<br>The package is generated and `claude plugin validate --strict` passes on the marketplace and the plugin (Claude Code 2.1.312). It has not been installed and invoked on a real Claude Code. The `synthesis` and `counterfactual` renders are host-adapted, not the text that was evaluated. |
| Codex | `unverified` (experimental)<br>2026-10-27 · [evidence](docs/install.md#codex-plugin)<br>The manifests validate against the agent-plugins.org 1.0.0 schemas; Codex has no CLI validator. The package has not been installed and invoked on a real Codex. The `synthesis` and `counterfactual` renders are host-adapted, not the text that was evaluated. |
<!-- matrix:end -->

`matrix.json` is the source of truth and `bun run matrix:check` fails if this table drifts from it. The second table records each host's plugin package. "Pending human review" means the eval report is machine-green and a person has not finished reviewing the judge's verdicts. Statuses are defined in [docs/install.md](docs/install.md#status-key).

## Evidence

Reports are under [`evals/reports/`](evals/reports/README.md); how to read them is in that README.

- **synthesis, epoch 3** ([`green.json`](evals/reports/synthesis/green.json)): agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, OpenCode 1.19.4. One preregistered read on four held-out fixtures, five runs per condition: skill 19/20, baseline 3/20, delta +0.80 (95% interval 0.52 to 0.91), 0 of 15 false fires on negative fixtures. Machine verdict `green`. Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green.
- **synthesis, epoch 2** ([`green.epoch2.json`](evals/reports/synthesis/green.epoch2.json)): free-tier and Go-gateway models. `green-miss`: skill 15/20 against a bar of 17/20, traced to the skill not always being loaded. Kept as recorded.
- **counterfactual, epoch 5** ([`red.json`](evals/reports/counterfactual/red.json), [`green-dev.json`](evals/reports/counterfactual/green-dev.json), [`green.json`](evals/reports/counterfactual/green.json)): `green`. Agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, OpenCode 1.19.4. Dev 29/30 under the preregistered pooled bar. One preregistered read on four held-out fixtures, five runs per condition: skill 18/20, baseline 1/20, delta +0.85 (95% interval 0.58 to 0.93), 0 of 15 false fires on negative fixtures. Machine verdict `green`. Human review: 38/38 held-out judgments reviewed; CF2–CF4 above the 0.8 agreement floor; CF1 and CF5 below floor and demoted to advisory; recomputed verdict green. Both skill misses are `judge_error`.

What this does not show:

- The gain is largely process visibility: the skill makes the agent write out perspectives, dependence, and a conclusion, which the rubric rewards. Whether answers are also more correct is not measured.
- One host, one model pair, one fixture family. The judge is a single model whose draw is not fixed.
- Pi, Codex, and Claude Code were checked for discovery only. No model was run on them. The Claude Code and Codex plugin packages were checked in scripted headless runs (`claude -p`, `codex exec`) only. The interactive Claude Code session and the Codex TUI have not been checked by hand.

**What preregistration proves.** Thresholds, rubric, and fixture hashes are committed in `evals/<method>/prereg.json` before the skill is authored, and the runner reads its bars and hashes from that file. Every manifest and report carries the sha256 of the file's canonical form, so a changed prereg no longer matches the runs made under the old one. This is a content contract, not a proof of git history: the author controls the repository and can rewrite the prereg and re-run. Held-out fixtures stay outside the repository until release.

## Reproduce

Evals run locally with your own provider credentials. They never run in CI, and committed reports are allowlist projections: counts, intervals, hashes, and model IDs, never transcripts.

```sh
bun install
bun run eval red --method <method>       # baseline runs on dev fixtures
bun run eval green --method <method> --provider live   # one-shot held-out read, both conditions
bun run eval report --method <method>    # regenerate the report projection
```

Runs happen in a throwaway workspace with a scrubbed environment so nothing from your machine reaches the model; [`evals/runner/README.md`](evals/runner/README.md) documents the isolation checks and the OpenCode event mapping. Checks that do run in CI: `bun run typecheck`, `bun test`, `bun run generate:check`, `bun run matrix:check`, `bun run scan:secrets`.

## Releases and automation

Releases use [Changesets](https://github.com/changesets/changesets). Pending changesets produce a version PR; merging it creates the `v*` tag and a GitHub Release, and the release workflow then publishes the package to npm with provenance. The runbook for the first publish is in [docs/install.md](docs/install.md#publishing-the-package). Claude Code and Codex detect plugin updates from the manifest `version`, so a change to the generated packages (`hosts/`, `.claude-plugin/`, `.agents/plugins/`) or to their generator must carry a changeset to reach users; CI checks this.

Fro Bot reviews pull requests and acts on `@fro-bot` mentions. The daily autoheal may open one fix PR and must not touch eval evidence (`evals/**`), skill text (`skills/**`) or the generated host packages.

## Attribution and license

MIT. This project reinterprets concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) (MIT, pinned at commit `3d89bb30cd26369fdcd242fd704f66641dca327c`). Both copyright notices are in [LICENSE](LICENSE). The upstream text that the plugin's tools adapt is described in [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
