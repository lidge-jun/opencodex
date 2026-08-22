# Transports And Sidecars SOT

## Provider diagnostic outbound safety

Provider connection tests and live model discovery share the GET-only provider outbound wrapper.
Direct HTTP(S) resolves once and pins the validated address; HTTPS preserves the original Host/SNI
and always verifies certificates. Proxy-configured requests stay on Bun fetch so HTTP(S)_PROXY,
ALL_PROXY, and NO_PROXY semantics remain authoritative. The wrapper classifies successful local DNS answers, but
only a typed DNS-resolution failure degrades to proxy resolution; every literal, metadata, and
resolved-address policy error still rejects. Proxy mode logs once that the proxy-selected peer
cannot be pinned. Private destinations additionally require allowPrivateNetwork plus NO_PROXY.

Both paths reject redirects and expose only credential-stripped final-address guidance. This phase
does not cover ordinary requests, streaming, retries, or per-hop redirect review on those paths.
Caller-owned `provider.fetch` executors are also deferred: they receive literal/config checks and
redirect blocking, but cannot inherit DNS classification or peer pinning without a verified-peer
executor contract. Main-request migration must not treat that branch as fixed-transport equivalent.

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output.

[Decision Log]
- 목적과 의도: Prevent routed models from turning invented or neighboring-agent tool names into client-executable Responses calls.
- 기존 구현 및 제약 조건: The request catalog already controlled custom-tool restoration and the non-OpenAI prompt nudge, but an undeclared upstream name still fell through as an ordinary `function_call`; Codex then reduced the mismatch to a bare `aborted` result.
- 검토한 주요 대안: Rely only on prompt guidance; automatically translate undeclared `apply_patch` into Code Mode; validate returned names against the request-visible catalog at the final bridge.
- 선택한 방식: Retain the allowed wire-name set with the existing bridge maps and fail the turn with an explicit compatibility error before emitting any undeclared tool item.
- 보완된 경계: Key-auth Responses passthrough restores a routed custom call only when the adapter actually lowered that name after request normalization and the caller's `tool_choice` still authorizes it. Native `apply_patch` and tools replaced by hosted-provider policy stay in their upstream function-call form.
- 다른 대안 대신 이 방식을 선택한 이유: Model guidance is not an enforcement boundary, while automatic translation would invent executable caller intent and arguments after generation.
- 장점, 단점 및 영향: Streaming and non-streaming routed responses now fail closed with an actionable provider-contract error; providers that emit aliases they never advertised must correct their adapter mapping instead of relying on client abort behavior.

[Decision Log]
- 목적과 의도: Keep Codex client-side deferred tool discovery usable through third-party Responses-compatible gateways that implement public function tools but reject the private `tool_search` declaration.
- 기존 구현 및 제약 조건: The chat translation path already exposed search as a function and bridged its call back to `tool_search_call`; passthrough only promoted definitions returned by an earlier search, so it could not initiate discovery on a strict third-party Responses endpoint.
- 검토한 주요 대안: Require every gateway to implement Codex-private tool types; route affected models through `openai-chat`; lower the declaration only; lower the noncanonical request and restore both JSON and SSE response lifecycles.
- 선택한 방식: On noncanonical Responses passthrough only, lower an actually declared `tool_search` to a collision-free public function name, translate its replayed call/output history to public function pairs, record only caller-authorized request-local conversions, and restore matching JSON/SSE calls to client `tool_search_call` items. Canonical OpenAI forward remains byte-shape native.
- 다른 대안 대신 이 방식을 선택한 이유: Provider-specific workarounds fragment the contract, while unconditional restoration could turn an untrusted ordinary function call into a privileged client discovery action.
- 장점, 단점 및 영향: Strict third-party Responses gateways can start and continue deferred discovery without changing native ChatGPT behavior; ordinary same-named functions remain distinct, and the proxy performs a capped SSE lifecycle rewrite only when the request actually required compatibility translation.

[Decision Log]
- 목적과 의도: Keep Codex 0.147 namespace tool catalogs usable after a routed provider adopts native Responses but implements only the public flat tool variants.
- 기존 구현 및 제약 조건: Chat translation already flattened namespace children, while native Responses passthrough forwarded the private `namespace` variant unchanged. xAI therefore rejected Grok requests before inference after its OAuth Grok 4.5/4.6 route moved to Responses.
- 검토한 주요 대안: Move Grok back to Chat; special-case only xAI or the reserved `functions` group; flatten every complete namespace on noncanonical Responses and restore request-authorized aliases on return.
- 선택한 방식: Noncanonical Responses lowers `functions` children to their bare top-level names and every other complete namespace to collision-checked `<namespace>__<name>` aliases after custom/tool-search conversion. It rewrites matching replay calls and tool selectors, records the aliases on the built request, and restores only those aliases in JSON/SSE call items before custom/tool-search lifecycle repair. Canonical OpenAI forward preserves native namespace shapes.
- 다른 대안 대신 이 방식을 선택한 이유: A transport regression should not discard Responses streaming or create a provider-specific fork, and restoration without request-local authorization could reinterpret an unrelated upstream function as a client namespace call.
- 장점, 단점 및 영향: Grok and other public-schema Responses gateways accept current Codex catalogs while Codex still receives explicit namespace routing. No `type: "namespace"` value survives the boundary: a group the layer cannot express — empty, nested, or with an unusable child name — is dropped along with the children it cannot represent, because relaying the private shape costs the whole request rather than one tool. Genuinely ambiguous wire names still fail closed, now as a 400 rather than an unstructured 500.

Two coordinates that lower to the same wire name are treated as one tool when they denote one:
`buildTools` flattens the reserved `functions` group without a namespace, so a bare declaration and
a `functions` child of the same name are the duplicate the parser already tolerates — and the one
`promoteClientLoadedTools` produces. The declaration is emitted once instead of failing the request.

Replayed call items are lowered whether or not this turn declares the group they name. A routed
compaction turn strips the whole tool surface before the boundary runs, and a catalog can change
mid-session, but the client is still replaying items this layer's own response restoration stamped
with a private `namespace`. Only `tool_choice` resolves a bare name through the catalog: a history
item records which tool actually ran, so re-pointing it at a same-named namespace child would
rewrite that record on a coincidence rather than translate it.

Codex-private tool fields are removed at the same boundary from one table
(`CANONICAL_ONLY_TOOL_FIELDS`) rather than one bespoke pass each: `external_web_access` on either
web-search variant, and `defer_loading` on any declaration, which `activateDeferredTool` clears only
for tools a `tool_search_output` already loaded. A new private bit is a row there.

The same noncanonical boundary strips ChatGPT's private `external_web_access` bit from routed
`web_search` declarations. The public tool remains enabled and all other options remain intact;
canonical OpenAI forwarding preserves the bit. xAI's public Responses schema enables browsing by
the presence of `web_search` and rejects the private argument, so forwarding it made the first
post-namespace request fail with HTTP 400.

The option-aware `openai` provider uses `openai-responses` with `authMode: "forward"`. Pool mode
resolves main plus added accounts through affinity/quota/cooldown ownership; Direct forwards only
the allowed Codex/OpenAI auth/session headers from the current request and short-circuits pool
state. `openai-apikey` uses its configured key and canonical API base URL. Missing credentials fail
within their route; neither route falls through to the other. See
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

### Routed service-tier capability

OpenAI-compatible service-tier support is resolved only after the final provider/model wire is
known. `supportsServiceTier` remains the provider fallback, while the exact
`modelSupportsServiceTier` map can override it per upstream model, including an explicit `false`.
The catalog and request path share this decision: a routed row publishes `service_tiers` only when
the resolved policy is eligible, and the final-route normalizer applies the same gate to
`service_tier`. Both `openai-responses` and `openai-chat` use the resolved provider/model capability
for catalog publication, routing evidence, and fingerprints. Canonical Fast injection additionally
requires a compatible FastWire mapping on the final adapter and an eligible policy. Setting
`fastMode: false` drops it. On classified Chat routes, `chatServiceTier` separately authorizes
foreign caller values; an exact-model `true` does not grant that forwarding permission. On
unclassified Chat routes it gates every caller tier because no canonical Fast capability has been
validated. An object-form registry wire default may also set `forwardCallerServiceTier: false` to
close a known subscription gateway while leaving generic unclassified Responses passthrough
unchanged. Exact `false`
narrows provider defaults, and provider-level `supportsServiceTier: false` cannot be reopened.
Capability is namespaced by the selected provider and model; model-name similarity and adapter type
alone never opt a gateway in.

`POST /v1/responses/compact` handles remote compaction v1 before the generic `/v1/responses` branch
and before the `/v1/*` guard. Unknown `/v1/*` paths return JSON 404 errors instead of falling through
to GUI static serving.

A replayed compaction item carries an `encrypted_content` blob only its minting backend can decode,
and the client replays it on every later turn. The proxy's own `ocx1:` envelopes are transparent
base64, so they always lower to plain user messages. A native blob is relayed only when there is no
known serving-identity mismatch and the destination is known to decode native blobs — the canonical
ChatGPT forward surface, the official OpenAI API, or a provider with the explicit
`decodesNativeCompactionBlobs` capability. The destination gate alone is insufficient because more
than one backend, including OpenAI and xAI, mints native blobs: a destination can decode its own blob
without being able to decode the previous backend's. The same serving-identity mismatch signal
therefore strips reasoning `encrypted_content` and degrades native compaction blobs through the
existing opaque-note path. When the thread has no recorded identity, the destination-only behavior
is deliberately unchanged. Forward auth alone is not evidence: noncanonical forward providers
receive no caller credentials and may point at any backend. On any other routed destination the blob
also degrades to the same opaque note the bridged parser uses, because forwarding it there fails the
turn and the item outlives the failure in the client transcript, repeating on every later turn
including the compaction turn the proxy itself drives. With `store: false`, request sanitization
strips ids from every input item, including compact-wire items, matching codex-rs
(`core/src/client.rs:918-925`). Compact-wire items remain exempt from response-side field backfill.

[Decision Log]
- 목적과 의도: Keep a session usable after its history crosses backends, instead of wedging it on a
  compaction blob the current upstream cannot decode.
