# Google Provider

## Google thought-text visibility boundary

Google-family parts with `thought: true` stay separate from assistant output. After a CCA
Gemini request is built, the shared streaming/buffered classifier emits `thinking_delta` for
these provider-authored summaries. Other Google wires, non-Gemini CCA models and uninitialized
adapters retain `reasoning_raw_delta`. Model provenance is refreshed on every build.
`showThinkingSummary` defaults on only for the Antigravity preset; explicit provider false and
explicit wire summary none win. Eligible CCA Gemini requests use `includeThoughts: true` only
when provider opt-in and per-request display both allow it. Thought signatures remain attached
to their tool calls independently; they never become Anthropic thinking signatures.

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
## Structured output on generateContent

A caller's Responses `text.format` reaches the Gemini wire as
`generationConfig.responseMimeType: "application/json"` plus, for `json_schema`,
`generationConfig.responseJsonSchema` carrying the schema unchanged.
`responseJsonSchema` takes ordinary JSON Schema with lowercase type names, which is
the shape `options.textFormat.schema` already holds; `responseSchema` takes Gemini's
uppercase typed `Schema` form and is omitted when `responseJsonSchema` is used. The
response type is unchanged — the model returns text containing conforming JSON — so
response parsing is untouched.

The schema is carried verbatim. `sanitizeGeminiToolParameters` narrows a schema to
the function-declaration subset and must never be applied to a caller-authored output
schema. `compileGenerationConfig` in `google-wire-compiler.ts` is a whitelist, so
both keys are listed there as well; setting them in the adapter alone would drop them
before the wire. On Cloud Code Assist, Gemini models carry these same keys inside
`envelope.request.generationConfig`.

Three cases refuse explicitly rather than dropping the constraint silently:
non-Gemini models on Cloud Code Assist (such as Claude models served through that
envelope), which opencodex does not implement or verify for this field (this is not
a claim about what the upstream can do); an image-capable model, whose `responseModalities`
configuration contradicts JSON-constrained text; and a `json_schema` format carrying
no schema, which would otherwise downgrade to bare JSON mode. An image-capable model
with no structured-output request keeps its existing `responseModalities` behavior.
