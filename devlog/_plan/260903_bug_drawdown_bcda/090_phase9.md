# 090 — Phase 9 (wp9): Issues #3245 and #1527 — evidence-backed disposition

Two items that investigation shows cannot be fixed from this machine. Each gets
a recorded disposition rather than a speculative patch.

## Issue #3245 — macOS Codex 0.152.0 stream disconnect

VERDICT NEEDS_REPRO / upstream. OpenCodex returns 426 by design when WebSockets
are disabled (`src/server/index.ts:1107-1126`), and its Responses data plane
only begins on the subsequent POST (`:1755-1787`). The reporter's probe shows no
POST and no usage-log entry, so SSE relay, terminal repair, timeout, and
outbound connection reuse were never reached
(`src/server/responses/core.ts:4657-4675`, `src/lib/upstream-retry.ts:294-311`).
Codex itself routes 426 to HTTP and already tests for the resulting POST. The
control test `tests/server-auth.test.ts:1384-1422` asserts 426 followed by HTTP
200 and predates v2.39.0.

Action: no OpenCodex diff. Comment with this trace, keep `upstream-tracking`,
and ask for a 0.152.1+ re-run recording `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
and the localhost probe.

## Issue #1527 — Cursor adapter large-context collapse

VERDICT NEEDS_REPRO, confidence high. The original full-history and overflow
defects are already fixed: checkpoints are reused and final replay envelopes are
bounded (`src/adapters/cursor/request-builder.ts:438`,
`src/adapters/cursor/protobuf-request.ts:1580`); rate limits are explicitly
non-retryable and post-terminal aborts no longer reclassify completed turns
(`src/adapters/cursor/transport-retry.ts:20`,
`src/adapters/cursor/live-transport.ts:716`). `max_output_tokens` is not lowered
— it has no wire field at all (`src/adapters/cursor/types.ts:12`,
`src/adapters/cursor/gen/agent_pb.ts:2736`). The only live candidate is cold
full replay after a missing/expired checkpoint, which needs a failing turn's
`continuationMode`, `rootBytes`, and direct-client cache evidence.

Action: no diff. Comment with the ruled-out causes and the exact capture needed
(matched direct-vs-proxy run on one account, redacted `run-request` fields).

## Verification (C)

Both are terminal as NEEDS_HUMAN with the analysis posted to the issue. No merge
proof applies; the evidence is the comment plus the file:line trace above.


## TESTS — why no RED assertion exists for either item

Both items are NEEDS_REPRO, so there is no honest failing unit test to write, and
manufacturing one would encode a guess as a contract. What each needs first:

- #3245: the control test `tests/server-auth.test.ts:1384-1422` already asserts
  426 followed by HTTP 200 and it PASSES on HEAD, which is precisely why the
  OpenCodex side is exonerated. A red test would have to live upstream in
  `codex-rs/core/tests/suite/websocket_fallback.rs`, asserting
  `websocket_attempts == 1 && http_attempts == 1` under the reporter's proxy
  environment; the reported failure is `http_attempts == 0`.
- #1527: the first artifact is a secret-free matched probe under `.tmp/` whose
  failure condition is that direct Cursor completes the workload without 429
  while OpenCodex returns 429 or fails the same completion rubric. Only after
  that isolates a cause does a red assertion become writable —
  `tests/cursor-request-builder.test.ts` asserting
  `continuationMode === "checkpoint"` with retained `checkpointBytes`, or
  `tests/cursor-blob.test.ts` asserting a captured direct wire parameter decodes.

Writing either assertion before its evidence exists is the failure mode this
campaign is supposed to avoid.

