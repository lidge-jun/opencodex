# Byte Accounting

Native result continuations and function-result injection follow [the mode-specific result and control contract](streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Translated Chat inline-image normalization keeps retained wire bytes in its aggregate budget while process-wide native-decode admission and a decoded-pixel ceiling bound memory outside that byte accounting.

Responses body-reader limits and lifetime handling follow the
[core module ownership](responses.md#core-module-ownership). Raised HTTP concurrency follows the separate admission contract below.

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them. Response-attached WebSocket telemetry follows the [stage record identity contract](responses-wire-shapes.md#passthrough-sse-stream-shapes-314). Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

## Request-copy accounting

The Google tool-schema loss report retains fixed categories, bounded counts, and endpoint class
only. It copies no request content and adds no bytes to the upstream wire; see the
[Google provider contract](../providers/google.md#google-tool-schema-loss-reporting).

`src/server/request-decompress.ts` observes the UTF-8 sizes of decoded text and reserialized JSON
without allocating encoded byte arrays solely to count them. Parsed-body accounting still uses
`JSON.stringify(parsed)`: numeric normalization can make it larger than the input text. These
observations retain the existing ownership and release lifecycle and do not consume the translator's
hard byte cap. Per-body limits, parsing, compression, and reader error envelopes are unchanged.
`tests/usage/request-decompress.test.ts` covers exact accounting across codecs and Unicode/numeric
normalization, UTF-8 counting without encoded copies, and release after malformed or optional empty input.

The final native ChatGPT Responses HTTP send in `src/server/responses/fetch-helpers.ts` encodes JSON
strings of at least 1 MiB as a UTF-8 buffer for Bun upload compatibility. This is a transport copy,
not a counting allocation or retained continuation. Existing body admission limits still apply;
the serialization observation keeps its existing lifetime, and nested dispatch reuses the buffer.

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

HTTP owners in `src/server/responses/core.ts`, `src/server/chat-completions.ts` and `src/server/claude-messages.ts` pass the request abort signal to `src/lib/translator-budget.ts`. An aborted request releases its owned translator budget even when its response body is never consumed. Abort finalization changes accounting only; the transport keeps ownership of producer cancellation and response terminal precedence. Explicit body cancellation also releases the budget before awaiting upstream reader cancellation. EOF and read errors share the same idempotent finalizer, which removes its abort listener. Responses lifetime wrapping in `src/server/responses/core-lifetime.ts` preserves native, eager-relay and preinspected-response markers. `tests/adapters/translator-budget-lifetime.test.ts` holds cancellation pending and covers abort before wrapping, abort after wrapping, explicit cancellation and successful EOF.

Disposed budgets ignore late call, reservation, charge and observation work; reservations created before disposal cannot resurrect per-turn or aggregate counters. The same Bun contract checks both accounting scopes before any producer cancellation and while an explicit cancellation is pending. Every producer must honor its transport abort link; disposed accounting does not provide a byte cap to work that outlives its request.

Prepared success, cancellation and timeout responses retain their bytes, status and headers when wrapping starts with an aborted request; its dead request budget is disposed immediately. This observer does not replace a transport verdict with a different abort error or an artificial EOF.

Devin's [Messages ordering buffer](../clients/claude-desktop.md#devin-messages-output-ordering) charges retained
semantic events consumed from the independently bounded adapter queue to the shared translator
budget until downstream delivery. Cancellation and overflow release held events before producer shutdown.

`src/web-search/run-turn-loop.ts` charges retained iteration events and generated replay history to
the request translator budget. Each owner releases its own reservations on completion, error,
cancellation or consumer closure; a buffer-limit failure terminates without another search.

`src/server/sse-payload-rewrite.ts` shares an incremental block buffer with native Chat. It scans
only new input plus a three-character delimiter prefix and counts consumed blocks rather than
remaining suffixes. CR, LF and CRLF share partial-event, injection/drop and EOF behavior.
Output admission precedes its single UTF-8 encoding;
failed enqueue and cancellation release the reservation without re-entering a disposed rewrite.
Old/new buffer overlap remains charged against the same translator cap.

Complete SSE blocks extract `data` fields with one indexed pass over the block rather than a
regular-expression split and intermediate line array. Colonless `data` fields, one optional ASCII
space after the colon, multiline joining, UTF-8 text and mixed CR/LF/CRLF input retain their
event-stream semantics. Payload and event-field repairs use the shared line rules, including
policy failures, custom tools, Copilot and Grok events; identity rewrites preserve
original wire bytes. `src/server/relay.ts` re-exports the canonical extractor and block splitter.
Empty byte results across the relay and `src/server/sse-frame-buffer.ts` reuse one immutable
zero-length view; non-empty frame ownership,
frame limits, cancellation and wire ownership remain bounded. The byte framer and inspection share
one CR/LF/CRLF delimiter scanner; WebSocket projection uses the canonical data extractor. A terminal
CR dispatches without awaiting EOF. A later LF extends that delimiter: byte delivery returns a
framing-only continuation, excluded from event-count limits and the next event's byte cap;
inspection consumes it without creating an event. The text rewrite relay keeps that continuation
outside rewrite/drop callbacks and settles injected nonfinal CR delimiters as CRLF.

`src/server/responses-custom-tool-repair.ts` continues to own retained routed argument bytes and
their charge/release lifecycle while it asks the pure progressive decoder in
`src/responses/progressive-freeform-input.ts` which prefix is safe to publish. The decoder neither
charges nor releases translator budget; extracting it from `src/bridge/sse.ts` does not create a
second retention owner or change terminal, failure, incomplete, or disposal release behavior.

`src/adapters/openai-responses.ts` counts new compaction fragments, including surrogate pairs formed
across deltas, while retaining snapshot/done/delta precedence and existing terminal ownership.
Serialized request and buffered-response observations use byte counts without measurement arrays.
The same rule applies to Anthropic, Google, and Chat response accounting; serialization itself is
preserved where the existing metric is the serialized JSON size.

The buffered Chat collector in `src/chat/outbound.ts` computes a split surrogate pair's incremental
UTF-8 cost from the runtime's measured separate and joined sizes. It does not assume how a Bun
version prices a lone surrogate, so retained content, reasoning, and refusal fields enforce and
release the same exact budget on every supported runtime.

> Decision record: [ADR-0112](../decisions/ADR-0112-chat-collector-unicode-accounting.md)

`src/lib/translator-budget.ts` admits an event batch atomically from per-event serialized byte sizes
plus exact separators, without joining a second full JSON array. `src/lib/admission.ts` counts and
truncates diagnostic text at UTF-8 code-point boundaries without allocating arrays per character;
byte sizing retains TextEncoder's coercion behavior for legacy non-string runtime callers.
These optimizations do not add request queues, retry policies, or RSS-based admission gates.

The buffered collector in `src/adapters/zed.ts` charges each delegated event before retaining it
and releases owned events when collection fails. Its translated stream is cancelled on early exit
for every provider family. `src/adapters/openai-responses/passthrough.ts` releases partial text and
usage collectors on every exit, and compaction ciphertext unless its lease transfers with the
`done` event. The ciphertext lease is bound to the event object and its budget separately from
serialized-event retention; an uncharged ciphertext field never releases another owner's bytes.
Zed releases that source lease if collection fails. The SSE bridge releases both source leases
after each consumed or discarded event, including cancellation before its first pull, late events,
and processing failure. Buffered bridging keeps ciphertext charged through output admission and
releases all source leases on success or failure. Output retention remains independently charged.
`tests/responses/compaction-event-ownership.test.ts` covers those transitions and unrelated owners.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Hosted Responses image display uses the allocation-free JSON byte counter to admit retained
metadata and projected output before saving artifacts or serializing expanded JSON/SSE.
The [Images display contract](../data-planes/images.md#hosted-responses-image-display) owns its
item/metadata limits and lifecycle behavior; raw continuation replay stays upstream-shaped.

## Response-log inspection

`src/lib/redact.ts` scans XML identifying attributes over disjoint tag spans rather than
searching the remaining suffix from each opening delimiter. Tag terminators are quote-aware,
so `>` inside a single- or double-quoted attribute cannot hide later credential attributes.
The decoded and raw passes
retain the original-offset mapping and mask a credential-bearing element through the rest
of the input. `tests/lib/redact.test.ts` counts delimiter searches and scanned characters across doubled inputs
without a machine-speed deadline, as well as malformed and escaped credential coverage.

`src/server/response-log-body.ts` forwards raw response chunks on downstream demand.
Diagnostic retention is limited to 32 MiB for JSON and an 8 KiB prefix for other
HTTP error bodies. Fixed 64 KiB blocks also bound per-chunk bookkeeping. These
are retained-source-byte limits, not peak heap or response-delivery limits:
joining, decoding and parsing a bounded JSON body can temporarily use more memory.
An oversized JSON candidate is discarded immediately; partial JSON on read error
or cancellation never replaces model or usage metadata. Existing trusted metadata
is preserved. The existing parser and redaction path inspect complete admitted
JSON and bounded non-JSON error prefixes. EOF, read error and cancellation finalize
once; history records the original status, 502 or 499 respectively, without
rewriting the response status or bytes already sent to the client.

`src/server/inspection-tee.ts` paces the native SSE inspection branch against raw
client consumption before rewrites. Its 32 MiB read-ahead allowance is not a total
turn limit: long streams retain terminal, usage and continuation observation.
The allowance can be exceeded by one source chunk plus native tee prefetch; it is
not an RSS limit or a producer-side bound for push transports. Existing eager-path
selection, WebSocket bounds and SSE frame/output-item limits are unchanged.
Client departure releases pacing to the existing 15-second/32-MiB bounded drain.
One tee branch's cancellation is never awaited by the wrapper, because that
promise may depend on its sibling. A hard owner abort discards pending candidates
rather than flushing them as successful terminals; genuine EOF/read-error tail
handling remains distinct.

`tests/server/response-log-inspection.test.ts` covers the real inspector/relay
composition, including a turn beyond 32 MiB, late usage/output, slow readers,
cancellation and read-error races. `tests/usage/request-log-nonstream.test.ts`
binds the bounded non-stream wrapper to request-log status and metadata behavior.

Retaining whole response bodies is the separate concern of `src/lib/bounded-body.ts`, whose cap,
deadline, and cancellation rules are specified in the [bounded ingestion contract](inventory.md#bounded-response-ingestion-and-orcarouter-login).

Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

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

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

## Durable spill admission

`enforceSpilledResponseBudget` in `src/responses/state.ts` owns the durable spill ceiling
described in [Codex home](../codex-home.md). A queued publication, and the shutdown fallback, call it
with the headroom their write needs on top of what is already accounted; called with no argument it
only brings the store back under the ceiling. With headroom it evicts oldest-first, deferred
superseded generations before installed spills, down to the ceiling minus that headroom, and only
while the room is reachable: bytes eviction cannot touch — in-flight reservations, superseded
generations a job owns, and unreclaimable paths — plus the headroom must fit under the ceiling. That
is re-read after every eviction, and once the publication cannot fit nothing more is evicted; the
caller refuses it as a `spill-failed` tombstone. An impossible publication therefore never costs an
unrelated continuation, and neither does one whose envelope exceeds the replay ceiling: admission
skips reclaim for it because it would end in `EFBIG` anyway.

`deleteResponseSpill` in `src/responses/spill-store.ts` reports a failed unlink (anything but a
missing file) to the spill queue, which charges that path in its unreclaimable ledger until the path
is gone. Every later accounting read sees the file, so admission never counts space that was never
freed; a single no-argument pruning pass still works from its local total and may stop short, leaving
the remainder to the next pass. The orphan sweep settles such files once the unlink can succeed. `spillCapacityRefusals` and
`spillHeadroomEvictions` on the memory endpoint are the cumulative refusal and admission-eviction
counts. `tests/responses/responses-spill-admission-headroom.test.ts` covers headroom eviction,
exact fit, impossible and inherited publications, pinned reservations, the shutdown fallback,
deferred-first order, reload replay and failed unlinks.

## Unicode pattern normalization

`src/adapters/responses-tool-schema.ts` strips unsupported Unicode property patterns with an
iterative traversal and copies containers only when a descendant changes. Unchanged siblings
retain identity; a no-op returns the original input. Traversal frames follow the active path
instead of queueing an assignment closure and eagerly cloned container for each sibling.
Name bags, literal values and preserved constraint subtrees retain their existing semantics;
the separate encrypted-marker normalizer is unchanged. Inputs are not mutated.
This reduces avoidable allocations; it is not a hard heap cap or a guarantee of lower CPU cost.
Schema size still determines traversal work and the cost of copying a changed broad container.
`tests/adapters/openai/openai-chat-hardening.test.ts` covers wide, deep and mixed-array schemas;
`tests/responses/openai-responses-passthrough.test.ts` covers the existing wire contract.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

The [compaction routing override](responses-failover.md#compaction-routing-overrides) changes model and effort scalars on the already-read request body, before parsing, within the existing body-reader budget.

`src/lib/sse-decoder.ts` recognizes CR, LF and CRLF line endings, including CRLF split between fetch chunks. Delimiters are consumed before field retention; event/comment ordering, EOF dispatch and translator-budget release remain shared across all three forms. The delimiter search keeps native `indexOf` cursors for the next CR and LF in each decoded chunk, so scanning stays linear for every framing.
