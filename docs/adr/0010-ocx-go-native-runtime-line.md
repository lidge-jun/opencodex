# `ocx-go`: a native runtime line with no JavaScript or Bun dependency

ADR-0008 reopened Go native work as an incremental sidecar takeover and named
the endpoint "a single static Go binary with a byte-identical HTTP API". ADR-0009
then defined completion as "every oracle-able surface passes its oracle", leaving
a deliberate Bun-dependent list as the accepted end state. Both were written for
the Go binary that wears the legacy identity (`ocx`) and delegates the rest to
the TypeScript lifecycle owner.

That accepted end state does not satisfy the owner's requirement for this line:
the Go runtime must run for end users with no JavaScript, no Bun, no Node, no
checkout, no `OCX_TYPESCRIPT_CLI`, and no runtime delegation of any kind. The
requirement is not a stronger oracle; it is a different product identity.

## Decision

Build a separate, permanently named Go-native runtime line.

1. **Identity.** The Go-native command is `ocx-go`, permanently. The legacy
   JavaScript/Bun line keeps `ocx`/`opencodex`. Neither shadows, symlinks, PATH-
   overrides, downloads, wraps, or replaces the other. Every Go-native
   user-copyable string — commands, service units, launchers, help, errors,
   capabilities, docs, fixtures — says `ocx-go`; legacy texts keep `ocx`.
2. **No delegation.** `ocx-go` never uses the legacy delegation seam, never
   spawns Bun/Node/TypeScript, and never requires a checkout. `DelegateToTypeScript`,
   `OCX_TYPESCRIPT_CLI`, and `OCX_BUN` are unreachable from `ocx-go`.
3. **Native unsupported.** An unavailable public surface is an explicit
   `ocx-go` result: exit `69` (`EX_UNAVAILABLE`) plus a stable machine-readable
   `go_runtime_unsupported`-family code. It never instructs the user to install
   Bun or the legacy owner.
4. **Migration ledger.** A machine-readable Go-native ledger is the single
   source of truth for every surface's support state, driving
   `capabilities --json`, help, the dashboard capability view, and docs. Each
   unsupported entry records target native behavior, platform range, stable
   unsupported code, oracle shape, migration milestone, and acceptance criteria.
   No ledger entry authorizes delegation. This supersedes ADR-0009's
   `deferredSurfaces` model and its "Bun-dependent list is the accepted end
   state" reading.
5. **Complete command surface is still visible.** `ocx-go` help and capabilities
   list the full public surface with `supported`/`unsupported` status, platform
   support, unsupported code, and migration milestone, so automation never has to
   probe.

## Runtime shape (first delivery: the core preview)

- **State root** `~/.ocx-go` (`OCX_GO_HOME`), separate from legacy
  `~/.opencodex`. Same legacy top-level JSON schema, including `config.port`;
  default `10101`; `--port` overrides one launch only.
- **Owner-tagged runtime records.** The runtime record carries owner
  (`ocx-go` vs `ocx`), PID, port, attestation, and the per-runtime admission
  token. No automatic cross-line takeover or termination; transfer is an
  explicit, preview-and-revalidate handoff.
- **Admission.** Each `start` mints a high-entropy admission token held only in
  the private runtime record. The `ocx-go` launchers inject it into the three
  supported clients for the child's lifetime only; it is never persisted into
  client config, shell, URL, logs, or HTML. Non-matching bearers are rejected
  and never forwarded upstream.
- **Data plane.** Public surface is admission-protected `POST /v1/responses`
  and `GET /v1/models` only. The first adapters are `openai-responses`, `azure`,
  `azure-openai`, and `openai-chat`, key-auth only; routing is the provable
  subset (exact `defaultModel`/`models` match, no namespace guessing, duplicate
  or unregistered models fail closed). Other adapters/auth/routing surfaces fail
  closed with stable unsupported codes.
- **No legacy bridge.** The sidecar bridge and its internal `RequestToken`/
  `BridgeToken` are internal to the legacy topology and are never exposed or
  reused as a standalone public admission path.
- **Dashboard.** Server-rendered HTML/forms with **no JavaScript**, reached via a
  one-time `ocx-go gui` bootstrap URL, a non-persistent HttpOnly/SameSite session,
  CSRF on writes, and a short-lived single-use challenge for high-impact
  operations. "Complete dashboard" is claimed only when every declared page and
  management capability is native; until then a core preview exposes real
  supported routes plus a migration-ledger capability view and never presents
  placeholder pages.
- **Privacy.** Default request records are metadata-only (route/provider/model,
  status, timing, usage, stable codes); prompt text, tool arguments, credentials,
  auth headers, and model output are never logged by default.
- **Build.** The `ocx-go` artifact builds, tests, and packages with Go alone —
  no Bun/Node on the build path. Releases publish SHA-256 plus a signed
  provenance/attestation. There is no self-update in the preview; upgrades are an
  explicit, verified manual step.

## Platform contract

Linux is the first runtime-verified platform. macOS ships as `supported`; its
build is verification-gated, and release notes/capabilities must state plainly
that only Linux has executed runtime E2E while macOS is build/format verified.
Windows is deferred: its unsupported surfaces return native unsupported, never a
fallback.

## Consequences

- ADR-0009's Bun-dependent list is no longer an accepted `ocx-go` end state; it
  becomes the migration ledger's initial unsupported set.
- The compatibility `ocx` binary's legacy delegation behavior is unaffected and
  out of scope; `ocx-go` is a distinct artifact.
- The prior status of "Go binary is the release runtime" (ADR-0008 update) holds
  for the legacy identity; `ocx-go` is a separate release channel.
- Every future flip moves a ledger entry to `supported` (or removes it) only
  with its acceptance evidence; the ledger is designed to reach zero.

**Status**: accepted — supersedes ADR-0009's completion definition and
Bun-dependent end state for the `ocx-go` line. ADR-0008's incremental-takeover
narrative remains the historical record of the legacy Go binary.
