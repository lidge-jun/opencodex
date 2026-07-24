# 002_rebase_strategy — clean rewrite onto origin/dev

Date: 2026-07-24

## Strategy recommendation

`REBASE_CLEAN` expected.

1. Ensure worktree clean.
2. `git fetch --all --prune` (done for this inventory).
3. Record pre-rebase tip: `PRE=$(git rev-parse HEAD)` → currently `222b4371d13cb64d934c8f52848d15608a634f9b`.
4. `git rebase origin/dev`.
5. If unexpected conflicts appear, stop and document path-level resolution; do not skip tests.
6. Local gates from `go/`:
   - `go build ./...`
   - `go vet ./...`
   - `go test ./... -count=1 -timeout 120s`
   - `go test -race ./... -count=1 -timeout 180s` (non-Windows local host)
   - `go test ./test/e2e/... -count=1 -timeout 60s`
   - cross-compiles used by CI if time permits
7. If only Go/governance/devlog changed and no TS source conflict resolution needed, Bun suite is optional; if any TS path is touched while resolving, run `bun run typecheck`, `bun run test`, `bun run privacy:scan`.
8. Commit any docs-only residual notes if needed (rebase itself rewrites commits; docs unit commits land before/after as ordinary commits).
9. Push rewrite:
   - `git push --force-with-lease=refs/heads/dev2-go:222b4371d13cb64d934c8f52848d15608a634f9b origin dev2-go`
10. Wait for hosted Go CI on exact new tip; if path filters skip because only non-go files changed, `workflow_dispatch` on `dev2-go`.

## Why force-with-lease is required

`origin/dev2-go` already exists at the pre-rebase tip. Rebase rewrites the 31 unique commits onto the new base, so a non-fast-forward update is expected. Lease must pin the exact old tip to avoid clobbering concurrent remote updates.

## Soft risks (not content conflicts)

- Divergence magnitude: 131 commits on `dev` — behavioral residual ports remain after a clean rebase.
- Go CI path filters: pure docs commits may need manual dispatch for exact-head proof.
- Sibling worktree still owning local `codex/260724-go-porting` is out of scope and must not be mutated.

## Unsafe paths (do not take)

- Force-push without lease.
- Rebase onto `main`/`preview`.
- Merge `dev2-go` into `dev` as part of this loop.
- Resetting unrelated worktrees that share historical branch names.


## Sol rebase brief folds (Socrates)

- Prefer plain `git rebase origin/dev` (linear 31 commits, no merges).
- Soft risk: force-push may not auto-trigger Go CI if final blobs for `go/**` and workflow are unchanged — use `gh workflow run` / `workflow_dispatch` on exact new tip.
- Optional strongest parity: also dispatch Cross-platform CI against `dev2-go` if governance wants Bun gates on the combined SHA (not required by go-ci path filters).
- Post-rebase integrity: `git range-diff 6a670bce..222b4371 origin/dev..HEAD` and `git diff --check origin/dev..HEAD`.
- Stop if lease fails, overlap appears after re-fetch, or range-diff shows dropped/duplicated Go commits.
