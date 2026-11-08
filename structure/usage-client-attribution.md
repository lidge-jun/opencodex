# Usage client attribution

`src/usage/client.ts` defines the closed client-attribution roster and recognizes bounded
request-header signatures without retaining the header values. HTTP request contexts in
`src/server/index/` and the Responses WebSocket handshake carry that observational label through
`src/server/request-log.ts` projection and `src/usage/log.ts` normalization. Older rows without
the field remain absent, while invalid present values become `unknown`. Combo child adoption
cannot replace the inbound label. The label is caller-supplied evidence, not an authorization
decision. New direct log writes without a valid client record `unknown`; reading an older row
without the field still preserves its absence. The live log detaches mutable caller rows so a
later caller mutation cannot replace a recorded client with raw text; frozen normalized rows with
only data properties can retain their identity. Client values and bounded failure details are
captured before error projection, and normalizing a new write also preserves any existing
attempt-loss marker.
`tests/usage/usage-client-attribution.test.ts` and
`tests/usage/request-log-normalization.test.ts` cover those boundaries.

`src/usage/source-filter.ts` defines app and device filters. A Codex filter includes recognized
Codex clients and legacy Codex-surface rows; it reports the latter as a separate unclassified
count, without assigning a client subtype. A no-key filter means the stored key ID is absent,
including pre-attribution and environment-admitted rows; it does not prove physical origin.
`src/usage/summary.ts` applies filters before aggregation and retains range-aware unclassified
counts. When provider/model filtering removes combo attempts, it recomputes the retained request
status using the same status facts as model and provider counts, excluding usage-less attempts
that never sent or were answered locally. Model and provider attempt counts use the same eligibility
in unfiltered reports; unchanged attempt sets retain the recorded row status.
`src/server/management/usage-aggregate-cache.ts` keys retained aggregates by both source
dimensions, and `src/server/management/logs-usage-routes.ts` validates the complete query before
special projections. The device inventory requires a dashboard session and refuses child scope.
`src/usage/filter-index.ts` selects candidates for those dimensions and for provider, model,
API-key and window bounds; its client, surface and admission columns mirror `source-filter.ts`
exactly, so the index can over-select but never reject a row the accumulator would keep. The
accumulator re-applies the authoritative filter to every candidate, and whole-ledger invalid and
oversized diagnostics come from the index rather than from the selected rows.

The candidate index is a disposable SQLite projection (`usage-filter-index.sqlite`) that records each
complete row's byte offset, the fields above, and one attribution per provider/model the row can
match. `src/usage/ledger-scanner.ts` supplies both halves: `scanUsageLedgerCooperatively` reports the
row offset during ingest, and `readUsageLedgerRowsAtOffsets` re-reads only the selected rows under the
same identity, row-ceiling and torn-suffix rules. The first filtered query after the index is missing
or invalid pays one cooperative full ingest; appends ingest only new bytes, and every later filter
reuses the projection. A replaced, truncated or same-size rewritten ledger rebuilds it, a write
observed during a row read re-verifies the selected bytes before publishing them, and a recorded
offset that no longer frames a complete row drops the projection instead of serving a partial
answer. `usage.jsonl` stays authoritative and is never truncated or rewritten.

Rows belong to a generation and meta names the one published generation. A rebuild stages a fresh
generation and publishes it in one short transaction fenced on the generation it started from;
nothing deletes another writer's staged rows, only a successful publish prunes other generations.
Two writers that stage concurrently therefore cannot mix rows, the loser retries, and a crash before
publish leaves the previously published generation complete. An append writes into the published
generation and publishes its cursor, digest, counts and span in the same transaction. Readers take
meta and the candidate select in one read transaction and reject a generation that changed under
them. A published generation that claims rows it no longer holds is rebuilt rather than served as a
complete zero, which is why an interrupted rebuild cannot produce empty totals that look final.

The projection is created 0600 through the shared private-SQLite path, its WAL and shared-memory
sidecars are registered for uninstall only when this module creates them, and a file at that path
that is not this projection is never modified. A passive management read opens an existing
projection read-only and only when it is current for the exact ledger revision; otherwise it streams,
and it never creates, writes or registers anything. Any other index-side failure -- unwritable home,
full disk, contention, a corrupt or foreign file -- falls back to the authoritative streaming scan
instead of failing a request the scan can answer; a failure to read `usage.jsonl` itself is
propagated. A nonselective filter (`client=all`, `device=all`, no provider/model/key) still reads
every row in its window; `candidateRows` counts the rows selected and normalized, not the SQL index
entries examined. `tests/usage/usage-filter-index.test.ts` asserts candidate counts against the whole
ledger, the append cursor, crash and two-writer generation handling, passive and fallback behavior,
row tolerance, query plans, and parity with a full-scan oracle.

`src/usage/app-breakdown.ts` maps only the closed recorded-client roster to report app categories:
the three Codex variants share one category, absent client fields are unclassified, and invalid
present values are unknown. `src/usage/summary.ts` accumulates per-app request, token and price
coverage within each date/surface partition after source and model projection. Clone and retained
memory accounting include these counters; filtered snapshot projection replaces them with the
filtered totals. `src/remote/hub-usage.ts` accepts the optional bounded app list while stripping
undeclared fields, and the hub computes it only for the authenticated key. Tests in
`tests/usage/usage-client-attribution.test.ts`, `tests/usage/usage-aggregate-cache.test.ts` and
`tests/server/hub-usage.test.ts` cover classification, projection, append and hub scope. The GUI
validates app categories against the backend roster, and `gui/tests/usage-app-breakdown.test.tsx`
checks that the source picker exposes the same categories apart from its all-app option.

The unconfigured-key filter compares configured-admission rows to a captured snapshot of all
currently configured key IDs; it does not prove historical deletion or device identity. Its
snapshot is included in filtered-cache identity. `src/usage/source-facets.ts` folds the bounded
30-day app/device counts in one pass, retaining individual counters only for configured IDs;
its legacy count is the unclassified subset of the Codex app option for the selected device.
Unselectable padded IDs remain in the configured membership set but are omitted from individual
rows and counted separately, so they neither hide valid choices nor become unconfigured traffic.
`src/server/management/usage-source-facets.ts` bounds concurrent scans. The session-only facets
route rechecks session and inventory after scanning, fails closed on changes and sets no-store.
Expiration after an authorized scan starts returns 401 so the dashboard clears session-scoped
results; an initial credential lacking the required dashboard scope still receives 403.
Snapshots exceeding 1,024 configured keys, 256 characters per ID or 65,536 total ID characters
are refused rather than truncated; retained accumulator estimates include the snapshot and cache
identity. Invalid ledger rows mark unconfigured reports incomplete without claiming they were
oversized. `tests/usage/usage-aggregate-cache.test.ts` covers append and snapshot identity.

`src/server/index/link-management.ts` binds new source-filtered relay reads to the admitted link
key. Source-filtered snapshot bounds cover only matching rows. `src/client/link-management-relay.ts`
requires JSON, a byte-limited body with a deadline, and the Home's matching source echo; it refuses
filtered HEAD reads, whose empty body cannot confirm the scope. Requests without these dimensions retain the previous relay behavior and are not
newly scoped by that rule. `src/server/hub-usage.ts` binds a client-filtered data-plane read to its authenticated
key and emits a safe scope echo; `src/remote/hub-usage.ts` projects it without key IDs, and
`src/client/hub-client.ts` rejects a missing or mismatched echo.
