# Tracking refresh

Run this to regenerate the lane rows of `060_ledger.md`. Every field it prints comes from a command,
so the ledger cannot drift into narration the way it did before audit round 2 caught a stale head.

```bash
set -uo pipefail
REPO=lidge-jun/opencodex
for b in codex/260911-l1-responses-core codex/260911-l2-catalog-provider codex/260911-l3-account-pool codex/260911-l4-service-cli codex/260911-l5-integrations-io codex/260911-l6-streaming-tools codex/260911-l7-docs; do
  head=$(git ls-remote origin "refs/heads/$b" | cut -f1)
  if [ -z "$head" ]; then echo "$b MISSING"; continue; fi
  pr=$(gh pr list -R "$REPO" --head "$b" --state open --json number,headRefOid,reviewDecision,mergeStateStatus)
  prtxt=$(printf '%s' "$pr" | jq -r 'if length==0 then "pr=none" else "pr=#\(.[0].number) prhead=\(.[0].headRefOid[0:9]) review=\(.[0].reviewDecision // "-") mergeState=\(.[0].mergeStateStatus // "-")" end')
  runs=$(gh run list -R "$REPO" --commit "$head" --json workflowName,conclusion,status,databaseId,event)
  ci=$(printf '%s' "$runs" | jq -r '[.[] | select(.event=="pull_request" or .event=="push")] | group_by(.workflowName) | map(max_by(.databaseId)) | if length==0 then "ci=no-run" else (map(select(.conclusion != "success")) | if length>0 then "ci=NOT-GREEN[" + (map(.workflowName + "=" + (if (.conclusion // "") == "" then .status else .conclusion end)) | join(";")) + "]" else "ci=green[" + ((. | length | tostring)) + " workflows]" end) end')
  echo "$b head=${head:0:9} $prtxt $ci"
done
```

## Reading rules

- `pr=none` means `gh pr list --head` returned `[]`. Use `list`, never `view`: `gh pr view <branch>`
  exits 1 when no pull request exists and would abort the loop.
- `ci=no-run` means no `pull_request` or `push` run exists for that exact head. It is **not** green.
  Every lane reads that way right now, before any thread pushes.
- The verdict reduces to the newest run per `workflowName` by `databaseId`, and requires *every* one
  of them to be `success`. It is not an allowlist: a red workflow nobody thought to name still fails
  the lane.
- Only `pull_request` and `push` events count, so a later `workflow_dispatch` success cannot outrank a
  failed run of the same workflow.
- `mergeState=UNKNOWN` is common and is not a mergeability verdict; it appeared on #4210, #4203, and
  on #4220 after it merged.
- Which checks are skipped inside a green workflow is a check-run fact, readable only from
  `gh pr checks <pr>`. #4220 showed `Cross-platform CI` and `React Doctor` as workflow-level `success`
  with the product jobs skipped inside, which is correct for a documentation-only pull request and
  must be recorded as such rather than as green product CI.

## Snapshot — 2026-09-10T16:47Z

```text
codex/260911-l1-responses-core head=29c342da7 pr=none ci=no-run
codex/260911-l2-catalog-provider head=b28f06ee0 pr=none ci=no-run
codex/260911-l3-account-pool head=6fd401636 pr=none ci=no-run
codex/260911-l4-service-cli head=f48cede91 pr=none ci=no-run
codex/260911-l5-integrations-io head=a7a92089c pr=none ci=no-run
codex/260911-l6-streaming-tools head=3760f81fd pr=none ci=no-run
codex/260911-l7-docs head=cd5dcd6a2 pr=none ci=no-run
```

Exit 0. Any lane pull request opened after that time supersedes this snapshot; re-run the block
rather than trusting it.

