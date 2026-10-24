---
date: 2026-10-23
topic: repo-ops
---

# Repository operations for metacogs

## Summary

Bring metacogs onto the fleet's repository conventions: settings-as-code with a squash-only `main` ruleset, Renovate from the owner preset with helper regeneration, Changesets releases that produce a tag and a GitHub Release only, and a Fro Bot that reviews pull requests with a blocking verdict and runs a daily autoheal that may fix code and docs but never the eval evidence or the shipped skill text.

---

## Problem Frame

metacogs shipped v0.1.0 with a single CI workflow and nothing else. Live repository state: `main` is unprotected, all three merge methods are enabled, actions are referenced by floating tags, and there is no dependency automation, no release tooling, and no automated review. Every sibling repository (dev-like, systematic, opencode-copilot-delegate, infra, space-bus) carries the same five pieces: a settings file synced by a shared workflow, Renovate from a shared preset, a release workflow, a Fro Bot workflow, and SHA-pinned actions.

Two properties of metacogs make a straight copy wrong. Dependency bumps that touch the record helper must regenerate the bundled `skills/*/scripts/record.mjs` or the drift check fails. Automated edits to skill text, eval fixtures, rubrics, preregistrations or reports are not fixes: a skill-text edit after a held-out read requires a new epoch, and a prereg or rubric edit changes a content hash the runner enforces.

Until this lands, every dependency update, settings change and release is manual, and PRs get no second reader.

---

## Actors

- A1. Owner: merges every PR by hand, cuts releases by merging the version PR, provisions secrets, owns eval epochs.
- A2. Fro Bot: reviews PRs under the `@fro-bot` identity with a verdict that gates merge; runs the daily autoheal; opens fix PRs and the daily issue.
- A3. Renovate (self-hosted through the shared workflow): opens dependency PRs; runs post-upgrade regeneration; receives an automatic changeset.
- A4. Settings sync (shared workflow): applies `.github/settings.yml`, including rulesets, to the repository; removes rulesets the file does not declare.
- A5. Changesets: maintains the version PR; on merge, the repo's release script tags and publishes the GitHub Release.

---

## Requirements

**Settings as code**
- R1. Repository settings live in `.github/settings.yml`, extend the owner common settings, and are applied by the shared settings workflow on change and on a daily schedule. The settings file is the only source of rulesets.
- R2. A `main` ruleset enforces squash-only merges, linear history, no force-push or deletion, zero required approvals, and required status checks `check`, `Fro Bot` and `Renovate / Renovate`.
- R3. A tag ruleset declared in the same file protects `v*` tags from update and deletion.
- R4. Merge methods other than squash are disabled at the repository level.

**Dependency updates**
- R5. Renovate runs through the shared workflow, configured from the owner preset at a pinned version, with semantic commit types.
- R6. The repo's Renovate config runs `bun run generate` after every upgrade so a dependency PR never fails the drift check. Regenerating `skills/*/scripts/record.mjs` is a generated-file refresh, not a skill edit; it does not open an epoch.
- R7. Renovate ignores `evals/**`.
- R8. Actions in every workflow are pinned to a full commit SHA with a version comment; the first pinning PR is manual, Renovate maintains the pins after that.

**Releases**
- R9. Releases use Changesets with `privatePackages: {version: true, tag: true}` and a repo release script, modeled on bfra-me/.github, that tags `v<version>` and creates the GitHub Release from the changelog entry. Nothing is published to a registry.
- R10. `package.json` starts at `0.1.0` so the next version PR produces `v0.1.1` or `v0.2.0`; the existing `v0.1.0` tag gets its GitHub Release by hand once.
- R11. Renovate PRs receive a patch changeset from the shared renovate-changesets action with `target-package: metacogs`. Fro Bot fix PRs include a changeset written by the agent. No check requires a changeset to merge.
- R12. The owner merges the version PR by hand; nothing auto-merges.

**Fro Bot review**
- R13. Fro Bot reviews every non-draft PR authored by a collaborator with write access and posts one consolidated review with a `PASS | CONDITIONAL | REJECT` verdict. PRs from bots or forks get a skipped `Fro Bot` check.
- R14. The `Fro Bot` check passes only on `PASS`. `CONDITIONAL` and `REJECT` request changes and fail the check; a review with no verdict fails the check. A new push re-runs the review.

**Fro Bot autoheal**
- R15. A daily autoheal run inspects the repository and opens at most one fix PR per run.
- R16. Autoheal may edit `src/**`, `docs/**`, `README.md`, `HYPOTHESES.md`, `AGENTS.md` and `matrix.json`. It must never edit `evals/**`, `skills/**`, `.agents/skills/**` or `.github/**`. Workflow findings go to the daily issue only.
- R17. The agent writes its findings to a file; a post-step that runs even when the agent fails closes the previous autoheal issue and opens today's. A run that fails before writing findings leaves the previous issue open. At most one autoheal issue is open at any time.
- R18. When autoheal finds nothing, it still rotates the issue with an empty-findings body.

