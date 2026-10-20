---
title: Inbound Body Admission
description: How raised request-body limits affect concurrent HTTP requests, retries, and memory accounting.
---

The [provider configuration reference](/reference/configuration/providers/) describes
`maxInboundBodyBytes`, the maximum decoded size of one inbound JSON body. Its default remains
256 MiB, and configured values remain bounded to 1 MiB through 512 MiB. Restart the proxy after
changing the limit so the listener and readers use the intended limit together.

## Raising the limit changes concurrency

When the resolved limit is greater than 256 MiB, each covered HTTP request must reserve its full
resolved per-request allowance **before any body is read**. These reservations share a
process-wide **2 GiB** admission budget, increased from 512 MiB, including across listeners in
the same process. This budget is separate from `appOwnedMemoryBudgetMb`.

Before bounded JSON parsing completes, a small `Content-Length` or a small compressed wire body
does not reduce the reservation. Admission does not trust either as evidence of the decoded or
normalized JSON size.

After a successful bounded JSON parse, the reader reduces the reservation to the largest of
the observed wire bytes, decoded bytes, and the existing normalized-JSON measurement when a
translator supplies a budget for that measurement. The reservation only shrinks, accounting for
measured bytes up to the original allowance; a larger normalized measurement never increases it.
Input byte length does not replace the potentially larger normalized JSON size; the existing
UTF-8 and reserialized-JSON checks remain.

With a 512 MiB per-request limit, the shared budget can admit up to **four full 512 MiB uploads**
before their reservations are measured and reduced. This is not a fixed four-request limit
after parsing: for example, **eight tiny requests can stream concurrently** once their reduced
reservations leave room for subsequent admissions, subject to the shared budget and other limits.

The reduced reservation stays held across asynchronous work and provider waits, through response
stream EOF, error, or settled cancellation. Parsing alone does not release it. On a client
disconnect, it remains held until producer cancellation settles. Release happens exactly once,
including when errors, aborts, and cancellation race.

The covered POST endpoints are `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits`, and `/v1/alpha/search`.
Images, search, and token counting keep their existing configurable per-body limits.
Internal direct translation and combo calls do not reserve a second HTTP allowance.
Management, audio, context-history, and WebSocket limits are unchanged.

An omitted/zero setting, or a resolved limit at or below 256 MiB, does not enable this additional
concurrency gate. Existing request-count and other resource limits still apply.

## Temporary refusal versus an oversized body

If the full allowance is temporarily unavailable, the request can enter a bounded **FIFO queue of
up to 32 waiting requests**, with a **120-second wait limit**. Waiting bodies remain unread.
Capacity freed by a measured reduction or final release admits waiting requests in FIFO order.
An aborted waiter is removed and its unread body is cancelled without consuming it.

A full queue or an expired wait produces HTTP **503**, `Retry-After: 1`, and error code
`server_busy`, before body parsing or provider dispatch. Unread bodies are cancelled on refusal.
Messages and token-counting clients receive an Anthropic-shaped error with type
`overloaded_error`; OpenAI-compatible clients receive `server_error`. Authentication and origin
checks run before admission and queueing.

Honor the retry header and client backoff when retrying. Bounded waiting and measured reservations
reduce avoidable capacity refusals, but do not eliminate all 503 responses. Raising the
per-request limit further does not fix sustained capacity exhaustion.

A body larger than its per-request limit still follows the existing HTTP **413** handling.
A declared oversize keeps that path instead of becoming a busy refusal.

## What the budget measures

The **2 GiB** budget counts admission units: full allowances before parsing, then measured
reservations. It is **not a bound on process RSS or parsed-object heap**, and does not guarantee
memory usage below 2 GiB. Decoding, strings, object graphs, request copies, and other application
state use additional memory.

Increasing the shared budget from 512 MiB to 2 GiB permits four times the total reservation.
Deployments that opt into limits above 256 MiB can now admit four full 512 MiB uploads instead
of one, so their potential peak memory use increases; parsed objects and copies can push actual
memory beyond the admission budget. Default and smaller limits do not activate this gate and
keep their existing behavior.

Keep the default per-request limit where possible. Raise it deliberately when a large-history
workflow needs it, accounting for the larger potential memory peak and bounded waiting.
