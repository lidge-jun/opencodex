# 260710 Provider Proxy Hardening — Unit Plan (MOC)

Goal: harden all 50 provider registry entries + owning adapter paths, one PABCD
work-phase per adapter family, sequential. Session 019f4840-5714-7b33-b0c5-8c6c82b3cfb1,
goalplan slug `harden-all-50-provider-proxy-paths-in-opencodex`.

## Hardening definition (user constraints)

- Model data (models/defaultModel/modelContextWindows/reasoningEfforts) updated ONLY
  from Tier-2-proven research (001-003 docs). Unverified => FREEZE, never guess.
- NO new fallback layers ("너무 많은 폴백 금지"): hardening = fail loudly + narrowly,
  remove/refuse silent degradation, tighten existing retry/failover guards.
  Existing narrow guards (upstream-retry ECONNRESET, key-failover 429 cooldown) stay.
- Every changed conditional path needs an activation scenario (C-ACTIVATION-GROUNDING-01).

## Work-phase map (dependency order: shared surfaces first via WP1 family, then families)

| WP | Doc | Scope |
|----|-----|-------|
| 1 | 010 | openai-responses family: openai, openai-apikey, azure-openai |
| 2 | 020 | anthropic family: anthropic, anthropic-apikey, umans, xiaomi, cloudflare-ai-gateway |
| 3 | 030 | google family: google, google-vertex, google-antigravity |
| 4 | 040 | cursor |
| 5 | 050 | kiro |
| 6 | 060 | xai, kimi, kimi-code, moonshot, firepass |
| 7 | 070 | CN: deepseek, zai, minimax, minimax-cn, qwen-portal, qianfan, alibaba |
| 8 | 080 | aggregators: openrouter, groq, cerebras, together, fireworks, huggingface, nvidia, opencode-go, opencode-zen, zenmux, kilo, vercel-ai-gateway, github-copilot, gitlab-duo, nanogpt, synthetic, venice, neuralwatt, parallel, mistral |
| 9 | 090 | local: ollama, ollama-cloud, vllm, lm-studio, litellm |

Each WP = full P->A->B->C->D with sol reviewer audit. Verify: `bun x tsc --noEmit`,
`bun test ./tests/`. Decade docs 020-090 are written diff-level at each cycle's P from
the standing explorer pre-analysis (research amendment path stated here up front;
001-003 research is already archived).

## Research docs

- 001_research_frontier.md — OpenAI/Anthropic/Google/xAI (Aquinas, sol)
- 002_research_cn.md — DeepSeek/Kimi/ZAI/MiniMax/Qwen/Qianfan/Xiaomi (Huygens, sol)
- 003_research_aggregators.md — OpenRouter/Groq/Cerebras/... (Hilbert, sol)

## Standing verdicts from research

- FREEZE model data: openai, openai-apikey (catalog unreadable), xai details
  (ids partially verified, ctx unverified), qianfan, xiaomi (DNS dead), qwen-portal
  coding-plan aliases, zenmux ids, github-copilot ids, gitlab-duo (endpoint 404).
- UPDATE candidates: anthropic (drop retired snapshots; fable-5/opus-4-8 present?),
  google (gemini-3.5-flash stable 1M; gemini-3-pro-preview retired), deepseek
  (v4-flash/pro 1M; chat/reasoner aliases deprecated 2026-07-24), kimi (drop k2
  previews), zai (glm-5.2), minimax (M3 1M, M2.7), cerebras (llama-3.3-70b
  deprecated 2026-02-16 -> gpt-oss-120b), mistral (codestral-latest unconfirmed),
  together (qwen2.5 default stale).
