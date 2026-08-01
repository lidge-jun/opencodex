# 010 — WP8 implementation record

## MODIFY map

- `src/server/memory-watchdog.ts`
  - `MemorySampleBase` now carries `rss`, `heapUsed`, `heapTotal`, `external`,
    and `arrayBuffers`.
  - Normalized `MemorySample` adds `observedBytes` and `observedMetric`, computed
    by `observedMemoryCounter()`.
  - The warn threshold uses `observedBytes` and the warning names the metric.
- `src/server/management/system-routes.ts`
  - `/api/system/memory` returns top-level `external`, `arrayBuffers`,
    `observedBytes`, and `observedMetric`.
  - Watchdog snapshot also carries `observedBytes` / `observedMetric`.
- `src/cli/doctor.ts`
  - Parses optional new counters while remaining compatible with old proxies.
  - Renders RSS, external, ArrayBuffers, heap, and observed metric.
  - Uses observed memory for the threshold branch.
- `gui/src/components/MemoryObservabilityCard.tsx`
  - Accepts optional new counters.
  - Shows observed/external/ArrayBuffers in details.
  - Uses observed-memory drift per hour.
- `gui/src/i18n/{en,ko,de,ja,ru,zh}.ts`
  - Adds the new memory labels and updates the hint/growth wording.
- `docs-site/src/content/docs/troubleshooting/windows-memory.md`
  - Replaces RSS-only guidance with observed-memory guidance.
- `structure/05_gui-and-management-api.md`
  - Updates the SOT endpoint contract.
- `tests/memory-watchdog.test.ts`, `tests/doctor.test.ts`,
  `gui/tests/memory-observability-card.test.tsx`
  - Regression coverage for #509.

## Verification plan

Run:

```bash
bun test tests/memory-watchdog.test.ts tests/doctor.test.ts
cd gui && bun test tests/memory-observability-card.test.tsx
bun x tsc --noEmit
bun run privacy:scan
```
