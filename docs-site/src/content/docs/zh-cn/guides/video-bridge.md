---
title: 视频桥接
description: 通过非 OpenAI 模型生成 Grok Imagine Video 视频。
---

## 概述

Video Bridge 允许你通过 opencodex 路由的任意非 OpenAI 模型使用 xAI 的 Grok Imagine Video 生成功能。启用后，系统会在对话中注入一个合成的 `video_gen` 工具。模型会像调用普通函数工具一样调用它；opencodex 拦截该调用，向 xAI 提交视频生成任务，轮询直到完成，然后下载结果。

默认情况下任务发送到 xAI；可以通过 `images.videoProvider` 改为发送到其他兼容后端。

## 前提条件

这些前提条件适用于默认的 xAI 目标。如果设置了 `images.videoProvider`，请参见[选择视频提供方](#选择视频提供方)。

- 一个带有 **API key** 的 `xai` provider 条目（仅执行 `ocx login xai` 不够，视频桥接需要 key 认证，而不是 OAuth）
- 作为路由目标的非 OpenAI 模型（例如 Anthropic Claude、Google Gemini）
- 已配置 opencodex 通过该非 OpenAI provider 路由

> **⚠ 需要 provider key：** 只有当 `xai` provider 使用 API key 认证时，视频桥接才会生效。请在配置中加入以下内容：
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> 在代理的启动环境中设置 `XAI_API_KEY`，保留 `${XAI_API_KEY}` 并明确使用 `authMode: "key"`。在其他终端导出不会改变已运行的代理；请通过所属 Desktop、服务或前台终端重启。不要将密钥写入提交、日志或共享报告。

## 配置

在你的 `images` 配置中添加 `videoBridgeEnabled: true`：

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| 选项 | 默认值 | 说明 |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | 总开关，必须显式启用。 |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | xAI 视频模型 id。 |
| `videoMaxRounds` | `2` | 在强制输出最终答案前允许的最大视频生成轮数。 |
| `videoTimeoutMs` | `300000`（5 分钟） | 单个视频的超时时间，包括轮询在内。 |
| `videoProvider` | 未设置（xAI） | 可选的 API 密钥提供方，使用其自身的 `baseUrl` 和密钥处理 `video_gen`。参见[选择视频提供方](#选择视频提供方)。 |

## 选择视频提供方

默认情况下，桥接使用 `xai` 提供方的 API 密钥把 `video_gen` 任务发送到 xAI。若要发送到实现了相同异步 API（先 `POST {baseUrl}/videos/generations`，再 `GET {baseUrl}/videos/{id}`）的其他后端（例如自托管的媒体桥接），请设置 `images.videoProvider`。

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- 只使用所指定提供方自身的 `baseUrl` 和 API 密钥作为目标和凭据。适配器类型不限，但必须使用 API 密钥认证。
- `"videoProvider": "xai"` 始终使用固定的 `https://api.x.ai/v1`，与 `xai` 条目的 `baseUrl` 无关。其他内置提供方 ID 会被拒绝，请改为指定自定义提供方。
- 回环或私有网络的 `baseUrl` 与其他提供方流量一样，需要在该提供方上设置 `allowPrivateNetwork: true`。
- OpenCodex 能识别为 xAI 的密钥（`xai-` 格式的密钥、任何 `xai` 条目持有的密钥，或以 xAI、Grok 命名的环境变量引用）只会发送到 `https://api.x.ai` 或 `https://cli-chat-proxy.grok.com`，其他来源一律拒绝。没有这些特征的密钥无法识别，因此不要把 xAI 密钥粘贴到其他提供方的条目中。指向其他提供方机密的钥匙串引用始终会被拒绝，已暂停的当前密钥同样会被拒绝，`baseUrl` 也不能包含凭据、查询参数或片段。
- 如果提供方不存在、已禁用、已暂停、没有密钥或被拒绝，每次 `video_gen` 调用都会把该错误返回给模型。不会发送任何内容，也不会回退到 xAI。
- 生成的视频仍然只从 base64 `data:` URL 或公网 `https:` URL 下载，因此本地桥接必须以 `video.url` 返回其中之一。

## 工作原理

1. opencodex 检测到一个已路由的非 OpenAI 模型，并且 `videoBridgeEnabled: true`
2. 系统会在对话中注入一个合成的 `video_gen` 函数工具
3. 当模型调用 `video_gen` 时，opencodex 会向 xAI 的 `/videos/generations` 提交任务（若设置了 `images.videoProvider`，则提交到该提供方）
4. 桥接每隔 5-15 秒轮询一次任务状态，并发送心跳消息以保持流持续存活
5. 视频准备就绪后，会下载到 artifacts 目录
6. 本地文件路径会作为工具结果返回给模型

## 支持的参数

`video_gen` 工具接受以下参数：

| 参数 | 类型 | 范围 | 说明 |
|-----------|------|-------|-------------|
| `prompt` | string | optional with an image | Text prompt |
| `duration` | integer | 1-15 | 视频时长，单位为秒 |
| `resolution` | string | `480p`, `720p`, `1080p` | Model-dependent |
| `aspect_ratio` | string | model-dependent | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2` |
| `image` | string | first frame | HTTPS URL, data URL or remembered artifact |
| `last_frame` | string | 1.5 only | Last frame |
| `keyframes` | array | 1.5, max 4 | `{image, timestamp_s}`; timestamp must be inside the clip |
| `reference_images` | array | 1.5: 14, classic: 7 | Image references; 1.5 limited to 720p |

### 模型和图像输入

| Model | Resolution | Inputs | 每秒 (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p 原生 | 首帧/末帧, 4 关键帧, 14 参考图 (720p 最多) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (默认) | 480p / 720p / 1080p 放大 | 首帧 | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | 首帧, 7 参考图 | $0.05 / $0.07 / — |

要固定帧或使用参考图，请将 `images.videoBridgeModel` 设置为 `grok-imagine-video-1.5`。已知模型支持九种宽高比；未知模型保留七种比例和 480p/720p，不支持图像输入。支持 HTTPS URL 和解码后不超过 10 MiB 的 PNG/JPEG/WebP 数据 URL。图像桥下载的图像可在一小时内通过产物 URL、绝对路径或 `file:` URL 引用；桥使用保存的源 URL，绝不读取本地文件。此引用仅适用于固定的 xAI 目标，不适用于自定义 `images.videoProvider`。内联结果没有源 URL，临时 URL 也可能提前过期。


## 限制

- **默认使用 xAI**：未设置 `videoProvider` 时，视频生成使用 xAI 的 Grok Imagine Video API；其他后端必须实现相同的异步 API
- **异步**：视频生成需要 30-120 秒
- **每次调用只生成一个视频**：每次 `video_gen` 调用只会生成一个视频
- **可与图片桥接共存**：两种桥接可以同时启用
- **Web 搜索优先级**：当某一轮启用了 web search sidecar（非 `runTurn` adapter）时，视频桥接会被跳过，这两者不能并发运行。系统会发出 `console.warn`，方便你在日志中识别这一情况。
- **超时覆盖提交与轮询**：`videoTimeoutMs` 预算在任务提交之前就开始计时，因此提交调用（60 秒）和后续轮询共用同一个截止时间。
