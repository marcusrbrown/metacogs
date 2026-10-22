# Runner transport and isolation evidence (Unit 1 spike)

Status: **GO**, with four amendments to the plan's Key Technical Decisions (see [Amendments](#amendments-to-the-key-technical-decisions)).

Evidence is reproducible: `bun test src/runner/spike` (scripted provider, 25 tests) and `METACOGS_LIVE=1 bun test src/runner/spike` (adds one live request). Measured on macOS arm64, Bun 1.4.3, 2026-10-22. Linux, CI and Windows are not exercised.

## Pinned OpenCode

| Item | Value |
| --- | --- |
| Version | `opencode-ai@1.19.4` (`bunx opencode-ai@latest --version` on 2026-10-22) |
| Launcher | `bunx opencode-ai@1.19.4 …`, constant `OPENCODE_PIN` in `src/runner/spike/env.ts` |
| Availability probe | memoized `bunx opencode-ai@1.19.4 --version`; last stdout line must equal the pin. If not, the suite is skipped with a `!!! OPENCODE SPIKE TESTS WILL BE SKIPPED` warning |
| Live model | `opencode/big-pickle` (available; no fallback needed) |

## Transport decision

**`opencode run --format json`**, one process per run, stdin closed (`stdio: ['ignore', …]`; an open stdin pipe makes `run` wait), own process group so a timeout reaps `bunx` and its `opencode` grandchild.

`opencode serve` is **not** needed. `run` exposes tool calls, skill loads, assistant text, usage and timing. `serve` was probed anyway (`GET /global/health` → `{"healthy":true,"version":"1.19.4"}`; `GET /experimental/tool?provider=&model=` → 200). That endpoint is a registry listing: it is not permission-filtered (`edit`, `write` appear though denied) and the `skill` tool description contains no `<available_skills>` block. It cannot serve as the loaded-skills instrument.

`--dir <ws>` from an unrelated cwd resolves the same workspace skills as `cwd = <ws>`. Both work; the runner should use `cwd`.

Quirk: the prompt reaches the model JSON-quoted (`"Reply with exactly the word: pong"`, quotes included) when it contains spaces.

## Child env allowlist

Built from scratch in `buildChildEnv` (`src/runner/spike/env.ts`); nothing is filtered out of `process.env`.

| Variable | Value |
| --- | --- |
| `PATH` | parent `PATH` (needed to find `bunx`, `git`, `node`) |
| `HOME` | `<fixture>/home` |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | `<fixture>/xdg/{config,data,state,cache}` |
| `TMPDIR`, `TMP`, `TEMP` | `<fixture>/tmp` |
| `LANG`, `LC_ALL` | `C` |
| `TZ` | `UTC` |
| `TERM` | `dumb` |
| `NO_COLOR` | `1` |
| `OPENCODE_CONFIG` | `<fixture>/opencode.json` (generated) |
| `OPENCODE_CONFIG_DIR` | `<fixture>/opencode-config-dir` (empty) |
| `OPENCODE_DISABLE_AUTOUPDATE`, `_LSP_DOWNLOAD`, `_MODELS_FETCH`, `_PRUNE` | `1` |
| `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS` | `1` |
| `BUN_INSTALL_CACHE_DIR` | shared `<os tmpdir>/metacogs-bun-install-cache-<uid>-<pin>` |

