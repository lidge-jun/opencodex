---
title: 代理配置
description: 多代理界面、委派引导、首选模型、回退链、原生默认值同步以及 effort 上限。
---

代理设置控制会公开哪种 Codex 协作界面，以及 opencodex 如何引导、路由并限制委派工作。

## 代理字段

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` 会把目录中的每个模型都标记为 v1；`v2` 会把每个模型都标记为 v2。`default` 会恢复上游固定值（Sol/Terra 为 v2，Luna 为 v1），否则遵循原生 `multi_agent_v2` 标志。适用于新会话。 |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | 最多五个裸原生 id、账户限定的 `<selector>/<native-openai-model>` id 或路由 `provider/model` id 会优先显示在子代理选择器中。Subagents 页面只提供裸原生和路由 id，保存时会省略精确的账户限定选项；如需精确选择，请使用 `ocx agent subagents set` 或直接编辑配置。显式空列表会被保留。 |
| `injectionModel?` | `string` | — | 在代理生成的 v2 委派引导中使用的首选原生或路由后的子代理模型。 |
| `injectionEffort?` | `string` | — | 首选 effort（`low` 到 `ultra`），只有在 `injectionModel` 存在时才有意义。 |
| `injectionPrompt?` | `string` | — | 替换内置 v2 指引正文。支持 `{{model}}`、`{{effort}}`、`{{roster}}` 和 `{{fallback}}`。只要配置了 `injectionModel`，自定义提示词就会触发。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 只控制 opencodex 生成的 v1/v2 开发者引导；不会改变原生代理默认值、工具、路由、名单或 effort 上限。 |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | 允许在同步或重启时，将 `injectionModel` 以及可选的 `injectionEffort` 写入为 Codex 的原生默认值。需要 `injectionModel`。 |
| `subagentModelFallback?` | `string[]` | `[]` | 按优先级排序的全局回退模型，用于派生的子轮次。 |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | 按请求的主模型 id 做键的 per-model 回退链。这是 per-role fallback 元数据的受支持存放位置；`model_fallback` 写在 Codex agent TOML 里会让 Codex 0.146+ 跳过该角色（#1190）。 |
| `subagentModelFallbackPollMs?` | `number` | `60000` | 可用性探测缓存间隔。低于 1000 ms 的值会回退到默认值。 |
| `effortCap?` | `string` | — | 对符合条件的 v2 主轮次和标记的派生子轮次设置硬上限。接受 `low` 到 `ultra`。 |
| `subagentEffortCap?` | `string` | — | 仅针对派生子轮次的额外上限。两个上限同时适用时，较低者生效。 |

通过仪表板或 `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>` 管理该界面。模式变更会应用于新会话。`maxConcurrentThreadsPerSession` 是 `PUT /api/v2` 字段，不是 `config.json` 键；`ocx v2 threads <n>` 会在启用 v2 后，将 `max_concurrent_threads_per_session` 写入 Codex 的 `$CODEX_HOME/config.toml` 中的 `[features.multi_agent_v2]` 下。

管理 API 公开 `GET`/`PUT /api/v2`、`/api/injection-model`、`/api/effort-caps`、`/api/subagent-models` 和 `/api/subagent-model-fallback`。injection-model 更新是部分更新；自定义 prompt 是该 API 上的 `prompt` 字段。

## 名单与引导

有效的 v2 名单，是已配置、在选择器中可见、按优先级排序的前五个模型中，和 v2 兼容且存在于注入目录中的那些模型。v2 资格判定会把显式的 `"v2"`、`null`，或缺失的上游固定值视为可用；真正的 `"v1"` 固定值会被排除。被排除的条目仍会保留在配置中，以便将来重新变为可用。

界面检测使用工具形状来判断。带命名空间的 `spawn_agent`，如果具有 `send_input`、`resume_agent` 或 `close_agent`，就是 v1。平铺的 `spawn_agent`，如果具有 `send_message`、`followup_task`、`interrupt_agent` 或 `list_agents`，就是 v2。

V1 引导只会在 `max` 或 `ultra` 时以主动文本形式出现。V2 只有在存在首选模型、可用名单或回退链时，才会收到代理生成的开发者消息。内置 v2 引导有 700 个字符的预算，必要时会先删减名单。引导会在 replay prefix 之间去重，并插入到末尾的 `compaction_trigger` 之前。

除非启用了原生默认值同步，`injectionModel` 和 `injectionEffort` 都只是建议。内置 v2 文本会要求 Codex 使用 `fork_turns: "none"` 将受支持的模型/effort 覆盖传给 `spawn_agent`。自定义 `injectionPrompt` 会把缺失值替换为空字符串。

## Codex 原生默认值同步

启用后，`syncCodexSubagentDefaults` 会写入由标记拥有的 `[agents] default_subagent_model` 和 `default_subagent_reasoning_effort` 字段。现有的、未标记的用户拥有目标字段会被视为冲突，并保持其权威性；不完整或含糊的 TOML 写入会以失败关闭。清空 `injectionModel` 也会同时清除该可选项。这些默认值只影响新创建的 Codex 任务，本身不会导致委派。

## 回退链

派生子轮次的回退顺序如下：

1. 请求的主模型；
2. `subagentModelFallbackByModel` 中的 per-model 链（按主模型做键）；然后是
3. 全局 `subagentModelFallback` 条目。

per-role fallback 链必须放在 opencodex 配置里。把 `model_fallback` 写进
`$CODEX_HOME/agents/*.toml` 会让 Codex 0.146+ 把整个角色文件当作未知字段拒绝并跳过该角色
（#1190）。TOML 中的旧版 `model_fallback` 仍会被读取以保持向后兼容，但 `ocx doctor` 会标记它。

opencodex 会跳过已禁用、不可路由、不健康、处于冷却中，或已达到配额阈值的候选项。可用性快照会在 `subagentModelFallbackPollMs` 期间缓存。加密的子任务可以把链限制为规范的原生 ChatGPT 目标；如果没有任何目标能读取加密载荷，请求就会失败，而不是把不可读的密文路由到别处。

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort 上限

上限只适用于 v2 协作功能：当主轮次的工具暴露 v2 时，它就符合条件；当子轮次在 `x-codex-turn-metadata` 中带有 codex-rs 的精确 `x-openai-subagent: collab_spawn` 或 `"subagent_kind": "thread_spawn"` 标记时，它也符合条件，即使叶子工具已经不再暴露协作。V1 主轮次、`multiAgentMode: "v1"`、压缩、审查以及记忆整合轮次都会绕过上限。

上限只会降低 effort。它们会向下贴合到不高于上限、且模型公开的最高档位。如果模型没有 effort 控制，或者没有任何受支持的档位可用，opencodex 会移除 effort，让提供方默认值生效。`max` 和 `ultra` 都可接受，而仪表板提供 `low` 到 `xhigh`。

关于 v1、default 和 v2 行为的面向初学者说明，请参阅 [Sub-agent surfaces](/guides/sub-agent-surface/)。
