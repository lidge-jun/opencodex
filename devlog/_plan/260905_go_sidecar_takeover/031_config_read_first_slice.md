# 031 — Ticket #16 first vertical slice: shared Go config parsing + strict shadow-call-settings parity

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: recorded on `dev-go`; ticket #16 OPEN (1 of 9 config read routes migrated)
Tickets: [#16](https://github.com/waxiangzi/opencodex/issues/16) (config read routes batch, spec #2)
Parent spec: [#2](https://github.com/waxiangzi/opencodex/issues/2) (increment 2)
Owner decision (2026-09-06): implement #16 next, per the ordering recommended in
`030_read_surface_state_source_gate.md` — port the pure config core first and
resolve live-field routes per-field.

## What this run delivered

The first vertical slice of #16, proven end to end through the differential
oracle: a shared Go config reader, one config read route served byte-identically
from it, and the registry/oracle semantics that make "this route has no volatile
field" a real, checkable contract.

- **`go/internal/config`** — the shared Go config parser (the artifact #20/#21/
  #24/#35 all list as a dependency). It reads the operator's `config.json` from
  the same place the TypeScript runtime reads it (`OPENCODEX_HOME`, defaulting
  to `~/.opencodex`), decodes numbers with `json.Number` so a value echoed into
  a response keeps its on-disk literal, and never rewrites or moves the file. It
  mirrors only the TS-side normalisation the Go-owned route bodies depend on,
  and keeps the raw decoded document (`Raw`) so later routes can project from
  it without a full schema port.
- **`GET /api/shadow-call-settings` is now Go-owned** — a marker flip in
  `route-registry.ts` plus a Go handler in `go/internal/sidecar` that projects
  the `shadowCallIntercept` section through the exact TS rules
  (`sci.enabled === true`, `sci.model ?? ""`, `shadowSourceModels` trim /
  non-empty / default filtering, default `["gpt-5.6-luna"]`). The in-process TS
  handler remains the fallback and the differential oracle.
- **Strict-byte ownership semantics.** The `go.volatileFields` marker may now be
  EMPTY: that declares a route whose body is a pure function of shared state
  and must be byte-identical with NO normalisation — the strongest contract the
  oracle can impose, not a vacuous one (the raw wire bodies are compared). The
  previous "must be non-empty" rule had it backwards: it only ever made sense
  for routes that legitimately report the serving process's own values. The
  interface doc, `go-ownership-plumbing.test.ts`, the parity oracle, and
  `go/README.md` all state the new contract.

## Why this route first

Of #16's nine config read routes, this is the only one whose body is a pure
function of the on-disk config with no live-process dependency — the smallest
byte-parity target that exercises the whole seam (config file → Go parser →
Go handler → registry flip → oracle row). Empirical check first: a probe
through `saveConfig`/`loadConfig` confirmed `shadowCallIntercept` round-trips
unnormalised (values verbatim, empty strings kept), so TS in-memory == file
content for this section and byte parity is well-defined.

## Verification

- `go build ./...`, `go vet ./...`, `go test ./...` green under `go/`
  (new `internal/config` package: 8 tests; `internal/sidecar`: 10 tests incl.
  shape/order, defaults, coercions, narrow surface).
- `bun test tests/go-sidecar-parity.test.ts`: 6 pass — health volatile parity,
  missing-binary no-op, crash fallback, PLUS two new strict cases:
  shadow-call-settings default body and configured body are byte-identical
  with no normalisation, and the front door relays the Go bytes unaltered.
- `bun test tests/go-ownership-plumbing.test.ts tests/management-route-registry.test.ts
  tests/repo-hygiene.test.ts tests/ci-workflows.test.ts tests/cli-capabilities.test.ts
  tests/route-explainability.test.ts`: 199 pass.
- `bun run typecheck` green.

## Per-route status of #16 (config read routes, 1 of 9 migrated)

| route | body source | status |
|---|---|---|
| `/api/shadow-call-settings` | pure config | **Go-owned, strict parity** |
| `/api/config` | pure fn of config, but a LARGE projection | next sub-increment: provider redaction policy (`providerEditorConfigDTO`), registry notes, xai opt-in, cost-overlay sanitisation, service-tier projection, key order |
| `/api/settings` | disk core + live fields | mixed: `codexRuntime` (memoized discovery), cached `startupHealth`, process `timeZone` — port the disk core; live fields need the per-field owner decision |
| `/api/sidecar-settings` | config core + candidate/model helpers | classify the helpers when attempted |
| `/api/startup-health` | in-process cache (install/repair actions) | defer — no on-disk counterpart |
| `/api/diagnostics/project-config` | in-process scan cache | defer — no on-disk counterpart |
| `/api/update/check` / `/api/update/status` | updater job module state | defer |
| `/api/windows-tray` | platform probe / static platform string | OS-level; low value; defer |

The `/api/settings` and `/api/config` disk-derived cores are the two large
sub-increments left before #16's write of shared parsing is exercised broadly;
the cache/process routes stay TypeScript-owned until the flip, consistent with
`030_read_surface_state_source_gate.md`. Ticket #16 remains open.

## Files

- `go/internal/config/config.go`, `config_test.go` — new shared config reader.
- `go/internal/sidecar/sidecar.go`, `sidecar_test.go` — new route + shared
  `respondJSON`; unit tests.
- `go/cmd/ocx-sidecar/main.go`, `go/README.md` — doc updates.
- `src/server/management/route-registry.ts` — strict-volatile semantics + marker.
- `tests/go-ownership-plumbing.test.ts`, `tests/go-sidecar-parity.test.ts` —
  two-route surface pins + strict-parity oracle cases.
