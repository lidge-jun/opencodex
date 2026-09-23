# Chat Provider Compatibility

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Cursor's localized native-shell names follow the [routing-commentary guard contract](cursor.md#cursor-native-exec).

Native Codex Spark-specific request exceptions are absent. General Lite and namespace repair
remain shared [Responses compatibility](../transports/responses.md#responses-httpsse), including
other providers whose models happen to share a name fragment.

## Chronological in-conversation instructions

`src/adapters/openai-chat/messages.ts` keeps a text-only timeline developer message in the
slot it arrived in, on every Chat destination and model. Appending a reminder therefore does
not hoist new text into the leading system prompt and rewrite the existing serialized message
prefix, and a mid-conversation instruction no longer moves ahead of the turns it was written
to follow. Pending tool results still precede deferred reminders. This was previously scoped
to the registry-recognized OpenCode Go destination and the exact model
`deepseek-v4.1-flash`, which made prompt-prefix stability read as a property of that one
destination. The base system prompt, vision conversion and native OpenAI developer roles
retain their existing behavior. This is independent of the Claude trailing-notice
stabilization option and does not guarantee upstream cache hits. Regression coverage is in
`tests/adapters/openai/openai-chat-system-order.test.ts` and
`tests/adapters/openai/openai-chat-developer-position.test.ts`.

The role that slot carries is a separate decision, and the setting that makes it is tri-state.
`foldDeveloperRoleToSystem` unset sends `system`, `true` sends `system`, and `false` sends
`developer`. Unset means nothing has been recorded about the destination; `true` records an
upstream that rejects the role; `false` records one that accepts it. The message keeps the slot it
arrived in in every case — only the role changes, never the position. The unrecorded state is the
folded one because a destination that rejects the role answers
`400 role 'developer' is not allowed` and the turn never starts, a failure that lands outside this
repository where no test can reach it. The role was previously decided by testing the base URL host
against `api.openai.com`, so every OpenAI-compatible gateway was assumed not to support a standard
role until proven otherwise, and the instruction silently lost `developer` precedence.

That mapping is not prose to be restated. `tests/ci-workflows/docs-developer-role-policy.test.ts`
builds the sentence above from the role `src/adapters/openai-chat/messages.ts` serializes for each
of the three states, and requires this document and
`docs-site/src/content/docs/reference/configuration/providers.md` to carry it word for word, so a
changed default fails a check rather than only a document review (INV-CHAT-01). The translated
configuration pages and Claude Code guides are held against their English source in the same file.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts.

## Reasoning and tool-result compatibility

### Inline think-tag recovery

A gateway that serves a thinking model without a server-side reasoning parser returns the chain
of thought inside `message.content` as `<think>` / `<thinking>` / `<reasoning>` blocks and sends
neither `reasoning_content` nor `reasoning_details`. `src/adapters/openai-chat.ts` recovers those
blocks into reasoning only for models listed in `inlineThinkTagModels`. An explicit operator list,
including `[]`, replaces matching registry defaults. The option is off by default because registry
providers share this adapter and a gateway that does parse reasoning
must keep its visible content byte-exact. Once enabled the splitter still engages only for a
response that opens with a thinking tag (optionally preceded by whitespace), so ordinary prose or
code fences before a tag leave the entire response untouched. Whitespace before that initial tag
and after every closing tag remains answer text;
after it engages it keeps splitting later blocks, because M-series models interleave thinking with
answer segments, including same-line interleaving. Once engaged, tags are protocol delimiters even
inside subsequent code fences or quoted examples: this explicit opt-in does not parse Markdown.
Gateways producing ambiguous literals should use structured reasoning instead. A moving cursor
scans each upstream chunk without copying the remaining response after every block. Only undecided
leading input or a trailing tag fragment is retained and charged to the translator budget.
Undecided leading whitespace is charged one incoming segment at a time and joined only when
the initial format is decided or the stream ends.
A block left unterminated at end of stream flushes as reasoning rather than being
dropped. In interleaved Chat mode, whitespace after the leading block and after later blocks
remains answer text, including indentation and blank lines. Kiro uses single-block mode and
retains its existing first-answer normalization.
`src/adapters/inline-think-tags.ts` owns the parser and is shared with the Kiro adapter,
which consumes it in single-block mode with its existing leading/first-answer normalization.
Regression coverage is in `tests/adapters/openai/openai-chat-inline-think-tags.test.ts` and
`tests/adapters/openai/inline-think-boundaries.test.ts`.

Google tool-declaration narrowing is observed by the Google final compiler, not this shared Chat
compatibility layer. Its endpoint profile and privacy boundary are specified in the
[Google provider contract](google.md#google-tool-schema-loss-reporting).

Chat models sometimes return a freeform call body under a common alternate field or wrap the whole
body in a Markdown fence. Restoration in `src/responses/apply-patch-envelope.ts` is deliberately
narrow: only bare or `default.`-prefixed `exec` and `apply_patch` accept one recognized alternate field or one complete
outer fence, while ambiguous wrappers and provider-owned freeform grammars remain byte-exact.
Structured shell arguments mistakenly sent to code-mode `exec` follow the shared
[Responses restoration contract](../transports/responses.md#responses-httpsse), including preview
holding and preservation of valid JavaScript fallback fields.

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

Native OpenAI passthrough consults the existing configured capability ladder before forwarding
`reasoning_effort`; an explicitly empty ladder removes that unsupported control while an unknown
ladder remains unclassified. Both Chat builders then apply the same explicit provider declarations:
gateway-object projection and tool-bearing model effort omission. An unset declaration preserves the
native caller field exactly. Native passthrough also sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.
It also repairs the opposite direction (260718): an assistant `tool_calls` round left dangling —
by an intervening user/developer barrier or an interrupted turn — is closed by deferring barrier
messages until the round completes, reattaching real results to their original call occurrence,
and synthesizing explicit "no tool result was recorded" answers only when no real result exists
(Kimi/Moonshot 400 `ocx-mrqaiw05-269`; unit `devlog/_fin/260718_dangling_toolcall_hardening`).

The native Ollama wire carries the same contract. `src/adapters/ollama-native.ts`
`buildNativeMessages` defers `user`/`developer` messages that arrive while a batch is open and
releases them after the tool messages, and answers a call with no result anywhere in the replayed
history with the same `[ocx] no tool result was recorded for "<name>"` marker. The shape it
absorbs is ordinary Codex history, not a malformed one: Codex records mid-turn items (a
`PostToolUse` hook verdict, a context notice) between an assistant `tool_calls` message and that
call's own result. The strict pair checks (orphan result, duplicate result, result naming another
tool) still throw on both wires (#4842).

Forward-mode OpenAI passthrough also repairs replayed `call_id` values longer than the Responses
API's 64-character limit. Sidechat/fork replay can namespace routed-provider ids beyond that limit,
so each oversized id and all matching call/output items receive the same deterministic,
request-local alias. Raw API-key continuations deliberately preserve ids because an output-only
continuation may reference a call stored upstream under its original id; proxy-expanded API-key
replays are explicit and receive the same repair.

Tool-name normalization stays adapter-scoped. The translated Chat Completions path uses a
request-scoped registry in `src/adapters/openai-chat/`: only flattened namespaced names over 64
characters receive a deterministic, charset-safe alias. Catalog declarations, replayed calls and
`tool_choice` share that registry, and streamed or buffered echoes restore to the original flattened
name before the Responses bridge restores `{namespace, name}`. Names at or below the bound and bare
names pass through unchanged, except declarations matching the reserved alias shape; those are
re-aliased so they cannot shadow an identity-derived alias.

The 64-character bound is a Chat Completions and strict-gateway compatibility concern: Command Code
rejects a 66-character function name (#4679). Upstream Codex raised its own MCP ceiling to 128 bytes
in `openai/codex#39594` because native Responses accepts 128, so that Responses limit does not govern
this translated wire. Kiro (`src/adapters/kiro-tools.ts`), Google (its wire compiler), and Meta Muse
Responses (`src/responses/muse-tool-name-alias.ts`, gated to `api.meta.ai`) each retain their own
equivalent normalization and restoration.

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
self-identifying opaque-blob 4xx (`invalid_encrypted_content`, a reasoning `encrypted_content`
that "was not issued to this caller" (#4469), or xAI's two `invalid-argument` decoder errors),
the proxy rebuilds once through the same sanitation path: reasoning
`encrypted_content` is removed and compaction blobs use the existing text degradation. A one-shot
guard makes a second rejection terminal, and a successful recovery records the current serving
identity so later route changes return to deterministic pre-flight. A cold-record cross-backend
switch therefore costs one extra upstream round trip and one turn of degraded reasoning, rather than
wedging the thread; unrelated 4xx responses and requests whose outbound body carries no blob never
enter this recovery.

Recovery is admitted for every adapter whose registry contract resolves to the Responses wire
(`adapterSpeaksResponsesWire` in `src/server/responses/core-opaque-recovery.ts`, through
`resolvedAdapterWire`), not for one adapter name. `openai-responses` qualifies directly and
`azure`/`azure-openai` through `contractParent`; before #5583 a name check left Azure's wrapper of
the same passthrough outside recovery. Once the destination itself has rejected foreign opaque
state, replayed reasoning items also lose their `id`, with or without a blob: the id names an item
in the refused identity's store,
and without `store: false` a stateful destination resolves it against its own store and answers
`Item with id 'rs_…' not found` on the recovered send. `_dropForeignReasoningItemIds` carries that
signal from `prepareOpaqueBlobRecovery` and from the rejection memo below into
`sanitizeReasoningInputContent`. A proven route switch sets it only when the durable destination or
credential changed (`reasoningReplayItemStoreChanged`): that is when the id names another store. A
model or adapter change on the same destination and credential strips the blob but keeps the id,
which that store can still resolve.
`tests/responses/responses-azure-opaque-blob-recovery.test.ts` runs the switch on both adapters.

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

That pass is gated by `requiresAdjacentResponsesToolResults`, not by provider name. Kimi's Code Plan
Responses endpoint enforces the same strict shape and rejects a hook-split pair with HTTP 400 (#4726),
so `kimi` and `kimi-code` carry the flag as well. The flag is inert while those presets use the Chat
wire and takes effect when a row is configured onto `openai-responses`, which is the configuration the
report exercised. xAI Grok 4.6/4.5 subscription Responses carries the same flag: after a mid-stream
interrupt, Codex can replay a `function_call` with hook-injected developer context between it and
its output, and later turns 400. The adjacency pass itself still does not invent duplicate or
backwards pairs. No upstream specification documents the adjacency requirement; the evidence is the observed
400 and DeepSeek's identical failure shape, which is why this stays a per-provider capability rather
than a wire-wide default — upstream Codex leaves an intervening developer message where it is.

A mid-stream interrupt produces a second, different shape: a call whose output never arrived at all.
That is `requiresPairedResponsesToolResults`, a separate capability, and the separation is the whole
point. Adjacency reorders items the upstream would accept in some order; pairing synthesizes an item
the client never sent, which puts a tool turn into the conversation that did not happen. The evidence
differs too — #4726 shows Kimi accepting a call with no result at all, so `kimi` and `kimi-code` keep
adjacency and do not receive placeholders. `xai` carries both. `statelessResponses` implies pairing,
which is how DeepSeek already had it: an upstream that stores nothing cannot resolve the missing half
from its own history either.

xAI's public Responses API is stateful (`store` defaults true; `previous_response_id` continues a
stored conversation), so the provider is not marked `statelessResponses`. The pairing repair
synthesizes an honest unknown-status placeholder without touching `store` or
`previous_response_id`: repairing an interrupted history must not cost the thread its server-side
state. An output-only continuation is preserved because its call may live in that server-side state;
pairing only synthesizes results for calls present in the current input. Forward auth suppresses the
synthesis regardless of the flag, because the backend that holds the conversation can resolve the
pair itself. Replay-miss reasoning cleanup remains independent of whether orphan outputs are
converted. A retained previous-response ID does not override an explicit custom-tool denial below.

> Decision record: [ADR-0052](../decisions/ADR-0052-reasoning-and-tool-result-compatibility.md)

## Declared hosted-tool denials

A gateway that speaks the Responses API does not necessarily accept everything OpenAI accepts.
`unsupportedHostedTools` is how such a destination says so: it names the hosted tool declarations
this provider rejects, and `stripUnsupportedHostedTools` in
`src/adapters/openai-responses/tool-schema.ts` removes them from `tools`, from client-loaded
`additional_tools`, and from `tool_choice` before the body is serialized.

The capability is provider-declared rather than destination-matched, and that is the point. The
original mechanism in `src/responses/hosted-tool-policy.ts` was a table of `(model, baseUrl)`
predicates, so a narrower gateway could only be supported by shipping a proxy release naming its
endpoint. The reported destination (#5002) accepted plain Responses requests and `function` tools
but rejected hosted `web_search` with HTTP 400 `unsupported_request`, which meant a text-only
prompt failed before the model answered, because Codex's hosted declaration travelled with it. A
provider nobody has classified can now describe itself in config.

The declaration is additive to that table, not a replacement for it. The table still covers
destinations that reject a tool regardless of configuration, so an operator who never heard of the
field stays protected; a declaration can only deny more, never re-enable a known-broken pairing.

Two properties are deliberate. Spelling variants of one capability are aliased, so declaring
`web_search` also denies `web_search_preview` — the rest of the proxy already folds that pair into
a single tool, and honouring only the spelling the operator happened to write would reproduce the
original 400 while the config claimed to have prevented it. And the value is validated against a
closed vocabulary in `src/config/schema/leaf-validators.ts` and `src/server/auth-cors.ts`, because
the provider schema ends in `.passthrough()`: an unvalidated misspelling would be persisted and
then match no tool, leaving the operator with the upstream rejection this field exists to prevent
and nothing explaining why. That is the `codexToolMode` lesson from #2106.

This capability is independent of `supportsResponsesCustomTools`, which denies native `custom`
tools and `custom_tool_call` items. A gateway that rejects both sets both; neither implies the
other.

When that capability is explicitly false, `src/responses/custom-tool-compat.ts` also lowers valid
historical custom-call/result pairs absent from the live catalog, without adding their names to
current declaration or restoration sets. Malformed or duplicate call identities and collisions
with live function names fail closed. Unmapped custom outputs request full replay; residual native
items fail the final outbound guard and map to HTTP 400. True or unspecified support preserves the
existing native path. Nested tool-output JSON remains data, not a protocol item to rewrite.

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

## Serialized tool-call content

Some Chat gateways expose one model-produced call twice: as a complete
`<tool_call><function=…>…</function></tool_call>` content block and as a structured `tool_calls`
entry. `src/adapters/openai-chat/serialized-tool-call-content.ts` recognizes bare blocks at the
start of a line outside Markdown fences; inline, quoted and indented examples remain unchanged.
It holds a possible serialized block, resumes ordinary text delivery when the header cannot match,
and removes the block only when its function name and
freeform body match a structured call's parsed `input` in the same response. If the gateway also prefixes the structured call's JSON
arguments with the same freeform body, the adapter keeps the JSON suffix only when the block body,
prefix, and wrapper's `input` value all agree. Mismatched markup and arguments remain byte-exact.
Silent held-content frames emit adapter heartbeats. Terminal errors and transport read failures
drain all held text, including matching serialized blocks, because pending tools are not dispatched.
The held bytes use the shared translator budget. For a model opted into inline `<think>` splitting,
reconciliation sees only the answer text the splitter emits. A reasoning event that arrives while
a block candidate is held waits behind it and is released in its original position, so event order
never changes and a duplicate is not exposed early; line and fence context carry across the
answer text on both sides of a think section. Streaming and buffered responses use the same
matching and repair rules; regression coverage enters through `/v1/responses` in
`tests/responses/responses-chat-tool-call-content.test.ts`.

> Decision record: [ADR-5548](../decisions/ADR-5548-serialized-tool-call-content.md)

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
expansion-, and inline-byte-bounded: each inlined reference is charged its serialized size against
one 1 MiB allowance shared by every tool in the request. Raw target bytes are reserved before
normalization. A candidate expansion restores its byte, node, and expansion allowances when
it falls back; nested retained copies spend the allowance once, and only additional outer growth
is charged. Moonshot's validator requires an explicit object termination type for recursive
unions, so a schema carrying `properties` or `additionalProperties`, or an `allOf` with such a
member, is emitted with `type: "object"`. This narrows scalar instances that JSON Schema would
permit; tool-argument schemas do not rely on those scalar instances. Non-object `allOf`
compositions, such as string constraints, remain untyped. An over-budget reference keeps the
bare-`$ref` fallback.
Unresolvable or cyclic references do the same, and unrelated OpenAI-compatible providers
retain the caller's schema unchanged.

> Decision record: [ADR-0064](../decisions/ADR-0064-chat-structured-output-compatibility.md)
> Decision record: [ADR-0355](../decisions/ADR-0355-chat-structured-output-compatibility.md)

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

`hideThinkingSummary` is set for explicit summary "none", or omitted summary without a validated
active effort. Accepted minimal/low/medium/high/xhigh/max (including ultra normalized to max)
allow raw visibility when summary is omitted; none and invalid efforts do not. Explicit "auto"
still permits raw visibility independently of effort. This flag is
honored by BOTH reasoning paths: anthropic `thinking_delta` AND raw `reasoning_raw_delta`
(openai-chat `reasoning_content`, kiro tags). Hidden reasoning emits an envelope-only reasoning
item (`summary: []`, txt-only `ocxr1:` `encrypted_content`, no text deltas) — invisible in the
Codex app, so tool cells group like native models — while the text still round-trips for
`preserveReasoningContentModels` replay. Visible mode (summary "auto") keeps the raw
`content[reasoning_text]` shape: raw deltas stream as `response.reasoning_text.delta` and the final
item carries `content: [{type: "reasoning_text", text}]`, so Codex applies its own display policy —
the desktop thinking band shows the "Thinking…" placeholder, and raw text appears only when
`show_raw_agent_reasoning` is enabled. Routing raw CoT through the summary channel instead (the
#45 display intent, intentionally reverted 260911) put unsummarized thinking in the desktop band,
which only fits native OpenAI providers that author real summaries. Diagnosis and codex-rs
grouping evidence: `devlog/_fin/260709_native_response_pattern/`.

For models that require a reasoning placeholder, a preserved thinking-only assistant turn with no
plaintext receives that placeholder even when it has no tool call. Otherwise the Chat serializer
drops the turn and strict DeepSeek continuations can reject the following request (#5421).

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

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.
## Anthropic parallel tool use

`options.parallelToolCalls === false` maps onto Anthropic's nested
`tool_choice.disable_parallel_tool_use`. Because the flag lives inside
`tool_choice`, a request that carries only the parallel intent and no explicit
choice gets a synthesized `{type:"auto"}` so the flag has somewhere to live;
`required` maps to `{type:"any"}` and a named choice to `{type:"tool"}`, and both
accept it. `{type:"none"}` does not receive the flag because tool use is already off,
and a request with no tools on the wire emits no `tool_choice` at all. An unset or
true `parallelToolCalls` is byte-identical to previous behavior.

The flag constrains the model's output, not execution ordering. Sequential tool use
is enforced by the caller's own loop returning each `tool_result` before issuing the
next request; this mapping does not provide that.
## Unmapped modalities are recorded, not dropped

The translated Chat route has no video mapping — this adapter does not implement one.
Both serialization branches emit a bounded marker for a video part: the image-bearing
branch previously produced `{type:"text", text: undefined}`, a malformed part, and the
text-only branch joined it to `""` so a video-only or text-plus-video message was
dropped entirely. The marker names opencodex's own missing mapping; it does not assert
anything about the provider's or model's capability, which the proxy has not
established. Native Chat passthrough and Google inline video are separate routes and
are unaffected.

`input_audio` parts are recognized in the shared Responses parser and recorded as a
presence marker in the translated IR. This is **presence only and not audio support**:
the IR has no audio carrier and no adapter consumes one. The parser stays non-throwing
because the native Responses passthrough also runs through `parseRequest` before the
adapter forwards `_rawBody`, so refusing there would regress raw passthrough.

The final registered adapter also checks the original input under the
[untranslated-media contract](../adapters/registry.md#untranslated-input-media). Audio/file
attachments cannot succeed merely because the normalized representation retained a text
marker: translated adapters refuse them, while native Responses retains the original body.
Chat conversion rejects recognized audio/file parts before projection, except a user-content
file part whose inline base64 bytes now have a lossless carrier; the native Chat wire is
unchanged. No audio transport and no automatic URL fetch is added, and no client filename,
payload, URL or metadata is included in the new error messages.

The shared coding-agent projection (CodeBuddy, Qoder) carries tool-result images as
real image blocks rather than flattening them to the text `[image]`, and orders image
blocks chronologically — history before current — so attachment order matches the
prose the model reads beside them. Vendor tool execution stays disabled on both
adapters. CodeBuddy refuses an unquoted, line-oriented full-width-bar DSML `calls`
container followed by a named bare or namespaced invoke control line in either output channel; it
preserves preceding answer text, never promotes vendor prose into execution authority,
and leaves discussed or quoted literals and code examples untouched. Qoder's explicit
refusal of original images is unchanged.

Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Unicode pattern normalization uses [copy-on-write traversal](../transports/byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.