Not present: any `*_API_KEY`/`*TOKEN*`/`*SECRET*`, any `METACOGS_*`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`. A test asserts the key set. The workspace is a `git init`'d directory inside the fixture; `HOME` and the XDG dirs are **siblings** of the workspace, not inside it (inside would put them within the agent's default read scope).

Cost of the allowlist: with `TMPDIR` inside the fixture, `bunx` re-extracts the package each run. Spawn to first event is about 4.5 s warm (see [Timings](#timings)). A stable shared `TMPDIR` cut this to about 3.5 s in a one-off test. Not adopted: it weakens `TMPDIR` isolation for roughly 1 s per run.

## Config injection

Both channels are honored for `permission`, `provider`, and the other settings tested:

| Channel | Result |
| --- | --- |
| `OPENCODE_CONFIG=<file>` only | honored |
| `OPENCODE_CONFIG_CONTENT=<json>` only | honored |
| both | **deep-merged**; on a same-key conflict the inline content wins (`file {*:allow}` + `content {*:deny}` → denied; `file {*:deny, spike-demo:allow}` + `content {*:deny}` → `spike-demo` still allowed) |

Decision: use the **file** only. Using both is a footgun because deny-all in one channel does not cancel an allow in the other. `OPENCODE_CONFIG_DIR` holds agents and commands, not settings, and is left empty.

Generated config (effective values confirmed by `debug config` and `debug agent build`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "permission": {
    "edit": "deny",
    "external_directory": "deny",
    "bash": { "*": "deny", "node *scripts/record.mjs*": "allow" },
    "skill": { "*": "deny" }
  },
  "provider": { "metacogs-spike-provider": { "…": "scripted mode only" } }
}
```

The shell permission key is **`bash`**, not `shell`. `node *scripts/record.mjs*` allows `node <abs path>/scripts/record.mjs`, and any other command is denied (tested). Never `--auto`.

## Event mapping (`--format json`)

One JSON object per stdout line; no non-JSON lines on stdout in the observed runs. `bunx` writes install noise (`Resolving dependencies`, `Saved lockfile`) to **stderr**. Schema is undocumented; the mapping below is observed on 1.19.4 only, so the runner must fail closed on unknown event shapes.

Top level on every event: `type`, `timestamp` (epoch **ms**, wall clock), `sessionID`, plus `part` or `error`.

| Concept | Event | Fields |
| --- | --- | --- |
| Turn boundaries | `step_start` / `step_finish` | `part.type` = `step-start` / `step-finish`; `part.reason` = `tool-calls` or `stop` |
| Tool call | `tool_use` (emitted once, after the call settles; no pending/start event) | `part.tool` (name), `part.callID`, `part.state.status` (`completed` \| `error`), `part.state.input`, `part.state.output` (completed), `part.state.error` (error), `part.state.metadata`, `part.state.title`, `part.state.time.{start,end}` (epoch ms) |
| Skill load | `tool_use` with `part.tool === "skill"` | `part.state.input.name`; `part.state.metadata.{name,dir,truncated}`; `part.state.output` is `<skill_content name=…>` with the body, `Base directory for this skill: <abs dir>`, and a `<skill_files>` list sampled from the skill dir |
| Assistant text | `text` | `part.text`, `part.time.{start,end}` |
| Usage | `step_finish` | `part.tokens.{total,input,output,reasoning,cache.{read,write}}`, `part.cost`; sum across `step_finish` events |
| Timing | every event `timestamp`; tool/text `part.time` | spawn→first event ≈ startup |
| Fatal error | `error` (exit code 1) | `error.name`, `error.data.message` (+ `statusCode`, `responseBody` for `APIError`) |

Observations the checker must respect:

- **Events arrive in completion order, not call order.** With two parallel tool calls, the denied one appeared first. Match on `part.callID`.
- **Skill directory is exposed**: in `part.state.metadata.dir` and in the output text. SKILL.md does not need an install-relative helper path convention; it can say "run the `scripts/record.mjs` in this skill's base directory". Paths are realpaths (`/private/var/…` on macOS).
- **A denied skill is not silent.** Under `skill: {"*":"deny"}` the `skill` tool is removed from the model's tool list. A model that calls it anyway produces `tool_use` with `part.tool === "invalid"` and output `…Model tried to call unavailable tool 'skill'. Available tools: …`. "No method fired" must treat that as an attempted fire (or check the model-visible tool list), not as silence.
- A `tool_use` with `status: "error"` still has exit code 0 for the run.

Sample (scripted, trimmed; temp paths replaced with `<tmp>`):

