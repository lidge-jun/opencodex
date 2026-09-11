# 070 — wp10/wp11: slug equivalence and the exec_command class

### #2491 — four slug-equivalence relations
Confirmed on dev:
1. visibility compares lossy `slugEquivalenceKey(routedSlug(...))`, collapsing
   `a/b` and `a-b` (`src/codex/catalog/provider-fetch.ts:1613`);
2. persisted sync rebuilds the same lossy keys independently
   (`src/codex/catalog/sync.ts:819,1038`);
3. `ocx models remove` uses exact `slugEquals` (`src/cli/models.ts:278`,
   `src/providers/slug-codec.ts:83`);
4. routing throws on encode collisions (`src/router.ts:650`,
   `slug-codec.ts:72`).
The over-grant is already pinned as expected behaviour in
`tests/selected-models.test.ts:88`. Unify on one relation and update that pin.

### #2472 — exec_command zero-output class → CLOSE
Neither `wall_time_seconds` nor `exec_command` appears under `src/` or `tests/`;
the result envelope is the Codex host's. The Cursor call-ID theory is disproved: live
bridge calls pass `allowEmptyArgs: true`
(`src/adapters/cursor/live-transport.ts:243`) and duplicate call IDs are deduplicated
deliberately (`src/adapters/cursor/protobuf-events.ts:1044`). The related zero-output
stream mitigation already shipped in `88b7cc057`. Close with this evidence rather than
changing proxy finalization, which would risk duplicate retries/execution/billing.

