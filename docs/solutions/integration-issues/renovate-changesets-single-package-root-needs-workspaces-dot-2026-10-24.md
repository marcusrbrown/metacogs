---
title: "renovate-changesets rejects a single-package root unless `workspaces` includes \".\""
date: 2026-10-24
category: integration-issues
module: repo-ops
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "Action failed: Configured target-package \"metacogs\" cannot be used as a Changesets release target: it is not a declared workspace member"
  - "Renovate PR gets no changeset file from the renovate-changesets job"
  - "Re-running the failed job after the fix merged still fails on the same PR"
root_cause: config_error
resolution_type: config_change
tags: [renovate, changesets, bfra-me, workspaces, github-actions, bun]
related_components: [development_workflow]
---

# renovate-changesets rejects a single-package root unless `workspaces` includes "."

## Problem

The `bfra-me/.github` `renovate-changesets` action refuses to use the root package of a single-package repository as a Changesets release target. It treats the root as a workspace member only when it is explicitly declared as one. A repo with no `workspaces` field fails, even though `target-package` names the root package correctly.

## Symptoms

- The job fails on the first Renovate PR with:
  `Action failed: Configured target-package "metacogs" cannot be used as a Changesets release target: it is not a declared workspace member`
- No `.changeset/*.md` file is generated for the dependency PR.
- Re-running the job on that PR keeps failing even after the `package.json` fix is on `main`.

## What Didn't Work

- **Re-running the job.** The action checks out the PR head, which still lacks the `package.json` change. A re-run reproduces the failure until the branch contains the fix.
- **Relying on `target-package`.** `.github/workflows/renovate-changesets.yaml:64-66` passes `target-package: metacogs`. This is required for a private root, but it does not mark the root as a workspace member.

## Solution

Declare the root as its own workspace in `package.json`:

```json
"workspaces": ["."]
```

`package.json:5-7` carries this. `bun.lock` did not change, and `bun install --frozen-lockfile` still passes.

Then make Renovate rebase the open PR so its head includes the fix: tick the rebase checkbox in the PR body. The next job run on the rebased head succeeds.

Related configuration that must be in place for the job to work end to end:

- **Caller workflow.** `.github/workflows/renovate-changesets.yaml` calls the reusable `bfra-me/.github/.github/workflows/renovate-changeset.yaml` (singular) at `v4.43.0` (`e6a1ab17bb68213940f63de91bd0450acdf9fff4`) and sets `target-package` (`:64-66`).
- **Ignored authors.** `.github/renovate.json5:7` sets `gitIgnoredAuthors` to include both the GitHub App bot (`137683033+mrbro-bot[bot]@users.noreply.github.com`) and `bfra-me[bot]` (`118100583+bfra-me[bot]@users.noreply.github.com`). The second is the reusable workflow's commit identity. Without it, Renovate sees the changeset commit-back as a foreign commit and stops rebasing the branch.

## Why This Works

The action decides whether the root is a declared member in `isDeclaredWorkspaceRoot` ([`workspace-discovery.ts:171-190`](https://github.com/bfra-me/.github/blob/a06d70b2bb9f54f380d59b03efae3eaa08f48624/.github/actions/renovate-changesets/src/multi-package/workspace-discovery.ts#L171-L190), tag `renovate-changesets@0.3.2`). It returns true only if root `package.json` `workspaces` includes `"."`, or `pnpm-workspace.yaml` `packages` includes `.`.

In `run-generation.ts`, an explicit `target-package` that resolves to a non-member throws the error above ([`run-generation.ts:131-151`](https://github.com/bfra-me/.github/blob/a06d70b2bb9f54f380d59b03efae3eaa08f48624/.github/actions/renovate-changesets/src/run-generation.ts#L131-L151)). The fallback target list also excludes non-members ([`run-generation.ts:154-168`](https://github.com/bfra-me/.github/blob/a06d70b2bb9f54f380d59b03efae3eaa08f48624/.github/actions/renovate-changesets/src/run-generation.ts#L154-L168)), so there is no implicit route for the root package.

## Prevention

- Add `"workspaces": ["."]` to the root `package.json` before enabling `renovate-changesets` in any single-package repo (or add `.` to `pnpm-workspace.yaml` `packages`).
- Pass `target-package` for private roots.
- List both the App bot and `bfra-me[bot]` in `gitIgnoredAuthors`.
- When the fix lands after the first Renovate PR exists, rebase that PR rather than re-running the job.

## Related Issues

- PR #13 (the fix), PR #11 (the Renovate PR where it surfaced)
- `.github/workflows/renovate-changesets.yaml`, `.github/renovate.json5`, `package.json`
- [Renovate via the shared workflow bootstraps only after config is on the default branch and CI is green](../workflow-issues/renovate-shared-workflow-bootstrap-needs-default-branch-config-and-green-ci-2026-10-24.md)
- marcusrbrown/infra `docs/solutions/integration-issues/renovate-changesets-monorepo-targeting-2026-04-15.md` (the monorepo side of the same action)
