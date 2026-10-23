# Combo Streaming Boundaries

## Combo streaming commit boundary

An HTTP 200 does not by itself commit a streaming combo child. The combo parent runs the child's
downstream Responses SSE through `src/server/responses/combo-stream-preflight.ts`, which owns one
reader and buffers only until one of these boundaries:

Native post-header reset recovery shares that boundary, because it is asking the same question
about the same bytes. With `replayReadErrors`, the preflight reports the stage it observed —
`headers-only` before any parsed event, `protocol-prelude` after `response.created`,
`semantic-output` once anything else arrives, including a payload it could not parse — and the
resend gate decides. A `response.created` whose snapshot already carries output items is not a
prelude.

- a non-control Responses event begins client-visible output or a tool/action item, after which the
  target is committed and cross-target replay is forbidden;
- a `response.failed` terminal arrives first, in which case the terminal is converted back through
  the ordinary bounded combo-failure classifier and may advance to the next declared target;
- a zero-output `response.incomplete` with no reason, `adapter_eof`, `missing_terminal_event`, or
  `upstream_stall_timeout` follows the same failure path; explicit semantic or unknown reasons stay terminal;
- a top-level `error` arrives before output, in which case unknown, rate-limit, and server failures
  may advance while errors explicitly classified as non-retryable 4xx remain committed;
- another completed/incomplete terminal or the aggregate preflight byte or retained-chunk cap is reached,
  in which case the current target is committed conservatively.

The buffered bytes are replayed unchanged before the reader continues. Native passthrough and eager
relay identity markers are restored on the wrapped response so Windows/Bun stream paths and deferred
logging retain their existing owners. A failed child keeps its physical attempt receipt and usage,
while the successful child remains the logical request result.

`src/server/responses/core.ts` holds the admitted turn lease across the whole combo ladder.
Refused child relays can unbind without settling the parent; the accepted stream keeps its binding
after the ladder returns, until completion or cancellation. Buffered/exhausted exits release the
ladder binding in `finally`. `tests/server/server-combo-zero-output-failover.test.ts` covers failover,
accepted stream lifetime, cancellation, and exactly-once attached-lease release.
Plain admission leases without controller binding do not register or unregister a ladder controller.
Reasonless incomplete snapshots containing output items stay committed; an explicit `reason: null`
also stays terminal. `tests/routing/combo-stream-preflight.test.ts` pins these conservative boundaries.
Hop warnings in `src/server/responses/core-combo.ts` include only parsed upstream code/message,
redacted before whitespace flattening and bounded to 200 characters; unparsed bodies stay out.
`tests/responses/responses-combo-exhausted-error.test.ts` pins that log boundary.

A `runTurn` adapter has the equivalent boundary in `preflightAdapterEvents` (`src/adapters/run-turn-queue.ts`), streaming and non-streaming alike: when its first meaningful event is a tool call the current request did not declare, and no earlier replay-unsafe heartbeat recorded a side effect, `src/server/responses/run-turn-execution.ts` projects the fail-closed undeclared-tool refusal as a pre-commit 502 so the combo can hop with the unchanged catalog. After any output or a replay-unsafe heartbeat the refusal stays with that child. Chat Completions and Anthropic Messages inbound requests do not use this classification. The same heartbeat also decides an ordinary pre-output adapter error or an empty end: after a replay-unsafe heartbeat the child's 502 is marked non-replayable, so the combo stops on it instead of sending the turn to the next target.

HTTP 410 remains terminal by default. It advances and cools only the exact combo target when the
structured code or message explicitly identifies a model lifecycle event (end-of-life, retired,
deprecated, sunset, decommissioned, or no longer available). An unrelated application-level 410 is
not retried.

> Decision record: [ADR-0071](../decisions/ADR-0071-combo-streaming-commit-boundary.md)
