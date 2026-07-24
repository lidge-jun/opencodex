# 010_rebase_onto_origin_dev

## Objective

Rebase `dev2-go` onto latest `origin/dev` and prove the rebased tip.

## Scope

### MODIFY (process only)

- git history of `dev2-go`

### MODIFY (only if unexpected conflict)

- `.github/workflows/go-ci.yml`, governance docs — none expected (overlap=0)

### OUT

- residual Go feature ports (020+)

## Before

- HEAD `222b4371`, origin/dev `b7585565`, MB `6a670bce`, counts 131/31, overlap 0

## After

- `origin/dev` is ancestor of HEAD
- unique Go commits replayed
- local Go gates green
- remote updated via force-with-lease on exact old remote tip
- hosted Go CI green for **post-rebase** SHA

## Copy-executable procedure

```bash
set -euo pipefail
cd /Users/jun/.codex/worktrees/e479/opencodex

# Revalidate the audited inputs. Any mismatch returns the phase to P/A.
EXPECTED_DEV=cc7bb577184a94784adab43e39a366b8ce65a7b6
EXPECTED_REMOTE_TIP=105cab4f3dda939fa00fa080605eb7b3ee9378a7
git fetch --all --prune
test "$(git rev-parse origin/dev)" = "$EXPECTED_DEV"
REMOTE_TIP=$(git rev-parse origin/dev2-go)
test "$REMOTE_TIP" = "$EXPECTED_REMOTE_TIP"
LIVE_REMOTE_TIP=$(git ls-remote --heads origin refs/heads/dev2-go | awk '{print $1}')
test "$LIVE_REMOTE_TIP" = "$REMOTE_TIP"

# Round-1 plan amendments are committed before the round-2 A-gate.
test -z "$(git status --porcelain)"

PRE=$(git rev-parse HEAD)
BASE=$(git merge-base "$PRE" origin/dev)
git rebase origin/dev
# expected: no conflicts
test -z "$(git diff --name-only --diff-filter=U)"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor origin/dev HEAD
git range-diff "$BASE..$PRE" "origin/dev..HEAD"

cd go
go build ./...
go vet ./...
go test ./... -count=1 -timeout 120s
go test -race ./... -count=1 -timeout 180s
go test ./test/e2e/... -count=1 -timeout 60s
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
GOOS=darwin GOARCH=arm64 go build ./...
GOOS=darwin GOARCH=amd64 go build ./...
GOOS=linux GOARCH=arm64 go build ./...
cd ..

# Record the rebase/range-diff/local-gate outputs in this unit, then commit the
# tracked local evidence. Goalplan runtime evidence is updated out-of-band after
# hosted CI. NEW is captured only after this local evidence checkpoint.
git add devlog/_plan/260724_dev2_go_rebase_continue/010_rebase_onto_origin_dev.md
git diff --cached --check
git commit -m "docs(devlog): record dev2-go rebase proof"
test -z "$(git status --porcelain)"
NEW=$(git rev-parse HEAD)

# Last-moment lease proof, then rewrite dev2-go only.
LIVE_REMOTE_TIP=$(git ls-remote --heads origin refs/heads/dev2-go | awk '{print $1}')
test "$LIVE_REMOTE_TIP" = "$REMOTE_TIP"
git push --force-with-lease=refs/heads/dev2-go:$REMOTE_TIP origin HEAD:dev2-go
REMOTE_AFTER=$(git ls-remote --heads origin refs/heads/dev2-go | awk '{print $1}')
test "$REMOTE_AFTER" = "$NEW"

# The rewritten tree may not satisfy the Go path filter, so dispatch explicitly.
gh workflow run "Go CI" --ref dev2-go

RUN_ID=""
i=0
while [ "$i" -lt 20 ] && [ -z "$RUN_ID" ]; do
  RUN_ID=$(gh run list --workflow "Go CI" --branch dev2-go --limit 20 \
    --json databaseId,headSha,createdAt \
    | jq -r --arg sha "$NEW" \
      '[.[] | select(.headSha == $sha)] | sort_by(.createdAt) | last | .databaseId // empty')
  i=$((i + 1))
  [ -n "$RUN_ID" ] || sleep 3
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status

RUN_JSON=$(gh run view "$RUN_ID" \
  --json headSha,status,conclusion,jobs,url,createdAt,updatedAt)
printf '%s\n' "$RUN_JSON" | jq -e --arg sha "$NEW" '
  .headSha == $sha and
  .status == "completed" and
  .conclusion == "success" and
  (.jobs | length > 0) and
  ([.jobs[].conclusion] | all(. == "success"))'
RUN_LOG=$(gh run view "$RUN_ID" --log)
if printf '%s\n' "$RUN_LOG" \
  | rg -i 'Node(\.js)? 20.*deprecat|deprecat.*Node(\.js)? 20'; then
  echo "Node 20 deprecation found in Go CI logs" >&2
  exit 1
fi
```

