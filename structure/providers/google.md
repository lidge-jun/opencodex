# Google Provider

Created: 2026-10-16 | Updated: 2026-10-18 | Version: 1.2 (Vertex per-key project)

## Streaming input accounting

Google-family SSE parsing counts new decoded text incrementally and waits for a newly received
newline before splitting an incomplete line. Fragmentation therefore does not cause repeated
UTF-8 encoding or rescanning of the growing prefix. The existing per-frame limit, terminal
requirements and heartbeat batching remain in force. Replacement strings, including decoder
EOF output, retain the [shared byte-accounting contract](../transports/byte-accounting.md#stream-buffer-accounting).

## Vertex API-key endpoint selection

`src/adapters/google-vertex-endpoint.ts` selects the Vertex endpoint once per request and the
same selection feeds the thought-signature replay namespace. API keys follow explicit provider
configuration only: `provider.project` selects
`/v1/projects/{project}/locations/{location}/...` with `provider.location` or `global`, which
keeps models such as Gemini 4 Argon reachable when express mode would pick a region without
them. Without `provider.project`, API keys keep the projectless express endpoint even when
`GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` or `GOOGLE_CLOUD_LOCATION` are set, so an unrelated
gcloud default cannot move an express key onto another project. Those environment fallbacks
apply to ADC only, which still requires a project and a location and resolves service-account
markers per request. Every branch validates the location and rejects a model id that is not a
single path segment before any credential is attached; keys stay in `x-goog-api-key`.
`tests/adapters/google/gcp-adc.test.ts` and
`tests/adapters/google/google-vertex-thought-signature.test.ts` cover the selection, ambient
environment isolation, ADC fallbacks, model-path rejection, and replay isolation.

`provider.project: "auto"` is an explicit opt-in for key pools that span projects. An express
key belongs to one project, and Google's projectless NOT_FOUND names it (probed 2026-10-18 across
five express keys; undocumented error text, not a stable discovery API), so
`src/adapters/google-vertex-key-project.ts` sends one countTokens call for a nonexistent model to
the fixed `aiplatform.googleapis.com` authority (manual redirects, 10 s timeout) through the
provider's configured egress (`provider.fetch` or `configuredOutboundFetch` with `providerEgressSendInit`)
and reads the 404 body through `readBoundedResponseBody` with a 4 KiB ceiling and UTF-8 check.
Results are cached per key digest in an insertion-order LRU of 64 entries; concurrent first
requests share one probe, and a caller abort detaches only that waiter unless every waiter has
aborted. A failed, truncated, oversized or stalled probe is not cached and that request uses the
express endpoint, so Google's own 401/403/429 for the key reaches the normal key-pool failover.
The resolved number then takes the ordinary project path, so the replay namespace stays per
project. ADC rejects `"auto"`.
`tests/adapters/google/google-vertex-key-project.test.ts` covers these cases.

## Vertex credential markers

