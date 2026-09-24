---
title: 管理 API
description: opencodex 控制平面的身份验证、错误和端点参考。
---

Management API 是 opencodex 的控制平面。`http://localhost:10100` 上的仪表板只是它的一个客户端；无头的 `ocx` provider、model、combo、account、settings、diagnostics 和 lifecycle 命令也是客户端。该 API 仅在代理运行时可用。

请使用 [Web 仪表板](/guides/web-dashboard/) 作为交互式客户端，或者在构建自动化时参考本文档。持久化值最终遵循 [配置](/reference/configuration/)。

## 身份验证模型

Management API 有自己独立的管理员凭证，与数据平面 API 密钥无关。启动时，opencodex 会按以下顺序解析它：

1. `OPENCODEX_ADMIN_AUTH_TOKEN`，如果已设置。
2. 在加固后的密钥文件中生成的 `ocx_admin_*` 令牌。

只有在其目录和文件权限或 ACL 已加固后，才会接受基于文件的令牌。如果无法保证这一点，管理身份验证将以拒绝式失败结束，API 会返回 503，直到提供环境变量令牌或修复文件状态为止。

管理员令牌可用以下任一形式发送：

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
管理员令牌必须与所有数据平面凭证都不同。启动时会拒绝与代理准入密钥冲突的管理凭证。不要把管理员令牌放进 Codex、Claude Code 或其他模型客户端；它授权的是控制平面变更。
:::

### 回环仪表板会话

在回环绑定上，仪表板引导可以接收一个短期的 `ocx_session_*` 凭证。每个会话持续五分钟，并绑定到精确的仪表板来源。安全请求必须匹配该来源。非安全方法还要求浏览器的 `Origin` 和该会话的 CSRF 令牌。

当需要数据平面身份验证时，会禁用会话签发，这也包括远程绑定。远程操作员必须使用原始管理员令牌进行身份验证；不会签发类似回环的 GUI 会话。

## 常见错误

下面所有端点行都继承这些边界错误。“典型错误”列列出的是额外的路由特定结果，而不是重复此表。

| 状态 | 类型或代码 | 含义 |
| --- | --- | --- |
| 401 | `opencodex admin token required` | 管理员令牌或 GUI 会话缺失、无效、过期、来源不匹配，或缺少 CSRF 证据 |
| 403 | `cross-origin request blocked` | 请求来源不在管理允许列表中 |
| 404 | `not_found` | 没有任何管理路由匹配该方法和路径 |
| 413 | `request body too large` | POST、PUT 或 PATCH 请求体超过 2 MiB 的管理限制 |
| 503 | `management API unavailable` | 管理员凭证初始化或加固不可用 |
| 503 | `oauth_mutation_busy` | 另一个 OAuth 凭证变更持有写锁；响应包含 `Retry-After: 1` |
| 503 | `catalog_busy` | 目录收集已达到容量上限；响应包含 `Retry-After: 1` |

## 端点矩阵

