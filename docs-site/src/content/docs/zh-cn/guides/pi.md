---
title: Pi
description: 在 Pi 中使用任意已路由模型 - `ocx export` 会为 Pi 的 `models.json` 写入一个自定义 provider 块，并连接到正在运行的代理。
---

Pi 从一个全局 JSON 文件而不是环境变量中读取 providers，所以 opencodex 不会启动它。相反，`ocx export` 会序列化 `opencodex` provider 块——基础 URL、模型列表，以及一个非秘密的字面量 `apiKey` 占位值——然后你把它合并到自己的配置中。

## 快速开始

先启动代理，再打印配置：

```bash
ocx start
ocx export --client pi
```

输出会先显示 JSON，然后打印目标路径、合并警告、Pi 专用的启动前提示、模型总数，以及省略上下文限制的行数。

在 Pi 的 schema 中，`openai-completions` 表示兼容 Chat Completions 的 API；对应的 opencodex adapter 名称是 `openai-chat`。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

模型 id 是代理的规范选择器，因此已路由模型会显示为 `provider/model`（`anthropic/claude-opus-5`），而原生 OpenAI slug 会保持不带前缀（`gpt-5.6-sol`）。`name` 后缀 - `(anthropic)`、`(native)`、`(routed)` - 负责让两个同名但来自不同上游的模型在 Pi 的选择器中可区分。

## 放置位置

Pi 的全局模型配置位于：

```text
~/.pi/agent/models.json
```

:::caution[只合并，不要替换]
`ocx export` 永远不会写入那个文件。请把 `providers.opencodex` 块合并进去 - 直接替换整个文件会破坏你已配置的其他 provider。`--out` 只用于临时路径，并且如果不加 `--force` 就不会覆盖已有文件：

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

导出的块是静态快照，不是实时视图。新增 provider 或更改模型可见性后，请重新运行 `ocx export`，再用新的块覆盖旧块进行合并。

## Pi 的 `apiKey` 占位值

Pi 通常调用 `/chat/completions`，并将配置的 `apiKey` 作为 Bearer 认证值发送。因此，生成的块会在 Pi 的常规 `apiKey` 字段中写入非机密字面值 `opencodex-loopback`。

这个字面值既不是代理准入凭据，也不是上游 provider key。回环代理会忽略它，并且完全不需要凭据。不过它对模型发现是必需的：Pi 在构建模型列表时会解析 `apiKey`，如果该值是未设置的环境变量引用，它就会隐藏整个 provider；使用字面值才能让所有已路由模型保持可见。

Provider key 是另一回事：你的 Anthropic / OpenAI / OpenRouter key 保存在 opencodex 自己的配置中，见 [Providers](/guides/providers/)，它绝不会出现在这个文件里。

## 模型元数据

只有当目录报告了权威的上下文窗口时，`contextWindow` 和 `maxTokens` 才会被输出。如果没有报告，这两个字段就会在该模型上省略，Pi 会应用自己的默认值；`ocx export` 会打印有多少行落入了这种情况。

`maxTokens` 是一个满足 schema 的 `32000` 预算，并会向下钳制到上下文窗口，因此不会给小上下文模型分配超过其上下文容量的输出。它并不声称某个具体模型的真实最大值。

有两个字段是刻意省略的。`cost` 需要全部四个价格字段，而 opencodex 没有已路由模型的价格数据 - 如果输出 0，会等于断言所有模型都是免费的。`reasoning` 在 Pi 里是一个布尔值，而目录里是一个 effort 层级，把二者互相映射只能是猜测。

## Schema 状态

:::note[已在真实安装上验证]
上面的结构已在安装了 Pi 0.83.0 的机器上、针对真实的 `~/.pi/agent/models.json` 完成验证：该块通过校验，并且所有具有 Pi 所支持输入模态的已导出路由模型都会出现在 Pi 的模型选择器中。如果更新版本的 Pi 拒绝这个导出块，问题在我们这边 - 请带上 Pi 的报错信息[提交 issue](https://github.com/lidge-jun/opencodex/issues)。
:::

## 需求

需要一个正在运行的 opencodex 代理（`ocx start`）以及已安装的 Pi。`ocx export` 通过代理的 management API 读取实时目录，因此配置永远不会在模型列表为空时被导出。
