---
title: 子代理界面（v1 / base / v2）
description: 控制 Codex 如何在所有模型上生成和管理子代理。
---

## 什么是子代理

子代理是一个独立的 Codex 工作器，主代理可以为专注任务创建它。它有自己的上下文和工具，因此多个独立任务可以并行运行。opencodex 负责控制 Codex 的哪种协作界面会暴露这些工作器、Codex 会为它们提供哪些模型，以及失败模型如何回退。它不会决定主代理何时必须委派。

## 模式

为**新会话**选择模式。已有会话会保留它们开始时所用的界面。

| 模式 | Codex 获得什么 | 适合谁 |
| --- | --- | --- |
| **v1** | 经典的命名空间 `spawn_agent`、`send_input`、`resume_agent` 和 `close_agent` 工具。spawn 可以直接选择另一个模型。 | 需要在不同 provider 之间可靠委派的初学者，尤其是原生到路由子级。 |
| **base**（默认） | 上游模型固定值：GPT-5.6 Sol/Terra 使用 v2，Luna 使用 v1，未固定的模型遵循 Codex 的 `multi_agent_v2` 功能开关。 | 大多数用户。它按 Codex 对每个模型预期的界面运行，而不是全局强制一种。 |
| **v2** | 扁平的 `spawn_agent`、`send_message`、`followup_task`、`interrupt_agent` 和 agent-list 工具，并支持并发会话。 | 想要更新的并发工作流，并理解模型继承以及下面加密任务限制的用户。 |

:::tip[不确定？]
先从 **base** 开始。只有当跨 provider 委派必须可预测地工作时才选 **v1**。只有在你明确想让所有目录条目都使用更新的会话模型时，才强制使用 **v2**。
:::

## 工作原理

所选模式会控制 Codex 读取的每个目录条目中的 `multi_agent_version` 字段：

- **v1** 会把所有模型的 `multi_agent_version` 设为 `"v1"`。
- **base** 会恢复上游固定值。未固定的条目会遵循原生 `multi_agent_v2` 功能开关。
- **v2** 会把所有模型的 `multi_agent_version` 设为 `"v2"`；但启用 **让 ChatGPT 保持 v1** 时例外：ChatGPT 原生条目保持 `"v1"`，路由/组合条目仍为 `"v2"`。

opencodex 会把这一点作为最后一步同时应用到实时的 `/v1/models` 目录和同步到磁盘的目录。因此，模式更改会一致影响新建的 App、CLI 和 TUI 会话。

对于 v2 roster，资格有三种状态：标记为 `"v2"` 的条目、显式设为 `null` 的条目，或者没有 `multi_agent_version` 字段的条目。真正的 `"v1"` 固定值会被排除，因为它说明该模型属于另一种协作界面。

## 委派模型与推理强度

Dashboard 上的 **Sub-agent delegation** 控件管理三个相关设置：

- `injectionModel` 是 opencodex 指引中指定的首选工作器模型。
- `injectionEffort` 是可选的 `reasoning_effort`，用于请求该模型。
- `injectionPrompt` 会替换内置的 v2 指引文本。

`multiAgentGuidanceEnabled` 默认开启，是 opencodex 编写的指引在两个界面上的总开关。关闭它会同时抑制 v2 的 designation block 和 v1 的 proactive 文本。

这些是发给主代理的指令，不是 proxy 侧的 spawn 路由器。对于 v2，全历史 fork 会继承父模型，并拒绝模型或 effort 覆盖。因此，指引会要求 Codex 在传递 `model` 或 `reasoning_effort` 时使用 `fork_turns: "none"`（或者像 `"3"` 这样正向的部分 turn 数），并让任务消息保持自包含。

自定义 `injectionPrompt` 文本可以使用全部四个占位符：

| 占位符 | 替换为 |
| --- | --- |
| `{{model}}` | 当前请求中生效的首选模型。未带选择器的原生 `injectionModel` 只有在请求本身明确指定账户选择器时，才会加上该账户限定。无法解析或存在歧义的未限定值会替换为空字符串；显式限定到账户或提供商路由的 ID 即使无法解析也保持原值 |
| `{{effort}}` | 配置的 `injectionEffort`，或空字符串 |
| `{{roster}}` | 解析后的、对 picker 可见且与界面兼容的 roster |
| `{{fallback}}` | 配置的全局 fallback 指引 |

内置的 v2 指引有 700 字符预算。如果会超出预算，opencodex 会优先删除 roster，而不是截断核心 spawn 指令。内置指引仅在首选模型、可用 roster 或 fallback chain 解析成功时触发。只要配置了 `injectionModel`，自定义提示词就会触发；如果未限定的值无法唯一解析，`{{model}}` 会替换为空字符串。

在 v1 上，opencodex 只会在 `max` 或 `ultra` effort 下注入上游风格的主动委派指引。它不会在 v1 上额外添加首选模型、roster、fallback list 或自定义提示词。

默认关闭的 `syncCodexSubagentDefaults` 选项与指引是分开的。当 opencodex 拥有活跃的 Codex 路由时，同步或重启可以把所选值写入 Codex TOML 中带标记的 `[agents] default_subagent_model` 和 `default_subagent_reasoning_effort` 条目。opencodex 只会更新或移除带有其标记的字段。如果任一目标字段属于用户，整对值会保持不变，而不会部分写入；含糊不清的 TOML 会在不写入的情况下被拒绝。外部 provider 管理器和用户拥有的根路由也仍然具有最终权威。

