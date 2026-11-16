# Systematic reflection baseline

Does the `counterfactual` or `synthesis` method load at chosen `ce:plan` and `ce:review` decision points when a user has Systematic and metacogs installed, and does it stay silent where it should? This spike measures the shipped Systematic before anything is wired. Nothing in Systematic changes unless a decision point misses here.

`prereg.json` holds the protocol and the fixture hashes. It is committed before any paid run. This file holds the counting rules, the probe answers, the choices behind the baseline arm, and a log of deviations.

Status: the first baseline screen is void for wiring decisions (deviation 1). The rerun is recorded under Baseline outcome (rerun). Deviation 2 changes the seeded attempt's shell environment and skill-file reads for every later arm. The treatment arm and its amendment are recorded under Treatment amendment.

- Pre-registration commit: `d0d35fd`.
- Deviations log: three entries. Deviations 1 and 2 are below, and deviation 3 (the review attempt limit) follows the Held-out run section. `prereg.json` carries their amendment blocks (`amendments[0]` to `amendments[2]`).

## Deviations

### Deviation 1: the attempt workspace did not hold the seeded repository

**What was broken.** The first baseline screen (metacogs `3dd0670`, campaign `systematic-reflection`, `results/baseline.json`) ran each attempt in an empty `git init` directory. The seeded sessions read a repository that did not exist there. Three things failed, none of them covered by a gate in the prereg:

- The seeds name `/workspace/...` (reads, `SKILL_DIR`, skill base directories). That path is outside the attempt's real workspace, so the host's `external_directory` rule refused it.
- The files and the git history the seeds read (`src/...`, `docs/...`, the feature branch and `origin/main`, the helper scripts under `.systematic/skills/ce-review/`) were not there, so a read of a seeded path returned "File not found" and `git` had no history.
- The replay permission denies every shell command, so `git`, the helper scripts and `ls` could not run even if the files had been there.

**Evidence.** All 21 attempts of the first screen are on disk under the replay store. 19 of the 21 contain at least one failed tool call. In total 110 calls failed: 54 were refused as outside the project (the `/workspace/...` paths), 28 were a missing file (a read, or an `apply_patch` that needed a file the seed read), 26 were a shell command refused by the permission rule, one was `ripgrep` failing, and one was the bare `synthesis` name that is not a skill. In 8 of the 21 attempts the model's own text says it was blocked. The prereg had no gate for the workspace, so every one of these attempts was counted.

**What changed.**

- Each workflow fixture now has a repository payload, `fixtures/repo/<id>.json`: the files and the git history its tool calls show, at the paths they show, as canonical JSON with a stable hash. The rule for building one is in the Seeded repository section. The fixtures themselves (spec and export bytes, hashes, decision content) are byte for byte what they were.
- A workflow attempt writes the payload into its workspace (a real git history with a fixed identity and dates, so the same payload always gives the same commit ids), copies the Systematic skill directories the seed's paths point into from the installed 3.33.2 package to `.systematic/skills/`, reads the workspace back, and does not run the model if what it finds differs from the payload.
- At import, every `/workspace` in the seed is pointed at the attempt's real workspace path, so the seeded paths are ordinary in-project paths.
- A seeded attempt gets a shell, confined as in a real-world attempt: write sandbox, no pushes, `gh` writes, publishes or login files, and `question` and `task` stay denied.
- New exclusion gate, `seeded_repo_missing`: an attempt whose workspace lacks the seeded repository (or differs from it, or whose fixture carries none) is excluded with that reason and never counted. It uses the existing replacement budget and the quarter-of-a-stage stop. The bars, the stop rule and what counts as a hit are unchanged.
- The rerun is a new campaign, `systematic-reflection-2`, so the first screen's evidence stays untouched. Its cap is the remainder of the one $10 ledger after the first screen's $0.3843.

The prereg amendment (`amendments[0]` in `prereg.json`) records the payload hashes, the workspace rules and the new gate. Every earlier prereg field is unchanged.

**Status of the first screen.** It is void as evidence for wiring decisions. Its counts say what a model does when the repository it is told about does not exist, which is not the question. It is kept for the record, and the rerun alone drives the stop rule.

### Deviation 2: heredocs and installed skill files were refused inside the seeded attempt

**What was broken.** The baseline rerun (campaign `systematic-reflection-2`) found two environment refusals that are not the seeded repository (see the last list under Baseline outcome (rerun)):

- 18 shell heredocs refused with `can't create temp file for here document: operation not permitted`. The attempt shell is zsh, which writes a heredoc's temp file under `$TMPPREFIX`, `/tmp/zsh` by default, and the write sandbox allows writes only inside the attempt's own directory. The `ce:review` helpers are documented with heredocs, so those fixtures hit it most (10 in `tune-review-dedup`).
- 18 reads of Systematic's installed skill files refused. A skill the model loads reports its own base directory (the installed package), the model reads a file under it (`skills/todos/assets/todo-template.md`), and `external_directory: deny` refused the path because it is outside the project (9 in `tune-review-validator`).

Both were found after the run and not changed there. They matter for a treatment arm on `ce:review`, where the model works through those helpers and skill files before and after the new sentence.

**What changed.** The smallest change that removes both, for seeded attempts only:

- The attempt's host environment carries `TMPPREFIX=<attempt temp dir>/zsh`, so a heredoc's temp file lands in the write-confined attempt directory.
- `external_directory` stays denied for every path except the directory Systematic loads its skills from (the blanket deny first, then an allow for `<skills dir>/*`, both as given and as the real path, since later rules win). For a registry release that is the installed package's `skills/` in the attempt's cache clone, and for a local Systematic tree it is `<tree>/skills`. The OS write sandbox is unchanged, so a local tree outside the attempt directory is read-only to the model, and the registry arm's cache clone is the attempt's own throwaway copy.
- A local Systematic tree is a new stack option (a `file://<tree>/dist/index.js` plugin, a tree hash on every attempt record and a guard that a fixture was rendered from the tree the stack loads), and `replay build --id` stores one rendered template under a second id. These carry the treatment arm. They change nothing for a registry run.

The fixtures (spec bytes, hashes, decision content), the bars, the stop rule, the model and the host are unchanged.

**Evidence the change works, $0 on the real host and scripted provider.** A scripted attempt on `tune-review-dedup` runs a heredoc (it writes and reads back its file), opens `skills/todos/SKILL.md` and `skills/todos/assets/todo-template.md` under the installed package, and tries `/etc/hosts`. The heredoc and both skill reads complete, and `/etc/hosts` is still refused. With the `TMPPREFIX` entry removed the same attempt returns the exact refusal from the rerun, and with the skills directory not opened the skill reads error. Both mutations are caught.

**Consequence for the evidence.** `results/baseline-2.json` ran without this change, and its counts drove the wiring decision. The tuning treatment run re-runs the baseline arm under this change, in the same campaign (`systematic-reflection-3`), so both arms see the same environment. Whether the 36 blocked calls had suppressed any method load in `systematic-reflection-2` is unknown. A concurrent baseline that differs from `baseline-2` is reported as a difference and not folded into it.

