# 260816 — Local-model capability evidence and browser-plugin routing

## Objective

A local Qwen model (`lidge/qwen3.8-27b-nvfp4`, llama.cpp behind an
`openai-chat` adapter) could not drive the Chrome or Computer Use browser
plugins. Investigating that failure surfaced a defect in
`src/routing/capability.ts` that is **not local-model specific**: the cached
Codex catalog is read on every policy-routed request and then discarded in
full, because the reader expects a field shape the catalog writer never
produces.

This unit fixes the capability-evidence defect, records the live-catalog
ingestion gap, and writes durable routing guidance for weaker local models
that must reach the browser plugins through the privileged Node REPL tool.

## Constraints

- `src/routing/capability.ts` is on the request path for every policy-routed
  request. The memoized catalog read exists precisely so the parse cost is not
  paid per candidate; a fix must not turn it into a per-candidate parse.
- "Unknown is not zero" is the module's stated contract (file header): a
  dimension without canonical evidence must stay `undefined`, never `false`.
  The fix must not convert a missing catalog field into a negative assertion.
- `src/routing/capability.ts` is reachable from `src/router.ts`, so the
  core/lab boundary in `tests/core-lab-boundary.test.ts` applies: no import
  may reach `src/lab/`.
- Out of scope: promotion to `main`, npm publish, GUI redesign, unrelated
  provider adapters.

## Dependency-ordered work-phase map

The order is build-order, not effort order: the catalog reader is the
foundation both later phases depend on.

| Phase | Doc | Depends on | Independently verifiable by |
|-------|-----|------------|------------------------------|
| 1 | `010_catalog_row_shape.md` | — | New focused test: catalog-sourced evidence survives for a routed row |
| 2 | `020_live_capability_ingestion.md` | Phase 1 | Focused test driving the observed llama.cpp `/v1/models` payload |
| 3 | `030_local_model_plugin_routing.md` | — (docs surface) | The written guidance resolves on the documented path |

Phase 3 has no code dependency on 1 or 2 and could land in any order; it is
listed last because it is documentation, not because it is smaller.

## Source-of-truth sync target (SOT-SYNC-01)

`structure/` holds maintainer invariants. Phase 1 changes how routing evidence
is sourced, so C patches the structure note that describes routing evidence if
one exists; if none does, the D summary recommends creating it.

## Research documents

- `001_capability_evidence_defect.md` — the reproduction, the field-shape
  mismatch, and why every existing test passes over it.
- `002_local_model_plugin_failure.md` — why the local model could not reach
  the Chrome and Computer Use plugins.

## Filed issues

| Issue | Covers | Fixed by |
|-------|--------|----------|
| [#1796](https://github.com/lidge-jun/opencodex/issues/1796) | Routing discards every catalog row (field-shape mismatch) | Phase 1 |
| [#1797](https://github.com/lidge-jun/opencodex/issues/1797) | llama.cpp `multimodal` token + dual-envelope join | Deferred; Phase 2 ships the context half only |

Phase 3 files no issue: it is host-side guidance with no opencodex defect
behind it (see `002_local_model_plugin_failure.md`).
