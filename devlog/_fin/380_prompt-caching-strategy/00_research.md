# 380 Prompt Caching Strategy Research

## Search Report

### focused_queries

- `OpenAI prompt caching API documentation cached tokens 2025 responses API`
- `Anthropic prompt caching cache_control TTL 1 hour official docs`
- `OpenRouter prompt caching provider routing cache discounts documentation`
- `LiteLLM cache prompt caching Redis semantic cache documentation`
- `Vercel AI Gateway automatic caching prompt caching provider behavior`
- `Google Gemini implicit caching prompt caching documentation minimum token TTL`
- `codex-rs prompt_cache_key thread_id ResponsesApiRequest`

### search_route_used

- Tier 1 web search for candidate discovery.
- Tier 2 `cli-jaw browser fetch` adaptive reader for original pages and official/provider docs.
- Parallel source gathering was used across official/provider docs because this is comparison-heavy and provider behavior differs.

### candidate_urls

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://openrouter.ai/docs/guides/best-practices/prompt-caching
- https://docs.litellm.ai/docs/completion/prompt_caching
- https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching
- https://ai.google.dev/gemini-api/docs/caching

### original_pages_opened_or_fetched

- OpenAI Prompt Caching official docs: fetched successfully.
- OpenRouter Prompt Caching docs: fetched successfully as markdown.
- LiteLLM Prompt Caching docs: fetched successfully.
- Vercel AI Gateway Automatic Caching docs: fetched successfully.
- Google Gemini context caching docs: fetched successfully.
- Anthropic official docs direct fetch failed because local CDP was unavailable on port 9250 during that fetch attempt; Anthropic behavior was cross-checked through OpenRouter/LiteLLM docs that link and summarize Anthropic cache semantics. This point remains less direct than the others.

### browse_escalation_decision

Browser/adaptive fetch was required because snippets alone are not evidence. Official/provider pages were fetched directly. Two fetch attempts failed due local CDP connection refusal, not source unavailability; equivalent provider docs from OpenRouter/LiteLLM/Vercel covered those claims.

### parallel_research_decision

Parallel research was appropriate because the task compares multiple gateway/proxy products and native provider cache semantics. Lanes used: official provider docs, gateway/proxy docs, and local repo inspection.

### evidence_status

Partial-to-sufficient by claim:

- OpenAI automatic prompt caching, `prompt_cache_key`, `prompt_cache_retention`, 1024-token minimum, cached token usage: sufficient from OpenAI official docs.
- OpenRouter sticky routing/session_id and cache usage fields: sufficient from OpenRouter docs.
- LiteLLM prompt caching support, cache_control examples, usage normalization, model support probing: sufficient from LiteLLM docs.
- Vercel AI Gateway `caching: "auto"` provider behavior: sufficient from Vercel docs.
- Gemini implicit caching: sufficient from Google docs.
- Anthropic exact native docs: partial because official fetch failed; corroborated via OpenRouter/LiteLLM/Vercel docs.
- codex-rs current state: sufficient from local source/tests.
- opencodex current state: sufficient from local source/tests.

### remaining_uncertainty

- Exact current Anthropic native cache minimums/TTL should be re-fetched from Anthropic official docs before implementing provider-specific write-cost policy.
- Cursor/ChatGPT backend may accept or ignore `prompt_cache_key`/`prompt_cache_retention` in OAuth passthrough; live probing is needed because public OpenAI API docs do not prove ChatGPT backend behavior.
- Cache hit rate cannot be proven from code inspection; it needs runtime telemetry from `usage.input_tokens_details.cached_tokens` over real workloads.

## Executive Summary

opencodex is already reasonably optimized in one important sense: it preserves provider cache-usage metadata through adapters and bridges, and it does not break OpenAI/ChatGPT native passthrough request bodies. That means provider-side prompt caching can work automatically when the upstream supports it.

The important codex-rs correction: normal Codex traffic already sends a stable `prompt_cache_key`. codex-rs sets it to the thread id, carries it through the WebSocket request shape, and has tests proving the key remains constant across model overrides and per-turn overrides. So for Codex-originated GPT traffic, opencodex's first job is not to invent a cache key. It is to prove that the incoming `prompt_cache_key` is preserved end-to-end.

