# 010 — wp2: capability core module (PR A, codex/cursor-umbrella-core -> dev)

## Changes

### 1. ADD src/adapters/cursor/catalog.ts

- export interface CursorCapability { levels: readonly CursorEffort[];
  thinking?: { order: "thinking-then-effort" | "effort-then-thinking" | "bare" };
  fast?: boolean; bigContext?: boolean; window: number; quarantined?: boolean }
- export const CURSOR_CAPABILITIES: Record<string, CursorCapability> —
  seeded from today's CURSOR_MODEL_EFFORT_TIERS (46) + CURSOR_THINKING_FAMILIES
  (13) + senpi windows (001 table), collapsed to ~30 base entries: thinking
  variants become thinking:{order} on the base; -fast entries become fast:true;
  kimi-k3-1m becomes bigContext:true on kimi-k3; claude/gemini/gpt-5.6 windows
  per senpi (1M) with bigContext on claude+gemini+kimi families.
- export function parseCursorVariantId(id): { baseId, level?, thinking,
  fast, ultra } — senpi grammar + our -1m suffix; level tokens
  minimal|low|medium|high|extra-high|xhigh|max|none.
- export function resolveCursorSelection(pickedId, codexEffort?):
  { wireId, maxMode, params: [] } — suffix-id-first composition reusing the
  order rules currently in cursorWireModelIdWithEffort; ultra ->
  top-level + maxMode when bigContext; grok fast keeps the parameter path.
- export function cursorUmbrellaRows(): { id, efforts, defaultEffort,
  window, bigContext }[] — picker list derivation (router ids stay in
  discovery).

### 2. Tests — ADD tests/cursor-catalog.test.ts

Named activation per branch: grammar round-trip for ALL 69 legacy ids
(fixture list frozen from discovery.ts seed) -> every id parses to a known
base; thinking merge (claude-opus-5 + high -> claude-opus-5-thinking-high);
bare-thinking families (claude-4-sonnet) ignore effort; fast alias
resolution; ultra on bigContext base -> maxMode + top effort; ultra on
non-bigContext -> clamps to max, no maxMode; quarantine row excluded from
umbrella rows; unknown id passthrough unchanged.

### 3. NO consumer changes in this PR (effort-map untouched) — additive
module + tests only, so the diff reviews clean.

## Verifiers

bun test tests/cursor-catalog.test.ts; bun x tsc --noEmit; privacy scan.
