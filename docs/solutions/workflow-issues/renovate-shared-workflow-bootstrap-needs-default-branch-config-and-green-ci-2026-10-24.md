---
title: "Renovate via the shared workflow bootstraps only after config is on the default branch and CI is green"
date: 2026-10-24
category: workflow-issues
module: repo-ops
problem_type: workflow_issue
component: development_workflow
severity: low
tags: [renovate, github-actions, bootstrap, required-checks, workflow-run, onboarding]
related_components: [tooling]
applies_when:
  - "Adding Renovate to a repo through the shared bfra-me reusable workflow"
  - "The Renovate workflow is gated on a CI `workflow_run`"
  - "Choosing which checks to require in branch rulesets"
---

# Renovate via the shared workflow bootstraps only after config is on the default branch and CI is green

## Context

Renovate was added through `bfra-me/.github/.github/workflows/renovate.yaml` (`v4.43.0`). The PR that introduced `.github/renovate.json5` failed its own `Renovate / Renovate` check. After merge, Renovate still did nothing until CI on `main` went green. The bootstrap has three ordering constraints that are not obvious from the workflow file.

## Guidance

1. **Expect the introducing PR's Renovate run to fail.** The dry run reports:
   `Error fetching config file from base branch - possible config name mismatch between branches?`
   Renovate resolves the config filename from the default branch, and that branch has no config yet (the repo is still in onboarding, so the onboarding PR also shows a "config error" notice). Merge on the other required checks. The error is not a defect in the config.

2. **Green CI on `main` gates the first real run.** `.github/workflows/renovate.yaml:24-27` triggers on `workflow_run` of `workflows: [CI]`, and `:36-39` includes the clause `github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success'`. When CI on `main` failed (an unrelated flaky test), the Renovate job was skipped. After CI went green, the first run executed: the onboarding PR autoclosed, the Dependency Dashboard opened, and the first branch was created. Re-run or fix CI on `main` first; nothing else will start Renovate.

3. **The first dependency PR needs one more full run.** The run that fires on a Renovate branch push is a dry run (the `push` trigger on non-`main` branches, `:10-11`). The PR opens on the next full run, after that branch's own checks pass.

4. **Keep `Renovate / Renovate` out of required status checks.** The workflow triggers on `push` (non-`main`) and PR `edited` (`:5-11`), not on `opened` or `synchronize`, and it never runs for fork PRs. A fork PR would wait forever on a required check that cannot start. `.github/settings.yml:38-39` requires only `check` and `Fro Bot`.

## Why This Matters

Without these expectations, the failing first PR looks like a broken config, and the skipped job after merge looks like a broken trigger. Both lead to needless debugging. Requiring the Renovate check would block every fork PR indefinitely.

## When to Apply

- Onboarding a repo to the shared Renovate workflow.
- Debugging "Renovate never ran" after a config merge. Check the CI conclusion on `main` first.
- Editing the required checks in `.github/settings.yml`.

## Examples

Trigger and guard in `.github/workflows/renovate.yaml`:

```yaml
workflow_run:
  branches: [main]
  types: [completed]
  workflows: [CI]
# ...
if: >
  (github.event.action == 'edited' && !contains(github.actor, '[bot]')) ||
  (github.event.action != 'edited' && github.event_name != 'workflow_run') ||
  (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success')
```

Required checks in `.github/settings.yml:38-39`:

```yaml
- {context: check, integration_id: 15368}
- {context: Fro Bot, integration_id: 15368}
```

## Related

- PR #5 (Renovate setup), PR #9 (required checks)
- [renovate-changesets rejects a single-package root unless `workspaces` includes "."](../integration-issues/renovate-changesets-single-package-root-needs-workspaces-dot-2026-10-24.md)
- `.github/renovate.json5`, `.github/workflows/renovate.yaml`, `.github/settings.yml`
- `docs/plans/2026-10-23-001-feat-repo-ops-plan.md` (Units 4 and 7)
