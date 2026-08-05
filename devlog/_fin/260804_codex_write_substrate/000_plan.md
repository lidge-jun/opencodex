# A Codex write path that can be safely interrupted

The prerequisite three integration switches are blocked on.

## Why this unit exists

`../260803_codex_desktop_toggle/` shipped two deliverables and proved the switch
itself is cheap: `ocx restore` already returns Codex to its native path without
stopping the proxy. Then two audit rounds on the durable-OFF flag failed, and the
diagnosis in that unit's `008_audit_synthesis_wp4_r2.md` was not the flag:

> Codex's write path was never designed to be interrupted.

Every attempt to add "check the flag before writing" hit the same wall. A check
is not a lock; the catalog refresh cannot be split around one; the history write
would freeze the proxy for every other client if a lock were held across it; and
the ownership guard that was supposed to protect a foreign home fails open, after
the artifacts it guards have already been created.

So this unit builds the substrate.

**What it ships, stated honestly** (audit #12 caught the earlier claim that this
unit "ships no switch", which was false): it ships the persisted config field
`clientIntegrations.codex` and the convergence semantics that obey it. It does
NOT ship the management setter or any GUI control. A user could set the field by
hand; nothing in the product offers it yet. The switch surfaces
(`WP5` Codex UI, `WP6` Grok, `WP7` Desktop in the prior unit) become small once
this exists.

## The phases

**Re-planned after audit round 1** (`006_audit_synthesis.md`). The first map had
four parallel authors and no owner for the surfaces they share, so they collided
on four of them: the `integrations/codex.json` record, the `/api/sync` contract,
the convergence entry point, and the module name. That is the same defect the
prior unit had at smaller scale, and I reproduced it.

So a contract phase lands first and owns every shared surface. The rest consume
it rather than inventing their share.

| Phase | Doc | Delivers | Depends on |
|---|---|---|---|
| WP8b | `005_contract.md` | The shared surfaces: record schema + owner, `/api/sync` response contract, the single convergence entry point, generation counters, module names, and the config-snapshot admission result | — |
| WP9 | `010_catalog_seam.md` | gather/commit split + typed outcome, consuming the contract | WP8b |
| WP10 | `020_history_isolation.md` | history off the event loop, and the cross-process history protocol | WP8b |
| ~~WP11~~ | `030_lock_protocol.md` | **merged into WP12** — the lock has exactly one consumer, and the `AdmissionSnapshot` producer plus the `inject.ts` split that its API needs both live there | — |
| WP12 | `040_ownership_convergence.md` + `030_lock_protocol.md` | the async per-home lock and per-USER namespace **with its first production caller**, plus tri-state authority, admission order, absence restoration | WP8b, WP9, WP10 |
| WP13 | `050_composed_acceptance.md` | one acceptance suite against real production entry points | all |

WP9 and WP10 remain independent of each other and both precede the lock: a lock
around an unsplittable gather-and-write, or around a ten-second blocking history
call, is the failure the last unit already proved. WP12 stays last of the four
because its admission must run before the lock module creates anything.

WP13 exists because audit #11 showed the per-phase criteria are provable inside
their own phase and break at the seams — the "8000 green tests beside a broken
real file" class this plan already warns about.

## Research, all written this cycle

- `001_catalog_seam.md` — the gather/commit line drawn through `refresh.ts`, all
  16 management callers traced, and the stale-candidate problem named
- `002_history_off_the_loop.md` — every blocking operation mapped, server-process
  vs CLI-process callers separated, worker isolation + fail-fast recommended
- `003_lock_protocol.md` — async SQLite lock, `acquired | busy | refused`,
  barging-allowed, per-user namespace under the real home, realpathed key
- `004_ownership_and_convergence.md` — four independent vetoes in one admission
  order, provenance by baseline-absence ledger rather than filename, and why
  `unchanged` must still converge

Carried forward from the prior unit: all eleven open findings listed in
`../260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md`. Each is assigned
to a phase in the table above and re-stated in that phase's decade doc.

## Scope boundary

IN: `src/codex/**`, `src/server/management/context.ts` and its callers,
`src/config.ts`, `src/service.ts`, `src/integrations/native/**`, `tests/`,
`docs-site` lifecycle and configuration pages, this unit.

