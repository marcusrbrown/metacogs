---
title: "feat: metacogs v0.1 — skill pack, record helper, and evidence-gated eval harness"
type: feat
status: active
date: 2026-10-22
origin: docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md
deepened: 2026-10-22
---

# feat: metacogs v0.1 — skill pack, record helper, and evidence-gated eval harness

## Overview

Build the metacogs repository from empty to a v0.1 release candidate: a per-skill layout with generated dependency-free helpers, a versioned decision-record contract, a harness-driven eval runner that drives OpenCode in a provably isolated workspace, a preregistration gate that makes post-hoc edits visible, and an evidence-backed host matrix. Two concepts — `counterfactual` and `synthesis` — enter the first RED cycle; the release ships whichever clears GREEN.

## Problem Frame

Upstream metacog's eleven MCP tools format the model's own inputs into reinforcing text and claim altered cognition; the useful kernel (a structured choice, then a response that redirects work) has no evidence behind it and no portable packaging. Coding-agent hosts already share the `SKILL.md` format, but nothing in that ecosystem ships reasoning methods with a record contract, fixtures, and measured outcomes. The brainstorm fixed the product: explicit methods as skills, script-validated records, and an evidence gate that only ships what demonstrably changes behavior (see origin: `docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md`).

The repo is greenfield. Every layout, contract, and tooling choice below is a first decision, so the plan front-loads the unknowns that gate everything: whether OpenCode can be driven non-interactively in a workspace that provably loads nothing from the author's machine, whether its JSON event stream exposes enough to check "no method fired," and whether the skill tool tells the agent where the skill's helper lives.

## Requirements Trace

Origin R-IDs in parentheses.

- R1. Shipped methods are standard Agent Skills with no vendor tool names or model IDs in core content (R1, R2).
- R2. Methods stay silent on tasks that need no reflective procedure (R5).
- R3. Each method produces a validated record written by a helper; malformed input yields a field-specific error and no file (R6, R7).
- R4. Helpers need only Node or Bun; helper failure degrades to execution mode `unrecorded`, never a silent drop (R9, R10).
- R5. A concept ships only after a retained baseline failure and a held-out GREEN against predeclared run-count and pass-rate thresholds in an isolated OpenCode workspace (R11, R12, R14).
- R6. Thresholds, rubric, and held-out split are committed before skill authoring and the runner enforces that ordering (R12).
- R7. Deterministic checks gate where possible; model-judged criteria use a different model family plus human spot-check with agreement reported (R13).
- R8. Every eval run emits a replay manifest with commit IDs, fixture hashes, skill versions, model settings, harness version, tools, budgets, usage, latency, raw-output hashes, and isolation evidence (R15).
- R9. Repeated-run counts, variance, and regressions are reported (R16, narrowed: Systematic baseline deferred).
- R10. The README matrix carries four statuses per host per method, with each host's discovery path and install step documented (R17, R18, R19).
- R11. Unshipped concepts are listed as hypotheses; fixtures exist only for concepts that entered RED (R20).
- R12. README states the reinterpretation stance and preserves upstream MIT attribution (R4).

## Scope Boundaries

- No native host tools, MCP endpoints, or Claude Code plugin tooling.
- No live RED/GREEN in Pi, Claude Code, or Codex; those hosts receive discovery smoke tests only.
- No npm publication or name reservation.
- No Systematic dependency in the pack and no Systematic-baseline runs in v0.1.
- No eval execution in CI; evals run locally with the author's provider credentials and committed reports are allowlist projections.
- No re-validation policy for model or harness version changes; `verified` cells pin the (host version, model) pair they were earned on.
- No pairwise judging, repeat-judge sampling, run locking, or JSON Schema artifacts; each is reintroduced only when a concrete need appears.

### Deferred to Separate Tasks

- Systematic-workflow baseline profile: separate plan after v0.1 (origin R16 narrowed by owner decision; see Documentation notes).
- Controlled comparison against the upstream MCP server: separate eval profile after v0.1.
- Additional concepts entering RED: one plan per concept, reusing this harness.

## Context & Research

### Relevant Code and Patterns

Greenfield repository: `.gitignore`, `metacog-project-brief-and-handoff.md`, and the origin doc are the only files. No conventions to inherit.

External precedents to mirror, not import:

- Systematic `skills/ce-review/scripts/validate-review.mjs` — a generated, dependency-free Node validator with a shared exit-code vocabulary and a `--check` drift mode; the shape for every helper here.
- Systematic `writing-skills` RED→GREEN→REFACTOR and `testing-skills-with-subagents.md` — the pressure-scenario method the fixtures follow.
- Inspect AI eval-log layout (MIT) — field inventory for the replay manifest; borrow the shape, not the dependency.
- MADR 4.0 — field inventory for the decision record (context, drivers, options, outcome, consequences, status).

### Institutional Learnings

None; `docs/solutions/` does not exist.

### External References

