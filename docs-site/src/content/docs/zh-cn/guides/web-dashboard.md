---
title: Web 仪表盘
description: 用于管理代理健康状态、provider、模型、委派指引、认证池、usage 和日志的 opencodex GUI。
---

opencodex 内置了一个由代理提供服务的本地 web 仪表盘（`gui/` 下的 Vite/React 应用）。你可以在
这里快速管理 provider、Codex/ChatGPT 账号、目录模型、sidecar、子代理设置和请求流量。

## 打开仪表盘

```bash
ocx gui
```

该命令会在浏览器中打开 `http://localhost:<port>`；如果代理尚未运行，会先自动启动。开发时也可
让 GUI dev server 单独连接到正在运行的代理：

```bash
ocx start
bun run dev:gui
```

## 登录

通过 `localhost`、`127.0.0.1` 等 loopback 地址打开仪表盘时，它会自动获得一个短期 GUI session，因此通常无需输入 token。在非 loopback 主机上公开仪表盘时，必须使用 `OPENCODEX_ADMIN_AUTH_TOKEN` 或自动生成的 `~/.opencodex/admin-api-token` 文件中的管理员 token。

远程仪表盘会显示标准密码表单，浏览器密码管理器可以提示保存并自动填充 token。仪表盘本身只在内存中保存 token，不会写入 `localStorage` 或 `sessionStorage`；是否持久保存完全由浏览器或密码管理器决定。

## 可以完成哪些操作

| 区域 | 作用 |
| --- | --- |
| **Dashboard 摘要** | 显示 multi-agent 模式、在线状态、版本、运行时间、provider 数量、30 天 token 总量、活动 provider 和可用的原生/路由模型。 |
| **Sub-agent delegation** | 选择供 OpenCodex 委派指引与可选的 Codex 原生子代理默认值共用的原生/路由模型和可选 reasoning 强度。它不是逐次生成的路由器，详见下文。 |
| **Sidecar** | 选择 web-search 模型及强度，以及图像描述模型；更改从下一次请求开始生效。 |
| **Maintenance** | 重新同步 Codex 模型目录，查看项目级配置绕过警告，检查 latest/preview 版本，并可在更新后重启代理。 |
| **启动安全** | 显示注入的 Codex 路由能否在重启后继续工作，并分别显示服务、launcher shim 状态和准确的修复命令。 |
| **Windows 托盘** | 安装用户登录托盘，一键控制代理启动、停止、重启、面板和状态。托盘不是代理重启服务。 |
| **Codex 自动启动** | 允许已安装的 Codex launcher shim 运行 `ocx ensure`。此开关不会安装 shim 或后台服务。 |
| **Providers** | 添加、编辑、设为默认（仅已启用）、启用/禁用、删除 provider，并在支持时管理 OAuth 账号池和 API key 池。删除当前默认时，会切换到剩余的第一个已启用 provider（若存在）；否则拒绝删除并保留当前默认。Claude（Anthropic）OAuth 池中，每个已登录账号显示各自的 5 小时与周限额条（用量按凭证计）；探测失败时保留上次已知数值并标记为暂时不可用。 |
| **Add provider** | 搜索 registry preset，选择账号登录、API key 服务、本地服务器或自定义 endpoint。 |
| **Codex Auth** | 添加 ChatGPT/Codex 池账号，选择下一 session 的账号，刷新 5h / 每周 / 30d 配额，启用或停用配额自动切换，设置其 1–100% 阈值和临时故障 failover。 |
| **Subagents** | 在 `spawn_agent` override 列表中置顶最多五个原生或路由模型。 |
| **Models** | 开关原生 GPT 与路由模型，配置 provider allowlist、上下文上限、v1/base/v2 以及 v2 thread 数量。 |
| **Logs** | 自动刷新近期请求，显示 token、请求强度以及（可用时）实际发送强度、实际模型、provider、状态、request id、耗时和错误详情。适配器发送 reasoning 参数时，详情中还会显示准确的 wire field。可按不透明会话/对话 ID（客户端提供时）筛选，并对当前已加载的 Logs 环形缓冲合计 token 与估算标价成本。 |
| **Usage / Debug** | 查看 token usage 覆盖率与趋势，或启用可选的 provider transport 和 usage 提取诊断。 |
| **Storage** | 只读查看 CODEX_HOME 磁盘占用（会话、归档、数据库、附件）。可选归档清理：预览最旧 N%，默认隔离到 `CODEX_HOME/.trash`，或勾选后永久删除。**自动清理策略**为可选且**默认关闭**（`storageCleanupPolicy.enabled`）；可在 Storage 页配置阈值/目标/计划/模式，或点「立即运行」。可在 Storage 页从隔离区恢复（JSONL + 线程）。活动会话保持只读。Codex 锁定最新/活动的 `state_*.sqlite` 时拒绝清理与恢复。 |
| **Stop** | 优雅地停止代理和已安装的后台服务，恢复原生 Codex 并退出（`POST /api/stop`）。 |

