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
cd /Users/jun/.codex/worktrees/e479/opencodex
git status --short --branch   # must be clean except intentional docs commits
git fetch --all --prune
REMOTE_TIP=$(git rev-parse origin/dev2-go)   # lease source = remote tip
PRE=$(git rev-parse HEAD)
git rebase origin/dev
# expected: no conflicts
cd go
go build ./...
go vet ./...
go test ./... -count=1 -timeout 120s
go test -race ./... -count=1 -timeout 180s
go test ./test/e2e/... -count=1 -timeout 60s
cd ..
git merge-base --is-ancestor origin/dev HEAD
git range-diff 6a670bce..$PRE origin/dev..HEAD | head
# push only after local gates
git push --force-with-lease=refs/heads/dev2-go:$REMOTE_TIP origin HEAD:dev2-go
NEW=$(git rev-parse HEAD)
# if push did not auto-start CI (path filters / unchanged go blobs):
gh workflow run "Go CI" --ref dev2-go
# require run headSha == $NEW and conclusion success; no Node 20 deprecation annotations
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