## Activation / verification

| Trigger | Observable | Proof |
|---|---|---|
| rebase completes | no conflict markers | git status clean of unmerged paths |
| local gates | all package ok | command exit 0 |
| ancestry | origin/dev ⊆ HEAD | merge-base --is-ancestor exit 0 |
| remote update | origin/dev2-go == NEW | ls-remote |
| hosted CI | success on NEW | gh run view |

## Risks

- lease fails if remote moved → stop, re-fetch
- CI path-filter skip → mandatory workflow_dispatch


## Stale-check amendment (2026-07-24 post Phase-0)

- Pre-rebase local tip after Phase-0 commit: `3f22d4945551795b23ba43cc3a6a14055e42e717` (docs unit)
- `origin/dev` advanced to `d34e8ba5d199776834a9fc33dd54bcaab5d70a65` (`docs: move public site to opencodex.me`)
- `origin/dev2-go` still `222b4371d13cb64d934c8f52848d15608a634f9b` (lease value)
- Overlap since merge-base `6a670bce`: **only** `structure/06_docs-and-release.md`
- Resolution strategy (keep both):
  1. Take `origin/dev` Pages URL `https://opencodex.me/` + Decision Log
  2. Keep HEAD `go-ci.yml` workflow map row
  3. Keep HEAD `dev2-go` temporary track paragraph after service-lifecycle note
- Expected other conflicts: none

## Resume stale-check amendment (2026-07-24 18:51 KST)

- Current local/fetched remote tip: `105cab4f3dda939fa00fa080605eb7b3ee9378a7`
- Current `origin/dev`: `cc7bb577184a94784adab43e39a366b8ce65a7b6`
- Current merge-base: `d34e8ba5d199776834a9fc33dd54bcaab5d70a65`
- Current unique counts (`HEAD...origin/dev`): 33 branch / 1 base
- The new base commit changes only:
  - `docs-site/src/components/Header.astro`
  - `docs-site/src/styles/custom.css`
- Current changed-path intersection: **none**
- `git merge-tree --write-tree HEAD origin/dev`: success
  (`99594400f0eb715ab27a8b660ec79210bca7ff81`)
- Exact push lease remains
  `--force-with-lease=refs/heads/dev2-go:105cab4f3dda939fa00fa080605eb7b3ee9378a7`

Execution order for this resume is fixed: independent A-gate review, rebase,
ancestry/range-diff inspection, local Go gates, evidence commit, one last remote
lease stale-check, force-with-lease push to `dev2-go` only, then exact-head Go CI.
Any unexpected conflict or lease mismatch returns this work-phase to P/A.

## A-gate round 1 fold-back

- Reviewer: Dalton (`019f9393-3506-7ae3-87fe-1623fb6c91bd`)
- Verdict: `FAIL` (3 blockers)
- Folded fixes:
  1. range-diff now captures the live pre-rebase merge-base, emits the full result,
     and does not hide the command status behind `head`;
  2. local gates now mirror all five workflow cross-build targets;
  3. the procedure now proves the live lease immediately before push, the remote
     post-push SHA, exact run `headSha`, all-job success, and negative Node 20 log
     evidence with copy-executable commands;
  4. `000_plan.md` rollback now uses dynamic `PRE` / exact `REMOTE_TIP` instead of
     obsolete `222b4371`.

Round 2 must use the same reviewer and must pass before any rebase begins.
