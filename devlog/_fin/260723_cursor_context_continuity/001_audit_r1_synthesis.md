# Audit round 1 synthesis (reviewer: Sol subagent, VERDICT: FAIL, 8 blockers)

| # | Sev | Decision | Resolution |
|---|-----|----------|------------|
| 1 | High | ACCEPT | Cursor always takes the `runTurn` branch (`src/adapters/cursor.ts:69`, `src/server/responses.ts:1483`); generic sites 1824/1859 can never see cursor. Force cursor only at 1537/1574; leave 1824/1859 kiro-only. 010 amended. |
| 2 | High | ACCEPT | Predicate-bypassing test was tautological and used nonexistent helpers. New spec: export `adapterNeedsForcedContinuation`, unit-test it; add a server-level routed-cursor chain test using the existing server harness pattern (`tests/server-combo-failover-e2e.test.ts`) with an injected fake cursor transport, asserting the SAME conversationId reaches the transport on the chained request. 010 amended. |
| 3 | High | ACCEPT (bounded mitigation) | Forced retention stores full expanded input per turn → ~quadratic bytes per chain; count/TTL prune only. Mitigation: total-byte high-water prune in `src/responses/state.ts` (`MAX_STORED_RESPONSE_BYTES`, approximate per-entry size captured at store time, prune-oldest loop) + long-chain test. Kiro already carries this risk; the cap fixes both. 010 amended. |
| 4 | Med | ACCEPT | Predicate now requires object-cue AND overflow-cue pairing; adversarial negative ("while loading tool catalog: quota exhausted" → 429) added to the test table. 020 amended. |
| 5 | High | ACCEPT | No settled guard exists (`live-transport.ts:621` fail direct, `:707` finish direct). New spec: per-`open()` `let settled=false`; `settleFail`/`settleFinish` wrappers own EVERY terminal path (timeout, stream error, trailers, end, session error, expectedClose finish). Race tests specified. 030 amended. |
| 6 | High | ACCEPT (scope-corrected) | Completed non-2xx is also classified `http` → split category: `transport` (session/request/setup, pre-response) vs `http` (completed response). Retry set = {timeout, transport} only; second attempt capped at 3000ms; worst case ~11.3s explicitly accepted for cache-miss `/v1/models` paths (current worst case is already 8s; degradation caching absorbs repeats). Real caller is `src/codex/catalog.ts:1538`, not discovery.ts. 030 amended. |
| 7 | Med | ACCEPT | Seams fixed at doc level: 3a/3b tests use a real local h2c server (pattern already in `tests/cursor-hardening.test.ts:16`); destroy-grace becomes named constant + optional `CursorTransportFactoryInput.timeoutDestroyGraceMs` seam; discovery retry gets an internal `attemptImpl` parameter seam. 030 amended. |
| 8 | Low | ACCEPT | Anchors refreshed: `state.ts:195`, `live-transport.ts:621`, caller = `src/codex/catalog.ts:1538`. 000/030 amended. |

No rebuttals — all 8 accepted with concrete amendments. Cross-blocker note:
#3's byte cap interacts with #2's server-level test (the test must not trip the
cap); cap default chosen far above test fixtures (64 MB).
