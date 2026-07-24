# Implementation and verification record

Date: 2026-07-24
Status: implemented; local checks passed; remote proof pending

## Planned diffs

### `.github/workflows/go-ci.yml`

- Before: PRs to `main`/`dev`/`preview` and pushes to `main`/`preview`/`dev`/`codex/*go*` trigger Go CI.
- After: manual dispatch and pushes to `dev2-go` trigger Go CI; superseded runs on the same ref are cancelled.
- Before: `actions/checkout@v4` and `actions/setup-go@v5` are mutable.
- After: every use is pinned to the exact official Node 24-based v7 commit with the release version retained as a comment.

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
- Final GitHub exact-SHA Go CI run: pending C repair.
- Remote branch/PR postconditions: pending C.

## D outcome

Populate after the remote postconditions are verified.
