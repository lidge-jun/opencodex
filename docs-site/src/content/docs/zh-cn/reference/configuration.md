---
title: 配置参考
description: ~/.opencodex/config.json 的所有字段 —— 顶层选项、provider 与 sidecar。
---

opencodex 使用 `~/.opencodex/config.json` 配置。`ocx init` 和仪表盘会写入该文件，你也可以直接
编辑；代理会在启动时重新加载。如果文件无法解析（例如被截断或不是有效 JSON），opencodex 会将
其备份为 `config.json.invalid-<timestamp>`，在 console 中警告，再以默认值启动。文件缺失时也会
回退到默认配置（单个 `openai` forward provider）。

## 保留的 OpenAI providers

`openai` 和 `openai-apikey` 是固定保留 id。`openai.codexAccountMode` 默认为 `"pool"`，会在主账户和
添加账户中选择；`"direct"` 只使用当前 Codex caller/主登录。API 只使用配置的 API key/key pool。
通过 bare 模型或 `openai-apikey/<model>` 选择，凭证路径间没有 fallback。API GPT-5.6 元数据为
1,050,000 context / 922,000 max input，Pro virtual id 在线上
改写为 base 模型加 `reasoning.mode: "pro"`。

`openaiProviderTierVersion: 2` 标记当前单一 provider projection。迁移 shipped v1 配置之前，会以
no-replace 方式创建 `config.json.pre-openai-tiers-v2.bak`，并把已知旧 namespaced selected id 改为 bare id。

