# ADR-0062 — decision recorded under "Chat streaming client with a JSON upstream result"

- Contract owner: [data-planes/inbound-compat.md](../data-planes/inbound-compat.md#chat-streaming-client-with-a-json-upstream-result)

## Decision record

- 목적과 의도: Keep tool execution and incomplete-response detection working when a streaming client receives a JSON upstream result.
- 기존 구현 및 제약 조건: The existing fallback copied only text and forced `stop`, despite the JSON converter already retaining tool calls, reasoning, and incomplete status.
- 검토한 주요 대안: Duplicate Responses parsing in the emitter; perform another inference request; preserve the already-converted Chat completion.
- 선택한 방식: Copy supported converted message fields into one delta, assign tool-call stream indexes, and retain the converted finish reason.
- 다른 대안 대신 이 방식을 선택한 이유: One conversion authority prevents the streaming fallback from drifting from non-streaming semantics without changing routing or retry behavior.
- 장점, 단점 및 영향: No additional upstream request or dependency; this remains buffered delivery, not token-by-token upstream streaming. Handler regressions cover tools, reasoning, length, ordinary and empty completions, and budget release.
