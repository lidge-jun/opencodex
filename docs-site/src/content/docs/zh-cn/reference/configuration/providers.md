---
title: 提供方配置
description: 提供者条目、身份验证、端点、模型目录、配额、上下文上限以及提供者特定选项。
---

提供者用于告诉 opencodex 模型位于哪里、使用哪种线协议适配器，以及请求如何进行身份验证。

## 提供者相关顶级字段

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | 提供者名称到提供者配置的映射。 |
| `openaiProviderTierVersion?` | `2` | 由迁移设置 | 标记单一、可感知选项的 OpenAI 投影已完成。 |
| `disabledModels?` | `string[]` | — | 从 Codex 目录和 `/v1/models` 中隐藏，但不会阻止直接代理调用的模型。路由后的 id 会从列表中移除；裸原生 GPT id 会被设为 `visibility: "hide"`。 |
| `providerContextCaps?` | `Record<string, number>` | `{}` | 按提供者设置、对 Codex 可见的上下文上限。上限只会降低已知的上下文窗口。 |
| `contextCapValue?` | `number` | `350000` | 仪表板上下文上限控件使用的值；修改它会更新所有已启用的 `providerContextCaps` 条目。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | 由 Codex Auth 管理的 ChatGPT/Codex 池账户元数据。密钥单独存放在 `codex-accounts.json` 中。 |
| `pausedCodexAccountIds?` | `string[]` | `[]` | 在恢复之前从 Pool 选择中排除的账户，包括被暂停时的主 `__main__` 账户。 |
| `codexAccountNamespaces?` | `Record<string, string>` | — | 公共模型选择器命名空间到已存储 Codex 账户目标的映射。此项会校验并持久化映射，但不会自行添加选择器行或改变路由。 |
| `activeCodexAccountId?` | `string` | — | 为下一次请求手动选定的 Pool 账户。选择会清除线程亲和性；进行中的请求会保留捕获到的凭据。 |
| `autoSwitchThreshold?` | `number` | `80` | 基于用量的主动切换阈值。`quota` 可在下一次请求中重新评估已绑定和未绑定任务；`fill-first` 仅把它用作未绑定分配的耗尽点；正常 `round-robin` 不使用它。分数取已知 5 小时、周或 30 天 quota window 的最高值。`0` 只关闭基于用量的主动切换，不关闭未绑定任务分配或故障恢复。 |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新建/未绑定 Codex 请求的分配策略。没有 live `(parent thread id, quota scope)` affinity 的请求属于未绑定；代理重启或 affinity 重置后，已有可见任务也可能未绑定。`quota` 在没有活跃账号时选择已知 usage 最低的合格账号；活跃账号合格且低于 `autoSwitchThreshold` 时继续使用；达到阈值后，可把未绑定请求或已绑定任务的下一次请求切换到 usage 更低的合格账号。`round-robin` 均匀分配未绑定请求；`fill-first` 在 cooldown、不可用或耗尽阈值前持续分配给活跃账号。 |
| `accountPoolStickyLimit?` | `number` | `1` | 一次 round-robin 选择在推进前保留的新建/未绑定任务分配数。计数在任务绑定时增加，而不是在上游成功后增加。范围 1–100；仅当 `accountPoolStrategy` 为 `round-robin` 时生效。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 连续发生多少次瞬态故障后，后续新会话会切换到备用上游。设为 `0` 可禁用。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每个提供者 `/models` 缓存的新鲜度窗口。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic 提示缓存策略：禁用、5 分钟临时缓存，或 1 小时扩展缓存。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | 关闭 | 可选的主动 OAuth 刷新与 Codex 账户预热策略。 |

`codexAccountNamespaces` 的键是公共选择器：长度 1–64 个字符，以 ASCII 字母或数字开头和结尾，中间可包含字母、数字、`.`、`_` 或 `-`。会拒绝保留的 JavaScript 对象名称。每个值都必须是有效的池账户 id（永远不能是内部 `__main__`）或用于 Codex Desktop 账户的 `"@main"`。会对提供者名以及保留的 `openai` / `combo` 冲突进行不区分大小写的检查。请保持原始账户 id 和邮箱私密；选择器才是公开名称。

