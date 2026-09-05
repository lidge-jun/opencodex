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
  binary path; it serves the declared Go-owned management read routes with
  byte-identical HTTP semantics to the in-process TypeScript handlers. Which
  routes are Go-owned is DATA, not code: the ownership markers (and each
  route's volatile-field declaration) live in
  `src/server/management/route-registry.ts`, and the single forwarding branch
  in `src/server/management-api.ts` reads them before asking the sidecar.
- `internal/sidecar` — the handler plus its unit tests. The JSON key order and
  number formatting of each payload are part of the byte contract with the Bun
  differential oracle (`tests/go-sidecar-parity.test.ts`).
- `internal/config` — the shared Go config reader (ticket #16). It parses the
  operator's `config.json` (OPENCODEX_HOME, defaulting to `~/.opencodex`)
  exactly where the TypeScript runtime keeps it, so a Go-served read route
  answers from the real on-disk state; route bodies are pure functions of the
  subsection they read.

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
  this line before registering the route forwarder.
- The migrated route's declared volatile fields are normalised by the
  differential oracle and nothing else is: a later route cannot silently widen
  what parity means. The declaration lives with the route in
  `route-registry.ts`, not here. Today: `GET /api/system/health` declares
  `["pid", "uptime"]` (the sidecar reports its own process values), and
  `GET /api/shadow-call-settings` declares an EMPTY set — its body is a pure
  function of `config.json`, so the oracle compares raw bytes with no
  normalisation at all.

## Config read routes (ticket #16)

`GET /api/shadow-call-settings` is the first config read route served from Go.
The sidecar reads the same `config.json` the TypeScript in-process handler's
config snapshot came from (`internal/config`), then projects the
`shadowCallIntercept` section through the same rules the TS handler applies
(`shadowSourceModels` defaults, trim/non-empty filtering, `sci.model ?? ""`).
The config is read per request; the sidecar carries no state. The in-process
TS handler remains the fallback and the differential oracle, so a default
install and a supervision blip behave byte-identically to a build without Go.
