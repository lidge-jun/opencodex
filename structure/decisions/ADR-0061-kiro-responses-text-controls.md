# ADR-0061 — decision recorded under "Kiro Responses text controls"

- Contract owner: [providers/kiro.md](../providers/kiro.md#kiro-responses-text-controls)

## Decision record

- 목적과 의도: Stop rejecting valid Kiro turns whose only offence is carrying a Responses text control the wire ignores.
- 기존 구현 및 제약 조건: The guard tested `_rawBody.text !== undefined`, so `text.verbosity`, `text.format:{"type":"text"}`, and even `text:{}` produced HTTP 400 with sendCount 0 while identical turns without `text` succeeded; `_structuredOutput` already distinguishes real structured output, and the catalog's `support_verbosity: false` helps neither a client holding a cached catalog nor the default text format, which no capability flag governs.
- 검토한 주요 대안: Keep the presence check, add an openai-responses-style stripper before serialization, or narrow the guard to `_structuredOutput` alone.
- 선택한 방식: Narrow the condition to `_structuredOutput`; no stripper is needed because the Kiro payload never spreads the raw body.
- 다른 대안 대신 이 방식을 선택한 이유: The presence check reads a preference as a requirement — the same error `db040e70f` removed for parallel-tool hints — and a stripper would add a serialization stage to defend against a body Kiro already ignores by construction.
- 장점, 단점 및 영향: Kiro-routed Codex turns stop failing intermittently and structured output stays honestly refused; a future `text` member Kiro genuinely cannot ignore would need its own condition.
