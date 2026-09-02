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
| `disabledModels?` | `string[]` | — | 从 Codex catalog 和 `/v1/models` 中隐藏、但不阻止直接 proxy 调用的 model。routed id 会从列表中移除。account-qualified native id 只隐藏对应 selector row；bare native GPT id 会隐藏 bare row 以及该 model 的所有 account-selector row。Models 页面只显示裸原生行和路由行；若只隐藏一个 selector-qualified 行，请直接设置此配置字段。 |
| `providerContextCaps?` | `Record<string, number>` | `{}` | 按提供者设置、对 Codex 可见的上下文上限。上限只会降低已知的上下文窗口。 |
| `contextCapValue?` | `number` | `350000` | 仪表板上下文上限控件使用的默认值。仅当勾选“应用到所有已路由的提供方”时，修改它才会把值应用到所有已路由提供方（包括没有现有 `providerContextCaps` 条目的提供方）；否则每个提供方保留自己的上限。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | 由 Codex Auth 管理的 ChatGPT/Codex 池账户元数据。密钥单独存放在 `codex-accounts.json` 中。 |
| `pausedCodexAccountIds?` | `string[]` | `[]` | 在恢复之前从 Pool 选择中排除的账户，包括被暂停时的主 `__main__` 账户。 |
| `codexAccountNamespaces?` | `Record<string, string>` | — | 将任意公开 model selector 映射到已保存 Codex account target 的可选配置。启用账户限定的选择器行后，target 存在的每个 selector 都会在 Codex picker 中添加独立的 `<selector>/<native-openai-model>` row，且每个 row 只使用对应账户。只要有 selector 生效，bare native row 就会在 picker 中隐藏；但除非显式禁用，其 id 仍可路由，并继续列在 raw `/v1/models` 中。 |
| `codexAccountPickerEnabled?` | `boolean` | 映射为空时关闭 | 控制是否根据有效的 `codexAccountNamespaces` 映射生成账户限定的 Codex 选择器行。`true` 允许显示映射行。在非空映射中省略此字段时，为保持向后兼容会视为已启用；映射为空时则关闭。`false` 会隐藏生成行并恢复选择器中的裸原生行，但不会删除映射，也不会禁用精确的 `<selector>/<native-openai-model>` 路由。 |
| `activeCodexAccountId?` | `string` | — | 为下一次请求手动选定的 Pool 账户。选择会清除线程亲和性；进行中的请求会保留捕获到的凭据。 |
| `codexAccountPriorities?` | `Record<string,number>` | — | Codex pool 各账号的选择顺序：账号 ID → `-100` 到 `100` 的整数，**数值越大越先使用**，未设置即为 `0`。这是顺序边界而非资格边界：选择会把已经合格的账号收窄到仍有 quota 余量的最高 tier，再由 `accountPoolStrategy` 在该 tier 内挑选。只有当某个 tier 的所有成员都超过 `autoSwitchThreshold`、处于 cooldown、被 soft-avoid、已暂停或需要重新认证时，该 tier 才会被跳过；usage 未知不会让 tier 耗尽。顺序不会让不合格的账号变得可选，也不会重新绑定已经绑定账号的 thread。主账号 `__main__` 同样参与排序，因此可以让 Codex Desktop 登录账号最后才被用到。没有任何条目时，行为与以往完全一致。映射格式非法时会打印警告并关闭排序（不会触发 config 修复）。可通过 `ocx account priority` 和 Codex Auth 页面管理。 |
| `autoSwitchThreshold?` | `number` | `80` | 基于用量的主动切换阈值。`quota` 可在下一次请求中重新评估已绑定和未绑定任务；`fill-first` 仅把它用作未绑定分配的耗尽点；正常 `round-robin` 不使用它。分数取已知 5 小时、周或 30 天 quota window 的最高值。`0` 只关闭基于用量的主动切换，不关闭未绑定任务分配或故障恢复。 |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新建/未绑定 Codex 请求的分配策略。没有 live `(parent thread id, quota scope)` affinity 的请求属于未绑定；代理重启或 affinity 重置后，已有可见任务也可能未绑定。`quota` 在没有活跃账号时选择已知 usage 最低的合格账号；活跃账号合格且低于 `autoSwitchThreshold` 时继续使用；达到阈值后，可把未绑定请求或已绑定任务的下一次请求切换到 usage 更低的合格账号。`round-robin` 均匀分配未绑定请求；`fill-first` 在 cooldown、不可用或耗尽阈值前持续分配给活跃账号。 |
| `accountPoolStickyLimit?` | `number` | `1` | 一次 round-robin 选择在推进前保留的新建/未绑定任务分配数。计数在任务绑定时增加，而不是在上游成功后增加。范围 1–100；仅当 `accountPoolStrategy` 为 `round-robin` 时生效。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 连续发生多少次瞬态故障后，后续新会话会切换到备用上游。设为 `0` 可禁用。对于常规 Responses 和原生 compact 发送，已证明的连接前 DNS/TCP 不可达故障按 provider-host 粒度记录，不影响账户健康、账户冷却、线程/会话亲和性、活动账户选择或 Pool 路由，也不会计入此阈值。 |
| `upstreamHostCircuitThreshold?` | `number` | `0` | 原生 OpenAI forward Responses 与 compact 发送的可选断路器阈值，仅统计已证明的连接前 DNS/TCP 故障。`0` 表示禁用；`1`–`20` 表示在这么多个终止逻辑请求失败后，对 provider-origin 冷却 30 秒。断路期间会在账户选择和上游发送之前返回带 `Retry-After` 的 `503`；冷却结束后只允许一个半开请求。超时和 HTTP 响应不计数，任意 HTTP 响应都会关闭断路器。 仅适用于未固定账户的 Codex Pool 路由；在 `codexAccountMode: "direct"` 或使用账户限定选择器时不会启用。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每个提供者 `/models` 缓存的新鲜度窗口。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic 提示缓存策略：禁用、5 分钟临时缓存，或 1 小时扩展缓存。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | 关闭 | 可选的主动 OAuth 刷新与 Codex 账户预热策略。 |

