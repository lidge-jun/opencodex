# OpenCodex Go Takeover

OpenCodex is migrating its CLI and server from Bun/TypeScript to a single static Go binary (ADR-0008), surface by surface, each proven by a differential oracle. This context covers the language of that migration: ownership, flips, the delegation seam, oracles, and the accepted end state.

## Language

### Ownership and the flip

**Go-owned** / **TypeScript-owned**:
A command surface is owned by whichever implementation dispatches it. Go-owned surfaces live in `go/internal/ocxcli` and pass an oracle; TypeScript-owned surfaces delegate through the seam. The `Commands` table `Owner` field is the single source of truth.
_Avoid_: native (overloaded), migrated (implies a state reached without an oracle).

**Surface**:
One executable face — a top-level command name, or a verb/sub-command inside a family.
_Avoid_: command (ambiguous between the surface and its implementation).

**Family**:
A group of commands that migrate as one batch (e.g. launchers, lifecycle, management reads).
_Avoid_: group, area.

**Flip**:
Moving one surface from TypeScript-owned to Go-owned, shipped as one batch with its oracle rows; the flip deletes the surface's deferral entry.
_Avoid_: port (a rewrite), migrate (whole-program drift).

**Delegation seam**:
The mechanism that runs a TypeScript-owned surface from the Go binary (`DelegateToTypeScript`, `go/internal/ocxcli/delegate.go`). The ledger `deferredSurfaces` (`deferral.go`, issue #55) records every delegated surface with its reason and track.
_Avoid_: fallback (implies failure), shim (a different wrapper concept).

**Deferral**:
An explicitly recorded TypeScript-owned surface in `deferredSurfaces` carrying a reason (why no oracle exists yet) and a track (the ticket or boundary record that lifts it). A deferral with no track is either platform-bound or awaiting an oracle.
_Avoid_: TODO, debt (both imply accident; deferrals are deliberate).

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
The single Go binary that needs no Bun or checkout. Under ADR-0009 the meaning is precise: every oracle-able surface is Go-owned; the rest are an explicit Bun-dependent list.
_Avoid_: complete, done (both imply a state this repo defines precisely instead of assuming).

**Static release identity**:
The immutable identity carried by a standalone artifact: its version and runtime source. It is defined at build time (or as the explicit `dev` identity for an unversioned development build) and cannot be overridden at runtime; it is never inferred from the working directory, a checkout, Bun, environment variables, or installation layout. The Go artifact ignores Bun runtime markers. `dev` is observable but is not comparable with release versions: a version-skew comparison with `dev` on either side never diagnoses a mismatch. Its runtime path names the resolved artifact, or `unknown` when the platform cannot resolve it. It varies by actual artifact without changing the shared status JSON shape or schema version.
_Avoid_: runtime detection, package discovery (both describe environment-dependent observations, not artifact identity).

**Bun-dependent surface**:
A surface that deliberately keeps the TypeScript owner in the end state — interactive OAuth, OS service managers, Windows tray, network self-replace, coordinator transactions. Recorded per-surface; never a default category.
_Avoid_: leftovers, exceptions (both imply small or undesirable).
