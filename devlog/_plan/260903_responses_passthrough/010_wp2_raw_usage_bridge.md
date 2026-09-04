# 010 — wp2: carry raw upstream usage through the AdapterEvent bridge

## Goal

openai/codex#41980 preserves the complete raw `response.usage` object. opencodex's translated/
buffered path (bridgeToResponsesSSE + buildResponseJSON) must do the same instead of rebuilding
usage from the closed OcxUsage shape.

## Files

- `src/types/request.ts` (OcxUsage): `rawUsage?: Record<string, unknown>` — the raw upstream usage
  object; wire data only, accounting keeps reading the canonical fields.
- `src/adapters/openai-responses.ts` `usageFromResponsesPayload`: capture the raw usage object when
  unknown keys exist (top-level or nested details); stop dropping metadata-only usage; charge the
  retained clone to the translator budget.
- `src/bridge.ts` `responsesUsage()`: merge extras under normalized known keys; nested detail extras
  preserved; `cache_write_tokens` never copied raw (validated normalized value only).
- `src/server/responses/empty-completion-guard.ts` `mergeUsage`: the content attempt's rawUsage wins.

## Tests

tests/responses-usage-passthrough.test.ts: stream/non-stream adapter extras, metadata-only usage
kept, canonical-only narrow, rebuild merge + strict defaults, unknown-shaped known key excluded,
retry merge.

## Close-out (D)

- Commit 1f0d820aa: OcxUsage.rawUsage + adapter extras capture (incl. zero-count metadata-only usage) +
  responsesUsage merge; tests in tests/responses-usage-passthrough.test.ts.
- Review: 5 subagent dispatches failed pool-wide (401/capacity/transport); direct independent audit PASS.
  Nuance accepted: zero-count-with-extras usage shows 0 tokens in display.
- Residual: unknown response.* event types dropped on translated paths (B3) — separate unit.