selector 名称是用户自定的公开 label；opencodex 不会为其赋予账户角色语义。
`codexAccountNamespaces` 的 key 长度为 1–64 个字符，首尾必须是 ASCII 字母或数字，
中间可使用字母、数字、`.`、`_` 或 `-`；保留的 JavaScript object 名称会被拒绝。value 必须是有效的
pool account id（不能是内部 `__main__`），或用 `"@main"` 表示 Codex Desktop 账号。与 provider 及
保留的 `openai` / `combo` / `policy` 冲突时不区分大小写；带 namespace 的 combo 或 routing-profile alias 不能把 selector 复用为
其 namespace prefix，已配置的 pool id 和其他 selector target 也不能复用为 selector。raw account id
与 email 应保持私密，selector 才是公开名称。明确选择的行为和优先级见
[路由配置](/zh-cn/reference/configuration/routing/)。

Codex Auth 仪表盘控件只管理显式包含 `codexAccountPickerEnabled` 字段的映射。启用空的受管
映射时会创建保护隐私的 selector；之后添加账号时，即使 picker 行处于隐藏状态，也会扩展该
映射且不会重命名已有 selector。省略此字段的手写映射保持手动管理，绝不会自动扩展。删除账号
会保留其映射，使精确路由在账号缺失时 fail closed；以后添加相同账号 id 时会恢复已有公开
selector，而不是分配一个新名称。

## 保留的 OpenAI 提供者

`openai` 和 `openai-apikey` 是固定的保留 id。`openai.codexAccountMode` 默认是 `"pool"`，会在主账户和新增账户之间选择；`"direct"` 只使用当前调用者/主登录态。API 只使用其配置的 API key 或 key 池。请使用裸模型名或 `openai-apikey/<model>`；不存在跨路由凭据回退。API 的 GPT-5.6 行携带 922,000 上下文 / 922,000 最大输入元数据，而 Pro 虚拟 id 会重写为基础线协议模型并带上 `reasoning.mode: "pro"`。