However, opencodex is not yet optimized like OpenRouter, LiteLLM, or Vercel AI Gateway in the active cache strategy layer. It lacks explicit regression tests for preserving Codex's cache key through HTTP/WS passthrough, does not expose cache retention policy, does not add provider-specific `cache_control` markers, and does not provide cache-hit observability in the CLI/dashboard. In short: Codex already gives us the main GPT cache routing hint; opencodex must protect and measure it.

The biggest GPT-side opportunity is low-risk: add preservation tests for `prompt_cache_key` and `prompt_cache_retention`, then aggregate `cached_tokens`/input token ratios by provider/model/thread so we can see whether hits happen in real use. Derived cache keys should be opt-in and mainly for non-Codex clients or routed providers that do not already provide a good key. Provider-specific auto-injection for Anthropic/Gemini should be a later opt-in because write costs and breakpoint placement can backfire.

## Source Findings

### OpenAI / ChatGPT-side prompt caching

OpenAI prompt caching is automatic for recent models and applies when prompts reach at least 1024 tokens. Cache hits require exact prefix matches, so static content should be placed first and dynamic content later. OpenAI exposes `cached_tokens` in usage details, supports `prompt_cache_key` as a routing hint, and supports `prompt_cache_retention` with in-memory or longer retention on supported models.

Relevant facts from the fetched OpenAI docs:

- Automatic caching works without code changes for supported models.
- Cache hits are prefix based.
- Static content, tools, images, and schemas should remain identical at the beginning of prompts.
- `prompt_cache_key` can improve routing/hit rate for common prefixes.
- Too much traffic on one prefix/key can overflow to more machines, reducing hit rate.
- In-memory retention is generally 5-10 minutes idle, up to one hour.
- Extended retention can reach up to 24 hours on listed supported models.
- `usage.prompt_tokens_details.cached_tokens` is the authoritative per-request signal.

Implication for opencodex: for native ChatGPT/OpenAI passthrough, the primary optimization is not server-side response caching. The output must still be generated. The optimization is request shape and routing stability: stable prefix, stable key, stable model/account/thread path.

### OpenRouter

OpenRouter is more active than opencodex today. It uses provider sticky routing to keep cache-warmed conversations on the same provider endpoint, and it supports explicit `session_id` as the sticky routing key. It also reports cache metrics through usage details such as `cached_tokens` and `cache_write_tokens`.

Important OpenRouter design points:

- Sticky routing activates after cache usage is observed, or immediately when `session_id` is supplied.
- Sticky granularity is account + model + conversation.
- Default conversation identification hashes early messages.
- `session_id` is useful for agentic workflows where early messages may shift.
- Router models pin the resolved provider/model during sticky sessions.

Comparison: opencodex already has thread/account affinity for ChatGPT pool accounts, which is conceptually similar to sticky routing for auth/quota. But it does not use that affinity to set a provider-visible prompt cache key, nor does it report cache hit rate by affinity/thread.

### LiteLLM

LiteLLM is more comprehensive at provider abstraction. It normalizes cache usage fields, forwards OpenAI `prompt_cache_key` and `prompt_cache_retention`, supports Anthropic-style `cache_control`, translates cache markers to Bedrock/Gemini where possible, and exposes model support helpers.

Relevant LiteLLM behavior:

- OpenAI caching is automatic above 1024 tokens.
- `prompt_cache_key` and `prompt_cache_retention` can be passed through with OpenAI-compatible calls.
- Anthropic requires `cache_control` on cacheable content; writes can cost extra.
- Gemini/Vertex can use Anthropic-style `cache_control` and LiteLLM translates it to provider-native cached content APIs.
- Usage is normalized into OpenAI-style `prompt_tokens_details.cached_tokens`, while Anthropic write tokens are also surfaced.
- It recommends checking usage fields because below-minimum prompts silently skip caching.

Comparison: opencodex already maps cached token usage across OpenAI-compatible, Anthropic, and Google adapters into `OcxUsage.cachedInputTokens`, then serializes that into Responses `input_tokens_details.cached_tokens`. That part is strong. What opencodex lacks is LiteLLM-style request-side cache policy and support discovery.

### Vercel AI Gateway

Vercel AI Gateway exposes `caching: "auto"`. For implicit providers like OpenAI/Google/DeepSeek it leaves requests unchanged; for explicit providers like Anthropic/MiniMax it inserts cache markers into static content. It documents default pass-through behavior when caching is unset.

