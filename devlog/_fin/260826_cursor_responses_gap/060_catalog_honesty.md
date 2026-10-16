# 060 — Fix D: catalog honesty for dead upstream models (codex/cursor-gap-4)

Research: sol lane Schrödinger. cursor/claude-opus-5 exposure chain:
static seed discovery.ts:248 -> effort-map.ts:33 suffixes ->
registry.ts:1037 -> live filter only checks GetUsableModels ID presence
(discovery.ts:78) -> provider-fetch.ts:1281 serves it. Upstream returns
not_found on every Run (probe C2a, 100%).

## Diff plan

1. EDIT discovery.ts — remove base claude-opus-5 from
   CURSOR_STATIC_MODELS (keep -fast and -thinking families: separate
   wire families with success evidence).
2. ADD narrow quarantine set CURSOR_KNOWN_UNCALLABLE_MODEL_IDS applied in
   the cursor branch of provider-fetch.ts before auth/fallback so stale
   caches and discovery-failure fallbacks cannot resurrect the row.
   Custom user provider overrides are NOT touched.

## Accept criteria

- Gathered canonical cursor catalog excludes cursor/claude-opus-5 even
  when GetUsableModels lists claude-opus-5-* ids (test).
- claude-opus-5-fast / -thinking siblings survive (test).
- No-auth, discovery-failure, stale-cache paths stay quarantined (test).
- Tests: cursor-hardening, cursor-static-catalog, cursor-discovery.
