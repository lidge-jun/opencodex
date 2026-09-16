# Byte Accounting

Responses body-reader limits and lifetime handling follow the
[core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them. Response-attached WebSocket telemetry follows the [stage record identity contract](responses.md#passthrough-sse-stream-shapes-314).

## Request-copy accounting

`src/server/request-decompress.ts` observes the UTF-8 sizes of decoded text and reserialized JSON
without allocating encoded byte arrays solely to count them. Parsed-body accounting still uses
`JSON.stringify(parsed)`: numeric normalization can make it larger than the input text. These
observations retain the existing ownership and release lifecycle and do not consume the translator's
hard byte cap. Admission limits, parsing, compression, and error envelopes are unchanged.
`tests/usage/request-decompress.test.ts` covers exact accounting across codecs and Unicode/numeric
normalization, UTF-8 counting without encoded copies, and release after malformed or optional empty input.

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

## Non-stream response-log inspection

`src/server/relay.ts` delegates JSON and non-JSON error-body delivery to
`src/server/response-log-body.ts`. A single pull-driven stream forwards the original bytes;
logging neither waits for the whole body before delivery nor eagerly drains a second tee branch.
The inspection copy retains at most 32 MiB for JSON, or an 8 KiB byte prefix for other errors.
One geometrically grown allocation also bounds retained chunk metadata. These are per-response
inspection-copy limits, not a process-memory ceiling or an output-size limit; decoding and parsing
can allocate additional bounded objects.

JSON is inspected only after clean EOF when the entire body fits. Crossing its budget discards
its inspection copy and skips parsing without truncating delivery, changing the HTTP status,
or inventing usage. Error and cancellation paths never parse a partial JSON document. Other
error bodies retain their bounded diagnostic prefix. The existing request-log parser and final
log writer remain responsible for redaction, usage provenance, and attempt accounting.

EOF logs the original status, a failed body read logs 502, and downstream cancellation logs 499
with `client_cancel`, exactly once. The same cancellation reason reaches the source reader;
reader cancellation is not awaited because a tee sibling can remain open. This limit does not
apply to SSE turn length: existing frame/output-item budgets and post-disconnect drain ownership
remain unchanged. `tests/server/consume-for-inspection-cancel.test.ts` registers the shared
body-lifecycle cases and covers the integration and a late SSE terminal beyond the JSON budget.
