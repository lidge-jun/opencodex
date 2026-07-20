---
title: Providers
description: Every way opencodex authenticates and talks to an LLM provider — OAuth, API key, ChatGPT forward, and local.
---

A **provider** is one upstream LLM endpoint plus how to reach it: an adapter, a base URL, an auth
mode, and an optional model list. Providers live under `providers` in `~/.opencodex/config.json`.

## OpenAI account modes

| Provider id | Use | Credential/account rule |
| --- | --- | --- |
| `openai` | Codex login | Pool(default) selects main plus added accounts; Direct uses the current caller/main login only. |
| `openai-apikey` | OpenAI API | Configured API key/key pool only; never reads Codex accounts. |

Use bare `gpt-5.6-sol` with the Pool/Direct option on the Providers page, or
`openai-apikey/gpt-5.6-sol` for API. The credential routes never fall through into one another.
The API route publishes 1,050,000 context / 922,000 max input metadata. Its
`sol-pro`, `terra-pro`, and `luna-pro` virtual ids keep their selected public identity while the wire
uses the base model plus `reasoning.mode: "pro"`.

Shipped v1 configs migrate automatically to marker 2 and one option-aware row. The original config
is retained once at `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restore it with
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

## Auth modes

Provider configs accept three `authMode` values (`key` is the default). The built-in registry also
labels local presets separately; those normally omit both `authMode` and `apiKey`.

| `authMode` | How it authenticates | Used by |
| --- | --- | --- |
| `key` | Sends your API key (`Authorization: Bearer …`, or `x-api-key` / `api-key` per adapter). The key may be a literal or an `${ENV_VAR}` reference. | Most providers. |
| `forward` | Relays **your incoming Codex auth headers** verbatim to the provider — no key stored. This is the ChatGPT-login passthrough. | OpenAI (`openai-responses` adapter). |
| `oauth` | Resolves a stored OAuth access token (auto-refreshed before expiry) and uses it as the bearer key. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, GitHub Copilot. |

## 1. ChatGPT login (forward / passthrough)

The `openai` provider needs **no API key**. Direct forwards credentials from your existing
`codex login`; Pool resolves a main or added Codex account before using the same backend:

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

The ChatGPT passthrough catalog also layers in the bare GPT-5.6 Sol/Terra/Luna slugs
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) for accounts that can use them.

## 2. Account login (OAuth)

Six provider presets use OAuth login — plus GitHub Copilot via an experimental unofficial
device-flow bridge. opencodex stores their credentials in
`~/.opencodex/auth.json` and refreshes them automatically. `chatgpt` is also accepted by the login
CLI; it acquires a ChatGPT credential while creating a `forward`-mode provider entry.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # import kiro-cli credentials (or token fallback)
ocx login google-antigravity
ocx login cursor       # standalone Cursor PKCE login
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot Pro/Business)
ocx login chatgpt      # standalone ChatGPT OAuth login
ocx logout <provider>
```

| Provider | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Live-first Grok catalog; `grok-4.5` is the fallback default. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude models; live model list fetched from `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 coding models. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Import-first login reuses the installed `kiro-cli` session. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth over the Cloud Code Assist wire. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Experimental PKCE login, live HTTP/2 transport, and account-filtered model discovery. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Experimental. GitHub device flow + `copilot_internal` exchange (VS Code OAuth client). Requires an active Copilot subscription; not an official third-party API. |

You can also start OAuth from the [web dashboard](/opencodex/guides/web-dashboard/).

### Multiple OAuth accounts

OAuth providers whose credentials include a stable account id or email can keep more than one
login. The Providers page shows those accounts in a dropdown, lets you add another, and switches the
active account without logging the others out. Identity-less Kimi and Kiro credentials replace their
active slot, while `chatgpt` is always single-slot because Codex pool accounts have a separate ledger.
Tokens stay in `~/.opencodex/auth.json`; `/api/oauth/accounts` returns masked metadata only.

## 3. API-key catalog

opencodex ships 53 built-in presets: 42 key-based, seven OAuth, three local, and the default
ChatGPT-forward preset. The dashboard's **Add provider** picker opens a key provider's dashboard,
validates the key, and stores it. Notable entries:

| Provider | Base URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
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
| Qwen Cloud | Token plan (default): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Pay as you go: `https://dashscope.aliyuncs.com/compatible-mode/v1` · or Custom |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …and more | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