```jsonl
{"type":"step_start","timestamp":1792683473300,"sessionID":"ses_…","part":{"type":"step-start","snapshot":"d2e4e9d…"}}
{"type":"tool_use","timestamp":1792683473322,"sessionID":"ses_…","part":{"type":"tool","tool":"skill","callID":"spike-skill-call","state":{"status":"completed","input":{"name":"spike-demo"},"output":"<skill_content name=\"spike-demo\">\n# Skill: spike-demo\n\nSPIKE_DEMO_BODY_MARKER_19d2\n\nBase directory for this skill: <tmp>/workspace/.agents/skills/spike-demo\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file><tmp>/workspace/.agents/skills/spike-demo/scripts/record.mjs</file>\n</skill_files>\n</skill_content>","metadata":{"name":"spike-demo","dir":"<tmp>/workspace/.agents/skills/spike-demo","truncated":false},"title":"Loaded skill: spike-demo","time":{"start":1792683473299,"end":1792683473320}}}}
{"type":"step_finish","timestamp":1792683473383,"sessionID":"ses_…","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":18,"input":11,"output":7,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
{"type":"step_start","timestamp":1792683473466,"sessionID":"ses_…","part":{"type":"step-start"}}
{"type":"text","timestamp":1792683473466,"sessionID":"ses_…","part":{"type":"text","text":"spike done","time":{"start":1792683473463,"end":1792683473464}}}
{"type":"step_finish","timestamp":1792683473554,"sessionID":"ses_…","part":{"type":"step-finish","reason":"stop","tokens":{"total":18,"input":11,"output":7,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
```

Denied read outside the workspace (`external_directory: deny`; error text trimmed):

```jsonl
{"type":"tool_use","timestamp":1792683484554,"sessionID":"ses_…","part":{"type":"tool","tool":"read","callID":"r1","state":{"status":"error","input":{"filePath":"<tmp>/outside/canary.txt"},"error":"The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{\"permission\":\"*\",\"action\":\"allow\",\"pattern\":\"*\"},{\"permission\":\"external_directory\",\"pattern\":\"*\",\"action\":\"ask\"}, … {\"permission\":\"external_directory\",\"action\":\"deny\",\"pattern\":\"*\"}, …]","time":{"start":1792683484542,"end":1792683484549}}}}
```

Nonexistent model (exit 1, no provider request made):

```jsonl
{"type":"error","timestamp":1792683488856,"sessionID":"ses_…","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_6423878c"}}}
```

Live smoke (`opencode/big-pickle`, exit 0):

```jsonl
{"type":"step_start","timestamp":1792683544505,"sessionID":"ses_…","part":{"type":"step-start","snapshot":"4b825dc…"}}
{"type":"text","timestamp":1792683544585,"sessionID":"ses_…","part":{"type":"text","text":"pong","time":{"start":1792683544581,"end":1792683544582}}}
{"type":"step_finish","timestamp":1792683544615,"sessionID":"ses_…","part":{"type":"step-finish","reason":"stop","tokens":{"total":6878,"input":5083,"output":3,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}
```

## Provider modes

**Scripted** (`src/runner/spike/scripted-provider.ts`): `Bun.serve` on a random port speaking OpenAI `/chat/completions` SSE. Registered as provider `metacogs-spike-provider`, model `metacogs-spike-model`, placeholder key, zero cost, `npm: @ai-sdk/openai-compatible`. The reply is a pure function of the number of completed tool-call rounds in the request history, so the concurrent title-generation request (no `tools`) cannot desynchronise it. The stub can call `skill`, `read` or `bash` by name. It emits a fixed usage chunk (11 prompt / 7 completion tokens), observed as `tokens.input = 11`, `output = 7`.

**Live**: `opencode/big-pickle`, no key anywhere. Free tier works with `OPENCODE_DISABLE_MODELS_FETCH=1` and an empty `auth.json` / data dir. **No auth.json fallback is needed.** The live run is exactly one request pair (title + chat), gated behind `METACOGS_LIVE=1`.

**Recording proxy** (live isolation instrument): `provider.opencode.options.baseURL` can be pointed at a local pass-through that records request bodies (never headers) and forwards to `https://opencode.ai/zen/v1`. Client headers must be forwarded untouched; a bare forward gets `403 FreeTierError`. This gives live runs the same model-visible-prompt evidence as scripted runs. Whether the runner should use it for the real RED/GREEN runs is a Unit 4 decision.

