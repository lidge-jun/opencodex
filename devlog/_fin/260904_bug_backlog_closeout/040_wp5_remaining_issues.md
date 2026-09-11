# wp5 — remaining unclaimed bug issues (#3433, #3424)

## #3433 — intermittent consecutive zero cache hits (Hermes)

Hypothesis CONFIRMED by an independent Sol lane, with one qualification: the body cache
key is preserved; what is missing is `session_id` synthesis.

- `chatCompletionsToResponsesBody` copies `prompt_cache_key` unchanged
  (`src/chat/inbound.ts:316`), so the key is not lost in translation.
- `FORWARD_HEADERS` includes `session_id`/`session-id`
  (`src/adapters/openai-responses.ts:36-44`), but the Chat bridge only copies headers the
  caller already sent (`src/server/chat-completions.ts:208-213`) — there is no
  body-key-to-header synthesis before serialization (`:233`), inside
  `handleChatCompletionsWithBudget` (`:83`).
- The Claude bridge DOES synthesize: it formats a 32-hex key as a UUID
  (`src/server/claude-messages.ts:157-160`) and applies it only for native Responses
  routes, only for metadata-derived per-session keys, and only when forwarded headers lack
  `session_id` (`:756-766`). Its comment records the devlog 090 finding that a body-only
  `prompt_cache_key` still produced `cached_tokens: 0`.

Fix plan (provenance-gated — REVISED after plan audit): synthesize `session_id` in
`handleChatCompletionsWithBudget` after header forwarding and before serialization, ONLY
when every guard holds: the caller sent no `session_id`/`session-id` header; the route
adapter is `openai-responses`; the key is a non-empty string; AND the key carries
POSITIVE per-session provenance. Convert deterministically to a UUID-shaped value
mirroring `src/server/claude-messages.ts:157-160`, hashing arbitrary keys to 32 hex first
so Claude's existing 32-hex result is preserved. Keep the body key intact.

REJECTED alternative (audit blocker 4): treating every caller Chat `prompt_cache_key` as
per-session. Chat keys are opaque caller values (`src/chat/inbound.ts:316`) and Claude
deliberately restricts synthesis to metadata-proven per-session keys, excluding shared
cohort keys (`src/server/claude-messages.ts:761`). Blanket synthesis would bind unrelated
callers sharing a cohort key onto one upstream session — a cross-request affinity bug
worse than the zero-cache symptom. It is NOT merge-safe and is out of scope.

Consequence: the Chat bridge needs a provenance signal equivalent to Claude's
`cacheKeySource` (`src/claude/inbound.ts:450-455, 522-553`) before any synthesis lands.
wp5's P decides one of: (a) add explicit per-session provenance to the Chat request path
and gate on it, or (b) if no honest provenance exists, do NOT patch — post the finding on
#3433 with file:line evidence and mark it NEEDS_HUMAN for a maintainer protocol decision.
Option (b) is a legitimate terminal outcome; shipping (a) without provenance is not.

Second, independent cause: pool affinity keys on `x-codex-parent-thread-id` or the
`session-id`+`thread-id` pair (`src/codex/auth-context.ts:80-98`), not underscore
`session_id` and not the body key. Without those, requests are unbound and can be
reassigned (`src/codex/routing.ts:2047-2068, 2143-2158`), changing the upstream cache
cohort. Synthesizing `session_id` may fix backend cache routing while leaving pool
stickiness unchanged. Test the two causes independently.

Regression file: `tests/chat-completions-endpoint.test.ts` (native header forwarding is
already covered at `:1755-1806`); Claude reference at
`tests/claude-messages-endpoint.test.ts:639-699`.

## #3424 — model unusable when the proxy is enabled

Chinese-language report, catalog/service labels, no reproduction detail yet. wp5's P must
first establish which model and which provider before any code change. Likely outcome is a
reproduction request rather than a patch; if so it moves to the wp6 disposition set.

## Accept criteria
- #3433 reaches a TERMINAL outcome: a merged or live provenance-gated PR with a focused
  regression in `tests/chat-completions-endpoint.test.ts`, OR a NEEDS_HUMAN close-out
  posted on the issue naming the provenance gap with file:line evidence. An unposted
  internal decision does not count.
- #3424 reaches a TERMINAL outcome: a fix PR, or a posted reproduction request with
  specific named questions plus the `needs-info` label so the stale workflow owns the
  timeout. Leaving it silently open is a failure.
- no blanket cache-key synthesis is shipped
