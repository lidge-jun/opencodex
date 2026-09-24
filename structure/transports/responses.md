# Responses Transport

Native result continuations and function-result injection follow [the mode-specific result and control contract](streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Management provider-validation calls use the [initialization-independent relative send-path validation](../config.md#provider-relative-send-paths) before persistence. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

Plaintext collaboration restoration treats a null namespace as absent, rejects non-string namespace types, and restores the native namespace/name pair before HTTP/WS delivery and continuation publication.
When a successful streamed native response has a missing or unrecognized non-JSON content type, the plaintext V2 path confirms a bounded Responses SSE prefix, under the server's `stallTimeoutSec` probe budget, before applying that restoration; an `application/json` body takes the bounded JSON path instead, and an unknown, stalled, or unreadable body retains the fail-closed response.

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

#### Schema-bound flat shell repair

Completed Responses function calls have one separate schema-bound flat-shell repair. When the
exact bare `exec_command` declaration requires a string `cmd`, a provider result containing only
the string member `{ "input": "..." }` is rewritten to `{ "cmd": "..." }`; the call name is not
changed. Namespaced tools, additional or conflicting members, non-string values, malformed JSON,
partial streaming previews, and schemas that do not prove this exact contract remain byte-exact.

> Decision record: [ADR-0098](../decisions/ADR-0098-schema-bound-exec-command-input-repair.md)

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

Anthropic Fast eligibility and downgrade recovery use the [Responses failover contract](responses-failover.md#anthropic-fast-downgrade-recovery).

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

For replayed `encrypted_content` slots whose minting provenance is unavailable after a restart or
full-history resend, the plaintext-compatibility boundary requires canonical key-independent Fernet
structure (version byte, timestamp, IV, block-aligned ciphertext and HMAC layout). A long
base64-like agent message does not gain ciphertext authority from its spelling. Structure is not
authentication: it is only the minimum legacy fallback needed to avoid corrupting genuine opaque
history. If the canonical backend still rejects an encrypted function or agent output, the exact
decrypt/decode identity enters one request-budgeted sanitize-and-rebuild attempt for HTTP and
pre-commit SSE/WebSocket terminal envelopes; the single-shot guard remains armed on the rebuilt
send.

> Decision record: [ADR-5236](../decisions/ADR-5236-responses-http-sse.md)

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
specified in [uploaded-file account retention](../providers/openai-accounts.md#uploaded-file-account-retention);
it reduces how often this refusal fires and does not replace it, because the issuing account can
always become unable to serve.

> Decision record: [ADR-0039](../decisions/ADR-0039-responses-http-sse.md)


## Core module ownership

`src/server/responses/core.ts` is the public ingress and compatibility-export surface.
The parent `src/server/responses.ts` facade retains its existing imports. Per-request execution
is composed from the following owners in `src/server/responses/`; none is a generated artifact.

| Owner | Responsibility |
| --- | --- |
| `request-prepare.ts` | Body parsing, combo handoff, final route, encrypted-task recovery and initial admission. |
| `shadow-target-availability.ts` | Shadow-call target resolution for `request-prepare.ts`: an unavailable target fails once with `409 intercept_target_unavailable` instead of reaching the native source model or the default provider. |
| `request-transport.ts` | Live credential selection, dispatch bindings, adapter replacement and same-target request identity. |
| `request-sidecar-auth.ts` | Sidecar credential resolution and vision preprocessing. |
| `response-effects.ts` | Completion notification, replay publication and live request-tool aliases. |
| `request-send-budget.ts` | Request-wide send accounting, remaining allowance, the pending recovery permit and the shared ambiguous-resend grant. |
| `reset-replay.ts` | The operator opt-in for replacing an ambiguous native Responses send, and the per-request grant both stages claim from. |
| `request-spend.ts` | This request's entries in the durable spend ledger: one per physical send, settled from the terminal usage. |
| `passthrough-execution.ts` | Native host-lease transfer and the enclosing dispatch/delivery `finally`. |
| `passthrough-dispatch.ts` | Native request preparation, upstream sends and pre-commit recovery. |
| `passthrough-delivery.ts` | Native HTTP/SSE/JSON delivery, rewrite/inspection, terminal accounting, and xAI tool-envelope filtering before continuation storage. |
| `policy-refusal.ts` | Rewrites an allowlisted non-combo HTTP 403 model refusal (`isUpstreamPolicyRefusal` in `src/lib/errors.ts`) from an xAI destination only (`isXaiResponsesDestination`: api.x.ai or the Grok CLI proxy, on either wire) to an HTTP 200 Responses `incomplete` / `content_filter` payload, JSON or SSE, for both `adapter-dispatch.ts` and `passthrough-delivery.ts`. A streamed rewrite takes the turn admission lease and releases it when the body finishes, so the refusal stays inside active-turn accounting. Combo attempts keep the original 403 so failover classifies it as a hop. |
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

## Adapter-to-Responses bridge

`src/bridge.ts` is a re-export facade; the implementation lives in `src/bridge/`.
`src/bridge/sse.ts` (`bridgeToResponsesSSE`) turns adapter events into the Responses SSE stream,
and `src/bridge/response-json.ts` (`buildResponseJSON`) builds the non-streaming Responses body
from the same events. `src/bridge/errors.ts` (`formatErrorResponse`) formats error responses and
keeps only allowlisted transport verdict codes. Adapter error events take a different path:
`src/bridge/internal.ts` carries an event's own `code` into the SSE and JSON failure, after
mapping cyber-policy codes to HTTP 400. The same file holds the shared usage shaping; `input_tokens_details` and
`output_tokens_details` are always emitted, with zero defaults, because strict Responses clients
deserialize them as required fields.


Active-turn admission owns workflow admission, so both remain held until a streaming body finishes or
is cancelled.

The shared endpoint path also preserves the cyber-policy stop when a malformed UTF-8 5xx body is
replacement-decoded; other malformed-body usage, quota, reset evidence and classification retain the
status-only fallback. Rebuilt failures remain non-replayable and cyber-policy failures carry neither
`Retry-After` nor quota-reset metadata. The [Responses failover contract](responses-failover.md)
owns the bounded recovery and replay decisions.
