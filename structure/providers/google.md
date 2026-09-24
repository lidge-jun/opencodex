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

## Google tool-schema loss reporting

`src/adapters/google-tool-schema.ts` compiles tool declarations against an explicit `ai-studio`,
`vertex`, or `cloud-code-assist` endpoint profile. All three profiles currently use the same
conservative documented subset. Compilation returns the compatible parameters plus a versioned
loss report with exactly six fields: `version`, `endpointClass`, `lossy`, `truncated`,
`uncertainComparisons`, and `categories`. Category values and the content-free uncertainty count
saturate at 255; saturation beyond either cap sets `truncated`. Bounded structural comparisons that
exhaust their 24-level or 1,024-node allowance increment `uncertainComparisons` rather than
`lossy` or a proven-loss category. The report never retains tool or property names, paths, descriptions,
schema or enum values, references, hashes, request ids, project ids, or account ids.
Every sanitizer branch that widens or drops an accepted-value constraint has a closed category,
including type unions and unsupported types, conditional and tuple constraints, reference-overlay
replacement, and root object coercion. Lossless normalization does not set `lossy`: accepted type
case folding, duplicate enum/required removal, nullable-union collapse, and string-const conversion
preserve the accepted value set; an array left without `items` is emitted with `items: { type: "string" }`
because Gemini rejects an array declaration without an item type; that narrows an unconstrained item
rather than widening a constraint, so it does not set `lossy` either. The synthesized item is itself
part of the emitted tree and charges the 1,024-node allowance, so an array the budget can no longer
complete is omitted — along with any parent that lost its own `items` to the same rule — and records
`node-budget-widened` instead of emitting a declaration Gemini would reject. Annotation-only fields such as title, default, examples, comments,
deprecated, read-only/write-only, external documentation and examples are omitted without loss.
Local-reference siblings use 2020-12-style conjunctive semantics for loss accounting, while the
wire transform retains its implemented overlay-wins merge; enum reports compare that intersection
with the post-filter set actually emitted.

This layer observes loss and does not reject it. The emitted request body remains the same as
before reporting. The existing limits remain 24 schema levels, 16 local-reference dereferences,
and 1,024 visited nodes; reporting stops with those limits and does not inspect omitted content.
`src/adapters/google-wire-compiler.ts` aggregates reports across declarations, and
`src/adapters/google.ts` emits a `google-tool-schema-loss` provider diagnostic only when provider
debug is enabled. `generationConfig.responseMimeType` and `generationConfig.responseJsonSchema`
are output-schema fields and never enter tool-schema sanitation or loss accounting.

`googleToolSchemaPolicy` is provider-scoped. Omission and `compatible` retain the report-only body
and existing repair replay. `reject-lossy` refuses an initially lossy or comparison-indeterminate
compilation before `buildRequest` returns, so no physical send exists. Vertex and Cloud Code Assist carry the same
resolved policy into their 400 compatibility repair: indexed repair reports one opened declaration,
unindexed repair reports every declaration it would open, and strict policy returns the original
400 without a changed repair send. The `google-tool-schema-repair` diagnostic inherits the complete
bounded report shape — version, endpoint class, `lossy`, `uncertainComparisons`, truncation flag,
and saturating fixed category counts — and adds only the `repair` phase, the declaration count, and whether the changed
send was allowed.
AI Studio direct mode continues to disable 400 repair entirely. Output schemas remain outside both
initial and repair policy.

## Google wire-shape projection

`src/adapters/google-wire-shape.ts` describes a compiled Google request without carrying any of
it. `summarizeGoogleWireShape` reads the body after `compileGoogleWireBody` and after Antigravity
replay and signature adjustment, which is the object the envelope sends, and returns per-role turn
counts, function call and response counts and their pairing, the position and class of the first
ordering violation, signature presence and sentinel-only signing, the session anchor class, and a
bounded upstream error class. Tool-call identity survives only as a request-internal ordinal in
first-appearance order.

What it must never retain is the point of the module: prompt or system text, tool arguments and
results, tool and function names, original or wire call ids, signature text or any hash of it,
inline file bytes, project and account identifiers, the request id, the Cloud Code Assist session
id, Codex thread and session ids, and the first user message. Totals stay exact for the whole
request while per-turn detail stops at a fixed ceiling and sets `truncated`, so a long agentic
session still reports its real counts.

It is a projection, not a validator. Nothing in the request path consults its output.
`antigravitySessionAnchor` in `google-antigravity-wire.ts` is the matching content-free read of
the session boundary: it reports which of the four anchor classes produced the session id without
reporting the id, and it reads the same decision the id derivation reads, so the two cannot
disagree about which regime a request is in.

The adapter passes a builder to `debugProviderDiagnosticLazy`, never a built object. That gates
before invoking it, so a request with provider debug off never pays the walk, and it evaluates
the projection inside the logger's own try/catch, so a throw in a diagnostic cannot turn a built
request into a rejected one. With provider debug ON the projection runs synchronously on the
dispatch path before the request is sent, and its cost is linear in history length — largest for
exactly the long sessions it exists to describe. Observing the real outbound body rather than a
reconstruction is what that buys.

Two ceilings bound the output, and both are needed. The item ceilings cap retained turns and the
per-turn ordinal lists; the serialized ceiling, held at half `MAX_DEBUG_LINE_BYTES`, then trims
turn detail from the tail until the summary fits. Without the second, a worst case inside the
first serializes past the debug buffer's per-line cap, and the buffer truncates at a byte
boundary: the consumer gets unparseable JSON whose retained prefix still reads `truncated: false`.
