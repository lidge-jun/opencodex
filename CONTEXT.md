# OpenCodex Go Takeover

OpenCodex maintains a legacy Bun/TypeScript `ocx` line and is building the separate `ocx-go` Go-native runtime line. `ocx-go` is a self-contained static binary with no user-runtime dependency on JavaScript, Bun, Node, a checkout, or TypeScript delegation. This context covers the language of that migration: ownership, native capability states, migration ledgers, oracles, and release evidence.

## Language

### Ownership and the flip

**Go-native owned** / **legacy-owned**:
A surface is Go-native owned when `ocx-go` implements it without launching Bun, Node, TypeScript, a checkout, or the delegation seam. A legacy-owned surface belongs to `ocx`; it may remain available there, but `ocx-go` reports it as native unsupported until the Go-native migration ledger marks it supported.
_Avoid_: TypeScript-owned (wrongly suggests `ocx-go` may delegate), native (overloaded), migrated (implies a state reached without acceptance evidence).

**Surface**:
One executable face — a top-level command name, or a verb/sub-command inside a family.
_Avoid_: command (ambiguous between the surface and its implementation).

**Family**:
A group of commands that migrate as one batch (e.g. launchers, lifecycle, management reads).
_Avoid_: group, area.

**Flip**:
Moving one surface from TypeScript-owned to Go-owned, shipped as one batch with its oracle rows; the flip deletes the surface's deferral entry.
_Avoid_: port (a rewrite), migrate (whole-program drift).

**Native unsupported**:
The explicit `ocx-go` result for an unimplemented public surface: exit `69` (`EX_UNAVAILABLE`) plus a stable machine-readable `go_runtime_unsupported`-family code and migration-ledger reference. It never launches a legacy runtime.
_Avoid_: delegation, fallback, install Bun (all imply a forbidden escape path).

**Migration ledger**:
The machine-readable single source of truth for every `ocx-go` surface's support state. Each unsupported entry records its target native behavior, platform range, stable unsupported code, oracle shape, migration milestone, and acceptance criteria. It drives `capabilities --json`, help, the zero-JS dashboard capability page, and documentation; an entry becomes supported or is removed only after acceptance evidence.
_Avoid_: deferral, TODO, debt (none expresses the mandatory no-delegation contract).

**Legacy delegation seam**:
The mechanism by which the legacy Go compatibility binary invokes a TypeScript lifecycle owner. It is not reachable from `ocx-go` and is not part of its end state.
_Avoid_: fallback (implies failure), shim (a different wrapper concept).

### Oracles (ADR-0009)

**Oracle**:
The evidence that the Go and TypeScript implementations are equivalent for a surface — the gate a flip must pass. Never replaced by one-sided tests.
_Avoid_: test, coverage (equivalence evidence, not pass/fail of one side).

**T1 byte parity**:
Oracle by diffing stdout/stderr/exit code over identical argv against the same environment — the original and default form.
_Avoid_: "parity" alone (ambiguous with the masked form).

**T2 masked parity**:
Oracle run in the same wall-clock window, with explicitly declared volatile fields masked — never an ad-hoc mask list.

**T3 golden fixture**:
Oracle against offline stubs — a stubbed server, a fixed seeded home, a pinned catalog, a stubbed release endpoint.

**T4 platform lane**:
Oracle per operating system (systemd / launchd / Windows), each lane its own environment.

**T5 interactive subset**:
Oracle over only the non-interactive branches of an interactive command; the interactive branches stay on the Bun-dependent surface.

**Volatile field**:
A field that legitimately differs between two equivalent runs and must be masked (T2) or declared non-deterministic. Declared where the oracle is, never silently.
_Avoid_: noise field (implies ignorable).

### End state

