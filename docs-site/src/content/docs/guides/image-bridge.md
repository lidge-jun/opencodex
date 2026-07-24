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

- An xAI account with Grok access.
- Either `ocx login xai` (OAuth) or an xAI API key configured in settings.
- A non-OpenAI model selected as your active provider. (When the active provider is OpenAI,
  the native hosted tool is used directly and the bridge is bypassed.)

## Configuration

Image Bridge options live under `images` in `~/.opencodex/config.json`:

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
| `bridgeEnabled` | `true` | Master switch. Set `false` to disable bridging entirely. |
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
  turn, web search is served first and image generation may be deferred.
- **xAI costs apply.** Image generation via xAI requires an active xAI subscription or API credits.
- **OAuth proxy compatibility varies.** The OAuth proxy path may not fully support xAI image
  endpoints; API-key mode (`xai` provider with a configured key) is more reliable for image
  generation.
