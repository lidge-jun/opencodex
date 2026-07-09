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
| `disabledModels?` | `string[]` | — | 从 Codex 中隐藏的模型。已路由 `provider/model` id 会从目录和 `/v1/models` 中排除；bare 原生 GPT slug（如 `gpt-5.4`）的目录条目会翻转为 `visibility: "hide"`，并从 bare `/v1/models` 列表中移除。可在仪表盘 Models 页面按模型开关。 |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 三态 multi-agent surface override。`"v1"` 会强制所有模型使用 v1 surface（覆盖 upstream pins）；`"default"` 遵循 upstream model pins（sol/terra=v2,luna=v1）；`"v2"` 会强制所有模型使用 v2。可从仪表盘 Models 页面或 `ocx v2 mode` 设置。 |
| `hostname?` | `string` | `"127.0.0.1"` | 绑定地址。设为 `"0.0.0.0"` 可暴露到 LAN（需要 `OPENCODEX_API_AUTH_TOKEN`；见下文 [远程访问](#远程访问)）。 |
| `websockets?` | `boolean` | `false` | 广告 `supports_websockets`，让 Codex 使用 Responses WebSocket 路径。省略或设为 `false` 会保持 HTTP/SSE。 |
| `syncResumeHistory?` | `boolean` | `false` | Codex App 历史兼容模式。启用后,opencodex 会备份原始 Codex thread metadata,把旧的 OpenAI interactive row remap 到 `opencodex`,并临时把 opencodex 创建的 `exec` row 提升为 App 可见的 source。`ocx stop` / `ocx restore` 会恢复已备份的 OpenAI row,并把剩余的 opencodex user thread eject 到 OpenAI,这样在 `config.toml` 中移除 proxy provider 后 native Codex 仍可 resume。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每个 provider 的 `/models` 缓存的有效期(5 分钟)。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 开启 | 网络搜索 sidecar 选项(见下文)。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 开启 | 视觉 sidecar 选项(见下文)。 |

如果旧的开发构建在备份支持出现之前已经运行过 `syncResumeHistory`,也可以显式运行
`ocx recover-history --legacy-openai` 执行同样的 native-provider 恢复。

## 远程访问

默认情况下 opencodex 只绑定到 `127.0.0.1`（loopback）。当 `hostname` 设置为 `0.0.0.0`
等非 loopback 地址时,opencodex 会对管理 API（`/api/*`）和 data-plane（`/v1/responses`）
都强制启用 token 认证。

启动前设置 `OPENCODEX_API_AUTH_TOKEN`:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

非 loopback 绑定缺少该变量时,proxy 会拒绝启动。如果要为 LAN 访问安装后台服务,也需要先在同一个
shell 中 export 该变量,再运行 `ocx service install`,这样 launchd、systemd 或 Task Scheduler
才能收到 token。客户端必须在每个请求中通过 `x-opencodex-api-key` 头传入 token:

```
x-opencodex-api-key: your-secret-token
```

token 会用常量时间比较（`timingSafeEqual`）以避免 timing side-channel。

:::caution[LAN 暴露]
绑定到 `0.0.0.0` 会把 proxy 和已配置的 provider credential 暴露到本地网络。只应在可信网络中这样做,
并始终设置强 `OPENCODEX_API_AUTH_TOKEN`。
:::

## Providers(`OcxProviderConfig`)

| Field | Type | 含义 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`azure-openai` 之一。 |
| `baseUrl` | `string` | 上游 API 的基础 URL。 |
| `apiKey?` | `string` | API key,或在请求时解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `defaultModel?` | `string` | 当选中该 provider 但未指定明确模型时使用的模型。 |
| `models?` | `string[]` | 种子/回退模型列表。当 `liveModels` 为 `false` 时,它也是 Codex 目录中精确暴露的 allowlist。 |
| `liveModels?` | `boolean` | 启动/同步时获取 provider 的实时 `/models` 目录(默认 `true`)。设为 `false` 时只使用配置的 `models`。 |
| `contextWindow?` | `number` | 路由 catalog 条目的 provider 级上下文窗口上限。实时 metadata 小于该值时会保留实时值。 |
| `modelContextWindows?` | `Record<string,number>` | 模型级上下文窗口上限。匹配模型时优先于 `contextWindow`,且不会抬高更小的实时 metadata。 |
| `modelInputModalities?` | `Record<string,string[]>` | 模型级 catalog 输入提示,例如 `["text"]` 或 `["text", "image"]`。 |
| `reasoningEfforts?` | `string[]` | provider 级要广告的 Codex reasoning tier（`low`、`medium`、`high`、`xhigh`、`max`）。 |
| `modelReasoningEfforts?` | `Record<string,string[]>` | 模型级 reasoning tier override。空数组会隐藏该模型的 effort 控件。 |
| `reasoningEffortMap?` | `Record<string,string>` | 将 Codex tier 转成上游 wire 值的 provider 级 alias map。默认情况下 `xhigh` 与 `max` 是不同 tier。 |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | 模型级 reasoning alias map。 |
| `headers?` | `Record<string,string>` | 发送到上游的额外 HTTP 头。 |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 认证方式(默认 `key`)。见 [Providers](/opencodex/zh-cn/guides/providers/#auth-modes)。 |
| `noReasoningModels?` | `string[]` | 会拒绝 reasoning/thinking 参数的模型 —— adapter 会为它们丢弃 `reasoning_effort`。 |
| `noVisionModels?` | `string[]` | 纯文本模型 —— [视觉 sidecar](/opencodex/zh-cn/guides/sidecars/) 会为它们描述图像。匹配时可容忍 Ollama 的 `:size` 标签。 |
| `escapeBuiltinToolNames?` | `boolean` | Umans 等 Anthropic 兼容网关可能要求在 wire 上转义工具名；opencodex 会在把 tool call 返回给 Codex 前移除前缀。 |

## 静态模型 allowlist

有些 provider 的实时模型目录非常大或响应较慢。如果只希望 Codex 看到 `models` 中固定的模型,
可以将 `liveModels` 设为 `false`。

当 `liveModels` 为 `false` 且 `models` 为空或省略时,opencodex 不会为该 provider 暴露 routed model。

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

## GPT-5.6 seed/fallback 模型

内置 **OpenAI (API key)** provider 使用 OpenAI Responses API(`https://api.openai.com/v1`),并在
fallback 模型列表中包含 `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。OpenRouter
会以 `openai/gpt-5.6-sol`、`openai/gpt-5.6-terra`、`openai/gpt-5.6-luna` 名称 seed 同一组
preview 模型。三款 GPT-5.6 模型的 `modelContextWindows` 值均为 `372000`,且 `max` reasoning tier
会与 `xhigh` 分开保留。

这些值是 rollout 准备 metadata。实际调用只有在连接的 OpenAI API key、OpenRouter 账号或原生
ChatGPT/Codex 账号拥有 GPT-5.6 preview 权限时才会成功。

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
