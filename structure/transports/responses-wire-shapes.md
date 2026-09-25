# Responses Wire Shapes

Per-wire request and stream shapes on the Responses data plane: mixed-wire model defaults, xAI
agent-message continuation, declared-tool membership by inbound wire, and passthrough SSE stream
shapes. The endpoint, dispatch, and credential rules they build on are in
[Responses transport](responses.md).

## Mixed-wire provider defaults

Registry `modelWireDefaults` select an evidence-backed upstream protocol for an exact model without
changing the provider-wide adapter. Explicit, allowed `modelAdapters` configuration always wins,
including an entry that opts the model back into the provider-wide wire. Defaults are applied only
while the configured provider still matches the registry transport, so reusing a preset name for a
different custom destination does not inherit its upstream assumptions. Object-form defaults may
also narrow the decision by inbound protocol and authentication mode; an auth-scoped default must
not leak from a subscription transport into an API-key or forwarded-credential route.

Alibaba Token Plan (Beijing) keeps `openai-chat` provider-wide but defaults `qwen3.8-flash`,
`qwen3.7-plus` and `glm-5.3` to `openai-responses` for Responses inbound only; Chat and Anthropic
inbound stay on Chat and its measured prefix-cache behavior. The entry sets
`preserveResponsesReasoningContent` beside the pins, because the Responses serializer reads that
flag rather than the Chat-side `preserveReasoningContentModels` list, and this gateway accepted
replayed plaintext reasoning content live. `qwen3.7-plus` sends effort as a `reasoning.effort`
string on this wire instead of the numeric `thinking_budget` the Chat wire applies. The intl sibling
stays unpinned. `tests/providers/alibaba-token-plan-wire-defaults.test.ts` covers the pins and the
replay flag.

xAI keeps `openai-chat` as its provider-wide compatibility wire, but Grok 4.5/4.6/4.7 subscription
Responses requests default to native `openai-responses`. Existing namespace, hosted-search and
reasoning-replay normalization remains in force. The reserved `xai` OAuth transport is name-pinned
to the Grok CLI gateway even if its saved base URL differs; custom provider IDs do not inherit this
default. API-key requests, translated Chat/Anthropic defaults and other Grok models retain their
existing wire and tier policy. The OAuth lane is service-tier classified per model
(`modelSupportsServiceTier` on the registry entry, live-probed 2026-09-13 and 2026-09-23;
`devlog/_plan/260923_grok47_parity/010_probe-evidence.md` records 4.7): grok-4.7, grok-4.6, grok-4.5,
grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1 and
grok-composer-2.5-fast accept `service_tier: "priority"` over Grok OAuth and echo it, so those
routes resolve Fast-eligible, publish `--fast` rows, and forward a caller-sent tier on either
wire (`chatServiceTier: true`). grok-4.20-multi-agent-0309 stays unclassified with its
caller-tier pin: the gateway accepts the field but answers `service_tier: "default"`, a live
downgrade rather than a fast tier.

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

## xAI string agent-message continuation

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
`src/adapters/openai-responses/web-search.ts` also drops the provider-rejected
`search_content_types` and `indexed_web_access` fields from plain `web_search` tools while
preserving preview tools. The two OpenCode Zen destinations gate that on a Contributor Muse id
because they serve nothing else; on the direct Meta destination (`https://api.meta.ai/v1/responses`)
the destination is the whole predicate, because Meta's refusal is a gateway schema rule for every
Muse model it serves, its default `muse-spark-1.3` is not a Contributor id, and a missing model id
still strips. Because the predicate is the host, a custom provider pointed at that exact URL gets the
same strip.

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

## Declared-tool membership by inbound wire

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
The bounded helper vocabulary includes the goal lifecycle calls that Codex advertises inside its
unified `exec` description (`create_goal`, `get_goal`, and `update_goal`). Routed providers that
echo one of those nested names, with or without an invented `default.` prefix, are restored to the
declared `exec` and compiled back to the matching `tools.<helper>(...)` call. A genuinely declared
bare goal tool keeps its bare identity, and a catalog declaring neither that tool nor `exec` still
fails closed.
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
wire enforces. Explicit enforcement with no declared catalog also refuses client tool calls rather
than treating the missing set as permission. A routed provider that names a tool the request never declared ends the turn there:
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

