# ADR-0034 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Accept a routed model's decorated outer `apply_patch` delimiter lines without changing the executable meaning of any provider-returned program.
- 기존 구현 및 제약 조건: Routed custom tools arrive through a public function wrapper and are restored at the response boundary, but arbitrary `exec` JavaScript is caller-executable source whose strings, comments, templates, and helper arguments cannot be safely rewritten with text patterns.
- 검토한 주요 대안: Regex-rewrite nested helper calls in `exec`; wrap a raw `exec` patch body as a helper call; reject every decorated patch; or normalize only the outer lines of a complete top-level `apply_patch` custom-tool payload.
- 선택한 방식: After unwrapping the request-authorized custom-tool function shape, normalize only exact decorated Begin/End lines when the entire `apply_patch` input is one structurally recognizable patch with a file operation. Keep `exec` and all other freeform bodies byte-identical.
- 다른 대안 대신 이 방식을 선택한 이유: A top-level `apply_patch` call already carries explicit executable intent, so its unambiguous outer-line spelling can be repaired without inventing a call or parsing JavaScript. Every broader rewrite could reinterpret ordinary data as code.
- 장점, 단점 및 영향: Decorated top-level patches regain compatibility while strings, comments, generated source, raw `exec` text, incomplete envelopes, and patch-file content remain untouched. Nested malformed helper source must be corrected by the provider instead of being guessed at the response boundary.
