# 070 — Usage convention unification + cache transparency

Round 4 (user report 260711 20:05): "캐싱이 하나도 처리가 안되고, 토큰 사용량이 어떻게
처리되고 있는지 너무 불투명해".

## Findings (live usage.jsonl, requests ocx-mrg9a*–mrg9d*)

1. **Upstream Anthropic prompt caching WORKS on the routed path.** The adapter's
   heuristic breakpoints (tools/system/penultimate-user + top-level automatic
   cache_control) produce real hits: e.g. fable-5 row `read=295846, write=2140`,
   opus row `read=101184, write=7580`. Full-write rows (`creation == entire input`)
   are first turns of parallel subagent sessions, not a broken cache.
2. **The reporting was broken in three stacked ways**, which made caching look dead:
   - `usageFromAnthropic` (adapter) recorded `inputTokens` EXCLUSIVE of cache
     (raw Anthropic convention, e.g. `4`), while every OpenAI-family adapter records
     INCLUSIVE input. `cachedInputTokens` was set to read+write COMBINED.
   - `bridge.responsesUsage` re-added read+write into `input_tokens`
     (`usageInputTokensWithCacheDetail`) and exported `cached_tokens = read+write`
     — wrong semantics (OpenAI `cached_tokens` means cache READS only).
   - `request-log` parsed that Responses usage (inclusive input + cache detail) and
     `usageDisplayTotalTokens` added the cache detail AGAIN → outer
     `totalTokens: 1489875` for a real 745877-token request (2x inflation), and the
     GUI "c 77.1만" chip couldn't distinguish an expensive full write from a cheap read.
   - `claude/outbound.anthropicUsage` told Claude Code
     `cache_read_input_tokens = read+write` (inflated by the write share).

## Canonical convention (v2, this commit)

`OcxUsage` is OpenAI-Responses-shaped everywhere:

- `inputTokens` — TOTAL prompt tokens, INCLUDING cache read + cache write.
- `cachedInputTokens` — cache READ tokens only (subset of inputTokens).
- `cacheReadInputTokens` / `cacheCreationInputTokens` — split detail when the
  provider reports both (Anthropic); reads mirror `cachedInputTokens`.
- `totalTokens` — inputTokens + outputTokens. Display rule everywhere:
  `max(usage.totalTokens ?? storedTotal, inputTokens + outputTokens)` — never
  re-add cache detail.

Normalization happens at the two Anthropic parse sites (`usageFromAnthropic`,
`anthropicUsageToOcx`): `inputTokens = raw_input + cache_read + cache_creation`.

Wire mapping:
- Responses SSE (`bridge.responsesUsage`): `input_tokens = usage.inputTokens`,
  `input_tokens_details.cached_tokens = reads`, `.cache_write_tokens = writes`.
- Anthropic SSE out (`outbound.anthropicUsage`):
  `input_tokens = max(0, input - reads - writes)` (Anthropic exclusive convention),
  `cache_read_input_tokens = reads`, `cache_creation_input_tokens = writes`.

Legacy rows: old adapter-direct rows (exclusive input) keep a correct display total
via their stored `totalTokens`; old claude-route rows with the inflated outer total
are healed because inner `usage.totalTokens` takes precedence. Historical
`inputTokens` sums in the Usage summary undercount for pre-fix anthropic rows —
accepted drift, noted here.

Also hardened: `mergeAnthropicUsage` now OVERWRITES per key instead of adding —
Anthropic `message_delta.usage` is cumulative, so addition double-counted
`message_start`'s output tokens (and would double input if a delta repeated it).

## GUI

- Logs list token cell now shows `c <read>` + `w <write>` split lines with an
  i18n-labelled tooltip breakdown (input/output/read/write/reasoning).
- Usage page: cached card = reads; new cache-write card when nonzero.
- i18n en/ko/zh/de.
