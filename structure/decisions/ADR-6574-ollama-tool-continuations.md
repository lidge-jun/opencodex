# ADR-6574 — decision recorded under "Reasoning and tool-result compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#reasoning-and-tool-result-compatibility)

## Decision record

- 목적과 의도: Preserve Codex code-mode yield/notify output without breaking Ollama's adjacent tool-call/result shape.
- 기존 구현 및 제약 조건: A call accepted only one result in its current batch. Valid extra output failed locally as duplicate or orphan even though its originating call remained in the replay history.
- 검토한 주요 대안: Drop extra output, reopen old batches, fabricate another tool call, or distinguish open-batch fragments from known late output.
- 선택한 방식: Join open-batch fragments once at settlement; carry known late output as explicitly attributed user text, deferring it behind an open native batch. Keep a request-local issued-call map to validate every result's name and namespace.
- 다른 대안 대신 이 방식을 선택한 이유: Dropping output loses evidence, reopening batches breaks adjacency, and fabricated calls misrepresent execution. Text attribution preserves output without pretending a second invocation occurred.
- 장점, 단점 및 영향: Order within each merged result, image data, and error evidence survive without mutating caller history. Late output is visible but no longer a native tool-result carrier; it may move behind a pending batch to preserve the wire's pairing requirement. Unknown IDs, reused call IDs, wrong tool identities, unsupported media, and existing missing-result markers remain enforced. No execution, credential, endpoint, or stream policy changes.
