# 039 — Ticket #35: Go CLI scaffold + local HTTP transport + version parity

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Ticket: [#35](https://github.com/waxiangzi/opencodex/issues/35) (spec #5)

## Scope discipline

This ticket adds a second CLI binary without moving the TypeScript CLI's operator workflow. The Go binary has a deliberately small registry: help, `--version`/`-v`/`version`, `health`, and `ready`. It drives only local unauthenticated identity endpoints. Starts, stops, configuration writes, management routes, wait/retry parity, and the complete command matrix remain owned by TypeScript until later slices; #36 owns the broader parity harness.

## Design decisions

### 1. Package manifest is the development version authority; release injection is authoritative outside a checkout

TypeScript's `printVersion()` reads repository `package.json`. A Go binary built from this checkout walks upward from its current working directory to the same manifest, then prints exactly `opencodex <version>\n`. That makes an ordinary source build match TypeScript immediately (2.42.0 for this ticket) without duplicating a version constant.

Release builds set `main.version` with `-ldflags -X main.version=<package version>`; `OCX_VERSION` exists for controlled packaging environments. Both override the checkout fallback, so a distributed binary does not depend on a nearby source tree. Release tooling must derive that ldflag from the same package manifest used to publish the TypeScript CLI. A missing source manifest and missing injected version deliberately reports `0.0.0`, never a copied, stale package value.

### 2. The command registry is data and parsing is local

`internal/ocxcli.Commands` is the top-level registry used by help and tests. `Run` is injected with streams, runtime-record loading, HTTP client and challenge generation, allowing exact output and exit-code tests without a subprocess. The currently supported `--json` option is intentionally narrow; unknown or misplaced options return sysexits usage code 64 before discovery or HTTP work.

### 3. Local transport first proves process identity, then reads readiness

The CLI reads TypeScript-owned `OPENCODEX_HOME/runtime-port.json`, requiring a valid pid, port and 43-character attestation secret. `health` sends a fresh base64url challenge to `/healthz`, requires `status:"ok"`, `service:"opencodex"`, matching pid/port and verifies the response HMAC over `opencodex-local-management-v1\n<challenge>\n<pid>\n<port>`. It sends no admin token. `ready` first completes that health proof, then accepts `/readyz` only when its status/body pairing, service, version, pid and port match the existing TypeScript readiness contract.

## Proof (as landed)

- Go unit tests cover exact version output, registry shape, usage exit 64, healthy and invalid-attestation paths, and ready JSON output.
- `tests/go-cli-parity.test.ts` builds `cmd/ocx` when Go is available, compares Go and TypeScript version stdout byte-for-byte, then starts a real TypeScript proxy, writes its runtime record, verifies the TypeScript proof independently, and compares Go health identity JSON fields to that proxy. This is the small extension point for #36's command matrix.

## Delivery notes (filled in at close)

- Added `go/cmd/ocx`, `go/internal/ocxcli`, focused Go tests, the first Bun CLI differential, and the Go README capability note.
- Validation: `bun run typecheck`, `bun test tests/go-cli-parity.test.ts`, and `go fmt/vet/build/test ./...` from `go/`.
- Follow-on: #36 should expand differential coverage to the TypeScript CLI's full command and exit/output matrix, including wait and failure semantics.