- 기존 구현 및 제약 조건: Compaction handling was binary — `ocx1:` envelopes were ours, everything
  else was treated as a native blob and gated only by the destination, even though multiple backends
  mint mutually incompatible blobs. Response-side field backfill exempted only `compaction`, so its
  two sibling types received synthesized ids the client then replayed.
- 검토한 주요 대안: Tag every compaction item with its minting provider/credential/model identity;
  drop compaction items on any route change; gate relay on the destination that would decode them.
- 선택한 방식: Reuse the thread's recorded serving identity to degrade native blobs after a known
  route change; otherwise retain the destination capability gate, and treat the compact wire family
  as one enumeration so id-bearing passes cannot diverge per type.
- 다른 대안 대신 이 방식을 선택한 이유: Full per-item provenance tagging is unnecessary when the
  existing thread identity proves a route change, while dropping the item would silently discard
  compacted context and widening unknown-identity behavior needs a separate decision.
- 장점, 단점 및 영향: A cross-backend session degrades one compaction summary to a note instead of
  failing every later turn. A self-hosted OpenAI relay keeps its blobs only when explicitly opted in;
  other routed gateways see a note because routed compaction produces an `ocx1:` envelope.

### Mixed-wire provider defaults

Registry `modelWireDefaults` select an evidence-backed upstream protocol for an exact model without
changing the provider-wide adapter. Explicit, allowed `modelAdapters` configuration always wins,
including an entry that opts the model back into the provider-wide wire. Defaults are applied only
while the configured provider still matches the registry transport, so reusing a preset name for a
different custom destination does not inherit its upstream assumptions. Object-form defaults may
also narrow the decision by inbound protocol and authentication mode; an auth-scoped default must
not leak from a subscription transport into an API-key or forwarded-credential route.

xAI keeps `openai-chat` as both its provider-wide compatibility wire and the default for Grok 4.5
and 4.6 subscription traffic. The official Grok CLI catalog declares those models as Responses
backends, but the current gateway rejects opaque reasoning continuation and compaction state on
later turns. Operators may still select `openai-responses` with an explicit model adapter override
while that compatibility work continues. The OAuth route drops caller-owned `service_tier` even
when an override selects Responses, and native Responses OAuth 401 replay remains available to
explicit opt-ins. API-key requests, translated Chat/Anthropic callers, and other Grok models retain
their existing wire and tier policy.

The dashboard's xAI Responses opt-in switch is the GUI surface of this same `modelAdapters` lane,
not a separate tier policy. One write sets or clears the Grok 4.5 and 4.6 entries together while
preserving unrelated overrides; a pre-existing one-entry state is reported as mixed until the next
switch write normalizes both.

OpenCode Go documents `gpt-5.6-luna` on `/zen/go/v1/responses` while sibling models use its Chat or
Anthropic endpoints. The built-in preset therefore selects `openai-responses` only for Luna and
keeps the provider-wide `openai-chat` default for other non-pinned models. This endpoint correction
does not set `modelResponsesUpstreamStreaming`: client `stream: true` remains real upstream
streaming until a current-runtime reproduction justifies a separate bounded-JSON compatibility
policy.

[Decision Log]
- 목적과 의도: Match OpenCode Go's model-specific Luna endpoint without changing sibling model behavior.
- 기존 구현 및 제약 조건: The preset had one Chat default even though the upstream publishes a mixed Chat, Responses, and Anthropic matrix; operators must retain explicit override precedence.
- 검토한 주요 대안: Move the whole preset to Responses; infer from the model name; declare one exact registry default; also force bounded JSON from an older conditional terminal report.
- 선택한 방식: Use one exact Luna wire default and leave upstream streaming unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: The endpoint mismatch is reproducible from current code and upstream documentation, whereas a current-dev live canary has not established the separate terminal-delivery policy.
- 장점, 단점 및 영향: Luna reaches its documented endpoint across inbound surfaces and explicit opt-out still works; any future stream workaround remains a separately reviewed compatibility decision.

### Passthrough SSE stream shapes (#314)

Native passthrough SSE has TWO shapes, selected per request in
`src/server/responses/core.ts`:

- **Default outside Windows: tee + background inspection.** `upstreamResponse.body.tee()` sends
  branch[0] through a terminal-aware client relay while branch[1] is
  drained eagerly by `consumeForInspection`/`consumeForResponseLogMetadata`
  for terminal-outcome recording, quota, the passthrough continuation cache,
  and request logs. This remains the default shape on bundled Bun 1.3.14.
- **Terminal-aware eager bounded relay** (`src/server/relay-eager.ts`). Windows
  uses this single-reader shape for rewrite traffic and for no-rewrite traffic
  selected by `selectEagerPath` in `src/lib/bun-stream-caps.ts`; the latter keeps
  `legacy-tee` and known-bad-runtime `auto` on tee as documented. When selected,
  `response.completed` closes the client stream even if upstream keeps HTTP/SSE
  alive. Darwin uses it for no-client-rewrite traffic only (neither image-gen
  aliases nor item-id repair) and is explicit-only: `auto` stays tee even after
  a future threshold bump. One eager reader + byte-bounded
  client queue + post-cancel bounded discard-drain replaces the tee and goes
  directly to the response without a JS rewrite wrapper, preserving the full
  inspection side-effect set (shared `createSseInspector` factory in `relay.ts`)
  including the #44 late-terminal semantics.

The two-shape contract is mirror-commented in `src/server/index.ts`; the real
`core.ts` gate is source-invariant-tested by `tests/passthrough-abort.test.ts`,
and the platform matrix lives in `tests/bun-stream-caps.test.ts`. Keep all three
in lockstep with any passthrough-policy change.

Canonical ChatGPT forward streaming has one transport-specific exception. A
stable Bun runtime at or above 1.4.0 may use Codex's upstream
`responses_websockets` transport; bundled Bun 1.3.14, prereleases, and
unverifiable runtime identities stay on HTTP/SSE. A successful upstream WS
response is re-encoded to the same SSE surface and forced through the bounded
eager single-reader relay instead of `tee()`: raw and enveloped frames are capped
at 4 MiB and the WS producer queue at 8 MiB. Overflow closes the upstream and
the downstream relay emits its terminal `response.failed` event plus `[DONE]`.
Pre-open HTTP fallback remains unmarked and follows the ordinary configured
stream path.

Translated response request-log tracking and the heartbeat relay also reuse
`createSseInspector`. This keeps every client-facing SSE observation path on
the same byte-bounded, discard-and-resynchronize frame policy and ensures the
request-log, first-output, and terminal observers share one payload parse.
The inspector records a structured `response.failed` status before invoking the
terminal observer. Native Responses, Chat Completions, Claude Messages, and WebSocket
request logs must therefore finalize through the context-aware terminal mapper; recognized
`cyber_policy` terminals stay `400 / cyber_policy` rather than collapsing to a generic 502.

## Standalone Search and exact account selectors

`POST /v1/alpha/search` retains the selected model in its request body. When that value is an
account-qualified native selector, the server resolves the public namespace, uses only the mapped
stored Codex credential, and sends the bare native model upstream. That exact path is fail-closed:
it does not consult Pool active state or affinity when selecting, and its outcomes cannot rotate
the active Pool account. An account-wide credential failure still quarantines that credential and
clears stale ordinary Pool affinities so they cannot reappear after reauthentication. Quota and
transient outcomes from an exact request leave Pool affinities untouched. Ordinary search requests
keep the normal Direct/Pool sidecar behavior.

Standalone Images and Live requests currently carry neither the account-qualified model selector
nor a trustworthy thread correlation from the Codex client. They therefore retain normal provider
routing. Do not infer an exact account from caller-supplied account headers, process-global last
selection, connection identity, or other ambient state; concurrent threads could cross-route
credentials. Extending exact routing to those endpoints requires an opaque client correlation that
can be bound server-side to a previously validated selector.

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

`src/server/images.ts` uses the existing ChatGPT/OpenAI fallback unless `images.provider` explicitly
selects a custom API-key `openai-responses` provider. Explicit selection fails closed when the
provider is missing, disabled, registry-managed, incompatible, or lacks a usable key; it never
falls through to another paid upstream. The relay accepts bounded JSON generation and edit requests,
then forwards the decoded JSON without rewriting Codex's edit schema. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

When the OpenAI credential path is unavailable or its authentication fails, `generations` (not
`edits`) may fall back to Google Antigravity if that provider is logged in. The fallback is
credential-driven: it exists so an image request reaches a real upstream answer rather than dying on a
local credential error, and it does not apply when the caller selected an explicit keyed custom
provider, because a configured pool owns its own authentication failure rather than hiding it behind
separately billed generation.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes. An
explicit keyed Images provider accepts the proxy admission secret as either an OpenAI-style bearer
or `x-opencodex-api-key` because the provider key replaces caller authorization before fetch. The
ChatGPT forward path still requires the dedicated header so its upstream bearer remains distinct.

The API-key `openai-responses` path also adapts Codex's private standalone image tool to the public
Responses tool surface. A complete `image_gen` namespace is lowered to safe
`image_gen__<inner-name>` function aliases even when no hosted image tool is present, because public
Responses runtimes may reserve the namespace itself and reject dotted function names. Native and
legacy dotted calls replayed in `body.input` are encoded to the same aliases. When any client
image-gen declaration is replaced by a usable `image_gen__<inner-name>` alias, the adapter also drops
hosted `image_generation` and deduplicates aliases in stable container order. Empty or malformed
namespaces do not remove the hosted fallback. Discovery and normalization span both top-level
`body.tools` and Codex Desktop Responses Lite `input[].type = "additional_tools"` containers.

For a model explicitly listed in `modelPreferHostedTools`, a non-forward Responses provider may opt
to remove colliding client `image_gen` declarations before this normalization and rewrite their
selectors to hosted `image_generation`, so a provider-reserved hosted tool takes precedence without
loosening a caller's tool-choice restriction. The opt-in is intentionally model-scoped: the default
alias path remains safest for ordinary public Responses endpoints.

For OpenAI API virtual `-pro` models, preference lookup checks the selected public ID first and
uses the resolved base wire-model ID as a fallback. `modelAdapters` resolves the public ID first and
the base ID second; the second pass selects the final adapter, and configuration validation mirrors
both steps.

