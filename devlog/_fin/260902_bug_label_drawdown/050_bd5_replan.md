# 050 — bd5 replan: one issue per cycle

## Why this doc exists

Batches A through D bundled multiple pull requests into one PABCD cycle each. That was
wrong under the one-work-phase-one-cycle invariant, and it made the work hard to follow:
four merges landed inside a single B with one attest covering all of them.

The remaining nine bug issues are re-registered as **nine separate work-phases**, one issue
each, in dependency order. Batch E and Batch F as bundles are retired.

| WP | Issue | Why this order |
|----|-------|----------------|
| i3141 | #3141 responses-state write amplification | evidence already gathered |
| i3152 | #3152 dashboard log panel jitter | adjacent to the landed #3174 responsive work |
| i3136 | #3136 CommandCode cost recording | narrow provider-metadata question |
| i3150 | #3150 citation markers leak to TUI | provider-compatibility, needs a repro read |
| i3155 | #3155 Business Premium Seat coverage | entitlement surface |
| i1419 | #1419 bundled Bun SIGTRAP | oldest; runtime floor moved since |
| i2999 | #2999 native-main publication race | the half #3112 did NOT close |
| i2813 | #2813 gpt-reserve disables routed models | account-pool behavior |
| i1527 | #1527 Cursor adapter large-context collapse | hardest; adapter vs direct divergence |

Each cycle: P re-reads the issue against the current tree, A audits the disposition, B does
the one fix or writes the one closure, C verifies it, D closes. No cycle handles two issues.

## bd5 disposition

This work-phase is closed as the **replan itself**. The five needs-info issues it originally
bundled are now i3141, i3136, i3150, i3155, and i1419.

Nothing was closed under the bundled Batch E, so no disposition is lost.

## bd6 disposition

Identical treatment. Batch F bundled #3152, #3170, #2999, #2813, and #1527; those are now
i3152, i2999, i2813, and i1527 — four rather than five, because **#3170 already closed** in
bd1 via #3177 (`0d6424f8`).

Both bundles are retired. Every remaining issue owns exactly one work-phase.

## Evidence already gathered for i3141, carried forward

The first per-issue cycle does not start cold. Reading #3141 against HEAD before the replan
turned up the following, which i3141's P should re-verify rather than rediscover:

- The reported path still exists: `src/responses/state.ts:1127` returns
  `join(getConfigDir(), "responses-state.json")`. The spill *directory*
  (`RESPONSE_SPILL_DIR_NAME`, `spill-store.ts:33`) is a separate mechanism, so the triage
  comment's "single json vs spill dir" question resolves as: the single file is still there.
- Write amplification is already bounded. `snapshotDebounceMs()`
  (`src/responses/state.ts:1561`) scales the debounce linearly with the last snapshot size
  from a 1 MiB floor, clamped at 30 s, and its comment names the exact failure the issue
  describes: *"at the 24 MiB bound a fixed 2 s debounce is up to ~12 MB/s of write
  amplification for state nothing reads until the next start (#2460)"*.
- A byte-identical snapshot is skipped entirely (`lastSnapshotDigest`, around line 1521).
- Both landed in `02c302a54`, *"fix(responses): stop rewriting an unchanged snapshot every
  two seconds (#2476)"*, dated 2026-08-25, when `package.json` read **2.32.0**.

#3141 reports **2.33.0**, which is *after* that commit — so the fix was present in the
reported version and the disposition is not a simple "already fixed". i3141 has to establish
whether 2.33.0 shipped it, and if it did, what remains unexplained.
