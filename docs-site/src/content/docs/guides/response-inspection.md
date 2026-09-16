---
title: Response inspection and large responses
description: How bounded diagnostic retention and streaming inspection interact with response delivery.
---

OpenCodex keeps response diagnostics bounded without making the logging limit a
limit on the bytes delivered to your client. Other provider, request and transport
limits still apply independently.

## JSON and ordinary error responses

JSON inspection retains at most 32 MiB of source bytes. If the body exceeds that
allowance, logging drops its retained copy and continues forwarding the original
response. It does not parse a truncated prefix as authoritative usage or model
metadata. Usage already supplied by another trusted path is preserved; missing
usage is not replaced with an invented zero. Ordinary non-JSON error diagnostics
retain only the first 8 KiB and pass through the existing redaction logic.

The client receives chunks as it reads them rather than waiting for diagnostic
inspection of the whole body. A read failure is recorded as 502 and cancellation
as 499 in request history; these diagnostic outcomes do not rewrite HTTP headers
that have already been sent. Logging is finalized once.

## Streaming responses

Native SSE inspection pauses when it runs too far ahead of client consumption.
The allowance is 32 MiB plus source-chunk/native-prefetch overhead, not a total
response-size limit or a cap on all process memory. A longer response is still
inspected through its actual completion event, including terminal usage and
continuation state.

After the client disconnects, the existing bounded drain can still observe a late
completion for up to 15 seconds or 32 MiB of additional inspection. A forced
shutdown is different: it discards uncompleted candidates rather than recording
them as a completed response. Existing transport selection and WebSocket memory
bounds are unchanged. No new configuration setting is required.
