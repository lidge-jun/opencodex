# WP180 — #140 Cursor retry transport ordering

- Base/branch: ~~WP170 tip -> `codex/wibias-140-13-cursor-retry-order`~~ **P-amendment (2026-07-17): commit directly onto dev@67fa4136 (last zero-overlap child; cursor/transport-retry untouched by the concurrent session).**
- P stale-check (2026-07-17) — the ledger's premise INVERTED on current dev:
  - Dev's `runCursorTurnWithRetry` is ALREADY the iterative form: `for(;;) { try{run} catch{sleep} finally{await close} }` — close1 awaits BEFORE the loop re-enters make2. The SOURCE hunk rewrites it into recursion where `return attemptOnce(attempt+1)` inside the catch starts make2/run2 BEFORE the finally's close1 — the source INTRODUCES the ordering bug this doc exists to prevent. Disposition: REJECT the source hunk entirely (production code keeps the iterative form).
  - Two genuine dev gaps remain in scope: (1) close1 currently runs AFTER the backoff sleep (finally order) — the failed transport is held open through the backoff; move the close BEFORE `sleepWithAbort` on the retry path (retain finally for the success/no-retry paths, guarded against double-close). (2) a throwing `close()` in finally masks the run error (or kills a viable retry) — contain it: best-effort close with a swallowed error + `debugProviderDiagnostic("cursor","close-error",...)`; the ordering contract (close awaited before make2) is unchanged.
  - Tests (tests/cursor-transport-retry.test.ts exists, 140 lines — APPEND an ordering describe): event-recorded `make1, run1, close1, make2, run2, close2` with a DELAYED close1 proving make2 waits; close-failure containment (close1 throws → retry still proceeds and the turn succeeds; success-path close2 throws → turn still resolves, error swallowed); retry exhaustion (all attempts fail → every transport closed exactly once, final error propagates, close count == attempt count).
- MODIFY `src/adapters/cursor/transport-retry.ts`: end each failed attempt and await `close()` before constructing or running the next transport.
- Explicitly exclude source changes in discovery/MCP/native-exec/tool-definition files; they require separate consumers and are ledger-dropped here.
- MODIFY `tests/cursor-transport-retry.test.ts` to record `make1, run1, close1, make2, run2, close2`, including close failure and retry exhaustion behavior.
- Before -> after: recursive retry inside `try` causes `make2/run2` before `close1` -> iterative/structured retry closes first.
- Conditional activation: first attempt fails, close is delayed, second attempt succeeds; event order assertion proves the fixed path fired.
- Verification: `bun test tests/cursor-transport-retry.test.ts`; `bun run typecheck`; `bun run privacy:scan`; `git diff --check`; diff <=500.
- Attribution: maintainer repair + Wibias co-author.
- Rollback: final child reverts independently; no other Cursor subsystem is modified.
