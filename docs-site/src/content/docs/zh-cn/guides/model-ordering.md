---
title: 模型排序
description: opencodex 如何确定 Codex 模型选择器和 spawn_agent 模型 override 的顺序。
---

Codex 模型选择器不会保留 opencodex 配置中 provider 的声明顺序或模型数组顺序。最终顺序由目录
priority 决定；priority 相同的路由模型则使用确定性的字母顺序。

## Codex 应用的规则

Codex 的 models-manager 按 `priority` 升序排列选择器中可见的目录条目。目录数组本身的顺序会被
丢弃，因此在生成的 JSON 数组中把某个条目前移，并不会让它在选择器中前移。该约束直接记录在
`src/codex/catalog/sync.ts` 中。

因此，opencodex 通过分配更低的 priority 控制置顶位置，而不依赖数组位置。本表中的固定值及下例适用于
没有有效账户 selector 的配置。存在 `N` 个 selector 时，配置 rank 为 `i` 的置顶裸原生模型会展开为
priority 为 `i * N + j` 的 selector 行，其中 `j` 是从 0 开始的 selector 位置。置顶的路由行使用
`i * N`，精确的账户限定原生 id 使用其 selector 对应的 `i * N + j`。Codex 仍只公布选择器中可见的
前五行。未选中的路由行会移到这些 selector 分组之外。

没有 selector 时的相关 priority 如下：

以下优先级表和示例适用于未开启完整选择器排序的情况。

| 目录条目 | Priority | 来源 |
| --- | ---: | --- |
| `subagentModels[i]` | `i`（`0` 至 `4`） | `src/codex/catalog/sync.ts` 中的 featured rank map |
| 其他路由模型 | `5` | `src/codex/catalog/sync.ts` 中创建路由条目的逻辑 |
| 默认原生 GPT slug | `9` | `src/codex/catalog/sync.ts` 中创建原生条目的逻辑 |
| 存在 featured 列表时未选中的原生模型 | 至少为 `featured.length + 100` | `src/codex/catalog/sync.ts` 中合并原生目录的逻辑 |

管理 API 在 `src/server/management/agent-settings-routes.ts` 中使用 `slice(0, 5)`，把
`subagentModels` 限制为最多五项。这与 Codex `spawn_agent` 界面只公布前五个模型 override 的行为
一致。五项之外的模型仍可继续显示在主选择器中，也可通过精确 id 调用。

## Priority 相同时如何排序

所有普通路由模型的 priority 都是 `5`，因此需要处理并列顺序。在创建目录条目之前，
`gatherRoutedModels()` 会先按 provider 名称、再按模型 id 对路由模型列表进行字母排序
（`src/codex/catalog/provider-fetch.ts`）。

因此，以下配置顺序不会影响最终顺序：

- `providers` 对象中各 key 的声明顺序；
- 每个 provider 的 `models` 数组中各 id 的排列顺序。

随后，`orderForSubagents()` 使用稳定排序，把 featured 模型按 `subagentModels` 中的顺序移到最前。
非 featured 模型会保持之前确定的 provider/id 字母相对顺序
（`src/codex/catalog/sync.ts`）。创建条目时，featured rank 还会转换为 `0` 至 `4` 的
priority，因此 Codex 的 priority 排序会保留这个开头序列。

## 可见性与排序彼此独立

`selectedModels` 和 `disabledModels` 只决定暴露哪些路由模型，不控制排序。
`filterCatalogVisibleModels()` 会把两类选择转换为 `Set` 查询，并在不把数组当作 rank 的情况下过滤
已收集的列表（`src/codex/catalog/provider-fetch.ts`）。

因此，调整 `selectedModels` 或 `disabledModels` 的数组顺序不会改变模型在选择器中的位置，只会
影响模型是否包含在内。

## 最终选择器顺序

没有有效账户 selector 且 featured 列表非空时，最终顺序为：

1. 严格按照配置的 `subagentModels` 顺序排列，priority 为 `0` 至 `4`；
2. 所有剩余路由模型，先按 provider、再按模型 id 的字母顺序排列，priority 为 `5`；
3. 在目录合并过程中被移到 featured 区块之后的未选中原生模型。

如果没有 `subagentModels`，路由模型保持 priority `5`，原生 GPT 条目使用正常 priority
（opencodex 创建的条目通常为 `9`），路由组内部仍按 provider/id 字母排序。

## 示例

假设 `subagentModels` 按以下顺序包含五个 id：

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

选择器开头的实际顺序如下：

