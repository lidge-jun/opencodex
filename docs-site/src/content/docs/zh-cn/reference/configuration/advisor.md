---
title: 顾问
description: 独立专家咨询，支持 manual、preflight 与基于证据的 adaptive 策略。
---

顾问是一个独立的专家模型，审阅 Worker 的任务并返回建议。OpenCodex 端到端地拥有整个咨询过程：代理向 Worker 的回合注入合成的 `advisor` 工具，自己通过正常路由权威执行咨询，并回注建议使原 Worker 继续。Worker 无需委托、无需 spawn 任何东西、也不携带 provider 凭据。

这与子代理面（见[代理配置](/zh-cn/reference/configuration/agents/)）不同：子代理是通过 Codex 协作工具由 Worker 发起的委托。顾问是客户端完全不可见的代理侧 sidecar —— 即使从不 spawn 的 Worker 也能获得建议。

## 配置

在仪表板 **Advisor** 页面从目录选择专家模型。选择器原样保存原生、提供商、指定账户、自定义和组合模型的标识符。已禁用和等待初始选择的模型不会作为新选项。已保存但不在可选目录中的标识符会保留并显示警告，直到您选择其他模型或清除。目录加载失败时保留当前选择并提供重试。请选择能返回文本建议的模型；目录不保证咨询兼容性。CLI 和 API 仍接受路由器支持的模型字符串。

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
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | 何时咨询顾问。 |
| `maxConsultationsPerTask?` | `integer` | `3` | 自适应任务咨询上限（1–3 次尝试），包含手动调用。 |
| `timeoutMs?` | `number` | `120000` | 回环咨询超时。 |
| `contextSharingConsent?` | `"v1"` | 缺省 | 操作者同意把任务上下文发给所配置的顾问 provider。只有 `"v1"` 是当前版本。缺省、过期或其他值都表示不发送任务内容。`enabled: true` 本身不是同意。 |

通过仪表盘的 **Advisor** 页面或 `ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight|adaptive>` 管理。

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

咨询同时遵守调用方捕获的 API key 模型范围、付费 combo 同意和设备 fallback 限制，以及 Advisor 自身准入密钥的主机限制：设置时为 `OPENCODEX_API_AUTH_TOKEN` 或本代理接受的服务 token 文件，否则为第一个配置的 API key。只有在最后这种情况下密钥顺序才有影响：请把能访问 Advisor 模型的密钥放在第一位，否则每次咨询都不可用。设置了环境或服务 token 时，由该 token 决定咨询。这些规则同样适用于 combo 选择、嵌套决策模型和重试。无法满足这些规则的咨询会向 worker 返回不可用通知。

例如，`allowMeteredComboTargets: false` 的 `laptop` 密钥无法通过 Advisor 在计费 combo 目标上花费，`fallback.devices.laptop.provider: false` 也会阻止 Advisor 的 provider fallback 跳转。没有密钥的 loopback 调用方仍需要 combo 的 `allowMeteredTargets: true` 选择加入。当两个密钥都设置 `allowMeteredComboTargets: true` 且 combo 设置 `allowMeteredTargets: true` 时，即使经由公共绑定的 loopback 监听器，Advisor 也可以使用计费目标。服务器在验证请求时捕获调用方策略，早于等待正文容量或读取正文；之后的密钥或 fallback 编辑无法扩大该次咨询。这也覆盖路由的视觉辅助、compact 请求及其决策模型，以及 WebSocket 轮次内的每次候选重试。每个新的 WebSocket 轮次会捕获自己的策略。

OpenCodex 不会把 provider API key、Authorization 头、OAuth token、仅后端使用的配置密钥、进程环境或隐藏的思维链写进该提示，也不会解密或转发加密的 provider 私有推理。**任务内容不做通用脱敏。** 贴进任务的密钥、工具读到的文件里的秘密、工具或日志打印出的 token 都可能被发送。OpenCodex 不运行通用 DLP。

## 权威

手动建议是 Worker 自己发出的 `advisor` 调用所对应的工具结果。结果是一个 JSON 对象。`advice` 是顾问模型的文本。`status` 由运行时写入。

