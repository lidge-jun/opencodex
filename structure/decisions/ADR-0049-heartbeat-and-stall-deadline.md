# ADR-0049 — Heartbeat and stall deadline

- Contract owner: [transports/streaming-health.md](../transports/streaming-health.md#heartbeat-and-stall-deadline)

## Decision record

- 목적과 의도: Stop Codex from replaying a provider-rejected oversized turn and hand the failure
  to the client's existing context-compaction semantics.
- 기존 구현 및 제약 조건: Providers can reject before SSE starts; Codex retries raw HTTP 413,
  while it recognizes terminal `response.failed` `context_length_exceeded`; the proxy cannot edit
  Codex's persisted transcript safely.
- 검토한 주요 대안: Relay 413 unchanged; return HTTP 400 JSON; silently remove media or old turns;
  synthesize a successful assistant warning.
- 선택한 방식: Preserve HTTP 413 with typed JSON for non-streaming clients, and map the final
  streaming 413 to one redacted non-retryable Responses failure at the outer request boundary.
- 다른 대안 대신 이 방식을 선택한 이유: Raw 413 causes a retry loop, HTTP JSON does not enter
  Codex's context-window path, and silent deletion or fake success loses user intent without fixing
  transcript ownership.
- 장점, 단점 및 영향: Codex stops reconnecting and can compact on the next turn; no input is
  silently lost. The failed turn itself is not auto-replayed, and callers must retry after Codex
  compacts or reduce the current input.