Client-facing API-key responses perform the inverse mapping: JSON output and SSE function-call
items restore `{ namespace: "image_gen", name: "<inner-name>" }` so Codex can dispatch the local
extension. When item-id repair is also enabled, both transforms compose in one SSE parse/stringify
pass (`src/server/sse-payload-rewrite.ts`) rather than chaining separate JS pull wrappers.
Inspection and continuation-cache branches keep the raw upstream alias, allowing stored
replays to return upstream without leaking a client-only namespace shape. The image-gen layer itself
leaves malformed and empty image-gen namespaces untouched, but on a noncanonical route the general
namespace boundary above runs after it and lowers whatever remains, so no private group reaches the
wire. ChatGPT forward mode preserves the private namespace and hosted tool because that backend
understands their native semantics.

Per-model `modelReasoningSummaryDelivery` is a narrow compatibility layer for
`openai-responses` gateways whose summary capability is real but whose accepted delivery enum
differs from Codex. Presence advertises reasoning summaries in the routed catalog and rewrites only
an already-present `stream_options.reasoning_summary_delivery` at the adapter boundary. It never
injects summary generation into a request, and config validation rejects a delivery map that
conflicts with `modelSupportsReasoningSummaries: false` for the same model.

[Decision Log]
- 목적과 의도: Preserve Codex Desktop reasoning summaries while adapting only the delivery enum rejected by a specific Responses-compatible upstream.
- 기존 구현 및 제약 조건: The existing boolean capability either passed Codex's enum unchanged or disabled summaries entirely; stale running clients can keep sending the old enum after a catalog refresh.
- 검토한 주요 대안: Disable summaries; rewrite the enum globally; inject a delivery field when absent; configure a provider-wide value.
- 선택한 방식: Use a validated per-model allowlisted map, imply summary capability for that model, and rewrite only a caller-provided delivery field at the Responses adapter boundary.
- 다른 대안 대신 이 방식을 선택한 이유: Upstream enum support differs by model and provider, while global rewriting or injection would change unrelated requests and disabling summaries removes Desktop UX.
- 장점, 단점 및 영향: Configured models retain the native summary UI and stale clients self-heal; each incompatible model needs an explicit map entry and contradictory opt-out configuration now fails closed.

## Claude Desktop config-library resolution

The Desktop profile writer and the management status probe share
`resolveDesktop3pConfigLibraryPath`. The resolver reproduces Desktop's own rule rather than a guess:
an explicit `CLAUDE_USER_DATA_DIR` (or the opencodex override) wins; on Windows
`%LOCALAPPDATA%\Claude-3p` wins; otherwise the Electron user-data path gains a `-3p` suffix if it
does not already have one. `configLibrary` is appended to that root.

`Claude-3p` is Desktop's real directory name, assembled at runtime from `"Claude" + "-3p"`, which is
why searching the app bundle for the literal string finds nothing. It is not a legacy path to migrate
away from. Resolution stays a pure function of (env, platform, home) so the Windows branch is
testable on any host: stubbing `process.platform` does not propagate to `os.platform()` under Bun.

[Decision Log]
- 목적과 의도: 생성된 Claude Desktop 프로필이 설치된 Desktop이 실제로 읽는 디렉터리에 떨어지고, 대시보드 상태가 그 쓰기 대상과 일치하게 한다.
- 기존 구현 및 제약 조건: 두 호출자가 경로 계산을 각자 복제했고, Desktop이 실제로 참조하는 `CLAUDE_USER_DATA_DIR`와 Windows `LOCALAPPDATA` 분기가 빠져 있었다(#539). 사용자가 프로필 루트를 직접 지정하는 경우도 있다.
- 검토한 주요 대안: `-3p` 접미사를 구버전 잔재로 보고 제거; 두 디렉터리를 모두 스캔; 레거시 파일을 자동 이전; 크로스플랫폼 해석기를 한 곳에 둔다.
- 선택한 방식: Desktop 번들의 해석 규칙을 그대로 이식한 override 인지 해석기를 한 곳에 두고, 쓰기 경로와 상태 조회가 같은 함수를 쓴다.
- 다른 대안 대신 이 방식을 선택한 이유: `-3p`는 Desktop의 정상 동작이므로 제거는 회귀였다. 해석기를 한 곳에 두면 두 호출자의 드리프트가 불가능해지고, 파괴적 이전 없이 상태와 쓰기 대상이 일치한다.
- 장점, 단점 및 영향: 지원 플랫폼 전부에서 apply 결과가 Desktop에 보인다. 비표준 레이아웃 사용자는 문서화된 override를 써야 하고, 해석기는 Desktop 번들의 규칙 변경을 따라가야 한다.

## Cursor Native Exec

Cursor's experimental live transport can receive server-driven local read/write/delete/ls/grep,
shell, and fetch exec frames. These frames are denied by default because they bypass Codex's normal
approval and sandbox path. `nativeLocalExec: "on"` is the explicit config-owner opt-in for trusted
local experiments; `off` and the backwards-compatible `codex-sandbox` spelling both fail closed.
MCP, screen recording, and computer-use stay on their separate explicit executor/MCP config paths.

[Decision Log]
- 목적과 의도: prevent caller-controlled Responses text from authorizing Cursor native local shell, filesystem, or fetch execution.
- 기존 구현 및 제약 조건: the adapter preserved top-level `instructions`, system messages, and developer messages, then treated a `sandbox_mode ... danger-full-access` prose marker as an exec allow signal in `codex-sandbox` mode.
- 검토한 주요 대안: keep marker-based authorization, require a future trustworthy attestation channel, or restrict authorization to server-local config.
- 선택한 방식: keep marker detection only as diagnostic/context and make `nativeLocalExec: "on"` the only non-legacy mode that enables built-in local exec; unset, `off`, and `codex-sandbox` all deny.
- 다른 대안 대신 이 방식을 선택한 이유: opencodex has no trustworthy per-request sandbox attestation in request text or headers, so any prompt-carried marker is spoofable by data-plane callers.
- 장점, 단점 및 영향: this closes prompt-to-native-exec escalation while preserving an explicit operator escape hatch; existing configs that relied on `codex-sandbox` must switch to `nativeLocalExec: "on"` for trusted local experiments.

Cursor's generic tool-use prompt filter must preserve every Responses-owned execution-path tool
that survives the transport budget: unified Desktop `exec` as well as the legacy
`exec_command`/`shell_command` aliases. The legacy aliases receive Cursor-specific shell guidance;
unified `exec` keeps its own schema and is surfaced back to Codex as a client tool. It must never
fall through to the separate native-local-exec dispatcher.

[Decision Log]
- 목적과 의도: keep fresh Cursor-routed Codex Desktop subagents able to invoke the actual unified `exec` tool exposed by their client catalog.
- 기존 구현 및 제약 조건: catalog truncation already pinned `exec`, but the later generic-tool filter recognized only bare `exec_command`/`shell_command` and could erase the sole executable client tool while also naming aliases that were absent.
- 검토한 주요 대안: synthesize a legacy alias, execute `exec` through Cursor native-local-exec, disable generic filtering, or treat every Responses-owned execution-path tool as eligible.
- 선택한 방식: preserve the existing client tool and schema by filtering with `isCursorExecutionPathTool`; keep alias-specific prompt guidance gated on an alias actually being present.
- 다른 대안 대신 이 방식을 선택한 이유: Codex Desktop remains the execution and approval authority, no unavailable tool name is invented, and the existing Responses MCP suspension path can relay the call without widening native execution privileges.
- 장점, 단점 및 영향: unified `exec` survives the filter and returns to Desktop for execution; legacy aliases behave as before; `wait` and unrelated tools remain excluded from generic tool-count prompts.

## WebSocket

The WebSocket endpoint exists at `/v1/responses`, but discovery is opt-in:

```json
{
  "websockets": false
}
```

`websocketsEnabled(config)` is true only for an explicit `true`. When false, opencodex removes
`supports_websockets` from injected provider tables and routed catalog entries, keeping Codex on
HTTP/SSE. When true, Codex may use Responses WebSocket frames handled by `src/server/ws-bridge.ts`.
If Codex still attempts a WebSocket upgrade while the feature is disabled, `/v1/responses` rejects
the upgrade with 426 so Codex falls back to HTTP cleanly.

That setting controls the client-facing upgrade only. The transparent upstream
ChatGPT WS optimization described above is selected independently and still
returns the same downstream SSE contract.

The endpoint handles `response.create`, ignores `response.processed`, supports warmup
`generate: false`, and feeds the same request pipeline as HTTP/SSE.

Registry-declared per-model compatibility hints (`modelResponsesUpstreamStreaming`) may ask the
upstream Responses endpoint for bounded JSON on ANY client transport — WebSocket or ordinary
HTTP/SSE. The bridge reframes that JSON into the same Responses event sequence
(`src/server/responses-json-events.ts`): WS turns send the frames as WebSocket messages, while
HTTP clients that requested streaming receive a synthesized terminal SSE body (created →
output_item.done → terminal → `[DONE]`). No production registry entry currently opts in:
DeepSeek V4 Flash used this path while its public-beta Responses stream was suspected of not
closing on the terminal event, but the official guide documents a
`response.completed`/`response.incomplete`/`response.failed` terminal with no `data: [DONE]`
sentinel, and live probes (2026-08-07) confirm the stream closes on the terminal. The relay's
terminal-output boundary (`src/server/relay.ts`) cuts the stream at that event and synthesizes
`[DONE]` itself, so DeepSeek streams live again; the registry knob remains as a one-line
rollback for upstreams that regress, kept suite-reachable by a synthetic-registry fixture in
`tests/deepseek-inbound-wire.test.ts`.
Synthesized output is capped at 10,000 items across HTTP and WebSocket reframing. HTTP frames are
encoded incrementally, so bounded upstream JSON cannot expand into an unbounded event array or SSE string.

DeepSeek V4 Flash keeps native Responses streaming for progressive reasoning, text, and tool-call
delivery. Its registry entry enables a model-scoped terminal repair before the existing
inspection/client split. A real `response.completed`, `response.failed`, or `response.incomplete`
event always passes through unchanged. If every opened output item has a structurally complete
`output_item.done` and no real terminal arrives for five seconds, the repair emits exactly one
`response.completed` snapshot and closes the upstream reader. EOF or `[DONE]` uses the same strict
completion check; open, malformed, duplicate, contradictory, or unknown output graphs fail closed
as `response.incomplete`, never synthetic success. The repair shares the per-turn translator byte
budget, preserves backpressure, and composes ahead of item-id/snapshot rewrites so HTTP/SSE and
WebSocket clients observe the same canonical lifecycle.

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.

## Heartbeat and stall deadline

The HTTP/SSE bridge emits an SSE comment-line keep-alive (`: opencodex heartbeat`) during upstream
silence to re-arm Codex's idle timer (Codex's default `stream_idle_timeout` is 300 s and ANY SSE
bytes re-arm it). A comment line is discarded by every eventsource parser without producing an event,
so strict Responses decoders never see an unknown variant. Those bridge-enqueued keepalive frames do
NOT count as activity for the bridge's own watchdog: a bounded stall deadline (default 300 s,
configurable via `stallTimeoutSec`, checked on the 2 s heartbeat tick) closes the stream with
`response.incomplete` / `upstream_stall_timeout` and cancels the upstream request if no real
adapter events arrive. Adapter-yielded `{ type: "heartbeat" }` events DO reset the watchdog.