## 保留的 OpenAI 提供者

`openai` 和 `openai-apikey` 是固定的保留 id。`openai.codexAccountMode` 默认是 `"pool"`，会在主账户和新增账户之间选择；`"direct"` 只使用当前调用者/主登录态。API 只使用其配置的 API key 或 key 池。请使用裸模型名或 `openai-apikey/<model>`；不存在跨路由凭据回退。API 的 GPT-5.6 行携带 1,050,000 上下文 / 922,000 最大输入元数据，而 Pro 虚拟 id 会重写为基础线协议模型并带上 `reasoning.mode: "pro"`。

`openaiProviderTierVersion: 2` 标记当前的单提供者投影。对已发布的 v1 配置进行迁移之前，opencodex 会创建 `config.json.pre-openai-tiers-v2.bak`，且不会覆盖不同的备份文件，并会把已知的旧式命名空间选择 id 重写为裸 id。

## 提供者条目（`OcxProviderConfig`）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`azure-openai`（或别名 `azure`）之一。 |
| `baseUrl` | `string` | 上游 API 基础 URL。大多数内置固定端点会忽略不匹配的值；具备冲突安全键的预设会保留一个更早、同名的自定义目标。 |
| `responsesPath?` | `string` | 用于 key-auth `openai-responses` 请求的相对资源路径。必须以 `/` 开头，且不能包含 scheme、query 或 fragment。 |
| `disabled?` | `boolean` | 将提供者保留在磁盘上，但从路由和模型/目录列表中排除。 |
| `apiKey?` | `string` | API key，或在请求时解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key 头部样式。默认使用原生 `x-api-key`；仅对 key-auth `anthropic` 提供者有效。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多 key 池。`apiKey` 会镜像当前激活条目；每个条目都有 `id`、`key`、可选 `label`，以及可选的数值 `addedAt`。 |
| `defaultModel?` | `string` | 当选择该提供者但未显式指定模型时使用的模型。 |
| `models?` | `string[]` | 种子/回退模型列表。配合 `liveModels: false` 时，这些就是唯一发现到的模型。 |
| `liveModels?` | `boolean` | 启动/同步时获取实时目录（默认 `true`）。自定义提供者使用 `${baseUrl}/models`；内置项可能使用注册表 URL 并进行过滤。 |
| `selectedModels?` | `string[]` | 发现之后的目录允许列表。非空时只暴露这些 id；为空或省略时则暴露全部发现到的模型。 |
| `contextWindow?` | `number` | 该提供者范围内、对 Codex 可见的上下文上限。会保留更小的实时元数据。 |
| `modelContextWindows?` | `Record<string, number>` | 按模型设置的上下文上限。它们会覆盖 `contextWindow`，且绝不会抬高更小的实时元数据。 |
| `modelInputModalities?` | `Record<string, string[]>` | 按模型设置的输入提示，例如 `["text"]` 或 `["text", "image"]`。 |
| `modelMaxInputTokens?` | `Record<string, number>` | 正数型、按模型设置的最大输入限制，用于目录自动压缩提示。 |
| `defaultMaxOutputTokens?` | `number` | 当客户端省略 `max_output_tokens` 时，`openai-chat` 的提供者级回退值。 |
| `modelMaxOutputTokens?` | `Record<string, number>` | 正数型、按模型设置的 `openai-chat` 回退预算；精确/模式匹配优先于提供者默认值。 |
| `headers?` | `Record<string, string>` | 额外的上游请求头。会拒绝 Authorization、cookie、API key 头、嵌入换行符以及无效名称。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 默认的 OpenRouter `order`、`only` 和 `allowFallbacks` 偏好；仅对使用 `openai-chat` 的规范 OpenRouter 有效。 |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | 精确模型 id 级别的覆盖项，会替换提供者级 OpenRouter 偏好。 |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | 身份验证模式（默认 `key`）。OAuth/订阅凭据存放在 `config.json` 之外；`local` 仅限注册表条目允许它的提供者。 |
| `codexAccountMode?` | `"pool" \| "direct"` | 仅适用于规范的 `openai`；默认是 Pool。Direct 会绕过池状态。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 覆盖该 OAuth 提供者的 Token Guardian 策略。 |
| `reasoningEfforts?` | `string[]` | 要向外暴露并发送的、提供者级 Codex 推理标签。 |
| `modelReasoningEfforts?` | `Record<string, string[]>` | 按模型设置的标签。空列表会隐藏 effort 控件。 |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | 将某个模型设为 `false`，即可停止暴露摘要并移除摘要交付字段。 |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | 按模型设置的 Responses 交付枚举；会重写现有的 delivery 字段。 |
| `modelAdapters?` | `Record<string, string>` | 按模型设置的 `openai-chat` 或 `openai-responses` 线协议覆盖项，用于混合线协议网关。显式条目优先于注册表默认值；DeepSeek 预设可以为 `deepseek-v4-flash` 选择原生 Responses。单一线协议上游固定项和规范 ChatGPT forward 会拒绝覆盖。 |
| `reasoningEffortMap?` | `Record<string, string>` | 提供者级、用于推理标签的线协议别名。 |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | 按模型设置的推理标签线协议别名。 |
| `noReasoningModels?` | `string[]` | 会拒绝推理/思考参数的模型。 |
| `noTemperatureModels?` | `string[]` | 会拒绝调用方指定 `temperature` 的模型。 |
| `noTopPModels?` | `string[]` | 会拒绝调用方指定 `top_p` 的模型。 |
| `noPenaltyModels?` | `string[]` | 会拒绝 presence/frequency penalty 的模型。 |
| `parallelToolCalls?` | `boolean` | 切换并行工具调用。OpenAI Chat 默认开启；非 chat 适配器只有显式 `true` 时才会声明支持。 |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | 默认关闭的下游 SSE 修复，用于精确占位 id 和缺失的终止 id。function-call id 永远不会被重写。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` 只接受 `auto` 或 `none` 的模型；强制选择会被降级。 |
| `preserveReasoningContentModels?` | `string[]` | 需要在聊天历史中保留先前 assistant `reasoning_content` 的模型。 |
| `thinkingToggleModels?` | `string[]` | 使用 `thinking.enabled` 而不是 effort 阶梯的 chat 模型。 |
| `thinkingBudgetModels?` | `string[]` | 使用整数 `thinking_budget` 的 chat 模型；effort 会映射为预算比例。 |
| `noVisionModels?` | `string[]` | 经由视觉 sidecar 发送的纯文本模型；匹配时会容忍 Ollama 的 `:size` 标记。 |
| `escapeBuiltinToolNames?` | `boolean` | 为 Anthropic 兼容网关转义内置工具名，并在返回的调用中恢复。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google 传输/身份验证模式。默认 `ai-studio`。 |
| `project?` | `string` | Vertex 或 Antigravity Cloud Code Assist 项目 id。 |
| `location?` | `string` | Vertex 位置；环境变量回退为 `GOOGLE_CLOUD_LOCATION`。 |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | 仅 Cursor：stdio 或 Streamable HTTP MCP 服务器。 |
| `desktopExecutor?` | `DesktopExecutorConfig` | 仅 Cursor：外部 computer-use 和录屏命令。 |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor 旧布尔值；仅当更新字段未设置时，等同于 `nativeLocalExec: "on"`。 |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor 本地执行策略。`off` 是默认值；`codex-sandbox` 目前会像 `off` 一样失败关闭。 |

API key 提供者可以持有字面量 key，或环境引用。OAuth 提供者使用由 `ocx login` 填充的凭据存储；基于订阅的 Claude Code 启动行为在 [`claudeCode.authMode`](/reference/configuration/server/#claude-code) 下配置。

## 提供者诊断出站安全性

仪表板连接测试和实时模型发现使用受限的、仅 GET 传输。没有出站代理时，opencodex 只会解析一次主机名，并仅连接到该已验证地址。HTTPS 仍会保留原始 Host、SNI 和证书验证；提供者配置不能关闭证书检查。

当 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 生效时，这些操作会继续使用 Bun 的原生 fetch。URL 和字面量地址检查仍会执行，但最终路由、DNS 解析结果和对端由代理决定，因此 opencodex 无法固定或验证该对端。这是一个明确的安全限制。

私有/本地目标需要 `allowPrivateNetwork: true`，并且在出站代理启用时，还需要匹配的 `NO_PROXY` 条目。回环地址会自动加入；每个 LAN 主机都必须显式列出，因为 CIDR 条目不会被解释。匹配器支持精确主机、域后缀、可选端口、带方括号的 IPv6 以及 `*`；例如，应显式列出 `192.168.1.50`。元数据和链路本地目标仍会被阻止。诊断请求会拒绝重定向，并报告一个已剥离凭据的目标。普通提供者请求的重定向审查仍然独立于这个诊断保护。

## Codex 账户池

请在仪表盘 **Codex Auth** 页面添加 pool account 并刷新 quota。配置只保存非 secret account
metadata；access/refresh token 存放在加固的 Codex account credential store 中。Pool routing
分为新建/未绑定任务分配、基于用量的主动切换和故障恢复。已绑定任务通常保持 affinity，但 `quota`
可在超过阈值后的下一次请求中重新绑定；暂停、cooldown、重新认证和故障处理也能独立清除或改变
routing。未绑定请求没有 live 账号绑定，也可能是代理重启或 affinity 重置后的已有任务。输出前的
**429/402** 即使在关闭基于用量的主动切换时，也可在同一请求中对合格替代账号重试一次。
账号变化后会保留并重放对话上下文，但账号间的 provider prompt cache 不保证复用，可能需要重新预热。
暂停后仍会显示账号及其 quota metadata，但不会参与自动切换、重试/failover 选择、cooldown 恢复探测或手动激活。
暂停还会清除该账号的 thread affinity map：进行中的请求保留已捕获的 credential，但后续 turn 会重新路由，无法再使用已暂停账号。
暂停状态会跨重启保留；如果所有账号均已暂停，Pool 路由会明确失败，而不会暗中选择某个账号。
**暂停已达上限账号** 会先刷新有 credential 的合格账号，只暂停相关 quota window 本次明确返回 100% 的账号；无 credential、未知额度或刷新失败的账号保持不变。
遇到 **401/403** 时，App 登录会清除该账户的进程内 affinity 并要求重新认证。
遇到 **429** 时，它会遵循 `Retry-After`、启动账户 cooldown、清除 affinity，
并可将请求切换到另一个符合条件的 Pool 账户。即使 `autoSwitchThreshold: 0`，
这些故障恢复流程仍然有效；`0` 只会禁用基于用量的主动切换。

**分配与主动切换策略：** `quota`（默认）在没有活跃账号时选择 usage 最低的合格账号；活跃账号合格且低于 `autoSwitchThreshold` 时继续使用；达到阈值后，可把未绑定请求或已绑定任务的下一次请求切换到 usage 更低的合格账号。`round-robin` 均匀分配未绑定请求，用量
阈值不会改变正常轮换。`accountPoolStickyLimit`（默认 `1`，1–100）统计分配/绑定，而不是成功响应。
`fill-first` 在 cooldown、重新认证或耗尽阈值前把未绑定请求分配给活跃账号；健康的已绑定任务保持
affinity。这些策略不能规避 provider enforcement。

### `anthropicAccountPool`（实验性）

这个可选功能会池化已经存储在 `auth.json` 中的多个 Anthropic OAuth 账户。默认关闭，且尚未经过充分实战验证。同一组织内的账户可能共享配额，而自动轮换可能触发提供者限制。

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | 启用粘性亲和性和 429 冷却故障转移。 |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | 对于新会话，选择已知缓存的、5 小时使用率最低且达到或超过此阈值的账户。`0` 会禁用配额选择。 |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新会话策略；quota 只使用 5 小时条形数据。 |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | 在一次轮询选择中保留的成功新会话绑定次数。范围 1–100。 |

启用后，429 会根据 `Retry-After` 记录有界冷却，或者使用默认退避，并且可能在同一请求内轮换。亲和性是进程本地的，并且有大小上限。凭据 401/403 会将账户标记为需要重新认证。如果所有合格账户都在冷却，客户端会在已知时收到带 `Retry-After` 的 429，而不是身份验证错误。

:::caution[Experimental]
除非你理解 Anthropic 账户策略风险，否则请保持关闭。若不确定，优先手动使用 `ocx account use anthropic <id>` 切换。
:::

### 托管记录形状

`apiKeys[]` 条目包含 `id`、`name`、生成的 `key` 以及 ISO 格式的 `createdAt` 字符串。`codexAccounts[]` 条目要求有 `id`、`email` 和 `isMain`，并可选 `plan`、`chatgptAccountId` 和具备隐私安全性的 `logLabel`。这些记录通常由仪表板管理。

### `tokenGuardian`（`OcxTokenGuardianConfig`）

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | 全局主动刷新开关。 |
| `tickSeconds?` | `number` | `21600` | 扫描间隔（6 小时，最少 60 秒）。 |
| `jitterSeconds?` | `number` | `300` | 扫描前的随机延迟。 |
| `concurrency?` | `number` | `3` | 最大并发刷新数。 |
| `leadSeconds?` | `number` | `900` | 相较于一个 tick 的额外刷新提前量。 |
| `failureBackoffBaseSeconds?` | `number` | `300` | 初始瞬态故障退避时间。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` | 退避上限和永久故障延迟。 |
| `codexWarmupEnabled?` | `boolean` | `false` | 启用合成的 Codex 池账户验证。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 8 天后重新验证账户。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 用于可选预热的原生模型。 |