Comparison: opencodex currently behaves like Vercel's default pass-through mode, not `caching: "auto"`. That is safer but leaves optimization on the table for explicit-cache providers.

### Google Gemini

Google's current Gemini docs say Gemini 2.5+ supports implicit caching by default for qualifying requests, with cache-hit token counts exposed in `usageMetadata.cachedContentTokenCount`. It recommends putting large common content at the beginning and sending similar-prefix requests close together.

Comparison: opencodex's Google adapter maps `cachedContentTokenCount` to `cachedInputTokens`, which is good. It does not actively manage Gemini cached content objects, and based on the current Interactions/implicit direction this may be acceptable for now.

## codex-rs Findings

codex-rs is already cache-aware for OpenAI Responses requests.

Evidence:

- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/codex-api/src/common.rs` declares `prompt_cache_key` on `ResponsesApiRequest`.
- The same file declares `prompt_cache_key` on `ResponseCreateWsRequest`.
- `impl From<&ResponsesApiRequest> for ResponseCreateWsRequest` copies `request.prompt_cache_key`, so WebSocket creation preserves the field.
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/client.rs` sets `let prompt_cache_key = Some(self.state.thread_id.to_string());` in `build_responses_request`.
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/core/tests/suite/client.rs` asserts the outgoing `/v1/responses` body has `prompt_cache_key == thread_id`.
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/core/tests/suite/prompt_caching.rs` asserts `prompt_cache_key` remains constant across overrides and per-turn overrides.

Implication: the normal Codex client already follows the key rule that OpenAI-style caching wants: a stable session/thread cache key with a stable prefix. opencodex should treat that field as a protocol-critical passthrough field.

This changes the recommended opencodex priority:

1. Preserve incoming Codex `prompt_cache_key` exactly on HTTP Responses passthrough.
2. Preserve it on WebSocket/native passthrough paths.
3. Add regression tests so future sanitation/parser work cannot drop it.
4. Add request-log/dashboard/CLI observability for `cached_tokens` and cache hit ratio.
5. Only derive a cache key for non-Codex clients or routed adapters after telemetry proves a gap.

## Local opencodex Findings

### What is already optimized

1. Provider model catalog caching exists.

`src/model-cache.ts` provides an in-memory per-provider TTL cache for live `/models` results, with stale fallback. This reduces provider `/models` polling and is unrelated to prompt caching, but it is a real cache layer.

2. Codex catalog/cache invalidation exists.

`src/codex-catalog.ts` and `src/codex-refresh.ts` manage Codex model catalog materialization and cache invalidation. Again, this is model metadata caching, not prompt caching.

3. Cache token telemetry is preserved.

Local code maps provider cache usage into Responses-compatible usage:

- OpenAI-compatible adapter maps `prompt_tokens_details.cached_tokens` to `cachedInputTokens`.
- Anthropic adapter maps `cache_read_input_tokens + cache_creation_input_tokens` to `cachedInputTokens` when present.
- Google adapter maps `usageMetadata.cachedContentTokenCount` to `cachedInputTokens`.
- `src/bridge.ts` serializes `cachedInputTokens` into `input_tokens_details.cached_tokens`.
- Tests cover OpenAI-compatible, Anthropic, Google, and bridge serialization.

This is a strong foundation. It means opencodex does not erase provider cache evidence.

4. Native Responses passthrough preserves raw request body.

For the ChatGPT/OpenAI Responses passthrough adapter, the raw body is stringified after only the known reasoning-content sanitation for ChatGPT compatibility. That means if the client includes cache-related fields in `_rawBody`, opencodex is likely to preserve them unless parser/schema code strips them before `_rawBody` is captured.

### What is not yet optimized

1. No first-class prompt cache strategy config.

There is no `promptCache` config block in `OcxConfig` and no user-facing CLI/status docs for cache policy.

2. No explicit preservation test for Codex's `prompt_cache_key`.

The Responses schema knows `prompt_cache_key` exists, and codex-rs already sends it as the thread id. The current opencodex native passthrough likely preserves it because `_rawBody` is forwarded after targeted sanitation, but the repo lacks a focused regression test proving this field survives all relevant passthrough paths.

3. No `prompt_cache_retention` policy.

No code path was found that sets or exposes `prompt_cache_retention`. For OpenAI models that support 24h retention, opencodex does not help users choose it.

4. No explicit cache marker injection.

