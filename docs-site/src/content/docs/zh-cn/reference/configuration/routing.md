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

1. 已配置的 `<account-selector>/<native-openai-model>` 命名空间，只会路由到映射的已存储 Codex
   账户。无效或不可用的精确目标会以 fail closed 方式失败。
2. 规范化的 `combo/<id>` 或已配置的 combo 别名。规范化 id 会优先于别名匹配。
3. 显式的 `<provider>/<model>` 命名空间，其前缀名称对应一个已配置的提供方。
4. 诸如 `gpt-*`、`o1-*`、`o3-*` 或 `o4-*` 之类未带前缀的原生 OpenAI 系列 id，会通过
   规范化且已启用的 `openai` 提供方进行路由。
5. 与某个提供方的 `defaultModel` 完全匹配。
6. 已知的提供方系列模型前缀。
7. 与某个提供方配置的 `models` 列表中的模型完全匹配。
8. `defaultProvider`，同时保留请求的 model id。

已禁用的提供方会被排除在外。对已禁用提供方的显式命名空间会直接失败，而不会继续
向后回退。对于可能匹配多个提供方的规则，提供方条目会按照其 JSON 插入顺序进行检查，
因此当一个裸模型可能存在歧义时，请使用显式命名空间。

## 精确 Codex 账户选择器

`codexAccountNamespaces` 会把 `side` 这样的公开 selector 映射到一个已存储 Codex 账户。
`side/gpt-5.6-sol` 请求即使在规范 `openai` 提供方处于 Direct mode 时也只使用该账户，并向
upstream 发送裸 `gpt-5.6-sol` model id。selector 后只能使用裸原生 OpenAI-family id。

精确选择会绕过 Pool 分配策略和普通 thread affinity。若映射账户不存在、已暂停、处于 cooldown、
不可用或需要重新认证，请求会 fail closed，不会切换到其他账户，也不会改变 active Pool account。
裸原生 model id 保持正常 Pool / Direct routing。namespace map 本身不会创建 model picker row。
selector 校验、冲突规则和隐私说明见[提供方配置](/reference/configuration/providers/)。

## Combos (`config.combos`)

每个 combo 键都是一个符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 的 id。它始终可以直接通过
`combo/<id>` 访问，也可以额外暴露一个 `alias`。别名必须唯一，不能占用 `combo/`
命名空间，也不能使用保留的原生裸系列，例如 `gpt-*`、`o1-*`、`o3-*`、`o4-*` 或
`codex-*`。

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | 有序的具体路由。`weight` 范围为 1–10000，默认值为 `1`。 |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | 选择策略。目标顺序表示故障切换优先级；权重会影响平滑加权轮询。 |
| `stickyLimit?` | `number` | `1` | 在单个轮询批次中保留的成功请求数。范围 1–100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | 仅在调用方省略 effort 且所选目标声明了请求的档位时应用。 |
| `alias?` | `string` | — | 可选的公开 model id，用于替代规范化的选择器 slug。 |

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

- 一个正的 `contextWindow`，来源可以是实时元数据、注册表提示，或提供方的
  `modelContextWindows` / `contextWindow`；以及
- 非空的 `inputModalities` 交集，其中省略的成员值按 `["text"]` 处理。

如果是一个没有上下文元数据的裸 relay id，或者目标之间的模态互不相交，combo 就会从
目录中移除。同步时会输出一条汇总警告，仪表板会将其标记为 **Needs attention**。
补充上下文元数据、对齐模态，或者把目标模型切换为可发现且兼容的能力。
