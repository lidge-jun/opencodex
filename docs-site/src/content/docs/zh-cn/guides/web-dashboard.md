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

## 可以完成哪些操作

| 区域 | 作用 |
| --- | --- |
| **Dashboard 摘要** | 显示 multi-agent 模式、在线状态、版本、运行时间、provider 数量、30 天 token 总量、活动 provider 和可用的原生/路由模型。 |
| **Sub-agent delegation** | 为 v1 委派 prompt 选择原生或路由模型，并可指定 reasoning 强度。它不是逐次生成的路由器，详见下文。 |
| **Sidecar** | 选择 web-search 模型及强度，以及图像描述模型；更改从下一次请求开始生效。 |
| **Maintenance** | 重新同步 Codex 模型目录，查看项目级配置绕过警告，检查 latest/preview 版本，并可在更新后重启代理。 |
| **启动安全** | 显示注入的 Codex 路由能否在重启后继续工作，并分别显示服务、launcher shim 状态和准确的修复命令。 |
| **Windows 托盘** | 安装用户登录托盘，一键控制代理启动、停止、重启、面板和状态。托盘不是代理重启服务。 |
| **Codex 自动启动** | 允许已安装的 Codex launcher shim 运行 `ocx ensure`。此开关不会安装 shim 或后台服务。 |
| **Providers** | 添加、编辑、启用/禁用、删除 provider，并在支持时管理 OAuth 账号池和 API key 池。 |
| **Add provider** | 搜索 registry preset，选择账号登录、API key 服务、本地服务器或自定义 endpoint。 |
| **Codex Auth** | 添加 ChatGPT/Codex 池账号，选择下一 session 的账号，刷新 5h / 每周 / 30d 配额，启用或停用配额自动切换，设置其 1–100% 阈值和临时故障 failover。 |
| **Subagents** | 在 `spawn_agent` override 列表中置顶最多五个原生或路由模型。 |
| **Models** | 开关原生 GPT 与路由模型，配置 provider allowlist、上下文上限、v1/base/v2 以及 v2 thread 数量。 |
| **Logs** | 自动刷新近期请求，显示 token、请求强度、实际模型、provider、状态、request id、耗时和错误详情。 |
| **Usage / Debug** | 查看 token usage 覆盖率与趋势，或启用可选的 provider transport 和 usage 提取诊断。 |
| **Stop** | 优雅地停止代理和已安装的后台服务，恢复原生 Codex 并退出（`POST /api/stop`）。 |

**Logs** 和 **Usage** 中的费用是根据已报告 token 计算的 API 标价折算值，不是账单，也不能证明
实际发生了扣费；实际可能计入订阅用量或消耗服务商额度。

## 委派选择器与生成路由的区别

Dashboard 的 **Sub-agent delegation** 选择器会保存 `injectionModel`，以及可选的
`injectionEffort`。在 v1 turn 中，opencodex 会注入一段指引，告诉父代理调用 `spawn_agent` 时应
传入哪个精确模型和 reasoning 强度。只要选定模型，无论父代理当前使用何种 reasoning 强度，都会
启用这段指引；清除模型时也会清除已保存的强度。

:::caution
该选择器是面向 v1 兼容界面的委派指引。在 `multi_agent_v2` 中，当前代理不会附加 v1 注入消息，
而且所有生成的子代理都会继承父 session 的模型。它不是代理侧的跨模型路由器。v1/base/v2 的
权威说明见 [子代理界面](/opencodex/zh-cn/guides/sub-agent-surface/)。
:::

选择器会列出已启用的原生与路由模型，以及全局 Codex reasoning 阶梯。API 会先验证所选强度是否
属于全局阶梯；Codex 仍会根据目标目录条目再次校验该 spawn 强度。

## Codex Auth 与账号池

**Codex Auth** 页面用于管理原生 ChatGPT/Codex 路由：

- 手动选择账号会影响下一次新建的 Codex session；已经绑定账号的 thread 不会因为这次手动切换而
  在中途转移。
- Thread affinity 可避免每个请求都来回切换账号。启用配额自动切换后，长时间运行的 thread 会被
  定期重新评估；当相关 usage 达到阈值，并且存在使用率确实更低的可用账号时，该 thread 可能会
  重新绑定。
- 新 session 可以选择 usage 最低的可用账号。付费计划按已知 5h、每周、30d 窗口中的最高使用率
  评分；Go/Free 计划只使用 30d 窗口。
- **Refresh quotas** 会立即重新读取账号 usage，使路由逻辑与页面上的账号卡片使用同一份数据。
- 池账号的请求日志使用 `p3fa91c` 这类不透明标签，不会记录账号邮箱。

## 仪表盘如何与代理通信

GUI 是代理 JSON 管理 API 之上的轻量客户端。常用 endpoint 包括：

| Endpoint | 用途 |
| --- | --- |
| `GET` / `PUT /api/settings` | 读取设置或切换 Codex 自动启动。 |
| `GET /api/startup-health` | 读取不含秘密信息的路由、服务、shim 和重启安全诊断。 |
| `GET` / `POST /api/windows-tray` | 读取或更改 Windows 托盘安装和显示状态；POST 支持 `install`、`start`、`stop`、`uninstall`。 |
| `POST /api/sync` | 重建共享模型目录，并把 Codex 模型缓存标记为过期。 |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | 检查、运行和监控自更新任务。 |
| `GET` / `PUT /api/sidecar-settings` | 读取或设置 search/vision sidecar 模型。 |
| `GET` / `PUT /api/injection-model` | 读取或设置 v1 委派指引模型及可选强度。 |
| `GET` / `PUT /api/v2` | 读取或设置界面模式、Codex feature flag 和 v2 thread 上限。 |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | 列出、添加/替换、启用/禁用或删除 provider。 |
| `GET /api/models` · `PUT /api/disabled-models` | 列出原生/路由模型，并更新共享的 disabled-model 集合。 |
| `GET /api/key-providers` · `GET /api/oauth/providers` | 读取 API key 和 OAuth provider 目录。 |
| `POST /api/oauth/login` · `GET /api/oauth/status` | 启动 provider OAuth 流程并轮询完成状态。 |
| `GET /api/codex-auth/accounts?refresh=1` | 列出主账号与池账号、强制刷新配额，并返回主账号的 `hasCredential` / terminal `needsReauth` 状态。 |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | 选择下一 session 的账号并配置账号池路由。 |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 通过浏览器登录添加池账号。 |
| `GET /api/logs?tail=50&provider=...&status=5xx` | 使用 tail、provider、精确状态码或状态类别筛选近期请求元数据。 |
| `GET` / `PUT /api/subagent-models` | 读取或设置五个置顶的 `spawn_agent` override 模型。 |
| `POST /api/stop` | 停止代理/服务，恢复原生 Codex 并退出。 |

:::tip
从仪表盘添加 **Ollama Cloud** 或其他目录型 provider 时，其文本/视觉模型分类会写入保存的
provider 配置。因此无需手动分类，[vision sidecar](/opencodex/zh-cn/guides/sidecars/) 也能在正确
条件下启用。
:::
