# Responses Transport
WorkBuddy AI carries account-bound identity through initial dispatch and renewal under the [WorkBuddy contract](../providers/workbuddy.md).
Native result continuations and function-result injection follow [the mode-specific result and control contract](streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages) is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Management provider-validation calls use the [initialization-independent relative send-path validation](../config.md#provider-relative-send-paths) before persistence. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

Plaintext collaboration restoration treats a null namespace as absent, rejects non-string namespace types, and restores the native namespace/name pair before HTTP/WS delivery and continuation publication.
When a successful streamed native response has a missing or unrecognized non-JSON content type, the plaintext V2 path confirms a bounded Responses SSE prefix, under the server's `stallTimeoutSec` probe budget, before applying that restoration; an `application/json` body takes the bounded JSON path instead, and an unknown, stalled, or unreadable body retains the fail-closed response. The [structural turn replay membership contract](response-turn-membership.md) owns optional authenticated pre-parser ordering; ordinary input remains unchanged.

## Responses HTTP/SSE

See [local timeout policy and OpenCode export](timeouts.md). HTTP ingress applies the [caller header contract](../data-planes/inbound-compat.md#http-caller-conversation-identity) before admission and dispatch. Optional Codex memory selection enters `src/server/responses/request-prepare.ts` for HTTP and WebSocket frames, as specified in [memory phase routing](responses-failover.md#memory-phase-routing); an unset phase keeps its existing route and starts no background work. Responses request preparation stabilizes incoming `<skills_instructions>` under `skills.catalog_refresh`: `per_session` (default) reuses the first received catalog for a conversation; `per_turn` leaves the supplied catalog unchanged. Other instruction sections and user/tool content remain untouched. Requests without a reliable conversation identity bypass snapshots; shared prompt-cache cohorts are not conversation identities. Only a body with exactly one catalog block across its instructions and developer/system content takes part; two or more pass through unchanged. A known snapshot is substituted before parsing, but a new catalog is stored only when preparation reaches its success return, so a request rejected by parsing or admission pins nothing. Without a named principal, snapshots are shared by conversation id only on a server that requires no data-plane auth. Snapshots are process-local, expire after four idle hours, and use bounded LRU retention; oversized blocks bypass caching. The dashboard's `src/codex/prompt-layers.ts` and `src/codex/prompt-text-probe.ts` continue observing current files for previews and do not own session snapshots.
`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output. Every Responses serializer projects unreferenced hosted-search history when the final body declares no hosted search tool; with search declared, the canonical Codex ordinary serializer retains structural hosted history by default, and only selected-provider `projectResponsesLiteHostedSearchHistory === true` plus exact canonical `/responses` and explicit Lite intent enables model-independent projection under the [hosted-search history boundary](../providers-and-adapters.md#hosted-search-continuation-binding), shared by HTTP/SSE and WS. The routed provider name follows every adapter build, including retries and continuations; only `github-copilot` injects a configured `modelContextTiers` value as upstream `contextTier`, while unconfigured passthrough retains the caller field. For an opted-in key-auth provider, a hosted-search continuation stays bound to the API-key selection that served the first leg; the contract is the [hosted-search continuation binding](../providers-and-adapters.md#hosted-search-continuation-binding). The native passthrough undeclared-tool guard fails closed on the Responses inbound wire in SSE and buffered JSON before continuation state is stored. Chat and Anthropic inbounds defer to the caller's own registry except an explicit empty catalog; the [declared-tool contract](responses-wire-shapes.md#declared-tool-membership-by-inbound-wire) also covers managed native, translated, directly encoded, and final media output while preserving internal hosted operations. GitHub Copilot Auto admission rechecks the negotiated provider/model against the key scope captured at request admission (a key edited or removed mid-request cannot widen it) before route mutation or dispatch, on initial and renewal negotiation; denial returns the standard `model_not_allowed_for_key` 403 naming the caller's inbound selector without disclosing the destination. The web-search and image sidecars answer a denial during their credential rotation with that 403 instead of the original 429, and a combo child's denial keeps the same envelope. Local model-scope refusals are non-replayable. A denial during Copilot dispatch renewal propagates as an admission exception to the request boundary, never as a provider fetch response; account recovery and combo/policy fallback cannot continue after that denial. A committed continuation, including OAuth account rotation after a 429, emits the same refusal type in-stream without dispatching another inference; ordinary negotiation failures still preserve the original provider refusal.

The `openai-responses` adapter preserves caller `User-Agent` unless provider headers own it, in either auth mode.
`forwardClientHeaders` additionally opts into `originator`, `x-client-request-id`, `x-codex-app-version`, or `user-agent`.
Provider headers win case-insensitively; arbitrary names are rejected on load/write and ignored at runtime.
Canonical forward auth retains its separate fixed credential/metadata allowlist; absent caller identity is not invented. Upstream WebSocket reasoning-inclusion headers follow the [native prelude and connection-signal contract](responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

Retired Codex Spark has no model-specific tool or Responses Lite override; general Lite handling and
namespace scrubbing remain shared compatibility behavior. Codex quota/reset evidence follows the
[shared/Reserve policy](../providers/openai-tiers.md#public-provider-contract), including suppression of retired model-derived evidence before shared recovery. Plain-main HTTP/WS quota headers refresh `__main__` only on the canonical OpenAI forward provider when the materialized bearer and workspace match the owned main observation, using the hard-lock credential-match rule. `src/server/responses/passthrough-delivery.ts` captures the response-arrival dispatch before any await and keeps that proof for the arrival headers across body classification and deferred replacement, rechecking its credential generation after the awaited import; `src/server/responses/core-codex-account.ts` renews a live dispatch object for each WS observer without recapturing its credential or config fences, retains that copy across frames, and rechecks it for each frame. Rotated credentials and unmatched workspaces publish nothing; dispatch proofs also reject any OpenCodex-owned credential publication epoch change, including native main refresh or same-account reauth before quota re-observation; each plain-main WS observer invocation claims its captured dispatch before liveness checks, and this claim is the authoritative HTTP publication guard across Response replacement; WS upstream responses and separately marked pre-response prelude projections (4xx refusals and 502/504 gateway failures) skip plain-main HTTP quota writes; prelude headers remain available to Pool replay, real HTTP fallbacks still publish; each operator-granted HTTP replacement renews the dispatch object with its original credential and config fences unchanged, and Pool health/failover gates remain unchanged.

### Passthrough message phase inference

Opt-in `messagePhaseInference` gives native passthrough Responses streams the commentary/final_answer semantics the Chat bridge owns under [ADR-0069](../decisions/ADR-0069-chat-to-responses-message-phase-inference.md). The block rewrite in `src/server/responses-phase-inference.ts`, wired through the `src/server/responses/passthrough-delivery.ts` chain, retains each completed message whose phase is missing, null, or not commentary/final_answer until the next typed protocol event: a following tool call, reasoning, or message classifies it as commentary; a terminal event or `[DONE]` classifies it as final_answer. Text deltas keep streaming, but completion may wait for that next event. Explicitly phased messages forward immediately; keepalives and unparseable blocks pass through without consuming the pending decision. Valid explicit phases are retained like inferred ones. Each decision is keyed by item id and by `output_index`; completed and incomplete snapshots fill absent phases from the decision with the same id, or from the decision at the same output position when the event or the snapshot item has no id, so an item-done event and its snapshot entry never disagree. Unmatched items, including a different id at a known position, fall back to final_answer; explicit snapshot phases take precedence even when they disagree with an earlier event. Failed terminal bodies remain unchanged. The pending block and per-id decisions are charged to the request's translator budget; overflow fails through the shared buffer-limit error. State is released on every terminal event, `[DONE]`, rewrite failure, and relay teardown (`tests/responses/responses-phase-inference.test.ts`). The same client rewrite chain also runs when upstream SSE is reconstructed into a buffered JSON response; ordinary upstream JSON is not phase-rewritten.

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
Explicitly opted-in first-party DeepSeek image replay uses `src/server/responses/deepseek-image-files.ts` during credential-bound construction; see the [image byte contract](byte-accounting.md#deepseek-image-replay). Token usage, client compaction and inference dispatch fences are preserved.
`src/server/responses/fetch-helpers.ts` is a transport leaf shared by Responses, compact, and native
Chat. Its runtime imports are limited to the Codex WebSocket transport, provider request pacing, and
the upstream HTTP-version helper, and core-owned admission-deadline metadata. Provider-local recovery queues share `src/lib/provider-admission-wait.ts`: local waiting retains client cancellation while pausing the upstream header timer, which restarts before dispatch. Server, provider, and WebSocket data types remain type-only edges. Opt-in `codexWsReuseAcrossTurns` (default off) in `src/server/responses/codex-ws-pool.ts` keeps a socket for an account and thread across turns, waits at most 750ms for a busy socket before dialing another, and leaves `x-codex-turn-state` / `x-codex-turn-metadata` on each frame.
Account refusal observers are injected by the calling transport owner and captured before the physical send; their wrapper forwards replacement pacing admission to the physical dispatch owner. It must not import routing, combos, OAuth, adapters, sidecars, response parsing, logging, or relay
modules merely because those imports existed in the pre-split `responses.ts` monolith.

`OCX_FRESH_CONNECTION_HOSTS` accepts comma-separated hostnames whose outbound HTTP sends bypass
keep-alive reuse with `Connection: close` and `keepalive: false`; exact hosts and their subdomains
match case-insensitively. `sendWithConnectionPolicy` applies the policy around the fetch that
performs the physical send, after a dispatch override has selected or rebuilt the destination, so
matching follows the URL sent on the wire rather than the URL supplied before credential
revalidation; prepaid initial-send receipts follow the [spend contract](responses-spend.md#prepaid-initial-sends). At this final HTTP boundary, native ChatGPT Responses and compact JSON strings of at least 1 MiB (UTF-8) become byte buffers to avoid Bun's large-string upload resets. Content, headers, abort signals and retry policy are preserved; WebSocket selection still receives the original string. Other destinations, small strings and existing byte/stream bodies retain their representation. The one exception is the opt-in `upstreamRequestCompression` (`"gzip"` / `"zstd"`, #7247), owned by `src/server/responses/request-compression.ts`. When set, the same canonical destinations' string bodies from 1 KiB to 16 MiB are compressed at this boundary instead: the send's private header copy gains `Content-Encoding` and loses any stale `Content-Length`, and the body becomes the coded bytes. Gzip uses native `Bun.gzipSync` on the original string at level 1 and returns an ArrayBuffer-backed Buffer view of its output; zstd keeps its level-3 UTF-8-buffer path. Each send owns independent coded bytes, with allocation details in the [request-copy contract](byte-accounting.md#request-copy-accounting). A body that already declares a coding, a non-string body (so a nested pass never codes twice), any other destination, a plugin rewrite away from `chatgpt.com`, and a codec failure all fall through to the representation above. Compression is synchronous so no await separates dispatch admission and the receipt from the physical send; the 16 MiB ceiling bounds the event-loop block. The setting is read per send from the live server config object, which `setLiveStateStoreConfig` installs at startup; detached configs never bind it. Direct-fetch sends that bypass this boundary (`agent-task-recovery.ts`, `codex/warmup.ts`) stay uncompressed.

Opt-in per-key pacing and round-robin use HTTP/SSE so their final dispatch override cannot be bypassed by a WebSocket upgrade. An unpaced WebSocket send still runs the dispatch override, so a key-auth frame is committed to its attempt row and rebinds the send budget; the override hands the marked WS executor its send directly instead of the HTTP connection policy, and the HTTP fallback inside that exchange does not run the override a second time. Transport-owned response markers and stage metadata survive owned pacing body rewraps. Replacement-key pacing admission retains client cancellation but pauses the header deadline; the full header interval restarts after admission. The wrapped executor alone is not that boundary. An override that revalidates credentials re-reads
`route.provider.fetch` at send time, because reselection can install a different provider transport
after the wrapper was built, and then calls that implementation instead of the executor. Both
production overrides do this -- `oauthDispatch` in `request-transport.ts`, native Chat in
`chat-native.ts`, native Messages and keyed compact -- so they wrap the selected implementation rather
than choosing between policy and provider transport. Reporting the executor as the boundary while
the code let a provider-scoped transport past it is what #4992 recorded, and it is why a
regression for this policy has to enter through `handleResponses` rather than through a
hand-written override that cooperates by calling the executor it was handed.

`src/server/responses/sidecar-execution.ts` owns search probe settlement: local validation releases immediately, bodyless responses release before returning, and upstream bodies retain the lease through completion, error or cancellation regardless of HTTP status. The core dispatcher does not infer body completion from a non-success status. A provider input overflow behind the web-search or image sidecar ends the turn the way the main path does (#7316). `isSidecarContextOverflow` in `src/server/responses/context-overflow.ts` classifies an HTTP 413 by status, a 400/422 only on definite overflow wording that is not rate-window wording, and an adapter's own `context_length_exceeded` code, while a non-replayable failure and an upstream `rate_limit_exceeded` code keep their own failure. The loops tag a first-iteration failure that qualifies, and `sidecar-execution.ts` maps a tagged failure to `streamingContextOverflowResponse`/`jsonContextOverflowResponse` with the proxy-owned message, except for combo attempts, whose raw failure feeds `comboFailureDecision` and the combo layer's own 413 mapping. Both loops end a later iteration's overflow with `sidecarContextOverflowEvent`: a 413 without overflow wording gets the proxy message, while a worded verdict keeps its status and wording because combo stream preflight reads them to decide whether a larger-context target may still serve the turn (`tests/responses/responses-sidecar-context-overflow.test.ts`, `tests/web-search/web-search-loop-error-usage.test.ts`, `tests/images/loop.test.ts`). An adapter-raised `translation_buffer_limit` terminal keeps the usage it carried on `response.failed` and reports it once through `onUsage` (`tests/adapters/translator-budget.test.ts`).

### Semantic progress ownership

The Responses proxy does not treat transcript growth as repository progress. It can observe request
boundaries, response items, tool names and payloads, adapter events, retained bytes, and elapsed
silence. It cannot observe the client's workspace or prove whether a successful tool result changed
repository state. Consequently, the active-turn and session-lane gates are concurrency admission
limits, the translator budget follows [live retained-byte ownership](byte-accounting.md#stream-buffer-accounting), the response-state caps are cache
retention limits, and the stall watchdog is a silence limit. None is a cumulative continuation or
semantic no-progress budget. The turn lease in `src/server/lifecycle.ts` subscribes to HTTP ingress cancellation, internal decision cancellation and every registered controller. Cancellation snapshots only that turn's controllers, releases its admission, session-lane reference, attached workflow leases and native-main ownership, then aborts the snapshot with the cancellation reason. It does not await upstream work or owner finalization, even when the owner remains suspended; other turns retain their controllers and admission. Late controllers abort immediately without registering or transferring ownership, and cancelled selections cannot claim a native-main account. Live/Realtime acquisition binds ingress cancellation until WebSocket upgrade transfers ownership. Normal controller completion detaches only that controller and its listener; the last owner or an explicit parent release settles the lease. A completed combo relay cannot retire its parent WebSocket turn or cancel the next attempt, and a completed child's late abort cannot cancel former siblings. Late finalizers remain idempotent. `tests/codex-integration/active-registry-admission.test.ts` covers these shared-owner boundaries. `tests/codex-integration/active-turn-disconnect.test.ts` covers these cancellation and ownership boundaries.

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
restoration stamped with a private `namespace`. Routed compaction runs this boundary before applying
the summary tool policy so request-local aliases remain available for response restoration. Only
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
discarded to manufacture a bare name. Meta Responses also applies [tool-selection compatibility](../providers-and-adapters.md#meta-responses-tool-selection).

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
object HOLDS until it closes, because a key that has not arrived yet can still change the
answer. Fallback fields decide at that close rather than from a parse: they only unwrap as the
single string field, so the scan keeps a last-wins table of the members it already walked and
consults it once — one string fallback field releases its value as `input`, anything else
streams the raw text byte-exact through whatever trailing whitespace follows. Classification is
bounded to `MAX_FREEFORM_WRAPPER_SCAN_CHARS`, which keeps the work per delta from growing with
the arguments. Past the bound nothing is previewed at all: the authoritative parse still
unwraps the wrapper at completion, so the bound costs preview and never agreement. Because the
close resolves from the member table instead of `JSON.parse`, fragmented trailing whitespace
and deltas that happen to end on a brace can never reparse a growing provider-controlled
buffer.

What that policy costs is worth stating plainly, because it is a real narrowing. A body that IS
a parseable JSON object but not a wrapper — `{"code":1}` or `{"code":"a","script":"b"}` — now
reaches the direct bridge in one delta when the object closes, where it previously streamed as
it arrived. That is not a tuning choice: `input` can still arrive after any property, so any
prefix published before the object closes is a prefix that completion may unwrap away. Routed
restoration has held exactly these bodies since #5047 and this is the two paths agreeing, not a
new restriction invented for one of them. Bodies that are not objects, which is what an `exec`
program or an `apply_patch` envelope actually looks like, are unaffected and still stream.

Routed restoration keeps its hold for an unrecognized JSON object and its separate code-mode patch-envelope hold. Duplicate `input` keys and wrappers that become invalid only after a valid prefix was emitted remain bounded exceptions for ordinary freeform tools. Routed `apply_patch` narrows that boundary: after an exact canonical `*** Begin Patch` line resolves, `src/responses/apply-patch-envelope.ts` exposes only bytes that delimiter normalization cannot rewrite.
A possible decorated terminal marker and the line break behind it remain held until authoritative. If a late-invalid or duplicate-key wrapper makes the completed repaired input disagree with an emitted canonical patch prefix, the routed rewrite fails closed before input-done, item-done, or completed output rather than publishing a rewound executable call.

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
`/responses/compact` request without passing through this adapter and applies the same destination strip: official destinations keep it, including native v1; opted-in custom gateways do not. Stripping on the canonical predicate would make
`openai-apikey` behave differently on its two endpoints. Native compact also applies the [Google replay projection](../providers/google.md#google-tool-call-thought-signature-replay) before its direct send.

This table is not an unknown-parameter sanitizer, and the distinction is the point. It lists keys a
client is observed to send, so an unrecognized top-level key reaches the wire untouched rather than
being deleted on the theory that the destination would have rejected it. `codex_output_schema` is
deliberately absent for that reason: in codex-rs it is the `name` of the JSON-schema `text.format`
object, not a top-level key, so listing it would remove a field this client never sends. Private input item TYPES are a third table, `CANONICAL_ONLY_INPUT_ITEM_TYPES` (`stripCanonicalOnlyInputItems`, same destination boundary in the passthrough and native compact gateway replay). It holds Codex 0.164 `configuration_update` (`{type, reasoning: {effort}}`), a positional effort control: OpenAI-operated destinations receive it verbatim and in order, other gateways get the conversation without it, the translated parser drops it without clearing pending reasoning, and the agent-task tail walkers skip it like `compaction_trigger`. Codex sends it only for rows with `supports_reasoning_effort_updates`, which `normalizeRoutedCatalogEntry` removes from routed rows; its effort is never mapped onto a routed request (#6895). Coverage: `tests/responses/codex-0164-request-compat.test.ts`.

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
state. Stored Pool credentials follow the [credit policy](../codex-account-controls.md#stored-account-authentication-policy) through refresh copies and physical HTTP/WebSocket dispatch; a policy refusal before transport contact announces no replay send. `openai-apikey` uses its configured key and canonical API base URL. Missing credentials fail
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
core, so that file repeats the same call before it binds the adapter; the managed native
Messages lane (`src/server/messages-native.ts`) does the same. Native compact
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

OpenAI-compatible service-tier support is resolved only after the final provider/model wire is known. `supportsServiceTier` remains the provider fallback, while the exact `modelSupportsServiceTier` map can override it per upstream model, including an explicit `false`.
The catalog and request path share this decision: a routed row publishes `service_tiers` only when the resolved policy is eligible, and the final-route normalizer applies the same gate to
`service_tier`. Both `openai-responses` and `openai-chat` use the resolved provider/model capability
for catalog publication, routing evidence, and fingerprints. Canonical Fast injection additionally
requires a compatible FastWire mapping on the final adapter and an eligible policy. Setting
`fastMode: false` drops it. On classified Chat routes, `chatServiceTier` separately authorizes
foreign caller values; an exact-model `true` does not grant that forwarding permission. On
unclassified Chat routes it gates every caller tier because no canonical Fast capability has been
validated. An object-form registry wire default may also set `forwardCallerServiceTier: false` to
close a known subscription gateway while leaving generic unclassified Responses passthrough
unchanged. Exact `false` narrows provider defaults, and provider-level `supportsServiceTier: false` cannot be reopened.
Capability is namespaced by the selected provider and model; model-name similarity and adapter type
alone never opt a gateway in. Response-tier evidence is governed by `src/providers/openai-tiers-destination.ts`: canonical ChatGPT Codex forwarding is non-authoritative (#2558); other destinations honor the optional provider boolean `responseTierAuthoritative`, with omission retaining legacy response authority. No gateway name or address infers a declaration. The final route captures this in `TierObservationContext` through `src/server/responses/core-normalize.ts`, without changing capability, `TierDecision`, or outgoing parameters.

### Response-tier observation authority

`src/providers/fastwire.ts` copies a defined authority flag into `AttemptTierOutcome`. With false, an eligible serialized priority request remains `fastOutcome: applied` and `confirmation: assumed`: the parameter was sent, while actual scheduling is unconfirmed. Neither a `default` nor a `priority` echo can confirm or deny Fast; sanitized `responseServiceTier` remains for inspection, while local capability and wire failures still downgrade. Logs and persisted attempts retain the flag, and `src/usage/cost.ts` uses requested-tier estimation without promoting an untrusted echo or a confirmed label to response-confirmed pricing. Official API and undeclared destinations retain legacy response judgments.

Anthropic Fast eligibility and downgrade recovery use the [Responses failover contract](responses-failover.md#anthropic-fast-downgrade-recovery). The [instance runtime contract](../providers/anthropic-account-pool.md#instance-scoped-runtime) governs Anthropic pool selection, physical-send ownership and continuation recovery.

`POST /v1/responses/compact` handles remote compaction v1 before the generic `/v1/responses` branch
and before the `/v1/*` guard. Unknown `/v1/*` paths return JSON 404 errors instead of falling through
to GUI static serving. Translated compaction uses the [historical image projection](responses-wire-shapes.md#compaction-image-input).

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
Custom `openai-responses` gateways declare native v2 triggers with `supportsNativeCompactionTrigger` and native v1 endpoints with `supportsNativeCompactEndpoint`; neither flag implies blob replay or OpenAI identity. `src/adapters/openai-responses/transport.ts` shares normal URL/auth/header construction with custom native v1 key/local/forward routes; generic OAuth retains routed compaction so the existing credential selection, refresh and dispatch fence own authentication. Native v2 remains an independent declaration. Custom native v1 honors `preserveResponsesReasoningContent: true` in both sanitizer passes only for custom destinations; absent/false and OpenAI-operated compact destinations blank raw reasoning content. Proxy-owned `ocxr1:` envelopes are always stripped, and plaintext preservation grants neither native generation nor ciphertext replay. Both custom v1 sanitizer passes omit non-array reasoning content channels and reuse `requiresPlaintextReasoningReplay` from `src/adapters/openai-responses/passthrough.ts`: custom providers with plaintext preservation and strict tool-result adjacency strip opaque reasoning ciphertext and backfill missing `reasoning_text` from `summary_text` or the existing minimal placeholder, while preserving available plaintext. Each physical send applies `dropResponsesReasoningItems: true` and strips private input message metadata unless `preserveResponsesMessageMetadata: true`, using the ordinary adapter policy; OpenAI-operated compact metadata, reasoning items and null channels retain their established policy. Custom v1 scrubs compaction ciphertext, reasoning ciphertext and foreign reasoning ids after each serving bind, using ordinary turns' parent-thread-first replay scope; provenance commits require a successful HTTP response and a validated replacement history with replayable compact ciphertext or nonblank message text, absent/completed status and absent/null error (`nativeCompactResponseSchema` in `src/responses/schema.ts`). Invalid or empty bodies preserve the prior identity; validation never rewrites the relayed body or request-log metadata. Daybreak endpoint restrictions remain canonical-only. A native 404 handoff preserves User-Agent and allowlisted provider-opted-in metadata through `src/server/responses/core-auth.ts` without widening credential forwarding. Every custom native v1 send carries only the gateway transport's headers, and Codex pool recovery (401 refresh replay, quota and transient alternates) and pool outcome recording skip gateway sends, so recovery cannot put a stored ChatGPT credential on a gateway wire (`tests/responses/native-compaction-gateway-credentials.test.ts`). Readable reasoning retention also bypasses native v2-capable gateways; the capability predicate controls local retention as well as dispatch. V1 fallback remains portable even for v2-capable gateways; cross-provider overrides still force portable summaries. `tests/responses/native-compaction-gateway.test.ts`, `tests/responses/native-compaction-gateway-policy.test.ts` `tests/responses/native-compaction-provenance.test.ts` and `tests/responses/native-compaction-oauth.test.ts` pin these boundaries. Key-auth compact revalidates the serving key after pacing, rebuilding custom gateway paths, transport headers, replay sanitization and [citation projection](responses-citations.md) against that physical selection; `tests/responses/compact-key-selection.test.ts` covers initial gateway dispatch and queued reselection.
Canonical native v1's 404 fallback also bypasses local readable retention: its native v2 turn receives the original reasoning and creates no archive (`tests/responses/reasoning-retention-routing.test.ts`).
A replayed compaction item carries an `encrypted_content` blob only its minting backend can decode, and the client replays it on every later turn. The proxy's own `ocx1:`/`ocx2:` envelopes are transparent base64, so they always lower to plain user messages. A
native blob is relayed only when there is no known serving-identity mismatch and the destination is known to decode native blobs — the canonical ChatGPT forward surface, the official OpenAI API, or a provider with the explicit
`decodesNativeCompactionBlobs` capability. The destination gate alone is insufficient because more than one backend, including OpenAI and xAI, mints native blobs: a destination can decode its own blob without being able to decode the previous backend's.
The same serving-identity mismatch signal therefore strips reasoning `encrypted_content` unless the narrowly scoped [native reasoning retention](native-reasoning-retention.md#runtime-boundary) policy permits it; native compaction blobs still degrade through the existing opaque-note path independently of that policy. Claude-native reasoning batches rejected blob tags into one scrub pass: only the
matching durable endpoint and generation-bearing credential retain raw and parsed carriers. Without recorded thread identity, the destination gate remains. Cold opaque preflight and identified rejection recovery follow the [cold-history contract](native-reasoning-retention.md#cold-opaque-state-rejection-recovery). Noncanonical forward providers receive no caller credentials and may point at any backend. On any
other routed destination the blob also degrades to the same opaque note the bridged parser uses, because forwarding it there fails the turn and the item outlives the failure in the client transcript, repeating on every later turn including the compaction
turn the proxy itself drives. With `store: false`, request sanitization strips ids from every input item, including compact-wire items, matching codex-rs (`core/src/client.rs:918-925`). Compact-wire items remain exempt from response-side field backfill.

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
continuation id and provider conversation reference. Parsed Responses requests also remove foreign reasoning item ids and apply the encrypted-reasoning policy before dispatch, keeping
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


## Decoded checkpoint continuation

`src/responses/parser.ts` adds `CHECKPOINT_CONTINUATION_NOTE` from `src/responses/compaction.ts` for decoded `ocx1:`/`ocx2:` checkpoints; `src/adapters/openai-responses/request-strips.ts` does the same while lowering them. For plaintext `SUMMARY_PREFIX` and readable portable checkpoints, `src/responses/compaction-history-framing.ts` frames text-only retained requests before the latest checkpoint as historical context. Plaintext checkpoints append the same note there; portable decoders retain their existing note placement. The parser projects only adapter context; `src/adapters/openai-responses/passthrough.ts` projects only non-OpenAI-operated outbound bodies. Original request text/blocks, canonical raw history, item identities, replay-prefix lengths, checkpoints and later input remain unchanged. Context wrappers, images/files and assistant/tool items are preserved; summarizer turns and opaque native blobs do not activate framing. Native OpenAI passthrough input is unchanged by checkpoint framing; the separate [citation projection](response-citations.md) repairs legacy annotation fields on OpenAI-operated outbound history.

The note is a prompt contract and grants no authority. Completed requests remain history unless a later user message asks to repeat them. Unfinished work continues only under existing authorization and within its scope, without asking for that authorization again while it still applies. Permission and confirmation gates remain authoritative: a pending decision or required permission must resolve before the dependent action. Checkpoints and delegations, including those from another thread, neither grant authority nor expand scope. Later user messages take priority, including pause, cancellation, replacement and scope changes.

The continuation-note and continuation-wire tests establish prompt and wire contracts, including separated `ocx2:` retained reasoning. `tests/responses/compaction-history-framing.test.ts` adds offline A/B projection, original-detail preservation, native passthrough isolation, multi-turn canonical replay/dedup coverage and exclusion of client-side summarizer turns ending in the canonical `COMPACT_PROMPT` (which carry no `compaction_trigger`). `tests/responses/compaction-portable-history.test.ts` covers default JSON/SSE trigger round trips and replacement replay with an external task envelope, plus portable checkpoint families and later user changes. These tests do not establish live model behavior or whether a model actually resumes the correct task.

> Decision record: [ADR-7003](../decisions/ADR-7003-decoded-checkpoint-continuation.md)

## Core module ownership

Final-route normalization in `src/server/responses/core-normalize.ts` decodes client effort aliases through `src/clients/reasoning-controls.ts` before strength pins/caps. `options.thinkingEnabled` is independent of `options.reasoning`: explicit booleans outrank aliases and defaults, and an empty strength ladder does not erase a declared switch. `src/server/effort-policy.ts` restores both original choices on a destination change; credential-only retries retain the current normalization. Routed capability normalization removes unsupported effort from both parsed options and the raw request. Native Codex requests retain snapshot-owned effort clamping even with saved capability exclusions. Unsupported routed controls follow the [per-axis capability contract](../providers-and-adapters.md), while unknown axes retain legacy behavior. At serialization, `src/adapters/openai-responses/passthrough.ts` strips the OCX `reasoning.enabled` extension for both HTTP and WebSocket bodies unless a custom destination declares `reasoningWireFormat: "gateway-object"`; OpenAI-operated destinations always strip it. The extension-removal step leaves other reasoning members untouched; existing effort and summary normalization still applies.

`src/server/responses/core.ts` is the public ingress and compatibility-export surface. The parent `src/server/responses.ts` facade retains its existing imports. Per-request execution is composed from the following owners in `src/server/responses/`; none is a generated artifact.

| Owner | Responsibility |
| --- | --- |
| `core-pipeline.ts` | Request-phase composition, native-to-translated adapter handoff and pending admission/unused-hop cleanup; the public ingress remains in `core.ts`. |
| `compaction-retention.ts` | Local direct-v2 reasoning retention, provisional archives and response-lifetime cleanup under the [routed compaction contract](responses-failover.md#compaction-routing-overrides). |
| `request-prepare.ts` | Body parsing, combo handoff, final route, encrypted-task recovery and initial admission, retaining [original policy authorization](policy-fallback.md). Both shadow-intercept sites use `shadowCallPreservesSelectedModel` in `src/lib/shadow-call.ts`: explicit `request_kind: "turn"` plus `thread_source: "user"`, or spawned-child provenance, preserves the selected model. `x-openai-subagent: collab_spawn` is a connection header on both transports (a child session opens its own connection); turn metadata comes from the HTTP `x-codex-turn-metadata` header or, on WebSocket, only from each frame's `client_metadata["x-codex-turn-metadata"]` (including `subagent_kind: "thread_spawn"`), never from stale upgrade metadata. Kind-only `turn` helpers and missing/malformed metadata retain interception; concrete self-targets remain no-ops and helper combos retain failover. `tests/responses/responses-shadow-intercept.test.ts` covers both sites and frame precedence. xAI OAuth model-scope admission previews the billed Fast lane using the serialization decision shared with Chat, Messages and routed compact admission; final normalization rechecks the actual wire destination. |
| `shadow-target-availability.ts` | Shadow-call target resolution for `request-prepare.ts`: an unavailable target fails once with `409 intercept_target_unavailable` instead of reaching the native source model or the default provider. |
| `request-transport.ts` | Live credential selection, dispatch bindings, adapter replacement and same-target request identity. Each physical adapter binding owns the build-only [append-only Claude tool projection](../data-planes/claude-tool-loading.md), preserving the request's original catalog across fallback and rebuilds. Copilot Auto renewal onto Chat (including negotiation-401 refresh) signals the native owner before inference; `passthrough-dispatch.ts` reuses its inference-401/429 adapter handoff so JSON and SSE retain the Responses envelope. |
| `request-sidecar-auth.ts` | Routed-compaction image projection, sidecar credential resolution and vision preprocessing. |
| `response-effects.ts` | Completion notification, replay publication, live request-tool aliases and routed summary controls; Anthropic keeps client tools/system/options, and flags hosted-tool or mandatory-choice summaries so the adapter sends wire `tool_choice: none`. |
| `request-send-budget.ts` | Request-wide send accounting, remaining allowance, the pending recovery permit and the shared ambiguous-resend grant. |
| `reset-replay.ts` | Self-contained-request eligibility and the shared operator replacement grant for native Responses and generic translated initial/rebuilt pre-header sends; adapter-owned transports and translated post-header failures are excluded. |
| `request-spend.ts` | This request's entries in the durable spend ledger: one per physical send, settled from the terminal usage. |
| `passthrough-execution.ts` | Native host-lease transfer and the enclosing dispatch/delivery `finally`. |
| `passthrough-dispatch.ts` | Native request preparation, upstream sends and pre-commit recovery. |
| `passthrough-delivery.ts`, `terminal-error-redaction.ts`, `non-replayable-error.ts` | Native HTTP/SSE/JSON delivery and terminal accounting. Marked real errors use bounded reads to retain only allowlisted error type and code, keep status and non-replayability plus `x-should-retry: false` when present, and withhold upstream body text and all other upstream headers; the client receives a fixed generic message and synthetic refusals stay distinct. SSE diagnostics and xAI tool-envelope filtering precede client delivery/continuation storage. |
| `policy-refusal.ts` | Rewrites an allowlisted non-combo HTTP 403 model refusal (`isUpstreamPolicyRefusal` in `src/lib/errors.ts`) from an xAI destination only (`isXaiResponsesDestination`: api.x.ai or the Grok CLI proxy, on either wire) to an HTTP 200 Responses `incomplete` / `content_filter` payload, JSON or SSE, for both `adapter-dispatch.ts` and `passthrough-delivery.ts`. A streamed rewrite takes the turn admission lease and releases it when the body finishes, so the refusal stays inside active-turn accounting. Combo attempts keep the original 403 so failover classifies it as a hop. |
| `sidecar-execution.ts`, `sidecar-send-budget.ts` | Image/video versus web-search execution, Chat raw-reasoning preference forwarded to both loop bridges under [reasoning display parity](../providers/chat-compat.md#reasoning-display-parity-hidethinkingsummary), per-build adapter prompt estimates for usage logging, shared rotation, and adapter-aware prepaid inference/producer ownership under the [spend contract](responses-spend.md#prepaid-initial-sends). |
| `completion-policy.ts`, `run-turn-execution.ts` | Empty-completion eligibility and adapter-owned event turns; refreshed retries reject previously failed key bindings and revalidate after each queued admission; adapter-owned CLI spawns receive the post-setup `IncomingMeta.beforePhysicalSend` fence, with [replacement-key readmission](responses-failover.md#upstream-key-attempt-accounting). |
| `adapter-dispatch.ts` | Translated initial dispatch, bounded recovery (including [Anthropic thinking-signature recovery](anthropic-thinking-recovery.md)) and the shared continuation retry counter. Initial and rebuilt adapter budget refusals retain the HTTP 413 [byte-accounting contract](byte-accounting.md#request-copy-accounting); ordinary build errors remain 400. |
| `adapter-continuation.ts`, `adapter-delivery.ts` | Continuation event sources and final streaming/buffered bridging; Anthropic routed summaries pass through `src/responses/compaction-summary.ts` before either bridge. A streamed turn with a `clientEncoder` option is handed to `src/server/inference/client-encoder-delivery.ts` instead of the bridge. |

Reusable helpers live in `core-auth.ts`, `core-codex-account.ts`, `core-combo.ts`, `core-combo-failure.ts`, `core-combo-native.ts`, `combo-requested-effort.ts`, `core-errors.ts`, `core-lifetime.ts`, `core-normalize.ts`, `core-opaque-recovery.ts` and `core-replay.ts`. `core-options.ts` owns the public option types
and small composition contracts, including [finite model-refusal evidence](../providers-and-adapters.md#combo-model-refusal-evidence). Existing public helper names are re-exported by `core.ts`. After an admitted Anthropic OAuth pool rotation, `adapter-dispatch.ts` rebinds reasoning replay to the committed credential snapshot; `adapter-continuation.ts` rebinds both its continuation clone and the outer request that persists the response. The replacement send strips the previous account's private state, while persisted ownership and the next turn follow the serving account. Codex alternate-account sends in `core-codex-account.ts` record `oauth-account-402` for HTTP 402 quota recovery, `oauth-account-429` for HTTP 429 rate-limit recovery, and `transient-5xx` for transient recovery, preserving the first response's wire status when sealing its attempt; gated-model moves keep their existing unattributed kind.
Adapter construction remains with the existing registry; `fetch-helpers.ts` remains a leaf. For Kiro OAuth with load settings, `request-transport.ts` acquires a lease on the admitted account and transfers it before a reactive replacement send; cancellation permanently fences the request holder so recovery cannot install a late lease after abort cleanup. `core.ts` and `core-lifetime.ts` release the lease on returned-body completion, error, or cancellation, outside the inner admission `finally`.

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
marker and translator-budget finalization; cleanup wrappers preserve its run-turn classification and nonreplayable failures, so retention cannot reopen combo retries after a tool effect. Owned-budget cleanup on request abort, including unread response bodies, follows the [byte-accounting lifetime contract](byte-accounting.md#stream-buffer-accounting).

The pending admission `finally` lives in `core-pipeline.ts`. Native execution explicitly transfers its
pending lease to `passthrough-execution.ts`; both owners await response construction before
cleanup. Stream body ownership, cancellation and post-commit behavior stay in the delivery owners.
This decomposition changes ownership boundaries, not credential-selection or retry policy.

`tests/responses/responses-core-modules.test.ts` covers the owner inventory, the 1,999-line ceiling,
acyclic dependencies, recursive dispatch, lease-transfer wiring, capture-name hygiene and live
send-holder/permit behavior. Cross-owner source assertions read the actual implementations via
`tests/helpers/responses-core-source.ts`; focused passthrough and subagent assertions read their
specific delivery/preparation owner. Existing runtime Lab-boundary tests still start at `core.ts`.

### Shared inference primitives

`src/server/inference/` holds the execution pieces the Responses pipeline and the native lanes
share, so a native lane reuses them instead of copying them. The directory is Lab-free and is
reachable from `core.ts`.

| Module | Contract |
| --- | --- |
| `context.ts` | `createInferenceSendBudget(req, logCtx)` is the one construction of an ingress-owned send holder: the default guarded policy with this request's spend tracker as observer. `handleResponses` calls it only when no holder was inherited, because attaching the tracker parks it on `logCtx`. |
| `final-log.ts` | `createFinalRequestLog(logIds, logCtx)` owns one request's final row: the first `finish(status, meta)` writes it, every later call is a no-op, and without log ids the claim settles with nothing written. The bridged Chat and Messages ingresses, native Chat and native Messages finish through it. |
| `attempt.ts` | `beginInferenceAttempt(logCtx, { provider, model, adapter })` opens the next attempt ordinal, makes it the active attempt with its start time, appends it to the request, and returns `seal(accountLabel?)` and `finish(status, usage?)`. |
| `client-wire.ts` | `markClientWire(response, protocol)` / `clientWireOf(response)` record, per `Response` identity, that a body is already in a client's wire. `createClientWireLog` / `attachClientWireLog` / `clientWireLogOf` carry the request-log facts of such a body (a start payload, one terminal, a cancel), buffered until the deferred log subscribes. The combo marks a native Chat child's answer and its refusal of an all-unrepresentable combo as `chat` (below). |
| `client-wire-log.ts` | `recordClientWireRequestLog` is the deferred request log of a client-wire response: `responseWithDeferredRequestLog` calls it instead of tapping the body, and it applies the Responses SSE tap's rules to the reported facts (payload inspection until the terminal, `terminal_sse` phase, `httpStatusForRequestLogTerminal`, 499 for a cancel before any terminal, one row). |
| `client-encoder-delivery.ts` | Direct Chat/Messages delivery (PF-09), described below. |

### Direct client encoders

Behind `protocols.rollout.directEncoders` (default off). The Chat and Messages ingresses set
`HandleResponsesOptions.clientEncoder` (`{ protocol, stream, model, inputTokenFloor? }`) when
`directEncodersApply` holds for the route they settled: the switch is on and the route is one
concrete target whose adapter is not `openai-responses`. `clientEncoderForDelivery` re-checks at
delivery, because core can still change the route: combo children (`comboAttempt`), policy or
combo route decisions, routed compaction and Responses-wire adapters keep the bridged body.
Passthrough, run-turn adapters and sidecar turns never reach this branch.

In the streaming adapter branch `deliverClientEncodedResponse` encodes the guarded event stream
with `encodeChatCompletionSse` or `encodeAnthropicMessageSse` (`src/protocols/encoders/`)
instead of `bridgeToResponsesSSE`, and preserves the bridge's effects:

- Every event is also retained as a shallow copy on the request's translator budget
  (`retainTranslatedEvent`). At any terminal the copies are folded with `buildResponseJSON`
  (`recordBufferedDelivery: false`, declared-tool enforcement off as on the bridge for these
  wires), which runs the replay-cache effects and releases the copies; overflow and client
  cancel release them without folding.
- A `done` terminal hands the folded response to the same `onCompletedResponse` the bridge uses
  (`commitReasoningReplayServingRoute`, the Kiro final-answer memo, `rememberResponseState`
  unless compaction, `notifyResponseComplete`), after the thought-signature durability barrier
  where the bridge awaited it. `bindKeyUsageFromBridge` gets the adapter usage under the bridge's
  `onUsage` rules.
- The body goes through `trackStreamLifetime` with the same cleanup and admission lease; the
  terminal and a client cancel call `cancelResponseCompletion` and abort the upstream once.
- Client frames are counted with `noteRelayedEvent`; wire-silence keepalives (the Chat `: opencodex heartbeat` comment, the Messages `ping`) are delivered as the converters deliver them but, like the bridge heartbeat, not counted.
- The request log learns the bridge's `response.created` snapshot and a terminal payload with the
  bridge's usage presence rules through the client-wire log channel.

A non-streaming client gets the encoded stream folded by the existing collectors
(`collectChatCompletionResponse`, `collectAnthropicMessageResponse`), with the status mapping the
ingresses applied. The response is marked with `markClientWire`, and the ingress returns it
without the Responses-to-client conversion; the Chat ingress still wraps it with
`responseWithDeferredRequestLog`, which subscribes to the log channel. The attempt's trace is
marked with `markAttemptProtocolPath`: request path and mode stay the bridge's, the response path
becomes `[upstream, "ir", client]`. `tests/responses/protocol-direct-encoders-chat.test.ts`,
`tests/responses/protocol-direct-encoders-messages.test.ts` and
`tests/server/inference-client-encoder-delivery.test.ts` cover parity and wiring.

Native Chat in `src/server/chat-native.ts` is split in two. `handleNativeChatCompletions` opens
the attempt and owns the final log row; `runNativeChatAttempt(execution, attemptHandle)` runs
effort normalization, the send loop, key failover, 429 replay, relay and usage, and reports each
outcome through the `finishLog` it is given. A caller that owns a different final row can
therefore run a native attempt without the attempt writing that row itself. A standalone native
Chat request keeps its own spend tracker rather than a send holder; a combo child is handed the
combo's per-target budget instead (below).

### Native Chat candidates in combos

`protocols.rollout.nativeChatCombos` (off by default) lets a Chat combo send an eligible
candidate on the native Chat lane. The Chat ingress supplies `HandleResponsesOptions.protocolSource`
(`ComboProtocolSource` in `core-combo-native.ts`: the source envelope and a native dispatcher)
only for a combo route with the switch on and no effort row; without it the combo loop runs
exactly as before, and a bridge child never inherits it.

For the candidate about to dispatch, `core-combo-native.ts` settles the concrete route the way the
Chat ingress settles a single route (the key's model scope, the static policy for a Chat inbound,
the wire override, the OpenCode Go transport) and applies `isNativeChatRouteEligible` to a fresh
`envelope.freshBody()` copy whose `model` is the concrete selector. A candidate whose adapter is
not `openai-chat` is decided without a copy. An eligible child is dispatched through
`protocolSource.dispatchNativeChild`, which runs `runNativeChatAttempt` on the attempt the combo
already opened (its opening stays hand-rolled: the ordinal comes from the parent context while the
active attempt and requested effort land on the child context, which `beginInferenceAttempt`
does not express). The child gets the combo's per-target send budget, the client's abort signal
and the turn lease. Ordinary Combo policy maps onto `reasoning_effort` through `concreteComboRequestBody`; the first JEV choice overrides it, including explicit null.
Initial shaping removes conflicting controls and caller `service_tier` before provider pins/caps and wire normalization; labels retain applied transitions ([JEV Decision Routing](../providers/jev-decision.md)).
Later targets use ordinary policy from the original body. Its attempt path is native (`[chat, chat]`) and its answer is marked `chat`.

Send accounting: the combo's hop reservation already booked the target's first send, so the native
child opens no spend tracker; its final HTTP receipt confirms the exact owning prepaid permit,
then reserves each later physical send independently under the [prepaid-send contract](responses-spend.md#prepaid-initial-sends).
Its transient ladder and 429 replays intersect target-local totals with shared ceilings;
a refusal answers 429 `request_send_budget_exhausted` in the Chat shape.

A marked child skips `preflightComboStreamResponse`: native Chat reports a pre-stream failure by
HTTP status before any byte, and a non-OK answer goes through `consumeComboFailure` unchanged. A
non-OK answer produced after the child observed output (a folded non-streaming answer that failed
mid-stream) is marked non-replayable, so the combo stops rather than re-running a turn that
already ran upstream. The child's final-log callback never writes the parent's row: a terminal,
cancellation or folded success publishes through the combo's child callback gate, which reaches
the Chat ingress's final-row owner only after the combo commits, and usage learned after the
merge is carried to the parent first. The Chat ingress returns a `chat`-marked success as it is;
only a `chat`-marked refusal goes through `responseWithDeferredRequestLog`, whose SSE inspector
reads Responses events and would misread a Chat stream.

Under `unrepresentable: "reject"`, each candidate's path (native, or the bridge to its settled
adapter's wire) is judged with `checkRepresentable`; a failing candidate is excluded from the pick
predicate and `feature-unrepresentable` is appended to the request's trace entry mark. When every
enabled candidate is skipped, the combo answers the ingress's refusal (400 `unsupported_feature`
in the Chat shape, blocked trace) with no send. `n > 1` is never emulated with several
inferences. Policy routes resolve one candidate in `routeModel` and never reach this loop, so they
are not migrated. `tests/responses/chat-native-combo.test.ts` pins the source body, failover
within the shared budget, no resend after output, the switch-off path and both reject outcomes.
Managed native Messages ([Protocol Paths](../data-planes/protocol-paths.md#managed-native-messages))
reuses `beginInferenceAttempt` and `createFinalRequestLog` with its own 401/429 key-rotation loop.

## Adapter-to-Responses bridge

`src/bridge.ts` is a re-export facade; the implementation lives in `src/bridge/`.
`src/bridge/sse.ts` (`bridgeToResponsesSSE`) turns adapter events into the Responses SSE stream; its once-only first-output observer includes nonempty `tool_call_delta` arguments (including custom-tool input), but not tool-start scaffolding or empty arguments,
and `src/bridge/response-json.ts` (`buildResponseJSON`) builds the non-streaming Responses body
from the same events. `buildResponseJSON` records a buffered delivery on the attempt unless the
caller passes `recordBufferedDelivery: false`, which the direct client encoders do because they
count their own frames. `src/protocols/encoders/adapter-events.ts` ports the bridge's item state
machine for those encoders, so a change to item boundaries, tool naming or terminal handling in
`sse.ts` has to be made there too; the parity tests fail when the two diverge. `src/bridge/errors.ts` (`formatErrorResponse`) formats error responses and
keeps allowlisted transport verdict codes, the buffered combo [required-tool verdict and retry policy](responses-combo-boundaries.md#buffered-required-tool-contract), its [streaming commitment boundary](responses-combo-boundaries.md#streaming-required-tool-contract), and the explicit local `spend_ledger_storage_unavailable` identity ([storage refusal contract](responses-spend.md#durable-spend-reservations)). Adapter error events take a different path:
`src/bridge/internal.ts` preserves explicit verdicts except cyber-policy and known rate-limit mappings
([client retry advice](responses-wire-shapes.md#client-rate-limit-retry-advice)). Explicit incomplete reasons follow the [reason contract](responses-wire-shapes.md#adapter-incomplete-reasons).
An explicit `tool_call_end.incomplete` closes only that item as incomplete without argument-completion frames or malformed-argument failure; the following turn terminal owns reason and usage. The shared usage shaping's `input_tokens_details` and `output_tokens_details` are always emitted,
with zero defaults, because strict Responses clients deserialize them as required fields.

Active-turn admission owns workflow admission, so both remain held until a streaming body finishes or is cancelled.

The shared endpoint path also preserves the cyber-policy stop when a malformed UTF-8 5xx body is
replacement-decoded; other malformed-body usage, quota, reset evidence and classification retain the
status-only fallback. Rebuilt failures remain non-replayable and cyber-policy failures carry neither
`Retry-After` nor quota-reset metadata. The [Responses failover contract](responses-failover.md)
owns the bounded recovery and replay decisions.

On the `responses` inbound wire only (`terminalRefusalAsFailed`, set by the same test as `enforceDeclaredToolNames` in `src/server/responses/adapter-delivery.ts`, `src/server/responses/run-turn-execution.ts` and the sidecar loops started from `src/server/responses/sidecar-execution.ts`), an adapter `incomplete` with `reason: "content_filter"` and `retryable: false` is delivered as `response.failed` whose `error` and `last_error` carry `invalid_request_error` / `invalid_prompt` with `retryable: false` and the turn's usage, built by `src/bridge/terminal-refusal.ts`: Codex retries every `response.incomplete` without reading `incomplete_details.retryable` and ends a turn only on a terminal-refusal `error.code` (#4312). The Anthropic and Kiro adapters emit that event today. Inside a combo a refusal with no output never reaches the client as a stream: `src/server/responses/combo-stream-preflight.ts` converts the zero-output `response.failed` into an HTTP 400 JSON error with the same `invalid_prompt` code, and `comboFailureDecision` stops the chain on it instead of sending the refused prompt to the next target (`tests/routing/combo-terminal-refusal.test.ts`). The web-search and image sidecar loops (`src/web-search/loop.ts`, `src/images/loop.ts`) check `isTerminalRefusalIncomplete` before looping, on every inbound wire: a refused iteration that carried a sidecar call ends the turn instead of running the call and re-asking the model with the refused context (`tests/web-search/web-search-terminal-refusal.test.ts`, `tests/images/loop-terminal-refusal.test.ts`); `src/web-search/run-turn-loop.ts` already stops on any incomplete. Every other incomplete, the chat and Anthropic inbound wires, and `buildResponseJSON` keep the incomplete shape. A `response.failed` built from an adapter error carries `retryable: false` for every code in `isTerminalRefusalCode` (`src/lib/errors.ts`), not only cyber policy. `tests/adapters/bridge-terminal-refusal.test.ts` pins both, `tests/server/server-terminal-refusal-wiring.test.ts` pins which inbound wire opts in, and `tests/server/server-kiro-refusal-e2e.test.ts` pins the adapter, runTurn and both sidecar-loop deliveries.
