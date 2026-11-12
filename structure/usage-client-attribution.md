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
reuses the projection. Candidate offsets are selected and consumed in bounded keyset pages, with a
timer yield between pages; each page rechecks the published generation before it is read, so broad
filters neither retain the complete offset set nor monopolize the event loop. A replaced, truncated
or same-size rewritten ledger rebuilds it, a write
observed during a row read re-verifies the selected bytes before publishing them, and a recorded
offset that no longer frames a complete row drops the projection instead of serving a partial
answer. `usage.jsonl` stays authoritative and is never truncated or rewritten.

Each candidate page is one keyset statement per branch, and every branch index is ordered
`(generation, <equality prefix>, byte_offset, ...)` so its own `ORDER BY byte_offset LIMIT` is
served by the index walk. This is why the window filter uses `idx_usage_rows_window` rather than a
timestamp-ordered index, why a lone provider or model pages from
`idx_usage_attr_{provider,model}_offset`, and why the Codex roster is expanded one label per branch
instead of `client IN (...)`: each of those alternatives would otherwise force SQLite to sort the
whole match set on every page, which made a deep page cost seconds on a large ledger -- more than the
streaming scan the projection exists to replace. The pager keeps one fetch cursor and one surplus
buffer per branch, so merging the branch heads returns one ascending, de-duplicated page bounded by
`CANDIDATE_PAGE_SIZE` while each candidate is fetched about once; a branch that fetched past what
the merge needed carries that surplus into the next page instead of reading it again.
`tests/usage/usage-filter-paging.test.ts` asserts that no paged branch plan carries a temp B-tree,
and pins branch-cursor order, the page bound, and the corrupt-projection rebuild.

The index keeps its `-wal` and `-shm` sidecars after the last connection closes
(`SQLITE_FCNTL_PERSIST_WAL` on every connection that can write, set only once the file classified
as this projection). The writer runs `PRAGMA wal_checkpoint(TRUNCATE)` before it closes and a
`journal_size_limit` is set, so a clean close leaves the kept WAL empty; while a reader in another
process pins it, the WAL keeps its frames until a later writer's checkpoint. Creation registers the
sidecar names up front; an existing projection whose names were never recorded (a 0-byte file left
by a crash before the first open) registers them on the first open after they exist. SQLite's
default deletes them on the final close, which changed the config directory on
every filtered query. On Windows a changed
config directory re-runs its ACL harden, whose inherited-ACE rewrite moves `usage.jsonl`'s
ChangeTime, and both the usage aggregate and this index then rebuild from the whole ledger.
`tests/usage/usage-filter-index.test.ts` asserts that filtered queries after the first leave the
directory's entries and times unchanged.

The reader also receives the snapshot's revision, boundary offset and trailing digest. When the
revision moved since the snapshot it re-verifies that boundary before trusting any offset, so a
rewrite between the index refresh and the row read becomes a rebuild rather than a silently
different row set; a candidate that no longer normalizes is reported unreadable for the same reason.
At an unchanged size a moved revision is always a rebuild, because the file cannot have grown: the
trailing digest is only the append contract for a file that grew, and a rewrite earlier than that
window accompanied by growth remains the base aggregate's documented limit. An empty selection still
performs this validation, so a query with no candidates cannot skip it, and a retained projection
that reports "unchanged" validates the ledger the same way before returning.

Growth is measured against the physical file size the snapshot recorded, not the processed byte
boundary. A torn final row leaves the file larger than the boundary without being new content, so a
snapshot taken with a torn suffix has a physical size above its cursor; a later same-size rewrite is
therefore a rebuild rather than an append, while an unchanged torn suffix settles as "unchanged"
without re-reading the ledger.

Rows belong to a generation; a small registry lists every generation and meta names the one
published. A rebuild stages a fresh generation under a writer lease and publishes it in one short
transaction fenced on the generation and cursor it started from. A successful publish prunes every
retired generation by equality; a generation whose writer is still alive is left alone, so that
writer's own publish fails the fence and retries, and a reader only ever sees one complete
generation. A
crash before publish leaves the previously published generation complete. An append writes into the
published generation and publishes its cursor, digest, counts and span in the same transaction,
fenced on the cursor so a stale append cannot regress it. Each candidate page re-reads meta and
selects inside its own short read transaction, and a generation or schema change aborts the read --
the per-page recheck described with the paging contract above. A published
generation that claims rows it no longer holds is rebuilt rather than served as a complete zero, in
both the active and the passive read.

