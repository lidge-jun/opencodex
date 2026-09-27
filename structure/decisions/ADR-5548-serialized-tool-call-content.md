# ADR-5548 — decision recorded under "Serialized tool-call content"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#serialized-tool-call-content)

## Decision record

- Intent: Prevent a gateway's duplicated serialized tool-call markup from becoming visible assistant text or malformed executable input.
- Prior constraint: Chat content is user-visible and must otherwise stream without delay; structured tool-call arguments are upstream-owned bytes.
- Alternatives considered: Drop all tool-call-looking content, add a provider-specific switch, or reconcile serialized blocks with structured calls at the Chat adapter boundary.
- Choice: Hold only a possible complete markup block and suppress or repair it only when the function name and duplicated body agree with a structured call in the same response.
- Why: Agreement between both representations is deterministic and avoids changing ordinary commentary, mismatched markup, or unrelated providers' valid text.
- Consequences: Matching calls no longer appear twice; an exact pair of immediately adjacent identical blocks with one doubled structured input is reduced to one call; same-name/different-body examples remain visible; the small held region is translator-budgeted and emits heartbeats while held; terminal failures retain held text without dispatching tools; malformed concatenated arguments are repaired only for proven duplicate shapes.
- Follow-up (260924): the streaming hold is bounded (8 KiB of prose after a closed block, 4 MiB total); past a bound held text is released unsuppressed. See structure/providers/chat-compat.md.
- Follow-up (260925): MiMo V2 models with the exact `mimo-v2` ID or dotted IDs (`mimo-v2.*`) can send `{}` for a declared freeform call while placing its code only in a standalone bare block, sometimes after a malformed `<parameter=` opener. Hyphenated IDs such as `mimo-v2-pro` and `mimo-v2-omni` are outside this recovery rule. One structured call to the exact wire tool authorizes recovering that body as `input` only when no other answer text was released; other models, prose, ambiguous responses, and quoted or fenced markup retain the original match-only behavior. This repairs a missing executable input, not just a visible echo.
