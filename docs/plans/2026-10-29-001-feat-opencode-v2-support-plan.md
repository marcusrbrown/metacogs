---
title: "feat: Load metacogs on OpenCode v2 with parity to v1"
type: feat
status: completed
date: 2026-10-29
---

# feat: Load metacogs on OpenCode v2 with parity to v1

## Overview

OpenCode v2 does not run v1 plugins. This plan makes the single `metacogs` package load on both v1 (1.19.4 and later) and v2 (2.2.0 and later). The default export becomes a plain object `{id, server, setup}`, and the built plugin carries no runtime OpenCode import. A v1 adapter keeps today's hooks. A v2 adapter registers the same tools, guidance, skills and slash commands through v2's own mechanisms. CI gains one required job that runs the packed plugin on a pinned v2 CLI. Everything ships in one PR as a minor release.

## Problem Frame

v2 is GA (2.0.0 on 2026-09-11; 2.2.2 is current) under the `@opencode/*` npm scope. It reads a `plugins` key and calls `setup(ctx)`, and it never calls `server()`. metacogs today exports `{id, server}` and imports `tool` from `@opencode-ai/plugin` at runtime, so a v2 user gets nothing. Systematic has shipped the same migration. This plan follows it where needs match and departs where metacogs differs: a non-persisted guidance block with an opt-out, one slash command per skill, and a record helper that resolves from the skill's base directory.

Owner decisions:
- Match Systematic: no runtime OpenCode imports, both host packages as optional peers, and a plain-object export.
- The v1 floor stays at the tested pin, 1.19.4, with no extra floor smoke.
- One required v2 real-host job. The existing v1 integration tests stay.
- v2 skill bodies are embedded at build time. A successful build is the proof, with no byte-equality test.
- The matrix gets a new host key for OpenCode v2. It is a distinct, incompatible host.
- v2 passes multi-word slash arguments raw. This is documented, not emulated.
- A denied skill typed as a slash command behaves as on v1: it is delivered, with no gate.
- Approved changes: `@opencode/plugin` as a devDependency (lockfile change), `ci.yml`, `.github/settings.yml` required checks, and `.github/renovate.json5`.
- One PR.

## Requirements Trace

- R1. One package loads on v1 (1.19.4 and later) and v2 (2.2.0 and later). (U1, U2, U3)
- R2. v1 behavior is unchanged. The only test edits are import paths, the export-shape and bundle-import assertions, and dropping the fixture's runtime-dependency link. (U1)
- R3. The built plugin has no runtime import of either OpenCode package, both are optional peers, and the entry has exactly one export, the default. (U1)
- R4. On v2, `feel` and `drugs` are offered as callable tools with the same fields, descriptions, required set and result text as on v1. (U2, U3)
- R5. On v2, the guidance block reaches every agent-loop request exactly once and never reaches a title, compaction or generate request. `guidance: false` in the plugin options turns it off. (U2, U3)
- R6. On v2, all four skills register with names, descriptions and bodies equal to v1's, and the record helper resolves from the skill's base directory. (U2, U3)
- R7. On v2, all four skills are slash commands that take raw arguments. A user's same-named command wins. (U2, U3)
- R8. On v2, a failure in one registration does not cost the plugin its other registrations. (U2)
- R9. A required CI job runs the packed plugin on the pinned v2 CLI. The v2 pin has a single source, which Renovate bumps together with the devDependency. (U3, U4)
- R10. The matrix records OpenCode v2 as its own host. The docs cover both config keys and floors, typed slash use on v1, raw arguments and the `permissions` array on v2, and on-disk skill shadowing. (U5)

### Parity map