Most use the `openai-chat` adapter with a bearer key; a few that expose only an Anthropic-compatible
endpoint (e.g. **Xiaomi MiMo**) use the `anthropic` adapter (`x-api-key`).

### Multiple API keys

Key-based providers can also keep multiple keys. Adding a key through the Providers page stores it
under `provider.apiKeyPool`, makes it active, and mirrors it to `provider.apiKey` so routing and
adapters continue to read the same field as before. The same dropdown can switch or remove keys; the
management API is `/api/providers/keys` and returns masked keys only.

### Switching accounts from the terminal

Use `ocx account list`, `ocx account current`, and `ocx account use` to inspect or switch the same
Codex, OAuth, and API-key pools without opening the dashboard. See the
[CLI reference](/opencodex/reference/cli/#ocx-account-subcommand) for commands, JSON output, and
new-session behavior.

### GPT-5.6 preview paths

GPT-5.6 Sol/Terra/Luna are seeded in provider fallback lists so `ocx sync` can keep the models
visible even while live catalogs lag:

| Codex route | Seeded model ids | Codex-visible context |
| --- | --- | --- |
| Codex login (Pool or Direct) | `gpt-5.6-*` | 372,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` plus `*-pro` | 1,050,000 (922,000 max input) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 1,050,000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1,000,000 |

The native GPT-5.6 entries preserve the pinned upstream reasoning ladders (for example, Luna has
`max` but no `ultra`). Routed entries use their provider metadata and reasoning mappings. All four
paths remain upstream-gated; Cursor's live discovery additionally filters its static seed to models
the logged-in account can use.

:::note[Gateways & subscription proxies]
A provider is included when opencodex has a matching wire adapter, **not** based on whether it is an
"agent" product. The current adapter ids are `openai-chat`, `openai-responses`, `anthropic`, `google`
(AI Studio, Vertex, and Antigravity/Cloud Code Assist modes), `azure` / `azure-openai`, `kiro`, and
`cursor`. A proprietary API without one of these implementations, such as native Amazon Bedrock,
is not supported directly.
**GitHub Copilot** is an OAuth provider (`ocx login github-copilot`) that exchanges a GitHub
device-flow login for a short-lived Copilot API token — not a pasted API key. **GitLab Duo** remains
a key/subscription-token gateway on its OpenAI-compatible endpoint. **Cloudflare AI
Gateway** needs your account + gateway ids filled into the URL.

Cursor is tracked separately as an experimental adapter. `adapter: "cursor"` appears in `ocx init`
and the dashboard Add Provider picker as an experimental local config entry with Cursor's static
fallback model catalog metadata. When a Cursor access token is configured, opencodex uses Cursor's
live HTTP/2 transport. Its v2.7.1 fallback seed includes `gpt-5.6-sol` / `terra` / `luna` (1M context)
plus `grok-4.5` / `grok-4.5-fast` (500K); live discovery decides which remain visible for the
account. Cursor server-driven native read/write/delete/ls/grep/shell/fetch execution
is disabled by default because it bypasses Codex's approval and sandbox path; set
`unsafeAllowNativeLocalExec: true` on the `providers.cursor` object in `~/.opencodex/config.json`
only for trusted local experiments (or via **Providers → Cursor → Edit JSON** in the dashboard).
See the [Configuration reference](/opencodex/reference/configuration/#cursor-provider-adapter-cursor)
for a full example. MCP, screen recording, and computer-use are available as executor hooks; without a
configured local executor, opencodex returns typed no-executor results instead of policy-blocking
the request. Cursor OAuth and live model discovery are enabled for this experimental adapter;
Cursor is still not shown in key-login lists.
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
