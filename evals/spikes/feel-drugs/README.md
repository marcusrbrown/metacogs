# feel/drugs mechanism spike

An experiment with a human read, not a method: no prereg, rubric, judge, tally or matrix cell. Epoch 1 of this spike; the frozen prompt hash below is its only contract.

**Epoch 2 (declared 2026-10-27).** Epoch 1 is the MCP spike below: arms A, B and C, the four prompts in `prompts.md`, the upstream tool names `metacog_feel` and `metacog_drugs`. Epoch 2 adds, without changing epoch 1's frozen prompts, hash or recorded results:

- **Plugin reads.** The packed OpenCode plugin against nothing, in blind reads 1 and 2 (see [Guided reads: harness](#guided-reads-harness) and [Plugin reads](#plugin-reads)).
- **Coding prompts.** `c1` and `c2`, the draft coding prompts for read 2, frozen with their own hash.
- **The guided harness.** `src/spike/feel-drugs/guided.ts` and `blind.ts`, with their own run records, expected-tool tables and diagnostic arms. `p1` is left out of the guided reads; `prompts.md` and its hash are unchanged.
- **The tool rename.** The plugin's tools are named `feel` and `drugs`; earlier runs recorded them as `metacogs_feel` and `metacogs_drugs`, and the MCP spike keeps `metacog_feel` and `metacog_drugs`. The blind sheet counts all three names in past records.

**Epoch 3 (declared 2026-10-29).** Adds the hands-on [tool-description activation probe](#tool-description-activation-probe-2026-10-29): the `feel` and `drugs` tool text on main `fdd49cf` against the text in `e5416f2`, in the owner's real stack. It changes no earlier epoch's prompts, hashes or recorded results.

**Epoch 4 (declared 2026-10-29).** Adds the [user-turn reminder probe](#user-turn-reminder-probe-2026-10-29): the same tool text with and without an opt-in reminder injected on each request, in the owner's real stack. It changes no earlier epoch's prompts, hashes or recorded results.

**Epoch 5 (declared 2026-11-08).** Adds the [session replays](#replay-mechanism): real moments from past sessions resumed with `Continue.`, `/feel` and `/drugs` (bare and with arguments), then scored by an automated judge, plus the bare-command paragraphs in `plugin/skills/{feel,drugs}` rewritten from those results. It changes no earlier epoch's prompts, hashes or recorded results.

Results recorded under an earlier epoch stay that epoch's results. Plan: `docs/plans/2026-10-25-001-feat-feel-drugs-spike-plan.md`. Requirements: `docs/brainstorms/2026-10-25-feel-drugs-spike-requirements.md`.

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
| P1 | 1 | the same, with `skill` limited to `synthesis`, `counterfactual`, `feel` and `drugs` | `drugs`, `feel`, `skill` |
| N2 | 2 | the shell, the network and outside directories denied; the rest at the host default | GPT: `apply_patch`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`. Anthropic: `edit`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`, `write` |
| P2 | 2 | as N2, with the plugin loaded | N2's tools plus `feel` and `drugs` |

A run is `completed` only if the offered names, the plugin tools' property names and their `required` lists match that table; otherwise it is `tools_missing` or `tools_extra`. Read 2 lists `customize-opencode` beside the plugin skills (`feel` and `drugs` also run as slash commands: the host exposes every skill that way). Read 1 uses the prompts in `prompts.md` except p1, the lighthouse story (p2 to p4; the file and its hash are unchanged); read 2 adds the two in `coding-prompts.md`, and a metacogs call on those is recorded as unwanted.

Live runs refuse unless `prompts_sha256`, `guidance_sha256` and (read 2) `coding_prompts_sha256` in this README match the files. `--cells one-per-model` (or `<prompt>@<model>`) runs a first pass, and a later full run keeps those runs.

### Frozen files

`plugin/guidance.md` is the guidance text the owner approved as committed. `coding-prompts.md` is the owner-approved read 2 coding prompts. Any edit to either needs its hash recomputed (`shasum -a 256 <file>`) in the same commit, and a change to the guidance wording starts a fresh read.

guidance_sha256: 188a643060cee63356f007da187f6bc79c128ebc6de0544872741ea617d3d369
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

## Plugin reads

Facts from the runs against the packed plugin on OpenCode 1.19.4, through CLIProxyAPI, models `openai/gpt-6-luna`, `openai/gpt-6.1-sol`, `anthropic/claude-haiku-5-5` and `anthropic/claude-opus-5-5`. Counts come from the `run.json` files in the guided state root. The plugin's tools were named `metacogs_feel` and `metacogs_drugs` when these runs were made; they are `feel` and `drugs` now.

- **Read 1** (nothing arm against plugin arm, prompts p1 to p4, blind marks by the owner). The plan's rule was met: three cells had a plugin arm that loaded a skill, all three were marked for the plugin, net +3, no model at -3 or worse. The other 12 cells were excluded because the plugin arm never fired. None of the 30 plugin runs called a metacogs tool; 6 loaded a skill (Luna 2, Haiku 2, Sol 2, Opus 0). The control cell (two nothing runs against two) was marked `same`.
- **Guidance on and off.** Diagnostic runs of the plugin arm on p2 and p3, 6 runs per model and condition: guidance on (A), on with a nudge sentence (B), off (C), off with the nudge (D); B and D on Luna only. Runs with a metacogs call: A Luna 1, others 0; C Luna 3, others 0; B Luna 4; D Luna 3. Skill loads were 2 or 3 of 6 in every condition. Guidance on or off made no consistent difference, and Haiku, Sol and Opus made no call under either.
- **Read 2** (nothing arm against plugin arm under the host's default tools, p1 to p4 plus the coding prompts c1 and c2). None of the 46 plugin runs called a metacogs tool, on a coding prompt or otherwise. 18 loaded a skill (Luna 6 of 12, Haiku 6 of 10, Sol 5 of 12, Opus 1 of 12). The sheet and key are written; the owner read is pending.
- **Command runs** (prompt, then `/feel` or `/drugs` with and without arguments; 8 per model). All 32 completed, and in all 32 the second turn made a metacogs call. These ran while the plugin registered the commands itself, before `feel` and `drugs` became skills.
- **After the reads** the guidance and the `feel` and `drugs` skills were rewritten (observable triggers, tool roles, evidence after the call, an ordering line) and `feel` and `drugs` moved from plugin commands to skills. `guidance_sha256` changed with the rewrite, so none of the runs above used the current wording. p1 was dropped from the guided reads; `prompts.md` and its hash are unchanged.
- **Hands-on probes** (not scored): debugging, design and long sessions on Luna and Opus with Systematic, oh-my-opencode-slim, magic-context and aft loaded, each at one checkpoint with `/feel` or `/drugs` against a plain "Stop and reassess your approach before continuing." Findings:
  - No turn that was not a `/feel` or `/drugs` invocation called `metacogs_feel` or `metacogs_drugs`. At each of four conflicts (a requirement against a test, or against a platform limit) both models loaded `counterfactual` first.
  - At the design conflict `/drugs` was followed by a different next step on both models: Luna worked out a conditional quota-partition design and changed no code; Opus wrote a simulation and reported a design that held in every simulated case (simulated, not proved). The plain reassess prompt gave a restated conclusion on Luna and a self-critique on Opus, with no new design.
  - At the policy-against-test conflict `/feel` was followed by evidence gathering before any change (a call-graph check on Luna, a review of its own diff on Opus). The plain reassess prompt gave reflection and a recommendation. `/feel` was slightly ahead.

#### Tool-description activation probe (2026-10-29)

Not scored. Two arms: the `feel` and `drugs` tool text on main (`fdd49cf`) against the text in `e5416f2`, guidance unchanged. Luna and Opus, run in the owner's real stack (Systematic, oh-my-opencode-slim, magic-context and aft loaded).

- Neither model reached a debug stuck point. Both debug seeds, including the harder one, were solved unaided in one turn, so no debug continuation ran.
- The second design seed gave one checkpoint per model: Luna after turn 4, Opus after turn 3 (cut short for budget). There were 4 continuations on "Continue." (2 per model, one per arm), and neither arm made a tool call in any of them.
- 12 controls (a story, a coding task with a typo'd path, a go/no-go question; both arms, both models) made 0 `feel` or `drugs` calls. `counterfactual` loaded on the go/no-go control under both arms.
- Cost: about $3.87 as reported by the host, about $6.2 by estimate.
- Reading: the description wording produced no measured change in unprompted use and did not overtrigger. The text ships as a clarity and correctness fix. The user-turn reminder probe below followed.
- Caveat: the raw events of the main-text (CURRENT) continuations were lost; only their summaries survive.

#### User-turn reminder probe (2026-10-29)

Not scored. Both arms used the new tool descriptions. ON added an opt-in reminder, injected through `experimental.chat.messages.transform` on every main request, with this text: "If the same failure has persisted across materially different attempts, or your next step would repeat a hypothesis you have already exhausted, call `feel` before the next move. If a requested creative or design exploration keeps circling the same rejected alternatives, call `drugs` before the next attempt."

- Delivery: the reminder reached both request formats, OpenAI Responses and Anthropic Messages. It was present on all 64 recorded ON requests, including tool-loop steps.
- Design checkpoints: probe 1's, reused, with 4 continuations on "Continue.". Luna ON called `feel` once. Its next action matched the OFF answer: a best-effort layout labelled as not unique. Opus made no call in either arm.
- Debug: one new seed per model with ON from turn 1. Both models solved it on the first attempt, so it was ineligible.
- Controls: 6 ON controls, 0 calls.
- Cost: about $1.25 host-reported, about $2.15 estimated.
- Reading: the reminder can produce a call, but the call did not change the next action, and Opus ignored the reminder. The reminder does not ship. Across the spike, both plugin reads and these two probes, unprompted use of `feel` and `drugs` gave no measured benefit in the owner's stack. The tools are used when the user calls them at a stuck point (`/feel`, `/drugs`, or naming the tool).
- Caveats: in three probes neither model reached a genuine debug stuck point. All cells are single runs.

#### Replay mechanism

Free probe (`src/spike/feel-drugs/replay/probe.test.ts`, `METACOGS_HOST_PROBES=1`, scripted provider, no paid call). Facts from two clean passes of 13 probes.

- **Host:** `1.19.5+harness.bf7f7dfe`, the daily `npm-fro-bot-harness` build run directly, never `--pure`.
- **Chosen mechanism: import.** Take a session export (`opencode export <id>`, shape `{ info, messages: [{ info, parts }] }`), set `info.directory` to the new fixture's workspace, run `opencode import <file>` in a fresh fixture, then `opencode run --format json --model <provider/model> -s <id> <arm message>`. The next request matched the source: same messages in the same order, the `read` call with its result, the `task` call with its result (child session id included), the same tool set, same part contents in the export, no compaction and no extra provider request.
- **Rejected: `-s <id> --fork`.** History and parts match, but the fork loses the source session's `question: deny` rule, so the host offers a 40th tool, `question` (source 39). A headless run cannot answer it. Fork also needs the source session to stay unmodified, which `-s` alone does not.
- **One fixture per attempt.** The installed plugin cache is about 1.6 GB; `cp -c` clones it in about 6 s. Stdout and stderr must go to files, because a pipe cuts `opencode debug config` at 768 KiB. Runs took 2 to 4 s and none hung.
- **Skill content and arguments.** `--command feel` and `--command drugs` put the skill text in the first text part of the last user message. It starts `# feel` or `# drugs` and ends with `Base directory for this skill: <package>/plugin/skills/<name>` and a relative-paths line; arguments follow that line. There is no `<skill_content>` wrapper (that appears only in `skill` tool output). `feel` and `drugs` are not in `debug config` commands; the host builds them from the skills. Arguments: none gives nothing, one word arrives raw, several argv words arrive joined raw, one argv element with spaces arrives JSON-quoted (`"strong black coffee"`). `feel` and `drugs` are offered as tools, and both skills are listed.
- **Added by the stack.** magic-context adds two `<session-history>` user messages before the history and a numeric tag prefix on text parts. Slim adds `<system-reminder>` parts to the last user message, and a Council Mode block once per session on the first user text matching its keyword pattern; the `/drugs` text matches and `/feel` does not. The fidelity check drops reminders and tags before comparing.
- **Default agent:** `orchestrator` (slim). `--model` overrides slim's preset: `openai/gpt-6-luna` reached the stub as `gpt-6-luna` and `anthropic/claude-opus-5-5` as `claude-opus-5-5`, both recorded on the assistant message with agent `orchestrator`. Title and `explorer` subagent requests use `claude-haiku-5-5`, so a returned-model gate must read the main request only. Slim's prompt never says "OpenCode", so `isMainRequest` does not find the main request; the probe uses the request that offers both `task` and `feel`.
- **Stack:** five plugins in `plugin_origins` (slim, magic-context, aft, Systematic, packed metacogs), no auth plugins, `mcp` empty. 39 tools including `feel` and `drugs`; 47 skills including `feel`, `drugs`, `synthesis`, `counterfactual`. Slim adds the orchestrator, explorer, oracle, designer, fixer, council and fast-generic agents and `interview`, `implement`, `deepwork`, `reflect`; Systematic adds its research and review agents and the `systematic:*` and `ce:*` commands; magic-context adds hidden historian and dreamer agents and `ctx-*` commands; aft adds `aft-status`.
- **Wire shapes.** The scripted provider speaks chat completions. Reading the same facts from Responses (`input[]` items with `input_text` blocks) or Anthropic (`messages[]` with `text` blocks, top-level `system`) needs a user-text reader for those shapes. `userTextsAnyWire` in the probe covers them against hand-built bodies only; check it against a captured live body.
- **CLIProxyAPI `GET /v1/models`:** lists `claude-opus-5-5` (owned by anthropic) and `gpt-6-luna` and `gpt-5.6-luna` (owned by openai). No `opencode-go/` id contains `luna`, so the list does not show Luna served through opencode-go.
- **Egress switches set in the fixture:** slim `autoUpdate: false` and `disabled_mcps: [context7, gh_grep]` (it adds both remote MCPs by default); magic-context `auto_update: false`, `embedding.provider: "off"`, `historian.disable` and `dreamer.disable` (the log shows `dreamer.disable is true` and `dreaming=false`); aft `auto_update: false` and `indexes.semantic: false` (without it the first run starts an ONNX Runtime download from GitHub); Systematic `search.allow_project_sources: []` (no network code in its bundle); host `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_LSP_DOWNLOAD` and `share: disabled`. A full turn under a proxy that refuses every tunnel, with the process group sampled for open sockets, showed no outside connection. Only plugin installs (first run) and the provider call use the network. Left on and not exercised: slim's ast-grep download and `webfetch`, aft's URL tools, which run only when a model calls them.
- **Not copied in the probe:** the aft and magic-context configs, which the probe could not read. The fixture writes only the switches above, so other settings are defaults.

#### Real-world replay mode

Replaces the paraphrased fixtures, whose answers were dominated by "no repo, gh denied" noise. Same host path (import, then `opencode run -s <id>` with `--command <name> <argv words>`), but the history and the world are real. Everything it builds is private: it lives under `<state root>/replay/world/<id>/` (0700/0600), never in the repo.

- **Scenarios.** `world/<id>/spec.json` carries `id`, `kind`, `project`, `source_session`, `cutoff_message`, `somewhere`, `substance`, `expected_outcome_ref` and an optional `author_next_turn_ref`. Both `_ref` fields are for the judge only; neither is sent to the agent or written to an attempt record. `substance` defaults to `caffeine` for /feel and ordinary moments and `psilocybin` for /drugs moments. The 11 scenarios are the 8 feel and drugs fixtures plus `ord-sys-46`, `ord-sys-20` and `ord-fro-130`; specs come from the paraphrased fixtures' provenance, and `author_next_turn_ref` is the first human-typed user message after the cutoff (first text part not starting with `<`).
- **History.** The real `message.data` and `part.data` rows up to and including the cutoff, mapped to `{ info, messages: [{ info, parts }] }` by adding the row ids (`id`, `sessionID`, `messageID`). The mapping was compared with a real `opencode export` of a scripted session (host test). Window: from the latest `compaction` part, else the last N messages, with N chosen so the estimate (content characters over four, no system prompt or tool schema) stays under 120k tokens; it starts on a user message. Parts the importer would reject (unknown type, malformed) are dropped and counted per type. Nothing is stripped for privacy. The export ends on the cutoff assistant message and `meta.json` records the window, the token estimate and the drop counts.
- **World.** Each attempt clones the local checkout with `git clone --local --no-hardlinks` into the fixture workspace, then fetches the source's remote-tracking refs. Commit rule 1: a branch the session named (`On branch`, `Switched to branch`, `git checkout -b`, `git status -sb`, `git branch --show-current`, a `.worktrees/<branch>` directory) that exists locally or remotely, at its tip at or before the cutoff. Rule 2: `git rev-list -1 --before=<cutoff ISO> origin/main`. `origin` is set to the GitHub URL and `remote.origin.pushurl` to `DISABLED`. `attempt.json` records `world: { repo, commit, rule, gh: 'read' }`, the history window and `hindsight_note: 'gh reads show current GitHub state'`. Branches the sessions named were deleted after merging, so all 11 resolve by rule 2 today.
- **gh reads.** The local gh token comes from `hosts.yml` or `gh auth token` (for a keyring-backed config), is written to a 0600 `hosts.yml` in the fixture, pointed at with `GH_CONFIG_DIR`, deleted when the run ends, and used as a leak-scan needle. The shell rules deny `gh auth*` and any command naming `hosts.yml` or `auth.json`.
- **Permissions.** Read, edit, write, bash, git, gh reads and task subagents are allowed in the clone; subagents inherit the rules. Denied: `git push`, the `gh pr`, `gh issue`, `gh workflow`, `gh run`, `gh release`, `gh repo` writes, `gh api` with a method other than GET or with `-f`, `-F`, `--field`, `--raw-field` or `--input`, `npm`/`bun`/`changeset publish`, `gh` or push behind a wrapper or an env prefix, and writes outside the clone. **Permissions alone do not confine the shell:** with `bash` allowed, a scripted `touch` and `echo >` outside the clone both succeeded on the host. Every real-world host process therefore runs under `/usr/bin/sandbox-exec` with writes denied outside the fixture root and the bun install cache, and `~/.ssh`, `.gnupg`, `.aws`, `~/.config/gh` and `~/.local/share/opencode` unreadable. An attempt refuses to start without it.
- **Project config.** The clone's own `opencode.json` applies, as in the daily setup. Systematic's declares `./src/index.ts` as a plugin, so the stack check allows plugin origins that are `file://` paths inside the clone; the generated permission, share and compaction keys must still survive exactly, or the attempt is excluded.
- **Scripted check of the real history.** One scripted-provider attempt per scenario imported all 11 real histories (nothing dropped) and passed every gate.
- **Arms.** `continue-a`, `continue-b`, `feel`, `feel-somewhere`, `drugs`, `drugs-substance`. Generous timeout (15 minutes); the host offers `agent.<name>.steps` as a tool-step cap, which is not set because slim defines the orchestrator.
- **Known limits.** Child sessions of `task` calls in the history are not imported, so resuming one by `task_id` fails. Uncommitted work and unpushed branches of the original moment are not reconstructable. The history keeps the original absolute paths, which now sit outside the clone.
- **Trust boundary.** The replay runs your own agent on your own sessions, with the same access it has in daily use. The sandbox and deny rules guard against accidental outward actions and stray writes. They are not a security boundary against a hostile history or repo: the gh login and same-user reads are reachable from inside. A campaign's cap is checked per invocation, so parallel invocations on one campaign can each overshoot it by one attempt.

```
bun run replay world specs [--fixtures <ids|all>] [--db <path>] [--force]
bun run replay world build [--fixtures <ids|all>] [--db <path>] [--budget <tokens>] [--resolve]
bun run replay world list
bun run replay campaign --world real --name <n> --models <list> --arms <list|all> --fixtures <ids|all> --cap <usd> [--provider scripted|cliproxy ...]
```

#### Real-world replay results (2026-11-08)

Campaign `real1`: 11 moments × 6 arms on `openai/gpt-6-luna` and `anthropic/claude-opus-5-5`. That is 61 counted runs per model, because `/feel <where>` runs only on the 6 /feel moments. Every run completed. One errored attempt per model was retried. Charged cost was $169.46 for Opus and $2.69 for Luna.

Scoring: `bun run replay judge real1` with `opencode-go/glm-5.3`, prompt sha `5b01f5736c37`. The reference for each pair was the real-world scenario (outcome, the author's next turn, and a brief from the real history). 21 of 22 pairs were judged, and every noise floor agreed. Luna on `feel-fro-fe3c-94` exceeded the judge's 10-minute request limit on every try.

| Arm | Opus changed, toward / away | Luna changed, toward / away | Ordinary turns derailed (Opus, Luna, of 3 each) |
| --- | --- | --- | --- |
| `/feel` | 6 of 11, 3 / 2 | 7 of 10, 3 / 3 | 0, 1 |
| `/feel <where>` | 3 of 6, 2 / 0 | 5 of 5, 4 / 0 | n/a |
| `/drugs` | 10 of 11, 5 / 3 | 4 of 10, 1 / 2 | 1, 0 |
| `/drugs <substance>` | 5 of 11, 3 / 1 | 6 of 10, 4 / 1 | 0, 0 |

A first judging used the paraphrased fixture as the reference, which was a bug fixed in this PR. It agreed with this one on "changed" for 69 of 74 verdicts, but on the full label for only 58 of 74. Direction is the noisy part.

Reading:
- **Arguments.** `/feel <where>` was never scored away in either judging. `/drugs <substance>` was scored toward 7 times and away 2. Both bare forms came out about even: 6 toward and 5 away each across the two models. Bare `/drugs` changed Opus's move in 10 of 11 runs.
- **Where the gains were.** They clustered where the default move committed to an unchecked premise: dispatching a fixer, relaunching analysis, pushing. Where `Continue.` already took the right step, the commands added nothing.

Caveats:
- One run per arm.
- `gh` and `main` reads show current state, and about a fifth of runs noticed that work had since landed, baseline runs included.
- The judge scores the first substantive move.
- 14 Luna quotes did not match the answer text (`unanchored`).

The guide built from this is [docs/using-feel-and-drugs.md](../../../docs/using-feel-and-drugs.md).
