# 010 Research digest

Observed 2026-09-30 KST. Full report with every URL: Aside run, `/Users/jun/.aside/u/0/artifacts/gpt61sol-research.md` (kept outside the repo). Live probes re-run from this checkout are marked (live).

## GPT-6.1 Sol, official

| Fact | Value | Source |
|---|---|---|
| API id | `gpt-6.1-sol`, no dated snapshot | developers.openai.com/api/docs/models/gpt-6.1-sol |
| Released | 2026-09-29 (API, ChatGPT Work, Codex) | openai.com/index/introducing-gpt-6-1-sol/ |
| API context / max input / max output | 1,050,000 / 922,000 / 128,000 | model page |
| API efforts | low, medium (default), high, xhigh, max | model page |
| Price per 1M | $2 input, $0.10 cached, $2.50 cache write, $10 output | pricing.md |
| Long context (>272K prompt) | $4 / $0.20 / $5 / $15 | pricing.md |
| Fast | 2x standard | pricing.md |
| Modalities | text + image in, text out | model page |
| Codex row (live, openai/codex models.json, #49318) | priority 1 (catalog default), efforts low..ultra, default effort low, context 272,000 / 872,000, Fast tier "2x speed, increased usage", minimal client 0.153.0 | codex-rs/models-manager/models.json |
| gpt-6-sol | retained: visibility list, priority 3, no upgrade, not deprecated | same file; deprecations page |
| GPT-6.1 Luna / Astra | do not exist (doc pages 404, absent from pricing, models index and Codex catalog) | model pages |

Only cached input changed versus GPT-6 Sol ($0.20 -> $0.10).

## Third-party listing (drives 020)

| Provider in this repo | Status | Id |
|---|---|---|
| OpenRouter | listed | `openai/gpt-6.1-sol` (1,050,000 ctx, 128,000 out) |
| Vercel AI Gateway | listed | `openai/gpt-6.1-sol` |
| GitHub Copilot | listed, GA rollout (github.blog 2026-09-29) | `gpt-6.1-sol` |
| Kilo | listed (models.dev) | `openai/gpt-6.1-sol` |
| OpenCode Zen | listed (live /zen/v1/models) | `gpt-6.1-sol` |
| Devin | listed (devin.ai blog); id not published | preemptive `gpt-6-1-sol` following its `gpt-5-6-sol` spelling |
| TokenLab | listed (live /v1/models/gpt-6.1-sol, Chat + Responses) | `gpt-6.1-sol` (live discovery) |
| Amazon Bedrock | not in models.dev; openai/codex source references `openai.gpt-6.1-sol` | preemptive |
| Cloudflare AI Gateway | not in catalog; OpenAI passthrough | preemptive |
| Kiro, CodeBuddy | not listed / unreadable; both carry preemptive gpt-6-sol rows today | preemptive, same policy as the Sonnet 5.5 Kiro rows |
| ZenMux | page explicitly "not a registered ZenMux page" | not added (live discovery picks it up) |
| DigitalOcean, Scaleway | not listed; DO naming for 6.1 unknown | not added |

## TokenLab (mail 546, 2026-09-30; live contract re-checked)

`GET https://api.tokenlab.sh/v1/models/{id}` returns `tokenlab.accepted_request_formats` (live):

| Models | Formats |
|---|---|
| gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-6.1-sol | chat, responses |
| claude-opus-5, claude-opus-5-5, claude-sonnet-5, claude-sonnet-5-5, claude-fable-5, claude-fable-5-1 | chat, anthropic_messages |
| deepseek-v4.1-flash, deepseek-v4-pro, kimi-k3, glm-5.3 | chat, responses, anthropic_messages |
| grok-4.7 | chat, responses |
| gemini-3.8-flash | chat, gemini_generate_content |

Endpoints from docs.tokenlab.sh/llms.txt: `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (x-api-key or Bearer), `/v1/systemone`. System One takes `{model, state, questions}` with Bearer auth, current model `jev-1.13` — the same body shape `src/combos/jev.ts` already sends to TypeSafe. Vincent asks to keep the user's API-key delivery policy default (no forced `X-TokenLab-Delivery-Policy`).

