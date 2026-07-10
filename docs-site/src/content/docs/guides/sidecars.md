---
title: "Sidecars: Web Search & Vision"
description: Give routed models real web search and text-only models image understanding through native ChatGPT sidecars.
---

Some capabilities only exist on OpenAI's hosted backend: real server-side **web search** and native
**image input**. opencodex backfills them for routed models with two sidecars that use a native model
over your ChatGPT-login (`forward`) provider. Both are on by default when an enabled forward provider
and usable ChatGPT auth are available. Sidecar errors become bounded tool results or image markers
instead of failing the whole turn.

:::note[Requires a forward provider]
Sidecars run through the `forward` (ChatGPT passthrough) path, which has hosted web search and native
vision. Without usable ChatGPT auth, web search takes the normal route and images for a declared
text-only model are replaced with an explicit omitted-image marker.
:::

## Web-search sidecar

When Codex requests hosted `web_search` for a non-passthrough routed model, opencodex:

1. **Drops** the hosted `web_search` tool and exposes a synthetic `web_search(query)` function tool
   to the routed model instead. The original hosted-tool options are retained for the sidecar call.
2. Runs the routed model in a small **agentic loop**. When it calls `web_search`, opencodex calls
   `gpt-5.6-luna` by default over the forward backend with hosted `web_search` and
   `reasoning.effort: "low"`, then parses the streamed answer and citations into a tool result.
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
    "model": "gpt-5.6-luna",
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

```json
{
  "visionSidecar": {
    "enabled": true,
    "model": "gpt-5.6-luna",
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

The Dashboard page lets you choose the search model and reasoning effort plus the vision model.
Those controls use `GET` / `PUT /api/sidecar-settings` and apply on the next request.

Set `enabled: false` on either sidecar in `config.json` to disable it. See the
[Configuration reference](/opencodex/reference/configuration/#sidecars) for every field.