### 代理与客户端设置

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET, PUT /api/v2` | 读取或更改原生多代理 v2 模式和线程设置 | 400 无效设置；502 过渡或持久化失败 |
| `GET, PUT /api/injection-model` | 读取或设置注入的子代理模型、努力程度、提示词和指导设置 | 400 无效模型、努力程度或请求体 |
| `GET, PUT /api/effort-caps` | 读取或设置全局和子代理推理努力上限 | 400 无效的阶梯值 |
| `GET, PUT /api/subagent-models` | 读取或排序向子代理公开的模型 | 400 无效列表或超过五个模型 |
| `GET, PUT /api/subagent-model-fallback` | 读取或设置有序回退链和轮询间隔 | 400 无效列表或轮询间隔 |
| `GET /api/grok` | 读取 Grok 托管配置状态和候选模型 | 400 状态读取失败 |
| `PUT /api/grok/selection` | 持久化被排除的 Grok 模型 | 400 选择无效或超出大小限制 |
| `POST /api/grok/apply` | 通过托管同步应用已持久化的 Grok 配置 | 409 `grok_apply_busy`；400/500 应用失败 |
| `GET /api/grok/reset-coupons?accountId=...` | 读取活跃或指定 xAI 账号剩余的 Grok 计费重置 token 及有效期窗口 | 400 缺少账号；401 未认证；502 上游 gRPC-Web 错误 |
| `POST /api/grok/reset-coupons/consume` | 兑换一个符合条件的重置优惠券。请求体为 `{ accountId?, tokenId?, operationId? }`。可选的 `operationId`（UUIDv4）让兑换具备幂等性：重复相同 id 会重放持久化结果，而不会重复兑换。 | 400 无效的 JSON/UUID；401 未认证；409 `identity_mismatch`；502 上游错误；503 ledger 容量 |
| `GET /api/anthropic/reset-grants?accountId=...` | 读取一个 Anthropic OAuth 账号的 Claude 用量额度重置机会：是否符合条件、每项重置机会的剩余次数、有效期及可恢复的用量窗口，以及仍可重试的未确认请求 | 400 无匹配账号；401 需要重新认证；502 上游不可用 |
| `POST /api/anthropic/reset-grants/consume` | 使用一次重置机会。请求体为 `{ accountId, grantId, operationId }`；`operationId` 是作为请求 ID 发送给上游的 UUIDv4，重复发送会重试同一次请求。需要仪表板会话。 | 400 请求体无效；401 需要重新认证；403 `session_required`；409 `grant_not_usable`、`in_flight`、`unresolved_prior_operation`、`unknown_outcome_expired`、`operation_identity_mismatch`；500 `journal_write_failed`；502 `unknown_outcome`；503 日志正忙、不可用或已满 |
| `GET, PUT /api/claude-desktop` | 读取或持久化 Claude Desktop 的路由/原生配置文件 | 400 分配无效或不可用 |
| `POST /api/claude-desktop/apply` | 将已保存的配置文件写入 Claude Desktop 的托管配置 | 400/500 写入失败 |
| `GET /api/claude-desktop/status` | 检查已保存与已应用的配置文件以及 Desktop 健康状态 | 400 状态读取失败 |
| `GET, PUT /api/claude-code` | 读取或更新 Claude Code 的网关、认证模式、模型映射、上下文、代理和 sidecar 设置 | 400 字段或结构无效 |

仪表板从 **Providers > xAI Grok > Accounts** 驱动这两条优惠券路径：每个已登录账号行
都带有显示剩余优惠券数量的票据徽章，该徽章会打开一个对话框，列出有效期窗口并兑换
最接近到期的优惠券。该对话框会发送客户端生成的 `operationId`，并在超时后停止发送而不是
重试，因为 journal 记录仍处于打开状态的兑换会再次执行。`ocx account grok-reset-coupons`
仍然是对应的终端命令。

Claude 用量重置同样可以从 **Providers > Anthropic > Accounts** 操作。每个已登录账号行都带有显示剩余重置次数的票据徽章，对话框会在再次确认后使用一次重置机会。重置会恢复 5 小时和每周用量额度，但不会改变每周额度的重置日期。如果请求未及时返回结果，对话框会保留其 `operationId`，并在十分钟内提供使用同一 ID 重试的选项；Claude Code 客户端也以此方式恢复。在此期间，同一重置机会的新操作会被拒绝。重置机会只能通过仪表板使用：仅凭管理员令牌会收到 `403 session_required`。

关于模型名录和加密工作任务行为的概念，请参见 [子代理界面](/guides/sub-agent-surface/)。

### 客户端集成回滚日志

| 方法和路径 | 用途 | 主要错误 |
| --- | --- | --- |
| `GET /api/client-integrations/journal?client=...` | 列出回滚操作，也可限定为单个客户端。每一项都包含由服务器计算的 `deletable` 字段。 | 400 客户端无效 |
| `DELETE /api/client-integrations/journal?opId=...` | 停用一条较旧的回滚操作，并在可能时删除其快照。成功响应中的 `snapshotRemoved: false` 表示清理任务已保留，等待维护重试。 | 400 缺少 `opId`；404 操作不存在或已停用；409 该客户端的最新操作 |

## 预览集成变更

预览只展示变更会做什么，而不会执行它。这些路由不写入任何内容：不留快照、不留归属记录、不留
日志行、不加锁、不做维护和恢复。

| 方法与路径 | 用途 | 主要错误 |
| --- | --- | --- |
| `POST /api/client-integrations/preview` | 为一个客户端规划 `apply`、`overwrite` 或 `disable`；请求体为 `{ "clientId": "...", "operation": "..." }` | 400 客户端或操作无效；400 `invalid_aside_profile_path`；409 `integration_preview_unavailable` |
| `POST /api/client-integrations/restore/preview` | 规划一次撤销；请求体为 `{ "opId": "...", "confirmDrift": false }` | 404 操作不存在；400 `invalid_aside_profile_path`；409 `integration_preview_unavailable` |
| `POST /api/client-integrations/aside/profiles/{profileId}/preview` | 规划单个 Aside 配置档的变更；`restore` 需要 `opId` | 400 请求体无效或未指定配置档；404 配置档或操作不存在；409 `integration_preview_unavailable` |

计划包含 `version`、`clientId`、`operation`、`state`、`foreignEdit`，由 `kind` 与 `path` 组成的
`changes` 列表，不透明的 `fingerprint`，以及 `canApply` 和 `willChange`；`refusalReason` 与
`profileId` 为可选。路径要么是受管理的结构路径，要么是 `$snapshot`、`$ownership`、`$journal`
这三个固定标记；运行时才确定的位置显示为 `*`。不会返回任何配置值、文件位置或所选条目的名称。

`canApply` 为真而 `willChange` 为假，表示操作会成功，但受管理的客户端文档不会有任何改动，例如
重复应用已经应用过的内容。

Aside 配置档的变更在这种情况下仍会保存一件事：确认之后，会先记录该配置档的同步偏好，然后才去动
客户端文档。因此关闭一个受管理区块已经不存在的配置档，只会保存偏好，文档及其历史保持不变。

`integration_preview_unavailable` 表示当前没有可用的模型清单：代理刚启动是一种情况，因配置或
提供方缓存变化而弃用了原有清单也是一种情况。读取 `GET /api/client-integrations` 会在探测成功
且能确认配置时建立清单，因此这通常是解决办法，但并非必然建立。

## 确认已预览的变更

变更路由接受与原有请求体并列的 `operation` 和 `planFingerprint`。两者要么都发送，要么都省略：
只带其中一个会被拒绝，`operation` 与所请求的变更不一致也会被拒绝。Aside 的绑定只针对单个配置
档，因为一个指纹无法描述多个各自独立变化的文件。

服务器在写入前会重新规划，若确认的内容已不再符合实际，会返回 `409 integration_preview_stale`
并附上重新计算的 `plan`。请根据新计划再做一次决定；请求不会自动重试。

指纹只是乐观校验，不是授权。变更是否被允许，仍由管理 API 的认证和归属规则决定。

删除操作会追加墓碑记录，而不会重写日志。服务器会保护每个客户端的最新操作，
以保留当前的撤销点。

### Combos

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/combos` | 列出规范化的 combo 及其公开模型 id | 目录工作可能返回 `catalog_busy` |
| `PUT /api/combos` | 创建、替换或重命名一个 combo | 400 id、目标、配置、重命名或常规冲突无效；409 Codex 账户命名空间冲突 |
| `DELETE /api/combos?id=...` | 删除一个 combo，并清除其选择/冷却状态 | 400 缺少 id；404 未知 combo |

