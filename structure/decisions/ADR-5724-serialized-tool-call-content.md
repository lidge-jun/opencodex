# ADR-5724 — decision recorded under "Serialized tool-call content"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#serialized-tool-call-content)

## Decision record

- Intent: Remove MiMo's duplicated tool-call echo on OpenAI Chat routes when it arrives in the shapes the model actually emits, not only the canonical one (#5724).
- Prior constraint: ADR-5548 suppresses a block only when its function name and freeform body agree with a structured call in the same response; mismatched markup stays byte-exact.
- Observed shapes: MiMo's echo can omit `</function>` (`<tool_call><function=exec>BODY</parameter></tool_call>`) and can put a template newline after the function header. The Command Code reader already accepts both (#5637); the Chat reconciler did not, so those echoes stayed visible beside the call that ran.
- Alternatives considered: Keep two regular expressions and try the closed form first (backtracks quadratically on a long unterminated body, and rejecting a closed match on any inner `<tool_call>` hides a body that merely contains that string); drop anything shaped like a tool call (discards real text); restore calls from markup when no structured call exists (a new behaviour this route has no evidence for).
- Choice: Read each block by delimiter scan. The first `</tool_call>` preceded by `</function>` closes the block; if none appears before the next block header at the start of a line (`<tool_call>` followed by `<function=`, where a separate bare block can begin), the first `</tool_call>` does. A stray `</parameter>` before the close is markup, and one leading newline in the body is template layout.
- Why: It accepts the same grammar on both MiMo routes, keeps a body that contains literal tool-call tags (even a full header) intact, and costs linear time. The agreement rule from ADR-5548 is unchanged, so no new text can disappear without a matching structured call.
- Consequences: The two echo shapes are removed when they duplicate a structured call, streamed and buffered. Markup with no structured call is still shown and still runs nothing. Streaming retention scans each new delta with fixed delimiter overlap and carries trailing-prose state; it never searches the whole retained block per delta. See [ADR-0102](ADR-0102-incremental-stream-accounting.md).
