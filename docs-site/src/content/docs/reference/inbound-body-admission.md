---
title: Inbound Body Admission
description: How raised request-body limits affect concurrent HTTP requests, retries, and memory accounting.
---

The [provider configuration reference](/reference/configuration/providers/) describes
`maxInboundBodyBytes`, the maximum decoded size of one inbound JSON body. Its default remains
256 MiB, and configured values remain bounded to 1 MiB through 512 MiB. Restart the proxy after
changing the limit so the listener and readers use the intended limit together.

Preserving the previous 512 MiB shared-budget default does not remove the queueing and
response-lifetime tradeoffs described below.

## Choose the shared budget explicitly

`maxConcurrentInboundBodyBytes` is an optional **top-level** `config.json` setting in bytes.
It defaults to **512 MiB (`536870912`)**, preserving the previous shared budget.
Omission, `0`, or an invalid value uses that default. A valid positive integer is clamped
to **512 MiB–2 GiB (`536870912`–`2147483648`)** when consumed. Restart the proxy after
changing this setting. All listeners in one process share one budget; this setting is
separate from `appOwnedMemoryBudgetMb`.

To choose a 512 MiB per-request limit and explicitly opt into a 2 GiB shared budget, merge
these fields into the top level of your `config.json`, then restart:

```json
{
  "maxInboundBodyBytes": 536870912,
  "maxConcurrentInboundBodyBytes": 2147483648
}
```

This is an operator choice that increases the potential memory peak. The proxy does not
automatically detect available RAM or choose a budget based on it.

## Raising the limit changes concurrency

When the resolved limit is greater than 256 MiB, each covered HTTP request must reserve its full
resolved per-request allowance **before any body is read**. These reservations share the
process-wide `maxConcurrentInboundBodyBytes` budget, whose default remains **512 MiB**.

Before bounded JSON parsing completes, a small `Content-Length` or a small compressed wire body
does not reduce the reservation. Admission does not trust either as evidence of the decoded or
normalized JSON size.

After a successful bounded JSON parse, the reader reduces the reservation to the largest of
the observed wire bytes, decoded bytes, and the existing normalized-JSON measurement when a
translator supplies a budget for that measurement. The reservation only shrinks, accounting for
measured bytes up to the original allowance; a larger normalized measurement never increases it.
Input byte length does not replace the potentially larger normalized JSON size; the existing
UTF-8 and reserialized-JSON checks remain.

With the default **512 MiB shared budget** and a **512 MiB per-request limit**, only **one
unparsed upload** can reserve its full allowance. Even if parsing reduces its reservation to
**one byte**, the remaining capacity is less than 512 MiB, so the next full allowance must
wait until enough capacity is released. The default therefore does **not** solve the original
concurrency problem at a 512 MiB per-request limit.

Explicitly setting `maxConcurrentInboundBodyBytes` to `2147483648` chooses **2 GiB** and permits
up to **four full 512 MiB uploads** before parsing and measured reductions. That 2 GiB budget
is not a fixed four-request limit after parsing: for example, **eight tiny requests can stream
concurrently** once their reduced reservations leave room for subsequent admissions, subject
to the shared budget and other limits.

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

This additional concurrency gate applies only when the resolved `maxInboundBodyBytes` is
greater than 256 MiB. Omitting that per-request setting or setting it to `0` keeps its 256 MiB
default and leaves this gate inactive. Omitting or zeroing `maxConcurrentInboundBodyBytes`
instead selects the 512 MiB shared default; it does not disable an otherwise active gate.
Existing request-count and other resource limits still apply.

## Temporary refusal versus an oversized body

If the full allowance is temporarily unavailable, the request can enter a bounded **FIFO queue of
up to 32 waiting requests**, with a **120-second wait limit**. While queued, the application
does not read request bodies.
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

The configured budget counts admission units: full allowances before parsing, then measured
reservations. It does **not preallocate 2 GiB** or the configured amount, and it is **not a
bound on process RSS or parsed-object heap**. Decoding, strings, object graphs, request copies,
and other application state use additional memory, so actual memory use can exceed the budget.

Choosing 2 GiB instead of the 512 MiB shared default permits four times the total reservation.
With a 512 MiB per-request limit, this explicit opt-in admits up to four full uploads before
parsing instead of one, increasing potential peak memory use. Choose the budget based on
your deployment's memory headroom. A per-request limit at or below 256 MiB leaves this
additional gate inactive, regardless of the shared-budget setting.

Keep the default per-request limit where possible. Raise it deliberately when a large-history
workflow needs it, accounting for the larger potential memory peak and bounded waiting.
