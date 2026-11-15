# 030 — Phase 3: Gemini generateContent inbound fidelity (on #8742)

Rows: IN-09 + CW-01 (P1), IN-05, IN-12 (P2), IN-03, IN-13 (P3). Class C3: touches the shared Chat codec
and encoder. Depends on the #8742 merge. Each row is its own commit.

## 3a — CW-01: Chat carries `extra_content.google.thought_signature`

Today the Responses wire carries a Gemini signature on `function_call` items
(`src/responses/provider-opaque-metadata.ts:17-61`, read in `src/responses/parser.ts:532-536` with a
fallback to the proxy-side store), but the Chat wire drops it both ways: `pushToolCall` in
`src/protocols/codecs/chat-ir.ts:260-265` builds `OcxToolCall` without `providerMetadata`, and
`emitToolCall` in `src/protocols/encoders/chat.ts:112-129` never writes `extra_content`. CPA reads and
writes this field on Chat (C-V-34, C-V-35).

```diff
// src/protocols/codecs/chat-ir.ts
-  const pushToolCall = (callId: string, name: string, args: string): void => {
+  const pushToolCall = (callId: string, name: string, args: string, extra?: unknown): void => {
     emitted = true;
-    const call: OcxToolCall = { type: "toolCall", id: callId, name, arguments: functionCallArgumentsFromText(callId, args) };
+    const providerMetadata = providerMetadataFromResponsesFunctionCall({ extra_content: extra });
+    const call: OcxToolCall = { type: "toolCall", id: callId, name, arguments: functionCallArgumentsFromText(callId, args),
+      ...(providerMetadata ? { providerMetadata } : {}) };
@@ (tool_calls loop)
-            pushToolCall(callId, name, args);
+            pushToolCall(callId, name, args, entry.extra_content);
```

