# ADR-0067 — Reasoning display parity (hideThinkingSummary)

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#reasoning-display-parity-hidethinkingsummary)

## Decision record

- 목적과 의도: Keep reasoning replay bounded while preserving opaque values exactly.
- 기존 구현 및 제약 조건: Reasoning continuity needs JSON/base64 envelopes, and existing callers already own retained accounting and typed overflow handling.
- 검토한 주요 대안: Per-field truncation, an independent fixed field limit, or shared transient admission plus cumulative inbound ownership.
- 선택한 방식: Reserve conservative copy projections in the envelope helpers and use the existing request budget across inbound blocks.
- 다른 대안 대신 이 방식을 선택한 이유: Truncation changes signed values; one field limit does not describe aggregate ownership. Existing budget errors retain the established HTTP and stream error contracts.
- 장점, 단점 및 영향: Normal replay is unchanged; envelope admission includes copy overhead and is stricter than a raw-string length ceiling. These are translator accounting limits, not a process-wide RSS guarantee.
