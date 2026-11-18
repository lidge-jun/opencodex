---
title: Video Bridge
description: Generate videos with Grok Imagine Video through a non-OpenAI model.
---

## Overview

The Video Bridge lets you use xAI's Grok Imagine Video generation through any non-OpenAI model
routed by opencodex. When enabled, a synthetic `video_gen` tool is injected into the conversation.
The model calls it like any function tool; opencodex intercepts the call, submits a video generation
job to xAI, polls until completion, and downloads the result.

By default jobs go to xAI; `images.videoProvider` can send them to another compatible backend instead.

## Prerequisites

These prerequisites apply to the default xAI destination. With `images.videoProvider` set, see [Choosing the video provider](#choosing-the-video-provider) instead.

- An `xai` provider entry with an **API key** (`ocx login xai` alone is not sufficient — the video bridge requires key auth, not OAuth)
- A non-OpenAI model as your routed provider (e.g. Anthropic Claude, Google Gemini)
- opencodex configured to route through the non-OpenAI provider

> **⚠ Provider key required:** The video bridge only activates when the `xai` provider uses
> API key auth. Add this to your config:
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
| `videoProvider` | unset (xAI) | Optional API-key provider that serves `video_gen` with its own `baseUrl` and key. See [Choosing the video provider](#choosing-the-video-provider). |

## Choosing the video provider

By default the bridge sends `video_gen` jobs to xAI with the `xai` provider's API key. Set
`images.videoProvider` to send them to another backend that implements the same asynchronous API
(`POST {baseUrl}/videos/generations`, then `GET {baseUrl}/videos/{id}`), such as a self-hosted media
bridge:

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

- The named provider's own `baseUrl` and API key are the only destination and credential used. Its
  adapter does not matter, but it must use API-key auth.
- `"videoProvider": "xai"` keeps the pinned `https://api.x.ai/v1` endpoint, whatever `baseUrl` the
  `xai` row carries. Other built-in provider ids are refused; name a custom provider instead.
- A loopback or private-network destination needs `allowPrivateNetwork: true` on that provider, as
  for other provider traffic. The check runs on the addresses the hostname resolves to when each
  submit or poll request connects, so a hostname that resolves to a local address is refused without
  it. Plain `http` works only for `localhost` or a loopback or private IP address with that setting;
  every other destination must use `https`. Requests follow the provider's own `proxy` and
  `noProxy` settings. When a provider or global proxy carries the request, the proxy resolves
  the hostname and connects itself, so the address check above covers only the local DNS answer and
  cannot pin the peer the proxy picks: route a provider through a proxy only if you trust that proxy's
  DNS and network path to keep private destinations unreachable. If local DNS cannot resolve the
  hostname while a proxy applies, the request still goes through that proxy with no local answer to
  check, and OpenCodex logs a warning. When a proxy applies, a plain `http` request and a hostname
  whose local DNS answer is a private address are both refused, even with `allowPrivateNetwork`; such a
  local video provider needs a direct route. Exclude its host with the provider's `noProxy` (for a
  provider `proxy`) or with `NO_PROXY` (for a global proxy).
- A key OpenCodex can recognize as xAI's (an `xai-` key, a key held by any `xai` row, or an
  environment reference named for xAI or Grok) is sent only to `https://api.x.ai` or
  `https://cli-chat-proxy.grok.com`; any other origin is refused. A key with none of those marks cannot
  be recognized, so do not paste your xAI key into another provider's row. A keychain reference to
  another provider's secret is always refused, a paused active key fails closed, and the `baseUrl`
  may not carry credentials, a query or a fragment.
- If the provider is missing, disabled, paused, keyless or refused, every `video_gen` call returns
  that error to the model. Nothing is sent, and the bridge never falls back to xAI.
- The finished video is still downloaded only from a base64 `data:` URL or a public `https:` URL, so
  a local bridge must return one of those as `video.url`.

## How It Works

1. opencodex detects a non-OpenAI routed model with `videoBridgeEnabled: true`
2. A synthetic `video_gen` function tool is injected into the conversation
3. When the model calls `video_gen`, opencodex submits a job to xAI's `/videos/generations` (or to the configured `images.videoProvider`)
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

- **xAI by default**: without `videoProvider`, video generation uses xAI's Grok Imagine Video API; another backend must implement the same asynchronous API
- **Asynchronous**: Video generation takes 30-120 seconds
- **Cost**: video generation is a paid xAI feature. Check the [official pricing](https://docs.x.ai/developers/pricing) before using it.
- **One video per call**: Each `video_gen` call produces one video
- **Coexists with Image Bridge**: Both bridges can be enabled simultaneously
- **Web search priority**: When a web search sidecar is active for a turn (non-`runTurn` adapter), the video bridge is skipped — the two cannot run concurrently. A `console.warn` is emitted so you can detect this in logs.
- **Timeout covers submit + poll**: The `videoTimeoutMs` budget starts before job submission, so the submit call (60 s) and subsequent polling share the same deadline.
