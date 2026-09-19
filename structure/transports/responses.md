# Responses Transport

Native result continuations and function-result injection follow [the mode-specific result and control contract](streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Management provider-validation calls use the [initialization-independent relative send-path validation](../config.md#provider-relative-send-paths) before persistence. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

Plaintext collaboration restoration treats a null namespace as absent, rejects non-string namespace types, and restores the native namespace/name pair before HTTP/WS delivery and continuation publication.

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output. For an opted-in key-auth provider, a hosted-search continuation stays bound to the API-key selection that served the first leg; the contract is the [hosted-search continuation binding](../providers-and-adapters.md#hosted-search-continuation-binding).

The `openai-responses` adapter preserves the incoming `User-Agent` as a non-credential fallback in
both key and forward modes. A configured provider header with that name wins case-insensitively;
when the caller omits it, the adapter invents no client identity. This does not widen the canonical
forward credential/metadata allowlist or copy any other caller header.

Retired Codex Spark has no model-specific tool or Responses Lite override; general Lite handling and
namespace scrubbing remain shared compatibility behavior. Codex quota/reset evidence follows the
[shared/Reserve policy](../providers/openai-tiers.md#public-provider-contract), including suppression of retired model-derived evidence before shared recovery.

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

`OCX_FRESH_CONNECTION_HOSTS` accepts comma-separated hostnames whose outbound HTTP sends bypass
keep-alive reuse with `Connection: close` and `keepalive: false`; exact hosts and their subdomains
match case-insensitively. `sendWithConnectionPolicy` applies the policy around the fetch that
performs the physical send, after a dispatch override has selected or rebuilt the destination, so
matching follows the URL sent on the wire rather than the URL supplied before credential
revalidation.

The wrapped executor alone is not that boundary. An override that revalidates credentials re-reads
`route.provider.fetch` at send time, because reselection can install a different provider transport
after the wrapper was built, and then calls that implementation instead of the executor. Both
production overrides do this -- `oauthDispatch` in `request-transport.ts` and the native Chat
key-revalidation override in `chat-native.ts` -- so both wrap the selected implementation rather
than choosing between policy and provider transport. Reporting the executor as the boundary while
the code let a provider-scoped transport past it is what #4992 recorded, and it is why a
regression for this policy has to enter through `handleResponses` rather than through a
hand-written override that cooperates by calling the executor it was handed.

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

A namespaced tool is registered under every coordinate a provider might echo — `ns__name`, the
dotted `ns.name`, and the bare `name` — but six spellings never reach a DECLARED-NAME set under
the bare one: `exec`, `exec_command`, `shell_command`, `write_stdin`, `apply_patch`,
`view_image` (`NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES`). A declared-name set is what decides
nested-helper normalization, so bare `exec` from a namespace turns it on for a catalog that never
declared the shell, and `normalizeDeclaredToolName` then rewrites an undeclared `apply_patch`
onto it. The fence is a property of the SPELLING, not of the declaring namespace and not of why
the alias was being added — both copies drifted once, one to `collaboration` only and one to
`exec` only, and each drift was a live authorization widening. Every site that builds a
declared-name set reads the one list: `buildToolBridgeMaps` for the echo and `tool_choice`
selector paths, and `collectDeclaredWireToolNames` for the passthrough catalog.

Declaration and restoration are separate, and only declaration is fenced. Passthrough rewrites an
echoed bare name to its namespaced identity before authorizing anything
(`authorizedBareNamespaceToolAliases`, built from `toolNsMap`), and the guard then authorizes
`ns__name`, so a `tool_choice` that nominates one helper tool by its bare name keeps the
`toolNsMap` entry and loses only the declaration. The echo path withholds both, because a bare
echo is a guess rather than a nomination. The bridges check the declared set before consulting
`toolNsMap`, so there a bare helper echo is refused either way. A genuine namespace-free
declaration is untouched throughout: that is the caller declaring the tool, not a namespace being
discarded to manufacture a bare name.

Function-call wrappers around freeform bodies are restored by
`src/responses/apply-patch-envelope.ts`. The declared `input` field is authoritative. For bare
`exec` and `apply_patch`, one tool-specific alternate field or one complete outer Markdown fence
is recoverable because the wrapper is otherwise unusable; two alternate fields are ambiguous and
therefore remain untouched. Foreign freeform grammars never receive that compatibility rewrite.

Progressive preview for those wrappers is decoded by
`src/responses/progressive-freeform-input.ts` in both the adapter-event bridge and routed
function-call restoration, over the classification in `src/responses/freeform-wrapper-scan.ts`.
A prefix that can still become a complete outer fence stays held so completion never removes
bytes already published in a delta; a body that is not shaped like a wrapper object remains
progressive, and JSON escapes emit only complete decoded units.

Which wrapper applies is decided by scanning the prefix as JSON rather than matching it against
a literal opening. `JSON.parse` decides the completed input, and it cares about neither property
order nor how a name is spelled, so a canonical key arriving after other properties or written
with an escape is the same wrapper and has to preview as one (#5151). The buffering policy that
follows is: an own `input` with a string value streams progressively, because completion gives
it precedence over everything else in the object whatever its position; an `input` with a
non-string value, a text that is not an object, and an object `JSON.parse` can no longer accept
all publish their own bytes, because that is what completion returns for them; every other
object HOLDS until it parses, because a key that has not arrived yet can still change the
answer. Fallback fields fall out of that last rule rather than being recognized separately:
they only unwrap as the single string field, so no prefix decides them. Classification is
bounded to `MAX_FREEFORM_WRAPPER_SCAN_CHARS`, which keeps the work per delta from growing with
the arguments. Past the bound nothing is previewed at all: the authoritative parse still
unwraps the wrapper at completion, so the bound costs preview and never agreement. The parse
that releases a held object therefore runs only where the scan SAW the object close, which is
what keeps a buffer whose deltas happen to end on a brace from being re-read on every one of
them.

What that policy costs is worth stating plainly, because it is a real narrowing. A body that IS
a parseable JSON object but not a wrapper — `{"code":1}` or `{"code":"a","script":"b"}` — now
reaches the direct bridge in one delta when the object closes, where it previously streamed as
it arrived. That is not a tuning choice: `input` can still arrive after any property, so any
prefix published before the object closes is a prefix that completion may unwrap away. Routed
restoration has held exactly these bodies since #5047 and this is the two paths agreeing, not a
new restriction invented for one of them. Bodies that are not objects, which is what an `exec`
program or an `apply_patch` envelope actually looks like, are unaffected and still stream.

Routed restoration additionally keeps its existing hold for an unrecognized JSON object and its
separate code-mode patch-envelope hold. Duplicate `input` keys and wrappers that become invalid
only after a valid prefix was emitted remain bounded exceptions: completion is authoritative
because preserving progressive canonical input leaves no rewind mechanism.

Codex-private tool fields are removed at the same boundary from one table
(`CANONICAL_ONLY_TOOL_FIELDS`) rather than one bespoke pass each: `external_web_access` on either
web-search variant, and `defer_loading` on any declaration, which `activateDeferredTool` clears only
for tools a `tool_search_output` already loaded. A new private bit is a row there.

OpenAI-private TOP-LEVEL request keys have their own table, `CANONICAL_ONLY_TOP_LEVEL_FIELDS`, with
the same discipline and a different scope. It currently holds `access_programs`, which Codex 0.155
mints from ChatGPT auth alone and never from the destination URL, so loopback injection — which
keeps Codex pointed at its built-in `openai` provider on purpose — leaves it attached wherever the
turn is routed. A gateway that validates its top-level schema rejects the request before inference:
Console Go answers with an unknown-parameter error naming the field, and every turn of that thread
fails (#4853). The key is scoped by DESTINATION rather than by the canonical surface, because
`src/server/responses/compact.ts` spreads the caller's raw body into the native
`/responses/compact` request without passing through this adapter, and that endpoint is offered
only to OpenAI-operated destinations; stripping on the canonical predicate would make
`openai-apikey` behave differently on its two endpoints.

This table is not an unknown-parameter sanitizer, and the distinction is the point. It lists keys a
client is observed to send, so an unrecognized top-level key reaches the wire untouched rather than
being deleted on the theory that the destination would have rejected it. `codex_output_schema` is
deliberately absent for that reason: in codex-rs it is the `name` of the JSON-schema `text.format`
object, not a top-level key, so listing it would remove a field this client never sends.

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
send has already earned a throttle. Before rotating a key, the Responses dispatch path peeks at
most 4 KiB of a 429 body under the client abort signal and a short deadline. Only the canonical
OpenRouter quota error shape (`rate_limit_error` or numeric 429 plus a Weekly/Monthly Limit
Exhausted message) may supply a dated cooldown; other providers continue to use `Retry-After` or
the ordinary undated cooldown. Bytes pulled in the boundary chunk are replayed ahead of the unread
stream, and every timeout, read failure, or cancellation cancels the reader and releases its lock. Client
cancellation terminates dispatch before rotation can persist another key.

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

Both entry points apply the Reserve opt-in refusal in
[providers/openai-tiers.md](../providers/openai-tiers.md#public-provider-contract) before auth, host-circuit
admission or any upstream byte. `src/server/responses/request-prepare.ts` applies it beside the
existing Reserve helper refusal, restricted to the native `responses` inbound wire and to
non-terminal-helper turns: enabling the opt-in would not make a terminal vision or search helper
work, and a `gpt-reserve` selector arriving over the Chat or Anthropic wire is an operator-authored
route. `src/server/responses/compact.ts` repeats it against the resolved route model, because its
native branch dispatches without replaying through `handleResponses`.

Combo compaction recall uses accepted completed-response callbacks to record the final client-visible
model and originating combo target. The existing child callback gate defers publication until an
attempt is accepted and drops discarded/failed attempts. Both compaction entry points preserve
explicit configured selectors before consulting bounded lane state. The existing state-store
reconciliation owns removal of obsolete targets and generation fencing; core imports no registration
composition root or Lab code. Recall retains routing identity only, never account credentials.

Retention is bounded on four axes: 256 lanes, 30 minutes, 1 KiB per remembered model id, and 64 KiB
in aggregate. The model id is the only field of unbounded length — lane keys are already SHA-256
digests — so the lane cap alone does not bound the bytes those lanes hold. The size test runs on code
units before encoding, since a UTF-8 encoding is never smaller than its code-unit count and the bound
must not pay the allocation it exists to prevent. Aggregate eviction drops the least recently written
lane, which is the front of the map because every write re-inserts its own lane at the back.

An unretainable model id declines the write rather than clearing the lane, matching how every other
rejection in `rememberComboForLane` returns. Clearing would let a late completion erase a newer
selection, and the publication path carries a config generation, not a request order, so it has no
basis on which to decide that its own result is the newer one. The store is also swept periodically
now: the TTL was previously evaluated only on read or on a generation change, so a lane never read
again held its entry for the life of the process.

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

Codex pool account changes are a separate portability question from destination serving identity.
`src/codex/routing.ts` remembers, in process memory and keyed like thread affinity, which pool
account minted a conversation's carried state (`previous_response_id`, encrypted reasoning, and
provider conversation or file ids). `src/server/responses/account-change-state.ts` applies that
record on `/v1/responses` and `/v1/responses/compact`, including same-request alternate-account
retries and the compact routed fallback: when the serving account differs, the proxy drops the
continuation id and strips encrypted reasoning with the existing helpers before dispatch, keeps
readable user text, and records `conversationStateScrub: "account-change"` on the request log
without account identifiers. Once the new account issues its own state, later turns carry it
normally. `canPortConversationState` is local until `src/routing/identity-domains.ts` lands.

### Uploaded files do not move between accounts

An uploaded `file_id` has always been classified as account-bound, and the scrub has always
removed only `previous_response_id` and `conversation`. A body whose only account-bound state was
a file reference therefore reported nothing scrubbed and went to the new account unchanged.

Deleting the reference is not the contract. A file reference is content the caller attached, not
continuation state the turn can do without, and dropping it silently answers a different question
than the one that was asked. `accountChangeFileReferenceRefusal` reads the carriers directly
rather than through the portability verdict, because that verdict reports the first reason it
finds: a body carrying both a previous response id and a file reference reports only the former,
and the file would slip through the scrub.

The initial `/v1/responses` selection and the native compact dispatch answer HTTP 400, not a
retryable status, and the message names both the cause and the remedy. That message carries more
than the immediate failure on purpose: the reference stays in conversation history, so every later
turn is refused the same way until the files are re-uploaded under the serving account or the
conversation is restarted, and a caller told only that the reference is invalid would resend
unchanged and see a dead conversation.

The alternate-account paths refuse the move instead of raising a status, because an earlier
response already exists to return. `conversationCarriesUploadedFiles` answers from the body alone,
so both the Responses retry helper and the compact retry ask before resolving an alternate: no
send is reserved, the first response is never cancelled, and the caller returns the original
upstream rejection. A same-account replay such as the gated-model 400 ladder is unaffected, and a
single-account install never reaches any of this because serving and issuing accounts cannot
differ. Pinning a file-carrying conversation to its issuing account is routing-affinity work and is
specified in [uploaded-file account retention](../providers/openai-tiers.md#uploaded-file-account-retention);
it reduces how often this refusal fires and does not replace it, because the issuing account can
always become unable to serve.

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

`shouldRetryCodexPoolAccountQuota` withholds that rotation when the 429 or 402 body names an
organization- or project-scoped exhaustion (`codexScopedExhaustionCode` in
`src/codex/quota-rejection.ts`). Every credential inside the refusing organization meets the same
counter, so the move would pay a second cold prompt prefix for no new capacity. Withholding the
move does not withhold the accounting: `src/server/responses/passthrough-delivery.ts` applies the
response's quota headers to the serving account and records the 429 outcome on the ordinary
delivery path, so the account still earns its cooldown and leaves the selection pool. The gate
fails closed — an empty, truncated, unparseable, duplicate-keyed or aborted body keeps the broad
behaviour, and `rate_limit_exceeded`, `slow_down` and plan-level exhaustion still rotate.
Credential-refresh failures are fenced by both the account generation and a global routing-state
generation. Reauthentication advances the account fence; replacing the whole routing roster
advances the global fence. A late failure from either obsolete state is ignored, while failures
captured after the reset still contribute to the bounded cooldown.

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
halves live in `src/adapters/exec-tool-result-normalize.ts` so the pre-call and post-hoc wording
cannot drift. This guidance and annotation change rewrites neither the model's JavaScript nor its
patch payload; the name-alias normalization in `src/responses/code-mode-helper-compat.ts` also
compiles `view_image` into the declared `exec` and surfaces its `image_url` through `image()`, and
the host still rejects a malformed call exactly as before. Anthropic, Google, OpenAI-chat and
command-code result paths have no exec-result seam today and are not annotated.

> Decision record: [ADR-0040](../decisions/ADR-0040-responses-http-sse.md)

> Decision record: [ADR-0041](../decisions/ADR-0041-responses-http-sse.md)

### xAI string agent-message continuation

`normalizeRoutedAgentMessages` owns raw Responses `agent_message` lowering. Its existing
nonempty all-readable array behavior remains shared by non-forward destinations. The optional
`allowStringContent` argument defaults to false and is enabled only by the non-forward adapter
call when `isXaiResponsesDestination` recognizes HTTPS `api.x.ai` or `cli-chat-proxy.grok.com`
on the standard port. A nonblank string becomes one `input_text` part with the original text;
the same author/recipient attribution is retained and the private transport item id is removed.

This addresses readable child-result delivery (#3907), not scheduling or decryption. Blank, malformed,
ciphertext-only and mixed unknown/encrypted content stays unlowered here; backend ciphertext is replaced by the
[omission marker](../subagents.md#routed-agent-message-ciphertext-egress) before it can reach a routed destination.
Forward destinations never enable the option. The parser and encrypted-task recovery owners are unchanged, and no
broad content-schema validation or adapter-wide string conversion is introduced. Mocked server fixtures cover
parent, child, and parent-result continuation over SSE and JSON while preserving actual tool-call/result pairs.

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
without `previous_response_id`. That refusal is not specific to the stateless flag: it covers every
destination that cannot see the prefix this process failed to restore, which is every destination
except the native Responses passthrough. The passthrough forwards the id and keeps its
upstream-owned state. A task-scope mismatch uses the same generic refusal even when the supplied
input appears complete, because the proxy cannot prove that it contains the full conversation.
The internal mismatch reason, stored scope and state contents never enter the client response;
the caller retries explicitly with complete history and no `previous_response_id`. Matching
normalized scopes replay, and two absent or blank scopes remain the legacy unscoped cohort.
`PROVIDER_OWNED_CONTINUATION_WIRES` in
`src/responses/continuation-ownership.ts` is deliberately empty and records why the three
candidates do not qualify: devin re-sends the whole conversation each turn, cursor reads its
`checkpointRef` out of the same expired store and otherwise falls back to `full-replay`, and kiro
rebuilds `conversationState.history` from the turns it was handed. A missed expansion on any of
them would forward the current turn alone under a normal 200 — the whole conversation replaced by
one line, with nothing in the response saying so. This also replaces kiro's former
`invalid_request_error`, which told the client to start a new session and therefore skipped the
recovery Codex performs on `previous_response_not_found`. Retention is the other half: local
continuation state is held for `RESPONSE_TTL_MS` (24 hours), long enough that an ordinary idle gap
resumes by expansion rather than by asking the client to replay. Routed custom-tool lowering requires the same recovery when a delta
custom result has no local call, because its original wire type cannot be established and guessing it
would send an unmatched result upstream. The check resolves the selected wire protocol and the
request's own tool declarations after final route selection, so stateful destinations keep their
upstream-owned native function and native-only custom continuations. Explicit input still receives
orphan repair; this path asks the client to replay rather than reconstructing history. Content-channel reasoning stays content in SSE, JSON and stored replay output; native
summary items and opaque blobs retain their upstream representation. Full-content replay
fingerprints compare the same client-visible items without content-to-summary conversion.
It does not change streaming selection or Chat model routes. Go fixtures cover Luna, Grok
and Muse against both response formats.

The canonical OpenCode Go transport derives `x-opencode-session` from the existing hashed session
lane and the final per-model wire protocol. One conversation keeps one opaque affinity value within
each protocol across ingress surfaces, retries, and key rotation, while Anthropic, Responses, and
Chat turns use separate namespaces and sibling subagents remain distinct. Destination recognition
uses the original routed provider while the generated hash uses the settled adapter, so selecting an
Anthropic hard pin cannot make the canonical Go destination disappear from transport recognition.
An operator-supplied header wins case-insensitively. Renamed providers are covered only when their
fixed key-auth destination still matches the registry; custom and lookalike URLs receive nothing.
OpenCode Go's exact `union-alpha` model id is hard-pinned to the Anthropic wire from every inbound
surface; sibling models retain their existing Chat or Responses selection. This wire choice and the
session namespace do not assert upstream availability after the Messages endpoint accepts the
session header.
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

### Declared-tool membership by inbound wire

Inbound declaration membership and schemas remain unchanged by Google's
[tool-schema loss report](../providers/google.md#google-tool-schema-loss-reporting). Only the final
Google wire compiler observes and reports compatibility narrowing; the Responses bridges neither
derive nor consume that report.

`declaredToolNames` carries the request's tool catalog into both bridges, and it does two separate
jobs that are separately controlled.

Normalization runs on every inbound wire. `normalizeDeclaredToolName` and `declaresCodeModeExec` in
`src/types/tools.ts` read the same set to map a provider-invented `default.` namespace back to the
declared bare tool and to rewrite code-mode helper names into the declared `exec`. Both return their
input unchanged when the set is absent, so the set reaches the bridge on every wire and enforcement
is expressed by a separate flag rather than by withholding it.

The passthrough guard resolves an emitted name through that same `normalizeDeclaredToolName`, so
whatever it admits it must also EMIT under the resolved name. The two halves disagreed once:
`normalizeDefaultNamespaceInItem` implemented only the bare-tool case (#4176), so a
`default.`-prefixed code-mode helper was admitted as `exec` (#4412) and then relayed verbatim.
`default.view_image` is not a legal Responses tool name, and Codex stores what it receives, so the
one relayed item was refused by `^[a-zA-Z0-9_-]+$` on every later replay of that conversation and
the task could not be compacted or continued (#5095). The rewrite now falls back to the resolver
whenever `isSchemaValidResponsesToolName` (`src/responses/tool-name-aliases.ts`) rejects the emitted
name, and only then, so a name the upstream accepts is never reshaped by this branch. A name that
resolves to nothing declared stays refused by the #1700 guard, which is the pre-existing and
intended outcome: an invalid name that cannot be resolved must end the turn visibly rather than
reach stored history.

Stopping the emission is only half of it, because Codex stores what it received. A conversation
that already contains one `default.`-prefixed call name is refused on every later turn that
replays it, so the task cannot be compacted or continued at all and no upgrade reaches it.
`repairLegacyDottedToolCallNames` (`src/responses/legacy-dotted-tool-name-repair.ts`) repairs the
replayed item on the way out, in `buildRequest` beside `backfillWebSearchQueries` and again in
`src/server/responses/compact.ts`, which forwards the caller's body directly. It runs before the
canonical-destination split because the reported failure was a side chat on a plain OpenAI model
inheriting history a routed provider had damaged.

What it will resolve is bounded on purpose, and only replayed `input` items are eligible — the
caller's tool catalog is never rewritten. A dotted spelling the catalog itself declares is a real
tool identity and is left alone; a suffix claimed by two declared identities is ambiguous and is
left alone; a suffix that names exactly one declared tool, or one of the code-mode helper spellings
in `CODE_MODE_HELPER_WIRE_NAMES` (which a code-mode catalog never declares), resolves to that name.
There is no rule that strips whatever precedes the first dot: a legitimate tool name may contain
one in another provider's vocabulary, and a replayed item names a call that already happened, which
is the worst place to guess.

Membership enforcement is that flag, `enforceDeclaredToolNames`, and only the `responses` inbound
wire enforces. A routed provider that names a tool the request never declared ends the turn there:
`src/bridge/sse.ts` emits `response.failed` and `src/bridge/response-json.ts` returns a failed
response, both carrying `undeclared client tool`. That is the #1700 contract and it stands. Codex
executes a top-level tool call, so a hallucinated `apply_patch` — which under code mode exists only
as a nested `tools.apply_patch(...)` helper inside `exec` — is refused before it reaches the
runtime, where it previously surfaced as a bare `aborted` with the file untouched.

The `chat` and `anthropic` inbound wires relay the call instead. This is a deliberate reversal of
#1700's scope for those two wires, not an oversight. Both vendor specs make the client's own runner
responsible for validating a tool call and then executing or denying it, and harnesses on those
endpoints defer part of their catalog to conserve prompt tokens and discover the rest at runtime.
Enforcing membership against a partial catalog killed those streams mid-turn with a 502 and cost the
caller the whole turn. This proxy executes no tool call on any wire, so scoping enforcement off
these two moves the decision to the party that already makes it rather than removing it.

An explicitly empty catalog still authorizes nothing on the wire that enforces. A request declaring
an empty tool list is making a statement rather than omitting one, which is how the passthrough
guard reads it through `clientExplicitWireToolCatalog` in
`src/server/responses/passthrough-dispatch.ts`.

The passthrough guard is not wire-scoped. `undeclaredToolGuardActive` gates namespace normalization
and continuation-state suppression as well as the refusal, and it stands down only for
`authMode: "forward"` and for a request that declares no catalog at all.

`src/server/responses/run-turn-execution.ts` and `src/server/responses/adapter-delivery.ts` set the
flag from `inboundWire` on the streaming, buffered, and JSON paths alike, so the three cannot drift.

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
That synthesized terminal also carries the upstream's own verdict. Codex classifies
a `response.failed` by `error.code` alone and retries every code outside its fatal
set, so a refusal stamped `upstream_server_error` reached the client as a retryable
disconnect and drove a reconnect loop (#5176). The readers now read a refusal code
and the message from the same candidate precedence, taking the first code present so
a refusal nested below a transient one cannot overrule it, and fall back to
recognized refusal copy only when the event carried no code at all. A refusal code
with no message still produces a terminal, and a read that fails after a refusal was
captured reports the refusal rather than a generic reset. Request-log accounting is
unchanged: a row that ends on a refusal still records the transport-level status.
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
a genuine upstream reset seen while reading the stream remains synthetic 502; the
pre-header case is a different verdict and is covered by
[ambiguous connection-reset replay boundary](#ambiguous-connection-reset-replay-boundary).
An already received terminal, including
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

No wire model carries a model-specific Lite override: the retired `gpt-5.3-codex-spark` body
normalization is gone, so Lite intent is whatever the caller or configured header says. A changed
Lite identity still retires the previous socket, and subsequent eligible requests with the same
identity can reuse the new socket. Malformed native metadata retains HTTP fallback eligibility
without rewriting its body.

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

Every exchange also leaves a content-free stage record (`CodexWsStageRecord`, #4191): create-frame bytes (measured on failure only — the committed-success record keeps it null so the happy path never byte-counts a megabyte replay frame), send completion, numeric close code, elapsed and first-frame durations, frame counters, liveness ping/pong counts, pool reuse, and the OCX/Bun versions. The exchange pins the record on the resolved Response (`markCodexWsStage`, the same marker seam as `markCodexWsResponse`); `handleResponses` adopts it onto the serving attempt, and usage.jsonl persists it per attempt behind a drop-guard normalizer, so hand-edited rows cannot inject strings into the DTO. Later snapshots update the same response-local record in place, so an attempt holding the committed reference observes final success or failure counters. Each exchange supplies a complete fresh snapshot; separate responses keep distinct records. On eager-relay cancel-drain expiry, upstream cancellation finalizes the transport snapshot before the cancellation hook writes the usage row; an actual terminal observed within the drain still wins over cancellation. The record never carries conversation text, headers, close-reason text, or account identifiers, and it is not a fallback-eligibility signal: the no-replay-after-send contract stands regardless of what it says.

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

Raw SSE inspection remains upstream-first: client-facing block rewrites run after the original
bytes are observed. The Grok-only `response.created_at` and `response.completed_at` compatibility
rewrite is limited to `response.*` events with nonnegative safe integer values and leaves invalid or
byte-identical payloads unchanged.

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
`final_answer` when a terminal `done` closes the current message unless the shared stop-reason
classifier marks that reason as truncated. Normal provider reasons such as `end_turn`,
`stop_sequence`, and `tool_use` therefore remain final answers, as does an absent reason. Explicit
adapter phases always win. Streaming `output_item.added` remains unphased until that future boundary
is known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

> Decision record: [ADR-0069](../decisions/ADR-0069-chat-to-responses-message-phase-inference.md)

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` never retries on its own
account. A reset-shaped rejection is replayed only when the caller passes `replaySafe: true`,
and then up to 3 total attempts with jittered backoff, warn-logged. Without it the rejection
becomes the terminal refusal described in
[ambiguous connection-reset replay boundary](#ambiguous-connection-reset-replay-boundary).
Reusable request bytes were never the test: a string body makes a send mechanically
repeatable, not idempotent, and a model POST is not idempotent. Timeouts, aborts,
`ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never retried at all.

The opted-in callers are the sidecars, whose work is a tool call rather than a turn: the
vision describers, the web-search executors and loop, and the image loop. The model-POST
paths — native Responses passthrough, the generic adapter dispatch and its continuation loop,
compact, and native Chat — are deliberately not opted in. Adapters with their own
`fetchResponse` (kiro, cursor, google) keep their own retry policies; kiro imports the shared
abort/sleep helpers from this module.

## Console upload rejection recovery

`src/providers/opencode-zen-rate-limit.ts` recognizes the complete Console upload-rejection envelope only at the effective HTTPS opencode.ai Zen/Go generation endpoint. A provider row name cannot authorize another destination. The two recovery loops in `src/server/responses/core.ts` wait 800 ms and replay the captured serialized request once; cancellation, nonreplayable responses, other errors and a second upload rejection keep their failure semantics. The recovery kind is persisted as `console-go-upload-retry` and has a localized Logs label.

## Same-provider combo quota fallback

Native account-gated model selection maps no grant to 400, temporary capable-account exhaustion to 429, and actual credential failures to 401; Images, Live, and Search reuse this distinction. For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
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
change target order or attempt accounting; provider-400 decisions follow the [request-local target compatibility](../runtime.md#request-local-target-compatibility) contract.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Upstream key attempt accounting

Key identity is sealed at the guarded physical dispatch after queued selections are rebuilt.
Raw adapter terminal usage is recorded before continuation, search, or image loops merge it;
repeated parsing of one physical response does not count it twice. Key changes preserve the
previous attempt while retaining the active attempt object shared by streaming/combo callbacks.
Bounded failure-body observation retains reported usage and releases cloned readers on abort.
Identity and consumer aggregation follow the [account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution).

## Combo reasoning replay target eligibility

When a serving-route change leaves a tool-bearing history whose reasoning has neither plaintext nor
usable opaque content, a target that requires plaintext reasoning replay is ineligible. Failover
continues to the next target; exhausting the eligible targets returns `400 target_incompatible`.
Opaque reasoning minted by another provider or account is never forwarded, and plaintext is never
fabricated.

## Combo streaming commit boundary

An HTTP 200 does not by itself commit a streaming combo child. The combo parent runs the child's
downstream Responses SSE through `src/server/responses/combo-stream-preflight.ts`, which owns one
reader and buffers only until one of these boundaries:

- a non-control Responses event begins client-visible output or a tool/action item, after which the
  target is committed and cross-target replay is forbidden;
- a `response.failed` terminal arrives first, in which case the terminal is converted back through
  the ordinary bounded combo-failure classifier and may advance to the next declared target;
- a top-level `error` arrives before output, in which case unknown, rate-limit, and server failures
  may advance while errors explicitly classified as non-retryable 4xx remain committed;
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

Lite and routing metadata use the same suffix-normalized model object as serialization, including configured bracket-suffix removal.

## Optional client transport hints

`dropCodexSafetyBuffering` defaults to false. Canonical OpenAI forward Responses can remove only
the two safety-buffering response headers, matching response.metadata events and top-level
safety_buffering fields. Pull/eager client output boundaries compose this with policy failure
normalization; refusal/error semantics, retryability, cancellation and captured EOF errors remain
intact. Internal inspection observes original upstream frames. Native codex.response.metadata.headers
WebSocket metadata and compact are excluded. This does not disable upstream safety enforcement.

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch) privately to final dispatch; preliminary route selection does not inject Go-only headers.
Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates; account quota surfaces use [safe probe diagnostics](inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority. Raw-byte readers on this path supply their own byte and deadline budgets under the [bounded ingestion contract](inventory.md#bounded-response-ingestion-and-orcarouter-login).

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior. Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate. Unicode pattern normalization uses [copy-on-write traversal](byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

## Compaction routing overrides

`src/server/responses/compaction-routing.ts` applies `compactionRouting` before model routing in
both `request-prepare.ts` and `compact.ts`. It requires explicit `request_kind: "compaction"` in
`x-codex-turn-metadata`, supplied as a header or embedded in Responses `client_metadata`, and on
`/v1/responses` a `compaction_trigger` input item as well, so metadata alone cannot move an
ordinary turn. Every supplied metadata copy must agree, both that the request is a compaction and
on which trigger it carries; copies that name different triggers are rejected rather than reconciled.
Malformed, absent, and ordinary-turn metadata leave the request unchanged. WebSocket requests use
only per-frame metadata; handshake headers can describe an earlier request.

`compactionRouting.triggers` names the `compaction.trigger` values the override covers, drawn
from Codex's own `manual` and `auto`. Omission means `["manual"]`, so a block that does not
mention triggers routes manual `/compact` only and leaves automatic compaction exactly where it
routes today. `["auto"]` or `["manual", "auto"]` is the opt-in for #5012: an automatic
pre-sampling compaction on a routed thread otherwise stays bound to the canonical `openai`
reservation in `routeCompactionModel`, because that reservation releases only when no enabled
canonical `openai` provider exists (#2901), not when its quota is exhausted. A hand-edited
`triggers` the schema would reject disables the whole block instead of widening it, so a
malformed edit can never route more than it names.

The override changes only the model and optional reasoning effort. Existing native forwarding,
routed summaries, capability handling, and retry budgets remain authoritative; native compact
still removes reasoning before sending. Internal handoffs carry the override record (with the
conversation's source model) as a recursion guard so combo children and fallback attempts
retain their selected targets. Overrides bypass shadow interception and conversation
combo recall, and do not publish replacement combo/handoff recall. They never change the
conversation's configured model or any compaction request outside the configured triggers.

`compactionRoutingKeepsProviderIdentity` compares the source model's concrete route with the
selected route (provider name, Codex account mode and namespace; combos on either side never
match, and a bare source model the lane remembers as a combo target counts as a combo source,
recorded as `sourceCombo` when the override is applied, and a configured combo target is recorded as
`targetCombo` so its concretely routed children stay portable too). A matching identity keeps the caller's credential and may use the native compact
endpoint. A mismatch marks the credential domain as rewritten, exactly like a shadow
intercept, and forces the portable summarizer even for a native-capable target: `compact.ts`
skips `/responses/compact`, and `request-prepare.ts` sets `parsed._portableCompaction`, which
`request-sidecar-auth.ts` (`routedCompaction`) and the passthrough adapter's compaction body
build both honor for canonical ChatGPT destinations. Native ciphertext is replayable only by the
backend that minted it; the conversation model would otherwise resume with an omission marker
in place of its history.

`tests/responses/responses-compaction-override.test.ts` covers trigger selection, config validation,
native and routed handlers, same-provider credential retention, cross-provider portable summaries
and their replay, combo failover, and subsequent conversation settings.

## Core module ownership

`src/server/responses/core.ts` is the public ingress and compatibility-export surface.
The parent `src/server/responses.ts` facade retains its existing imports. Per-request execution
is composed from the following owners in `src/server/responses/`; none is a generated artifact.

| Owner | Responsibility |
| --- | --- |
| `request-prepare.ts` | Body parsing, combo handoff, final route, encrypted-task recovery and initial admission. |
| `request-transport.ts` | Live credential selection, dispatch bindings, adapter replacement and same-target request identity. |
| `request-sidecar-auth.ts` | Sidecar credential resolution and vision preprocessing. |
| `response-effects.ts` | Completion notification, replay publication and live request-tool aliases. |
| `request-send-budget.ts` | Request-wide send accounting, remaining allowance and the pending recovery permit. |
| `request-spend.ts` | This request's entries in the durable spend ledger: one per physical send, settled from the terminal usage. |
| `passthrough-execution.ts` | Native host-lease transfer and the enclosing dispatch/delivery `finally`. |
| `passthrough-dispatch.ts` | Native request preparation, upstream sends and pre-commit recovery. |
| `passthrough-delivery.ts` | Native HTTP/SSE/JSON delivery, rewrite/inspection and terminal accounting. |
| `sidecar-execution.ts` | Image/video versus web-search execution and their shared rotation hook. |
| `completion-policy.ts`, `run-turn-execution.ts` | Empty-completion eligibility and adapter-owned event turns. |
| `adapter-dispatch.ts` | Translated initial dispatch, bounded recovery and the shared continuation retry counter. |
| `adapter-continuation.ts`, `adapter-delivery.ts` | Continuation event sources and final streaming/buffered bridging. |

Reusable helpers live in `core-auth.ts`, `core-codex-account.ts`, `core-combo.ts`,
`core-combo-failure.ts`, `core-errors.ts`, `core-lifetime.ts`, `core-normalize.ts`,
`core-opaque-recovery.ts` and `core-replay.ts`. `core-options.ts` owns the public option types
and small composition contracts. Existing public helper names are re-exported by `core.ts`.
Adapter construction remains with the existing registry; `fetch-helpers.ts` remains a leaf.

Mutable values are not copied across phases. A phase exposes only the values consumed by later
phases, with getters/setters over the original local bindings where a retry or callback can
change them. Consumers receive typed `Pick` views. In particular, adapter replacement, credential
snapshots, request-tool aliases, cancellation, pending permits and continuation retry counts
remain live. Owner names are distinct from local decision variables: `admissionState` retains the
lease while a block-local `admission` holds only the acquisition result.

`handleResponses` creates or inherits the same logical-request send holder. The budget owner
reads that holder rather than minting a per-phase allowance. Combo recursion is injected through
`ResponsesDispatchers`: a child re-enters the public handler without a reverse runtime import
from the combo implementation into `core.ts`. `core-lifetime.ts` owns the shared run-turn response
marker and translator-budget finalization, so the combo and delivery paths observe one identity.

The outer admission `finally` remains in `core.ts`. Native execution explicitly transfers its
pending lease to `passthrough-execution.ts`; both owners await response construction before
cleanup. Stream body ownership, cancellation and post-commit behavior stay in the delivery owners.
This decomposition changes ownership boundaries, not credential-selection or retry policy.

`tests/responses/responses-core-modules.test.ts` covers the owner inventory, the 1,999-line ceiling,
acyclic dependencies, recursive dispatch, lease-transfer wiring, capture-name hygiene and live
send-holder/permit behavior. Cross-owner source assertions read the actual implementations via
`tests/helpers/responses-core-source.ts`; focused passthrough and subagent assertions read their
specific delivery/preparation owner. Existing runtime Lab-boundary tests still start at `core.ts`.

## Credential-hop reservations

A credential rotation inside one provider's roster reserves a hop from the request's shared send
budget before it knows whether a rotation is even possible, because the reservation is the charge:
`reserveDispatch` spends, `permit.use()` only confirms which leg sent, and `permit.release()` is
idempotent and a no-op once used. Every ladder therefore owes the budget an answer on every exit.

The hop pays for a replay that some *other* layer dispatches, so which layer settles the
reservation follows the dispatcher, not the ladder. A helper-routed replay reports the same
physical send back through `onSendsConsumed`; that is what `countedExternally: true` names, and the
reporter's first send settles the pending booking instead of adding a second charge. An adapter
that owns its transport — Kiro's reset ladder, Cursor's transport ladder, or Devin's bounded
pre-output stated-reset replay — reserves once per physical send instead, so no reporter ever
arrives. Those ladders are handed
`adapterDispatchBudget`, a live delegating view of the same budget that spends a permit passed down
through `pendingHopPermit` on the adapter's first reservation and closes the booking through
`permit.assumeCharge()`. Letting both charge is how one physical send became two charges, and how a
spent allowance answered a 429 with a synthetic error instead of the rate limit it was recovering
from (#4709).

`run-turn-execution.ts` passes the same physical-send and recovery-withheld observers used by the
request-building adapter path. Devin builds one `createAdapterPhysicalSend` for the whole
`GetChatMessage` invocation, so its initial POST and at most two same-target replays report ordinals
1, 2, and 3. The outer runTurn attempt already records ordinal 1, and the shared observer therefore
adds only ordinals above 1 to `sendCount`; the execution budget still reserves every ordinal. A
replay reserves only after its server-stated wait. If admission is refused, no inference I/O occurs,
`retry-send-budget` is recorded, and the preceding provider 429 remains the returned error.

Confirmation happens at the dispatch boundary rather than at the rotation. `adapter-dispatch.ts`
passes an `onDispatch` callback that the rebuild invokes immediately before the wire, and skips it
when the adapter owns dispatch: settling there first would hand that adapter a dead permit, which
it reads as an exhausted request and stops sending on. `adapter-continuation.ts` never confirms,
because its replay is the next loop iteration. `run-turn-execution.ts` always hands the reservation
down, because a runTurn adapter is by definition the layer that sends. The passthrough ladder keeps
the shape it already had: reserve with `countedExternally: true` and pass the permit to the rebuild.

An explicit provider `transientRetryOn5xx.attempts` value is the exact physical-send total for that
request. Once spent, a passthrough rebuild receives no final-recovery reserve and returns the
original upstream response. The guarded profile's shared reserve remains available only when the
provider leaves that transient policy unconfigured; its existing hop-permit settlement is unchanged.

What must not happen is a ladder that charges and then returns through a path that neither confirms
nor releases. That is not a lost send; it is a send the request never made, spending an allowance a
later recovery in the same request then cannot have. `tests/lib/execution-budget-permits.test.ts`
pins the settlement rule and every ladder shape against exactly that, and
`tests/responses/responses-core-modules.test.ts` pins the adapter view's live delegation.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

A combo derives a policy scope per target, and that derivation has to happen inside the budget
factory. Overriding the public `used` property shares only what callers read from outside:
`remainingBaseSends`, the total check and the reserve test all consult the factory's own private
counter, which an overridden property cannot reach. Each derived scope therefore admitted
dispatches as though the request had spent nothing, and the per-target holdback in
`comboTargetSendBudget` — expressed against `maxTotalModelSends` — had nothing to hold back from,
so a long failover combo could exhaust the allowance before its later declared targets were ever
attempted. `deriveRequestExecutionBudget` binds the scope to the parent's real ledger instead.

Three things travel on that shared ledger and have to travel together. The spend and the pending
externally-counted bookings, because a pending booking is a send already counted in the total and
waiting for its reporter, so sharing one without the other would either charge that send twice or
never charge it. And the durable-spend observer below, because it books by watching this counter
move: a derived scope that spent the counter without carrying the observer would move it without
booking, and a combo child's sends would go missing from the ledger. `permit.assumeCharge()`
closes its booking on the same shared ledger, so the adapter handoff above and the combo
derivation agree rather than each settling against a counter the other cannot see.

What stays per-scope is deliberate: the reserve, alternate-target and transition ledgers are each
target's own recovery decision, while the physical-send total is what binds every target together.

## Durable spend reservations

The request's send budget bounds how many times it may reach upstream; the spend ledger bounds
what those sends may cost, and it is the only bound here that survives a restart. Its production
caller is `request-spend.ts`, installed on the execution budget at genuine ingress in `core.ts`
and parked on the log context so `addFinalRequestLog` can settle it.

It books by observing the budget's own send counter rather than by being called from each
dispatch site. That counter moves exactly once per physical send — a reservation increments it, a
refund decrements it, and an externally reported send settles against a booking already counted —
so one ledger entry per increment is one entry per send, and a dispatch path added later cannot
forget to book. The previous attempt at this wiring shipped the whole reserve/dispatch/settle
vocabulary with no caller at all (#4707), which is the failure mode this shape rules out.

A booking is confirmed dispatched only once a LATER send exists, because that later send proves
the earlier one left. The newest booking stays open, so a reservation the budget hands back
during this process's lifetime can still be released for free.

Settlement follows what the request learned. The terminal usage belongs to the last send that
left, so that one settles with the real figure; every earlier send failed without reporting usage
of its own and may still have been billed, so it becomes unresolved spend rather than free. A
request that reports no usage at all leaves all of them unresolved.

Replay resolves what nobody is left to settle, and resolves it as unresolved spend whatever state
it was in. Giving an undispatched one its tokens back would assume the journal is complete up to
the crash, and the torn-tail rule says it is not: a send can dispatch and die before its dispatch
record lands. It would also reset a ceiling that had already fired, and an exhausted scope
staying exhausted across a restart is the whole reason this store is on disk. Both are journaled,
so a second restart has nothing to redo.
`tests/responses/responses-spend-ledger-wiring.test.ts` pins the
booking, the settlement split, the refund, a ceiling that refuses a dispatch rather than
describing it afterwards, and the restart.

The default policy still sets no token ceiling on any scope, so an unconfigured install accounts
and reports without refusing. An operator turns enforcement on with the `spend` section in
config.json, which `src/lib/spend-reservation-ledger.ts` resolves through
`spendPolicyFromConfig` and applies with `configureSharedSpendLedger` at startup. There is no
default figure and there deliberately never will be: this ledger is on and journaling by
default, so a shipped ceiling would start refusing real traffic on the first upgrade that ran
it, against a number nobody chose. Absent, empty and all-scopes-absent sections are the same
thing -- observe only.

The shared journal has one live writer per state directory. `startServer` acquires the
`src/lib/spend-ledger-owner.ts` SQLite lease before configuration and before any listener binds;
`sharedSpendLedger` asserts that lease before construction because replay can append `lost`
records, and `configureSharedSpendLedger` asserts it before changing a live singleton. This applies
identically with and without configured ceilings: observe-only still appends, settles and compacts.
Two servers in one process and one directory share a reference-counted lease; that process cannot
hold two directories at once. Sequential ownership is allowed and concurrent ownership is not:
releasing the final reference discards the singleton, so a later directory replays its own
journal instead of inheriting figures. A ledger records the ownership it was built under and
proves that exact identity on every accounting read and change, so a handle kept across a release
and a reacquire of the same directory is refused rather than resuming over writes another owner
may have made. File-backed journal and salt writers are owner-bound at construction, and a
directory entry that is a link -- including one whose target does not exist -- is refused instead
of followed. A separate process may use a separate directory. SQLite crash release permits the
next owner without stale-PID or TTL reclamation.

The journal survives an ordinary process restart once its writes reached the filesystem. It does
not claim host power-loss durability: the append path does not fsync each record, so power loss can
drop recently acknowledged filesystem writes. A torn final line remains the only replay corruption
that may be discarded quietly.

Applying a policy to a ledger that already exists reconfigures it rather than rebuilding it.
Every figure already accounted survives, so raising, lowering or clearing a ceiling changes what
is refused from here on and never what was spent. A rebuild would replay the journal into a
second set of maps while the first still held this process's open reservations, and the two
would then disagree about what is in flight.

With a ceiling configured, three places can refuse and they are ordered cheapest first. HTTP
admission refuses a root scope that is ALREADY spent, before the body is parsed, because that
question needs no token count; the pre-dispatch check in `createResponsesSendBudget` asks the
same question beside the existing send-count one; and the reservation itself refuses the send
that would CROSS a ceiling, which is the only one of the three that can see the identity and
pool scopes, since neither is known until routing picks an account. Count caps and token
ceilings are an intersection: a request passes only when every count and every ceiling admits
it, a count denial is decided before any reservation is booked, and a token denial before any
count is charged, so neither leaves the other's accounting to unwind.

## What a spent budget tells the client

A refusal this proxy made is reported as HTTP 429 with the code `request_send_budget_exhausted`,
on every dispatch path. The three paths used to disagree: passthrough answered 429 and declined
to blame the provider, the adapter paths fell through `describeUpstreamConnectFailure` and
answered 502 "Provider unreachable", and runTurn pushed an unstructured message that was inferred
back to 502 under HTTP 200.

The status is the load-bearing half. The Codex client retries 5xx and does not retry a direct
429, so reporting a local refusal as 502 makes the caller send the whole turn again — the
amplification the budget exists to stop. Encoding it as a quota code instead would stop the
client for the wrong stated reason, and the retryable streaming rate-limit codes would restart
the stream, so neither is available.

The distinct code is what an operator reads afterwards. `classifyError` keeps it by matching the
supplied type rather than the status, so an upstream 429 still classifies as
`rate_limit_exceeded` and only this proxy's own refusal carries the other code. Once a response
is committed the refusal travels as a structured terminal event — status, `errorType` and
`code` on the event itself — because an unstructured message is inferred back to 502.

A local 429 must not look like a provider one to our own routing. `rotateRunTurnAdapterOnPreflight429`
returns early on the code, before it reads the status, so a refusal cannot rotate a credential or
write a cooldown against an account that rate-limited nothing; that fake signal would outlive the
request and misroute later ones. The terminal-guard continuation loop now consults
`sendBudgetExhausted()` before it cancels the upstream body, matching the main recovery loop, so
a spent request keeps the real 429 instead of replaying on a live stream.

This is the proxy's own accounting only. Classifying an upstream 429 as org or project spend
exhaustion is a separate contract with a separate owner.
Adapter-owned retries enter the same pending dispatch metadata path as initial key sends.
The actual dispatch commits their count and recovery label once; unsent pending metadata
is discarded on process exit and is not usage evidence. See [key attribution](../gui-and-management-api.md#upstream-key-account-attribution).
Generic refetches record metadata inside each admitted retry callback, retaining the
transient recovery reason when present and otherwise the outer recovery reason.

## Ambiguous connection-reset replay boundary

Three failures look alike from the outside — the turn may have executed and we cannot
prove otherwise — and they are answered differently, because the status is an instruction
to the client and the client obeys it. Codex builds its retry policy from
`ApiRetryConfig { retry_429: false, retry_5xx: true, max_attempts: request_max_retries() }`
with `DEFAULT_REQUEST_MAX_RETRIES = 4`. A 5xx is therefore an invitation to send the whole
turn up to four more times, and a 429 is where the client stops.

**A pre-header fetch rejection this proxy refuses to replay is a refusal this proxy made.**
`src/lib/upstream-retry.ts` returns a marked **429** carrying its own code,
`upstream_reset_replay_refused`. No response headers is not evidence that the model POST
was never processed, so the decision not to replay is ours, made before any response
existed — the same shape as `request_send_budget_exhausted`, and it takes the same status
for the same reason. Only an explicitly replay-safe operation opts into reset retries.

**An upstream reset observed mid-stream or after a terminal keeps its existing behaviour.**
The passthrough read path still settles a genuine upstream reset as a synthetic 502, and the
Codex WebSocket transport still settles `upstream_closed_before_response` (socket closed
after the create frame) and `upstream_no_response` (origin never produced an event) as 502
and 504. Those describe something the upstream did after our send, they are the contract the
public server reference already documents, and this release does not move them.

This reclassification is the recorded behaviour change: before it, the pre-header refusal
borrowed `upstream_closed_before_response` and its 502, which multiplied the duplicate send
the refusal exists to prevent. The distinct code is what keeps the two separable afterwards —
both are non-replayable, but only one is ours to restate.

Because the refusal now carries 429, a 429 is no longer sufficient evidence of a provider
rate limit. Every same-target replay, key rotation, account rotation and pool-quota recorder
that keys on 429 first asks `isNonReplayableResponse`:
`src/server/responses/adapter-dispatch.ts`, `src/server/responses/adapter-continuation.ts`,
`src/server/responses/passthrough-dispatch.ts`, `src/server/responses/compact.ts` and
`src/server/chat-native.ts`. Compact additionally records the transport outcome rather than
the client-facing status, so pool health sees exactly what it saw before the correction.
Rotating on a synthetic 429 would both re-send an inference that may already have run and
write a cooldown against a credential that refused nothing — a false signal that outlives the
request, which is the same hazard `rotateRunTurnAdapterOnPreflight429` already guards for the
send budget.

In `adapter-dispatch.ts` the guard at the top of the recovery loop is necessary and was not
sufficient. The refusal can also be produced by a refetch made INSIDE an arm, and that arm
then still holds it: the same-target loop re-enters while `rateLimitRetries` is below the
configured attempts, and the key, Anthropic-pool and generic-OAuth rotations re-enter while a
credential is left to try. The key-401 arm is in the same class from the other direction — its
refetch answers 429 and it falls through into the arms below. So every arm that reassigns
`upstreamResponse` from `rebuildAndRefetch` re-enters the loop guard rather than continuing,
which is what makes the top-of-loop check the single exit for this verdict.

**A refusal this proxy made never acquires a `Retry-After` and never becomes quota evidence.**
Guarding the ten call sites that READ 429 as a rate limit left the sites that WRITE evidence,
synthesize a wait, or re-classify the status on the way out. `isNonReplayableResponse` is the
wrong question for those, because it also covers the WebSocket post-send verdicts, which are
genuine upstream observations; the question is whether any upstream produced this status at
all. `isReplayRefusalResponse` in `src/lib/upstream-retry.ts` answers exactly that, applied
where the refusal is synthesized and reapplied by `src/bridge/errors.ts` when the formatter
re-wraps it after combo failure consumption. Three writers consult it or the code:
`src/server/responses/passthrough-delivery.ts` skips `recordCodexUpstreamOutcome`, which would
otherwise classify the synthetic 429 as quota exhaustion and cool the account;
`src/server/responses/passthrough-error.ts` suppresses the retryable-429 default and drops any
inherited header, taking provenance from the caller that still holds the response and falling
back to the code in the body — provenance is not optional there, because the bounded read
answers with an empty string for anything not display-safe and an empty body is exactly what
the default fires on; and `src/server/chat-native.ts` restores the code its own classifier overwrote —
429 maps to `rate_limit_error`, which already carries a code, so the branch that copies an
upstream code could never reach it — and suppresses the same synthetic wait.

The existing provider HTTP-status policy and the shared physical-send budget remain
independent: zero refuses dispatch, invalid counts fail, and a stopped send is counted once.
`src/bridge/errors.ts` retains only the allowlisted non-replayable transport codes,
reapplies the in-process marker, attaches no `Retry-After`, and restates 429 for the refusal
code alone so a combo or adapter formatter holding an upstream-shaped 502 cannot hand the
client back a retryable status. Other upstream codes keep the existing classification;
cyber-policy hard blocks retain precedence. The helper, formatter and public Responses count
regressions live in `tests/lib/upstream-retry.test.ts`,
`tests/responses/responses-send-budget-counts.test.ts` and
`tests/codex-integration/reserve-dispatch.test.ts`. The three write-side paths are pinned
separately: a second armed same-target attempt in
`tests/responses/responses-send-budget-counts.test.ts`, the absent cooldown and absent
`Retry-After` on a Codex pool account in `tests/responses/responses-account-label.test.ts`,
the formatter in `tests/server/retry-after-429.test.ts`, and the native Chat classification in
`tests/providers/upstream-transient-retry.test.ts`.

## Combo output headroom

A combo child is admitted against two budgets, not one. `resolveInputCeiling` in
`src/server/responses/input-admission.ts` answers "how much input may this target take", which
`modelMaxInputTokens` can tighten below the window. The context window itself is what input and
output actually share. When the caller declared `max_output_tokens`,
`checkComboTargetInputAdmission` requires both `estimated input <= ceiling` and
`estimated input + min(declared output, target output ceiling) <= window`, so the output reserve
is counted once rather than charged twice against an already-tightened input budget.

The refusal is local: HTTP 413 `input_admission_refused` before any upstream bytes are sent, which
existing combo policy already treats as a safe hop. That ordering is the whole point. A target whose
total window cannot hold the turn plus the caller's allowance answers 200, emits a few hundred
tokens and stops on `finish_reason: length`, which the Anthropic surface renders as an output-token
error naming a limit the model never approached — and by then output has committed and no later
target may be tried.

Scope is deliberately narrow. Direct and single-target requests keep the loose 2.5x
pathological-input gate, because they have nowhere to hop. Compaction turns stay exempt. Unknown
context and a caller that declared no output allowance both remain fail-open, so this invents no
limits for custom providers. Canonical native slugs that the narrower pinned table does not carry
resolve their window from the generated in-tree bundle, which is what made the gate inert on the
route where this was first observed; explicit provider and operator caps may only narrow it.

Regression coverage: `tests/server/input-admission.test.ts` and
`tests/helpers/combo-context-headroom-cases.ts`.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).
