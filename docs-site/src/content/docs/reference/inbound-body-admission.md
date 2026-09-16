---
title: Inbound Body Admission
description: How raised request-body limits affect concurrent HTTP requests, retries, and memory accounting.
---

The [provider configuration reference](/reference/configuration/providers/) describes
`maxInboundBodyBytes`, the maximum decoded size of one inbound JSON body. Its default remains
256 MiB, and configured values remain bounded to 1 MiB through 512 MiB. Restart the proxy after
changing the limit so the listener and readers use the intended limit together.

## Raising the limit changes concurrency

When the resolved limit is greater than 256 MiB, each covered HTTP request reserves its entire
configured allowance from a shared, process-wide 512 MiB admission budget. This means at most one
such request runs at a time, including when multiple listeners share a process. Small bodies also
reserve the full allowance; neither a small Content-Length nor compression bypasses admission.
The reservation remains until the response stream ends, fails, or finishes cancellation, rather
than ending as soon as the request JSON has been parsed.

The covered POST endpoints are `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits`, and `/v1/alpha/search`.
Images, search, and token counting keep their existing configurable per-body limits.
Internal direct translation and combo calls do not reserve a second HTTP allowance.
Management, audio, context-history, and WebSocket limits are unchanged.

An omitted/zero setting, or a resolved limit at or below 256 MiB, does not enable this additional
concurrency gate. Existing request-count and other resource limits still apply.

## Temporary refusal versus an oversized body

A temporarily unavailable allowance produces HTTP **503**, `Retry-After: 1`, and error code
`server_busy`, before protocol parsing or provider dispatch. Messages and token-counting clients
receive an Anthropic-shaped error with type `overloaded_error`; OpenAI-compatible clients receive
`server_error`. Retry after the current request completes, honoring the retry header and client
backoff. Increasing the body limit further does not resolve a busy allowance.

A body larger than its per-request limit still follows the existing HTTP **413** handling.
A declared oversize keeps that path instead of becoming a busy refusal. A disconnect retains the
existing cancellation behavior. Authentication and origin checks run before this concurrency gate.

## What the budget measures

512 MiB is a sum of admitted per-request allowances, **not a guarantee that process memory stays
below 512 MiB**. Decoding, strings, object graphs, request copies, and other application state use
additional memory. The existing UTF-8 and reserialized-JSON measurements are preserved; input
byte length is not substituted for the potentially larger normalized JSON size.

For parallel small requests, keep the default limit where possible. Raise it deliberately for a
large-history workflow, accepting the additional concurrency restriction.