`openaiProviderTierVersion: 2` 标记当前的单提供者投影。对已发布的 v1 配置进行迁移之前，opencodex 会创建 `config.json.pre-openai-tiers-v2.bak`，且不会覆盖不同的备份文件，并会把已知的旧式命名空间选择 id 重写为裸 id。

## 提供者条目（`OcxProviderConfig`）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`ollama-native`、`azure-openai`（或别名 `azure`）之一。 |
| `baseUrl` | `string` | 上游 API 基础 URL。大多数内置固定端点会忽略不匹配的值；具备冲突安全键的预设会保留一个更早、同名的自定义目标。 |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | 可选的客户端出站请求启动节流，与上游用量、计费和限流指标相互独立。提供商限制适用于所有模型，`models` 按上游模型精确 ID 匹配且只能增加延迟。排队等待不计入响应头超时。覆盖 HTTP、Responses WebSocket 以及显式适配器 `fetchResponse`/`runTurn` 调用。 |
| `responsesPath?` | `string` | 用于 key-auth `openai-responses` 请求的相对资源路径。必须以 `/` 开头，且不能包含 scheme、query 或 fragment。 |
| `upstreamWebsocket?` | `boolean` | 为 `openai-responses` 请求选择性启用上游 Responses WebSocket 传输（默认 `false`）。当上游支持该协议时，流式 POST 请求会使用配置的 Responses 路径（默认 `/v1/responses`），通过 HTTPS 基础 URL 以 WSS 连接，并重新编码为常规流程使用的 SSE。forward 提供者使用 `{baseUrl}/responses`；key-auth 提供者使用 `responsesPath`，未设置时回退到传统的 `/v1/responses`。普通 HTTP 仍使用 SSE；非 Responses 路径和 `openai-chat` 请求仍使用 HTTP。 |
| `supportsServiceTier?` | `boolean` | `service_tier` 能力的三态。`true`：fast 模式可以注入，调用方提供的值也会被保留。`false`：剥离该字段且绝不注入（已明确不支持的上游不会收到它）。未设置：未分类——调用方提供的值原样保留，fast 模式绝不注入。注册表已对官方 OpenAI（`true`）、DeepSeek 和 Volcengine Ark（`false`）分类；仅对真正支持分层的自定义网关显式设置。 |
| `preserveResponsesReasoningContent?` | `boolean` | 在重放的 Responses reasoning 项中保留明文 reasoning 内容，而不是清空（清空是 ChatGPT 后端的规则）。对接受 reasoning 重放的上游（如 DeepSeek）启用。代理生成的 `ocxr1` 信封始终会被剥离。 |
| `disabled?` | `boolean` | 将提供者保留在磁盘上，但从路由和模型/目录列表中排除。 |
| `apiKey?` | `string` | API key，或在请求时解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key 头部样式。默认使用原生 `x-api-key`；仅对 key-auth `anthropic` 提供者有效。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多 key 池。`apiKey` 会镜像当前激活条目；每个条目都有 `id`、`key`、可选 `label`，以及可选的数值 `addedAt`。 |
| `defaultModel?` | `string` | 当选择该提供者但未显式指定模型时使用的模型。 |
| `models?` | `string[]` | 种子/回退模型列表。配合 `liveModels: false` 时，这些就是唯一发现到的模型。 |
| `liveModels?` | `boolean` | 启动/同步时获取实时目录（默认 `true`）。自定义提供者使用 `${baseUrl}/models`；内置项可能使用注册表 URL 并进行过滤。 |
| `selectedModels?` | `string[]` | 发现之后的目录允许列表。非空时只暴露这些 id；为空或省略时则暴露全部发现到的模型。 |
| `modelDisplayNames?` | `Record<string, string>` | 持久的仅显示名称，以此提供者的精确原生模型 id 为键。键区分大小写。名称优先于提供者目录元数据，并且不会改变身份验证、适配器、路由、计费或上游请求。该映射最多可包含 2,000 个条目，与发现上限相同。 |
| `contextWindow?` | `number` | 上游缺少元数据时使用的提供者级上下文数值；有元数据时作为上限，保留更小的实时数值。Models 面板中与 `providerContextCaps` 分开设置。 |
| `modelContextWindows?` | `Record<string, number>` | 按模型设置的上下文数值与上限。优先于 `contextWindow`：窗口未知时采用所配置的数值，而更小的实时元数据仍然优先。 |
| `modelInputModalities?` | `Record<string, string[]>` | 按模型设置的输入提示，例如 `["text"]` 或 `["text", "image"]`。 |
| `modelMaxInputTokens?` | `Record<string, number>` | 正数型、按模型设置的最大输入限制，用于目录自动压缩提示。 |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | 按模型设置的正安全整数软自动压缩预算。该值只能降低“上下文或最大输入的 90%”这一有效上限；没有已知的权威上下文窗口时不会输出。对于规范 `openai`，键必须是受支持的精确原生模型 ID，且不得包含提供者或账户选择器前缀。提供者 PATCH 会合并条目；将某个键设为 `null` 会删除该键，将整个字段设为 `null` 会清空映射。这些 `null` 删除标记仅适用于 PATCH。 |
| `defaultMaxOutputTokens?` | `number` | 当客户端省略 `max_output_tokens` 时，`openai-chat` 的提供者级回退值。 |
| `modelMaxOutputTokens?` | `Record<string, number>` | 正数型、按模型设置的 `openai-chat` 回退预算；精确/模式匹配优先于提供者默认值。 |
| `modelCosts?` | `Record<string, Cost4>` | 按模型设置的显示价格（每 100 万 token 的美元数），以该提供者的精确上游模型 ID 为键（不是提供者标识符或路由后的 `provider/model` 标签），值为四个字段：`input`、`output`、`cacheRead`、`cacheWrite`（示例：`{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`）。任何模型 ID 都是有效键——自定义提供者可以通过 `openai-chat` 适配器指向任意 OpenAI 兼容端点，即使不存在于内置目录中，本地 OpenAI 兼容和内部提供者的 ID 同样有效。用户配置的价格在 Logs 的 `~$` 和 Usage 估算中优先于内置目录；历史条目也会按当前覆盖项重新计价，因此修改价格可能改变过去的总额（回退顺序：用户配置 → jawcode 目录 → expected-price 覆盖 → 模型级厂商价格）；全零条目会回退到该顺序中的下一个来源。每个费率必须是大于等于 0 的有限数字，且不超过 1,000,000（每 100 万 token 的美元数）；超出范围的条目会在管理边界被拒绝，并在加载时被丢弃。仅用于显示的估算：覆盖项不影响路由、账户选择、配额或计费。 |
| `headers?` | `Record<string, string>` | 额外的上游请求头。会拒绝 Authorization、cookie、API key 头、嵌入换行符以及无效名称。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 默认的 OpenRouter `order`、`only` 和 `allowFallbacks` 偏好；仅对使用 `openai-chat` 的规范 OpenRouter 有效。 |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | 精确模型 id 级别的覆盖项，会替换提供者级 OpenRouter 偏好。 |
| `vercelGatewayRouting?` | `VercelGatewayRouting` | 默认的 Vercel AI Gateway `order`、`only` 和 `sort`（`"cost"` \| `"ttft"` \| `"tps"`）偏好；仅对使用 `openai-chat` 的规范 Vercel AI Gateway 有效。 |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | 身份验证模式（默认 `key`）。OAuth/订阅凭据存放在 `config.json` 之外；`local` 仅限注册表条目允许它的提供者。 |
| `codexAccountMode?` | `"pool" \| "direct"` | 仅适用于规范的 `openai`；默认是 Pool。Direct 会绕过池状态。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 覆盖该 OAuth 提供者的 Token Guardian 策略。 |
| `reasoningEfforts?` | `string[]` | 要向外暴露并发送的、提供者级 Codex 推理标签。 |
| `modelReasoningEfforts?` | `Record<string, string[]>` | 按模型设置的标签。空列表会隐藏 effort 控件。 |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | 将某个模型设为 `false`，即可停止暴露摘要并移除摘要交付字段。 |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | 按模型设置的 Responses 交付枚举；会重写现有的 delivery 字段。 |
| `modelAdapters?` | `Record<string, string>` | 按模型设置的 `openai-chat` 或 `openai-responses` 线协议覆盖项，用于混合线协议网关。显式条目优先于注册表默认值；DeepSeek 预设可以为 `deepseek-v4-flash` 选择原生 Responses，GitHub Copilot 则为 GPT-5 系列（`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`）声明了 Responses 专用默认值，因为这些模型在代理流量下会拒绝 `/chat/completions`。没有内置默认值的模型（例如 `gpt-5.4-nano`）可以在此手动启用。单一线协议上游固定项和规范 ChatGPT forward 会拒绝覆盖。 |
| xAI Responses 启用项（仪表板） | 开关 | 仅用于 `xai`，以原子方式设置或清除 `grok-4.5` 和 `grok-4.6` 的 `modelAdapters` 条目。若只存在一个条目，则显示混合状态，直到下次开关写入将两者统一。其他覆盖项和层级行为不变。 |
| `xaiResponsesXSearch?` | `boolean` | 默认禁用。在 xAI Responses 目标上，仅当有效的 `web_search` 工具在最终请求规范化后仍保留时，才附加由提供方托管的 `x_search` 声明。不会重复已有声明，绝不会扩大调用方的 `tool_choice`/`allowed_tools` 选择范围，并且此项独立于网络搜索辅助服务的 `search.xSearch` 选项。 |
| `modelPreferHostedTools?` | `Record<string,string[]>` | 非 forward Responses gateway 的精确模型 ID opt-in，用于上游预留 hosted tool namespace 的情况。目前只支持 `["image_generation"]`；匹配模型必须使用 `openai-responses` wire 且支持该 hosted 工具。它会移除冲突的客户端 `image_gen` 声明，并改写其 selector 以保持调用方的 tool choice。对于 OpenAI API 的虚拟 `-pro` 模型，先匹配所选公开 ID，未命中时才使用解析出的基础 wire-model ID 作为回退。`modelAdapters` 会先按公开 ID、再按基础 ID 解析；后一次结果决定最终 wire。未配置模型保持普通 alias 行为。 |
| `annotateEmptyToolOutputs?` | `boolean` | 在工具结果到达模型之前，将存在但为空的结果替换为简短标记，以免空白结果被误认为缺失结果。适用于空白字符串和仅包含文本的部件数组；图像、文件和加密部件绝不会被修改。内置注册表中 `DeepSeek` 的默认值为 `true`，其他情况下不设置。设为 `false` 可让提供者退出此行为——后续编辑即使省略该字段，也会保留显式的 `false`。`PATCH /api/providers?name=<provider>` 接受 `true`、`false` 或 `null`；传入 `null` 可清除覆盖值并恢复注册表默认行为。 |
| `reasoningEffortMap?` | `Record<string, string>` | 提供者级、用于推理标签的线协议别名。 |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | 按模型设置的推理标签线协议别名。 |
| `reasoningWireFormat?` | `"gateway-object"` | 用于接受 `reasoning: { enabled, effort }` 而非 `reasoning_effort` 的 OpenAI 兼容 gateway。ClinePass preset 会自动设置。 |
| `noReasoningModels?` | `string[]` | 会拒绝推理/思考参数的模型。 |
| `noTemperatureModels?` | `string[]` | 会拒绝调用方指定 `temperature` 的模型。 |
| `noTopPModels?` | `string[]` | 会拒绝调用方指定 `top_p` 的模型。 |
| `noPenaltyModels?` | `string[]` | 会拒绝 presence/frequency penalty 的模型。 |
| `noStructuredOutputModels?` | `string[]` | `openai-chat` 端点拒绝 `response_format` 的精确模型 ID。仅当请求模型与条目完全匹配时才省略该字段；其他 `openai-chat` 模型仍启用 structured-output 转换。 |
| `parallelToolCalls?` | `boolean` | 切换并行工具调用。OpenAI Chat 默认开启；非 chat 适配器只有显式 `true` 时才会声明支持。 |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | 默认关闭的下游 SSE 修复，用于精确占位 id、缺失的终止 id，以及（`repairInvalidIds`）缺少规范 `msg_`/`rs_` 前缀的 message/reasoning id。function-call id 永远不会被重写。内置 DeepSeek 默认启用后两项。 |
| `responsesSnapshotRepair?` | `boolean` | 默认关闭的客户端修复，用于补全 SSE 与 JSON 中稀疏 Responses 生命周期快照缺失的 status、output 和工具元数据；原始检查与持久化保持不变。 |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | 仅限 API-key 提供商（`authMode: "key"`）。可选的同目标 429 重试：未配置 `retryOn429` 时功能关闭；对象存在即启用，除非 `enabled: false`。收到 429 时等待（上游 `Retry-After` 或固定间隔）后在相同 key 上重放完全相同请求，再进入任何 key 故障转移——覆盖主文本恢复循环、Responses passthrough、图像/视频桥、web-search 侧车与终结续接。重放仅适用于流开始前的 HTTP 429 响应；自定义 `runTurn` 传输不在 HTTP 重试循环范围内。`attempts` 是首个 429 之后的同 key 重放次数（总发送次数 = `attempts` + 1），是主恢复循环、终结守卫续接与桥接重试共享的按请求统一预算；`attempts` 耗尽只会停止进一步的同 key 重放：随后按可用目标进行正常的 key 故障转移或最终错误处理——key 认证的 passthrough 线路上没有故障转移，因此耗尽的 429 会原样透出。Codex 自身从不重试 429，因此这是单 key 提供商唯一的防线。默认值：`enabled: true`、`attempts: 3`、`intervalMs: 5000`、`maxIntervalMs: 60000`（单次等待以 `maxIntervalMs` 为上限，其本身上限 600000）、`respectRetryAfter: true`。 |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | 仅限使用 key 认证的 `openai-chat` 提供商。可选的流开始前上游瞬态状态码（500、502、503、504、520、521、522）重试：未配置时关闭；对象存在即启用，除非 `enabled: false`。覆盖初始 Responses 请求、终结守卫续接、原生 `/v1/chat/completions`，以及 429/账户恢复重新获取。`attempts` 是单个请求允许向上游发送的总次数，包含首次发送（1..10，默认 3）；它是与连接重置恢复共享的按请求预算，因此 `3` 表示最多只有三个实际请求到达提供商。等待采用固定 400 毫秒的指数退避，上限为 5 秒，并遵循 `Retry-After`。此选项独立于处理速率限制的 `retryOn429`；流开始后的故障绝不会重放。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` 只接受 `auto` 或 `none` 的模型；强制选择会被降级。 |
| `preserveReasoningContentModels?` | `string[]` | 需要在聊天历史中保留先前 assistant `reasoning_content` 的模型。 |
| `reasoningDetailsModels?` | `string[]` | 以结构化 `reasoning_details` 数组返回思考内容的模型（启用 `reasoning_split` 的 MiniMax M 系列）；流式增量为累积快照，按前缀差分处理，保留的推理以 `reasoning_details` 数组而非 `reasoning_content` 字符串回放。 |
| `requiresReasoningPlaceholderModels?` | `string[]` | 上游会拒绝缺少 `reasoning_content` 的 tool_call 续接消息的模型（DeepSeek thinking 模式）；重放缓存 miss 时注入最小占位符。缺省沿用 `preserveReasoningContentModels`；设为 `[]` 可显式关闭。 |
| `thinkingToggleModels?` | `string[]` | 使用 `thinking.enabled` 而不是 effort 阶梯的 chat 模型。 |
| `thinkingBudgetModels?` | `string[]` | 使用整数 `thinking_budget` 的 chat 模型；effort 会映射为预算比例。 |
| `noVisionModels?` | `string[]` | 经由视觉 sidecar 发送的纯文本模型；匹配时会容忍 Ollama 的 `:size` 标记。 |
| `escapeBuiltinToolNames?` | `boolean` | 为 Anthropic 兼容网关转义内置工具名，并在返回的调用中恢复。 |
| `anthropicEofTolerance?` | `boolean` | 允许 Anthropic 兼容网关在 `message_stop` 前结束流，仅当已收到可见文本或完整的 JSON 对象工具输入时。默认关闭。 |
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
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | 对于新会话，当活动账户达到此阈值时，选择配置窗口中已知缓存使用率最低的账户。`0` 会禁用配额选择。 |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新会话策略；`quota` 按 `quotaWindow` 指定的窗口（默认是 5 小时条形数据）对账户排序，`fill-first` 也在同一窗口中判定其耗尽阈值。 |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` | 基于用量选择账户时使用的、由提供商报告并缓存的用量条。`five-hour` 保持原有行为。`weekly` 使用每周用量条，并在仍有其他可用账户时跳过 5 小时用量已耗尽的账户；若没有其他账户，则回退使用这些账户。`max-utilization` 使用已知值中的最高值，因此每周用量尚不可用时仍可使用 5 小时用量；两者都未知时，账户遵循 unknown 用量排序。已知用量排在 unknown 之前，但如果所有可用账户都未知，仍会按可用顺序选择一个账户。在前述较低 5 小时用量的同分判定之后，完全相同时也保留可用顺序。不会主动重新平衡健康且已建立亲和性的会话。在新会话分配和符合条件的 429 替代后的路由恢复中，`quota` 直接按此窗口对可用候选账户排序；`fill-first` 按此窗口的阈值和耗尽规则以稳定顺序前进；`round-robin` 忽略此设置。冷却状态、故障转移上限和重新认证资格仍是独立的本地状态。各账户的每周用量只有在控制面板的提供商页面完成查询后才可用。 |
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

