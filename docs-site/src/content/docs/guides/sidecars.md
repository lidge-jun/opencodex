---
title: "Sidecars: Web Search & Vision"
description: Give routed models real web search and text-only models image understanding through native ChatGPT sidecars.
---

Routed models do not all expose hosted **web search** or native **image input**. opencodex backfills
those capabilities with two sidecars. Both support a ChatGPT-login (`forward`) provider or stored
Anthropic OAuth provider; web search can additionally use stored Grok OAuth through the explicit
`xai` backend. Sidecar errors become bounded tool results or image markers instead of failing the
whole turn.

:::note[Automatic backend selection]
Explicit `backend` config wins. The two sidecars default differently when `backend` is unset:
**web search** always defaults to `openai` — `anthropic` runs only when explicitly configured.
**Vision** defaults to `anthropic` if an enabled Anthropic OAuth provider has an active account not
marked `needsReauth`, otherwise `openai`. Explicit `anthropic` without that credential fails
closed. Explicit `xai` requires a usable stored Grok OAuth account and does not fall back. `openai`
requires both ChatGPT login auth and an enabled `forward` provider.
:::

### Additional web-search backends (explicit-only)

Three more web-search backends exist beyond the ChatGPT and Claude paths. Each is
**explicit-only** — it never activates from credential presence — and **fails closed**:
a missing credential produces no sidecar plan and the request takes the normal routed path.

| Backend | Runs | Credential | Notes |
| --- | --- | --- | --- |
| `xai` | Grok hosted `web_search` (+ opt-in `x_search`) on `api.x.ai` Responses | Stored Grok OAuth (`ocx login xai`) | `webSearchSidecar.xSearch` enables X search with `allowedXHandles`/`excludedXHandles` (max 20, mutually exclusive) and ISO `fromDate`/`toDate`. Default model `grok-4.6`. |
| `gemini` | `google_search` grounding on the Antigravity transport | Stored Antigravity OAuth with a discovered project (`ocx login google-antigravity`) | Default model `gemini-3.7-flash`; reasoning maps to the tiered thinking level. |
| `exa` | Exa Search API (non-LLM result digest) | `webSearchSidecar.exaApiKey` | The key is write-only through the management API (never echoed, redacted from logs). No sidecar model applies. |

## Web-search sidecar

When Codex requests hosted `web_search` for a non-passthrough routed model, opencodex:

1. **Drops** the hosted `web_search` tool and exposes a synthetic `web_search(query)` function tool
   to the routed model instead. The original hosted-tool options are retained for the sidecar call.
2. Runs the routed model in a small **agentic loop**. When it calls `web_search`, opencodex uses the
   selected sidecar backend: OpenAI runs hosted `web_search` with `gpt-5.6-luna` by default;
   Anthropic runs `web_search_20250305` with `claude-sonnet-5` by default. The streamed answer and
   citations become a tool result. xAI runs Grok hosted `web_search` with `grok-4.6` by default and,
   when enabled, adds hosted `x_search` to the same request.
3. **Loops** until the model answers or the total real-query budget reaches `maxSearchesPerTurn`
   (default 3), then removes the search tool and forces a final answer. Real client tools such as
   `apply_patch` or shell finalize the turn so those calls reach Codex.

Every routed-model iteration requests upstream `stream: true`, but by default opencodex fully
buffers semantic events internally before deciding whether to search or return the final answer.
Only the first iteration's final headers/status and 429 key rotations are acquired eagerly. Thus
synthetic search calls and preliminary output are never exposed as client-visible model output.

Opt-in `webSearchSidecar.streamRoutedModelOutput` (default `false`) streams each iteration's
leading text/thinking deltas live instead — the client sees output as soon as the model produces
it, exactly like the sidecar-less path. The live window closes permanently at the first tool-call
boundary, so the decision to intercept `web_search` stays atomic and nothing is ever delivered
twice (the terminal replay skips what already streamed). Tradeoff: text the model emits *before*
deciding to search — which buffered mode silently drops — becomes visible and may partially repeat
in the post-search answer. The Dashboard overview page exposes this as the **Stream answers live**
toggle on the web-search sidecar card (`PUT /api/sidecar-settings` with
`webSearch.streamRoutedModelOutput`).

