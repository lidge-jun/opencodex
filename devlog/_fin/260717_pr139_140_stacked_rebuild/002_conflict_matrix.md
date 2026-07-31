# Source overlap and synthesis matrix

## Textual conflicts between #139 and #140

| Path | Owner/order | Synthesis rule |
|---|---|---|
| `gui/package.json` | 100 then 110 | Preserve #139 lint scope; add only pinned Doctor commands/dependency in 110. Regenerate lockfile there. |
| `gui/src/App.tsx` | 080 then 120 | #139 owns Providers workspace navigation; #140 may add query/client wiring without reverting routes or layout. |
| `gui/src/components/AddCodexAccountModal.tsx` | 060 then 120 | #139 owns account flow/copy; #140 contributes only verified accessibility/query-state improvements. |
| `gui/src/components/AddProviderModal.tsx` | 050 then 120 | Keep decomposed #139 catalog; port only #140 diagnostics that still apply to the new modules. |
| `gui/src/pages/CodexAuth.tsx` -> `gui/src/components/CodexAccountPool.tsx` | 060 then 150 | Treat rename/extraction as #139 ownership; #140 changes are reapplied to the extracted component only when behavior-level tests justify them. |
| `gui/src/components/QuotaBars.tsx` | 070 then 130 | #139 owns stacked quota semantics; #140 diagnostics cannot flatten or remove five-hour/weekly rows. |
| `gui/src/pages/Providers.tsx` | 040-100 then 130 | Never choose either whole file. Reapply #140 query/diagnostic deltas to the final #139 orchestration shell. |
| `tests/xai-refresh-lock.test.ts` | drop both | Both changes are unrelated to provider workspace/Doctor children. Preserve current `origin/dev`; handle xAI race in its own unit if needed. |

## Clean shared paths

| Path | Owner/order | Synthesis rule |
|---|---|---|
| `gui/src/styles.css` | 100 then 130/140/150 | Component/page selectors land with their owning child; no bulk stylesheet import. |
| `src/providers/derive.ts` | 010 then 130 | #139 contract fields land first; #140 catalog optimization is retained only with output-parity tests. |
| `src/server/management-api.ts` | 040 then 130 | #139 repairs mutation/test-connection invariants; #140 changes may not bypass them. |
| `src/types.ts` | 010 then 130 | #139 owns provider config schema additions; #140 additions require an independent consumer. |

## Hard blockers that must become tests

1. #139 connection test: static/stale model fallback cannot produce `{ok:true}` for an unreachable provider.
2. #139 key mutation: active API key and `apiKeyPool` update atomically through the existing key owner.
3. #140 image normalization: peak decode concurrency stays at the explicit bound.
4. #140 Cursor retry: `close(previous)` occurs before `make(next)`/`run(next)`.
5. #140 tooling/update: package/action are immutable, and update verification/install use the same immutable version with unavailable-version coverage.

## Final reconciliation gate

At stack tip, compare every ledger row to its child evidence. A retained/rewrite row without a landed commit/test is a blocker; a dropped row without the recorded rationale is a blocker. Exact equality with either contributor integration tree is not expected because the stack deliberately repairs blockers and drops unowned churn.
