# ADR-0060 — decision recorded under "Kiro client parallel-tool hint"

- Contract owner: [providers/kiro.md](../providers/kiro.md#kiro-client-parallel-tool-hint)

## Decision record

- 목적과 의도: Keep current Codex clients usable with Kiro without claiming or inventing parallel execution on the CodeWhisperer wire.
- 기존 구현 및 제약 조건: Codex can send `parallel_tool_calls: true` even for catalog rows that advertise false; Kiro has no verified parallel-control request field and serializes tool execution.
- 검토한 주요 대안: Reject the client hint, rewrite it to false before routing, or accept it as permission while leaving the Kiro wire unchanged.
- 선택한 방식: Accept either request value, preserve the parsed client intent internally, and omit all parallel-control fields from the Kiro payload.
- 다른 대안 대신 이 방식을 선택한 이유: Rejection interprets permission as a requirement and blocks valid turns, while rewriting shared request state hides caller intent and can affect later policy or diagnostics.
- 장점, 단점 및 영향: Codex tool turns reach Kiro again and the adapter contract stays honest; Kiro still cannot produce true parallel tool batches through this transport.
