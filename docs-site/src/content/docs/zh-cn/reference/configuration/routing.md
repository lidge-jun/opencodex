---
title: 路由配置
description: 默认提供方选择、模型解析顺序、组合别名、目标顺序以及 effort 默认值。
---

路由会把客户端发送的 model id 转换为一个具体的提供方和上游模型。

## 顶层路由字段

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | 当没有更早的模型规则匹配时使用的最终提供方。它必须是一个已启用且已配置的提供方名称。 |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | 由有序的提供方/模型目标构建出来的虚拟 `combo/<id>` 模型。 |

## 模型解析顺序

opencodex 按以下顺序解析请求的模型：

1. 已配置的 `policy/<id>` 或路由策略配置文件别名，会执行策略评估器并路由到选定的候选。
   未解析的 `policy/<id>` 会继续按后续规则进行常规解析。
2. 已配置的 `<account-selector>/<native-openai-model>` 命名空间，只会路由到映射的已存储 Codex
   账户。无效或不可用的精确目标会以 fail closed 方式失败。
3. 规范化的 `combo/<id>` 或已配置的 combo 别名。规范化 id 会优先于别名匹配。
4. 显式的 `<provider>/<model>` 命名空间，其前缀名称对应一个已配置的提供方。
5. 诸如 `gpt-*`、`o1-*`、`o3-*` 或 `o4-*` 之类未带前缀的原生 OpenAI 系列 id，会通过
   规范化且已启用的 `openai` 提供方进行路由。
6. 与某个提供方的 `defaultModel` 完全匹配。
7. 已知的提供方系列模型前缀。
8. 与某个提供方配置的 `models` 列表中的模型完全匹配。
9. `defaultProvider`，同时保留请求的 model id。

已禁用的提供方会被排除在外。对已禁用提供方的显式命名空间会直接失败，而不会继续
向后回退。对于可能匹配多个提供方的规则，提供方条目会按照其 JSON 插入顺序进行检查，
因此当一个裸模型可能存在歧义时，请使用显式命名空间。

### 被阻止模型重定向

`blockedModelRedirects` 是可选的顶层 `Record<string, string>`，用于精确替换已解析的模型 ID，默认未设置。它在上述解析顺序之后运行：匹配后会保留已选定的提供方和账户路由，仅替换上游模型 ID，并记录路由原因 `blocked-model-redirect`。省略该键则路由保持不变。

```json
{
  "blockedModelRedirects": { "gpt-5.6-terra": "gpt-5.6-luna" }
}
```

## 精确 Codex 账户选择器

`codexAccountNamespaces` 会把 `side` 这样的公开 selector 映射到一个已存储 Codex 账户。
`side/gpt-5.6-sol` 请求即使在规范 `openai` 提供方处于 Direct mode 时也只使用该账户，并向
upstream 发送裸 `gpt-5.6-sol` model id。selector 后只能使用裸原生 OpenAI-family id。

精确选择会绕过 Pool 分配策略和普通 thread affinity。若映射账户不存在、已暂停、处于 cooldown、
不可用或需要重新认证，请求会 fail closed，不会切换到其他账户，也不会改变 active Pool account。
配置至少一个合格 selector 后，Codex catalog 会隐藏 bare native picker row，并为每个 selector 显示
独立的 `<selector>/<native-openai-model>` row。除非显式禁用，bare native model id 仍保持正常的 Pool /
Direct routing，并继续出现在 raw `/v1/models` 中。映射到缺失已保存账户的 selector 不会被展示。
selector 校验、冲突规则和隐私说明见[提供方配置](/reference/configuration/providers/)。

Codex Auth 页面将此 picker 行为作为选择加入项。关闭它会隐藏生成的 selector-qualified picker
行并恢复普通 GPT 行，但不会移除映射，也不会改变精确 `<selector>/<model>` 路由。因此再次
启用时会恢复相同的公开标签。账号和设置变更会在有界 catalog refresh 前持久化；出现
`ocx sync` 警告只表示 picker 目录仍需收敛，并不表示路由变更丢失。

## Combos (`config.combos`)

