---
title: Codex App 模型选择器
description: opencodex 中的模型如何通过共享 Codex 目录出现在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不会修改 Codex App。它会写入 Codex CLI/TUI 使用的同一套 Codex 配置和模型目录。
app-server 会读取这份共享状态，但部分 Codex Desktop 版本还会在 renderer 中应用第二层远程
allowlist，因此仍可能从选择器里删掉路由模型。

OpenAI 条目有两种凭据通道：原生 Codex 登录，以及命名空间化的 `openai-apikey/<model>` API key 通道。仅在 Pool 与 Direct 之间切换 `codexAccountMode` 不会改变选择器 id。但当 `codexAccountPickerEnabled` 启用了账户限定的选择器行，且 `codexAccountNamespaces` 中有目标账户存在的 selector 时，opencodex 会为映射账户添加独立的 `<selector>/<native-openai-model>` 行，并在选择器中隐藏裸原生行。Selector 名称是用户自定义的公开标签，没有内置的账户角色含义。选择带 `selector` 的行只会使用映射账户，不会更改当前 Pool 账户；目标不可用时，请求会直接失败，不会切换到其他账户。详情请参阅[精确 Codex 账户选择器](/reference/configuration/routing/#exact-codex-account-selectors)。

`codexAccountNamespaces` 映射为空时，账户限定的选择器行处于关闭状态。非空映射中省略 `codexAccountPickerEnabled` 时，为保持向后兼容会视为已启用。设为 `false` 会隐藏生成的账户限定行并恢复选择器中的裸原生行，但不会删除映射，也不会禁用精确的 `<selector>/<native-openai-model>` 路由。

API GPT-5.6 条目使用 1,050,000 context / 922,000 max input，而 `*-pro` 选择器 id 会解析到基础线协议模型，并在日志、用量和选择器状态中保留虚拟 id，同时带上 `reasoning.mode: "pro"`。API 目录固定为恰好八个 id：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna，以及它们三个 Pro 虚拟 id；不存在通用的 `gpt-5.6-pro` 别名。Compact 请求会保留所选 tier，但发送基础模型且不带 reasoning 对象。

请通过选择器 id 显式选择凭据路径。在 Providers 页面切换 Pool/Direct；下面的 `<selector>` 是
用户自定义、通过 `codexAccountNamespaces` 映射的公开标签：

```text
gpt-5.6-sol                         # 通过 Pool 或 Direct 使用 bare Codex 登录路由
<selector>/gpt-5.6-sol              # 映射到该 selector 的已保存 Codex 账户
openai-apikey/gpt-5.6-sol           # API key
```

全新安装和没有保存模式的配置默认使用 Pool。当前配置使用 marker 2，并保留随发行版提供的 v1 源文件 `~/.opencodex/config.json.pre-openai-tiers-v2.bak`；可用以下命令恢复：

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

更早的 v1 三 provider 配置会自动迁移到这个支持单一选项的行。

## Desktop 远程 allowlist 限制

如果 `codex debug models` 和 app-server 的 `model/list` 都包含某个路由模型，但 Desktop
没有显示它，根因通常是上游 [Codex #19694](https://github.com/openai/codex/issues/19694)。
启用远程 `use_hidden_models` 后，Desktop 可能只保留 `available_models` 中的原生 id，甚至会
重新显示 catalog 中已标记为 `hide` 的原生行。单纯刷新 catalog 或重启代理无法改变 renderer
策略。

对于等价的路由模型，opencodex 提供默认关闭的 native-alias combo 兼容模式：用明确的显示标签
发布 allowlist 接受的裸 slug，并让该 slug 在规范 OpenAI 路由之前进入指定 combo。只要配置了
native alias，已禁用的裸原生行就会从有效 catalog 中移除，避免 Desktop 无视隐藏状态将其复活。
命令、禁用键语义和安全限制见 [Codex Desktop 原生 allowlist 兼容模式](/zh-cn/guides/combos/#codex-desktop-原生-allowlist-兼容模式)。

## 集成路径

`ocx init`、`ocx start` 和 `ocx sync` 会把共享的 Codex 配置和目录接入代理；有关配置注入、目录同步、shim、WebSocket fallback 和恢复机制，请参见 [Codex Integration](/guides/codex-integration/)。

## 为什么路由模型会显示

Codex 的模型选择器需要 Codex 形状的目录条目。opencodex 会克隆一个原生 Codex 模型模板，然后替换路由模型的身份：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

克隆会保留严格解析器字段，例如 reasoning 档位、shell 类型、API 支持标志和 base instructions。随后，opencodex 会移除该路由无法兑现的仅原生能力，包括 OpenAI service-tier 元数据。

## 当前稳定模型覆盖

原生回退集合包含 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex-spark` 以及 GPT-5.6 Sol/Terra/Luna。对于 GPT-5.5/5.4 家族，opencodex 会保留已安装 Codex 目录中更丰富的实时条目，只在缺失时才合成条目。内置的上游快照只用于 GPT-5.6，因为它提供的是每个模型真实的身份和元数据，而不是较旧模板的近似版本。

| 路由 | 选择器 id 与目录元数据 |
| --- | --- |
| Codex 登录（账户限定的选择器行未启用） | 显示 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 等裸原生 id，并按 `codexAccountMode` 使用 Pool 或 Direct。GPT-5.6 行使用 922,000-token 目录窗口。 |
| Codex 登录（账户限定的选择器行已启用且存在有效 selector） | 为每个有效 selector 与受支持原生模型的组合显示 `<selector>/<native-openai-model>` 行。每行只使用映射账户，裸原生行会从选择器中隐藏。原生 metadata 与 context window 会保留。 |
| OpenAI（API key） | 恰好八个命名空间行：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna，以及三个 `*-pro` 虚拟 id（八个条目均为 1,050,000 context / 922,000 max input） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`（922,000） |
| Cursor | 静态回退包含 `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`（1,000,000），以及 Grok 4.5/4.6 的普通和 Fast 条目（500,000）。4.6 还提供 `xhigh`；实时账户发现会决定最终哪些条目仍然可见。 |
| xAI | 实时发现具有权威性。回退目录包含 `xai/grok-4.6`，默认模型仍为 `xai/grok-4.5`；两者的上下文窗口均为 500,000。Grok 4.6 提供 `low` / `medium` / `high` / `xhigh`（上游默认值为 `high`），Grok 4.5 最高为 `high`。 |

固定的 GPT-5.6 条目保留了精确的上游阶梯。Sol 和 Terra 暴露从 `low` 到 `ultra` 的档位；Luna 只到 `max`。Sol 默认是 `low`，Terra 和 Luna 默认是 `medium`。`ultra` 是面向客户端的最大 reasoning 加主动委派选项，在后端会以 `max` 传入。选择器里的一个条目只表示目录已经准备好：关联的账户或 API key 仍然必须有权使用该模型。

## 原生与路由模型开关

仪表盘 Models 页面为裸原生 id 和路由 `provider/model` id 提供 `disabledModels` 开关。
`disabledModels` 也支持账户限定的 `<selector>/<native-openai-model>` id，但仪表盘不会列出或切换这些
精确 selector 行；请把它们直接添加到配置中：

- 路由 provider id 使用命名空间形式（`provider/model`）。禁用后会从同步目录和
  `/v1/models` 中移除。
- 账户限定的原生 id 使用 `<selector>/<native-openai-model>` 形式。把该 id 写入
  `disabledModels` 只会隐藏对应的 selector 行。
- 裸原生 GPT id 是裸 slug。禁用后会隐藏裸行以及该模型的所有 account-selector 克隆行，
  同时保留目录条目以便之后重新启用。
- 配置 native-alias combo 后，被该 combo 遮蔽的裸原生行会从 Models 页面移除且不再显示原生开关；
  只有未被遮蔽的原生行保留开关，并可在重新启用时恢复原生 metadata。
- 原生行来自受支持的静态集合，因此被禁用的原生模型仍会在仪表盘中可见，并且可以重新打开。

可见性处理会在快照升级之后运行；每次切换后，管理 API 都会刷新目录，并强制让 Codex 的模型缓存失效。

## 多代理界面模式

Models 页面上的 v1/base/v2 控件会改变每个选择器条目使用的 Codex 协作界面；有关规范模式、委派、继承、fallback 以及加密任务行为，请参见 [Sub-agent Surface](/guides/sub-agent-surface/)。

## 推理顶档

推理档位的可见性与 v1/base/v2 界面模式无关。生成的、支持推理的条目会标出 `max`，以便直接设置的子代理 effort override 能通过校验；当前生成的路由条目和更早的原生 GPT 条目也会标出 `ultra`。精确的上游 GPT-5.6 阶梯会原样保留，因此 Luna 只有 `max`，没有 `ultra`。

在传输层面，路由 adapter 会映射或钳制不受支持的档位。对于真实阶梯止于 `xhigh` 的较老原生模型，`nativeEffortClamp` 会把直接的 `max` 或 `ultra` 选择映射到 `xhigh`，例如 GPT-5.5。Sol、Terra 和 Luna 都有真实的 `max` 档位。

## Fast tier 规则

Codex 会把 fast 模式保存为：

```toml
service_tier = "fast"

[features]
fast_mode = true
```

但模型目录和运行时请求里的 tier id 使用的是 `priority`。opencodex 保留了这个拆分。原生 OpenAI 透传模型保留 fast 支持；路由的提供商会按能力门控——只有当提供商声明 `supportsServiceTier: false` 时才会剥离 `service_tier`（注册表已将官方 OpenAI 分类为 `true`，DeepSeek 和 Volcengine Ark 分类为 `false`）；未分类的自定义网关会原样保留调用方提供的值且绝不注入，因此无法兑现的 fast 选项不会被展示，自定义网关也可以用 `true` 显式启用。

## 子代理选择

Codex 会按 `priority` 升序对选择器可见的目录条目排序，并把前五个作为 `spawn_agent` 模型 override 暴露出来。仪表盘 Subagents 页面最多可以选择并保存五个裸原生 id 或路由 `provider/model` id。手动设置的 `subagentModels` 也支持账户限定的 `<selector>/<native-openai-model>` id，但仪表盘不会提供这些精确 id；保存该页面会用仪表盘中可见的选项替换整个列表。opencodex 会按所选顺序分配较低的目录 priority；启用账户限定的选择器行时，裸原生选择会展开为 selector-qualified 分组。其他模型仍然可以通过精确 id 调用。

精选模型列表与 Dashboard 的 **Sub-agent delegation** 选择彼此独立。它只决定 Codex 先提供哪些 override；它不会自己选择模型，也不会触发委派。

## Desktop 远程服务器

Codex Desktop 的远程服务器模式会针对客户端自己的 `available_models` 白名单过滤模型选择器（当远程 `use_hidden_models` 设置启用时生效）。路由目录条目仍然会被加载并对外提供——`model/list` 会返回它们，内置 CLI 也能读取——但 Desktop 渲染层在显示前会丢弃任何不在这个仅包含原生模型的白名单中的条目。opencodex 无法影响这份白名单；上游问题在 [openai/codex#19694](https://github.com/openai/codex/issues/19694) 跟踪中。

在 Desktop 提供白名单控制之前：

- 在远程机器的 `~/.codex/config.toml` 中直接设置模型，例如 `model = "input/grok-4.5"`。选择器可能显示为 `Custom`，但请求仍会使用所配置的路由模型。
- 改用 Codex CLI 或 TUI，而不是 Desktop 选择器；它们不应用该白名单，会正常列出路由模型。

## 刷新模型状态

如果选择器里仍然显示旧条目，请刷新目录并重启目标 Codex 界面：

```bash
ocx sync
```

每当目录可见性、priority 或元数据发生变化时，opencodex 都会用一个刻意标记为过期的缓存 wrapper 重写 `models_cache.json`，这样 Codex 下次刷新模型时就会读取新目录。
