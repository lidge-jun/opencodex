# 000 — same-target 429 retry: why the client cannot do it

## 요약

Codex turns die instantly when an upstream provider (e.g. BLSC with a single API key)
returns HTTP 429. The proxy forwards the error with `Retry-After` (#514), but Codex
never acts on it.

## Evidence

- **Upstream [openai/codex#30471](https://github.com/openai/codex/issues/30471) (open):**
  `codex-rs/codex-api/src/provider.rs` has a retry policy with an explicit `retry_429` flag,
  and the endpoint configs set it to `false`; HTTP 429 is only mapped to `UsageLimitReached`
  when the body matches the Codex usage-limit shape, otherwise it falls through to a generic
  transport/API error and surfaces as the misleading "exceeded retry limit" message. The
  suggested fix is to reword the error, deliberately preserving `retry_429=false` — there is
  no user-facing knob to enable client-side 429 retry.
- **opencodex issue #487 (auto-closed as `not_planned` for missing detail):** the author
  requested exactly this feature and noted "The Codex client itself does not retry 429
  (upstream: openai/codex#30471) — it only retries 5xx — so a proxy-side retry would fill a
  real gap."
- **opencodex PR #514 (merged):** attaches a client `Retry-After` (upstream header → message
  hint → default 2) across Responses, chat completions, Claude messages, and passthrough
  paths. Its own test plan lists the Codex recovery check as *unverified*. Claude Code honors
  `Retry-After` and absorbs 429s (#507); Codex does not.

## Current proxy behavior (v2.8.0 / dev)

- `src/server/responses/core.ts` recovery loop: the only 429 retry is multi-key failover
  (`hasKeyPoolFailover` requires ≥2 keys in `apiKeyPool`). Single-key pools no-op, and the
  429 falls through to `rate_limit_error` with `Retry-After`.
- `src/server/chat-completions.ts` and the routed Claude path reuse `handleResponses`, so one
  insertion point covers all three inbound surfaces.

## Conclusion

Client-side 429 retry does not exist and is not planned. The fix must live in the proxy:
an opt-in wait-and-retry that replays the identical pre-stream request on the same key before
any failover.
