# ADR-0057 — decision recorded under "Google tool-call thought-signature replay"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-call-thought-signature-replay)

## Decision record

- 목적과 의도: Preserve Vertex Gemini tool-call continuation without exposing opaque signatures to Codex or another Google backend.
- 기존 구현 및 제약 조건: Responses history does not carry a safe Gemini signature field; Antigravity already used a bounded in-process replay cache, while Vertex bypassed it and received HTTP 400 after the first tool call.
- 검토한 주요 대안: Serialize the signature into Responses item ids or reasoning content; create an unbounded Vertex map; reuse the bounded cache with or without a transport namespace.
- 선택한 방식: Reuse the bounded cache for Vertex, observe both response shapes, apply after wire-name compilation, and scope Vertex by transport/project/location plus the opaque client session key when available.
- 다른 대안 대신 이 방식을 선택한 이유: Responses ids are not Gemini signatures and previously caused Base64/TYPE_BYTES failures; a second cache duplicates limits; an unscoped cache could send provider-private state across destinations.
- 장점, 단점 및 영향: Tool loops continue with exact opaque state and bounded memory while cross-transport reuse fails closed. Replay remains process-local, matching the existing Antigravity contract.
