# ADR-0033 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Prevent routed models from turning invented or neighboring-agent tool names into client-executable Responses calls.
- 기존 구현 및 제약 조건: The request catalog already controlled custom-tool restoration and the non-OpenAI prompt nudge, but an undeclared upstream name still fell through as an ordinary `function_call`; Codex then reduced the mismatch to a bare `aborted` result.
- 검토한 주요 대안: Rely only on prompt guidance; automatically translate undeclared `apply_patch` into Code Mode; validate returned names against the request-visible catalog at the final bridge.
- 선택한 방식: Retain the allowed wire-name set with the existing bridge maps and fail the turn with an explicit compatibility error before emitting any undeclared tool item.
- 보완된 경계: Key-auth Responses passthrough restores a routed custom call only when the adapter actually lowered that name after request normalization and the caller's `tool_choice` still authorizes it. Native `apply_patch` stays in its upstream function-call form unless the destination explicitly denies Responses custom tools; tools replaced by hosted-provider policy also stay in their upstream function-call form.
- 다른 대안 대신 이 방식을 선택한 이유: Model guidance is not an enforcement boundary, while automatic translation would invent executable caller intent and arguments after generation.
- 장점, 단점 및 영향: Streaming and non-streaming routed responses now fail closed with an actionable provider-contract error; providers that emit aliases they never advertised must correct their adapter mapping instead of relying on client abort behavior.
