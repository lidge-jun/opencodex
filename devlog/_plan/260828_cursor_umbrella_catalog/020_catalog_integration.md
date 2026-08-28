# 020 — wp3: integration (PR B, codex/cursor-umbrella-wire, stacked on PR A)

## Changes

### 1. MODIFY src/adapters/cursor/discovery.ts

- CURSOR_STATIC_MODELS: replace 52+13 explicit rows with rows generated from
  cursorUmbrellaRows() (+ 4 router rows kept literal). claude-4-sonnet-1m
  stays (real wire id) as alias metadata.
- CURSOR_ULTRA_1M_MODEL_IDS + cursorUltraBaseModelId: reimplement over
  parseCursorVariantId ultra dimension (any bigContext base), keeping the
  kimi-k3-1m alias.
- filterCursorConfiguredModelsByLiveDiscovery: match live suffix ids via
  parseCursorVariantId(base match) instead of enumerated suffix compose.
- inferCursorContextWindow: read window from CURSOR_CAPABILITIES first,
  fall through to current heuristics for unknown ids.

### 2. MODIFY src/adapters/cursor/live-models.ts — stop discarding maxMode:
return maxModeModels and thread into provider-fetch so live maxMode marks
bigContext on matching bases (union with static flags).

### 3. MODIFY src/providers/registry.ts cursor section — efforts from
cursorUmbrellaRows(); defaults: keep kimi-k3 max; thinking-merged rows
default per capability.

### 4. MODIFY src/adapters/cursor/request-builder.ts — normalizeCursorModelId
/ effort composition delegate to resolveCursorSelection; grok-fast parameter
path preserved; ultra path generalized (maxMode for any bigContext base).

### 5. DELETE src/adapters/cursor/effort-map.ts once discovery +
request-builder consume catalog.ts; migrate any residual export the tests
reference.

### 6. Tests — MODIFY tests near existing cursor suites: discovery filter
with live suffix fixtures; registry efforts snapshot (row count ~34);
request-builder wire ids unchanged for every legacy fixture (byte-equal
wire id table test — the back-compat proof); sync row-count before/after.

## Verifiers

bun test tests/cursor-catalog.test.ts tests/cursor-hardening.test.ts
+ discovery/sync-focused files; tsc; privacy scan; catalog sync dry-run
row output captured for 030.
