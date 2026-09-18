# ADR-0055 — decision recorded under "Google thought-text visibility boundary"

- Contract owner: [providers/google.md](../providers/google.md#google-thought-text-visibility-boundary)

## Decision record

- 목적과 의도: Prevent provider-marked internal reasoning from appearing as ordinary assistant text while preserving reasoning and tool-call continuation.
- 기존 구현 및 제약 조건: Both Google response paths emitted every non-empty `Part.text` as visible text; function calls, inline images, and Antigravity/Vertex thought-signature replay already depended on the original part ordering.
- 검토한 주요 대안: Drop thought text; classify it separately in each parser; remove the marker and keep visible text; use one shared classifier without mutating the provider parts.
- 선택한 방식: Map `thought: true` text to `reasoning_raw_delta` through one helper used by streaming and buffered parsing, leaving part order and signature observation unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: Dropping the text loses reasoning replay/display policy input, while duplicated parser rules can drift and exposing marked thoughts violates the provider's visibility boundary.
- 장점, 단점 및 영향: Internal reasoning no longer leaks into normal answers and both transports stay consistent; downstream reasoning policy still decides whether raw reasoning is rendered or only preserved, and malformed non-boolean markers remain ordinary text rather than broadening hidden-content inference.
