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

## Triage: `exceeded retry limit, last status: 429 Too Many Requests`

The message is the client's retry budget summary, not a diagnosis. One refusal
that the client does not retransmit can end a turn in the same words as a
fully exhausted budget, so treat the text as a question. Three cases look
identical at this layer and are checked differently.

| Check | Distinguishing evidence | If the check is positive |
| --- | --- | --- |
| Main-account hard lock (local admission policy) | The dashboard Settings or `GET /api/settings` reports the policy state, such as `mainAccountHardLock.state` being `blocked`, `ready`, or `off`, with `thresholds` and an optional `resetAt`. A non-streaming request may also carry an explicit main-policy body instead of a bare upstream 429. | Refresh usage with `ocx account refresh openai`; fresh usage below every blocking threshold or validated window absence releases the lock. If it remains blocked, wait for fresh lower usage or explicitly turn `codexMainAccountHardLock` off in Settings. Builds before [#6287](https://github.com/lidge-jun/opencodex/pull/6287) could keep an obsolete short-window block across restarts when no fresh observation ever replaced it; the release semantics are described in the [closing note on #6244](https://github.com/lidge-jun/opencodex/issues/6244). |
| Upstream ChatGPT plan window | The account quota section shows a 5-hour or weekly window at or near its limit while the lock reports `ready` or `off`. | Wait for the window to reset, inspect any reset option ChatGPT offers ([banked reset rules](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work), [plan windows](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)), or serve the request on another account with `ocx account use openai <id>`. For explicitly authorized paid-credit use after the limit, see [account credit policy](/reference/cli/providers-accounts/#pool-policy-account-thresholds-and-paid-credit-intent). The credit-balance rediscovery defect in [#6845](https://github.com/lidge-jun/opencodex/issues/6845) was fixed by [#6886](https://github.com/lidge-jun/opencodex/pull/6886). |
| Provider incident or transport failure | Quota stays low, the lock stays released, and `ocx doctor` reports transport or ChatGPT reachability problems. | Retry after the incident clears or reroute through an existing combo. Changing lock or threshold policy is not a cure for a transport failure. |

A proxy-generated `upstream_reset_replay_refused` response also uses status 429:
upstream execution is unknown, so OCX refuses an automatic resend. Its log cause
is `transport-ambiguous`, not provider rate limiting. On a direct provider route this applies to client HTTP
and WebSocket ingress independently of `upstreamWebsocket`; a failure that a combo
rebuilds from a child does not yet keep this attribution. Older builds can
misrecord a client WebSocket refusal as `rate-limit` / `rate_limit_exceeded`;
that combination alone does not establish exhausted quota. `headers-only` is a
response-progress stage, not proof that the provider returned headers. Correct
attribution does not diagnose or repair the original connection reset.

A locked main credential closes request admission; it does not reserve the
account's remaining quota, and a predicted reset never releases the block on
its own. The thresholds (by default `short` 90, `long` 98) are visible in the
status payload and configurable through `codexMainAccountHardLockThresholds`.

A hard-lock refusal is reported as `usage_limit_reached`, so Codex ends the turn
and marks an active Goal as usage-limited instead of waiting for days in a
retry. The suggested retry time is the main account's reset or, for a request
that the account pool routed to the main account, the earliest known time another
pool account recovers, whichever comes first (never sooner than one minute).
Resume the Goal after that time; routing then picks an account from fresh state.

## Stored-account credit metadata retries

An explicitly selected stored account can reach its included usage limit while its last
credit balance observation is older than five minutes. If credit spending is enabled for
that account and the evidence is stale, missing or incomplete, its local 429 advises retrying
after the 300-second base metadata cadence (or at the included reset if sooner). A later known upstream
cooldown for the selected quota scope, including account-wide holds, still takes precedence; when
both apply, the later deadline wins. Unrelated
model-group holds are not imported. The original included-window reset remains attached to the
internal refusal as `resetAt`; the shorter hint is a metadata recheck opportunity, not a new quota reset.

The request remains refused until fresh spendable credit evidence is available. This hint
does not perform a refresh, bypass metadata-query pacing, guarantee recovery, change account
selection, or enable credit spending. Direct account bindings retain their identity. Explicit
credit opt-out, an older cached null without provenance, a known spending veto or a finite empty
balance without unlimited entitlement retain the included-reset advice. A newly observed missing
or malformed credit summary retracts spending authority but permits the short metadata retry;
an explicit spending veto still wins. Unlimited credits with a zero balance require fresh evidence
just like other credits. Ordinary upstream 429 delays keep the existing parser ceiling of 24 hours
for numeric and HTTP-date Retry-After values.

## Triage: `idle timeout waiting for SSE`

Codex ends a stream that has sent no event for its `stream_idle_timeout_ms`
(300 seconds by default) and retries the turn. The report alone does not say
why the stream went quiet. On the native ChatGPT upstream WebSocket, one
possible cause is a path that failed silently after the response started: a VPN
or tunnel restart, a Wi-Fi rejoin or an expired NAT mapping can drop it without
a FIN or RST reaching the proxy.

On the canonical ChatGPT Codex endpoint
(`https://chatgpt.com/backend-api/codex/responses`, the exchange with the
metadata channel), the proxy pings the upstream for the whole exchange. Once the
response has started, a peer that has answered at least one ping on that
exchange and then delivers no frame and no pong for two ping intervals ends the
stream with a retryable failure. Codex then reconnects 30 to 45 seconds after
the last frame or pong instead of after 300 seconds, and the reconnect row names
the cause:

```text
Reconnecting... 1/5 (stream disconnected before completion: Upstream stream terminated unexpectedly: codex websocket stopped answering after the response started [cause=after-response-started ...])
```

When a ping reaches a path that a restarted tunnel resets, the same row reports
`codex websocket closed before a Responses terminal event (close 1006)`
instead, within about one ping interval. An `idle timeout waiting for SSE` that
still arrives after the full timeout comes from a peer that kept answering pings
while sending no events, a peer that never answered a ping, or an exchange
without the metadata channel, such as the OpenAI API Responses WebSocket, which
sends no pings. All three keep the client's idle deadline on purpose.
`ocx logs get <request-id> --json` shows the attempt's `codexWsStage` with its
`pings` and `pongs` counts, which tell the three apart. Raising
`stream_idle_timeout_ms` only makes them wait longer.

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
