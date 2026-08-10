# 060 — usage management read cap: 200k → 500k entries

User authorization (2026-08-06): adopt the user's uncommitted 500k edits from
the main checkout, "의견을 종합해서" — synthesize the review context and land
it properly. Authority includes push + PR + merge for this item.

## Synthesis (why 500k is the right call now)

- The cap is a READER bound (`MANAGEMENT_USAGE_MAX_ENTRIES` in
  `src/usage/log.ts`), not a retention bound: raw `usage.jsonl` is never
  deleted by it. Raising it widens what one management read can return.
- The BYTE cap (`managementUsageMaxReadBytes`, 64 MiB default) bounds the raw
  INPUT of a read before the entry cap applies (log.ts:532-558); the entry cap
  trims parsed rows afterwards (log.ts:500-519). Corrected per audit: 64 MiB
  bounds input bytes, while 500k raises the TRANSIENT parse/summary heap and
  CPU — up to 300k more normalized JS objects can be retained per read, and
  `/api/usage` does several full passes with per-request Map/Set aggregation
  (summary.ts:301-583). This is a bounded, transient cost on a management
  read, not an unbounded leak — but it must be measured, not assumed.
- Acceptance criterion added: a representative 500k-entry benchmark (small
  rows, worst-case unique request ids) must show acceptable wall time and
  peak RSS delta for `readUsageSnapshotForManagement` + `summarizeUsage`
  before landing.
- Prior lesson (usage-log cap incident): "a reader cap can hide data without
  deleting it" — the 200k clip was exactly that failure shape for the GUI.
- With the #1008 rollup sidecar (still open) history older than the window
  will come from folded rows anyway; until it lands, the raw window IS the
  history, which strengthens the case for the wider entry cap now.
- Overlap handling: this branch cuts from current dev, applying the same
  content as the user's dirty edits. The main checkout stays untouched; once
  this lands, the user's local diff becomes content-identical to HEAD.

## Work

1. Branch `codex/usage-entry-cap-500k` off current dev; apply the two-file
   change (constant + test expectations).
2. 500k benchmark (bench script in .tmp/, not committed): parse + summarize
   wall time and heap delta at 200k vs 500k; record numbers in this ledger.
3. Focused tests + typecheck; terra regression audit. Collision check done:
   #1008's log.ts diff starts at the reader (~line 523) and does not touch
   the cap line or this test — no hunk collision (audit-verified).
4. Push, PR to dev, CI green, merge with `--match-head-commit` pin.

## Ledger

| Step | Evidence |
|------|----------|
| Benchmark (bench.ts in mktemp, not committed) | Baseline 200k-cap: 200k entries, read 475ms, summarize 358ms, ΔRSS 547MiB. With 500k cap on a 96.7MiB/500k-row file: byte cap binds first → 330,585 entries, read 835ms, summarize 609ms, ΔRSS ~1.1GiB transient. 600k-row file: identical 330,585 entries — the 64MiB byte window is the effective bound for realistic rows; the 500k entry cap is a secondary guard, not the binding limit |
| Cap-binding benchmark (bench2, audit-required) | Tiny rows densely packing 63.5MiB → 629,205 rows in the byte window; parse-all-then-slice yields exactly 500,000 entries (129,205 dropped). read 1,436ms, summarize 637ms, ΔRSS 897MiB transient. This exercises the exact widened case (entry cap binding, unique request ids) |
| Acceptance threshold + verdict | Threshold: ≤3s combined read+summarize, ≤1.5GiB transient RSS on the worst case. Measured: 2.07s combined, 897MiB — inside threshold. Request-scoped, no steady-state retention; acceptable for an on-demand admin endpoint |
| Stale comment | tests/usage-log.test.ts:138 timing comment updated to the 500k shape (audit minor) |