关于目标策略、冷却、别名和路由失败，请参见 [Combos](/guides/combos/)。

### Codex 提示词层

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/codex-prompt` | 读取提示词层快照：层、基础变体、选择和 drift 状态 | — |
| `GET /api/codex-prompt/text` | 通过 `codex debug prompt-input` 探测模型可见的提示词文本 | 故障弱化：不可用的探测降级为正文中的状态，而非 HTTP 错误 |
| `PUT /api/codex-prompt/toggle` | 启用或禁用一个可切换的层 | 400 无效正文或未知层；409 `stale_revision`、`layer_not_toggleable` |
| `PUT /api/codex-prompt/custom` | 替换自定义层集合 | 400 无效正文、`invalid_characters`、规范化 UTF-8 层超过 65,536 字节时 `body_too_large`、超过 131,072 字节时 `composed_too_large`；409 `stale_revision` |
| `PUT /api/codex-prompt/base/select` | 选择默认基础提示词或一个已保存的变体 | 400 无效正文、与任何已保存变体都不匹配的 id 返回 `unknown_layer`；409 `stale_revision`、当前基础提示词为外部时 `developer_instructions_not_owned` |
| `PUT /api/codex-prompt/base` | 创建（省略 `id` 或 `id: null`）、编辑或删除（`delete: true`）一个基础变体。提供的 `id` 仅用于编辑，必须引用已保存的变体。`body` 在测量或存储前会被规范化（制表符展开，CR/CRLF 折叠为 LF） | 400 无效正文、`default` id 或与任何已保存变体都不匹配的 id 返回 `unknown_layer`、规范化 UTF-8 正文超过 65,536 字节时 `body_too_large`；409 `stale_revision` |
| `POST /api/codex-prompt/adopt` | 将 `config.toml` 中的 `developer_instructions` 导入为自定义层 | 400 无效正文、`invalid_characters`、`body_too_large`、`composed_too_large`；409 `config_unreadable`、`nothing_to_adopt`、`adopt_unsupported_form`、`stale_revision` |
| `POST /api/codex-prompt/repair` | 修复 `config.toml` 与受管 projection 之间的 drift | 400 无效正文；409 `config_unreadable`、`nothing_to_repair`、`repair_unsupported`、`stale_revision` |

有关层模型和每个层写入的键，请参见 [Codex 提示词层](/zh-cn/guides/codex-prompt/)。

### 配置、启动、同步和更新

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/config` | 返回已脱敏、对管理安全的配置 DTO | — |
| `PUT /api/config` | 禁用的完整配置替换保护 | 405；请改用聚焦端点 |
| `GET, PUT /api/settings` | 读取运行时/启动设置，或更新自动启动、流模式、应用拥有的内存预算和 `codexAccountPickerEnabled` | 400 无效、非对象或空更新 |
| `GET /api/startup-health` | 读取缓存的服务/shim 启动健康状态 | — |
| `POST /api/startup-action` | 安装或修复服务或 Codex shim | 400 无效动作；500 动作失败 |
| `GET, POST /api/windows-tray` | 读取 Windows 托盘状态，或安装、启动、停止、卸载它 | 400 不支持的平台/动作；500 操作失败 |
| `GET /api/diagnostics/project-config` | 读取缓存的项目配置警告 | — |
| `POST /api/sync` | 将当前模型目录同步到 Codex | 500 同步失败 |
| `GET /api/update/check` | 异步检查 `latest` 或 `preview` 软件包通道，并在成功时刷新缓存 | 400 无效标签 |
| `POST /api/update/run` | 异步检查新的软件包版本，然后启动更新任务，并可选择重启 | 400 无效请求体；任务特定的冲突/错误状态 |
| `GET /api/update/status` | 按 id 轮询更新任务 | 404 未知任务 |
| `GET, PUT /api/sidecar-settings` | 读取或更新 web 搜索和 vision sidecar 的模型/后端设置 | 400 结构、后端或限制无效 |
| `GET, PUT /api/shadow-call-settings` | 读取或更新 shadow-call 拦截设置 | 400 结构或值无效 |

