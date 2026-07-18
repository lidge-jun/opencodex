---
title: 子代理界面（v1 / base / v2）
description: 全局控制 Codex 在所有模型上生成和管理子代理的方式。
---

opencodex 允许你为目录中的所有模型选择多代理协作界面。仪表盘和 Models 页面中的 **Sub-agent** 开关会全局控制这一设置。

:::note
在 v2 界面（`multi_agent_v2`）上，子代理**默认**继承父会话的模型：`fork_turns` 默认为 `all`，而全量历史 fork 会拒绝覆盖。自 v2.7.2 起，opencodex 注入的指引会教模型如何打破继承 —— 将 `fork_turns` 设为 `"none"`（或如 `"3"` 的部分 fork）的 `spawn_agent` 调用可以传入 `model` / `reasoning_effort` 参数；即使公开的工具 schema 中看不到这些参数，Codex 运行时也会解析并应用。已知限制：当**原生**父代理 spawn 一个路由到**非原生** provider 的子代理时，Codex 客户端可能只以后端加密的 `encrypted_content` 发送 `NEW_TASK` 载荷，路由子代理会收到空的任务正文（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。模型覆盖仍会生效，但任务文本可能丢失 —— 异构 provider 委派请使用更可靠的 v1 界面。
:::

## 模式

| 模式 | 界面 | 行为 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 使用经典的命名空间代理工具，以及 `send_input` / `close_agent` / `resume_agent`。`spawn_agent` 的模型覆盖可以在其他模型上生成子代理。 |
| **base**（默认） | 上游固定值 | 恢复上游模型的固定值：gpt-5.6-sol 和 gpt-5.6-terra 使用 v2，gpt-5.6-luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能开关。生成行为取决于该模型最终使用的界面。 |
| **v2** | `multi_agent_v2` | 使用扁平的 `spawn_agent` 工具、并发会话，以及 `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`。全量历史 fork 时子代理继承父模型；`fork_turns: "none"`（或部分 fork）时接受 `model` / `reasoning_effort` 覆盖。原生→路由子代理的任务正文可能以加密形式到达（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。 |

## 工作原理

所选模式会设置 Codex 读取的每个目录条目中的 `multi_agent_version` 字段：

- **v1 模式**：强制所有条目使用 `multi_agent_version = "v1"`，覆盖上游固定值。
- **base 模式**：恢复上游默认值。已固定的模型使用快照值；未固定的模型不写入该字段，交由 Codex 功能开关决定。
- **v2 模式**：强制所有条目使用 `multi_agent_version = "v2"`，覆盖上游固定值。

无论是实时 `/v1/models` 目录响应，还是磁盘目录同步，这项覆盖都会作为最后一步执行。因此，无论条目原本如何生成，新会话都会使用一致的模式。

### 委托模型与推理强度

仪表盘中的 **子代理委托** 选择器会保存 `injectionModel`，以及可选的 `injectionEffort`。它们用于生成委托指引，并不是由 proxy 执行的子代理路由规则。设置 `injectionPrompt` 可以把内置指引文本整体替换为自定义内容。

`multiAgentGuidanceText` 根据请求中的工具列表判断当前界面 —— 包括 Codex Desktop 的 WebSocket 路径（`responses_lite`），此时工具位于 `additional_tools` input 项中而不是请求的 `tools` 数组。

在 **v2** 请求上（base 模式下的 Sol/Terra，v2 模式下的全部模型），只要设置了注入模型、或配置的子代理清单能在目录中解析出来，proxy 就会注入一段不超过 700 字符的精简指引：`spawn_agent` 隐藏的 `model` / `reasoning_effort` 参数用法、覆盖所需的 `fork_turns: "none"`（或部分 fork）规则、首选模型与推理强度，以及 `subagentModels` 清单和各模型在目录中公布的 effort 阶梯 —— 这正是 Codex 验证生成强度所用的列表。

在 **v1** 请求上，proxy 仅在最高推理档位（max / ultra）镜像上游的主动委托文本。v1 不会追加模型指定、清单或自定义提示词。

