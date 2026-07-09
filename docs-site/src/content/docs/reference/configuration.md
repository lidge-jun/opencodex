---
title: Configuration Reference
description: Every field in ~/.opencodex/config.json — top-level options, providers, and sidecars.
---

opencodex is configured by `~/.opencodex/config.json`. It's written by `ocx init` and the dashboard,
but you can edit it directly; the proxy reloads it on start. If the file cannot be parsed (e.g.
truncated or invalid JSON), opencodex backs it up to `config.json.invalid-<timestamp>`, prints a
console warning, and starts with defaults. Missing files also fall back to a default (a single
`openai` forward provider).

## Top level (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Port the proxy listens on. |
| `hostname?` | `string` | `"127.0.0.1"` | Bind address. Set `"0.0.0.0"` to expose on the LAN (requires `OPENCODEX_API_AUTH_TOKEN`; see [Remote access](#remote-access) below). |
| `providers` | `Record<string, OcxProviderConfig>` | — | Map of provider name → config. |
| `defaultProvider` | `string` | `"openai"` | Provider used when routing finds no better match. |
| `subagentModels?` | `string[]` | — | Up to 5 `provider/model` ids featured first in Codex's subagent picker. |
| `disabledModels?` | `string[]` | — | Models hidden from Codex. Routed `provider/model` ids are excluded from the catalog and `/v1/models`; bare native GPT slugs (e.g. `gpt-5.4`) flip their catalog entry to `visibility: "hide"` and drop from the bare `/v1/models` list. Toggleable per model from the dashboard Models page. |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 3-state multi-agent surface override. `"v1"` forces all models to the v1 surface (overrides upstream pins); `"default"` respects upstream model pins (sol/terra=v2, luna=v1); `"v2"` forces all models to v2. Settable from the dashboard Models page or `ocx v2 mode`. |
| `websockets?` | `boolean` | `false` | Advertise `supports_websockets` so Codex uses the Responses WebSocket path. Omit or set `false` to keep HTTP/SSE. |
| `syncResumeHistory?` | `boolean` | `true` | Reversible Codex App history compatibility mode. opencodex backs up original Codex thread metadata, remaps old OpenAI interactive rows to `opencodex`, and temporarily promotes opencodex-created `exec` rows to an app-visible source. `ocx stop` / `ocx restore` restore backed-up OpenAI rows and eject remaining opencodex user threads to OpenAI so native Codex can resume them after the proxy is removed from `config.toml`. Set `false` to opt out. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT/Codex pool account metadata managed by the Codex Auth dashboard. Secrets live separately in `codex-accounts.json`. |
| `activeCodexAccountId?` | `string` | — | Pool account used for the next new Codex thread. Existing thread affinities keep their original account. |
| `autoSwitchThreshold?` | `number` | `80` | Usage percent threshold for new-session auto-switching. The score uses the hottest known 5h, weekly, or 30d quota window. Set `0` to disable quota auto-switching. |
| `upstreamFailoverThreshold?` | `number` | `3` | Consecutive transient upstream failures before future new sessions fail over to another eligible pool account. Set `0` to disable failure failover. |
| `modelCacheTtlMs?` | `number` | `300000` | Freshness window for the per-provider `/models` cache (5 min). |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | Web-search sidecar options (see below). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | Vision sidecar options (see below). |

If an older development build already ran `syncResumeHistory` before backup support existed, you can
also force the same native-provider recovery with `ocx recover-history --legacy-openai`.

:::note[Codex account pool]
Use the dashboard's **Codex Auth** page to add pool accounts and refresh quotas. The config stores
non-secret account metadata only; access and refresh tokens are kept in the hardened Codex account
credential store. Existing thread ids keep account affinity, while new sessions can auto-route based
on quota, cooldown, and health.
:::

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

The token is compared in constant time (`timingSafeEqual`) to prevent timing side-channels.

:::caution[LAN exposure]
Binding to `0.0.0.0` exposes your proxy — and all configured provider credentials — to the local
network. Only do this on trusted networks, and always set a strong `OPENCODEX_API_AUTH_TOKEN`.
:::

## Providers (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, `azure-openai`, `cursor`. |
| `baseUrl` | `string` | Upstream API base URL. |
| `apiKey?` | `string` | API key, or an `${ENV_VAR}` / `$ENV_VAR` reference resolved at request time. |
| `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
| `models?` | `string[]` | Seed/fallback model list. Also becomes the exact catalog allowlist when `liveModels` is `false`. |
| `liveModels?` | `boolean` | Fetch the provider's live `/models` catalog on start/sync (default `true`). Set `false` to use only configured `models`. |
| `contextWindow?` | `number` | Provider-wide Codex-visible context-window cap for routed catalog entries. Live metadata below this value is kept. |
| `modelContextWindows?` | `Record<string,number>` | Model-specific context-window caps. These override `contextWindow` for matching model ids and never raise smaller live metadata. |
| `modelInputModalities?` | `Record<string,string[]>` | Model-specific catalog input hints such as `["text"]` or `["text", "image"]`. |
| `reasoningEfforts?` | `string[]` | Provider-wide Codex reasoning labels to advertise and send (`low`, `medium`, `high`, `xhigh`, `max`). |
| `modelReasoningEfforts?` | `Record<string,string[]>` | Model-specific reasoning labels. An empty list hides the effort control for that model. |
| `reasoningEffortMap?` | `Record<string,string>` | Provider-wide wire aliases for reasoning labels. Use only when the upstream expects a different value. |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | Model-specific wire aliases for reasoning labels. |
| `headers?` | `Record<string,string>` | Extra HTTP headers sent upstream. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | How to authenticate (default `key`). See [Providers](/opencodex/guides/providers/#auth-modes). |
| `noReasoningModels?` | `string[]` | Models that reject a reasoning/thinking param — the adapter drops `reasoning_effort` for them. |
| `noVisionModels?` | `string[]` | Text-only models — the [vision sidecar](/opencodex/guides/sidecars/) describes images for them. Matching tolerates an Ollama `:size` tag. |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic-compatible gateways such as Umans can require tool-name escaping on the wire; opencodex strips the prefix before returning tool calls to Codex. |
| `unsafeAllowNativeLocalExec?` | `boolean` | **Cursor adapter only.** Opt-in escape hatch for Cursor server-driven local `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` execution. Defaults to `false` so remote Cursor messages cannot bypass Codex approval and sandbox enforcement. See [Cursor provider](#cursor-provider-adapter-cursor) below. |

## Cursor provider (`adapter: "cursor"`)

The Cursor bridge is experimental. After `ocx login cursor`, add or edit the `cursor` entry under
`providers` in `~/.opencodex/config.json` (Windows: `%USERPROFILE%\.opencodex\config.json`).

By default, Cursor's server-driven native local tools stay **disabled**. Codex keeps using its own
tools (`apply_patch`, `exec_command`, and so on) with approval and sandbox policy. Set
`unsafeAllowNativeLocalExec` only for trusted local experiments where you accept that Cursor may
read, write, delete, list, grep, shell, or fetch on your machine **without** Codex's approval path.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "unsafeAllowNativeLocalExec": true
    }
  }
}
```

The flag belongs on the **provider object** (`providers.cursor`), not at the top level of
`config.json`.

You can also set it from the [web dashboard](/opencodex/guides/web-dashboard/): **Providers →
Cursor → Edit JSON**, add `"unsafeAllowNativeLocalExec": true`, save, then restart the proxy
(`ocx restart` or `ocx stop` + `ocx start`).

The older `allowNativeLocalExec` spelling is still accepted as a deprecated transition alias.
MCP, screen recording, and computer-use use separate executor config (`mcpExecutor`,
`desktopExecutor`) and are not controlled by this flag.

:::caution[Security]
Leave `unsafeAllowNativeLocalExec` unset or `false` unless you explicitly want Cursor-native local
execution that bypasses Codex approval and sandbox semantics.
:::

## Static model allowlists

Some providers expose very large or slow live model catalogs. Set `liveModels` to `false` when you
want Codex to see only the models pinned in `models`:

When `liveModels` is `false` and `models` is empty or omitted, opencodex exposes no routed models
for that provider.

Preview GPT-5.6 fallback entries use the same mechanism. The OpenAI API-key preset seeds
`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; the OpenRouter preset seeds the same models as
`openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna`. Both presets attach
model-specific `modelContextWindows` values of `372000`, and the synced Codex catalog advertises
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

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when a forward provider + login exist | Master switch. |
| `model?` | `string` | `gpt-5.4-mini` | The sidecar model running real `web_search` (must be a native ChatGPT model). |
| `reasoning?` | `string` | `low` | Reasoning effort for the sidecar (`minimal` is rejected with web search). |
| `maxSearchesPerTurn?` | `number` | `3` | Total real searches per main-model turn (loop guard). |
| `timeoutMs?` | `number` | `30000` | Sidecar fetch timeout. |

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when a forward provider + login exist | Master switch. |
| `model?` | `string` | `gpt-5.4-mini` | Vision model that describes images (must accept image input). |
| `timeoutMs?` | `number` | `45000` | Sidecar fetch timeout. |

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
  "subagentModels": ["anthropic/claude-opus-4-8", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": { "maxSearchesPerTurn": 3 },
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