## 固定提供者端点

路由会先于适配器解析提供者端点。对于大多数内置项，注册表端点会覆盖所配置的 `baseUrl`。以下四类条目会保留所配置的 URL：

- 启用覆盖的提供者：`ollama`、`vllm`、`lm-studio`、`litellm`、`qwen-cloud` 和 `alibaba-token-plan-intl`；
- 由用户填写的注册表模板，例如 `azure-openai` 和 `cloudflare-ai-gateway`；
- 被提升的固定 API key 预设，并保留一个更早、同名的自定义目标；以及
- 不在注册表中的提供者。

适配器之后可以再调整解析后的 URL。例如，Kiro 会依据导入凭据的 API 区域，遵循规范的 `runtime.{region}.kiro.dev`。参见[适配器](/reference/adapters/)。

当路由丢弃 `baseUrl` 时，opencodex 会记录注册表端点以及仅有的已配置 origin；配置的路径本身也可能包含凭据。请移除未使用的 URL，或选择与预期区域相匹配的提供者条目。`alibaba-token-plan` 锁定在北京，而 `alibaba-token-plan-intl` 覆盖国际端点。

对于损坏的 `openai-responses` 网关，修复应放在提供者对象上：

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

占位列表必须精确匹配。对于正常/有状态的 Responses 提供者，请保持该字段未设置，以便转发能保持逐字节一致。