No `cache_control` injection exists for Anthropic/Gemini/OpenRouter/Vercel-style explicit caching. This is acceptable as a safe default, but it means opencodex is behind gateways that can auto-inject breakpoints.

5. No cache-hit dashboard/CLI metrics.

opencodex preserves usage at the response level, but it does not appear to aggregate hit rate, cached-token ratio, write/read tokens, provider/model/session hit rate, or cost delta into request logs/dashboard/status.

## Comparison Matrix

| Capability | opencodex today | OpenAI native | OpenRouter | LiteLLM | Vercel AI Gateway |
| --- | --- | --- | --- | --- | --- |
| Implicit OpenAI caching | Preserved by passthrough/routed usage | Yes | Yes | Yes | Yes |
| Cached token usage preserved | Yes | Yes | Yes | Yes | Provider/gateway dependent |
| Stable cache routing hint | Codex sends `prompt_cache_key`; opencodex must preserve/test it | `prompt_cache_key` | `session_id` sticky routing | forwards `prompt_cache_key` | gateway-specific |
| Extended retention control | Not exposed | `prompt_cache_retention` | provider dependent | forwards `prompt_cache_retention` | provider dependent |
| Explicit Anthropic cache markers | Not injected | N/A | supported | supported/translated | `caching: "auto"` |
| Provider sticky routing | Account/thread affinity only, not cache-aware | provider internal | yes | proxy/provider dependent | gateway routing |
| Cache support discovery | No | docs/dashboard | docs/API | `supports_prompt_caching` | model filtering |
| Cache hit observability | Per-response preserved only | usage/dashboard | usage/generation API | usage/cost headers | observability/spend |

## Is opencodex already optimized?

Answer: partially.

opencodex is optimized enough not to block provider-native caching. It also preserves cache usage metadata better than a naive proxy would. That matters because cache hit evidence survives all the way back to Responses JSON/SSE.

But it is not optimized at the gateway-strategy level. Compared with OpenRouter/LiteLLM/Vercel, opencodex lacks explicit cache-key preservation tests, cache policy controls, provider-specific cache marker injection, and cache metrics. Therefore, there is meaningful room to improve, especially for proving Codex-originated GPT/OpenAI passthrough behavior and for any routed OpenAI-compatible provider that honors `prompt_cache_key`.

## Recommended Strategy

### Phase 1: Measure before changing behavior

Add request-log/cache telemetry:

- `cachedInputTokens`
- `inputTokens`
- `cacheHitRatio = cachedInputTokens / inputTokens`
- `model`
- `provider`
- `thread-id` or hashed session label
- stream vs non-stream
- passthrough vs routed

Expose summary in dashboard/status:

- last N requests cached token ratio
- per-provider/model hit rate
- top cacheable routes with zero hits

This is low risk because opencodex already receives the data.

### Phase 2: Preserve Codex/OpenAI cache controls explicitly

Audit parser/schema/adapter paths to prove that these fields survive from incoming Responses requests:

- `prompt_cache_key`
- `prompt_cache_retention`

For Codex-originated traffic, `prompt_cache_key` should normally already be present as the codex-rs thread id. If passthrough preserves it already, add regression tests. If any routed OpenAI-compatible adapter drops it, add explicit pass-through for OpenAI-compatible providers only.

Acceptance criteria:

- A Responses request with `prompt_cache_key` reaches OpenAI/ChatGPT passthrough unchanged, except known sanitation.
- A Responses request with `prompt_cache_retention` reaches OpenAI/ChatGPT passthrough unchanged.
- Routed OpenAI-compatible adapter forwards these fields only when provider declares support or user opts in.

### Phase 3: Add telemetry before considering derived GPT cache keys

Implementation.

- Record whether incoming requests include `prompt_cache_key`.
- Record whether upstream usage reports `cached_tokens`.
- Aggregate hit ratio by provider/model/thread label.
- Add dashboard/CLI output for cache hit ratio and zero-hit diagnostics.

Acceptance criteria:

- We can answer "is Codex's thread key producing cache hits?" from local logs.
- We can distinguish "no key received", "key preserved but no provider hits", and "provider did not return cache usage".

### Phase 4: Optional derived GPT cache key for non-Codex clients

Add config:

```json
{
  "promptCache": {
    "openai": {
      "mode": "off|preserve|derive",
      "retention": "provider_default|in_memory|24h",
      "keyScope": "thread|account_thread|model_thread|prefix_hash"
    }
  }
}
```