## Selection outlives the declaration check

Declaration and selection are different questions, and the guard above answers only the first.
`tool_choice: "none"`, a forced selector and an `allowed_tools` allow-list each narrow a catalog
without removing a declaration, so a name can be declared and forbidden at the same time — and a
guard that compares names against the catalog passes it.

The gap is reachable because a repair can put such a call back.
`createGrokResponsesSparseTerminalBlockRewrite` in `src/server/grok-responses-snapshot-repair.ts`
rebuilds a terminal `output` the upstream never sent from the items it collected during the turn.
`src/server/responses-request-tool-scope.ts` reads the boundary the request states, and the repair
applies it to what it publishes: a client call outside the selection is left out of the
reconstruction. The scope comes from the final outbound body, after every removal, rename and
translation, so a catalog that ends up empty there authorizes no client call whatever the selector
still says. An absent catalog states no boundary, exactly as it states none for the declaration
guard.

Selection matching follows request-local identity correspondence instead of regenerating a set of
name spellings. The outbound selector keeps its exact kind and wire name; namespace lowering
contributes only its collision-checked `{namespace, name, kind}` aliases, and the Muse length rewrite
composes its final wire alias over those identities. After client-facing restoration, two namespaces
that share one basename remain distinct, as do a function and a custom tool that share one name. A
custom call may match a function selector only when the same request records that exact
custom-to-function conversion; malformed narrowing selectors and contradictory alias maps fail
closed. Payload restoration still precedes sparse-terminal reconstruction, so the scope compares the
restored call through that correspondence while preserving its item and call identifiers.

The refusal is narrow and it is visible. Only the offending item is dropped, so the assistant text
that arrived in the same turn still reaches the client rather than being discarded with it. Because
the turn no longer ended the way the upstream said it did, the reconstructed terminal is published
as `response.incomplete` carrying `incomplete_details.reason: forbidden_tool_call`, not as a clean
`response.completed` with a quietly shorter output. The repair edits nothing but the terminal it
synthesizes; the raw stream remains the declaration guard's to police.

The selection is kept honest on the way out as well. `src/adapters/xai-web-search.ts` omits an
`auto`/`none` selector once normalization has left nothing for it to select, because xAI answers
that request with a 400. A forced function selector is preserved: a selector this proxy cannot
honor is a client input error, and `src/server/responses/passthrough-dispatch.ts` already answers
it with one.

Those two omissions are not the same edit, because the scope above is read from the body this
normalization produces. `auto` selects from the catalog, so removing it from a request with an
empty one states nothing new. `none` is a prohibition, and on a request whose catalog this
normalizer emptied it is the only place the turn's client-call boundary is written down. Dropping
the word alone would let the reconstruction hand back a call the caller ruled out, and nothing
behind it would catch that: the repair runs on the grok client surface, while the declaration
guard stands down whenever the provider's `authMode` is `forward` — which is what the xAI OAuth
lane is. So the prohibition is restated as the explicit empty catalog, which carries the same
deny-all, which the scope and the declaration guard both already read that way, and which this
destination receives unchanged whenever a caller sends one itself.