## Cursor 提供者（`adapter: "cursor"`）

Cursor 桥接是实验性的。执行 `ocx login cursor` 之后，添加或编辑 `providers.cursor`。Cursor Router 的优化层级会作为独立的 Codex id 暴露，因为选择器无法渲染 Cursor 特定的模型参数：

| Codex model | Cursor Router mode |
| --- | --- |
| `cursor/auto` | Team/account default |
| `cursor/auto-cost` | Cost |
| `cursor/auto-balance` | Balance |
| `cursor/auto-intelligence` | Intelligence |

显式变体会携带 Cursor 的 `default` 模型及其 `optimization` 参数，从而在每次请求中保留该选择。即使实时发现未返回 `default`，它们仍然可用。

Cursor 由服务端驱动的本地工具默认是禁用的。Codex 继续使用自己的工具，例如 `apply_patch` 和 `exec_command`，并沿用自己的审批与沙箱策略：

- `"off"`（默认）会拒绝执行 Cursor 原生的 `read`、`write`、`delete`、`ls`、`grep`、`shell` 和 `fetch`。
- `"on"` 会启用受信任的本地执行，并绕过 Codex 的审批/沙箱语义。
- `"codex-sandbox"` 为兼容性保留，但会像 `"off"` 一样失败关闭；请求文案并不是可信的沙箱证明。

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

