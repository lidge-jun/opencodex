# ADR-0071 — decision recorded under "Combo streaming commit boundary"

- Contract owner: [transports/responses.md](../transports/responses.md#combo-streaming-commit-boundary)

## Decision record

- 목적과 의도: Recover a failover combo from a provider-local SSE or model-lifecycle failure only while replay is provably free of duplicate client output and tool calls.
- 기존 구현 및 제약 조건: The parent committed every HTTP-200 child before reading its SSE body, while terminal stream errors were classified only later by logging; generic 410 responses stopped the chain.
- 검토한 주요 대안: Retry every failed stream, buffer the complete turn, inspect only HTTP status, or preflight a bounded prefix until an explicit output/terminal boundary.
- 선택한 방식: Put the one-reader bounded preflight in a dedicated module, commit on any non-control event, and treat only explicit model-lifecycle 410 evidence as target-local.
- 다른 대안 대신 이 방식을 선택한 이유: Replaying after output can duplicate text or tools, full-turn buffering destroys streaming and grows memory, and making every 410 retryable hides caller/application errors.
- 장점, 단점 및 영향: Zero-output provider failures can reach a healthy target with ordered receipts and cooldown; ambiguous or oversized pre-output streams keep the current fail-closed behavior instead of consuming unbounded memory.
