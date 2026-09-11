# ADR-0041 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep Codex hosted web search usable on xAI's public Responses endpoint without forwarding private OpenAI-only fields that xAI rejects.
- 기존 구현 및 제약 조건: Codex emits `external_web_access`, `search_context_size`, `search_content_types`, and `user_location`; xAI documents a live-only `web_search` tool with domain filters and image flags, while Codex cached mode explicitly forbids external access.
- 검토한 주요 대안: Strip only the first rejected field; pass every hosted-search field unchanged; disable web search for all xAI turns; normalize only the exact official xAI API destination.
- 선택한 방식: On `https://api.x.ai` Responses traffic, lower live search to xAI's public shape, map image content requests to `enable_image_search`, remove unsupported OpenAI-private fields, and omit cached/index-only search plus stale selectors because xAI has no non-live equivalent.
- 다른 대안 대신 이 방식을 선택한 이유: One-field stripping exposes the next schema mismatch and turning `external_web_access:false` into xAI live search widens the caller's network policy; destination scoping leaves custom gateways and canonical OpenAI byte-shape native.
- 장점, 단점 및 영향: Grok 4.5/4.6 no longer fail every default Codex turn with an unsupported-argument 400; live search remains available when explicitly enabled, while cached search degrades to no hosted search on xAI rather than silently going live.
