---
title: Configuration Reference
description: Every field in ~/.opencodex/config.json — top-level options, providers, and sidecars.
---

opencodex is configured by `~/.opencodex/config.json`. It's written by `ocx init` and the dashboard,
but you can edit it directly; the proxy reloads it on start. **Prefer stopping the proxy (or using the
dashboard / management API) before hand-editing** while a service is running: the live process keeps
config in memory and any mid-run save can rewrite the file from that snapshot. Since v2.7.41, hand
edits to the `claudeCode` subtree are preserved across those saves; other keys (for example
`providers`) can still be overwritten. If the file cannot be parsed (e.g. truncated or invalid JSON),
opencodex backs it up to `config.json.invalid-<timestamp>`, prints a console warning, and starts with
defaults. Missing files also fall back to a default (a single `openai` forward provider).

## Reserved OpenAI providers

`openai` and `openai-apikey` are fixed reserved ids. `openai.codexAccountMode` is `"pool"` by
default and selects across main plus added accounts; `"direct"` uses only the current caller/main
login. API uses only its configured API key/key pool. Use a bare model or
`openai-apikey/<model>`; there is no cross-route credential fallback. API GPT-5.6 rows carry
1,050,000 context / 922,000 max input metadata and Pro
virtual ids rewrite to the base wire model with `reasoning.mode: "pro"`.

`openaiProviderTierVersion: 2` marks the current single-provider projection. Before migrating a
shipped v1 config, opencodex creates `config.json.pre-openai-tiers-v2.bak` without replacing a
differing backup and rewrites known legacy namespaced selected ids to bare ids.