请将该字段设置在 `providers.cursor` 上，而不是顶层。在仪表板中，使用 **Providers → Cursor → Edit JSON**，保存，然后重启。旧的 `unsafeAllowNativeLocalExec: true` 仅在未设置 `nativeLocalExec` 时，才等同于 `nativeLocalExec: "on"`。MCP、屏幕录制和 computer use 由 `mcpServers` 和 `desktopExecutor` 单独控制。

每个 `mcpServers.<name>` 都可以接受 `command`（stdio）或 `url`（Streamable HTTP）。stdio 还接受 `args`、`env` 和 `cwd`；HTTP 接受 `headers`。两者都支持 `enabled`（默认 true）和 `toolPrefix`。`desktopExecutor` 接受 `computerUseCommand`、`recordScreenCommand`、`cwd`、`env` 和 `timeoutMs`（默认 `30000`）。命令通过 `sh -c` 执行，从 stdin 读取一个 JSON 请求，并且必须向 stdout 写入一个 JSON 结果。

:::caution[Security]
默认的 loopback 绑定会让任何本地进程都能在没有认证的情况下接入，包括多用户主机上的其他用户。除非每个数据平面调用方都是受信任的，并且你明确接受绕过 Codex 的审批和沙箱语义，否则请保持本地执行关闭。
:::

