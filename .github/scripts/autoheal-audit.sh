#!/usr/bin/env bash
# Post-run path audit for the daily autoheal agent.
# Closes any open fro-bot PR from this run that touches a path outside the
# allowlist below, and records each closure in the findings file. Never fails
# the job.
set -Eeuo pipefail
trap 'echo "::warning::autoheal audit stopped early (line ${LINENO}); continuing."; exit 0' ERR

# A missing input means the run died before the agent started: nothing to audit.
if [ -z "${GH_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${AUTOHEAL_FINDINGS:-}" ] || [ -z "${RUN_STARTED_AT:-}" ]; then
  echo "::notice::autoheal audit skipped: run identity was not frozen."
  exit 0
fi

findings="$AUTOHEAL_FINDINGS"

# Allowlist: a path outside it is rejected. Findings-only source directories
# take precedence over the broad src/ allowance.
findings_only_dirs=(src/runner/ src/record/ src/generate/)

is_allowed() {
  local path="$1" dir
  # Reject path tricks before any prefix match.
  case "$path" in /* | *..*) return 1 ;; esac
  for dir in "${findings_only_dirs[@]}"; do
    [[ "$path" == "$dir"* ]] && return 1
  done
  case "$path" in
    src/* | docs/*) return 0 ;;
    README.md | HYPOTHESES.md | matrix.json) return 0 ;;
    .changeset/*/*) return 1 ;;
    .changeset/*.md) return 0 ;;
  esac
  return 1
}

# "Created since run start": createdAt is UTC ISO-8601 with a trailing Z, as is
# RUN_STARTED_AT, so a string comparison orders them. The reused autoheal/current
# PR predates the run but receives its pushes, so it is always audited.
prs=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --author fro-bot --limit 100 \
  --json number,createdAt,headRefName |
  jq -r --arg since "$RUN_STARTED_AT" \
    '.[] | select(.createdAt >= $since or .headRefName == "autoheal/current") | .number')

for pr in $prs; do
  # The REST file list includes previous_filename, so a rename out of a protected
  # path is still caught.
  paths=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${pr}/files?per_page=100" \
    --jq '.[] | .filename, (.previous_filename // empty)' | sort -u)

  offending=()
  while IFS= read -r path; do
    [ -z "$path" ] || is_allowed "$path" || offending+=("$path")
  done <<< "$paths"

  [ "${#offending[@]}" -gt 0 ] || { echo "PR #${pr}: clean."; continue; }

  list=$(printf '`%s`, ' "${offending[@]:0:10}")
  list="${list%, }"
  gh pr close "$pr" --repo "$GITHUB_REPOSITORY" --delete-branch \
    --comment "Closed by the autoheal path audit: this PR changes paths outside the autoheal allowlist (${list}). Make the change in a human-authored PR."
  echo "::warning::Closed PR #${pr}: touches ${list}."

  if [ -f "$findings" ] && ! grep -q '^## Audit$' "$findings"; then
    printf '\n## Audit\n' >> "$findings"
  fi
  printf -- '- **Audit:** closed #%s because it changed paths outside the allowlist: %s\n' "$pr" "$list" >> "$findings"
done
