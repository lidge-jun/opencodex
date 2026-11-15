# 010 — Phase 1: Gemini Interactions API inbound (stateless)

Rows: INT-01..12, INT-18, INT-19 ([001](001_parity_matrix.md)). Class C4: a new public wire surface.
Depends on the #8742 merge (it reuses `gemini-native-paths.ts`, `gemini-inbound.ts`'s error body,
`native-chat-bridge.ts` and `native-final-log`). `previous_interaction_id` answers 400 in this phase;
phase 020 replaces that with the store.

## Stale check before B

Re-read on the merged tree: `src/server/gemini-native-paths.ts`, `src/server/index/gemini-routes.ts`,
`src/server/gemini-inbound.ts` (exports `geminiError`, `geminiErrorBody`, `toGeminiRefusal`),
`src/server/native-chat-bridge.ts` (`internalChatRequest`, `streamNativeFromChat`,
`drainedInnerErrorMessage`, `commitCancelled`), `src/server/ollama-route-policy.ts`
(`preflightOllamaRoute`), `src/server/inbound-body-admission.ts` (`isGeminiGenerationPath`), the
loopback allowlist and management denial in `src/server/index.ts` (both keyed on `parseGeminiNativePath`),
and `tests/fixtures/file-size-baseline.json` for every file below. Capture the stable-version reference
(`https://ai.google.dev/api/interactions-api.md.txt?api-version=v1` through Aside) and keep
`/v1/interactions` only if the fields this codec reads are identical there; otherwise drop INT-19 to defer.

## Changes

### MODIFY `src/server/gemini-native-paths.ts`

Add Interactions routes to the same classifier, so the package-tree fence, loopback allowlist,
management denial and raised-body admission all pick them up through the existing callers.

```diff
-export type GeminiNativeRoute =
-  | { kind: "models"; httpMethod: "GET" }
-  | { kind: "model"; httpMethod: "GET"; model: string }
-  | { kind: "method"; httpMethod: "POST"; model: string; method: GeminiMethod };
+export type GeminiNativeRoute =
+  | { kind: "models"; httpMethod: "GET" }
+  | { kind: "model"; httpMethod: "GET"; model: string }
+  | { kind: "method"; httpMethod: "POST"; model: string; method: GeminiMethod }
+  | { kind: "interactions"; httpMethod: "POST" };
@@ export function parseGeminiNativePath(pathname: string): GeminiNativeRoute | undefined {
+  if (pathname === "/v1beta/interactions" || pathname === "/v1/interactions") return { kind: "interactions", httpMethod: "POST" };
   const beta = pathname.startsWith("/v1beta/models");
@@ export function isGeminiGenerationPath(pathname: string): boolean {
   const route = parseGeminiNativePath(pathname);
-  return route?.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent");
+  return route?.kind === "interactions"
+    || (route?.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent"));
 }
```

Phase 020 extends the union with the by-id routes. `/v1/interactions` is the stable-version path
(002); `rg '/v1/interactions' src` is empty on d842c1352e, so it collides with nothing.

### NEW `src/protocols/codecs/gemini-interactions.ts` (pure, no server imports)

```ts
export class InteractionsCodecError extends Error { readonly status = 400; readonly code = "invalid_interactions_request"; }
export interface InteractionsRequestPlan {
  model: string;                       // after stripping a leading "models/"
  stream: boolean;
  store: boolean;                      // default true (Google default)
  previousInteractionId?: string;      // phase 1: presence is a 400 from the handler
  unmatchedResultIds: string[];        // function_result call_ids with no function_call in this input
  chat: Record<string, unknown>;       // the internal Chat Completions body
}
export function interactionsToChat(input: unknown): InteractionsRequestPlan;
export function chatToInteraction(meta: InteractionMeta, chatResponse: unknown): Record<string, unknown>;
export interface InteractionMeta { id: string; model: string; created: string }
export function createInteractionsStreamState(meta: InteractionMeta): InteractionsStreamState;
export function interactionsStreamStart(state): InteractionsSseEvent[];               // interaction.created
export function consumeInteractionsChatChunk(state, parsedChunk: unknown): InteractionsSseEvent[];
export function interactionsStreamTerminal(state): InteractionsSseEvent[] | undefined;  // step.stop(s) + interaction.completed
export function interactionsErrorEvent(code: number, message: string): InteractionsSseEvent;
export type InteractionsSseEvent = { event: string; data: Record<string, unknown> };
```

Request mapping (Interactions → Chat). Unknown top-level fields are ignored, as in #8742.

