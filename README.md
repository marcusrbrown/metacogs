# metacogs

Explicit, testable reasoning methods packaged as portable [Agent Skills](https://agentskills.io/specification). Each method is a short written procedure plus a helper that validates and stores a decision record. A method is included only after an eval shows it changes what a model does on tasks where it should apply, and stays silent on tasks where it should not.

## Stance

Altered cognition and jailbreak framing are not objectives of this project. It reinterprets the concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) as ordinary, inspectable procedures: a structured choice, then a response that redirects work. A method structures the model's own reasoning; nothing in it enforces anything. Upstream attribution is in [Attribution](#attribution-and-license).

## Install

Copy a skill directory to a path your host scans:

```sh
mkdir -p .agents/skills
cp -R <metacogs-clone>/skills/synthesis .agents/skills/synthesis
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

A hypothesis, not shipped. The idea: find the one premise a decision depends on, state what changes if it is false, and name the evidence that would flip the decision. Its baseline failure was retained (without the skill, a model fails the preregistered rubric on 5 of 6 dev fixtures), and a skill was written. The skill did not clear the dev bar. The first epoch-3 dev read missed because the record was not always written; one edit fixed that. After it, `cf-d6-autoscaler-removal` scored 3 of 5 against a bar of 4 in two consecutive dev reads. The misses were on one criterion, "name flip evidence and where to get it", and re-judging the same answers passed all of them. That points to judge-boundary variance on a fixture at the edge of the criterion, not to a skill defect, but it does not prove either. The held-out set was not read. Counterfactual stays `red-retained`, its skill directory stays in `skills/` as evidence, and it is not installable guidance. Retrying needs a new epoch and a new held-out set.

The other nine upstream concepts are listed in [HYPOTHESES.md](HYPOTHESES.md) with one-line interpretations. None has fixtures or a skill.

## Host matrix

<!-- matrix:start -->
| Host | Project skills path | synthesis |
| --- | --- | --- |
| [OpenCode](docs/install.md#opencode) | `.agents/skills/` | `verified`<br>OpenCode 1.19.4 · model `openai/gpt-6-luna` · judge `anthropic/claude-haiku-5-5` · 2026-10-23 · [evidence](evals/reports/synthesis/green.json)<br>Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green. |
| [Pi](docs/install.md#pi) | `.agents/skills/` | `content-compatible-untested`<br>Pi 1.3.0 · 2026-10-23 · [evidence](docs/install.md#pi)<br>Listing smoke only. Project skills load after trusting the project (`--approve`). |
| [Codex](docs/install.md#codex) | `.agents/skills/` | `content-compatible-untested`<br>Codex 0.162.1 · 2026-10-23 · [evidence](docs/install.md#codex)<br>Listing smoke only. |
| [Claude Code](docs/install.md#claude-code) | `.claude/skills/` | `content-compatible-untested`<br>Claude Code 2.1.270 · 2026-10-23 · [evidence](docs/install.md#claude-code)<br>Listing smoke only. Reads `.claude/skills/`, not `.agents/skills/`. |
<!-- matrix:end -->

`matrix.json` is the source of truth and `bun run matrix:check` fails if this table drifts from it. "Pending human review" means the eval report is machine-green and a person has not finished reviewing the judge's verdicts. Statuses are defined in [docs/install.md](docs/install.md#status-key).

## Evidence

Reports are under [`evals/reports/`](evals/reports/README.md); how to read them is in that README.

- **synthesis, epoch 3** ([`green.json`](evals/reports/synthesis/green.json)): agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, OpenCode 1.19.4. One preregistered read on four held-out fixtures, five runs per condition: skill 19/20, baseline 3/20, delta +0.80 (95% interval 0.52 to 0.91), 0 of 15 false fires on negative fixtures. Machine verdict `green`. Human review: 39/39 held-out judgments reviewed; SY1 above the 0.8 agreement floor; SY2–SY5 below floor and demoted to advisory; recomputed verdict green.
- **synthesis, epoch 2** ([`green.epoch2.json`](evals/reports/synthesis/green.epoch2.json)): free-tier and Go-gateway models. `green-miss`: skill 15/20 against a bar of 17/20, traced to the skill not always being loaded. Kept as recorded.
- **counterfactual** ([`red.json`](evals/reports/counterfactual/red.json), [`green-dev.json`](evals/reports/counterfactual/green-dev.json)): `red-retained`, as described under Methods. Held-out unread.

What this does not show:

- The gain is largely process visibility: the skill makes the agent write out perspectives, dependence, and a conclusion, which the rubric rewards. Whether answers are also more correct is not measured.
- One host, one model pair, one fixture family. The judge is a single model whose draw is not fixed.
- Pi, Codex, and Claude Code were checked for discovery only. No model was run on them.

**What preregistration proves.** Thresholds, rubric, and fixture hashes are committed and tagged (`prereg/<method>/<epoch>`) before any skill content, and the runner refuses a GREEN read if the order is wrong. This makes edits after the tag visible. It does not make them impossible: the author controls the repository and can retag. Held-out fixtures stay outside the repository until release.

## Reproduce

Evals run locally with your own provider credentials. They never run in CI, and committed reports are allowlist projections: counts, intervals, hashes, and model IDs, never transcripts.

```sh
bun install
bun run eval red --method <method>       # baseline runs on dev fixtures
bun run eval green --method <method> --provider live   # one-shot held-out read, both conditions
bun run eval report --method <method>    # regenerate the report projection
```

Runs happen in a throwaway workspace with a scrubbed environment so nothing from your machine reaches the model; [`evals/runner/README.md`](evals/runner/README.md) documents the isolation checks and the OpenCode event mapping. Checks that do run in CI: `bun run typecheck`, `bun test`, `bun run generate:check`, `bun run matrix:check`, `bun run scan:secrets`.

## Attribution and license

MIT. This project reinterprets concepts from [inanna-malick/metacog](https://github.com/inanna-malick/metacog) (MIT, pinned at commit `3d89bb30cd26369fdcd242fd704f66641dca327c`). Both copyright notices are in [LICENSE](LICENSE).