**Batch**:
One flip shipped as a unit — surface-map flip in cli.go + native dispatch + help + parity rows, in one commit (the #45–#54 pattern).
_Avoid_: PR-size, commit (batches are semantic units, not size buckets).

**Standalone**:
A self-contained Go artifact that needs no JavaScript, Bun, Node, checkout, `OCX_TYPESCRIPT_CLI`, or runtime delegation. For `ocx-go`, an unavailable surface is explicitly native unsupported and tracked in the migration ledger; it is never an accepted Bun-dependent endpoint.
_Avoid_: complete, done (both imply a state this repo defines precisely instead of assuming).

**Core preview**:
An `ocx-go` release stage that is safe and daily-use capable for the declared Codex, Claude, and OpenCode core closure, but does not claim a complete dashboard. It exposes only actually supported zero-JS dashboard routes plus the migration-ledger capability view.
_Avoid_: complete dashboard, fully migrated.

**Complete dashboard**:
The point at which every declared dashboard page and management capability is implemented natively as server-rendered zero-JavaScript HTML, with its session, CSRF, confirmation, and acceptance evidence. It must not be claimed merely because a static SPA is embedded or because unsupported pages are shown as placeholders.
_Avoid_: embedded UI, page shell.

**Legacy Bun-dependent surface**:
A capability that remains available only on legacy `ocx` while awaiting its `ocx-go` migration ledger acceptance. It is not an accepted `ocx-go` end state and never authorizes runtime delegation.
_Avoid_: leftovers, exceptions (both imply small or undesirable).

**Admission token**:
A fresh, high-entropy per-runtime credential authorizing a local client to use `ocx-go`'s public data plane. It is private runtime state, rotates on every start and explicit rotation, and is consumed rather than forwarded when invalid. It is distinct from a dashboard session and from an upstream provider credential.
_Avoid_: API key (ambiguous with an upstream provider key), shared secret (does not express the runtime lifetime).

**Dashboard session**:
A browser-local, non-persistent management principal minted only by a one-time `ocx-go gui` bootstrap. It is protected by HttpOnly/SameSite cookie and CSRF controls, ends on runtime restart or explicit revocation, and still requires a separate one-time confirmation for high-impact operations.
_Avoid_: dashboard token (suggests it is displayed or reusable as a bearer credential).

**Configuration snapshot**:
The fully validated immutable provider/routing configuration chosen at the beginning of one request. Configuration writes replace the persisted snapshot atomically; a malformed candidate cannot partially affect requests already in flight or replace the last known valid snapshot.
_Avoid_: live config (implies mutable shared state), in-place reload.

**Configuration-derived catalog**:
The offline model catalog projected solely from the persisted `ocx-go` configuration. It is deterministic and does not probe provider endpoints; explicit provider tests and opt-in release probes are separate operations.
_Avoid_: discovery (implies an endpoint request).

**Codex handoff**:
The explicit, preview-first transfer of shared `CODEX_HOME` routing ownership from a legacy or otherwise identified state to `ocx-go`. Apply revalidates all observed ownership evidence and refuses on change; it never auto-takes over or auto-terminates another runtime.
_Avoid_: auto migration, takeover.

**Runtime response state**:
The bounded, in-memory `ocx-go` state needed to continue a standard Responses turn across `previous_response_id`, including tool-call continuity. It belongs to exactly one running runtime, is never delegated or silently reconstructed, and becomes explicitly unrecoverable after restart.
_Avoid_: persistent history (implies cross-restart storage), bridge state (implies a legacy owner).

**Metadata-only request record**:
The default privacy-preserving record of a proxied request: route/provider/model identifiers, status, timing, token/usage counts, and stable error codes, but never prompt text, tool arguments, credentials, authorization headers, or complete model output. Content capture is a separate opt-in capability with its own retention and acceptance criteria.
_Avoid_: request log (ambiguous about content retention), safe logging (not a concrete data boundary).

**Runtime key scheduler**:
The deterministic, bounded per-runtime selector for a key-auth provider's ordered `apiKeys`: it uses the first currently available key and only reacts to an upstream header-stage HTTP 429 by cooling that key and choosing the next available key. Cooldowns live only in runtime memory, derive from a bounded standard `Retry-After` policy, and are never inferred from provider body text. A streaming turn can retry once only before it has emitted any client event; it never replays an already-visible turn.
_Avoid_: load balancer, account pool (both imply unsupported scheduling semantics).

**Static release identity**:
The immutable identity carried by a standalone artifact: its version and runtime source. It is defined at build time (or as the explicit `dev` identity for an unversioned development build) and cannot be overridden at runtime; it is never inferred from the working directory, a checkout, Bun, environment variables, or installation layout. The Go artifact ignores Bun runtime markers. `dev` is observable but is not comparable with release versions: a version-skew comparison with `dev` on either side never diagnoses a mismatch. Its runtime path names the resolved artifact, or `unknown` when the platform cannot resolve it. It varies by actual artifact without changing the shared status JSON shape or schema version.
_Avoid_: runtime detection, package discovery (both describe environment-dependent observations, not artifact identity).
