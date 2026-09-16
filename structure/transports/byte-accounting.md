# Byte Accounting

Responses body-reader limits and lifetime handling follow the
[core module ownership](responses.md#core-module-ownership). Raised HTTP concurrency follows the separate admission contract below.

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them. Response-attached WebSocket telemetry follows the [stage record identity contract](responses.md#passthrough-sse-stream-shapes-314). Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

## Request-copy accounting

`src/server/request-decompress.ts` observes the UTF-8 sizes of decoded text and reserialized JSON
without allocating encoded byte arrays solely to count them. Parsed-body accounting still uses
`JSON.stringify(parsed)`: numeric normalization can make it larger than the input text. These
observations retain the existing ownership and release lifecycle and do not consume the translator's
hard byte cap. Per-body limits, parsing, compression, and reader error envelopes are unchanged.
`tests/usage/request-decompress.test.ts` covers exact accounting across codecs and Unicode/numeric
normalization, UTF-8 counting without encoded copies, and release after malformed or optional empty input.

## Raised HTTP body admission

`src/server/inbound-body-admission.ts` reserves the full resolved `maxInboundBodyBytes` allowance
from a process-wide 512 MiB admission budget when the allowance exceeds the 256 MiB default.
`src/server/index.ts` owns this lease in `runAdmittedHttpTurn`, after authentication and origin
checks, before any request body is read. Default and smaller allowances do not consume this budget.
Missing or small Content-Length and compressed wire bodies do not reduce the reservation.
An already-aborted request or explicitly oversized declaration keeps the existing abort/413 path.

The lease covers upload, parsing, downstream awaits and response consumption. It is released on
response EOF/error or after producer cancellation settles, not when parsing or response headers
complete. A pending read resolving as EOF during cancellation does not release it early. The
outermost response wrapper preserves bytes and metadata and adds no eager pull. Internal direct
combo/translation calls share their HTTP owner's reservation rather than reserving again.

The exact POST routes are Responses, compact, Chat Completions, Messages, count_tokens, image
generations/edits and alpha search. Image/search/count_tokens retain their configured per-body
limits. Management, audio, context relay and WebSocket frames retain their independent contracts.
Capacity refusal happens before protocol handlers, with HTTP 503, `Retry-After: 1`, and code
`server_busy`; Messages/count_tokens use the Anthropic `error`/`overloaded_error` envelope.
The HTTP owner preserves receiving-listener CORS and records the refusal without reading the body.

This is an allowance budget, not a measured RSS or parsed-heap cap. All covered requests, even small
ones, serialize when configured above 256 MiB. It does not bound retained state beyond the HTTP
lifetime or change default-cap concurrency. `tests/server/server-request-body-size.test.ts` covers
lifecycle, cancellation races, protocol envelopes, and the real HTTP admission boundary.

## Stream-buffer accounting

`src/server/sse-payload-rewrite.ts` shares an incremental block buffer with native Chat. It scans
only new input, counts consumed blocks rather than remaining suffixes, and preserves LF/CRLF,
partial-event, injection/drop, and EOF behavior. Output admission precedes its single UTF-8 encoding;
failed enqueue and cancellation release the reservation without re-entering a disposed rewrite.
Old/new buffer overlap remains charged against the same translator cap.

`src/adapters/openai-responses.ts` counts new compaction fragments, including surrogate pairs formed
across deltas, while retaining snapshot/done/delta precedence and existing terminal ownership.
Serialized request and buffered-response observations use byte counts without measurement arrays.
The same rule applies to Anthropic, Google, and Chat response accounting; serialization itself is
preserved where the existing metric is the serialized JSON size.

`src/lib/translator-budget.ts` admits an event batch atomically from per-event serialized byte sizes
plus exact separators, without joining a second full JSON array. `src/lib/admission.ts` counts and
truncates diagnostic text at UTF-8 code-point boundaries without allocating arrays per character;
byte sizing retains TextEncoder's coercion behavior for legacy non-string runtime callers.
These optimizations do not add request queues, retry policies, or RSS-based admission gates.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.
