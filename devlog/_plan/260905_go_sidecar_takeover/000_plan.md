# Go sidecar takeover — first increment: fresh `go/` + one read-only route

Date: 2026-09-05
Status: planned
ADR: [`docs/adr/0008-go-runtime-incremental-takeover.md`](../../docs/adr/0008-go-runtime-incremental-takeover.md)

## Objective

Land the first Go increment on `dev` per ADR-0008: a fresh Go module under
`go/` building an `ocx-sidecar` binary, spawned and supervised by the
TypeScript server, serving exactly one read-only management route
(`GET /api/system/health`) with byte-identical HTTP semantics, plus the
differential oracle harness that proves it.

This increment migrates nothing else: no proxy hot path, no CLI, no write
route. Its only job is to prove the seam — TS front door → Go sidecar →
differential oracle — with zero user-visible change.

## Shape

- Go module at `go/` (`go.mod`, module path `github.com/lidge-jun/opencodex/go`),
  a fresh codebase. Nothing is copied from `archive/dev2-go`; that archive is
  reference material only (consulted, never forked).
- Binary: `go/cmd/ocx-sidecar` → `ocx-sidecar`, built `CGO_ENABLED=0`.
- The TS server spawns the sidecar as a child process and supervises it,
  following the existing sidecar pattern (`openai-sidecar.ts` is the model).
  It forwards only `GET /api/system/health` to the sidecar over the local HTTP
  channel (`direct-local-http.ts`); every other route stays in-process TS.
- The sidecar serves the same JSON shape as the TS handler:
  `{ status, service, version, uptime, pid }`. `status`, `service`, and
  `version` must equal the TS values; `uptime` and `pid` are the sidecar's own
  process values.

## Differential oracle harness

- A Bun test boots the TS server with the sidecar attached, then issues
  `GET /api/system/health` twice — once to the TS in-process handler and once
  to the Go sidecar — and asserts byte-identical responses after normalising
  the declared volatile fields (`pid`, `uptime`).
- The normalisation set is explicit and declared, never ad-hoc, so no later
  route can silently widen what "equal" means.
- This is the divergence class that sank `dev2-go` (Go runtime numbers rendered
  under JavaScript labels); the harness must fail on any such drift, not log it.

## Accept criteria

- `go build ./...`, `go vet ./...`, and `go test ./...` clean under `go/`.
- The differential harness passes in CI: TS handler and Go sidecar agree on
  status, headers, and the normalised body for `GET /api/system/health`.
- `bun run typecheck` and the existing Bun suite stay green — no TS behaviour
  change.
- No route other than `GET /api/system/health` is affected, and the Go-owned
  route is declared in the management route registry so the forwarding seam is
  visible to the existing registry reconciliation test.

## Open questions for the implementer

- Nested `go/go.mod` (module `.../opencodex/go`) versus a root `go.mod`; nested
  is assumed here to keep the Go tree self-contained under `go/`.
- Which sidecar supervision primitive to reuse (the exact sidecar spawner to
  copy), settled during implementation against `openai-sidecar.ts`.