| v1 behavior | v2 equivalent | Proven by |
|---|---|---|
| `feel`/`drugs` tools via `tool()` and zod args | `ctx.tool.transform` with `z.toJSONSchema` of the same args, `codemode:false` | U2 unit test, U3 load and tool call |
| Guidance appended to `system[0]`, internal requests skipped by signature | `context` session hook pushes a `{type:'text'}` part; title, compaction and generate never reach it | U2 unit test, U3 guidance run |
| `guidance:false` via the tuple options | `guidance:false` via `plugins[].options` → `ctx.options` | U2 unit test, U3 opt-out run |
| Skills from `skills.paths` (`skills/`, `plugin/skills/`) | `ctx.skill.transform` with embedded records; `path` is each `SKILL.md` | U2 unit test, U3 base-directory check |
| Skills become slash commands; a user command wins; a denied skill still runs when typed | `ctx.command.transform`, one per skill, attaching the skill by id and forwarding the invocation envelope (`sessionID`, `delivery`, `prompt.files`, `prompt.agents`, existing `prompt.skills`); a user command wins on the host; no deny gate | U2 unit test, U3 command run (also under a skill deny) |
| Tool and skill of the same name are separate: denying tool `feel` leaves skill `feel`, denying skill `feel` leaves tool `feel` (`src/plugin/names.test.ts:77-89`) | Same separation on v2 | U3 permission-separation runs |
| A throwing hook breaks only that hook | A throwing transform disables the whole plugin on the host, so every transform body and the guidance callback is guarded, including calls after setup | U2 unit test |

## Scope Boundaries

- No v2-only capabilities: storage, RPC, GUI or TUI plugins.
- No changes to the Claude Code or Codex packages, `hosts/**`, the MCP server, the evals or the `skills/**` text.
- No v1 support below 1.19.4 and no v2 support below 2.2.0. Versions below those floors are documented as unsupported, with no shim.
- No change to the v1 TUI `/` popup. Upstream leaves skill-sourced commands out of it by design, and typed `/feel` dispatches. `/counterfactual` and `/synthesis` appear in the owner's popup only because Systematic's `skills_as_commands` turns the repo's local `.agents/skills` mirror into commands.

### Deferred to Separate Tasks

- The changeset gate does not cover `src/plugin/**`, `src/frames/**` or `plugin/**`, so a plugin-only change can ship without a changeset. Fix it in a separate PR. Exclude test-support files by an explicit list, since `src/hosts/test-support.ts` and `src/mcp/test-support.ts` already sit under gated roots.

## Context & Research

### Relevant Code and Patterns

- `src/plugin/index.ts`: today's entry. It default-exports `{id, server}` with `satisfies PluginModule & {id: string}` and also has a named `createServer` export. `tool` is imported at line 1 and is an identity helper.
- `src/frames/feel-drugs.ts`: tool text, field constants, `feelText` and `drugsText`. Host-independent.
- `src/plugin/guidance.ts`: `GUIDANCE_BLOCK` and `GUIDANCE_OPEN` are shared. `withGuidance` and `INTERNAL_SIGNATURES` are v1-only.
- `src/plugin/options.ts` (`parseOptions`) and `src/plugin/config.ts` (`applyConfig`, `skillsDirsFrom`, `pathFrom`): reused.
- `src/plugin/build.ts`: `Bun.build`, the `.md` text loader (also in `bunfig.toml`) and `PLUGIN_EXTERNALS`.
- `src/plugin/{index,frames-text,package,integration,names,pin}.test.ts` and `src/plugin/fixture.ts`: the v1 pack, `file://` load and host-gated suites. `index.test.ts:16` and `frames-text.test.ts:3` import `createServer` from `./index`.
- `src/runner/scripted-provider.ts`: `startScriptedProvider` and `PLACEHOLDER_API_KEY`. It detects the main request by v1 agent text (`:79`, `:116-118`), and `scriptedProviderConfig` emits v1 keys (`:254-277`).
- `src/matrix/check.ts`: report-backed evidence only for `opencode` (`:346-348`); `manual_run` for plugin entries on other hosts (`:401-403`).
- `src/scan/secrets.ts:66`: flags literal `"apiKey": "<20+ chars>"` in `src`.
- Systematic precedent, in `~/src/github.com/marcusrbrown/systematic`:
  - entry typed against a local `setup(ctx: unknown)` (`src/index.ts:34,44`), with `@opencode/plugin` imported only in adapters (`src/lib/opencode-v2.ts:3`);
  - v2 CLI install and pin read in `.github/workflows/main.yaml`;
  - pin and devDependency grouping in `.github/renovate.json5:29-33,90`.

### Institutional Learnings

- `docs/solutions/best-practices/opencode-file-url-object-plugin-needs-explicit-id-2026-10-29.md`: a plugin without an `id` is skipped and the run still exits 0. Keep `id` and assert registration, not exit status.
- `docs/solutions/integration-issues/opencode-plugin-per-request-reminder-injection-2026-10-29.md`: v1 hook facts. The v1 guidance path stays as recorded there.
- Memory 6749: an optional peer must never be a runtime import in `dist`. An isolated-install test is the guard.
- From Systematic: extra named exports on the entry are treated as plugin factories, and real-host tests run the packed artifact in isolation.

