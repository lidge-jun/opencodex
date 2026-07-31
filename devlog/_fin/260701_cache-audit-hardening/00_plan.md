# 260701 Cache Audit Hardening Plan

## Objective
Audit and harden opencodex caching end-to-end: provider prompt-cache request support, cache usage propagation, Google replay cache behavior, model list TTL cache, and Codex model-cache sync. Fix functional gaps found in code and document deliberate non-parity.

## Evidence read
- README.md: opencodex is a local Responses proxy with provider adapters, dashboard logs, model sync, and Codex cache refresh.
- src/server.ts: request parsing, adapter selection, usage logging, model cache invalidation, `/api/usage`, `/v1/models` flow.
- src/responses/parser.ts and src/responses/schema.ts: `prompt_cache_key` exists in schema/types but is not mapped into `OcxParsedRequest.options`.
- src/adapters/anthropic.ts: recent commit added block-level `cache_control` for system prompts and final tool definitions; usage maps `cache_read_input_tokens` and `cache_creation_input_tokens`.
- src/adapters/openai-chat.ts: usage maps `prompt_tokens_details.cached_tokens`; request does not propagate Responses `prompt_cache_key` to upstream where supported.
- src/adapters/google.ts and src/adapters/google-antigravity-replay.ts: usage maps `cachedContentTokenCount`; Antigravity has thoughtSignature replay cache for eligible Gemini models.
- src/model-cache.ts and src/codex-refresh.ts: in-memory per-provider live model TTL and Codex on-disk model cache sync are separate from prompt caching.
- src/usage-log.ts and src/bridge.ts: cached token fields are propagated to Responses usage and request logs.

## External-source baseline
- Anthropic prompt caching is explicit: cacheable blocks need `cache_control: { type: "ephemeral" }`; system and tool blocks are valid cache surfaces.
- OpenAI prompt caching is mostly automatic for supported long prompts; `cached_tokens` appears in usage. Responses also exposes `prompt_cache_key` as an affinity/routing hint, but opencodex currently parses the raw field only at schema level.
- Google Gemini exposes `cachedContentTokenCount`; explicit context caching is a separate API and is out of scope unless opencodex adds persistent cached content resources.

## Scope boundary

### IN
1. Audit and document every cache-like surface in this repo.
2. Wire `prompt_cache_key` from Responses request body into parsed options/types if missing.
3. Forward `prompt_cache_key` only to adapters/upstreams where the field is compatible, starting with OpenAI Responses passthrough and OpenAI-compatible chat if the existing wire schema supports it without breaking common providers.
4. Add tests that prove cached usage fields survive adapter parsing, bridge conversion, and usage log normalization.
5. Add tests that prove Anthropic request cache breakpoints are present and not attached to the Claude Code OAuth identity block.
6. Preserve Kiro estimated usage semantics: request log can use full-context estimate, downstream SSE remains current-turn delta.
7. Preserve model-list cache behavior and add focused regression coverage only if a gap is found.
8. Add docs/devlog notes for intentional non-parity: Google explicit context-cache resources and Kiro real cache usage are not available through current upstreams.

### OUT
1. No multi-account Kiro failover.
2. No live destructive provider calls.
3. No persistent Google cached-content resource manager in this pass.
4. No changes to Codex CLI internals outside opencodex config/cache sync.
5. No push unless explicitly requested.

## Phase map

### Phase 10 — Cache surface audit and prompt_cache_key plumbing
Goal: make parsed request cache options honest and testable.

MODIFY: src/types.ts
- Before: `OcxRequestOptions` has `promptCacheKey?: string`, but parser does not populate it.
- After: keep the field and use it consistently in tests and adapters.

MODIFY: src/responses/parser.ts
- Before: `data.prompt_cache_key` is accepted by schema but dropped.
- After: set `options.promptCacheKey = data.prompt_cache_key` when present.

MODIFY: src/adapters/openai-responses.ts
- Before: passthrough serializes raw body, but routed/non-forward metadata handling needs audit for prompt_cache_key retention.
- After: explicitly preserve `prompt_cache_key` in passthrough/raw body tests; no mutation unless missing in routed construction.

MODIFY: src/adapters/openai-chat.ts
- Before: request body never carries prompt-cache affinity metadata.
- After: only if compatible with the target provider surface, add `prompt_cache_key` when `parsed.options.promptCacheKey` exists; otherwise document that chat-completions prompt caching is automatic and usage-only.

MODIFY: tests/adapter-usage.test.ts or NEW tests/cache-behavior.test.ts
- Add parser test: Responses `prompt_cache_key` reaches `parsed.options.promptCacheKey`.
- Add adapter request test for any adapter that forwards it.

Acceptance criteria:
- `bun test tests/cache-behavior.test.ts tests/adapter-usage.test.ts`
- `bun x tsc --noEmit`
- No file exceeds 500 lines.

### Phase 20 — Usage propagation and request log correctness
Goal: cached usage numbers must survive end-to-end into Responses usage and dashboard logs.

MODIFY: tests/adapter-usage.test.ts or NEW tests/cache-usage-log.test.ts
- Add bridge test for `cachedInputTokens -> input_tokens_details.cached_tokens`.
- Add usage-log test for cachedInputTokens normalization and total token calculation.
- Confirm Kiro estimated usage remains marked estimated in logs.

MODIFY: src/usage-log.ts only if tests reveal a gap.
MODIFY: src/bridge.ts only if tests reveal a gap.

Acceptance criteria:
- cached usage appears in Responses usage and persisted usage JSON shape.
- estimated status does not replace numeric token values with strings.

### Phase 30 — Model-cache regression and docs
Goal: distinguish model cache from prompt cache and prevent future confusion.

MODIFY: devlog/_plan/260701_cache-audit-hardening/01_cache-surface-audit.md
- Document the cache taxonomy: prompt cache, usage cache counters, Google replay cache, model-list cache, Codex on-disk models_cache.

MODIFY: docs or README only if a user-facing confusion remains after audit.

MODIFY: tests/codex-catalog.test.ts or tests/model-cache.test.ts only if an uncovered regression is found.

Acceptance criteria:
- devlog includes clear cache taxonomy and non-parity notes.
- Existing model-cache tests continue passing.

## Test matrix
- `bun test tests/adapter-usage.test.ts tests/usage-debug.test.ts tests/token-estimate.test.ts tests/google-antigravity-replay.test.ts tests/codex-catalog.test.ts`
- `bun x tsc --noEmit`
- Read-only verifier/audit if dispatch is available; if employee dispatch fails, record the failure and use local evidence.

## Risks
- Some OpenAI-compatible providers may reject unknown `prompt_cache_key`; if so, do not send it on generic chat-completions and document usage-only automatic caching instead.
- Anthropic block cache_control currently changes API-key `system` from string to block array; tests already cover this, but compatible gateways may vary. Keep Umans tests in the gate.
- Google explicit context caching is not equivalent to cachedContentTokenCount usage; avoid inventing persistent cache resources without a design pass.