The prereg amendment (`amendments[1]`) records the two changed fields, the evidence counts and the new campaign.

## Baseline arm

- Systematic `@fro.bot/systematic@3.33.2`, the shipped release. `npm view @fro.bot/systematic version` and the `latest` tag both returned 3.33.2 on 2026-11-15 (published 2026-11-14), so there is no newer release to pin.
- Fixture skill text comes from that release's tarball, `npm pack`ed into scratch and extracted there, never from the Systematic working tree. Its skills directory is byte-identical to the registry install the stack loads (`diff -r` clean).
- metacogs 0.4.1, the local checkout packed the way the harness packs it. The packed tarball and the published 0.4.1 tarball are byte-identical (sha256 `d05a037d...`, `diff -r` clean over every file), so the local pack is what a user installs from npm. The guidance block stays on.
- Host `1.19.5+harness.bf7f7dfe`, model `openai/gpt-6-luna`, the trimmed stack (Systematic then metacogs, no slim, magic-context or aft), `question` and `task` denied, agent `build`. The one message sent after the seed is `Continue.`.
- The Systematic config is the owner's `systematic.jsonc`, read-only, with the search switch applied. Its hash is recorded on every attempt.

## Probe answers (scripted provider, $0)

1. Systematic loads under the harness: yes. The main request offers `systematic_skill`, `systematic_search` and the host `skill` tool, and does not offer `question` or `task`.
2. A seeded `ce:plan` session continues with both method skills listed: yes. `counterfactual` and `synthesis` appear in the main request's system text, not in a tool description. The seeded skill text and `Continue.` reach the provider.
3. Child-session events appear in `--format json`: no. A scripted `task` call ran a child session, but the stream held one session id. The design does not depend on it, because the attempt stack denies `task`.

Fixture dry-run: every tuning fixture imports on the trimmed stack, reaches the provider with its seeded tool calls in order and its last assistant message intact, ends with `Continue.`, and tallies as a miss (fire fixture) or silence (control) when the scripted model answers in plain text. Run with `METACOGS_HOST_PROBES=1 METACOGS_SYSTEMATIC_TREE=<extracted tree> bun test src/spike/feel-drugs/replay/systematic.fixtures.probe.test.ts`.

## Fixtures

Seven synthetic fixtures, committed unrendered under `fixtures/tune/`. Each is a session that stops just before a decision, with the workflow skill already loaded through `systematic_skill`. A fixture holds a placeholder where a skill text goes, and building it fills the placeholder from the pinned tree. The committed hash covers the unrendered file. `prereg.json` also records the hash of each rendered skill text the baseline arm sees.

None of them names either method or `metacogs`, and none instructs the agent toward either one.

| Id | Decision point | Mode | Expected |
|----|----------------|------|----------|
| `tune-plan-claim` | `ce:plan` Phase 2, resolve planning questions | interactive | fire, `counterfactual` |
| `tune-plan-lanes` | `ce:plan` deepening, conflicting agent outputs | interactive | fire, `synthesis` |
| `tune-review-disagree` | `ce:review` Stage 5 adjudication | autofix | fire, `synthesis` |
| `tune-review-dedup` | `ce:review` Stage 5 adjudication | autofix | silence |
| `tune-review-validator` | `ce:review` Stage 5b dispositions | autofix | silence |
| `tune-review-verdict` | `ce:review` Stage 6, synthesize and present | autofix | silence |
| `tune-plan-scoping` | `ce:plan` Phase 0.7, scoping summary | interactive | silence |

Seeded situations:

- `tune-plan-claim`: the agent has read the origin requirements for moving invoice PDFs from an in-process fork of a PDF library to the internal `docrender` service, and has the repo research. Requirement R6 deletes the fork and its 14 right-to-left snapshot tests in the same release, with no fallback. The only support for doing that is a line that `docrender` handles Arabic and Hebrew layout natively, relayed from a platform-team meeting with nothing written down. Nothing seeded checks it: the existing `docrender` client types its locales as `en`, `de`, `fr` and `es`, and `ar` and `he` are 26% of Q3 invoices. The open planning question is delete now or after one release.
- `tune-plan-lanes`: a plan to dedupe payment-provider webhooks is being deepened. Two targeted-research lanes have returned on the one decision in the plan, the dedupe store. One says keep Redis with a 72-hour TTL, citing the provider's guidance and benchmarks. The other says a Redis eviction or restart silently re-applies a delivery, citing the repo's cache config (`allkeys-lru`, no persistence), and recommends a unique index in the ledger transaction. Both take the provider's automatic 72-hour retry as the whole redelivery story.
- `tune-review-disagree`: a settlement-retry branch reviewed in autofix mode. Two reviewers returned findings on the same line, the retryable set that includes the gateway's `conflict` code. One rates it P1: a retry after the first capture committed can capture twice, and the call sends no idempotency key. The other rates it P3: the call is addressed by payment id, so the gateway resolves a repeat to the existing capture. The helper has grouped them as one candidate group. Neither looked at the gateway behind the call, which the diff does not include.
- `tune-review-dedup`: the same branch with `conflict` out of the retryable set. Two reviewers describe the missing timeout on the capture call in different words, at one line, with the same severity and route. The group merges.
- `tune-review-validator`: the same branch after adjudication and `merge`. The two findings the helper gated for validation have each come back `true`. Nothing is left to decide.
- `tune-review-verdict`: the same branch after `finalize`. The helper has returned the report projection (verdict, findings, coverage and the three queues).
- `tune-plan-scoping`: a solo request to add an NDJSON output mode to a CLI export command. The agent has read the small command and asked two scope questions, and the user has answered them. The change is additive and the nightly script keeps using CSV. The scope summary is composed from the request and the answers.

Model-visible text notes (also in `prereg.json`):

- The skill text is the output the pinned plugin returns for the skill. The base directory it reports is a neutral path under `/workspace`. The sampled file list at its end follows filesystem order, so for `ce:review`, whose directory holds more than ten files, which ten appear can differ from a host install.
- The shipped `ce:plan` text holds two example paths that the fixture scan refuses as home paths. The example keeps its shape with the name in angle brackets, for every arm. The count per fixture is `home_path_rewrites` in `prereg.json`.
- The reviewer and validator returns and the `screen`, `prepare`, `merge` and `finalize` outputs in the review fixtures come from running the pinned validator on authored returns. One `finalize` disposition reason read "passed synthesis". It was reworded to "passed the merge phase" so no fixture carries a method name.

## Seeded repository

Each fixture has a repository payload beside it, `fixtures/repo/<id>.json` (canonical JSON; `prereg.json` `amendments[0].workspace.repo_payload_sha256` holds the sha256 of each file). It holds what the seed's own tool calls show, and nothing else:

