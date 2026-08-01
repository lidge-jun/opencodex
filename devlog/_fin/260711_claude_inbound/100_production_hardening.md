# 100 — Production hardening loop (WP1-WP4)

Round 6 (user, 260711 21:15): "전반적으로 프로덕션급으로 보강하는 cxc-loop, sol이랑 같이".
HOTL goal + manual PABCD (cxc CLI absent). sol explorers x2 (Copernicus: API conformance,
Jason: gateway/CC field behavior) + sol workers x2 (Feynman: WP3 observability,
Ohm: WP4 docs). Worker evidence: `.codexclaw/evidence/wp3-observability-20260711.md`,
`wp4-claude-code-docs-20260711.md`.

## WP1 — Gap list & verdicts

Sources (Tier-2 opened, 2026-07-11): platform.claude.com errors/streaming/rate-limits/
token-counting/handling-stop-reasons docs; claude-code issues #33949 #26224 #2728 #3633
#8047 #46416 #13012 #2256; CLIProxyAPI #1620 #2189 #2599; BerriAI/litellm #16716 #14236.

| Gap | Verdict | Rationale |
|---|---|---|
| Error taxonomy missing 402/409/413/504 | ADOPT | official table (errors doc) |
| EOF w/o terminal closed as end_turn | ADOPT fail-closed | silent-truncation is gateway failure pattern #5 (CLIProxyAPI#2189); CC needs a retryable `error` event |
| No idle SSE pings | ADOPT (20s synth) | pings legal anywhere/any count; protects LB/NAT + slow first byte; CC does not REQUIRE them (#33949) so interval is conservative |
| incomplete(content_filter) unmapped | ADOPT -> `refusal` | official stop_reason list includes refusal |
| stop_sequence always null | REJECT | Responses API does not expose the matched stop string; no source of truth |
| count_tokens estimate | REJECT (keep) | official count_tokens is itself an estimate; LiteLLM ships tokenizer fallback; documented in guide |
| /api/hello endpoint | REJECT | old-CLI connectivity probe; current CC works without it (live evidence) |
| pause_turn / model_context_window_exceeded | REJECT | no upstream signal maps to them on routed paths; native passthrough relays verbatim |
| surface tag + GUI filter (050 follow-up) | ADOPT (WP3) | |

## WP2 — Conformance fixes (outbound.ts)

- `anthropicErrorType`: + 402 billing_error, 409 conflict_error, 504 timeout_error
  (413 request_too_large was already present).
- EOF without terminal frame -> `event: error` api_error 502 "truncated response"
  (was: polite end_turn). Matches openai-chat adapter fail-closed precedent.
- `response.incomplete` reason `content_filter` -> stop_reason `refusal`.
- Idle keepalive: `responsesSseToAnthropicSse(..., { pingIntervalMs })` default 20s;
  ping timer cleared on finish/cancel; pings emitted mid-stream are spec-legal.
- Tests: EOF fail-closed, refusal mapping, idle-ping timing (25ms interval fixture),
  taxonomy table.

## WP3 — Observability (worker Feynman)

`surface: "claude"` on RequestLogContext/Entry, set in handleClaudeMessages +
count_tokens native passthrough; GUI Logs surface filter (all|claude|codex segmented)
+ filtered virtualizer; i18n x4; request-log tests.

## WP4 — Docs (worker Ohm)

claude-code guide x3 locales: Reasoning effort section (adaptive wire), Prompt caching
section (breakpoints/affinity/CLAUDE.md), token display (c/w), Production notes
(error taxonomy, Retry-After, count_tokens estimate). docs build 55 pages clean.

## Gates (D)

bun test 2163 pass / 0 fail; tsc clean; gui build clean; docs build clean.
Commits: WP2 + WP3 + WP4 recorded on claudecode branch (see git log).
