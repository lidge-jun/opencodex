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
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Master switch. Must be explicitly enabled. |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | xAI video model id. |
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
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
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
- On the xAI wire the finished video is downloaded only from a base64 `data:` URL or a public
  `https:` URL, so a local bridge must return one of those as `video.url`. A backend that serves the
  rendered file from its own host instead uses the OpenAI wire below.

### OpenAI Videos API backends

Set `"videoApi": "openai"` on the provider when its backend implements the OpenAI Videos API shape
(`POST {baseUrl}/videos`, then `GET {baseUrl}/videos/{id}` until `completed`, then the MP4 from
`GET {baseUrl}/videos/{id}/content`), as LiteLLM and several self-hosted Gemini or AI Studio shims do.
OpenAI shut its own Videos API down on September 24, 2026, so this names third-party backends, not
`api.openai.com`.

```json
{
  "providers": {
    "aistudio": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:2048/v1",
      "apiKey": "${AISTUDIO_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true,
      "videoApi": "openai"
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "aistudio",
    "videoBridgeModel": "gemini-omni-1.1-flash"
  }
}
```

- `duration` is sent as `seconds`, `resolution` and `aspect_ratio` as `size` (720p at 16:9 is
  `1280x720`), and a first-frame `image` as `input_reference.image_url`. `last_frame`, `keyframes` and
  `reference_images` have no OpenAI field and are refused before any request.
- Submit, poll and the content download all go to the same provider with the same key, under the
  same address, `allowPrivateNetwork`, cleartext, proxy and redirect rules listed above. A redirect
  from `/content` is refused, not followed, and the download keeps the 200 MiB video cap.
- Name the backend's model in `videoBridgeModel`. Models OpenCodex does not know keep the generic
  limits: 480p or 720p, seven aspect ratios and no image inputs.

## Public `/v1/videos` endpoint

Clients that speak the OpenAI Videos API can point at OpenCodex. Three routes are served:

| Route | Purpose |
|-------|---------|
| `POST /v1/videos` | Create a job. JSON, or multipart with an `input_reference` PNG/JPEG/WebP file (sent upstream as a data URL). |
| `GET /v1/videos/{id}` | Job status. |
| `GET /v1/videos/{id}/content` | The rendered file; `variant` may be `video`, `thumbnail` or `spritesheet`. |

`model` picks the backend: `"aistudio/gemini-omni-1.1-flash"` sends `gemini-omni-1.1-flash` to the
`aistudio` provider, and a model without a provider prefix goes to `images.videoProvider`. Only a
provider with `"videoApi": "openai"` serves these routes; any other, and every refusal listed above,
returns an error and sends nothing. The `id` in each answer is an OpenCodex handle: status and content
calls return to the provider that created the job, and a handle works only with the same OpenCodex
API key (or the same loopback or environment admission) that created it. Other keys get `404`. The
handles are signed with a key stored as `video-handle-key` in the OpenCodex home, so they survive a
restart.

The routes take the same authentication and origin checks as `/v1/images/generations`, a scoped key
is held to its providers and models on all three, and each call is recorded in `usage.jsonl`. List,
delete, remix, edit and extension routes are not served.

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
| `prompt` | string | optional with an image or frame | Text prompt |
| `duration` | integer | 1-15 | Video length in seconds |
| `resolution` | string | `480p`, `720p`, `1080p` | Model-dependent; 720p at most with `last_frame`, `keyframes` or `reference_images` |
| `aspect_ratio` | string | model-dependent | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; refused when only animating an `image`, which keeps its own ratio |
| `image` | string | first frame | HTTPS URL, data URL or remembered artifact |
| `last_frame` | string | 1.5 only | Last frame |
| `keyframes` | array | 1.5, max 4 | `{image, timestamp_s}`; timestamp strictly inside the clip (8 s when `duration` is omitted) |
| `reference_images` | array | 1.5: 14, classic: 7 (≤ 10 s) | Image references; the classic model cannot combine them with `image` |

Settings a model cannot honour are refused before any paid call instead of being dropped.

### Models and image inputs

| Model | Resolution | Inputs | Price per second (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / native 1080p | first/last frame, 4 keyframes, 14 references (720p maximum) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (default) | 480p / 720p / upscaled 1080p | first frame | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | first frame, 7 references | $0.05 / $0.07 / — |

Set `images.videoBridgeModel` to `grok-imagine-video-1.5` for frame pins or references.
Known models support nine aspect ratios. Unknown models retain seven ratios, 480p/720p,
and no image inputs. Inputs accept HTTPS URLs or PNG/JPEG/WebP data URLs up to 10 MiB
decoded. Images downloaded by the image bridge may also be referenced by artifact URL,
absolute path or `file:` URL for up to one hour; the bridge uses their remembered source
URL and never reads the local file. These artifact references work only with pinned xAI,
not a custom `images.videoProvider`. Inline image results have no source URL and cannot
be referenced. An upstream temporary URL may expire earlier.


## Limitations

- **xAI by default**: without `videoProvider`, video generation uses xAI's Grok Imagine Video API; another backend must implement the same asynchronous API, or the OpenAI Videos API with `videoApi: "openai"`
- **Asynchronous**: Video generation takes 30-120 seconds
- **Cost**: video generation is a paid xAI feature. Check the [official pricing](https://docs.x.ai/developers/pricing) before using it.
- **One video per call**: Each `video_gen` call produces one video
- **Coexists with Image Bridge**: Both bridges can be enabled simultaneously
- **Web search priority**: When a web search sidecar is active for a turn (non-`runTurn` adapter), the video bridge is skipped — the two cannot run concurrently. A `console.warn` is emitted so you can detect this in logs.
- **Timeout covers submit + poll**: The `videoTimeoutMs` budget starts before job submission, so the submit call (60 s) and subsequent polling share the same deadline.
