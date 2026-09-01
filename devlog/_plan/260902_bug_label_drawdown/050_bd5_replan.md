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