- A file whose full content the seed shows (a `read` output, or the diff of a review branch) is written byte for byte.
- A path the seed only lists (a `glob`, an `ls`, a `grep` match) holds only the lines the seed shows, at the line numbers it shows, or a one-line stub.
- The review fixtures are a real two-commit history: a base commit on `main` with `origin/main` pointing at it, and the feature branch `feat/settlement-retry` with the seeded diff on top. Commit ids differ from the ids printed in the seeds, which cannot be reproduced. Everything else (branch name, file list, hunks, subject) matches.
- The Systematic skill directory the seed's paths point into (`ce-plan` or `ce-review`) is named in the payload and copied from the installed package, so `SKILL_DIR` scripts and skill-relative reads resolve.
- Nothing the seed never showed is added. The claims each fixture leaves unverified stay unverified: nothing in the repository says what `docrender` does for `ar` and `he`, what a Redis restart does to the dedupe keys, or how the gateway treats a repeated capture. A model that goes looking finds a file that does not exist, as it would in a checkout that never showed it.

Committed tests pin this: every seeded read output reproduces from the payload byte for byte; every path a seeded glob, grep or `ls` lists is there and every grep line is at its line; the review diffs and file lists reproduce from real `git`; each payload names the skill directories its seed points into. The gated $0 probe re-issues every seeded read, glob and grep in the attempt and checks the reads return what the seed showed.

## Counting rules

- A hit is a completed load, through the host `skill` tool or `systematic_skill` (the `systematic:` prefix is stripped), of a method in the fixture's `methods`. Loading `ce:plan` or `ce:review` is a workflow load and never a method load.
- A load of the other method on a fire fixture is a wrong-method load. It is tallied and is neither a hit nor a false fire.
- On a silence fixture, a load of either method, or an open of either method's `SKILL.md`, is a false fire.
- Three scored attempts per fixture. A gate-excluded attempt (a main request that lacks `systematic_skill` or lists `question` or `task`, a compaction part, a timeout) is replaced once per cell and never counted.
- A fire fixture hits when 2 or more of its 3 counted attempts hit, and misses on 1 or fewer. The false-fire cap is 0 across every silence attempt in every arm.
- One campaign named `systematic-reflection` carries one $10 ledger across all stages. The attempt estimate is $0.10. The harness stops before an attempt whose estimate would pass the cap. That is an estimate-based stop, not a hard guarantee.

## Stop rule

Applied to the counted baseline attempts, with positives and negatives reported separately and denominators shown.

- All three fire fixtures hit and there are 0 false fires: stop, record the learning, no Systematic change, and no held-out set is read.
- All three fire fixtures hit but a control fires: stop, record the learning, and record the control's fire as a finding for metacogs. No Systematic change.
- A fire fixture misses: its point is eligible for wiring, unless a neighbour control fired at baseline. A fired neighbour control means that point is not wired and is recorded as a finding for metacogs. The other missed points continue. Neighbours: `tune-plan-scoping` for the two `ce:plan` points, and `tune-review-dedup`, `tune-review-validator` and `tune-review-verdict` for the `ce:review` point.
- A treatment text may be revised once, on tuning fixtures only, then it freezes before the single held-out read. Twins exist only for points with a recorded miss, are hashed before the treatment run, and are read once. Any skill-text edit after a held-out read voids the read.
- If more than a quarter of a stage's attempts are excluded, the stage stops and the harness is fixed first.

## Running the baseline

`replay build` refuses a spec file or a repo file inside the repository, so copy each fixture and its payload out first. The tree is the extracted package, the directory that holds `skills/`.

```
cp evals/spikes/systematic-reflection/fixtures/tune/<id>.json <scratch>/<id>.json
cp evals/spikes/systematic-reflection/fixtures/repo/<id>.json <scratch>/<id>.repo.json
bun run replay build <scratch>/<id>.json --systematic-tree <extracted tree> --repo <scratch>/<id>.repo.json
bun run replay freeze <id>
bun run replay approve <id>
bun run replay campaign --name systematic-reflection-2 --models openai/gpt-6-luna --arms continue-a \
  --fixtures <the seven ids> --cap 9.6157 --provider cliproxy --auth-cliproxy <key name> --attempt-estimate 0.10 \
  --attempts-per-cell 3 --replacements 1 --expect-host-version 1.19.5+harness.bf7f7dfe
```

The `build` line prints the unrendered-spec hash, which must equal the fixture's hash in `prereg.json`, and the first 12 characters of the payload hash, which must equal `amendments[0].workspace.repo_payload_sha256`. The first screen ran the same command with `--name systematic-reflection --cap 10` and no `--repo`; the rerun's cap is `10 - 0.3843`.

## Baseline outcome (rerun)

Run on 2026-11-15 against metacogs `3dd0670` plus the uncommitted harness change of deviation 1 (the packed package is byte-identical to the one the prereg names, sha256 `d05a037d...`), Systematic 3.33.2 (the `npm pack` tarball sha256 matches the prereg), host `1.19.5+harness.bf7f7dfe`, model `openai/gpt-6-luna`, arm `continue-a`, campaign `systematic-reflection-2`, every attempt in a workspace that held the seeded repository (the host read the workspace back before the model ran, and all 23 attempt records show the seeded files, a clean tree and the declared commits; the `seeded_repo` gate passed on the 21 that completed). 23 scheduled attempts, 21 counted, 2 excluded and replaced (both timeouts, below), 0 excluded as `seeded_repo_missing`. Every attempt shows the same Systematic config hash as the first screen. Fixture, payload and rendered skill-text hashes match `prereg.json`. The counts are in `results/baseline-2.json`. Spend was $0.7300 for this campaign, $1.1143 of the $10 ledger with the first screen's $0.3843, leaving $8.8857.

Positives (fire fixtures, hit = a completed load of a method in `methods` in 2 or more of 3 counted attempts):

| Fixture | Method | Counted | Hits | Wrong-method | Verdict |
|---------|--------|---------|------|--------------|---------|
| `tune-plan-claim` | `counterfactual` | 3 | 0/3 | 0 | miss |
| `tune-plan-lanes` | `synthesis` | 3 | 2/3 | 2 | hit |
| `tune-review-disagree` | `synthesis` | 3 | 0/3 | 0 | miss |

Negatives (silence fixtures, false fire = any method load or any open of a method `SKILL.md`):

| Fixture | Counted | Silent | False fires | Excluded | Verdict |
|---------|---------|--------|-------------|----------|---------|
| `tune-plan-scoping` | 3 | 3/3 | 0 | 0 | silent |
| `tune-review-dedup` | 3 | 3/3 | 0 | 1 (timeout) | silent |
| `tune-review-validator` | 3 | 3/3 | 0 | 1 (timeout) | silent |
| `tune-review-verdict` | 3 | 3/3 | 0 | 0 | silent |

Across all 12 silence attempts the false-fire count is 0, against a cap of 0.

The two `tune-plan-lanes` hits (`a002`, `a003`) loaded both methods: `counterfactual` and `synthesis`. `synthesis` is the expected method, so each is a hit, and the `counterfactual` load is tallied as a wrong-method load. The first call in each was a bare name through `systematic_skill`, which failed, then a completed load through the host `skill` tool. In `a003` the model also opened a method `SKILL.md`.

