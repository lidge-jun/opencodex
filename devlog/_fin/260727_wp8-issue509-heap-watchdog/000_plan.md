# 000 — WP8 Issue #509 Windows memory observability plan

## Objective

Handle Issue #509 only:

https://github.com/lidge-jun/opencodex/issues/509

The reporter originally classified the Windows memory growth as JS-heap-side, but
the latest controlled follow-up withdraws that conclusion. The remaining
actionable gap is observability: the service endpoint, watchdog sample ring,
doctor output, and dashboard expose `rss`, `heapUsed`, `heapTotal`, `jscHeap`,
and `responseState`, but not `process.memoryUsage().external` or
`arrayBuffers`. On the bundled Bun 1.3.14 Windows runtime those two counters are
the useful signal for reachable ArrayBuffer/external retention, while RSS can be
blind after working-set trimming.

## Classification

`takeover-fix/investigate`.

This is a small additive observability fix. It does not change auth, permission,
storage migration, model routing, release branches, or restart policy.

## Planned change

Production code:

- `src/server/memory-watchdog.ts`
  - add `external` and `arrayBuffers` to `MemorySample`;
  - sample them from `process.memoryUsage()`;
  - add explicit `observedBytes` and `observedMetric`;
  - make the rate-limited warn threshold use the largest observed memory counter
    among `rss`, `external`, and `arrayBuffers`;
  - name the triggering metric in the warning line.
- `src/server/management/system-routes.ts`
  - include top-level scalar `external` and `arrayBuffers` in
    `GET /api/system/memory`.
  - include top-level `observedBytes` and `observedMetric` even when no watchdog
    instance is active.
- `src/cli/doctor.ts`
  - parse optional `external` and `arrayBuffers`;
  - render them in the Memory / runtime section;
  - classify high observed memory using the same largest-counter threshold as the
    watchdog while keeping the existing high-RSS JS-vs-native language only when
    RSS itself is high.
- `gui/src/components/MemoryObservabilityCard.tsx`
  - accept optional `external` and `arrayBuffers`;
  - render them in the detail area;
  - compute drift from observed memory instead of RSS only.
- `gui/src/i18n/{en,ko,de,ja,ru,zh}.ts`
  - add labels for external/ArrayBuffers if needed.
- `docs-site/src/content/docs/troubleshooting/windows-memory.md`
  - update wording so the attribution rule does not claim RSS alone is a
    reliable Windows discriminator.

Tests:

- `tests/memory-watchdog.test.ts`
  - endpoint includes scalar `external` and `arrayBuffers`;
  - watchdog warning fires when RSS is below threshold but external memory crosses
    it;
  - warning remains scalar and path-free.
- `tests/doctor.test.ts`
  - doctor parses/renders the new counters;
  - below-RSS but high external memory no longer prints "looks normal".

## Non-goals

- Do not auto-restart.
- Do not close #314.
- Do not claim the Windows leak is fixed.
- Do not expose paths, request bodies, account IDs, tokens, or private prompts.
- Do not add Windows OS-specific `PrivatePageCount` in this phase; that needs a
  separate platform implementation and review.

## Verification

- `bun test tests/memory-watchdog.test.ts tests/doctor.test.ts`
- `bun x tsc --noEmit`
- `bun run privacy:scan`
- A-gate reviewer verdict folded before B.

## A-gate review

Reviewer verdict: `GO-WITH-FIXES`.

Folded blockers:

- GUI Memory card must render the new counters and stop deriving drift from RSS
  only.
- Doctor interpretation must use observed memory and stop saying low RSS means
  memory is normal when external/ArrayBuffers are high.
- Watchdog warning text must not be RSS-specific and must name the triggering
  metric.
- Docs/SOT must replace RSS-only terminology with observed-memory terminology
  and Windows counter caveats.
