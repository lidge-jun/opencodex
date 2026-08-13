---
title: "组合：故障切换与负载均衡"
description: 将一个虚拟模型路由到多个 provider，用于故障切换或加权负载均衡。
---

**combo** 是一个虚拟模型，它前置了一组按顺序排列的真实 provider/model 目标。你的客户端请求 `combo/<id>`；opencodex 会选择一个目标，将请求重写为那个具体的 `provider/model`，并且在第一个目标出现可重试失败时，可以改试另一个目标。

这在以下场景很有用：

- **故障切换：** 优先使用一个模型，同时保留备用模型。
- **负载均衡：** 以加权批次在多个模型或 provider 之间分散成功请求。

combo 位于正常 provider 路由之前。如果你还不熟悉 `provider/model` 选择器，请先阅读 [模型路由](/guides/model-routing/)。

## 60 秒快速上手

这个示例创建 `combo/main`，Anthropic 在前，OpenAI 在后。两个 provider 都必须已经存在并启用。

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

默认策略是故障切换，所以正常请求会发往 `anthropic/claude-opus-4-8`。如果这次尝试出现可重试失败，opencodex 可以切换到 `openai/gpt-5.6-sol`。

在任何你通常会提供模型 id 的地方，都可以使用这个虚拟模型：

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

确认已保存的定义：

```bash
ocx combo show main
```

:::tip
先使用故障切换和相等权重。只有在你确实想要分散流量时，再切换到轮询；只有在相等分配不合适时，再添加权重。
:::

## combo 名称的工作方式

`ocx combo set <id>` 中的 combo id 必须以字母或数字开头。之后可以包含字母、数字、`.`、`_` 或 `-`，总长度最多 64 个字符。其规范模型 id 始终是 `combo/<id>`；例如，id `main` 会变成 `combo/main`。

在配置 combo 时，`combo/` 命名空间是保留的。名为 `combo` 的 provider 不能占用它，而 combo id 也不能与已配置的 provider 名称重复。

可选的别名会为 combo 提供不同的公开模型名。别名：

- 使用与 id 相同的字符集；
- 可以是无斜杠形式，例如 `daily-fast`，也可以包含一个 `/`，例如 `team/daily-fast`；
- 不能是 `combo` 或以 `combo/` 开头；
- 不能与其他 combo 别名重复；并且
- 通常不能是以 `gpt-`、`o1-`、`o3-`、`o4-` 或 `codex-` 开头的裸原生 OpenAI 系列名称；
  唯一例外是下方显式启用的 Desktop 兼容模式。

即使设置了别名，规范的 `combo/<id>` 形式仍然可以解析。规范查找会先于别名匹配，因此别名不能抢占另一个 combo 的规范 id。

:::note
别名只会改变客户端请求的公开名称，不会改变 combo 存储的 id，也不会改变其背后的具体 provider/model 选择器。
:::

## Codex Desktop 原生 allowlist 兼容模式

部分 Codex Desktop 版本会在 app-server 已经加载 `model_catalog_json` 后，再用远程
`available_models` allowlist 过滤选择器。这会让普通的 `Nova1/...` 路由模型在 CLI 中可用，
却不出现在 Desktop。可以显式让一个 combo 接管对应的裸原生 slug：

```bash
ocx combo set nova-sol \
  --targets Nova1/codex/gpt-5.6-sol \
  --alias gpt-5.6-sol \
  --native-alias \
  --display-name 'Nova1 - codex-gpt-5.6-sol'
```

该模式默认关闭，同时要求 `--native-alias` 和非空显示名称。alias 必须是当前 opencodex 版本
明确支持的原生 model id；只有原生系列前缀还不够，因为移除 alias 时必须能恢复权威 metadata。
如果路由目标的 discovery 只返回 model id，兼容行会从被接管的原生 id 补齐缺失的 context、
modality 和 reasoning metadata；目标显式声明的限制仍然优先，因此不会抬高 context cap 或覆盖
已经声明的能力。
`gpt-5.6-sol` 请求会先解析到
`combo/nova-sol`，catalog 中只保留一条带明确 Nova 标签的裸行。`combo/nova-sol` 用于禁用
这个 combo；`disabledModels` 中裸的 `gpt-5.6-sol` 仍只表示原生 OpenAI 行，不会误禁 combo。
配置任意 native alias 后，其他已禁用的裸原生行也会从有效 catalog 中移除，而不是仅标成
`visibility: "hide"`，从而防止 Desktop 无视隐藏标记后把它们重新显示出来。账户限定的
`main/gpt-5.6-sol` 仍是真实 OpenAI 路由。删除 combo 后，下次同步会恢复正常原生身份。

