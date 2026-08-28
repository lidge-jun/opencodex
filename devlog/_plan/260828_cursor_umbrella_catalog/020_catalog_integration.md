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

### 2. MODIFY src/codex/catalog/provider-fetch.ts (~:1276-1310) — consume
the maxModeModels ALREADY returned by live-models.ts (:123-136; decoder
needs no change, A-gate finding 6): live maxMode ids union with
maxModeVerified static flags to arm the ultra->maxMode wire rung per base.

### 3. MODIFY src/providers/registry.ts (~:1092 cursor section) — model ids
from cursorUmbrellaRows(); modelReasoningEfforts from each row's
defaultVariant ladder; modelDefaultReasoningEfforts keeps kimi-k3: max.

### 3b. MODIFY src/codex/catalog/effort.ts (:219-226) — POLICY UNCHANGED
(A-gate blocker 5): synthetic max+ultra stay appended to every
reasoning-capable row for spawn validation. Add a comment distinguishing
catalog-synthetic ultra from wire maxMode. Regression test: spawn-validation
efforts for a cursor row WITHOUT maxModeVerified still include ultra, and
the adapter clamps it (existing clamp test extended).

### 4. MODIFY src/adapters/cursor/request-builder.ts — normalizeCursorModelId
/ effort composition delegate to resolveCursorSelection; grok-fast parameter
path preserved; ultra path generalized (maxMode for any bigContext base).

### 5. DELETE src/adapters/cursor/effort-map.ts once discovery +
request-builder consume catalog.ts; migrate any residual export the tests
reference.

### 6. Tests (exact paths, A-gate blocker 7):
- MODIFY tests/cursor-effort-suffix.test.ts — wire-id oracle table from 010
  stays green after consumers switch (the byte-equal back-compat proof).
- MODIFY tests/cursor-hardening.test.ts discovery sections — live filter
  with suffix + cursor-prefixed fixtures via the new parser.
- ADD tests/cursor-umbrella-rows.test.ts — cursorUmbrellaRows row count
  (4 router excluded; ~30 umbrellas), thinking-merged rows list their
  default-variant ladder, removed slugs absent from rows but RESOLVABLE via
  resolveCursorSelection (pinned-session survival unit proof), quarantined
  regular excluded while thinking sibling present.
- ADD focused catalog sync test: sync output cursor section row count +
  synthetic max/ultra still appended (spawn validation).
- Pinned-session integration: request with model cursor/claude-opus-5-thinking
  (removed row) through request-builder resolves to same wire id as today.

## Verifiers

bun test tests/cursor-catalog.test.ts tests/cursor-hardening.test.ts
+ discovery/sync-focused files; tsc; privacy scan; catalog sync dry-run
row output captured for 030.