Cursor 桥接是实验性的。执行 `ocx login cursor` 之后，添加或编辑 `providers.cursor`。

如果代理无法承载 Cursor 默认的 HTTP/2 stream，请将 `upstreamHttpVersion` 设置为
`"http1.1"` 或其别名 `"h1"`。推理会切换到 Cursor 的 `RunSSE` + `BidiAppend` 兼容传输，`GetUsableModels`
实时发现也会使用 HTTP/1.1。该配置要求 `baseUrl` 使用 HTTPS。保持未设置或使用 `"auto"`，
则继续使用现有 HTTP/2 行为。
在仪表板中，可通过 **Providers → Cursor → 设置 → Cursor 传输协议** 进行选择。

Cursor Router 的优化层级会作为独立的 Codex id 暴露，因为选择器无法渲染 Cursor 特定的模型参数：

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

请将 `nativeLocalExec` 设置在 `providers.cursor` 上，而不是顶层。在仪表板中，使用 **Providers → Cursor → Edit JSON**，保存，然后重启。旧的 `unsafeAllowNativeLocalExec: true` 仅在未设置 `nativeLocalExec` 时，才等同于 `nativeLocalExec: "on"`。MCP、屏幕录制和 computer use 由 `mcpServers` 和 `desktopExecutor` 单独控制。

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

