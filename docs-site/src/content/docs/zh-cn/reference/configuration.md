---
title: 配置参考
description: ~/.opencodex/config.json 中的每一个字段 —— 顶层选项、providers 以及 sidecars。
---

opencodex 通过 `~/.opencodex/config.json` 进行配置。它由 `ocx init` 和仪表盘写入,但你也可以直接编辑它;代理会在启动时重新加载它。缺失或无效的文件会回退到默认配置(单个 `openai` forward provider)。

## 顶层(`OcxConfig`)

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 代理监听的端口。 |
| `providers` | `Record<string, OcxProviderConfig>` | — | provider 名称 → 配置的映射。 |
| `defaultProvider` | `string` | `"openai"` | 当路由找不到更优匹配时使用的 provider。 |
| `subagentModels?` | `string[]` | — | 最多 5 个 `provider/model` id,会在 Codex 的 subagent 选择器中优先展示。 |
| `disabledModels?` | `string[]` | — | 从 Codex 中隐藏的已路由 `provider/model` id(从目录和 `/v1/models` 中排除)。 |
| `websockets?` | `boolean` | `false` | 广告 `supports_websockets`，让 Codex 使用 Responses WebSocket 路径。省略或设为 `false` 会保持 HTTP/SSE。 |
| `syncResumeHistory?` | `boolean` | `false` | Codex App 历史兼容模式。启用后,opencodex 会备份原始 Codex thread metadata,把旧的 OpenAI interactive row remap 到 `opencodex`,并临时把 opencodex 创建的 `exec` row 提升为 App 可见的 source。`ocx stop` / `ocx restore` 会恢复已备份的 OpenAI row,并把剩余的 opencodex user thread eject 到 OpenAI,这样在 `config.toml` 中移除 proxy provider 后 native Codex 仍可 resume。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每个 provider 的 `/models` 缓存的有效期(5 分钟)。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 开启 | 网络搜索 sidecar 选项(见下文)。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 开启 | 视觉 sidecar 选项(见下文)。 |

如果旧的开发构建在备份支持出现之前已经运行过 `syncResumeHistory`,也可以显式运行
`ocx recover-history --legacy-openai` 执行同样的 native-provider 恢复。

## Providers(`OcxProviderConfig`)

| Field | Type | 含义 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`azure` 之一。 |
| `baseUrl` | `string` | 上游 API 的基础 URL。 |
| `apiKey?` | `string` | API key,或在请求时解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `defaultModel?` | `string` | 当选中该 provider 但未指定明确模型时使用的模型。 |
| `models?` | `string[]` | 种子/回退模型列表。当 `liveModels` 为 `false` 时,它也是 Codex 目录中精确暴露的 allowlist。 |
| `liveModels?` | `boolean` | 启动/同步时获取 provider 的实时 `/models` 目录(默认 `true`)。设为 `false` 时只使用配置的 `models`。 |
| `contextWindow?` | `number` | 路由 catalog 条目的 provider 级上下文窗口上限。实时 metadata 小于该值时会保留实时值。 |
| `modelContextWindows?` | `Record<string,number>` | 模型级上下文窗口上限。匹配模型时优先于 `contextWindow`,且不会抬高更小的实时 metadata。 |
| `modelInputModalities?` | `Record<string,string[]>` | 模型级 catalog 输入提示,例如 `["text"]` 或 `["text", "image"]`。 |
| `headers?` | `Record<string,string>` | 发送到上游的额外 HTTP 头。 |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 认证方式(默认 `key`)。见 [Providers](/opencodex/zh-cn/guides/providers/#auth-modes)。 |
| `noReasoningModels?` | `string[]` | 会拒绝 reasoning/thinking 参数的模型 —— adapter 会为它们丢弃 `reasoning_effort`。 |
| `noVisionModels?` | `string[]` | 纯文本模型 —— [视觉 sidecar](/opencodex/zh-cn/guides/sidecars/) 会为它们描述图像。匹配时可容忍 Ollama 的 `:size` 标签。 |
| `escapeBuiltinToolNames?` | `boolean` | Umans 等 Anthropic 兼容网关可能要求在 wire 上转义工具名；opencodex 会在把 tool call 返回给 Codex 前移除前缀。 |

## 静态模型 allowlist

有些 provider 的实时模型目录非常大或响应较慢。如果只希望 Codex 看到 `models` 中固定的模型,
可以将 `liveModels` 设为 `false`。

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

### `webSearchSidecar`(`OcxWebSearchSidecarConfig`)

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 当存在 forward provider + 登录时开启 | 总开关。 |
| `model?` | `string` | `gpt-5.4-mini` | 运行真实 `web_search` 的 sidecar 模型(必须是原生 ChatGPT 模型)。 |
| `reasoning?` | `string` | `low` | sidecar 的推理强度(在网络搜索时 `minimal` 会被拒绝)。 |
| `maxSearchesPerTurn?` | `number` | `3` | 每个主模型轮次的真实搜索总次数(循环保护)。 |
| `timeoutMs?` | `number` | `30000` | sidecar 的请求超时时间。 |

### `visionSidecar`(`OcxVisionSidecarConfig`)

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 当存在 forward provider + 登录时开启 | 总开关。 |
| `model?` | `string` | `gpt-5.4-mini` | 描述图像的视觉模型(必须接受图像输入)。 |
| `timeoutMs?` | `number` | `45000` | sidecar 的请求超时时间。 |

## 完整示例

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

:::tip[密钥]
建议为 key 使用 `${ENV_VAR}` 引用,这样 `config.json` 中就不会包含密钥。OAuth 和 forward provider 完全不存储任何 key。
:::

:::note[原子写入]
所有配置和目录文件（`config.toml`、`opencodex-catalog.json`）均通过 `atomicWriteFile`（临时文件 + 重命名）
进行原子写入。这可以防止并发写入者（例如 `ocx stop` 和 proxy 的自身关闭处理器同时恢复 Codex 时）产生
写了一半的文件。
:::