### 日志、使用情况和存储

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/logs` | 查询经过过滤的内存请求日志；`servedModel` 记录上游返回的模型，`wireModel` 记录与客户端模型不同的实际发送模型。两者不同时，仪表板显示 `wire → served`，提示信息保留两者；缺少上游证据时不推断模型。 | — |
| `GET, PUT /api/debug` | 读取调试标志；设置、清除或重置捕获类别 | 400 无效或空更新 |
| `GET /api/debug/logs` | 读取有上限的 provider/debug 日志条目 | — |
| `GET /api/debug/usage-logs` | 读取有上限的 usage-debug 条目 | — |
| `GET /api/debug/injection-logs` | 读取有上限的 guidance-injection 调试条目 | — |
| `GET /api/claude/inbound-debug` | 读取 Claude 入站调试状态和条目 | — |
| `GET /api/usage` | 按范围和客户端界面汇总使用情况 | 若无法读取存储，则返回带有 `error: "read_failed"` 的摘要 |
| `GET /api/metrics` | 返回进程本地的 Prometheus 文本指标，涵盖逻辑请求、实际发送、恢复类型、持续时间和 TTFT。标签仅使用协议、结果和恢复类别的封闭集合；绝不导出请求或凭据标识。 | 启动时 `metricsExport.enabled` 不为 true 则返回 404；需要普通管理认证，数据平面凭据不能访问 |
| `GET /api/storage` | 按桶扫描 Codex 存储使用情况 | 扫描失败时返回带有 `error: "scan_failed"` 的载荷 |
| `POST /api/storage/cleanup/preview` | 预览已归档会话清理并返回绑定摘要 | 400 `invalid_json` 或 `invalid_percent` |
| `POST /api/storage/cleanup` | 隔离或永久移除预览出的归档集合 | 400 输入无效；409 过期/忙碌/被引用状态；500 文件系统/数据库失败 |
| `GET /api/storage/trash` | 列出已隔离的清理条目 | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | 恢复一个已隔离条目 | 400 无效 id；404 缺少 trash；409 忙碌/目标冲突；500 恢复失败 |
| `GET /api/storage/trash/restore/test-stream` | 仅测试用的恢复流钩子 | 测试钩子关闭时返回 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | 读取或更新计划清理策略和作业状态 | 400 策略无效 |
| `POST /api/storage/cleanup-policy/run` | 启动一次手动清理策略运行 | 409 `already_running`；500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | 仅测试用的策略流钩子 | 不可用时返回 404 `not_found` |

如果某行超过现有解析器的大小限制，`GET /api/usage` 和 `GET /api/keys` 会保留可读取行的汇总，并在响应级别添加 `usageIncomplete: true` 和 `usageIncompleteReason: "oversized_rows"`。缓存和增量追加会保留该诊断，即使结果为空或没有筛选匹配；重建时会重新计算。不会缩短供应商、模型或 API 密钥标识来容纳该行。没有此标记不代表所有记录均有效。它与 `historyTruncated`、`entriesTruncated` 及 token 测量覆盖率相互独立。

`models`、`providers` 和 `days[].models` 中的记录也带有 `cacheHitRate`：它表示由提供方提示缓存提供的输入 token 比例，并限制在 `[0, 1]` 范围内。当提供方未报告缓存遥测数据或该记录没有输入 token 时，其值为 `null`，绝不会是 `0`，因为“没有缓存数据”与“实际命中率为 0%”是不同的事实，将两者显示为相同结果的图表会产生误导。

:::caution
存储清理端点可以移动或永久删除已归档的会话数据。务必先预览，并提交返回的摘要。若可能需要恢复，优先选择隔离。
:::

### 模型与目录

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/catalog` | 返回已安装的 Codex 目录文档 | 404 未找到目录 |
| `GET /api/models` | 返回仪表板/CLI 模型行 | 收集饱和时返回 `catalog_busy` |
| `GET /api/client-config?client=...` | 为任意支持的文件集成构建只读客户端配置 | 400 不支持的客户端；503 目录不可用 |
| `PUT /api/disabled-models` | 替换共享的禁用模型列表 | 400 无效 JSON |
| `PUT /api/model-visibility` | 原子性地更改 provider 级或 model 级可见性 | 400 provider、scope、target 或请求体无效; 409 `initial_model_selection_pending` (刷新模型列表后重试。) |
| `GET, POST /api/custom-models` | 列出自定义模型或添加一个 | 400 字段无效；404 provider 缺失；409 模型重复 |
| `PUT, DELETE /api/custom-models/{id}` | 编辑或删除一个自定义模型 | 400 id/字段无效；404 未找到；409 模型重复 |
| `GET, PUT /api/selected-models` | 读取 provider 允许列表和可用性，或替换一个允许列表 | 400 缺少 provider/请求体；404 未知 provider; PUT 409 `initial_model_selection_pending` |
| `GET, PUT /api/model-presets` | 读取预设信息或选择 preset/all/custom 模式 | 400 模式无效或不支持该预设；404 未知提供者; PUT 409 `initial_model_selection_pending` |