Top-level `emptyCompletionRetry: true` opts Responses turns into one identical replay when a
successful upstream completion contains neither output text nor a tool call. The default is off
because the replay may be billable; `OCX_EMPTY_COMPLETION_RETRY=0` is a disable-only emergency
override. Streaming and buffered HTTP adapters plus `runTurn` transports share the same guard,
while combo attempts and routed compaction stay excluded. Pre-content reasoning is retained under
named event-count and byte caps and emits liveness heartbeats while held. A second empty result or
retry failure becomes typed 502 `empty_completion_retry_failed`; usage is merged across sends, and
the Logs attempt records recovery kind `empty-completion`.

The web-search loop requests `stream: true` for every routed-model iteration, but buffers the events
needed to decide whether to intercept a synthetic search call. Text explicitly phased as
`commentary` is safe to forward live because it cannot terminate the turn; this keeps Kiro's
progress visible. A Kiro stream EOF after user-facing text or reasoning gets one bounded completion
retry, because neither the upstream text event nor `END_TURN` / `STOP_SEQUENCE` reliably distinguishes
progress from a final answer. Those two clean-stop reasons prove only that the inference ended; on a
tool-enabled turn, only the private completion tool authorizes `final_answer`. Any other explicit
reason already terminated the inference upstream and is reported as a terminal state rather
than converted into another model request: output-token limits become continuable incomplete output,
context-window exhaustion becomes a non-retryable `context_length_exceeded` error, filtering becomes
filtered incomplete output, and a `TOOL_USE` without an actual tool call is a contradiction. Since
the stop reason arrives only at the end of the stream, `required`-mode assistant text is held inside
the adapter until a real tool call starts or the stream ends, then released as `commentary` unless a
private completion call supplied the final answer. Each held event yields a `heartbeat` in its place
so the stall watchdog stays armed. Synthetic search calls, real tool calls,
and terminal events remain buffered until the iteration validates. Only the first iteration's final
response headers/status and any 429 key rotations are handled eagerly. A failure before downstream
SSE starts returns non-2xx JSON; once headers have started the final response, a generation failure
is emitted as `response.failed` SSE.

Kiro transient HTTP 429 recovery is coordinated process-wide after the first throttle: healthy
traffic remains parallel, but throttled followers wait behind one abort-aware probe and share a
deadline that is re-checked after every sleep. Event-stream `ThrottlingException` records the same
deadline for the next client replay. Retries are bounded to three attempts; hard quota responses and
ordinary 5xx errors are not replayed. Completion fallback rebuilds only replayable text, preserves
the original user/tool-result turn for reasoning-only attempts, supplies neutral non-empty carriers
for empty tool output, and validates role alternation plus tool-use/result pairing before transport.

