# Chat Provider Compatibility

## Reasoning and tool-result compatibility

Kiro groups only consecutive original-message tool results whose raw call ID exactly matches
the originating call. Its wire-ID map retains the original ID privately so replacement or
truncation collisions cannot join unrelated results. Every non-tool message ends the group,
including a reasoning-only assistant omitted from the Kiro turns. Group finalization preserves
single-result normalization, ordered meaningful raw text and whitespace in multi-result output,
failure text, image order and sticky error status. Empty hints are applied once for an entirely
text-empty group, not once per chunk; local grouping state never enters the wire payload.

`src/responses/task-input.ts` recognizes complete external Codex task-input envelopes
before translated Responses adapters: `function_call_output`, no `call_id` property,
nonblank `id`/`name`/`namespace`, and fully representable nonempty text/image output.
`parser.ts` emits a user turn, clears pending reasoning and includes that turn in the
existing continuation conversation-boundary calculation. The metadata is structural,
not authentication. Unknown/opaque/malformed parts reject the entire conversion;
ordinary missing/empty tool call ids retain the existing translated-route 400 guard.
Native passthrough and compaction retain raw-body handling. The leaf reuses the input
content converter after validation and imports no optional subsystem.
Stateful developer-guidance injection reuses that validator for its raw insertion
boundary, so parsed messages and stored raw history retain the same task/guidance order.

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

After a self-identified opaque-blob rejection, the proxy also keeps a five-minute rejection memo.
The memo key is the resolved conversation identity plus the durable serving identity: provider,
destination, adapter, model, and credential. It is recorded only when the blobless recovery resend
succeeds. A missing durable destination or credential prevents memo creation and lookup. On a later
request with the same key, pre-flight sanitation removes opaque reasoning `encrypted_content` and
degrades compaction blobs before the first upstream send. This skips the rejected first send and
the recovery round trip. A different serving identity does not match the memo. Route changes still
follow the normal pre-flight stripping rule. Memo expiry returns to the fail-soft recovery path.

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

> Decision record: [ADR-0051](../decisions/ADR-0051-reasoning-and-tool-result-compatibility.md)

DeepSeek's stateless Responses compatibility pass normalizes only unambiguous tool-call batches.
Calls emitted before the first matched output stay together as one assistant batch, followed by
their outputs in call order; hook-injected messages that split the batch move after it without being
dropped. This preserves #1292's single-call adjacency repair without splitting a same-turn parallel
batch away from its preceding plaintext reasoning (#1477). Tolerant providers never enter this pass,
and duplicate, missing, or backwards call/result pairs are left for the upstream to reject rather than guessed.

> Decision record: [ADR-0052](../decisions/ADR-0052-reasoning-and-tool-result-compatibility.md)

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
rotation keeps it — along with every other registry backfill — because the retry starts from the
fresh committed provider row and routes it again (`rotateProviderTransportOn429` in
src/providers/key-failover.ts). Stale request-time config fields are deliberately discarded so a
concurrent deletion stays authoritative; only runtime `fetch` state and generated OpenCode session
affinity survive the rebuild. If an opted-in upstream rejects the field, OpenCodex does not strip it and retry or mutate the
saved configuration. Other OpenAI-compatible providers remain deny-by-default because strict
backends may reject the OpenAI-specific field.

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

> Decision record: [ADR-0063](../decisions/ADR-0063-volcengine-ark-assistant-continuation-shapes.md)

## Chat structured-output compatibility

First-party Kimi and Moonshot Chat destinations normalize a `$ref` with sibling keywords because
their wire rejects that valid JSON Schema 2020-12 shape. Inlining preserves conjunction semantics:
`required` members are unioned, lower numeric bounds take the maximum, upper numeric bounds take the
minimum, and overlapping `properties` recurse with the same rules. The walk remains depth-, node-,
and expansion-bounded. Unresolvable or cyclic references keep the existing bare-`$ref` fallback,
and unrelated OpenAI-compatible providers retain the caller's schema unchanged.

> Decision record: [ADR-0064](../decisions/ADR-0064-chat-structured-output-compatibility.md)

The `openai-chat` adapter translates Responses `text.format` and Chat Completions
`response_format` through one internal format, then emits `response_format` on the upstream chat
wire. That remains the default because silently returning prose breaks clients that requested a
JSON object or schema. A mixed-capability gateway may list exact native model ids in
`noStructuredOutputModels`; only those models omit the wire field, while siblings keep the normal
translation. The proxy does not infer this from provider names, localhost destinations, or a model
family shared by unrelated upstreams.

> Decision record: [ADR-0065](../decisions/ADR-0065-chat-structured-output-compatibility.md)

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

> Decision record: [ADR-0066](../decisions/ADR-0066-anthropic-structured-output-compatibility.md)

## Reasoning display parity (hideThinkingSummary)

Reasoning-envelope serialization uses preflight byte sizing and transient reservations before
creating JSON, UTF-8, or base64 copies. Encoding also admits the matching decode projection, so
a successfully encoded standalone envelope fits the standalone decoder's limit. Callers retain
ownership of returned values; the helper releases only its temporary reservation. Inbound
Anthropic translation carries one budget across all assistant blocks and accounts for retained
envelopes until the response lifecycle disposes it. Standalone translation owns a temporary
budget and disposes it on success or failure. Final translated-request sizing uses plain-JSON
measurement rather than allocating a serialized copy just to measure it.

> Decision record: [ADR-0067](../decisions/ADR-0067-reasoning-display-parity-hidethinkingsummary.md)

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

> Decision record: [ADR-0068](../decisions/ADR-0068-reasoning-display-parity-hidethinkingsummary.md)

## Chat streamed tool-call identity

`src/adapters/openai-chat.ts` retains a call's first observed non-negative safe integer
index as an alias when the call started by ID. Every present, non-null index must
be a number in that range: strings (including numeric and empty strings), booleans,
objects, arrays, negative numbers, fractions and unsafe integers terminate the stream
before any key, alias, ID or last-call matching. `Number.MAX_SAFE_INTEGER` is accepted;
larger integers are rejected because distinct wire literals can parse to the same number.
The invalid-index error releases all pending call reservations without emitting
those calls or a successful completion; invalid indexes are never treated as absent.
Only missing and null indexes are absent-index placeholders. Repeated ID, name and
argument string-field tolerance retains its existing rules.

For valid indexes, lookup preserves direct-key precedence, then index alias, then
ID fallback. The initial key continues to own all translator budget reservations
and release; learning an alias creates no additional owner. Unassociated index-only
fragments are not guessed onto pending ID-only calls.
`tests/adapters/openai/openai-chat-parallel-stream.test.ts` covers late aliases,
parallel/colliding identities, distinct unsafe raw JSON index literals, the maximum
safe-integer boundary, invalid index types, missing/null continuations and UTF-8
byte-limit boundaries.
