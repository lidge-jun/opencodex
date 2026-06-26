---
title: Providers
description: Every way opencodex authenticates and talks to an LLM provider — OAuth, API key, ChatGPT forward, and local.
---

A **provider** is one upstream LLM endpoint plus how to reach it: an adapter, a base URL, an auth
mode, and an optional model list. Providers live under `providers` in `~/.opencodex/config.json`.

## Auth modes

Every provider has an `authMode` (default `key`):

| `authMode` | How it authenticates | Used by |
| --- | --- | --- |
| `key` | Sends your API key (`Authorization: Bearer …`, or `x-api-key` / `api-key` per adapter). The key may be a literal or an `${ENV_VAR}` reference. | Most providers. |
| `forward` | Relays **your incoming Codex auth headers** verbatim to the provider — no key stored. This is the ChatGPT-login passthrough. | OpenAI (`openai-responses` adapter). |
| `oauth` | Resolves a stored OAuth access token (auto-refreshed before expiry) and uses it as the bearer key. | xAI, Anthropic, Kimi. |

## 1. ChatGPT login (forward / passthrough)

The default provider needs **no API key**. It forwards the credentials from your existing
`codex login` straight to the OpenAI Responses backend:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Only a curated set of headers is forwarded (`FORWARD_HEADERS`: authorization, ChatGPT account id,
OpenAI beta/originator/session — see [Adapters](/opencodex/reference/adapters/)). This path is also
what powers the [web-search and vision sidecars](/opencodex/guides/sidecars/).

## 2. Account login (OAuth)

Three providers support real account login. opencodex stores the credential in `~/.opencodex/auth.json`
and refreshes it automatically:

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx logout <provider>
```

| Provider | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Grok models; some have no reasoning param (handled automatically). |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude models; live model list fetched from `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2 family. |

You can also start OAuth from the [web dashboard](/opencodex/guides/web-dashboard/).

## 3. API-key catalog

opencodex ships a catalog of key-based providers (mostly OpenAI-compatible, a few
Anthropic-compatible). The dashboard's **Add provider** picker opens the provider's key dashboard,
validates the key, and stores it. Notable entries:

| Provider | Base URL |
| --- | --- |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Portal | `https://portal.qwen.ai/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` |
| …and more | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

Most use the `openai-chat` adapter with a bearer key; a few that expose only an Anthropic-compatible
endpoint (e.g. **Xiaomi MiMo**) use the `anthropic` adapter (`x-api-key`).

:::note[Gateways & subscription proxies]
A provider is included whenever it speaks a standard streaming API opencodex can proxy
(`openai-completions`, `anthropic-messages`, `openai-responses`, Azure, or Gemini) — **not** based on
whether it's an "agent" product. Providers on a proprietary protocol with no opencodex adapter are
excluded: Gemini CLI / Antigravity, Vertex AI, Amazon Bedrock, and the Codex backend itself.
**GitHub Copilot** and **GitLab Duo** are multi-model gateways mapped to their universal
OpenAI-compatible endpoint; they authenticate with a Bearer **subscription token** (not a plain API
key), and Copilot may need a `User-Agent` header set via the provider's `headers`. **Cloudflare AI
Gateway** needs your account + gateway ids filled into the URL.

Cursor is tracked separately as an experimental adapter. `adapter: "cursor"` appears in `ocx init`
and the dashboard Add Provider picker as an experimental local config entry with Cursor's static
public model catalog metadata. When a Cursor access token is configured, opencodex uses Cursor's
live HTTP/2 transport and handles native read/write/delete/shell requests locally. Cursor OAuth and
live model discovery remain separate future phases; Cursor is still not shown in key-login or OAuth
login lists.
:::

### Ollama Cloud

Ollama Cloud is a hosted (not local) Ollama, OpenAI-compatible at `https://ollama.com/v1` with a key
from [ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex classifies its cloud
lineup by vision capability so the [vision sidecar](/opencodex/guides/sidecars/) only kicks in for
text-only models. Text-only models (e.g. `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`,
`minimax-m2.x`, `nemotron-3-*`) are listed in `noVisionModels`; vision-native models (e.g.
`kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`, `gemini-3-flash-preview`) are not. Matching is
tolerant of Ollama's `:size` tags, so `gpt-oss` covers `gpt-oss:120b` and `gpt-oss:20b`.

## 4. Local providers

Point opencodex at a local OpenAI-compatible server — usually with a blank key:

| Provider | Base URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Any OpenAI-compatible endpoint

If a provider speaks Chat Completions, the `openai-chat` adapter handles it — choose **Custom** in the
dashboard or `custom` in `ocx init` and enter the base URL. See the
[Configuration reference](/opencodex/reference/configuration/) for every provider field
(`headers`, `noReasoningModels`, `noVisionModels`, `models`, …).
