# MiMo Bare Tool Calls

## Standalone bare-call recovery

Standalone recovery (#7260) is separate from
[structured-call/identified-wrapper reconciliation](chat-compat.md#serialized-tool-call-content).
`src/adapters/openai-chat.ts` composes both paths without changing the identified-wrapper contract.
`src/adapters/openai-chat/standalone-bare-tool-calls.ts` enables it only for MiMo `mimo-v2` or
dotted `mimo-v2.*` model IDs when no structured calls exist. Complete bare `<tool_call>` blocks
must name an exact declared freeform wire tool. They may follow prose on the same line;
`src/adapters/openai-chat/serialized-tool-call-markup.ts` tracks Markdown state at every candidate,
including inline ticks and fences split across deltas.

Identified wrappers never authorize synthetic calls or disappear because a bare block was
recovered. Empty bodies, nested tool/function headers, and named or nested parameter markup
stay inert. One malformed leading `<parameter=` retains existing freeform-body normalization.
Ordinary functions, absent tools, hyphenated MiMo IDs, literals and prose without a block remain
unchanged. A structured call disables standalone recovery for the entire response; errors,
cancellation, a stream that ends without `finish_reason` or `[DONE]`, and content after the first
terminal signal dispatch nothing (the block stays visible text). Each accepted bare block becomes one start/delta/end sequence
with restored tool identity and JSON `{input}` arguments. Only accepted bare ranges are removed;
the structured-call repeated-pair ambiguity rule does not govern synthetic calls.

`src/adapters/openai-chat/serialized-tool-call-content.ts` still releases held markup and prose
in order at streaming bounds, but eligible candidate inputs survive in a separate
[translator-budgeted record](../transports/byte-accounting.md#stream-buffer-accounting).
Only detached candidate data is retained, never trailing prose: at most 128 calls, 4 MiB total
and a conservative 2 MiB per-record cap. Exceeding a cap disables the entire synthetic batch;
candidate traversal stops at the 129th header, including after earlier candidates were released.
Disposal releases all bytes. Already released markup cannot be retracted. Buffered recovery
shares eligibility and byte/count bounds without the streaming text-release limit.
When a size bound releases an unresolved outer block, standalone recovery is disabled for that
response so later inner headers cannot become calls. A nested header also makes later apparent
siblings ambiguous and disables recovery across release. The shared `SerializedToolCallContentBuffer`
keeps complete control bodies opaque to Markdown across release on every provider, independently
of standalone eligibility; their backticks never expose subsequent literal examples.
Coverage: `tests/adapters/openai/openai-chat-standalone-bare-block.test.ts`.

> Decision record: [ADR-7260](../decisions/ADR-7260-standalone-bare-tool-calls.md)
