---
title: Web 仪表盘
description: opencodex 的 GUI——proxy 状态、提供商管理、模型选择器和请求日志。
---

opencodex 内置了一个本地 web 仪表盘（位于 `gui/` 下的 Vite/React 应用），由 proxy 提供服务。这是添加提供商、用 OAuth 登录、选择 subagent 模型以及观察流量的最简便方式。

## 打开它

```bash
ocx gui
```

这会在你的浏览器中打开 `http://localhost:<port>`（如有需要会先自动启动 proxy）。在开发环境中，你可以针对正在运行的 proxy 单独运行 GUI 开发服务器：

```bash
ocx start
bun run dev:gui
```

## 你可以做什么

| 区域 | 作用 |
| --- | --- |
| **Status** | 实时的 proxy 状态、端口、运行时长和 PID。 |
| **Providers** | 添加、编辑、启用/禁用以及移除提供商。 |
| **Add provider** | 一个可搜索的预设选择器——OAuth 登录（xAI / Anthropic / Kimi）、ChatGPT forward、API 密钥目录（含 Ollama Cloud）、本地服务器以及 Custom。 |
| **OAuth login** | 打开提供商的认证页面并轮询，直到令牌到位；或导入已有的本地 CLI/钥匙串令牌。 |
| **Subagent models** | 选择 Codex 的 `spawn_agent` 所展示的 ≤5 个路由模型。 |
| **Models** | 启用/禁用单个路由模型（被隐藏的模型会从目录和 `/v1/models` 中排除）。 |
| **Multi-agent mode** | Models 页面上的三段选择器（All v1 / Default / All v2），用于强制所有模型的 multi-agent surface。Default 会遵循 upstream pins（sol/terra=v2,luna=v1）。 |
| **Request log** | 自动刷新的近期请求视图（模型、提供商、状态）。 |
| **Stop** | 侧栏按钮，可一键优雅地关闭 proxy、停止后台服务（如已安装）并恢复原生 Codex（`POST /api/stop`）。 |

## 仪表盘如何与 proxy 通信

GUI 是 proxy 管理 API 之上的一个轻量客户端。常用端点（均为 JSON）：

| 端点 | 用途 |
| --- | --- |
| `GET /api/providers` | 列出已配置的提供商。 |
| `POST /api/providers` | 添加或覆盖一个提供商（目录条目会自动附带其模型分类信息）。 |
| `DELETE /api/providers?name=…` | 移除一个提供商。 |
| `GET /api/key-providers` | API 密钥目录（含 Ollama Cloud）。 |
| `GET /api/oauth/providers` | 哪些提供商支持 OAuth 登录。 |
| `POST /api/oauth/login` · `GET /api/oauth/status` | 启动一次 OAuth 流程并轮询其完成情况。 |
| `GET` / `PUT /api/subagent-models` | 读取 / 设置置顶的 subagent 模型。 |
| `POST /api/stop` | 优雅地停止 proxy（以及已安装的后台服务），恢复原生 Codex，然后退出。 |

:::tip
从仪表盘添加 **Ollama Cloud**（或任何目录提供商）时，会自动将其文本与视觉模型分类信息复制到你的配置中，因此 [vision sidecar](/opencodex/zh-cn/guides/sidecars/) 会被正确地按条件启用，无需任何手动设置。
:::