No parse-time store fallback is added: `lookupReplayThoughtSignature` requires a bound replay scope for
a hit (`src/responses/parser.ts:36-42`), and the scope is not bound when a request is parsed. The
scoped durable lookup already happens at serialization in the adapter (`src/adapters/google.ts:527-535`,
#1926), which covers clients that do not echo the field. The carrier only reads what the client sent.

```diff
// src/protocols/encoders/chat.ts
-  const emitToolCall = (toolIndex: number, callId: string, name: string, args: string) => {
+  const emitToolCall = (toolIndex: number, callId: string, name: string, args: string, extra?: Record<string, unknown>) => {
@@
-          function: { name, arguments: args },
+          function: { name, arguments: args },
+          ...(extra ? { extra_content: extra } : {}),
@@ toolDone(call)
-      emitToolCall(toolIndex, call.callId, call.name || toolNameByIndex.get(toolIndex) || "", call.arguments);
+      emitToolCall(toolIndex, call.callId, call.name || toolNameByIndex.get(toolIndex) || "", call.arguments, call.extraContent);
```

Stale check: the shape of the `call` the converter hands to `toolDone` and whether the serialized
Responses item's `extra_content` is already on it; if not, add an `extraContent` field where the
converter reads the finished `function_call` item. The buffered Chat response path gets the same field
on `message.tool_calls[]`.

Tests: EXTEND `tests/responses/protocol-chat-ir-parity.test.ts` — an assistant `tool_calls[].extra_content.google.thought_signature` reaches
`OcxToolCall.providerMetadata`; an oversized signature is dropped. EXTEND the Chat encoder tests — a
tool call with provider metadata emits `extra_content` in the stream and in the buffered body.

## 3b — IN-09: Gemini inbound codec carries `thoughtSignature`

```diff
// src/protocols/codecs/gemini.ts (chatMessages, model role)
-        calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
+        const signature = field(part, "thoughtSignature") ?? pendingThoughtSignature;
+        pendingThoughtSignature = undefined;
+        calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(args) },
+          ...(typeof signature === "string" && signature ? { extra_content: { google: { thought_signature: signature } } } : {}) });
```

A `thoughtSignature` on a `thought:true` text part or a signature-only part is held as
`pendingThoughtSignature` for the next call in the same turn (Gemini 3 puts it on the first call).
Response side (`functionCallPart`, buffered and stream): copy `tool_calls[].extra_content.google.thought_signature`
onto the part as `thoughtSignature`. Unsigned calls stay unsigned (the outbound adapter's sentinel rule
applies on the Google side).

Tests (EXTEND `tests/responses/responses-gemini-codec.test.ts`): request with a signed `functionCall`
→ Chat `tool_calls[0].extra_content`; buffered and streamed Chat responses with `extra_content` →
`functionCall` part with `thoughtSignature`. EXTEND `tests/server/server-gemini-inbound.test.ts` with a
two-turn tool loop through a `google` provider fixture that returns a signature on turn 1 and asserts the
turn-2 upstream `functionCall` part carries it — this is the end-to-end failing test that settles A's open
question 1.

## 3c — IN-05: `:countTokens` returns a local estimate

Build the Chat body with `geminiToChat(model, body.generateContentRequest ?? body, false)`, parse it with
the Chat IR (`src/protocols/codecs/chat-ir.ts`), and estimate with `estimateInputTokens(parsed, model)`
(`src/server/responses/input-admission.ts:124`; the Messages estimator in `messages-shared.ts:570` takes a
Messages body and does not fit). Answer `{ "totalTokens": n }`. `dispatchGeminiRoute` keeps
model-discovery admission for this method (no upstream call) and enforces the key's model scope exactly
as `handleGeminiModel` does (unknown or out-of-scope model → 404). Tests: `server-gemini-inbound.test.ts` 501 case becomes a 200 with a positive integer
`totalTokens` for `contents` and for `generateContentRequest`; embed methods stay 501.

## 3d — IN-12: model resources carry token limits

`modelResource(selector)` in `src/server/gemini-inbound.ts` adds `inputTokenLimit` and
`outputTokenLimit` when the catalog knows the route's context window and max output (stale check: the
accessor `listOllamaRoutes` rows expose, or the catalog lookup Ollama's `/api/show` uses). Unknown → the
fields are omitted, never guessed. Test: the list and lookup carry the configured limits for a fixture
model with `contextWindow`/`maxOutputTokens`.

## 3e — IN-03 and IN-13

- `dispatchGeminiRoute`: `const sse = (url.searchParams.get("alt") ?? url.searchParams.get("$alt")) === "sse";`
- `STATUS_NAMES`: add `402: "FAILED_PRECONDITION"`, `408: "DEADLINE_EXCEEDED"`, `409: "ABORTED"`,
  `422: "INVALID_ARGUMENT"`, `500: "INTERNAL"`, `502: "UNAVAILABLE"` (google.rpc.Code mapping).
- Tests: `$alt=sse` streams SSE; `geminiErrorBody(409, …).error.status === "ABORTED"`.

## Docs

Update `structure/data-planes/gemini-inbound.md` (signatures, countTokens, token limits, `$alt`) and
`structure/data-planes/inbound-compat.md` (Chat `extra_content` carrier).



## Stale check (cycle 4, at baa5dfbadb), revised after audit `.tmp/research/audit-030.md` (FAIL)

3a replaces the earlier 3a diff. Carrier rule everywhere: a client value is normalized with
`providerMetadataFromResponsesFunctionCall` and re-serialized with `responsesExtraContentFromProviderMetadata`,
so a malformed or oversized `extra_content` becomes absent and never fails the request (`responses/schema.ts:111`
is strict and `parser.ts:232` throws on a miss).

- Inbound, bridge lane (all Chat→AI Studio/Vertex traffic and all Gemini-inbound traffic):
  `src/chat/inbound.ts:224` `toolCallsToItems` spreads the normalized `extra_content` onto each pushed
  `function_call` item; `parser.ts:532` already turns it into `providerMetadata`.
- Inbound, Antigravity direct lane: `chat-ir.ts` `pushToolCall` gets the same normalized metadata (keeps the
  chat-ir/bridge parity contract); one `extra_content` fixture joins `tests/responses/protocol-chat-ir-parity.test.ts`.
- Outbound, `src/chat/outbound.ts` (primary: `directEncoders` defaults off, `src/protocols/settings.ts:104`):
  stream `emitToolCall` gains an `extra` argument fed from `output_item.done` `item.extra_content` (normalized);
  buffered `function_call` branch (~:970) copies it; `collectChatCompletion` (~:1220-1294) keeps it per tool index
  so SSE-folded bodies (also the direct lane's non-stream `collectChatCompletionResponse`) carry it.
- Outbound, direct lane: `adapter-events.ts` passes `providerMetadata` from `tool_call_start` on `toolDone`;
  `encoders/chat.ts` `emitToolCall` writes it. Emission is self-gating: only `google.ts` sets provider metadata.
- The direct lane does remember signatures server-side (`client-encoder-delivery.ts:167` folds through
  `buildResponseJSON`, `response-json.ts:376`), so the combined two-turn test calls
  `resetThoughtSignatureReplayForTests()` between turns; the echo-only test uses a fresh call id.
- Native Chat isolation: `src/server/chat-native-eligibility.ts:45-49` forwards message objects verbatim; a body
  whose assistant `tool_calls[]` carry `extra_content` declines native Chat with the existing
  `opaque-state-stripped` reason, so Google opaque state never reaches another vendor (the bridge drops it,
  no non-Google adapter serializes provider metadata).

3b details: capture `pendingThoughtSignature` before the thought-text and signature-only early returns, scoped
per content (reset each turn); `StreamTool` gains `signature` from `delta.tool_calls[].extra_content`; buffered
reads `call.extra_content`; parallel calls sign only the call that carried it.

3c details: read with `readJsonRequestBody` + `createTranslatorBudget` under the inbound limit; resolve the route with
`findOllamaRoute` + `routeAllowedByScope` (404 unknown or out of scope); parse with the bridge Chat path
`chatConversationToIr` (cheaper than `chatToResponsesBody` → `parseRequest`), then
`estimateInputTokens({ ...parsed, modelId })` with the route's provider; 400 for codec/Chat errors, 413 for size;
wired only for `countTokens` (embed stays 501); `supportedGenerationMethods` gains `countTokens`.

3d precedence (never guessed): `inputTokenLimit` = configured max input / context window
(`src/codex/catalog/model-hints.ts`) ?? `customModels[].contextWindow` ?? `getModelMetadata(provider, model)?.contextWindow`;
`outputTokenLimit` = `customModels[].maxOutputTokens` ?? `getModelMetadata(...)?.maxTokens`; absent when unknown.

3e: also `405: "UNIMPLEMENTED"`.

Tests (first, failing on baa5dfbadb): `tests/responses/chat-google-thought-signature.test.ts` covers both lanes ×
stream/buffered surfacing, echo-only signing, store reset between turns, malformed and oversized echoes answering
200 without a signature, and no `extra_content` on non-Google routes; a native-Chat decline test; the Gemini inbound
two-turn signature test, countTokens and token-limit tests in a sibling of `server-gemini-inbound.test.ts`.


## As built (cycle 4)

Implemented as the revised stale-check section describes, after two audit rounds (FAIL, then NEAR-PASS).
`normalizedClientExtraContent` (in `src/responses/provider-opaque-metadata.ts`) is the one normalizer every site
uses. The structure doc for the Chat carrier is `structure/data-planes/chat-reasoning-details.md` (moved there
because `inbound-compat.md` is at its 600-line budget), which now also owns `src/server/chat-native-eligibility.ts`.
Red evidence: `.tmp/t030-red-all.log` (13 of 26 new or extended cases fail with the source changes set aside).
Residual: a client that does not echo `extra_content` still relies on the server-side store, which the bridge and the
direct lane both write; the Antigravity chat-ir inbound path is covered by the parity fixture.

