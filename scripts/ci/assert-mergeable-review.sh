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

meta=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,author,title) || {
  echo "FAIL: could not read required metadata for #$PR" >&2
  exit 2
}
identity=$(printf '%s' "$meta" | jq -er '
  if (.headRefOid | type) != "string" or (.headRefOid | length) == 0
    or (.author.login | type) != "string" or (.author.login | length) == 0
  then error("missing headRefOid or author.login")
  else [ .headRefOid, (.author.login | ascii_downcase) ] | @tsv
  end
') || {
  echo "FAIL: #$PR metadata is missing headRefOid or author.login" >&2
  exit 2
}
IFS=$'\t' read -r head author <<< "$identity"

# Maintainer roster comes from MAINTAINERS.md itself, not from a hardcoded list here, so
# the gate cannot drift from the policy document it enforces.
roster=$(gh api "repos/$REPO/contents/MAINTAINERS.md" --jq .content \
  | base64 -d \
  | sed -n '/^## Current maintainers/,/^## Former maintainers/p' \
  | grep -oE '\[@[A-Za-z0-9-]+\]' \
  | tr -d '@[]' \
  | jq -Rr 'ascii_downcase' \
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

# Validate gh's slurped array-of-page-arrays before flattening every review row. Review
# identity is case-insensitive. COMMENTED is neutral; DISMISSED invalidates an earlier
# approval; PENDING is not an approval and does not hide a prior submitted blocker.
latest=$(printf '%s' "$reviews" | jq -c '
  def allowed_states: ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"];
  if type != "array" then
    error("review payload is not a slurped page array")
  elif any(.[]; type != "array") then
    error("review payload contains a non-array page")
  else
    [ .[][] ]
    | if any(.[]; type != "object") then
        error("review payload contains a non-object row")
      else
        to_entries
        | map(
            .key as $order
            | .value as $review
            | if ($review.user.login | type) != "string" or ($review.user.login | length) == 0 then
                error("review row is missing user.login")
              elif ($review.state | type) != "string" then
                error("review row is missing state")
              else
                ($review.state | ascii_upcase) as $state
                | if (allowed_states | index($state)) == null then
                    error("review row has an unknown state")
                  else
                    {
                      login: ($review.user.login | ascii_downcase),
                      state: $state,
                      commit: $review.commit_id,
                      order: $order
                    }
                  end
              end
          )
        | group_by(.login)
        | map(
            sort_by(.order) as $rows
            | ($rows | map(select(.state != "COMMENTED")) | last) as $latest
            | ($rows | map(select(
                .state == "APPROVED"
                or .state == "CHANGES_REQUESTED"
                or .state == "DISMISSED"
              )) | last) as $submitted
            | select($latest != null)
            | {
                login: $rows[0].login,
                state: $latest.state,
                commit: $latest.commit,
                submitted_state: ($submitted.state // null)
              }
          )
      end
  end
') || {
  echo "FAIL: could not parse the review payload for #$PR" >&2
  exit 2
}

# A maintainer's live objection blocks regardless of anyone else's approval.
blockers=$(printf '%s' "$latest" | jq -r --argjson roster "$(printf '%s\n' "$roster" | jq -R . | jq -s .)" '
  .[]
  | select(
      .state == "CHANGES_REQUESTED"
      or (.state == "PENDING" and .submitted_state == "CHANGES_REQUESTED")
    )
  | select(.login as $l | $roster | index($l))
  | .login
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

# The review work above may race a contributor push. Re-read the head immediately before
# success so this verdict and the printed --match-head-commit instruction name one SHA.
final_meta=$(gh pr view "$PR" --repo "$REPO" --json headRefOid) || {
  echo "FAIL: could not re-read head SHA for #$PR" >&2
  exit 2
}
final_head=$(printf '%s' "$final_meta" | jq -er '
  .headRefOid | select(type == "string" and length > 0)
') || {
  echo "FAIL: could not resolve final head SHA for #$PR" >&2
  exit 2
}
if [ "$final_head" != "$head" ]; then
  echo "FAIL: #$PR head changed during review validation ($head -> $final_head)" >&2
  exit 1
fi

echo "OK: #$PR approved at head $head by maintainer $qualified (author $author)"
echo "Merge with: gh pr merge $PR --repo $REPO --match-head-commit $head"