A staging generation registers itself and its writer pid before its first row. A failed attempt
discards its own generation in a finally; a process that dies without running it leaves a lease
whose pid is no longer alive, and the next refresh reclaims that generation. A generation whose
writer is alive is never reclaimed. The registry is the complete set of generations, so reclamation
and pruning delete by equality instead of scanning the row table under the write lock. The registry
row and the lease commit together, and reclamation re-reads the published generation and the lease
inside its own write transaction before deleting, so a generation that registered while the
pre-check was running is never treated as abandoned. A retired generation's dead writer record is
removed with it; a live writer keeps its registry row and lease, so another writer's prune leaves
its staging alone and its own publish fails the fence and retries. A lease whose generation is no
longer registered cannot belong to a live writer and is pruned.

Opening the projection is safe against a concurrent first open. The busy timeout is set before the
first read, and a classification that meets another writer's lock rethrows the busy error into the
caller's retry; it never reads as a foreign file. A fresh file gets its whole schema in one
`BEGIN IMMEDIATE` transaction that re-classifies under the lock, so no process can observe the meta
table without the data tables, and a schema another process committed first is adopted and
verified. An outdated schema is recreated only after re-checking it under the same lock, so two
processes that both saw it stale cannot drop each other's fresh tables.

The projection is created 0600 through the shared private-SQLite path. It and its WAL and
shared-memory sidecars are registered for uninstall when this module creates them, or, beside an
existing file that classified as this projection, once they appear; a file at that path that is
not this projection is never registered or modified. A passive management read opens an existing
projection read-only, requires this projection's full table set rather than a coincidental meta
table, and only uses it when it is current for the exact ledger revision; otherwise it streams,
and it never creates, writes or registers anything. The passive read makes a single attempt and
degrades to the streaming scan on any error; it does not retry. Only the active index read
(`readUsageFilterCandidates`) retries contention on three short delays (85 ms, plus SQLite's
250 ms busy timeout per attempt) before streaming, and runs a
foreign or unsafe open and a rebuild-required read through three short delays before degrading.
Any other
index-side failure -- unwritable home,
full disk, a corrupt file -- falls back to the authoritative streaming scan
instead of failing a request the scan can answer; a failure to read `usage.jsonl` itself is
propagated. A `UsageFilterIndexPageError` from a `src/usage/filter-index.ts` page read clears the
retained filtered aggregate, then retries the authoritative streaming scan under
`withFilterIndexRetry` (`MAX_FILTER_INDEX_ATTEMPTS` attempts) in
`src/server/management/usage-aggregate-cache.ts`: only a concurrent ledger replacement or an
aggregation-input change is retried, the unusable index is never re-entered, and unrelated ledger
I/O failures still propagate. A nonselective filter (`client=all`, `device=all`, no provider/model/key) still reads
every row in its window; `candidateRows` counts the rows selected and normalized for that call and
`scope` says whether that is the whole candidate set or only the appended suffix, not how many SQL
index entries were examined. `tests/usage/usage-filter-index.test.ts` asserts candidate counts against the whole
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

## Anthropic pool account tag

Anthropic pool attempts carry no `accountLogLabel`; the pool folds the account into the logged
provider (`anthropic-p<hex6>`, `formatAnthropicProviderForLog`). `anthropicAccountTag` in
`src/providers/label.ts` exposes that same suffix as a separate `accountTag` field and mints no
new identifier. `sealRequestAttemptIdentity` (`src/server/request-log-account-rotation.ts`)
derives it from the attempt's frozen provider, so a failover split carries the next account's
tag; the row's tag comes from the row's provider in `src/server/request-log.ts`. `src/usage/log.ts`
and the request-log hydration keep only `p` plus six lowercase hex digits and drop anything else.
Per-account summaries still key on `accountLogLabel` and ignore the tag
(`tests/usage/request-log-anthropic-account-tag.test.ts`).
