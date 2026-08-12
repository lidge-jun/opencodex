# 260808 — metadata pipeline de-jawcode (rename + full external-dependency removal)

Loop archetype: spec-satisfaction repair (single PABCD cycle).
Trigger: user request — "의존성도 완전히 제거하고 파일이름도 바꿔놔".
Goal: the bundled model-metadata pipeline no longer references the jawcode
checkout, the jawcode repo, or jawcode-named files/symbols; all gates green.
Non-goals (recorded boundary, contract surface — separate decision):
- the `source: "jawcode"` price-source literal and `jawcodeProvider` field in
  `src/usage/cost.ts` (serialized shape; usage-cost tests and the Logs payload
  assert it),
- the `jawcodeBundle` registry field and `deriveJawcodeAliases` in
  `src/providers/derive.ts` (registry schema),
- the jawcode provider itself (product surface: OAuth, registry, wire ids),
- devlog history docs (records of past work; not rewritten),
- jawcode repo work (price-cut branch merge).
Verifier: `bun run typecheck`; `bun test` on the affected suites; an `rg`
sweep showing zero pipeline references to the old names; `bun run
privacy:scan`; generator idempotence (rerun → no diff).
Stop condition: all verifiers green and the sweep clean.
Memory artifact: this unit; D archives to `_fin/`.
Expected terminal outcome: DONE. Escalation: a name clash, a wire-visible
consumer of the renamed symbols, or test expectations pinning old names
beyond the mapped set → stop and report.

## File change map

RENAME (git mv, content otherwise regenerated or unchanged):
1. `scripts/jawcode-models.json` → `scripts/model-metadata.source.json`
2. `scripts/generate-jawcode-metadata.ts` → `scripts/generate-model-metadata.ts`
3. `src/generated/jawcode-model-metadata.ts` → `src/generated/model-metadata.ts`
4. `tests/jawcode-metadata-sync.test.ts` → `tests/model-metadata-sync.test.ts`

MODIFY:
5. `package.json` — script `generate:jawcode-metadata` → `generate:model-metadata`.
6. generator — drop the `JAWCODE_MODELS_JSON` override entirely (fixed source =
   the vendored snapshot next to the script); rename `JAWCODE_METADATA_OUT` →
   `MODEL_METADATA_OUT` (still needed by the sync guard's temp regen);
   the DEFAULT OUTPUT also moves from `process.cwd()`-relative to
   `resolve(import.meta.dir, "../src/generated/model-metadata.ts")` so the
   from-any-cwd activation scenario holds for output as well as source
   (A-round blocker, reviewer Cicero);
   regenerate the output module with renamed exports; header comment no longer
   instructs jawcode-checkout workflows (one short provenance line stays:
   the snapshot's content origin is recorded in the unit docs, not code).
7. generated module exports:
   `JawcodeModelMetadata` → `ModelMetadata`,
   `resolveJawcodeProvider` → `resolveMetadataProvider`,
   `getJawcodeModelMetadata` → `getModelMetadata`,
   `getJawcodeModelMetadataCaseInsensitive` → `getModelMetadataCaseInsensitive`,
   `listJawcodeModelMetadata` → `listModelMetadata`,
   `findJawcodeCostByModelId` → `findVendorCostByModelId`.
   (Clash sweep 2026-08-08: zero hits for every new name across src/, tests/,
   gui/src/.)
8. consumers — import path + symbol updates only:
   `src/codex/catalog/{sync,aggregation,metadata,parsing,bundled,effort,provider-fetch}.ts`,
   `src/usage/cost.ts`, `src/codex/catalog.ts` (re-export),
   `tests/{codex-catalog,provider-registry-parity,slug-codec}.test.ts`.
9. non-generated renames:
   `applyJawcodeCatalogMetadata` → `applyCatalogMetadata`
   (parsing.ts definition; sync.ts:269,306 callers),
   `augmentRoutedModelsWithJawcodeMetadata` → `augmentRoutedModelsWithMetadata`
   (provider-fetch.ts definition + :1225 caller; catalog.ts:8 re-export;
   codex-catalog.test.ts import),
   local `jawcodeProvider` variables → `metadataProvider`.
   Serialized keys stay byte-identical: at `src/usage/cost.ts:220` the rename
   must be the explicit `jawcodeProvider: metadataProvider`, never the
   `{ metadataProvider }` shorthand — the GUI reads `jawcodeProvider` at
   `gui/src/pages/Logs.tsx:1004` (A-round observation, folded).

## Activation scenarios

- Sync guard temp-regen path (`MODEL_METADATA_OUT`): exercised by running
  `tests/model-metadata-sync.test.ts` — pass proves the generator honors the
  renamed env and the byte-compare path.
- Generator fixed-source path: running `bun run generate:model-metadata`
  from any cwd (including a worktree without a sibling jawcode checkout)
  must succeed and be idempotent (second run → zero diff).

## Verification commands (pre-run at P)

- `bun run typecheck` — ran this session, exit 0; reads all touched TS via
  the project tsconfig.
- `bun test tests/model-metadata-sync.test.ts tests/codex-catalog.test.ts
  tests/provider-registry-parity.test.ts tests/slug-codec.test.ts
  tests/usage-cost.test.ts tests/cost-scoring.test.ts
  tests/zhipu-bigmodel-provider.test.ts
  tests/management-api-logs-metrics.test.ts` — all exist and pass on the
  pre-rename tree (239 pass this session); they import the renamed modules
  directly, so they read the change target.
- `bun run privacy:scan` — ran this session, passed; scans the repo incl.
  the renamed snapshot.