Provider-level `retryOn429` (devlog 260802_429_same_target_retry) is the generic, opt-in
same-target 429 retry for API-key providers (`authMode: "key"`), primarily single-key pools
that cannot use multi-key failover. In the pre-stream recovery loop, a 429 waits (`Retry-After`
or the fixed interval, capped at `maxIntervalMs`) and replays the identical request on the same
key before any failover, up to `attempts` extra times per request (the budget lives outside the
recovery loop, so a 413/401 replay cannot re-arm it). The same wait-and-replay applies to every
other key-auth surface that bypasses that loop: the Responses passthrough wire (e.g. the
built-in DeepSeek preset), the image/video bridge and web-search sidecar loops (before their
`on429` key rotation), and Anthropic terminal-guard continuations (before key/account
failover). The policy covers HTTP-capable adapters only: custom `runTurn` transports in the
image loop run through an event queue and never receive an HTTP status, so they are outside
the HTTP retry scope and cannot replay a 429. Codex never retries 429 client-side (openai/codex#30471), so this is the only
defense for those providers; the final 429 still carries `Retry-After` for clients that honor
it. Concurrent requests each honor their own policy — there is no process-wide shared cooldown
(unlike the Kiro pattern), so a rate-limit storm multiplies upstream volume by at most
`attempts + poolKeys` per request (same-key replays, then failover keys; the pool size is the
operator-configured `apiKeyPool` length, fixed for the duration of the request). Every surface
releases (and awaits the cancellation of) the unread 429 body before the backoff, records the
`rate-limit-429` recovery kind on replay sends, and the bridge loops clear the old
response-header deadline before the wait and start a fresh one afterward — client cancellation
is re-checked after the wait, so 499 always wins over a stale-deadline edge, and backoffs never
consume the connect budget or surface as a 504. The wait is abort-aware:
once the server observes the client disconnect (Bun propagates it asynchronously, observed
1–10 s), the sleep is interrupted, the unread 429 body is released, and the request is
cancelled with 499 before any replay; because the propagation is async, a replay may precede
the cancel if the interval elapses first (bounded by the same `attempts` budget).

Provider-level `requestPacing` is the proactive companion to `retryOn429`. It reserves outbound
request-start slots before transport work begins, so a known RPM ceiling does not have to fail once
before the proxy reacts. One provider-wide lane enforces the aggregate ceiling. Exact model lanes
may add a slower interval without lowering the provider-wide interval or blocking an otherwise
eligible sibling model. Queue wait is abort-aware and happens before the response-header timeout is
armed. The shared fetch boundary covers HTTP and Responses WebSocket sends; explicit adapter
`fetchResponse` and `runTurn` dispatches reserve the same lane at their call sites. Image-bridge
iterations reserve before arming their per-attempt response-header deadline.

[Decision Log]
- 목적과 의도: Prevent Kiro progress from becoming a false final answer, reject invalid empty completion retries, and stop concurrent transient 429s from consuming independent retry budgets.
- 기존 구현 및 제약 조건: Kiro text has no trustworthy phase; stop metadata arrives only at stream end; the private completion tool is adapter-owned; normal parallel tool traffic must remain parallel; client cancellation must interrupt all waits.
- 검토한 주요 대안: Trust native `END_TURN`; infer completion from wording; serialize every Kiro request; leave throttling entirely to the client; manufacture empty assistant turns to preserve alternation.
- 선택한 방식: Require the private completion tool on tool-enabled turns, rebuild only valid replayable wire turns, validate the final conversation, and activate a shared cooldown plus single probe only after a transient throttle.
- 다른 대안 대신 이 방식을 선택한 이유: Native stop metadata has mislabeled progress, wording is language-dependent, global serialization harms healthy concurrency, client-only retries amplify bursts, and empty structural turns are rejected upstream.
- 장점, 단점 및 영향: Completion phase is deterministic and throttled concurrency recovers without a request storm; some clean Kiro stops pay one bounded validation call and an exactly repeated completion answer may be shown twice to preserve `final_answer` semantics.

Historical `web_search_call` output items from previous Responses turns are not converted into
assistant text. They are UI/search-cell evidence, not a replayable search result payload; turning
them into strings risks routed models echoing an internal marker or implying a current search ran
when the sidecar is unavailable. The active sidecar path is the only place that emits new
`web_search_call_begin` / `web_search_call_end` events.

Four independent clocks bound this path. `stallTimeoutSec` is the base bridge event-stall budget.
`connectTimeoutMs` (default 200 s) covers only DNS/TCP/TLS and the wait for final response headers,
not response-body generation. Config-file-only
`webSearchSidecar.routedModelStallTimeoutMs` (default 200 s, integer 1..2147483647) bounds continuous
raw response-byte inactivity for a routed-model iteration and resets on every non-empty byte.
`webSearchSidecar.timeoutMs` (default 60 s) separately bounds one hosted search request (lowered
from 200 s so an unavailable/limit-exhausted search backend degrades within ~1 min instead of
hanging the whole turn, #398). The
effective web-search bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 s` (230 s at defaults,
dominated by the routed-model stall clock),
with seam heartbeats between bounded units. None of these clocks is a total generation deadline.

## Reasoning and tool-result compatibility

Native OpenAI passthrough sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.
It also repairs the opposite direction (260718): an assistant `tool_calls` round left dangling —
by an intervening user/developer barrier or an interrupted turn — is closed by deferring barrier
messages until the round completes, reattaching real results to their original call occurrence,
and synthesizing explicit "no tool result was recorded" answers only when no real result exists
(Kimi/Moonshot 400 `ocx-mrqaiw05-269`; unit `devlog/_fin/260718_dangling_toolcall_hardening`).

Forward-mode OpenAI passthrough also repairs replayed `call_id` values longer than the Responses
API's 64-character limit. Sidechat/fork replay can namespace routed-provider ids beyond that limit,
so each oversized id and all matching call/output items receive the same deterministic,
request-local alias. Raw API-key continuations deliberately preserve ids because an output-only
continuation may reference a call stored upstream under its original id; proxy-expanded API-key
replays are explicit and receive the same repair.

These compatibility guards are covered by focused tests and should stay close to the adapters that
need them.

Responses passthrough always removes output-only `status` from `reasoning` input items, including
items that retain opaque `encrypted_content`. The prior retains-blob-keeps-status invariant was
defensive rather than observed: measured OpenAI reasoning items never contain `status`, and Grok
accepts its own blob with `status` removed. Keeping it on a cold cross-backend replay instead made
OpenAI reject the unknown field before validating the blob, starving opaque-blob recovery of the
provenance error it needs. The established raw-`content` rule remains separate: ChatGPT accepts
reasoning input only with empty `content`, so a native blob plus raw content keeps the blob but still
blanks `content`. The blob is kept unless the in-process thread record proves that the current
provider, destination, adapter, model, or credential differs from the route recorded for the prior
request on that client thread. On a proven change the blob is removed while the reasoning item and
its summary survive; `status` has already been removed on every path. Missing, expired, or evicted
identity state is unknown. The comparison uses the durable destination and credential identities
with the provider, adapter, and model, so OAuth token-generation refreshes do not look like backend
changes; when either durable dimension is unavailable it refuses to record rather than falling back
to a volatile identity. Route binding only compares: it does not replace the recorded identity until
the destination successfully serves the turn. Bridged streams commit on a completed or incomplete
terminal; native passthrough streams use the non-error upstream status before relay as their success
boundary so the proxy does not retain request state across the whole stream. This deterministic
pre-flight is the primary path and covers threads the process has served while their record remains
inside the TTL/LRU bounds. Missing, expired, evicted, and
pre-process history stays fail-soft on the first send. If a Responses upstream then returns its own
self-identifying opaque-blob 4xx (`invalid_encrypted_content`, or xAI's two `invalid-argument`
decoder errors), the proxy rebuilds once through the same sanitation path: reasoning
`encrypted_content` is removed and compaction blobs use the existing text degradation. A one-shot
guard makes a second rejection terminal, and a successful recovery records the current serving
identity so later route changes return to deterministic pre-flight. A cold-record cross-backend
switch therefore costs one extra upstream round trip and one turn of degraded reasoning, rather than
wedging the thread; unrelated 4xx responses and requests whose outbound body carries no blob never
enter this recovery.

A combo target rotation between turns legitimately changes that serving identity, so the following
turn drops blobs minted by the prior target. This is correct because the new target cannot decode
them, but it is intentionally unobvious to the client: `pickComboTarget` keys selection state only by
combo id, without a conversation dimension, and the SSE model-name rewrite preserves the requested
combo name instead of exposing the concrete target switch. A user can therefore observe a reasoning
cache drop with no visible model change.

The image and web-search auxiliary loops consume `_reasoningReplayScope` for bridge-level replay but
never call `bindRouteReasoningReplayScope`, so their internal small-model requests do not update the
serving-identity record. That omission is intentional: binding those routes would poison the main
conversation's last-serving identity and cause a later main-model turn to strip valid blobs.

[Decision Log]
- 목적과 의도: Keep same-backend opaque reasoning replay while preventing backend-private blobs and output-only fields from breaking the first turn after a route change.
- 기존 구현 및 제약 조건: Reasoning-input sanitation already handled raw content and `ocxr1:` envelopes; the replay cache already supplied a bounded, thread-scoped physical-route identity, but no record connected that identity to native `encrypted_content` provenance.
- 검토한 주요 대안: Strip every opaque blob, persist provenance across restarts, trust generic 4xx prose, rely only on a retry, or combine deterministic route comparison with a narrowly identified recovery.
- 선택한 방식: Remove output-only `status` from every reasoning input item without changing the pre-existing raw-`content` blanking rule; compare a 64-entry/256 KiB/one-hour in-process serving-identity record using durable destination and credential dimensions before sending, commit it only after the selected destination succeeds, pass a proven change into the Responses adapter before the first send, and use one self-identified opaque-blob recovery only when provenance was unknown.
- 다른 대안 대신 이 방식을 선택한 이유: The former blob/status coupling was defensive rather than observed, and live backends showed that removing `status` preserves same-backend Grok replay while allowing cold cross-backend requests to reach blob validation. Unknown provenance can still be valid after restart, durable storage is unnecessary for this bounded compatibility hint, and deterministic pre-flight avoids the extra paid or stateful upstream attempt whenever the process has evidence. The upstream's narrow error identity supplies authoritative evidence only for histories the process could not observe.
- 장점, 단점 및 영향: Same-route and unknown replay retain cached reasoning on the first send without replaying an output-only field, known cross-route replay keeps the reasoning item without its undecodable blob, and a cold cross-route replay can reach opaque-blob recovery instead of failing early on `status`. A repeated blob rejection is surfaced unchanged after exactly one recovery attempt.

DeepSeek's stateless Responses compatibility pass normalizes only unambiguous tool-call batches.
Calls emitted before the first matched output stay together as one assistant batch, followed by
their outputs in call order; hook-injected messages that split the batch move after it without being
dropped. This preserves #1292's single-call adjacency repair without splitting a same-turn parallel
batch away from its preceding plaintext reasoning (#1477). Tolerant providers never enter this pass,
and duplicate, missing, or backwards call/result pairs are left for the upstream to reject rather than guessed.

[Decision Log]
- 목적과 의도: Preserve DeepSeek reasoning replay for parallel tool calls while retaining the provider-scoped repair for hook-interleaved results.
- 기존 구현 및 제약 조건: Pair-by-pair adjacency fixed one call but split parallel calls into separate assistant turns; DeepSeek always enables parallel tool calling and merges adjacent reasoning and calls into one assistant message.
- 검토한 주요 대안: Disable parallel calls, duplicate reasoning, remove the #1292 repair, or normalize one unambiguous call/output batch.
- 선택한 방식: Group calls that occur before the first matched output, emit the call batch followed by outputs in call order, and retain intervening non-tool items after the batch.
- 다른 대안 대신 이 방식을 선택한 이유: The batch shape matches the documented Responses contract without inventing reasoning or reintroducing hook-interleaving failures.
- 장점, 단점 및 영향: Sequential and parallel tool continuations both retain their reasoning contract; only the declared strict provider changes order, and ambiguous histories still fail closed upstream.

## Cursor parameterized models

Cursor Router's parameterized `default` model is represented in Codex by four catalog rows:
`cursor/auto` preserves Cursor's team/account default, while `cursor/auto-cost`,
`cursor/auto-balance`, and `cursor/auto-intelligence` make each optimization level explicit.
All four route to the `default` Cursor wire model. Explicit variants additionally populate
`AgentRunRequest.requested_model.parameters` with the `optimization` parameter; this is the same
parameterized-model channel used by current Cursor clients. Router rows are static capabilities and
must survive a live `GetUsableModels` response that omits `default`.

`cursor/grok-4.5-fast` and `cursor/grok-4.6-fast` are stable Codex-facing rows, but current Cursor
clients do not request them as flat model slugs. OpenCodex sends the matching Grok base id through
`requested_model` with separate `effort` and `fast=true` parameters, leaving legacy `model_details`
unset for that parameterized external selection. Grok 4.5 stops at `high`; Grok 4.6 additionally
advertises and sends `xhigh`. Live discovery recognizes Cursor's flattened
`cursor-grok-{version}-{effort}-fast` variants, plus the older
`grok-{version}-fast-{effort}` ordering, as availability evidence only.

## Cursor active-context usage

Cursor's `conversationCheckpointUpdate.tokenDetails.usedTokens` is treated as the authoritative
absolute active-context size for a Cursor conversation. Some client-tool suspension turns must end
before Cursor emits a new checkpoint; those turns carry forward the last observed total for the same
Cursor conversation instead of reporting only the tiny current-turn output delta. The carry-forward
cache is process-local, numeric-only, bounded, and keyed by Cursor conversation id. Compaction
boundaries clear the carry so pre-compaction totals are not reused after Codex replaces history.
Historical compaction markers restored by `previous_response_id` expansion are acknowledged as a
replayed prefix and do not clear a fresh post-compaction checkpoint again on every later turn.
Compaction summarizer turns may still report their own checkpoint for that response, but their
pre-compaction checkpoint is not persisted for later carry-forward.

```text
[Decision Log]
- 목적과 의도: Keep Codex's visible "context left" indicator aligned with Cursor's active-context usage on client-tool turns that finalize before a checkpoint arrives.
- 기존 구현 및 제약 조건: Checkpoint turns reported totalTokens correctly, but no-checkpoint client-tool finalize fell back to output-only usage and could overwrite a meaningful prior total with values like 109 tokens.
- 검토한 주요 대안: Add a longer wait for late checkpoints; infer prior+output totals; store full prompt/history state; carry forward only the last numeric checkpoint per Cursor conversation.
- 선택한 방식: Carry forward the last numeric absolute checkpoint per Cursor conversation with bounded LRU/TTL storage, update it only from live checkpoint frames, and clear/suppress it once when a newly appended compaction boundary starts an epoch; previous_response replay provenance acknowledges historical markers without serializing private metadata upstream.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the UI regression without delaying tool turns, fabricating token growth, storing prompt/tool content, or repeatedly clearing valid post-compaction usage when historical markers replay; one-time compaction resets still prevent stale over-report when history is replaced.
- 장점, 단점 및 영향: Active-context reporting stays monotonic within an uncompacted Cursor conversation; no-checkpoint turns remain estimated; a process restart loses the numeric cache, and when neither a checkpoint nor a carry-forward is available the turn reports a request-local estimate derived from the same pruned payload sent to Cursor (#373 — reporting output-only usage made Codex read the context as nearly empty). Estimates are never persisted or promoted into checkpoint carry-forward; only live checkpoint frames update the cache.
```

## Cursor conversation checkpoint reuse

After a successful no-tool turn, the Cursor adapter keeps the returned ConversationStateStructure in
a process-local store and reuses that snapshot on the next validated linear continuation instead of
rebuilding rootPromptMessagesJson and conversationTurns. Tool-result turns reuse the last completed
checkpoint plus only the uncovered suffix. Chat Completions hops that omit previous_response_id and thread headers reuse a snapshot only when
the covered message prefix and system/developer digest match exactly one stored snapshot. Isolated
helper/shadow turns never join the parent conversation. An explicit missing checkpointRef full-replays. Compaction, account or model mismatch, missing refs, decode failures, and
invalid_argument recovery keep the existing full-replay path. previous_response_id may select a
branch's opaque checkpointRef; it is never a Cursor conversation ownership key. Cursor Connect still
does not expose authoritative cache_read_tokens.

```text
[Decision Log]
- 목적과 의도: Reuse Cursor's returned ConversationStateStructure on validated linear continuations so OpenCodex does not rebuild the full root history every turn.
- 기존 구현 및 제약 조건: Stable conversation ids already exist (#366), but every turn still reconstructed rootPromptMessagesJson and conversationTurns. Cursor Connect still reports only usedTokens/maxTokens, so cache_read_tokens cannot be treated as authoritative (#275).
- 검토한 주요 대안: Keep full replay; copy Pi's live MCP bridge immediately; store raw protobuf in Responses JSON; key checkpoints only by conversation id.
- 선택한 방식: Keep an opaque process-local checkpointRef on OcxProviderContinuationState.cursor, bind the snapshot to conversation/account/model affinity, pin referenced blobs for the checkpoint lifetime, and fall back to the existing full-replay path for isolation, compaction, restart, missing refs, and invalid_argument recovery. Tool-result turns reuse the last completed checkpoint plus an uncovered suffix. previous_response_id is a branch anchor, never a Cursor conversation ownership key.
- 다른 대안 대신 이 방식을 선택한 이유: It removes avoidable replay cost without claiming cache-hit rates, without changing OAuth, and without collapsing helper/compaction isolation or tool-call replay safety.
- 장점, 단점 및 영향: Validated no-tool follow-ups stop growing local rootBytes with history; a process restart or missing blob lease falls back to full replay; large-context 429 / premature-completion acceptance for #1527 is still unproven; a stateful live MCP bridge remains out of scope.
```

## Google thought-text visibility boundary

Google-family responses may represent model-internal reasoning as a text-bearing part with
`thought: true`. The Google adapter maps that text to the internal `reasoning_raw_delta` event;
only text without the marker becomes visible `text_delta`. Streaming SSE and buffered JSON share
one classifier so transport selection cannot change whether provider-declared reasoning is shown
as assistant output. Thought-signature observation still runs on the original parts before text
classification, preserving the opaque continuation state independently of display semantics.

[Decision Log]
- 목적과 의도: Prevent provider-marked internal reasoning from appearing as ordinary assistant text while preserving reasoning and tool-call continuation.
- 기존 구현 및 제약 조건: Both Google response paths emitted every non-empty `Part.text` as visible text; function calls, inline images, and Antigravity/Vertex thought-signature replay already depended on the original part ordering.
- 검토한 주요 대안: Drop thought text; classify it separately in each parser; remove the marker and keep visible text; use one shared classifier without mutating the provider parts.
- 선택한 방식: Map `thought: true` text to `reasoning_raw_delta` through one helper used by streaming and buffered parsing, leaving part order and signature observation unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: Dropping the text loses reasoning replay/display policy input, while duplicated parser rules can drift and exposing marked thoughts violates the provider's visibility boundary.
- 장점, 단점 및 영향: Internal reasoning no longer leaks into normal answers and both transports stay consistent; downstream reasoning policy still decides whether raw reasoning is rendered or only preserved, and malformed non-boolean markers remain ordinary text rather than broadening hidden-content inference.

## Google response-part field boundary

Google-family adapters validate the values inside an otherwise well-formed response part before
they become `AdapterEvent`s. A present `functionCall` must be an object with a nonblank string
`name`; because Gemini delivers that call atomically rather than across deltas, an invalid name is a
terminal protocol error and is never dispatched. A non-string optional `text` value is dropped
without coercion, while the rest of the part and turn continue. Structured `functionCall.args`
remain provider-native and are serialized as before.

[Decision Log]
- 목적과 의도: Keep malformed Google-compatible response fields from violating the internal string-only text and tool-name contract or dispatching an unidentified tool.
- 기존 구현 및 제약 조건: Container validation guaranteed object parts, but truthy string/number/array functionCall values emitted a nameless tool call and truthy non-string text values crossed as text or reasoning events. Gemini supplies a complete call in one part, so there is no later name fragment to await.
- 검토한 주요 대안: Pass malformed values through; coerce them to strings; silently drop every malformed field; terminate the turn for every malformed field; distinguish dispatch identity from optional text.
- 선택한 방식: Prevalidate function calls and terminate on a non-object, non-string, empty, or whitespace name; drop only non-string text; leave arguments untouched.
- 다른 대안 대신 이 방식을 선택한 이유: Passing or coercing can execute the wrong tool or fabricate transcript text, while terminating for optional malformed text discards an otherwise usable response. An invalid call name cannot be recovered or safely ignored once the model selected a tool.
- 장점, 단점 및 영향: Streaming and buffered paths enforce the same AdapterEvent contract and invalid calls cannot enter thought-signature replay. Nonconforming third-party Google-compatible text fields are ignored rather than surfaced, and operators receive a structured terminal error for call identity failures.

## Google tool-call thought-signature replay

Gemini may attach an opaque `thoughtSignature` to a `functionCall` and requires that exact value on
the matching model turn when its tool result is submitted. Antigravity and Vertex share the existing
bounded TTL/LRU replay store, keyed by compiled function-call name plus canonical arguments. Vertex
prefixes its cache model key with the transport, project, and location identity, so a signature
minted by Vertex cannot be sent to Antigravity even when both routes expose the same public model id.
Vertex prefers Codex's opaque `prompt_cache_key` for session identity and falls back to the existing
first-user-message derivation for clients that omit it; only the fixed hash is retained.
Both streaming and non-streaming responses feed the store; request compilation happens before replay
so matching uses the provider-visible tool name.

[Decision Log]
- 목적과 의도: Preserve Vertex Gemini tool-call continuation without exposing opaque signatures to Codex or another Google backend.
- 기존 구현 및 제약 조건: Responses history does not carry a safe Gemini signature field; Antigravity already used a bounded in-process replay cache, while Vertex bypassed it and received HTTP 400 after the first tool call.
- 검토한 주요 대안: Serialize the signature into Responses item ids or reasoning content; create an unbounded Vertex map; reuse the bounded cache with or without a transport namespace.
- 선택한 방식: Reuse the bounded cache for Vertex, observe both response shapes, apply after wire-name compilation, and scope Vertex by transport/project/location plus the opaque client session key when available.
- 다른 대안 대신 이 방식을 선택한 이유: Responses ids are not Gemini signatures and previously caused Base64/TYPE_BYTES failures; a second cache duplicates limits; an unscoped cache could send provider-private state across destinations.
- 장점, 단점 및 영향: Tool loops continue with exact opaque state and bounded memory while cross-transport reuse fails closed. Replay remains process-local, matching the existing Antigravity contract.

## Google tool-result adjacency repair

Google-family requests serialize a model tool-call turn and its results as one adjacent
`model -> user` pair. The user turn contains exactly one `functionResponse` for every representable
call in original call order. Missing results use an explicit unknown-history marker; duplicate,
mismatched, and standalone results become marked text instead of unpaired function responses.
Representable data-URL images remain sibling `inline_data` parts in either case.

[Decision Log]
- 목적과 의도: prevent interrupted or replayed Claude-on-Antigravity histories from reaching the
  Google wire with unanswered `functionCall` or unpaired `functionResponse` parts.
- 기존 구현 및 제약 조건: `messagesToGeminiFormat` emitted every internal message independently;
  Antigravity translates the resulting Gemini shape back into strict Anthropic tool-use blocks, and
  rejects malformed adjacency with HTTP 400. Tool-result images cannot live inside a
  `functionResponse` and already rely on sibling `inline_data` parts.
- 검토한 주요 대안: repair the shared internal history; synthesize fake calls for orphan results;
  repair only the Google adapter serialization boundary.
- 선택한 방식: group only consecutive results after a model call batch, match by the normalized
  request-scoped call id, emit responses in call order, synthesize an explicit missing result, and
  degrade remaining results to marked text while retaining image siblings.
- 다른 대안 대신 이 방식을 선택한 이유: shared-history mutation could change other adapters,
  while fabricating a successful call would invent model behavior. The adapter boundary owns the
  strict upstream wire contract and can repair it without changing client-visible history.
- 장점, 단점 및 영향: normal histories remain byte-shape equivalent, parallel and interrupted
  histories become provider-valid, and orphan data is not lost. A result separated by a non-tool
  barrier is intentionally not reattached across that boundary.

## OpenRouter provider routing

The canonical OpenRouter `openai-chat` transport may carry optional provider-routing preferences
from `OcxProviderConfig.openRouterRouting`, with exact model-id replacements in
`modelOpenRouterRouting`. The adapter maps camel-case config to OpenRouter's request wire
(`order`, `only`, `allow_fallbacks`) after the Codex-facing routed slug has been decoded to the
native model id.

Preferences are accepted only for `https://openrouter.ai/api/v1` (an optional trailing slash is
equivalent) and the `openai-chat` adapter. Alternate ports, credentials, query strings, fragments,
lookalike hosts, and custom proxy paths fail validation. A model override replaces rather than
merges the provider-wide default, keeping precedence deterministic. With no preference configured,
the request body is byte-for-byte unchanged in this area and OpenRouter retains its default routing.

## Kimi Coding Plan prompt-cache affinity

The canonical `kimi` OAuth and `kimi-code` API-key presets opt into forwarding the internal
request's `prompt_cache_key` to Kimi's Chat Completions body. Kimi Code Plan documents a stable
session/task key as required to improve cache hit rates. The chat adapter never invents a key of
its own: it forwards what the request already carries — Codex's session key on
`/v1/responses`, or the session-scoped key the Claude `/v1/messages` inbound derives
(metadata.user_id hash, else the system+tools cohort hash) — and a request with no key stays
keyless. An explicit provider-level `promptCacheKey: false` continues to opt out, and the flag is
persisted through `providerConfigSeed`/`enrichProviderFromRegistry` for new configs; key-pool 429
rotation keeps it — along with every other registry backfill — because the retry inherits the
request's routed provider and swaps only the API key (`rotateProviderTransportOn429` in
src/providers/key-failover.ts). If an opted-in upstream rejects the field, OpenCodex does not strip it and retry or mutate the
saved configuration. Other OpenAI-compatible providers remain deny-by-default because strict
backends may reject the OpenAI-specific field.

## xAI Grok hardening (official Grok Build contract parity)

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_fin/260716_grok_build_hardening/`.

- **Reasoning folding:** the Responses parser folds `reasoning` items into the FOLLOWING
  assistant turn (`pendingReasoning` in `src/responses/parser.ts`) so the Grok chat wire carries
  ONE assistant message with `reasoning_content` — exact-prefix cache stability. Unsigned
  siblings newline-join; `ocxr1`-signed siblings stay separate parts (Anthropic replay keeps
  each signature on its own text); boundaries (user/tool-result/agent) clear pending state;
  call items fold pending reasoning into the same turn.
- **Grok CLI credential ownership:** `source:"local-cli"` xAI credentials re-read
  `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
  zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
  detaches the credential to `source:"oauth"`.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` → superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
- **Reactive 401 replay:** both the adapter recovery loop and native Responses passthrough branch
  force-refresh once (singleflight, generation-checked) and replay OAuth-backed xAI requests
  exactly once with a re-resolved transport; API-key/BYOK paths are excluded
  (`src/server/responses/core.ts`).
- **Header parity:** per-attempt `x-grok-req-id` (fresh UUID inside the transport fetch
  wrapper), stable session/conv affinity headers, always-set User-Agent, and a single
  compatibility profile const for the Grok client version (`src/providers/xai-transport.ts`);
  `fetchWithHeaderTimeout` takes an executor so provider fetch wrappers stay inside the
  timeout race.

## Kiro reasoning round-trip (`redactedContent`)

Kiro never returns plaintext reasoning for its **GPT-5.6 family** (`gpt-5.6-sol`, `-terra`,
`-luna`): `reasoningContentEvent` carries a KMS-encrypted `redactedContent` blob, never `text`.
Their `additionalModelRequestFieldsSchema` (`ListAvailableModels`) accepts only `reasoning.effort`
with `additionalProperties: false` — there is no display/summary opt-in, so this is the only
reasoning these models can return. Kiro's own CLI replays the blob on the matching
`assistantResponseMessage.reasoningContent` to preserve model reasoning across turns; dropping it
makes every turn restart without the previous turn's reasoning. Verified on kiro-cli 2.14.1 and
2.16.0, all three models.

The Claude 4.6+/5 entries advertise a different, richer contract (`thinking.type` adaptive/disabled,
`thinking.display` summarized/omitted, `output_config.effort`, `max_tokens`) and are not covered by
that measurement; older Claude, deepseek, minimax, glm, and qwen entries advertise no additional
fields at all. The handling below keys off the wire field, not the model id, so any model that
sends `redactedContent` round-trips.

- The blob rides the existing `ocxr1:` envelope as `krc` (`src/responses/reasoning-envelope.ts`) on
  an envelope-only reasoning item — `summary: []`, no text deltas — so it stays invisible in the
  Codex app while round-tripping, exactly like the hidden-thinking path.
- **Pairing is backwards.** Kiro emits `reasoningContentEvent` at the END of an assistant turn,
  after content AND tool calls. A `krc`-only item therefore belongs to the turn that already
  closed, so the parser attaches it to the PRECEDING assistant message rather than folding it into
  the following turn like ordinary reasoning (`src/responses/parser.ts`). With no assistant turn to
  own it, the blob is dropped rather than mis-paired.
- The blob lives on `OcxAssistantMessage.kiroRedactedReasoning`, not on a thinking content part, so
  no other adapter replays provider-private state if the conversation switches providers.

Kiro reports context pressure in its own `contextUsageEvent`, which is the authoritative source. On
every capture taken (2.14.1 and 2.16.0) `metadataEvent` carried only `stopReason` — which is why
reading the percentage from `metadataEvent` alone never saw a value — but the parser still accepts a
finite `contextUsagePercentage` (and a `tokenUsage` block) there as a fallback, so a value parsed
from `metadataEvent` is legitimate rather than impossible. Both feed the same field, and any
positive value overwrites an earlier one.

Spend arrives in `meteringEvent` as **credits, not tokens**. No captured response carried
`tokenUsage` on any event, which is why Kiro usage stays estimated; `meteringEvent` is currently
ignored because a credit is not a token count.

## Chat Completions inbound native path

`POST /v1/chat/completions` sends eligible `openai-chat` routes directly to the provider's Chat
Completions endpoint. Route selection reads the raw Chat body and the native request keeps that body
as its wire source; a Responses projection is constructed only after the native route is declined
and is never converted back into Chat. Request construction remains owned by `src/adapters/openai-chat.ts`, including model
normalization, credential and provider headers, capability-specific fields, and the canonical
`openaiChatCompletionsUrl()` path. The passthrough builder uses an explicit Chat-field whitelist so
messages (including `name` and separate `system`/`developer` entries), Chat token controls,
sampling/logprob fields, caller identity/metadata, and caller stream options retain their wire
shape. For streams, caller `stream_options` are merged with mandatory `include_usage: true`. On
the native passthrough there is no canonical Fast injection and no wire mapping: every caller
`service_tier` — canonical or foreign — is forwarded raw and only under `chatServiceTier: true`,
and `fastMode` injects nothing here. Resolved-Fast-policy injection applies only to routes that
take the Chat -> Responses -> Chat bridge below. `parallel_tool_calls` is emitted only for providers opted into
parallel tools (or pinned false by the existing provider opt-out contract).
Combo/policy routes and requests that need Responses-only hosted tools, continuation, background,
or storage semantics retain the existing Chat -> Responses -> Chat bridge.

The direct SSE relay accepts CRLF and arbitrary transport chunk boundaries while retaining at most
one bounded event. EOF with an unterminated event and an event above the translator limit are typed
upstream failures, never successful partial completions. Provider-controlled structured error
messages are redacted before either JSON or SSE reaches the client. The native path uses the same
request-attempt logging, reset retry, same-key 429 replay, key rotation, usage extraction, and
request-signal cancellation contracts as routed Responses transport.

## Parallel tool calls (default-on for chat providers)

The openai-chat adapter buffers ALL streamed `tool_calls` deltas (keyed by `index`, falling back to
`id`, then last-seen) and flushes them as atomic start/delta/end sequences at the terminal signal.
This is required by the bridge's sequential tool-call contract and makes interleaved parallel
deltas, id-only-first-chunk continuations, and whole-chunk multi-call frames all safe.

Parallel tool calls are DEFAULT-ON for openai-chat providers: the adapter follows Codex's
request-level `parallel_tool_calls` bit (default true) and routed catalog entries advertise
`supports_parallel_tool_calls`. `OcxProviderConfig.parallelToolCalls: false` is the per-provider
opt-out (registry-seeded, router-backfilled; an explicit user value always wins). Non-chat
adapters advertise the catalog bit only on explicit `true`; cursor keeps its own special-casing.
Providers with flaky parallel streaming can be opted out individually. Evidence and provider
ledger: `devlog/_fin/260709_parallel_tool_calls/`.

## Volcengine Ark assistant continuation shapes

The `openai-chat` adapter keeps Volcengine's pay-as-you-go Chat endpoint and Coding Plan endpoint
on separate empty-assistant contracts. The pay-as-you-go `/api/v3` route retains the structured
`[{ "type": "text", "text": "" }]` placeholder inferred for #796, while `/api/coding/v3` uses the
ordinary empty string accepted by its live tool-call continuation contract (#1571). Matching only
the shared Ark hostname is too broad because the two endpoint families reject opposite shapes.

[Decision Log]
- 목적과 의도: Preserve multi-turn tool-call continuations across both Ark Chat endpoint families.
- 기존 구현 및 제약 조건: The #796 workaround was host-wide and unverified; live Coding Plan evidence shows its structured placeholder returns HTTP 400 while an empty string succeeds.
- 검토한 주요 대안: Remove the workaround globally, select by model ID, or scope it by endpoint path.
- 선택한 방식: Apply the structured placeholder only to recognized Ark hosts whose normalized base path is exactly `/api/v3`.
- 다른 대안 대신 이 방식을 선택한 이유: Global removal would reopen #796, while model IDs can appear behind multiple Ark products and therefore do not identify the wire contract.
- 장점, 단점 및 영향: Coding Plan regains its accepted continuation shape without changing generic providers; any future Ark endpoint family must provide evidence before inheriting the pay-as-you-go quirk.

## Chat structured-output compatibility

The `openai-chat` adapter translates Responses `text.format` and Chat Completions
`response_format` through one internal format, then emits `response_format` on the upstream chat
wire. That remains the default because silently returning prose breaks clients that requested a
JSON object or schema. A mixed-capability gateway may list exact native model ids in
`noStructuredOutputModels`; only those models omit the wire field, while siblings keep the normal
translation. The proxy does not infer this from provider names, localhost destinations, or a model
family shared by unrelated upstreams.

[Decision Log]
- 목적과 의도: Recover chat models that reject `response_format` without removing structured output from models that support it.
- 기존 구현 및 제약 조건: The adapter forwarded the field to every routed chat model after #1137, while the same model id may sit behind gateways with different capabilities.
- 검토한 주요 대안: Revert translation globally; blacklist a model id globally; detect a proxy by name or URL; add an explicit provider/model opt-out.
- 선택한 방식: Preserve default translation and omit it only for exact ids in `noStructuredOutputModels`.
- 다른 대안 대신 이 방식을 선택한 이유: Global or heuristic rules regress supported providers and make custom gateway names part of the wire contract.
- 장점, 단점 및 영향: Compatible siblings retain schema enforcement and explicitly incompatible models avoid the upstream 400; operators must classify each unsupported model they route.

## MiniMax Anthropic-compatible clients

The MiniMax platform CLI's text resource posts Anthropic Messages to
`/anthropic/v1/messages`. `ocx mmx` adapts that hard-coded client path with a temporary
loopback bridge instead of adding another server route. The bridge accepts only POSTs to the
messages and count-tokens paths, rewrites them to the existing `/v1/messages` data plane,
preserves the query and streaming body, strips all incoming credential headers, and pins the
public loopback placeholder. It stops as soon as the MMX child exits, so the server's
`AUTH_MATRIX` and authentication surface remain unchanged.

`ocx mmx` exposes only the text resource because the other MMX resources use MiniMax-specific
image, video, speech, music, vision, search, quota and file endpoints. The launcher isolates
`~/.mmx` credentials behind a temporary config, removes ambient proxy variables so loopback
traffic cannot be sent off-machine, owns the temporary bridge lifecycle, and refuses
destination, region and credential overrides. It is
loopback-only because MMX cannot carry the dedicated remote-admission header. MiniMax Code uses
the separate reversible `custom_provider.opencodex` file integration and is likewise
loopback-only; its generated block never changes `defaultModel`. Each generated MCode model
copies an authoritative catalog context window into `limit.context` and a nonempty canonical
reasoning ladder into `thinking.effortOptions`. Missing capabilities stay absent instead of
falling back to OpenCodex guesses, and the integration does not write the removed
`thinking.effort` / `defaultEffort` fields because MCode owns the active effort per session.

## Anthropic structured-output compatibility

The Anthropic adapter lowers Responses `text.format` and Chat Completions `response_format` JSON
Schema requests to `output_config.format`. The local transform follows Anthropic's TypeScript SDK
subset so upstream rejects neither OpenAI-only envelope fields nor unsupported schema constraints.
The adapter merges `format` into an existing adaptive-thinking `output_config` rather than replacing
it, so a compatible `output_config.effort` remains alongside the structured-output format.
Routed Anthropic Messages input carries `output_config.format` through internal `text.format`, so
stored-OAuth requests regain the same native format when the Anthropic adapter rebuilds the wire body.
Unsupported constraints remain in `description` as model guidance instead of disappearing. Root
`$defs` stay beside a root `$ref`, intentionally differing from the current SDK transform's early
`$ref` return so local references remain resolvable.

[Decision Log]
- 목적과 의도: Preserve schema-constrained output when OpenAI-shaped Responses or Chat Completions requests route to Anthropic Messages.
- 기존 구현 및 제약 조건: The parser retained the requested schema, but the Anthropic adapter dropped it; forwarding the OpenAI schema unchanged fails when it includes constraints outside Anthropic's supported subset.
- 검토한 주요 대안: Keep tool-call emulation; forward the raw schema; depend on the full Anthropic SDK; maintain a local compatibility transform based on the SDK.
- 선택한 방식: Merge Anthropic `output_config.format` into compatible adaptive-thinking configuration, mirror the SDK transform locally with strict `unknown` narrowing, move unsupported constraints into descriptions, and preserve root `$defs` before returning a root `$ref`.
- 다른 대안 대신 이 방식을 선택한 이유: Native structured output avoids synthetic tools, raw forwarding produces upstream 400s, and importing the full SDK only for a small wire transform would duplicate the adapter's direct HTTP ownership.
- 장점, 단점 및 영향: Both OpenAI-shaped input surfaces gain native Anthropic schema enforcement and unsupported intent remains visible to the model; the copied subset must track upstream SDK changes, description-carried constraints are guidance rather than hard validation, and the root-reference fix is an intentional divergence to keep definitions reachable.

## Reasoning display parity (hideThinkingSummary)

`hideThinkingSummary` (request reasoning summary absent/"none" — the routed catalog default) is
honored by BOTH reasoning paths: anthropic `thinking_delta` AND raw `reasoning_raw_delta`
(openai-chat `reasoning_content`, kiro tags). Hidden reasoning emits an envelope-only reasoning
item (`summary: []`, txt-only `ocxr1:` `encrypted_content`, no text deltas) — invisible in the
Codex app, so tool cells group like native models — while the text still round-trips for
`preserveReasoningContentModels` replay. Visible mode (summary "auto") keeps the raw
`content[reasoning_text]` shape. Diagnosis and codex-rs grouping evidence:
`devlog/_fin/260709_native_response_pattern/`.

The content-to-summary channel rewrite skips any reasoning item that carries a native
`encrypted_content` blob. The blob is opaque, state-bearing provider data, so the item must
round-trip unchanged unless that backend has an explicit replay contract permitting a rewrite.
This defensively protects providers that issue blobs and later join the route through
`preserveReasoningContentModels`. The rewrite's round trip was verified against DeepSeek, which is
`statelessResponses` and issues no blob. Grok is unaffected in practice because it natively emits
summary-channel reasoning and no `reasoning_text` events, so this content-to-summary item rewrite
does not engage on its route. Only the stored item is exempt — `reasoning_text` delta events carry
no blob and still route to the summary channel, so the live expandable trace is unchanged.

The process-local raw-reasoning fallback is fail-closed unless a request has an explicit client
thread plus an exact provider destination, wire adapter, final model, and physical credential
identity. API-key material is represented only by a process-keyed HMAC; OAuth replay is bound to the
existing credential slot and exact credential generation, and an authentication-header override is
folded into that identity without retaining the raw value. A token refresh intentionally starts a
new fail-closed replay namespace. The destination is likewise process-HMACed because a configured
base-URL path may itself be a credential. Header-only/keyless routes cannot establish a physical
credential identity and therefore fail closed. Parsed-request copies and already-created bridges
share one scope holder, and key/account rotation replaces its current identity before rebuilding
the request. A retry may therefore reuse reasoning on the same physical target, but a provider, model, or
credential failover receives the provider's configured placeholder instead of another target's raw
reasoning.

[Decision Log]
- 목적과 의도: Preserve tool-call continuation compatibility without forwarding one provider or physical account's private reasoning to another fallback target.
- 기존 구현 및 제약 조건: Conversation-only scoping stopped process-global call-id collisions, but combo and 429 failover can reuse the same thread and provider-generated call id across destinations or credentials.
- 검토한 주요 대안: Disable replay on every failover-capable provider; key only by provider name; use persisted or truncated secret-derived ids; bind the in-memory cache to an exact process-local route and credential tuple.
- 선택한 방식: Keep a shared mutable scope holder and key entries by thread, provider name, an opaque destination HMAC, adapter, final model, and an opaque HMAC/account identity; incomplete identities read and write nothing.
- 다른 대안 대신 이 방식을 선택한 이유: Exact binding preserves same-generation same-target retries while making account switches and OAuth token refreshes fail closed, without logging, persisting, or exposing credential material.
- 장점, 단점 및 영향: Cross-provider/account replay is blocked and rotations are visible to live bridges; providers without a stable credential identity lose cache replay and use the existing minimal placeholder path.

## Chat-to-Responses message phase inference

Chat Completions streams do not carry the Responses `message.phase` field. The bridge keeps an
unphased live message provisional while its deltas arrive, then assigns `commentary` when a later
tool, search, reasoning, or assistant boundary proves that more work follows, and assigns
`final_answer` only when a clean terminal `done` closes the current message. Explicit adapter
phases always win. Streaming `output_item.added` remains unphased until that future boundary is
known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

```text
[Decision Log]
- 목적과 의도: Prevent Codex App from rendering one bridged Chat Completions answer as both live commentary and a second persisted final answer.
- 기존 구현 및 제약 조건: openai-chat emits text deltas without phase, the bridge streamed them immediately, and whether text is pre-tool commentary or the terminal answer is unknowable until a later boundary arrives.
- 검토한 주요 대안: Mark every delta final_answer; mark every delta commentary; buffer the entire answer before emitting; infer phase only when the message is finalized.
- 선택한 방식: Keep the live added item provisional and infer commentary or final_answer at the authoritative close boundary, preserving explicit phases and item identity in done/completed output.
- 다른 대안 대신 이 방식을 선택한 이유: Eager defaults misclassify either tool preambles or final answers, while full buffering removes live streaming; close-time inference provides correct persisted semantics without adding latency.
- 장점, 단점 및 영향: Codex App receives a definitive phase for persisted bridged messages and avoids the duplicate-final rendering path; the provisional output_item.added event intentionally has no phase because its classification is not yet knowable.
```

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` retries only
connection-reset-shaped rejections (up to 3 total attempts, jittered backoff, warn-logged);
timeouts, aborts, `ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never
retried. Guarded paths: the ChatGPT passthrough and generic adapter fetch in
`src/server/responses.ts`, the vision/web-search sidecars, and the web-search loop's direct-fetch
fallback. Adapters with their own `fetchResponse` (kiro, cursor, google) keep their own retry
policies; kiro imports the shared abort/sleep helpers from this module.

## Same-provider combo quota fallback

For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
429/402 carrying only `x-codex-*-reset-at` may advance to the later model on the same account. The
failed physical combo target still enters its normal target cooldown. An explicit `Retry-After`
remains an account-wide instruction and blocks the later target; a quota response with neither an
explicit retry delay nor a usable reset timestamp keeps the conservative default account cooldown.
This exception is request-scoped and is not applied to direct requests, round-robin combos, or a
combo whose remaining eligible targets use other providers.

```text
[Decision Log]
- 목적과 의도: Let an ordered combo recover when one model-specific Codex quota window is exhausted but another model on the same account remains usable.
- 기존 구현 및 제약 조건: Account health is shared across models, and recording a reset-derived 429 before combo advancement rejected the later model locally.
- 검토한 주요 대안: Make every quota cooldown model-scoped; ignore all combo 429 cooldowns; or defer only reset-derived cooldown recording for an eligible later same-provider failover target.
- 선택한 방식: Use the narrow request-scoped deferral while retaining target cooldown and all explicit Retry-After/default account cooldown behavior.
- 다른 대안 대신 이 방식을 선택한 이유: Reset timestamps identify quota windows rather than a literal account-wide retry instruction, but widening the exception would risk hot retries and provider abuse.
- 장점, 단점 및 영향: Same-account model fallback works without weakening explicit upstream backoff; the account health map intentionally does not remember that one deferred reset-derived failure, while the combo target map does.
```

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
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/chat/` | Inbound translation onto the same routing pipeline. |
| Hosted search relay | `src/server/search.ts` | Direct relay; distinct from the web-search sidecar loop below. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
| API-key pools | `src/providers/key-failover.ts` | A 429 rotates the active key and records a cooldown; `provider.apiKey` keeps mirroring the active entry so routing stays single-key. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. |

## Sidecars

Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Vision has two possible backends; web search's config union additionally
admits `xai`, `gemini`, and `exa`. xAI is a live explicit-only backend through stored Grok OAuth;
Gemini and Exa remain inert until their executors ship. Selection differs per sidecar:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. No backend — Anthropic or otherwise — is auto-selected from credential availability (doing so once sent OpenAI model ids to the Anthropic API). Explicit xAI requires usable stored Grok OAuth and may add hosted `x_search`; explicit Gemini/Exa remain fail-closed until their executors land. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic), `grok-4.6` (xAI) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.4-mini` (OpenAI) | Input contains images for a model listed in `noVisionModels`. |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

On the OpenAI path there is one deterministic `openai` sidecar candidate and its current account mode
owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
