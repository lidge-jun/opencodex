# Byte Accounting

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them.

## Anthropic stable image admission

`src/adapters/anthropic-image-normalize.ts` encodes each Anthropic image independently,
starting at the fixed 2000px/2MiB profile. Only that image's size selects lower codec steps.
The shared codec retains full-decode validation, bomb limits, four-worker concurrency and a
byte-bounded LRU. Cache eviction does not select a different encoding. Byte stability is scoped
to unchanged source bytes, media type, codec and policy versions, not mutable remote URL content.
Kiro and OpenAI Chat retain their existing adaptive image-count and aggregate-budget policies.

`src/adapters/anthropic-image-guard.ts` textifies only individually unsafe images. Request-level
limits reject rather than rewrite history: more than 100 images, more than 20MiB image base64,
or unverifiable/oversized dimensions in a request with more than 20 images. The completed
serialized Anthropic body has a separate 32,000,000-byte UTF-8 cap, including tools and text.

`src/adapters/anthropic.ts` and native `src/server/claude-messages.ts` apply the same admission;
native Messages and count_tokens normalize identically. Local refusals retain specific
anthropic_image_* or anthropic_request_body_too_large codes and HTTP 413 before dispatch;
already-streaming continuations report a terminal error. Combo routing stops without penalizing
or trying another account. Upstream 413 never causes an image-degrading retry. Existing upstream
context-overflow response mapping remains separate. The host must compact/reduce input or start
a new session; the proxy does not compact, delete history, or promise upstream cache hits.

Regression coverage: `tests/adapters/anthropic/anthropic-image-normalize.test.ts`,
`tests/adapters/anthropic/anthropic-image-guard.test.ts`,
`tests/adapters/anthropic/anthropic-image-retry.test.ts`,
`tests/adapters/anthropic/anthropic-image-retry-e2e.test.ts`, and
`tests/claude-integration/claude-native-passthrough.test.ts`.

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
