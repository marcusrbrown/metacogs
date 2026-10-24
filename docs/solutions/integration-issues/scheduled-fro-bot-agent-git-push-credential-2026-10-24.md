---
title: "Scheduled fro-bot/agent runs need an on-disk git credential to push"
date: 2026-10-24
category: integration-issues
module: ci
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "Scheduled/dispatched agent run created an issue with gh but `git push -u origin HEAD` failed"
  - "Git could not obtain HTTPS credentials"
root_cause: config_error
resolution_type: config_change
tags: [fro-bot, github-actions, git-credentials, persist-credentials, schedule]
related_components: [development_workflow]
---

# Scheduled fro-bot/agent runs need an on-disk git credential to push

## Problem

In a scheduled or dispatched `fro-bot/agent` run, `gh` is authenticated but `git push` has no credential. The agent can create issues and comments, but it cannot push a branch for its fix PR.

## Symptoms

- First autoheal dispatch (run `40077949423`): the issue was created through `gh` (the PAT was valid).
- `git push -u origin HEAD` then failed with `Git could not obtain HTTPS credentials`.

## What Didn't Work

- **Trusting the checkout token.** `.github/workflows/fro-bot.yaml:282-283` passes `token: ${{ secrets.FRO_BOT_PAT }}` with `persist-credentials: false`. That deliberately leaves no credential in `.git/config`.
- **Relying on `GH_TOKEN` for git.** `fro-bot/agent@v0.125.3` scrubs `GH_TOKEN` and `GITHUB_TOKEN` from its child environment (`.github/workflows/fro-bot.yaml:285-286`). `gh` authenticates through its own mechanism, but git has no credential helper to read the token.

## Solution

Add a step after checkout that writes the credential into the repo-local git config, only for scheduled and dispatched runs. In `.github/workflows/fro-bot.yaml`, the `Enable authenticated git push` step (`:289-297`) does this:

```yaml
- name: Enable authenticated git push
  if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
  env:
    FRO_BOT_PAT: ${{ secrets.FRO_BOT_PAT }}
  run: |
    set -euo pipefail
    auth="$(printf '%s' "x-access-token:${FRO_BOT_PAT}" | base64 | tr -d '\n')"
    echo "::add-mask::${auth}"
    git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${auth}"
```

- The `if:` gate is on line 290; the `git config --local` call is on line 297.
- `::add-mask::` hides the encoded value in logs.
- The checkout action's post step removes the `extraheader` entry from the local config when the job ends.

The pattern comes from the `Enable authenticated git push` step in [`marcusrbrown/infra` `.github/workflows/fro-bot.yaml`](https://github.com/marcusrbrown/infra/blob/62aebe77f316ef48fa44704b02fcdd1a0123afd6/.github/workflows/fro-bot.yaml#L1018-L1025).

## Why This Works

Git reads `http.<url>.extraheader` from the local config and sends it as the HTTP `Authorization` header, so no credential helper is needed. The agent's own env scrubbing cannot remove it, because it lives on disk rather than in the environment.

## Prevention

- **Gate the step to `schedule` and `workflow_dispatch` only.** Never add it to PR or mention (comment) runs. For those events the agent runs a fail-closed check for an on-disk credential and aborts if it finds one.
- Keep `persist-credentials: false` on checkout, and keep the credential step after it.
- The agent's brokered push is separate: in PR runs it pushes through its own mechanism, limited by `brokered-push-extra-paths` (`.github/workflows/fro-bot.yaml:327-329`).

## Related Issues

- PR #12 (the fix); runs 40077949423 (failed push) and 40079837037 (first successful fix PR, #14)
- `.github/workflows/fro-bot.yaml`
- [actionlint rejects an empty or commented `schedule:`; comment the whole block](../developer-experience/actionlint-rejects-empty-schedule-comment-whole-block-2026-10-24.md)
