# 260903_responses_passthrough — 000 research

## Trigger

User report: check upstream openai/codex for response-stream movements and anything meant to make
passthrough explicit; improve opencodex accordingly as stacked PRs.

## Upstream movements (verified 2026-09-03, clone ~/Developer/codex/121_openai-codex @ 728cb12fe)

- e017e93ac #41980 "Preserve raw response usage metadata" (2026-09-01): the complete upstream
  `response.usage` object (including fields codex-rs does not type) is preserved into
  `ResponseUsageMetadata.metadata` and exposed via `rawResponse/completed` notifications on SSE,
  Responses WebSocket, turn, and compaction completion paths. codex-api/src/sse/responses.rs:478-490
  extracts `resp_val.get("usage")` as raw JSON before typed deserialize.
- 2c4a95736 #41087 "Expose response usage metadata in completion events" (2026-08-27): app-server
  `rawResponse/completed` carries `{ threadId, turnId, responseId, usage }`; `usage` null when the
  upstream event omits it.
- 5f79a92e3 #41912 (2026-08-31): cumulative token usage persisted in rollout; `thread/resume`
  re-emits `thread/tokenUsage/updated`.
- e0c727de0 #40931 (2026-08-26): rate-limit failure inside an HTTP-200 stream is the existing
  `response.failed` event classified retryable.
- Issues: #37138 — a proxy stripping `usage` from `response.completed` is silently accepted with
  `token_usage=None` and bypasses session totals/budget accounting; #37141 — a malformed/partial
  usage block fails SSE deserialize, classified retryable, causing full-request retry storms.
- opencodex dev: bea573abe #3358 reads Muse subscription usage from `response.completed.usage`
  in-band (src/server/responses/core.ts noteInspectedPayload + src/providers/muse-subscription-usage.ts).

Net: the wire source of truth is the raw `response.completed.response.usage` object. Both upstream
codex and opencodex's own passive-quota feature depend on unknown usage fields surviving the relay.

## opencodex passthrough shape (current tree, post-3361)

- Happy-path streaming forward: byte-verbatim unless a block rewrite fires
  (core.ts `clientBlockRewrite`; relaySseEagerBounded / relaySseWithBlockRewrite).
- Every block rewrite is identity-preserving when unchanged (`rewritten === event` → original
  block bytes; responses-field-backfill.ts:316, sse-payload-rewrite.ts compose).
- Parse-modify-reserialize rewrites keep unknown fields (spread on the parsed object).
- Known rebuild-from-whitelist points (gap candidates):
  1. `src/bridge.ts` responsesUsage() — rebuilds usage from typed OcxUsage for the
     translated-provider bridge AND buildResponseJSON non-streaming rebuild; unknown usage fields
     (subscription metadata) are dropped.
  2. Non-streaming rebuild in core.ts (`buildResponseJSON(terminalEvents...)`).
  3. Compact path (responses/compact.ts) — native ChatGPT/OpenAI: upstream body verbatim.
  4. ws-bridge.ts — Responses WebSocket transport frame handling.
- Internal typed extractors (request-log.ts, openai-responses.ts usageFromResponsesPayload)
  feed the proxy's own accounting only — not client-visible. OK by design.

## Audit result (Sol reviewer Euclid, 01a0679f-8f04-7673-a23c-33df980d7c4c)

Full re-serialization inventory over relay.ts / relay-eager.ts / repair chain / bridge / ws transports:

- Happy-path SSE relay, terminal-bounded relay, trackSseForRequestLog, createSseInspector,
  snapshot repair (JSON fields), terminal repair (real terminals), item-id repair, model rewrite,
  field backfill, image/namespace/custom-tool rewrites, non-streaming JSON passthrough,
  upstream-WS→SSE normalization, SSE→client-WS reframing: SAFE for unknown `response.usage` keys
  (spread-preserved or byte-verbatim). Intentional field drops exist (namespace scrub deletes
  `namespace`; custom-tool repair drops `arguments`; undeclared-tool guard is fail-closed) — by design.
- Synthetic terminal events (missing/failed upstream terminal) cannot carry unseen upstream
  fields — inherent, acceptable.
- B1 (High, verified): the AdapterEvent bridge drops unknown usage fields irrecoverably —
  `usageFromResponsesPayload` (src/adapters/openai-responses.ts) narrows to typed OcxUsage and
  returns undefined when input+output are both 0 (metadata-only usage disappears entirely);
  `responsesUsage()` (src/bridge.ts) rebuilds only input/output/total + cache/reasoning
  details. Hits `buildResponseJSON` (non-streaming/buffered) and `bridgeToResponsesSSE`
  (translated providers).
- B2 (Medium, verified): no test pins "unknown keys inside response.completed.response.usage
  survive client passthrough" on any path.
- #3358 Muse observer is safe (observer-only; the raw `response.subscription_usage` frame survives
  passthrough; subscription.tier omission is dashboard-cache only).

## Narrow audit confirmation (Ampere, 01a067a9-1a22-7650-b739-434533aac908)

- Canonical openai forward (pool/direct) never reaches bridgeToResponsesSSE/buildResponseJSON —
  including stream:false (bounded JSON, spread-preserving transforms) and compaction (upstream body
  copied byte-verbatim; only headers reduced).
- openai-responses adapter is ALWAYS the passthrough adapter (adapters/registry.ts), so B1's
  blast radius is: translated adapters parsing Responses-shaped upstreams (future providers, Lab
  conformance executor) and any buffered rebuild. Fix stands as #41980 parity + future-proofing.
- WS→SSE drops non-`response.*` sideband frames (codex.rate_limits, websocket_timing) — SSE clients
  have no semantic for them; recorded as residual, not a gap.

## Fix plan

- wp2 (010): `OcxUsage` gains the raw upstream usage object; the openai-responses adapter attaches
  it; `responsesUsage()` merges unknown keys (normalized known keys win, extras pass through,
  zero-count metadata-only usage is no longer dropped). Unit tests in the adapter + bridge suites.
- wp3 (020): regression coverage pinning unknown usage keys through (a) forward SSE passthrough,
  (b) non-streaming JSON passthrough, (c) bridge rebuild, (d) WS normalization. Stacked on wp2.
- wp4 (030): push stacked PRs against origin/dev — independent of PR #3361.

## Review findings folded (PR #3364)

- Codex connector P2: empty-completion retry mergeUsage dropped rawUsage → the content attempt's
  raw usage now wins (empty-completion-guard.ts).
- Codex connector P2: the retained raw usage clone was not charged to the translator budget →
  parseStream reserves/releases its serialized size like the adjacent retained collectors.
- CodeRabbit minor: unknown-shaped `cache_write_tokens` must not leak through the raw spread →
  excluded from raw input details; only the validated normalized value is emitted.
- CodeRabbit minor (MD041): document headings rebuilt.
