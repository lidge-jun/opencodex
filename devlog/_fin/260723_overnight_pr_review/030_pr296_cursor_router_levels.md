# 030 — PR #296: Add Cursor Router optimization levels

- **Author:** jontonsoup (Jonathan Friedman)
- **Branch:** codex/cursor-routing-levels → dev
- **CI:** enforce-target pass (4x)
- **Decision:** MERGE
- **Risk:** Low-Medium (well-scoped adapter change, tests included)

## Changes

1. `src/adapters/cursor/discovery.ts` — adds `CURSOR_ROUTING_LEVELS` type, `CURSOR_ROUTER_MODEL_IDS`, `cursorWireModelSelection()`, `isCursorRouterModelId()`. Router models survive live discovery filter.
2. `src/adapters/cursor/protobuf-request.ts` — adds `requestedModel.parameters` with `optimization` param for routing level.
3. `src/adapters/cursor/request-builder.ts` — `normalizeCursorModelId` now returns `{ modelId, routingLevel? }`.
4. `src/adapters/cursor/types.ts` — adds `routingLevel?: CursorRoutingLevel` to `CursorRunRequest`.
5. `structure/04_transports-and-sidecars.md` — documents Router optimization levels section.
6. `docs-site/` — adapters.md + configuration.md updated with model table.
7. Tests: `codex-catalog.test.ts`, `cursor-adapter.test.ts`, `cursor-blob.test.ts`, `cursor-discovery.test.ts` — comprehensive coverage.

## Review

- Clean implementation. Exposes Cursor's hidden `optimization` parameter as first-class model IDs.
- Backwards compatible: `cursor/auto` unchanged, new IDs are additive.
- Tested: catalog lists all 4 router IDs, discovery filter keeps them, wire encoding includes parameter.
