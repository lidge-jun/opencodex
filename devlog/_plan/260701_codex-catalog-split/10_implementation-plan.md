# codex-catalog.ts split - jawdev implementation plan (PABCD work-phases)

Date: 2026-07-01
Status: SCAFFOLD - ready to execute under cxc-loop.
Prereq: the two adapter bug fixes land first; server.ts split may run in
parallel (no file overlap).

## Measured contract (the safety net)

tsconfig include ["src"] -> src/codex-catalog/*.ts auto-compiles.

Tests import these from ../src/codex-catalog (keep importable via barrel):
- codex-catalog.test.ts: augmentRoutedModelsWithJawcodeMetadata,
  buildCatalogEntries, filterSupportedNativeSlugs, gatherRoutedModels,
  isMediaGenerationModelId, loadBundledCodexCatalog,
  materializeBundledCodexCatalog, normalizeRoutedCatalogEntry
- provider-registry-parity.test.ts: buildCatalogEntries
- reasoning-effort.test.ts: buildCatalogEntries

src consumers (keep importable via barrel):
- codex-inject.ts: restoreCodexCatalog
- codex-refresh.ts: invalidateCodexModelsCache, syncCatalogModels
- model-cache.ts: type CatalogModel
- server.ts: type CatalogModel, invalidateCodexModelsCache, readCodexCatalogPath

RULE: codex-catalog.ts becomes a barrel re-exporting all of the above. Zero
import-path churn in tests or src.

## P - Plan / golden snapshot FIRST (work-phase 0)

The catalog is injected into Codex (the on-disk opencodex-catalog.json). The
split must be byte-identical for the same inputs. So BEFORE moving anything:

1. grep -nE '^export ' src/codex-catalog.ts -> freeze the public surface to
   11_export-inventory.md.
2. Add a GOLDEN test: feed a fixed provider/model input set into
   buildCatalogEntries (+ materializeBundledCodexCatalog) and snapshot the
   serialized result. This test must pass on the CURRENT code first - it is the
   behavior-preservation oracle for every later WP.
3. Baseline: tsc 0; bun test ./tests/ (record count); privacy passed.

Exit P when the golden snapshot is committed and green on unchanged code.

## Work-phases

### WP1 - persistence.ts (filesystem, lowest logic risk)
- Move: catalog file read/write, backup/restore, readCodexCatalogPath
  (exported), restoreCodexCatalog (exported), materializeBundledCodexCatalog
  (exported), loadBundledCodexCatalog (exported).
- Barrel re-export all four.
- C-gate: golden snapshot unchanged; tsc 0; suite == baseline; privacy passed.

### WP2 - discovery.ts (network + cache)
- Move: provider model fetch, the models cache, invalidateCodexModelsCache
  (exported), syncCatalogModels (exported), gatherRoutedModels (exported),
  filterSupportedNativeSlugs (exported).
- The cache is module state -> if runtime-state-consolidation is running,
  coordinate ownership; otherwise keep it here with an invalidate() hook.
- Barrel re-export. C-gate as WP1.

### WP3 - build.ts (PURE - the prize; do last)
- Move: deriveEntry, buildCatalogEntries (exported), normalizeRoutedCatalogEntry
  (exported), augmentRoutedModelsWithJawcodeMetadata (exported),
  isMediaGenerationModelId (exported), reasoning-levels application, strict
  field normalization, AND the identity base_instructions neutralization
  (routed entries; the "coding agent powered by the X model" replace).
- NO fs, NO network in this module after the move (that is the point).
- A-gate: reviewer confirms the pure logic is unchanged and identity
  neutralization still fires for routed entries.
- C-gate: golden snapshot unchanged; identity tests green
  (tests/identity-neutralize.test.ts, tests/codex-catalog*.test.ts);
  reasoning-effort.test.ts green; full suite == baseline; privacy passed.

### WP4 - codex-catalog.ts becomes the thin orchestrator
- Keep only: the public barrel + any compose function that wires
  discovery -> build -> persistence. Confirm no logic remains that belongs in a
  leaf module.
- C-gate: golden snapshot unchanged; full suite == baseline.

## D - close

Record per-WP C-evidence (commands + counts + "golden snapshot: unchanged").
Final D: codex-catalog.ts line count recorded, golden + identity + full suite
green, zero import churn. Move entry to _fin.

## Hard invariants

- Injected catalog byte-identical for identical inputs (golden oracle proves it).
- Identity neutralization for routed base_instructions MUST keep working.
- Pure move + re-wire; green at every commit; one module per commit.
