# Usage client attribution

`src/usage/client.ts` defines the closed client-attribution roster and recognizes bounded
request-header signatures without retaining the header values. HTTP request contexts in
`src/server/index/` and the Responses WebSocket handshake carry that observational label through
`src/server/request-log.ts` projection and `src/usage/log.ts` normalization. Older rows without
the field remain absent, while invalid present values become `unknown`. Combo child adoption
cannot replace the inbound label. The label is caller-supplied evidence, not an authorization
decision. `tests/usage/usage-client-attribution.test.ts` covers the normalization boundary.

`src/usage/source-filter.ts` defines app and device filters. A Codex filter includes recognized
Codex clients and legacy Codex-surface rows; it reports the latter as a separate unclassified
count, without assigning a client subtype. A no-key filter means the stored key ID is absent,
including pre-attribution and environment-admitted rows; it does not prove physical origin.
`src/usage/summary.ts` applies filters before aggregation and retains range-aware unclassified
counts. `src/server/management/usage-aggregate-cache.ts` keys retained aggregates by both source
dimensions, and `src/server/management/logs-usage-routes.ts` validates the complete query before
special projections. The device inventory requires a dashboard session and refuses child scope.

The unconfigured-key filter compares configured-admission rows to a captured snapshot of all
currently configured key IDs; it does not prove historical deletion or device identity. Its
snapshot is included in filtered-cache identity. `src/usage/source-facets.ts` folds the bounded
30-day app/device counts in one pass, retaining individual counters only for configured IDs;
`src/server/management/usage-source-facets.ts` bounds concurrent scans. The session-only facets
route rechecks session and inventory after scanning, fails closed on changes and sets no-store.

`src/server/index/link-management.ts` binds new source-filtered relay reads to the admitted link
key. Source-filtered snapshot bounds cover only matching rows. `src/client/link-management-relay.ts`
requires JSON, a byte-limited body with a deadline, and the Home's matching source echo; it refuses
filtered HEAD reads, whose empty body cannot confirm the scope. Requests without these dimensions retain the previous relay behavior and are not
newly scoped by that rule. `src/server/hub-usage.ts` binds a client-filtered data-plane read to its authenticated
key and emits a safe scope echo; `src/remote/hub-usage.ts` projects it without key IDs, and
`src/client/hub-client.ts` rejects a missing or mismatched echo.
