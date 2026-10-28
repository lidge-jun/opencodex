# Combo Streaming Boundaries

## Buffered required-tool contract

Before combo success bookkeeping, native delivery in `src/server/responses/passthrough-delivery.ts`
uses `src/server/responses/combo-required-tool-contract.ts` to check successful native
`openai-responses` JSON children with explicit required or named function/custom choices.
Only a parsed `completed` output array can prove a violation. A missing required call becomes
502 `required_tool_contract_unsatisfied`; normal failure handling owns target eligibility,
send budgets, fallback consent and spent-replacement refusal. Usage remains on the failed attempt.
Hosted calls satisfy an any-tool requirement only for a declared mapped capability. A mismatched
hosted call returns HTTP 400 with the same code, marked non-replayable and carrying
`x-should-retry: false`, because it may already have executed. Error formatting retains that client policy.
Provider-executed custom calls use response ownership and `isAuthorizedProviderExecutedCall` in
`src/server/responses-undeclared-tool-guard.ts`; a hosted call cannot masquerade as a client custom call.
Unknown tool declarations abstain; incomplete, failed and opaque payloads retain delivery.
Judgment precedes local hosted-image display projection, which replaces image calls with messages;
canonical SSE buffered for JSON callers is judged after restoration and before that projection too.
Accepted bodies retain response tool ownership and preinspection identity, with stale representation
headers removed after decoding. Existing non-replayable responses bypass inspection.
Translated Chat, runTurn and native Chat terminal owners stay outside this buffered guard.
The streaming sibling below uses the existing inspector and rewrite readers; it never replays output.
`src/lib/errors.ts` declares the code and `src/bridge/errors.ts` preserves it through combo error
formatting without overriding cyber-policy precedence. Regression coverage lives in
`tests/server/server-combo-required-tool-contract.test.ts`, including the 151-tool call/result cycle.

## Streaming required-tool contract

For native `openai-responses` combo children requested with `stream: true`,
`src/server/responses/combo-required-tool-stream.ts` applies the same explicit required/named
contract derived from the caller body, independently of outbound capability filtering. Acceptable
calls retain caller-declared identities through the shared restorers. The adapter records authorized
hosted substitutions in `AdapterRequest.hostedToolSubstitutions` during the build step that applies
them; delivery reads that metadata and body from the request that produced the stream, including
in-place queued revalidation in `src/server/responses/request-transport.ts`. Every build supplies an
array, including empty, so removing a preference cannot retain an earlier build's authority.
`src/server/responses/combo-required-tool-fulfillments.ts` accepts `image_generation_call` for the
replaced image function only when that send still declares the hosted capability. A filtered tool or
lowered `none` selector never erases caller intent: missing calls retain the usual pre-commit fallback
or post-commit typed failure. Caller hosted non-function selectors retain their terminal owner.
Completed item events and terminal snapshots can satisfy it; a call start alone cannot.
Missing calls turn `response.completed` into `response.failed` with
`required_tool_contract_unsatisfied`, retaining response identity, output and usage.
The client rewrite judges restored calls before continuation observers and hosted-image display.
The raw inspector and client guard resolve selectors and observed calls through the same authorized
Muse/namespace alias maps, authorized self-named scrub and catalog-aware default-namespace normalization.
They compare name and namespace (the reserved `functions` group is bare) before reporting terminals
or persisting completion. Eager and tee retain their readers and cancellation owners.
Provider-owned custom calls retain their call-ID-prefix ownership. Hosted effects, unknown items,
and the local web-search bridge make the verdict non-replayable, including sparse terminal snapshots.

Only this mandatory native contract extends preflight to hold known reasoning frames. It keeps the
existing aggregate byte/chunk caps and a fixed `COMBO_REQUIRED_TOOL_REASONING_HOLD_MS` deadline of
1,000 ms from the first held reasoning frame in `src/server/responses/combo-stream-preflight.ts`.
Trickling frames do not reset it. Deadline expiry, text, tools, opaque/unknown events or either cap
commit this child; expiry releases held bytes and transfers the pending read to the existing relay,
preserving its eventual chunk or error exactly once without authorizing replay. A missing-call
terminal held before commitment becomes the existing 502 combo failure; another
target remains subject to eligibility, consent and budgets. After commitment the typed failed
terminal remains with that child. Lifecycle snapshots with output and failed/incomplete snapshots
with output commit conservatively; only a checked missing-call terminal with harmless text/reasoning
may be discarded. Cancellation wakes a pending read; every exit clears the hold timer and checks cancellation before parent success.
Auto/none, unknown contracts, direct native routes, Chat and runTurn keep their terminal owners.
Coverage: `tests/server/server-combo-stream-required-tool.test.ts`,
`tests/server/server-combo-stream-hosted-tool-contract.test.ts` (hosted substitutions, eager/tee),
`tests/server/server-combo-stream-send-contract.test.ts` (queued rebuilds and filtered required tools), and
`tests/routing/combo-required-tool-stream-preflight.test.ts`.

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

- a non-control Responses event (apart from the held mandatory-tool reasoning prelude above) begins client-visible output or a tool/action item, after which the
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