手动模型会替换 Models 仪表板中 provider 和 model ID 相同的行。OpenAI 手动行保留 `openai/<model>`，并支持可见性控制。删除手动行后，不带账户限定符的原生行会恢复。带账户限定符的原生行仍单独保留。原生路由和账户权限不会改变。非原生 OpenAI 可见性目标必须匹配已配置的手动模型。


可靠的初始模型列表尚未确认时，有效的 `PUT /api/selected-models` 和 `PUT /api/model-presets` 请求也会返回 HTTP 409 和代码 `initial_model_selection_pending`。请使用 `GET /api/models` 等方式刷新模型列表，成功后再重试。

### OAuth 账户、provider 密钥和数据平面密钥

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/oauth/providers` | 列出带公共 OAuth 登录流程的 provider | — |
| `GET /api/key-providers` | 列出通过 API key 登录配置的 provider | — |
| `POST /api/oauth/login` | 启动 OAuth 登录或添加账户流程 | 400 provider 未知/无效；`oauth_mutation_busy` |
| `POST /api/oauth/login/code` | 提交手动回调 URL 或授权码 | 400 provider/代码无效；`oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | 取消一个公开进行中的 OAuth 流程 | 400 provider 未知 |
| `GET /api/oauth/status` | 轮询某个 provider 的 OAuth 流程 | 400 provider 未知 |
| `POST /api/oauth/logout` | 移除选定的 provider 凭证 | 400 provider 未知；`oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | 列出已脱敏账户或移除一个账户 | 400 provider/id 无效；404 账户缺失；`oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | 选择当前活跃的 OAuth 账户 | 400 provider/账户无效；`oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | 读取或更新 Anthropic OAuth 池策略 | 400 非 Anthropic provider 或策略无效 |
| `POST /api/oauth/accounts/clear-cooldown` | 清除一个 OAuth 账户的运行时冷却 | 400 provider/账户无效 |
| `PUT /api/oauth/accounts/alias` | 设置或清除 OAuth 账户别名 | 400 provider/账户/别名无效 |
| `GET, POST, DELETE /api/providers/keys` | 列出已脱敏的 provider 密钥，添加/激活一个，或移除一个 | 400 输入无效；404 provider/密钥缺失 |
| `PUT /api/providers/keys/active` | 选择某个 provider 的活跃密钥 | 400 输入无效；404 provider/密钥缺失 |
| `PUT /api/providers/keys/alias` | 设置或清除 provider 密钥别名 | 400 输入无效；404 provider/密钥缺失 |
| `GET, POST, PATCH, DELETE /api/keys` | 列出、创建、编辑或删除数据平面准入密钥 | 400 请求体/id 无效；404 密钥缺失 |

凭证列表响应会刻意脱敏。OAuth 访问令牌和完整的 provider API 密钥不会返回给仪表板客户端。

### Providers

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/providers` | 列出已脱敏的 provider 配置和发现状态 | — |
| `POST /api/providers` | 添加或替换一个已验证的 provider，并可选地将其设为默认 | 400 目标或配置无效/危险；409 命名空间冲突 |
| `PATCH /api/providers?name=...` | 更新允许的 provider 字段（包括合并的 `headers` 块）、启用/默认状态，或 OpenAI 账户模式 | 400 字段或转换无效；404 未知 provider |
| `DELETE /api/providers?name=...` | 删除一个 provider，并在可能时重新分配默认值 | 404 未知 provider；409 `last_provider`；409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | 执行一个有上限的在线 provider 连通性/模型发现探测 | 404 未知 provider；失败通常以 `ok: false` 证据返回 |
| `GET /api/provider-quotas` | 读取 provider 配额报告；`refresh=1` 会强制刷新 | — |
| `GET, PUT /api/provider-context-caps` | 读取或更新全局、全部 provider，或单个 provider 的上下文上限 | 400 请求无效；404 未知 provider |
| `GET /api/provider-presets` | 返回从运行时注册表派生的 GUI provider 预设 | — |

