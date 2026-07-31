# 040 — Phase 4: /v1/messages native passthrough normalization

## Gap

`anthropicNativePassthrough` (src/server/claude-messages.ts:169-241) forwards Claude-Code
client bodies verbatim to api.anthropic.com — no `normalizeAnthropicImages`, no
`enforceAnthropicImageLimits` (rg-verified). Claude Code resizes single images at
ingestion (001 §2) but its HISTORY still accumulates: >20MiB aggregate base64 and >100
images reproduce 413/400 through ocx. The routed (non-passthrough) branch is covered via
the anthropic adapter; only the native branch leaks.

## Diff plan

### MODIFY `src/server/claude-messages.ts`

In `anthropicNativePassthrough`, immediately before `JSON.stringify(body)`
(~:200, the fetch): when `Array.isArray(body.messages)`, run
`await normalizeAnthropicImages(body.messages)` then
`enforceAnthropicImageLimits(body.messages)`. Imports from the two adapter modules.

- Applies to BOTH pathnames ("/v1/messages" AND "/v1/messages/count_tokens"):
  count_tokens must count what the real send will contain, and the 32MB body cap
  applies to it equally. Non-message bodies (missing/non-array `messages`) untouched.
- Mutation safety: `body` is this request's freshly parsed JSON (readJsonRequestBody →
  local Rec); `captureClaudeInbound` runs BEFORE passthrough and captures the original.
- Client images are already ingestion-resized by Claude Code, so the normalize pass is
  usually validated-pass-through (cached per unique image) — steady-state cost ≈ hash
  lookups.

## Tests (audit round 1 amendments folded)

EXTEND the existing harness `tests/claude-native-passthrough.test.ts` (it already
constructs full native-branch reachability: passthrough enabled + claude* model +
sk-ant-* credential + scripted upstream — :64/:89/:132) with body-capturing cases:
- P1 (age tiering, decodable fixtures): 30 REAL 1500×1000 PNGs in history → upstream
  body has newest 6 as PNG pass-through, older re-encoded JPEG ≤1024/≤700px, aggregate
  ≤ budget (activation: removing the wiring fails this).
- P2 (oversize handling is normalization, not textify): one REAL image whose base64
  exceeds 5MiB arrives RE-ENCODED under the tier-0 cap (valid data shrinks; textify is
  only for undecodable/all-terminal — audit correction).
- P2b (guard activation on this path): 101 tiny valid images → guard 100-cap textifies
  the oldest one.
- P3 (no regression): non-image body arrives semantically equal (object equality, not
  byte identity — passthrough already reserializes JSON).
- P4: count_tokens path normalized identically.
- P5 (Files API preservation): a single `source.type:"file"` image block passes through
  untouched.

## Accept criteria (criterion c1)

P1-P4 green + full gates green + reviewer verdict recorded.
