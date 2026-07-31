# 003 — Aggregator/infra research (Hilbert, gpt-5.6-sol, 2026-07-10)

"Alive" = HTTP route responded; not authenticated-inference proof.

- OpenRouter — VERIFIED: public GET https://openrouter.ai/api/v1/models authoritative;
  ids vendor/model. Live coding entries observed: openai/gpt-5.6-sol/-terra/-luna,
  x-ai/grok-build-0.1, google/gemini-3.5-flash, qwen/qwen3.7-max. Pin stable id, not
  canonical_slug.
- Groq — VERIFIED (console.groq.com/docs/models): production llama-3.1-8b-instant,
  llama-3.3-70b-versatile, openai/gpt-oss-120b/-20b; groq/compound(-mini); whisper-v3.
  llama-3.3-70b-versatile STILL production on Groq.
- Cerebras — VERIFIED (inference-docs.cerebras.ai + live /v1/models): production
  gpt-oss-120b; preview gemma-4-31b, zai-glm-4.7. llama-3.3-70b DEPRECATED 2026-02-16
  => registry defaultModel "llama-3.3-70b" is STALE; replace with gpt-oss-120b.
- Together — route alive (401 unauth). Coding guide uses Qwen/Qwen3.5-9B; Qwen2.5
  defaults stale. Exact serverless ids unverified without key.
- Fireworks — VERIFIED docs: recommended coding accounts/fireworks/models/deepseek-v4-pro,
  kimi-k2p6, glm-5p1, minimax-m2p7; fast: deepseek-v4-flash, step-3p7-flash-nvfp4.
- Mistral — /v1/models alive (401). codestral-latest UNCONFIRMED; keep as compat alias only.
- NVIDIA NIM — VERIFIED: public GET https://integrate.api.nvidia.com/v1/models;
  ids lowercase publisher/model (deepseek-ai/deepseek-v4-pro, minimaxai/minimax-m3, ...).
- Venice — alive, public /api/v1/models; Venice slugs (zai-org-glm-5-2, kimi-k2-7-code...).
- NanoGPT — alive, public https://api.nano-gpt.com/v1/models (registry says nano-gpt.com/api/v1
  — verify); mixed ids + :low/:medium/:high suffixes, nanogpt/coding-router.
- Synthetic — alive, public /v1/models; aliases syn:large:text etc., direct hf:<org/model>.
- ZenMux — docs alive; /v1/models unreadable => ids UNVERIFIED (freeze).
- Kilo — alive, public https://api.kilo.ai/api/gateway/v1/models; kilo-auto/frontier etc.
- Vercel AI Gateway — alive, public https://ai-gateway.vercel.sh/v1/models; provider/model ids.
- GitHub Copilot — /models alive but auth-required (400 no Authorization); ids unverifiable
  without token => freeze.
- GitLab Duo — gitlab.com/api/v4/ai 404; no public OpenAI-compatible endpoint documented
  => flag entry as dubious; freeze (possible NEEDS_HUMAN on removal).

Recommendation: /models discovery first-class where public; hardcode only bootstrap aliases.
