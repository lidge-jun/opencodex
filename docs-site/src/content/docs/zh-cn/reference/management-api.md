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
| `GET, PUT /api/claude-desktop` | 读取或持久化 Claude Desktop 的路由/原生配置文件 | 400 分配无效或不可用 |
| `POST /api/claude-desktop/apply` | 将已保存的配置文件写入 Claude Desktop 的托管配置 | 400/500 写入失败 |
| `GET /api/claude-desktop/status` | 检查已保存与已应用的配置文件以及 Desktop 健康状态 | 400 状态读取失败 |
| `GET, PUT /api/claude-code` | 读取或更新 Claude Code 的网关、认证模式、模型映射、上下文、代理和 sidecar 设置 | 400 字段或结构无效 |

关于模型名录和加密工作任务行为的概念，请参见 [子代理界面](/guides/sub-agent-surface/)。

### Combos

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/combos` | 列出规范化的 combo 及其公开模型 id | 目录工作可能返回 `catalog_busy` |
| `PUT /api/combos` | 创建、替换或重命名一个 combo | 400 id、目标、配置、重命名或常规冲突无效；409 Codex 账户命名空间冲突 |
| `DELETE /api/combos?id=...` | 删除一个 combo，并清除其选择/冷却状态 | 400 缺少 id；404 未知 combo |

关于目标策略、冷却、别名和路由失败，请参见 [Combos](/guides/combos/)。

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
| `GET /api/update/check` | 检查 `latest` 或 `preview` 更新通道 | 400 无效标签 |
| `POST /api/update/run` | 启动更新任务，可选随后重启 | 400 无效请求体；任务特定的冲突/错误状态 |
| `GET /api/update/status` | 按 id 轮询更新任务 | 404 未知任务 |
| `GET, PUT /api/sidecar-settings` | 读取或更新 web 搜索和 vision sidecar 的模型/后端设置 | 400 结构、后端或限制无效 |
| `GET, PUT /api/shadow-call-settings` | 读取或更新 shadow-call 拦截设置 | 400 结构或值无效 |

### 日志、使用情况和存储

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/logs` | 查询经过过滤的内存请求日志 | — |
| `GET, PUT /api/debug` | 读取调试标志；设置、清除或重置捕获类别 | 400 无效或空更新 |
| `GET /api/debug/logs` | 读取有上限的 provider/debug 日志条目 | — |
| `GET /api/debug/usage-logs` | 读取有上限的 usage-debug 条目 | — |
| `GET /api/debug/injection-logs` | 读取有上限的 guidance-injection 调试条目 | — |
| `GET /api/claude/inbound-debug` | 读取 Claude 入站调试状态和条目 | — |
| `GET /api/usage` | 按范围和客户端界面汇总使用情况 | 若无法读取存储，则返回带有 `error: "read_failed"` 的摘要 |
| `GET /api/storage` | 按桶扫描 Codex 存储使用情况 | 扫描失败时返回带有 `error: "scan_failed"` 的载荷 |
| `POST /api/storage/cleanup/preview` | 预览已归档会话清理并返回绑定摘要 | 400 `invalid_json` 或 `invalid_percent` |
| `POST /api/storage/cleanup` | 隔离或永久移除预览出的归档集合 | 400 输入无效；409 过期/忙碌/被引用状态；500 文件系统/数据库失败 |
| `GET /api/storage/trash` | 列出已隔离的清理条目 | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | 恢复一个已隔离条目 | 400 无效 id；404 缺少 trash；409 忙碌/目标冲突；500 恢复失败 |
| `GET /api/storage/trash/restore/test-stream` | 仅测试用的恢复流钩子 | 测试钩子关闭时返回 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | 读取或更新计划清理策略和作业状态 | 400 策略无效 |
| `POST /api/storage/cleanup-policy/run` | 启动一次手动清理策略运行 | 409 `already_running`；500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | 仅测试用的策略流钩子 | 不可用时返回 404 `not_found` |

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
| `PUT /api/model-visibility` | 原子性地更改 provider 级或 model 级可见性 | 400 provider、scope、target 或请求体无效 |
| `GET, POST /api/custom-models` | 列出自定义模型或添加一个 | 400 字段无效；404 provider 缺失；409 模型重复 |
| `PUT, DELETE /api/custom-models/{id}` | 编辑或删除一个自定义模型 | 400 id/字段无效；404 未找到；409 模型重复 |
| `GET, PUT /api/selected-models` | 读取 provider 允许列表和可用性，或替换一个允许列表 | 400 缺少 provider/请求体；404 未知 provider |

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

`provider_has_dependent_combos` 是一个安全屏障：在删除 provider 之前，先移除或编辑依赖它的 combos。

### 侧边栏与基于同意的动作

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/github/star` | 通过用户的 `gh` 会话读取仓库星标状态 | 与状态相关的固定结果代码 |
| `POST /api/github/star` | 仅允许来自经过身份验证的人类操作来给仓库加星 | 对缺少仪表板会话证据的 agent 驱动调用返回 403 `agent_consent_required` |
| `GET /api/update/badge` | 读取便宜的侧边栏更新徽标状态 | — |

:::caution
管理身份验证只能证明对代理的访问权限；它不能证明用户同意消耗自己的身份。agent 不得绕过 `agent_consent_required`。是否给仓库加星，应由用户自行决定。
:::

### 系统生命周期

| 方法和路径 | 用途 | 典型错误 |
| --- | --- | --- |
| `GET /api/system/memory` | 返回标量级的进程、堆、流、响应状态、看门狗和活跃回合指标 | — |
| `POST /api/system/restart` | 在不移除客户端注入的情况下，开始一次考虑排空的进程重启 | 返回 202；重复调用会报告现有排空 |
| `POST /api/stop` | 停止服务、恢复原生 Codex、移除受管 Grok 注入并排空代理 | 409 服务所有权冲突 |

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
| `PUT /api/codex-auth/auto-switch` | 设置自动切换账户的配额阈值 | 400 阈值无效 |
| `PUT, PATCH /api/codex-auth/pool-strategy` | 更新 Codex 账户池选择策略 | 400 策略/配置无效 |
| `PUT /api/codex-auth/failover` | 设置账户故障转移阈值 | 400 阈值无效 |
| `GET /api/codex-auth/quota` | 按账户读取缓存的配额状态 | — |
| `GET /api/codex-auth/reset-credits` | 检查某个账户是否具备 reset-credit 资格 | 400 缺少账户 id；上游状态透传；500 查询失败 |
| `POST /api/codex-auth/reset-credits/consume` | 消耗一个符合条件的 reset credit | 400 缺少账户 id；上游状态透传；503 `server_busy`；500 消耗失败 |
| `POST /api/codex-auth/login` | 启动 Codex 登录或重新认证 | 400 请求无效；登录状态冲突/忙碌 |
| `POST /api/codex-auth/login/code` | 为 Codex 登录流程提交手动代码 | 400 流程/代码无效 |
| `POST /api/codex-auth/login/cancel` | 取消一个 Codex 登录流程 | — |
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
