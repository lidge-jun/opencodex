# Transport Inventory

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

## Transport inventory

The sections above cover the transports with load-bearing invariants. The rest of the transport
surface is listed here so a maintainer can find the owner without grepping:

| Transport | Owner | Invariant worth knowing |
| --- | --- | --- |
| Azure OpenAI Responses | `src/adapters/azure.ts` | Deployment-shaped URLs on top of the Responses contract. |
| Meta Muse Responses tool names | `src/responses/muse-tool-name-alias.ts`, `src/adapters/openai-responses.ts` | `api.meta.ai` only: function names over 64 characters or containing characters outside `[a-zA-Z0-9_-]` become collision-safe wire aliases and are restored before the client sees them. |
| Google / Vertex / Antigravity | `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/adapters/google-wire-compiler.ts`, `src/adapters/google-tool-schema.ts`, `src/adapters/google-truncation.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts` | Vertex and Antigravity install a Google-family `fetchResponse` and so own their retry policy, while AI Studio Gemini leaves it undefined and uses the default server fetch path. The Google-family wrapper reuses the shared abort/deadline helpers (`src/lib/upstream-retry.ts`), wire-body repair, and upstream error normalization. |
| Mimo Free | `src/adapters/mimo-free.ts` | Client identity and JWT handling are transport-local; the per-install client id lives in the opencodex state root. |
| Anthropic image ingress | `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Oversized or unsupported images are normalized or rejected before reaching upstream. |
| Adapter execution support | `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/image.ts`, `src/adapters/upstream-http-error.ts` | Shared machinery: turn ordering, tool-catalog nudging, client fingerprinting, image conversion, upstream error normalization. |
| Cursor (beyond the sections above) | `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/http1-bidi.ts`, `src/adapters/cursor/live-models.ts`, `src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/mcp-manager.ts`, `src/adapters/cursor/thread-continuity.ts`, `src/adapters/cursor/checkpoint-store.ts` | Thread continuity is the point: a retry must not start a new Cursor thread, and a validated checkpoint must not rebuild the full root history. HTTP/2 remains the default; an explicit `http1.1`/`h1` pin maps the bidi run onto Cursor's `RunSSE` receive stream plus sequenced `BidiAppend` sends, and applies to live discovery too. |
| Claude Messages | `src/server/claude-messages.ts` | Routed translation, a native Anthropic passthrough branch, and `count_tokens`. |
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/server/chat-native.ts`, `src/chat/`, `src/adapters/openai-chat.ts` | Inbound translation onto the same routing pipeline. The content mapper preserves image URLs and supported detail, including screenshot-bearing tool results; target adapters own image placement on their wire. Image-free tool results stay strings. The native handler owns pin/cap normalization; the adapter wire builder removes effort only for explicit empty declarations or no-reasoning models, preserving unknown raw declarations. On the response side, the upstream `service_tier` echo relays on every delivery shape (`src/chat/outbound.ts` projections, `src/server/chat-native-sse.ts` chunks); an upstream without the field gets no injected key. |
| Hosted search relay | `src/server/search.ts` | Direct relay; distinct from the web-search sidecar loop below. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
| API-key pools | `src/providers/api-key-selection.ts`, `src/providers/key-failover.ts` | A configured `apiKeyPoolStrategy` plus a cooling committed key rotates before the first send (`selectProactiveApiKeyTransport`); a 429 still rotates after the send and records a cooldown. `provider.apiKey` keeps mirroring the active entry so routing stays single-key. The pick is inert without a strategy or while the committed key is healthy. |
| OAuth account failover | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-routing.ts` | Reactive pre-output 429 recovery is presence-driven with 2+ eligible accounts. Pool and `oauthAccountFailover` flags govern proactive routing, not the reactive retry: a disabled Anthropic pool recovers through quota ordering rather than its dormant strategy, and a per-provider `enabled` beats the global default in either direction. |
| OAuth login callback (inbound) | `src/oauth/callback-server.ts` | Every response, including non-callback 404s, closes its connection so a pooled socket cannot deliver a later login to a retired flow on the same callback port. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts`, `src/providers/registry.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. Provider-scoped hints fill capabilities omitted by live rosters; OpenCode Go's `deepseek-v4.1-flash` keeps its 1,048,576-token context window. |

> Decision record: [ADR-0072](../decisions/ADR-0072-transport-inventory.md)

Cursor external-model continuations attach data-URL screenshots from the contiguous active
tool-result batch through the existing image preparation and selected-context owners. The batch
shares the 12-image active cap. Bounded source labels are emitted in active user-action text so
root pruning cannot erase attachment provenance; the same text participates in token estimation.
Native Composer/MCP behavior and text-only historical replay remain unchanged.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Bounded response ingestion and OrcaRouter login

`src/lib/bounded-body.ts` owns `readBoundedResponseBytes`: it consumes the original response
body without cloning or teeing and retains at most the caller's `maxBytes`. An exact-cap body
requires EOF to succeed; observing an additional byte discards the retained prefix, returns an
empty byte view with `oversized: true`, and attempts to cancel the reader. The cap measures raw
bytes exposed by `response.body`, not characters, `Content-Length`, or total process memory.
The caller supplies the wall-clock deadline through `signal`; an inactivity deadline exists only
when explicitly requested.

An already-aborted signal attempts to cancel the original body before any reader is attached,
then rejects with the same reason by identity. An abort during consumption likewise preserves
the signal reason. Cancellation is best-effort: synchronous throws and rejected cancellation
promises are observed, and a cancellation that never settles cannot extend the read's deadline.
After an attached read, cleanup removes the abort listener, cancels any inactivity timer, and
attempts to release the reader lock. `tests/server/bounded-body.test.ts` covers these paths.

`src/oauth/orcarouter.ts` applies this reader to a successful `POST /api/v1/auth/keys` response
with a 65,536-byte (64 KiB) ceiling. One 30-second signal, combined with caller cancellation,
covers both fetching the response headers and consuming the body; no separate body or inactivity
budget is started. Only a complete body within the cap is decoded with fatal UTF-8 and parsed
as JSON before key, user identity, and optional scope validation can return credentials.

Oversized bodies fail with a fixed size-limit error. Malformed UTF-8, malformed JSON, and ordinary
body-read failures share a fixed invalid-JSON error without upstream text or an error cause.
Body-phase aborts preserve the combined signal's reason by identity; fetch-phase timeout errors
retain the existing network-error wrapper. Non-success HTTP responses retain status-only errors
and do not enter this reader. These limits govern login key exchange, not inference payloads or
other providers' token grants. `tests/providers/orcarouter-provider.test.ts` covers the login
contract with synthetic responses and local callback fixtures, not live provider authentication.

Other raw-byte consumers of this reader supply their own byte and deadline budgets and inherit the
same best-effort cancellation behavior. `src/server/responses/fetch-helpers.ts` keeps its own
transport budgets, so the 64 KiB login ceiling never caps Responses inference payloads. Because a
rejected body returns no credentials, an oversized, malformed, or aborted key response ends the
login before credential persistence or dashboard convergence, leaving only the fixed size-limit or
invalid-JSON message described above.

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
admitted for fixed canonical destinations under the transparent TUN exception, or when the proxy variable that matches the URL scheme is set (HTTPS_PROXY for https:,
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

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger.

Connected CLI usage follows the [client-scoped hub usage contract](../gui-and-management-api.md#usage-accounting); local management and account data remain separate.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](../remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Quota publication distinguishes display reports from explicitly supplied inference projections; a credential-bound cache read validates the current destination and key. See [scoped provider quota](../runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

CCA Gemini summary provenance and request opt-in are specified in [Google provider](../providers/google.md); raw Responses content retains its wire channel.

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
Devin CLI credential path composition in `src/oauth/devin-cli.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.
Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

## Account quota failure diagnostics

Antigravity account quota probes expose only a closed `quotaFailure` category when the read is unavailable. Typed transport failures, rejected destinations, redirects, denied access, rate limits and unusable bodies are distinguished; successful fallback clears the earlier failure. The last attempted endpoint determines the diagnosis. A 401/403 category does not change account health, entitlement or routing eligibility.

`src/providers/quota.ts` binds diagnoses to the probed credential/project and rechecks before cache reads and API projection. Reauthentication invalidates an old diagnosis independently of last-good quota bars. Private digests, callbacks and upstream error values are not serialized. The CLI and current/all-account dashboard views consume the same closed code; unknown codes and local management-read failures retain generic unavailable text. Codes are transient, never persisted quota evidence. Authenticated TUN field acceptance remains separate from deterministic transport coverage.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](../catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.
