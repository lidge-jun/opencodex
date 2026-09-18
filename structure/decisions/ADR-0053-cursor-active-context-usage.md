# ADR-0053 — decision recorded under "Cursor active-context usage"

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-active-context-usage)

## Decision record

- 목적과 의도: Keep Codex's visible "context left" indicator aligned with Cursor's active-context usage on client-tool turns that finalize before a checkpoint arrives.
- 기존 구현 및 제약 조건: Checkpoint turns reported totalTokens correctly, but no-checkpoint client-tool finalize fell back to output-only usage and could overwrite a meaningful prior total with values like 109 tokens.
- 검토한 주요 대안: Add a longer wait for late checkpoints; infer prior+output totals; store full prompt/history state; carry forward only the last numeric checkpoint per Cursor conversation.
- 선택한 방식: Carry forward the last numeric absolute checkpoint per Cursor conversation with bounded LRU/TTL storage, update it only from live checkpoint frames, and clear/suppress it once when a newly appended compaction boundary starts an epoch; previous_response replay provenance acknowledges historical markers without serializing private metadata upstream.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the UI regression without delaying tool turns, fabricating token growth, storing prompt/tool content, or repeatedly clearing valid post-compaction usage when historical markers replay; one-time compaction resets still prevent stale over-report when history is replaced.
- 장점, 단점 및 영향: Active-context reporting stays monotonic within an uncompacted Cursor conversation; no-checkpoint turns remain estimated; a process restart loses the numeric cache, and when neither a checkpoint nor a carry-forward is available the turn reports a request-local estimate derived from the same pruned payload sent to Cursor (#373 — reporting output-only usage made Codex read the context as nearly empty). Estimates are never persisted or promoted into checkpoint carry-forward; only live checkpoint frames update the cache.