`src/lib/gcp-adc.ts` resolves an explicit `gcp-sa:<account>` through the OS credential store.
An empty or whitespace-only account is rejected before token resolution; it never selects host ADC.
Marker payload readability is checked before returning a cached token; removing or locking the stored
credential fails closed. Errors omit the marker account. Wrapped or malformed credential-shaped input
is refused at ingestion and keychain restore, so it cannot become a literal config value.
The leaf classifier in `src/lib/gcp-credential-input.ts` rejects structured JSON carriers (objects,
arrays and quoted strings) and malformed GCP text reached through
`keychain:` aliases before normal or quiet API-key resolution can return wire-header material.
Post-commit cleanup skips empty or whitespace-only GCP marker accounts in both persisted references and captured removal candidates, so one malformed marker cannot block valid-account retention or cleanup. Request-time marker validation remains strict.
`src/providers/api-keys.ts` stores pasted credential JSON as markers, including multiple JSON objects
in one atomic pool update. Verified OS writes and marker persistence share the cleanup mutation
lock. Rebased callbacks repeat idempotent writes before committing; failed batches remove only
newly created, unreferenced secrets.
The dedicated key-pool endpoint owns JSON ingestion. Provider POST/create/overwrite and CLI add
reject raw JSON in active keys or submitted pool entries before saving; mixed JSON/literal-key
bulk pastes are rejected before any store writes. OS-store failures return a fixed error without
credential material. `src/server/management/provider-gcp-credential-routes.ts` and `src/cli/provider.ts` enforce
this admission through `providerCredentialInputError` in `src/providers/api-keys.ts`; CLI registry input is checked before forward/OAuth branches can discard `--api-key`.
The management helper also owns the locked provider-deletion callback, preserving fallback-default
selection, custom-model/context-cap removal, persistence and subsequent marker cleanup order.
`src/providers/gcp-credential-cleanup.ts` cleans removed markers after config persistence, including CLI `provider add --force` overwrites, under the
  config mutation lock, retaining credentials still referenced by any persisted provider. CLI overwrite captures both live and latest durable rows under that lock. Management overwrite reuses `snapshotProviderGcpCredentialMarkers`; CLI and management deletion use `commitProviderGcpCredentialRemoval` to capture live and valid durable markers and persist removal without releasing the lock. Failed saves and refused CLI additions do not clean credentials.
CLI provider add and removal keep synchronous post-save cleanup inside the same config-root ACL admission as publication; cleanup failures retain the existing warning that configuration removal remains committed.
Reference retention compares OS account identities across both `gcp-sa:` and `keychain:`
spellings. `src/providers/key-store.ts` leaves GCP markers stored during ordinary keychain
store/restore and refuses to restore GCP JSON through a keychain alias; the shared classification
in `src/providers/api-key-resolve.ts` reports those markers as OS-stored credentials.

## OpenCode Go Gemini transport

`src/types/opencode-go.ts` declares the shared exact-model Go protocol table and scopes its Google pins to fixed-key
HTTPS OpenCode Go destinations (`/zen/go/v1` or `/inference/go/v1`), excluding userinfo,
query, fragment, nonstandard ports and Google OAuth/Vertex modes. `src/types/wire.ts`
selects `google` for the table's Gemini model on the `opencode-go` row; runtime, static policy, Fast
policy and protocol summaries share the pin. User-configurable adapter overrides stay
limited to the two OpenAI wires. The existing `opencode-go` preset keeps historical name-based
ownership and pins saved custom or inference URLs to `/zen/go/v1` before dispatch. Pure policy
captures apply the same canonical destination. A differently named custom Chat provider keeps
its configured URL and does not acquire the Google pin. The registry recognizes `/inference/go/v1`
as a destination alias for metadata and affinity on differently named rows.

`src/adapters/google.ts` sends the compiled Gemini body to
`https://opencode.ai/inference/go/v1/models/gemini-4-argon-contributor`, with
`:generateContent` or `:streamGenerateContent?alt=sse`, using the selected key as Bearer
authorization. The existing Go session helper adds affinity for the settled Google wire.
An empty key fails locally with an OpenCode Go diagnostic; AI Studio keeps its own diagnostic.
The preset declares Gemini's `low`/`medium`/`high` thinking-level ladder; higher requested
Codex efforts clamp to `high` through the existing effort resolver.
AI Studio, Vertex and Antigravity retain their own transport contracts. Mocked dispatch
and thought-signature continuation coverage lives in `tests/providers/opencode-go-gemini-wire.test.ts`;
these fixtures do not attest live upstream availability.

## Google thought-text visibility boundary

Google-family parts with `thought: true` stay separate from assistant output. After a CCA
Gemini request or a `showThinkingSummary`-opted-in Gemini request is built, the shared
streaming/buffered classifier emits `thinking_delta` for these provider-authored summaries.
Other Google wires without the opt-in, non-Gemini models and uninitialized adapters retain
`reasoning_raw_delta`. Model provenance is refreshed on every build.
`showThinkingSummary` defaults on only for the Antigravity preset; explicit provider false and
explicit wire summary none win. Eligible CCA, Vertex and direct Gemini requests use
`includeThoughts: true` only when provider opt-in and per-request display both allow it. Thought signatures remain attached
to their tool calls independently; they never become Anthropic thinking signatures.

