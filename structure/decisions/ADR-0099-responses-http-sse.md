# ADR-0099 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Restore a Muse callback that wraps a request-declared flattened namespace identity in an invented `default.` prefix without weakening the undeclared-tool boundary.
- 기존 구현 및 제약 조건: Default-namespace normalization accepted genuine bare declarations and bounded code-mode helpers, but intentionally rejected a namespaced tool's child name; the missing case carried the complete canonical `namespace__tool` identity after the prefix.
- 검토한 주요 대안: Strip every `default.` prefix; authorize any unique bare alias; special-case Codex App or Muse model names; require the complete suffix to be a declared flattened identity.
- 선택한 방식: Strip the wrapper only when the suffix contains `__`, is present verbatim in the current declared-name set, and no explicit default-namespace identity owns the emitted spelling.
- 다른 대안 대신 이 방식을 선택한 이유: Exact current-turn membership repairs the provider formatting error while preserving rejection for namespace-dropping guesses, unknown names, pruned tools, and explicitly declared default identities.
- 장점, 단점 및 영향: Streaming and buffered Responses paths emit the canonical client identity and continue the turn; providers inventing a different wrapper syntax still fail closed until measured and reviewed.