## 选择策略

### 故障切换：按顺序的主目标和备用目标

`failover` 会按配置顺序选择第一个合格目标。当 provider 存在、已启用、未处于冷却中，并且能够满足任何特殊请求约束时，该目标就是合格的。权重和 `stickyLimit` 不影响这种策略。

给定以下顺序：

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

每个请求都会先从 Anthropic 开始。Anthropic 的可重试失败会把该请求切换到 OpenAI；OpenAI 的可重试失败则可以切换到 Google。终止性错误会立即停止，而不会尝试剩余目标。

### 轮询：平滑的加权批次

`round-robin` 使用平滑加权轮询。更大的目标权重会让该目标在长期内获得更大的份额，但不会把它的全部份额一次性作为一个很长的连续块发送。`stickyLimit` 控制在下一次加权选择之前，有多少个成功请求会继续停留在当前选中的目标上。

创建一个 2:1 的 combo，并让每批包含两个成功请求：

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

把目标记为 **A**（权重 2）和 **B**（权重 1）时，前六次加权选择是 `A, B, A, A, B, A`。由于 `stickyLimit` 为 2，每次选择都会持续两个成功请求：

| 成功请求 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 目标 | A | A | B | B | A | A | A | A | B | B | A | A |

长期占比仍然是 2:1。一次可重试失败会结束当前 sticky 批次，使该目标进入冷却，并为同一个请求选择另一个合格目标。

:::caution
权重是相对值，不是百分比。权重 `2,1` 和 `200,100` 表达的是同样的比例。优先使用能清晰表达意图的小数值。
:::

## 目标失败时会发生什么

combo 失败分为 **跳转** 失败和 **终止** 失败。

| 结果 | 行为 |
| --- | --- |
| HTTP 401、403、404、408、429，或任何 5xx | 使该目标进入冷却，并跳转到下一个合格目标。 |
| 被分类为认证、订阅、配额、速率限制、过载或上游服务器错误 | 即使仅凭状态码不足以判断，也会使该目标进入冷却并跳转。 |
| 客户端取消（499）、`origin_rejected`、cyber-policy 拒绝、上下文溢出，或无效请求 | 停止并返回错误；换其他目标也无法让请求变得有效。 |
| 任何其他未分类错误 | 停止并返回错误。 |

被跳过的目标默认会进入 60 秒冷却。如果上游响应包含有效的 `Retry-After` 值，opencodex 会改用该值。数字秒数和 HTTP-date 值都可以接受，而且每次冷却最多只会封顶到 10 分钟。

当前请求不会再次重试同一个已经尝试过的目标。后续请求会跳过它，直到冷却结束。如果没有任何合格目标可用，代理会返回 HTTP 503，并带上 `error.code = "combo_unavailable"`。

:::note
故障切换是有边界的。它有助于处理特定目标的可用性、认证、配额和过载失败；它不会掩盖调用方错误或策略拒绝。
:::

## 默认推理力度

只有在以下所有条件都满足时，`defaultEffort` 才会提供 `reasoning.effort`：

1. combo 有一个非空默认值；
2. 调用方没有设置 effort；并且
3. 选中的目标目录明确声明了该精确的 effort。

如果请求没有 `reasoning` 对象，opencodex 会创建一个。如果 `reasoning` 存在但没有 `effort` 属性，它会保留其他字段并添加默认值。调用方提供的 effort 永远不会被覆盖。

当目标能力未知，或者不包含配置的 effort 时，opencodex 会省略默认值，并保持目标自身行为不变。支持的值是 `low`、`medium`、`high`、`xhigh`、`max` 和 `ultra`；省略该字段或将其设为 `null`，就会把 effort 完全交给调用方和目标。

## 加密的 v2 子代理任务

