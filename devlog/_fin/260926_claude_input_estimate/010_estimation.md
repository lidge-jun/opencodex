# A Claude input estimate the settled route actually sends

Defect: `src/server/claude-messages.ts` `estimateClaudeRequestTokens`. The estimator measured the
body the **caller sent**, while `message_start` publishes it as the floor for the prompt this proxy
**actually forwarded**. On the Anthropic wire those are the same body. On every other wire they are
not, and the gap is whatever the target adapter drops.

Measured on the live path with a real Claude Code conversation replayed byte-identical (260
messages, 23 tools, 1,734,433 B) to `thehive/deepseek-ai/deepseek-v4.1-flash`
(`adapter: openai-chat`): `message_start` **432,068** against the upstream's `message_delta`
**131,907** — **3.28x**. The contract the estimator's own doc cites allows `>2x` drift
(`devlog/_fin/260711_claude_inbound/040_phase4_hardening.md` §3); this is outside it.

Why the two differ. Claude Code replays its own thinking blocks, and they dominate a long body:
80 blocks, 550,930 thinking chars and 750,284 `signature` chars. In the captured request the
thinking JSON is **78.8%** of all message JSON and the base64 `signature` is **56.7%** of the
thinking JSON. The `openai-chat` wire forwards that text only when the model is listed in
`preserveReasoningContentModels`, and it has no `signature` field at all — zero `signature`
references exist anywhere under `src/adapters/openai-chat*`. The `thehive` provider config declares
no reasoning policy keys, so it drops both, and upstreams do not bill replayed reasoning they never
receive. The estimator was counting 432,068 tokens of a prompt whose real size was 131,907.

The gap is a property of the route, not a constant, so no divisor can absorb it: a route that does
replay thinking must keep counting it. Char-per-token calibration and the `thehive/` alias prefix
were both ruled out as causes — CJK is 0.07% of the body, and moving 4 to 3.5 chars/token is ±14%,
while dropping the alias alone makes the number 14% *worse*.

Change:

- New leaf `src/lib/claude-request-projection.ts`: `ClaudeThinkingProjection`, the native
  `{text:true, signature:true}`, `projectBlock`, and `projectClaudeRequest` — a pure, idempotent
  projection that returns message content with the blocks a wire does not carry emptied. It never
  mutates its input and survives a message whose content is not an array.
- `src/adapters/openai-chat/messages.ts`: new exported `openAIChatSerializesThinking(provider,
  modelId)`, the single source of truth for whether that wire carries a replayed thinking block.
  The `messagesToChatFormat` conversion reads the same answer once per request
  (`wireSerializesThinking`) instead of re-deriving it per message, so the estimator and the
  serializer cannot drift apart — they are one rule.
- `src/server/claude-messages.ts`: `estimateClaudeRequestTokens` takes an optional
  `thinking: ClaudeThinkingProjection` defaulting to the native pair, and projects the messages
  before measuring. `claudeRequestTokenFloor` passes the projection for the route the turn settled
  on (`settledRoute`, recorded where routing resolves), and `handleClaudeCountTokens` resolves its
  own route through the read-only `previewRouteModel`. A route that is not `openai-chat` keeps the
  native projection, so the Anthropic-native lane stays byte-exact and pre-existing two-argument
  callers keep their behavior.

The measurement only. The caller's body is never rewritten on its way to the adapter — the
projection exists to price the prompt, not to alter it, and every reader of the floor shares the one
estimate, so no number is double-counted.

Rejected: excluding replayed thinking unconditionally (wrong for the native lane and any adapter
that does replay it); a `billsReplayedReasoning?: boolean` flag on `ProviderAdapter` (states a
billing policy on an interface whose business is wire shape, and cannot express "text yes,
signature no", which is the shape that actually occurs).

Tests (new `tests/claude-integration/claude-estimate-projection.test.ts`): a replayed-thinking body
projects away exactly the unserialized fields; `projectClaudeRequest` is pure, idempotent, and keeps
a message it emptied; a body with no thinking is projection-invariant; and end-to-end, the
`message_start` floor for a real captured body lands within the confirmed usage instead of 3.28x
above it. Verified to fail when the projection is disabled — the end-to-end case reports 6946 where
it expects <42, so the assertion is load-bearing rather than decorative.

Live verification, same captured body against the real upstream (104,318 / 131,907 = **0.79x**, and
`message_delta` byte-identical at 131,907, so the upstream result is untouched and only the
published estimate moved). The Paseo meter that opened this unit reads 240% before and 58% after.