The visibility marker is the boolean `thought: true`, not the presence of a `thoughtSignature`
or the wording of the text. An unmarked signed text part remains ordinary assistant output;
a signature-only part produces no text. Responses keeps summaries in reasoning items, Chat in
`reasoning_content`, and Messages in thinking blocks. The handler-level synthetic matrix in
`tests/responses/protocol-argon-thought-boundary.test.ts` checks Argon across buffered/SSE
clients, coalesced/split upstream frames, direct/bridge lanes, explicit display suppression and
tool calls. It verifies protocol separation, not live model behavior or another client's UI.

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
A first `functionCall` that still has no real signature after replay receives the Gemini-only
`skip_thought_signature_validator` sentinel through `applyAntigravityThoughtSignatureFallback`, on
Antigravity, Vertex and AI Studio alike. AI Studio gained it for combo hops that hand Gemini a call
another model issued (#7298); non-Gemini model ids never receive it.

`src/adapters/openai-responses/passthrough.ts` removes item-level `extra_content` through
`stripProviderInputItemMetadata` in `src/adapters/openai-responses/request-strips.ts` only for
OpenAI-operated Responses destinations (canonical ChatGPT Codex and the official OpenAI API).
This outbound projection is shared by HTTP and WebSocket creates, including concrete combo/fallback
children, and the direct native compact send in `src/server/responses/compact.ts`.
It preserves caller-owned history for Google thought-signature replay and leaves arbitrary
gateway extensions intact; it does not allowlist item fields or traverse tool arguments/results.

> Decision record: [ADR-0057](../decisions/ADR-0057-google-tool-call-thought-signature-replay.md)

## Google tool-result adjacency repair

Google-family requests serialize a model tool-call turn and its results as one adjacent
`model -> user` pair. The user turn contains exactly one `functionResponse` for every representable
call in original call order. Missing results use an explicit unknown-history marker; duplicate,
mismatched, and standalone results become marked text instead of unpaired function responses.
For Cloud Code Assist routed `claude-*` models, the complete matched `functionResponse` batch
precedes its sibling images in the same user turn; images keep call order, MIME types and bytes.
Interleaving an image before the remaining responses makes CCA Claude reject the batch as missing
later tool results. Single-call and text-only batches keep their existing shape. CCA Gemini,
non-Claude CCA models, AI Studio and non-Argon Vertex retain interleaved image siblings.
`tests/adapters/google/google-tool-result-adjacency.test.ts` checks the final compiled request
for three parallel calls, reversed results, distinct images and route isolation.
For Vertex `gemini-4-argon`, matched results carry representable data-URL images inside
`functionResponse.parts`, preserving each image's call ownership. Sibling images on that route can
produce a misleading "Requests ending with a model turn are not supported" error even when the
last turn is `user`. When an adjacent orphan batch contains representable images on that route,
the entire marked orphan batch follows the complete function-response batch in a separate user
turn, preserving orphan result order and image bytes without assigning an orphan image to another call. Text-only
orphans, standalone orphans and other routes retain their existing representation.
`tests/adapters/google/google-vertex-thought-signature.test.ts` covers the scoped wire format.

> Decision record: [ADR-0058](../decisions/ADR-0058-google-tool-result-adjacency-repair.md)
> Decision record: [ADR-7279](../decisions/ADR-7279-vertex-argon-tool-images.md)
> Decision record: [ADR-7280](../decisions/ADR-7280-vertex-argon-orphan-images.md)

## Google opening functionCall repair

A `functionCall` turn may not open `contents`: the upstream requires a call turn to follow a
user or function-response turn and rejects an opening call turn with
"function call turn comes immediately after a user turn or after a function response turn"
(HTTP 400). Client-side context compaction can truncate a long history so it opens on an
assistant tool call. `messagesToGeminiFormat` prepends a user `"(continue)"` nudge when the
first compiled turn is `model` carrying a `functionCall` — the same repair Kiro applies to
assistant-head turns in `src/adapters/kiro/payload.ts`. A model head carrying only text is left
alone: no upstream rule against it is demonstrated, so repairing it would inject a turn into
valid requests.

> Decision record: [ADR-5008](../decisions/ADR-5008-google-opening-functioncall-repair.md)

## Gemini progress-text history

Gemini sometimes skips its thinking channel on a tool-calling turn and plans in visible text
instead: a progress line followed by unmarked planning such as "Let's read google.ts next."
Replayed whole, that tail is copied by every later turn of the session. When
`messagesToGeminiFormat` serializes an assistant turn that contains a tool call for a model id
containing `gemini`, the text before the turn's first tool call is replayed as the lead sentence
of its first non-empty text part; the other text parts before the call are dropped. Text after a
tool call and turns with Responses `phase: "final_answer"` are replayed whole.
`src/adapters/google-progress-history.ts` owns the split: ASCII `.`, `!` or `?` followed by
whitespace, a script's own sentence terminator (CJK, Devanagari, Arabic, Armenian, Ethiopic,
Myanmar), or a line break, with trailing closing quotes,
brackets and Markdown emphasis kept. Boundaries that only close a leading list marker or
`e.g.`/`i.e.`/`etc.`/`vs.` are skipped. Boundary checks use a fixed-size suffix and scan
intervening whitespace intervals once, keeping the split linear in text length. It never matches wording.