要替换内置的 v2 指引，请设置 `injectionPrompt`（config 键，或 `PUT /api/injection-model` 的 `prompt` 值）。占位符 `{{model}}`、`{{effort}}`、`{{roster}}` 会被替换为配置的注入模型、推理强度和解析出的清单。触发条件保持不变：自定义提示词不会让本应保持沉默的请求触发注入。

## 更改模式

### GUI

- **Dashboard** → 第一个状态单元：选择 **v1**、**base** 或 **v2**。
- **Models** 页面 → 使用顶部的分段控件。
- 两个页面都有 **?** 按钮，可打开帮助弹窗并返回本文。
- **Dashboard** → **子代理委托**：选择首选模型和可选的推理强度。在 v2 上，注入的指引会要求以 `fork_turns: "none"` 生成，使模型覆盖得以应用 —— 但原生→路由子代理的任务正文可能以加密形式到达（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。

### CLI

```bash
ocx v2 mode v1       # 强制所有模型使用 v1
ocx v2 mode default  # 恢复上游固定值
ocx v2 mode v2       # 强制所有模型使用 v2
ocx v2 status        # 显示当前模式和 Codex 功能开关
```

### API

```bash
# 读取界面模式、功能开关和线程上限
curl http://localhost:10100/api/v2

# 设置界面模式
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` 的 PUT 端点还接受 `enabled`（布尔值，Codex 功能开关）和 `maxConcurrentThreadsPerSession`（整数）。它会验证请求、保存模式、重新同步目录，并提示模式更改从新会话开始生效。

委托选择器使用另一个端点：

```bash
# 读取当前模型/推理强度和可选值
curl http://localhost:10100/api/injection-model

# 同时设置两个值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# 设置自定义指引提示词（{{model}}/{{effort}}/{{roster}} 占位符）
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "委托给 {{model}}。{{roster}}"}'

# 清除两个值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` 返回 `model`、`effort`、`prompt`、全局 `efforts` 阶梯，以及由已启用原生/路由模型组成的 `available` 列表。PUT 请求省略 `effort` 或 `prompt` 时会保留当前值，传入 `null` 时会清除它；清除 `model` 一定会同时清除推理强度。API 会按全局 Codex 阶梯验证推理强度，Codex 仍会在生成时检查目标目录条目是否支持该强度。

## 推理强度

可选的子代理推理强度保存在 `injectionEffort` 中，只有同时设置注入模型时才有意义。它会向注入的 v2 指引加入 `reasoning_effort` 要求，但不会改变父会话的推理强度。在接受覆盖的 fork 上，Codex 会直接应用传给 `spawn_agent` 的 `reasoning_effort`。

在 Codex 目录中，`ultra` 的级别高于 `max`，并带有自动委托语义；但 provider 永远不会在线路上收到字面量 `ultra`。Codex 会在客户端边界将 `ultra` 转成 `max`，随后 opencodex 再确保 provider 收到有效值：

| 模型 | 线路上的 `max` | 选择 `ultra` 后的线路值 |
| --- | --- | --- |
| gpt-5.5、gpt-5.4、gpt-5.4-mini | xhigh | xhigh（先转为 max，再经 `nativeEffortClamp`） |
| gpt-5.6-sol、gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 其精确上游阶梯不提供该选项 |
| 路由模型 | 由适配器映射或限制 | 先转为 max，再由适配器映射或限制 |

目录中是否提供某个推理强度与 v1/v2 模式无关。支持推理的生成条目会提供 `max`，使直接指定的子代理强度能够通过验证；当前生成的路由条目还会提供 `ultra`。精确的上游模型阶梯会原样保留，因此 gpt-5.6-luna 最高只到 `max`。

## 上下文上限

全局上下文上限值默认为 350k。它只会限制已启用上限的路由 provider 所广告的 `context_window`；原生 OpenAI 模型保留其真实上下文窗口。

你可以在 Models 页面更改上限值或全体 provider 设置，也可以通过各 provider 分组标题旁的开关单独启用或禁用上限。
