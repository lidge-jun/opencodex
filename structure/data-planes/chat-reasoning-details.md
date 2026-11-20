# Anthropic Thinking Signatures on the Chat Wire (#7429)

The one exception to the rule in [inbound-compat.md](inbound-compat.md) that opaque reasoning
state never crosses a Chat Completions boundary.

A Chat client routed to Claude echoed `reasoning_content` only, so every tool step reached
Anthropic without the signed thinking block it requires and the adapter dropped the reasoning.
`src/chat/reasoning-details.ts` owns the carrier, OpenRouter's `reasoning_details` shape that
Hermes and pi already round-trip: `{type:"reasoning.text", text, signature, format:
"anthropic-claude-v1", index}` for a signed block and `{type:"reasoning.encrypted", data, …}`
for a `redacted_thinking` block, redacted entries first as the adapter replays them.

Outbound, the bridge converter (`src/chat/outbound.ts`, stream and JSON) builds the entries from
each reasoning item's `ocxr1` envelope and the direct writer (`src/protocols/encoders/chat.ts`)
from `reasoningDone` and the optional `progressThinking` hook; the parity suite holds them
frame-equal. Only a value with Anthropic's signature spelling is emitted. A signature over text
the client never saw (hidden thinking: `txt` without `upd`, or the driver's `hidden` flag) is
withheld and only redacted entries go out. An Opus progress update (`txt` with `upd`) is
shown as `content` and also returned as a signed entry over that same text.

Inbound, `chatCompletionsToResponsesBody` reads the entries only when the ingress sets
`acceptAnthropicReasoningSignatures`: the settled route is one `anthropic` adapter destination
that is first-party (`credentialDomainFor(...).firstPartyAnthropic`) and cannot change
credential domain (no combo, policy or credential rewrite). Every entry must be well formed or
the whole array is ignored and the plaintext projection above applies unchanged; a client that
sends no `reasoning_details` gets a byte-identical body. Accepted entries become reasoning
items carrying the same `ocxr1` envelope the Responses wire uses, so the serving-identity
strip, the rejection memo and thinking recovery all apply. A progress update's visible copy in
`content` is replayed as sent: no marker distinguishes it from answer text, so nothing is cut.
Validation is structural only: an edited `text` or a well-formed altered signature is forwarded
and Anthropic refuses it. No signature is computed, cached server side, or synthesized; the
chat-ir placeholder still never passes the adapter's signature check.

An `openai-chat` destination cannot take the native passthrough when assistant history contains
Anthropic reasoning state: an entry with the Anthropic format marker, or an unmarked
`reasoning.text` whose signature passes the same spelling check the inbound replay accepts.
Native Chat preserves complete message objects, which would expose the signature or redacted
ciphertext to the new provider; declining with `opaque-state-stripped` sends the turn through
the bridge, where the non-Anthropic gate retains only the plaintext projection. Reasoning details
in other providers' formats — including signed entries explicitly marked foreign — remain
eligible for native passthrough.

## Gemini thought signatures on the Chat wire

A Gemini thought signature crosses the Chat wire on `tool_calls[].extra_content.google.thought_signature`,
the carrier the Responses wire already uses (`src/responses/provider-opaque-metadata.ts`). Inbound, both lanes
read it through `normalizedClientExtraContent`, so only a bounded string survives and a malformed or oversized
value is dropped instead of failing the request: the bridge in `src/chat/inbound.ts` (`toolCallsToItems`) and
the Antigravity direct lane in `src/protocols/codecs/chat-ir.ts` (`pushToolCall`), held equal by
`tests/responses/protocol-chat-ir-parity.test.ts`. Outbound, `src/chat/outbound.ts` copies a function_call
item's `extra_content` onto the streamed and buffered tool call and keeps it when folding Chat SSE, and the
direct-encoder lane passes the adapter's provider metadata from `tool_call_start` through
`src/protocols/encoders/adapter-events.ts` to `src/protocols/encoders/chat.ts`. Only the Google adapter sets that
metadata, so no other route emits the field. Native Chat forwards message objects verbatim, so `src/server/chat-native-eligibility.ts` declines a body whose
assistant tool calls carry `extra_content` with `opaque-state-stripped` unless the destination is a
Google host (`generativelanguage.googleapis.com`, `aiplatform.googleapis.com`), whose OpenAI-compatible endpoint
reads the field; the bridge then drops it for every other vendor. Coverage:
`tests/responses/chat-google-thought-signature.test.ts` (both lanes, stream and buffered, echo after the
server-side store is cleared, malformed and oversized echoes, another vendor).
