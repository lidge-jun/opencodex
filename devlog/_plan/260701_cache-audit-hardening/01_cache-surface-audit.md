# Cache Surface Audit

## Taxonomy

opencodex has several unrelated cache surfaces. Treat them separately:

1. Provider prompt cache
   - Anthropic: explicit `cache_control: { type: "ephemeral" }` on cacheable content blocks.
   - OpenAI Responses passthrough: raw Responses body is forwarded, including `prompt_cache_key`.
   - OpenAI-compatible chat completions: do not forward `prompt_cache_key`; generic chat providers may reject unknown fields and OpenAI prompt caching is usage-reported rather than configured here.
   - Google Gemini: explicit cached-content resources are not implemented in this pass.
   - Kiro: upstream does not report authoritative token usage to this adapter; usage remains estimated.

2. Cached token usage counters
   - `OcxUsage.cachedInputTokens` is the internal field.
   - `bridge.ts` maps it to Responses `input_tokens_details.cached_tokens`.
   - `usage-log.ts` persists it as a numeric field and keeps `estimated` as a separate boolean.

3. Google Antigravity reasoning replay cache
   - `google-antigravity-replay.ts` stores thought signatures for Gemini/Flash continuity.
   - This is not a billing prompt cache and must not be counted as `cachedInputTokens`.

4. Live model list cache
   - `model-cache.ts` caches provider `/models` results in memory with a five-minute TTL.
   - This cache only affects catalog/model discovery and has no prompt-token billing meaning.

5. Codex on-disk model cache
   - `codex-refresh.ts` and related paths refresh Codex model catalog/cache files so Codex sees routed models.
   - This is also unrelated to prompt-cache billing.

## Current deliberate non-parity

- No persistent Google cached-content resource manager.
- No generic chat-completions `prompt_cache_key` forwarding.
- No fake cache usage for Kiro; Kiro log usage is estimated and remains numeric.

## Regression coverage

- `tests/responses-parser.test.ts`: Responses `prompt_cache_key` reaches `options.promptCacheKey`.
- `tests/openai-responses-passthrough.test.ts`: passthrough preserves raw `prompt_cache_key`.
- `tests/adapter-usage.test.ts`: provider cached usage parsing and Anthropic request cache breakpoints.
- `tests/bridge.test.ts`: cached usage becomes Responses `input_tokens_details.cached_tokens`.
- `tests/usage-log.test.ts`: cached token counts survive persistence, including estimated rows.
- `tests/usage-summary.test.ts`: cached token counts aggregate into `/api/usage` top-level summary totals without changing total-token math.

## Display findings

- Request log rows expose per-request cached tokens in `gui/src/pages/Logs.tsx` tooltips.
- Usage summary cards expose aggregate cached tokens in `gui/src/pages/Usage.tsx`.
- Model/provider usage tables intentionally stay total-token oriented; cached token detail is shown at summary and per-request levels.

## Antigravity runtime evidence

- Local usage logs contain Antigravity rows with upstream-reported cached tokens, proving the Google adapter is receiving and preserving `cachedContentTokenCount`.
- Recent sample: `google-antigravity-p442fff` / `gemini-3.5-flash-mid` at 2026-07-01 13:41:49 KST reported `inputTokens=159132` and `cachedInputTokens=154663`.
- Several later rows failed with 429/502 and one Claude-on-Antigravity row failed with 400; those are transport/model errors and have no usage body to display.
- Phase 30 makes cached tokens visible in the request-log table itself so Antigravity cache hits are not hidden behind a hover tooltip.

## Phase 4 outcome

- Native Anthropic (`api.anthropic.com`) now sends root-level `cache_control: { type: "ephemeral" }` in addition to existing block-level system/tool cache markers, enabling automatic conversation-history caching on the official Anthropic Messages API.
- Anthropic-compatible gateways remain conservative: Umans keeps block-level markers but does not receive the root-level automatic caching field until top-level support is proven.
- OpenAI / ChatGPT Responses passthrough preserves raw `prompt_cache_key` and `prompt_cache_retention` fields; opencodex does not synthesize or validate retention policy in this pass.
- Kimi and other generic OpenAI-compatible chat providers remain usage-only for cache behavior; `prompt_tokens_details.cached_tokens` is preserved when upstream reports it, but no unproven request fields are injected.
- Google / Antigravity remains implicit-cache usage-only; `usageMetadata.cachedContentTokenCount` continues to map to `cachedInputTokens`.
