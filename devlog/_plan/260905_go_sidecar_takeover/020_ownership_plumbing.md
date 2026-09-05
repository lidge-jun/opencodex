# 020 — Ticket #14 delivered: read/write ownership split + batch-migration plumbing

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: implemented on `dev-go`
Tickets: [#8](https://github.com/waxiangzi/opencodex/issues/8) (1.1) →
[#10](https://github.com/waxiangzi/opencodex/issues/10) (1.2) /
[#11](https://github.com/waxiangzi/opencodex/issues/11) (1.3) →
[#12](https://github.com/waxiangzi/opencodex/issues/12) (1.4) →
[#13](https://github.com/waxiangzi/opencodex/issues/13) (1.5) →
[#14](https://github.com/waxiangzi/opencodex/issues/14) (2.1)
Parent specs: [#1](https://github.com/waxiangzi/opencodex/issues/1) (increment 1),
[#2](https://github.com/waxiangzi/opencodex/issues/2) (increment 2)

## What this run delivered

The critical path was walked in dependency order. Increment 1 (#8 → #10 ∥ #11 →
#12 → #13) already sat on `dev-go` (commit `4b8715a30` + follow-ups); this run
audited each acceptance criterion against the tree, closed the two gaps that
were still machine-unproven, and then implemented ticket #14 — the first
increment-2 ticket, which generalises the one-route seam into the plumbing the
read-surface batches will use.

### #8 (1.1) gap closed: cross-platform build is now a CI gate

The Go job already ran `go build/vet/test`, but only on the runner's native
platform. #8's acceptance — "builds CGO_ENABLED=0 on every release target" —
needed a proof. The `go` job in `.github/workflows/ci.yml` now loops the six
release targets (`linux/darwin/windows` × `amd64/arm64`) with `CGO_ENABLED=0`
and fails if any combination does not produce a binary. All six build clean
today; a future cgo leak or build-tag mistake surfaces in CI, not at release.

### #11 (1.3) gap closed: crash observability is now machine-checked

#11's "crashes surface via health/status" had been argued in prose (warn log +
in-process fallback) but not proven. The differential oracle now kills the
sidecar child mid-run and asserts the full observable contract: the forwarder
deregisters (base URL goes null) and the next `GET /api/system/health`
answers from the in-process handler with the pid flipped back to the proxy's
own — an observable change on the exact route the sidecar was serving, with no
window where health goes unanswered.

### #14 (2.1): typed read/write ownership + single registry-driven branch

Ticket #14's three acceptance criteria, and how each is met:

- **Write routes cannot be marked Go-owned by mistake.** `ManagementRoute` in
  `src/server/management/route-registry.ts` is now a discriminated union: the
  write arm (`mutates: true`) has no `go` marker and the read arm
  (`mutates: false`) carries an optional `GoOwnedRouteDeclaration`. Writing
  `go:` onto a write route is a compile error. A runtime re-check in
  `tests/go-ownership-plumbing.test.ts` re-derives the marker set from
  `MANAGEMENT_ROUTES` and compares it with the exported
  `GO_OWNED_MANAGEMENT_ROUTES`, so a cast or array-level workaround cannot
  drift.

- **Migrating a read route is a marker flip, not dispatch edits.** The bespoke
  health forwarder call is gone from `system-routes.ts`. Dispatch now has ONE
  branch, at the head of `handleManagementAPI`, that looks the request up in
  the declared Go-owned surface (`findGoOwnedManagementRoute`) and only then
  asks the optional-subsystem slot (`go-sidecar-slot.ts`, generalized from a
  health forwarder to a route forwarder) to relay it. The Go-owned surface is
  derived DATA (`GO_OWNED_MANAGEMENT_ROUTES`); the branch names no route, and a
  test pins that `management-api.ts` contains no management-path literal in the
  forwarding path. The next read route migrates by flipping its marker plus a
  Go handler plus oracle coverage — no second dispatch edit exists to write.

- **Per-route volatile declarations supported.** Each Go-owned route declares
  its volatile fields in the registry (`health` declares `["pid","uptime"]`).
  The differential oracle consumes the declaration instead of a mirrored
  constant in `go-sidecar.ts`, so the oracle normalises exactly the declared
  set and a later route cannot silently widen what parity means. The harness
  also pins that the declared Go-owned surface is exactly health today, so an
  accidental flip fails loudly.

Fallback semantics are unchanged end to end: forwarder absent (default
install), returning `null`, or throwing → the in-process handler answers,
byte-identically to a build without Go. The in-process handler remains the
differential oracle.

## Files

- `src/server/management/route-registry.ts` — typed read/write ownership,
  `GO_OWNED_MANAGEMENT_ROUTES`, `findGoOwnedManagementRoute`.
- `src/server/go-sidecar-slot.ts` — generalized core-owned forwarder slot.
- `src/server/go-sidecar.ts` — supervisor registers the generic forwarder.
- `src/server/management-api.ts` — the single forwarding branch.
- `src/server/management/system-routes.ts` — health back to pure in-process
  fallback/oracle.
- `tests/go-ownership-plumbing.test.ts` — new: registry invariants + dispatch
  behaviour with a fake forwarder (no Go toolchain needed).
- `tests/go-sidecar-parity.test.ts` — registry-driven normalisation; crash
  fallback oracle (#11).
- `.github/workflows/ci.yml` — cross-platform build gate (#8).
- `go/README.md` — ownership marker contract.

## Verification

- `bun run typecheck` green.
- `tests/go-ownership-plumbing.test.ts` (9 pass), `tests/go-sidecar-parity.test.ts`
  (4 pass, incl. crash fallback), `management-route-registry`, `core-lab-boundary`,
  `ci-workflows`, `repo-hygiene`, `cli-capabilities`, `route-explainability`,
  `skill-ocx` all green.
- `go build ./...` / `go vet ./...` / `go test ./...` green under `go/`;
  all six release-target cross-compiles succeed with `CGO_ENABLED=0`.

## Next on the path

Spec #2 (increment 2) migrates the read-only management surface in batches:
system memory, models, providers, usage, quotas, config, catalog. Each batch
route flips its marker in the registry, gains a Go handler in
`go/cmd/ocx-sidecar`, and joins the registry-driven oracle. The plumbing to do
that without re-proving the seam is what ticket #14 established.
