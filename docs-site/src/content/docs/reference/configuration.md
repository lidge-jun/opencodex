---
title: Configuration Reference
description: Every field in ~/.opencodex/config.json — top-level options, providers, and sidecars.
---

opencodex is configured by `~/.opencodex/config.json`. It's written by `ocx init` and the dashboard,
but you can edit it directly; the proxy reloads it on start. Missing or invalid files fall back to a
default (a single `openai` forward provider).

## Top level (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Port the proxy listens on. |
| `providers` | `Record<string, OcxProviderConfig>` | — | Map of provider name → config. |
| `defaultProvider` | `string` | `"openai"` | Provider used when routing finds no better match. |
| `subagentModels?` | `string[]` | — | Up to 5 `provider/model` ids featured first in Codex's subagent picker. |
| `disabledModels?` | `string[]` | — | Routed `provider/model` ids hidden from Codex (excluded from the catalog and `/v1/models`). |
| `websockets?` | `boolean` | `false` | Advertise `supports_websockets` so Codex uses the Responses WebSocket path. Omit or set `false` to keep HTTP/SSE. |
| `syncResumeHistory?` | `boolean` | `false` | Reversible Codex App history compatibility mode. When enabled, opencodex backs up original Codex thread metadata, remaps old OpenAI interactive rows to `opencodex`, and temporarily promotes opencodex-created `exec` rows to an app-visible source. `ocx stop` / `ocx restore` restore backed-up OpenAI rows and eject remaining opencodex user threads to OpenAI so native Codex can resume them after the proxy is removed from `config.toml`. |
| `modelCacheTtlMs?` | `number` | `300000` | Freshness window for the per-provider `/models` cache (5 min). |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | Web-search sidecar options (see below). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | Vision sidecar options (see below). |

If an older development build already ran `syncResumeHistory` before backup support existed, you can
also force the same native-provider recovery with `ocx recover-history --legacy-openai`.

## Providers (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, `azure`. |
| `baseUrl` | `string` | Upstream API base URL. |
| `apiKey?` | `string` | API key, or an `${ENV_VAR}` / `$ENV_VAR` reference resolved at request time. |
| `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
| `models?` | `string[]` | Seed/fallback model list (live `/models` is preferred when reachable). |
| `headers?` | `Record<string,string>` | Extra HTTP headers sent upstream. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | How to authenticate (default `key`). See [Providers](/opencodex/guides/providers/#auth-modes). |
| `noReasoningModels?` | `string[]` | Models that reject a reasoning/thinking param — the adapter drops `reasoning_effort` for them. |
| `noVisionModels?` | `string[]` | Text-only models — the [vision sidecar](/opencodex/guides/sidecars/) describes images for them. Matching tolerates an Ollama `:size` tag. |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic-compatible gateways such as Umans can require tool-name escaping on the wire; opencodex strips the prefix before returning tool calls to Codex. |

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
