# Grill record — `ocx-go` native runtime line (no JS/Bun)

Date: 2026-09-09 (continues past the first fork-release-line seat)
Status: **decided — governance/spec phase** (implementation not started)

## What was grilled

A multi-round design tree forced by the owner goal: *"按完全不依赖于 js,bun 的
运行来确认，且要彻底解掉依赖"* — the Go runtime must run for end users with no
JS, Bun, Node, checkout, `OCX_TYPESCRIPT_CLI`, or TypeScript lifecycle owner, and
the dependencies must be *fully* removed rather than kept as an accepted boundary.

The first fork-release-line seat (see `260909_go_fork_release_line/000_grill_record.md`)
had established the fork as the main line and produced a first artifact + dogfood
switch. This seat asked what the *independent Go runtime* is, precisely.

## Facts the tree rested on (verified, not assumed)

- **F1** — Standalone `ocx start` wires `sidecar.NewHandler` without
  `RequestToken`, so `POST /v1/responses` 404s (`go/internal/sidecar/hotpath.go`
  `dataPlaneSeam`); `/api/usage`, `/api/provider-quotas`, Lab reads, signed writes
  also 404. This is a gap, not a Bun fallback.
- **F2** — Go direct relay supports only `openai-responses`/`azure`/`azure-openai`
  with `authMode=key`; `openai-chat` and every other adapter fall to the bridge
  (`go/internal/sidecar/hotpath_relay.go`).
- **F3** — Full `ocx sync` delegates to TypeScript (`runSyncDelegate`,
  `go/internal/ocxcli/sync_command.go`); Go only writes `models_cache.json`
  natively and reads/journal-restores Codex config.
- **F4** — Codex injection is a transaction: `config.toml`, profile, catalog,
  immutable backups, journal, ownership markers, a write lock, and compensation
  (`src/codex/inject.ts`, `internal/catalog-writer.ts`). Not "one TOML line".
- **F5** — The dashboard is ~70,650 lines of React/TypeScript across 255 files
  calling ~215 management routes (122 mutating), including credential, OAuth,
  Codex/Claude integration, storage, logs, and Lab surfaces.
- **F6** — The owner's E2E target is a local gateway at `http://127.0.0.1:20100`
  with cheap model `tencent/glm-5.3-flash`, whose current local config uses
  adapter `openai-chat` (so it was never covered by the responses-family relay).
- **F7** — Cross-line shared state is the risk: Codex's `~/.codex/config.toml`
  is an external client file both lines may route.
- **F8** — `provider-registry-parity` and `go-*` tests pin current behavior; the
  Go CLI registry is 42 Go-owned / 10 legacy-owned through the delegation seam.

## Decision tree — owner rulings (this seat)

Identity and release
1. `ocx-go` is the permanent Go-native command; legacy keeps `ocx` (no shadowing).
2. An all-Go-native artifact: build, test, package with **no JS/Bun/Node**; ship
   `ocx-go-<os>-<arch>`; checksum + signed provenance; **no self-update** in preview.
3. Linux = runtime-verified; macOS = **`supported`** but release notes must state
   it is build/format verified only; Windows deferred, native unsupported.

State, config, and secrets
4. Independent `~/.ocx-go` (`OCX_GO_HOME`) with the legacy top-level JSON schema and
   `config.port`; default `10101`; `--port` overrides one launch.
5. Owner-tagged runtime records; explicit preview-and-revalidate handoff; never
   auto-take-over or auto-terminate another runtime.
6. literal key: private perms (0700 dir / 0600 files), fail closed if perms cannot
   be established; env-reference stores only the variable name.
7. Private-network upstreams denied unless the provider explicitly sets
   `allowPrivateNetwork`; request, `provider test`, and opt-in E2E share one
   destination policy.
8. Config is validated in full before write; invalid candidate writes nothing and
   keeps the last valid snapshot; running requests use an immutable per-request
   snapshot.

Data plane
9. Public surface is admission-protected `POST /v1/responses` and `GET /v1/models`
   only; `/v1/chat/completions` is not public; upstream `openai-chat` is an
   upstream wire, not a public API.
10. First adapters: the three responses-family plus `openai-chat`, key-auth;
    duplicate or unregistered models fail closed; no namespace guessing.
11. `previous_response_id`: bounded in-memory state bound to the admission-token
    generation; only a completed canonical `done` becomes continuable; restart/
    eviction returns a stable unavailable code.
12. Multi-key: config order, rotate **only** on header-stage HTTP 429, runtime-memory
    cooldown from a bounded standard `Retry-After`; SSE may retry once before the
    first client event and never replays a visible turn.
13. Client-visible errors are generic and non-leaking; requests are logged
    metadata-only by default.

Clients and Codex
14. Admission token reaches the three clients only through an `ocx-go` launcher,
    for the child's lifetime; direct manual clients get a stable failure/guidance.
15. Codex route injection: loopback Design B only for the first delivery; a
    handoff/apply requires proving all runtimes stopped; complex or unknown TOML
    is preserved untouched with a stable conflict.
16. `ocx-go codex` may self-inject only when its own proxy is not running (static
    transaction, then start proxy and wait ready, then start the client).

Dashboard
17. Zero-JavaScript server-rendered HTML; one-time `gui` bootstrap; non-persistent
    session that ends on runtime restart or explicit revoke; CSRF; short-lived
    single-use challenge for high-impact operations; credentials write-only.
18. "Complete dashboard" only when every declared page/capability is native;
    otherwise a core preview shows real routes plus a ledger capability view.

Governance
19. A machine-readable migration ledger replaces ADR-0009's deferral model as the
    single source of truth for support state.

## Deliverables of this seat

- `docs/adr/0010-ocx-go-native-runtime-line.md` — the governing decision.
- `CONTEXT.md` — glossary rewritten to the `ocx-go`/no-delegation model.
- `devlog/_plan/260909_ocx_go_native_line/010_migration_ledger_spec.md` —
  ledger schema and initial entries.
- `devlog/_plan/260909_ocx_go_native_line/020_core_preview_spec.md` — the first
  implementation slice and its acceptance matrix.

## Not yet decided

- `ocx-go` version-line policy vs the legacy npm version cadence.
- Whether to unify the CLI `go_runtime_unsupported` and HTTP
  `standalone_go_unsupported` vocabularies into one cross-surface code set.
- Windows native-unsupported response shapes.
- Documentation/translation scope for the new line.
- Upstream-donation maturity test.
