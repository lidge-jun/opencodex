# 043 — Ticket #42: release pipeline Go build (cross-compile) + CI switch

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-07
Ticket: [#42](https://github.com/waxiangzi/opencodex/issues/42) (spec #7 acceptance:
release pipeline builds the Go binary for every target; CI verifies Go build/vet/test)

## What landed

The Go binary is the release runtime, so the release path builds and attaches the
same static cross-platform `ocx` artifact CI has verified:

- `.github/workflows/go-release-artifacts.yml` (scaffolded at 36a0c2cfb as
  dispatch-only staging) is now the active release-artifact gate. It runs on
  pull requests and on pushes to `main`/`preview`/`dev` when the Go release
  surface changes (same paths-filter `changes`-job shape as `ci.yml`), and
  verifies every release target through `scripts/build-go-release-artifact.sh`:
  `go build/vet/test` under `go/`, then the linux/amd64 artifact is built and
  smoked — static ELF check, and `--version` must print exactly
  `opencodex <package.json version>` when run from a directory with no
  package.json (proves the `-ldflags` stamp), which is what release.yml relies
  on per release tag. The matrix job cross-compiles all five release targets
  (linux/darwin × amd64/arm64, windows/amd64) with the same script and asserts
  each file's format (ELF 64-bit / Mach-O / PE32+).
- `scripts/build-go-release-artifact.sh` keeps its single-builder role; its
  header now states it is the shared artifact builder for the gate workflow and
  release.yml rather than a staging-only helper awaiting #40 (closed).
- `release.yml`'s artifact build/attach steps (added with the #41 flip at
  310f25fa8) are unchanged in behavior; comments now tie them to #42's gate.

## Why the CI switch stayed workflow-shaped

`ci.yml` already runs a `go` job (build/vet/test + 6-target `ocx-sidecar`
cross-compile + differential oracles). The release *artifact* — `./cmd/ocx` with
version ldflags and the embedded dashboard — is a different build (script,
`-trimpath`, `sync-go-embedded-dashboard.sh`, 5 targets), and the release path
must not trust an unverified producer. A dedicated gate workflow keeps the
artifact verification next to its consumer (release.yml) instead of enlarging
the aggregate CI job graph; release remains a deployment of a commit the gate
already ran on, matching the repo's existing exact-SHA CI gate.

## Verification notes

Local verification: `go build/vet/test` clean under `go/`; the linux/amd64
artifact builds through the script, prints the exact stamped version, and is a
static ELF; `tests/ci-workflows.test.ts` pins the workflow's permissions,
immutable action refs, bounded timeouts, trigger/paths-filter shape, and the
release.yml Go steps ordering.
