---
title: 原生上下文兼容性
description: Codex 历史记录与笔记中继的使用资格、认证试用配置及限制。
---

OpenCodex 已经中继原生 Codex 历史记录和笔记。这不是面向路由 provider 的通用记忆服务；公开其 HTTP 端点，也不意味着某个特定的 Codex 构建、账户或模型能够使用它们。中继的归属、取消和凭据边界见 [Codex 集成](/zh-cn/guides/codex-integration/)。

## 两项独立要求

Codex 必须激活该扩展，OpenCodex 也必须识别调用方。单独修改后端 URL 无法满足任一要求。

已检查的上游 Codex 契约要求：模型的原生目录条目声明 `supports_experimental_context`、ChatGPT 登录符合条件，以及名为 `OpenAI` 且 base URL 以 `/backend-api/codex` 结尾的 provider。自动激活会拒绝使用 `env_key`、`experimental_bearer_token`、命令式 `auth` 或 AWS auth 的 provider。已检查的资格条件接受 ChatGPT Plus、Pro 和 ProLite，但这不表示这些方案的每个账户都拥有可用的后端历史记录端点。

OpenCodex 还要求成功的模型请求和后续上下文请求都携带有效的**数据面 API key**。默认内置的 loopback 注入不会发送该 key，因此模型可能正常使用，但上下文调用会以 `context_principal_required`（403）失败。仅使用经过认证的远程 provider 表形式也无法解决原生上下文问题：其 `env_key` 和 provider 名称不符合上述 Codex 激活契约。不要为了掩盖任一问题而移除调用主体或账户归属检查。

## 明确启用的语法

OpenCodex 接受 Codex 的 `FeatureToml` 支持的两种持久化根级 feature 形式：

```toml
[features]
context_management = true
```

等价的表形式也可用，且兼容尚不识别布尔形式的旧版 OpenCodex：

```toml
[features.context_management]
experimental_mode = true
```

只使用其中一种形式。值为 false、缺失或格式错误时，功能保持关闭。proxy 会读取自己的 Codex home 配置；仅在 CLI 中覆盖，或只在 Codex profile 中启用，都不会打开其运行时门控。这项变更不会根据模型元数据推断是否启用。

## 经过认证的原生试用 profile

这是**经源码核对的试用配置，不是对真实账户端到端能力的认证**。测试前请备份 Codex 配置，并为任务保留持久检查点。使用新的临时线程；不要修改现有正常线程的 provider 身份。

在 Codex 进程的环境中，通过 `OCX_CONTEXT_API_KEY` 提供一个现有且有效的 OpenCodex 数据面 key。不要使用管理 token，也不要把 key 存入 TOML。单独启动的桌面应用不会自动继承服务的环境。保留正常的原生 Codex ChatGPT 登录；附加 header 不能替代 OAuth。

在上面的根级 feature 已启用、OpenCodex 已配置规范的 ChatGPT forward provider，且原生模型目录为当前版本的前提下，将这个**额外的** provider 和 profile 合并进同一份 Codex 配置。将端口调整为实际的本地 proxy 端口。保持根级 `model_provider` 和现有 provider 表不变。

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

使用 `codex --profile ocx-native-context` 启动新的 CLI 线程。示例使用 HTTP/SSE，让首次试用沿着模型到中继的归属路径进行；它不会改变其他 profile 的传输方式，也不证明 WebSocket 或回合中途引导具备相同行为。只有当账户的原生目录确实声明模型具有上下文能力时才使用该模型；不要强行给 Devin、Gemini 或其他路由条目设置此标志。

自定义 provider ID 是有意选择的。上游 Codex 通常不会通过 `model_providers.openai` 覆盖内置 provider；在其中增加 header 可能悄悄失效。自定义 ID 保留正常 provider，而精确的 `OpenAI` 名称满足原生后端的判断条件。不要为此 profile 增加 `env_key`：`env_http_headers` 独立承担本地接入认证，`Authorization` 则继续携带原生 ChatGPT 登录凭据。OpenCodex 会消耗本地 key，不会把它转发到 ChatGPT。

根级启用选项也会影响其他符合条件的原生 profile。**试用期间，不要继续使用缺少附加 key 的普通内置 loopback 线程。** 返回这些线程前，先关闭根级 feature 并运行 `ocx sync`。这不是自动或默认的集成变更；此 CLI profile 也不代表桌面端支持选择 profile。

## 重置上下文前先验证

先在新线程中取得成功的原生模型响应，再写入一条笔记、读回同一条笔记，并查询该线程的历史记录。只有这些操作全部成功后，才应在可丢弃的测试中使用 `new_context`，并检查保存的状态能否恢复。即使试用成功，也要保留外部检查点。

- **403 `context_principal_required`：** 没有有效的本地数据面 key 到达 proxy。
- **409 `context_account_unavailable`：** 归属信息缺失或不一致；不要擅自换成当前活跃账户，也不要盲目重试写入。
- **404：** 区分 proxy 返回的功能关闭／未知端点响应与上游 404。后者不能证明 OpenCodex 路由有缺陷，也不能证明整个账户无法使用该服务。

模型调用成功或 `ocx ready` 成功，都不能证明笔记、历史记录或状态恢复可用。模型路由、账户变更、proxy 重启及上游端点可用性是彼此独立的问题。本地标志无法赋予缺失的后端资格，失败的上下文操作也不能报告为成功重置。完成后移除试用表并取消试用 key；除非使用的是已验证的认证路径，否则保持 feature 关闭。

## 已检查的上游契约

以下链接固定了上述配置所依据的源码契约，并不承诺部署后的可用性：

- [FeatureToml 的布尔值／表形式](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [原生上下文使用资格](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Provider 身份与内置合并规则](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [历史记录／笔记使用 provider 的请求 header 与认证](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