## 顶层（`OcxConfig`）

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 代理监听端口。 |
| `hostname?` | `string` | `"127.0.0.1"` | 绑定地址。设为 `"0.0.0.0"` 可暴露到 LAN（需要 `OPENCODEX_API_AUTH_TOKEN`；见下文 [远程访问](#远程访问)）。 |
| `proxy?` | `string` | — | 出站 HTTP(S) proxy URL 或 `${ENV_VAR}` 引用。对应 env 未设置时应用到 `HTTP_PROXY` / `HTTPS_PROXY`；loopback 会保留在 `NO_PROXY` 中。 |
| `providers` | `Record<string, OcxProviderConfig>` | — | provider 名称 → 配置的映射。 |
| `openaiProviderTierVersion?` | `2` | migration 设置 | 单一选项式 OpenAI projection 完成标记。 |
| `defaultProvider` | `string` | `"openai"` | 路由找不到更优匹配时使用的 provider。 |
| `subagentModels?` | `string[]` | `gpt-5.5`、三款 GPT-5.6、`gpt-5.4-mini` | 最多 5 个原生 slug 或 `provider/model` id，优先显示在 Codex subagent picker 中。v2 指引清单是已配置模型与 Codex 中 picker 可见、兼容 v2、按 priority 排序后前五项的交集，并使用规范目录 slug 与可用 effort 档位；被排除的条目仍保留在配置中。显式空数组会被保留。 |
| `injectionModel?` | `string` | — | 注入 multi-agent 指南（v2 界面）的首选原生或路由模型；委派指南会要求把该模型连同 `fork_turns: "none"` 一起传给 `spawn_agent`。 |
| `injectionEffort?` | `string` | — | 首选 `spawn_agent` reasoning effort（`low` 到 `ultra`）。只有与 `injectionModel` 一起使用才有意义。 |
| `effortCap?` | `string` | — | reasoning effort 的逐请求硬上限。这是多代理 V2 专属功能：适用于工具列表带有 V2 协作表面的主轮次，以及标记精确匹配 `x-openai-subagent: collab_spawn` 或 `x-codex-turn-metadata` 中 `"subagent_kind": "thread_spawn"` 的派生子轮次（带标记的子轮次无论自身工具表面如何都会被覆盖）。普通主轮次与 V1 表面主轮次不受影响，压缩（compaction）轮次始终绕过上限，`multiAgentMode: "v1"` 会完全禁用上限功能（仪表盘同时隐藏该面板）。接受 `low` 到 `ultra`；只会降低 effort，绝不会提高。会降至不高于上限的最高受支持档位。若模型不提供 effort 控制，或上限之下没有可用档位，则移除 effort 字段并采用 provider 默认值。`max` 和 `ultra` 均可使用，但不会形成更低的等级上限（客户端会将 `ultra` 转换为 `max`，因此请求以 `low` 到 `max` 的范围到达）；不过，已知的模型 effort 阶梯仍可能触发降档或移除字段。仪表盘选择器提供 `low` 到 `xhigh`。通过 `GET /api/effort-caps` 和 `PUT /api/effort-caps` 管理。 |
| `subagentEffortCap?` | `string` | — | 同样的硬上限，但只用于 codex-rs 标记精确匹配的派生子轮次：`x-openai-subagent: collab_spawn`，或 `x-codex-turn-metadata` 中的 `"subagent_kind": "thread_spawn"`。其他内部子代理类别（评审、压缩、记忆整理）不会触发此上限，`multiAgentMode: "v1"` 会完全禁用该功能。接受 `low` 到 `ultra`；两个上限同时设置时取较低者，且只会降低 effort，绝不会提高。会降至不高于上限的最高受支持档位。若模型不提供 effort 控制，或上限之下没有可用档位，则移除 effort 字段并采用 provider 默认值。`max` 和 `ultra` 均可使用，但不会形成更低的等级上限（客户端会将 `ultra` 转换为 `max`，因此请求以 `low` 到 `max` 的范围到达）；不过，已知的模型 effort 阶梯仍可能触发降档或移除字段。仪表盘选择器提供 `low` 到 `xhigh`。通过 `GET /api/effort-caps` 和 `PUT /api/effort-caps` 管理。 |
| `injectionPrompt?` | `string` | — | 整体替换注入的 v2 指南正文的自定义文本。`{{model}}`、`{{effort}}`、`{{roster}}` 占位符会被替换，触发条件保持不变。也可通过 `PUT /api/injection-model` 的 `prompt` 键设置。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 仅控制由 OpenCodex 添加的 multi-agent developer 指引。未设置/`true` 保持 v1/v2 指引；`false` 会同时禁止两者，但不改变协作界面、`subagentModels`、路由或 effort 上限。`GET/PUT /api/injection-model` 返回有效值，PUT 为部分更新。 |
| `disabledModels?` | `string[]` | — | 从 Codex 隐藏的模型。路由 `provider/model` id 会从目录和 `/v1/models` 排除；bare 原生 GPT slug（如 `gpt-5.4`）的目录条目会改成 `visibility: "hide"`，并从 bare `/v1/models` 列表移除。可在仪表盘 Models 页面按模型切换。 |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 三态 multi-agent surface override。`"v1"` 覆盖 upstream pin，强制全部模型使用 v1；`"default"` 遵循 upstream model pin（sol/terra=v2，luna=v1）；`"v2"` 强制全部模型使用 v2。可在仪表盘 Models 页面或 `ocx v2 mode` 中设置。 |
| `providerContextCaps?` | `Record<string,number>` | `{}` | provider 级 Codex 可见 context cap。只会降低已知 context window。 |
| `contextCapValue?` | `number` | `350000` | 仪表盘 context-cap 控件使用的值；修改后会更新 `providerContextCaps` 中所有已启用条目。 |
| `stallTimeoutSec?` | `number` | `300` | 上游无数据后 bridge 中止并发出 `response.incomplete` 前等待的秒数。最小值 1。 |
| `connectTimeoutMs?` | `number` | `200000` | 每次尝试仅等待 DNS/TCP/TLS 和最终响应 header 的 deadline；在响应 body 生成前结束。 |
| `shutdownTimeoutMs?` | `number` | `5000` | 中止活跃 turn 前的 graceful drain deadline。 |
| `websockets?` | `boolean` | `false` | 公布 `supports_websockets`，让 Codex 使用 Responses WebSocket 路径。省略或设为 `false` 会保持 HTTP/SSE。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 非 loopback 绑定下，management 和 data-plane 认证额外接受的生成式 `ocx_…` credential。由仪表盘管理；条目字段见下文。 |
| `codexAutoStart?` | `boolean` | `true` | 允许 Codex shim 在启动 Codex 前运行 `ocx ensure`。`false` 会让 `ocx ensure` 不执行任何操作。 |
| `syncResumeHistory?` | `boolean` | `true` | 可逆的 Codex App 历史兼容模式。opencodex 会备份原始 Codex thread metadata，把旧 OpenAI interactive row 重映射到 `opencodex`，并暂时把 opencodex 创建的 `exec` row 提升成 App 可见 source。`ocx stop` / `ocx restore` 会恢复已备份的 OpenAI row，并把剩余 opencodex user thread 转回 OpenAI，使原生 Codex 在从 `config.toml` 移除代理后仍能继续这些 thread。设为 `false` 可退出该模式。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth 仪表盘管理的 ChatGPT/Codex pool account metadata。secret 单独存放在 `codex-accounts.json`。 |
| `activeCodexAccountId?` | `string` | — | 下一个新 Codex thread 使用的 pool account。已有 thread affinity 继续保留原账号。 |
| `autoSwitchThreshold?` | `number` | `80` | 新 session 自动切换的 usage 百分比 threshold。分数取已知 5 小时、周或 30 天 quota window 中最高的一项。设为 `0` 可禁用 quota 自动切换。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 连续发生多少次临时上游失败后，让后续新 session failover 到其他合格 pool account。设为 `0` 可禁用失败切换。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每个 provider 的 `/models` 缓存新鲜度窗口（5 分钟）。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache 策略：禁用、5 分钟 ephemeral 或 1 小时 extended。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 开启 | 网络搜索 sidecar 选项（见下文）。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 开启 | 视觉 sidecar 选项（见下文）。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | 关闭 | 可选的 proactive OAuth 刷新和 Codex account warmup 策略；字段见下文。 |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS 额外允许的精确 origin。loopback origin 始终允许。 |

`maxConcurrentThreadsPerSession` 是 `PUT /api/v2` 使用的 camel-case 字段，不是 `config.json` key。
`ocx v2 threads <n>` 会把对应的 `max_concurrent_threads_per_session` 值写入 Codex
`$CODEX_HOME/config.toml` 的 `[features.multi_agent_v2]` 下；请先启用 v2，确保该 table 存在。

如果旧开发构建在支持备份前已运行 `syncResumeHistory`，也可用
`ocx recover-history --legacy-openai` 强制执行相同的 native-provider 恢复。

:::note[Codex 账号池]
请在仪表盘 **Codex Auth** 页面添加 pool account 并刷新 quota。配置只保存非 secret account
metadata；access/refresh token 存放在加固的 Codex account credential store 中。已有 thread id 会
保留 account affinity，新 session 可按 quota、cooldown 和 health 自动路由。
:::

### 受管 record 形状

`apiKeys[]` 条目包含 `id: string`、`name: string`、生成的 `key: string` 和 ISO 格式的
`createdAt: string`。`codexAccounts[]` 条目包含必需的 `id`、`email`、`isMain`，以及可选的
`plan`、`chatgptAccountId` 和不含隐私的 `logLabel` 字符串。这些 record 通常由仪表盘管理。

### `tokenGuardian`（`OcxTokenGuardianConfig`）

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | proactive refresh 总开关。 |
| `tickSeconds?` | `number` | `21600` | sweep 间隔（6 小时，最少 60 秒）。 |
| `jitterSeconds?` | `number` | `300` | sweep 前增加的随机延迟。 |
| `concurrency?` | `number` | `3` | 每次 sweep 最多同时刷新多少项。 |
| `leadSeconds?` | `number` | `900` | 在一个 tick 之外额外预留的刷新提前量。 |
| `failureBackoffBaseSeconds?` | `number` | `300` | 首次临时失败 backoff。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` | backoff 上限和永久失败延迟。 |
| `codexWarmupEnabled?` | `boolean` | `false` | 选择启用合成 Codex pool-account 验证。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 账号在 8 天后重新验证。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 可选 warmup 使用的原生模型。 |

## 远程访问

opencodex 默认只绑定到 `127.0.0.1`（loopback）。当 `hostname` 设置为 `0.0.0.0` 等非 loopback
地址时，management API（`/api/*`）和 data plane（`/v1/responses`）都会强制 token 认证。

启动前设置 `OPENCODEX_API_AUTH_TOKEN`：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

非 loopback 绑定缺少该变量时，代理会拒绝启动。若要为 LAN 访问安装后台服务，也应先 export
同一变量，再运行 `ocx service install`，让 launchd、systemd 或 Task Scheduler 收到 token。
客户端必须在每个请求的 `x-opencodex-api-key` header 中提供 token：

```
x-opencodex-api-key: your-secret-token
```

也可以使用 `Authorization: Bearer …` header。启动后，仪表盘生成的 `apiKeys` 可代替环境 token。
所有候选值均用常量时间（`timingSafeEqual`）比较，避免 timing side-channel。

:::caution[LAN 暴露]
绑定到 `0.0.0.0` 会把代理和所有已配置 provider credential 暴露到本地网络。只应在可信网络中
使用，并始终设置强 `OPENCODEX_API_AUTH_TOKEN`。
:::

## Providers（`OcxProviderConfig`）

| Field | Type | 含义 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`azure-openai`（或别名 `azure`）之一。 |
| `baseUrl` | `string` | 上游 API base URL。 |
| `responsesPath?` | `string` | `key` 认证的 `openai-responses` 请求可选相对 resource path。必须以 `/` 开头，且不得包含 URL scheme、query 或 fragment。省略时保留原有的 `/v1/responses` URL 构造。 |
| `disabled?` | `boolean` | 配置保留在磁盘上，但从路由和模型/目录列表排除。 |
| `apiKey?` | `string` | API key，或在请求时解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多 key pool。`apiKey` 映射当前活动条目；每项包含 `id`、`key`、可选 `label` 和可选数字 `addedAt`。 |
| `defaultModel?` | `string` | 选中该 provider 但未指定明确模型时使用的模型。 |
| `models?` | `string[]` | seed/fallback 模型列表。`liveModels` 为 `false` 时，只会发现这些模型。 |
| `liveModels?` | `boolean` | 启动/同步时获取 provider 的实时 `/models` 目录（默认 `true`）。设为 `false` 时只使用配置的 `models`。 |
| `selectedModels?` | `string[]` | 模型发现后应用的目录 allowlist。非空时只向 Codex 暴露这些 id；为空或省略时暴露所有发现的模型。 |
| `contextWindow?` | `number` | 路由目录条目的 provider 级 Codex 可见 context-window cap。实时 metadata 更小时保留实时值。 |
| `modelContextWindows?` | `Record<string,number>` | 模型级 context-window cap。匹配模型时优先于 `contextWindow`，且不会抬高更小的实时 metadata。 |
| `modelInputModalities?` | `Record<string,string[]>` | 模型级目录 input hint，如 `["text"]` 或 `["text", "image"]`。 |
| `headers?` | `Record<string,string>` | 额外上游 header。Authorization、cookie、API-key header、包含换行的值和无效 header 名称会被拒绝。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 默认 OpenRouter provider 路由设置。支持 `order`、`only` 和 `allowFallbacks`；仅适用于 canonical OpenRouter URL 和 `openai-chat` adapter。 |
| `modelOpenRouterRouting?` | `Record<string,OpenRouterProviderRouting>` | 按精确模型 id 覆盖 `openRouterRouting`。 |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 认证方式（默认 `key`）。参见 [Providers](/opencodex/zh-cn/guides/providers/#认证模式)。 |
| `codexAccountMode?` | `"pool" \| "direct"` | 仅用于 canonical `openai`。省略时默认 Pool；Direct 会绕过池状态。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 覆盖该 OAuth provider 的 Token Guardian 策略。 |
| `reasoningEfforts?` | `string[]` | provider 级需要公布和发送的 Codex reasoning label（`low`、`medium`、`high`、`xhigh`、`max`、`ultra`）。 |
| `modelReasoningEfforts?` | `Record<string,string[]>` | 模型级 reasoning label。空数组会隐藏该模型的 effort 控件。 |
| `reasoningEffortMap?` | `Record<string,string>` | provider 级 reasoning label wire alias。只在上游需要不同值时使用。 |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | 模型级 reasoning label wire alias。 |
| `noReasoningModels?` | `string[]` | 拒绝 reasoning/thinking 参数的模型；adapter 会为它们移除 `reasoning_effort`。 |
| `noTemperatureModels?` | `string[]` | 拒绝调用方指定 `temperature` 的模型。 |
| `noTopPModels?` | `string[]` | 拒绝调用方指定 `top_p` 的模型。 |
| `noPenaltyModels?` | `string[]` | 拒绝 presence/frequency penalty 的模型。 |
| `parallelToolCalls?` | `boolean` | 启用或禁用并行工具调用。OpenAI Chat 默认开启；非 chat adapter 只有显式为 `true` 时才公布支持。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` 只接受 `auto` 或 `none` 的模型；forced/named 选择会降级。 |
| `preserveReasoningContentModels?` | `string[]` | 要求在 chat history 中保留先前 assistant `reasoning_content` 的模型。 |
| `thinkingToggleModels?` | `string[]` | 使用 vendor `thinking.enabled` toggle，而不是 effort ladder 的 chat 模型。 |
| `thinkingBudgetModels?` | `string[]` | 使用整数 `thinking_budget` 的 chat 模型；effort 会映射成 budget 比例。 |
| `noVisionModels?` | `string[]` | 纯文本模型；[视觉 sidecar](/opencodex/zh-cn/guides/sidecars/) 会为它们描述图像。匹配时容忍 Ollama `:size` 标签。 |
| `escapeBuiltinToolNames?` | `boolean` | Umans 等 Anthropic 兼容 gateway 可能要求在 wire 上转义工具名；opencodex 会在把 tool call 返回 Codex 前移除 prefix。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transport/auth mode。默认 `ai-studio`。 |
| `project?` | `string` | Vertex project id 或 Antigravity Cloud Code Assist project id。 |
| `location?` | `string` | Vertex location；env fallback 为 `GOOGLE_CLOUD_LOCATION`。 |
| `mcpServers?` | `Record<string,CursorMcpServerConfig>` | **仅 Cursor。** 通过 stdio 启动或 Streamable HTTP 连接的 MCP server；字段见下文。 |
| `desktopExecutor?` | `DesktopExecutorConfig` | **仅 Cursor。** 外部 computer-use/record-screen 命令；字段见下文。 |
| `unsafeAllowNativeLocalExec?` | `boolean` | **仅 Cursor adapter。** 允许 Cursor server 驱动本地 `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` 的 opt-in escape hatch。默认 `false`，防止远程 Cursor message 绕过 Codex 审批与 sandbox。见下文 [Cursor provider](#cursor-provideradapter-cursor)。 |

## Cursor provider（`adapter: "cursor"`）

Cursor bridge 仍属实验功能。运行 `ocx login cursor` 后，在
`~/.opencodex/config.json`（Windows：`%USERPROFILE%\.opencodex\config.json`）的 `providers` 下
添加或编辑 `cursor` 条目。

Cursor server 驱动的原生本地工具默认保持**禁用**。Codex 继续按自身审批和 sandbox policy 使用
`apply_patch`、`exec_command` 等工具。只有在可信本地实验中，且你接受 Cursor 绕过 Codex 审批
读取、写入、删除、列出、grep、shell 或 fetch 本机内容时，才设置
`unsafeAllowNativeLocalExec`。

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

该 flag 应放在 **provider 对象**（`providers.cursor`）上，而不是 `config.json` 顶层。

也可在 [Web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/) 中设置：进入 **Providers → Cursor →
Edit JSON**，添加 `"unsafeAllowNativeLocalExec": true`，保存后重启代理
（`ocx restart` 或 `ocx stop` + `ocx start`）。

MCP、屏幕录制和 computer-use 使用独立的 `mcpServers` / `desktopExecutor` 配置，不受该 flag 控制。

### Cursor 集成 record

每个 `mcpServers.<name>` 值接受 `command`（stdio）或 `url`（Streamable HTTP）之一。stdio 条目还
接受 `args?: string[]`、`env?: Record<string,string>`、`cwd?: string`；HTTP 条目接受
`headers?: Record<string,string>`。两种形式都支持 `enabled?: boolean`（默认 true）和
`toolPrefix?: string`。

`desktopExecutor` 接受 `computerUseCommand?`、`recordScreenCommand?`、`cwd?`、
`env?: Record<string,string>` 和 `timeoutMs?`（默认 `30000`）。命令经 `sh -c` 运行，从 stdin
读取一个 JSON 请求，并必须向 stdout 写出一个 JSON 结果。

:::caution[安全]
除非你明确需要绕过 Codex 审批与 sandbox 语义的 Cursor 原生本地执行，否则请省略
`unsafeAllowNativeLocalExec` 或保持为 `false`。
:::

## OpenRouter provider 路由

同一模型的不同 OpenRouter endpoint 在 prompt cache 支持、命中率、保留时间和价格方面可能存在显著差异。
使用 `openRouterRouting` 指定默认 provider，使用 `modelOpenRouterRouting` 为精确模型 id 覆盖设置。
这些设置会转换为 OpenRouter 请求中的 `order`、`only` 和 `allow_fallbacks` 字段。
当 `allowFallbacks: false` 时，指定 provider 不可用会使请求失败，而不会切换到其他 endpoint。

```json
{
  "openRouterRouting": { "order": ["deepseek"], "allowFallbacks": false },
  "modelOpenRouterRouting": {
    "anthropic/claude-sonnet-5": { "only": ["anthropic"], "allowFallbacks": false }
  }
}
```

## 静态模型 allowlist

部分 provider 的实时模型目录非常大或很慢。若只想让 Codex 看到 `models` 中固定的模型，请把
`liveModels` 设为 `false`。

当 `liveModels` 为 `false` 且 `models` 为空或省略时，opencodex 不会为该 provider 暴露任何
路由模型。

`selectedModels` 的用途不同：模型发现仍会运行，但只有选中的 id 会发布到 Codex 目录和
`/v1/models`。仪表盘仍保留完整模型列表，因此之后可以修改 allowlist。

Preview GPT-5.6 fallback 条目采用相同机制。OpenAI API-key preset 会以 context `1050000`、
max input `922000` seed base 和 Pro id；OpenRouter preset 会以 context `1050000` seed
`openai/gpt-5.6-sol`、`terra`、`luna`。Pool/Direct 的 Codex 目录契约为 `372000`；同步后的
Codex 目录会公布 `max` reasoning，同时与 `xhigh` 保持
区分。保持 `liveModels` 开启可把实时 provider 结果与这些显式条目合并；设为 `false` 则只暴露
`models`。

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

### `webSearchSidecar`（`OcxWebSearchSidecarConfig`）

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 所选后端可用时开启 | 总开关。设为 `false` 可禁用 Web Search sidecar。 |
| `backend?` | `"openai" \| "anthropic"` | 自动 | 执行后端。显式配置优先；省略时，有可用的 Anthropic OAuth 活动账户则选 `anthropic`，否则选 `openai`。 |
| `model?` | `string` | 因后端而异 | 搜索模型：`openai` 默认 `gpt-5.6-luna`，`anthropic` 默认 `claude-sonnet-5`。显式保留的旧 `gpt-5.4-mini` 值会在启动时迁移。 |
| `reasoning?` | `string` | `low` | sidecar reasoning effort（网络搜索会拒绝 `minimal`）。 |
| `maxSearchesPerTurn?` | `number` | `3` | 每个主模型 turn 的真实搜索总次数（loop guard）。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 仅可在配置文件中设置的路由模型迭代原始响应 byte 连续无活动 deadline。必须是 `1` 到 `2147483647` 的整数；每个非空响应 body chunk 都会重置该计时器。 |
| `timeoutMs?` | `number` | `200000` | 单次托管 web-search 请求的独立 deadline。 |

`openai` 后端通过已启用的 ChatGPT `forward` provider 执行托管搜索，因此同时需要 ChatGPT 登录
和该 provider。Claude 入站的路由重放会把主 ChatGPT 认证注入内部 sidecar 请求，使该路径仍可
访问。`anthropic` 后端使用已启用 Anthropic OAuth provider 的活动存储凭据，并运行 Claude 的
`web_search_20250305` 工具。若显式设置 `backend: "anthropic"`，但没有可用活动账户（包括
`needsReauth` 状态），sidecar 会关闭失败，而不会回退到 OpenAI。

Web-search 路径有四个时钟：基础 bridge event-stall 预算（`stallTimeoutSec`）、DNS/TCP/TLS/最终
header 预算（`connectTimeoutMs`）、路由模型原始 byte 无活动期限
（`routedModelStallTimeoutMs`），以及单次托管搜索期限（`timeoutMs`）。实际 bridge watchdog 为
`max(基础 stall, connect timeout, 路由模型 stall, sidecar timeout) + 30 秒`。路由模型 stall 是
无活动保护，并非总生成 timeout。

### `visionSidecar`（`OcxVisionSidecarConfig`）

| Field | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 所选后端可用时开启 | 总开关。设为 `false` 可禁用图像描述。 |
| `backend?` | `"openai" \| "anthropic"` | 自动 | 执行后端。使用与 Web Search 相同的显式优先、Anthropic 凭据感知解析规则。 |
| `model?` | `string` | 因后端而异 | 图像描述模型：`openai` 默认 `gpt-5.4-mini`，`anthropic` 默认 `claude-sonnet-5`。 |
| `maxDescriptionsPerTurn?` | `number` | `8` | 一个主模型 turn 中允许新增的描述缓存 miss 数。`0` 禁用描述调用；无效值使用默认值。 |
| `timeoutMs?` | `number` | `45000` | sidecar fetch timeout。 |

Vision sidecar 仅在图像发送给 provider 的 `noVisionModels` 列表所匹配模型时启用。OpenAI 后端与
Web Search 一样，需要 ChatGPT 登录和 forward provider；Anthropic 后端使用已存储 OAuth，显式
选择但没有可用凭据时会关闭失败。成功的 `data:` 图像描述会存入有界进程级缓存，缓存键包含后端、
模型、detail、图像字节和规范化消息上下文。缓存命中和同一 turn 的重复请求不会消耗
`maxDescriptionsPerTurn`。远程 `https:` 图像以及失败或空的描述不会缓存。

Anthropic OAuth 搜索和图像描述请求沿用 opencodex 已有的 Claude Code OAuth fingerprint。它处于
仓库既有 OAuth 先例范围内，但仍应使用目标账户和实际负载进行充分 soak test。

<!-- TODO(WP5 GUI): GUI 控件完成后补充 sidecar 设置页面操作说明。 -->

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
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  },
  "visionSidecar": { "enabled": true }
}
```

:::tip[密钥]
建议为 key 使用 `${ENV_VAR}` 引用，避免 `config.json` 包含 secret。OAuth 和 forward provider
完全不存储 key。
:::

:::note[原子写入]
所有配置和目录文件（`config.toml`、`opencodex-catalog.json`）都会经 `atomicWriteFile`（临时文件 +
重命名）原子写入。这样即使多个 writer（例如 `ocx stop` 与代理自身的 shutdown handler）同时
恢复 Codex，也不会留下只写了一半的文件。
:::