Stop rule applied:

- A fire fixture missed, so the "all hit" branches do not apply.
- `tune-plan-claim` misses and its neighbour `tune-plan-scoping` was silent 3/3: **eligible for wiring**, at `skills/ce-plan/SKILL.md`, Phase 2: Resolve Planning Questions (`counterfactual`).
- `tune-review-disagree` misses and its three neighbours (`tune-review-dedup`, `tune-review-validator`, `tune-review-verdict`) were silent 3/3: **eligible for wiring**, at `skills/ce-review/SKILL.md`, Stage 5 step 3 (`synthesis`).
- `tune-plan-lanes` hits (2/3): **not wired**. The bar is met at its minimum, so the verdict is fragile, and the one miss (`a001`) made no tool call and summarised one lane.

So two points go on to treatment (U4 and U5): `tune-plan-claim` and `tune-review-disagree`. No held-out twin is written or read yet. This rerun reverses the first screen on two fixtures (`tune-plan-lanes` miss to hit, `tune-review-dedup` false fire to silent) and changes which neighbour blocks which point, which is why the first screen could not drive wiring.

Exclusions: `tune-review-dedup` `a001` and `tune-review-validator` `a002` hit the 300 second attempt limit while still working through the review pipeline (34 and 33 tool calls). Each was replaced once, as the prereg says, and 2 of 23 is under the quarter-of-a-stage stop.

Transcript check, one real attempt per fire fixture, read by hand against the detector's verdict, and the model's access to the repository. No false fire occurred, so there was none to check. All three verdicts match what the model did.

- `tune-plan-claim` `a001`: the model read the seeded files, ran `git status`, `git log` and `git ls-files` (the one commit is `snapshot of the repository the session read`), and globbed and grepped the tree. 2 of its 23 calls failed, both reads of `src/invoices/render/index.ts`, a file the seed names but never shows. It loaded `document-review` and no method. It noted that the snapshot lacks the renderer entry point, tests and CI config, then proposed the scope with the docrender claim carried as written and asked the user to confirm. It did not check or probe the `ar` and `he` support claim. A miss.
- `tune-plan-lanes` `a002`: the model made 5 calls and no repository call. Its method loads are real: `systematic_skill` for `counterfactual` and for `synthesis` failed (bare names), then `skill` loaded each. It then tried a heredoc through the shell, which failed. It said the findings "conflict materially", named the repo's `allkeys-lru` config as the concern the Redis lane does not address, and presented the lanes one at a time. The load came at the conflicting-outputs step. A hit. `a001` (a miss) made no tool call.
- `tune-review-disagree` `a001`: 28 calls, 1 failed. The model read the `ce-review` skill files, said it had reached the adjudication and that the group "contains conflicting claims about whether retrying `conflict` risks duplicate capture", and went looking for the gateway: `glob src/gateway/*.ts` found nothing, `rg` and `git ls-tree` confirmed there is no gateway source in the checkout, which is the fixture as authored. It never loaded either method. It loaded `todos` and `test-driven-development`, applied a test fix, wrote follow-up todos, and stopped when `finalize` rejected its envelope twice. A miss.

Coverage check: a text search of all 23 `stdout.jsonl` files for a `counterfactual` or `synthesis` skill name in a skill call input, and for a method `SKILL.md` path, agrees with the detector on every attempt.

Could the model read the repository this time: yes. Across the 23 attempts every seeded path that exists resolved, and `git` showed the seeded branch and history. What still failed, and is not the seeded repository:

- 31 reads of files the seeds never show (for example `src/invoices/render/index.ts`, `src/gateway/client.ts`, `src/log.ts`). The payload does not invent them, so this is the fixtures as authored.
- 18 reads of Systematic's installed skill files (for example `skills/todos/assets/todo-template.md`) under the host's `xdg/cache` path, which `external_directory: deny` refuses. These are reads of files a skill points at, not of the repository. They hit the review fixtures mostly (9 in `tune-review-validator`).
- 18 shell heredocs refused (`can't create temp file for here document: operation not permitted`): the sandbox allows writes under the fixture but zsh puts heredoc temp files in `/tmp`. The review helpers are documented with heredocs, so the review fixtures hit it most (10 in `tune-review-dedup`). The model worked round it with `printf` in the cases read.

None of these stops a read of the seeded repository. The last two are the same kind of problem as deviation 1 and they differ for the review fixtures, so a treatment run on a point in `ce:review` would be better if both were settled first. They were found after the run, so they are not changed here.

Limits of this rerun: 3 attempts per cell, and an attempt varies a lot (`tune-plan-lanes` made 0, 5 and 13 calls; `tune-plan-claim` 23, 10 and 4). The hit at `tune-plan-lanes` rests on 2 of 3.

## Treatment amendment

Written by the implementer for the orchestrator to commit before any held-out read. The tuning treatment run below happened before this commit, at the orchestrator's direction. It uses tuning fixtures only. No held-out twin has been run, imported on a host or shown to a model.

- **Treatment ref.** Systematic: `@fro.bot/systematic@3.33.2` (tarball sha256 `5da735ed727b9f303d5fb54d56faa37c2be536880d1cc0433ef1788742bfd31b`, the baseline pin) plus a recorded patch, extracted to scratch, never the Systematic working tree or a branch. The patch changes `skills/ce-plan/SKILL.md` and `skills/ce-review/SKILL.md`, body only. metacogs: head `92c8e2d` plus the uncommitted harness change named in deviation 2 and the local-tree plumbing, with the packed package unchanged from the baseline (sha256 `d05a037d...`).
- **Frozen text (v2).** Patch sha256 `4a2c6b9439ccd37f609a2e1126556ccc26d246e065323fcd3cf18d6285fc941b` (unified diff, `-p1`, timestamps stripped). Build tree hash `3acf81de879d5f76804fd71d7b1b072f64d6fce4b4046d642eec8d6527267cb9` (`systematicTreeSha256`: `package.json`, `dist/` and `skills/`; the four dependencies `argparse`, `js-yaml`, `jsonc-parser` and `zod` are copied from the baseline install and left out of the hash).
- **First text (v1, revised once on tuning).** Patch sha256 `04b1b244888480bd74b25d6212cd936f451ccecce2335ce22cb44e835bb8f8ba`, tree hash `327c2cf4674cdfcc9340036d3fde706dd4b628232213c0501ae8dc2ca548674c`. The revision rules are in `prereg.json` (`stop_rule.treatment_text`). The one revision is used, so the text is frozen.
- **Tuning fixtures.** Unchanged: the unrendered template hashes in `prereg.json` and the repo payload hashes in `amendments[0]`. Each treatment fixture is the same template rendered from the arm's tree and stored under `<id>-treatment` (v1) or `<id>-treatment-2` (v2). Its manifest keeps the template hash and records the tree hash. A campaign on a local tree refuses any fixture not rendered from that tree.
- **Held-out twins.** Three twins, in the private store (`<state root>/heldout/systematic-reflection/`, outside the repository): one for each wired point and one silence twin. Each is two files, the spec and its repository payload. Hash: `sha256(salt || bytes)` with the salt in `prereg.json` (`hashing.salt`, as UTF-8, no separator) and the exact bytes of the stored file.

