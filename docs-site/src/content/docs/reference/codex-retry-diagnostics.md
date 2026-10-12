---
title: Codex retry diagnostics
description: Distinguish rate-limit advice, automatic retransmission, provider recovery, and Desktop notifications.
---

OpenCodex's [Devin adapter](/reference/adapters/#devin) preserves a usable retry
hint in the error contract Codex understands. That is not a guarantee that
Desktop displays a reconnect row, or that the provider accepts the next request.

## Who waits

With `OPENCODEX_DEVIN_STATED_RESET_WAIT_MS` unset or `0`, the Devin adapter does
not hold a refused request for the stated cooldown. Codex receives the final
failure and owns its bounded retry policy. A positive value opts into the
existing proxy-owned wait; it delays delivery of the final failure and can
compound with client retries. This compatibility mapping changes neither that
setting nor Codex's retry count. A process-only override need not survive restart.

`rate_limit_exceeded` plus `Please try again in Ns.` is retry advice, not a
countdown event. Codex's own retry policy, cancellation and lifecycle still
apply. Do not add synthetic reasoning, tool, assistant or success items to make
waiting visible: those items can contaminate history or imply work happened.
Do not shorten the provider delay or provoke an extra request to advance the
client's retry counter.

## Why the first reconnect row can be absent

The public Codex `rust-v0.158.0-alpha.2.1` source gates the ordinary stream-retry
notification in
[`handle_response_stream_error`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/core/src/responses_retry.rs):

```rust
let report_error = retry_count > 1
    || cfg!(debug_assertions)
    || !sess.services.model_client.responses_websocket_enabled();
```

In a release build, the first retry in this loop can therefore wait without
emitting `Reconnecting...` when the internal WebSocket-enabled predicate is
true. The selected delay is not part of that notification predicate, and the
sleep is outside the `if report_error` block. A long server-advised wait can be
silent too. This is a version-specific source observation, not proof that any
particular Desktop request took that branch. Do not infer the internal predicate
from a model name, an HTTP status, or the transport seen on one proxy hop.

An enabled notification subscription and a renderer capable of drawing the row
only establish that the receiving path exists. They do not prove that the engine
emitted an event for the affected turn. Likewise, collapsed provider details can
explain missing detail text, but not a missing reconnect row by themselves.

The corresponding app-server
[`ErrorNotification`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/app-server-protocol/schema/typescript/v2/ErrorNotification.ts)
contains `willRetry`, `threadId` and `turnId`. Observe emission, delivery to the
matching turn, and rendering separately. A proxy `response.failed` frame is not
itself that app-server notification. Changing this engine-side first-notification
policy requires a Codex change; an OpenCodex error-message rewrite cannot force
an event through a branch that does not emit it.

## Read-only verification

Keep the existing app, proxy, settings and test turn unchanged while collecting
evidence. Restarting, sending a new turn, or switching transports changes the
experiment. In an isolated follow-up, compare the same controlled failure under
both internal WebSocket states and inspect the first and subsequent retries;
do not call that an actual Desktop-rendering test unless the UI is observed.

For the affected conversation and active turn, distinguish these outcomes:

| Question | Evidence required |
| --- | --- |
| Was usable advice delivered? | The final failure's code, normalized delay and response-end time. |
| Did automatic retransmission occur? | A correlated next request after that failure, without a manual send. Measure from the failure response end to the next request start, not from the first request start. |
| Did the provider recover? | A successful response and continuation of the affected work, not merely another request or an unrelated successful turn. |
| Was a retry notification emitted and delivered? | The matching app-server error event and its retry flag, not subscription configuration alone. |
| Was the notice visible? | Observation of the affected Desktop turn; protocol or source-code checks alone are insufficient. |

Approximate provider advice and scheduling overhead can produce a small timing
difference. If retransmission reaches a socket-close error and a later attempt
receives a new rate limit, record retransmission as working but provider recovery
as incomplete. The new refusal's delay is a new observation, not a timer inherited
from the previous refusal. An `inProgress` turn by itself proves neither recovery
nor correct rendering. Retry exhaustion, cancellation and app-restart recovery
must be assessed separately.

Publish only the validation scope and aggregate durations/outcomes. Keep raw logs,
request bodies, credentials, account data, private paths, and thread/conversation/
request/trace identifiers out of public PRs and diagnostic reports.

## Regression-test scope

`tests/server/retry-delay-hardening.test.ts` checks that 120-, 900-, 1,800-,
2,460- and 3,600-second advice survives formatting unchanged; a longer hint stays
first when a shorter one also exists; and an intervening untimed disconnect does
not make a later refusal inherit an old delay. These are pure parser/formatter
checks. They do not wait for an hour, exercise Codex's notification predicate,
verify an app restart, or prove recovery from a live provider failure.
