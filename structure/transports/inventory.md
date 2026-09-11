# Transport Inventory

## Transport inventory

The sections above cover the transports with load-bearing invariants. The rest of the transport
surface is listed here so a maintainer can find the owner without grepping:

| Transport | Owner | Invariant worth knowing |
| --- | --- | --- |
| Azure OpenAI Responses | `src/adapters/azure.ts` | Deployment-shaped URLs on top of the Responses contract. |
| Google / Vertex / Antigravity | `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/adapters/google-wire-compiler.ts`, `src/adapters/google-tool-schema.ts`, `src/adapters/google-truncation.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts` | Vertex and Antigravity install a Google-family `fetchResponse` and so own their retry policy, while AI Studio Gemini leaves it undefined and uses the default server fetch path. The Google-family wrapper reuses the shared abort/deadline helpers (`src/lib/upstream-retry.ts`), wire-body repair, and upstream error normalization. |
| Mimo Free | `src/adapters/mimo-free.ts` | Client identity and JWT handling are transport-local; the per-install client id lives in the opencodex state root. |
| Anthropic image ingress | `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Oversized or unsupported images are normalized or rejected before reaching upstream. |
| Adapter execution support | `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/image.ts`, `src/adapters/upstream-http-error.ts` | Shared machinery: turn ordering, tool-catalog nudging, client fingerprinting, image conversion, upstream error normalization. |
| Cursor (beyond the sections above) | `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/http1-bidi.ts`, `src/adapters/cursor/live-models.ts`, `src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/mcp-manager.ts`, `src/adapters/cursor/thread-continuity.ts`, `src/adapters/cursor/checkpoint-store.ts` | Thread continuity is the point: a retry must not start a new Cursor thread, and a validated checkpoint must not rebuild the full root history. HTTP/2 remains the default; an explicit `http1.1`/`h1` pin maps the bidi run onto Cursor's `RunSSE` receive stream plus sequenced `BidiAppend` sends, and applies to live discovery too. |
| Claude Messages | `src/server/claude-messages.ts` | Routed translation, a native Anthropic passthrough branch, and `count_tokens`. |
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/chat/` | Inbound translation onto the same routing pipeline. The content mapper preserves image URLs and supported detail, including screenshot-bearing tool results; target adapters own image placement on their wire. Image-free tool results stay strings. |
| Hosted search relay | `src/server/search.ts` | Direct relay; distinct from the web-search sidecar loop below. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
| API-key pools | `src/providers/api-key-selection.ts`, `src/providers/key-failover.ts` | A 429 rotates the active key and records a cooldown; `provider.apiKey` keeps mirroring the active entry so routing stays single-key. |
| OAuth account failover | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-routing.ts` | Reactive pre-output 429 recovery is presence-driven with 2+ eligible accounts. Pool and `oauthAccountFailover` flags govern proactive routing, not the reactive retry: a disabled Anthropic pool recovers through quota ordering rather than its dormant strategy, and a per-provider `enabled` beats the global default in either direction. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. |

> Decision record: [ADR-0072](../decisions/ADR-0072-transport-inventory.md)

Cursor external-model continuations attach data-URL screenshots from the contiguous active
tool-result batch through the existing image preparation and selected-context owners. The batch
shares the 12-image active cap. Bounded source labels are emitted in active user-action text so
root pruning cannot erase attachment provenance; the same text participates in token estimation.
Native Composer/MCP behavior and text-only historical replay remain unchanged.

## Provider diagnostic outbound safety

Provider connection tests and live model discovery share the GET-only provider outbound wrapper.
Direct HTTP(S) resolves once and pins the validated address; HTTPS preserves the original Host/SNI
and always verifies certificates. Proxy-configured requests stay on Bun fetch so HTTP(S)_PROXY,
ALL_PROXY, and NO_PROXY semantics remain authoritative. The wrapper classifies successful local DNS answers, but
only a typed DNS-resolution failure degrades to proxy resolution; every literal, metadata, and
resolved-address policy error still rejects. Proxy mode logs once that the proxy-selected peer
cannot be pinned. Private destinations additionally require allowPrivateNetwork plus NO_PROXY.

Two fake-IP DNS accommodations exist, both for resolved answers only (a literal address in the URL
still rejects). The IANA benchmark range (198.18/15 and its IPv4-mapped IPv6 spellings) is admitted
whenever any outbound proxy applies to the host, because the range itself marks the answer synthetic.
Mihomo's default IPv6 fake-IP range (fdfe:dcba:9876::/48) is ULA and carries no such mark, so it is
admitted only when the proxy variable that matches the URL scheme is set (HTTPS_PROXY for https:,
HTTP_PROXY for http:; ALL_PROXY is not consulted because Bun fetch does not honour it), the host is
not in NO_PROXY, and the request is then bound to that proxy through Bun's explicit `proxy` option
rather than environment inference. Both gates live in the outbound wrapper, not in classification:
`classifyIpv6` and config-time validation (`providerDestinationResolvedError`) never admit the
ULA, so provider save-time checks are unaffected (#3462).

Both paths reject redirects and expose only credential-stripped final-address guidance. This phase
does not cover ordinary requests, streaming, retries, or per-hop redirect review on those paths.
Caller-owned `provider.fetch` executors are also deferred: they receive literal/config checks and
redirect blocking, but cannot inherit DNS classification or peer pinning without a verified-peer
executor contract. Main-request migration must not treat that branch as fixed-transport equivalent.