| Interactions | Chat | Notes |
| --- | --- | --- |
| `model` (string, required unless `agent`) | `model` | `models/x` → `x`; empty → 400 |
| `agent` | — | 400 `agent interactions require a native Interactions upstream`; both or neither of model/agent → 400 `request requires exactly one of model or agent` (A-I02) |
| `stream` | `stream` (+ `stream_options.include_usage:true`) | non-boolean → 400 `stream must be a boolean` (A-I03) |
| `background: true` | — | 400 |
| `store` | — | boolean or absent; recorded on the plan |
| `previous_interaction_id` | — | string; recorded on the plan |
| `system_instruction` string, `{text}`, or `{parts:[{text}]}` | leading `system` message | other shapes 400 |
| `input` string | one `user` message | |
| `input` content object or content array (`{type:"text",text}`, `{type:"image",data,mime_type}`) | one `user` message (string when text-only, parts when an image is present) | image needs base64 `data` and an `image/*` `mime_type`; `uri`, audio, video, document → 400 `unsupported content type` |
| `input` step array, or turn objects `{role,content}` | messages in order | see step table |
| `tools[]` `{type:"function",name,description?,parameters?}` | `tools[]` function entries | schema types lower-cased with #8742's `normalizeSchema` rule (depth 64); any other `type` → 400 `unsupported tool type` (D3) |
| `generation_config.temperature/top_p/seed/stop_sequences` | `temperature/top_p/seed/stop` | finite numbers / safe integers / string array |
| `generation_config.max_output_tokens` | `max_tokens` | positive safe integer |
| `generation_config.thinking_level` | `reasoning_effort` | `minimal|low|medium|high|xhigh` |
| `generation_config.thinking_summaries: "auto"` | `include_reasoning: true` | `none` → omitted |
| `generation_config.tool_choice` (or top-level `tool_choice`) | `tool_choice` | `auto`/`validated` → omitted (auto), `any` → `required`, `none` → `none`, `{allowed_tools:{mode,tools}}` → `{type:"allowed_tools",allowed_tools:{mode:auto|required,tools:[{type:"function",function:{name}}]}}` (#8742 `toolChoice` semantics) |
| `response_format` `{type:"text",mime_type:"application/json",schema?}` (object or one-element array) | `response_format` `json_schema` / `json_object` | `type` image/audio/video → 400 (D3) |
| `response_modalities` other than `["TEXT"]` / `["text"]` | — | 400 (CPA-derived field, absent from the current reference; non-text output is refused through `response_format` above) |

Steps → messages:

| step | Chat |
| --- | --- |
| `user_input{content[]}` / `{role:"user",content}` | `user` message (content table above) |
| `model_output{content[]}` / `{role:"model",content}` | `assistant` text, merged with following `function_call` steps into one assistant message |
| `thought{signature?,summary?}` | not conversation text; a `signature` is held and attached to the next `function_call` as `extra_content.google.thought_signature` (consumed once CW-01 lands in 030) |
| `function_call{id,name,arguments}` | assistant `tool_calls[]` entry, `arguments` JSON-stringified (object required) |
| `function_result{call_id,name?,result,is_error?}` | `tool` message, `tool_call_id: call_id`; `result` string as is, object → `JSON.stringify`, text-content array joined, image content → 400; `is_error: true` wraps the text as `{"error": <text>}` (the Gemini functionResponse convention). A `call_id` with no matching `function_call` in this input is **not** a codec error: it is returned in `plan.unmatchedResultIds` (Google's chained tool flow sends only the result plus `previous_interaction_id`, function-calling guide). The handler answers 400 `unmatched function_result` for ids still unmatched after history is applied (phase 1: no history, so any unmatched id is 400) |
| `developer`/`system` role turn | `system` message |
| any other step type | 400 `unsupported step type: <type>` |

Limits copied from #8742: at most 1,024 function calls, schema depth 64.

Response mapping (Chat → Interaction), buffered:

```json
{ "id": "<meta.id>", "status": "<status>", "created": "<iso>", "updated": "<iso>", "model": "<requested model>",
  "steps": [
    { "type": "thought", "summary": [{ "type": "text", "text": "<reasoning_content>" }] },
    { "type": "model_output", "content": [{ "type": "text", "text": "<content>" }] },
    { "type": "function_call", "id": "<call id>", "name": "<name>", "arguments": { } }
  ],
  "usage": { "total_input_tokens": 5, "total_cached_tokens": 0, "total_output_tokens": 2, "total_thought_tokens": 0, "total_tokens": 7 } }
```

- `status` from `finish_reason`: `tool_calls`/`function_call` → `requires_action`, `length` and
  `content_filter` → `incomplete`, `stop` → `completed`; anything else → 502 (as #8742 refuses an
  unknown finish). (INT-12; CPA reports `completed` for tool turns.) `content_filter` maps to
  `incomplete` because the reference defines it as "completed, but contains incomplete results" and a
  filtered answer is exactly that: the turn ended and its partial text is valid; `failed` is kept for
  turns with no usable result (proxy or upstream errors).
- `usage`: `total_input_tokens = prompt_tokens`, `total_cached_tokens = prompt_tokens_details.cached_tokens`,
  `total_thought_tokens = completion_tokens_details.reasoning_tokens`,
  `total_output_tokens = max(0, completion_tokens − thought)`, `total_tokens = prompt + completion` (D4).
  On Google routes this is exact only after 050 (D5), because Google completion counts exclude
  thoughts until then; the clamp keeps it non-negative meanwhile.
- A thought signature on a Chat tool call (`extra_content.google.thought_signature`, emitted once CW-01
  lands) becomes `thought.signature` on a thought step placed before that call.
- `id`: `ocx-int-` + 32 lowercase hex chars from `crypto.getRandomValues(new Uint8Array(16))` (128 random
  bits; `randomUUID` carries only 122); `created` = `updated` = ISO second precision.

Streaming events, each framed `event: <name>\ndata: <json>\n\n` and each `data` carrying
`event_type` (002):

1. `interaction.created` `{interaction:{id,status:"in_progress",model,created,updated}}` — first frame.
   #8742's `NativeStreamTranslator` has no start hook, so the codec emits it lazily: the first `chunk()`
   call prepends it, and `failure()` / the terminal frames prepend it when no chunk produced it. No #8742
   file changes for this.
2. reasoning delta → `step.start {index:n, step:{type:"thought"}}` once, then
   `step.delta {index:n, delta:{type:"thought_summary", content:{type:"text",text}}}`.
3. content delta → close an open thought step (`step.stop {index:n}`), `step.start {index:n+1,
   step:{type:"model_output"}}` once, then `step.delta {delta:{type:"text",text}}`.
4. tool calls accumulate as in #8742 and are emitted at `finish_reason`: per call
   `step.start {step:{type:"function_call",id,name,arguments:{}}}`,
   `step.delta {delta:{type:"arguments_delta",arguments:"<json>"}}`, `step.stop`; a signature becomes
   `step.delta {delta:{type:"thought_signature",signature}}` on a preceding thought step.
5. terminal (only after Chat EOF and settlement, via `streamNativeFromChat`): close the open step, then
   `interaction.completed {interaction:{id,status,model,created,updated,usage}}`.
6. failure after commit: `event: error`, `{event_type:"error", error:{code:"<status name lower-case>",message}}`.

### NEW `src/server/gemini-interactions-inbound.ts`

`handleGeminiInteraction(req, config, logCtx, ids): Promise<Response>` mirrors
`handleGeminiGeneration` step for step: read the JSON body under `resolveInboundBodyLimitBytes` and a
translator budget; `interactionsToChat`; 400 for `previous_interaction_id` (phase 1 only:
`previous_interaction_id is not supported`); `preflightOllamaRoute(config, plan.model, req)`; 413 when the
Chat JSON exceeds the limit; `handleChatCompletions(internalChatRequest(...), config, logCtx, {...ids,
suppressProtocolTrace:true})`; buffered → `chatToInteraction`; streamed →
`streamNativeFromChat` with SSE framing and `content-type: text/event-stream`. Errors use
`geminiError` (Google `{error:{code,message,status}}`, fixed text) so both Gemini surfaces share one
error vocabulary (INT-18).

### MODIFY `src/server/index/gemini-routes.ts`

```diff
-  const generation = route.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent");
+  const interaction = route.kind === "interactions";
+  const generation = interaction || (route.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent"));
@@
-      await handleGeminiGeneration(method, route.model, sse, sessionReq, config, logCtx, { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy }),
+      interaction
+        ? await handleGeminiInteraction(sessionReq, config, logCtx, { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy })
+        : await handleGeminiGeneration(method, route.model, sse, sessionReq, config, logCtx, { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy }),
```

The `route.method` cast moves inside the non-interaction branch.

## Tests (written first, must fail before the change)

- NEW `tests/responses/responses-gemini-interactions-codec.test.ts` (domain `responses`): string input;
  content array with an image; step history with `function_call`/`function_result` and a held thought
  signature; `system_instruction` forms; generation_config mapping incl. `thinking_level`,
  `thinking_summaries`, `tool_choice` (string and `allowed_tools`); `response_format`; every 400 in the
  tables (agent, both model+agent, non-boolean stream, background, hosted tool, unsupported step,
  unmatched result, image uri); buffered response for stop / tool_calls / length with usage names; the
  stream event sequence for text, reasoning-then-text, and tool calls; terminal refused before finish.
- NEW `tests/server/server-gemini-interactions-inbound.test.ts` (domain `server`, harness copied from
  `server-gemini-inbound.test.ts`): buffered and streamed create on `/v1beta/interactions` and
  `/v1/interactions`; `x-goog-api-key` admission and 401 without it on a public bind; 405 for GET;
  upstream 400 → Google error body with fixed text; `previous_interaction_id` → 400; one request-log row.
- Register both in `scripts/test-layout/layout-server-inbound.json` and
  `tests/fixtures/test-layout-expected.json` (the shard `tests/test-layout-tooling.test.ts` names).

## Docs

- `structure/data-planes/gemini-inbound.md`: new "Interactions" section (routes, mapping summary, D3
  refusals, events, usage names, coverage list) and ownership of the two new source files in
  `structure/manifest.json`, then `bun run structure:index`.
- `docs-site` integrations guide (070).

## Verify

`bun test tests/responses/responses-gemini-interactions-codec.test.ts tests/server/server-gemini-interactions-inbound.test.ts tests/server/server-gemini-inbound.test.ts tests/responses/responses-gemini-codec.test.ts`,
then the per-phase floor in [000](000_plan.md).

