---
title: 图像桥接
description: 在使用非 OpenAI 提供方时，将 image_generation 托管工具调用路由到 xAI Grok Imagine。
---

## 概述

当你将 Codex 路由到非 OpenAI 模型（Claude、Gemini、Grok 等）时，`image_generation` **托管工具**通常无法工作，因为它需要 OpenAI 的服务端执行环境。Image Bridge 会检测这些调用，并将其透明地重路由到 xAI Grok Imagine，这样你实际在对话的模型仍然可以生成图像。

## 前提条件

- **启用桥接**：在配置中设置 `images.bridgeEnabled: true`（默认关闭，以避免意外产生 xAI 费用 - 见下文的 [配置](#configuration)）。
- 配置一个带有 **API 密钥** 的 `xai` provider 条目。桥接会将执行固定到注册表中的 xAI Images 端点（`https://api.x.ai/v1`）；任何已配置的 `baseUrl` 覆盖都会被图像调用忽略。仅有 OAuth / `ocx login xai` **不会** 让桥接生效（Grok CLI 的 OAuth 传输是面向聊天的，不用于 `/images/*`）。

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- 选定一个非 OpenAI 模型作为当前 active provider。（当 active provider 是 OpenAI 时，会直接使用原生托管工具，桥接会被绕过。）

## 配置

Image Bridge 的选项位于 `~/.opencodex/config.json` 的 `images` 下。桥接是 **显式启用** 的 - 你必须设置 `bridgeEnabled: true` 才会启用付费的 xAI Grok Imagine 生成能力：

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `bridgeEnabled` | `false` | 总开关。设为 `true` 以启用桥接。默认关闭，以避免意外产生 xAI 费用。 |
| `bridgeModel` | `grok-imagine-image-quality` | 发送提示词到的 xAI 图像模型 ID。 |
| `maxRounds` | `3` | 每个回合的最大图像生成循环迭代次数。会向下取整为整数，并限制在 `[0, 10]`；非有限值会回退到 `3`。 |
| `timeoutMs` | `60000` | 每次调用的 xAI 截止时间，单位毫秒。有限且为正的值会向下取整后传入 xAI 请求。 |
| `artifactsKeepCount` | `200` | 在 `artifacts/` 下保留的最大文件数。超过后，会在每次完成调用后删除最旧的文件。设为 `0` 或负值可禁用清理。 |

## 产物保留

生成的图像会写入 `~/.opencodex/artifacts/`。为了避免长期运行的会话中磁盘无限增长，目录会在每次完成的图像调用之后自动清理（也就是该调用的整批文件都已落盘之后） - 当文件数超过配置的最大值时，会删除最旧的文件（按修改时间排序）（默认 200，可通过 `images.artifactsKeepCount` 配置）。只有在清理后仍然保留的路径才会返回给模型。

## 工作原理

Image Bridge 只会在 **Responses** 回合中生效，且仅当 `/v1/responses` 的 `tools` 数组里包含托管的 `image_generation` 工具，并且当前选择的是 **非 OpenAI** 模型时才会激活。它**不会**拦截 Codex 内置的 `image_gen` 工具，因为后者会直接 POST 到 `/v1/images/generations`（或 `/images/edits`） - 这条路径在 [Codex 集成](/guides/codex-integration/#built-in-image-generation-image_gen) 中单独覆盖。

1. 当某个 Responses 请求在 `tools` 中列出 `image_generation` 时，OpenCodex 会在请求预处理阶段检测到它。
2. 托管工具会被替换为一个 **合成函数工具**，路由后的模型可以像正常工具一样调用它 - 模型看到的是一个可调用工具，而不是一个自己无法执行的、不可见的托管工具。
3. 当模型调用该工具时，OpenCodex 会拦截这次调用，并将提示词发送到 xAI 的图像生成 API。
4. 生成的图像会保存到 `~/.opencodex/artifacts/`，并将 **本地文件路径** 作为工具结果返回给模型。
5. 模型随后会在了解生成图像及其位置的情况下继续对话。

从模型视角看，一切都没有变化 - 它调用了一个工具并拿到了结果。从用户视角看，图像生成可以在任何被路由的 provider 上正常工作，而不会悄然失败。

## 限制

- **仅支持 xAI Grok Imagine。** DALL-E 和其他图像提供方未来可能会加入。
- **Web 搜索优先。** 在支持 web-search sidecar 循环的 adapter 上，如果同一回合同时请求了 web 搜索和图像生成，会先运行 web-search，图像生成会被跳过。Cursor/`runTurn` adapter 目前不能使用该 sidecar，因此这些双工具回合中图像桥接仍可能运行。
- **会产生 xAI 成本。** 通过 xAI 进行图像生成需要有效的 xAI 订阅或 API credits。
- **仅支持流式。** 桥接通过拦截 SSE 响应流实现；`stream: false` 的请求会以 400 错误被拒绝。