每个 combo 键都是一个符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 的 id。它始终可以直接通过
`combo/<id>` 访问，也可以额外暴露一个 `alias`。别名必须唯一，不能占用 `combo/`
命名空间，也不能使用保留的原生裸系列，例如 `gpt-*`、`o1-*`、`o3-*`、`o4-*` 或
`codex-*`，除非通过 `nativeAlias: true` 显式启用 Desktop 兼容契约。

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | 有序的具体路由。`weight` 范围为 1–10000，默认值为 `1`。 |
| `strategy?` | `"failover" \| "round-robin" \| "random" \| "least-used" \| "reset-window"` | `"failover"` | 选择策略。目标顺序表示 `failover` 优先级；`weight` 决定 `round-robin` 和 `random` 的抽取权重；`least-used` 根据记录的成功次数选择；`reset-window` 跟随最近的额度重置。 |
| `stickyLimit?` | `number` | `1` | 在单个轮询批次中保留的成功请求数。范围 1–100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | 仅在调用方省略 effort 且所选目标声明了请求的档位时应用。 |
| `imageInput?` | `"auto" \| "disabled"` | `"auto"` | `"auto"` 仅在每个目标都支持图片时发布图片能力；`"disabled"` 强制仅文本（从对外能力中去掉图片，并在分发前拒绝带图请求）。 |
| `alias?` | `string` | — | 可选的公开 model id，用于替代规范化的选择器 slug。 |
| `nativeAlias?` | `boolean` | `false` | 仅让当前受支持的裸原生 id 对该不带限定前缀的 id 优先；带账号或提供方限定的 OpenAI 路由仍是独立路由。 |
| `displayName?` | `string` | — | 仅用于 catalog 展示的标签；native alias 必须提供非空值。 |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

关于策略行为、可重试失败、冷却时间、加密 v2 任务限制以及管理命令，请参见 [Combos](/guides/combos/)。

### 目录可列出性

即使某个 combo 不能被列出，它仍然可以直接路由。只有当所有目标都暴露出可以交集的能力时，`ocx sync`、`/v1/models` 和 Codex 选择器才会列出它：

- 一个正的 `contextWindow`，来源可以是实时元数据、注册表提示、提供方的
  `modelContextWindows` / `contextWindow`、成员行上已知的正 `maxInputTokens`，或者——当提供方已知且启用但所有来源仍未给出窗口时——
  保守的 128,000 token 回退（若配置了 `providerContextCaps` 则会按上限夹紧）；以及
- 非空的 `inputModalities` 交集，其中省略的成员值按 `["text"]` 处理。

目标位于已禁用提供方（即使有完整 discovery 行）、未知且无 discovery 行的提供方，或目标之间的模态互不相交时，combo 会从
目录中移除。同步时会输出一条汇总警告，仪表板会将其标记为 **Needs attention**。
补充上下文元数据、对齐模态，或者把目标模型切换为可发现且兼容的能力。

## 路由策略配置文件（`config.routingProfiles`）

显式请求的 `policy/<id>`（或配置的别名）会在固定的候选白名单中，根据硬性能力要求与确定性、可解释的评分进行选择。现有模型 ID 永远不会隐式经过配置文件。支持 `candidates`（显式白名单）、可选 `alias`、`require`（`minContextWindow`、`minQuotaHeadroom`、`tools`、`imageInput`、`structuredOutput`、`localOnly`、`remoteAllowed`、`encryptedCodexTasks`、`reasoningEffort`、`serviceTier`）、`optimize`（latency/health/cost/quota 权重）、`limits.maxEstimatedCostUsd`、`unknownEvidence`（allow/penalize/exclude）。未知不会被当作零或免费。

CLI：`ocx route policy list`、`ocx route policy show <id>`、`ocx route policy dry-run <id> --model-context <tokens> --tools`、`ocx route policy evaluate <id>`。

组合是采用可选策略的显式目标路由（有序 `failover`、平滑加权的 `round-robin` 或 `random` 均衡、`least-used`，以及 `reset-window`）：由配置的策略决定目标，可重试失败则沿列表继续尝试；策略配置文件是基于证据在候选之间进行选择。

## 请求历史与路由分析

- `GET /api/request-history` - 从派生索引（`routing-history.sqlite`）进行游标分页的全历史查询。过滤器：`provider`、`model`、`requestedModel`、`status`、`conversationId`、`surface`、`inboundProtocol`、`apiKeyId`、`profileId`、`fallback`、`from`、`to`。
- `GET /api/request-history/:requestId/route-decision` - 为什么选择此路由（跟踪、候选、排除、分数、配置文件+版本、执行尝试、结果）。
- `GET /api/routing-analytics` - 成功/失败/取消/回退率、p50/p95/p99 耗时与 TTFT、不完整流率、冷却失败数、每次成功请求的估算成本、覆盖率、置信度、截断标志。
- `GET /api/routing-profiles`、`POST /api/routing-profiles/dry-run` - 配置文件查看与试运行评估（不发送上游请求）。

返回的历史记录与路由决策负载仅暴露已脱敏的请求元数据（例如不透明的 `apiKeyId` 标签）。不包含凭证、原始提示正文或提供商密钥。

CLI：`ocx logs explain <request-id>`、`ocx logs rebuild-index`、`ocx logs index-status`。

## 迁移

`routingProfiles` 是可选的增量配置：现有配置文件与旧 `usage.jsonl` 行均可原样加载。索引是一次性的——删除后会在下次查询时从 `usage.jsonl` 自动重建。系统不会自动调优。