- Agent Skills spec: `name` 1–64 chars, lowercase/digits/hyphens, must match directory; `description` 1–1024; optional `license`, `compatibility`, `metadata`, experimental `allowed-tools`; `scripts/`, `references/`, `assets/` conventions. https://agentskills.io/specification
- Host discovery (verified 2026-10-22): OpenCode reads `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` (project, walking up to the git worktree) and `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`; Pi reads `.pi/skills/`, `.agents/skills/`, `~/.pi/agent/skills/`, `~/.agents/skills/`; Codex reads `.agents/skills/`, `$HOME/.agents/skills/`, `/etc/codex/skills`; Claude Code reads `.claude/skills/` and `~/.claude/skills/` only. https://opencode.ai/docs/skills/ · https://pi.dev/docs/latest/skills · https://developers.openai.com/codex/skills · https://code.claude.com/docs/en/skills
- OpenCode headless: `opencode run --dir --model --agent --file --format json`; `opencode serve` with OpenAPI at `/doc`, `GET /global/health` (version), `GET /experimental/tool?provider=&model=` (tool list incl. skill tool description, experimental); `opencode debug config`; config file via `OPENCODE_CONFIG` (path) or `OPENCODE_CONFIG_CONTENT` (inline) — `OPENCODE_CONFIG_DIR` holds agents/commands/plugins, not settings; `permission` map with `skill` patterns (`allow|deny|ask`, last match wins, catch-all first), `edit`, `shell` patterns, `external_directory` (default `ask`); legacy `tools` booleans deprecated since v1.1.1; `--auto` approves anything not denied; env `OPENCODE_PERMISSION`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`; credentials from `~/.local/share/opencode/auth.json` or provider env vars. JSON event schema is undocumented. `--dir` is not a sandbox. Managed config under `/Library/Application Support/opencode/` and remote `.well-known` config are outside HOME. https://opencode.ai/docs/cli/ · https://opencode.ai/docs/server/ · https://opencode.ai/docs/config/ · https://opencode.ai/docs/permissions/
- Eval discipline: 5 runs per condition per fixture; report `pass/total` with Wilson intervals and paired per-fixture outcomes; pass@k is not pass rate; 60/40 dev/held-out is Anthropic's trigger-eval precedent; deterministic checks first, cross-family judge for semantics, human review of every held-out case, κ only when interpretable. Bowyer et al. 2025 (arxiv 2410.03492); Anthropic `skill-creator` and "Demystifying evals for AI agents" (2026); agentskills.io/skill-creation/evaluating-skills; Bavaresco et al. 2025; Inspect AI log reference.
- Method lineage: Klein pre-mortem (HBR 2007); Dewar, Assumption-Based Planning (RAND); Toulmin, The Uses of Argument; US Government Tradecraft Primer (key-assumptions check, ACH); Heuer, Psychology of Intelligence Analysis; Dong et al., "Integrating Conflicting Data: The Role of Source Dependence" (PVLDB 2009); Wang et al., Self-Consistency (ICLR 2023); "Too Consistent to Detect" (EMNLP 2025); Sharma et al., sycophancy (2023); Huang et al., "LLMs Cannot Self-Correct Reasoning Yet" (ICLR 2024); Ku et al. (ArgMining 2025) on stance-assigned debate.
- Judge bias: Chen et al. (EMNLP 2024) and Tripathi et al. (2024) on verbosity; Ma et al. (Findings EMNLP 2025) on bandwagon effects in multi-agent evaluation; Shi et al. (IJCNLP-AACL 2025) on position effects.
- Community precedent for OpenCode skill evals: `tardigrde/agent-skill-eval`, `guilhermelowa/opencode-skill-eval`.
- Node 20 reached end of life April 2026; floor is Node 22 LTS.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": "repository root (greenfield; three files, no source)",
  "freshness": {
    "scope_baseline": "git worktree with no commits on main; files: .gitignore, metacog-project-brief-and-handoff.md, docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md"
  },
  "budget": {
    "max_search_passes": 1,
    "max_candidate_inspections": 3,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "metacog-project-brief-and-handoff.md",
      "description": "project brief: concept table, scenario table, output contract, milestones",
      "disposition": "insufficient",
      "insufficiency_reason": "prose brief; contains no reusable code, schema, or tooling"
    }
  ]
}
```

## Key Technical Decisions

