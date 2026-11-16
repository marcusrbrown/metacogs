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
last_updated: 2026-11-16
status: stale
stale_reason: "metacogs#107 dropped the Enable authenticated git push step. Under isolate-agent the action gives the agent a gh-backed git credential helper, and a credential persisted in .git/config is refused."
stale_date: 2026-11-16
---

# Scheduled fro-bot/agent runs need an on-disk git credential to push

> **Superseded by metacogs#107 (2026-11-15).** The workflow now sets `isolate-agent: 'true'` (`.github/workflows/fro-bot.yaml:326`) and keeps `persist-credentials: false` on checkout (`:299`). Under `isolate-agent`, the action sets `gh auth git-credential` as the git credential helper for the agent's sandbox user on schedule and `workflow_dispatch` runs, so `git push` authenticates from the `gh` token and nothing is written to `.git/config` ([fro-bot/agent setup docs](https://github.com/fro-bot/agent/blob/main/docs/wiki/Setup%20and%20Configuration.md)). The action also fails the run before setup if checkout persisted credentials. Do not add a step that writes a credential into the git config.

## Problem (historical)

In a scheduled or dispatched `fro-bot/agent` run before #107, `gh` was authenticated but `git push` had no credential, so the agent could open issues but not push a fix branch (run `40077949423`: `Git could not obtain HTTPS credentials`). Checkout used `persist-credentials: false`, and the action scrubbed `GH_TOKEN` and `GITHUB_TOKEN` from its child environment, so git had nothing to read.

PR #12 added a scheduled-only step that wrote an `http.https://github.com/.extraheader` entry into the repo-local git config (see `.github/workflows/fro-bot.yaml` at [`ad263c0^`](https://github.com/marcusrbrown/metacogs/blob/ad263c0%5E/.github/workflows/fro-bot.yaml)). #107 replaced it with the action's isolated credential helper.

## Related Issues

- PR #12 (the original step); metacogs#107 (replaced by `isolate-agent`); runs 40077949423 (failed push) and 40079837037 (first successful fix PR, #14)
- [actionlint rejects an empty or commented `schedule:`; comment the whole block](../developer-experience/actionlint-rejects-empty-schedule-comment-whole-block-2026-10-24.md)