**Repository hygiene**
- R19. CI stays a single required job named `check` with its current five commands; the workflow name is stable because Renovate keys on it.
- R20. `SECURITY.md` and a PR template are added. `CODEOWNERS` is omitted: no sibling has one and zero required approvals makes it inert.

---

## Acceptance Examples

- AE1. **Covers R2, R4.** Given a PR with green checks, when the owner opens the merge menu, only squash is offered, and merging with a failing `Fro Bot` check is blocked.
- AE2. **Covers R6.** Given a Renovate PR that bumps a dependency used by the record helper, when CI runs, `generate:check` passes because `bun run generate` ran in the same PR and the regenerated `skills/*/scripts/record.mjs` is part of the diff.
- AE3. **Covers R9, R12.** Given two merged PRs with changesets, when the owner merges the version PR, a `v0.1.x` tag and a GitHub Release whose body is the changelog entry exist, and nothing was published to npm.
- AE4. **Covers R11.** Given a Renovate PR, when the renovate-changesets action runs, a patch changeset for `metacogs` is committed to the PR without an owner action.
- AE5. **Covers R13, R14.** Given an owner-authored PR marked ready, when Fro Bot posts `CONDITIONAL`, the review requests changes and the `Fro Bot` check fails; after the owner pushes a fix and Fro Bot posts `PASS`, the check passes.
- AE6. **Covers R13.** Given a Renovate PR, when checks run, the `Fro Bot` check reports skipped and does not block the merge.
- AE7. **Covers R16.** Given an autoheal run that identifies a stale sentence in `evals/reports/README.md`, when it prepares a fix PR, that file is excluded and the finding appears in the daily issue instead.
- AE8. **Covers R17, R18.** Given yesterday's autoheal issue is open, when today's run completes with no findings, yesterday's issue is closed and today's is open with an empty-findings body; when today's run fails before writing findings, yesterday's issue stays open.

---

## Success Criteria

- `main` cannot receive a non-squash merge, a force-push, or a merge with a failing required check.
- A dependency bump lands with no manual step beyond the owner's merge.
- A release is one merge of the version PR; the tag and GitHub Release appear without a manual command.
- Every owner-authored PR has a Fro Bot verdict before the owner merges it, and a non-`PASS` verdict blocks until re-reviewed.
- At any moment at most one autoheal issue is open.
- No automated PR edits `evals/**`, skill text under `skills/**`, or `.agents/skills/**`; the only automated change under `skills/**` is the regenerated helper.

---

## Scope Boundaries

- The v0.2 scoring redesign and any new eval epoch.
- Publishing to npm or any registry, provenance attestation, scheduled release gating.
- Back-porting the rotating-issue behavior and the verdict-gated check to dev-like and systematic (noted for the fleet; not this repo).
- CodeQL, Scorecard, FOSSA, dependency-review and other scans beyond the existing secret scan.
- Copilot setup files, issue templates and `CONTRIBUTING.md`, which some siblings carry.
- Fro Bot editing eval evidence, skill text, custody or workflows; any automated eval run in CI.

---

## Key Decisions

- Squash-only ruleset with zero approvals and a verdict-gated `Fro Bot` check: the bot blocks through its status, the owner keeps merge authority, and a `CONDITIONAL` is a real request for changes rather than a comment.
- Changesets with `privatePackages` and a repo release script, not semantic-release: matches dev-like, infra and copilot-delegate for the version PR flow, and bfra-me/.github for releasing a private root package.
- Owner preset pinned, not `local>`: one more Renovate stream in exchange for no surprise preset changes.
- Autoheal has fix-PR power with a path allowlist instead of report-only: the fleet's autoheal fixes are valuable here; the brokered-push allowlist, not the prompt, is the enforcement point.
- Rotating daily issue instead of one rolling issue: an open issue should mean "today's findings", not an accumulating log.

---

## Dependencies / Assumptions

- Secrets and variables the owner provisions before any workflow can run: `FRO_BOT_PAT` (done), `OPENCODE_AUTH_JSON`, `OPENCODE_CONFIG`, `APPLICATION_ID` / `APPLICATION_PRIVATE_KEY` (or the `APPLICATION_CLIENT_ID` variable), and the `FRO_BOT_MODEL` variable.
- `@fro-bot` is a collaborator (done; the invitation auto-accepts).
- The Renovate runner has `bun` on its PATH; unverified until the first dependency PR.
- Shared workflow versions at adoption: `bfra-me/.github` v4.43.0, `fro-bot/agent` v0.125.3, `marcusrbrown/renovate-config` latest tag.

---

## Sources / Research

- Fleet recon: dev-like, systematic, infra, opencode-copilot-delegate, space-bus, fro-bot/agent, fro-bot/.github, bfra-me/.github (workflows, settings, Renovate configs).
- bfra-me/.github `scripts/release.ts` and `.changeset/config.json`: the private-root-package release pattern R9 follows.
- bfra-me/.github `update-repository-settings` action: rulesets are created from the `rulesets:` key with `target` passed through, and undeclared rulesets are deleted.
- fro-bot/agent action: brokered pushes deny `.github/`; outputs carry no findings channel, so the daily issue needs a findings file plus a post-step.
