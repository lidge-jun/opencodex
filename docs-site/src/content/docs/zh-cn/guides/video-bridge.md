---
title: 视频桥接
description: 通过非 OpenAI 模型生成 Grok Imagine Video 视频。
---

## 概述

Video Bridge 允许你通过 opencodex 路由的任意非 OpenAI 模型使用 xAI 的 Grok Imagine Video 生成功能。启用后，系统会在对话中注入一个合成的 `video_gen` 工具。模型会像调用普通函数工具一样调用它；opencodex 拦截该调用，向 xAI 提交视频生成任务，轮询直到完成，然后下载结果。

## 前提条件

- 一个带有 **API key** 的 `xai` provider 条目（仅执行 `ocx login xai` 不够，视频桥接需要 key 认证，而不是 OAuth）
- 作为路由目标的非 OpenAI 模型（例如 Anthropic Claude、Google Gemini）
- 已配置 opencodex 通过该非 OpenAI provider 路由

> **⚠ 需要 provider key：** 只有当 `xai` provider 使用 API key 认证时，视频桥接才会生效。请在配置中加入以下内容：
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
>   }
> }
> ```
>
> 如果你是通过 `ocx login xai` 接入的（OAuth），provider 会保持在 `authMode: "oauth"`，桥接就会静默不启用。请在环境中设置 `XAI_API_KEY`，或者像上面那样直接硬编码密钥。

## 配置

在你的 `images` 配置中添加 `videoBridgeEnabled: true`：

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| 选项 | 默认值 | 说明 |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | 总开关，必须显式启用。 |
| `videoBridgeModel` | `"grok-imagine-video"` | xAI 视频模型 id。 |
| `videoMaxRounds` | `2` | 在强制输出最终答案前允许的最大视频生成轮数。 |
| `videoTimeoutMs` | `300000`（5 分钟） | 单个视频的超时时间，包括轮询在内。 |

## 工作原理

1. opencodex 检测到一个已路由的非 OpenAI 模型，并且 `videoBridgeEnabled: true`
2. 系统会在对话中注入一个合成的 `video_gen` 函数工具
3. 当模型调用 `video_gen` 时，opencodex 会向 xAI 的 `/videos/generations` 提交任务
4. 桥接每隔 5-15 秒轮询一次任务状态，并发送心跳消息以保持流持续存活
5. 视频准备就绪后，会下载到 artifacts 目录
6. 本地文件路径会作为工具结果返回给模型

## 支持的参数

`video_gen` 工具接受以下参数：

| 参数 | 类型 | 范围 | 说明 |
|-----------|------|-------|-------------|
| `prompt` | string | required | 详细的视频生成提示词 |
| `duration` | integer | 1-15 | 视频时长，单位为秒 |
| `resolution` | string | `"480p"`, `"720p"` | 视频分辨率 |
| `aspect_ratio` | string | 7 种比例 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3` |

## 限制

- **仅限 xAI**：视频生成只可通过 xAI 的 Grok Imagine Video API 使用
- **异步**：视频生成需要 30-120 秒
- **费用**：视频生成是 xAI 的付费功能（约 `480p` 每秒 `$0.05`，`720p` 每秒 `$0.07`）
- **每次调用只生成一个视频**：每次 `video_gen` 调用只会生成一个视频
- **可与图片桥接共存**：两种桥接可以同时启用
- **Web 搜索优先级**：当某一轮启用了 web search sidecar（非 `runTurn` adapter）时，视频桥接会被跳过，这两者不能并发运行。系统会发出 `console.warn`，方便你在日志中识别这一情况。
- **超时覆盖提交与轮询**：`videoTimeoutMs` 预算在任务提交之前就开始计时，因此提交调用（60 秒）和后续轮询共用同一个截止时间。