上下文上限响应包含 `caps`（当前有效的上限）和 `values`（关闭后仍保留的最后选择值）。
开启提供商的上限时，如果未指定 `value`，则恢复其选择值；首次开启时使用全局 `contextCapValue`。
OpenAI 也遵循此规则：开关不会选择特殊的 922k 模式。有效上限约束每个原生窗口；支持长上下文的模型
只能扩展到该模型支持的上限。
`{ "value": 600000, "setAll": true }` 修改全局值，并且只更新已开启的上限；上限已关闭的提供商保留
自己的选择值，供之后开启时恢复。不带 `value` 的 `{ "setAll": true }` 会按当前全局值开启所有
已配置提供商的上限，并替换保存的选择值。关闭上限不会清除选择值，重新加载后仍保留，但不会将其作为限制应用。

`provider_has_dependent_combos` 是一个安全屏障：在删除 provider 之前，先移除或编辑依赖它的 combos。

### 侧边栏与基于同意的动作

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/github/star` | 通过用户的 `gh` 会话读取仓库星标状态 | 与状态相关的固定结果代码 |
| `POST /api/github/star` | 仅允许来自经过身份验证的人类操作来给仓库加星 | 对缺少仪表板会话证据的 agent 驱动调用返回 403 `agent_consent_required` |
| `GET /api/update/badge` | 直接读取缓存的包更新徽标，不查询注册表；缓存缺失、通道不匹配或已达 40 小时时返回 `unknown: true`。`surface=desktop&session=<id>` 只读取该桌面应用会话。 | 400 无效 surface；桌面会话缺失或过期时返回 `unknown: true` |
| `POST /api/update/desktop-snapshot` | 桌面 shell 通过已绑定的代理客户端发布 Tauri 更新器的显示状态 | 存在 `Origin` 标头或不是原始 `admin-token` principal 时返回 403；字段无效时返回 400；超过 1 KiB 时返回 413 |

桌面 snapshot 是临时显示状态，不是安装请求。代理最多在内存中保存 32 个会话，并在最后一次 heartbeat 后 180 秒使会话过期。未指定 surface=desktop 的普通浏览器仍读取包更新徽标。

对于符合条件的软件包安装，代理在启动后发现缓存缺失或超过 20 小时时会检查更新，之后每小时检查缓存是否过期。`OCX_DISABLE_UPDATE_CHECK=1` 仅禁用自动检查；显式检查和运行请求仍可使用。

:::caution
管理身份验证只能证明对代理的访问权限；它不能证明用户同意消耗自己的身份。agent 不得绕过 `agent_consent_required`。是否给仓库加星，应由用户自行决定。
:::

### 系统生命周期

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/system/memory` | 返回标量级的进程、堆、流、响应状态、看门狗和活跃回合指标 | — |
| `POST /api/system/restart` | 在不移除客户端注入的情况下，开始一次考虑排空的进程重启 | 返回 202；重复调用会报告现有排空 |
| `POST /api/stop` | 停止服务、恢复原生 Codex、移除受管 Grok 注入并排空代理 | 409 服务所有权冲突；当 Windows 任务计划程序包装器可能重新拉起代理且调用方不是 `ocx stop` 时返回 409 `respawnable_service`（不会做任何更改）；已安装的管理器拒绝停止时返回 409；无法读取任务计划程序状态时返回 409 `service_state_unknown`（不会做任何更改；修复查询后重试） |