### Host facts (free probes, 2026-10-29)

**v1 (1.19.4):**
- Calls `server(input, options)` with tuple options and never calls `setup`, under `run` or `serve`. This contradicts Systematic's note OC2-LOADER.
- `permission.skill: deny` hides a skill from the model and blocks the `skill` tool, but a typed `/drugs` still runs and delivers the body.

**v2 (2.2.2, key points repeated on 2.2.0):**
- **Loading and options.** The runtime loads `{id, setup}`. The published types say `Plugin = {id, effect}`. The plugin loads lazily on the first `/api/*` request. `ctx.options` holds `plugins[].options` verbatim, or `{}`. When the same spec appears in two config layers there is one setup and project options win. A second spec with the same `id` is skipped silently.
- **Tools.** Descriptions, `required` and `additionalProperties:false` reach the provider unchanged. A missing required field is rejected before `execute`. Extra fields are stripped. Without `options:{codemode:false}` the tool is absent from `tools`.
- **Skills.** When `path` is the `SKILL.md` file, the skill tool prints `Base directory for this skill: <skill dir>`. The skill tool takes `{id}`.
- **Context hook.** It fires on `primary` requests only, including a subagent's. Title, manual and auto compaction, and `generate` requests never carry its part. The compaction system text equals the agent prompt, so v2 cannot detect internal requests by text, and does not need to.
- **Commands.** A user's `command` beats a plugin command. A plugin command named like a built-in (`init`, `review`, `goal`) replaces it. `session.prompt({..., skills:[{id}]})` delivers the body as `<skill_content>`, including the base directory. `opencode run "/cmd"` sends plain text, so commands run only via `serve` and `POST /api/session/{id}/command`. `serve` prints its password and leaves a child process, so kill it by process group.
- **Permissions.** These are a config array `permissions:[{action,resource,effect}]`. A plugin cannot read them. `ctx.permission.assert` is the only check, and it is unused here because of the parity decision.
- **Failures.** One throwing transform disables the whole plugin.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/plugin, src/frames, src/runner scripted provider, src/matrix, .github CI and Renovate config; sibling precedent ~/src/github.com/marcusrbrown/systematic v2 adapter",
  "freshness": { "vcs_reference": "77beeb2" },
  "budget": { "max_search_passes": 3, "max_candidate_inspections": 14, "exhausted": false },
  "candidates": [
    { "path_or_symbol": "src/plugin/index.ts", "description": "v1 entry with default {id, server} and named createServer", "disposition": "extend" },
    { "path_or_symbol": "src/frames/feel-drugs.ts", "description": "host-independent tool text, field constants, result builders", "disposition": "reuse" },
    { "path_or_symbol": "src/plugin/guidance.ts", "description": "GUIDANCE_BLOCK and marker (shared); withGuidance and INTERNAL_SIGNATURES (v1 only)", "disposition": "reuse" },
    { "path_or_symbol": "src/plugin/options.ts", "description": "parseOptions for {guidance}", "disposition": "reuse" },
    { "path_or_symbol": "src/plugin/config.ts", "description": "skillsDirsFrom and pathFrom for skill locations", "disposition": "reuse" },
    { "path_or_symbol": "src/plugin/build.ts", "description": "Bun.build with .md text loader; externals list", "disposition": "extend" },
    { "path_or_symbol": "src/plugin/fixture.ts", "description": "v1 pack, extract and file:// harness", "disposition": "extend" },
    { "path_or_symbol": "src/runner/scripted-provider.ts", "description": "OpenAI-compatible scripted stub", "disposition": "extend" },
    { "path_or_symbol": "src/runner/opencode.ts", "description": "v1-only launcher hard-wired to bunx opencode-ai@pin", "disposition": "insufficient", "insufficiency_reason": "v2 needs an npm-prefix install, --standalone, serve plus the HTTP command route and a provider key; a separate v2 test helper is simpler than widening the v1 launcher" },
    { "path_or_symbol": "src/matrix/check.ts", "description": "host, method-cell and plugin-entry schema", "disposition": "extend" },
    { "path_or_symbol": "systematic v2 adapter and host recipe", "description": "local structural entry type, JSON Schema tools with codemode:false, v2 CLI install, pin plus Renovate grouping", "disposition": "reuse" }
  ]
}
```

## Key Technical Decisions

- **Entry.** `src/plugin/index.ts` has one `export default {id: 'metacogs', server, setup}`, typed against a local structural type. `@opencode/plugin` types are imported only in `v2.ts`. `createServer` moves to `v1.ts`. Rationale: R3 and the factory learning. The published v2 type cannot describe `setup`.
- **v1 tool args.** Build them with the bundled zod 4.6.7 instead of `tool()`. A probe on 1.19.4 showed descriptions and `required` reach the provider, but why this works is not established. The existing AE1 assertion (`integration.test.ts:62-82`) is the first gate of U1 and the tripwire on later pin bumps. If AE1 fails, R2 and R3 conflict, and the owner decides. The bundle grows from about 9 KB to about 132 KB, which is accepted.
- **v2 tools.** Set `input = z.toJSONSchema(z.object(args))` from the same field definitions as v1, with `$schema` stripped, plus `options:{codemode:false}`. `execute` returns `feelText` or `drugsText`. The host already rejects missing required fields, and empty strings stay accepted as on v1.
- **v2 skills.** The four bodies and descriptions are imported at build time through the `.md` loader, with frontmatter split off. `path` is each `SKILL.md`, derived from `skillsDirsFrom(import.meta.url)`, so the base directory resolves `scripts/record.mjs`. The bundle's no-fs and no-`process` rule stays.
- **v2 guidance.** Only the `context` session hook carries guidance. It pushes `{type:'text', text: GUIDANCE_BLOCK}` unless a part already contains `GUIDANCE_OPEN`, which covers duplicate instances. When `parseOptions(ctx.options).guidance === false`, no hook is registered. Nothing is persisted. Turning the option off therefore takes effect on existing sessions once the plugin reinitializes, and no stale guidance remains. The option is not live-toggled, since a host reload replays the transforms without rerunning setup. Systematic's `instructions.entry.put` was rejected for this reason. "Same text" means the same block bytes: v1 appends the block, and v2 adds it as a separate part.
- **v2 commands.** There is one command per skill (`feel`, `drugs`, `synthesis`, `counterfactual`). Each `execute` calls `session.prompt` with the raw text and forwards the invocation envelope: `sessionID`, `delivery`, `prompt.files`, `prompt.agents` and any existing `prompt.skills`. It adds the commanded skill by id without duplicating it (see Systematic's `src/lib/opencode-v2-commands.ts:81-99`). A user's own command wins on the host. None of the four names is a v2 built-in, and a comment in the command table says so. There is no deny gate, matching v1. `ctx.permission.assert` is the known mechanism if that ever changes.
- **v2 failure containment.** Every transform body and the guidance callback run inside a small guard. Transforms re-run on replay and hooks run later, so guarding only the setup call would not contain them. The guard catches the error, logs `metacogs: <part> failed` with no argument values, and returns the input unchanged. Registration promises are awaited. Command `execute` errors stay visible and are not swallowed. `setup` returns early when `!ctx.location || !ctx.session`.
- **v2 pin.** The single source is `package.json` `testedWith["opencode-v2"]`. The test helper, the CI job and `pin.test.ts` read it. A Renovate regex manager bumps it, grouped with the `@opencode/plugin` devDependency. The matrix `host_version` records the version that was actually hand-checked, not the moving pin.
- **Peers.** `@opencode-ai/plugin` gets `>=1.19.4 <2` and `@opencode/plugin` gets `>=2.2.0 <3`. Both are optional (`peerDependenciesMeta`) and both are devDependencies. `dependencies` becomes empty.
- **v2 test gate.** A new `METACOGS_HOST_V2=1` gate keeps v2 tests skipped in `check` and in `prepublishOnly`. Neither has the v2 CLI. The existing gates are booleans scoped to other suites.
- **Matrix.** A new host key `opencode-v2`, with method cells for synthesis and counterfactual, both `unverified`, with a note that no v2 eval report exists. Add a `plugins.opencode-v2` entry, which goes `verified` through `manual_run` after the owner's hand check.

## Open Questions

### Resolved During Planning

- Does v1 call `setup`? No, on 1.19.4. The guard stays, and the v1 integration suite proves no change.
- Does v2 need internal-request skipping? No. The `context` hook never fires for title, compaction or generate.
- Can the plugin read permission rules? No, and no deny gate is needed (parity).
- Where does the skill text come from? It is embedded at build time.
- Do the env and file off-switches apply to OpenCode? No. They belong to the Claude hook. The OpenCode opt-out is the plugin option.

### Deferred to Implementation

- Does `@opencode/plugin@2.2.2` typecheck under this repo's TypeScript 7.0.2 with `verbatimModuleSyntax`? Install it and run `tsc` first in U2. If its types fail, type `v2.ts` against a local structural ctx type instead.
- Which `plugins[].package` form loads a packed directory (`file://<dir>` vs a path) in the test helper? Settle by the first U3 run and record it.
- Whether a later plugin's same-named tool overrides ours on v2 is inferred from the docs and unprobed. It is not a requirement.

