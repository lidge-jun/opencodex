# ADR-0044 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Turn upstream terminal variants and bare EOF into one deterministic Responses
  outcome instead of a retryable disconnect or duplicate terminal.
- 기존 구현 및 제약 조건: Policy refusals can arrive in several SSE envelopes, while a clean EOF,
  an unterminated final frame, and a read error exercise different pull/tee and eager cleanup paths.
- 검토한 주요 대안: Forward every byte unchanged; classify only request logs; synthesize a failure
  after every EOF or read error; normalize the bounded terminal at the client output boundary.
- 선택한 방식: Rewrite only high-confidence policy terminal shapes, preserve their bounded metadata,
  flush native terminal candidates before transport-error classification, keep repair-owned
  delimiter-less candidates tainted, and synthesize `adapter_eof` only when no real terminal exists.
- 다른 대안 대신 이 방식을 선택한 이유: Log-only classification leaves Codex retry behavior
  unchanged, while unconditional synthesis can create two contradictory outcomes for one turn.
- 장점, 단점 및 영향: Both native relay shapes expose exactly one terminal and one sentinel with
  matching accounting. Ordinary upstream errors remain fail-closed, and policy refusals remain
  refusals rather than becoming successful model output.