### Codex 身份验证委托

`GET /api/settings` 会返回实际生效的 `codexAccountPickerEnabled` 布尔值。包含该严格布尔值的
`PUT` 在启用空映射时会初始化保护隐私的账号 selector；禁用或再次启用时会保留已有标签。配置
会先持久化，仅当 picker 的实际可见性发生变化时才请求一次有界 catalog convergence。成功响应
中的 `catalogRefreshPending` 为 `false` 表示目录提交已完成（或无需刷新）；为 `true` 表示设置已
保存，但应通过 `POST /api/sync` 重试目录刷新。持久化或 selector 分配失败时会回滚内存设置，且
不会运行 convergence。

根管理分发器会将每个 `/api/codex-auth/*` 请求委托给 Codex 账户管理器。其路由如下：

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | 列出/刷新或删除 Codex 账户。POST 仅作为已禁用的兼容端点保留；成功的 DELETE 响应包含 `catalogRefreshPending`。 | POST 始终返回 403 `manual_import_disabled`；DELETE 输入无效时返回 400 |
| `PUT /api/codex-auth/accounts/alias` | 设置或清除账户别名 | 400 账户/别名无效 |
| `PUT /api/codex-auth/accounts/pause` | 暂停或恢复一个账户 | 400 账户/状态无效；404 缺少账户 |
| `PUT /api/codex-auth/accounts/pause-exhausted` | 暂停配额已耗尽的账户 | 变更锁失败会变成 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | 清除一个账户或所有账户的运行时冷却 | 400 id 无效 |
| `GET, PUT /api/codex-auth/active` | 读取或选择当前活跃账户 | 400 账户无效或缺失；409 暂停/旧行冲突 |
| `PUT /api/codex-auth/auto-switch` | 使用不含 `id` 的 `{ threshold }` 设置全局阈值，或使用 `{ id, threshold }` 设置账号覆盖值；`id: '__main__'` 选择 Codex Desktop 账号。指定 `id` 时，`threshold: null` 删除该账号的覆盖值并恢复继承全局阈值 | 400 ID/阈值无效；404 账号不存在 |
| `PUT, PATCH /api/codex-auth/pool-strategy` | 更新 Codex 账户池选择策略 | 400 策略/配置无效 |
| `PUT /api/codex-auth/failover` | 设置账户故障转移阈值 | 400 阈值无效 |
| `GET /api/codex-auth/quota` | 按账户读取缓存的配额状态 | — |
| `GET /api/codex-auth/reset-credits` | 检查某个账户是否具备 reset-credit 资格 | 400 缺少账户 id；上游状态透传；500 查询失败 |
| `POST /api/codex-auth/reset-credits/consume` | 消耗一个符合条件的 reset credit。可选的 `operationId`（UUIDv4）让兑换具备幂等性：相同 id 会重放同一条持久化结果，而不会再消耗一个 credit。 | 400 缺少账户 id 或无效的 `operationId`；若该 id 属于其他账户则 409 `identity_mismatch`；上游状态透传；503 `server_busy`、`capacity` 或 `unavailable`；500 消耗失败 |
| `POST /api/codex-auth/login` | 启动 Codex 登录或重新认证 | 400 请求无效；登录状态冲突/忙碌 |
| `POST /api/codex-auth/login/code` | 为 Codex 登录流程提交手动代码 | 400 流程/代码无效 |
| `POST /api/codex-auth/login/cancel` | 仅取消 `{ "flowId": "..." }` 指定的待处理 Codex 登录 | 400 流程 ID 缺失、未知或不在待处理状态 |
| `GET /api/codex-auth/login-status` | 轮询某个流程或账户登录状态。新账号流程完成时，仅在需要恢复时包含 `catalogRefreshPending: true`。 | 未知流程报告为 `expired`；没有活跃流程时报告为 `idle` |

