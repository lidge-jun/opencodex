---
title: 顾问
description: OpenCodex 自有的专家咨询 sidecar — 配置的专家模型为路由 Worker 提供建议，支持 manual 与 preflight 两种策略。
---

顾问是一个独立的专家模型，审阅 Worker 的任务并返回建议。OpenCodex 端到端地拥有整个咨询过程：代理向 Worker 的回合注入合成的 `advisor` 工具，自己通过正常路由权威执行咨询，并回注建议使原 Worker 继续。Worker 无需委托、无需 spawn 任何东西、也不携带 provider 凭据。

这与子代理面（见[代理配置](/zh-cn/reference/configuration/agents/)）不同：子代理是通过 Codex 协作工具由 Worker 发起的委托。顾问是客户端完全不可见的代理侧 sidecar —— 即使从不 spawn 的 Worker 也能获得建议。

## 配置

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | 总开关。关闭时请求路径上没有任何 advisor 行为。 |
| `model?` | `string` | — | 专家模型。任何路由权威接受的模型字符串：裸原生模型（`gpt-6-astra`）、显式 `provider/model`（`anthropic/claude-sonnet-4-6`、`xai/grok-...`）或账户限定的原生模型。完整支持跨 provider：Worker 与 Advisor 无需同属一个 provider。 |
| `effort?` | `string` | `"max"` | Advisor 调用的推理强度（`low` 至 `ultra`）。 |
| `policy?` | `"manual" \| "preflight"` | `"manual"` | 何时咨询顾问。 |
| `timeoutMs?` | `number` | `120000` | 回环咨询超时。 |
| `contextSharingConsent?` | `"v1"` | 缺省 | 操作者同意把任务上下文发给所配置的顾问 provider。只有 `"v1"` 是当前版本。缺省、过期或其他值都表示不发送任务内容。`enabled: true` 本身不是同意。 |

通过仪表盘的 **Advisor** 页面或 `ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight>` 管理。

`ocx advisor on` 在没有当前同意时不会开启跨 provider 发送：它会打印披露并停止。`ocx advisor on --ack-context-sharing` 与 `ocx advisor consent` 记录 `v1`。`ocx advisor consent --revoke` 会移除同意并立即停止发送。`ocx advisor set` 不授予同意。仪表盘上的同意复选框默认不勾选。

## 策略

- **`manual`** — 仅当 Worker 显式调用合成的 `advisor` 工具时咨询。该调用由代理拦截，客户端不可见，也不会作为本地工具执行。
- **`preflight`** — OpenCodex 会在每个任务自动尝试一次额外咨询。失败的咨询不会被当作建议：任务会在失败账本条目过期后重试。当 Worker 产出第一份方向性证据（最新用户消息之后的助手工具调用或工具结果）时，代理会咨询顾问并在 Worker 下一回合之前注入建议 —— 即使 Worker 从不调用该工具。触发条件是确定性的、有文档的近似规则，不是语义级"模型卡住了"检测器。

## 同意

在操作者记录上下文共享同意 `v1` 之前，不会发送任务上下文。该字段带版本，以便以后披露范围扩大时改用 `v2`，而不是沿用这次授权。运行时强制执行。缺少或过期时顾问不可运行（`advisor_context_sharing_consent_required`），编码请求本身继续。Worker、顾问模型，以及任务文本里的字符串都不能授予同意。

## Advisor 能看到什么

一次咨询可能发送：

- 最新的用户任务
- 已解析会话中可见的用户、助手和开发者文本
- 工具调用与工具参数
- 工具结果
- Worker 的工具目录和描述
- Worker 身份与所配置的顾问模型
- Worker 调用 `advisor()` 时的可选焦点问题

所配置的顾问 provider 可能与 Worker 的 provider 不同。

OpenCodex 不会把 provider API key、Authorization 头、OAuth token、仅后端使用的配置密钥、进程环境或隐藏的思维链写进该提示，也不会解密或转发加密的 provider 私有推理。**任务内容不做通用脱敏。** 贴进任务的密钥、工具读到的文件里的秘密、工具或日志打印出的 token 都可能被发送。OpenCodex 不运行通用 DLP。

## 权威

手动建议是 Worker 自己发出的 `advisor` 调用所对应的工具结果。结果是一个 JSON 对象。`advice` 是顾问模型的文本。`status` 由运行时写入。

自动建议仍使用 developer 消息，因为当前与 provider 无关的续写路径没有不成对的低信任咨询结果。伪造一次 Worker 没有发出的工具调用会破坏 Anthropic 的消息合法性，也会破坏续写配对。该消息里的固定传输说明是运行时拥有的策略。说明之后的 JSON 是加引号的不可信建议数据。引号使顾问文本无法提前结束封装，也不能改写溯源。这并不表示 developer 角色传输是完美隔离。专门的咨询结果协议会是更强的边界。

抑制不读取顾问字符串。自动去重只看服务端账本。复制了传输文本的 developer 消息也不能抑制 preflight。

## 成本与记账

每次咨询都是真实的额外模型调用。它以 **advisor 模型**计入用量 —— 绝不并入 Worker 的 token 计数 —— 并且每次咨询会写一条带触发方式、时长、状态和用量的 `[advisor]` 日志行，因此 advisor 调用永远可以从日志中证明。

## 失败行为

Advisor 失败是 fail-open 的：已经发出的咨询若失败（模型不可用、配置错误、超时），Worker 会收到简短、无误导性的"advisor 不可用"通知（preflight 为 `<opencodex_advisor_unavailable>` 消息，manual 为错误工具结果）并继续任务；只有咨询被取消时才什么都不注入，而计划根本未发起咨询（未启用、未配置模型、或缺少当前上下文共享同意）时也不会发送 preflight 通知。没有当前同意时，手动 `advisor()` 调用返回 consent-required 工具结果，且不外发。Advisor 失败不会让编码请求失败，咨询也不会切换会话的主模型。

## PR1 限制

- 原生 OpenAI passthrough 回合（ChatGPT 池 Worker）不会获得合成工具；advisor 支持覆盖路由（translated）provider。preflight 咨询适用于 run-turn 适配器；工具不适用。
- 无自适应触发：没有卡住检测、重复失败分析、升级分层、多 Advisor 或投票。`manual` 与 `preflight` 是仅有的策略。
- preflight 去重账本是进程内的；代理重启后，进行中的任务可能再收到一次 preflight 咨询。
