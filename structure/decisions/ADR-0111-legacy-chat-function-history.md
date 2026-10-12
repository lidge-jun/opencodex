# ADR-0111 — decision recorded under "Chat Compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md)

## Decision record

- 목적과 의도: Preserve complete legacy Chat function declarations, assistant calls, and textual results when translating to the Responses protocol.
- 기존 구현 및 제약 조건: Modern `tools` and `tool_calls` were translated, but top-level `functions`, assistant `function_call`, and text `role: function` messages were omitted. Legacy calls carry no call ID, while Responses requires one and downstream adapters require call/result adjacency.
- 검토한 주요 대안: Reject every legacy request; translate declarations only; infer results by transcript position alone; or assign local call IDs and pair pending results by their declared function name.
- 선택한 방식: Translate legacy declarations into function tools, legacy selection into `tool_choice`, assign bounded sequential call IDs to assistant calls, and resolve each textual function result against the pending same-name call. Orphans and malformed shapes fail explicitly; legacy image results retain their existing explicit refusal.
- 다른 대안 대신 이 방식을 선택한 이유: Declaration-only translation still loses executed history, while silent positional pairing can attach a result to the wrong call. Name-bound pending calls preserve the legacy contract without inventing provider identity.
- 장점, 단점 및 영향: Responses providers receive the full executed exchange and no text result disappears. Synthetic IDs are request-local, and ambiguous or orphaned legacy histories now return a clear client error instead of being forwarded incompletely.
