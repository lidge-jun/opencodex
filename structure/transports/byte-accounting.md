# Byte Accounting

Responses body-reader limits and lifetime handling follow the
[core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them. Response-attached WebSocket telemetry follows the [stage record identity contract](responses.md#passthrough-sse-stream-shapes-314). Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

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

Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

## Terminal-continuation retention

`src/server/responses/terminal-guard.ts` retains at most 1,024 text/thinking/signature/redacted
content events and 65,536 aggregate JavaScript string code units per guarded turn. These are
semantic-retention limits, not UTF-8 byte accounting or a process-wide memory cap. Heartbeats,
tool-argument fragments, and events unused by continuation analysis/rebuilding pass through
without being retained or spending that allowance.

A real tool start, a limit overflow, or text exceeding 280 characters after trimming disables
analysis for the rest of the turn and clears the retained history. Overflow never produces a
continuation from truncated reasoning. Consumer events, terminal reasons, and usage still pass
through unchanged except for existing cross-continuation usage aggregation. Each permitted
continuation has fresh counters; unsupported adapters and exhausted continuation allowances
retain no content. Anthropic behavior and the caller's OpenAI Chat opt-in gate remain scoped as
before. `tests/server/terminal-guard.test.ts` covers inclusive limits, split whitespace, passthrough,
reasoning replay, analysis shutdown, usage aggregation, and unsuccessful or absent terminals.

If creating a continuation throws or rejects, its error event carries usage already reported by
completed legs. Unknown usage stays absent rather than becoming a measured zero. This does not
invent usage for an unreported failed send, retry a failed factory, or turn failure into success.
Source-iteration exceptions still propagate to the caller. Returning the guard iterator closes
its active source; cancellation at an assistant boundary does not start the continuation callback.
The same focused tests cover these lifecycle paths and Unicode code-unit limit boundaries.
