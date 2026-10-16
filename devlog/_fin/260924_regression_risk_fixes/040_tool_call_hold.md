# Bound the serialized tool-call hold

Defect: src/adapters/openai-chat/serialized-tool-call-content.ts SerializedToolCallContentBuffer.ingest appends everything after a bare <tool_call><function=...> opening to the held text until the stream ends. An unmatched block followed by a long answer is delivered only at the end of the turn and can approach the translator budget.

Change:

- MAX_HELD_CHARS = 64 KiB: when the held text exceeds it, the buffer releases everything it holds (text and queued events, in order, nothing suppressed) and resumes scanning from the carried context.
- MAX_TRAILING_CHARS = 4 KiB: once the held text contains a closed </tool_call> and the non-whitespace text after the last closer exceeds this, release as above: a duplicated block is the tail of the content, not the head of a long answer.
- The adapter (openai-chat.ts emitContent) drains the released events through a new buffer method so ordering stays intact; no other adapter change (openai-chat.ts is ratchet-capped, so the change stays inside the helper plus a one-line call).

Tests (new tests/adapters/openai-chat-serialized-tool-call-hold-bound.test.ts): a bare block followed by >4 KiB of prose emits text before the stream ends and suppresses nothing; a block exceeding 64 KiB is released; a real duplicate (block then matching structured call) is still suppressed.


## Audit fold (round 1 FAIL)

Streaming and buffered paths are separated. ingest() keeps its current unbounded behaviour because reconcileSerializedToolCallEvents (buffered responses, structured calls already known) uses it. A new ingestEvents(delta) is used only by the streaming emitContent in openai-chat.ts (two lines replaced by two lines, inside the 822-line cap).

Overflow policy, stated: past the bound the stream prefers showing text over suppressing a possible duplicate. A duplicate block larger than the bound, or one followed by more than MAX_TRAILING_CHARS of prose before its structured call, reaches the client as raw markup, which is the behaviour before #5548. Bounds: MAX_HELD_BYTES = 64 KiB measured on this.bytes (held text plus queued events) and checked BEFORE retaining the next delta, so one large delta cannot push retention past the bound; MAX_TRAILING_CHARS = 8 KiB of non-whitespace text after the last closed </tool_call>.


## Audit fold (round 2)

MAX_HELD_BYTES rises to 4 MiB: it is a runaway guard only, well under the translator budget, so a large duplicated write inside the block itself is still reconciled. The latency case is handled by the 8 KiB trailing-prose rule alone. A duplicated block is the tail of the content (#5548's observed shape), so a closed block followed by more than 8 KiB of prose before any structured call is treated as prose; that narrow residual is accepted.