### 链接到某个部分

布局只有一种，无需切换。Dashboard 的各个部分都有自己的地址：`#dashboard` 打开 Overview，`#dashboard/providers` 与 `#dashboard/models` 打开另外两个。刷新、收藏和后退都会保留当前所在的部分。**Logs** 同理，使用 `#logs` 与 `#logs/debug`。旧的 `#providers/workspace` 书签现在会跳转到 `#providers`。

**Logs** 和 **Usage** 中的费用是根据已报告 token 计算的 API 标价折算值，不是账单，也不能证明
实际发生了扣费；实际可能计入订阅用量或消耗服务商额度。

## 模型可见性

**Models** 开关表示 Codex 中的最终可见状态。路由模型只有在 provider allowlist 中（或未设置 allowlist）且未被禁用时才会开启。开启模型会原子地协调两个过滤条件；**全部开启** 会清除 allowlist，因此以后新发现的模型也会开启。

## 委派选择器与生成路由的区别

Dashboard 的 **Sub-agent delegation** 选择器会保存 `injectionModel`，以及可选的
`injectionEffort`。所选值会用于由 OpenCodex 编写的委派指引，而该指引由
`multiAgentGuidanceEnabled` 单独控制。清除模型时也会清除已保存的强度，并关闭原生默认值同步。

启用 **用作原生 Codex 子代理默认值** 后，当 OpenCodex 管理当前 Codex 路由时，下一次同步或重启会
把所选模型和强度应用为原生 `[agents]` 默认值；外部用户管理的 provider 配置不会被修改。这些默认值只影响新建的 Codex 任务，该选项本身不会触发委派。已有的用户自有
`[agents]` 默认值会保留而不会被覆盖，因此请求的默认值可能与 Codex 实际使用的默认值不同。

:::caution
两个开关相互独立：关闭 OpenCodex 委派指引不会关闭原生默认值同步；启用原生默认值同步也不会
启用委派指引或触发委派。两者都不是代理侧的逐次跨模型路由器。v1/base/v2 的
权威说明见 [子代理界面](/zh-cn/guides/sub-agent-surface/)。
:::

选择器会列出已启用的原生与路由模型，以及全局 Codex reasoning 阶梯。API 会先验证所选强度是否
属于全局阶梯；Codex 仍会根据目标目录条目再次校验该 spawn 强度。

<a id="codex-auth-and-account-pools"></a>

## Codex Auth 与账号池

**Codex Auth** 页面用于管理原生 ChatGPT/Codex 路由：

Pool 模式会在主账号和已添加的 Codex 账号之间选择；Direct 只使用调用者或主登录账号。进行中的请求会保留已获取的凭据，而 401/403 重新认证或 429 cooldown 可能清除亲和性并轮换到另一个合格的 Pool 账号。这与 `openai-apikey` 及其他 provider 相互独立。

- 手动选择账号会立即生效：已经绑定账号的 thread 会在下一次请求时切换到所选账号，只有已经在传输中的
  请求会继续使用它们捕获的账号。手动选择的账号还会被固定：卡片上会出现 **已固定** 徽章，在该账号被耗尽、你改选
  其他账号，或你改动任意账号的选择顺序之前，更高的选择顺序都无法抢占它。
- 每张账号卡片都带有 **选择顺序** 控件（最先 / 较先 / 默认 / 较后 / 最后）。顺序靠前的账号先被使用，
  只有当它上面的账号全部耗尽或不可用时才会降到更靠后的顺序。改动顺序会从**下一个未绑定请求**起生效，
  且不会移动已经绑定的 thread。Codex Desktop（主）账号同样参与排序，可以设为 **最后** 留作备用。
  用 `ocx account priority` 设置的非预设值也会保留在卡片上，仍可选择。
- Thread affinity 可避免每个请求都来回切换账号。启用配额自动切换后，长时间运行的 thread 会被
  定期重新评估；当相关 usage 达到阈值，并且存在使用率确实更低的可用账号时，该 thread 可能会
  重新绑定。
- 新 session 可以选择 usage 最低的可用账号。付费计划按已知 5h、每周、30d 窗口中的最高使用率
  评分；Go/Free 计划只使用 30d 窗口。
