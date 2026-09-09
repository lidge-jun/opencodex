# Reopen the Go runtime line as an incremental sidecar takeover

The `dev2-go` Go port was retired on 2026-07-30 because a parallel runtime line
could not keep up with `dev` (594 commits of divergence) and kept producing silent
dogfood defects. We reopen Go native work in a different shape: the backend migrates
to Go as an incremental sidecar takeover — the Bun/TypeScript server stays the front
door while a Go sidecar takes over routes one at a time, and the endpoint is a single
static Go binary (server, CLI, and the embedded dashboard) with a byte-identical HTTP
API and on-disk formats. The owner will maintain the Go side long-term, which is what
makes the reopened line sustainable where the parallel line was not.

## Considered options

- **Parallel Go runtime line** — the `dev2-go` shape; rejected as already-failed.
- **Rust via N-API incremental module** — the previously stated default; not chosen
  because the owner prefers Go.
- **Big-bang rewrite** — rejected; a single cutover cannot be verified against the
  live TS oracle.

## Consequences

- Fresh Go codebase; `archive/dev2-go` is reference material only, not a fork.
- Parity is proven by a differential harness: the same request is run against the TS
  and Go implementations and the responses (including SSE frame sequences) must match.
- The Compatibility Lab migrates last and is an explicit cut candidate.
- The flip to a single binary happens only at 100% differential parity; until then the
  TypeScript CLI and server remain the operating surface.

## Status update (2026-09-09): delivered, and the operating surface is now Go

This ADR was written against the upstream (lidge-jun/opencodex) `dev` line. The Go
line is implemented on the owner's fork (`waxiangzi/opencodex`, branch `dev-go`), which
is since maintained as an independent release line; upstream is a future donation
target, not the current integration base. The prose below that still reads as upstream
"we" decisions should be read as fork-line decisions.

Increment state on `dev-go` (fork tickets #1–#43, all closed):

- The management read/write surface, hot path, non-streaming relay, WebSocket bridge,
  SSE streaming relay, Lab routes, Go CLI scaffold + families, single-binary packaging
  (#40), release pipeline (#42) and upgrade/rollback oracle (#43) are implemented with
  their differential harnesses. The CLI surface is Go-owned for every oracle-able
  command; the remainder is the explicit Bun-dependent list of ADR-0009.
- The final consequence bullet above ("TypeScript CLI and server remain the operating
  surface") no longer holds: with the #41 cutover (dev-go, 2026-09-07) the Go binary is
  the release runtime. Release tags ship a TypeScript-free single-binary artifact, the
  `go-release-artifacts` workflow gates the exact binaries, and the Bun/TypeScript
  server remains the in-repo oracle the differential harness diffs against — not the
  shipped surface.
- The "100% differential parity" clause is superseded by ADR-0009's completion
  definition (every oracle-able surface passes its oracle; the non-oracle-able surface
  is the deliberate Bun-dependent list). ADR-0009 records the taxonomy; this ADR defers
  to it.
