# 010 — wp2: capability core module (PR A, codex/cursor-umbrella-core -> dev)

## Changes

### 1. ADD src/adapters/cursor/catalog.ts

- export type CursorVariantKind = "regular" | "thinking" | "fast" | "thinkingFast";
- export interface CursorVariantSpec { levels: readonly string[];
  order?: "thinking-then-effort" | "effort-then-thinking" | "bare";
  quarantined?: boolean }
- export interface CursorCapability { variants: Partial<Record<CursorVariantKind,
  CursorVariantSpec>>; defaultVariant: CursorVariantKind; window: number;
  maxModeVerified?: boolean; wirePrefix?: "cursor-" }
  (A-gate blocker 1: per-variant ladders — claude-opus-5 fast low/med/high
  vs thinkingFast low..max representable; defaultVariant = thinking when a
  thinking variant exists, else regular; quarantine per-variant — blocker 3.)
- export const CURSOR_CAPABILITIES: Record<string, CursorCapability> —
  seeded 1:1 from CURSOR_MODEL_EFFORT_TIERS + CURSOR_THINKING_FAMILIES +
  senpi window table; maxModeVerified only on kimi-k3 (blocker 4);
  wirePrefix "cursor-" on grok-4.5/grok-4.6 regular.
- export function parseCursorVariantId(id): { baseId, kind, level?, ultra }
  with STRICT precedence (blocker 2): (1) exact base-id table hit (covers
  gpt-5.1-codex-max, gpt-5.5-extra, claude-4-sonnet-1m as real identities);
  (2) cursor- prefix strip + re-lookup; (3) -1m synthetic suffix; (4) senpi
  suffix grammar (strip -fast; -thinking-<lvl> | -<lvl>-thinking |
  -thinking | -<lvl>); tokens minimal|low|medium|high|extra-high|xhigh|max|none.
- export function resolveCursorSelection(pickedId, codexEffort?):
  { wireId, maxMode, params: [] } — suffix-id-first composition reusing the
  order rules currently in cursorWireModelIdWithEffort; ultra ->
  top-level + maxMode when bigContext; grok fast keeps the parameter path.
- export function cursorUmbrellaRows(): { id, efforts, defaultEffort,
  window, bigContext }[] — picker list derivation (router ids stay in
  discovery).

### 2. Tests — ADD tests/cursor-catalog.test.ts

Named activation per branch, with a FROZEN fixture table (all 69 seed ids +
cursor- prefixed wire forms + representative live suffix ids) asserting
(parsedBase, kind, level) AND resolved wire id byte-equality against the
CURRENT cursorWireModelIdWithEffort/cursorRequestWireModelIdWithEffort
output (generated once from the old module while it still exists — the
back-compat oracle). Plus: precedence cases (gpt-5.1-codex-max stays a base;
gpt-5.5-extra + any effort -> gpt-5.5-extra-high; cursor-grok-4.6-xhigh
round-trips); thinking default variant; bare-thinking ignores effort;
per-variant ladder divergence (opus-5 fast vs thinkingFast); ultra ->
maxMode ONLY on maxModeVerified; ultra elsewhere clamps to ladder top
without maxMode; variant-specific quarantine (opus-5 regular excluded,
thinking present); unknown id passthrough.

### 3. NO consumer changes in this PR (effort-map untouched) — additive
module + tests only, so the diff reviews clean.

## Verifiers

bun test tests/cursor-catalog.test.ts; bun x tsc --noEmit; privacy scan.
