---
title: Provider Configuration
description: Provider entries, authentication, endpoints, model catalogs, quotas, context caps, and provider-specific options.
---

A provider tells opencodex where a model lives, which wire adapter it speaks, and how requests are
authenticated.

## Provider-related top-level fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Map of provider name to provider config. |
| `openaiProviderTierVersion?` | `2` | set by migration | Marks the single option-aware OpenAI projection as complete. |
| `disabledModels?` | `string[]` | — | Models hidden from Codex's catalog and `/v1/models`, but not blocked from direct proxy calls. A routed id is removed from listings. An account-qualified native id hides only that selector row; a bare native GPT id hides the bare row and every account-selector row for that model. The dashboard Models page exposes only routed and bare native rows; use this configuration field directly to hide one selector-qualified row. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Per-provider Codex-visible context caps. A cap only lowers a known context window. |
| `contextCapValue?` | `number` | `350000` | Default value used by the dashboard context-cap controls. Changing it applies the value to every routed provider — including providers without an existing `providerContextCaps` entry — only when "apply to every routed provider" is toggled on; otherwise each provider keeps its own cap. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT/Codex pool account metadata managed by Codex Auth. Secrets live separately in `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Accounts excluded from Pool selection until resumed, including the main `__main__` account when paused. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Optional map from an arbitrary public model selector to a stored Codex account target. When account-qualified picker rows are enabled, each selector whose target is present adds separate `<selector>/<native-openai-model>` rows to the Codex picker; each row uses only that account. With any selector active, bare native rows are hidden in the picker, but their ids remain routable and listed by raw `/v1/models` unless explicitly disabled. |
| `codexAccountPickerEnabled?` | `boolean` | off when the map is empty | Controls whether eligible `codexAccountNamespaces` mappings generate account-qualified Codex picker rows. `true` allows mapped rows to appear. If omitted with a non-empty map, it is treated as enabled for backward compatibility; if the map is empty, it is off. `false` hides generated rows and restores bare native picker rows without deleting mappings or disabling exact `<selector>/<native-openai-model>` routing. |
| `activeCodexAccountId?` | `string` | — | Manually selected Pool account for the next request. Selection clears thread affinity; in-flight requests keep captured credentials. |
| `codexAccountPriorities?` | `Record<string, number>` | — | Per-account selection order for the Codex pool: account id → integer from `-100` to `100`, **higher is used earlier**, absent means `0`. This is an ordering boundary, not an eligibility one: selection narrows the already-eligible accounts to the highest tier that still has quota headroom, and `accountPoolStrategy` then picks within that tier. A tier is skipped only when every member is over `autoSwitchThreshold`, cooling down, soft-avoided, paused, or needs reauthentication — unknown quota never drains a tier. Ordering never makes an ineligible account selectable and never re-binds a thread that already has an account. The main `__main__` account participates on equal terms, which is how the Codex Desktop login can be set to drain last. With no entries the pool behaves exactly as before. A malformed map is ignored with a console warning (ordering off, no config repair). Managed by `ocx account priority` and the Codex Auth page. |
| `activeCodexAccountPinned?` | `string` | — | Account id the operator last selected by hand. While set, a higher `codexAccountPriorities` tier cannot preempt it until the pin is released by drain, exclusion, deletion, or an explicit failover/promotion away. Ordinary round-robin movement inside the capped tier does not release it. Writing any `codexAccountPriorities` entry also releases the pin, so a pin made before an order existed cannot outrank one set afterward. `GET /api/codex-auth/active` reports both whether the effective account is pinned (`pinned`) and the account carrying the ceiling (`pinnedAccountId`). |
| `autoSwitchThreshold?` | `number` | `80` | Usage threshold for proactive switching. `quota` can re-evaluate both bound and unbound tasks on their next request; `fill-first` uses it only as the drain point for unbound assignment; normal `round-robin` selection does not use it. The score uses the hottest known 5h, weekly, or 30d quota window. `0` disables usage-based proactive switching only, not unbound assignment or failure recovery. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Assignment strategy for new/unbound Codex requests. A request is unbound when it has no live (parent thread id, quota scope) affinity; a visible existing task can become unbound after proxy restart or affinity reset. `quota` picks the lowest-usage eligible account when no active account exists, keeps an eligible active account below `autoSwitchThreshold`, and after the threshold may move an unbound request or proactively rebind a bound task to a lower-usage eligible account. `round-robin` distributes unbound requests evenly; `fill-first` keeps assigning unbound requests to the active account until cooldown, unavailability, or the configured drain threshold. |
| `accountPoolStickyLimit?` | `number` | `1` | New/unbound task assignments retained on one round-robin selection before advancing; the counter advances when a task is bound, not after an upstream success. Range 1–100. |
| `upstreamFailoverThreshold?` | `number` | `3` | Consecutive transient failures before future new sessions fail over. Set `0` to disable. For regular Responses and native compact sends, proven pre-connection DNS/TCP reachability failures are tracked at the provider-host level: they never affect account health, account cooldowns, thread/session affinity, active-account selection, or Pool routing, and never count toward this threshold. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Opt-in circuit threshold for proven pre-connection DNS/TCP failures on native OpenAI forward Responses and compact sends. `0` disables it; `1`–`20` opens a 30-second provider-origin cooldown after that many terminal logical requests. While open, requests receive `503` with `Retry-After` before account selection or upstream send; after cooldown, one half-open request is admitted. Timeouts and HTTP responses never count, and any HTTP response closes the circuit. Applies only to Codex Pool routing with no pinned account; it is inert for `codexAccountMode: "direct"` and account-qualified selectors. |
| `maxUpstreamBodyBytes?` | `number` | `0` | Opt-in ceiling, in bytes, on a serialized native Responses **passthrough** body. `0` or omitted disables it — no limit is inferred for any destination. When set, a built body above the ceiling is refused locally before the send: streaming turns receive a terminal `response.failed` / `context_length_exceeded` so the client compacts instead of resending, and non-streaming turns receive a `413` naming the size, the number of embedded `input_image` items, and roughly how many megabytes of image data they represent. Checked at every build and rebuild point, including OAuth-refresh replay and alternate-account retry. Translated adapter paths are not covered. There is deliberately no default: the only measured ceiling here belongs to the WebSocket transport, which already falls back to HTTP for oversized turns, so a default would refuse requests that currently succeed. Set it when your gateway has a known request-size limit and you would rather see an actionable local error than an opaque upstream failure. |
| `modelCacheTtlMs?` | `number` | `300000` | Freshness window for the per-provider `/models` cache. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache policy: disabled, 5-minute ephemeral, or 1-hour extended. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | Optional proactive OAuth refresh and Codex-account warmup policy. |

Selector names are user-chosen public labels; opencodex assigns no account-role semantics to them.
`codexAccountNamespaces` keys are 1–64 characters, starting and ending with an
ASCII letter or number, with letters, numbers, `.`, `_`, or `-` inside. Reserved JavaScript object
names are rejected. Each value is a valid pool-account id (never internal `__main__`) or `"@main"`
for the Codex Desktop account. Provider and reserved `openai` / `combo` / `policy` collisions are
checked case-insensitively; a namespaced combo or routing-profile alias cannot reuse a selector as
its namespace prefix, and configured pool ids or selector targets also cannot reuse a selector. Keep
raw account ids and emails private; the selector is the public name. See [Routing Configuration](/reference/configuration/routing/)
for exact-selection behavior and precedence.

The Codex Auth dashboard control owns maps that have an explicit `codexAccountPickerEnabled` field.
Enabling an empty managed map creates privacy-safe selectors; later account additions extend that map
even while picker rows are hidden, without renaming existing selectors. A hand-written map that omits
the flag remains manual and is never auto-expanded. Deleting an account keeps its mapping so exact
routes fail closed while it is missing; adding the same account id again restores the existing public
selector instead of allocating a new one.

## Reserved OpenAI providers

`openai` and `openai-apikey` are fixed reserved ids. `openai.codexAccountMode` is `"pool"` by default
and selects across the main plus added accounts; `"direct"` uses only the current caller/main login.
API uses only its configured API key or key pool. Use a bare model or `openai-apikey/<model>`; there
is no cross-route credential fallback. API GPT-5.6 rows carry 1,050,000 context / 922,000 max input
metadata, and Pro virtual ids rewrite to the base wire model with `reasoning.mode: "pro"`.

`openaiProviderTierVersion: 2` marks the current single-provider projection. Before migrating a
shipped v1 config, opencodex creates `config.json.pre-openai-tiers-v2.bak` without replacing a
differing backup and rewrites known legacy namespaced selected ids to bare ids.

## Provider entries (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `ollama-native`, `azure-openai` (or alias `azure`). |
| `baseUrl` | `string` | Upstream API base URL. Most built-in fixed endpoints ignore a mismatch; collision-safe key presets preserve an older same-named custom destination. |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | Optional client-side outbound request-start pacing, separate from upstream usage, billing, and rate-limit indicators. RPM is converted to an even interval; `minIntervalMs` may impose a longer interval. Provider limits apply across all models, while `models` entries use exact upstream model IDs (for example `nvidia/llama-3.1-nemotron-ultra-253b-v1`) and can only add delay. Queue waits do not consume the upstream response-header timeout. HTTP, Responses WebSocket, and explicit adapter `fetchResponse`/`runTurn` dispatches are covered. |
| `upstreamHttpVersion?` | `"auto" \| "http1.1" \| "h1" \| "http2" \| "h2"` | Pin the HTTP version used for upstream requests to this provider. Defaults to `auto`, which lets Bun negotiate. An explicit pin requires an HTTPS target and fails locally when it cannot be honored. Set `http1.1` when a provider's HTTP/2 SSE stream stalls instead of delivering events — the symptom is a long-running streaming request that produces nothing and eventually times out. For Cursor, `http1.1`/`h1` selects its `RunSSE` + `BidiAppend` compatibility transport for inference and also pins live model discovery. Management `POST`/`PATCH` accept `null` to clear it back to `auto`. |
| `responsesPath?` | `string` | Relative resource path for key-auth `openai-responses` requests. It must start with `/` and contain no scheme, query, or fragment. |
| `upstreamWebsocket?` | `boolean` | Opt-in upstream Responses WebSocket transport for `openai-responses` requests (default false). When the upstream supports the Responses WebSocket protocol, streaming POST requests to the configured Responses path (default `/v1/responses`) are dialed as WSS over an HTTPS base URL and re-encoded to SSE for the usual pipeline. Forward providers use `{baseUrl}/responses`; key-auth providers use `responsesPath`, or the legacy `/v1/responses` fallback. This mirrors the canonical ChatGPT backend optimization for OpenAI-compatible gateways (for example sub2api) whose WebSocket ingress is measurably faster than its SSE queue. Plain HTTP remains on SSE; non-Responses paths and `openai-chat` requests stay on HTTP. |
| `supportsServiceTier?` | `boolean` | Tri-state canonical Fast capability fallback. `true` publishes Fast in the catalog, satisfies service-tier routing requirements, contributes a supported fingerprint, and lets fast mode inject the provider's canonical wire value on a compatible final adapter. `false` strips the field and never injects, and exact model declarations cannot reopen it. Absent leaves the provider unclassified: fast mode does not inject or normalize a canonical caller value, and caller values obey the final wire's forwarding permission (`chatServiceTier` on Chat; passthrough on Responses). The registry classifies canonical OpenAI (`true`), DeepSeek, and Volcengine Ark (`false`); set it explicitly only for custom gateways that genuinely support tiers. |
| `modelSupportsServiceTier?` | `Record<string, boolean>` | Exact upstream model capability overrides. Exact `true` enables canonical Fast for that model; exact `false` narrows provider defaults. An explicit provider-level `supportsServiceTier: false` remains fail-closed and cannot be reopened. Exact `true` does not authorize foreign caller-tier forwarding on Chat. Undeclared models fall back to provider-wide behavior. Management `PATCH /api/providers` merges entries and accepts `null` to clear one. |
| `chatServiceTier?` | `boolean` | Provider-wide Chat-wire opt-in for forwarding caller `service_tier` values. On a classified route it governs foreign values such as `flex`, not proxy-owned canonical Fast after capability validation; on an unclassified route it governs every caller value because no Fast capability has been validated. Exact model capability does not authorize foreign forwarding. Responses routes retain their capability-based caller forwarding behavior. |
| `promptCacheKey?` | `boolean` | Provider-wide `openai-chat` opt-in for forwarding a `prompt_cache_key`. The adapter forwards the key it is given and never invents one, but the key is not always the caller's: Claude Messages translation derives one from `metadata.user_id`, or from a model/system/tools cohort when no metadata is sent. Default off. Enable only when the upstream documents support, because strict gateways may reject the unknown field with HTTP 400. |
| `preserveResponsesReasoningContent?` | `boolean` | Keep plaintext reasoning content on replayed Responses reasoning items instead of blanking it (blanking is the ChatGPT backend's rule). Enable for upstreams whose contract accepts reasoning replay, such as DeepSeek. Proxy-minted `ocxr1` envelopes are always stripped. |
| `disabled?` | `boolean` | Keep the provider on disk but exclude it from routing and model/catalog listings. |
| `apiKey?` | `string` | API key, an `${ENV_VAR}` / `$ENV_VAR` reference, or a `keychain:<provider>` reference written by `ocx provider keychain <name> store`. References resolve at request time. See [Storing keys in the OS keychain](#storing-keys-in-the-os-keychain). |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key header style. Defaults to native `x-api-key`; valid only for key-auth `anthropic` providers. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Multi-key pool. `apiKey` mirrors the active entry; each item has `id`, `key`, optional `label`, and optional numeric `addedAt`. |
| `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
| `models?` | `string[]` | Seed/fallback model list. With `liveModels: false`, these are the only discovered models. |
| `liveModels?` | `boolean` | Fetch the live catalog on start/sync (default `true`). Custom providers use `${baseUrl}/models`; built-ins may use a registry URL and filter. |
| `selectedModels?` | `string[]` | Catalog allowlist after discovery. Non-empty exposes only those ids; empty or omitted exposes all discovered models. |
| `retainModels?` | `string[]` | Ids kept in the catalog even when live discovery omits them. They need not be repeated in `models`. Empty or omitted keeps today's behavior. |
| `modelDisplayNames?` | `Record<string, string>` | Durable labels used only for display, keyed by this provider's exact upstream model id. Labels win over provider catalog metadata, survive discovery refreshes and provider edits, and never change authentication, adapter behavior, routing, billing, upstream request construction, the routed `provider/model` selector, or the upstream wire model. Keys are exact and case sensitive. Unknown model ids are kept so a temporarily missing model receives its label when it returns. The map accepts at most 2,000 entries, matching the discovery limit. |
| `contextWindow?` | `number` | Provider-wide context fallback when upstream metadata is absent; otherwise a cap that retains smaller live metadata. The Models dashboard exposes this separately from `providerContextCaps`. |
| `modelContextWindows?` | `Record<string, number>` | Per-model context fallbacks/caps. These override `contextWindow`: an unknown window uses the configured value, while smaller live metadata remains authoritative. |
| `modelInputModalities?` | `Record<string, string[]>` | Per-model input hints such as `["text"]` or `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Positive per-model max input limits used for catalog auto-compaction hints. |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | Positive safe-integer per-model soft auto-compaction budgets. Values can only lower the effective 90%-of-context/max-input envelope and are omitted when no authoritative context window is known. For canonical `openai`, keys must be exact supported native model IDs without provider or account-selector prefixes. Provider PATCH merges entries; set a key to `null` to delete it or the whole field to `null` to clear the map. These `null` tombstones are PATCH-only. |
| `defaultMaxOutputTokens?` | `number` | Provider-wide `openai-chat` fallback when the client omits `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Positive per-model `openai-chat` fallback budgets; exact/pattern matches beat the provider default. |
| `modelCosts?` | `Record<string, Cost4>` | Per-model display prices (USD per 1M tokens), keyed by that provider's exact upstream model id — not a provider identifier or a routed `provider/model` label, e.g. `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`. Any model id is a valid key — custom providers may target any OpenAI-compatible endpoint through the `openai-chat` adapter, and local or internal provider ids work even when they are absent from the built-in catalogs. User-configured prices win over the built-in catalogs in the Logs `~$` and Usage estimates; historical entries are repriced from the current overlay, so editing a price can move past totals. The fallback order is user `modelCosts` → exact official correction → jawcode catalog → expected-price overlay → model-level vendor fallback, and an all-zero entry falls through to the next source in that sequence. Each rate must be a non-negative finite number at most 1,000,000 (USD per 1M tokens); out-of-range rows are rejected by the management boundary and dropped on load. Display-time estimation only: overlays never affect routing, account selection, quotas, or billing. |
| `headers?` | `Record<string, string>` | Extra upstream headers. Authorization, cookies, API-key headers, embedded newlines, and invalid names are rejected. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Default OpenRouter `order`, `only`, and `allowFallbacks` preferences; valid only for canonical OpenRouter with `openai-chat`. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | Exact model-id overrides that replace the provider-wide OpenRouter preference. |
| `vercelGatewayRouting?` | `VercelGatewayRouting` | Default Vercel AI Gateway `order`, `only`, and `sort` (`"cost"` \| `"ttft"` \| `"tps"`) preferences; valid only for canonical Vercel AI Gateway with `openai-chat`. |
| `modelVercelGatewayRouting?` | `Record<string, VercelGatewayRouting>` | Exact model-id overrides that replace the provider-wide Vercel AI Gateway preference. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Authentication mode (default `key`). OAuth/subscription credentials are stored outside `config.json`; `local` is limited to providers whose registry entry permits it. |
| `codexAccountMode?` | `"pool" \| "direct"` | Canonical `openai` only; defaults to Pool. Direct bypasses pool state. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Override this OAuth provider's Token Guardian policy. |
| `reasoningEfforts?` | `string[]` | Provider-wide Codex reasoning labels to advertise and send. For `google`-adapter providers, a configured ladder also asserts `thinkingLevel` capability: direct and Vertex non-image requests send the selected effort as `generationConfig.thinkingConfig.thinkingLevel`, while Cloud Code Assist uses its envelope-specific path. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Per-model labels. An empty list hides effort control. As with `reasoningEfforts`, each configured `google`-adapter ladder asserts `thinkingLevel` capability; direct and Vertex non-image requests use the flat Gemini path, while Cloud Code Assist sends it under its request envelope. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Set a model to `false` to stop advertising summaries and strip summary-delivery fields. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Per-model Responses delivery enum; rewrites an existing delivery field. |
| `modelAdapters?` | `Record<string, string>` | Per-model `openai-chat` or `openai-responses` wire override for mixed-wire gateways. Explicit entries beat registry defaults. The OpenCode Go preset selects Responses for `gpt-5.6-luna` while leaving sibling models on their documented wires; DeepSeek can select native Responses for `deepseek-v4-flash`; and GitHub Copilot declares Responses-only defaults for its GPT-5 family (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) because those models reject `/chat/completions` for agent traffic. Models without a built-in default (for example `gpt-5.4-nano`) can be opted in here. Single-wire upstream pins and canonical ChatGPT forward reject overrides. |
| `modelResponsesCompatibility?` | `Record<string, "terminal-repair">` | Case-insensitive per-model opt-in for the Responses terminal-repair policy on custom providers. A matching model gets the 500 ms default grace unless `modelResponsesTerminalRepair` supplies an explicit grace. The effective model wire must be `openai-responses`; canonical ChatGPT forward rejects this key. |
| `modelResponsesTerminalRepair?` | `Record<string, number \| { graceMs: number }>` | Case-insensitive per-model terminal-repair grace in milliseconds. It overrides the compatibility default and takes precedence over `responsesTerminalRepair`; positive values are floored and capped at 60 seconds. Invalid or ambiguous case-folded entries fail closed at resolution. |
| `responsesTerminalRepair?` | `"terminal-repair" \| number \| { graceMs: number }` | Provider-level terminal-repair fallback for models using the `openai-responses` wire. The string selects the 500 ms default; numeric/object values set the grace and are capped at 60 seconds. It is considered only after compatibility and explicit per-model settings, and is rejected on the canonical ChatGPT forward provider. |
| xAI Responses opt-in (dashboard) | switch | For `xai` only, atomically sets or clears the `grok-4.5` and `grok-4.6` `modelAdapters` entries. A hand-edited single entry appears as mixed until the next switch write normalizes both. Other overrides and tier behavior are unchanged. |
| `xaiResponsesXSearch?` | `boolean` | Disabled by default. On an xAI Responses destination, append the provider-hosted `x_search` declaration only when a live `web_search` tool survives final request normalization. Existing declarations are not duplicated, caller `tool_choice`/`allowed_tools` selectors are never widened, and this is separate from the web-search sidecar's `search.xSearch` options. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Exact-model opt-in for non-forward Responses gateways that reserve a hosted-tool namespace. Currently accepts only `["image_generation"]`; a matching model must use the `openai-responses` wire and support that hosted tool. It removes colliding client `image_gen` declarations and rewrites their selectors to preserve caller tool choice. For OpenAI API virtual `-pro` models, the selected public ID is matched first and the resolved base wire-model ID is a fallback. `modelAdapters` resolves the public ID first, then the base ID; the second resolution determines the final wire. Other models retain normal alias behavior. |
| `annotateEmptyToolOutputs?` | `boolean` | Replace a present-but-empty tool result with a short marker before it reaches the model, so a blank result is not read as a missing one. Applies to blank strings and text-only part arrays; image, file, and encrypted parts are never touched. Defaults to `true` for DeepSeek from the built-in registry and is otherwise unset. Set `false` to opt a provider out — an explicit `false` is preserved across later edits that omit the field. `PATCH /api/providers?name=<provider>` accepts `true`, `false`, or `null` to clear the override and return to registry-default behavior. |
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire aliases for reasoning labels. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Per-model wire aliases for reasoning labels. |
| `reasoningWireFormat?` | `"gateway-object"` | For OpenAI-compatible gateways that accept `reasoning: { enabled, effort }` instead of `reasoning_effort`. The ClinePass preset sets this automatically. |
| `noReasoningModels?` | `string[]` | Models that reject reasoning/thinking parameters. |
| `noTemperatureModels?` | `string[]` | Models that reject caller-specified `temperature`. |
| `noTopPModels?` | `string[]` | Models that reject caller-specified `top_p`. |
| `noPenaltyModels?` | `string[]` | Models that reject presence/frequency penalties. |
| `noStructuredOutputModels?` | `string[]` | Exact model IDs whose `openai-chat` endpoint rejects `response_format`. Only an exact requested-model match omits the field; structured-output translation stays enabled for every other `openai-chat` model. |
| `omitReasoningEffortWithToolsModels?` | `string[]` | Exact `openai-chat` model IDs that accept a reasoning-effort field on an ordinary turn but reject it once function tools are present. The model keeps its advertised effort ladder; OpenCodex omits the wire field for tool-bearing requests only and the upstream default applies. Narrower than `noReasoningModels`, which strips reasoning from every request and costs the model its picker entirely. |
| `parallelToolCalls?` | `boolean` | Toggle parallel tool calls. OpenAI Chat defaults on; non-chat adapters advertise only on explicit `true`. |
| `terminalContinuationGuard?` | `boolean` | Opt in an `openai-chat` provider to one bounded internal re-ask when an actionable turn announces work, then cleanly stops without a tool call. Defaults to `false`; explicit `false` behaves like omission. Combo attempts and routed compaction turns are excluded, and non-`openai-chat` adapters ignore this option. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | Disabled-by-default downstream SSE repair for exact placeholder ids, missing terminal ids, and (with `repairInvalidIds`) message/reasoning ids missing the canonical `msg_`/`rs_` prefix. Function-call ids are never rewritten. Built-in DeepSeek enables the last two by default. |
| `responsesSnapshotRepair?` | `boolean` | Disabled-by-default client-facing repair for sparse Responses lifecycle snapshots in SSE and JSON. Fills missing canonical status, output, and tool metadata while raw inspection and persistence remain unchanged. |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | API-key providers only (`authMode: "key"`). Opt-in same-target 429 retry: when `retryOn429` is absent the feature is off; object presence enables it unless `enabled: false`. On 429 the proxy waits (upstream `Retry-After` or the fixed interval) and replays the identical request on the same key before any key failover — across the main text-turn recovery loop, the Responses passthrough wire, the image/video bridge, the web-search sidecar, and terminal continuations. Only pre-stream HTTP 429 responses are eligible for replay; custom `runTurn` transports are outside the HTTP retry loop. `attempts` counts same-key replays after the first 429 (total sends = `attempts` + 1) and is one request-wide budget shared by the main recovery loop, the terminal-guard continuation, and bridge retries. Exhausting `attempts` only stops further same-key replays: normal key failover or final-error handling then applies per the available targets — on the key-auth passthrough wire there is no failover, so the exhausted 429 surfaces as-is. Codex itself never retries 429, so this is the only defense for single-key providers. Defaults: `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000` (any single wait is capped at `maxIntervalMs`, itself capped at 600000), `respectRetryAfter: true`. |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | Key-auth `openai-chat` providers only. Opt-in retry for pre-stream transient upstream statuses (500, 502, 503, 504, 520, 521, 522): absent means off, object presence enables it unless `enabled: false`. Covers the initial Responses request, the terminal-guard continuation, and native `/v1/chat/completions`. `attempts` is the TOTAL number of upstream sends allowed for one request including the first (1..10, default 3) — it is one budget shared with connection-reset recovery, so `3` means at most three real requests reach the provider. Waits use a fixed 400 ms exponential backoff capped at 5 s and honor `Retry-After`. Separate from `retryOn429`, which handles rate limiting; mid-stream failures are never replayed. |
| `autoToolChoiceOnlyModels?` | `string[]` | Models whose `tool_choice` accepts only `auto` or `none`; forced choices are downgraded. |
| `preserveReasoningContentModels?` | `string[]` | Models requiring prior assistant `reasoning_content` in chat history. |
| `reasoningDetailsModels?` | `string[]` | Models whose endpoint returns thinking as a structured `reasoning_details` array (MiniMax M-series with `reasoning_split`); stream deltas are cumulative snapshots that are prefix-diffed, and preserved reasoning replays as a `reasoning_details` array instead of a `reasoning_content` string. |
| `requiresReasoningPlaceholderModels?` | `string[]` | Models whose upstream rejects a tool_call continuation missing `reasoning_content` (DeepSeek thinking mode); a minimal placeholder is injected when the replay cache misses. Defaults to `preserveReasoningContentModels`; set `[]` to opt out. |
| `thinkingToggleModels?` | `string[]` | Chat models using `thinking.enabled` rather than an effort ladder. |
| `thinkingBudgetModels?` | `string[]` | Chat models using integer `thinking_budget`; effort maps to a budget fraction. |
| `noVisionModels?` | `string[]` | Text-only models sent through the vision sidecar; matching tolerates an Ollama `:size` tag. |
| `escapeBuiltinToolNames?` | `boolean` | Escape built-in tool names for Anthropic-compatible gateways and restore them in returned calls. |
| `anthropicEofTolerance?` | `boolean` | Let an Anthropic-compatible gateway complete a stream that ends before `message_stop`, only when visible text or a complete JSON-object tool input was received. Off by default. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transport/auth mode. Default `ai-studio`. |
| `directGeminiWireRenames?` | `boolean` | Google only. Applies only to direct AI Studio requests. Omitted or `true` keeps the `-tiered` wire rename for Gemini Flash ids (`gemini-3.7-flash` -> `gemini-3.7-flash-tiered`); `false` sends the requested bare ids to the wire unchanged. Vertex preserves the requested model ID, and Cloud Code Assist routing is unchanged. Set `false` when the configured upstream still serves the bare ids. |
| `project?` | `string` | Vertex or Antigravity Cloud Code Assist project id. |
| `location?` | `string` | Vertex location; environment fallback is `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Cursor only: stdio or Streamable HTTP MCP servers. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Cursor only: external computer-use and record-screen commands. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor legacy boolean, equivalent to `nativeLocalExec: "on"` only when the newer field is unset. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor local-exec policy. `off` is default; `codex-sandbox` currently fails closed like `off`. |

### Discovered model display names

Use `modelDisplayNames` when a provider returns machine friendly ids but the Codex model picker
needs shorter labels. The map belongs to one provider, so the same model id can have a different
label under another provider. Add the field to the existing provider row in `config.json` and keep
all other provider settings. The example includes the surrounding required fields for context:

```json
{
  "providers": {
    "xai": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.x.ai/v1",
      "modelDisplayNames": {
        "grok-4.6": "Grok 4.6"
      }
    }
  }
}
```

The effective label order is operator `modelDisplayNames`, then provider catalog metadata, then the
normal `provider/model` fallback. The routed selector remains `xai/grok-4.6`, while the upstream
wire model remains `grok-4.6`. Labels are display only. They do not change authentication, adapter
behavior, routing, billing, or upstream request construction. Removing a map entry resets only its
label. A management client can set or reset one label with
`PUT /api/providers/:provider/model-display-names` and a body of
`{ "modelId": "grok-4.6", "displayName": "Grok 4.6" }`; send `displayName: null` to reset it.
Provider `PATCH` does not edit this map. Use this dedicated `PUT` endpoint to change or remove labels.

## Codex catalog and root `config.toml` settings

These settings belong in the root of `$CODEX_HOME/config.toml`, alongside
`approvals_reviewer`; they are not provider fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `auto_review_model` | `string` | Public catalog selector in `provider/model` form, for example `opencode-go/deepseek-v4-flash`. After each catalog merge, OpenCodex resolves it against the final catalog and stamps the trimmed value as `auto_review_model_override` on catalog entries. Boundary whitespace is removed; the selector's slash-delimited components are otherwise unchanged. If the value is absent or blank, existing routed overrides are cleared and normal upstream auto-review selection is preserved. If it is syntactically invalid or absent from the final catalog (including after provider/model removal), OpenCodex fails closed for the override only: it clears the dead override, preserves normal upstream behavior, and emits a diagnostic. Re-adding the provider/model on a later sync allows the configured selector to be stamped again. |

The setting is evaluated after provider discovery, model filtering, native/account-row
projection, and merge precedence, so only a selector present in the catalog produced by
that sync can become an override. Native upstream values are preserved when the setting is
cleared or unresolved. The persisted catalog field is read by Codex for the current turn's
model, which is why a valid configured selector is copied to each applicable entry.
### Responses terminal-repair policy

These three keys are overlapping controls for custom providers that need a bounded repair when a
native Responses stream does not deliver its terminal event. For each requested model, the
effective adapter (the provider adapter or its `modelAdapters` override) must be
`openai-responses`; Chat Completions and other wires never opt in. Model matching is
case-insensitive.

Resolution uses this precedence:

1. A matching `modelResponsesCompatibility` entry opts the model into terminal repair. Its
   default grace is 500 ms, unless a matching `modelResponsesTerminalRepair` entry supplies an
   explicit grace.
2. Otherwise, a matching `modelResponsesTerminalRepair` entry supplies the per-model grace.
3. Otherwise, `responsesTerminalRepair` supplies the provider-level fallback.

Grace values are positive finite milliseconds, and the runtime floors them and caps any result at
60 seconds. Config validation rejects malformed values and rejects all three keys on the canonical
ChatGPT forward provider (matching by adapter, authMode, and normalized baseUrl configuration, not provider name). The runtime resolver is defense in depth: an invalid or ambiguous
case-folded per-model entry is not selected, so resolution fails closed instead of choosing an
arbitrary entry.

#### Decision Log: why three overlapping knobs?

`modelResponsesCompatibility` provides a readable opt-in with a safe default, while
`modelResponsesTerminalRepair` handles models that need a different grace period. The
provider-level `responsesTerminalRepair` covers a gateway whose Responses models share one policy.
Keeping all three preserves simple compatibility migration without giving a broad default priority
over an explicit per-model choice.

### FastWire B1 capability migration

Fast capability and arbitrary Chat caller-tier forwarding are independent after FastWire B1. The
[provider-field definitions](#provider-entries-ocxproviderconfig) above remain the authoritative
contract; existing configurations see these migration deltas:

1. A Chat provider/model declared Fast-capable no longer needs `chatServiceTier: true` for canonical
   Fast. Publication, routing eligibility, and injection still require an eligible policy and a
   compatible FastWire mapping on the final adapter. On classified routes, `fastMode: false` still
   removes canonical Fast. Set `supportsServiceTier: false` or an exact-model `false` when the route
   is not Fast-capable.
2. On an eligible classified route, caller spellings `fast` and `FAST` normalize through
   `fastWire.canonicalToWire.priority`; caller `priority` remains canonical. Configure a verified
   mapping to `fast` only when that is the upstream's canonical value. Unclassified routes retain
   their existing forwarding behavior.
3. Exact-model `true` no longer authorizes foreign Chat tiers such as `flex` or vendor-specific
   values. Those still require `chatServiceTier: true`; otherwise they are removed and recorded as
   dropped caller tiers.

Explicit capability `false` and Responses caller-tier forwarding retain their existing contracts.

### Cursor Fast (`cursor-variant`)

Cursor has no `service_tier` field. Its fast product is a different **model variant** —
`claude-opus-5-thinking-high-fast`, or a `{id:"fast",value:"true"}` request parameter for
Grok — so the Cursor entry declares `fastWire.kind: "cursor-variant"` and the request
builder resolves the variant instead of setting a request field.

Only the bases that actually declare a fast variant advertise Fast: `claude-opus-4-7`,
`claude-opus-4-8`, `claude-opus-5`, `grok-4.5`, `grok-4.6`. Every other Cursor row publishes
`supportsServiceTier: false`, so Codex shows no toggle rather than a dead one.

A base whose umbrella row routes thinking upgrades to its **thinking-fast** variant, not to
the plain fast sibling — that sibling is a different product with a shorter effort ladder,
and for `claude-opus-5` its regular family is quarantined upstream.

`fastMode` behaves differently per surface, because only Codex has a Fast toggle of its own:

| Surface | `fastMode: true` |
|---|---|
| Codex | rows stay umbrella rows; the app's Fast toggle selects the variant |
| Claude Code (`?ids=cli`) | lists the fast identity, e.g. `claude-ocx-cursor--claude-opus-5-thinking-fast` |
| OpenAI `/v1/models` | lists `cursor/claude-opus-5-thinking-fast` |
| Claude Desktop (3P) | unchanged — its aliases are hashed from the model name |
| Dashboard `/api/models` | row ids unchanged; they are the enable/disable keys |

Requests are promoted either way: with `fastMode: true`, picking the umbrella id still
resolves to the fast variant, so a client whose saved config predates the switch does not
need to rediscover. Every legacy variant id keeps routing unchanged.

### xAI Priority Processing

The built-in `xai` preset advertises and injects Fast only when its effective transport uses
`authMode: "key"`. API-key mode targets `https://api.x.ai/v1` through the `openai-chat` adapter and
sends `service_tier: "priority"` through Chat Completions. `ocx login xai`
instead stores OAuth credentials for the separate Grok CLI subscription-gateway flow, so OAuth
remains unclassified: its catalog rows do not advertise Fast and the proxy does not inject a tier.

