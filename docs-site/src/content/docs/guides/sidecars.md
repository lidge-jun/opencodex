---
title: "Sidecars: Web Search & Vision"
description: Give routed models real web search and text-only models image understanding through native ChatGPT sidecars.
---

Routed models do not all expose hosted **web search** or native **image input**. opencodex backfills
those capabilities with two sidecars. Each can run through a ChatGPT-login (`forward`) provider or a
stored Anthropic OAuth provider. Sidecar errors become bounded tool results or image markers instead
of failing the whole turn.

:::note[Automatic backend selection]
Explicit `backend` config wins. When unset, opencodex uses `anthropic` if an enabled Anthropic OAuth
provider has an active account not marked `needsReauth`; otherwise it uses `openai`. Explicit
`anthropic` without that credential fails closed. `openai` requires both ChatGPT login auth and an
enabled `forward` provider.
:::

## Web-search sidecar

When Codex requests hosted `web_search` for a non-passthrough routed model, opencodex:

1. **Drops** the hosted `web_search` tool and exposes a synthetic `web_search(query)` function tool
   to the routed model instead. The original hosted-tool options are retained for the sidecar call.
2. Runs the routed model in a small **agentic loop**. When it calls `web_search`, opencodex uses the
   selected sidecar backend: OpenAI runs hosted `web_search` with `gpt-5.6-luna` by default;
   Anthropic runs `web_search_20250305` with `claude-sonnet-5` by default. The streamed answer and
   citations become a tool result.
3. **Loops** until the model answers or the total real-query budget reaches `maxSearchesPerTurn`
   (default 3), then removes the search tool and forces a final answer. Real client tools such as
   `apply_patch` or shell finalize the turn so those calls reach Codex.

Every routed-model iteration requests upstream `stream: true`, but opencodex fully buffers semantic
events internally before deciding whether to search or return the final answer. Only the first
iteration's final headers/status and 429 key rotations are acquired eagerly. Thus synthetic search
calls and preliminary output are never exposed as client-visible model output.

The injected result is wrapped in an untrusted-data boundary, length-capped, and de-duplicated by
source URL. In structured-output turns (`json_schema` / `json_object`) it is handed over as compact
JSON instead of prose. For text-only routed models, the search model is also told to describe
relevant images in words and include their source URLs.

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  }
}
```

`minimal` reasoning is not used because the hosted backend rejects tools at that effort. A failed
search is returned to the routed model as a bounded error result, allowing it to answer from the
context it already has.

Four separate clocks apply. `stallTimeoutSec` is the base bridge event-stall budget.
`connectTimeoutMs` (default `200000`) covers only DNS/TCP/TLS and final response headers.
Config-file-only `webSearchSidecar.routedModelStallTimeoutMs` (default `200000`, integer
`1..2147483647`) bounds continuous raw response-byte inactivity for each routed-model iteration and
resets on every non-empty byte. `webSearchSidecar.timeoutMs` separately bounds one hosted search
request. The effective bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 seconds`. The routed
stall is not a total generation timeout. Failures before SSE starts return non-2xx JSON; generation
failures after response headers have started are delivered as `response.failed` SSE.

## Vision sidecar

When the routed model is listed in its provider's `noVisionModels` and a request carries an image,
opencodex describes each image **before** the main call and replaces it with text. The Dashboard and
management API present `gpt-5.6-luna` as the current default, and startup migrates an explicitly
persisted legacy `gpt-5.4-mini` value to Luna. If the `visionSidecar.model` field is entirely absent,
the vision execution path still has a `gpt-5.4-mini` code fallback.

- Images can come from user, developer, and tool-result messages, including Codex's `view_image`.
- Each image is sent to the configured native vision model with `reasoning.effort: "low"`; its
  description replaces the image part inline.
- Descriptions run with bounded concurrency (3 at a time, input order preserved). User context sent
  to the describer is capped at 800 characters, and each injected description is capped at 2,000
  characters. The request does not send `max_output_tokens`, which the ChatGPT backend rejects.
- Image URLs are validated before forwarding: data URLs must use `png` / `jpeg` / `jpg` / `webp` /
  `gif`, and base64 data is limited to about 20 MB. Only `data:` and `https:` schemes are accepted;
  remote `https` images are fetched by the OpenAI backend, not by the proxy.
- `noVisionModels` matching ignores an Ollama-style `:size` suffix, so a `gpt-oss` entry also covers
  `gpt-oss:120b`.
- If description fails, the model receives a short processing-error marker. If no sidecar plan is
  available, the raw image is stripped rather than forwarded to a text-only backend.
- `maxDescriptionsPerTurn` (default 8) limits new descriptions per main-model turn. Cache hits and
  same-turn duplicates do not consume it. Successful `data:` image descriptions are cached by
  backend, model, detail, image bytes, and message context; mutable `https:` images are not cached.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

A model is marked text-only per provider:

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## Dashboard controls and disabling

<!-- TODO(WP5 GUI): Add the sidecar settings-screen walkthrough after the GUI controls ship. -->

The config-file keys are available now. Set `enabled: false` on either sidecar in `config.json` to
disable it. Anthropic-OAuth search and image description reuse the existing Claude Code OAuth
fingerprint precedent, but should be soak-tested with the intended account and workload.

See the [Configuration reference](/reference/configuration/#sidecars) for every field.
