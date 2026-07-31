# 002 — CN provider research (Huygens, gpt-5.6-sol, 2026-07-10)

## DeepSeek — VERIFIED
deepseek-v4-flash, deepseek-v4-pro (both 1M ctx, 384K max out, thinking+non-thinking).
Aliases deepseek-chat / deepseek-reasoner map to v4-flash; deprecated 2026-07-24 15:59 UTC.
Endpoints: OpenAI https://api.deepseek.com; Anthropic https://api.deepseek.com/anthropic.
Opened: api-docs.deepseek.com/, /quick_start/pricing.

## Moonshot/Kimi — VERIFIED
kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k2.6, kimi-k2.5 (all 256K);
coding-plan alias kimi-for-coding. Standard base https://api.moonshot.ai/v1;
Kimi Code base https://api.kimi.ai/coding/v1 (NOTE: registry uses api.kimi.com —
verify domain before touching). DROP: kimi-k2-0905-preview, kimi-k2-0711-preview,
kimi-k2-turbo-preview, kimi-k2-thinking(-turbo), kimi-latest, kimi-thinking-preview.
Opened: platform.moonshot.ai/docs/models, /docs/guide/codex-kimi.

## Z.AI — VERIFIED
glm-5.2 (up to 1M; glm-5.2[1m] spelling on Anthropic path). Coding-plan bases:
Anthropic /api/anthropic; OpenAI /api/coding/paas/v4. No proven deprecation of
glm-5/5.1/4.7. Opened: docs.z.ai/devpack/quick-start, /devpack/latest-model.

## MiniMax — VERIFIED
MiniMax-M3 (1M), MiniMax-M2.7 / -highspeed (204,800). Older M2.5/M2.1/M2 still
API-supported => legacy, not hard-deprecated. Anthropic base https://api.minimax.io/anthropic.
Opened: platform.minimax.io/docs/api-reference/text-anthropic-api.

## Qwen/DashScope — PARTIAL
General: qwen3.7-max, qwen3.7-plus, qwen3.6-flash (1M). Coder ids listed but
"no longer preferred": qwen3-coder-plus/flash/next/480b/30b. thinking_budget verified
for Qwen3 thinking mode. portal.qwen.ai blocked => coding-plan aliases UNVERIFIED (freeze).
Opened: help.aliyun.com/zh/model-studio/models, /text-generation-model/, /deep-thinking.

## Qianfan — UNVERIFIED (freeze). Docs host opened but catalog unreadable.
## Xiaomi MiMo — UNVERIFIED (freeze). xiaomimimo.com DNS resolution FAILED (dead baseUrl signal).
