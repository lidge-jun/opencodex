---
title: Image Bridge
description: Route image_generation hosted-tool calls to xAI Grok Imagine when using a non-OpenAI provider.
---

## Overview

When you route Codex through a non-OpenAI model (Claude, Gemini, Grok, etc.), the
`image_generation` **hosted tool** normally doesn't work — it requires OpenAI's server-side
execution environment. The Image Bridge detects these calls and transparently reroutes them to
xAI Grok Imagine, so the model you're actually chatting with can still generate images.

## Prerequisites

- **Enable the bridge** by setting `images.bridgeEnabled: true` in your config (it is off by
  default to avoid unexpected xAI charges — see [Configuration](#configuration) below).
- An xAI provider configured in settings with `baseUrl: "https://api.x.ai/v1"` and the
  `openai-chat` adapter.
- Authentication via `authMode: "oauth"` (`ocx login xai` — uses a stored, auto-refreshed
  bearer token) or `authMode: "key"` (a configured API key).
- A non-OpenAI model selected as your active provider. (When the active provider is OpenAI,
  the native hosted tool is used directly and the bridge is bypassed.)

## Configuration

Image Bridge options live under `images` in `~/.opencodex/config.json`. Bridging is
**opt-in** — you must set `bridgeEnabled: true` to enable paid xAI Grok Imagine generation:

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `bridgeEnabled` | `false` | Master switch. Set `true` to enable bridging. Off by default to avoid unexpected xAI charges. |
| `bridgeModel` | `grok-imagine-image-quality` | The xAI image model id to send prompts to. |
| `maxRounds` | `3` | Maximum number of image-generation loop iterations per turn. |

## How It Works

1. When Codex sends a request with `image_generation` in the tools array, OpenCodex detects it
   during request preprocessing.
2. The hosted tool is replaced with a **synthetic function tool** that the routed model can call
   normally — the model sees a callable tool rather than an opaque hosted tool it can't execute.
3. When the model invokes that tool, OpenCodex intercepts the call and sends the prompt to xAI's
   image generation API.
4. Generated images are saved to `~/.opencodex/artifacts/` and the **local file path** is returned
   to the model as the tool result.
5. The model continues the conversation with knowledge of the generated image and its location.

From the model's perspective nothing changed — it called a tool and got a result. From the user's
perspective, image generation works with any routed provider instead of silently failing.

## Limitations

- **Only xAI Grok Imagine is supported.** DALL-E and other image providers may be added later.
- **Web search takes priority.** If both web search and image generation are requested in the same
  turn, the web-search bridge runs and image generation is skipped for that turn.
- **xAI costs apply.** Image generation via xAI requires an active xAI subscription or API credits.
- **Streaming only.** The bridge works by intercepting the SSE response stream; requests with
  `stream: false` are rejected with a 400 error.