## OpenRouter 提供者路由

OpenRouter 可以通过多个推理提供者来提供同一个模型。`openRouterRouting` 会让请求停留在偏好的提供者上；`modelOpenRouterRouting` 则会对精确模型 id 进行替换。对于提示缓存亲和性来说，这很有用，因为不同推理提供者的缓存支持、保留策略、命中率和定价都不同。

提供者名称使用 OpenRouter slug。`allowFallbacks: false` 会失败关闭；`true` 则允许在有序列表之后使用另一个合格提供者。`only` 永远是允许列表。

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

模型键必须是精确的原生 OpenRouter id，不带外层的 opencodex 提供者前缀。选择 `openrouter/anthropic-claude-sonnet-5` 会在应用模型规则之前，还原为原生 `anthropic/claude-sonnet-5`。

## 静态模型允许列表

将 `liveModels: false` 设为只暴露 `models`。如果 `models` 为空或省略，该提供者将不暴露任何路由模型。实时发现会在缓存前拒绝超过 4 MiB 或 2,000 条原始模型行；内置预设可能使用更低的限制，并过滤为可聊天的行。过大或格式错误的结果会走陈旧/配置回退。合法的、零可用结果的发现仍然具有权威性，不会被静默替换或截断。

当需要继续运行发现，但只有选定 id 应该出现在 Codex 和 `/v1/models` 中时，请使用 `selectedModels`。仪表板会保留完整的已发现列表，以便之后调整允许列表。

预览版 GPT-5.6 回退条目使用相同机制。OpenAI API key 预设会为基础和 Pro id 设定 `1050000` 上下文和 `922000` 最大输入；OpenRouter 会为 `openai/gpt-5.6-sol`、`openai/gpt-5.6-terra` 和 `openai/gpt-5.6-luna` 设定 `1050000` 上下文。Pool/Direct 会声明 `372000`；同步后的目录会声明 `max`，同时保留 `xhigh` 的独立性。

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
