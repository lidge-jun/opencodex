# R4 — what the remainders reach, and what they do not

The lane brief put #4191 and #5180 in R4 "as far as the rework reaches". This records where that
line actually fell, with the evidence, so the next lane starts from a finding rather than a
re-investigation.

## #4191 — reached: nothing. Found: a wrong stage in the shared vocabulary

The resend gate does not consult the WebSocket projection. The post-header path excludes a
`isCodexWsUpstreamResponse` body on purpose: the WS transport settles its own ambiguous
failures and marks them non-replayable, and a second reader of one exchange is a defect, not a
recovery. So the durable threading the round-2 plan names is untouched here.

The investigation did surface a real defect in the projection itself.
`classifyCodexWsFailure` in `src/server/responses/codex-ws-wire.ts` returns
`after-response-started` — which `CODEX_WS_FAILURE_PROJECTION` maps to `semantic-output` —
as soon as `relayedEvents > 0`. But `src/server/responses/codex-ws-exchange.ts` increments
`relayedEvents` for every non-metadata Responses event, and `response.created` is one:
`controlFrame` is set only when the metadata channel consumes the frame, not for lifecycle
events. `src/lib/request-failure-model.ts` puts `response.created` in `protocol-prelude`
and requires an output-bearing event for `semantic-output`. A WS failure carrying only a
created event therefore projects as committed output today.

It is left here rather than fixed because the fix needs a counter the classifier does not have,
and `CodexWsStageRecord` is derived from `CodexWsFailureStage` by `Omit`, so adding one
lands in a persisted record whose read-back whitelist in `src/usage/log.ts` would reject every
row written before it. Adding the counter and `Omit`-ing it from the durable twin avoids that,
but the output-bearing predicate lives in `combo-stream-preflight.ts` and restating it in the
exchange is the class of duplication this round already paid for three times. It belongs with
the lane that threads `failureStage` / `failureCause` into the record, where both halves can
be written once.

The SSE fallback the issue asks for stays out regardless. After `ws.send()` returns, a
fallback is a second physical send on another transport, which is a transport decision with its
own duplicate-inference policy — not a retry-gate change.

## #5180 — reached: nothing. The symptom is upstream of this gate

The reported failure is a key-auth `openai-chat` provider answering a bare 429. Traced on
current `dev`: `rateLimitRetryPolicyFor` returns null for every provider except the
OpenCode Go destination, so the same-target wait never runs; key rotation needs a pool of at
least two; and `fetchWithResetRetry` returns the first received HTTP response without
consulting its status. One send, 429 returned, which is exactly what the reporter saw.
`Retry-After` is forwarded to the client — synthesized as `2` for a bare retryable 429 by
`src/lib/retry-after.ts` — but the proxy never waits on it itself.

None of that is an ambiguous-resend question: a received 429 is `headers-only` with cause
`rate-limit`, which the stage table already answers `permitted` and funds from the
`transient` class. It needs no grant and no override. What it needs is a policy default and a
process-wide cooldown that a single-key provider can write, and `keyCooldowns` cannot be
reused unchanged because both its identity and its write path require a multi-key pool.

One adjacent accounting gap is worth recording for whoever takes it. On the generic adapter
path, `prepareAdapterExchange` passes `attempts` and `onSendsConsumed` to its retry helper
only when `transientRetryOn5xx` is configured. An unconfigured provider's initial send is
therefore recorded in the attempt log but never charged to the request-wide send counter. It is
bounded today — without `replaySafe` the reset helper makes exactly one send — so it is an
under-count rather than an amplification, and widening it without a suite to run is not a change
worth making blind.
