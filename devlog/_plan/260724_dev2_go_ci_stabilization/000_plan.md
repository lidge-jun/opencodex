# dev2-go CI stabilization and branch split

Date: 2026-07-24
Work class: C4 (GitHub Actions, branch governance, remote branch replacement, and PR closure)

## Loop specification

- Archetype: spec-satisfaction repair.
- Trigger: Draft PR #368 has two Go CI runs for SHA `5f3229d4`; the `pull_request` run passed while the simultaneous `push` run failed on macOS in `TestCredentialStoreRefreshAdoptsCrossProcessWinner`.
- Goal: establish `dev2-go` as the temporary maintainer-owned Go track running a deterministic, branch-scoped Go CI gate, then close PR #368 and retire `origin/codex/260724-go-porting` only after the replacement branch is green.
- Non-goals: merge or rebase Go into `dev`, `preview`, or `main`; publish a package; claim live-provider, tray-UI, or Codex-runtime parity; alter the TypeScript release train; close unrelated PRs.
- Verifier: local Go build/vet/test/race/E2E/cross-compile commands, workflow syntax inspection, and a successful GitHub Go CI run on the exact `dev2-go` head SHA.
- Stop condition: local gates pass, `origin/dev2-go` points at the verified SHA, its Go CI run is successful, PR #368 is closed, and the old remote branch no longer exists.
- Memory artifact: this unit plus the exact GitHub run URL/SHA recorded in `010_implementation.md` during C.
- Expected terminal outcome: `DONE`; `BLOCKED` if GitHub rejects branch/PR mutations or a supported-OS CI job remains red after an evidence-led repair; `UNSAFE` if the only route requires force-pushing or rewriting shared history.
- Escalation: main agent retains all writes and remote mutations. An independent A reviewer audits the test, workflow trust boundary, and deletion ordering; no implementation slice is delegated.

## Current state

- Current detached HEAD and `codex/260724-go-porting` both point to `5f3229d4dd2c6b6bcbafc459eaec06a2eff9f362`.
- `origin/dev` is 86 commits ahead of the merge base and the Go branch is 27 commits ahead; this operation intentionally preserves that divergence.
- `origin/preview` is 45 commits ahead of the same merge base and the Go branch is 27 commits ahead; no ancestry rewrite is planned.
- PR #368 is an open draft from `codex/260724-go-porting` to `dev` and is the only PR in scope.
- The owning sibling worktree `/Users/jun/.codex/worktrees/6e3a/opencodex` is clean. This worktree will create `dev2-go` from the same SHA rather than mutate the branch checked out by the sibling worktree.

## Necessity gate

- Do nothing: rejected because the push run is red and the current workflow will not run on `dev2-go` (`push.branches` only matches `main`, `preview`, `dev`, and `codex/*go*`).
- Blind rerun: rejected because the failed assertion is scheduler-dependent and a retry would preserve the flake.
- Close PR and rename only: rejected because the flaky synchronization remains and the renamed branch would lose automatic CI.
- Quarantine or retry the test: rejected because it would hide a concurrency contract and violate the repository's anti-flake rule.
- Reuse: use the existing stale-generation-safe `RefreshAccountIfGeneration` entry point in the deterministic winner-adoption test; do not add production hooks, sleeps, retries, or a new lock abstraction.

## Threat model

- Assets: branch integrity, Go build/test signal, contributor code executed by GitHub-hosted runners, and the replacement branch history.
- Entrypoints: direct pushes to `dev2-go` and manual workflow dispatch.
- Trust boundaries: repository content to GitHub Actions runner; workflow action reference to third-party action repository; local branch to remote branch/PR state.
- Attacker/failure capability: compromised mutable action tag, untrusted branch content, overlapping pushes, scheduler-dependent tests, or deleting the old branch before replacement proof exists.
- Controls: `contents: read`, exact action SHAs, path scoping, branch-only push trigger, concurrency cancellation, deterministic channel/generation test inputs, exact-SHA CI verification, and create/verify/close/delete ordering.
- Secrets: none are introduced or consumed by Go CI.

## Change map

- MODIFY `.github/workflows/go-ci.yml`
  - Replace PR plus broad branch triggers with `workflow_dispatch` and pushes to `dev2-go` only.
  - Add per-ref concurrency cancellation.
  - Pin `actions/checkout` v4 and `actions/setup-go` v5 to the official commits resolved on 2026-07-24.
  - Superseded during C after the first successful `dev2-go` run emitted Node 20 deprecation annotations: pin the current Node 24-based `actions/checkout` v7.0.1 and `actions/setup-go` v7.0.0 releases instead.