## Top level (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Port the proxy listens on. |
| `hostname?` | `string` | `"127.0.0.1"` | Bind address. Set `"0.0.0.0"` to expose on the LAN (requires `OPENCODEX_API_AUTH_TOKEN`; see [Remote access](#remote-access) below). |
| `proxy?` | `string` | — | Outbound HTTP(S) proxy URL or `${ENV_VAR}` reference. Applied to `HTTP_PROXY` / `HTTPS_PROXY` when those env vars are unset; loopback stays in `NO_PROXY`. |
| `providers` | `Record<string, OcxProviderConfig>` | — | Map of provider name → config. |
| `openaiProviderTierVersion?` | `2` | set by migration | Marks the single option-aware OpenAI projection as complete. |
| `defaultProvider` | `string` | `"openai"` | Provider used when routing finds no better match. |
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 trio, `gpt-5.4-mini` | Up to 5 native slugs or `provider/model` ids featured first in Codex's subagent picker. The v2 guidance roster is the configured intersection of Codex's picker-visible, v2-compatible, priority-sorted first five, using canonical catalog slugs and available effort ladders; excluded entries remain configured. An explicit empty list is preserved. |
| `injectionModel?` | `string` | — | Preferred native or routed sub-agent model. OpenCodex-authored v2 guidance tells delegation to pass this exact model to `spawn_agent` with `fork_turns: "none"`; the separate `syncCodexSubagentDefaults` opt-in can also apply it as Codex's native default for new tasks. |
| `injectionEffort?` | `string` | — | Preferred sub-agent reasoning effort (`low` through `ultra`). Only meaningful with `injectionModel`; used by delegation guidance and, when opted in, the native Codex subagent default. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Opt in to applying `injectionModel` and optional `injectionEffort` as native Codex `[agents]` defaults during sync/restart when OpenCodex manages the active Codex routing. External user-managed provider configs remain untouched. The defaults affect newly created Codex tasks and do not themselves cause delegation. Unmarked user-owned target entries are preserved as conflicts instead of being overwritten and remain authoritative. Requires `injectionModel`; clearing the model clears this opt-in. Exposed by `GET/PUT /api/injection-model` as a partial-update field. |
| `effortCap?` | `string` | — | Hard per-request ceiling for reasoning effort. A multi-agent V2 feature: it applies to main turns whose own tool list carries the V2 collab surface, plus spawned-child turns marked with exactly `x-openai-subagent: collab_spawn` or `"subagent_kind": "thread_spawn"` in `x-codex-turn-metadata` (marked children qualify regardless of their own tool surface). Plain and V1-surface main turns are untouched, compaction turns always bypass caps, and `multiAgentMode: "v1"` disables caps entirely (the Dashboard hides the panel). Accepts `low` through `ultra`; caps only lower, never raise. Snaps down to the highest supported rung at or below the cap. If the model exposes no effort control, or no supported rung fits under the cap, the effort field is removed and the provider default applies. `max` and `ultra` are accepted but do not impose a lower rank ceiling (requests arrive as `low` through `max` after the client's `ultra` → `max` conversion), though known model ladders may still cause snap-down or strip. The Dashboard picker offers `low` through `xhigh`. Managed via `GET /api/effort-caps` and `PUT /api/effort-caps`. |
| `subagentEffortCap?` | `string` | — | The same hard ceiling, applied only to spawned-child turns identified by codex-rs markers matched exactly: `x-openai-subagent: collab_spawn` or `"subagent_kind": "thread_spawn"` in `x-codex-turn-metadata`. Other internal sub-agent categories (review, compaction, memory consolidation) never trip this cap, and `multiAgentMode: "v1"` disables it entirely. Accepts `low` through `ultra`; when both caps are set, the lower one wins, and caps only lower, never raise. Snaps down to the highest supported rung at or below the cap. If the model exposes no effort control, or no supported rung fits under the cap, the effort field is removed and the provider default applies. `max` and `ultra` are accepted but do not impose a lower rank ceiling (requests arrive as `low` through `max` after the client's `ultra` → `max` conversion), though known model ladders may still cause snap-down or strip. The Dashboard picker offers `low` through `xhigh`. Managed via `GET /api/effort-caps` and `PUT /api/effort-caps`. |
| `injectionPrompt?` | `string` | — | Custom override for the injected v2 guidance body. Replaces the built-in text; `{{model}}`, `{{effort}}`, and `{{roster}}` placeholders are substituted. Firing gates are unchanged. Settable via `PUT /api/injection-model` (`prompt` key). |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Controls only OpenCodex-authored multi-agent developer guidance. Unset/`true` preserves v1/v2 guidance; `false` suppresses both without changing native Codex `[agents]` defaults, the collaboration surface, `subagentModels`, routing, or effort caps. `GET/PUT /api/injection-model` exposes the effective value; PUT is a partial update. |
| `disabledModels?` | `string[]` | — | Models **hidden** from Codex's catalog and `/v1/models` (not blocked at the proxy). Routed `provider/model` ids are excluded from listings; bare native GPT slugs (e.g. `gpt-5.4`) flip their catalog entry to `visibility: "hide"` and drop from the bare `/v1/models` list. Exact model ids remain directly callable. Toggleable per model from the dashboard Models page. |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 3-state multi-agent surface override. `"v1"` forces all models to the v1 surface (overrides upstream pins); `"default"` respects upstream model pins (sol/terra=v2, luna=v1); `"v2"` forces all models to v2. Settable from the dashboard Models page or `ocx v2 mode`. |
| `providerContextCaps?` | `Record<string,number>` | `{}` | Per-provider Codex-visible context caps. A cap only lowers known context windows. |
| `contextCapValue?` | `number` | `350000` | Value used by the dashboard's context-cap controls; changing it updates every enabled entry in `providerContextCaps`. |
| `stallTimeoutSec?` | `number` | `300` | Seconds without upstream data before the bridge aborts and emits `response.incomplete`. Minimum 1. |
| `connectTimeoutMs?` | `number` | `200000` | Per-attempt deadline for DNS/TCP/TLS and final response headers only; it ends before response-body generation. |
| `shutdownTimeoutMs?` | `number` | `5000` | Graceful drain deadline before active turns are aborted. |
| `websockets?` | `boolean` | `false` | Advertise `supports_websockets` so Codex uses the Responses WebSocket path. Omit or set `false` to keep HTTP/SSE. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | unset / `enabled: false` | **Opt-in** archived auto-cleanup (issue #42 Phase 3). Default **OFF** — never enabled implicitly. When enabled, runs on `schedule` (`startup` / `daily` / `weekly` / `manual`) once archived bytes exceed `trigger.archivedBytesOver`, selecting oldest archives toward `target` (`reduceToBytes` or `removeOldestPercent`) in `mode` (`quarantine` default, or explicit `permanent`). Persists `lastRun` / `nextRun`. Configure via Storage page or `GET`/`PUT /api/storage/cleanup-policy`; `POST /api/storage/cleanup-policy/run` for manual. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Additional generated `ocx_…` credentials accepted by management and data-plane auth on non-loopback binds. Managed by the dashboard; entry fields are listed below. |
| `codexAutoStart?` | `boolean` | `true` | Let the Codex shim run `ocx ensure` before launching Codex. `false` makes `ocx ensure` a no-op. |
| `codexShimAutoRestore?` | `boolean` | `true` | Restore a previously installed Codex shim when a completed external Codex update replaces it. Set `false`, or set `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out. |
| `syncResumeHistory?` | `boolean` | `true` | Reversible Codex App history compatibility mode. opencodex backs up original Codex thread metadata, remaps old OpenAI interactive rows to `opencodex`, and temporarily promotes opencodex-created `exec` rows to an app-visible source. `ocx stop` / `ocx restore` restore backed-up OpenAI rows and eject remaining opencodex user threads to OpenAI so native Codex can resume them after the proxy is removed from `config.toml`. Set `false` to opt out. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT/Codex pool account metadata managed by the Codex Auth dashboard. Secrets live separately in `codex-accounts.json`. |
| `activeCodexAccountId?` | `string` | — | Manually selected Pool account. Selection clears existing thread affinity and applies to the next request; in-flight requests keep their captured account. |
| `autoSwitchThreshold?` | `number` | `80` | Usage percent threshold for new-session auto-switching. The score uses the hottest known 5h, weekly, or 30d quota window. Set `0` to disable quota auto-switching. |
| `upstreamFailoverThreshold?` | `number` | `3` | Consecutive transient upstream failures before future new sessions fail over to another eligible pool account. Set `0` to disable failure failover. |
| `modelCacheTtlMs?` | `number` | `300000` | Freshness window for the per-provider `/models` cache (5 min). |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache policy: disabled, 5-minute ephemeral, or 1-hour extended. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | Web-search sidecar options (see below). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | Vision sidecar options (see below). |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Standalone Images relay options for Codex's built-in `image_gen` tool (see below). |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | Optional proactive OAuth refresh and Codex-account warmup policy; fields are listed below. |
| `corsAllowOrigins?` | `string[]` | `[]` | Additional exact origins allowed by CORS. Loopback origins are always allowed. |

`maxConcurrentThreadsPerSession` is the camel-case field used by `PUT /api/v2`, not a
`config.json` key. `ocx v2 threads <n>` persists the corresponding
`max_concurrent_threads_per_session` value under `[features.multi_agent_v2]` in Codex's
`$CODEX_HOME/config.toml`; enable v2 first so that table exists.

## Combos (`config.combos`)

Failover / round-robin aliases live under `combos.<id>` with `targets` (provider + model), optional
`strategy`, `alias`, and `defaultEffort`. A combo is always routable by `combo/<id>` or its alias
when requested explicitly.

Catalog listing is stricter. `ocx sync`, `/v1/models`, and Codex's model picker only include a combo
when **every** target has discoverable capabilities that can be intersected:

- a positive `contextWindow` (from live `/models`, registry hints, or provider
  `modelContextWindows` / `contextWindow`)
- a non-empty `inputModalities` intersection (defaults to `["text"]` when a member omits modalities)

When a member is a bare relay id with no context metadata, or when members advertise **disjoint**
`inputModalities` (empty intersection), the combo is **omitted from the catalog** even though direct
requests still work. `ocx sync` surfaces a summary warning (and `console.warn` once per combo); the
Combos dashboard flags it under Needs attention. Fix by setting `modelContextWindows` / matching
modalities on the relay provider, or by pointing targets at models that already advertise compatible
fields.

If an older development build already ran `syncResumeHistory` before backup support existed, you can
also force the same native-provider recovery with `ocx recover-history --legacy-openai`.

:::note[Codex account pool]
Use the dashboard's **Codex Auth** page to add pool accounts and refresh quotas. The config stores
non-secret account metadata only; access and refresh tokens are kept in the hardened Codex account
credential store. Existing thread ids keep account affinity, while new sessions can auto-route based
on quota, cooldown, and health.
:::

### anthropicAccountPool (experimental)

Opt-in routing across **multiple Anthropic OAuth accounts** already stored in `auth.json`
(issue [#294](https://github.com/lidge-jun/opencodex/issues/294)). **Default off.** This is
experimental and not battle-tested — enable only if you accept the risk that Anthropic may
restrict accounts that look like automated multi-account rotation. Accounts under the same
organization can share quota; pooling those will not help.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | When true, sticky session affinity + 429 cooldown failover across eligible Anthropic OAuth accounts. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | For **new** sessions only: if the active account's **known** cached 5-hour usage is at/above this percent, pick the lowest-usage eligible account. Unknown usage does not force a switch. `0` disables quota-based picking (affinity + active only). |

Reliability contract when enabled:

- A provider **429** records cooldown from `Retry-After` (capped) or a default backoff, clears
  that account's affinities, and may rotate within the request (bounded attempts).
- Affinity maps are **process-local** (lost on restart) and size-bounded.
- Credential **401/403** failures mark `needsReauth` and exclude the account until login is fixed.
- When all eligible accounts are cooling, clients receive **429** with `Retry-After` when known —
  not an authentication error.

Toggle and warning also appear on **Providers → anthropic → Accounts** in the GUI.
:::caution[Experimental]
Leave this disabled unless you understand Anthropic account policy risk. Prefer manual
`ocx account use anthropic <id>` switching when unsure.
:::

### claudeCode (OcxClaudeCodeConfig)

Claude Code inbound settings consumed by the `/v1/messages` surface, the `ocx claude`
launcher, and the GUI Claude page. Native-passthrough body bounds (added with the
body-occupancy guard):

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Native passthrough body inactivity budget in seconds — raw upstream-byte silence while a read is pending, never total duration. Min 1. Exactly `0` disables. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Native passthrough cumulative body byte cap (streamed SSE and buffered non-stream). Exactly `0` disables. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | unset (auto) | How `ANTHROPIC_AUTH_TOKEN` is handled at launch. Unset means auto: opencodex detects Claude auth on every launch and picks subscription when it finds any, proxy when it finds none, and subscription with a warning when it cannot tell. An explicit value is never overridden by detection. See [Claude Code](/guides/claude-code/#auth-mode). |
| `claudeCode.authModeMigratedAt?` | `string` | unset | Internal one-time marker. Written once when an upgrade pins a pre-`auto` config to `subscription`, so a deliberate subscriber is not silently moved onto the proxy. Do not set by hand. |

### Managed record shapes

`apiKeys[]` entries contain `id: string`, `name: string`, the generated `key: string`, and an ISO
`createdAt: string`. `codexAccounts[]` entries contain required `id`, `email`, and `isMain` fields,
plus optional `plan`, `chatgptAccountId`, and privacy-safe `logLabel` strings. These records are
normally dashboard-managed.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Global proactive-refresh switch. |
| `tickSeconds?` | `number` | `21600` | Sweep interval (6 hours, minimum 60 seconds). |
| `jitterSeconds?` | `number` | `300` | Random delay added before a sweep. |
| `concurrency?` | `number` | `3` | Maximum simultaneous refreshes per sweep. |
| `leadSeconds?` | `number` | `900` | Extra refresh lead time beyond one tick. |
| `failureBackoffBaseSeconds?` | `number` | `300` | Initial transient-failure backoff. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Backoff ceiling and permanent-failure delay. |
| `codexWarmupEnabled?` | `boolean` | `false` | Opt into synthetic Codex pool-account validation. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | Revalidate an account after 8 days. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | Native model used for optional warmup. |

## Remote access

By default opencodex binds to `127.0.0.1` (loopback only). When `hostname` is set to a non-loopback
address such as `0.0.0.0`, opencodex enforces token authentication on **both** the management API
(`/api/*`) and the data-plane (`/v1/responses`).

Set the `OPENCODEX_API_AUTH_TOKEN` environment variable before starting:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

The proxy refuses to start without this variable when binding beyond loopback. If you install a
background service for LAN access, export the same variable before `ocx service install` so launchd,
systemd, or Task Scheduler receives it. Clients must include the token in every request via the
`x-opencodex-api-key` header:

```
x-opencodex-api-key: your-secret-token
```

An `Authorization: Bearer …` header is also accepted. Dashboard-generated `apiKeys` may be used in
place of the environment token after startup; all candidates are compared in constant time
(`timingSafeEqual`) to prevent timing side-channels.

:::caution[LAN exposure]
Binding to `0.0.0.0` exposes your proxy — and all configured provider credentials — to the local
network. Only do this on trusted networks, and always set a strong `OPENCODEX_API_AUTH_TOKEN`.
:::

## Providers (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` (or alias `azure`). |
| `baseUrl` | `string` | Upstream API base URL. Built-in providers with a fixed endpoint ignore it — see [Fixed provider endpoints](#fixed-provider-endpoints). |
| `responsesPath?` | `string` | Optional relative resource path for key-auth `openai-responses` requests. It must start with `/` and contain no URL scheme, query, or fragment. When omitted, the adapter keeps its legacy `/v1/responses` URL construction. |
| `disabled?` | `boolean` | Keep the provider on disk but exclude it from routing and model/catalog listings. |
| `apiKey?` | `string` | API key, or an `${ENV_VAR}` / `$ENV_VAR` reference resolved at request time. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Multi-key pool. `apiKey` mirrors the active entry; each item has `id`, `key`, optional `label`, and optional numeric `addedAt`. |
| `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
| `models?` | `string[]` | Seed/fallback model list. When `liveModels` is `false`, these are the only discovered models. |
| `liveModels?` | `boolean` | Fetch the provider's live `/models` catalog on start/sync (default `true`). Set `false` to use only configured `models`. |
| `selectedModels?` | `string[]` | Catalog allowlist applied after discovery. A non-empty list exposes only those ids to Codex; empty/omitted exposes all discovered models. |
| `contextWindow?` | `number` | Provider-wide Codex-visible context-window cap for routed catalog entries. Live metadata below this value is kept. |
| `modelContextWindows?` | `Record<string,number>` | Model-specific context-window caps. These override `contextWindow` for matching model ids and never raise smaller live metadata. |
| `modelInputModalities?` | `Record<string,string[]>` | Model-specific catalog input hints such as `["text"]` or `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string,number>` | Model-specific max input token limits used for catalog auto-compaction hints. Values must be positive integers. |
| `defaultMaxOutputTokens?` | `number` | Provider-wide `openai-chat` fallback for `max_tokens` when the client omits `max_output_tokens`. Explicit requests still win. |
| `modelMaxOutputTokens?` | `Record<string,number>` | Model-specific `openai-chat` fallback output budgets. Exact/model-pattern matches beat `defaultMaxOutputTokens`; all values must be positive integers. |
| `headers?` | `Record<string,string>` | Extra upstream headers. Authorization, cookies, API-key headers, embedded newlines, and invalid header names are rejected. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Default OpenRouter provider preferences. Supports `order`, `only`, and `allowFallbacks`; valid only with the canonical OpenRouter base URL and `openai-chat` adapter. |
| `modelOpenRouterRouting?` | `Record<string,OpenRouterProviderRouting>` | Exact model-id overrides for `openRouterRouting`. A matching entry replaces the provider-wide default. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | How to authenticate (default `key`). See [Providers](/guides/providers/#auth-modes). |
| `codexAccountMode?` | `"pool" \| "direct"` | Only for canonical `openai`; defaults to Pool when omitted. Direct short-circuits pool state. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Override this OAuth provider's Token Guardian policy. |
| `reasoningEfforts?` | `string[]` | Provider-wide Codex reasoning labels to advertise and send (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). |
| `modelReasoningEfforts?` | `Record<string,string[]>` | Model-specific reasoning labels. An empty list hides the effort control for that model. |
| `modelSupportsReasoningSummaries?` | `Record<string,boolean>` | Model-specific reasoning-summary capability. Set a model to `false` to stop advertising summaries and strip summary-delivery fields before an `openai-responses` request. |
| `modelReasoningSummaryDelivery?` | `Record<string,"sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Model-specific Responses delivery enum. A configured model stays summary-capable and only an existing `stream_options.reasoning_summary_delivery` is rewritten; do not combine it with a `false` summary capability for the same model. |
| `modelAdapters?` | `Record<string,string>` | Per-model wire override for a gateway that fronts models speaking different wires. Keys are upstream native model ids; values must be `openai-chat` or `openai-responses`. Useful when one model needs the Responses API for hosted tools such as `web_search` while its siblings are fine on chat completions. Models the upstream pins to a single wire, and the canonical ChatGPT forward provider, reject overrides. |
| `reasoningEffortMap?` | `Record<string,string>` | Provider-wide wire aliases for reasoning labels. Use only when the upstream expects a different value. |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | Model-specific wire aliases for reasoning labels. |
| `noReasoningModels?` | `string[]` | Models that reject a reasoning/thinking param — the adapter drops `reasoning_effort` for them. |
| `noTemperatureModels?` | `string[]` | Models that reject caller-specified `temperature`. |
| `noTopPModels?` | `string[]` | Models that reject caller-specified `top_p`. |
| `noPenaltyModels?` | `string[]` | Models that reject presence/frequency penalties. |
| `parallelToolCalls?` | `boolean` | Enable/disable parallel tool calls. OpenAI Chat defaults on; non-chat adapters advertise support only on explicit `true`. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | Provider-local, disabled-by-default passthrough SSE repair for exact `message` / `reasoning` placeholder ids and missing terminal ids. Downstream only; function-call ids and `call_id` are never rewritten. |
| `autoToolChoiceOnlyModels?` | `string[]` | Models whose `tool_choice` accepts only `auto` or `none`; forced/named choices are downgraded. |
| `preserveReasoningContentModels?` | `string[]` | Models that require prior assistant `reasoning_content` to remain in chat history. |
| `thinkingToggleModels?` | `string[]` | Chat models using a vendor `thinking.enabled` toggle instead of an effort ladder. |
| `thinkingBudgetModels?` | `string[]` | Chat models using an integer `thinking_budget`; effort is mapped to a budget fraction. |
| `noVisionModels?` | `string[]` | Text-only models — the [vision sidecar](/guides/sidecars/) describes images for them. Matching tolerates an Ollama `:size` tag. |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic-compatible gateways such as Umans can require tool-name escaping on the wire; opencodex strips the prefix before returning tool calls to Codex. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transport/auth mode. Default `ai-studio`. |
| `project?` | `string` | Vertex project id or Antigravity Cloud Code Assist project id. |
| `location?` | `string` | Vertex location; environment fallback is `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string,CursorMcpServerConfig>` | **Cursor only.** MCP servers started over stdio or reached over Streamable HTTP; fields are listed below. |
| `desktopExecutor?` | `DesktopExecutorConfig` | **Cursor only.** External computer-use/record-screen commands; fields are listed below. |
| `unsafeAllowNativeLocalExec?` | `boolean` | **Cursor adapter only.** Legacy compatibility boolean for the Cursor server-driven local `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` executor. Equivalent to `nativeLocalExec: "on"` when `nativeLocalExec` is unset; an explicit `nativeLocalExec` value always wins. Defaults to `false`. Prefer `nativeLocalExec` for new configs. See [Cursor provider](#cursor-provider-adapter-cursor) below. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | **Cursor adapter only.** Native local exec policy for the Cursor server-driven executor. `"off"` (default) rejects it; `"on"` is the trusted-local opt-in; `"codex-sandbox"` is accepted for backwards compatibility but is fail-closed like `"off"`. See [Cursor provider](#cursor-provider-adapter-cursor) below. |

### Fixed provider endpoints

Routing resolves a provider's endpoint before any adapter sees it, and for most built-in
providers the registry's own endpoint wins over a `baseUrl` in your config. Three kinds of entry
keep the configured URL at this stage:

- providers that opt into an override — `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud`
  and `alibaba-token-plan-intl`;
- providers whose registry endpoint is a template you fill in, such as `azure-openai` and
  `cloudflare-ai-gateway`;
- providers you define yourself, which are not in the registry at all.

Adapters may adjust the resolved URL afterward. The `kiro` adapter, for example, follows the API
region of the imported credential for a canonical `runtime.{region}.kiro.dev` host. See
[Adapters](/reference/adapters/) for per-adapter rules.

When routing discards a configured `baseUrl`, opencodex logs a warning. It names the registry
endpoint in full and your configured one by origin only, shown as `https://host/…` when it had a
path — a configured path can itself be a credential, so none of it is logged. Either drop the
`baseUrl` — the registry endpoint is what routing will use regardless — or switch to the provider
whose endpoint matches the URL you wanted.
Picking the right entry matters when a vendor runs one product in several regions:
`alibaba-token-plan` is pinned to Beijing while `alibaba-token-plan-intl` covers the
international endpoints, and a key issued for one is rejected by the other.

For broken `openai-responses` compatibility gateways, `responsesItemIdRepair` belongs on the
provider object itself, for example:

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

The placeholder lists are exact string matches only. Leave the field unset for normal/stateful
Responses providers so passthrough stays byte-for-byte identical to upstream.

## Cursor provider (`adapter: "cursor"`)

The Cursor bridge is experimental. After `ocx login cursor`, add or edit the `cursor` entry under
`providers` in `~/.opencodex/config.json` (Windows: `%USERPROFILE%\.opencodex\config.json`).

Cursor Router's complete optimization ladder is exposed as separate Codex model ids because Codex's
model picker cannot render Cursor-specific model parameters:

| Codex model | Cursor Router mode |
| --- | --- |
| `cursor/auto` | Team/account default (backwards compatible) |
| `cursor/auto-cost` | Cost |
| `cursor/auto-balance` | Balance |
| `cursor/auto-intelligence` | Intelligence |

The explicit variants all send Cursor's `default` model with its `optimization` model parameter, so
the selection is preserved on every request. They remain available when live model discovery omits
`default`, just like the original `cursor/auto` entry.

By default, Cursor's server-driven native local tools stay **disabled**. Codex keeps using its own
tools (`apply_patch`, `exec_command`, and so on) with approval and sandbox policy. Use the
`nativeLocalExec` field to choose a policy:

- **`"off"` (default, safest)** — rejects all Cursor server-driven local `read`, `write`, `delete`,
  `ls`, `grep`, `shell`, and `fetch` execution. Use this unless you have deliberately opted in.
- **`"on"` (trusted-local opt-in)** — always allows Cursor-native local execution for this provider.
  Use it only for a trusted local experiment on a host where every data-plane caller is trusted.
- **`"codex-sandbox"` (accepted, fail-closed)** — recognized for backwards compatibility, but
  currently behaves like `"off"`. Responses `instructions` / `system` / `developer` text is
  caller-controlled prose, and opencodex has no trustworthy per-request attestation that it reflects
  a real Codex sandbox state, so it never authorizes native local exec.

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

The field belongs on the **provider object** (`providers.cursor`), not at the top level of
`config.json`.

You can also set it from the [web dashboard](/guides/web-dashboard/): **Providers →
Cursor → Edit JSON**, set `"nativeLocalExec"` to `"off"`, `"on"`, or `"codex-sandbox"`, save, then
restart the proxy (`ocx restart` or `ocx stop` + `ocx start`).

The legacy `unsafeAllowNativeLocalExec: true` boolean is still accepted and is equivalent to
`nativeLocalExec: "on"` when `nativeLocalExec` is unset; an explicit `nativeLocalExec` value always
wins. Prefer `nativeLocalExec` for new configs.

MCP, screen recording, and computer-use use separate `mcpServers` / `desktopExecutor` config and are
not controlled by this field.

### Cursor integration records

Each `mcpServers.<name>` value accepts either `command` (stdio) or `url` (Streamable HTTP). Stdio
entries also accept `args?: string[]`, `env?: Record<string,string>`, and `cwd?: string`; HTTP entries
accept `headers?: Record<string,string>`. Both forms support `enabled?: boolean` (default true) and
`toolPrefix?: string`.

`desktopExecutor` accepts `computerUseCommand?`, `recordScreenCommand?`, `cwd?`,
`env?: Record<string,string>`, and `timeoutMs?` (default `30000`). Commands run through `sh -c`, read
one JSON request from stdin, and must write one JSON result to stdout.

:::caution[Security]
`"off"` is the safest default. The default loopback bind admits **any** local process without auth
(including other local users on multi-user machines), and request text such as Codex sandbox
markers never authorizes native local exec. Leave `nativeLocalExec` unset or set it to `"off"`
unless you explicitly want Cursor-native local execution that bypasses Codex approval and sandbox
semantics.
:::

## OpenRouter provider routing

OpenRouter can serve one model through multiple inference providers. Use `openRouterRouting` to
keep requests on preferred providers, or `modelOpenRouterRouting` when different models need
different endpoints. This is especially useful for prompt-cache affinity: cache support, hit rates,
retention, and pricing can differ substantially between providers, and automatic provider changes
may turn expected cache hits into full-price uncached requests.

The configuration mirrors OpenRouter's provider-selection fields. Provider names are OpenRouter
provider slugs. `allowFallbacks: false` makes the preference fail closed; `true` lets OpenRouter use
other eligible providers after the ordered list. An `only` list is always an allowlist.

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

Model keys are exact OpenRouter model ids, without the outer OpenCodex provider prefix. With the
example above, select `openrouter/anthropic-claude-sonnet-5` in Codex; OpenCodex restores the native
`anthropic/claude-sonnet-5` id before applying the model-specific rule.

## Static model allowlists

Some providers expose very large or slow live model catalogs. Set `liveModels` to `false` when you
want Codex to see only the models pinned in `models`:

When `liveModels` is `false` and `models` is empty or omitted, opencodex exposes no routed models
for that provider.

Use `selectedModels` for a different purpose: discovery still runs, but only the selected ids are
published to Codex's catalog and `/v1/models`. The dashboard's full model list remains available so
the allowlist can be changed later.

Preview GPT-5.6 fallback entries use the same mechanism. The OpenAI API-key preset seeds base and
Pro ids with context `1050000` and max input `922000`; the OpenRouter preset seeds
`openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` with context `1050000`.
The Pool/Direct Codex catalog contract is `372000`, and the synced Codex catalog advertises
`max` reasoning while keeping `xhigh` distinct. Leave `liveModels` on to merge live provider results
with those explicit additions, or set it to `false` to expose only `models`.

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

## Sidecars

### `images` (`OcxImagesConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider?` | `string` | automatic OpenAI selection | Explicit custom API-key `openai-responses` provider for `/v1/images/generations` and `/v1/images/edits`. Registry-managed ids are rejected; omit this field to use the built-in ChatGPT/OpenAI fallback. |
| `timeoutMs?` | `number` | `300000` | Whole-request upstream timeout for one standalone Images request. |

Explicit provider selection fails closed when the provider is missing, disabled, incompatible, or
has no usable key. It never falls back to another paid upstream. The custom endpoint must implement
the OpenAI Images API paths and response shape expected by Codex.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when the selected backend is usable | Master switch. Set `false` to disable web-search sidecars. |
| `backend?` | `"openai" \| "anthropic"` | auto | Executor backend. Explicit config wins; when omitted, a usable stored Anthropic OAuth account selects `anthropic`, otherwise `openai`. |
| `model?` | `string` | backend-dependent | Search model: `gpt-5.6-luna` for `openai`, `claude-sonnet-5` for `anthropic`. Explicit legacy `gpt-5.4-mini` values are migrated on start. |
| `reasoning?` | `string` | `low` | Reasoning effort for the sidecar (`minimal` is rejected with web search). |
| `maxSearchesPerTurn?` | `number` | `3` | Total real searches per main-model turn (loop guard). |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Config-file-only continuous raw response-byte inactivity deadline for each routed-model iteration. Must be an integer from `1` through `2147483647`; every non-empty response-body chunk resets it. |
| `timeoutMs?` | `number` | `60000` | Separate deadline for one hosted web-search request. Lowered from 200000 so an unavailable/limit-exhausted search backend degrades to a no-result answer within ~1 min instead of hanging the whole turn (#398). |

The `openai` backend runs hosted search through an enabled ChatGPT `forward` provider, so it needs
both a ChatGPT login and that provider. On Claude-inbound routed replays, opencodex injects the main
ChatGPT auth into the internal sidecar request so this path remains reachable. The `anthropic`
backend uses the active stored credential from an enabled Anthropic OAuth provider and runs
Claude's `web_search_20250305` tool. If `backend: "anthropic"` is explicit but no active account is
usable (including `needsReauth`), the sidecar fails closed instead of falling back to OpenAI.

The web-search path has four clocks: the base bridge event-stall budget (`stallTimeoutSec`), the
DNS/TCP/TLS/final-header budget (`connectTimeoutMs`), routed-model raw-byte inactivity
(`routedModelStallTimeoutMs`), and one hosted search (`timeoutMs`). Its effective bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 seconds`. The routed
stall is an inactivity guard, not a total generation timeout.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when the selected backend is usable | Master switch. Set `false` to disable image descriptions. |
| `backend?` | `"openai" \| "anthropic"` | auto | Executor backend. Uses the same explicit-first, Anthropic-credential-aware resolution as web search. |
| `model?` | `string` | backend-dependent | Image-description model: `gpt-5.4-mini` for `openai`, `claude-sonnet-5` for `anthropic`. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Maximum new description cache misses admitted in one main-model turn. `0` disables description calls; invalid values use the default. |
| `timeoutMs?` | `number` | `45000` | Sidecar fetch timeout. |

Vision activates only for images sent to a model matched by its provider's `noVisionModels` list.
The OpenAI backend has the same login + forward-provider requirements as web search; the Anthropic
backend uses stored OAuth and fails closed when explicitly selected without a usable credential.
Successful `data:` image descriptions are cached in a bounded process-level cache keyed by backend,
model, detail, image bytes, and normalized message context. Cache hits and same-turn duplicates do
not consume `maxDescriptionsPerTurn`. Remote `https:` images and failed/empty descriptions are not
cached.

Anthropic-OAuth search and image-description requests reuse opencodex's existing Claude Code OAuth
fingerprint. This is within the repository's existing OAuth precedent, but should be soak-tested
with the intended account and workload.

<!-- TODO(WP5 GUI): Add the sidecar settings-screen walkthrough after the GUI controls ship. -->

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
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
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

:::tip[Secrets]
Prefer `${ENV_VAR}` references for keys so `config.json` stays free of secrets. OAuth and forward
providers store no key at all.
:::

:::note[Atomic writes]
All config and catalog files (`config.toml`, `opencodex-catalog.json`) are written atomically via
`atomicWriteFile` (temp file + rename). This prevents half-written files when concurrent writers —
e.g. `ocx stop` and the proxy's own shutdown handler — both restore Codex at the same time.
:::
