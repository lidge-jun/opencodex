# Provider Cache Parity Audit

## Scope

This audit covers prompt-cache behavior for the provider surfaces currently relevant to opencodex:

- Anthropic Messages adapter: `src/adapters/anthropic.ts`
- OpenAI / ChatGPT Responses passthrough: `src/adapters/openai-responses.ts`
- OpenAI-compatible chat providers, including Kimi / Moonshot: `src/adapters/openai-chat.ts`
- Google Gemini / Vertex / Antigravity: `src/adapters/google.ts`
- Umans Coding Plan, because it uses the Anthropic Messages adapter with Kimi-family models

It intentionally excludes server-side response caching. Prompt caching is a provider-side prefix reuse feature; opencodex should preserve, expose, and safely activate provider cache controls, not cache model outputs.

## External Evidence

### Anthropic

Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

Findings:

- Anthropic supports both top-level automatic caching and explicit block-level breakpoints.
- Top-level `cache_control: { "type": "ephemeral" }` automatically moves the cache breakpoint to the last cacheable block as a conversation grows.
- The official cURL, Python, and TypeScript examples put `cache_control` at the request body root next to `model`, `max_tokens`, `system`, and `messages`.
- Explicit and automatic caching can be combined. Automatic caching consumes one of the four available cache breakpoint slots.
- Prompt prefix order is `tools`, then `system`, then `messages`.
- Cache reads look back up to 20 blocks per breakpoint.
- Default TTL is 5 minutes. A 1-hour TTL exists but costs more.
- Cache write tokens cost more than regular input; cache read tokens are cheaper.
- Active Claude models support prompt caching, but minimum cacheable prompt length varies by model.

opencodex status:

- Existing code explicitly marks the user system prompt and final tool definition with `cache_control`.
- Existing code does not add top-level automatic `cache_control`, so message history is not actively cache-targeted.
- Recent request logs showing about 9K cached tokens on about 47K actual input are consistent with system/tool prefix caching but not conversation-history caching.

Recommendation:

- Add top-level automatic caching for native Anthropic API requests using the same 5-minute TTL as the existing block-level breakpoints.
- Keep explicit system/tool breakpoints because they protect stable prefix regions and keep behavior aligned with Claude Code-style static prefix caching.
- Do not enable 1-hour TTL by default because it changes write cost.

### OpenAI / ChatGPT Responses

Source: https://developers.openai.com/api/docs/guides/prompt-caching

Findings:

- Prompt caching is automatic for qualifying prompts.
- Caching starts at 1024 prompt tokens.
- `usage.prompt_tokens_details.cached_tokens` reports cache hits.
- `prompt_cache_key` should be used consistently across requests sharing common prefixes.
- OpenAI recommends monitoring cache hit rates and cached-token proportions.
- `prompt_cache_retention` can request extended retention on supported models.

opencodex status:

- `src/responses/schema.ts` accepts `prompt_cache_key`.
- `src/responses/parser.ts` maps it to `options.promptCacheKey`.
- `src/adapters/openai-responses.ts` forwards `parsed._rawBody`, preserving request fields such as `prompt_cache_key` unless a sanitizer changes them.
- `tests/openai-responses-passthrough.test.ts` covers raw `prompt_cache_key` preservation.
- No explicit `prompt_cache_retention` parser or regression test exists yet.

Recommendation:

- Preserve pass-through behavior as the default.
- Add focused coverage for `prompt_cache_retention` preservation on the raw Responses passthrough path.
- Do not synthesize a key by default because Codex already sends a stable thread key in normal traffic.

### OpenAI-compatible Chat, Including Kimi / Moonshot

Source state:

- Kimi provider entries use `adapter: "openai-chat"` and `baseUrl: "https://api.kimi.com/coding/v1"` in `src/providers/registry.ts`.
- No reliable official Kimi prompt-cache control evidence was found in this pass.
- OpenAI-compatible chat providers may reject unknown top-level fields.

opencodex status:

- `src/adapters/openai-chat.ts` maps upstream `usage.prompt_tokens_details.cached_tokens` into `cachedInputTokens`.
- The adapter does not forward `prompt_cache_key`.
- Existing devlog already marks generic chat-completions `prompt_cache_key` forwarding as deliberate non-parity because compatibility varies.

Recommendation:

- Keep usage-only cache support for generic chat-completions.
- Do not add `prompt_cache_key`, `prompt_cache_retention`, or Anthropic-style `cache_control` to generic chat bodies without a provider-specific opt-in.
- Treat Kimi/Moonshot as "observability only" until official wire support is confirmed.

### Google Gemini / Antigravity

Source: https://ai.google.dev/gemini-api/docs/caching

Findings:

- Gemini 2.5 and newer support implicit caching by default.
- The Interactions API page documents implicit caching only; explicit cached-content resources are a separate generateContent surface.
- Cache hits are reported through cached content token counts.

opencodex status:

