# feel/drugs mechanism spike

An experiment with a human read, not a method: no prereg, rubric, judge, tally or matrix cell. Epoch 1 of this spike; the frozen prompt hash below is its only contract. Plan: `docs/plans/2026-10-25-001-feat-feel-drugs-spike-plan.md`. Requirements: `docs/brainstorms/2026-10-25-feel-drugs-spike-requirements.md`.

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

## Nudged variant

`--nudge` appends one sentence to the frozen prompt text sent to the model; `prompts.md` and its hash above are untouched, and the freeze check still applies to them. The appended string is a blank line plus the sentence, exactly `\n\nUse your available tools or skills before answering.` (constant `NUDGE` in `src/spike/feel-drugs/driver.ts`), recorded here by the hash of those bytes:

nudge_sha256: c84b43edf63e9c9460b445a262dd490de3d791321d869d6e24f20d51663756fa

Each `run.json` records `variant` (`unprompted` or `nudged`; runs from before the field read as `unprompted`). Nudged campaigns carry `-nudged` in their id. The sheet renders the unprompted runs first and the nudged runs in a separate top-level section.

## Running

```sh
# $0 smoke run against the scripted provider (a local stub, no credential, no network)
bun run spike:feel-drugs --model openai/gpt-6-luna --arm B --runs 1 --probe

# live: one invocation per model, 24 runs each (add --nudge for the nudged variant) (needs the frozen prompts and a CLIProxyAPI key name)
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

The same probe on the two models added later (campaigns `openai-gpt-6.1-sol-2026-10-25T14-20-18-770Z` and `anthropic-claude-opus-5-5-2026-10-25T14-21-14-990Z`). Both ids are in the OpenCode 1.19.4 catalogue and the gateway served them (`returned_models`: `gpt-6.1-sol`, `claude-opus-5-5`):

| Model | Offered tools | Isolation | Tool calls |
| --- | --- | --- | --- |
| `openai/gpt-6.1-sol` | `glob`, `grep`, `metacog_drugs`, `metacog_feel`, `read`, `todowrite` | passed (all five checks) | none |
| `anthropic/claude-opus-5-5` | `glob`, `grep`, `metacog_drugs`, `metacog_feel`, `read`, `todowrite` | passed (all five checks) | none |

## Results

Campaigns (state root `<state root>/spikes/feel-drugs/<campaign id>/<arm>-<prompt>-<n>/`; the state root is outside the repository). Each is 24 runs, one invocation per model, all unprompted (the prompts never mention the tools):

- `openai-gpt-6-luna-2026-10-25T14-05-15-261Z`
- `anthropic-claude-haiku-5-5-2026-10-25T14-09-17-140Z`
- `openai-gpt-6.1-sol-2026-10-25T14-21-39-874Z`
- `anthropic-claude-opus-5-5-2026-10-25T14-36-00-474Z`

The read sheet is `sheet.md`, rendered from those four campaigns (probes excluded; paths redacted to `<ws>` and `<home>`). Counts below are computed from the `run.json` files. B shows feel calls / drugs calls / runs with any call to either tool. C shows runs where the skill was loaded / runs where the frame fields appear in the reply. Each cell is 2 runs.

| Prompt | Model | A: completed | B: feel / drugs / any call | C: skill loaded / fields in reply |
| --- | --- | --- | --- | --- |
| p1 | `openai/gpt-6-luna` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p1 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p1 | `openai/gpt-6.1-sol` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p1 | `anthropic/claude-opus-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p2 | `openai/gpt-6-luna` | 2 of 2 | 1 / 0 / 1 of 2 | 2 / 2 of 2 |
| p2 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p2 | `openai/gpt-6.1-sol` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p2 | `anthropic/claude-opus-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p3 | `openai/gpt-6-luna` | 2 of 2 | 1 / 1 / 1 of 2 | 1 / 0 of 2 |
| p3 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p3 | `openai/gpt-6.1-sol` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p3 | `anthropic/claude-opus-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `openai/gpt-6-luna` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `anthropic/claude-haiku-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `openai/gpt-6.1-sol` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `anthropic/claude-opus-5-5` | 2 of 2 | 0 / 0 / 0 of 2 | 0 / 0 of 2 |

Non-completed runs: none. All 96 runs completed, passed the isolation checks, and listed both `metacog_*` tools in arm B (no `tools_missing`). No cell needed a rerun.

Wall time, tokens and cost per model, summed from the `run.json` files (cost is OpenCode's own estimate; the two probe runs per model are not included):

| Model | Summed run time | Input / output tokens | Cache read / write tokens | Cost |
| --- | --- | --- | --- | --- |
| `openai/gpt-6-luna` | 223 s | 79,788 / 5,697 | 20,992 / 0 | $0.0112 |
| `anthropic/claude-haiku-5-5` | 248 s | 52 / 19,329 | 84,583 / 77,743 | $0.0241 |
| `openai/gpt-6.1-sol` | 844 s | 63,178 / 12,082 | 4,864 / 0 | $0.2587 |
| `anthropic/claude-opus-5-5` | 479 s | 60 / 26,255 | 109,642 / 78,699 | $1.0359 |

## Results: told to use it (nudged)

The same frozen prompts with the nudge sentence appended (`--nudge`, see above), arms B and C only, 2 runs per cell, one invocation per model, 16 runs each, 64 in all. Sequential, same isolation, same CLIProxyAPI credential path. Campaigns:

- `openai-gpt-6-luna-nudged-2026-10-25T14-56-09-803Z`
- `anthropic-claude-haiku-5-5-nudged-2026-10-25T15-00-38-847Z`
- `openai-gpt-6.1-sol-nudged-2026-10-25T15-04-08-844Z`
- `anthropic-claude-opus-5-5-nudged-2026-10-25T15-14-11-254Z`

Caveat: there is no nudged arm A, so a difference between nudged B or C and unprompted A can include the effect of the sentence itself; nudged B against nudged C is the clean tool-versus-skill comparison.

Columns as above, computed from the `run.json` files. Each cell is 2 runs.

| Prompt | Model | B: feel / drugs / any call | C: skill loaded / fields in reply |
| --- | --- | --- | --- |
| p1 | `openai/gpt-6-luna` | 2 / 0 / 2 of 2 | 2 / 1 of 2 |
| p1 | `anthropic/claude-haiku-5-5` | 1 / 0 / 1 of 2 | 1 / 0 of 2 |
| p1 | `openai/gpt-6.1-sol` | 2 / 0 / 2 of 2 | 0 / 0 of 2 |
| p1 | `anthropic/claude-opus-5-5` | 2 / 0 / 2 of 2 | 2 / 0 of 2 |
| p2 | `openai/gpt-6-luna` | 2 / 0 / 2 of 2 | 2 / 2 of 2 |
| p2 | `anthropic/claude-haiku-5-5` | 0 / 0 / 0 of 2 | 1 / 0 of 2 |
| p2 | `openai/gpt-6.1-sol` | 2 / 0 / 2 of 2 | 2 / 0 of 2 |
| p2 | `anthropic/claude-opus-5-5` | 2 / 0 / 2 of 2 | 2 / 2 of 2 |
| p3 | `openai/gpt-6-luna` | 0 / 2 / 2 of 2 | 2 / 0 of 2 |
| p3 | `anthropic/claude-haiku-5-5` | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p3 | `openai/gpt-6.1-sol` | 0 / 1 / 1 of 2 | 0 / 0 of 2 |
| p3 | `anthropic/claude-opus-5-5` | 0 / 0 / 0 of 2 | 0 / 0 of 2 |
| p4 | `openai/gpt-6-luna` | 0 / 2 / 2 of 2 | 2 / 0 of 2 |
| p4 | `anthropic/claude-haiku-5-5` | 0 / 0 / 0 of 2 | 1 / 0 of 2 |
| p4 | `openai/gpt-6.1-sol` | 2 / 0 / 2 of 2 | 0 / 0 of 2 |
| p4 | `anthropic/claude-opus-5-5` | 2 / 0 / 2 of 2 | 2 / 0 of 2 |

Totals per model (8 B runs and 8 C runs each):

| Model | B: feel calls | B: drugs calls | B: runs with any call | C: skill loads | C: runs with fields in reply |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-6-luna` | 4 | 4 | 8 of 8 | 8 of 8 | 3 of 8 |
| `anthropic/claude-haiku-5-5` | 1 | 0 | 1 of 8 | 3 of 8 | 0 of 8 |
| `openai/gpt-6.1-sol` | 6 | 1 | 7 of 8 | 2 of 8 | 0 of 8 |
| `anthropic/claude-opus-5-5` | 6 | 0 | 6 of 8 | 6 of 8 | 2 of 8 |