## Output Structure

    src/plugin/
      index.ts                # single default export {id, server, setup}
      v1.ts                   # createServer: today's hooks, moved
      v2.ts                   # setup(ctx): tools, skills, commands, context hook
      v2.test.ts
      v2-host.ts              # test support: v2 CLI, isolated config, serve/command driver
      v2-integration.test.ts

The layout is a scope declaration. Per-unit file lists are authoritative.

## Implementation Units

- [x] **Unit 1: Entry reshape and zero runtime imports (v1 unchanged)**

**Goal:** Remove the runtime OpenCode import and reshape the entry to `{id, server, setup}`, with v1 behavior unchanged.

**Requirements:** R1, R2, R3

**Dependencies:** None.

**Files:**
- Create: `src/plugin/v1.ts`
- Modify: `src/plugin/index.ts`, `src/plugin/build.ts` (empty `PLUGIN_EXTERNALS`), `src/plugin/fixture.ts` (drop `linkRuntimeDependency`), `package.json` (peers, devDependencies, empty `dependencies`), `bun.lock`
- Test: `src/plugin/index.test.ts`, `src/plugin/frames-text.test.ts` (both import from `./v1`), `src/plugin/package.test.ts`, `src/plugin/integration.test.ts`

**Approach:**
- Move `createServer` and its hooks to `v1.ts` unchanged, and swap `tool()` for bundled-zod args.
- `index.ts` default-exports one object.
- `setup` is a stub that returns early in this unit.

