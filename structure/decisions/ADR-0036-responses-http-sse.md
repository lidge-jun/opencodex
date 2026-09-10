# ADR-0036 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep Codex client-side deferred tool discovery usable through third-party Responses-compatible gateways that implement public function tools but reject the private `tool_search` declaration.
- 기존 구현 및 제약 조건: The chat translation path already exposed search as a function and bridged its call back to `tool_search_call`; passthrough only promoted definitions returned by an earlier search, so it could not initiate discovery on a strict third-party Responses endpoint.
- 검토한 주요 대안: Require every gateway to implement Codex-private tool types; route affected models through `openai-chat`; lower the declaration only; lower the noncanonical request and restore both JSON and SSE response lifecycles.
- 선택한 방식: On noncanonical Responses passthrough only, lower an actually declared `tool_search` to a collision-free public function name, translate its replayed call/output history to public function pairs, record only caller-authorized request-local conversions, and restore matching JSON/SSE calls to client `tool_search_call` items. Canonical OpenAI forward remains byte-shape native.
- 다른 대안 대신 이 방식을 선택한 이유: Provider-specific workarounds fragment the contract, while unconditional restoration could turn an untrusted ordinary function call into a privileged client discovery action.
- 장점, 단점 및 영향: Strict third-party Responses gateways can start and continue deferred discovery without changing native ChatGPT behavior; ordinary same-named functions remain distinct, and the proxy performs a capped SSE lifecycle rewrite only when the request actually required compatibility translation.
