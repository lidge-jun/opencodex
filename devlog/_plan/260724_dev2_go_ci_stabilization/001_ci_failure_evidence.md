# CI failure and branch evidence

Date: 2026-07-24

## Exact failing run

- Workflow: `Go CI`
- Event: `push`
- Run: `30061262434`
- Head branch: `codex/260724-go-porting`
- Head SHA: `5f3229d4dd2c6b6bcbafc459eaec06a2eff9f362`
- Failed job: `Build + Test (macos-latest)`
- Failed step: `go test -race ./... -count=1 -timeout 180s`
- Assertion: `store_test.go:140: refresh calls = 2, want 1`

The simultaneous `pull_request` run `30061264866` passed on Ubuntu, macOS, and Windows. That disagreement is evidence of scheduler-dependent test ordering, not evidence that the commit is stable.

## Root cause

`go/internal/oauth/store_test.go` starts the second goroutine and immediately releases the first refresh callback. The test has no signal proving that the second goroutine captured the old generation before the first goroutine persisted the new credential. If the second goroutine is scheduled late, both its observed and locked generations are already new and it legitimately invokes the refresh callback a second time.

The production code already exposes `RefreshAccountIfGeneration`, whose contract is to compare a caller-captured generation under the refresh lock. Both request-time callers (`authcontext.go` and `guardian.go`) use that entry point. Feeding both concurrent calls the same old generation makes the test deterministic and exercises the stale-read-safe contract directly.

## Workflow findings

- `.github/workflows/go-ci.yml` runs both on a PR targeting `dev` and on pushes matching `codex/*go*`, producing duplicate runs for PR #368.
- The push pattern will not match the requested `dev2-go` branch.
- `actions/checkout@v4` and `actions/setup-go@v5` are mutable references in a security-sensitive workflow.
- GitHub's official refs resolved on 2026-07-24 to:
  - `actions/checkout` v4: `11d5960a326750d5838078e36cf38b85af677262`
  - `actions/setup-go` v5: `40f1582b2485089dde7abd97c1529aa768e1baff`

## Scope safeguards

- PR #368 is the only PR to close.
- No merge, rebase, force-push, release, package publish, or change to `dev`, `preview`, or `main` is authorized or planned.
- The old remote branch remains until `dev2-go` has exact-SHA green proof.

## First replacement-branch run

- Run: `30064436430`
- Head branch: `dev2-go`
- Head SHA: `05006fdd2bfb540810c517daf61ac00d86d7bd79`
- Result: all build/test, race, cross-compile, and E2E jobs passed.
- Residual: five Node 20 action-runtime deprecation annotations, one for each matrix/cross-compile/E2E job; GitHub forced the old action bundles onto Node 24.

The current official Node 24-based releases resolved on 2026-07-24 to immutable commits:

- `actions/checkout` v7.0.1: `3d3c42e5aac5ba805825da76410c181273ba90b1`
- `actions/setup-go` v7.0.0: `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`

This run proves the Go matrix is functionally green, but it is intermediate evidence rather than the final stability gate.
