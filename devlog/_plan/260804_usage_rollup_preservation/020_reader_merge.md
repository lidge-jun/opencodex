# 020 — Reader merge: rollup(old) + raw tail(recent) — rev3 (post-audit 002 R2)

One PABCD cycle. Write scope: `src/usage/log.ts`, `src/usage/summary.ts`,
`src/server/management/logs-usage-routes.ts`,
`src/server/management/api-key-usage.ts`, `src/config.ts`, `src/types.ts`,
`tests/usage-rollup-merge.test.ts` (new), existing usage tests updated only
where signatures change.

## log.ts — offset-aware tail

`readUsageSnapshotForManagement(maxReadBytes, fromOffset = 0)`:

- effective start = `max(fromOffset, size - maxReadBytes)`; existing
  newline-realignment logic reused verbatim.
- `truncatedPrefixBytes` becomes the *residual* gap: `start - fromOffset`
  clamp ≥ 0. With a caught-up rollup the residual is 0 and `historyTruncated`
  turns false even at 157 MB.
- entry cap unchanged (200k applies to the tail only; rollup keeps history).
- in-flight sharing key gains the `fromOffset` component.

## summary.ts — merge contributions

`summarizeUsage(entries, range, now, surface, rollup?: RollupContribution)`:

```ts
export interface RollupContribution {
  days: RollupDayRow[]; models: RollupModelRow[];
  providers: RollupProviderRow[]; oldestTimestampMs: number | null;
}
```

- Surface filter: apply the same four disjoint predicates to row.surface.
- Range filter: include a rollup day when `localDate(date)` overlaps the
  window; `all` includes everything. Day-grain inclusion affects only 30d in
  the caught-up steady state (min-age 9 keeps 7d fully in the tail); the
  boundary day may overcount by up to ~24h vs ms-filtering — documented in
  docs-site and asserted in tests (002 B3/adv4).
- `summary` totals: add day-row statusCounts/attemptCount/tokens/cost fields
  additively before `finalizeCoverage`.
- `days`: seed the grid from rollup day rows (additive with tail rows landing
  on the same date — disjoint byte ranges make this pure addition). `all`-range
  day count uses `min(oldestTimestampMs, oldest tail ts)`.
- `models`/`providers`: convert rollup rows into pre-aggregated
  `UsageModel`/`UsageProvider` seeds (requests/attemptCount/statuses/tokens/
  cost), merge tail-built rows by the same key, then share-ratio/sort/cap as
  today. Merged "other" buckets sum pre-aggregated request counts (additive;
  exact within the 010 exactness domain). Per-day model breakdown
  (`day.models`) merges rollup model rows for that date.
- No behavior change when `rollup` is undefined (all call sites outside the
  usage route pass nothing).

## logs-usage-routes.ts — wiring

In `GET /api/usage`:

1. `if (config.usageRollupEnabled !== false) void ensureRollupCurrent()` —
   fire-and-forget, throttled internally; the fold never blocks the request.
2. `const rollup = readRollupSnapshot()` — synchronously validated (R2-2:
   version/lineage/fingerprint checked inside; null on any mismatch → raw-tail
   legacy path with cutline 0, so stale costs are unreachable); pass
   `fromOffset = rollup?.cutlineOffset ?? 0` into the snapshot read and
   the contribution into `summarizeUsage`.
3. Cache key/revision: append the rollup `cutlineOffset` (single commit
   authority — a fold advance changes it) to the
   revision key so a fold invalidates cached summaries.
4. Truncation metadata: `historyTruncated = residualPrefix > 0 || entriesTruncated`.

## api-key-usage.ts — key rollup merge (002 B3)

`readApiKeyUsageRollup` reads tail from the cutline and seeds
`totalRequests`/`attributionSince`/`lastUsedAt` from `RollupKeyRow`s.
`requests7d` is tail-exact when `truncatedPrefixBytes === 0` (the min-age-9
watermark keeps the last 9 local days raw). If the byte window is smaller than
the un-folded suffix (extreme growth), the residual gap surfaces as the
existing `historyTruncated` metadata — a bounded, reported regression
identical to today's behavior, never silent.

## config

`usageRollupEnabled: z.boolean().default(true)` in config schema + types +
defaults. No new tuning knobs — cadence/min-age are module constants.

## Tests

1. Property test (fixture generator from 010): random entries across 40 days →
   fold prefix, merge tail → `summarizeUsage` equality with full-raw parse for
   `all` (totals, days, models, providers, costs to 1e-9), within the 010
   exactness domain; out-of-domain cases (duplicate ids, combo-into-other)
   covered by dedicated documenting tests.
2. Boundary day: same date present in both rollup and tail → additive, not
   doubled.
3. Surface filters against rollup rows (claude vs claude-desktop vs codex).
4. 7d/30d windows: 7d never touches rollup (min-age 9); 30d includes rollup
   days inside the window, excludes outside, boundary-day whole-day inclusion
   asserted; midnight/tz/out-of-order-timestamp cases.
5. Route-level: cache invalidates on fold advance; `historyTruncated` false
   with caught-up rollup on an oversized file; flag off → legacy behavior.
6. api-key totals include folded history; `requests7d` exact vs full-raw
   reference on a fixture whose history spans the fold boundary.
