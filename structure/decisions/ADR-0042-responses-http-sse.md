# ADR-0042 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Match OpenCode Go's model-specific Luna endpoint without changing sibling model behavior.
- 기존 구현 및 제약 조건: The preset had one Chat default even though the upstream publishes a mixed Chat, Responses, and Anthropic matrix; operators must retain explicit override precedence.
- 검토한 주요 대안: Move the whole preset to Responses; infer from the model name; declare one exact registry default; also force bounded JSON from an older conditional terminal report.
- 선택한 방식: Use one exact Luna wire default and leave upstream streaming unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: The endpoint mismatch is reproducible from current code and upstream documentation, whereas a current-dev live canary has not established the separate terminal-delivery policy.
- 장점, 단점 및 영향: Luna reaches its documented endpoint across inbound surfaces and explicit opt-out still works; any future stream workaround remains a separately reviewed compatibility decision.
