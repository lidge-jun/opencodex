#!/usr/bin/env bash
# Fail-closed pre-merge review gate for the bug-PR campaign.
#
# MAINTAINERS.md requires a maintainer approval, forbids self-approval, and requires
# explicit security review on security-boundary changes. GitHub cannot express the last
# part, and `dismiss_stale_reviews_on_push` is false on this repository, so an approval
# granted to an older head survives a force-push that invalidates it. An admin merge can
# bypass the approval requirement entirely.
#
# This script is the executable form of that policy. It prints nothing reassuring and
# exits nonzero unless a review exists that is simultaneously:
#   - the reviewer's LATEST review, not merely some historical one
#   - state APPROVED
#   - bound to the EXACT current head SHA (commit_id == headRefOid)
#   - authored by someone other than the PR author
#   - authored by an account listed as a current maintainer in MAINTAINERS.md
# and additionally:
#   - no maintainer's latest review is CHANGES_REQUESTED
#   - GitHub's own reviewDecision is APPROVED
#
# The latest-state requirement is not theoretical. A reviewer can approve a commit and then
# post CHANGES_REQUESTED on the SAME commit after finding something on a second read. A gate
# that scans for any historical APPROVED row would report that PR as approved, which is worse
# than no gate: it launders a live objection into a green light. Likewise, one maintainer's
# approval must not mask another maintainer's outstanding blocker.
#
# Every API call fails the script. An earlier revision ended the review query with `|| true`,
# which meant a mid-pagination failure kept the pages already fetched and could pass on a
# partial view of the review history. A gate that treats a failed lookup as an empty result
# is not fail-closed.
#
# Usage: scripts/ci/assert-mergeable-review.sh <pr-number> [repo]
set -euo pipefail

PR="${1:?usage: assert-mergeable-review.sh <pr-number> [repo]}"
REPO="${2:-lidge-jun/opencodex}"

meta=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,author,title)
head=$(printf '%s' "$meta" | jq -r '.headRefOid')
author=$(printf '%s' "$meta" | jq -r '.author.login')

if [ -z "$head" ] || [ "$head" = "null" ]; then
  echo "FAIL: could not resolve head SHA for #$PR" >&2
  exit 2
fi

# Maintainer roster comes from MAINTAINERS.md itself, not from a hardcoded list here, so
# the gate cannot drift from the policy document it enforces.
roster=$(gh api "repos/$REPO/contents/MAINTAINERS.md" --jq .content \
  | base64 -d \
  | sed -n '/^## Current maintainers/,/^## Former maintainers/p' \
  | grep -oE '\[@[A-Za-z0-9-]+\]' \
  | tr -d '[@]' \
  | sort -u)

if [ -z "$roster" ]; then
  echo "FAIL: could not parse the maintainer roster from MAINTAINERS.md" >&2
  exit 2
fi

# No `|| true`: a failed or partial review fetch must abort, not degrade to "no approvals".
reviews=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate --slurp) || {
  echo "FAIL: could not read reviews for #$PR (API or pagination failure)" >&2
  exit 2
}

# Collapse to each reviewer's LATEST substantive review. COMMENTED rows are ignored because
# they neither approve nor block; APPROVED and CHANGES_REQUESTED are the states that decide.
latest=$(printf '%s' "$reviews" | jq -c '
  [ .[] | add? // . ] | flatten
  | map(select(type == "object" and (.state // "") != ""))
  | map(select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED"))
  | sort_by(.submitted_at // "", .id)
  | group_by(.user.login)
  | map(last)
  | map({login: .user.login, state: .state, commit: .commit_id})
') || {
  echo "FAIL: could not parse the review payload for #$PR" >&2
  exit 2
}

# A maintainer's live objection blocks regardless of anyone else's approval.
blockers=$(printf '%s' "$latest" | jq -r --argjson roster "$(printf '%s\n' "$roster" | jq -R . | jq -s .)" '
  .[] | select(.state == "CHANGES_REQUESTED") | select(.login as $l | $roster | index($l)) | .login
')
if [ -n "$blockers" ]; then
  echo "FAIL: #$PR has an outstanding maintainer CHANGES_REQUESTED from: $(printf '%s' "$blockers" | tr '\n' ' ')" >&2
  exit 1
fi

decision=$(gh pr view "$PR" --repo "$REPO" --json reviewDecision --jq '.reviewDecision // ""') || {
  echo "FAIL: could not read reviewDecision for #$PR" >&2
  exit 2
}
if [ "$decision" != "APPROVED" ]; then
  echo "FAIL: #$PR reviewDecision is '${decision:-none}', not APPROVED" >&2
  exit 1
fi

qualified=$(printf '%s' "$latest" | jq -r --arg head "$head" --arg author "$author" --argjson roster "$(printf '%s\n' "$roster" | jq -R . | jq -s .)" '
  .[]
  | select(.state == "APPROVED")
  | select(.commit == $head)
  | select(.login != $author)
  | select(.login as $l | $roster | index($l))
  | .login
' | head -1)

if [ -z "$qualified" ]; then
  echo "FAIL: #$PR has no maintainer approval bound to head $head" >&2
  echo "  author:            $author" >&2
  echo "  approvals at head: ${approvals:-(none)}" >&2
  echo "  maintainer roster: $(printf '%s' "$roster" | tr '\n' ' ')" >&2
  exit 1
fi

echo "OK: #$PR approved at head $head by maintainer $qualified (author $author)"
echo "Merge with: gh pr merge $PR --repo $REPO --match-head-commit $head"
