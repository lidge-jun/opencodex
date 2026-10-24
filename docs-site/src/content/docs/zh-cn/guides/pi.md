---
title: Pi
description: 在 Pi 中使用任意已路由模型 - `ocx export` 会为 Pi 的 `models.json` 写入一个自定义 provider 块，并连接到正在运行的代理。
---

Pi 从单个全局 JSON 文件读取提供商。opencodex 不会启动 Pi；`ocx export` 输出 `opencodex` 提供商块，其中包含基础 URL、模型列表和非秘密的本地密钥占位符。请将其合并到现有配置中。

## 快速开始

先启动代理，再打印配置：

```bash
ocx start
```

保持此进程运行。在另一个终端中输出配置：

```bash
ocx export --client pi
```

JSON 之后会显示目标路径、合并警告、回环使用提示，以及具有已确认上下文限制的模型数量。此导出仅支持无需认证的回环代理，不会配置远程访问认证。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

生成的 Pi 提供方配置启用了 `compat.sendSessionAffinityHeaders`。合并或手动编辑提供方时请保留该设置：Pi 提供稳定的会话标识，OpenCodex 据此为规范的 OpenCode Go 目标生成会话亲和标识。`cacheRetention` 为 `none` 时，Pi 可能不发送会话标识。

生成的 Pi 提供方配置还会把 `compat.supportsDeveloperRole` 设为 `false`，使 Pi 以 `system` 而不是 `developer` 角色发送系统提示词。OpenCodex 按原样转发 Chat Completions 角色，而部分 OpenAI 兼容上游会以 400 拒绝 `developer`；所有上游都接受 `system`。

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

## 准入密钥

导出的 `apiKey` 是非秘密占位符 `opencodex-loopback`，无需导出密钥环境变量。导出器只允许无需认证的回环代理，会拒绝远程代理或受令牌保护的代理。提供商凭证保留在 opencodex 配置中，参见[提供商](/zh-cn/guides/providers/)；不要把上游提供商密钥放入此 Pi 配置块。远程访问应使用支持代理访问凭证的集成。修改占位符不会启用 Pi 的远程导出。

## 模型元数据

只有当目录报告了权威的上下文窗口时，`contextWindow` 和 `maxTokens` 才会被输出。如果没有报告，这两个字段就会在该模型上省略，Pi 会应用自己的默认值；`ocx export` 会打印有多少行落入了这种情况。

输出上限使用目录或生成元数据中已知的模型上限，仅在未知时回退到 `32000`。输出上限始终不超过 context window；已知低于 `32000` 的上限也会保留。

有两个字段是刻意省略的。`cost` 需要全部四个价格字段，而 opencodex 没有已路由模型的价格数据 - 如果输出 0，会等于断言所有模型都是免费的。`reasoning` 在 Pi 里是一个布尔值，而目录里是一个 effort 层级，把二者互相映射只能是猜测。

## Schema 状态

:::note[未在真实安装上验证]
上面的结构遵循了 Pi 已公开的自定义 provider 文档。它**尚未**在一台安装了 Pi 的机器上、针对真实的 `~/.pi/agent/models.json` 进行验证。如果 Pi 拒绝这个导出块，问题在我们这边 - 请带上 Pi 的报错信息[提交 issue](https://github.com/lidge-jun/opencodex/issues)。
:::

## 需求

需要一个正在运行的 opencodex 代理（`ocx start`）以及已安装的 Pi。`ocx export` 通过代理的 management API 读取实时目录，因此配置永远不会在模型列表为空时被导出。