**Execution note:** Run AE1 on the bundled-zod build before any other change in this unit lands.

**Test scenarios:**
- Happy path: the default export's keys are exactly `['id','server','setup']`, with `id === 'metacogs'`.
- Happy path: the bundle has no imports and exactly one export, the default.
- Integration: the packed plugin loads on 1.19.4 with no `node_modules` linked. AE1 passes (field descriptions offered), and the whole v1 integration and names suites pass unchanged.
- Integration: after `npm install` of the tarball with `--omit=dev --omit=peer` into a temp project, a bare `node` import of the entry succeeds.

**Verification:** The v1 suites are green on 1.19.4, and the bundle and isolated-install checks pass.

- [x] **Unit 2: v2 adapter**

**Goal:** `setup(ctx)` registers the tools, skills, commands and guidance, with failure containment.

**Requirements:** R4, R5, R6, R7, R8

**Dependencies:** Unit 1.

**Files:**
- Create: `src/plugin/v2.ts`
- Modify: `src/plugin/index.ts` (wire `setup`), `src/plugin/build.ts` (skill `.md` imports, if the loader needs entries)
- Test: `src/plugin/v2.test.ts`

**Approach:** Follow the v2 Key Technical Decisions above. The command table derives from the embedded skill records. Unit tests drive `setup` with a fake ctx that records each editor call.

**Test scenarios:**
- Happy path: each tool `input` carries the v1 field descriptions, the required set (`since_last` optional) and `codemode:false`. `execute` returns exactly the `feelText` and `drugsText` output.
- Happy path: four skill records, whose names and descriptions equal the frontmatter, whose bodies have no frontmatter, and whose `path` ends `<name>/SKILL.md`.
- Happy path: four commands with skill names and descriptions. `execute` with `"caffeine"` prompts with text `caffeine` and the `drugs` skill attached. Multi-word text stays raw. Empty text attaches the skill with no text.
- Edge case: `execute` forwards `sessionID`, `delivery`, `prompt.files`, `prompt.agents` and existing `prompt.skills`, and adds the commanded skill once even if it is already present.
- Happy path: the `context` hook on an empty `system` pushes exactly one `{type:'text', text: GUIDANCE_BLOCK}`.
- Edge case: the hook pushes nothing when the marker is already present.
- Edge case: `ctx.options = {guidance:false}` registers no hook. `{}` and non-object options leave guidance on.
- Edge case: a ctx with no `location` or `session` registers nothing and does not throw.
- Error path: a transform body that throws on a replay after setup has completed is caught. It returns its input, logs one `metacogs:` line with no argument values, and another transform still works.
- Error path: a guidance callback that throws is caught, and the request proceeds without the block.
- Error path: an error thrown by command `execute` propagates and is not swallowed.

