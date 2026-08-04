---
title: Codex App 模型选择器
description: opencodex 中的模型如何通过共享 Codex 目录出现在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不会修改 Codex App。它会写入 Codex CLI/TUI 已经使用的同一套 Codex 配置和模型目录。因为 Codex App 读取的是这份共享状态，路由模型可以像普通 Codex 目录条目一样出现在 App 的模型选择器中。

OpenAI 条目有两种稳定身份：一个是不带命名空间的原生 `openai` 组，由 `codexAccountMode` 控制使用 Pool（默认）还是 Direct 的账户选择；另一个是命名空间化的 `openai-apikey/<model>` API key 通道。切换账户模式不会改变选择器 id。API GPT-5.6 条目使用 1,050,000 context / 922,000 max input，而 `*-pro` 选择器 id 会解析到基础线协议模型，并在日志、用量和选择器状态中保留虚拟 id，同时带上 `reasoning.mode: "pro"`。API 目录固定为恰好八个 id：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna，以及它们三个 Pro 虚拟 id；不存在通用的 `gpt-5.6-pro` 别名。Compact 请求会保留所选 tier，但发送基础模型且不带 reasoning 对象。

请显式选择凭据路径；在 Providers 页面切换 Pool/Direct：

```text
gpt-5.6-sol                         # openai (Pool or Direct option)
openai-apikey/gpt-5.6-sol           # API key
```

全新安装和没有保存模式的配置默认使用 Pool。当前配置使用 marker 2，并保留随发行版提供的 v1 源文件 `~/.opencodex/config.json.pre-openai-tiers-v2.bak`；可用以下命令恢复：

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

更早的 v1 三 provider 配置会自动迁移到这个支持单一选项的行。

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
| Codex 登录（Pool 或 Direct） | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`（372,000-token 目录窗口） |
| OpenAI（API key） | 恰好八个命名空间行：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna，以及三个 `*-pro` 虚拟 id（八个条目均为 1,050,000 context / 922,000 max input） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`（1,050,000） |
| Cursor | 静态回退包含 `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`（1,000,000），以及 `cursor/grok-4.5` 和 `cursor/grok-4.5-fast`（500,000）；实时账户发现会决定最终哪些条目仍然可见。 |
| xAI | 实时发现具有权威性；回退目录默认使用 `xai/grok-4.5`，上下文窗口为 500,000，并提供 `low` / `medium` / `high` reasoning 控制。 |

固定的 GPT-5.6 条目保留了精确的上游阶梯。Sol 和 Terra 暴露从 `low` 到 `ultra` 的档位；Luna 只到 `max`。Sol 默认是 `low`，Terra 和 Luna 默认是 `medium`。`ultra` 是面向客户端的最大 reasoning 加主动委派选项，在后端会以 `max` 传入。选择器里的一个条目只表示目录已经准备好：关联的账户或 API key 仍然必须有权使用该模型。

## 原生与路由模型开关

仪表盘 Models 页面对两类模型都使用 `disabledModels`：

- 路由 id 使用命名空间形式（`provider/model`）。禁用其中一个会把它从同步目录和 `/v1/models` 中移除。
- 原生 GPT id 是裸 slug。禁用其中一个会保留它的目录条目，但把 `visibility` 改成 `hide`，以便之后重新启用时精确保留该条目；禁用期间，裸 OpenAI 列表形态会把它省略。
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

但模型目录和运行时请求里的 tier id 使用的是 `priority`。opencodex 保留了这个拆分。原生 OpenAI 透传模型保留 fast 支持；路由到非 OpenAI 模型时会移除 service-tier 元数据，因此无法兑现的 fast 选项不会被展示出来。

## 子代理选择

Codex 会按 `priority` 升序对选择器可见的目录条目排序，并把前五个作为 `spawn_agent` 模型 override 暴露出来。你可以通过 `subagentModels` 或仪表盘的 Subagents 页面，选择最多五个裸原生 id 或命名空间化的 `provider/model` id；opencodex 会按所选顺序给这些条目分配 0-4 的 priority。其他模型仍然可以通过精确 id 调用。

精选模型列表与 Dashboard 的 **Sub-agent delegation** 选择彼此独立。它只决定 Codex 先提供哪些 override；它不会自己选择模型，也不会触发委派。

## 刷新模型状态

如果选择器里仍然显示旧条目，请刷新目录并重启目标 Codex 界面：

```bash
ocx sync
```

每当目录可见性、priority 或元数据发生变化时，opencodex 都会用一个刻意标记为过期的缓存 wrapper 重写 `models_cache.json`，这样 Codex 下次刷新模型时就会读取新目录。