## Vercel AI Gateway 提供者路由

Vercel AI Gateway 可以在多个底层推理提供者之间路由一个模型。`vercelGatewayRouting` 配置提供者级偏好；`modelVercelGatewayRouting` 会针对精确模型 ID 替换这些偏好。两者均未设置时，`resolveVercelGatewayRouting()` 返回 `undefined`，因此 Chat 请求构建器会省略 `provider` 字段，Vercel AI Gateway 则保留其默认的动态路由行为。

- `order`：按优先级排列的 Vercel AI Gateway 上游提供者 slug。
- `only`：限制可用 Vercel AI Gateway 上游提供者的显式允许列表。
- `sort`：按 `"cost"`（成本最低）、`"ttft"`（首个 token 所需时间）或 `"tps"`（每秒 token 数）自动排列可用提供者。

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

模型键是 Vercel 的公开模型选择器，不带外层的 OpenCodex 提供者前缀。选择 `vercel-ai-gateway/zai-glm-5.2` 时，会先还原为原生 `zai/glm-5.2`，再应用模型规则。相同映射也适用于原生 `vercel/<model-id>` 选择器：在 OpenCodex 中使用编码后的 `vercel-ai-gateway/vercel-<model-id>` 选择器，并将 `vercel/<model-id>` 保留为模型键。

