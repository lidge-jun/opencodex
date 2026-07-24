# WP9 — #338 slow-calls close + re-test request (080)

Issue #338: "The call speed is super slow (<5 tok/s) but calling GPT directly
without OpenCodex is fast." Version v2.7.36, mac, chatgpt+grok+gemini accounts.
No logs/config/model attached (all "_No response_").

## Rationale (per user directive)

User: "일단 어제 z커밋이 많이 들어갔을텐데 일단 닫고 재보고 요청으로 마무리."
Yesterday's dev landed substantial streaming/SSE throughput work that directly
affects perceived tok/s:
- `03ea4e59` pull-driven backpressure for routed SSE streams (WP5b)
- `366e3053` bound runTurn event backlog + close fetch-to-reader abort race (WP5a)
- `83811e28` count upstream comment keepalives as adapter activity (WP4)
- plus the broader `260724_sse_hardening` closeout.

#338 has no logs, no provider/model, no config → not reproducible as filed, and
the most likely contributing paths were reworked after v2.7.36.

## Action

Comment (English) + close #338 with a re-test request: update to the latest
release (post-SSE-hardening), reproduce, and if still slow reopen with proxy logs
(the dashboard per-request timing), provider+model, tok/s vs direct, and whether
web-search/vision sidecar was active on the slow turn (see #398 — sidecar waits
can dominate a turn).

Terminal: DONE = comment posted + #338 closed.
