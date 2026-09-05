# Go sidecar — ADR-0008 incremental takeover, first increment

A fresh Go module under the nested `go/` tree (module
`github.com/lidge-jun/opencodex/go`), per
[`docs/adr/0008-go-runtime-incremental-takeover.md`](../docs/adr/0008-go-runtime-incremental-takeover.md)
and the first-increment plan in
[`devlog/_plan/260905_go_sidecar_takeover/`](../devlog/_plan/260905_go_sidecar_takeover/).

Nothing here is copied from `archive/dev2-go`; that archive is reference
material only. This is a fresh codebase.

## What lives here

- `cmd/ocx-sidecar` — the sidecar binary. The TypeScript server spawns and
  supervises it when the operator sets `OPENCODEX_GO_SIDECAR_BIN` to a built
  binary path; it serves exactly one read-only management route,
  `GET /api/system/health`, with byte-identical HTTP semantics to the
  in-process TypeScript handler (see `src/server/go-sidecar.ts`).
- `internal/sidecar` — the handler plus its unit tests. The JSON key order and
  number formatting in the health payload are part of the byte contract with
  the Bun differential oracle (`tests/go-sidecar-parity.test.ts`).

## Building

```bash
go -C go build ./cmd/ocx-sidecar
go -C go vet ./...
go -C go test ./...
```

The differential harness builds the binary itself with `CGO_ENABLED=0`; CI
does the same (the `go` job in `.github/workflows/ci.yml`). The module has no
external dependencies, so there is no `go.sum`.

## Wire contract with the TypeScript parent

- The parent passes the installed package version in `OCX_SIDECAR_VERSION`;
  the sidecar reports it verbatim as the `version` field (fallback `0.0.0`).
- After binding its loopback listener, the sidecar prints one readiness line on
  stdout: `ocx-sidecar-ready http://127.0.0.1:<port>`. The parent waits for
  this line before forwarding the health route.
- `status`, `service`, and `version` must equal the TypeScript values;
  `uptime` and `pid` are the sidecar's own process values. The differential
  harness normalises exactly `pid` and `uptime` (declared in
  `src/server/go-sidecar.ts`) and compares everything else byte-for-byte.
