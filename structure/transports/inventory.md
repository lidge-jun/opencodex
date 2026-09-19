# Transport Inventory

Meta Muse's registry-owned compatibility User-Agent takes precedence over an incoming client User-Agent; explicit provider headers still win. See the [Muse provider contract](../providers-and-adapters.md).

Native result continuations and function-result injection follow [the mode-specific result and control contract](streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The existing Responses transport is divided by responsibility in the
[core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

The Chat adapter's [OpenCode Go instruction ordering](../providers/chat-compat.md#opencode-go-chronological-instructions)
changes translated message placement only; endpoint selection and transport stay with their existing owners.

Shared parsing and streaming follow the [request-copy](byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](responses.md#passthrough-sse-stream-shapes-314).

[Anthropic seed image metadata](../runtime.md#capability-aware-image-admission) supplies missing capability evidence; transport selection and image wire handling remain unchanged.

## Transport inventory

The sections above cover the transports with load-bearing invariants. The rest of the transport
surface is listed here so a maintainer can find the owner without grepping:

| Transport | Owner | Invariant worth knowing |
| --- | --- | --- |
| Azure OpenAI Responses | `src/adapters/azure.ts` | Deployment-shaped URLs on top of the Responses contract. |
| Responses custom-tool preview | `src/bridge/sse.ts`, `src/server/responses-custom-tool-repair.ts`, `src/responses/progressive-freeform-input.ts`, `src/responses/freeform-wrapper-scan.ts` | Direct adapter events and routed function restoration share one progressive wrapper decoder over one bounded JSON classification of the prefix, so property order and escaped key spellings preview as the wrapper completion unwraps them. Fence-shaped `exec`/`apply_patch` prefixes stay held until authoritative completion normalization, while each caller retains its own patch-envelope and byte-budget policy. |
| Meta Muse Responses tool names | `src/responses/muse-tool-name-alias.ts`, `src/adapters/openai-responses.ts` | `api.meta.ai` only: function names over 64 characters or containing characters outside `[a-zA-Z0-9_-]` become collision-safe wire aliases and are restored before the client sees them. |
| Google / Vertex / Antigravity | `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/adapters/google-wire-compiler.ts`, `src/adapters/google-tool-schema.ts`, `src/adapters/google-truncation.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts`, `src/adapters/google-wire-shape.ts` | Vertex and Antigravity install a Google-family `fetchResponse` and so own their retry policy, while AI Studio Gemini leaves it undefined and uses the default server fetch path. The Google-family wrapper reuses shared abort/deadline helpers, upstream error normalization, and policy-aware wire-body repair: strict initial schema loss sends nothing, while strict repair withholding returns the original 400 without a changed send. The final compiler produces the [content-free tool-schema loss contract](../providers/google.md#google-tool-schema-loss-reporting). `google-wire-shape.ts` remains diagnostic-only. |
| Mimo Free | `src/adapters/mimo-free.ts` | Client identity and JWT handling are transport-local; the per-install client id lives in the opencodex state root. |
| Anthropic image ingress | `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts`, `src/adapters/anthropic-image-codec.ts` | Oversized or unsupported images are normalized or rejected before reaching upstream. An image's ladder position is pinned to its own identity (content hash + media type) rather than recomputed from recency each request (#4532); appending a newer image therefore cannot demote and re-encode older images and bust Anthropic's prompt prefix cache. Unseen images still take the age-tier pyramid's first position, the total byte budget still binds, and a 413 `tierBias` retry still applies. Recorded positions only move down the ladder, so the store is monotonic. |
| Adapter execution support | `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/image.ts`, `src/adapters/upstream-http-error.ts` | Shared machinery: turn ordering, tool-catalog nudging, client fingerprinting, image conversion, upstream error normalization. |
| Cursor (beyond the sections above) | `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/http1-bidi.ts`, `src/adapters/cursor/live-models.ts`, `src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/mcp-manager.ts`, `src/adapters/cursor/thread-continuity.ts`, `src/adapters/cursor/checkpoint-store.ts` | Thread continuity is the point: a retry must not start a new Cursor thread, and a validated checkpoint must not rebuild the full root history. HTTP/2 remains the default; an explicit `http1.1`/`h1` pin maps the bidi run onto Cursor's `RunSSE` receive stream plus sequenced `BidiAppend` sends, and applies to live discovery too. |
| Claude Messages | `src/server/claude-messages.ts` | Routed translation, a native Anthropic passthrough branch, and `count_tokens`. |
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/server/chat-native.ts`, `src/chat/`, `src/adapters/openai-chat.ts` | Inbound translation onto the same routing pipeline. The content mapper preserves image URLs and supported detail, including screenshot-bearing tool results; target adapters own image placement on their wire. Image-free tool results stay strings. The native handler owns pin/cap normalization; the adapter wire builder removes effort only for explicit empty declarations or no-reasoning models, preserving unknown raw declarations. On the response side, the upstream `service_tier` echo relays on every delivery shape (`src/chat/outbound.ts` projections, `src/server/chat-native-sse.ts` chunks); an upstream without the field gets no injected key. |
| Hosted search relay | `src/server/search.ts` | Verbatim ChatGPT relay, or an explicitly configured web-search sidecar backend when no forward provider exists; distinct from the web-search sidecar loop below. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
| API-key pools | `src/providers/api-key-selection.ts`, `src/providers/key-failover.ts` | A configured `apiKeyPoolStrategy` plus a cooling committed key rotates before the first send (`selectProactiveApiKeyTransport`); a 429 still rotates after the send and records a cooldown. `provider.apiKey` keeps mirroring the active entry so routing stays single-key. The pick is inert without a strategy or while the committed key is healthy. |
| OAuth account failover | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-routing.ts` | Reactive pre-output 429 recovery is presence-driven with 2+ eligible accounts. Pool and `oauthAccountFailover` flags govern proactive routing, not the reactive retry: a disabled Anthropic pool recovers through quota ordering rather than its dormant strategy, a per-provider `enabled` beats the global default in either direction, and a non-positive fill-first threshold disables proactive usage-based rotation. |
| OAuth login callback (inbound) | `src/oauth/callback-server.ts` | Every response, including non-callback 404s, closes its connection so a pooled socket cannot deliver a later login to a retired flow on the same callback port. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts`, `src/providers/registry.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. Provider-scoped hints fill capabilities omitted by live rosters; OpenCode Go's `deepseek-v4.1-flash` keeps its 1,048,576-token context window. The fixed-key Opper preset uses the shared OpenAI Chat adapter at `https://api.opper.ai/v3/compat`, discovers models through its conventional authenticated `/models` path, preserves an older same-named custom destination, and falls back to bare pool ids while passing vendor-prefixed ids through unchanged. Codex quota DTOs suppress retired Spark evidence under the [OpenAI scope contract](../providers/openai-tiers.md#public-provider-contract), retaining ordinary custom windows. |

The registry's first-party `deepseek-flash` row declares native `text` and `image` input, so image
requests bypass the vision sidecar by default; explicit `noVisionModels` or text-only declarations
remain authoritative. First-party `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash`
remain sidecar-backed by default. Zen routes are unchanged and unprobed in this update. Zen `mimo-v2.5-free` and `longcat-2.0-free` now carry positive `modelInputModalities` image evidence rather than relying on absence from the text-only list.

> Decision record: [ADR-0072](../decisions/ADR-0072-transport-inventory.md)

Cursor external-model continuations attach data-URL screenshots from the contiguous active
tool-result batch through the existing image preparation and selected-context owners. The batch
shares the 12-image active cap. Bounded source labels are emitted in active user-action text so
root pruning cannot erase attachment provenance; the same text participates in token estimation.
Native Composer/MCP behavior and text-only historical replay remain unchanged.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Media iteration retention

`src/images/loop.ts` admits at most 32 MiB of serialized non-heartbeat adapter events per
iteration, including array framing, and 2 MiB of UTF-8 arguments per current tool call. Both
`runTurn` emission and ordinary stream collection enforce the shared translator limits before
retaining another event. Overflow aborts the producer and surfaces `translation_buffer_limit`.
The iteration budget is separate from adapter leases and final response buffers; collected
`runTurn` events reach the scanner directly without a second charge. Heartbeats do not reset
argument accounting, and each new iteration receives a fresh retention budget. The charge follows
what `src/adapters/run-turn-queue.ts` keeps: `push` reports whether it merged a text or thinking
delta into its buffered tail, and a merged delta costs only its appended payload. Billing every
pre-merge envelope would abort a turn on roughly a thirtieth of the documented limit whenever a
producer streams token-granular deltas ahead of its consumer. These bounds do
not cap process RSS or the conversation messages accumulated across completed media iterations.
`tests/images/loop.test.ts` covers early producer cancellation, byte boundaries, iteration reset,
opaque metadata, normal tool passthrough, coalesced-tail accounting, and consumer cancellation on
both execution paths.

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

Google tool-schema loss diagnostics follow the same outbound boundary. The compiler retains only
an endpoint class, closed category counts, and bounded flags; provider debug controls emission,
and the diagnostic adds no field or byte to the upstream request.

Provider connection tests and live model discovery share the GET-only provider outbound wrapper.
Direct HTTP(S) resolves once and pins the validated address; HTTPS preserves the original Host/SNI
and always verifies certificates. HTTP(S)-proxy requests stay on Bun fetch; configured SOCKS5
requests use the explicit tunnel fetch. Both retain NO_PROXY semantics. The wrapper classifies successful local DNS answers, but
only a typed DNS-resolution failure degrades to proxy resolution; every literal, metadata, and
resolved-address policy error still rejects. Proxy mode logs once that the proxy-selected peer
cannot be pinned. Private destinations additionally require allowPrivateNetwork plus NO_PROXY.

Two fake-IP DNS accommodations exist, both for resolved answers only (a literal address in the URL
still rejects). The IANA benchmark range (198.18/15 and its IPv4-mapped IPv6 spellings) is admitted
whenever any outbound proxy applies to the host, because the range itself marks the answer synthetic.
Mihomo's default IPv6 fake-IP range (fdfe:dcba:9876::/48) is ULA and carries no such mark, so it is
admitted for fixed canonical destinations under the transparent TUN exception, or when the proxy variable that matches the URL scheme is set (HTTPS_PROXY for https:,
HTTP_PROXY for http:; a SOCKS5 ALL_PROXY takes precedence through the configured wrapper), the host is
not in NO_PROXY, and the request is then bound to that same proxy through the explicit `proxy` option
rather than environment inference. Both gates live in the outbound wrapper, not in classification:
`classifyIpv6` and config-time validation (`providerDestinationResolvedError`) never admit the
ULA, so provider save-time checks are unaffected (#3462).

Both paths reject redirects and expose only credential-stripped final-address guidance. The shared
SOCKS5 fetch also carries ordinary request bodies and response streams, while redirect decisions
remain with their request owners.
Caller-owned `provider.fetch` executors are also deferred: they receive literal/config checks and
redirect blocking, but cannot inherit DNS classification or peer pinning without a verified-peer
executor contract. Main-request migration must not treat that branch as fixed-transport equivalent.

Crusoe model discovery is one fixed canonical destination on this path. It sends a Bearer key only
to `https://api.inference.crusoecloud.com/v1/models`, rejects redirects, and applies the registry's
256 KiB response and 256-row ceilings before catalog admission. A same-named custom destination
does not inherit this policy.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

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
Devin CLI credential path composition in `src/oauth/devin/cli-import.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged.

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

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Startup provider-id migration preserves the account binding between configuration and OAuth credentials; see the [runtime contract](../runtime.md).

Unicode pattern normalization uses [copy-on-write traversal](byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

## Model-family-aware OAuth headroom

`src/oauth/account-quota-rank.ts` ranks Antigravity custom windows for the requested
Gemini or Claude family, including GPT-OSS in the Claude family. An unknown model
retains all-window ranking; absent matching evidence retains the existing unranked behavior.
`src/server/responses/request-transport.ts` passes the routed model at initial selection.
The passthrough, adapter, continuation, sidecar and run-turn execution owners pass
the same routed model during account rotation, without bypassing their send-budget
admission or account-snapshot pairing. The forwarding contract is covered in
`tests/oauth/oauth-account-quota-rank.test.ts`; the core facade remains orchestration-only.

## SOCKS5 dispatch boundary

`src/config/proxy-env.ts` activates configured SOCKS5 through `src/lib/proxy-env.ts`;
the compatibility config facade does not own a second activation path.
`src/server/responses/fetch-helpers.ts` routes the built-in HTTP executor through
configured outbound fetch, preserving physical-send admission and dispatch override.
Native WebSocket selection stays on HTTP SSE while SOCKS5 is configured.
Proxy-selected discovery peers remain unpinnable, and private destinations still
require explicit private-network permission plus NO_PROXY before direct transport.

The tunnel reader keeps incomplete framing separate from queued socket bytes,
waits for new input, and caps headers even when the terminating delimiter arrives
in the same chunk. Cancellation removes the exact queued waiter; socket errors
remain errors on later reads rather than turning into clean EOF. Buffered body
reads pause the socket at the local high-water mark, and an upload failure is observed
by the caller rather than lost behind the answer. `tests/lib/socks5-fetch.test.ts` covers
fragmented framing, header limits and explicit-route snapshot preservation.
Explicit `http2` / `h2` pins reject before network I/O: this HTTP/1.1 tunnel cannot
honor them and must not silently downgrade the provider contract.

The upload and the answer are read together. One reader consumes the socket for the whole
exchange, starting before the request body is finished, because a peer may answer a request it
has not finished receiving and a caller's body stream may stall. Each body read and drain wait
races the caller's abort and that pending answer, so an abort settles the fetch with its own
reason rather than leaving a read the transport does not own, an early final response ends the
upload without writing a terminating chunk into a finished conversation, and a socket failure
during a stalled read surfaces as the failure instead of a promise that never settles. The
request body is cancelled without being awaited, since a caller's cancel algorithm may itself
never settle. `tests/lib/socks5-upload-lifecycle.test.ts` covers these four outcomes.

Content-coding is this transport's own obligation. `fetch` decodes a coded body below the
Response constructor; this tunnel assembles the body from a socket, so a response wrapped with
its upstream headers hands the coded bytes to whatever parses them. The request therefore asks
for `identity` unless the caller chose an `accept-encoding` itself, a `gzip` or `deflate`
response is decoded and stops advertising the coding and the coded length, and any other coding
is refused by name rather than surfaced as bytes no caller can read.

## Raw transport null-body statuses

`src/lib/http-response-semantics.ts` holds the null-body status set both raw outbound transports
have to honor. `fetch` applies it below the Response constructor; `src/lib/pinned-http.ts` and
`src/lib/socks5-fetch.ts` build a Response from a socket, so each one applied the rule on its own
and the two disagreed — the SOCKS helper excluded 204 and the pinned helper excluded nothing.
204, 205 and 304 resolve with a null body and release the connection instead of waiting for a
peer that is entitled to keep it alive, and their representation headers are preserved as they
arrived rather than decoded or refused, because there are no coded bytes to act on.
`tests/lib/transport-null-body.test.ts` covers both transports against a keep-alive peer.

## Raw transport content coding

Content coding is each raw transport's own obligation, and the pinned direct helper now carries
the same one the tunnel does. Provider outbound picks between these two routes, so decoding on
only one of them made the same gzip JSON readable or unreadable depending on operator egress
configuration. Both ask for `identity` unless the caller chose an `accept-encoding` itself,
decode `gzip` and `deflate`, drop the coding and the coded length once the bytes no longer match
them, and refuse any other coding by name instead of surfacing bytes no caller can parse. Only
the coding the response actually carries decides this; a preference list that mentions an
alternative this code cannot undo is not a refusal.

The pinned helper's `maxBytes` binds both sides of that decode: the bytes that arrive on the
socket keep their existing meaning, and the decoded bytes are bounded by the same ceiling, so a
small coded response cannot expand past the limit a caller set to bound what it holds. A decoder
failure surfaces as a named `PinnedHttpError`. Connection teardown belongs to the responses that
end early — a decode failure, an exceeded ceiling, a cancelled read; a response that completed
is left to the HTTP agent, which may pool or destroy it.
`tests/lib/pinned-http-content-coding.test.ts` covers both routes on the same payload.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).
