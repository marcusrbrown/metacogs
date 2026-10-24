---
title: "Changesets release script: run before changesets/action and target the commit that introduced the version"
date: 2026-10-24
category: best-practices
module: release
problem_type: best_practice
component: development_workflow
severity: high
tags: [changesets, release, github-actions, gh-cli, git-tags, idempotency]
related_components: [tooling]
applies_when:
  - "Creating GitHub Releases or tags from a Changesets CHANGELOG without an npm publish step"
  - "Adding a release step to a workflow that also runs changesets/action"
---

# Changesets release script: run before changesets/action and target the commit that introduced the version

## Context

A private package (no npm publish) is released by creating a GitHub Release `v<version>` from the Changesets-generated `CHANGELOG.md`, using `gh release create`, which also creates the tag. The release step lives in the same workflow as `changesets/action` (`.github/workflows/release.yaml`). Two ordering and targeting mistakes tag the wrong commit with the right-looking notes.

## Guidance

**1. Run the release step before `changesets/action`, on `main` only.**

`.github/workflows/release.yaml:55-60` runs `bun run release` first, gated by `if: github.ref == 'refs/heads/main'` (`:56`). `changesets/action` follows at `:62-72`. At the pinned ref (v2.1.2), the action's `runVersion` calls `prepareBranch` ([`src/run.ts:363`](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/run.ts#L363)). That switches to `changeset-release/<branch>` and resets to `context.sha` ([`src/github.ts:239-242`](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/github.ts#L239-L242)). The version script then runs in place. A release step placed afterwards reads a bumped `package.json` and `CHANGELOG.md` while `HEAD` is still the pre-bump SHA. A push that carries a pending changeset would then create `v<next>` on the wrong commit (found in review of PR #4, fixed in `3ede53e`).

The action's publish path (`src/index.ts`, [`case !hasChangesets && hasPublishScript`](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/index.ts#L74)) runs only when no changesets are pending. The workflow sets no `publish-script` and `create-github-releases: false` (`.github/workflows/release.yaml:68`), so the release step must be independent of the action.

**2. Target the commit that introduced the version, not `HEAD`.**

If a release run fails and a later push lands first, `--target HEAD` tags a feature commit with an older version's notes (found in a later review, fixed in `73b7fec`). `introducingCommit` in `src/release/release.ts:87-93` resolves the target:

```sh
git log --first-parent --format=%H -S'"version": "<v>"' -- package.json | tail -1
```

This takes the oldest first-parent commit whose diff adds or removes that exact `"version": "<v>"` line. If none is found, `runRelease` falls back to `HEAD` and logs a notice (`src/release/release.ts:38-42`).

**3. Keep the decision logic idempotent.** `runRelease` (`src/release/release.ts:26-50`) does the following:

- Release `v<version>` exists: no-op (`:29-32`).
- The changelog has a `## <version>` section, found by `extractChangelogSection` (`src/release/changelog.ts:13-21`): `gh release create v<v> --target <sha> --notes-file …` (`ghCreateRelease`, `src/release/release.ts:65-77`). This creates the tag.
- Otherwise: no-op with a notice (`:33-37`).

## Why This Matters

The tag is the release identity. A tag on a mid-version commit, or notes attached to the wrong commit, is hard to repair. `.github/settings.yml:44-54` makes `v*` tags immutable (no update, no delete), so a wrong tag cannot be moved afterwards. The only fix is a new version.

## When to Apply

- Any workflow that runs `changesets/action` and also needs a release or tag created from the CHANGELOG.
- Any release step that must stay correct when a release run fails and a later push lands first.

## Examples

Step order in `.github/workflows/release.yaml`:

```yaml
- name: Create GitHub Release for the current version
  if: github.ref == 'refs/heads/main'
  run: bun run release        # reads package.json at the checked-out SHA
- id: changesets
  uses: changesets/action@…   # v2.1.2; mutates the tree in place
```

First real exercise: version PR #17 merged and the workflow produced `v0.1.1` (tag and Release) with no manual step.

## Related

- PR #4 (implementation), PR #17 (first version PR)
- `.github/workflows/release.yaml`, `src/release/release.ts`, `src/release/changelog.ts`, `.github/settings.yml`
- `README.md` § Releases and automation; `docs/plans/2026-10-23-001-feat-repo-ops-plan.md` (Unit 3)
- marcusrbrown/dev-like `docs/solutions/best-practices/bun-changesets-oidc-release-pipeline-2026-07-11.md` (the publishing variant)
