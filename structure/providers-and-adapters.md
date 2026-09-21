# Providers And Adapters

OrcaRouter key exchange uses the shared raw-byte reader before returning a durable key. Its
64 KiB response ceiling, single 30-second header/body deadline, and cancellation behavior follow
the [bounded ingestion contract](transports/inventory.md#bounded-response-ingestion-and-orcarouter-login).

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Compatibility facade; canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata live in `src/providers/registry/entries-core.ts` and `entries-extended.ts`, with model seeds in `model-seeds.ts`. |
| `src/providers/registry/model-ids.ts` | Classifies every `ProviderRegistryEntry` field by what its KEYS mean for selector decoding, and derives the native model ids an entry names. The classification is exhaustive by construction: a new registry field fails typecheck until its keys are given a meaning, which is what stops an identity-bearing map from being silently left out of decoding. Imported directly rather than through the facade, which is at its file-size cap. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/providers/resolved-model-policy.ts`, `src/providers/resolved-model-policy-merge.ts` | Static provider/model policy resolution for the final upstream wire model, plus its pure clone/merge/URL/family helpers. The resolver detaches and freezes registry defaults, operator overrides, exact explicit input-modality declarations, hard wire pins, aliases, and explicit false/empty values with field-level provenance. Provider derivation, routing, catalog hints, gather admission, and adapter selection consume its detached frozen result. Callers supply transport match, the exact capability row, and a credential-free effective auth decision; credential bytes, usability evidence, account/quota/health state, and observed limits remain outside the result. |

| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. Kiro add-account identity prefers same-session `whoami` over a leftover SQLite state profile, and never persists the Builder ID service profile ARN as `accountId`. |
| `src/combos/request.ts` | Clones each selected combo target request and applies the existing target capability ladder: adaptive unknown targets and explicit empty ladders receive no unsupported reasoning/thinking controls, while known ladders retain per-target resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/responses/muse-tool-name-alias.ts` | Host-gated Meta Muse 64-char tool-name alias/restore used by the Responses passthrough. |
| `src/adapters/openai-chat.ts`, `src/adapters/openai-chat/` | OpenAI-compatible Chat Completions bridge, split into leaves (`wire.ts`, `messages.ts`, `response-events.ts`, `passthrough.ts`, `parallel-tool-calls.ts`, `reasoning-wire.ts`, `tool-call-validation.ts`, `tool-schema.ts`, `errors.ts`). `parallel-tool-calls.ts` owns the `parallel_tool_calls` wire value for both the translated and native builders, so the three provider states — configured opt-out, configured opt-in, and the unset default that forwards only a caller's explicit `false` — cannot drift between them. `reasoning-wire.ts` applies explicit gateway-object and tool-bearing effort-omission declarations to both builders; absent declarations leave native raw forwarding unchanged. Its client delivery shapes in `src/chat/outbound.ts` and `src/server/chat-native-sse.ts` relay the upstream `service_tier` echo on non-stream, folded-stream, and synthesized-SSE bodies, never inventing the key when the upstream omits it. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. A `refusal` or `content_filter` stop reason yields an explicit `incomplete` event with `retryable: false` rather than `done` with that stopReason (#4312); `max_tokens` remains `done`. It is the wire that defines `tools[*].strict` and `tools[*].allowed_callers`, so a rebuilt declaration carries both: an explicit `strict: true` and any `allowed_callers` the caller declared. An absent `strict` stays absent, because the Messages inbound records it as `false` and a `false` on the wire would read as an opt-out nobody asked for. |
| `src/adapters/google.ts` | Gemini bridge. The final wire compiler owns [endpoint-scoped tool-schema loss policy](providers/google.md#google-tool-schema-loss-reporting): compatible mode changes no request bytes, strict initial loss creates no physical send, and strict non-direct repair creates no changed repair send. A caller-declared strict tool selects `functionCallingConfig.mode: "VALIDATED"` in place of the absent-choice default; `NONE`, `ANY` and a forced-name choice are stronger constraints the caller asked for and are never overwritten. |
| `src/adapters/declaration-carrier.ts`, `src/adapters/input-media-guard.ts` | Default-deny allowlists for constraints the normalized request carries but a wire may not be able to express: `tools[*].allowed_callers`, which fences a tool off from callers, and inline document bytes. Both are refused with a 400 at the single guard every registered adapter passes through, rather than left to each adapter, because an adapter that never learned about the carrier rebuilds without it and answers normally. `allowed_callers` reaches the `anthropic` wire; document bytes reach `anthropic`, `openai-chat` and `google`; the `openai-responses` wire is exempt from the whole guard because it forwards the original body. Adding an `AdapterWire` member makes the omission visible in these lists instead of at a customer's upstream. The unrestricted `["direct"]` caller default is not a restriction. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/devin.ts`, `src/adapters/devin/cloud-direct/` | Devin runTurn transport over Cognition Connect-RPC. `GetChatMessage` uses the Responses provider executor and shared physical-send budget; catalog and JWT support RPCs remain outside inference-send accounting. |
| `src/adapters/kiro.ts` and `src/adapters/kiro/` | Kiro event/tool/thinking/truncation/retry handling. The original path is a facade over leaves for wire identity, reasoning, conversation state, token estimation, payload assembly, streaming, and the adapter. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts`, `src/adapters/anthropic-image-codec.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. An image's ladder position is pinned to its own identity (content hash + media type), so appending a newer image cannot re-encode older ones and bust Anthropic's prompt prefix cache (#4532). |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |

Adapter output must stay in internal `AdapterEvent` form until `src/bridge/sse.ts` converts it back
to Responses SSE or WebSocket frames, or `src/bridge/response-json.ts` buffers it into a JSON
response. `src/bridge.ts` is the compatibility facade that re-exports both.

The image/video loop bounds each hidden iteration before replay or fulfillment; see
[media iteration retention](transports/inventory.md#media-iteration-retention).

Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
Custom providers keep the conventional `${baseUrl}/models` request, normalized by
`providerModelsUrl` the same way `openaiChatCompletionsUrl` normalizes the send path: outer
whitespace and trailing slashes are trimmed and an already-pasted `/models` is not doubled, so a
`baseUrl` written with or without a trailing slash yields the identical discovery URL and an
existing path prefix is preserved. Canonical presets may select a
trusted URL/path/query, response envelope key, model identifier field, and declarative eligibility
filter without persisting that policy into user config. A response is rejected before caching when
it exceeds 4 MiB, contains more than 2,000 raw rows, has a malformed declared list envelope, or
includes an invalid model id. Tests use fixtures and
must never depend on live provider endpoints. Newly promoted fixed key presets opt into
`preserveCustomDestination`, so an older same-named custom provider keeps its configured adapter,
destination, and key boundary instead of being silently canonicalized onto the new host. Fixed
OAuth presets resolve discovery against the same canonical registry transport as normal routing
before any adapter-specific transport override, so a stale configured `baseUrl` cannot receive an
OAuth bearer token.

The Crusoe preset uses that fixed-key path at `https://api.inference.crusoecloud.com/v1`. Its
registry-owned policy admits only public rows whose `architecture.modality` is `text` or
`multimodal`, caps the response at 256 KiB and 256 raw rows, and leaves same-named custom
destinations untouched. Five catalog ids carry explicit text-and-image input metadata;
`openai/gpt-oss-120b` alone carries a direct low/medium/high `reasoning_effort` ladder.

Provider-scoped capability hints remain authoritative when discovery returns an id without
capabilities. In particular, `src/providers/registry/entries-core.ts` assigns OpenCode Go's live
`deepseek-v4.1-flash` route the official 1,048,576-token window instead of the conservative 128k
routed-model fallback.
Meta's two direct surfaces keep separate reasoning contracts: `meta-model` remains capped at
`xhigh`, while `meta-muse` advertises `max` and sends the transparent Muse compatibility
User-Agent required by that credential surface. The existing registry header merge keeps an
operator-supplied User-Agent authoritative.
The same registry declares the first-party `deepseek-flash` model with `text` and `image` input,
so it bypasses the vision sidecar by default; explicit `noVisionModels` or text-only declarations
remain authoritative. First-party `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash`
remain sidecar-backed by default.

OpenCode Go's `deepseek-v4.1-flash` joined them on 2026-09-19: probed against
`https://opencode.ai/zen/go/v1/chat/completions` with this proxy's headers, the route accepts an
`image_url` part and the model reads it, so it left `noVisionModels` and gained a positive
`modelInputModalities` declaration. Its sibling `deepseek-v4-flash` on the same gateway still
answers HTTP 400 "Model only supports text input" and stays sidecar-backed. The Zen tiers
(`opencode-zen`, `opencode-free`) were not measurable (HTTP 402) and keep their existing
classification — an unverified tier is not evidence.

Because `enrichProviderFromRegistry` fills `noVisionModels` all-or-nothing and fills
`modelInputModalities` per-key beneath the saved value, both halves of a stale classification are
frozen into any config saved while it was current. `src/providers/stale-vision-classification-migration.ts`
repairs exactly those two saved values and runs inside the shared startup repair pass in
`src/providers/model-rename-startup.ts`. Correcting the registry alone fixes new installs only.

It covers both states that reach a running process, because the sidecar predicate reads
`noVisionModels` before `modelInputModalities`: the full stale pair (modalities still the stale
declaration and the id listed, both rewritten) and the half-repaired row (modalities already
corrected but the id still listed, where removing the name is what stops the image from being
stripped). The paired modality declaration is the guard in both cases, which is why a name listed
without one is left alone — that row is either a half-finished repair or a deliberate operator
entry, and the projection does not guess which. The row must also still be the registry's own:
identity resolves through `providerMatchesRegistryTransport`, the rule `enrichProviderFromRegistry`
applies before it writes registry metadata, plus the entry's adapter. `opencode-go` is a pinned
key preset without `preserveCustomDestination`, so its id alone claims a row — exactly as it does
for enrichment — and an entry that opts into destination preservation narrows the projection with
it. `modelCapabilities` is never written: it is the
axis that outranks every source here, so it is where a deliberate text-only override belongs
(`ocx provider edit <provider> --model <id> --text-only` writes it) and the one declaration a
restart cannot take back.

The BigModel Coding Plan Responses preset uses the separately documented
`https://open.bigmodel.cn/api/v1` transport and a static catalog. Its provider row
disables live discovery: a local Codex `models.json` example does not establish an
authenticated HTTP models endpoint. Its static context and reasoning metadata are
kept in the canonical registry, including an explicit empty selectable effort
ladder for `glm-5-turbo`.

Raycast is a managed client export, not an upstream model provider. Its YAML
contribution owns only the unique `providers/[id=opencodex]` entry, with the
existing manifest and fingerprint checks protecting user-owned provider values.
Ambiguous selector matches and incompatible containers cannot be adopted or
mutated. Catalog refresh uses the existing owned-integration activation check;
an unowned client remains disconnected. OpenCodex omits Raycast API-key fields
and exports only to eligible local targets. Pro detection is an advisory hint,
not an authentication or entitlement decision.

Routed Responses continuations whose local replay state is missing resolve their recovery decision from the selected wire protocol, not the model name; the contract lives in [Responses transport](transports/responses.md).

Volcengine Ark Coding Plan is a native Responses preset at `/api/coding/v3/responses`. Validated
tool continuations there reject the reasoning item the previous turn returned, so its registry
entry sets `dropResponsesReasoningItems`, which removes replayed Responses `reasoning` items from
continuation input before forwarding. That is lossy — summaries, item ids and `encrypted_content`
go with the item — and an explicit `false` on the provider turns it off. The flag belongs to the
DESTINATION rather than to the provider-wide wire, so `routedProviderConfig` fills it on the
early-return path too: a row saved on Chat still reaches the Responses adapter when one model
opts in through `modelAdapters`, and would otherwise forward the rejected item. Because it changes
the continuation body, it is part of the compatibility behavior record and two routes that
disagree about it are not the same subject.

A row already saved on `openai-chat` keeps that wire. The entry is
`preserveCustomDestination` with key auth, so `providerMatchesRegistryTransport` refuses the
adapter mismatch and the request path returns the stored row unchanged, and the retired Chat
destination stays an alias so that row keeps this entry's metadata. There is deliberately no
startup config migration: the Z.AI one (`src/providers/zai-responses-migration.ts`) is
behavior-preserving only because it gates on `providerMatchesRegistryTransport` and therefore
rewrites rows the router already canonicalizes, which a Volcengine Chat row is not.

Command Code ships its own per-model `reasoning_effort` table in
`src/providers/command-code-efforts.ts`, and that table decides the wire effort. Configuration can
take precedence, but only when the provider declares `modelReasoningEffortsAuthoritative`:
`providerConfigSeed` copies the shipped table into every materialized preset and both enrichment
and routing keep a persisted row over the current seed, so neither the presence of a configured
row nor its difference from today's table establishes that a human wrote it. With the flag the
ladder resolves through `configuredReasoningEfforts`, the same function that advertises the Codex
picker, so the catalog and the wire agree; a rung the upstream then refuses is returned as that
error rather than replayed without the effort, because the operator asked for it. The flag is part
of the compatibility behavior record for the same reason as above.

The shared Responses path follows the [bounded multipart recovery contract](subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Hosted-search continuation binding

The opt-in key-auth Responses hosted-search bridge in `src/server/responses/passthrough-delivery.ts` captures the
request binding that served the first leg, after any permitted initial reselection. Before every
continuation dispatch, after provider pacing, that binding must remain an API-key selection matching
the configured entry, reference, revision, resolved key, authentication mode, and base URL; a
disabled or removed provider fails the same check. Drift produces the bridge's failed terminal
without another provider request, and an unchanged binding resends the built request with its
executed search result appended, never re-entering the initial reselection/rebuild path. Initial
dispatch keeps its normal reselection policy. `tests/web-search/web-search-passthrough-bridge.test.ts`
covers drift during search, while pacing, and before first-leg headers return, plus successful
first-dispatch reselection and result preservation.

`providers.<name>.webSearchBridge.backend` is explicit-only. `ollama` spends that provider's API key
on the planned search endpoint. `openai`, `anthropic`, `xai`, `gemini`, and `exa` reuse the matching
sidecar executor and that executor's own credential; a missing credential leaves the bridge
disarmed rather than falling through to another paid search. A leg that mixes an intercepted
`web_search` call with another client-executed tool ends the turn on that leg: the intercepted
searches run, their hosted cells complete, the held client calls are released for the caller to
execute, and the leg's own terminal closes the turn with no continuation sent upstream. The
destination therefore does not receive that search result during the turn. It gets it on the next
one: every search the bridge executes is recorded in `src/responses/bridge-search-replay-cache.ts`
under the hosted cell's proxy-minted id, scoped to the upstream destination and bounded by entry
count, total bytes, and a one-hour TTL. When the caller replays that cell,
`restoreBridgedWebSearchCalls` in `src/adapters/openai-responses/tool-output-recovery.ts` puts the
destination's own `function_call` and the executed `function_call_output` back in the cell's
position before the next turn's first leg is dispatched, recording exactly the text
`appendBridgeSearchTurn` would have sent on a continuation leg so a replayed turn and a continued
turn show the destination one consistent conversation. The rewrite runs only for a provider with
`webSearchBridge.enabled`, and a miss — unknown id, expired entry, a different destination, or a
`call_id` the body already carries — leaves the replayed item untouched. Re-running the search or
synthesizing result text is not a permitted recovery. The bridge finalizes request-scoped OpenAI sidecar authority on completion, failure, and client cancellation — cancellation releases immediately rather than waiting on an abandoned upstream read — so a recovery probe lease no search consumed is always returned.
`tests/web-search/web-search-bridge-replay.test.ts` pins the restore and each of those refusals.
A leg whose
upstream terminal is `response.failed` or `response.incomplete` runs no search at all and closes
any cell it opened rather than leaving it in progress. Assistant text is not treated as a search
instruction.

`src/web-search/passthrough-bridge.ts` withholds at most 8,388,608 UTF-16 code units of
SSE data payloads per leg; this is not a byte or total-heap measurement. A companion cap of
65,536 events is derived from that budget at a realistic 128-code-unit serialized delta, so it
only bounds per-event object overhead the character budget cannot see rather than refusing a
large client-executed tool call streamed as fine-grained argument deltas. The first over-budget
event fails the leg before releasing any held tool call, and reports that refusal as the
bridge's own bound rather than as an upstream read failure.
Read failures and exhausted continuation budgets use the same cleanup: discard held calls and
close every search cell opened by the current leg as failed before one failed terminal and DONE.
Successful release serializes held events lazily rather than building another full frame array;
release, discard, and the next leg reset the held payload counter and identity sets.
`tests/web-search/web-search-progress-stream.test.ts` covers both bounds, identity-only deltas,
upstream cancellation, cell closure, the exact event boundary, and mixed terminal controls.

The bridge backend and the global `webSearchSidecar` block are configured independently, so the
sidecar's `model` applies to a bridge search only when `resolveSidecarBackend(webSearchSidecar.backend)`
equals that bridge backend; otherwise the bridge runs the backend's own default. An unset global
backend resolves to `openai`, so an unset-backend model reaches an `openai` bridge and no other.
There is no per-provider `webSearchBridge.model`, so a mismatched backend gets the default rather
than a vendor-specific override. This is a model and settings rule, not a credential one:
`resolvePassthroughWebSearchBridgeAuth` switches on the bridge backend and consults only that
backend's credential locator, so no key crosses backends. `reasoning` and `xSearch` are not gated —
`reasoning` is a generic effort level and `xSearch` is xai-only with no per-backend default and no
`webSearchBridge` equivalent. `resolveSidecarBackend` lives in `src/web-search/sidecar-providers.ts`
rather than the `src/web-search/index.ts` barrel so the bridge can answer this question without a
value import of the barrel; the barrel re-exports it.
`tests/web-search/web-search-passthrough-bridge.test.ts` covers the mismatch and matching cases for
anthropic, xai, and gemini, plus the unset-backend default.

`providers.<name>.webSearchBridge.endpoint` names the destination that receives that provider's own
API key, so it carries the same literal destination assessment as `baseUrl`:
`providerDestinationConfigError` runs both at management write time, inside
`providerWebSearchBridgeConfigError`, and at plan time inside `resolveOllamaWebSearchEndpoint`.
Metadata destinations are refused unconditionally; loopback, localhost, and private space need the
provider's `allowPrivateNetwork` opt-in or a registry entry that is local by default, which is what
keeps a self-hosted Ollama on `127.0.0.1` working. Both checks are synchronous and literal-only and
resolve no DNS, so a hostname that resolves into metadata or private space is a disclosed residual
rather than a blocked case. That residual is strictly larger than `baseUrl`'s: `baseUrl` also runs
the async `providerDestinationResolvedError` at management write, which the endpoint does not, and
parity there would still leave the hand-edited-file path uncovered because the plan-time boundary is
synchronous. The plan-time check is the
authorization boundary rather than a second opinion: a hand-edited config file, `ocx config set`,
and `ocx config import` all reach `configSchema` only and never call
`providerWebSearchBridgeConfigError`, and `resolveOllamaWebSearchEndpoint` is the only reader of
this field in the tree, so a value that survives file load still cannot be spent. It refuses
silently by design; config-time is where the operator is told why. The planner requires the
provider name for that assessment, so `planPassthroughWebSearchBridge` takes it explicitly.
