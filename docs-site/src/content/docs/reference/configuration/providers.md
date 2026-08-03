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
| `disabledModels?` | `string[]` | — | Models hidden from Codex's catalog and `/v1/models`, but not blocked from direct proxy calls. Routed ids are removed from listings; bare native GPT ids get `visibility: "hide"`. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Per-provider Codex-visible context caps. A cap only lowers a known context window. |
| `contextCapValue?` | `number` | `350000` | Value used by the dashboard context-cap controls; changing it updates every enabled `providerContextCaps` entry. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT/Codex pool account metadata managed by Codex Auth. Secrets live separately in `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Accounts excluded from Pool selection until resumed, including the main `__main__` account when paused. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Optional public model-selector namespace to stored Codex account target. `<selector>/<native-openai-model>` routes using exactly the mapped account; this setting does not add model-picker rows. |
| `activeCodexAccountId?` | `string` | — | Manually selected Pool account for the next request. Selection clears thread affinity; in-flight requests keep captured credentials. |
| `autoSwitchThreshold?` | `number` | `80` | Usage threshold for proactive switching. `quota` can re-evaluate both bound and unbound tasks on their next request; `fill-first` uses it only as the drain point for unbound assignment; normal `round-robin` selection does not use it. The score uses the hottest known 5h, weekly, or 30d quota window. `0` disables usage-based proactive switching only, not unbound assignment or failure recovery. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Assignment strategy for new/unbound Codex requests. A request is unbound when it has no live (parent thread id, quota scope) affinity; a visible existing task can become unbound after proxy restart or affinity reset. `quota` picks the lowest-usage eligible account when no active account exists, keeps an eligible active account below `autoSwitchThreshold`, and after the threshold may move an unbound request or proactively rebind a bound task to a lower-usage eligible account. `round-robin` distributes unbound requests evenly; `fill-first` keeps assigning unbound requests to the active account until cooldown, unavailability, or the configured drain threshold. |
| `accountPoolStickyLimit?` | `number` | `1` | New/unbound task assignments retained on one round-robin selection before advancing; the counter advances when a task is bound, not after an upstream success. Range 1–100. |
| `upstreamFailoverThreshold?` | `number` | `3` | Consecutive transient failures before future new sessions fail over. Set `0` to disable. |
| `modelCacheTtlMs?` | `number` | `300000` | Freshness window for the per-provider `/models` cache. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache policy: disabled, 5-minute ephemeral, or 1-hour extended. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | Optional proactive OAuth refresh and Codex-account warmup policy. |

`codexAccountNamespaces` keys are public selectors: 1–64 characters, starting and ending with an
ASCII letter or number, with letters, numbers, `.`, `_`, or `-` inside. Reserved JavaScript object
names are rejected. Each value is a valid pool-account id (never internal `__main__`) or `"@main"`
for the Codex Desktop account. Provider and reserved `openai` / `combo` collisions are checked
case-insensitively; a namespaced combo alias cannot reuse a selector as its namespace prefix, and
configured pool ids or selector targets also cannot reuse a selector. Keep raw account ids and
emails private; the selector is the public name. See [Routing Configuration](/reference/configuration/routing/)
for exact-selection behavior and precedence.

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
| `adapter` | `string` | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` (or alias `azure`). |
| `baseUrl` | `string` | Upstream API base URL. Most built-in fixed endpoints ignore a mismatch; collision-safe key presets preserve an older same-named custom destination. |
| `responsesPath?` | `string` | Relative resource path for key-auth `openai-responses` requests. It must start with `/` and contain no scheme, query, or fragment. |
| `supportsServiceTier?` | `boolean` | Tri-state `service_tier` capability. `true`: fast mode may inject and caller values are preserved. `false`: the field is stripped and never injected (the upstream documented as not supporting it must not receive it). Absent: the provider is unclassified — caller-supplied values are preserved untouched and fast mode never injects. The registry classifies canonical OpenAI (`true`), DeepSeek, and Volcengine Ark (`false`); set it explicitly only for custom gateways that genuinely support tiers. |
| `preserveResponsesReasoningContent?` | `boolean` | Keep plaintext reasoning content on replayed Responses reasoning items instead of blanking it (blanking is the ChatGPT backend's rule). Enable for upstreams whose contract accepts reasoning replay, such as DeepSeek. Proxy-minted `ocxr1` envelopes are always stripped. |
| `disabled?` | `boolean` | Keep the provider on disk but exclude it from routing and model/catalog listings. |
| `apiKey?` | `string` | API key, or an `${ENV_VAR}` / `$ENV_VAR` reference resolved at request time. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key header style. Defaults to native `x-api-key`; valid only for key-auth `anthropic` providers. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Multi-key pool. `apiKey` mirrors the active entry; each item has `id`, `key`, optional `label`, and optional numeric `addedAt`. |
| `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
| `models?` | `string[]` | Seed/fallback model list. With `liveModels: false`, these are the only discovered models. |
| `liveModels?` | `boolean` | Fetch the live catalog on start/sync (default `true`). Custom providers use `${baseUrl}/models`; built-ins may use a registry URL and filter. |
| `selectedModels?` | `string[]` | Catalog allowlist after discovery. Non-empty exposes only those ids; empty or omitted exposes all discovered models. |
| `contextWindow?` | `number` | Provider-wide Codex-visible context cap. Smaller live metadata is retained. |
| `modelContextWindows?` | `Record<string, number>` | Per-model context caps. These override `contextWindow` and never raise smaller live metadata. |
| `modelInputModalities?` | `Record<string, string[]>` | Per-model input hints such as `["text"]` or `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Positive per-model max input limits used for catalog auto-compaction hints. |
| `defaultMaxOutputTokens?` | `number` | Provider-wide `openai-chat` fallback when the client omits `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Positive per-model `openai-chat` fallback budgets; exact/pattern matches beat the provider default. |
| `headers?` | `Record<string, string>` | Extra upstream headers. Authorization, cookies, API-key headers, embedded newlines, and invalid names are rejected. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Default OpenRouter `order`, `only`, and `allowFallbacks` preferences; valid only for canonical OpenRouter with `openai-chat`. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | Exact model-id overrides that replace the provider-wide OpenRouter preference. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Authentication mode (default `key`). OAuth/subscription credentials are stored outside `config.json`; `local` is limited to providers whose registry entry permits it. |
| `codexAccountMode?` | `"pool" \| "direct"` | Canonical `openai` only; defaults to Pool. Direct bypasses pool state. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Override this OAuth provider's Token Guardian policy. |
| `reasoningEfforts?` | `string[]` | Provider-wide Codex reasoning labels to advertise and send. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Per-model labels. An empty list hides effort control. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Set a model to `false` to stop advertising summaries and strip summary-delivery fields. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Per-model Responses delivery enum; rewrites an existing delivery field. |
| `modelAdapters?` | `Record<string, string>` | Per-model `openai-chat` or `openai-responses` wire override for mixed-wire gateways. Explicit entries beat registry defaults; DeepSeek's preset can select native Responses for `deepseek-v4-flash`, and GitHub Copilot declares Responses-only defaults for its GPT-5 family (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) because those models reject `/chat/completions` for agent traffic. Models without a built-in default (for example `gpt-5.4-nano`) can be opted in here. Single-wire upstream pins and canonical ChatGPT forward reject overrides. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Exact-model opt-in for non-forward Responses gateways that reserve a hosted-tool namespace. Currently accepts only `["image_generation"]`; a matching model must use the `openai-responses` wire and support that hosted tool. It removes colliding client `image_gen` declarations and rewrites their selectors to preserve caller tool choice. For OpenAI API virtual `-pro` models, the selected public ID is matched first and the resolved base wire-model ID is a fallback. `modelAdapters` resolves the public ID first, then the base ID; the second resolution determines the final wire. Other models retain normal alias behavior. |
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire aliases for reasoning labels. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Per-model wire aliases for reasoning labels. |
| `reasoningWireFormat?` | `"gateway-object"` | For OpenAI-compatible gateways that accept `reasoning: { enabled, effort }` instead of `reasoning_effort`. The ClinePass preset sets this automatically. |
| `noReasoningModels?` | `string[]` | Models that reject reasoning/thinking parameters. |
| `noTemperatureModels?` | `string[]` | Models that reject caller-specified `temperature`. |
| `noTopPModels?` | `string[]` | Models that reject caller-specified `top_p`. |
| `noPenaltyModels?` | `string[]` | Models that reject presence/frequency penalties. |
| `parallelToolCalls?` | `boolean` | Toggle parallel tool calls. OpenAI Chat defaults on; non-chat adapters advertise only on explicit `true`. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | Disabled-by-default downstream SSE repair for exact placeholder ids and missing terminal ids. Function-call ids are never rewritten. |
| `autoToolChoiceOnlyModels?` | `string[]` | Models whose `tool_choice` accepts only `auto` or `none`; forced choices are downgraded. |
| `preserveReasoningContentModels?` | `string[]` | Models requiring prior assistant `reasoning_content` in chat history. |
| `thinkingToggleModels?` | `string[]` | Chat models using `thinking.enabled` rather than an effort ladder. |
| `thinkingBudgetModels?` | `string[]` | Chat models using integer `thinking_budget`; effort maps to a budget fraction. |
| `noVisionModels?` | `string[]` | Text-only models sent through the vision sidecar; matching tolerates an Ollama `:size` tag. |
| `escapeBuiltinToolNames?` | `boolean` | Escape built-in tool names for Anthropic-compatible gateways and restore them in returned calls. |
| `anthropicEofTolerance?` | `boolean` | Let an Anthropic-compatible gateway complete a stream that ends before `message_stop`, only when visible text or a complete JSON-object tool input was received. Off by default. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transport/auth mode. Default `ai-studio`. |
| `project?` | `string` | Vertex or Antigravity Cloud Code Assist project id. |
| `location?` | `string` | Vertex location; environment fallback is `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Cursor only: stdio or Streamable HTTP MCP servers. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Cursor only: external computer-use and record-screen commands. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor legacy boolean, equivalent to `nativeLocalExec: "on"` only when the newer field is unset. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor local-exec policy. `off` is default; `codex-sandbox` currently fails closed like `off`. |

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
task after proxy restart or affinity reset. A pre-stream 429 or 402 retries once on an eligible
alternate account in the same request, even when usage-based proactive switching is off. Account
changes preserve and replay the conversation context, but provider-side prompt-cache reuse across
accounts is not guaranteed and the cache may need to warm again.

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
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | For new sessions, choose the lowest known cached 5-hour usage at or above this threshold. `0` disables quota picking. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | New-session strategy; quota uses 5-hour bars only. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Successful new-session binds retained on one round-robin selection. Range 1–100. |

When enabled, 429 records bounded cooldown from `Retry-After` or a default backoff and may rotate
within the request. Affinity is process-local and size-bounded. Credential 401/403 marks the account
as needing reauthentication. If all eligible accounts are cooling, clients receive 429 with
`Retry-After` when known, not an authentication error.

:::caution[Experimental]
Leave this disabled unless you understand Anthropic account policy risk. Prefer manual
`ocx account use anthropic <id>` switching when unsure.
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

Set the field on `providers.cursor`, not at the top level. In the dashboard use **Providers → Cursor
→ Edit JSON**, save, then restart. Legacy `unsafeAllowNativeLocalExec: true` equals
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

Model keys are exact native OpenRouter ids, without the outer opencodex provider prefix. Selecting
`openrouter/anthropic-claude-sonnet-5` restores native `anthropic/claude-sonnet-5` before applying
the model rule.

## Static model allowlists

Set `liveModels: false` to expose only `models`. If `models` is empty or omitted, the provider exposes
no routed models. Live discovery rejects more than 4 MiB or 2,000 raw model rows before caching;
built-in presets may use lower limits and filter to chat-eligible rows. Oversized or malformed results
follow stale/configured fallback. A valid zero-eligible result remains authoritative and is not
silently replaced or truncated.

Use `selectedModels` when discovery should still run but only selected ids should appear in Codex and
`/v1/models`. The dashboard retains the full discovered list for later allowlist changes.

Preview GPT-5.6 fallback entries use the same mechanism. The OpenAI API-key preset seeds base and Pro
ids with context `1050000` and max input `922000`; OpenRouter seeds `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` with context `1050000`. Pool/Direct advertises
`372000`; the synced catalog advertises `max` while keeping `xhigh` distinct.

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
