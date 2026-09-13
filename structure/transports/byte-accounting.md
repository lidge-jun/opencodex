# Byte Accounting

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them.

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

A saved-account ZCode refresh in `src/adapters/zcode/adapter.ts` reserves the account, waits for an active turn and its direct bootstrap to release the official profile, and completes before native dispatch or output admission. The cache is checked again after the stable profile queue is acquired, so a refresh that becomes due during a long wait reloads settings and model identity before any client is created. Caller cancellation stops only that request's wait on the shared official refresh, emits no native stream bytes, and does not transfer cancellation ownership to sibling requests; authenticated orphan-draft reconciliation is likewise metadata-only, and default-workspace aliases are canonicalized before account-scope validation. Advanced settings are read through the same bounded four-MiB file reader used for model materialization, and the resulting content generation joins the session scope so in-place profile changes cannot retain a prior continuation. Process serialization uses a separate stable physical-profile key, so a credential-generation change cannot open a concurrent queue against the same profile.
The same adapter constructs a maximum-length session-id envelope and measures the actual JSON
serialization of each prospective `session/send` frame before it creates the native client. Frames
over the managed bootstrap's one-MiB NDJSON line limit fail as pre-dispatch input errors; escaped
control characters therefore cannot expand a nominally bounded prompt into an accepted turn that
later dies in the bridge.

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
