# feel/drugs mechanism spike

An experiment with a human read, not a method: no prereg, rubric, judge, tally or matrix cell. Plan: `docs/plans/2026-10-25-001-feat-feel-drugs-spike-plan.md`. Requirements: `docs/brainstorms/2026-10-25-feel-drugs-spike-requirements.md`.

The question: do upstream's `feel` and `drugs` change what a model produces when it composes the fields in a tool call and reads the frame back, compared with reading the same frame as skill text and writing the fields in its reply, and does the model family matter? Upstream is pinned to `inanna-malick/metacog@3d89bb30cd26369fdcd242fd704f66641dca327c` (MIT). Both tools are stateless text templates there.

## Arms

| Arm | The model is offered |
| --- | --- |
| A | nothing |
| B | the upstream `feel` and `drugs` registrations over a local stdio MCP (`src/spike/feel-drugs/server.ts`) |
| C | the skill `evals/spikes/feel-drugs/skill/metacog-frames/SKILL.md`: the same frames, verbatim, to write in the reply |

Every arm runs under the same permission block (no edits, outside directories, web, subagents or shell); only the offered tools and the C skill differ. Models: `openai/gpt-6-luna` and `anthropic/claude-haiku-5-5` through CLIProxyAPI. Four prompts, two runs per cell: 3 arms x 2 models x 4 prompts x 2 = 48 runs.

## Prompts

`prompts.md` holds the four prompts with a one-line rationale each. They are frozen by this hash; live runs refuse to start if it does not match the committed file.

prompts_sha256: 47b31dcde9b9414f604f118f4497796cf09ac4beefebb6735680c89124753e60

Status: approved by the owner as committed. Any edit to `prompts.md` needs the hash above recomputed (`shasum -a 256 evals/spikes/feel-drugs/prompts.md`) in the same commit.

## Running

```sh
# $0 smoke run against the scripted provider (a local stub, no credential, no network)
bun run spike:feel-drugs --model openai/gpt-6-luna --arm B --runs 1 --probe

# live: one invocation per model, 24 runs each (needs the frozen prompts and a CLIProxyAPI key name)
bun run spike:feel-drugs --provider live --auth-cliproxy <key-name> --model openai/gpt-6-luna

# render the read sheet from the retained campaign dirs
bun run spike:feel-drugs:sheet --campaign <campaign dir> [--campaign <campaign dir>]
```

Runs are written to `<state root>/spikes/feel-drugs/<model>-<timestamp>/<arm>-<prompt>-<n>/` (`stdout.jsonl`, `stderr.txt`, `requests.json`, `run.json`), outside the repository. A run whose offered tools lack either expected name in arm B is `tools_missing`, not read as arm A.

## Scripted probe (pinned host, $0)

Against `opencode-ai@1.19.4` with the scripted provider (`src/spike/feel-drugs/driver.test.ts`, arm B test):

- The isolated config with the `mcp` block and the `webfetch`/`task` denials passes `checkDebugConfig` and the other isolation checks.
- The host offers `metacog_feel` and `metacog_drugs` in the request `tools` array, beside `glob`, `grep`, `read` and `todowrite`.
- A scripted `metacog_feel` call arrives as a `tool_use` event with the composed input and the server's template as output.

Live probe, arm B, one run per model through CLIProxyAPI (`--probe --provider live --arm B`, campaigns `openai-gpt-6-luna-2026-10-25T14-04-27-040Z` and `anthropic-claude-haiku-5-5-2026-10-25T14-04-43-827Z`):

| Model | Offered tools | Isolation | Tool calls |
| --- | --- | --- | --- |
| `openai/gpt-6-luna` | `glob`, `grep`, `metacog_drugs`, `metacog_feel`, `read`, `todowrite` | passed (all five checks) | none |
| `anthropic/claude-haiku-5-5` | `glob`, `grep`, `metacog_drugs`, `metacog_feel`, `read`, `todowrite` | passed (all five checks) | none |

Both runs completed with a story as the answer, and the provider reported the pinned model id. Not calling a tool on the probe prompt is data, not a failure.

## Results

Campaigns (state root `<state root>/spikes/feel-drugs/<campaign id>/<arm>-<prompt>-<n>/`; the state root is outside the repository):

- `openai-gpt-6-luna-2026-10-25T14-05-15-261Z`: 24 runs.
- `anthropic-claude-haiku-5-5-2026-10-25T14-09-17-140Z`: 24 runs.

The read sheet is `sheet.md`, rendered from those two campaigns (paths redacted to `<ws>` and `<home>`). Counts below are computed from the `run.json` files. B shows feel calls / drugs calls / runs with any call to either tool. C shows runs where the skill was loaded / runs where the frame fields appear in the reply. Each cell is 2 runs.

| Prompt | Model | A: completed | B: feel / drugs / any call | C: skill loaded / fields in reply |
| --- | --- | --- | --- | --- |
| p1 | `openai/gpt-6-luna` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p1 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p2 | `openai/gpt-6-luna` | 2 of 2 | 1 / 0 / 1 of 2 | 2 / 2 of 2 |
| p2 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p3 | `openai/gpt-6-luna` | 2 of 2 | 1 / 1 / 1 of 2 | 1 / 0 of 2 |
| p3 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `openai/gpt-6-luna` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |

Non-completed runs: none. All 48 runs completed, passed the isolation checks, and listed both `metacog_*` tools in arm B (no `tools_missing`). No cell needed a rerun.

The owner's outcome per tool is one line in `HYPOTHESES.md` and the prose goes below. A null result is a statement about these four prompts and these two models, not about the tool in general.