In arm C, no run that skipped the `skill` tool read the skill file: their `read` calls (haiku 2 runs, opus 1, sol 6) targeted the workspace directory or `fixture.md`.

Non-completed runs: none. All 64 runs completed, passed the isolation checks, and (arm B) listed both `metacog_*` tools. No cell needed a rerun.

Time, tokens and cost per model, summed from the `run.json` files (cost is OpenCode's own estimate):

| Model | Invocation wall time | Summed run time | Input / output tokens | Cache read / write tokens | Cost |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-6-luna` | 4m30s | 255 s | 77,540 / 4,517 | 56,192 / 0 | $0.0110 |
| `anthropic/claude-haiku-5-5` | 3m30s | 198 s | 60 / 14,627 | 146,995 / 58,147 | $0.0205 |
| `openai/gpt-6.1-sol` | 10m02s | 590 s | 65,495 / 9,021 | 42,496 / 0 | $0.2315 |
| `anthropic/claude-opus-5-5` | 5m46s | 335 s | 70 / 18,950 | 179,170 / 60,586 | $0.7644 |

The sheet's nudged section opens with the sentence and the same prompt, model, arm grouping.

## Owner read

Recorded verbatim:

- feel - all: yes, mostly; tool vs skill: tool
- drugs - (the ones that used it); tool vs skill: tool

The read covers these four prompts and these four models, not the tools in general.

## Plugin host probes

What OpenCode `1.19.4` does with an object plugin, asserted at $0 against the scripted provider in `src/plugin/probe.test.ts` (a throwaway probe plugin, loaded by `file://`). The suite runs only with `METACOGS_HOST_PROBES=1`, on a host pin bump. One line per question:

- **Object plugin id.** A `file://` object plugin without an `id` is not loaded: the host logs `must export id`, the run still exits 0, and the plugin's tools are absent.
- **Default plugins switch.** A `file://` plugin loads under `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, so plugin arms do not unset it.
- **`debug config`.** It shows what the hooks add: `skills.paths`, plus the non-empty `plugin` array and a `plugin_origins` list (`spec`, `source`, `scope`). A run with no plugin has `command: {}`, `plugin: []`, and no `skills` or `plugin_origins` key. The expected-config object for plugin arms allows the two `skills.paths` entries (`skills/` and `plugin/skills/`), the `plugin` entry and `plugin_origins`.
- **`$ARGUMENTS`.** One word arrives raw (`caffeine`), several words arrive JSON-quoted (`"two words"`, the known argv quirk), and no argument arrives as the empty string, so `<args></args>` and the template's empty-arguments branch apply.
- **Skill-name precedence.** A plugin `skills.paths` copy and `.agents/skills` copies (project, HOME) of one name are listed once and one copy loads, but the winner is not stable: in 6 runs of one fixture with the plugin loaded the plugin copy won 3 and the project copy 3, and in 6 runs with the copies alone the project copy won 5 and the HOME copy 1. There is no precedence to document; the docs say to remove the `.agents/skills` copy when the plugin is installed. A skill that exists only in the plugin path always loads.
- **Title and summary signatures.** The title request starts `You are a title generator. You output ONLY a thread title.`, which matches Systematic's `You are a title generator`. Systematic's `You are a helpful AI assistant tasked with summarizing conversations` does not appear on 1.19.4: the compaction request starts `You are a context summarization agent.` The guidance constant gains that string; the transform hook fires for the title request and the compaction request, both with a `sessionID`.
- **Built-in tools after the deny set.** Denying `glob`, `grep`, `list`, `read`, `edit`, `bash`, `task`, `todowrite`, `question`, `webfetch`, `websearch`, `lsp` and `skill` leaves no tool at all: the main request carries no `tools` array, so N1's main request is found by its `You are opencode` system text and not by `hasTools`. With the plugin loaded and only its skills allowed, the offered tools are exactly the plugin's tools and `skill`.
- **Same plugin in two config layers.** The same spec in two layers is one entry: `server()` runs once, the project layer's options replace the file layer's, and the tool is offered once.
- **Two distinct plugins.** Both load. They share a tool name by last-loaded-wins (the project layer over the file layer, and the later array entry over the earlier), and each transform hook runs, so a plugin that only appends adds one block per instance; the guidance strips existing blocks before it appends.
- **`permission.skill` and per-agent lists.** `skill: deny`, `skill: {"*": "deny"}` and an agent-level `{"*": "deny"}` remove the `skill` tool and list no skills, the plugin's included. A per-name allow keeps the named skill, and a per-name deny hides just that one.
- **Session replay after uninstall.** A resumed session replays the old `tool_calls` entry (`probe_tool`) and its result as history while the tool is no longer offered, and the run exits 0. Whether a real provider accepts that history is not tested at $0, so the docs say to start a new session after removing the plugin.
- **Stale `skills.paths`.** A path added by an earlier plugin config does not survive a fresh config load; the host keeps no copy, so no scrub is needed.
- **Config-dir install.** The first run that loads a plugin makes the host run `npm install @opencode-ai/plugin` in `OPENCODE_CONFIG_DIR` (about 20 s, over the network). The probe tests install it once and copy the directory into each fixture, with `npm_config_offline=true`.
- **Not run.** `Agent.generate` (the `opencode agent create` path) also triggers the transform hook, with no `sessionID` (read from the 1.19.4 binary, not run).

## Manual check: Systematic loaded alongside

Not automated and not run yet. `src/plugin/integration.test.ts` covers the plugin alone; coexistence with Systematic is checked by hand when its pin changes.

1. In a scratch project, set `opencode.json` to `{"plugin": ["@fro.bot/systematic@<pinned version>", "<file:// URL of the extracted metacogs package>/dist/index.js"]}` and start `opencode`.
2. Send one message and read the request (`opencode run --print-logs`, or a recording provider). Expect the system text to hold one `<SYSTEMATIC_WORKFLOWS>` block and one `<METACOGS_GUIDANCE>` block, each once.
3. Run `opencode debug config`. Expect `command` to hold nothing from metacogs and `skills.paths` to list the package's `skills/` and `plugin/skills/`.
4. Expect `synthesis`, `counterfactual`, `feel` and `drugs` in the skill list. Systematic applies its own per-agent skill rules, which can hide the metacogs skills from the agents it manages; note any agent that loses them.

## Guided reads: harness

`src/spike/feel-drugs/guided.ts` runs the plugin arms against the packed package (`bun run spike:guided`). The model is offered, per arm:

| Arm | Read | Permission | Offered tools |
| --- | --- | --- | --- |
| N1 | 1 | every built-in tool denied | none |
| P1 | 1 | the same, with `skill` limited to `synthesis`, `counterfactual`, `feel` and `drugs` | `metacogs_feel`, `metacogs_drugs`, `skill` |
| N2 | 2 | the shell, the network and outside directories denied; the rest at the host default | GPT: `apply_patch`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`. Anthropic: `edit`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`, `write` |
| P2 | 2 | as N2, with the plugin loaded | N2's tools plus `metacogs_feel` and `metacogs_drugs` |

A run is `completed` only if the offered names, the plugin tools' property names and their `required` lists match that table; otherwise it is `tools_missing` or `tools_extra`. Read 2 lists `customize-opencode` beside the plugin skills (`feel` and `drugs` also run as slash commands: the host exposes every skill that way). Read 1 uses the four prompts in `prompts.md`; read 2 adds the two in `coding-prompts.md`, and a metacogs call on those is recorded as unwanted.

Live runs refuse unless `prompts_sha256`, `guidance_sha256` and (read 2) `coding_prompts_sha256` in this README match the files. `--cells one-per-model` (or `<prompt>@<model>`) runs a first pass, and a later full run keeps those runs.

### Frozen files

`plugin/guidance.md` is the guidance text the owner approved as committed. `coding-prompts.md` is the owner-approved read 2 coding prompts. Any edit to either needs its hash recomputed (`shasum -a 256 <file>`) in the same commit, and a change to the guidance wording starts a fresh read.

guidance_sha256: 991907a6a7eddb385cf0c453be75b0fa536a00fe56777dba770b18f0b9186758
coding_prompts_sha256: 39351741feea49278bdfdbb261f5e691c0ff3ad4aff06d7e867b39d3ccc8b0ea

### Diagnostic arms

`--guidance on|off` and `--nudge` run read 1's P1 arm with the guidance block switched off (`{ "guidance": false }` in the plugin entry; the packed `plugin/guidance.md` and its frozen hash are unchanged) and/or the spike's nudge sentence appended to the prompt, exactly as the spike driver's `--nudge` does. They need `--read 1 --arm P1`. The four arms are A (guidance on, no nudge), B (guidance and nudge), C (neither) and D (nudge alone); `--start-run <n>` numbers an invocation's runs from `n` so interleaved invocations form one set. Records carry `guidance_enabled` and `nudge`, and the campaign directory is `diag-<arm>-<model>` under the guided state root. A diagnostic campaign is not part of a read: `spike:blind` refuses `diag-*` directories and any record with the nudge or guidance off.

### Environment variables

| Variable | Effect |
| --- | --- |
| `METACOGS_HOST_SUITES=1` | Runs the host-backed scripted suites in `guided.test.ts` and `blind.test.ts` (several minutes, $0). Run it before a read and on a host pin bump. The pure unit tests in those files run every time. |
| `METACOGS_HOST_PROBES=1` | Runs the plugin host probes in `src/plugin/probe.test.ts` (about three minutes, $0). Run it on a host pin bump. |
| `METACOGS_REQUIRE_HOST=1` | Makes `src/plugin/integration.test.ts` fail instead of skip when the pinned host is unavailable. CI sets it. |

Command runs (`--read 2 --command feel --command drugs=caffeine`) send the prompt, then `opencode run --continue --command <name> [args]` in the same fixture, with isolation checked on each turn. They are P2 runs in their own campaign directory (`commands2-<model>`), one record per run with the turn-2 calls under `second_turn`. `spike:blind` puts them in the key and `spike:reveal` reports them in a checks-only table: per model and command form, how often the tool call followed, how often the main field held the argument text, and which fields were filled. They are not part of any cell or of the rule.

Blind read: `bun run spike:blind --campaign <dir>...` writes `sheet.md` (answers only, a random X/Y side per cell, one hidden control cell of two nothing runs against two) and `key.json` under the state root. The control cell is a prompt and model with four nothing runs and no plugin run (`--arm N1 --runs 4`). Mark each cell's `Verdict:` line X, Y or same, then `bun run spike:reveal --dir <dir>` refuses until every cell is marked, applies the rule and writes `revealed.md`.
