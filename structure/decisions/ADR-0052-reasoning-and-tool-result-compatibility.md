# ADR-0052 — decision recorded under "Reasoning and tool-result compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#reasoning-and-tool-result-compatibility)

## Decision record

- 목적과 의도: Preserve DeepSeek reasoning replay for parallel tool calls while retaining the provider-scoped repair for hook-interleaved results.
- 기존 구현 및 제약 조건: Pair-by-pair adjacency fixed one call but split parallel calls into separate assistant turns; DeepSeek always enables parallel tool calling and merges adjacent reasoning and calls into one assistant message.
- 검토한 주요 대안: Disable parallel calls, duplicate reasoning, remove the #1292 repair, or normalize one unambiguous call/output batch.
- 선택한 방식: Group calls that occur before the first matched output, emit the call batch followed by outputs in call order, and retain intervening non-tool items after the batch.
- 다른 대안 대신 이 방식을 선택한 이유: The batch shape matches the documented Responses contract without inventing reasoning or reintroducing hook-interleaving failures.
- 장점, 단점 및 영향: Sequential and parallel tool continuations both retain their reasoning contract; only the declared strict provider changes order, and ambiguous histories still fail closed upstream.
