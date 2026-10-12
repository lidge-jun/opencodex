# wp4 audit r1 — synthesis

Reviewer: grok-4.6 subagent (Feynman), read-only, 7 questions on 040. Verdict: **near-pass / GO-WITH-FIXES** (3 blockers, 3 suggestions).

## Answers that confirm the plan

- Union (Q1): safe only if written as an ordered dedupe set `[vertexDefault?, ...models, ...retainModels]`, replacing the current `seed ? [default] : models` ternary. `configured` is the single seed for static `liveModels:false`, the Cursor filter, the degraded fallback, `droppedConfiguredIds`, and hints, so a retain-only id gets the same context/effort maps as a `models[]` entry. The Vertex seed predicate (`models.length === 0`) stays untouched.
- Family match (Q2): acceptable, same semantics as `noVisionModels`. `retainModels: ["gpt-oss"]` keeps `gpt-oss:120b` and also invents a bare `gpt-oss` row through the union — extra row, never a drop.
- selectedModels precedence (Q3): `filterCatalogVisibleModels` and `sync.ts` still hide a retained id when `selectedModels` is non-empty and omits it. Keep that; document "retain ≠ visible".
- PATCH (Q4): copy `provider-routes.ts:386` verbatim; also GET list (:540).
- CLI (Q5): no `takeListOption`; use `csv(takeOption)` and special-case `"-"` **before** `csv` (`csv("-")` yields `["-"]`).
- #2122 (Q6): union, schema, `MODEL_ID_LISTS` are the necessary parts; the 404 module maps and `retainedWithoutDiscovery` are not. The `withConfiguredRetention(live→forCache)` change is incidental — the double merge is the OCX-111 combo-cache contract. Do not copy.
- No-regression (Q7): absent/empty is a no-op; kimi/xai tables unchanged.

## Blockers folded into 040

1. `src/server/auth-cors.ts` was missing from the file list: `providerManagementConfigError` (~693) must validate `retainModels` with `nonBlankStringArrayConfigError`, and the safe-config DTO key list (~794) must include it, otherwise PATCH validation and DTO echo silently miss.
2. The "liveModels:false / retain-only present" criterion cannot be proven through `mergeConfiguredModelsIntoLiveCatalog` alone. Add a test that goes through `fetchProviderModels`/the gather path so the union at :1307 is actually exercised.
3. CLI: handle `-` before `csv`.

## Suggestions taken

- Docs state that `selectedModels` still narrows what is visible even for retained ids.
- `retainModels` added to `providerCatalogFingerprint` (:573) so two providers differing only in that list do not share a discovery flight.
- Flip #2860's "does not invent ids" test to assert the union.

## Disposition

All three blockers are additive edits inside the already-planned files plus one file (`auth-cors.ts`). No scope change. Proceed to B.