- **Refresh quotas** 会立即重新读取账号 usage，使路由逻辑与页面上的账号卡片使用同一份数据。
- 池账号的请求日志使用 `p3fa91c` 这类不透明标签，不会记录账号邮箱。
- **从模型选择器指定 Codex 账号** 是一项显式选择加入的设置。启用后，普通 GPT picker 条目会
  替换为每个公开账号 selector 对应的条目。选择其中一项会把该对话锁定到映射账号：不会轮换、
  fallback，也不会更改活跃 Pool 账号。内置 Codex App 登录有自己的 selector；生成的 map 通常
  使用 `main`，发生冲突时会使用 `main-2` 这类安全后缀。新增账号会获得稳定且保护隐私的标签，
  已有自定义 selector 标签则会保留。现有对话和已保存的模型选择会
  继续路由。关闭此设置只会隐藏生成的 picker 项，不会删除账号、selector 或精确路由；普通 GPT
  model id 继续使用已配置的 Pool 或 Direct 行为。
- 添加、删除账号或更改 picker 设置时，会先保存变更再刷新模型目录。如果有界刷新未完成，
  仪表盘会显示琥珀色的“成功但需要恢复”提示；运行 `ocx sync` 即可重试。账号或设置变更本身
  仍已保存。

Providers 概览会单独汇总 Pool 模式的显示专用加权容量估算，并同时显示当前有效账户的原始配额和
下一次容量恢复。可见字段、覆盖不完整的含义以及路由边界，请参阅
[提供商概览中的账户池容量](/zh-cn/guides/providers/#提供商概览中的账户池容量)。

## 仪表盘如何与代理通信

GUI 是代理 JSON 管理 API 之上的轻量客户端。常用 endpoint 包括：

| Endpoint | 用途 |
| --- | --- |
| `GET` / `PUT /api/settings` | 读取设置，或更新 Codex 自动启动、流/内存设置以及账号定向 picker 的可见性。 |
| `GET /api/startup-health` | 读取不含秘密信息的路由、服务、shim 和重启安全诊断。 |
| `GET` / `POST /api/windows-tray` | 读取或更改 Windows 托盘安装和显示状态；POST 支持 `install`、`start`、`stop`、`uninstall`。 |
| `POST /api/sync` | 重建共享模型目录，并把 Codex 模型缓存标记为过期。 |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | 检查、运行和监控自更新任务。 |
| `GET` / `PUT /api/sidecar-settings` | 读取或设置 search/vision sidecar 模型。 |
| `GET` / `PUT /api/injection-model` | 读取或设置委派指引模型/强度、指引开关及 Codex 原生子代理默认值同步开关。 |
| `GET` / `PUT /api/v2` | 读取或设置界面模式、Codex feature flag 和 v2 thread 上限。 |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | 列出、添加/替换、启用/禁用、设为默认或删除 provider。`PATCH` 用单独的 `{ "setDefault": true }`（仅已启用）；`POST` 创建/替换时也可带 `setDefault`（同样仅已启用）。删除当前默认时，会改派到剩余的第一个已启用 provider（若存在）；否则返回 `409`（`code: "last_provider"`）并保留当前默认。 |
| `GET /api/models` · `PUT /api/disabled-models` | 列出原生/路由模型，并更新共享的 disabled-model 集合。 |
| `GET /api/selected-models` · `PUT /api/model-visibility` | 读取 provider allowlist，并原子地更改单个模型或 provider 分组的最终可见状态。 |
| `GET /api/key-providers` · `GET /api/oauth/providers` | 读取 API key 和 OAuth provider 目录。 |
| `POST /api/oauth/login` · `GET /api/oauth/status` | 启动 provider OAuth 流程并轮询完成状态。 |
| `GET /api/codex-auth/accounts?refresh=1` | 列出主账号与池账号、强制刷新配额，并返回主账号的 `hasCredential` / terminal `needsReauth` 状态。 |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | 选择下一次请求使用的账号并配置账号池路由。 |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | 读取实际生效的账号（含表示是否固定的 `pinned` 和指明被固定账号的 `pinnedAccountId`），并设置单个账号的选择顺序。 |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 通过浏览器登录添加池账号。 |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | 使用 tail、provider、精确状态码或状态类别筛选近期请求元数据。`limit`/`offset` 从最新一行向前分页（`offset=0` 为最新一页）。响应为 `{ timeZone, total, logs }`，其中 `total` 为分页前的匹配行数。 |
| `GET` / `PUT /api/subagent-models` | 读取或设置五个置顶的 `spawn_agent` override 模型。 |
| `POST /api/stop` | 停止代理/服务，恢复原生 Codex 并退出。 |

:::tip
从仪表盘添加 **Ollama Cloud** 或其他目录型 provider 时，其文本/视觉模型分类会写入保存的
provider 配置。因此无需手动分类，[vision sidecar](/zh-cn/guides/sidecars/) 也能在正确
条件下启用。
:::
