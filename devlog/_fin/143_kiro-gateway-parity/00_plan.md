# 143 — Kiro <-> kiro-gateway Parity (catch-up)

Goal: raise opencodex's Kiro (CodeWhisperer) surface to kiro-gateway parity and
stabilize it. One FULL PABCD cycle per surface. Each surface closes with a
typecheck + targeted test and one atomic commit.

Upstream reference: https://github.com/jwadow/kiro-gateway (Python/FastAPI,
~14.8K LOC across kiro/*.py). opencodex Kiro surface today: src/adapters/kiro.ts
(474 lines) + src/oauth/kiro.ts + shared src/lib/eventstream-decoder.ts,
src/lib/token-estimate.ts, plus shared sidecars (src/vision, src/web-search).

## Gap matrix (gateway has -> opencodex kiro status)

| # | Surface | Gateway implementation | opencodex status | Phase |
|---|---------|------------------------|------------------|-------|
| 1 | Native image input | convert_images_to_kiro_format -> userInputMessage.images = [{format, source:{bytes}}] (converters_core.py 641-704, 1354-1362, 1520-1562). Parses OpenAI image_url data URLs + Anthropic image.source.base64 (185-297). | MISSING — userContentText (kiro.ts 91-94) drops every image part; payload has no images field. Vision sidecar also inactive (kiro not in noVisionModels). | 10 |
| 2 | Retry/backoff | network_errors.py classifies 403/429/5xx as retryable; routes retry with account failover. | MISSING — no retry/backoff in adapter or transport for kiro. | 20 |
| 3 | Payload size guard | payload_guards.py trim_payload_to_limit trims oldest history pairs under a byte cap; repairs orphaned tool results. | MISSING — no size guard / history trim. | 30 |
| 4 | Thinking parse-back | thinking_parser.py FSM extracts <thinking>/<think>/<reasoning> blocks from the response stream and emits them as reasoning_content. | PARTIAL — opencodex injects request-side thinking tags (kiro.ts 196-209) but does NOT parse response-side thinking blocks into reasoning events. | 40 |
| 5 | Smart model-name normalization | model_resolver.py normalize_model_name maps versioned/dashed slugs (claude-sonnet-4-5-20250929, claude-3-7-sonnet) to canonical ids. | WEAK — mapModelId (kiro.ts 56-58) only strips a kiro- prefix; no versioned-slug normalization. | 50 |
| 6 | Truncation recovery | truncation_recovery.py detects mid-stream truncation (Issue #56) and injects a synthetic recovery message so the model adapts. | MISSING — no truncation detection/recovery. | 60 |

## Surfaces intentionally NOT in scope (already at/above parity or out of band)

- Multi-account failover: opencodex has its own Codex multi-account pool
  (codexAccounts) at a different layer; kiro single-credential import is the
  documented design. Not a kiro-adapter gap.
- Anthropic/OpenAI dual API ingress: opencodex normalizes upstream-in via its
  own Responses parser; gateway's dual ingress is its own front door. Out of band.
- Web search: opencodex already has the shared web-search sidecar wired to kiro
  (parseResponse + loop). At parity.
- Token usage: closed in plan 142. CW emits no usage; heuristic estimate stands.

## PABCD discipline

- Phase 0 (this doc): design + gap matrix only. No code.
- Phases 10/20/30/40/50/60: one surface each = one full P->A->B->C->D cycle.
- Verification per surface: bun x tsc --noEmit + the surface's targeted
  bun test tests/... . Atomic commit per surface.
- Risk tiering: surfaces 1 (payload shape) and 3 (history trim) touch request
  construction -> STANDARD+; others LIGHT/STANDARD.

## Completion criteria

All six surfaces implemented, each with passing typecheck + tests and an atomic
commit, and a closing parity audit confirming no silent image drop, retry on
transient upstream failures, bounded payload, response-side reasoning surfaced,
versioned model slugs resolved, and truncation surfaced rather than swallowed.
