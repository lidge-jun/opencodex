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
- An `xai` provider entry with an **API key**. The Responses Image Bridge pins fulfillment to the
  registry xAI Images endpoint (`https://api.x.ai/v1`); any configured `baseUrl` override is
  ignored for image calls. OAuth / `ocx login xai` alone does **not** arm this sidecar loop.
  The same `bridgeEnabled` flag does arm the separate Codex `/v1/images` relay so the built-in
  `image_gen` client can call Imagine with the Grok CLI grant — see
  [Built-in image generation](/guides/codex-integration/#built-in-image-generation-image_gen).
  If that grant (or an xAI API key) is missing, `/v1/images` returns an error instead of
  falling through to ChatGPT.

  The relay only owns the route when no image provider is configured: it runs when
  `images.bridgeEnabled` is `true` **and** `images.provider` is omitted. Setting
  `images.provider` explicitly hands `/v1/images` to that provider, and its own
  validation errors are returned as-is rather than being retried through xAI.

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

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
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `bridgeEnabled` | `false` | Master switch. Set `true` to enable bridging. Off by default to avoid unexpected xAI charges. |
| `bridgeModel` | `grok-imagine-image-quality` | The xAI image model id to send prompts to. |
| `maxRounds` | `3` | Maximum image-generation loop iterations per turn. Floored to an integer and clamped to `[0, 10]`; non-finite values fall back to `3`. |
| `timeoutMs` | `60000` | Per-call xAI deadline in milliseconds. Finite positive values are floored and passed to the xAI request. |
| `artifactsKeepCount` | `200` | Maximum number of files retained under `artifacts/`. When exceeded, the oldest files are deleted after each fulfilled call. Set to `0` or a negative value to disable pruning. |

## Artifact Retention

Generated images are written to `~/.opencodex/artifacts/`. To prevent unbounded disk
growth in long-running sessions, the directory is pruned automatically after each fulfilled
image call (once the full batch for that call is on disk) — the oldest files (by modification
time) are deleted when the count exceeds the configured maximum (default 200, configurable via
`images.artifactsKeepCount`). Only paths that survive pruning are returned to the model.

## How It Works

The Image Bridge activates only on **Responses** turns that include the hosted
`image_generation` tool in the `/v1/responses` tools array while a **non-OpenAI**
model is selected. It does **not** intercept Codex's built-in `image_gen` tool,
which POSTs directly to `/v1/images/generations` (or `/images/edits`) — that path
is covered separately in [Codex Integration](/guides/codex-integration/#built-in-image-generation-image_gen).

1. When a Responses request lists `image_generation` in `tools`, OpenCodex detects it
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
- **Web search takes priority** on adapters that support the web-search sidecar loop. If both web
  search and image generation are requested in the same turn, web-search runs and image
  generation is skipped. Cursor/`runTurn` adapters cannot use that sidecar today, so the image
  bridge may still run for those dual-tool turns.
- **xAI costs apply.** Image generation via xAI requires an active xAI subscription or API credits.
- **Streaming only.** The bridge works by intercepting the SSE response stream; requests with
  `stream: false` are rejected with a 400 error.