xAI charges Priority Processing at 2× the standard token price for input, output, cached, and
reasoning tokens; cache discounts are applied before the multiplier. Cost estimates use that premium
only when xAI's response confirms `service_tier: "priority"`. A missing or unparsed response tier is
not confirmation, and an echoed `default` is a downgrade; all three stay at the standard price.

For `grok-4.6`, the standard rate per 1M tokens is $2.00 input, $0.50 cached input, and $6.00
output. A prompt of at least 200,000 tokens reprices the whole request at $4.00 / $1.00 / $12.00.
xAI has not published how that long-context band combines with Priority Processing. When a
long-context response confirms `priority`, the dashboard therefore shows the published long-context
cost with a `≥` marker and a lower-bound explanation; it never invents a stacked multiplier.

### OpenRouter Fast

The canonical `https://openrouter.ai/api/v1` preset advertises Fast only for these exact
OpenAI-backed model slugs:

- `openai/gpt-5.6-sol`
- `openai/gpt-5.6-terra`
- `openai/gpt-5.6-luna`

`anthropic/claude-sonnet-5` and undeclared OpenRouter models remain unclassified. A provider-level
`supportsServiceTier` default is intentionally absent, and a user-set `supportsServiceTier: false`
still disables the exact-model declarations. The registry declarations apply only while the
provider still targets the canonical OpenRouter base URL; a same-named custom destination is not
assumed to share OpenRouter's contract.

