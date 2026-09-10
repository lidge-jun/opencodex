# ADR-0054 — decision recorded under "Cursor conversation checkpoint reuse"

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-conversation-checkpoint-reuse)

## Decision record

- 목적과 의도: Reuse Cursor's returned ConversationStateStructure on validated linear continuations so OpenCodex does not rebuild the full root history every turn.
- 기존 구현 및 제약 조건: Stable conversation ids already exist (#366), but every turn still reconstructed rootPromptMessagesJson and conversationTurns. Cursor Connect still reports only usedTokens/maxTokens, so cache_read_tokens cannot be treated as authoritative (#275).
- 검토한 주요 대안: Keep full replay; copy Pi's live MCP bridge immediately; store raw protobuf in Responses JSON; key checkpoints only by conversation id.
- 선택한 방식: Keep an opaque process-local checkpointRef on OcxProviderContinuationState.cursor, bind the snapshot to conversation/account/model affinity, and require a remembered provider conversation or stable client thread before a ref-less prefix lookup. Reuse the bounded process-local Desktop session/thread HMAC when the canonical parent-thread header is absent. Pin referenced blobs for the checkpoint lifetime, and fall back to the existing full-replay path for unowned headerless requests, isolation, compaction, restart, missing refs, and invalid_argument recovery. Tool-result turns reuse the last completed checkpoint plus an uncovered suffix. previous_response_id is a branch anchor, never a Cursor conversation ownership key.
- 다른 대안 대신 이 방식을 선택한 이유: It removes avoidable replay cost without claiming cache-hit rates, without changing OAuth, and without collapsing helper/compaction isolation or tool-call replay safety.
- 장점, 단점 및 영향: Validated no-tool follow-ups stop growing local rootBytes with history; a process restart or missing blob lease falls back to full replay; large-context 429 / premature-completion acceptance for #1527 is still unproven; a stateful live MCP bridge remains out of scope.
