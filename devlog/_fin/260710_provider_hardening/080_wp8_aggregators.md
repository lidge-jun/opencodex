# 080 — WP8: aggregators (20 providers)

Pre-analysis: Hegel (sol explorer xhigh, 2026-07-10). Re-verify at WP8's P.

## P scope draft (260710 — re-verify at WP8 cycle open)

IN candidates:
- A1 (AMENDED A-round1) openrouter: separate OPENROUTER_GPT56_CONTEXT_WINDOW =
  1_050_000 feeding ONLY the OPENROUTER_GPT56_CONTEXT_WINDOWS map (:97-100);
  openai-apikey keeps frozen 372_000 (ctx UNVERIFIED per 001 — shared constant
  must not leak the OpenRouter-proven value).
- A2 cerebras: defaultModel llama-3.3-70b -> gpt-oss-120b (deprecated 2026-02-16).
- A3 neuralwatt: drop stale K2.5 seed rows, add glm-5.2-short(-fast) per live
  catalog (Tier-2 opened).
- A4 responses.ts:785 — network failure after key rotation swallowed (previous
  429 reported) => surface the real error.
- A5 (FINAL, A-round2) catalog.ts:1108 — ghost re-add narrowed. Discovery
  SUCCESS requires: liveModels !== false AND 2xx AND a SCHEMA-VALID model array
  (parseable data[] of model ids). Malformed 2xx (missing/wrong-shape data,
  Google-style models arrays) degrades to stale/static exactly as today and
  never becomes an authoritative cached empty catalog. A schema-VALID empty
  array IS authoritative (provider says no models => warn loudly, drop ghosts).
  Configured ids missing from a successful live list are NOT re-added (loud
  warning names them). Static-seed, stale-cache, cursor "auto" preserved.
  Tests add malformed-2xx degradation coverage + valid-empty authoritative case.
- A8 (NEW A-round1) activation tests: cerebras default assertion, neuralwatt
  seed refresh assertion, rotated-retry network-failure surfacing
  (fault-injected), ghost-removal invariant (live success drops ghosts) +
  degradation invariant (live failure keeps stale/static path).
- A6 (CORRECTED at P, main-session code read) responses.ts:460-463 — the image
  strip is a DOCUMENTED fail-closed design ("never forward raw images to a
  text-only upstream" when no sidecar plan). Turning it into a hard error would
  break every text-only-model request carrying stray images when the sidecar is
  off. NOOP-with-rationale; reviewer may propose a narrow loud signal (debug
  warn) if warranted.
- A7 parallel: baseUrl points at dashboard not api.parallel.ai; tools silently
  ignored upstream => NEEDS_HUMAN decision recorded (removal breaks configs;
  default: keep entry + strong note comment, no data invention).
- F: together/mistral/zenmux/github-copilot/gitlab-duo/qwen rows FREEZE+notes;
  groq/fireworks/huggingface/nvidia/opencode-*/kilo/vercel/synthetic/venice/
  nanogpt/opencode-go NOOP.

OUT: full catalog degradation-chain redesign (cooldown->stale->static order
stays; only the ghost-model re-add narrowed), key-validation truthfulness
(login flow surface — WP10 candidate), 429-failover trigger breadth (bounded
and narrow already).

## Verdicts (Tier-2 sources opened by explorer; URLs in report + 003 doc)

- openrouter UPDATE: gpt-5.6-sol/terra/luna ctx 372_000 -> 1_050_000 (live
  /endpoints routes opened).
- cerebras UPDATE: defaultModel llama-3.3-70b (deprecated 2026-02-16) -> gpt-oss-120b.
- neuralwatt UPDATE: live catalog dropped K2.5 rows; added glm-5.2-short(-fast);
  static seed reintroduces stale ids (registry.ts:347).
- parallel UPDATE-or-remove: base points at dashboard, not api.parallel.ai;
  models speed|lite|base|core; no /models; tools silently ignored upstream =>
  NEEDS_HUMAN flavor (removal breaks configs).
- groq/fireworks/huggingface/nvidia/opencode-zen/kilo/vercel-ai-gateway/
  synthetic/venice/nanogpt/opencode-go NOOP (nanogpt both routes alive — keep).
- together/mistral/zenmux/github-copilot/gitlab-duo FREEZE.

## Control-flow findings

- key-failover: bounded same-provider key chain, narrow — OK. But triggers on
  EVERY 429 (incl. provider-wide limits) — assess, likely acceptable.
- responses.ts:785 — network failure after key rotation swallowed; previous 429
  reported instead => surface real error.
- catalog.ts:1083/1108 — discovery silently falls cooldown->stale->static AND
  re-adds configured ids missing live (ghost models) => loud warning + stop
  re-adding for liveModels providers (cursor WP4 overlaps).
- responses.ts:460 — missing vision-sidecar prereqs silently strip images with
  200 => explicit error.
- openai-chat.ts:248 blank-key unauthenticated send => WP6 shared fix.
- key-providers.ts:98 — public /models 200 validates ANY key => truthful
  validation; login-cli.ts:101 persists "unknown" keys — assess.

# 090 — WP9: local providers (ollama, ollama-cloud, vllm, lm-studio, litellm)

- ollama/vllm/lm-studio URLs NOOP; runtime UPDATE: router.ts:100 forces registry
  localhost baseUrl over user's custom host/port (saved by CLI but ignored) —
  the local-host dead branch. Fix: registry-owned allowBaseUrlOverride for the
  4 local entries (narrow, explicit — not a fallback).
- ollama-cloud UPDATE: live catalog ids are tagged qwen3-coder:480b,
  qwen3.5:397b, gemma4:31b; untagged seed ids absent live (registry.ts:449).
- litellm UPDATE: handled in WP6 as R2 — keyOptional seed flag (authKind stays
  key; local flip was reviewer-proven to break key-login/GUI). WP9 verifies only.