对于 Codex v2 子代理，有一个重要限制（[issue #92](https://github.com/lidge-jun/opencodex/issues/92)）。原生父进程只能把新启动 worker 的任务，以为原生 ChatGPT 后端生成的密文形式发送出去。外部 provider 无法读取那段负载。

对于这类请求，combo 会把合格目标筛选为规范的原生 ChatGPT 路由，即使在一次可重试失败之后也是如此。如果 combo 没有任何具备解密能力的目标，opencodex 会在分发前停止，并返回 HTTP 400：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

这样可以防止任务被发送到无法接收可读指令的 provider。可读的明文任务则使用正常的 combo 策略。

你有四种恢复方式：

1. 为子任务选择一个原生 ChatGPT 模型。
2. 向 combo 添加一个规范的原生 ChatGPT 目标。
3. 使用 v1 接口在不同 provider 之间委派。
4. 如果你控制调用方，请把任务作为明文 v2 `agent_message` 内容重新发送。

有关 v1/base/v2 模式以及完整的加密任务工作流，请参见 [子代理接口](/guides/sub-agent-surface/)。

## 管理 combo

### Dashboard

打开本地 dashboard 并选择 **Models → Combos**。该工作区可以创建、编辑、重命名和删除 combo，其目标选择器会排除已禁用的模型和嵌套 combo。

### CLI

主要命令如下：

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set` 也接受 `--strategy`、`--sticky`、`--effort`、`--alias`、`--native-alias`、
`--display-name` 和 `--rename-from`。将 `--effort`、`--alias` 或 `--display-name` 的值设为
`-` 可清除该字段。`--native-alias` 必须配合当前受支持的裸原生 alias 和非空显示名称使用。
`create` 和 `update` 是 `set` 的别名；`delete` 是 `remove` 的别名；同样的子命令也可通过
`ocx route combo` 使用。

### Management API

无头客户端会对 `/api/combos` 使用 `GET`、`PUT` 和 `DELETE`。`GET` 会列出规范化后的 combo 定义，`PUT` 会创建或替换一个定义（也可以重命名一个），`DELETE` 则使用 id 查询参数。认证以及请求/响应细节请见 [Management API 参考](/reference/management-api/)。

如需查看完整的持久化配置，请参见 [配置](/reference/configuration/)。

## 配置参考

combo 会存储在顶层的 `combos` 对象中，并以 combo id 作为键：

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| 字段 | 必填 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `targets` | 是 | — | 非空、有顺序的数组，元素为已配置的 `{ provider, model, weight? }` 目标。重复的 provider/model 对会被拒绝。 |
| `targets[].weight` | 否 | `1` | 1 到 10,000 的整数。轮询会使用它；故障切换会忽略它。 |
| `strategy` | 否 | `"failover"` | `"failover"` 或 `"round-robin"`。 |
| `stickyLimit` | 否 | `1` | 每次轮询选择可连续处理的成功请求数，范围为 1 到 100。 |
| `defaultEffort` | 否 | `null` | `low`、`medium`、`high`、`xhigh`、`max` 或 `ultra`；仅当调用方省略 effort 且目标声明支持时才会应用。 |
| `alias` | 否 | 无 | 可选的、已修剪的公开模型 id；使用上面的别名规则。空值会以“无别名”形式存储。 |
| `nativeAlias` | 否 | `false` | 显式允许当前受支持的裸原生 alias 接管路由和 catalog 优先级；绝不会根据 alias 自动推断。 |
| `displayName` | 否 | 无 | 仅用于 catalog 展示的有界标签；`nativeAlias` 为 true 时必须非空。 |

## 故障排查

### 为什么 `combo/<id>` 会返回 404？

combo id 不存在。响应是 HTTP 404，类型为 `invalid_request_error`。运行 `ocx combo list`，检查拼写和大小写，并确认你的管理命令写入的是同一个正在运行、并接收模型请求的 opencodex 实例。

### 为什么会收到 `combo_unavailable`？

当前每个目标都不可用：例如，它的 provider 被禁用、它正在冷却、它已经在这次请求中被尝试过，或者加密的 v2 任务把它排除了。检查目标的 provider 状态和最近的上游错误。对于冷却，请等待 60 秒的默认值或上游 `Retry-After` 时长（永远不会超过 10 分钟），然后重试。

### 为什么我的别名被拒绝了？

先检查别名语法和保留名称。重复别名或无效形状会被拒绝并返回 HTTP 400。首段是已配置 Codex 账户命名空间的带斜杠别名会被拒绝并返回 HTTP 409；请选用不同的别名命名空间。CLI 和 dashboard 会显示服务器返回的精确校验消息。

### 为什么故障切换在第一次错误后就停止了？

该错误是终止性的，而不是针对目标的。修复无效输入、缩小过大的上下文、处理策略拒绝，或者纠正被拒绝的请求来源。对于这些情况，combo 不会继续跳转。
