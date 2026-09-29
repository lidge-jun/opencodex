# 031 wp3 execution: push, PR, final CI, merge

Previous D (wp2): all local gates green on 441aeb179e; full-suite failures proven pre-existing
(022). Direction unchanged: push once and let the cross-platform CI be the last gate.

Branch head at push = 441aeb179e plus devlog-only commits (021 audit, 022 results, this file).
The devlog commits do not change code; CI runs on the pushed head, which is the head that merges.

## 1. Screenshots to pr-assets (no working-tree change)

```sh
IDX=$(mktemp /tmp/rt2710-assets.XXXXXX)
GIT_INDEX_FILE=$IDX git read-tree rt/pr-assets        # rt/pr-assets = origin pr-assets ea1749154d
for f in pr-6094-provider-request-pacing.png:request-pacing.png pr-5905-2.bin:cursor-installer.png; do
  src=${f%%:*}; dst=${f##*:}
  blob=$(git hash-object -w .tmp/rt2710/shots/$src)
  GIT_INDEX_FILE=$IDX git update-index --add --cacheinfo 100644,$blob,260929-release-2-71-0/$dst
done
tree=$(GIT_INDEX_FILE=$IDX git write-tree)
commit=$(git commit-tree $tree -p rt/pr-assets -m "assets: 2.71.0 integration screenshots (#6094, #5905)")
git push origin $commit:refs/heads/pr-assets   # fast-forward only; fails if pr-assets moved
```

The images are the source PRs' own screenshots (#6094 by the author's run, #5905 second image);
the integrated code for those files is byte-identical to the PR heads (patch-id equality, 011).

## 2. Push and open the PR

`git push -u origin codex/release-2-71-0`, then `gh pr create --base dev --title
"chore(release): integrate six reviewed PRs for 2.71.0" --body-file .tmp/rt2710/pr-body.md`.
Body: template sections (Summary, Verification, Checklist); one bullet per source PR with author,
land commit and what it changes; the four fix commits; the two screenshots embedded; local
verification summary pointing to 022; `Closes #6208`; one `Co-authored-by` line per identity in the
010 table.

## 3. Final CI (the only cross-platform run)

Wait on the PR head SHA. Required: every check run on that SHA completes with success (skipped only
where the workflow's path filter or matrix helper skips by design, as on the source PRs). Cross-
platform CI must show all Linux test shards, windows 1-9, macOS, docker smoke, npm-global smokes;
enforce-target, hygiene, privacy gate, structure, react-doctor (runs on every PR, fails on
warnings) and Service lifecycle must pass. A failure is fixed with a new commit and
the wait restarts on the new head; a flake classified with evidence may be rerun once
(`gh run rerun --failed`).

## 4. Merge and close

Before merging: `scripts/ci/assert-mergeable-review.sh --maintainer-integration <n> lidge-jun/opencodex`
(MAINTAINERS.md change log 2026-09-06). It checks the actor against the dev roster and live
permissions and binds its snapshot to the current head and base; it is not CI proof. Then post a
PR comment recording the maintainer-integration decision (owner-authorized, 2026-09-29), the exact
head SHA and the CI run IDs that passed on it.

`gh pr merge <n> --admin --merge --match-head-commit <head>` (merge commit keeps the six authored
commits). Then for each source PR: `gh pr comment <src> --body "Landed on dev in <land sha> through
#<n> (2.71.0 integration). Thanks!"` and `gh pr close <src>`. Close #6208 with a comment naming the
#6209 land commit (dev is not the default branch, so Closes does not fire). Record the dev merge SHA.

D10 (architect, wp3): a) run the maintainer-integration helper and record the decision (above);
b) Service lifecycle must actually run and pass, because src/cli/index.ts is in its pull_request
paths (service-lifecycle.yml:15); c) `--merge` is allowed on dev (MAINTAINERS.md:204-205, no linear
history rule). ci.yml runs the full matrix on pull_request (ci.yml:6) and not on push to dev
(ci.yml:32-33), so the PR run is the only cross-platform evidence before promotion. Accepted.

Audit (Kimi 01a0eb97): GO-WITH-FIXES, 1 blocker folded (react-doctor added to required checks),
`mktemp -u` replaced, line anchors corrected. The reviewer ran the pr-assets plumbing in a scratch
repo and confirmed it touches only refs/heads/pr-assets; confirmed the maintainer-integration helper
passes for the owner on a self-authored PR; confirmed the planned body satisfies pr-quality and the
carry gate (trailers use each author's git identity from the PR commits).