Fast sends `service_tier: "priority"`. It does not add or rewrite `provider.only`,
`provider.order`, or `provider.allow_fallbacks`. OpenRouter documents priority endpoints as the
first routing choice, followed by graceful fallback to other endpoints when priority capacity is
unavailable. Billing follows the endpoint actually used, and the response reports the actual
top-level `service_tier`. Pinning tier endpoints and disabling fallback would therefore reduce
availability without improving billing safety.

Request logs use that response echo as the authority. `priority` confirms Fast as applied;
`default` records a downgrade and uses the standard-price estimate; a missing field leaves the
attempt assumed rather than guessing a downgrade. OpenRouter's priority multiplier varies by
upstream and is not bundled here. When priority is confirmed but no exact priority price is known,
the dashboard keeps the standard-price estimate as a documented lower bound and prefixes it with
`≥`; downgraded attempts have no lower-bound marker.

API-key providers may hold a literal key or an environment reference. OAuth providers use the
credential store populated by `ocx login`; subscription-backed Claude Code launch behavior is
configured under [`claudeCode.authMode`](/reference/configuration/server/#claude-code).

## Provider diagnostic outbound safety

Dashboard connection tests and live model discovery use a bounded GET-only transport. Without an
outbound proxy, opencodex resolves the hostname once and connects only to that validated address.
HTTPS retains the original Host, SNI, and certificate verification; provider config cannot disable
certificate checks.

When `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` applies, these operations keep Bun's native fetch.
URL and literal-address checks still run, but the proxy chooses the final route, DNS answer, and peer,
so opencodex cannot pin or verify that peer. This is an explicit security limitation.

Private/local destinations require `allowPrivateNetwork: true` and, when an outbound proxy is active,
a matching `NO_PROXY` entry. Loopback is added automatically; list each LAN host explicitly because
CIDR entries are not interpreted. The matcher supports exact hosts, domain suffixes, optional ports,
bracketed IPv6, and `*`; for example, list `192.168.1.50` explicitly. Metadata and link-local
destinations stay blocked. Diagnostic
requests reject redirects and report a credential-stripped target. Ordinary provider request redirect
review remains separate from this diagnostic guard.

## Codex account pool

Use **Codex Auth** in the dashboard to add pool accounts and refresh quotas. `config.json` stores
non-secret metadata; access and refresh tokens use the hardened credential store. Pool routing
separates new/unbound assignment, usage-based proactive switching, and failure recovery. A bound task
normally keeps affinity, but `quota` may rebind it on its next request after the usage threshold is
crossed, while pause, cooldown, reauthentication, and failure handling can clear or move routing
independently. An unbound request has no live account binding; this can include an existing visible
task after proxy restart or affinity reset. A pre-stream 429 or 402, or a 5xx response whose bounded
body explicitly reports quota exhaustion, retries once on an eligible alternate account in the same
request, even when usage-based proactive switching is off. The ordinary transient-5xx policy runs
first, so a wrapped quota response may make up to three sends on the exhausted account before pool
rotation. Account changes preserve and replay the conversation context, but provider-side
prompt-cache reuse across accounts is not guaranteed and the cache may need to warm again.

On a **401/403**, App login clears that account's process-local affinity and requires reauthentication.
On a **429**, opencodex honors `Retry-After`, starts the account cooldown, clears affinity, and may
rotate the request to another eligible Pool account. These failure transitions remain active with
`autoSwitchThreshold: 0`; that setting disables only usage-based proactive switching.

Pausing an account preserves its quota metadata but excludes it from switching, failover, recovery
probes, and manual activation. It also clears that account's thread affinities. In-flight requests keep
captured credentials; later turns are rerouted. If every account is paused, Pool routing fails rather
than silently choosing one. **Pause exhausted** refreshes eligible accounts with available credentials
and pauses only accounts freshly confirmed at 100%; unknown or failed refreshes remain unchanged.

| Strategy | Behaviour |
| --- | --- |
| `quota` (default) | If no active account exists, choose the lowest-usage eligible account across 5-hour, weekly, and 30-day windows. Otherwise retain an eligible active account below `autoSwitchThreshold`; after it crosses the threshold, an unbound request or a bound task's next request can move to a lower-usage eligible account. `0` disables this usage-driven re-evaluation, not failure recovery. |
| `round-robin` | Evenly assign unbound requests across eligible accounts. `autoSwitchThreshold` does not change normal round-robin selection. `accountPoolStickyLimit` (1–100) counts assignments on one pick, not successful upstream responses. |
| `fill-first` | Assign unbound requests to the active account until cooldown, reauthentication, or the configured drain threshold; unknown usage does not force a switch. Healthy bound tasks keep affinity. |

Rotation does not protect against provider enforcement; multi-account use may violate provider terms.

### `anthropicAccountPool` (experimental)

This opt-in pools multiple Anthropic OAuth accounts already stored in `auth.json`. It is off by
default and not battle-tested. Accounts in the same organization may share quota, and automated
rotation may trigger provider restrictions.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | Enable sticky affinity and 429 cooldown failover. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | For new sessions, when the active account reaches this threshold, choose the lowest known cached usage in the configured window; the account chosen does not itself have to be at or above the threshold. `0` disables **proactive** usage-based switching only — new-session selection and routing recovery after an eligible 429 still consult `quotaWindow`. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | New-session strategy; `quota` ranks accounts by the window set by `quotaWindow`, and `fill-first` evaluates its drain threshold in that same window. |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` | The cached provider-reported utilization bar used for usage-aware account selection. `five-hour` keeps the original behavior. `weekly` scores the weekly bar and skips accounts whose 5-hour bar is exhausted while another eligible account remains, but falls back to exhausted candidates when none do. `max-utilization` scores the highest known bar, so it can use 5-hour usage before weekly usage is available; if neither is known, the account follows unknown-usage ordering. Known usage ranks before unknown usage under the opt-in `weekly` and `max-utilization` windows only; an omitted or explicit `five-hour` preserves the legacy ordering. If every eligible account is unknown, selection still returns one in eligible order. After the documented lower-5-hour tie-break, exact ties preserve eligible order. A healthy affinity-bound session is not proactively rebalanced. For new-session assignment and routing recovery after an eligible 429 replacement, `quota` ranks eligible candidates directly with this window; `fill-first` advances in stable order using this window's threshold and exhaustion rules; `round-robin` ignores it. Cooldown, failover limits, and reauthentication eligibility remain separate local state. Per-account weekly bars are only known once the dashboard Providers page has polled them. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Successful new-session binds retained on one round-robin selection. Range 1–100. |

When enabled, 429 records bounded cooldown from `Retry-After` or a default backoff and may rotate
within the request. Affinity is process-local and size-bounded. Credential 401/403 marks the account
as needing reauthentication. If all eligible accounts are cooling, clients receive 429 with
`Retry-After` when known, not an authentication error.

:::caution[Experimental]
Leave this disabled unless you understand Anthropic account policy risk. Prefer manual
`ocx account use anthropic <id>` switching when unsure.
:::

### `oauthAccountFailover`

Rotates to another logged-in account of the same provider when one is rate-limited, for OAuth
providers that have no pool of their own — xAI, Cursor, Kimi, GitHub Copilot, Google Antigravity,
and Nous.

**Logging in a second account is what turns this on.** With no configuration, rotation activates
for any of those providers holding 2 or more accounts that are not flagged for reauthentication —
the same rule `apiKeyPool` already applies to a 2+ key pool. A provider with one stored account
behaves exactly as before.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `oauthAccountFailover.enabled?` | `boolean` | presence-driven | Global override. `false` forces single-account behaviour everywhere; `true` forces rotation on. |
| `providers.<name>.oauthAccountFailover.enabled?` | `boolean` | inherits | Per-provider override; beats the global setting and beats account presence. |
| `providers.<name>.oauthAccountFailover.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | — | Declared pool strategy for a generic OAuth provider (#695). Persisted through `ocx account strategy <provider> <name>` or `PUT /api/oauth/accounts/pool`; the generic selector does not act on it yet, so omitted and set behave the same today. |
| `providers.<name>.oauthAccountFailover.autoSwitchThreshold?` | `number` | — | Declared 0–100 usage percent for a proactive switch on a generic OAuth provider (#695). Set with `ocx account auto-switch <provider> threshold <n>`; inert until the selector consumes it. |

To keep strict single-account behaviour for one provider whose terms you would rather not test:

```json
{
  "providers": {
    "cursor": {
      "oauthAccountFailover": { "enabled": false }
    }
  }
}
```

That setting survives logging in, adding an account, and reauthenticating.

Generic OAuth providers (Google Antigravity, xAI, Cursor, Kimi, GitHub Copilot, Nous, and any
other OAuth provider outside the Codex and Anthropic pools) also accept `strategy` and
`autoSwitchThreshold` on the same key, through `GET`/`PUT /api/oauth/accounts/pool?provider=<name>`
and the `ocx account strategy` / `ocx account auto-switch` verbs. The response carries
`"inert": true` while the generic selector ignores those two fields; `stickyLimit` and
`quotaWindow` are not part of the generic contract. Codex (`/api/codex-auth`) and Anthropic
(`anthropicAccountPool`) keep their own contracts unchanged.

Deliberately narrower than `anthropicAccountPool`: no session affinity, no quota-ranked
selection, no probe leases. It answers one question — the account that just returned 429 is
cooled, is there another one available.

The Codex pool and the Anthropic pool are excluded and keep their own rotation; enabling this
changes neither. A provider with a single stored account is a strict no-op, and no cooldown is
recorded for it.

On a 429 the failed account is cooled using `Retry-After` when present (capped at 15 minutes)
or a default backoff, and the request is replayed on the next eligible account, up to three
rotations per request. An account flagged for reauthentication is never selected. Cooldowns are
process-local, so a restart forgets them.

Rotation carries the alternate account's **full** credential snapshot, not just its bearer, so a
provider that pairs routing metadata with its token — Antigravity's Cloud Code Assist project id,
for example — cannot end up sending one account's token with another account's metadata.

Current scope is the ordinary Responses request paths. Cursor reports rate limits as adapter
events rather than an HTTP status, and the standalone Antigravity image endpoint has its own
request path; neither rotates yet.

:::caution[Experimental]
Rotating across subscription accounts spends a second account's quota and may violate some
providers' terms. If that is not a tradeoff you want, set `enabled: false` globally or for the
provider in question.
:::

### Managed record shapes

`apiKeys[]` entries contain `id`, `name`, generated `key`, and ISO `createdAt` strings.
`codexAccounts[]` entries require `id`, `email`, and `isMain`, with optional `plan`,
`chatgptAccountId`, and privacy-safe `logLabel`. These records are normally dashboard-managed.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Global proactive-refresh switch. |
| `tickSeconds?` | `number` | `21600` | Sweep interval (6 hours, minimum 60 seconds). |
| `jitterSeconds?` | `number` | `300` | Random delay before a sweep. |
| `concurrency?` | `number` | `3` | Maximum simultaneous refreshes. |
| `leadSeconds?` | `number` | `900` | Extra refresh lead time beyond one tick. |
| `failureBackoffBaseSeconds?` | `number` | `300` | Initial transient-failure backoff. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Backoff ceiling and permanent-failure delay. |
| `codexWarmupEnabled?` | `boolean` | `false` | Opt into synthetic Codex pool-account validation. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | Revalidate an account after 8 days. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | Native model used for optional warmup. |

## Fixed provider endpoints

Routing resolves a provider endpoint before the adapter. For most built-ins, the registry endpoint
wins over configured `baseUrl`. Four entry types keep the configured URL:

- override-enabled providers: `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud`, and
  `alibaba-token-plan-intl`;
- registry templates filled by the user, such as `azure-openai` and `cloudflare-ai-gateway`;
- promoted fixed API-key presets preserving an older same-named custom destination; and
- providers absent from the registry.

Adapters can adjust the resolved URL afterward. Kiro, for example, follows the imported credential's
API region for canonical `runtime.{region}.kiro.dev`. See [Adapters](/reference/adapters/).

When routing discards `baseUrl`, opencodex logs the registry endpoint and only the configured origin;
a configured path may itself contain a credential. Remove the unused URL or choose the provider entry
matching the intended region. `alibaba-token-plan` is pinned to Beijing, while
`alibaba-token-plan-intl` covers international endpoints.

For a broken `openai-responses` gateway, repair belongs on the provider object:

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

Placeholder lists are exact matches. Leave the field unset for normal/stateful Responses providers
so passthrough stays byte-for-byte identical.

## Cursor provider (`adapter: "cursor"`)

The Cursor bridge is experimental. After `ocx login cursor`, add or edit `providers.cursor`.

If a proxy cannot carry Cursor's default HTTP/2 stream, set `upstreamHttpVersion` to `"http1.1"`
or its `"h1"` alias.
This switches inference to Cursor's `RunSSE` + `BidiAppend` compatibility transport and uses
HTTP/1.1 for `GetUsableModels` discovery as well. The value requires an HTTPS `baseUrl`. Leave it
unset or use `"auto"` for the existing HTTP/2 behavior. In the dashboard choose
**Providers → Cursor → Settings → Cursor transport**.

Cursor Router's optimization ladder is exposed as separate Codex ids because the picker cannot render
Cursor-specific model parameters:

| Codex model | Cursor Router mode |
| --- | --- |
| `cursor/auto` | Team/account default |
| `cursor/auto-cost` | Cost |
| `cursor/auto-balance` | Balance |
| `cursor/auto-intelligence` | Intelligence |

Explicit variants send Cursor's `default` model with its `optimization` parameter, preserving the
selection on every request. They remain available when live discovery omits `default`.

### Vision

Native Cursor vision uses `SelectedImage` (JPEG soft-cap + `blobIdWithData`) for models that can
see images natively — Claude, Gemini, GPT, Kimi, and Grok among them — using active-turn `data:`
images only. Earlier-turn images replay as `[image attached]` text markers; remote or undecodable
images become omission markers. Auto, the Composer family, and GLM (`glm-5.2`, `glm-5.3`) stay on
the curated `noVisionModels` list and use the vision describe sidecar instead.

Cursor server-driven local tools are disabled by default. Codex continues using its own tools such as
`apply_patch` and `exec_command` with its own approval and sandbox policy:

- `"off"` (default) rejects Cursor-native `read`, `write`, `delete`, `ls`, `grep`, `shell`, and
  `fetch` execution.
- `"on"` opts into trusted-local execution and bypasses Codex approval/sandbox semantics.
- `"codex-sandbox"` is retained for compatibility but fails closed like `"off"`; request prose is
  not trustworthy sandbox attestation.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

Set `nativeLocalExec` on `providers.cursor`, not at the top level. In the dashboard use **Providers
→ Cursor → Edit JSON**, save, then restart. Legacy `unsafeAllowNativeLocalExec: true` equals
`nativeLocalExec: "on"` only when `nativeLocalExec` is unset. MCP, screen recording, and computer use
are controlled separately by `mcpServers` and `desktopExecutor`.

Each `mcpServers.<name>` accepts either `command` (stdio) or `url` (Streamable HTTP). Stdio also
accepts `args`, `env`, and `cwd`; HTTP accepts `headers`. Both support `enabled` (default true) and
`toolPrefix`. `desktopExecutor` accepts `computerUseCommand`, `recordScreenCommand`, `cwd`, `env`,
and `timeoutMs` (default `30000`). Commands run through `sh -c`, read one JSON request from stdin,
and must write one JSON result to stdout.

:::caution[Security]
The default loopback bind admits any local process without auth, including other users on a
multi-user host. Leave local exec off unless every data-plane caller is trusted and you deliberately
accept bypassing Codex approval and sandbox semantics.
:::

## OpenRouter provider routing

OpenRouter can serve one model through several inference providers. `openRouterRouting` keeps
requests on preferred providers; `modelOpenRouterRouting` replaces it for exact model ids. This is
useful for prompt-cache affinity because cache support, retention, hit rates, and pricing vary by
inference provider.

Provider names are OpenRouter slugs. `allowFallbacks: false` fails closed; `true` allows another
eligible provider after the ordered list. `only` is always an allowlist.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

## Vercel AI Gateway provider routing

Vercel AI Gateway can route a model across multiple underlying inference providers. `vercelGatewayRouting` configures provider-wide preferences; `modelVercelGatewayRouting` replaces it for exact model IDs. Leaving both unset makes `resolveVercelGatewayRouting()` return `undefined`, so Chat request builders omit the `provider` field and Vercel AI Gateway retains its default dynamic routing behavior.

- `order`: Vercel AI Gateway upstream provider slugs in priority order.
- `only`: explicit allowlist restricting eligible Vercel AI Gateway upstream providers.
- `sort`: automatically sort eligible providers by `"cost"` (lowest cost), `"ttft"` (time to first token), or `"tps"` (tokens per second).

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "${VERCEL_AI_GATEWAY_KEY}",
      "vercelGatewayRouting": {
        "sort": "ttft"
      },
      "modelVercelGatewayRouting": {
        "zai/glm-5.2": {
          "only": ["novita", "deepinfra"],
          "order": ["novita", "deepinfra"]
        }
      }
    }
  }
}
```

Model keys are Vercel public model selectors without the outer OpenCodex provider prefix. Selecting
`vercel-ai-gateway/zai-glm-5.2` restores native `zai/glm-5.2` before applying the model rule. The
same mapping applies to a native `vercel/<model-id>` selector: use the encoded
`vercel-ai-gateway/vercel-<model-id>` selector in OpenCodex and keep `vercel/<model-id>` as the
model key.

## Static model allowlists

## Storing keys in the OS keychain

By default a provider's `apiKey` and `apiKeyPool` sit in `config.json` (mode 0600, atomic writes).
If you would rather keep the key material out of the file, move it into the OS credential store:

```bash
ocx provider keychain deepseek status    # store: file | env | keychain, and whether the keychain answers
ocx provider keychain deepseek store     # move active key + pool into the OS keychain
ocx provider keychain deepseek restore   # bring the plaintext back and delete the keychain items
```

The same operations are `GET`/`POST /api/providers/keychain`. After `store`, `config.json` holds
`"apiKey": "keychain:deepseek"` (pool entries `keychain:deepseek/<id>`) and the secret lives under the
`opencodex.provider-api-key.v1` service in macOS Keychain, Windows Credential Manager, or the Linux
Secret Service. Backups of `config.json` therefore carry references only. Key rotation and failover
keep working: pool entries compare by reference, so a rotation never writes plaintext back.

Before touching the config, `store` writes and reads back every entry; if the keychain is unavailable
or the read-back does not match, it refuses with 503 and leaves the file as it was. At request time
a reference that cannot be read yields no credential and one warning per key — there is no plaintext
fallback, by design.

When not to opt in: a proxy running as a headless service (systemd, launchd, Task Scheduler) or in a
container usually has no unlocked keychain session, so requests would fail closed. Use an
`${ENV_VAR}` reference in the service environment there instead. Env references are left untouched
by `store`.

Set `liveModels: false` to expose only `models`. If `models` is empty or omitted, the provider exposes
no routed models. Live discovery rejects more than 4 MiB or 2,000 raw model rows before caching;
built-in presets may use lower limits and filter to chat-eligible rows. Oversized or malformed results
follow stale/configured fallback. A valid zero-eligible result remains authoritative and is not
silently replaced or truncated.

Use `selectedModels` when discovery should still run but only selected ids should appear in Codex and
`/v1/models`. The dashboard retains the full discovered list for later allowlist changes.

Use `retainModels` for the opposite problem: a provider whose `/models` endpoint omits an id that is
still callable (a private deployment, a preview id, an OpenAI-compatible gateway with a partial
listing). Listed ids are kept in the routed catalog with the same context and effort hints as
`models`, and they survive `liveModels: false` too. `selectedModels` still narrows what is visible,
so an id must be in both lists when an allowlist is active. Retaining an id does not make the
upstream accept it; a wrong id fails at request time with the upstream error. From the CLI:
`ocx provider edit <name> --retain-models gemini-3.7-flash,other-id` (`-` clears).

Preview GPT-5.6 fallback entries use the same mechanism. The OpenAI API-key preset seeds base and Pro
ids with context `922000` and max input `922000`; OpenRouter seeds `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` with context `922000`. Pool/Direct advertises
`922000`; the synced catalog advertises `max` while keeping `xhigh` distinct.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Complete example

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "glm-5.3", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```