- **Per-skill self-contained directories, `skills/<name>/` canonical.** Each skill ships its own `scripts/record.mjs`; installers that copy one skill directory keep working, and deleting a skill deletes its helper. No committed symlinks (Windows checks them out as text; copy paths break relative targets). In-repo dogfooding uses a gitignored `.agents/skills/` populated by the generate step. (see origin: Key Decisions, helper commitment)
- **Helpers are generated, not hand-maintained.** One TypeScript source under `src/record/` bundles to a dependency-free `.mjs` per skill via Bun; a `--check` drift script fails CI if a committed helper diverges. Mirrors Systematic's `validate-review.mjs` pattern.
- **Bun for development, Node 22+ for runtime.** Generated helpers execute under `node` with no `node_modules`; the runner, generators, and tests use Bun.
- **The TypeScript validator is the record contract.** No JSON Schema artifacts at v0.1; the runner imports the same validator module the bundle is built from, so there is one source of truth. Fields: `schema_version`, `helper_version`, `method`, `method_version`, `objective`, `evidence[]`, `assumptions[]`, `alternatives[]`, `findings[]`, `next_action`, `reopen_condition`, `execution_mode` (enum incl. `sequential`, `delegated`, `unrecorded`), `status`. Helper rejects unknown `schema_version`; `method` must match `^[a-z][a-z0-9-]{0,63}$` and the shipped-method enum. (origin R6)
- **Helper write contract.** Exit codes: `0` written; `2` validation failure (names the field, writes nothing); `3` I/O failure; `4` collision with different content; `64` usage. Output root: `--out-dir` → `METACOGS_RECORDS_DIR` → `$XDG_STATE_HOME/metacogs/records/` → `~/.local/state/metacogs/records/`; in-repo storage is an explicit opt-in documented with its `.gitignore` line. Canonical form is RFC 8785 JCS with `helper_version` excluded; filename `<method>-<16-hex-of-canonical-hash>.json`; the resolved path is asserted to sit inside the root. Write = complete temp file in the same directory, then `fs.link(tmp, final)`; on `EEXIST` byte-compare and return `0` (identical) or `4`; unlink temp in `finally`. Dirs 0700, files 0600. Evidence refs are opaque strings, never dereferenced.
- **Runner transport is `opencode run --format json` in a `git init`'d temp workspace, with two provider modes.** *Scripted mode* (isolation tests, CI-safe): a local OpenAI-compatible stub registered as a fake provider via `OPENCODE_CONFIG_CONTENT` with a placeholder key, zero cost, deterministic replies — mirrors Systematic's `withScriptedProvider`/`startScriptedModelServer`. *Live mode* (RED/GREEN): OpenCode's free-tier `opencode/*` models (e.g. `opencode/big-pickle`), pinned in prereg; no provider key is needed, so none is passed. The binary is pinned via `bunx opencode-ai@<version>`; `OPENCODE_DISABLE_AUTOUPDATE`, `_LSP_DOWNLOAD`, `_MODELS_FETCH`, `_PRUNE` are all `1`. Child env is built from an allowlist: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` all point into the workspace; `OPENCODE_CONFIG` points at a generated settings file (never combine with `OPENCODE_CONFIG_CONTENT`; both are honored and deep-merge); `HOME` and `XDG_*` dirs are siblings of the workspace, not inside it; `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`; `METACOGS_*` unset except `METACOGS_RECORDS_DIR` (inside workspace); no API-key variables are forwarded in either mode. Generated permissions: `edit: deny`, `external_directory: deny`, `bash: {"*": "deny", "node *scripts/record.mjs*": "allow"}` (the key is `bash`, not `shell`), `skill: {"*": "deny"}` for baseline or `{"*": "deny", "<method>": "allow"}` for GREEN; no `ask` rules — headless `run` auto-rejects them with exit 0 and no follow-up turn, whereas an explicit `deny` gives the model a follow-up turn. Never `--auto`. `PATH` is inherited; the `bash` allowlist is the only control on what the agent can execute. Credentials are never written to config, workspace, manifest, or transcript; the workspace is deleted on normal exit and in the signal handler. `opencode serve` is the fallback if `run` cannot expose tool-call events. Unit 1 proves this before anything else is built.
- **Isolation is a pass criterion, not a label.** A run counts toward RED or GREEN only if the manifest shows: the `<available_skills>` block in the system prompt (captured from the request body by the scripted stub, or by a recording proxy in live mode — `/experimental/tool` is unfiltered and lists denied tools) equals exactly the expected set (`customize-opencode` is built in and must be hidden by the deny-all rule); `opencode debug config` shows only the generated config; a sentinel `AGENTS.md` planted in a throwaway author home is not quotable; canaries at the author-home `auth.json` path and outside the workspace do not appear in stdout, stderr, or request bodies. The real HOME is never used, even as a control. Runs that fail any check are excluded and reported as `non_isolated`.
- **Preregistration is a tagged commit the runner enforces, as an audit trail.** `evals/<method>/prereg.json` holds `epoch`, salted canonical hashes of dev, negative, and held-out fixtures and of the rubric (canonicalization: UTF-8, LF, final newline), N, RED bar, GREEN bar, false-fire threshold, per-run timeout, `infra_error` definition, run-outcome taxonomy, agreement floor, pinned agent model ID, judge model ID, and accepted false-RED/false-GREEN rates. Commit sequence: (1) fixtures + rubric commit; (2) prereg-only commit; annotated tag `prereg/<method>/<epoch>` on (2), pushed before any `skills/<method>/` commit. At GREEN the runner requires: tag is a strict ancestor (not equal) of the first `skills/<method>/` commit found by `git rev-list --reverse --topo-order <base>..HEAD -- skills/<method>` where `<base>` is the previous epoch's closing commit (epoch 1: root commit); commit (1) is an ancestor of (2); (2) touches only `prereg.json`; `git hash-object --path` of the working-tree prereg equals the tagged blob. The manifest records tag object SHA, tagged commit, and blob hash. README states this makes post-hoc edits visible, not impossible.
- **Held-out custody is outside the repo until GREEN.** Content lives at `METACOGS_HELDOUT_DIR` (default `$XDG_STATE_HOME/metacogs/heldout/<method>/`, fallback `~/.local/state/...`), never in the working tree. Held-out run artifacts (transcripts, manifests) are written under the same state root, never under `evals/runs/`; the runner refuses a held-out run whose output resolves inside the repo. The runner verifies hashes before judging and runs a private near-duplicate check against dev fixtures whose only committed output is pass/fail. Content is committed after release. Burn rule: a GREEN report is a one-shot read; any `skills/<method>/` edit after it under the same epoch burns the set and requires a fresh set and a new epoch. Infra reruns do not burn.
- **Eval defaults (v0.1 profile).** 5 runs per condition per fixture, interleaved order. RED qualifies when baseline fails ≥4/5 on at least two dev fixtures; the baseline pass criterion is rubric-only (record checks do not apply when no skill is loaded). GREEN is a one-shot read on the held-out set with both conditions: skill pooled ≥17/20 with per-fixture floor 3/5, baseline pooled ≤10/20, no dev regression, 0/3 negative false fires; paired per-fixture delta reported with a Wilson interval. 4 held-out + 6 dev + 3 negative fixtures per method, split by scenario family. Denominator fixed at attempted runs: timeouts, budget breaches, `judge_error`, and host exits after skill content loads count as FAIL; `infra_error` is only a provider/host outage before skill content loads, retried ≤2× and reported separately. Accepted error rates are stated in prereg (at N=5 a 0.75-true-rate skill clears 17/20 ~22% of the time; this is a pragmatic gate, not proof).
- **Judge is a single-turn request through the authenticated OpenCode gateway (free-tier quota exhausted 2026-10-22; owner authorized `opencode`/`opencode-go` credential passthrough into the throwaway HOME only, with leak scans).** `read` is the only tool the gateway permits; the judge workspace is empty and `external_directory` is denied. Deterministic checks first (record present/absent as expected, validator passes, `execution_mode` correct, no false fire); survivors go to one HTTP request to a pinned different-family model: fixed system prompt, no tools, no agent loop. Input is the final answer and record JSON with `redact.json` tokens stripped (runner asserts redaction), wrapped in per-request random delimiters and framed as data; each verdict must quote supporting input. Temperature 0, strict JSON, one retry then `judge_error`. If the provider-returned model ID differs from the pinned ID the run fails. Human reviews 100% of held-out judgments plus any dev judgment within ±1 of threshold, blind to the judge verdict; raw agreement reported, κ only when both labels occur; below the prereg floor the criterion is demoted to advisory.
- **First RED candidates: `counterfactual` and `synthesis`.** Both map to brief scenarios with mechanical checks; `ritual` is deferred because the record contract already embodies it; `tether`/`fork` depend on host capabilities v0.1 does not test.
- **Matrix is data; README table is hand-maintained and checked.** `matrix.json` cells carry `status`, `evidence_ref`, `date`, `host_version`, `model`, `history[]`. `matrix:check` fails when a `verified` cell lacks a resolvable `evals/reports/<method>/green.json` or a `content-compatible-untested` cell lacks a primary discovery reference, and when the README table disagrees with `matrix.json`. Codex starts `content-compatible-untested` after a smoke listing.
- **Negative "must not fire" suite is release-blocking.** ≥3 negative fixtures per shipped method (trivial, near-miss using the method's vocabulary, unrelated). Pass = no `tool_use` event with `part.tool === "skill"` naming the method, no `tool_use` with `part.tool === "invalid"` whose output names the unavailable `skill` tool (a denied skill call is an attempted fire, not silence), no helper invocation in the tool trace, no file in the records dir.
- **Reports are allowlist projections.** `evals/runs/` is gitignored; `evals/reports/<method>/` contains only counts, intervals, paired outcomes, verdict enums, hashes, model IDs, and SHAs — never stdout, stderr, config paths, or env. CI scans `evals/reports/` and `evals/*/fixtures/` for key-shaped strings and PII patterns. Fixtures are synthesized or anonymized; source URL and licence live in prereg metadata.
- **Runner lifecycle.** Manifest written as `running` before launch; SIGINT/SIGTERM kill the child process group, delete the workspace, write `interrupted`. Runs are sequential by convention; a stale `running` manifest is reported on startup, not auto-reconciled. No lock file.

## Open Questions

### Resolved During Planning

- Event mapping (opencode-ai 1.19.4, from Unit 1): every event has `type`, `timestamp` (epoch ms), `sessionID`; `step_start`/`step_finish` with `part.reason` (`tool-calls`|`stop`), `part.tokens.{total,input,output,reasoning,cache.{read,write}}`, `part.cost`; `tool_use` emitted once on settle with `part.tool`, `part.callID`, `part.state.{status,input,output,error,metadata,title,time.{start,end}}`; skill load = `tool_use` with `part.tool === "skill"`, `state.input.name`, `state.metadata.{name,dir,truncated}`; `text` with `part.text`, `part.time`; fatal `error` with `error.name`, `error.data.message`, exit 1. Skill directory is exposed in `state.metadata.dir` and as "Base directory for this skill: <abs>" in the tool output, so SKILL.md may reference `scripts/record.mjs` skill-relatively.
- Timings (Unit 1): scripted run ≈4.7 s warm (≈4.4 s is `bunx` + boot); first cold `bunx` 17 s; concurrent cold starts 25–60 s — runs are sequential. Live `opencode/big-pickle` trivial run: 6.9 s, no key, no `auth.json`.
- Which concepts enter RED first: `counterfactual` and `synthesis`.
- Record field names, canonical form, and helper exit codes: fixed above.
- Runner transport, env allowlist, permission set, and isolation criterion: fixed above; proven in Unit 1.
- Thresholds, fixture counts, RED/GREEN rules: v0.1 profile above.
- Held-out custody and artifact location: outside the repo.
- Judge transport: direct provider request with redaction and delimiting.
- Codex matrix start status: `content-compatible-untested` after smoke listing.
- Systematic baseline: deferred out of v0.1 (origin R16 narrowed).

### Deferred to Implementation

- Whether Unit 4 live runs use the recording proxy (needs client headers forwarded untouched or the free tier returns 403) or rely on stdout events alone for the `<available_skills>` check: decided in Unit 4 against the README evidence.
- Rubric wording and `redact.json` token lists per method: written in Unit 5 against dev fixtures only, hashed into the prereg.
- Judge model selection: any different-family model with a stable ID; pinned in prereg.
- Bun bundler flags for the smallest dependency-free `.mjs` under Node 22: settled in Unit 3.
- Per-run timeout value and expected total wall-clock: set in prereg from Unit 1 timings.

## Output Structure

    .agents/skills/                 (gitignored; generated copy for dogfooding)
    skills/
      counterfactual/
        SKILL.md
        scripts/record.mjs          (generated)
        references/                 (optional)
      synthesis/
        SKILL.md
        scripts/record.mjs          (generated)
    src/
      record/                       (validator + writer; single contract; bundled per skill)
      runner/                       (workspace, opencode driver, prereg, checks, judge, redact, report)
      matrix/                       (check)
      generate/                     (helper bundler, drift check)
    evals/
      counterfactual/
        prereg.json
        fixtures/dev/*.md
        fixtures/negative/*.md
        rubric.md
        redact.json
      synthesis/ ...
      runs/                         (gitignored; dev-run artifacts only)
      reports/                      (allowlist-projected release reports)
      runner/README.md              (event-field mapping, isolation evidence)
    matrix.json
    README.md
    LICENSE                         (MIT; upstream attribution section)
    HYPOTHESES.md                   (unshipped concepts)
    AGENTS.md
    .github/workflows/ci.yml
    package.json  bunfig.toml  tsconfig.json

    Outside the repo ($XDG_STATE_HOME/metacogs/ or ~/.local/state/metacogs/):
      records/                      (default helper output)
      heldout/<method>/             (held-out fixtures until GREEN)
      runs/                         (held-out run artifacts)

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
  participant A as Author
  participant G as git
  participant R as Runner
  participant O as OpenCode (isolated)
  participant J as Judge (direct provider request, other family)
  A->>G: commit fixtures + rubric; commit prereg.json alone; tag -a prereg/<m>/1
  A->>R: run RED (baseline, 5x per dev fixture + negatives)
  R->>O: git-init'd temp ws, allowlisted env, permission.skill deny-all
  O-->>R: JSON events; records dir (empty expected)
  R->>R: isolation checks → include/exclude; rubric-only baseline pass rule
  R->>J: rubric judge (redacted, delimited)
  J-->>R: strict JSON verdicts
  R->>A: red.json (counts, intervals); ≥2 fixtures at RED bar → GREEN eligible
  A->>G: author skills/<m>/SKILL.md (dev fixtures only)
  A->>R: run GREEN (held-out, both conditions, one-shot)
  R->>G: strict-ancestor + one-file + blob-hash checks
  R->>O: baseline and skill runs on held-out (artifacts outside repo)
  R->>R: deterministic checks; pooled 17/20, floor 3/5, baseline ≤10/20, paired delta
  R->>J: judge survivors
  R->>A: green.json (allowlist projection); human reviews 100% held-out judgments
  A->>G: matrix.json cell → verified (host ver, model)
```

Run-outcome taxonomy: `pass | fail | timeout→fail | budget→fail | judge_error→fail (reported separately) | infra_error (pre-skill-load outage only; retry ≤2; reported, not in denominator) | non_isolated (excluded, reported)`.

## Implementation Units

### Phase 1 — Prove the unknowns

- [x] **Unit 1: OpenCode isolation and event-capture spike** — GO (`0733034`; evidence in `evals/runner/README.md`; opencode-ai 1.19.4)

**Goal:** Prove `opencode run` can execute in a workspace that provably loads nothing from the author's machine, that its JSON events expose tool calls, skill loads, usage, and timing well enough to check "no method fired," and that the skill tool tells the agent where the skill directory is.

**Requirements:** R5, R8 — origin F2

**Dependencies:** None

**Files:**
- Create: `evals/runner/README.md` (event-field mapping, isolation evidence, instruments used, pinned OpenCode version, go/no-go record)
- Create: `src/runner/spike/isolation.ts`
- Test: `src/runner/spike/isolation.test.ts`

**Approach:**
- Build the allowlisted child env and generated `OPENCODE_CONFIG` file from Key Technical Decisions; `git init` the temp workspace; run a trivial prompt with `--format json`; capture stdout/stderr separately.
- Instruments: `GET /experimental/tool` (or the equivalent in `run` events) for the skill tool description's `<available_skills>`; `opencode debug config` for the effective config; sentinel `AGENTS.md` in the real HOME; canary secret at the real `auth.json` path; canary file under a fake held-out dir; a planted file outside the workspace read via an absolute path.
- Repeat with a planted dummy skill in `<ws>/.agents/skills/` and a `skill` allow rule; confirm the skill-tool call appears in events and that the tool result names the skill directory.
- Enumerate managed config locations (`/Library/Application Support/opencode/`, `.well-known`) and record whether they are present and loadable.
- Observe what headless `run` does with an `ask` permission.
- Measure wall-clock for the trivial run to seed the per-run timeout.
- If user-level content loads, tool events are absent, or the skill directory is not exposed, probe `opencode serve` + `GET /session/:id/message` and document which transport wins or record a no-go.

**Test scenarios:**
- Happy path: clean env → `<available_skills>` empty; `debug config` shows only the generated file; sentinel `AGENTS.md` not quotable; canaries absent from transcript.
- Happy path: planted skill + allow rule → skill-tool event naming the skill; tool result includes the skill directory path.
- Edge case: planted skill + deny-all → no skill-tool event; skill text absent from transcript.
- Error path: absolute-path read of a file outside the workspace → denied by `external_directory: deny`; denial visible in events.
- Error path: nonexistent model id → non-zero exit with a captured error event, not a hang.
- Error path: provider key absent from child env → run fails on auth, proving no fallback to the author's `auth.json`.
- Integration: author's real `~/.config/opencode/skills` and `~/.config/opencode/AGENTS.md` present → neither appears in loaded skills or is quotable.

**Verification:**
- `evals/runner/README.md` names the transport, event fields for tool calls/usage/timing, the instruments, the isolation controls, the pinned OpenCode version, and the `ask` behavior, with captured sample events.
- Go/no-go recorded against the isolation criterion; if any check cannot be made to pass, the plan reopens before Unit 4.

### Phase 2 — Scaffold the pack

- [x] **Unit 2: Repository scaffold, license, CI skeleton**

**Goal:** Turn the empty repo into a Bun/TypeScript project with CI that runs typecheck, tests, drift checks, and content scans.

**Requirements:** R12

**Dependencies:** None (parallel with Unit 1)

**Files:**
- Create: `package.json`, `bunfig.toml`, `tsconfig.json`, `.github/workflows/ci.yml`, `LICENSE`, `README.md` (stub with stance + attribution), `HYPOTHESES.md` (eleven concepts: two `red-candidate`, nine `hypothesis`), `AGENTS.md` (repo conventions: no absolute paths, generated files, prereg commit sequence, allowlist reports)
- Modify: `.gitignore` (add `evals/runs/`, `.agents/skills/`)

**Approach:**
- MIT license with an upstream attribution section citing `inanna-malick/metacog@3d89bb30`.
- CI: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run generate:check`, `bun run matrix:check`, `bun run scan:secrets` — each script exits 0 as a no-op until its unit lands. No provider keys, no eval runs.
- README stub states the reinterpretation stance and that altered-cognition/jailbreak framing is not an objective.

**Test scenarios:**
- Test expectation: none — scaffolding; CI green on the scaffold commit is the check.

**Verification:**
- CI passes on the scaffold commit; `HYPOTHESES.md` lists all eleven concepts with status.

- [x] **Unit 3: Record validator and generated helper**

**Goal:** Ship the TypeScript record contract and a single-source helper that validates and atomically writes records, bundled per skill as dependency-free `.mjs`.

**Requirements:** R3, R4 — origin F1, AE1, AE6

**Dependencies:** Unit 2

**Files:**
- Create: `src/record/contract.ts` (field set, enums, `method` pattern), `src/record/validate.ts`, `src/record/canonical.ts` (JCS), `src/record/write.ts`, `src/record/cli.ts`, `src/generate/bundle-helpers.ts`, `src/generate/check.ts`
- Test: `src/record/validate.test.ts`, `src/record/canonical.test.ts`, `src/record/write.test.ts`, `src/record/cli.test.ts`, `src/generate/check.test.ts`

**Approach:**
- Validator is hand-rolled for the v1 field set; the runner imports it directly so there is one contract.
- CLI reads JSON from stdin or `--file`; resolves output root per precedence (XDG state default; cwd never used implicitly); canonicalizes with `helper_version` excluded; derives filename; asserts the resolved path is inside the root; writes temp then `fs.link`; byte-compares on `EEXIST`; dirs 0700, files 0600; exit codes `0/2/3/4/64`; success prints path and `next_action` echo as fixed-shape JSON; stamps `helper_version`.
- Bundler emits `skills/<name>/scripts/record.mjs` for every `skills/*` directory and a gitignored `.agents/skills/` copy; `check` re-bundles to memory and diffs.

**Execution note:** Implement test-first; the exit-code contract is the eval's deterministic surface.

**Patterns to follow:** Systematic `validate-review.mjs` generation + drift check.

**Test scenarios:**
- Happy path: valid record → `<method>-<hash>.json` under the resolved root, exit 0, stdout echoes path and `next_action`; file mode 0600.
- Happy path: identical record twice → exit 0, same path, no duplicate.
- Happy path: same record with keys reordered or whitespace changed → same hash, same path.
- Edge case: `--out-dir` absent, env set → env wins; neither and `XDG_STATE_HOME` unset → `~/.local/state/metacogs/records/` created with 0700; cwd untouched.
- Edge case: `alternatives: []`, `evidence: []` → valid; `reopen_condition: ""` → exit 2.
- Edge case: `helper_version` differs between two otherwise identical records → same filename.
- Error path: missing `reopen_condition` → exit 2 naming it, no file.
- Error path: `schema_version: 2` → exit 2.
- Error path: `method: "../x"` or `"a/b"` or not in the shipped enum → exit 2, no file.
- Error path: unwritable root → exit 3, no file; temp file removed.
- Error path: existing final file with different content → exit 4; pre-existing truncated file → exit 4 with a message naming the path.
- Integration: bundled `skills/<x>/scripts/record.mjs` under `node` (v22, empty `node_modules`) returns identical exit codes and output to the TS CLI across the test corpus.
- Integration: `generate:check` fails when a bundled helper is hand-edited.

**Verification:**
- All exit codes exercised; bundle parity under Node 22; drift check green.

- [x] **Unit 4: Eval runner — workspace, isolation checks, prereg enforcement, manifest** (`3b1786e`; live mode uses a recording proxy for `<available_skills>`; prereg gained `prev_epoch_closing_commit`, `budget`, `run_outcome_taxonomy`; see `evals/runner/README.md` §Runner)

**Goal:** A runner that executes N isolated OpenCode runs per fixture per condition, applies isolation and deterministic checks, enforces preregistration, and emits a replay manifest with the run-outcome taxonomy.

**Requirements:** R5, R6, R8, R9 — origin F2, AE4

**Dependencies:** Unit 1 (transport, fields, instruments), Unit 3 (validator module)

**Files:**
- Create: `src/runner/env.ts` (allowlist), `src/runner/workspace.ts`, `src/runner/opencode.ts`, `src/runner/isolation.ts`, `src/runner/prereg.ts`, `src/runner/git.ts`, `src/runner/checks.ts`, `src/runner/manifest.ts`, `src/runner/cli.ts`
- Test: `src/runner/env.test.ts`, `src/runner/workspace.test.ts`, `src/runner/isolation.test.ts`, `src/runner/prereg.test.ts`, `src/runner/git.test.ts`, `src/runner/checks.test.ts`, `src/runner/manifest.test.ts`

**Approach:**
- Workspace: `git init`'d temp dir with the fixture only; for GREEN, copy exactly `skills/<method>/` into `<ws>/.agents/skills/<method>/`; generate the settings file and permission set from Key Technical Decisions; `METACOGS_RECORDS_DIR` inside the workspace; held-out runs resolve all artifacts under the state root and refuse if inside the repo.
- Isolation checks per Key Technical Decisions; failing runs → `non_isolated`, excluded.
- Prereg enforcement: parse `prereg.json`; verify fixture and rubric hashes after canonicalization; for GREEN verify strict ancestry via `rev-list --reverse --topo-order`, commit-(1)-before-(2), one-file prereg commit, and `hash-object --path` blob equality; refuse with both SHAs.
- Manifest `running` → final status `completed | host_crash | timeout | budget_exceeded | infra_error | interrupted | non_isolated`; records isolation evidence, config path, OpenCode version, model (pinned and returned), usage, wall-clock, tool-call count, records found, prereg SHAs, artifact hashes.
- SIGINT/SIGTERM handler: kill child process group, delete workspace, write `interrupted`. Startup reports any stale `running` manifest.
- Interleave conditions; retry `infra_error` ≤2; key-scan manifest, transcripts, and workspace for the provider key value before finalizing.

**Execution note:** Test-first for prereg, git, isolation, and checks; the OpenCode driver is tested against recorded event fixtures from Unit 1 plus one live smoke.

**Test scenarios:**
- Happy path: fixtures commit → prereg-only commit → annotated tag → first skill commit → GREEN permitted.
- Error path: prereg and SKILL.md in one commit → refused (tag equals first skill commit).
- Error path: prereg commit touches a second file → refused.
- Error path: fixtures committed after the prereg commit → refused.
- Error path: working-tree prereg differs from tagged blob (incl. CRLF checkout) → refused via `hash-object --path`, not raw bytes.
- Happy path: epoch 2 tag after epoch 1 closing commit → permitted for the first skill commit after that close; epoch 1 base = root commit.
- Error path: held-out hash ≠ prereg → refused before launch; held-out output dir inside repo → refused.
- Happy path: baseline run, no skill-tool call, empty records dir, isolation checks pass → counted.
- Error path: any isolation check fails → `non_isolated`, excluded, reported.
- Edge case: run exceeds per-run timeout → `timeout`, FAIL, manifest status `timeout`.
- Edge case: host exits before skill content loads → `infra_error`, retried, reported separately; after skill content loads → FAIL.
- Error path: SIGINT mid-run → child group killed, workspace gone, manifest `interrupted`.
- Error path: provider key string found in any artifact → run aborted, artifacts purged, `credential_leak` recorded.
- Integration: live smoke manifest lists exactly the expected skills and only the generated config.

**Verification:**
- One live baseline smoke produces a manifest with isolation evidence; all refusal paths covered by tests.

### Phase 3 — Preregister and RED

- [x] **Unit 5: Fixtures, rubrics, redaction lists, and preregistration for `counterfactual` and `synthesis`** (`9ed607e`…`39b89a8`; tags `prereg/<m>/1`; expected-answer annex lives in `rubric.md`, held-out sidecars `*.expected.txt` in the state dir; epoch 1 judge id requires a paid key → superseded by epoch 2 in Unit 6)

**Goal:** Author dev, negative, and held-out fixtures plus rubrics and redaction token lists for both candidates, and commit each prereg in the enforced sequence before any `skills/<method>/` content exists.

**Requirements:** R2, R6, R7, R11 — origin F2

**Dependencies:** Unit 4

**Files:**
- Create: `evals/counterfactual/fixtures/dev/*.md` (6), `evals/counterfactual/fixtures/negative/*.md` (3), `evals/counterfactual/rubric.md`, `evals/counterfactual/redact.json`, `evals/counterfactual/prereg.json`
- Create: same set under `evals/synthesis/`
- Create (outside repo): `$XDG_STATE_HOME/metacogs/heldout/{counterfactual,synthesis}/*.md` (4 each)
- Test: `src/runner/prereg.test.ts` (extend with real prereg files); `scan:secrets` over fixtures

**Approach:**
- Fixtures derive from the brief's scenario table; synthesized or anonymized; split by scenario family; each names the dimension it probes; source URL and licence recorded in prereg metadata.
- Fixture families per method (dev set covers each at least once; held-out draws from the same families with different surface details):
  - `counterfactual`: hard-constraint conflict (preferred option vs pinned runtime/deploy target), hidden availability assumption (CI reach, credentials), user-asserted premise with no authoritative evidence, polished plan undermined by one new fact.
  - `synthesis`: N recommendations sharing one unsupported premise (e.g., "team can operate another stateful service"), agreement traced to a single repo artifact with minority counter-evidence, disagreement that hides a shared constraint (tenant isolation), vote-count bait where the majority is wrong.
  - negatives (both): trivial mechanical edit; near-miss that uses the method's vocabulary ("replace the word 'assumption' with 'premise'"); unrelated small fix.
- Rubric: criterion-by-criterion, scored independently, provenance/premise criteria graded before the conclusion criterion; each criterion carries a pass anchor and a fail anchor and is tagged `mechanical` or `judge`. Baseline pass rule is rubric-only.
  - `counterfactual` criteria: names a load-bearing assumption (judge); states it as falsifiable (judge); separates evidence from assumption (mechanical shape + judge relevance); counterfactual is decision-relevant and labeled hypothetical (judge); names flip evidence and where to get it (mechanical non-empty + judge diagnosticity); respects the applicability gate (mechanical across negatives).
  - `synthesis` criteria: reconstructs each material perspective fairly (judge; count mechanical); separates evidence from premises and names ≥1 shared premise when present (judge; fixture-known premise mechanically checkable); identifies a concrete dependence path — common source, shared prompt, same artifact (judge); tests alternatives including dissent (judge); calibrates conclusion to evidence, no "confirmed by agreement" (judge + overclaim-phrase flag); produces record and respects gate (mechanical).
  - Judge instructions encode the known pitfalls: score process evidence, not whether the answer matches the fixture author's preferred option; vote count is never evidence; length is not merit.
- Prereg per Key Technical Decisions, including RED bar (≥4/5 fail on ≥2 dev fixtures), GREEN bar (pooled ≥17/20, floor 3/5, baseline ≤10/20, 0/3 negatives), per-run timeout from Unit 1 timings, pinned agent and judge model IDs, accepted error rates.
- Commit sequence per method: (1) fixtures + rubric + redact; (2) `prereg.json` alone; `git tag -a prereg/<method>/1`; push tag.

**Test scenarios:**
- Happy path: each prereg validates with the runner's prereg parser; hashes match fixtures and rubric.
- Happy path: held-out hashes verify against the state-root files.
- Error path: a dev fixture edited after the tag → runner reports prereg voided.
- Error path: any `evals/*/heldout/` path exists in the working tree → `scan:secrets` fails.
- Integration: `scan:secrets` finds no key-shaped strings or PII patterns in fixtures.

**Verification:**
- Two annotated tags exist; `git log` shows no `skills/counterfactual|synthesis` paths before them; the prereg commits touch one file each.

- [x] **Unit 6: RED runs and go/no-go** (`4ca26cb`…`db847fc`; epoch 2 tags; agent `opencode-go/beam-free`, judge `opencode-go/deepseek-v4.1-flash` via authenticated gateway with `opencode`/`opencode-go` passthrough; counterfactual 5/6 dev fixtures at bar, synthesis 6/6; 0 infra/non_isolated/judge_error; both GREEN-eligible. Caveat: baseline fails are process-rubric fails on terse answers, not wrong conclusions; judge family unverified; no human spot-check yet)

**Goal:** Execute baseline runs for both candidates, retain failures, and decide which proceed to GREEN.

**Requirements:** R5, R9 — origin F2, AE2

**Dependencies:** Unit 5

**Files:**
- Create: `src/runner/judge.ts` (single-turn provider request), `src/runner/redact.ts`, `src/runner/report.ts` (allowlist projection)
- Create: `evals/reports/counterfactual/red.json`, `evals/reports/synthesis/red.json`, `evals/reports/README.md`
- Modify: `HYPOTHESES.md`
- Test: `src/runner/judge.test.ts`, `src/runner/redact.test.ts`, `src/runner/report.test.ts`

**Approach:**
- Judge per Key Technical Decisions: redact, delimit, single request, strict JSON, quoted evidence, model-ID match, one retry then `judge_error` (FAIL).
- 5 baseline runs per dev fixture per method plus the 3 negatives; rubric-only pass rule.
- A concept is GREEN-eligible when ≥2 dev fixtures meet the RED bar; otherwise it returns to `hypothesis` with fixtures retained as regression cases.
- Go/no-go: if neither qualifies, v0.1 becomes the harness-plus-hypotheses release (Unit 8 with zero verified cells).

**Test scenarios:**
- Happy path: judge returns schema-valid JSON with quoted evidence → verdict recorded with returned model ID and prompt hash.
- Error path: malformed JSON twice → `judge_error`, FAIL in gate rate, listed separately.
- Error path: returned model ID ≠ pinned → run fails.
- Error path: a `redact.json` token survives redaction → abort before request, `redaction_failed`.
- Edge case: agent output containing instruction-like text inside the delimiters → verdict still grounded in quoted evidence (fixture test with a planted injection).
- Integration: `red.json` contains only allowlisted fields; `scan:secrets` passes.

**Verification:**
- Each `red.json` shows per-fixture `fail/total` with intervals and retained-failure artifact hashes; eligibility decision recorded; `HYPOTHESES.md` updated.

### Phase 4 — GREEN and release

- [ ] **Unit 7: Author skills and run GREEN**

**Goal:** Write the minimal `SKILL.md` for each eligible method against dev fixtures only, then run the one-shot GREEN read on held-out fixtures with both conditions, judge, and human review.

**Requirements:** R1, R2, R3, R5, R7 — origin F1, F2, AE3, AE4, AE6, AE7

**Dependencies:** Unit 6

**Files:**
- Create: `skills/<method>/SKILL.md`, `skills/<method>/scripts/record.mjs` (generated)
- Create: `evals/reports/<method>/green.json`
- Modify: `HYPOTHESES.md`

**Approach:**
- SKILL.md: `name` matches directory; third-person trigger-only `description` under 500 chars that states the activation boundary as conditions, not vocabulary (e.g., counterfactual: "Use when a consequential implementation or architecture decision depends on an uncertain premise, especially when a preferred option may conflict with a hard constraint or when evidence could change the recommendation"; synthesis: "Use when multiple materially different analyses or evidence sources must be reconciled for a consequential decision, especially when their agreement may rest on shared evidence or an unstated premise"); explicit one-turn procedure; record-field mapping per step; helper invocation by the path convention Unit 1 confirmed; fallbacks for hosts lacking delegation (`execution_mode: sequential`) and for helper failure (`unrecorded`, one retry on exit 2); no claims of altered cognition or enforcement. Tune the description against the trigger fixtures separately from the procedure.

**Technical design:** *(directional guidance for the skill text, not wording to reproduce)*

- `counterfactual`, seven steps: (1) gate — is there a decision whose outcome depends on an uncertain premise? else stop, no record; (2) state objective and proposed decision → `objective`; (3) find the load-bearing bridge — the smallest claim linking evidence to the preferred decision, written falsifiably → `assumptions[]`; (4) check it against supplied evidence, separating observed from inferred → `evidence[]`; (5) run the counterfactual — what changes if false, labeled hypothetical → `alternatives[]`, `findings[]`; (6) name a discriminating test and where to get it, plus a feasible alternative if the premise fails → `evidence[]`, `next_action`; (7) record decision and an observable reopen trigger → `findings[]`, `reopen_condition`. Lineage: pre-mortem, assumption-based planning (load-bearing + vulnerable), Toulmin warrant, key-assumptions check.
- `synthesis`, seven steps: (1) gate — are there multiple material perspectives or real disagreement on a decision? else stop; (2) normalize the decision question → `objective`; (3) extract each perspective's claim, evidence, assumptions separately → `evidence[]`, `assumptions[]`; (4) map shared vs unique premises and visible common sources → `assumptions[]`; (5) test dependence before aggregating — group perspectives that rest on the same premise or source; dependent agreement is one data point → `findings[]`; (6) compare alternatives against discriminating evidence, including dissent; preserve uncertainty if evidence is insufficient → `alternatives[]`; (7) synthesize with surviving findings, unsupported premises, next action, reopen trigger. Lineage: ACH and key-assumptions check, argument mapping, source-dependence in evidence fusion, correlated error in self-consistency ensembles.
- Expected baseline failures to retain in RED: accepting a user-asserted premise as fact and omitting flip evidence (counterfactual); resolving disagreement rhetorically or by majority without tracing shared sources (synthesis). Measure on the pinned model; do not assume.
- GREEN per Key Technical Decisions: baseline and skill on held-out, artifacts outside the repo, pooled 17/20 + floor 3/5 + baseline ≤10/20 + 0/3 negatives + no dev regression; paired delta reported; human review of 100% held-out judgments.

**Execution note:** Follow Systematic `writing-skills` RED→GREEN→REFACTOR; iterate only on dev fixtures; one GREEN read per epoch.

**Test scenarios:**
- Integration: GREEN run's record files validate with the bundled helper and appear in the manifest.
- Integration: negative fixtures → no skill-tool call, no helper invocation, empty records dir.
- Edge case: skill edited after a GREEN read under the same epoch → runner refuses the next GREEN until a new epoch and held-out set exist.
- Error path: held-out baseline exceeds 10/20 → GREEN fails even if skill clears 17/20; report states "held-out too easy".

**Verification:**
- `green.json` per method with counts, intervals, paired outcomes, agreement, verdict; a method meets every bar or returns to `hypothesis` with a new epoch required.

- [ ] **Unit 8: Host matrix, discovery smoke, README, release candidate**

**Goal:** Publish the honest matrix and install docs; cut the v0.1 release candidate.

**Requirements:** R10, R11, R12 — origin F3, AE5

**Dependencies:** Unit 7

**Files:**
- Create: `matrix.json`, `src/matrix/check.ts`, `docs/install.md`
- Modify: `README.md` (matrix table, install per host, stance, evidence summary, what prereg proves), `HYPOTHESES.md`
- Test: `src/matrix/check.test.ts`

**Approach:**
- Discovery smoke per host: copy one skill into the host's documented project path in a temp project and confirm the host lists it (OpenCode/Pi/Codex `.agents/skills/`; Claude Code `.claude/skills/`). Record evidence refs with host versions.
- Statuses: OpenCode `verified` (host version + model) for GREEN methods; Pi/Codex/Claude Code `content-compatible-untested` with smoke evidence; any host whose smoke could not run stays `unverified`.
- `matrix:check` per Key Technical Decisions, including README-table agreement.
- Release: tag `v0.1.0`; README links reports; no npm.

**Test scenarios:**
- Happy path: valid `matrix.json` + matching README table → check passes.
- Error path: `verified` cell with missing report → fails naming the cell.
- Error path: `content-compatible-untested` without `evidence_ref` → fails.
- Error path: README table disagrees with `matrix.json` → fails.
- Edge case: regression downgrade keeps prior `evidence_ref` under `history[]`.

**Verification:**
- CI green with `matrix:check` and `scan:secrets`; install doc names each host's path, the Node 22 requirement, and `unrecorded` behavior.

## System-Wide Impact

- **Interaction graph:** Skill → host skill tool → agent runs `scripts/record.mjs` → file under the state root. Runner → OpenCode CLI → events → isolation checks → deterministic checks → judge (direct provider request) → report → matrix.
- **Error propagation:** Helper exit codes are the only signal the agent gets; the skill maps `2` to "fix the named field, one retry", `3/4` to `unrecorded`. Runner maps host failures to the taxonomy with a fixed denominator; `judge_error` and post-skill-load exits are FAIL; `non_isolated` and `infra_error` are excluded but reported, so denominators cannot inflate silently.
- **State lifecycle risks:** Prereg voiding on any fixture/threshold edit; held-out burn after a GREEN read; stale `running` manifests reported; child process group killed and workspace deleted on signals; held-out artifacts never enter the repo tree.
- **API surface parity:** Helper CLI contract and exit codes are shared across all skills via generation; each record carries `helper_version` because installed skills can carry different bundles; a contract change bumps `schema_version` and regenerates every bundle.
- **Integration coverage:** Live smoke of baseline and GREEN through real OpenCode; Node-only execution of bundled helpers; per-host discovery smoke; credential-leak and PII scans over everything committed.
- **Unchanged invariants:** No host configuration outside the eval workspace is touched; the author's `~/.config/opencode` and `~/.local/share/opencode/auth.json` are never read during evals; consumer repos never receive files unless the user opts in.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| OpenCode JSON events lack tool-call detail or skill-directory exposure | Unit 1 probes `serve`/session messages; if neither suffices, false-fire detection falls back to records-dir + transcript checks and the helper path convention changes; recorded as a no-go if isolation itself cannot be proven |
| `OPENCODE_CONFIG` or permission semantics differ in the pinned build | Unit 1 verifies with `debug config` and denial events; documented per version |
| Managed or remote config outside HOME loads into "clean" runs | Unit 1 enumerates; if present and unredirectable, the isolation criterion fails and the plan reopens |
| Author leakage between fixtures and skill | Held-out content and artifacts outside the repo, salted hashes, one GREEN read per epoch, held-out baseline bar, 100% human review |
| Judge shares bias with agent model or is injected | Different family; redaction + delimiting + quoted evidence; agreement floor demotes criterion to advisory |
| Neither candidate retains RED on ≥2 fixtures | Floor release (harness + hypotheses) at the Unit 6 checkpoint |
| Eval cost | ≈ 2 methods × (6 dev + 3 neg) × 5 baseline + GREEN (4 held-out × 2 conditions × 5) + negatives ≈ 180 agent runs plus judge calls, before retries; local; the 3-run profile is one prereg edit before Unit 5 |
| Rolling host docs drift; `/experimental/tool` changes | Matrix cells and manifests pin host version; instruments re-verified per pinned build |
| Secrets/PII in committed artifacts | Allowlist-projected reports; key-scan before manifest finalization; CI scans over reports and fixtures; held-out artifacts outside repo |

## Documentation / Operational Notes

- README: stance, matrix, install per host, evidence summary, "what prereg proves and does not."
- `docs/install.md`: per-host copy paths, Node 22 requirement, records default location and in-repo opt-in with its `.gitignore` line, `unrecorded` behavior.
- `evals/reports/README.md`: how to read counts, intervals, paired outcomes, agreement.
- `AGENTS.md`: generated-file rule, prereg commit sequence, allowlist-report rule, no absolute paths.
- Origin doc updates applied with this plan: R16 narrowed to "counts, variance, and regressions reported; Systematic baseline deferred"; Codex discovery corrected to native `.agents/skills/`.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-10-22-metacogs-skill-pack-requirements.md` (untracked at plan time; the repo has no commits yet).
- Project brief: `metacog-project-brief-and-handoff.md`.
- Upstream: https://github.com/inanna-malick/metacog/tree/3d89bb30cd26369fdcd242fd704f66641dca327c (MIT).
- Agent Skills spec: https://agentskills.io/specification
- OpenCode docs: https://opencode.ai/docs/cli/ · https://opencode.ai/docs/server/ · https://opencode.ai/docs/config/ · https://opencode.ai/docs/skills/ · https://opencode.ai/docs/permissions/
- Host skills docs: https://pi.dev/docs/latest/skills · https://developers.openai.com/codex/skills · https://code.claude.com/docs/en/skills
- Eval methodology: Bowyer et al. 2025 (arxiv 2410.03492); Anthropic `skill-creator`; agentskills.io/skill-creation/evaluating-skills; Inspect AI eval logs (MIT); MADR 4.0; RFC 8785 (JCS).
- Precedents: Systematic `skills/ce-review/scripts/validate-review.mjs`; `tardigrde/agent-skill-eval`; `guilhermelowa/opencode-skill-eval`.