## 静态模型允许列表

将 `liveModels: false` 设为只暴露 `models`。如果 `models` 为空或省略，该提供者将不暴露任何路由模型。实时发现会在缓存前拒绝超过 4 MiB 或 2,000 条原始模型行；内置预设可能使用更低的限制，并过滤为可聊天的行。过大或格式错误的结果会走陈旧/配置回退。合法的、零可用结果的发现仍然具有权威性，不会被静默替换或截断。

当需要继续运行发现，但只有选定 id 应该出现在 Codex 和 `/v1/models` 中时，请使用 `selectedModels`。仪表板会保留完整的已发现列表，以便之后调整允许列表。

请使用 `modelDisplayNames` 设置显示名称。优先顺序是操作者设置的 `modelDisplayNames`、提供者目录元数据，然后是普通的 `provider/model` 显示。键是此提供者内精确的原生模型 id，例如 `xai/grok-4.6` 的键是 `grok-4.6`。名称只改变显示，不会改变精确路由 id 或上游模型 id。请只把此字段加入 `config.json` 中现有的提供者设置，并保留所有其他字段。向 `PUT /api/providers/:provider/model-display-names` 发送 `{ "modelId": "grok-4.6", "displayName": "Grok 4.6" }` 可保存名称，发送 `displayName: null` 只重置该名称。

