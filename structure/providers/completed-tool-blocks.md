# Negotiated completed tool blocks

`src/adapters/openai-chat.ts` and `src/adapters/openai-chat/completed-tool-blocks.ts` accept `block-stop-v1` completion markers only when both the
trusted per-exchange `AdapterStreamContext.completedToolBlocks` in `src/adapters/base.ts`,
configured provider header and response header `x-opencodex-tool-completion` equal that version.
A marker is a tool-call delta with exact existing numeric index, exact nonempty call ID and
`x_opencodex_completed: "block-stop-v1"`, without a function field. It never creates a call;
repeated markers or subsequent fragments for a completed call terminate the stream.

The adapter releases only the completed prefix in original pending-call order. Early calls
require a nonempty name, actual string arguments parsing to an object without an own `input`
property, and no freeform identity. Inline-think models stay buffered. The content buffer in
`src/adapters/openai-chat/serialized-tool-call-content.ts` uses its `hasHeldEvents()` gate to prevent tools from overtaking held text or reasoning. Calls remain in
the full reconciliation batch until terminal cleanup, preserving ambiguity rules and byte budgets;
already released calls are not emitted again. Errors preserve those closed calls and emit no success.
Cancellation cannot retract a completed call the client already received. Request bodies, aliases,
usage collection, custom-tool reconciliation and providers without bilateral negotiation retain
their existing behavior. Coverage: `tests/adapters/openai/openai-chat-parallel-stream.test.ts`.

Without trusted `IncomingMeta.completedToolBlocks` build metadata, the adapter removes the
negotiation header before sending. Parsing separately requires per-exchange stream context,
so construction of another request never grants parsing authority. The adapter ignores markers
without that context. The Responses owner derives that metadata from authenticated durable
[turn membership](../transports/response-turn-membership.md), rather than client-supplied JSON.

`src/adapters/unique-tool-call-ids.ts` forwards this context without changing its call-ID reminting.
Only the signed canonical delivery supplies it; direct client encoders, advisor guards,
compaction and other parser consumers leave it absent.