- MODIFY `go/internal/oauth/store_test.go`
  - Rename the flaky winner-adoption test and pass one pre-captured credential generation to both concurrent `RefreshAccountIfGeneration` calls.
  - Preserve the one-refresh and refreshed/superseded assertions without sleeps or retries.
  - Add a separate sequential `RefreshAccount` happy-path test so the exported CLI entry point keeps direct coverage after the concurrency test moves to the generation-aware API.
- MODIFY `AGENTS.md`
  - Document `dev2-go` as the temporary maintainer-owned Go track parallel to the `preview` TypeScript prerelease train, with no standing merge PR.
- MODIFY `MAINTAINERS.md`
  - Record the narrow direct-push exception and exact Go CI requirement for `dev2-go` without changing normal contributor PR policy.
- MODIFY `structure/06_docs-and-release.md`
  - Add the Go CI workflow and branch split to the workflow/source-of-truth map.
- ADD this implementation unit's P/A/C/D evidence documents under `devlog/_plan/260724_dev2_go_ci_stabilization/` and archive it to `_fin/` after verification.
- REMOTE after exact-SHA green: push `dev2-go`, close PR #368 with an English evidence comment, delete `origin/codex/260724-go-porting`.

## Acceptance criteria

1. The winner-adoption test has no wall-clock synchronization and passes under `go test -race ./internal/oauth -run '^TestCredentialStoreRefresh(Sequential|IfGenerationAdoptsWinner)$' -count=100`; the sequential case directly covers `RefreshAccount`, while the concurrent case covers stale-generation adoption.
2. `go build ./...`, `go vet ./...`, `go test ./... -count=1`, `go test -race ./... -count=1`, and `go test ./test/e2e/... -count=1` pass from `go/`.
3. Windows, Linux, and Darwin cross-compiles used by Go CI pass locally where Go cross-compilation permits them.
4. Go CI runs automatically only for pushes to `dev2-go`, remains manually dispatchable, uses read-only contents permission, cancels superseded runs for the same ref, pins third-party actions to exact SHAs, and emits no Node 20 action-runtime deprecation annotations.
5. Governance and workflow-map docs agree that `preview` remains the TypeScript prerelease line and `dev2-go` is a separate temporary Go line with no standing PR to `dev`.
6. `origin/dev2-go` exists at the checked commit and a fresh Go CI run for that exact SHA is successful before any old remote branch deletion.
7. PR #368 is closed, not merged; its close comment names the replacement branch and successful run.
8. `origin/codex/260724-go-porting` is deleted only after criteria 6 and 7; unrelated local branches/worktrees and open PRs remain untouched.

## Rollback

- Before old-branch deletion: stop and keep both remote branches if the replacement run fails.
- After old-branch deletion: recreate `codex/260724-go-porting` from the verified `dev2-go` SHA if branch consumers require it; do not force-push or rewrite commits.
- Reopen PR #368 only if the maintainer abandons the independent-branch strategy.

## C-phase amendment: action runtime support

The first replacement-branch run, `30064436430` at `05006fdd2bfb540810c517daf61ac00d86d7bd79`, passed every job but emitted five annotations saying the pinned checkout/setup actions still declared Node 20 and were being forced onto Node 24. A green result with a known action-runtime deprecation is not the requested stable endpoint.

The repair remains within the audited trust boundary and keeps immutable refs:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0`

Both releases declare `node24`. The branch replacement sequence remains unchanged: validate locally, push, require a fresh exact-SHA green run without the deprecation annotation, then close PR #368 and delete the old remote branch.

### C-phase repair 2: Go toolchain source of truth

Run `30065013478` showed that setup-go v7 correctly sets `GOTOOLCHAIN=local`, exposing a pre-existing contradiction: the workflow requested Go 1.24 while `go/go.mod` requires Go 1.26.4. The old setup-go v5 run had set `GOTOOLCHAIN=auto`, so every job silently downloaded Go 1.26.4 after first installing 1.24.

Replace the duplicated `go-version: "1.24"` inputs with `go-version-file: go/go.mod`. This makes the module declaration the single toolchain source of truth, avoids hidden second-stage downloads, and keeps all jobs aligned when the module version changes.
