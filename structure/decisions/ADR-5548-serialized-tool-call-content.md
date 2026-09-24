# ADR-5548 — decision recorded under "Serialized tool-call content"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#serialized-tool-call-content)

## Decision record

- Intent: Prevent a gateway's duplicated serialized tool-call markup from becoming visible assistant text or malformed executable input.
- Prior constraint: Chat content is user-visible and must otherwise stream without delay; structured tool-call arguments are upstream-owned bytes.
- Alternatives considered: Drop all tool-call-looking content, add a provider-specific switch, or reconcile serialized blocks with structured calls at the Chat adapter boundary.
- Choice: Hold only a possible complete markup block and suppress or repair it only when the function name and duplicated body agree with a structured call in the same response.
- Why: Agreement between both representations is deterministic and avoids changing ordinary commentary, mismatched markup, or unrelated providers' valid text.
- Consequences: Matching calls no longer appear twice; same-name/different-body examples remain visible; the small held region is translator-budgeted and emits heartbeats while held; terminal failures retain held text without dispatching tools; malformed concatenated arguments are repaired only for the exact duplicated wrapper shape.
- Follow-up (260924): the streaming hold is bounded (8 KiB of prose after a closed block, 4 MiB total); past a bound held text is released unsuppressed. See structure/providers/chat-compat.md.
- Follow-up (#5724): MiMo echoes that omit `</function>` or put a template newline after the function header are read as the same block, matching the Command Code reader's grammar; suppression still requires the name and body to agree with a structured call.
