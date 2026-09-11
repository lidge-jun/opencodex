# ADR-0079 — Usage accounting

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#usage-accounting)

## Decision record

- 목적과 의도: Keep dashboard and management requests responsive as `usage.jsonl` grows.
- 기존 구현 및 제약 조건: The append-only JSONL file remains the durable source of truth and may be truncated or replaced. A tail-only byte/row bound kept memory finite but made historical totals incomplete on busy installations; arbitrary in-place historical edits cannot be detected without rereading the prefix.
- 검토한 주요 대안: Raise the byte/row caps, retain normalized rows, maintain a second database, or stream the complete ledger into compact accumulators and cache only revision-keyed summaries.
- 선택한 방식: Stream the complete ledger in fixed 1 MiB chunks for a cold rebuild, retain only compact aggregate state plus an LF/digest checkpoint, fold verified append suffixes atomically, share concurrent work, yield during parsing, and poll usage separately at a slower cadence.
- 다른 대안 대신 이 방식을 선택한 이유: It restores complete historical aggregation without making correctness depend on an operator-sized read limit, retaining every parsed row, or introducing a second persistence format.
- 장점, 단점 및 영향: Unchanged queries are cheap, normal refreshes read only appended bytes, and memory stays bounded. Cold starts and explicit invalidations still consume file-size-proportional IO/CPU. A same-inode historical rewrite outside the trailing checkpoint requires replacement, truncation, or restart to force that cold rebuild.
