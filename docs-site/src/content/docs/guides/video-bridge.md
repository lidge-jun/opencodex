---
title: Video Bridge
description: Generate videos with Grok Imagine Video through a non-OpenAI model.
---

## Overview

The Video Bridge lets you use xAI's Grok Imagine Video generation through any non-OpenAI model
routed by opencodex. When enabled, a synthetic `video_gen` tool is injected into the conversation.
The model calls it like any function tool; opencodex intercepts the call, submits a video generation
job to xAI, polls until completion, and downloads the result.

## Prerequisites

- An `xai` provider entry with an **API key** (`ocx login xai` alone is not sufficient — the video bridge requires key auth, not OAuth) — unless `images.videoProvider` names another key-auth provider, which then supplies both the destination and the credential
- A non-OpenAI model as your routed provider (e.g. Anthropic Claude, Google Gemini)
- opencodex configured to route through the non-OpenAI provider

> **⚠ Provider key required:** With no `videoProvider` set, the video bridge only activates when
> the `xai` provider uses API key auth. Add this to your config:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> Set `XAI_API_KEY` in the proxy startup environment, keep the `${XAI_API_KEY}` reference and explicitly select `authMode: "key"`. Exporting it in another terminal does not change an already running proxy; restart through its owning Desktop app, service, or foreground terminal so it inherits the value. Keep literal keys out of commits, logs and shared reports.

## Configuration

Add `videoBridgeEnabled: true` to your `images` config:

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

| Option | Default | Description |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Master switch. Must be explicitly enabled. |
| `videoBridgeModel` | `"grok-imagine-video"` | xAI video model id. |
| `videoMaxRounds` | `2` | Max video-gen rounds before forced final answer. |
| `videoTimeoutMs` | `300000` (5 min) | Per-video timeout including polling. |
| `videoProvider` | *(unset)* | Custom video bridge destination (#8175). Names a configured provider; only its own `baseUrl` and API key are used. |

### Custom video provider

By default the video bridge talks to xAI's pinned endpoint. Set `images.videoProvider` to the
name of a configured provider to route the `video_gen` submit and poll calls elsewhere —
for example a self-hosted bridge or any vendor exposing an xAI-compatible async video API
(same contract: `POST {baseUrl}/videos/generations`, poll `GET {baseUrl}/videos/{id}`):

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
    "videoBridgeModel": "grok-imagine-video"
  }
}
```

The named provider's own `baseUrl` and API key are the only destination and credential used:
fail closed, never falling back to xAI, and an xAI key is never sent to another host. The bridge
stays **silently unarmed** in every one of these cases:

- the named provider is missing, disabled, or has no usable API key
- the named provider uses OAuth or forward auth — the video client sends a static bearer key, so
  those auth modes are rejected rather than downgraded
- the named provider's `baseUrl` is not an absolute http(s) URL
- `videoProvider` is present but not a provider name (`42`, `true`, `null`) or names the reserved
  registry id `xai` — a built-in registry entry is never adopted as the bridge destination, so an
  `xai` entry's `baseUrl` override can never carry the xAI key to another host

A blank `videoProvider` (`""` or whitespace) is treated as unset, keeping the pinned xAI default.
`allowPrivateNetwork: true` is required for loopback/private destinations, exactly as for any
provider `baseUrl`.

> **Delivery still requires a fetchable URL.** Submit and poll may succeed against a custom
destination, but the finished video is downloaded into the artifacts directory only when
`video.url` is a public HTTPS URL or an inline `data:` URL. A bridge whose `video.url` points at
`http://127.0.0.1/...` (or any non-public address) will generate the video and then fail at the
download step — return a hosted URL or a `data:` payload from the poll response instead.

## How It Works

1. opencodex detects a non-OpenAI routed model with `videoBridgeEnabled: true`
2. A synthetic `video_gen` function tool is injected into the conversation
3. When the model calls `video_gen`, opencodex submits a job to `/videos/generations` — on xAI by default, or on the provider named by `images.videoProvider`
4. The bridge polls the job status every 5-15 seconds, sending heartbeat messages to keep the stream alive
5. When the video is ready, it's downloaded to the artifacts directory
6. The local file path is returned to the model as a tool result

## Supported Parameters

The `video_gen` tool accepts:

| Parameter | Type | Range | Description |
|-----------|------|-------|-------------|
| `prompt` | string | required | Detailed video generation prompt |
| `duration` | integer | 1-15 | Video length in seconds |
| `resolution` | string | `"480p"`, `"720p"` | Video resolution |
| `aspect_ratio` | string | 7 ratios | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

## Limitations

- **xAI only**: Video generation targets xAI's Grok Imagine Video API by default; set `images.videoProvider` to a configured provider to use a custom destination (#8175)
- **Asynchronous**: Video generation takes 30-120 seconds
- **Cost**: video generation is a paid xAI feature. Check the [official pricing](https://docs.x.ai/developers/pricing) before using it.
- **One video per call**: Each `video_gen` call produces one video
- **Coexists with Image Bridge**: Both bridges can be enabled simultaneously
- **Web search priority**: When a web search sidecar is active for a turn (non-`runTurn` adapter), the video bridge is skipped — the two cannot run concurrently. A `console.warn` is emitted so you can detect this in logs.
- **Timeout covers submit + poll**: The `videoTimeoutMs` budget starts before job submission, so the submit call (60 s) and subsequent polling share the same deadline.