Kiro commentary is independent of this option: commentary-phase text already streams ahead of the
terminal event in buffered mode, and that bypass is unchanged — with or without
`streamRoutedModelOutput`, only search-decision events (tool calls and everything after the first
tool-call boundary) remain buffered for the atomic `web_search` decision.

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
    "timeoutMs": 200000,
    "streamRoutedModelOutput": false
  }
}
```

The explicit xAI backend uses the stored credential created by `ocx login xai`. Its optional
`xSearch` block enables X search and may restrict it to one handle list and an ISO date range:

```json
{
  "webSearchSidecar": {
    "backend": "xai",
    "model": "grok-4.6",
    "xSearch": {
      "enabled": true,
      "allowedXHandles": ["xai"],
      "fromDate": "2026-08-01",
      "toDate": "2026-08-21"
    }
  }
}
```

`allowedXHandles` and `excludedXHandles` are mutually exclusive and each accepts at most 20
strings. Dates use `YYYY-MM-DD`. Malformed management writes return `400`; persisted malformed
blocks fail closed at planning time instead of silently broadening the search.

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

When the routed model is listed in its provider's `noVisionModels` — or declared text-only for
that model via `modelInputModalities` — and a request carries an image, opencodex describes each
image **before** the main call and replaces it with text, provided a vision sidecar plan is
available. Without an available plan the raw image is stripped rather than forwarded to a
text-only backend. The model catalog advertises image input for every sidecar-covered model.
Combos advertise image input only when every member accepts images, either natively or through a
sidecar, and the combo's `imageInput` setting is not disabled, so clients such as the Codex app
allow attachments instead of blocking them before the sidecar runs. When
`visionSidecar.model` is absent or blank, the OpenAI execution path, Dashboard, and management API
use the `gpt-5.4-mini` fallback. Startup still migrates an explicitly persisted legacy
`gpt-5.4-mini` value to `gpt-5.6-luna`; that migration applies to a stored value, not to an absent
model field.

- Images can come from user, developer, and tool-result messages, including Codex's `view_image`.
- On the OpenAI path (ChatGPT-login passthrough), each image is sent to the configured vision model
  over the Responses endpoint with the selected `reasoning.effort` (`low` by default), and its
  description replaces the image part inline. The Anthropic path uses the Messages endpoint with its
  own thinking-budget mapping and ignores this OpenAI-specific setting.
- For native models with known capability metadata, unsupported reasoning is normalized to the
  highest supported rung at or below the requested level; if none exists, the lowest supported rung
  is used. Unknown or custom models remain permissive when reliable capability metadata is absent.
- Descriptions run with bounded concurrency (3 at a time, input order preserved). User context sent
  to the describer is capped at 800 characters, and each injected description is capped at 2,000
  characters. The request does not send `max_output_tokens`, which the ChatGPT backend rejects.
- Image URLs are validated before forwarding: data URLs must use `png` / `jpeg` / `jpg` / `webp` /
  `gif`, and base64 data is limited to about 20 MB. Only `data:` and `https:` schemes are accepted;
  remote `https` images are fetched by the OpenAI backend, not by the proxy.
- `noVisionModels` matching ignores an Ollama-style `:size` suffix, so a `gpt-oss` entry also covers
  `gpt-oss:120b`.
- If description fails, the model receives a short processing-error marker. (Without an available
  sidecar plan, no description is attempted — the raw image is stripped, as described above.)
- `maxDescriptionsPerTurn` (default 8) limits new descriptions per main-model turn. Cache hits and
  same-turn duplicates do not consume it. Successful `data:` image descriptions are cached by
  backend, model, detail, image bytes, and message context — plus the reasoning effort on OpenAI
  keys (Anthropic keys omit it, since that field is ignored there); mutable `https:` images are not
  cached.

The management API and Dashboard picker now list models that can actually accept image input.
When the matching backend is available, `gpt-5.6-luna` (OpenAI) and `claude-haiku-4-5` (Anthropic)
are always offered as baseline options. `PUT /api/sidecar-settings` rejects a model known to be
text-only, but still accepts an unknown id so custom or ahead-of-catalog names keep working.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium",
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
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## Dashboard controls and disabling

The Dashboard Vision sidecar card can enable or disable the sidecar, set
`maxDescriptionsPerTurn`, and set `timeoutMs`, along with the existing model,
backend, and reasoning controls. Disabling the sidecar does not delete those
settings; turning it back on keeps the previous model, backend, reasoning,
timeout, and limit.

`PUT /api/sidecar-settings` accepts the same fields. Partial updates leave
omitted keys unchanged. `timeoutMs` uses the runtime integer bounds
(1–2147483647 ms).

You can still set `enabled: false` in `config.json` if you prefer to edit the
file directly. Anthropic-OAuth search and image description reuse the existing
Claude Code OAuth fingerprint precedent, but should be soak-tested with the
intended account and workload.

See the [Configuration reference](/reference/configuration/#sidecars) for every field.
