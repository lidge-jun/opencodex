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

