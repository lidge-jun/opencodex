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