**Verification:** `v2.test.ts` is green, typecheck is clean, and the bundle still passes the no-fs, no-process and no-import checks.

- [x] **Unit 3: v2 host harness and contract tests**

**Goal:** Prove R1 and R4–R7 on the pinned v2 CLI with the packed artifact.

**Requirements:** R1, R4, R5, R6, R7, R9

**Dependencies:** Unit 2.

**Files:**
- Create: `src/plugin/v2-host.ts`, `src/plugin/v2-integration.test.ts`
- Modify: `src/runner/scripted-provider.ts` (a v2 config builder), `src/plugin/pin.test.ts`, `package.json` (`testedWith["opencode-v2"]`)
- Test: `src/plugin/v2-integration.test.ts`, `src/runner/scripted-provider.test.ts`

**Approach:**
- The helper installs `@opencode/cli@<testedWith pin>` into an npm prefix and checks for `opencode v<pin>`.
- It writes an isolated config: `plugins` pointing at the packed plugin, the scripted provider under `providers`, a top-level `model`, and the provider key taken from `PLACEHOLDER_API_KEY` at run time, so `scan:secrets` never sees a literal.
- It runs `run --standalone` for prompt tests, and `serve` plus `POST /api/session/{id}/command` for command tests. It polls `GET /api/command` for lazy load and never echoes stdout lines that contain the password.
- It kills by process group, isolates with `env -i` and temp XDG dirs, and asserts from provider-recorded requests.
- The suite is gated by `METACOGS_HOST_V2=1`.

**Test scenarios:**
- Integration (load and schema): `feel` and `drugs` appear in the provider's `tools` with v1-equal parameters. This asserts registration, not exit 0.
- Integration (tool call): a scripted `feel` call returns the `feelText` output.
- Integration (guidance): one run covers a tool loop, a subagent continuation, a title request and a forced compaction. The compaction request is identified on its own terms: `tools:[]` plus the summarize instruction in the last user message. Its occurrence is asserted before the test checks that guidance is absent. The v2 agent prompt text is not used as the classifier, because compaction shares that text. Every agent-loop request carries exactly one guidance part, and the title and compaction requests carry none. With `options:{guidance:false}`, no request carries it.
- Integration (skills): the skill tool loads `counterfactual`, the printed base directory ends `skills/counterfactual`, and `scripts/record.mjs` exists under it.
- Integration (commands): `POST …/command {name:'drugs', text:'caffeine'}` gives a request carrying the `drugs` skill content followed by `caffeine`. A user `command.feel` in config wins over ours. With `permissions` denying skill `drugs`, the typed `/drugs` command still delivers the skill, which matches v1 and needs no gate.
- Integration (name separation): denying tool `feel` leaves skill `feel` loadable. Denying skill `feel` makes the native skill tool refuse it, and tool `feel` stays offered.
- Happy path (unit): the v2 config builder emits `providers`, `package`, `settings.baseURL` and `model`.
- Happy path (unit): `pin.test.ts` asserts that `testedWith["opencode-v2"]` equals the `@opencode/plugin` devDependency version. Matrix presence is asserted in U5.

**Verification:** The suite is green locally with `METACOGS_HOST_V2=1`, and no server process survives it.

- [x] **Unit 4: CI job, required check, Renovate**

**Goal:** Run the v2 contract on every PR as a required check, with the pin bumped by Renovate.

**Requirements:** R9

