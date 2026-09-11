# 002 — current opencodex cursor surface (grok-4.6 lane, verified)

- effort-map.ts (229 L): CURSOR_MODEL_EFFORT_TIERS 46 hand-kept ids;
  CURSOR_THINKING_FAMILIES 13 ids with per-family wire order; consumers:
  discovery.ts + request-builder.ts only.
- discovery.ts: 69-row static seed (4 router + 52 + 13 thinking);
  inferCursorContextWindow (:27-38) hardcodes per-family windows; synthetic
  ultra marker = kimi-k3-1m ONLY (:158-174); live merge is a FILTER (45 of 69 rows carry ladders; quarantined opus-5 is a map key but not seeded) (never
  adds rows, provider-fetch.ts:1276); claude-opus-5 quarantined; dead
  CURSOR_REASONING_EFFORTS const.
- live-models.ts: decode keeps modelId + maxMode only; DISCARDS displayName,
  displayNameShort, displayModelId, aliases, thinkingDetails; maxModeModels
  returned but unconsumed.
- sync.ts/effort.ts: picker rows cursor/<id>, efforts via
  cursorModelReasoningEfforts; synthetic max+ultra appended (effort.ts:219);
  kimi-k3-1m default effort falls to high (not pinned).
- request path (request-builder.ts:189, protobuf-request.ts:996): suffix-id
  first; parameters only for grok-fast / router level / maxMode(ultra);
  thinkingDetails never sent.
- Duplicate rows today: 13 thinking + 7 fast + 2 x 1m = 22 of 69 are variants
  of a base.
