# 001 — codex-rs timeout semantics (gpt-5.5 explorer report, agent 019f3cb4-6149-7113-874f-d1b99745ce6f)

Clone: /Users/jun/Developer/codex/120_codex-cli/codex-rs (HEAD 2026-07-01 129ea2aaf)

1. Stream idle timeout: `timeout(idle_timeout, stream.next())` over an eventsource stream
   (codex-api/src/sse/responses.rs:475); ANY yielded SSE event re-arms it BEFORE type parsing;
   unknown types fall through `_ => trace!(...)` / `Ok(None)` (codex-api/src/sse/responses.rs:443).
   So the bridge's 2s `response.heartbeat` re-arms Codex's idle timer.
2. No other codex-side wall clock bounds an active HTTP /v1/responses stream: request
   `timeout: None` by default (codex-api/src/provider.rs:77; codex-client/src/transport.rs:65),
   retry policy is attempt-based (codex-client/src/retry.rs:58), the only explicit timeout in
   core/src/client.rs:968 is WebSocket CONNECT only.
3. Default idle timeout 300_000 ms (model-provider-info/src/lib.rs:26), per-provider override
   `stream_idle_timeout_ms` via config (lib.rs:126,315).
4. Proxy-emitted `response.incomplete` reason=upstream_stall_timeout → parsed at
   codex-api/src/sse/responses.rs:399 → `ApiError::Stream("Incomplete response returned,
   reason: upstream_stall_timeout")` → retryable `CodexErr::Stream` (protocol/src/error.rs:200)
   → "Reconnecting... n/max" retries up to stream_max_retries (core/src/responses_retry.rs:48),
   then the turn fails.

Conclusion: with heartbeats flowing, ONLY opencodex's own bridge stall deadline can kill a long
web-search turn; Codex then burns stream retries re-submitting, which re-runs the whole
web-search loop and can repeat the kill — matching the user-observed "time limit termination".
