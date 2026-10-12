---
title: 为什么 v1 是默认子代理界面
description: v2 加密任务限制会破坏什么、OpenCodex 为何现在默认使用 v1，以及仍想使用 v2 时该怎么办。
---

OpenCodex 安装后的子代理界面默认为 **v1**。Dashboard、Models 和 Subagents 页面在切换到 **base** 或 **v2** 前都会要求确认，并链接到本页。CLI 不会提示。

原因明确而具体：在 v2 上，从 ChatGPT 原生模型分派给路由模型的任务无法被路由模型读取。这恰恰是最常见的委派方式——GPT 父代理启动 Grok、Claude 或 GLM 子代理——而在 v2 上每次都会失败。

## 发生时会看到什么

启动子代理的请求会被拒绝，而不是静默生成空任务：

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

响应为 HTTP 400，密文绝不会回传。有意采用封闭式失败：转发无法读取的载荷会让子代理收到空指令，却给出看似确定的错误答案。

## 原因

![两条路径对比相同的委派。v1 上，ChatGPT 父代理通过 OpenCodex 发送明文任务，任务跨过提供商边界，路由子代理可读取。v2 上，父代理发送由 ChatGPT 后端生成的 encrypted_content；OpenCodex 无法解密，因此任务停在提供商边界，请求以 unreadable_encrypted_agent_task 失败。](../../../../assets/subagent-v2-encrypted-task.svg)

在 v1 上，父代理以纯文本发出子代理的任务。OpenCodex 读取并路由它，子代理因而收到可执行的内容。

在 v2 上，父代理以 ChatGPT 后端生成的 `encrypted_content` 发出任务。密钥留在该后端，OpenCodex 从未持有它，因此代理既无法解密也无法改写；该值确实是密文，并不是由标志隐藏的明文。这是结构限制，而非配置错误，代理端的设置无法修复。

有三种拓扑不受影响；了解它们也有助于理解失败发生的位置：

| 拓扑 | v1 | v2 |
| --- | --- | --- |
| ChatGPT 父代理到路由子代理 | 可用 | **失败** |
| 路由父代理到路由子代理 | 可用 | 可用 |
| ChatGPT 父代理到 ChatGPT 子代理 | 可用 | 可用——后端能解密自己生成的密文 |

后端始终可以读取自己的密文。只有跨越提供商边界时才会失败。

## 上游修复了吗？

还没有，至少关键的发送端没有修复。上游合并了 [openai/codex#35845](https://github.com/openai/codex/pull/35845)，新增了接收明文协作消息的支持，但这只处理*接收*端：它可以处理已经生成的明文，却不会让 OpenAI 父代理生成明文。

发送端的问题仍未解决：[ #36376](https://github.com/openai/codex/issues/36376) 在 Windows、macOS 和 Linux 上的 CLI 0.146 至 0.151 中复现；[#37197](https://github.com/openai/codex/issues/37197) 则直接指出缺少发送端的传递策略。维护者尚未承诺修复或给出时间表。

OpenCodex 在 [#92](https://github.com/lidge-jun/opencodex/issues/92) 记录了影响，并以“不计划处理”关闭：此仓库无法修复，因此该 issue 是上游工作的索引，并非等待这里的维护者处理的任务。

## 三种模式目前的作用

| 模式 | 界面 | 适用情况 |
| --- | --- | --- |
| **v1**（默认） | 每个模型都提供经典的带命名空间的启动工具。启动时可直接指定另一模型。 | 跨提供商委派的用户。这是当前发布的默认值。 |
| **base** | 上游模型固定设置：Sol 和 Terra 使用 v2，Luna 使用 v1，未固定的模型遵循 Codex 自身的标志。 | 希望采用 Codex 预期的各模型界面，且只在同一提供商内委派。 |
| **v2** | 每个模型都提供扁平的并发工具。 | 希望使用较新的并发会话模型，且父代理与子代理位于边界同侧。 |

base 排在第二而非第一，是因为它将大多数人用于*发起*委派的 Sol 和 Terra 固定在 v2。对于这一问题，base 不是折中选项；ChatGPT 向路由模型启动子代理时，它的行为与 v2 相同。

## 如果已经选择 base 或 v2

现有设置不会被改动。升级到采用这一默认值的版本不会重写既有设置；仪表盘会显示一次通知，等待你的选择。

- **Continue** 保留当前模式，并停止提醒。
- **Switch to v1** 应用 v1，并停止提醒。

两种选择都会被记录，通知不再出现。如果直接关闭通知而未作选择，下次打开仪表盘时仍会看到它。

模式变更只对**新建** Codex 会话生效。选择后请新建会话；如果长期运行的 App 宿主仍显示旧界面，请执行 `ocx sync` 并重启该界面。

## 如果仍想使用 v2

以下四种方法按建议尝试的顺序列出：

1. **让 ChatGPT 保持 v1。** 在 v2 模式中，`keepNativeChatGptOnV1` 开关让 Sol 和 Terra 继续使用 v1 界面，从而仍能启动 Grok 或 Claude；路由父代理则使用 v2。这最接近两者兼得。
2. **在同一提供商内委派。** v2 上，路由父代理启动路由子代理使用明文，正常可用。
3. **信任直接使用密钥认证的 Responses 中继。** 明确设置 `allowEncryptedV2AgentTasks: true` 的提供商会收到不透明载荷，而不是 400。只有确定目标能够处理该载荷时才这样做。
4. **启用 `agentTaskRecovery`。** 此功能为实验性，默认关闭。它通过 ChatGPT 后端恢复无法读取的加密 `NEW_TASK`、`MESSAGE`、`FOLLOWUP_TASK` 和 `FINAL_ANSWER` 项，代价是消耗额度、增加延迟并依赖未文档化的行为；combo 恢复仍仅限于已启动子代理的轮次，而拆分令牌片段仍不受支持。

完整机制见[子代理界面](/zh-cn/guides/sub-agent-surface/)，具体设置见[代理配置](/zh-cn/reference/configuration/agents/)。

## 何时不再需要本页

当上游版本使 ChatGPT 原生父代理以明文发出路由子代理的任务时，默认采用 v1 的原因也会消失。届时默认值会恢复为 base，确认提示不再出现，本页会从建议变成历史记录。

## 更改模式

Dashboard、Models 和 Subagents 都提供相同的 v1/base/v2 开关，而且切换到 base 或 v2 时都会要求确认。CLI 命令如下：

```bash
ocx v2 status
ocx v2 mode v1
```

CLI 不会提示。这是同一设置，因此请了解本页描述的行为后再选择。