如果新账号的 config row 已保存但 credential setup 未能完成，OAuth `login-status` 会报告
`status: "error"`，并包含
`code: "codex_credential_persistence_failed"`、`accountId`、`needsReauth: true`，并在需要时包含
`catalogRefreshPending: true`；底层 storage error 详情不会暴露。account row 会保持已保存状态；再次
创建账号前，请重新认证或删除该账号。

此委托家族下的配置写入器或凭证刷新锁超时，会返回 HTTP 503，代码为 `CONFIG_MUTATION_LOCK_UNAVAILABLE`。客户端应稍后重试，而不是把该响应视为永久性的账户失败。

账号创建和删除会在 catalog convergence 之前提交凭证/配置。目录尝试失败或推迟时，持久化的
账号变更不会回滚，响应也不会暴露内部 provider、account、path 或 credential 详情；客户端只会
收到完成状态布尔值。删除账号时会保留 selector 绑定，因此该账号缺失期间精确路由会 fail closed，
而以后添加相同账号 id 时会恢复同一 selector。

## 如何选择客户端

对于日常管理，[Web 仪表板](/guides/web-dashboard/)提供了最安全的引导式流程。对于无头主机和自动化，请使用相应的 `ocx` 命令：它们调用的是同一个实时 API，并在代理不可达或操作失败时返回非零结果。直接 HTTP 最适合需要上述精确端点契约的集成。

## 远程会话与数据密钥轮换

`POST /api/keys/rotate {id}` 开始十分钟重叠期，并只返回一次新密钥。`POST /api/keys/rotate/commit {id,rotationId}` 提交，`DELETE /api/keys/rotate {id,rotationId}` 中止。它们都需要管理认证，数据密钥不能调用。`POST /api/session/logout` 需要当前 `gui-session`、匹配的 Origin 和 CSRF。Admin token 会收到 403，永远不能创建用户同意会话。