## Instruments and their outputs

| Instrument | What it shows | Verified on 1.19.4 |
| --- | --- | --- |
| **Model-visible request body** (stub or recording proxy): `<available_skills>` in the system prompt, offered tool list, full system prompt | Ground truth for what the model could load and was told. In 1.19.4 the skill list lives in the **system prompt**, not the skill tool description | Clean/deny-all: block and `skill` tool both absent. Allow `spike-demo`: exactly `["spike-demo"]`, built-in hidden. Control: author skills present |
| `opencode debug config` (same env, cwd) | Effective merged config. Isolated: generated keys plus empty host defaults (`agent`, `mode`, `plugin`, `command`, `username`, `compaction`); `apiKey` masked as `***` | No author marker; control shows `small_model` from the planted author config |
| `opencode debug skill` | Discovered skills **before** permission filtering; always includes built-in `customize-opencode` (`location: "<built-in>"`) | Not a loaded-skill instrument; useful for "what exists on disk" |
| `opencode debug agent build` | Effective permission rules, in order | Skill rules read `*:deny`, `spike-demo:allow` |
| Sentinel `AGENTS.md` in a throwaway **author home** | Instruction leakage | Control quotes it in the system prompt; isolated run does not |
| Canary secret in author-home `…/.local/share/opencode/auth.json` | Credential leakage | Never in any transcript; direct reads denied |
| Canary file outside the workspace, read by absolute path | `external_directory` enforcement | Denied, `status: "error"`, denial visible in events |
| Managed-config control: `OPENCODE_TEST_MANAGED_CONFIG_DIR` | Proves the instrument sees machine-level config if it existed | Marker visible with the var set, absent without |

The real `HOME` is never touched. The plan's wording ("sentinel in the real HOME", "canary at the real `auth.json` path") is satisfied with a throwaway author home that mimics the real layout; the unisolated control run points `HOME` at it with no `XDG_*` overrides, exactly as an un-isolated launch on the author's machine would. The control detects `author-private-skill`, `author-agents-skill` (`~/.agents/skills`), `author-claude-skill` (`~/.claude/skills`), the sentinel, and the author `small_model`.

Built-in skill: OpenCode 1.19.4 ships `customize-opencode`. It appears in `<available_skills>` unless `skill` permission hides it. With `{"*":"deny","<name>":"allow"}` only `<name>` is listed. The expected-set check must be an exact set compare, never "contains".

## Isolation controls that matter

- `HOME` + four `XDG_*` dirs redirected: nothing global (`~/.config/opencode`, `~/.agents`, `~/.claude`, `auth.json`) is reachable by default discovery.
- `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`: belt and braces on top of the fake `HOME`.
- Project discovery stops at the workspace: it is its own git root.
- `external_directory: deny`: reads outside the workspace fail. The `external_directory` allow list that `debug agent` shows includes only the fixture's own `xdg/data/opencode/tool-output/*` and `tmp/opencode/*`.
- Machine-level config: `/Library/Application Support/opencode` (macOS; `/etc/opencode` on Linux; `%ProgramData%\opencode` on Windows), `/Library/Managed Preferences/<user>/ai.opencode.managed.plist` and `/Library/Managed Preferences/ai.opencode.managed.plist` (MDM). **None present on this host** (asserted by a test, which fails if any appears). The env allowlist cannot redirect these. A host that has them cannot pass the isolation criterion; `debug config` would show the contribution. Remote `.well-known` config is keyed off `auth.json` entries in the (empty) data dir, so it is not reachable.

## `ask` permission in headless `run`

Neither blocks nor crashes. With `bash: {"*":"ask"}` and a scripted `bash` call:

- stderr: `! permission requested: bash (echo should-not-run); auto-rejecting`
- `tool_use` for `bash` with `status: "error"`, `error: "The user rejected permission to use this specific tool call."`
- exit code 0, and **no further model turn** (the run ends on the rejection; no `text` event)