## Fallback chains

对于生成出的工作器，opencodex 会按以下优先级构建顺序：

1. 请求的主模型。
2. opencodex 配置中 `subagentModelFallbackByModel` 提供的 per-model 链，按请求的主模型做键。
3. opencodex 配置中的全局 `subagentModelFallback` 列表。

per-role fallback 链应该放在 opencodex 配置里，而不是 `$CODEX_HOME/agents/*.toml`。Codex 0.146+ 会严格反序列化 agent 角色文件，并把 `model_fallback` 当作未知字段拒绝，导致整个角色定义被跳过（#1190）。opencodex 为了向后兼容仍然能读取 TOML 里的旧版 `model_fallback`，但 `ocx doctor` 会给出警告，而且 Codex 本身会忽略受影响的角色。

重复的模型 id 会在保留第一次出现的前提下移除。在选择过程中，opencodex 会跳过已禁用、不可路由、由已禁用 provider 支撑、标记为 unhealthy、处于 cooldown、没有可用 pooled Codex 账户，或者超出配置配额阈值的候选项。可用性探测会缓存 `subagentModelFallbackPollMs` 的时长，默认 60 秒。

fallback 不会让不兼容的加密任务变得可读。当子任务为 ChatGPT 加密时，即使链中更靠前出现了外部模型，选择也只会限制在规范的原生 ChatGPT 目标上。

## 加密的 v2 任务传递

Codex 只能把 v2 原生到路由的子任务作为后端加密的 `encrypted_content` 发送。这个载荷可以被原生 ChatGPT 后端读取，但外部 provider 不能读取。这就是已知的 [#92](https://github.com/lidge-jun/opencodex/issues/92) 限制。

opencodex 会安全失败，而不是转发空任务或不可读任务：

- 直接的非原生路由会返回 HTTP 400，并且 `error.code = "unreadable_encrypted_agent_task"`，不会回显密文。
- 对于该任务，combo 只会考虑规范的原生 ChatGPT 目标，包括重试。如果没有可用目标，则返回相同的 400 错误。
- 可读的明文任务会保持正常的路由和 fallback 行为。

恢复选项是选择原生 ChatGPT 子级、在 combo 中添加原生 ChatGPT 目标、在异构 provider 委派中使用 v1，或者在你控制调用方时将任务作为明文 v2 `agent_message` 内容重新发送。

实验性的 `agentTaskRecovery` 默认关闭。显式启用后，它可以通过向固定 ChatGPT 端点发送额外的认证请求来恢复这种格式，但会消耗配额、增加延迟，并依赖非公开的后端行为。任何失败都会保留原有的 `unreadable_encrypted_agent_task` 错误。详见[英文配置参考](/reference/configuration/agents/#encrypted-v2-task-recovery)。

## 更改模式

### GUI

- **Dashboard** → 第一个状态单元：选择 **v1**、**base** 或 **v2**。
- **Models** → 顶部一行的分段控件：选择相同的全局模式。
- **Dashboard** → **Sub-agent delegation**：设置指引模型/effort，以及原生默认值启用项。
- **Subagents**：选择并排序 roster，并配置全局 fallback chain。

### CLI

使用 `ocx v2` 管理协作界面和原生功能设置：

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

使用 `ocx agent` 管理委派、roster、effort 上限和 fallback 设置：

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

传入 `-` 可清除可空的 `ocx agent injection` 值，或者对 roster / fallback list 使用相应的 `clear` 操作。所有命令族请参见 [CLI reference](/reference/cli/)。

### API

管理 API 提供对应的 `GET` 和 `PUT` 端点：

| 端点 | 管理内容 |
| --- | --- |
| `/api/v2` | 界面模式、原生功能开关和线程设置 |
| `/api/injection-model` | 首选模型、effort、自定义提示词、指引和原生默认值同步 |
| `/api/effort-caps` | 主代理和子代理的 effort 上限 |
| `/api/subagent-models` | 最多五个模型的有序 roster |
| `/api/subagent-model-fallback` | 全局 fallback 顺序和轮询间隔 |

例如：

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

### 选择委派模型会强制 Codex spawn 它吗？

不会。指引可以推荐模型，原生默认值同步也可以提供 Codex 默认值，但是否委派仍由主代理决定。

### 为什么我的 v2 子级使用了父模型？

全历史 v2 fork 会继承父模型。在传入模型或 effort 覆盖之前，请使用把 `fork_turns` 设为 `"none"` 或正向部分 turn 数的 spawn。

### 为什么配置的模型没有出现在 v2 roster 中？

它可能在 picker 中被隐藏、超出了五个模型的显示上限、从目录中缺失，或者被固定到 v1。`"v2"`、`null` 或缺失的界面值都可以；真正的 `"v1"` 固定值不可以。

### 模式更改会影响正在运行的会话吗？

不会。更改模式后请启动一个新的 Codex 会话。如果长时间运行的 App host 仍然显示旧的目录状态，请运行 `ocx sync` 并重启那个 Codex 界面。

### 推理强度

`injectionEffort` 只会影响委派工作器的指引，以及在显式启用时影响原生 Codex 子代理默认值。它不会改变父会话的 effort。`ultra` 是面向客户端的顶级档位，Codex 会把它转换成 `max`；随后 opencodex 会按所选 provider 对该值进行映射或限制。

### 上下文上限

模型上下文上限与子代理模式无关。请在 Models 页面配置它；原生 OpenAI 模型会保留其真实的上下文窗口。
