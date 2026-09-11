# ADR-0056 — Google response-part field boundary

- Contract owner: [providers/google.md](../providers/google.md#google-response-part-field-boundary)

## Decision record

- 목적과 의도: Keep malformed Google-compatible response fields from violating the internal string-only text and tool-name contract or dispatching an unidentified tool.
- 기존 구현 및 제약 조건: Container validation guaranteed object parts, but truthy string/number/array functionCall values emitted a nameless tool call and truthy non-string text values crossed as text or reasoning events. Gemini supplies a complete call in one part, so there is no later name fragment to await.
- 검토한 주요 대안: Pass malformed values through; coerce them to strings; silently drop every malformed field; terminate the turn for every malformed field; distinguish dispatch identity from optional text.
- 선택한 방식: Prevalidate function calls and terminate on a non-object, non-string, empty, or whitespace name; drop only non-string text; leave arguments untouched.
- 다른 대안 대신 이 방식을 선택한 이유: Passing or coercing can execute the wrong tool or fabricate transcript text, while terminating for optional malformed text discards an otherwise usable response. An invalid call name cannot be recovered or safely ignored once the model selected a tool.
- 장점, 단점 및 영향: Streaming and buffered paths enforce the same AdapterEvent contract and invalid calls cannot enter thought-signature replay. Nonconforming third-party Google-compatible text fields are ignored rather than surfaced, and operators receive a structured terminal error for call identity failures.
