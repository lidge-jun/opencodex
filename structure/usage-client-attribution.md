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