| 选择器位置 | 模型 | Priority | 出现在此处的原因 |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | 第一个 `subagentModels` 选择 |
| 2 | `opencode-go/glm-5.2` | `1` | 第二个选择，即使其 provider 在字母顺序上位于 `anthropic` 之后 |
| 3 | `anthropic/claude-opus-4-6` | `2` | 第三个选择 |
| 4 | `gpt-5.6-sol` | `3` | 第四个选择 |
| 5 | `gpt-5.6-terra` | `4` | 第五个选择 |
| 6 | `anthropic/claude-fable-5` | `5` | 剩余路由模型中按 provider/id 字母排序的第一项 |
| 第 7 项起 | 其余路由模型 | `5` | 先按 provider 字母排序，再按模型 id 字母排序 |
| 路由模型之后 | 其余原生模型 | `featured.length + 100` 或更高 | 未选中的原生模型移到 featured 区块之后 |

前五个条目是向 `spawn_agent` 公布的 override，其余模型继续按普通选择器顺序排列。

存在账户 selector 时，五项限制会在裸原生选择展开为 selector-qualified 分组之后应用。

## 更改顺序

自定义开头模型顺序的受支持方式是重新排列 `subagentModels`。仪表盘的 **Sub-agents** 页面可以调整
裸原生和路由 id 的顺序。配置和 `ocx agent subagents set` 也接受精确的账户限定
`<selector>/<native-openai-model>` id，仪表盘会保留已保存的 id，即使当前不可用。配置的
id 请勿超过五个。存在账户 selector 时，一个裸原生选项可能展开为多个 selector-qualified 行，因此
已配置的选项与公布的行不一定一一对应。

`modelPickerOrder` 只控制选择器的显示顺序。如果列表只有路由 ID `<provider>/<model>`，
其中未置顶的行会按列表顺序进入独立的显示区间（`1000 + i`）。未列出的路由行保留原有优先级，
因此仍排在该区间之前。同时列在 `subagentModels` 中的行保留置顶优先级，原生行也保持原有位置。
需要控制相对顺序的路由行都应列入列表。

要对整个选择器排序，请加入至少一个不含 `/` 的裸目录 ID，例如 `gpt-5.6-sol`。
空字符串或只有空白的条目不会启用此模式。

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

列出的行按数组顺序排在最前面，未列出的行随后按原有优先级排列。匹配使用精确的目录 ID：
`gpt-5.6-sol` 和 `openai/gpt-5.6-sol` 是不同的行。同一路由 ID 的原始写法和编码写法也可匹配，
但精确匹配优先于等价匹配。空条目和只有空白的条目会被忽略。账户限定行必须使用包含 selector 的完整 ID。

### 迁移提醒：现有列表中的原生 ID

以前 `modelPickerOrder` 中的裸原生 ID 会被忽略。现在，现有列表只要包含这样的 ID，就会启用
整个选择器的排序，包括置顶行。要保持以前只调整路由行的行为，请移除裸 ID。
未设置、空列表、只有空白条目的列表以及只有路由 ID 的列表都保留原有行为。

`modelPickerOrder` 保留 OpenCodex 按原有优先级计算最多五个首选候选项的规则，供子代理指导使用。
每个移动行的原有优先级与原生 `priority` 分开保存；仅改变选择器顺序不得改变这一计算结果。
它也不会限制通过精确模型名称指定 override 的资格：公布的列表不是允许列表，现有的认证、模型、
effort 和后端限制仍然适用。

原生 Codex 按原生 `priority` 排序，从符合条件且在选择器中可见的模型中取前五个，公布在
`spawn_agent` 中。这适用于 V1，以及公开模型 override 的 V2。因此，即使 OpenCodex 的首选候选项
不变，原生公布的五个模型仍可能随选择器顺序改变。V1 不接收 OpenCodex 注入的首选模型列表。
V2 在客户端目录状态允许时，可以额外接收基于原有优先级的 OpenCodex 指导；这些指导不会重排
原生工具公布的列表。

`disabledModels` 和各提供商的 `selectedModels` 仍是可见性字段。没有独立的 `modelOrder`、
`providerOrder` 或优先级映射设置。

## 仪表盘排序预设

在 **Models** 中选择默认、按模型名 A–Z、按提供商或使用量快照，再应用顺序。保存当前可用的路由 ID 和 `modelPickerOrderMode`（`alphabetical`、`provider`、`most-used`）。使用量排序仅在应用时读取一次保留的全部历史；重新打开或模型增减不会重新计算。已有自定义、原生完整顺序会保留，直到明确应用替换。即使没有可用模型，默认也能清除两个字段。

`GET/PUT /api/subagent-models` 的 `chosen`、`available` 保留禁用或缺失的已存 roster；`pickerAvailable` 只包含可选路由 ID。Models 只发送 `pickerOrder`、`pickerOrderMode`，不发送 `models`。只保存 roster 不影响排序，非法输入或保存失败会保留原状态。

预设保留精选、原生优先级区间，应用于 Codex 目录与 Claude 发现列表的路由分组。Claude 原生前缀、明确的 Desktop 配置及 alias 归属不变。OpenCodex 指导排序与 fallback 设置不变，但原生 Codex 工具显示的前五候选及推荐默认模型可能改变。保存不会重启客户端；目录刷新可能尚未完成，旧列表可能需要重新打开客户端。
