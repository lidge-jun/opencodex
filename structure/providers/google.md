# Google Provider

## Google thought-text visibility boundary

Google-family responses may represent model-internal reasoning as a text-bearing part with
`thought: true`. The Google adapter maps that text to the internal `reasoning_raw_delta` event;
only text without the marker becomes visible `text_delta`. Streaming SSE and buffered JSON share
one classifier so transport selection cannot change whether provider-declared reasoning is shown
as assistant output. Thought-signature observation still runs on the original parts before text
classification, preserving the opaque continuation state independently of display semantics.

> Decision record: [ADR-0055](../decisions/ADR-0055-google-thought-text-visibility-boundary.md)

## Google response-part field boundary

Google-family adapters validate the values inside an otherwise well-formed response part before
they become `AdapterEvent`s. A present `functionCall` must be an object with a nonblank string
`name`; because Gemini delivers that call atomically rather than across deltas, an invalid name is a
terminal protocol error and is never dispatched. A non-string optional `text` value is dropped
without coercion, while the rest of the part and turn continue. Structured `functionCall.args`
remain provider-native and are serialized as before.

> Decision record: [ADR-0056](../decisions/ADR-0056-google-response-part-field-boundary.md)

## Google tool-call thought-signature replay

Gemini may attach an opaque `thoughtSignature` to a `functionCall` and requires that exact value on
the matching model turn when its tool result is submitted. Antigravity and Vertex share the existing
bounded TTL/LRU replay store, keyed by compiled function-call name plus canonical arguments. Vertex
prefixes its cache model key with the transport, project, and location identity, so a signature
minted by Vertex cannot be sent to Antigravity even when both routes expose the same public model id.
Vertex prefers Codex's opaque `prompt_cache_key` for session identity and falls back to the existing
first-user-message derivation for clients that omit it; only the fixed hash is retained.
Both streaming and non-streaming responses feed the store; request compilation happens before replay
so matching uses the provider-visible tool name.

> Decision record: [ADR-0057](../decisions/ADR-0057-google-tool-call-thought-signature-replay.md)

## Google tool-result adjacency repair

Google-family requests serialize a model tool-call turn and its results as one adjacent
`model -> user` pair. The user turn contains exactly one `functionResponse` for every representable
call in original call order. Missing results use an explicit unknown-history marker; duplicate,
mismatched, and standalone results become marked text instead of unpaired function responses.
Representable data-URL images remain sibling `inline_data` parts in either case.

> Decision record: [ADR-0058](../decisions/ADR-0058-google-tool-result-adjacency-repair.md)