Default should be `preserve`, not `derive`, because Codex already sends `prompt_cache_key`. `derive` is for non-Codex clients or routed providers after live data proves benefit.

Potential derived key:

- For non-Codex ChatGPT passthrough: hash of `provider + model + chatgptAccountId + thread-id/window-id`.
- For routed OpenAI API: hash of `provider + model + stable system/developer prefix`.

Risks:

- Too coarse key can exceed OpenAI's hot-prefix threshold and overflow routing.
- Too fine key yields no benefit.
- Any key containing raw prompt/user text is a privacy and observability problem. Use hashes only.

### Phase 5: Provider-specific explicit cache markers

Only after telemetry exists, add opt-in explicit caching for providers that need markers:

- Anthropic: add `cache_control` to large stable system/developer blocks or long retrieved context.
- Gemini/Vertex: only if using explicit cached content APIs or gateway-compatible markers; otherwise rely on implicit caching.
- OpenRouter/Vercel-like providers: pass through user-provided gateway fields rather than inventing incompatible fields.

Default should remain off because Anthropic cache writes can cost extra and minimum-token misses are silent.

### Phase 6: Cache-aware model/provider routing

Longer term, opencodex could mimic OpenRouter sticky routing:

- keep a per-session provider/model sticky map when cache hits are observed;
- avoid switching providers mid-session if the cached-token ratio is high;
- combine this with existing ChatGPT account/thread affinity and quota routing.

This is advanced because it competes with quota failover. A quota-critical failover should still override cache stickiness.

## GPT-side optimization checklist

Use this before implementation:

1. Is the prompt prefix stable for at least 1024 tokens?
2. Are tools/schema/system/developer blocks stable and placed before dynamic user data?
3. Does the incoming Codex request already contain `prompt_cache_key == thread_id`?
4. Does opencodex passthrough preserve `prompt_cache_key` and `prompt_cache_retention` exactly?
5. Is the same ChatGPT account/provider endpoint used for a given thread?
6. Are `cached_tokens` logged after each request?
7. Is the hit ratio visible in dashboard/status?
8. Are dynamic parts accidentally inserted before static parts by parser/adapters?
9. Are web-search/tool outputs appended late, not injected into the static prefix?
10. Are explicit cache writes disabled by default for providers that charge write premiums?

## Concrete PABCD Slice Proposal

### 10 Phase 1: Cache observability inventory

Docs-only + small diagnostics.

- Inspect request log shape.
- Add devlog with current cache data flow.
- Add tests proving cached token details survive all adapters/bridge.

### 20 Phase 2: OpenAI/Codex cache controls passthrough tests

Implementation.

- Add passthrough tests for `prompt_cache_key` and `prompt_cache_retention`.
- If failing, patch raw body preservation.
- Keep default behavior no-op.

### 30 Phase 3: Request-log cache metrics

Implementation.

- Extend request log entries with cache usage fields.
- Add dashboard/status summary if existing request log endpoint already supports it.
- Tests for cached-token aggregation.

### 40 Phase 4: Opt-in derived `prompt_cache_key` for non-Codex clients

Implementation.

- Add config field but default off/preserve.
- Derive stable hashed key only when enabled and no user/Codex key is present.
- Tests for no raw prompt leakage and no override of user-provided key.

### 50 Phase 5: Cache policy CLI/dashboard docs

Docs/UX.

- Document prompt cache behavior and risks.
- Show how to interpret cached token ratios.
- Add troubleshooting for “why cached_tokens is zero.”

### 60 Phase 6: Explicit cache marker research

Research before code.

- Re-fetch Anthropic official docs.
- Decide if/where to inject `cache_control`.
- Model write/read cost tradeoff table.

## Final Answer

opencodex is not "bad" on caching. It already preserves provider cache usage and has model/catalog cache layers. The key codex-rs finding is that Codex already sends `prompt_cache_key = thread_id`, so opencodex should not treat key synthesis as the default first move. The best next optimization is preservation proof, stable prefix discipline, `prompt_cache_key`/retention regression tests, and observability.

The highest-confidence first implementation is passthrough regression tests plus cache telemetry. Do not auto-inject Anthropic/Gemini cache markers yet. That should wait until we have hit-rate telemetry and official Anthropic docs re-fetched, because explicit caching can add write cost and can silently no-op under token minimums.