**Dependencies:** Unit 3.

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/settings.yml`, `.github/renovate.json5`

**Approach:**
- Add a new job with a static name. It runs on every `pull_request` and push to `main` with no `paths:` filter, so the required context always reports.
- The job:
  - uses Node 22;
  - reads the pin from `testedWith`;
  - does an npm-prefix install with `--dangerously-allow-all-scripts` only on npm ≥ 12;
  - fails before tests if the version doesn't match;
  - runs `METACOGS_HOST_V2=1` on the v2 suite only.
- The `settings.yml` required-check entry lands in the same PR. Add a regex manager on `testedWith["opencode-v2"]`, grouped with `@opencode/plugin`.

**Test expectation:** none. This is CI and config. `actionlint` and the green job on the PR are the proof.

**Verification:** `actionlint` is clean. The new job is green on the PR, and its context name matches `settings.yml`.

- [x] **Unit 5: Matrix, docs, changeset**

**Goal:** Record v2 as its own host and document both hosts.

**Requirements:** R10

**Dependencies:** Unit 3.

**Files:**
- Modify: `matrix.json`, `src/matrix/check.ts`, the README matrix render and "OpenCode plugin" section, `docs/install.md`
- Create: `.changeset/opencode-v2.md` (minor; notes the removed named `createServer` export)
- Test: `src/matrix/check.test.ts`

**Approach:**
- Add the `opencode-v2` host, its two `unverified` method cells with a note, and a `plugins.opencode-v2` entry that is `unverified` until the owner's `manual_run`. The checker already accepts new host keys, requires their method cells and requires `manual_run` for verified non-v1 plugins (`src/matrix/check.ts:210-217,399-408`). Any change is limited to what the new entry needs. The report-backed restriction to `opencode` (`:346-348`) stays. Match the required-check context and its Actions `integration_id` in `.github/settings.yml:37-39` (U4).
- Install docs cover:
  - the v2 `plugins: [{package: "metacogs", options: {guidance: false}}]` form next to v1's tuple;
  - both floors;
  - v1's typed `/feel` and `/drugs` (the popup omits skill-sourced commands);
  - raw multi-word arguments on v2;
  - the v2 `permissions` array;
  - on-disk `.agents/skills` copies shadowing the plugin's skills on v2.

**Test scenarios:**
- Happy path: the matrix with the `opencode-v2` host, cells and plugin entry parses, and the README render matches (`matrix:check`).
- Error path: `plugins.opencode-v2` set to `verified` without `manual_run` fails the check, and an `opencode-v2` method cell set to `verified` fails without a v2 report.

**Verification:** `matrix:check`, `generate:check` and `scan:secrets` are green, and the docs name both config keys.

## System-Wide Impact

- **Interaction graph:** Both hosts load the same `dist/index.js`, and each calls only its own entry. Systematic and other plugins share the host. On v1, Systematic's `skills_as_commands` setting already shadows on-disk skills as commands. That is unchanged.
- **Error propagation:** v2 registration failures are caught one at a time and logged once.
- **State lifecycle risks:** v2 persists nothing, so turning the guidance option off takes effect on existing sessions after the plugin reinitializes. It is not a live toggle.
- **Unchanged invariants:**
  - `GUIDANCE_BLOCK` bytes
  - tool names, fields and descriptions
  - the `skills/**` text
  - the record helper
  - the v1 hooks
  - the matrix cells for v1, Claude Code and Codex
  - the Claude Code and Codex packages

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bundled zod stops carrying v1 field descriptions on a pin bump | AE1 fails on the bump PR |
| `@opencode/plugin` types fail under TypeScript 7 | Local structural ctx type in `v2.ts` |
| Published v2 type (`{id, effect}`) differs from runtime (`setup`) | Local structural entry type; the host suite proves the runtime |
| v2 `serve` leaks its password or orphans a child | Never echo the password line; kill by process group; the suite asserts no survivors |
| Required context never reports | No `paths:` filter, static job name, `settings.yml` in the same PR |

## Documentation / Operational Notes

- The owner hand-checks in a v2 TUI before `plugins.opencode-v2` flips to `verified`.
- The owner's own config moves to the v2 form only when he upgrades. His v1 config is unchanged.

## Sources & References

- Systematic precedent: `docs/plans/2026-10-27-001-feat-opencode-v2-support-plan.md` in the sibling repo `marcusrbrown/systematic`
- OpenCode v2: `@opencode/plugin@2.2.2`, `@opencode/cli@2.2.2`, `anomalyco/opencode@v2.2.2`
- Learnings: `docs/solutions/best-practices/opencode-file-url-object-plugin-needs-explicit-id-2026-10-29.md`, `docs/solutions/integration-issues/opencode-plugin-per-request-reminder-injection-2026-10-29.md`
