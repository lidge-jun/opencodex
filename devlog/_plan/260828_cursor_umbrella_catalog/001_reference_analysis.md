# 001 — senpi/omo architecture analysis (sol-high lane, verified)

## senpi (packages/ai/src/cursor/*)

- CURSOR_MODEL_CAPABILITIES (model-capabilities.ts:81-195): 34 capability ids,
  schema { evidence, window, maxWindow?, parameterOrder, defaultContext?,
  requestContext?, levels: {level -> {value, encoding: parameters|variant-id}} }.
  Claude order [thinking,context,effort]; GPT [context,reasoning,fast].
  1M via requestContext="1m" when window>=1M.
- Variant grammar (model-capabilities.ts:204-248): strip terminal -fast; then
  -thinking-<level> | -<level>-thinking | -thinking | -<level>; tokens
  minimal|low|medium|high|extra-high|xhigh|max|none.
- Grouping (catalog-grouping.ts): group key = targetId + fast — FAST IS A
  SEPARATE GROUP; Claude-only thinkingMode split (isClaude guard :45-47);
  members with efforts collapse to one entry with thinkingLevelMap; 336-row
  generated alias JSON maps live ids -> {targetId, level, legacyVariantId}.
- Wire (selection-descriptor.ts:85-120): alias-first — send catalog-served
  suffix id when known (Cursor Run rejects bare capability ids with Connect
  not_found, issue #1008); parameters fallback only when no alias; fast
  parameter hardcoded "false" (fast reachable only via separate fast ids).
- Discovery (cursor-agent.ts:4362-4495): 1M inferred from display-name /\b1m\b/i
  labels OR maxMode on /claude|gemini/ ids; reads thinkingDetails for
  reasoning flag; multimodal from id pattern.

## senpi weaknesses (our targets)

1. Fast modeled twice (parameter always false + separate groups) — incoherent.
2. Claude-only thinkingMode split — separate thinking identities remain rows.
3. Truth split across static TS table + 336-row generated JSON + name regex.
4. variant-id fallback silently degrades to representative id.

## omo-ai@beta

provider-map.json contains ZERO cursor model rows (cursor only in
builtinProviderIds; 5 provider-name aliases). Cursor architecture is delegated
to its pinned senpi runtime. Nothing to adopt beyond "don't do this" —
objective's cleanliness bar vs omo is met by having any self-contained map.