Final answers (assistant turns without tool calls), non-Gemini models such as Claude on
Antigravity, tool calls, their signatures and client-visible output are unchanged. A leak in the
current response is still delivered as ordinary text; the trim keeps it from propagating.
The trade-off is that facts a model states only in pre-call text, beyond its first sentence, are
not replayed; the call, its result and any final answer still are.
`tests/adapters/google/gemini-progress-history.test.ts` covers CCA and AI Studio Gemini, the
`final_answer` and Claude exemptions, text after a call and the split.

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

## Video part boundary and agentic media processing

The inbound contract is the OpenAI-compatible content part
`{ type: "video_url", video_url: { url, processing? } }`, normalized by both the Chat and
Responses ingress into an internal `{ type: "video", videoUrl, processing? }` part. `processing`
is caller-supplied and optional; nothing infers it.

The outbound contract is a GenerateContent `contents[].parts[]` entry. `media_processing` is a
**Part** field, not a request field and not the Interactions API's `processing`, so it is emitted
beside `inline_data` and beside `file_data` alike — attaching it to only the fetched-URI branch
would silently drop the mode for `data:` URLs, which is the shape the first revision of #3271 had.
`geminiMediaProcessing` upper-cases the caller's value and returns `undefined` when absent, so a
request that did not ask for a mode gains no field.

`geminiFetchableVideoUri` is the trust boundary: it decides which URLs opencodex will ask Gemini
to **fetch on its own behalf**. It parses the URL and requires HTTPS, then admits exactly two
families — the YouTube watch hosts (`youtube.com`, `www.`/`m.`/`music.` variants, `youtu.be`, and
the `-nocookie` forms) and `generativelanguage.googleapis.com` with a path matching
`/files/<id>`. Matching is on the parsed host and pathname, never a substring of the URL, so a
look-alike host cannot become a `file_data` reference. Everything else keeps the
`[video: <url>]` text marker: without a media type there is nothing correct to send, and a
fetchable reference the proxy cannot vouch for is the SSRF-shaped half of this feature.

`file_data` carries `file_uri` only. An earlier revision guessed a `mime_type` for it; the Files
API already knows the type of what it stores, and a wrong guess is worse than no guess.