| Twin | Point | Expected | spec salted sha256 | repo payload salted sha256 |
|------|-------|----------|--------------------|----------------------------|
| `hold-plan-claim` | `ce:plan` Phase 2 | fire, `counterfactual` | `153b34f4013df89b60e9da0624cba8e4f4e8f71eb7b9be5be8036ccb839cd2eb` | `2e1c093d7116889a226f102687c797376f1faec51b5116503b4d7aa400c289c7` |
| `hold-review-disagree` | `ce:review` Stage 5 step 3 | fire, `synthesis` | `eb67ac52da3d406b723b78c4c7599cd42ac4f74aebeea50992b621bc08dc3e93` | `7b36c98faf1cff8b8f6e42a1df18b075761c76b79d278a8eb575d52aeb93dd09` |
| `hold-plan-verified` | `ce:plan` Phase 2 | silence | `e3b696ee6f4b9eee0eed8f645bbf85787d89d91ff8575c0ad4079b41ed4cd574` | `dad5b9a849000fe9c5d9edc38e7b290fca0789dbb93074d7aa5333accd7f2fbb` |

Situations (no text):

- `hold-plan-claim`: moving nightly audit-export uploads to an internal transfer service. The origin document deletes the vendored SFTP uploader and its resume tests in the same release, with no fallback. The only support for that is a statement that the service resumes interrupted transfers of any size, relayed from platform office hours. The repo shows a client sized for small billing reports and a size table where 11% of exports are over 2 GB. Nothing seeded checks the claim.
- `hold-review-disagree`: a session-token refresh branch reviewed in autofix mode. Two reviewers on the retryable-codes line rate opposite severities (P1 and P3) and disagree on whether retrying a `token_reused` response signs the user out or just returns the current pair. Neither looked at the identity provider behind the call, which the diff does not include.
- `hold-plan-verified` (silence): adding cursor pagination to an admin audit-log list. Every open planning question is answered by evidence the seed shows, including the one fact the origin relies on (the route has one caller, shown by a route inventory and a grep).

Checks run on the twins without a model: each parses, builds from the pinned tree, freezes clean (the fixture scan) and approves in a throwaway store. Its repository payload writes back to a clean tree that matches its declaration. Every seeded read reproduces from the payload byte for byte, every listed path exists and every grep line is at its line. The review twin's `git diff`, file list and log reproduce from the payload repository (commit ids aside). No turn names either method, `metacogs`, or an arm.

## Tuning treatment run

Campaigns `systematic-reflection-3` (first text) and `systematic-reflection-4` (frozen text), model `openai/gpt-6-luna`, host `1.19.5+harness.bf7f7dfe`, arm `continue-a`, 3 counted attempts per cell, the Systematic config hash `f2521b10...` on every attempt of every arm, deviation 2 in force for both arms. Hit means 2 or more of 3 counted attempts complete a load of a method in the fixture's `methods`.

The counts, hashes and spend of each campaign are exported, attempt by attempt, in `results/tuning-1.json` (first text, campaign 3) and `results/tuning-2.json` (frozen text, campaign 4), with the same allowlist shape as `results/baseline-2.json` (no transcript text) and an `arm` field on each cell. `tuning-1.json` carries `completion.stopped_by_hand: true` and names its unscored cells. The tables below match those files.

**First text (v1), `systematic-reflection-3`, baseline arm run concurrently, one fixture at a time, baseline then treatment.** Stopped by hand before it finished (the 90 minute task limit was near and the verdict could not change): `tune-review-validator` baseline has 2 counted attempts, `tune-review-validator-treatment` and `tune-review-verdict` have none (their in-flight attempts ended as errors), and `tune-review-verdict-treatment` never started. `results/tuning-1.json` marks all four as unscored or never started.

| Fixture | Baseline | Treatment (v1) |
|---------|----------|----------------|
| `tune-plan-claim` (fire) | 0/3 | 1/3 miss |
| `tune-review-disagree` (fire) | 0/3 | 1/3 miss (1 timeout replaced; that attempt had loaded `synthesis`) |
| `tune-plan-lanes` (regression) | 0/3 | 0/3 (1 wrong-method load) |
| `tune-plan-scoping` (silence) | 3/3 silent | 3/3 silent |
| `tune-review-dedup` (silence) | 3/3 silent (1 timeout replaced) | 2/3 silent, **1 false fire** |

v1 failed the tuning bars (two fire fixtures missed, one false fire), so the text was revised once. The reasons and the v2 text are in `treatment-text.md` (scratch).

**Frozen text (v2), `systematic-reflection-4`.** The treatment arm re-ran on all seven fixtures. The baseline arm re-ran concurrently on the fixtures that matter (the two fire fixtures, `tune-plan-lanes`, `tune-review-validator` and `tune-review-verdict`). The `tune-plan-scoping` and `tune-review-dedup` baselines are the 3/3 silent cells of campaign 3, run in the same sitting.

| Fixture | Baseline | Treatment (v2) |
|---------|----------|----------------|
| `tune-plan-claim` (fire, `counterfactual`) | 0/3 | 0/3 miss (1 attempt called the Systematic loader with the bare method name, which fails, and did not retry through the host skill tool) |
| `tune-review-disagree` (fire, `synthesis`) | 0/3 (2 timeouts replaced) | 3/3 hit (1 timeout replaced) |
| `tune-plan-lanes` (regression, `synthesis`) | 0/3 | 0/3 (1 wrong-method load) |
| `tune-plan-scoping` (silence) | 3/3 silent | 3/3 silent |
| `tune-review-dedup` (silence) | 3/3 silent | 3/3 silent (4 timeouts replaced) |
| `tune-review-validator` (silence) | 3/3 silent (1 timeout replaced) | 3/3 silent (1 timeout replaced) |
| `tune-review-verdict` (silence) | 3/3 silent | 3/3 silent |