Contrast with an explicit `deny`: `status: "error"` with the "specified a rule" message, and the model **does** get a follow-up turn. The generated config has no `ask` rules, but note `read` of `*.env*` defaults to `ask`, so such reads silently end the turn.

## Timings

Scripted runs, warm `bunx` cache, macOS arm64, sequential:

| Phase | Wall |
| --- | --- |
| Whole run (spawn → exit) | 3.8 to 5.7 s (typical 4.7 s) |
| Spawn → first event (bunx resolve/extract + OpenCode boot) | 3.8 to 5.4 s |
| First event → last event | 0.05 to 0.3 s |
| Last event → process exit | 15 to 235 ms |
| Live smoke (`opencode/big-pickle`, one `pong` turn) | 6.9 s (about 5.1k input tokens, 3 output) |
| Nonexistent model | 3.8 s, exit 1 |

Cold or contended: first-ever `bunx` of the pin took 17 s; four concurrent cold starts took 25 to 60 s each (`bunx` postinstall 34 to 42 s under contention). Sequential runs are not a convention here, they are a requirement for sane timings.

Seed for the per-run timeout: startup overhead 5 s warm, 60 s cold; live-model latency is the unknown. The tests use 180 s as a guard, which is a ceiling, not a recommendation. Unit 4 should set the prereg timeout from real live-model runs, with startup measured separately.

## Amendments to the Key Technical Decisions

1. **Loaded-skill list source.** The KTD says to read `<available_skills>` from the skill tool description via `/experimental/tool`. In 1.19.4 that description has no list and the endpoint is unfiltered. Replace with: the `<available_skills>` block in the system prompt of the tool-capable request, captured by the local provider (stub or recording proxy). An absent block counts as the empty set. Fallback when no proxy is used: `debug agent build` skill rules plus `debug skill` discovery, which is derived rather than observed.
2. **Permission key.** `shell` → `bash`.
3. **Directory layout.** `HOME`/`XDG_*` should be fixture-level siblings of the workspace, not inside it.
4. **Config channel.** Use `OPENCODE_CONFIG` (file) only; `OPENCODE_CONFIG_CONTENT` deep-merges and wins conflicts, so setting both is unsafe. The plan's "ask" deferral resolves to: auto-reject, turn ends.

## Isolation go/no-go against the criterion

| Criterion | Result |
| --- | --- |
| Loaded-skill list contains exactly the expected set | **Pass**, via the amended instrument (1). Clean: empty; allow: exactly `spike-demo` |
| `debug config` shows only the generated config | **Pass** (generated keys plus empty host defaults; no author marker) |
| Sentinel `AGENTS.md` not quotable | **Pass**; control proves detection |
| Canary secret at `auth.json` path and canary file absent from transcript | **Pass**; control proves the path is otherwise live |
| Skill-tool event names the skill and result gives the directory | **Pass** (`metadata.dir` + output text) |
| "No method fired" checkable from events | **Pass**, with the `invalid` pseudo-tool caveat above |
| Free live model with no credentials | **Pass** |

Verdict: **GO** for Unit 4 on macOS with the amendments. No plan reopening required.

## Limitations and unverified

- One platform (macOS arm64) and one OpenCode build. Managed-config paths on Linux/Windows come from the binary, not from a Linux run.
- `PATH` is inherited, so any allowed `bash` command sees the author's binaries. The `bash` allowlist (one `node` pattern) is the control; `node *scripts/record.mjs*` also matches `node` with any earlier path segment ending in `scripts/record.mjs`, so the helper path should be verified by the runner, not just the pattern.
- The model-visible-prompt instrument needs the local provider/proxy on every run; without it only the derived fallback exists.
- Live isolation test uses only a trivial prompt, so it shows nothing was *offered*, not what a live model would *do* with a leaked instruction. The scripted control covers detection, not live behavior.
- Event schema is undocumented and may change in any release; the pin and `isolation.test.ts` are the tripwire.
- Artifacts (raw stdout/stderr/request bodies) are written to a temp dir (`METACOGS_SPIKE_ARTIFACTS` to keep). They contain only synthetic canaries and paths; real runs must still go through the allowlist projection before anything lands in `evals/reports/`.
