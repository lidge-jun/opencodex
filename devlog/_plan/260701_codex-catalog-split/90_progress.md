# codex-catalog.ts split - progress (WP5)

Date: 2026-07-01
Status: ORACLE LANDED, file split DEFERRED.

## Done

- Built the behavior-preservation oracle: tests/codex-catalog-golden.test.ts
  snapshots the pure buildCatalogEntries output for a fixed native+routed input
  set, asserting the invariants a split must not change: identity neutralization
  (routed strips "based on GPT-5", native keeps it), featured priority ordering
  (featured slugs get lowest priorities), and ws opt-out. Passes on current code.

## Deferred (NOT done) - the 3-way file split

codex-catalog.ts has the same high-coupling profile as the server.ts inner
split: module-level bundledCatalogCache, ~14 imports, and the pure build core
(buildCatalogEntries/deriveEntry/normalizeRoutedCatalogEntry) is interleaved
with fs (materializeBundledCodexCatalog/loadBundledCodexCatalog/restore) and
network (gatherRoutedModels/syncCatalogModels). A safe split needs a dedicated
session.

## Recommendation for the dedicated session

1. The oracle (golden test) is already in place - run it red/green around every
   move.
2. Extract persistence.ts (fs) first, then discovery.ts (network + cache), then
   build.ts (pure, incl. identity neutralization) last.
3. codex-catalog.ts becomes the barrel + orchestrator; keep all 8 test-imported
   symbols + the 4 src consumers importable from ../src/codex-catalog.
4. The injected catalog must stay byte-identical for identical inputs - the
   golden oracle proves it.
