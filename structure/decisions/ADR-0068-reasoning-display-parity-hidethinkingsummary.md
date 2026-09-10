# ADR-0068 — decision recorded under "Reasoning display parity (hideThinkingSummary)"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#reasoning-display-parity-hidethinkingsummary)

## Decision record

- 목적과 의도: Preserve tool-call continuation compatibility without forwarding one provider or physical account's private reasoning to another fallback target.
- 기존 구현 및 제약 조건: Conversation-only scoping stopped process-global call-id collisions, but combo and 429 failover can reuse the same thread and provider-generated call id across destinations or credentials.
- 검토한 주요 대안: Disable replay on every failover-capable provider; key only by provider name; use persisted or truncated secret-derived ids; bind the in-memory cache to an exact process-local route and credential tuple.
- 선택한 방식: Keep a shared mutable scope holder and key entries by thread, provider name, an opaque destination HMAC, adapter, final model, and an opaque HMAC/account identity; incomplete identities read and write nothing.
- 다른 대안 대신 이 방식을 선택한 이유: Exact binding preserves same-generation same-target retries while making account switches and OAuth token refreshes fail closed, without logging, persisting, or exposing credential material.
- 장점, 단점 및 영향: Cross-provider/account replay is blocked and rotations are visible to live bridges; providers without a stable credential identity lose cache replay and use the existing minimal placeholder path.