- `src/adapters/google.ts` maps `usageMetadata.cachedContentTokenCount` into `cachedInputTokens`.
- Antigravity wraps the Gemini request in the Cloud Code Assist envelope, preserves reported usage, and exposes cached token hits in `tests/google-antigravity-wire.test.ts`.
- `src/adapters/google-antigravity-replay.ts` is a reasoning signature replay cache, not a billing prompt cache.

Recommendation:

- Keep Gemini / Antigravity prompt caching implicit.
- Do not implement persistent cached-content resource management in this goal.
- Preserve and display `cachedContentTokenCount` as cache telemetry.

### Umans Coding Plan

Source state:

- `src/providers/registry.ts` configures Umans with `adapter: "anthropic"` and `baseUrl: "https://api.code.umans.ai"`.
- `tests/umans-provider.test.ts` verifies Anthropic message-wire behavior without Anthropic OAuth beta headers.

opencodex status:

- Umans inherits Anthropic adapter request construction, including current explicit `cache_control` markers.
- If top-level automatic caching is added unconditionally to the Anthropic adapter, Umans will receive the same field unless explicitly gated.

Risk:

- Umans is an Anthropic-compatible gateway, not the native Claude API. The upstream may reject top-level `cache_control` even if it accepts block-level markers.

Recommendation:

- Gate top-level automatic caching to native Anthropic API requests only.
- Keep Umans on existing block-level cache markers until Umans publishes or proves top-level automatic `cache_control` support.
- Add an Umans regression assertion that `body.cache_control` is absent while existing system/tool block-level markers remain.

## Local Claude Code / CLI Source Comparison

Local source root: `/Users/jun/Developer/codex`

Relevant findings:

- `/Users/jun/Developer/codex/002_prompt-context/claude-code_prompt/26-permission_scope-permission-scope-defs.md` shows Claude Code-derived logic reading `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` separately.
- The same source marks selected text blocks with `cache_control` and logs actual input as `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`.
- `/Users/jun/Developer/codex/002_prompt-context/02_ai_prompt.md` and `/Users/jun/Developer/codex/010_memory-pipeline/10_ai_memory.md` describe Aider/Claude-style cache strategies that mark stable examples/system/repo/chat-file regions.
- Copilot CLI extracted sources under `/Users/jun/Developer/codex/151_copilot_cli/` track `cacheReadTokens` and `cacheWriteTokens` separately in telemetry.

Implications for opencodex:

- `OcxUsage.cachedInputTokens` currently merges cache-read and cache-creation tokens for Anthropic. This is sufficient for OpenAI Responses compatibility but less precise than Claude Code/Copilot telemetry.
- The request log display should eventually distinguish read vs write tokens for providers that expose both.
- The immediate bug behind low Anthropic cache hits is not usage parsing; it is that message history lacks a moving cache breakpoint.

## Provider Matrix

| Provider surface | Native cache mode | opencodex request support | opencodex usage support | Safe next action |
| --- | --- | --- | --- | --- |
| Anthropic native | Explicit or automatic `cache_control` | Explicit tools/system only | `cache_read + cache_creation` merged | Add top-level automatic 5m caching |
| OpenAI / ChatGPT Responses | Automatic prefix caching | Raw passthrough preserves fields | `cached_tokens` extraction | Add retention preservation test |
| OpenAI-compatible chat | Provider-specific / automatic if any | No generic cache controls | `cached_tokens` extraction | Keep usage-only by default |
| Kimi / Moonshot | Not proven from official docs in this pass | No generic cache controls | OpenAI-chat usage extraction if returned | Document as no-op until official support |
| Google Gemini | Implicit caching | No explicit cached-content management | `cachedContentTokenCount` extraction | Keep implicit usage-only |
| Antigravity CCA | Gemini implicit cache via wrapped upstream | CCA session id + implicit request | Wrapped usage extraction | Keep implicit usage-only |
| Umans | Anthropic-compatible gateway | Inherits Anthropic adapter | Inherits Anthropic usage parsing | Test top-level cache_control shape |

## Open Risks

- Top-level `cache_control` is documented for native Anthropic, but Anthropic-compatible gateways may lag.
- Anthropic cache-read and cache-write tokens are merged in current usage logs, so hit-rate and write-cost analysis are imprecise.
- Kimi/Moonshot official cache-control support remains unproven; adding generic fields would risk 400s.
- OpenAI `prompt_cache_retention` is pass-through only; opencodex does not validate model support or privacy implications.

## Decision

Proceed with a narrow implementation pass:

1. Add native-Anthropic-only top-level automatic cache control with default 5-minute ephemeral TTL.
2. Keep existing explicit system/tool breakpoints.
3. Add request-shape tests for native Anthropic, OAuth Anthropic, and Umans gateway shape; Umans must not receive the top-level field.
4. Add OpenAI Responses passthrough test for `prompt_cache_retention`.
5. Update cache devlog taxonomy after verification.
