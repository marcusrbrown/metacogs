# Systematic reflection baseline

Does the `counterfactual` or `synthesis` method load at chosen `ce:plan` and `ce:review` decision points when a user has Systematic and metacogs installed, and does it stay silent where it should? This spike measures the shipped Systematic before anything is wired. Nothing in Systematic changes unless a decision point misses here.

`prereg.json` holds the protocol and the fixture hashes. It is committed before any paid run. This file holds the counting rules, the probe answers, the choices behind the baseline arm, and a log of deviations.

Status: baseline screen run and recorded (see Baseline outcome). No treatment run yet.

- Pre-registration commit: `d0d35fd`.
- Deviations log: none.

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

`replay build` refuses a spec file inside the repository, so copy each fixture out first. The tree is the extracted package, the directory that holds `skills/`.

```
cp evals/spikes/systematic-reflection/fixtures/tune/<id>.json <scratch>/<id>.json
bun run replay build <scratch>/<id>.json --systematic-tree <extracted tree>
bun run replay freeze <id>
bun run replay approve <id>
bun run replay campaign --name systematic-reflection --models openai/gpt-6-luna --arms continue-a \
  --fixtures <the seven ids> --cap 10 --provider cliproxy --auth-cliproxy <key name> --attempt-estimate 0.10 \
  --attempts-per-cell 3 --replacements 1 --expect-host-version 1.19.5+harness.bf7f7dfe
```

The `build` line prints the unrendered-spec hash, which must equal the fixture's hash in `prereg.json`.

## Baseline outcome

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