## Passthrough SSE stream shapes (#314)

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
[ambiguous connection-reset replay boundary](responses-failover.md#ambiguous-connection-reset-replay-boundary).
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
disconnect settles as a non-replayable gateway status before the first Responses
event, or as an errored SSE body after it, rather than as a retryable fetch
failure, so HTTP fallback cannot duplicate that inference. The one exception is a
socket that closed or errored before any Responses event on a provider that opted
into `retryOnReset`: the passthrough dispatch may spend the request's replacement
grant on one HTTP send (see [ambiguous-resend gate](responses-failover.md#ambiguous-resend-gate)).
A standalone no-response
exchange has a 90-second prelude deadline in addition to the upgrade deadline.
That prelude deadline is a ceiling, not a floor: the exchange runs under the
caller's abort signal, so a `connectTimeoutMs` shorter than 90 seconds cancels
an already-sent create before the prelude timer fires.
These are transport-fidelity guarantees, not a provider-billing guarantee.

Every exchange also leaves a content-free stage record (`CodexWsStageRecord`, #4191): create-frame bytes (measured on failure only — the committed-success record keeps it null so the happy path never byte-counts a megabyte replay frame), send completion, numeric close code, elapsed, first-frame and first-response-event durations, frame counters, liveness ping/pong counts, pool reuse, and the OCX/Bun versions. The exchange pins the record on the resolved Response (`markCodexWsStage`, the same marker seam as `markCodexWsResponse`); `handleResponses` adopts it onto the serving attempt, and usage.jsonl persists it per attempt behind a drop-guard normalizer, so hand-edited rows cannot inject strings into the DTO. Later snapshots update the same response-local record in place, so an attempt holding the committed reference observes final success or failure counters. Each exchange supplies a complete fresh snapshot; separate responses keep distinct records. On eager-relay cancel-drain expiry, upstream cancellation finalizes the transport snapshot before the cancellation hook writes the usage row; an actual terminal observed within the drain still wins over cancellation. The record never carries conversation text, headers, close-reason text, or account identifiers, and it is not a fallback-eligibility signal: nothing it says permits a resend. The one replacement an operator can grant after a socket dies is the resend gate's decision (see [ambiguous-resend gate](responses-failover.md#ambiguous-resend-gate)).

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


## Inbound history and code-mode shell wire repairs

Inbound function-call history with a missing JSON object prefix is repaired for every provider when
restoring it produces an object; other malformed argument strings replay as `{}` (`src/responses/parser.ts`).
Function-wrapper restoration supports `default.`-prefixed `exec` and `apply_patch` aliases while
retaining the existing ambiguity and foreign-grammar boundaries.

For a verified code-mode catalog, `src/responses/code-mode-shell-input.ts` recognizes a structured
`cmd` or `command` object submitted under `exec` and the canonical `input` wrapper. Only known shell
options and one command field are accepted, and any command that parses as JavaScript remains
unchanged, including ambiguous single identifiers. The helper compiler serializes recognized
arguments into `tools.exec_command(...)` and emits its result through `text(...)`; the proxy executes
nothing. JSON, native Responses and adapter-event SSE use the same completion rule. Possible
shell-object previews stay held until completion so raw JSON or shell text cannot precede compiled
JavaScript. Ordinary JavaScript stays progressive. Coverage: `tests/responses/responses-code-mode-shell-compile.test.ts`.

An explicit custom-tool denial also requests recovery for unmapped historical results without a live
catalog; history never adds current tool authorization. The custom-tool compatibility contract owns
lowering and final validation. Muse may wrap an already-flattened namespace identity such as
`default.mcp__server__tool` only when the complete suffix exactly matches a declared namespaced name
and neither explicit `default.` nor `default__` identity exists. It cannot borrow a manufactured bare
alias; unknown suffixes still fail as undeclared tools. See [ADR-0099](../decisions/ADR-0099-responses-http-sse.md).

> Decision record: [ADR-0099](../decisions/ADR-0099-responses-http-sse.md)

## Mixed encrypted-content slots

A mixed `encrypted_content` slot may contain structurally valid Fernet runs alongside text.
`src/server/responses/encrypted-payload.ts` recognizes at most 64 runs per slot. Finding a
65th marks the slot as overflow: sanitization and agent-message stripping replace that
whole slot with `[encrypted content omitted]`, while unreadable-task detection remains
fail-closed. The scanner never emits an unexamined suffix as text. The limit constrains
part expansion without changing single-token replay or the separate 32-part task-recovery cap.

## Injected combo summary defaults

An injected combo default supplies `summary: "auto"` only when no summary was specified; caller
summary choices remain intact. Raw display and hidden-envelope replay follow
[reasoning display parity](../providers/chat-compat.md#reasoning-display-parity-hidethinkingsummary).
Final-route normalization preserves visible raw reasoning when the parsed request has a validated
active effort and omits summary; explicit `summary: "none"` still hides it.
