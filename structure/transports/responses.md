# Responses Transport

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Plaintext collaboration restoration treats a null namespace as absent, rejects non-string namespace types, and restores the native namespace/name pair before HTTP/WS delivery and continuation publication.

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output. For an opted-in key-auth provider, a hosted-search continuation stays bound to the API-key selection that served the first leg; the contract is the [hosted-search continuation binding](../runtime.md#hosted-search-continuation-binding).

### Credential-bearing HTTP redirects

Credential/body-bearing HTTP sends use `redirect: "manual"` at the final executor boundary,
including dispatch overrides and adapter/sidecar retries. `fetchWithHeaderTimeout` retains its
legacy final argument for callers but no longer permits default-follow sends. Both same-origin
and cross-origin redirects remain observable responses: retry helpers must not synthesize a 502
before the owning route can apply its existing response and health policy. Native Responses and
compact retain their 3xx/Location relay contract; image and search sidecar owners consume 3xx
through their existing upstream-error path without relaying Location. This server policy does not govern client-side
redirect following; providers requiring a redirect must be configured with their final API URL.

### Fetch-helper import boundary

`src/server/responses/fetch-helpers.ts` is a transport leaf shared by Responses, compact, and native
Chat. Its runtime imports are limited to the Codex WebSocket transport, provider request pacing, and
the upstream HTTP-version helper. Server, provider, and WebSocket data types remain type-only edges.
It must not import routing, combos, OAuth, adapters, sidecars, response parsing, logging, or relay
modules merely because those imports existed in the pre-split `responses.ts` monolith.

### Semantic progress ownership

The Responses proxy does not treat transcript growth as repository progress. It can observe request
boundaries, response items, tool names and payloads, adapter events, retained bytes, and elapsed
silence. It cannot observe the client's workspace or prove whether a successful tool result changed
repository state. Consequently, the active-turn and session-lane gates are concurrency admission
limits, the translator budget is a live retained-byte limit, the response-state caps are cache
retention limits, and the stall watchdog is a silence limit. None is a cumulative continuation or
semantic no-progress budget.

> Decision record: [ADR-0031](../decisions/ADR-0031-responses-http-sse.md)

> Decision record: [ADR-0032](../decisions/ADR-0032-responses-http-sse.md)

> Decision record: [ADR-0033](../decisions/ADR-0033-responses-http-sse.md)

> Decision record: [ADR-0034](../decisions/ADR-0034-responses-http-sse.md)

> Decision record: [ADR-0035](../decisions/ADR-0035-responses-http-sse.md)

> Decision record: [ADR-0036](../decisions/ADR-0036-responses-http-sse.md)

> Decision record: [ADR-0037](../decisions/ADR-0037-responses-http-sse.md)

Two coordinates that lower to the same wire name are treated as one tool when they denote one:
`buildTools` flattens the reserved `functions` group without a namespace, so a bare declaration and
a `functions` child of the same name are the duplicate the parser already tolerates — and the one
`promoteClientLoadedTools` produces. The declaration is emitted once instead of failing the request.

Replayed call items are lowered whether or not this turn declares the group they name. A catalog can
be absent or change mid-session, but the client is still replaying items this layer's own response
restoration stamped with a private `namespace`. Routed compaction runs this boundary before removing
the tool surface so request-local aliases remain available for response restoration. Only
`tool_choice` resolves a bare name through the catalog: a history
item records which tool actually ran, so re-pointing it at a same-named namespace child would
rewrite that record on a coincidence rather than translate it.

Codex-private tool fields are removed at the same boundary from one table
(`CANONICAL_ONLY_TOOL_FIELDS`) rather than one bespoke pass each: `external_web_access` on either
web-search variant, and `defer_loading` on any declaration, which `activateDeferredTool` clears only
for tools a `tool_search_output` already loaded. A new private bit is a row there.

After that namespace boundary has produced public function tools, the Grok CLI Responses transport
applies the same root-schema policy as its Chat transport. A root `oneOf`/`anyOf` is flattened only
when the shared xAI normalizer can preserve its meaning; an unsafe function is omitted instead of
letting one incompatible declaration reject the entire request before inference. This is scoped to
`cli-chat-proxy.grok.com`: public `api.x.ai` keeps native root unions, as do unrelated Responses
gateways. Both top-level `tools` and Responses Lite `additional_tools` pass through this policy.

Only the ROOT rejects a union, so exclusivity is preserved by moving it down rather than widening
it: a root `oneOf` whose branches differ in one property becomes that property's `oneOf`, or its
`anyOf` when the branches are provably disjoint and the two keywords describe the same set. That
property is also promoted into `required`, because absent it matched every branch — which the root
`oneOf` rejects. Branches that are wholly identical validate nothing and have no faithful
flattening, so they omit the tool. The walk carries depth, node, and variant budgets, since nested
unions are combinatorial and a `$ref` diamond amplifies the same way without ever cycling;
exceeding a budget omits that one function rather than expanding until memory is gone.

Omitting a function makes `tool_choice` the loose end. A selector naming a dropped tool would reach
Grok as a dangling reference, and relaxing it to `auto` is worse — the turn would quietly run
without the tool the caller required. So an `allowed_tools` list drops the omitted entries while any
remain, and a selection with nothing left to point at fails locally with the same 400 a tool catalog
this proxy cannot lower already returns.

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
[`openai-tiers.md`](../providers/openai-tiers.md).

### Pre-dispatch API-key pool pick

Key-auth routes with a configured `apiKeyPoolStrategy` and two or more pool entries pick a
warm key before the first send (`selectProactiveApiKeyTransport` in
`src/providers/key-failover.ts`). The pick is inert unless that strategy is set and the
committed key is already cooling or missing from the pool: a healthy committed key, including
a manual selection, is left alone and the common path returns null without a config write.
`forgetApiKeyRotationCursor` drops the process-local round-robin cursor when the operator
edits the pool, so a later pick cannot second-guess that choice.

On the shared Responses path the assignment lands in `src/server/responses/core.ts`
immediately before `resolveProviderTransport`. `route.provider` is copied into
`adapterProvider` on the next lines, and later `providerFetch` consumers (the HTTP send,
the image bridge, web search) read that pinned object with no stale-selection re-read. A
pick after the pin would leave the first attempt on the cooled key.

Native Chat Completions is a separate entry path: `src/server/chat-completions.ts` routes
eligible `openai-chat` requests to `src/server/chat-native.ts` and never through Responses
core, so that file repeats the same call before it binds the adapter. Native compact
(`src/server/responses/compact.ts`) and the keyed Images relay (`src/server/images.ts`)
do the same for the same reason. Request paths assign the Transport variant, not the bare
`selectProactiveApiKey` snapshot: the snapshot is the persisted row, so it carries none of the
backfills `routedProviderConfig` merges in at request time and none of the route's explicit
runtime transport state. The load-bearing one is the credential -- a stored `\${VAR}` or
keychain reference is resolved in `routedProviderConfig` and nowhere in the adapter, so a
wholesale assignment sends the literal reference as the bearer token. `adapter` and `baseUrl`
are not at risk on a stored row, because the config schema requires both.

Reactive 429 rotation (`rotateProviderTransportOn429`) remains the recovery path after a
send has already earned a throttle.

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

Combo compaction recall uses accepted completed-response callbacks to record the final client-visible
model and originating combo target. The existing child callback gate defers publication until an
attempt is accepted and drops discarded/failed attempts. Both compaction entry points preserve
explicit configured selectors before consulting bounded lane state. The existing state-store
reconciliation owns removal of obsolete targets and generation fencing; core imports no registration
composition root or Lab code. Recall retains routing identity only, never account credentials.

> Decision record: [ADR-0038](../decisions/ADR-0038-responses-http-sse.md)

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

> Decision record: [ADR-0039](../decisions/ADR-0039-responses-http-sse.md)

### Mixed-wire provider defaults

Registry `modelWireDefaults` select an evidence-backed upstream protocol for an exact model without
changing the provider-wide adapter. Explicit, allowed `modelAdapters` configuration always wins,
including an entry that opts the model back into the provider-wide wire. Defaults are applied only
while the configured provider still matches the registry transport, so reusing a preset name for a
different custom destination does not inherit its upstream assumptions. Object-form defaults may
also narrow the decision by inbound protocol and authentication mode; an auth-scoped default must
not leak from a subscription transport into an API-key or forwarded-credential route.

xAI keeps `openai-chat` as its provider-wide compatibility wire, but Grok 4.5/4.6 subscription
Responses requests default to native `openai-responses`. Existing namespace, hosted-search and
reasoning-replay normalization remains in force. The reserved `xai` OAuth transport is name-pinned
to the Grok CLI gateway even if its saved base URL differs; custom provider IDs do not inherit this
default. API-key requests, translated Chat/Anthropic defaults and other Grok models retain their
existing wire and tier policy. The OAuth lane is service-tier classified per model
(`modelSupportsServiceTier` on the registry entry, live-probed 2026-09-13): grok-4.6, grok-4.5,
grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1 and
grok-composer-2.5-fast accept `service_tier: "priority"` over Grok OAuth and echo it, so those
routes resolve Fast-eligible, publish `--fast` rows, and forward a caller-sent tier on either
wire (`chatServiceTier: true`). grok-4.20-multi-agent-0309 stays unclassified with its
caller-tier pin: the gateway accepts the field but answers `service_tier: "default"`, a live
downgrade rather than a fast tier.

Native Responses participates in the same pre-stream OAuth HTTP-429 account rotation as the Chat
bridge. It uses the existing account quorum, cooldown and three-rotation request cap, refreshes
the complete credential/transport/replay identity, and attributes usage to the serving account.
Single-account installs do not retry; a missing alternate credential preserves the original error.

Startup removes legacy Grok 4.5/4.6 Chat overrides once and persists the provider-owned
`xaiResponsesDefaultVersion` marker. Later explicit Chat choices survive restarts. The migration
rebases under the config mutation lock; unavailable persistence warns and uses an isolated in-memory
projection without overwriting invalid disk state. Read-only config loading does not migrate.

The Z.AI coding plan gets the same shape for a different reason. Its registry row owns a fixed
destination, so `routedProviderConfig()` already rewrites a config written against the retired
Chat endpoint (`/api/coding/paas/v4`, `openai-chat`) onto Responses at `https://api.z.ai` on every
request. Startup persists that same canonical pair to the `zai` row once and records
`zaiResponsesDefaultVersion`, so the dashboard, `ocx doctor` and direct config readers stop showing
an endpoint the runtime never uses and the per-boot discarded-base-URL warning stops. The rewrite is
behavior-preserving because it only touches a row the router canonicalizes anyway; Chat stays
reachable per model through `modelAdapters`. A custom-named provider at the retired endpoint is not
migrated — the router leaves its wire alone, and `destinationAliases` already supplies its metadata.

The dashboard's Chat Completions switch and `ocx provider edit xai --xai-chat on|off` share the
existing `modelAdapters` lane. On writes Chat for both models; off writes Responses. Unrelated
overrides remain intact. The legacy PATCH field `xaiResponsesOptIn` retains its direction:
true selects Responses, false now writes explicit Chat rather than deleting entries. Its derived
`xaiResponsesOptInState` reflects effective Responses-inbound routing, including registry defaults;
only genuinely different effective wires report mixed. A switch write also records the migration
version (without lowering a future version), and provider-form overwrites retain omitted choices.

Native routed Responses code-mode turns also receive the shared result-emission contract in both
instructions and the lowered exec input description: a bare awaited helper return is discarded by
the host, so visible results need `text(...)` or `notify(...)` in that first call. Paired exec outputs
containing only an empty completion/failure wrapper use the shared explanatory annotation. The
whole result is examined; populated text, image/file parts, unpaired results, shell-only catalogs,
compaction and OpenAI-operated destinations are untouched. This does not rewrite valid JavaScript
or reconstruct output that the code-mode host never emitted.

Routed code-mode turns also carry the host contract for the nested helpers, stated in the same three
injection sites as the result-emission rule (shared catalog nudge, Cursor code-mode guidance, native
routed Responses instructions): `tools.apply_patch` takes one string that opens and closes with the
bare patch marker lines (blank lines or indentation around them are tolerated; a decorated or missing
marker is rejected), the isolate has no `import`/`require`, and a command that outlives
`yield_time_ms` is polled through `write_stdin` with empty `chars` rather than a shell sleep loop.
When a code-mode exec result still carries one of the host's failure strings ("expects a string
input", "The first line of the patch must be", "The last line of the patch must be", "Unsupported
import in exec"), the native routed Responses, Kiro, and Cursor result paths append a one-line
recovery hint naming the broken rule; flat shell bridges and foreign MCP namespaces are never
annotated, Responses and Kiro additionally require the request's verified code-mode catalog, Cursor
matches the exact `exec` name under its `opencodex-responses` provider without catalog context, and
Cursor's error classification and Kiro's whitespace and failed-wrapper grouping are unchanged. Both
halves live in `src/adapters/exec-tool-result-normalize.ts`
so the pre-call and post-hoc wording cannot drift. This guidance and annotation change rewrites
neither the model's JavaScript nor its patch payload; the existing name-alias delimiter
normalization in `src/responses/code-mode-helper-compat.ts` is unchanged, and the host still rejects a
malformed call exactly as before. Anthropic, Google, OpenAI-chat and command-code result paths
have no exec-result seam today and are not annotated.

> Decision record: [ADR-0040](../decisions/ADR-0040-responses-http-sse.md)

> Decision record: [ADR-0041](../decisions/ADR-0041-responses-http-sse.md)

### xAI string agent-message continuation

`normalizeRoutedAgentMessages` owns raw Responses `agent_message` lowering. Its existing
nonempty all-readable array behavior remains shared by non-forward destinations. The optional
`allowStringContent` argument defaults to false and is enabled only by the non-forward adapter
call when `isXaiResponsesDestination` recognizes HTTPS `api.x.ai` or `cli-chat-proxy.grok.com`
on the standard port. A nonblank string becomes one `input_text` part with the original text;
the same author/recipient attribution is retained and the private transport item id is removed.

This addresses readable child-result delivery (#3907), not scheduling or decryption. Blank,
malformed, ciphertext-only and mixed unknown/encrypted content retains the existing fail-closed
path. Forward destinations never enable the option. The parser and encrypted-task recovery
owners are unchanged, and no broad content-schema validation or adapter-wide string conversion
is introduced. Mocked server fixtures cover parent, child, and parent-result continuation over
SSE and JSON while preserving actual tool-call/result pairs.

OpenCode Go documents `gpt-5.6-luna` on `/zen/go/v1/responses` while sibling models use its Chat or
Anthropic endpoints. The built-in preset therefore selects `openai-responses` only for Luna and
keeps the provider-wide `openai-chat` default for other non-pinned models. This endpoint correction
does not set `modelResponsesUpstreamStreaming`: client `stream: true` remains real upstream
streaming until a current-runtime reproduction justifies a separate bounded-JSON compatibility
policy.

Go's non-forward Responses request path moves valid `additional_tools` wrappers into top-level
`tools` through `src/adapters/opencode-go-additional-tools.ts`. Placement runs after existing
custom/search/namespace lowering and before code-mode, compaction and final hosted-tool pruning.
It does not recalculate wire identities or response aliases. The matcher reads the constructed
send URL, resolving it with URL semantics, and requires HTTPS `opencode.ai`, the standard port
and exact `/zen/go/v1/responses`. Normal and endpoint-inclusive bases or split `responsesPath`
configurations agree; a custom path resolving to Zen or elsewhere does not acquire Go placement.
Credentials, query, fragment, foreign hosts and other resource paths are excluded. The existing
URL constructor canonicalizes trailing base slashes before this check. Malformed wrappers remain unchanged and
the shared mixed-ciphertext agent-message gate remains fail-closed.

The canonical `opencode-go` registry entry defaults to `statelessResponses: true` because Go
rejects reasoning ciphertext combined with `previous_response_id` (#3838). Existing derive
logic fills absent values and preserves explicit false; renamed custom configurations receive
no new destination-based migration. The existing stateless pass sets `store: false`, removes
stored continuation parameters, and repairs orphan calls/results without claiming execution
success. A local replay-cache hit supplies history; a miss cannot reconstruct it, so callers
receive `previous_response_not_found` before upstream dispatch and must resend complete history
without `previous_response_id`. Routed custom-tool lowering requires the same recovery when a delta
custom result has no local call, because its original wire type cannot be established and guessing it
would send an unmatched result upstream. The check resolves the selected wire protocol and the
request's own tool declarations after final route selection, so stateful destinations keep their
upstream-owned native function and native-only custom continuations. Explicit input still receives
orphan repair; this path asks the client to replay rather than reconstructing history. Content-channel reasoning stays content in SSE, JSON and stored replay output; native
summary items and opaque blobs retain their upstream representation. Full-content replay
fingerprints compare the same client-visible items without content-to-summary conversion.
It does not change streaming selection or Chat model routes. Go fixtures cover Luna, Grok
and Muse against both response formats.

The canonical OpenCode Go transport also derives `x-opencode-session` from the existing hashed
session lane before per-model wire selection. One conversation keeps one opaque affinity value
across Responses, Chat, retries, and key rotation, while sibling subagents remain distinct. An
operator-supplied header wins case-insensitively. Renamed providers are covered only when their
fixed key-auth destination still matches the registry; custom and lookalike URLs receive nothing.
Muse Spark's Responses sanitizer also drops the provider-rejected `search_content_types` and
`indexed_web_access` fields from plain `web_search` tools while preserving preview tools and
unrelated models.

Direct Meta Muse / Meta Model Responses (`https://api.meta.ai/v1`) also rejects function tool
names longer than 64 characters or containing characters outside `[a-zA-Z0-9_-]`. After namespace
flattening, `src/responses/muse-tool-name-alias.ts` rewrites those identities on the `api.meta.ai`
host only — every model, including default `muse-spark-1.3` — and records
`convertedMuseToolNameAliases` on the adapter request. Restore runs hashed-to-original before
namespace restore and before the undeclared-tool guard, covering stream payloads, non-stream JSON,
continuation cache, inspection, and failover rebuilds.
Restore matches the tool identity on `function_call`, `custom_tool_call`, `function`, and
`custom` objects and on `response.function_call_arguments.{done,delta}`, whose `name` sits
outside any item and is read directly by the undeclared-tool guard.
The restorable map is narrowed by `tool_choice` the same way `authorizedAliases` narrows the
namespace layer: upstream still receives the whole aliased catalog, but a tool the caller
disabled for the turn cannot be restored back into an executable client name.
Arguments, user text, and schema property names are never rewritten.

> Decision record: [ADR-0042](../decisions/ADR-0042-responses-http-sse.md)

> Decision record: [ADR-0043](../decisions/ADR-0043-responses-http-sse.md)

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

Both client readers also retain a bounded, redacted message from a bare upstream
`error` event. If EOF arrives without a real Responses terminal, they synthesize
one `response.failed` with that message instead of replacing it with `adapter_eof`.
The delivering reader owns this evidence; an asynchronous tee inspection branch
cannot reliably supply it before EOF. Inspection independently applies the same
bare-error rule when EOF arrives, so account health records failure instead of
clearing avoidance as if the turn had succeeded. Existing real terminals and
caller cancellation retain precedence on both branches. Native recovery preflight
also preserves a rejected body reader and its bounded prefix for the normal
mid-stream failure path; it does not turn that rejection into a decrypt retry.

Native Responses may rebuild once when encrypted function/custom-tool output or
agent-message content receives the exact known decrypt rejection before output
commits. Recovery replaces only encrypted parts with an omission marker, preserves
the raw request object used by continuation persistence guards, and uses the same
adapter and cancellation path. A missing Content-Type is allowed only under the
existing successful streaming condition. Default combo preflight classification
is unchanged; only the native recovery caller supplies the exact error predicate.

Both shapes carry the inbound caller-abort signal separately from the turn/shutdown
controller. A caller-driven read rejection is 499/client_cancel without pool penalty;
a genuine upstream reset remains synthetic 502. An already received terminal, including
one completed by the error-path parser flush, retains its real outcome. Eager relays
remove the caller listener when done and close signal-cancelled downstream streams even
when the response-body cancel hook has not run.

The two-shape contract is mirror-commented in `src/server/index.ts`; the real
`core.ts` gate is source-invariant-tested by `tests/responses/passthrough-abort.test.ts`,
and the platform matrix lives in `tests/lib/bun-stream-caps.test.ts`. Keep all three
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

At the canonical ChatGPT destination, HTTP Responses Lite intent is copied into
the native per-frame WS metadata key, and the routing hint is derived from the
final outgoing model/tier. No caller identity is synthesized. Noncanonical
opt-in gateways keep their own metadata policy. Oversized/unsupported-runtime
HTTP fallback preserves the original HTTP body and Lite header.

For the final wire model `gpt-5.3-codex-spark`, the canonical forward adapter normalizes the
Lite header from the BODY, overriding caller/configured headers and stale native WS Lite
metadata in both directions. A body carrying a nonempty `additional_tools` input item is
pinned to `true`: that item IS the Lite tool-delivery format and the non-Lite wire shape
expects top-level `tools`, so an inherited `false` would advertise non-Lite while the tools
exist only in the Lite shape and hide the client tool surface. Any other Spark body is set to
`false`, selecting the non-Lite framing policy. A changed Lite identity retires the previous socket;
subsequent eligible Spark requests with the same identity can reuse the new socket. Malformed
native metadata retains HTTP fallback eligibility without rewriting its body.

Canonical WS quota and response metadata preceding the first Responses event
are projected into bounded, allowlisted HTTP headers before the response is
committed. Later quota observations update only the captured serving account;
they cannot retroactively change HTTP headers already sent to the client.
Control frames remain bounded, and provider credential/cookie headers are not
forwarded. Once a WS create may have been sent, a missing prelude, overflow or
disconnect settles as an errored SSE body rather than a retryable fetch failure,
so HTTP fallback cannot duplicate that inference. A standalone no-response
exchange has a 90-second prelude deadline in addition to the upgrade deadline.
That prelude deadline is a ceiling, not a floor: the exchange runs under the
caller's abort signal, so a `connectTimeoutMs` shorter than 90 seconds cancels
an already-sent create before the prelude timer fires.
These are transport-fidelity guarantees, not a provider-billing guarantee.

Every exchange also leaves a content-free stage record (`CodexWsStageRecord`, #4191): create-frame bytes (measured on failure only — the committed-success record keeps it null so the happy path never byte-counts a megabyte replay frame), send completion, numeric close code, elapsed and first-frame durations, frame counters, liveness ping/pong counts, pool reuse, and the OCX/Bun versions. The exchange pins the record on the resolved Response (`markCodexWsStage`, the same marker seam as `markCodexWsResponse`); `handleResponses` adopts it onto the serving attempt, and usage.jsonl persists it per attempt behind a drop-guard normalizer, so hand-edited rows cannot inject strings into the DTO. The record never carries conversation text, headers, close-reason text, or account identifiers, and it is not a fallback-eligibility signal: the no-replay-after-send contract stands regardless of what it says.

Eligible complete-input creates can retain a canonical upstream socket within
one selected account, credential, thread and turn. Model/tier and immutable
handshake headers and the selected outbound proxy must also match. Turn-state and turn-metadata headers are
projected into their same-name per-frame metadata slots; explicit body values win.
The pool retains at most 32 sockets, expires idle sockets after 30 seconds, and
retires a socket after five minutes or 32 successful exchanges (after active work
finishes). Cancellation, errors, idle unsolicited frames and shutdown dispose it.
A busy key uses a separate one-shot connection rather than interleaving requests.

This is connection reuse, not native incremental-input synthesis: complete HTTP
inputs are never trimmed and no previous response id is invented. Explicit
continuation IDs, named lanes, warmup and background requests remain outside this
pool. A fresh credential-dispatch guard runs before every warm send. Per-exchange
listeners, response/item correlation and metadata ownership detach before release.
No pool timer or shutdown registration exists before eligible traffic activates it.

Translated response request-log tracking and the heartbeat relay also reuse
`createSseInspector`. This keeps every client-facing SSE observation path on
the same byte-bounded, discard-and-resynchronize frame policy and ensures the
request-log, first-output, and terminal observers share one payload parse.
The inspector records a structured `response.failed` status before invoking the
terminal observer. Native Responses, Chat Completions, Claude Messages, and WebSocket
request logs must therefore finalize through the context-aware terminal mapper; recognized
`cyber_policy` terminals stay `400 / cyber_policy` rather than collapsing to a generic 502.

The client-facing boundary treats the first Responses terminal as authoritative in both relay
shapes. High-confidence policy errors carried as `response.incomplete`, `response.failed`, or a
top-level `error` are normalized to one `response.failed / cyber_policy` event without changing the
refusal outcome; later bytes cannot create a second terminal. A clean HTTP 200 EOF with no terminal
instead emits one `response.incomplete` with `adapter_eof`, followed by one `[DONE]`. Delimiter-less
EOF candidates follow the owning repair policy: the native boundary accepts a structurally valid
terminal tail, while an opted-in terminal repair keeps its unframed suffix tainted and emits
`missing_terminal_event`. Pull/tee and eager relays therefore agree on terminal, sentinel, and
request-log accounting without promoting a truncated repair candidate.

> Decision record: [ADR-0044](../decisions/ADR-0044-responses-http-sse.md)

## Chat-to-Responses message phase inference

Chat Completions streams do not carry the Responses `message.phase` field. The bridge keeps an
unphased live message provisional while its deltas arrive, then assigns `commentary` when a later
tool, search, reasoning, or assistant boundary proves that more work follows, and assigns
`final_answer` only when a clean terminal `done` closes the current message. Explicit adapter
phases always win. Streaming `output_item.added` remains unphased until that future boundary is
known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

> Decision record: [ADR-0069](../decisions/ADR-0069-chat-to-responses-message-phase-inference.md)

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

## Console upload rejection recovery

`src/providers/opencode-zen-rate-limit.ts` recognizes the complete Console upload-rejection envelope only at the effective HTTPS opencode.ai Zen/Go generation endpoint. A provider row name cannot authorize another destination. The two recovery loops in `src/server/responses/core.ts` wait 800 ms and replay the captured serialized request once; cancellation, nonreplayable responses, other errors and a second upload rejection keep their failure semantics. The recovery kind is persisted as `console-go-upload-retry` and has a localized Logs label.

## Same-provider combo quota fallback

For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
429/402 carrying only `x-codex-*-reset-at` may advance to the later model on the same account. The
failed physical combo target still enters its normal target cooldown. An explicit `Retry-After`
remains an account-wide instruction and blocks the later target; a quota response with neither an
explicit retry delay nor a usable reset timestamp keeps the conservative default account cooldown.
This exception is request-scoped and is not applied to direct requests, round-robin combos, or a
combo whose remaining eligible targets use other providers.

> Decision record: [ADR-0070](../decisions/ADR-0070-same-provider-combo-quota-fallback.md)

## Combo per-target reasoning controls

`src/server/responses/core.ts` passes the combo's `reasoningEffortMode` and the final target's
`supportedLadderFor` result to `src/combos/request.ts` before adapter parsing. Explicit empty
capability ladders remove effort and thinking controls in every combo mode; adaptive mode also
removes those controls for unknown ladders and preserves `reasoning.summary`. Known non-empty
ladders retain the existing per-target effort resolution. This request normalization does not
change target order, attempt accounting, or the existing provider-400 failover classification.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Combo streaming commit boundary

An HTTP 200 does not by itself commit a streaming combo child. The combo parent runs the child's
downstream Responses SSE through `src/server/responses/combo-stream-preflight.ts`, which owns one
reader and buffers only until one of these boundaries:

- a non-control Responses event begins client-visible output or a tool/action item, after which the
  target is committed and cross-target replay is forbidden;
- a `response.failed` terminal arrives first, in which case the terminal is converted back through
  the ordinary bounded combo-failure classifier and may advance to the next declared target;
- a completed/incomplete terminal or the aggregate preflight byte or retained-chunk cap is reached,
  in which case the current target is committed conservatively.

The buffered bytes are replayed unchanged before the reader continues. Native passthrough and eager
relay identity markers are restored on the wrapped response so Windows/Bun stream paths and deferred
logging retain their existing owners. A failed child keeps its physical attempt receipt and usage,
while the successful child remains the logical request result.

HTTP 410 remains terminal by default. It advances and cools only the exact combo target when the
structured code or message explicitly identifies a model lifecycle event (end-of-life, retired,
deprecated, sunset, decommissioned, or no longer available). An unrelated application-level 410 is
not retried.

> Decision record: [ADR-0071](../decisions/ADR-0071-combo-streaming-commit-boundary.md)

Usage consumers preserve positive incomplete-history metadata and connected CLI usage follows the client-scoped hub contract, both specified in [usage accounting](../gui-and-management-api.md#usage-accounting): readable totals are not a complete ledger, and local management and account data stay separate. Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity. The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`. Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration and records its isolated owner and support limits.

Console upload-rejection recovery excludes query-bearing and fragment-bearing destinations even when their host and generation path match the canonical endpoint.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).

Chat helper admission in `src/server/responses/core.ts` follows the [deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence; see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Spark Lite and routing metadata use the same suffix-normalized model object as serialization, including configured bracket-suffix removal.

## Optional client transport hints

`dropCodexSafetyBuffering` defaults to false. Canonical OpenAI forward Responses can remove only
the two safety-buffering response headers, matching response.metadata events and top-level
safety_buffering fields. Pull/eager client output boundaries compose this with policy failure
normalization; refusal/error semantics, retryability, cancellation and captured EOF errors remain
intact. Internal inspection observes original upstream frames. Native codex.response.metadata.headers
WebSocket metadata and compact are excluded. This does not disable upstream safety enforcement.

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch) privately to final dispatch; preliminary route selection does not inject Go-only headers.
Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates; account quota surfaces use [safe probe diagnostics](inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.
