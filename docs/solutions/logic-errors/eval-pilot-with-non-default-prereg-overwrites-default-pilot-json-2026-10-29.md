---
title: "A pilot run with a non-default `--prereg` overwrote the default pilot's committed `pilot.json`"
date: 2026-10-29
category: logic-errors
module: runner
problem_type: logic_error
component: tooling
symptoms:
  - "`eval pilot --prereg evals/synthesis/pilot-2/prereg.json` wrote its tally to `evals/synthesis/pilot/pilot.json`, epoch 1's committed file"
  - "No warning: a tally under a different prereg content hash replaced the existing file without a log line"
  - "`rejudge` and `pairs --reconcile` under the same prereg resolved the same wrong directory"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [eval-runner, pilot, prereg, output-path, hardcoded-path, regression-test, byte-identical, pair-summary]
related_components: [testing_framework]
---

# A pilot run with a non-default `--prereg` overwrote the default pilot's committed `pilot.json`

## Problem

The eval runner derived the output directory for `pilot.json` and `pair-summary.json` from the method name instead of the prereg the run used. A second pilot of the same method (`evals/synthesis/pilot-2/`) therefore wrote over the first pilot's committed tally (`evals/synthesis/pilot/pilot.json`).

## Symptoms

- A baseline screen run with `--prereg evals/synthesis/pilot-2/prereg.json` replaced `evals/synthesis/pilot/pilot.json`. The file was restored from git before PR #59 landed.
- The overwrite was silent. `writePilotTally` (`src/runner/pilot.ts:396-410`) logs a replacement only when the existing file has the same prereg content hash (`src/runner/pilot.ts:399-404`). A pilot whose prereg content differs has a different hash, so its tally starts the file over with no log line (`src/runner/pilot.ts:405-410`).
- `rejudge`, including `--tally-only`, and `pairs --reconcile` resolved the same directory.

## What Didn't Work

- Restoring the file from git recovered the data. It did not change where the writer pointed, so the next non-default run would overwrite the file again.

## Solution

The output directory is now the directory that holds the prereg the run used. `pilotDir` (`src/runner/pilot.ts:378`) and `pilotTallyPath` (`src/runner/pilot.ts:379`) take the repo-relative prereg path that `pilotPreregRel` returns (`src/runner/pilot.ts:368-371`). `pairSummaryPath` (`src/runner/pairs.ts:840`) builds on `pilotDir`.

```ts
// before (introduced in d4de6e4, replaced in 2a25ae6)
export const pilotDir = (repoRoot: string, method: string): string => join(repoRoot, 'evals', method, 'pilot')

// after (src/runner/pilot.ts:378)
export const pilotDir = (repoRoot: string, preregRel: string): string => join(repoRoot, dirname(preregRel))
```

- `writePilotTally` (`src/runner/pilot.ts:396`) and `writePairSummary` (`src/runner/pairs.ts:843`) now take `preregRel` after `repoRoot`. The old `writePairSummary` read `summary.method`, so it had no way to know about a second prereg.
- All three callers pass the prereg path they already resolved: `eval pilot` (`src/runner/cli.ts:437`), `rejudge` and `rejudge --tally-only` (`src/runner/cli.ts:613`), and `pairs --reconcile` (`src/runner/cli.ts:736`).
- `pairs --reconcile` gained `--prereg`, resolved with `pilotPreregRel` (`src/runner/cli.ts:726`). It refuses a path outside the repo or one that names no file (`src/runner/cli.ts:727-729`).
- Defaults are unchanged. The default prereg is `evals/<m>/pilot/prereg.json`, so the tether pilot and synthesis epoch 1 keep their paths (`src/runner/pilot.test.ts:606-612`).

## Why This Works

A run is enforced against its prereg, and the prereg's location is the one input that already tells two pilots apart. `--prereg` already carried that location to every command that writes output. `pilotPreregRel` rejects paths outside the repo (`src/runner/pilot.ts:368-371`), so a directory derived from its result stays inside the repo. Callers must pass that result: `pilotDir` and the writers take a plain `string` (`src/runner/pilot.ts:378-396`), which does not enforce it.

The defect is older than the symptom. The hardcoded `pilotDir` and the `--prereg` flag arrived together with the first pilot (#22). From then on, the flag could name another prereg while the writer ignored it. Nothing exercised that until a second pilot prereg existed (#59). `content_dir` came later (#53) and also left the output path alone.

## Prevention

- When a contract or config location becomes configurable, through a flag or a `content_dir`-style field, derive every output path from where that file lives. Do not derive output paths from a name or a convention.
- Add a regression test that runs the writer under a non-default location, after planting a known file in the default directory. Assert that the default directory is byte-identical afterwards.
- Test every entry point that writes, not only the shared writer. A flag present on one command and missing on another, as `--prereg` was on `--reconcile`, is the same bug.
- Known gap: the `eval pilot` call at `src/runner/cli.ts:437` has no end-to-end test, because `main()` cannot take a fake host. It goes through the same `writePilotTally` that the `rejudge` tests cover.

Regression tests:

- `src/runner/pilot.test.ts:627-639` checks `writePilotTally`: a non-default prereg leaves the default `pilot.json` byte-identical.
- `src/runner/pilot.test.ts:601-625` checks `pilotDir`, `pilotTallyPath` and `pilotPreregRel` path resolution.
- `src/runner/pairs.test.ts:940-957` checks `writePairSummary`: the same byte-identical check for `pair-summary.json`.
- `src/runner/pairs.test.ts:1152-1203` runs the same check through `pairs --reconcile`, plus the refusals.
- `src/runner/cli.test.ts:823-856` runs the same check through `rejudge` and `rejudge --tally-only`.

## Related Issues

- PR #60 (fix), PR #59 (where it surfaced), PR #53 (`content_dir`), PR #22 (first pilot, `--prereg` and the hardcoded directory)
- `evals/runner/README.md` (the `eval pilot` "Writes" list and `pairs` usage)
- `docs/solutions/best-practices/eval-fixture-headroom-baseline-screen-before-skill-arm-2026-10-29.md`
