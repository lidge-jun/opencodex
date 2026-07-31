# 090 — OpenAI-route cache misses: missing prompt_cache_key

User report (260711 21:03): two consecutive gpt-5.6-sol turns 10s apart showed no
cache line. usage.jsonl confirms the upstream EXPLICITLY reported `cached_tokens: 0`
(in=34,484 then 34,521 — near-identical prefix), provider `openai` =
`https://chatgpt.com/backend-api/codex` (native ChatGPT backend, forward auth).

Root cause: OpenAI-side prompt-cache routing is keyed by `prompt_cache_key` — real
Codex clients send their session id, and the raw Responses passthrough preserves the
field (tests/openai-responses-passthrough.test.ts). Our Anthropic→Responses
translation never set it, so every Claude Code turn landed without cache affinity and
missed.

Fix: `anthropicToResponsesBody` now derives `prompt_cache_key` from Claude Code's
`metadata.user_id` (which embeds the session uuid) as a 32-hex sha256 slice — stable
per session, bounded length/charset. The native-route strip list
(claude-messages.ts) keeps the field; schema/parser already supported it
(`prompt_cache_key` -> options.promptCacheKey).

Anthropic-routed models are unaffected (content-keyed caching, already ~99.9% hits —
see 080). Verification: fresh session, two consecutive gpt-routed turns; the second
row should show `c ~= input`.

## Follow-up (21:09 live rows): header, not just body

After the daemon restart with prompt_cache_key, small repeated low-effort calls began
hitting (5.3만 rows with c 5.2만) but the main-session 3.5만 rows still reported
cached_tokens: 0. The ChatGPT backend's cache affinity rides the `session_id` HEADER
(codex clients always send their session uuid; it is in FORWARD_HEADERS), which
Claude Code never sends. The native route now synthesizes a stable uuid-shaped
session_id from the same per-session hash (751e473c). Endpoint test covers the pair
plus effort forwarding on the native route.
