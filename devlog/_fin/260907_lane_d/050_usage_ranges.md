# 050 Custom usage windows
REIMPLEMENT range slice from PR #2956 with Manson2438 credit; do not carry offline reports.
ADD src/usage/time-range.ts strict timestamp parser and inclusive since/until bounds;
MODIFY summary.ts accumulator interface to support bounded windows without poisoning
preset daily aggregates. Use stream ledger filtering for partial days if compact daily
partitions cannot answer exact boundaries. Reject malformed/reversed bounds at API/CLI.
MODIFY src/server/management/logs-usage-routes.ts custom-window path before preset cache,
stream/filter into isolated accumulator preserving surface/provider/model and truncation
metadata. Do not persist normalized ledger rows. Include bounds in response.
MODIFY CLI observe/capabilities usage flags and GUI Usage.tsx custom datetime inputs,
independent draft/applied bounds, cache key includes bounds, grid anchored to effective
window, clear returns to preset. All locale keys append-only usage.range.*.
Tests: inclusive boundaries, partial same-day, reversed/invalid, empty ledger, existing
provider/model/surface filters, preset cache after custom query; GUI apply/clear/errors.
Public API/CLI docs describe epoch/ISO contract and local datetime conversion.

Verification: NOT RUN locally by user instruction; focused tests execute in final top-head Cross-platform CI.

A fold-back: immutable window option on createUsageSummaryAccumulator; add() checks
inclusive bounds AFTER recording whole-scan snapshot timestamps but BEFORE partitioning.
clone preserves window. summarize uses window endpoint for grid, actual now for generatedAt;
retain 366-day grid cap. Custom queries use isolated row-unique accumulator via existing
getFilteredUsageAggregate with window in key. Reuse overlay/timezone revision restart
and scanner identity controls. Preserve apiKeyId and current filter echo alongside all
other filters. USAGE_RANGES remains preset-only; response range stays selected preset
with customWindow:true, since/until explicit bounds (bounds override preset). API accepts
integer epoch milliseconds or full ISO-8601 with timezone only; require both bounds;
reject negative/unsafe/date-invalid/reversed, never normalize overflow dates.
MODIFY src/cli/usage-report.ts heading prints since/until for customWindow responses.
GUI datetime values become epoch ms locally; end selected minute includes 59.999s.

P revalidation: custom windows always filter rows before aggregation. Introduce exported
UsageTimeWindow {since:number,until:number} and immutable optional accumulator window;
snapshot timestamps update first, clone retains the window, summary returns customWindow:true
and exact since/until while actual generatedAt stays now. Partition/day filtering must not
drop the partial first day. Grid uses local calendar day boundaries and caps at 366 days.
getFilteredUsageAggregate accepts window, keys both bounds, passes window to factory and
reuses existing revision/timezone/overlay guards. Only-window queries preserve account rows.
GUI skips held/session report caching for custom windows (arbitrary keys must not grow the
preset cache); useDataSurface key still includes bounds and unsubscribed stores already evict.
Workers split backend/API/CLI/tests and GUI/i18n/tests; main owns docs/manifests/generated map.

Implementation checkpoint: shared strict ISO/epoch-ms parser, immutable per-entry window,
window-keyed filtered cache, API and CLI inclusive bounds, exact interval heading, and
localized Usage date/time controls are implemented. Custom GUI reports bypass held caches;
calendar grid stays within the server's bounded days. Tests cover partial/inclusive bounds,
filters/accounts, cache invalidation, clone/snapshot behavior, empty/error responses and UI
apply/clear/stale-response paths. New parser test registered in both manifests. ISO fractions
beyond millisecond precision reject instead of truncating. Product execution NOT RUN locally.
