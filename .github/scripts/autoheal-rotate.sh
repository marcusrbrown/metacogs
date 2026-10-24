#!/usr/bin/env bash
# Keeps exactly one open "Fro Bot Autoheal — <date>" issue authored by fro-bot.
# Valid findings: create or update today's issue, then close the older ones.
# Invalid findings: comment on the newest open autoheal issue and leave it open.
set -Eeuo pipefail

: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${AUTOHEAL_DATE:?}" "${AUTOHEAL_FINDINGS:?}" "${RUNNER_TEMP:?}"

repo="$GITHUB_REPOSITORY"
findings="$AUTOHEAL_FINDINGS"
prefix='Fro Bot Autoheal — '
title="${prefix}${AUTOHEAL_DATE}"
marker="<!-- autoheal:${AUTOHEAL_DATE} -->"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${GITHUB_RUN_ID:-0}"

# Autoheal issues authored by fro-bot in the given state, as a JSON array.
autoheal_issues() {
  gh issue list --repo "$repo" --author fro-bot --state "$1" --limit 1000 \
    --json number,title,state |
    jq -c --arg p "$prefix" '[.[] | select(.title | startswith($p))]'
}

first_line=''
if [ -s "$findings" ]; then
  first_line=$(head -n 1 "$findings" | tr -d '\r' | sed -E 's/[[:space:]]+$//')
fi

if [ "$first_line" != "$marker" ]; then
  note="Autoheal run ${run_url} finished without valid findings: the findings file was missing, empty, or did not start with \`${marker}\`. The previous report stays open."
  # Closures recorded by the path audit still matter when the agent failed.
  if [ -f "$findings" ]; then
    audit=$(grep -E '^- \*\*Audit:\*\* ' "$findings" || true)
    [ -z "$audit" ] || note="${note}"$'\n\n'"${audit}"
  fi

  newest=$(autoheal_issues open | jq -r 'sort_by(.number) | .[-1].number // empty')
  if [ -n "$newest" ]; then
    gh issue comment "$newest" --repo "$repo" --body "$note"
    echo "Findings invalid; commented on #${newest}."
  else
    url=$(gh issue create --repo "$repo" --title "$title" --body "${marker}"$'\n\n'"${note}")
    echo "Findings invalid; no open autoheal issue, created ${url}."
  fi
  exit 0
fi

# Valid findings: build the body. GitHub caps a body at 65536 characters.
body="${RUNNER_TEMP}/autoheal-issue-body.md"
{
  head -c 60000 "$findings"
  printf '\n\n---\n'
  pr_url=$(gh pr list --repo "$repo" --state open --head autoheal/current --author fro-bot \
    --json url --jq '.[0].url // empty')
  [ -z "$pr_url" ] || printf 'Autoheal pull request: %s\n' "$pr_url"
  printf 'Run: %s\n' "$run_url"
} > "$body"

# Today's issue may already exist (a second run the same day), even if closed.
today=$(autoheal_issues all | jq -c --arg t "$title" '[.[] | select(.title == $t)] | sort_by(.number) | .[0] // empty')
if [ -n "$today" ]; then
  number=$(jq -r '.number' <<< "$today")
  gh issue edit "$number" --repo "$repo" --body-file "$body"
  # Exactly one open issue is the invariant, so a closed one comes back.
  [ "$(jq -r '.state' <<< "$today")" != "CLOSED" ] || gh issue reopen "$number" --repo "$repo"
  echo "Updated #${number}."
else
  url=$(gh issue create --repo "$repo" --title "$title" --body-file "$body")
  number="${url##*/}"
  echo "Created #${number}."
fi

for other in $(autoheal_issues open | jq -r --argjson n "$number" '.[] | select(.number != $n) | .number'); do
  gh issue close "$other" --repo "$repo" --reason 'not planned' --comment "Superseded by #${number}."
  echo "Closed #${other}."
done
