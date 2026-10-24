---
title: "actionlint rejects an empty or commented `schedule:`; comment the whole block"
date: 2026-10-24
category: developer-experience
module: ci
problem_type: developer_experience
component: development_workflow
severity: low
tags: [actionlint, github-actions, schedule, cron, yaml]
related_components: [tooling]
applies_when:
  - "Shipping a workflow with its cron trigger disabled"
  - "Enabling a previously disabled schedule"
---

# actionlint rejects an empty or commented `schedule:`; comment the whole block

## Context

A workflow can ship with its daily cron disabled until the first manual run succeeds. Both obvious ways to disable the cron leave an invalid `on.schedule` value.

## Guidance

Comment out the entire `schedule:` block, key included. To enable, uncomment both lines.

| Disabled form | actionlint result |
| --- | --- |
| `schedule:` with the `- cron:` line commented | `must be sequence node but got null` |
| `schedule: []` | `should not be empty` |
| Whole block commented, key included | Valid |

GitHub's own workflow validation also rejects an empty `schedule:` key.

## Why This Matters

An empty `schedule:` parses as `null`, so the workflow fails lint (and GitHub's own validation) before it can run at all. A fully commented block parses as if the trigger were absent.

## When to Apply

- Adding a schedule that should stay off until a first successful `workflow_dispatch`.
- Gating a cron behind a follow-up PR.

## Examples

Disabled, as shipped in PR #8 (`d2ba991`):

```yaml
  # Enable after the first successful dispatch. GitHub rejects an empty
  # `schedule:` key, so the whole block stays commented out until then.
  # schedule:
  #   - cron: '30 4 * * *'
  workflow_dispatch:
```

Enabled in PR #16 (`3f0c2cd`); the live trigger is at `.github/workflows/fro-bot.yaml:16-17`:

```yaml
  schedule:
    - cron: '30 4 * * *'
```

## Related

- [Scheduled fro-bot/agent runs need an on-disk git credential to push](../integration-issues/scheduled-fro-bot-agent-git-push-credential-2026-10-24.md)
- `.github/workflows/fro-bot.yaml`