OUT: the GUI switches (they follow once this lands), `gui/**`, releases,
publishing, deploys, tags, npm, starring the repository. The six file clients
remain `FOLLOWUP-FILECLIENT-01` from the prior unit.

## Criteria

- C1 — catalog work gathers outside a lock and commits inside it, and a failure
  is a typed outcome rather than a swallowed exception.
- C2 — a stale candidate cannot be committed: a config or base-catalog revision
  change between gather and commit is detected and refused.
- C3 — a dashboard-initiated OFF never blocks another client. Measured, not
  argued: `/healthz` stays responsive while real SQLite history contention is
  active.
- C4 — history that cannot be resolved is recorded as unresolved and retried,
  never silently reported as success.
- C5 — lock acquisition is async with a finite deadline and returns
  `acquired | busy | refused`; contention is never an exception.
- C6 — two spellings of the same home take the SAME lock; two different homes
  never do. Symlinked, default, explicit and case-differing spellings all tested.
- C7 — the lock namespace is per-user, outside `CODEX_HOME`, and rejects a
  symlinked or wrong-owner path rather than trusting it.
- C8 — automatic convergence refuses on `foreign` AND `unknown` ownership, and
  creates no artifact — no lock file, no database, no journal write — before the
  answer is known.
- C9 — the external-`model_provider` guard survives as an authority distinct from
  service-home ownership.
- C10 — an artifact that did not exist before apply is *removed* only when its
  current bytes match the recorded post-image; current-byte drift is preserved with
  a reported conflict rather than deleted. A hash proves only current equality. It
  cannot prove that no edit-and-revert occurred between observations.
- C11 — `unchanged` desired state still converges observed state.
- C12 — a desired-state change made by another process is honored by the running
  server without a restart.
- C13 — typecheck, full test, gui lint, privacy scan green; no regression in the
  8000-test suite.
- C14 — every one of the 16 management catalog callers goes through the single
  convergence entry point; none can commit catalog bytes bypassing ownership,
  provenance, intent or the lock (audit #2).
- C15 — history is serialized ACROSS processes, including the manifest and
  rollout writes that happen outside its SQLite transaction
  (`history-provider.ts:606,626`). Proven by two processes converging in
  opposite directions, not by a same-process flight test (audit #1).
- C16 — one owner and one schema for `integrations/codex.json`; a record written
  by any phase is readable by every other (audit #3).
- C17 — a cooperating config/native A→B→A transition between gather and commit is
  detected by generation identity, and single-direction target-identity drift is
  detected. This does not promise detection of an arbitrary non-cooperating
  filesystem A→B→A entirely between checks: a hash or equal current bytes cannot
  prove that no edit-and-revert occurred (audit #6).
- C18 — two processes for the same OS user with different `HOME`/`USERPROFILE`
  take the SAME lock (audit #7).

## Risk register

| Risk | Mitigation |
|---|---|
| A lock held across unbounded work freezes the proxy | WP10 lands before WP11; the locked section is synchronous and bounded by construction, and C3 measures it rather than asserting it |
| The substrate becomes a fifth concurrency pattern | `003` catalogues the existing `withConfigMutationLockSync` and `runIntegrationMutationFlight` and states where the new lock deliberately differs |
| Deadlock against the config mutation lock | One stated ordering, plus a proof that no inverse nesting exists today |
| Convergence deletes something the user owns | Provenance is a recorded baseline-absence plus post-image hash, never a filename or marker; on conflict, preservation wins and the operation reports rather than deletes |
| Another round of divergence | One phase, one boundary, one audit. WP2 and WP3 of the prior unit passed clean on exactly that property; WP4 failed twice without it |
| Parallel authors collide on a shared surface | WP8b owns every shared surface and lands first; the rest consume it. Round 1 proved that dispatching four parallel authors without a contract owner reproduces the prior unit's defect at four times the scale |
| A criterion provable only inside its own phase | WP13 re-proves the composed system through real production entry points |

## What this unit does not claim

It does not make Codex's write path transactional. A crash mid-commit still
leaves partial state; what changes is that the partial state is *detectable* and
the next convergence *re-runs* against it. `004` §Artifact inventory is explicit
about which artifacts can be restored to absence and which can only be reported.