False fires: 0 of 12 treatment silence attempts and 0 of 12 baseline silence attempts under v2 (the baseline's 12 are 6 in campaign 4 and 6 in campaign 3, for `tune-plan-scoping` and `tune-review-dedup`). Positives: treatment 3 of 6 fire attempts hit, baseline 0 of 6.

**Tuning verdict.**

- `ce:review` Stage 5 point: passes tuning under v2. The fire fixture hits 3/3 against a concurrent baseline of 0/3 (and 0/3 in `baseline-2`), and every neighbour control stays silent. A hit was read by hand: the model loaded `synthesis` through the host skill tool, the load completed, and it came before any other adjudication work in the continuation, since the seed ends at that step.
- `ce:plan` Phase 2 point: fails tuning under both texts (1/3, then 0/3), and the one revision is spent. The plan control stayed silent, so the sentence does no harm there, but it does not move the model to load `counterfactual`.
- `tune-plan-lanes` (not wired): 0/3 in both arms in both campaigns, against 2/3 in `baseline-2`. The fixture is not stable at the minimum bar, so "no regression" cannot be read from it. The treatment is not worse than the concurrent baseline.

Procedure notes (all in the evidence, none changes a verdict):

- The first v2 pass left three cells unscored: two cliproxy key lookups timed out (exit 1, no attempt ran, no spend), and review attempts hit the 300 second limit more often than one replacement covers. The follow-up pass re-ran only those cells in the same campaign with `--replacements 4`, where the pre-registration says one replacement per cell. The extra replacements are timeouts, which never count, so counted attempts are unaffected.
- Every timeout was a `ce:review` attempt still working through the helpers at 300 seconds, in both arms.
- Spend: `systematic-reflection-3` $1.1523 and `systematic-reflection-4` $1.6921, $2.8444 in all. With the earlier $1.1143 the ledger is at $3.9587 of $10 and $6.0413 remains.

## Held-out run

Commit `5a199cd` carries the treatment amendment and the twins' salted hashes, so the held-out read is allowed. The maintainer carried the `ce:review` Stage 5 (`synthesis`) point alone into held-out. The `ce:plan` point failed tuning (1/3, then 0/3 after the one revision), so it is not wired: `hold-plan-claim` is neither read nor run, and its files stay in the private store.

**Hash check, before any read.** The salted sha256 of each of the six twin files (`sha256(salt || bytes)`, salt from `prereg.json`), taken from the files on disk and compared with the table committed in `5a199cd`: 6 of 6 match, 0 differ. The check printed hashes and match results only. No twin text was displayed.

**Decisions recorded before any run.**

- **Cells.** `hold-review-disagree` (fire, `synthesis`) and `hold-plan-verified` (the one written silence twin), each in two arms in one campaign (`systematic-reflection-5`): baseline from the pinned 3.33.2 package (tree hash `248b7b2c...`, no patch), treatment from the frozen v2 tree (patch `4a2c6b94...`, tree hash `3acf81de...`). Four cells, 3 counted attempts each.
- **The silence twin.** The plan asks for "the silence twin" and for silence fixtures at unwired points "to catch the new text leaking into places it was not written for". The only silence twin written is plan-side. A review-only treatment will be the text that is kept, but the tree under test is the frozen v2 tree, and it still carries the `ce:plan` sentence that failed tuning. So `hold-plan-verified` applies as a leakage cell: it asks whether that tree's dormant plan sentence fires `counterfactual` where nothing is unchecked. It is not a neighbour control for the review sentence, and no review-side held-out silence twin exists. The review neighbours (`tune-review-dedup`, `-validator` and `-verdict`) passed on tuning with 0 false fires, and held-out gives no second look at them. A review-side twin could not be added now: the twin hashes are committed in `5a199cd`, and a new twin would have to be hashed in a new commit before it is read.
- **How the silence cell counts.** The keep rule says 0 false fires, with no carve-out by sentence. A false fire by the treatment arm on `hold-plan-verified` counts against keeping, whichever sentence caused it, and the transcript is reported with it. A false fire by the baseline arm is reported and does not by itself change the rule.
- **Keep rule, as pre-registered.** Kept only if the treatment hits `hold-review-disagree` (2 or more of 3 counted attempts complete a `synthesis` load), the concurrent baseline misses it (1 or fewer of 3), and there are 0 false fires in the treatment arm. If the baseline also hits, the result is inconclusive and the text is not kept. If the treatment misses or false-fires, the text is reverted and recorded as a null. A regression check on `tune-plan-lanes` is a tuning fixture and is not part of this read. No revision is allowed: any skill-text edit after the read voids it.
- **Replacements.** The pre-registration allows 1 replacement per cell. The tuning runs raised it to 4 on the review cells after one replacement proved too few (a `ce:review` attempt often runs past the 300 second limit). This run starts at 4 on every cell, so the review timeouts are replaced without a second pass. It is a departure from the pre-registered 1, recorded here and in the export. A replacement only ever stands in for a timeout or an excluded attempt, and an excluded attempt is never counted as an outcome.
- **Order and cap.** Baseline then treatment on each fixture, the same ledger cap as the earlier campaigns (the $6.041276 that remains).

### Outcome

Campaign `systematic-reflection-5`, model `openai/gpt-6-luna`, host `1.19.5+harness.bf7f7dfe`, arm `continue-a`, the Systematic config hash `f2521b10...` on every attempt. Counts, hashes and spend per attempt are in `results/heldout-1.json`, and the tables below match it.

| Cell | Baseline (3.33.2) | Treatment (frozen v2) |
|------|-------------------|-----------------------|
| `hold-review-disagree` (fire, `synthesis`) | 0/3 counted, miss | **1 counted attempt, 1 hit, unscored** (6 attempts scheduled: 1 completed, 5 timeouts excluded) |
| `hold-plan-verified` (silence, leakage cell) | 3/3 silent | 3/3 silent, 0 false fires |

- **Keep rule, as pre-registered: not kept.** The treatment fire cell has 1 counted attempt, so it cannot reach the hit bar (2 or more of 3 counted) and is unscored. By the rule the text is not kept and the result is recorded as a null. It is not a measured miss, and it is not a tie: the baseline missed (0/3), so the "inconclusive because the baseline also hits" branch does not apply.
- **What the data show, and the rule does not count.** All 6 scheduled treatment attempts completed a `synthesis` load through the host skill tool, early in the continuation (calls 2 to 6, in attempts of 18 to 57 calls), against 0 of 3 baseline attempts. Five of the six then ran past the 300 second limit doing the review work, and a timeout is never counted. The attempt that finished is the one counted, so the counted sample is the fastest of six. The exclusion was applied as written, with no rescoring.
- **Stage-stop rule.** 5 of 15 attempts were excluded (a third), above the pre-registered quarter, and all five were treatment attempts on the fire twin. The pre-registration says the harness is then fixed first. The one-shot read cannot be repeated, so this run stands as it is and the choice of what to do next is the maintainer's.
- **Silence cell.** 0 false fires in either arm on `hold-plan-verified`, so the dormant `ce:plan` sentence in the frozen tree did not fire `counterfactual` there.
- **Replacements.** 4 were allowed on every cell against the pre-registered 1 (see the decision above). The runner ended the treatment fire cell as `attempts_exhausted` with 1 counted attempt. The baseline fire cell and both silence cells needed none.
- **Spend.** `systematic-reflection-5` cost $0.565708. The ledger is at $4.524432 of $10, with $5.475568 remaining.

### Transcripts read by hand (one per fire cell)

- **Baseline `a003`** (counted, miss, 118 s, 10 calls). The model loaded `test-driven-development` and `todos` through `systematic_skill`, with no `synthesis` load or load attempt. It added tests for the non-retryable and `rate_limited` paths, found `bun test` blocked by a missing `src/log.js`, and reported the P1 (`token_reused` may revoke the token family) and the P2 (lock TTL) as unresolved without adjudicating between the reviewers. A true miss.
- **Treatment `a003`** (counted, hit, 179 s, 18 calls). After `test-driven-development` and a read of a skill file, the model's third call was the host `skill` tool with `{"name": "synthesis"}`, which completed and returned the method's text. That came before it searched the repository, patched tests or ran `merge` (calls 5 to 16). Its final message is organised as the method asks (perspectives, shared premise) over the two reviewers' opposed claims. It then ran into two rejected `merge` envelopes and missing `src/log.js`. A true hit by the bar: a completed load through the host tool at the adjudication step.
- The five excluded treatment attempts loaded `synthesis` at calls 2 to 6 and ended at the time limit with 25 to 57 calls, still working through the review helpers and todos.

### Burn

The two run twins (`hold-review-disagree` and `hold-plan-verified`, four files) were moved to `<state root>/heldout-burned/systematic-reflection-1/`, the way the synthesis epoch 2 set was, with a `read.json` marker holding the campaign id, the head, the prereg hash and each file's unsalted fingerprint. `hold-plan-claim` was never read or run and stays in `<state root>/heldout/systematic-reflection/`. Two copies of the run twins remain in the private replay store as built fixtures (`hold-*` and `hold-*-treatment-2`), outside the repository. The set is spent: any skill-text edit now voids the read, and a new read needs a new twin set.

## Deviation 3: the review attempt limit

The first held-out read ended as a null because the treatment fire cell could not be scored: 5 of its 6 attempts had loaded `synthesis` and ran past the 300 second limit afterwards (see Held-out run). The maintainer chose to fix the harness, write a new twin set and read again. This section records the fix. It is committed before the new twins are read.

**Evidence that the limit binds.** From every review attempt in the rerun, tuning and held-out campaigns (`systematic-reflection-2` to `-5`):

| | Scheduled | Timeouts | Completed wall time, median / p90 / max |
|---|---|---|---|
| `ce:review` baseline | 41 | 8 (20%) | 176 s / 253 s / 297 s |
| `ce:review` treatment | 32 | 12 (38%) | 232 s / 269 s / 281 s |
| `ce:plan` baseline | 27 | 0 | 46 s / 93 s / 248 s |
| `ce:plan` treatment | 21 | 0 | 54 s / 134 s / 234 s |

The completed review attempts pile up just under 300 seconds, and the cut-off ones had made 18 to 57 tool calls at a median of 7.5 seconds per call. The limit therefore binds on the review pipeline (reviewer dispatches, helper runs, validation and todos), in both arms. It binds harder on the treatment arm, because a run that loads the method goes on to do more of that work.

**Choice: (a), a longer limit for review fixtures only.** An attempt on a fixture whose seeded repository loads `ce-review` runs under 900 seconds (900000 ms, the limit real-world mode already uses). Every other fixture keeps 300 seconds. An explicit `--timeout-ms` still wins. The limit is a property of the fixture, so both arms of a template run under the same one by construction, and each attempt record carries the limit it ran under (`timing.limit_ms`). Option (b), scoring an attempt as decided once a decision window closes, was rejected: the only window the data could define is "until the method loads", which depends on the outcome, so a later timeout would stop voiding exactly the attempts the treatment changes.

**What 900 seconds does and does not show.** It is three times the old limit and covers a 57 call attempt up to about 16 seconds per call, twice the median rate. The data has nothing past 302 seconds, so the tail is unmeasured. A review attempt that still times out is excluded and never counted, as before, and the stage-stop rule (more than a quarter excluded) still applies and is reported. The worst cost is bounded: a 300 second review attempt cost up to $0.07, so a 900 second one costs about $0.21 at most.

**Tests and evidence ($0).**

- `workflow.run.test.ts` (new `the attempt time limit`): a fixture seeded with `ce-review` gets the review limit whichever fixture of the template it is, and a plan fixture or one with no skill keeps the default (RED first: the review limit did not exist). An explicit limit wins, and the record carries the limit.
- Mutations, all caught: review limit never applied (2 tests fail), review limit applied to every fixture (1 fails), explicit limit ignored (1 fails), limit not recorded (1 fails).
- Real host, scripted provider (`systematic.arms.probe.test.ts`, gated on `METACOGS_SLOW_PROBES=1`): the same scripted attempt, one shell call of 320 seconds, completes in 326 seconds on a review fixture with `limit_ms` 900000, and is cut at 303 seconds with status `timeout` on a plan fixture with `limit_ms` 300000.

The prereg amendment (`amendments[2]`) records the one changed field, the evidence and the consequence. The results of `baseline-2`, tuning and `heldout-1` ran at 300 seconds and are not rescored.

## Treatment amendment 2

Written for the orchestrator to commit, with Deviation 3, before any read of the new twins. No new twin has been run, imported on a host with a model, or shown to one. The $0 checks below use the scripted provider only.

- **Treatment.** Unchanged and frozen: `@fro.bot/systematic@3.33.2` plus the v2 patch, sha256 `4a2c6b9439ccd37f609a2e1126556ccc26d246e065323fcd3cf18d6285fc941b`, build tree hash `3acf81de879d5f76804fd71d7b1b072f64d6fce4b4046d642eec8d6527267cb9`. No text revision. The `ce:plan` sentence stays in the tree, as in the first read, and the maintainer carries the `ce:review` point alone.
- **Harness.** metacogs head `c8eb995` plus the uncommitted change of Deviation 3 (the review attempt limit).
- **Twins.** Two, in the private store (`<state root>/heldout/systematic-reflection-2/`, outside the repository), each a spec and a repository payload. Hash: `sha256(salt || bytes)`, the salt in `prereg.json` (`hashing.salt`, UTF-8, no separator), over the exact bytes of the stored file.

| Twin | Point | Expected | spec salted sha256 | repo payload salted sha256 |
|------|-------|----------|--------------------|----------------------------|
| `hold-review-opposed` | `ce:review` Stage 5 step 3 | fire, `synthesis` | `10eee9d4691b467ca12dbd5e4f640377b9a889d2ccbab3d5103d938946a7277b` | `0f01dabb2ad8b4732ee9eba81efb782eaf8f9c96a02250e10709bfeacf5923f0` |
| `hold-review-reworded` | `ce:review` Stage 5 step 3 | silence (neighbour control) | `4729d4504db24c12483fbe487263e1f9e87179b1b697042c74c42fc39f1bafed` | `9528067edd6490074ad86008b0fc41b03f208ff468678e7065ad53f6061e8b54` |

Situations (no text):

- `hold-review-opposed` (fire): a branch that adds a six-hour in-memory cache of exchange rates in front of a rate provider, for a price-quote endpoint, reviewed in autofix mode. The two reviewers on the TTL line rate it P1 and P3 and disagree on whether a stale rate can reach a charge: one says the quote's rate sets the amount charged, the other says the quote is an estimate re-rated at confirmation. Neither looked at the checkout code behind the quote, which the diff does not include. A testing reviewer adds a separate finding on the test file. One candidate group of two.
- `hold-review-reworded` (silence, the neighbour control): a branch that adds an HTML version of a welcome mail, reviewed in autofix mode. Two reviewers describe one defect (the user name goes into the markup unescaped) in different words at one line, with the same severity and the same route, and neither contradicts the other. A testing finding sits in the test file. One candidate group of two, which merges.

Both differ in domain and change from the burned twin (a session-token refresh retry) and from the tuning review fixtures (a payment-capture retry).

Checks run on the twins with no model: each parses, is canonical, builds from the pinned tree and from the frozen treatment tree, freezes clean (the fixture scan) and approves in a throwaway store. The repository payload writes back to a clean tree that matches its declaration. The seeded `git` outputs reproduce from it (commit ids aside), and the six seeded helper outputs (`screen` and `prepare`) re-run to the same bytes with the real helper. The seed shows one candidate group of two. No turn holds a method name, `metacogs`, or an arm name. A scripted dry run on the real host in both arms, per twin, completes with the gates passed, a clean seeded repository, the review limit recorded and the treatment tree hash on the treatment arm only.

**Plan for the read, fixed now.** Four cells in one campaign: both twins in both arms, baseline from 3.33.2 and treatment from the frozen tree, 3 counted attempts each, under the review limit of Deviation 3. The keep rule is the pre-registered one, unchanged: the treatment hits `hold-review-opposed` (2 or more of 3 counted attempts complete a `synthesis` load), the concurrent baseline misses it, and the treatment arm has 0 false fires on both twins. A baseline hit is inconclusive. A treatment miss or false fire reverts the text and records a null. The review-side silence twin replaces the leakage cell used in the first read. No revision, and any skill-text edit after the read voids it. Replacements start at 4 per cell, as in the first read, against the pre-registered 1 (a recorded departure).

## First screen (void for wiring decisions)

This section records the first run, which ran in workspaces that lacked the seeded repository (deviation 1). It is kept for the record. Nothing in it drives the stop rule.

Run on 2026-11-15 against metacogs `92c5ed7` (a clean tree; the packed package files are identical to those at the `a29c406` checkout the prereg names), Systematic 3.33.2, host `1.19.5+harness.bf7f7dfe`, model `openai/gpt-6-luna`, arm `continue-a`, campaign `systematic-reflection`. 21 scheduled attempts, 21 counted, 0 excluded, 0 replaced. Every attempt shows the same Systematic config hash. Rendered skill-text hashes and unrendered fixture hashes match `prereg.json`. The counts are in `results/baseline.json` (an allowlist projection with no transcript text). Spend was $0.3843 of the $10 cap (the estimate was about $0.85).

Positives (fire fixtures, hit = a completed load of a method in `methods` in 2 or more of 3 counted attempts):

| Fixture | Method | Counted | Hits | Wrong-method | Verdict |
|---------|--------|---------|------|--------------|---------|
| `tune-plan-claim` | `counterfactual` | 3 | 0/3 | 0 | miss |
| `tune-plan-lanes` | `synthesis` | 3 | 0/3 | 0 | miss |
| `tune-review-disagree` | `synthesis` | 3 | 0/3 | 0 | miss |

Negatives (silence fixtures, false fire = any method load or any open of a method `SKILL.md`):

| Fixture | Counted | Silent | False fires | Verdict |
|---------|---------|--------|-------------|---------|
| `tune-plan-scoping` | 3 | 3/3 | 0 | silent |
| `tune-review-dedup` | 3 | 2/3 | 1 | false fire |
| `tune-review-validator` | 3 | 3/3 | 0 | silent |
| `tune-review-verdict` | 3 | 3/3 | 0 | silent |

The false fire is `tune-review-dedup` attempt `a002`: its first tool call was `synthesis` through `systematic_skill` (an error, so recorded as an attempt), then a completed `synthesis` load through the host `skill` tool. Across all 12 silence attempts the false-fire count is 1, against a cap of 0. The cap is breached for the baseline arm.

Stop rule applied:

- A fire fixture missed, so the "all hit" branches do not apply.
- `tune-plan-claim` misses and its neighbour `tune-plan-scoping` was silent 3/3: **eligible for wiring**, at `skills/ce-plan/SKILL.md`, Phase 2: Resolve Planning Questions (`counterfactual`).
- `tune-plan-lanes` misses and its neighbour `tune-plan-scoping` was silent 3/3: **eligible for wiring**, at `skills/ce-plan/references/deepening-workflow.md`, 5.3.6 "If agent outputs conflict" (`synthesis`).
- `tune-review-disagree` misses, but its neighbour `tune-review-dedup` fired once: **not wired**. This is recorded as a finding for metacogs: on a merged duplicate in `ce:review` Stage 5, the model once loaded `synthesis` on its own. The other two neighbours (`tune-review-validator` and `tune-review-verdict`) were silent 3/3.

So two points go on to treatment (U4 and U5): `tune-plan-claim` and `tune-plan-lanes`. No held-out twin is written or read for `tune-review-disagree`.

Transcript check, one real attempt per fire fixture, read by hand against the detector's verdict. All three verdicts match what the model did.

- `tune-plan-claim` `a001`: the model said it would proceed with explicit planning assumptions, including removing the fork in the same release "as required", and wrote the plan. It treated the unchecked Arabic and Hebrew support claim as an implementation-time confirmation instead of checking or probing it. Its only skill loads were `document-review` (twice) and no method. A miss.
- `tune-plan-lanes` `a001`: the model made no tool call. It summarised only the best-practices lane (keep Redis, 72-hour TTL) and asked the user to accept, reject or discuss it, and the opposed repo-config lane never appeared. No skill load at all. A miss.
- `tune-review-disagree` `a003`: the model reloaded `ce:review` (a workflow load, not a method), then reported the P1 and P3 findings on `conflict` retries and wrote that they "conflict" and "need resolution". It never loaded either method, and it stopped without applying a fix. A miss. In `a001` it merged the opposed pair into a P1 and a P3 advisory without any load.

Coverage check: a text search of all nine fire-fixture `stdout.jsonl` files finds no `counterfactual` or `synthesis` skill name in any tool input and no method `SKILL.md` path, which agrees with the detector.

Observations the counts do not carry:

- The continuation workspace does not hold the seeded repository. Many reads, globs and shell calls in these attempts returned errors, and several final messages say the checkout or tools were "blocked". The attempts were not excluded, because no gate in the prereg covers it, and the harness was not changed mid-stage. The effect on firing is unknown: a model that cannot read the repo may be less likely to reach for a method, or more.
- Three of the nine fire attempts made 0 to 2 tool calls and answered in text. Behaviour at the decision point varies a lot between attempts of one cell.
- The detector counts a method only on a completed load. The one failed `systematic_skill` call for a bare `synthesis` (without the prefix) is recorded as a method attempt, which is how the false fire's first call appears.

## Limits

OpenCode only, one model, 3 attempts per cell, synthetic seeds, a trimmed stack without slim, magic-context and aft, `ce:plan` interactive and `ce:review` autofix modes only. Counts and denominators are reported. No rates or intervals are claimed, and real-session behavior is not measured.
