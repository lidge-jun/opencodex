# ADR-5236 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Agent-generated text must not poison later native replay as trusted ciphertext.
- 기존 구현 및 제약 조건: The proxy cannot authenticate backend Fernet tokens after full-history replay, but must preserve genuine opaque bytes byte-for-byte.
- 검토한 주요 대안: Trust every encoded-looking string; strip every encrypted slot; require canonical Fernet structure and retain bounded rejection recovery.
- 선택한 방식: Use Fernet structure as the unknown-history floor and one guarded recovery for the exact backend rejection.
- 다른 대안 대신 이 방식을 선택한 이유: Loose shape grants authority to plaintext, while unconditional stripping destroys valid backend state.
- 장점, 단점 및 영향: False positives stop before dispatch and poisoned history self-recovers once; structurally valid unauthenticated text may still need the bounded backend rejection path.
