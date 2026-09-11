# ADR-0058 — decision recorded under "Google tool-result adjacency repair"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-result-adjacency-repair)

## Decision record

- 목적과 의도: prevent interrupted or replayed Claude-on-Antigravity histories from reaching the
  Google wire with unanswered `functionCall` or unpaired `functionResponse` parts.
- 기존 구현 및 제약 조건: `messagesToGeminiFormat` emitted every internal message independently;
  Antigravity translates the resulting Gemini shape back into strict Anthropic tool-use blocks, and
  rejects malformed adjacency with HTTP 400. Tool-result images cannot live inside a
  `functionResponse` and already rely on sibling `inline_data` parts.
- 검토한 주요 대안: repair the shared internal history; synthesize fake calls for orphan results;
  repair only the Google adapter serialization boundary.
- 선택한 방식: group only consecutive results after a model call batch, match by the normalized
  request-scoped call id, emit responses in call order, synthesize an explicit missing result, and
  degrade remaining results to marked text while retaining image siblings.
- 다른 대안 대신 이 방식을 선택한 이유: shared-history mutation could change other adapters,
  while fabricating a successful call would invent model behavior. The adapter boundary owns the
  strict upstream wire contract and can repair it without changing client-visible history.
- 장점, 단점 및 영향: normal histories remain byte-shape equivalent, parallel and interrupted
  histories become provider-valid, and orphan data is not lost. A result separated by a non-tool
  barrier is intentionally not reattached across that boundary.
