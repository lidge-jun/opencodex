# 010 — Decision: migrate the Compatibility Lab, do not cut it

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: **decided — migrate** (owner, recorded on [ticket #9](https://github.com/waxiangzi/opencodex/issues/9))
Parent spec: [#6 — Migrate the Compatibility Lab to Go (ADR-0008 increment 6)](https://github.com/waxiangzi/opencodex/issues/6)
ADR: [`docs/adr/0008-go-runtime-incremental-takeover.md`](../../../docs/adr/0008-go-runtime-incremental-takeover.md)

## Decision

The Compatibility Lab is **migrated to Go**, not cut. It remains the last surface to move
(ADR-0008 increment 6 per spec #6) and stays behind the same ownership seam, reproducing
its opt-in activation gate and provider slot with byte-identical behavior. Cutting is
recorded as an owner-rejected alternative: the Lab is **not** removed from the single
binary, and no discontinuation documentation will be written.

Ticket #9 asked for an explicit migrate-or-cut decision with a cost-vs-value basis so the
choice is made on evidence rather than defaulted. The evidence is summarized below; the
owner weighed the same evidence and chose migrate.

## Cost-vs-value basis

### Cost (acknowledged, and why it does not decide the outcome)

- `src/lab/` is 117 TypeScript files / ~21.4k LOC of production code, with ~14.5k LOC of
  tests across 58 test files — the largest opt-in subsystem in the tree.
- It is not a thin route layer: SQLite-backed projection/ledger/event stores, a secure
  artifact store, a signed community registry with origin/revocation handling, conformance
  suites, a live sandbox runner with MCP loopback and credential leases, an automation
  scheduler, and a query layer all sit behind the public routes.
- A Go port must reproduce the synchronous, gap-free activation guarantee and the
  core-owned slot contract ([#19](https://github.com/waxiangzi/opencodex/issues/19)),
  then prove byte-identical route behavior under the differential oracle
  ([#33](https://github.com/waxiangzi/opencodex/issues/33)).
- Migrating is strictly more work than cutting. That alone was never the question: the
  question is whether the Lab is a shipped capability worth keeping.

### Value (why migrate wins)

- **The Lab is a shipped, GUI-exposed capability, not an experiment.** The dashboard
  exposes a routing control that requires compatibility evidence
  (`routing.compatibility.enabled`, "require evidence"), a Compatibility Matrix view, a
  Lab section, and i18n strings in several locales. Cutting the Lab would remove that
  control and quietly change routing for every install whose profile is gated on
  compatibility evidence. ADR-0008 states the single-binary endpoint cannot quietly drop
  a documented opt-in surface; the same principle applies before the flip.
- **Routing depends on it.** The compatibility evidence provider feeds the synchronous
  routing assembler (`routeModelInternal`) through the core-owned provider slot. A cut is
  not a UI cleanup — it deletes an evidence source the policy path already consults for
  gated profiles.
- **The seams make migration bounded.** The 2026-07 decoupling campaign
  ([`devlog/_fin/260814_lab_core_decoupling/`](../../_fin/260814_lab_core_decoupling/))
  was expensive precisely because the Lab had leaked into the core import graph. Today the
  activation gate, the passive-route linker, the provider slot, and the optional shutdown
  hooks are first-class core seams, and the boundary is machine-enforced
  (`tests/core-lab-boundary.test.ts`). Porting into those same seams is mechanical where
  it was previously architectural.
- **Independent gating neutralizes the schedule risk.** Lab is increment 6, gated on its
  own terms (spec #6): it cannot block the management read/write surfaces, the hot path,
  the CLI, or the flip (#7), which only needs the Lab batch in a terminal state.
- **Cut still costs.** Cutting would require its own release-note and docs work
  (spec #6 US6), a GUI/i18n removal sweep, and a deprecation window for existing users —
  real work with a permanently lost capability at the end.

## Scope for later Lab tickets

This decision sets the direction for the Lab batch under spec #6:

- [#19 — Lab activation gate + provider-slot in Go](https://github.com/waxiangzi/opencodex/issues/19):
  build, not re-scope. Reproduce the opt-in activation gate and the provider-slot seam in
  Go so the "one provider, no Lab" user still executes no Lab code.
- [#33 — Lab routes migration + differential](https://github.com/waxiangzi/opencodex/issues/33):
  the migrate branch applies — Lab routes go Go-owned and differential-green. No cut
  documentation is to be written.
- The TypeScript Lab remains the operating surface until its batch; no Lab code changes in
  increments 1–5 and no user-visible change before increment 6.

## Revisit

The decision is recorded now so later Lab tickets have a stable reference, but it is not
permanent. Spec #6 requires the porting cost to be estimated against usage before the Lab
batch commits. If adoption evidence collected at that point shows the Lab is effectively
unused, the owner may reopen [ticket #9](https://github.com/waxiangzi/opencodex/issues/9)
and flip this record to cut — the flip (#7) depends only on the Lab batch reaching a
terminal state, so revisiting before the batch starts costs nothing.

## References

- ADR-0008 (go runtime incremental takeover) — Lab "migrates last", explicit cut candidate.
- Spec #6 (ADR-0008 increment 6) — Lab migrate/cut framing and independent gating.
- Tickets #9 (this decision), #19 (activation gate + provider slot in Go), #33 (routes
  migration + differential).
- `devlog/_fin/260814_lab_core_decoupling/` — why the Lab is seam-gated today.
- `tests/core-lab-boundary.test.ts` — the machine-enforced core/Lab boundary.
