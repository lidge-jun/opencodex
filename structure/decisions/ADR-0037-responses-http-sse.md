# ADR-0037 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep Codex 0.147 namespace tool catalogs usable after a routed provider adopts native Responses but implements only the public flat tool variants.
- 기존 구현 및 제약 조건: Chat translation already flattened namespace children, while native Responses passthrough forwarded the private `namespace` variant unchanged. xAI therefore rejected Grok requests before inference after its OAuth Grok 4.5/4.6 route moved to Responses.
- 검토한 주요 대안: Move Grok back to Chat; special-case only xAI or the reserved `functions` group; flatten every complete namespace on noncanonical Responses and restore request-authorized aliases on return.
- 선택한 방식: Noncanonical Responses lowers `functions` children to their bare top-level names and every other complete namespace to collision-checked `<namespace>__<name>` aliases after custom/tool-search conversion. It rewrites matching replay calls and tool selectors, records the aliases on the built request, and restores only those aliases in JSON/SSE call items before custom/tool-search lifecycle repair. Canonical OpenAI forward preserves native namespace shapes.
- 다른 대안 대신 이 방식을 선택한 이유: A transport regression should not discard Responses streaming or create a provider-specific fork, and restoration without request-local authorization could reinterpret an unrelated upstream function as a client namespace call.
- 장점, 단점 및 영향: Grok and other public-schema Responses gateways accept current Codex catalogs while Codex still receives explicit namespace routing. No `type: "namespace"` value survives the boundary: a group the layer cannot express — empty, nested, or with an unusable child name — is dropped along with the children it cannot represent, because relaying the private shape costs the whole request rather than one tool. Genuinely ambiguous wire names still fail closed, now as a 400 rather than an unstructured 500.
