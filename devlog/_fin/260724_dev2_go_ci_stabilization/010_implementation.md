# Implementation and verification record

Date: 2026-07-24
Status: `DONE`; local and remote checks passed

## Planned diffs

### `.github/workflows/go-ci.yml`

- Before: PRs to `main`/`dev`/`preview` and pushes to `main`/`preview`/`dev`/`codex/*go*` trigger Go CI.
- After: manual dispatch and pushes to `dev2-go` trigger Go CI; superseded runs on the same ref are cancelled.
- Before: `actions/checkout@v4` and `actions/setup-go@v5` are mutable.
- After: every use is pinned to the exact official Node 24-based v7 commit with the release version retained as a comment.
- Before: each job requests Go 1.24 even though `go/go.mod` requires Go 1.26.4; setup-go v5 masks this by enabling automatic toolchain downloads.
- After: each job uses `go-version-file: go/go.mod`, and setup-go v7 installs the declared toolchain directly with local-toolchain enforcement.

### `go/internal/oauth/store_test.go`

- Before: both goroutines call `RefreshAccount`, so the second goroutine may capture its generation after the first refresh completes.
- After: the test captures `CredentialGeneration(credential)` once and both goroutines call `RefreshAccountIfGeneration` with it. The callback count and result-state assertions remain unchanged.
- Add `TestCredentialStoreRefreshSequential` to keep the exported `RefreshAccount` happy path directly covered for its CLI caller.

### Governance and source-of-truth docs

- `AGENTS.md`: add the branch identity and no-standing-PR warning.
- `MAINTAINERS.md`: add the owner-approved direct-push exception and exact Go CI gate.
- `structure/06_docs-and-release.md`: add Go CI trigger/purpose and the temporary dual-track relationship.

## Verification ledger

- Focused repeated race test: `go test -race ./internal/oauth -run '^TestCredentialStoreRefresh(Sequential|IfGenerationAdoptsWinner)$' -count=100 -timeout 180s` -> exit 0, package `ok`.
- Go build/vet/test: `go build ./...`, `go vet ./...`, `go test ./... -count=1 -timeout 120s` -> exit 0.
- Full Go race: `go test -race ./... -count=1 -timeout 180s` -> exit 0 across every package.
- E2E: `go test ./test/e2e/... -v -count=1 -timeout 60s` -> exit 0; four tests passed.
- Cross-compiles: Windows amd64, Linux amd64/arm64, and Darwin amd64/arm64 `go build ./...` -> exit 0.
- Workflow syntax/security: `actionlint .github/workflows/go-ci.yml` -> exit 0; `git diff --check` -> exit 0; official action refs are exact 40-character SHAs with version comments.
- Repository gates after `bun install --frozen-lockfile` in root and `gui/`: `bun run typecheck` -> exit 0; `bun run privacy:scan` -> exit 0; `bun run test` -> 3,841 pass, 0 fail across 313 files.
- Environment note: the first Bun gate attempt ran before this worktree had dependencies and failed on missing `bun-types`, `zod/v4`, `@bufbuild/protobuf`, and React runtime modules. No lockfile changed. Frozen installs restored the declared environment and the fresh rerun passed.
- Intermediate GitHub exact-SHA Go CI: run `30064436430` at `05006fdd2bfb540810c517daf61ac00d86d7bd79` passed every job, but emitted five Node 20 action-runtime deprecation annotations. The C repair upgrades the immutable action pins to checkout v7.0.1 and setup-go v7.0.0 before final proof.
- Node 24 action repair run: `30065013478` at `c7384bef8fac0008391989087ae6245f1cce48b9` removed the deprecation warnings but failed every Go command because setup-go v7 enforced the requested Go 1.24 locally while the module requires 1.26.4. Prior-run logs confirm v5 had silently downloaded 1.26.4 in every job. The second C repair makes `go/go.mod` the setup-go version source.
- Final implementation GitHub exact-SHA Go CI: run `30065187682` at `5564f84c27141df9058770df4c2e61594f586a18` passed Ubuntu/macOS/Windows build, vet, and tests; Ubuntu/macOS race detection; all five cross-compiles; and E2E. Log inspection found no Node 20 deprecation or forced-Node-24 warning.
- Remote branch/PR postconditions: PR #368 is closed with `mergedAt: null` and an English evidence comment naming `dev2-go` and run `30065187682`; `origin/dev2-go` points to the verified implementation SHA; `origin/codex/260724-go-porting` is absent; no open PR remains for the old head.
- Preservation: `/Users/jun/.codex/worktrees/6e3a/opencodex` still owns local branch `codex/260724-go-porting`; it was left intact to avoid mutating concurrent local work.

## D outcome

1. Deterministic OAuth regression: passed 100 race repetitions and full Go race.
2. Go build/vet/test/race/E2E: passed locally and on hosted runners.
3. Windows/Linux/Darwin cross-compiles: passed locally and in hosted CI.
4. Workflow: `dev2-go` push plus manual dispatch only, read-only permissions, per-ref cancellation, immutable Node 24 action SHAs, module-derived Go toolchain.
5. Governance: `preview` remains the TypeScript prerelease line; `dev2-go` is the no-standing-PR Go line.
6. Replacement proof: run `30065187682` succeeded for exact implementation SHA `5564f84c27141df9058770df4c2e61594f586a18` before destructive cleanup.
7. PR cleanup: #368 closed, never merged.
8. Branch cleanup: old remote deleted after criteria 6 and 7; sibling local branch/worktree preserved.

The archived devlog-only head is manually dispatchable and receives one final exact-head Go CI run after this record is committed, so the branch tip is also covered even though devlog paths do not trigger push CI.