自动建议的 JSON 内容放在独立的 user-role 建议消息中。developer 消息只保留固定的运行时传输说明，顾问生成的文本不会进入 developer/system 内容；OpenAI Chat 和 Anthropic 均可传递它，无需伪造工具调用。JSON 转义能防止结构突破和字段伪造，但不能保证模型忽略自然语言中的恶意指令。专门的咨询结果协议可进一步区分建议与用户请求。每个请求最多进行 3 次咨询和 4 次 Advisor worker 续写。咨询额度耗尽后移除 advisor 工具，重复调用只允许一次携带上限结果的最终续写；再次调用会以 502 advisor_continuation_limit 结束，不再发送隐藏的 worker 请求。空完成重试共享此上限。

抑制不读取顾问字符串。自动去重只看服务端账本。复制了传输文本的 developer 消息也不能抑制 preflight。

## 成本与记账

每次咨询都是真实的额外模型调用。它以 **advisor 模型**计入用量 —— 绝不并入 Worker 的 token 计数 —— 并且每次咨询会写一条带触发方式、时长、状态和用量的 `[advisor]` 日志行，因此 advisor 调用永远可以从日志中证明。

## 失败行为

Advisor 失败是 fail-open 的：已经发出的咨询若失败（模型不可用、配置错误、超时），Worker 会收到简短、无误导性的"advisor 不可用"通知（preflight 为 `<opencodex_advisor_unavailable>` 消息，manual 为错误工具结果）并继续任务；只有咨询被取消时才什么都不注入，而计划根本未发起咨询（未启用、未配置模型、或缺少当前上下文共享同意）时也不会发送 preflight 通知。没有当前同意时，手动 `advisor()` 调用返回 consent-required 工具结果，且不外发。Advisor 失败不会让编码请求失败，咨询也不会切换会话的主模型。

## PR1 限制

- 原生 OpenAI passthrough 回合（ChatGPT 池 Worker）不会获得合成工具；advisor 支持覆盖路由（translated）provider。preflight 咨询适用于 run-turn 适配器；工具不适用。
- 不提供语义卡住检测、任务完成复核、升级分层、多专家或投票；自适应触发只使用已观察到的工具证据。
- preflight 去重账本是进程内的；代理重启后，进行中的任务可能再收到一次 preflight 咨询。

## 基于证据的自适应咨询与活动记录

`adaptive` 在初始咨询外，只有在同一工作目录中的同一验证命令失败、后续文件编辑成功、重新执行验证仍失败时才咨询。成功验证会清除对应失败；编辑前已启动的验证不算修复后的重试。初始阶段与失败阶段分别去重，自动咨询需要稳定的会话标识。工具须提供明确退出码和配对的调用/结果；支持常见测试、类型检查、lint、构建命令及已完成的文件编辑，轮询命令和单一静态 Code Mode helper 也可识别。复杂脚本、批量调用、shell 修改及模糊输出不触发。

用 `ocx advisor set --policy adaptive --max-consultations 2` 设置预算。自适应模式中，手动与自动尝试共用每任务 1–3 次预算，服务端在发出调用前写入 `OPENCODEX_HOME/advisor-budget.sqlite`，重启或切换 Worker 不会清零。仅保存任务摘要、次数和过期时间，首次调用后 24 小时过期；最多保留 512 项任务。预算不可用或耗尽时 Worker 继续执行。已发出的失败或取消调用仍可能计费，因此不退回额度。没有稳定会话标识时仅保留请求级的手动调用。

Advisor 页面和 `ocx advisor activity --json`（`GET /api/advisor/activity`）显示本进程最近 24 小时内最多 100 条调用元数据。页面可见时每 5 秒更新。包括原因、状态、模型、耗时、已报告的输入/输出 Token、请求档位与适配器映射档位；不存任务正文、命令、建议或会话标识，重启即清空。映射是适配器发出的参数，不代表已验证模型内部推理；未报告保持未知，不推测精确费用或建议采纳情况。
