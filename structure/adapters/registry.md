# Adapter Registry Authority

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Request-local adapter bindings are separate from registry authority in the Responses
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses.md#passthrough-sse-stream-shapes-314).

## Decision

Runtime adapter construction has one authority: `src/adapters/registry.ts`.

[Chronological instruction ordering](../providers/chat-compat.md#chronological-in-conversation-instructions)
is now uniform across destinations, so the Chat adapter no longer consults the provider registry's
destination identity for it; it adds no adapter factory.

`src/server/adapter-resolve.ts` may resolve a provider/model onto an adapter id, but it does not maintain a second adapter factory inventory. The selected persisted/configured adapter id remains an untrusted string until the registry lookup succeeds. Unknown ids fail with the existing `Unknown adapter: <id>` error instead of widening configuration types around a closed compile-time union.

## Semantic inheritance is not constructor inheritance

Some adapters share another adapter's routed-tool semantics while retaining independent runtime construction:

- `azure` and `azure-openai` inherit the `openai-responses` contract.
  The inherited contract includes Meta Muse's host-gated 64-character tool-name alias when the
  constructed send URL is `api.meta.ai` (`src/responses/muse-tool-name-alias.ts`).
- `mimo-free` inherits the `openai-chat` contract.
- `cursor` stays direct because its `runTurn` transport and gated native-file fallback are distinct.
- `devin` is direct for a related reason. It streams Cognition's
  `ApiServerService/GetChatMessage` over Connect-RPC from `runTurn` with hand-written protobuf
  framing, so like Cursor it never travels the `buildRequest`/`parseStream` path. Login is
  import-first: the installed CLI's own `credentials.toml` holds an ordinary
  `devin-session-token`, the same credential `RegisterUser` mints for a browser sign-in, so
  `devin` imports that token when one exists and falls back to the Auth0 browser flow when it
  does not. `devin-cli` survives only as a deprecated alias — `ocx login devin-cli` routes to
  `devin`, and a startup merge migration rewrites any saved row still keyed under the old
  provider id, so the registry carries one Devin provider, not two.
  Its `GetChatMessage` inference POSTs pass through the provider executor and shared send budget.
  The adapter allows no reset wait; the shared helper retains bounded replays for opted-in callers.
  Catalog and JWT RPCs remain adapter support traffic rather than inference sends.
  `AdapterFactoryContext.providerId` still tells the shared adapter which configured row it is
  serving: the Cognition tenant is recorded on the credential, not in the registry, so the
  adapter has to know the row before it can resolve a host. That adapter advertises bare local
  tool names to Cognition, so `runTurn` also owns a request-scoped return map from each unique
  bare name to the canonical Codex namespace identity. Unknown names remain subject to the shared
  undeclared-tool guard; duplicate bare names fail before dispatch rather than selecting a request
  tool by declaration order. Canonical identities are registered in that map as well, because the
  adapter accepts them on return. One tool's canonical identity can be another tool's advertised
  local name, and resolving that name to either owner would dispatch the call to a tool the caller
  may not have named, so it is treated as ambiguous and fails before dispatch too.
  Assistant reasoning replay likewise follows the Cognition wire shape. One history prompt carries
  a single thinking/signature pair, so every block with text is replayed at #11 and #12 is attached
  only when the text being replayed is the text that signature attests — the single-block case.
  Several independently signed blocks send the joined chain unsigned rather than pairing one
  block's attestation with another block's words, and rather than dropping reasoning the turn
  produced to keep a pair. A signature-only block carries encrypted thinking that is not replayed,
  so it contributes neither the text nor the signature. The signature is replayed only when the
  source envelope actually carried one: the serialized reasoning item the Responses parser parks
  on unsigned thinking parts is provider state, not an attestation, and
  `isProviderIssuedThinkingSignature` in `src/responses/reasoning-envelope.ts` denies that one
  shape beside the code that writes it. It is a deny-list rather than a guess at what an opaque
  token looks like; the stricter base64 allow-list in `src/adapters/anthropic.ts` is a fact about
  Anthropic's wire and is not assumed of Cognition's.

  There is no second Devin transport. An Agent Client Protocol adapter that spawned a local
  `devin acp` child once existed under the `devin-cli` adapter id and was removed: the CLI's
  credential turned out to be the ordinary cloud token, so the child process bought nothing that
  importing the token did not, and it cost a placeholder `buildRequest`, a disabled
  `parseStream`, an identity-only `baseUrl`, and a subprocess running in the operator's tree.
  The merge migration rewrites the canonical `devin-cli` provider id. A custom-named row that
  still names the retired adapter is left on that unknown id so requests fail closed until the
  operator explicitly selects `devin` and configures Devin authentication.

  Before spending a chat roundtrip the adapter runs a catalog pre-flight:
  `src/adapters/devin/cloud-direct/catalog.ts` fetches `GetCascadeModelConfigs` and preserves
  `ClientModelConfig` field #4 as the per-account disabled gate, field #18 as the per-account
  context window, and field #5 as an optional `supportsImages` tri-state — a present value
  asserts image support or its absence, while an omitted field stays unknown (the #1796
  precedent). `src/adapters/devin/live-models.ts` collapses that tri-state across the
  rows each base model's collapsed UID gathers — the EFFORT_TOKENS suffixes, tier rows
  like `-1m` included: unmeasured rows abstain, unanimous measured rows advertise
  `["text"]` or `["text", "image"]`, and measured disagreement stays unadvertised.

  At dispatch the adapter reads the same per-account/host cache once more for the
  exact selected wire UID and forwards `completionOpts.maxInputTokens`: the smallest
  of that row's field #18 window and any valid configured model/provider input
  hints, so `CompletionConfiguration` field #3 no longer serializes the encoder's
  128000 fallback. Smaller operator hints cap live evidence and never enlarge it;
  with no evidence the adapter hint is omitted and the encoder still serializes
  its own 128000 fallback for field #3. Connect trailer diagnostics expose only an
  allowlisted error code, hexadecimal trace id and typed `retryAfterSeconds`, optionally rendered as
  generated `retry after ~Ns` wording; raw text stays internal because it can reflect credentials. Investigation and limits:
  `devlog/_plan/260917_devin_input_ceiling/000_review.md`.

The registry records those relationships with `contractParent`. A parent relationship does **not** mean the registry recursively constructs a parent adapter and injects it into the child. Azure and MiMo keep owning their existing internal composition. This avoids making production constructors depend on test/conformance needs and keeps this authority refactor behavior-neutral.

Codex Spark retirement removes model-specific exceptions from the Responses adapter, without
changing contract inheritance or generic Responses Lite handling; see
[Responses transport](../transports/responses.md#responses-httpsse).

## Wrapper-cycle and runtime validation policy

`effectiveAdapterContract()` follows `contractParent` links at runtime with a visited set. Unknown parents and cycles fail closed. This is intentionally runtime validation: registry/config values can originate in persisted files written by older or hand-edited installations, so compile-time typing alone is not an adequate boundary.

## Extension policy

Adding a production adapter requires:

1. one `ADAPTER_REGISTRY` entry with its factory;
2. either a direct `wire` + mutation contract or an explicit `contractParent`;
3. provider/model adapter ids that point only at registered ids;
4. registry-derived conformance coverage in the follow-up conformance layer.

Do not add a second switch/list of adapter factories in request routing. Focused tests may construct a concrete adapter directly when they are testing that adapter itself; cross-adapter production routing should use registry authority.

## Scope boundary

This decision does not change routed `apply_patch` behavior, Cursor structured-edit conversion, Azure/MiMo request construction, or provider wire selection. Those behaviors remain owned by their existing modules and focused tests. The registry exposes the universe and semantic relationships; the next stack layer consumes that metadata for generic conformance.

Registry selection neither derives nor consumes Google's endpoint-scoped
[tool-schema loss report](../providers/google.md#google-tool-schema-loss-reporting). That report is
owned by the selected adapter's final compiler and cannot affect adapter selection.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Moonshot `$ref`-with-siblings normalization

Moonshot/Kimi enforce the draft-07 reading where `$ref` must stand alone and 400 the whole
request when a node carries both. Codex's own deferred tool catalog emits exactly that shape,
so the schema is not something a user can fix from configuration (issue #2673).

> Decision record: [ADR-0093](../decisions/ADR-0093-moonshot-ref-with-siblings-normalization.md)

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../gui-and-management-api.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
## Truncated tool finalization

The bridge keeps an open function, custom, or tool-search call incomplete when an adapter ends with a recognized truncated stop reason. Streaming emits no argument/input completion frame for that open call, and buffered JSON applies the same status. A call already closed by its own tool-call end retains its completed state. The response remains incomplete, partial output is preserved, and truncated compaction never replaces history.

A provider web search still in flight at that truncated terminal is finalized as `failed`, the same status it already receives from the error and explicit-incomplete terminals. It never returned results, so reporting it as `completed` would leave the client showing a finished search for a turn the provider cut short.

`src/adapters/anthropic.ts` maps a `refusal` or `content_filter` stop reason to an explicit `incomplete` adapter event with `reason: "content_filter"` and `retryable: false` instead of `done` with that stopReason (#4312). Codex otherwise treats a filter incomplete without retryable as a dropped stream and retries a refusal that cannot succeed. Partial output, tool-call integrity, and usage are preserved; `max_tokens` remains a `done` so a legitimate truncation can continue.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Adapter events distinguish raw reasoning content from summary-channel thinking; CCA Gemini classification is request-local. See [Google provenance](../providers/google.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary. Translated and native Chat builders share explicit gateway-object and tool-bearing effort-omission policy after provider resolution; native Chat otherwise preserves caller controls and removes effort for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

## SWE-2 model effort selection

`src/adapters/devin.ts` resolves an explicit SWE-2 reasoning effort to the native
medium/high/max UID before accepting a suffix already present in the model id.
The merged `devin` provider uses this resolver for every account, whichever login
path minted the credential. Omitted effort preserves an explicit
variant; unrelated model families retain their existing suffix precedence.


## Untranslated input media

`src/responses/input-media.ts` inspects actual content blocks and typed tool-output arrays
without parsing text or function arguments, copying attachment payloads, resolving file IDs,
or fetching URLs. Audio and file-ID-only images have no lossless normalized carrier, and
neither does a file or document reference that carries no bytes. The scanner returns only an
input-kind name, never client content.

A document that carries its own base64 bytes is the one exception, and only in user or
developer message content: `src/responses/inline-document.ts` decodes it into the
`OcxDocumentContent` part, which the Anthropic, OpenAI Chat and Gemini wires emit as a native
document, file part and `inline_data` respectively. Every other position — tool output, system
and assistant content — is still refused, because those converters reduce their content to text
and exempting them would restore the silent drop the scanner exists to prevent. The scanner and
the decoder share one predicate so a request cannot be exempted here and reduced to a marker
there.

`src/adapters/input-media-guard.ts` guards adapters created by the registry after effective
wire selection. A translated `buildRequest` refuses these inputs through the existing 400
error path; `runTurn` emits one nonretryable `unsupported_input_modality` error without
starting its underlying transport. `localTerminal` declines a success shortcut for such a
request, letting the guarded builder return the error instead. The original raw body stays
unchanged, including when another final adapter is selected after a failed attempt.

The effective Responses wire, including both Azure aliases, is excluded: it forwards the
original body and leaves native media acceptance to its upstream. This exception does not
claim that every Responses model supports every attachment. Native Chat also keeps its
existing wire; only an actual Chat-to-Responses projection rejects audio/file blocks before
losing them. Legacy function-result images fail explicitly because that projection does not
implement legacy call/result pairing. Modern tool-image carriers are unchanged.

`tests/adapters/adapter-input-media-guard.test.ts` covers hook ordering, error events and
raw passthrough; `tests/responses/chat-media-translation.test.ts` reaches the real HTTP
translation boundary and verifies that rejection sends no upstream request.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Unicode pattern normalization uses [copy-on-write traversal](../transports/byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

## Devin image boundary

The registered Devin implementation in `src/adapters/devin.ts` maps data URLs to its native image field. Its textual fallback accepts only bounded HTTPS references and emits a fixed-size omission marker for unsupported or oversized values.

A [compaction routing override](../transports/responses.md#compaction-routing-overrides) selects its target before adapter resolution and uses the existing registry factory.
