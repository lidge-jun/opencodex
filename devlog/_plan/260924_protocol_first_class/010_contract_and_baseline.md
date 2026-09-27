# 010 — PF-01 contract and baseline

## Modules

| File | Role | Import rule |
|---|---|---|
| `src/protocols/contract.ts` | protocols, upstream wires, hops, delivery modes, reason codes, name mappings | leaf |
| `src/protocols/features.ts` | feature keys, sources, cross-wire hop dispositions, body extraction, path effects | leaf (+ type from `src/compatibility/manifest.ts`) |
| `src/protocols/baseline.ts` | 18-cell current/target matrix | leaf |
| `src/protocols/dto.ts` | `ProtocolPlanV1`, `ProtocolTraceV1`, validators, limits | leaf |
| `src/protocols/settings.ts` | only reader of `apiSurfaces` and `protocols` config | type-only config import |

"Leaf" means importable from `gui/src/*`: no server, router, provider or Lab imports, not even
as types. `tests/responses/protocol-contract.test.ts` enforces it by reading import specifiers.

## Vocabulary

- **Protocol**: `responses | chat | messages` — the public API a client speaks.
- **Upstream wire**: a protocol or `other` (Gemini, Kiro, Cursor, ...). Nothing is claimed about
  `other`; absent feature dispositions there mean unknown.
- **Hop**: a wire name, `ir` (`OcxParsedRequest` / `AdapterEvent`), or `responses-internal`
  (Responses JSON/SSE produced only as an internal bridge).
- **Delivery mode**: `native` (same wire, source body is the wire source), `translated`
  (cross-wire through the IR or the target wire only), `legacy-bridge` (path contains
  `responses-internal`), `blocked` (refused before any send).
- **Fidelity**: `preserved`, `degraded`, `unknown`.

Internal spellings keep their names and map explicitly: routing `InboundWire` "anthropic" is
`messages`; adapters `openai-responses`/`openai-chat`/`anthropic` are the three protocol wires;
Lab identities `openai-responses`/`openai-chat`/`anthropic-messages` map one to one. Persisted
rows are not rewritten.

## Feature dispositions and their evidence

Same-wire hops are passthrough by definition. Cross-wire claims about current code:

| Claim | Evidence |
|---|---|
| Chat `n`, `logprobs`/`top_logprobs`, `logit_bias`, `seed`, `audio`/`modalities`, `prediction` are unsupported on `chat>responses` | `chatCompletionsToResponsesBody` in `src/chat/inbound.ts` builds the body from an explicit field list without them |
| Chat tools, sampling, stop, user, parallel tool calls, service tier, prompt cache key, metadata, reasoning effort, response format are translated on `chat>responses` | same function, explicit field copies |
| Messages `top_k` is unsupported on `messages>responses` | `src/claude/inbound.ts` header: accepted and dropped |
| Messages `thinking.budget_tokens` is degraded on `messages>responses` | maps to an effort tier, never forwarded raw |
| Messages `cache_control` is degraded on `messages>responses` | block-level cache hints are not carried into the Responses body; caching is re-derived downstream |
| Responses hosted tools are degraded on `responses>chat` and `responses>messages` | only web search and image generation have sidecar bridges |
| Responses `previous_response_id` and compaction are translated off-wire | expanded from proxy-side state before the adapter runs |
| Responses `store` is degraded and `background` unsupported off-wire | only proxy-side state exists for non-Responses upstreams |

The `chat>messages` and `messages>chat` rows describe the target direct codecs (PF-06). Today
those pairs travel through `responses-internal`, so their effective disposition is the
composition of the two Responses hops, which `featureEffectsForPath` computes from the path.

## Baseline (eligible single-provider route)

| inbound → upstream | current | target |
|---|---|---|
| responses → responses | native `responses,responses` | native |
| responses → chat / messages | translated `responses,ir,X` | translated |
| chat → chat | native `chat,chat` (JSON when `stream:false`) | native |
| chat → responses | translated `chat,responses` | translated |
| chat → messages | legacy-bridge `chat,responses-internal,ir,messages` | translated `chat,ir,messages` |
| messages → messages | legacy-bridge for managed keys (native only for caller-forwarded Anthropic credentials) | native |
| messages → responses | translated `messages,responses` | translated |
| messages → chat | legacy-bridge | translated `messages,ir,chat` |

Every routed (non-native) Chat and Messages path streams internally and folds for a
non-streaming client (`sse-folded`). The stream axis doubles the table to 18 cells in
`src/protocols/baseline.ts`.

Out of scope for the baseline, and described per request by the planner instead: combos and
policy routes (legacy bridge today), OAuth/forward credentials, synthetic effort rows,
vision-preprocessed images, tool-result images, and Responses-only features on Chat.

## DTOs

`ProtocolTraceV1` is the observed record for one request (`v: 1`), persisted with the request
log row; `attempts[]` records each physical attempt's upstream, mode and request path. A blocked
request has empty paths. `ProtocolPlanV1` is the predicted record (`schemaVersion: 1`) with one
candidate per route target, `guaranteedFeatures` (preserved by every eligible candidate) and
`partialFeatures`. Both validators reject anything that is not exactly v1, oversize, or outside
the vocabulary. Limits: 6 hops, 8 reason codes, 24 feature effects, 16 candidates, 16 attempts,
200-character identifiers without control characters.

## Settings

```jsonc
{
  "apiSurfaces": { "messages": { "enabled": false } },   // absent => inherit claudeCode.enabled
  "protocols": {
    "unrepresentable": "legacy",                        // or "reject"
    "rollout": {
      "nativeChatCombos": false,
      "managedMessagesNative": false,
      "managedMessagesNativeOAuth": false,              // effective only with the key-auth switch
      "directEncoders": false,
      "shadowPlan": false
    }
  }
}
```

`apiSurfaces` is kept raw by the config schema and parsed fail-closed: a present malformed value
closes the surface rather than inheriting. `protocols` is schema-validated and drops to defaults
when malformed, because every default is the conservative one. PF-01 adds the keys and the
resolver only; no request path reads them until PF-04.
