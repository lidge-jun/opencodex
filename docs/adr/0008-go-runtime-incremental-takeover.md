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