预览版 GPT-5.6 回退条目使用相同机制。OpenAI API key 预设会为基础和 Pro id 设定 `922000` 上下文和 `922000` 最大输入；OpenRouter 会为 `openai/gpt-5.6-sol`、`openai/gpt-5.6-terra` 和 `openai/gpt-5.6-luna` 设定 `922000` 上下文。Pool/Direct 会声明 `922000`；同步后的目录会声明 `max`，同时保留 `xhigh` 的独立性。

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

### Responses 终端事件修复策略 (Terminal-Repair Policy)

这三个配置键是针对自定义 Provider 提供的重叠控制项，用于在原生 Responses 流未送达终端事件时提供有界的修复机制。对于每个请求的模型，有效适配器（Provider 的 adapter 或其 modelAdapters 覆盖）必须为 openai-responses；Chat Completions 与其他线协议绝不启用。模型匹配不区分大小写。

解析优先级如下：

1. 匹配的 modelResponsesCompatibility 条目为模型启用终端修复，默认宽限期为 500 毫秒（除非匹配的 modelResponsesTerminalRepair 提供显式宽限期）。
2. 否则，匹配的 modelResponsesTerminalRepair 条目提供 per-model 宽限期。
3. 否则，由 responsesTerminalRepair 提供 Provider 级别的回退值。

宽限期数值必须为正有限毫秒数，Runtime 会对其取整并将上限约束在 60 秒。配置验证会拒绝格式错误的值，并在规范的 ChatGPT forward Provider 上拒绝这三个键（通过 adapter、authMode 与规范化 baseUrl 判定，而非 Provider 名称启发式）。Runtime 解析器实施纵深防御：无效或大小写冲突的 per-model 条目不会被选取，从而 fail-closed 拒绝，而非任意挑选条目。
