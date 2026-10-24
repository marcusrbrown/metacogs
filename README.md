# metacogs

Explicit, testable reasoning methods packaged as portable [Agent Skills](https://agentskills.io/specification). Each method is a short written procedure plus a helper that validates and stores a decision record. A method is included only after an eval shows it changes what a model does on tasks where it should apply, and stays silent on tasks where it should not.

## Stance

Altered cognition and jailbreak framing are not objectives of this project. It reinterprets the concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) as ordinary, inspectable procedures: a structured choice, then a response that redirects work. A method structures the model's own reasoning; nothing in it enforces anything. Upstream attribution is in [Attribution](#attribution-and-license).

## Install

Copy a skill directory to a path your host scans:

```sh
mkdir -p .agents/skills
cp -R <metacogs-clone>/skills/synthesis .agents/skills/synthesis
cp -R <metacogs-clone>/skills/counterfactual .agents/skills/counterfactual
```

`.agents/skills/` works for OpenCode, Pi, and Codex. Claude Code reads `.claude/skills/` only. Per-host paths, listing commands, and the smoke evidence are in [docs/install.md](docs/install.md).

- **Helper runtime.** The record helper is one dependency-free file that needs Node 22 or newer. The agent runs it with `node`; no install step.
- **Records.** Records go to `$XDG_STATE_HOME/metacogs/records/` (default `~/.local/state/metacogs/records/`), outside your repository. `METACOGS_RECORDS_DIR` or `--out-dir` overrides it. To keep records in a project, opt in with `METACOGS_RECORDS_DIR=.metacogs/records` and add `.metacogs/records/` to `.gitignore`.
- **`unrecorded`.** If the helper cannot run (no Node 22, a denied shell command, an unwritable directory), the skill says no record was written and the run is marked `unrecorded`. It never claims a record that does not exist.

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
<!-- matrix:end -->

`matrix.json` is the source of truth and `bun run matrix:check` fails if this table drifts from it. "Pending human review" means the eval report is machine-green and a person has not finished reviewing the judge's verdicts. Statuses are defined in [docs/install.md](docs/install.md#status-key).

## Evidence

Reports are under [`evals/reports/`](evals/reports/README.md); how to read them is in that README.

- **synthesis, epoch 3** ([`green.json`](evals/reports/synthesis/green.json)): agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, OpenCode 1.19.4. One preregistered read on four held-out fixtures, five runs per condition: skill 19/20, baseline 3/20, delta +0.80 (95% interval 0.52 to 0.91), 0 of 15 false fires on negative fixtures. Machine verdict `green`. Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green.
- **synthesis, epoch 2** ([`green.epoch2.json`](evals/reports/synthesis/green.epoch2.json)): free-tier and Go-gateway models. `green-miss`: skill 15/20 against a bar of 17/20, traced to the skill not always being loaded. Kept as recorded.
- **counterfactual, epoch 5** ([`red.json`](evals/reports/counterfactual/red.json), [`green-dev.json`](evals/reports/counterfactual/green-dev.json), [`green.json`](evals/reports/counterfactual/green.json)): `green`. Agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, OpenCode 1.19.4. Dev 29/30 under the preregistered pooled bar. One preregistered read on four held-out fixtures, five runs per condition: skill 18/20, baseline 1/20, delta +0.85 (95% interval 0.58 to 0.93), 0 of 15 false fires on negative fixtures. Machine verdict `green`. Human review: 38/38 held-out judgments reviewed; CF2–CF4 above the 0.8 agreement floor; CF1 and CF5 below floor and demoted to advisory; recomputed verdict green. Both skill misses are `judge_error`.

What this does not show:

- The gain is largely process visibility: the skill makes the agent write out perspectives, dependence, and a conclusion, which the rubric rewards. Whether answers are also more correct is not measured.
- One host, one model pair, one fixture family. The judge is a single model whose draw is not fixed.
- Pi, Codex, and Claude Code were checked for discovery only. No model was run on them.

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

Releases use [Changesets](https://github.com/changesets/changesets). Pending changesets produce a version PR; merging it creates the `v*` tag and a GitHub Release. Nothing is published to a registry.

Fro Bot reviews pull requests and acts on `@fro-bot` mentions. The daily autoheal may open one fix PR and must not touch eval evidence (`evals/**`) or skill text (`skills/**`). The daily cron is enabled after the first successful manual dispatch.

## Attribution and license

MIT. This project reinterprets concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) (MIT, pinned at commit `3d89bb30cd26369fdcd242fd704f66641dca327c`). Both copyright notices are in [LICENSE](LICENSE).
