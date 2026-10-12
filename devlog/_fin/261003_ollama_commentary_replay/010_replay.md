# Keep unresolved native batches open across commentary

Depends on: roadmap/unlock only; runtime independent of the Antigravity slice. Carry #6509 at de5bb1f215c613670e03585e918a344c510ba97a on a separate own branch from current dev.

MODIFY the four files in the exact proposed source diff below, adapting only current-base conflicts. PendingToolBatch.unresolvedCount is created from wireCalls.length, decremented only after validated result attachment and consumed only by the no-new-call assistant deferral branch. It is request-local internal state: serialization/deserialization N/A; no persisted or public API field.

The new branch activates with an open batch, unresolvedCount > 0, assistant role and no extracted calls. It defers assistant text/thinking until flushPending emits genuine results in original call order and then releaseDeferred emits conversation arrival order. New tool-call batches and EOF settle missing results with existing unknown markers. Fully resolved batches flush before normal assistant turns. Validation remains before decrement: unknown/duplicate/name/namespace results reject; invalid/reused call IDs retain their existing rules. No parsed input mutation.

## Negative verification delta beyond source PR

MODIFY tests/providers/ollama/ollama-native.test.ts (existing uncapped file; no new registry entries): construct batches with commentary interleaved before orphan IDs, duplicate result IDs, mismatched tool names and mismatched namespaces; each must throw the existing error. Add old-batch result after a new tool-call batch (must reject), unresolved EOF (must emit exactly one unknown result before commentary), fully resolved result then commentary (must not defer past subsequent conversation), reverse-arrival results in a multi-call batch (must output call order), and deep-frozen parsed context with nested content/call argument objects (must build unchanged). Assert output payload order and values rather than internal counters. Keep all existing malformed-input tests.

Commands planned, NOT RUN under initial gate: bun test tests/providers/ollama/ollama-native.test.ts; native-parser/native-v4/native-reasoning-wire/native-structured-output files in separate Bun processes; tests/adapters/adapter-tool-conformance.test.ts and adapter-buffered-tool-conformance.test.ts; typecheck/privacy/structure/layout/file-size/test:changed gates. Document full-local-suite exception for concurrent worktrees. No live Ollama service is assumed; absence is an explicit evidence limit.

Review all src/adapters ownership docs; preserve OpenAI behavior and touch only the Ollama paragraph in chat-compat. User docs describe observed contract, never promise caller-side physical tool execution. Independent code/security review and applicable exact-head CI are required. Source #6509 stays open.

Credit: Co-authored-by: potota90 <85318310+adtumk@users.noreply.github.com>.

## Executable source delta

```diff
diff --git a/docs-site/src/content/docs/reference/adapters.md b/docs-site/src/content/docs/reference/adapters.md
index a765419710..c616f58a0e 100644
--- a/docs-site/src/content/docs/reference/adapters.md
+++ b/docs-site/src/content/docs/reference/adapters.md
@@ -118,6 +118,10 @@ be configured on a separately named custom or self-hosted Ollama provider with
   is refused rather than mis-sent, and remote image URLs are not fetched.
 - **Tools:** declared in Ollama's native shape, streamed tool calls are whole-call records with
   object-valued `arguments`, and tool-result replay is paired strictly by call id and tool name.
+  Codex may record assistant commentary before a pending call's results. Text/thinking with no
+  new tool calls is deferred until the batch is settled, so genuine results remain beside their
+  originating calls. A new tool-call batch still settles the preceding one; missing results retain
+  an explicit unknown-status marker, and orphan or duplicate results remain invalid.
   `tool_choice: "none"` and `auto` behave normally; **`required` or an exact named choice fails
   closed**, because Ollama's `/api/chat` has no `tool_choice` field to enforce it with.
 - **Structured output is refused on canonical Ollama Cloud.** Ollama currently documents structured
diff --git a/src/adapters/ollama-native.ts b/src/adapters/ollama-native.ts
index 2f95c5dbdc..b180d1f1d5 100644
--- a/src/adapters/ollama-native.ts
+++ b/src/adapters/ollama-native.ts
@@ -77,6 +77,7 @@ interface PendingToolCall {
 interface PendingToolBatch {
   calls: PendingToolCall[];
   byId: Map<string, PendingToolCall>;
+  unresolvedCount: number;
 }

 interface NativeStreamToolCall {
@@ -302,6 +303,12 @@ function assistantTextThinkingAndCalls(message: OcxAssistantMessage): {
   };
 }

+/**
+ * Build native replay messages without mutating the parsed history. Keep tool results
+ * beside their originating batch, deferring intervening conversation until settlement.
+ * Reserve replayed call IDs for response translation and mark missing results explicitly.
+ * @throws When call IDs are invalid or results are orphaned, duplicated, or mismatched.
+ */
 function buildNativeMessages(
   parsed: OcxParsedRequest,
   reservedToolCallIds: Set<string>,
@@ -323,12 +330,14 @@ function buildNativeMessages(
   // early. The openai-chat adapter defers them the same way; refusing the replay killed the turn.
   let deferred: OllamaNativeMessage[] = [];

+  /** Emit held conversation messages in their recorded arrival order after settlement. */
   const releaseDeferred = (): void => {
     if (deferred.length === 0) return;
     messages.push(...deferred);
     deferred = [];
   };

+  /** Settle the open batch with genuine results or unknown markers, then release deferred messages. */
   const flushPending = (): void => {
     if (!pending) return;
     for (const call of pending.calls) {
@@ -376,13 +385,14 @@ function buildNativeMessages(
         throw new Error(`ollama-native tool result ${message.toolCallId} names the wrong originating tool`);
       }
       call.result = message;
+      pending.unresolvedCount--;
       continue;
     }

     // Native Ollama requires the whole assistant tool-call turn followed by its tool results. A
     // conversational message that arrives while the batch is still open is held aside instead of
     // closing it, so the call keeps its results adjacent; it is released right after the batch
-    // flushes. Anything else (a new assistant turn) settles the batch first.
+    // flushes. A new assistant tool-call batch settles the preceding batch first.
     if (pending) {
       if (message.role === "user" || message.role === "developer") {
         const translated = message.role === "user"
@@ -393,6 +403,19 @@ function buildNativeMessages(
           : { role: "system", content: translated.content });
         continue;
       }
+      if (message.role === "assistant" && pending.unresolvedCount > 0) {
+        const extracted = assistantTextThinkingAndCalls(message);
+        if (extracted.calls.length === 0) {
+          // Commentary can follow the call items but precede their recorded results.
+          // Keep the batch open and release its text/thinking after the actual results.
+          deferred.push({
+            role: "assistant",
+            content: extracted.content,
+            ...(extracted.thinking ? { thinking: extracted.thinking } : {}),
+          });
+          continue;
+        }
+      }
       flushPending();
     }

@@ -443,7 +466,11 @@ function buildNativeMessages(
         };
         messages.push(native);
         if (wireCalls.length > 0) {
-          pending = { calls: wireCalls, byId: new Map(wireCalls.map(call => [call.id, call])) };
+          pending = {
+            calls: wireCalls,
+            byId: new Map(wireCalls.map(call => [call.id, call])),
+            unresolvedCount: wireCalls.length,
+          };
         }
         break;
       }
diff --git a/structure/providers/chat-compat.md b/structure/providers/chat-compat.md
index a469a3c8ef..740bb7a115 100644
--- a/structure/providers/chat-compat.md
+++ b/structure/providers/chat-compat.md
@@ -122,13 +122,13 @@ and synthesizing explicit "no tool result was recorded" answers only when no rea
 (Kimi/Moonshot 400 `ocx-mrqaiw05-269`; unit `devlog/_fin/260718_dangling_toolcall_hardening`).

 The native Ollama wire carries the same contract. `src/adapters/ollama-native.ts`
-`buildNativeMessages` defers `user`/`developer` messages that arrive while a batch is open and
-releases them after the tool messages, and answers a call with no result anywhere in the replayed
-history with the same `[ocx] no tool result was recorded for "<name>"` marker. The shape it
-absorbs is ordinary Codex history, not a malformed one: Codex records mid-turn items (a
-`PostToolUse` hook verdict, a context notice) between an assistant `tool_calls` message and that
-call's own result. The strict pair checks (orphan result, duplicate result, result naming another
-tool) still throw on both wires (#4842).
+`buildNativeMessages` defers `user`/`developer` messages while a batch is open; assistant text/thinking
+with no new tool calls is also deferred while results remain outstanding. Deferred messages retain
+arrival order after recorded results. An unresolved counter avoids rescanning calls per message.
+A new tool-call batch settles its predecessor; completed batches keep subsequent messages in place.
+Codex can record hook notices or commentary between calls and results. Missing results keep the
+`[ocx] no tool result was recorded for "<name>"` marker; orphan IDs, duplicates, and mismatched names
+still throw (#4842). `tests/providers/ollama/ollama-native.test.ts` covers replay and compaction.

 Forward-mode OpenAI passthrough also repairs replayed `call_id` values longer than the Responses
 API's 64-character limit. Sidechat/fork replay can namespace routed-provider ids beyond that limit,
diff --git a/tests/providers/ollama/ollama-native.test.ts b/tests/providers/ollama/ollama-native.test.ts
index 44a09e8a8c..c17e5c1967 100644
--- a/tests/providers/ollama/ollama-native.test.ts
+++ b/tests/providers/ollama/ollama-native.test.ts
@@ -9,12 +9,14 @@ import { getProviderRegistryEntry } from "../../../src/providers/registry";
 import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";
 import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

+/** Discover routed test models with provider fetches stubbed to avoid live requests. */
 const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
   gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

 /** The four ids this transport is maintained against. */
 const TARGETS = ["glm-5.3-flash", "deepseek-v4-flash:0731", "glm-5.2", "kimi-k3"] as const;

+/** Configure a native Ollama test provider with inert credentials and caller overrides. */
 function ollamaProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
   return {
     adapter: "ollama-native",
@@ -28,6 +30,7 @@ function ollamaProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProvider
   } as OcxProviderConfig;
 }

+/** Build a minimal streamed replay request from synthetic messages and caller options. */
 function parsedWith(
   messages: unknown[],
   options: Record<string, unknown> = {},
@@ -285,6 +288,120 @@ describe("ollama-native — request shape", () => {
     expect(messages[3].content).toBe("[hook] design findings requiring review");
   });

+  test("assistant commentary before parallel results keeps the original batch open", async () => {
+    const adapter = createOllamaNativeAdapter(ollamaProvider());
+    const { body } = await adapter.buildRequest(parsedWith([
+      {
+        role: "assistant",
+        content: [
+          { type: "toolCall", id: "call_commentary_first", name: "exec", arguments: { input: "text('first')" } },
+          { type: "toolCall", id: "call_commentary_second", name: "exec", arguments: { input: "text('second')" } },
+        ],
+        timestamp: 1,
+      },
+      { role: "assistant", content: [{ type: "text", text: "checking both results" }], timestamp: 2 },
+      { role: "toolResult", toolCallId: "call_commentary_second", toolName: "exec", content: "second result", isError: false, timestamp: 3 },
+      { role: "toolResult", toolCallId: "call_commentary_first", toolName: "exec", content: "first result", isError: false, timestamp: 4 },
+    ]));
+    const messages = JSON.parse(String(body)).messages;
+    expect(messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "tool", "assistant"]);
+    expect(messages[1]).toMatchObject({ tool_call_id: "call_commentary_first", content: "first result" });
+    expect(messages[2]).toMatchObject({ tool_call_id: "call_commentary_second", content: "second result" });
+    expect(messages[3].content).toBe("checking both results");
+  });
+
+  test("assistant commentary after one parallel result preserves the remaining genuine result", async () => {
+    const adapter = createOllamaNativeAdapter(ollamaProvider());
+    const { body } = await adapter.buildRequest(parsedWith([
+      {
+        role: "assistant",
+        content: [
+          { type: "toolCall", id: "call_partial_first", name: "exec", arguments: {} },
+          { type: "toolCall", id: "call_partial_second", name: "exec", arguments: {} },
+        ],
+        timestamp: 1,
+      },
+      { role: "toolResult", toolCallId: "call_partial_first", toolName: "exec", content: "first done", isError: false, timestamp: 2 },
+      { role: "assistant", content: [{ type: "text", text: "waiting for the second result" }], timestamp: 3 },
+      { role: "toolResult", toolCallId: "call_partial_second", toolName: "exec", content: "second done", isError: false, timestamp: 4 },
+    ]));
+    const messages = JSON.parse(String(body)).messages;
+    expect(messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "tool", "assistant"]);
+    expect(messages[1].content).toBe("first done");
+    expect(messages[2].content).toBe("second done");
+    expect(messages[3].content).toBe("waiting for the second result");
+  });
+
+  test("deferred assistant text and thinking retain their order without mutating parsed history", async () => {
+    const parsed = parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_thinking", name: "exec", arguments: {} }], timestamp: 1 },
+      { role: "developer", content: "context notice", timestamp: 2 },
+      { role: "assistant", content: [{ type: "text", text: "first comment" }, { type: "thinking", thinking: "synthetic reasoning" }], timestamp: 3 },
+      { role: "assistant", content: [{ type: "text", text: "second comment" }], timestamp: 4 },
+      { role: "toolResult", toolCallId: "call_thinking", toolName: "exec", content: "recorded result", isError: false, timestamp: 5 },
+    ]);
+    const original = JSON.stringify(parsed);
+    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
+    const messages = JSON.parse(String(body)).messages;
+    expect(messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "system", "assistant", "assistant"]);
+    expect(messages[1].content).toBe("recorded result");
+    expect(messages[2].content).toBe("context notice");
+    expect(messages[3]).toMatchObject({ content: "first comment", thinking: "synthetic reasoning" });
+    expect(messages[4].content).toBe("second comment");
+    expect(JSON.stringify(parsed)).toBe(original);
+  });
+
+  test("assistant commentary after a complete batch keeps its existing wire position", async () => {
+    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_complete", name: "exec", arguments: {} }], timestamp: 1 },
+      { role: "toolResult", toolCallId: "call_complete", toolName: "exec", content: "done", isError: false, timestamp: 2 },
+      { role: "assistant", content: [{ type: "text", text: "completed comment" }], timestamp: 3 },
+      { role: "user", content: "next turn", timestamp: 4 },
+    ]));
+    const messages = JSON.parse(String(body)).messages;
+    expect(messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "assistant", "user"]);
+    expect(messages[1].content).toBe("done");
+    expect(messages[2].content).toBe("completed comment");
+    expect(messages[3].content).toBe("next turn");
+  });
+
+  test("a new tool-call batch still settles an unresolved batch after assistant commentary", async () => {
+    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_unfinished", name: "exec", arguments: {} }], timestamp: 1 },
+      { role: "assistant", content: [{ type: "text", text: "before the next batch" }], timestamp: 2 },
+      { role: "assistant", content: [{ type: "toolCall", id: "call_next", name: "exec", arguments: {} }], timestamp: 3 },
+      { role: "toolResult", toolCallId: "call_next", toolName: "exec", content: "next result", isError: false, timestamp: 4 },
+    ]));
+    const messages = JSON.parse(String(body)).messages;
+    expect(messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "assistant", "assistant", "tool"]);
+    expect(messages[1].tool_call_id).toBe("call_unfinished");
+    expect(messages[1].content).toContain("execution status unknown");
+    expect(messages[2].content).toBe("before the next batch");
+    expect(messages[4]).toMatchObject({ tool_call_id: "call_next", content: "next result" });
+  });
+
+  test("routed compaction preserves a result recorded after assistant commentary", async () => {
+    const parsed = parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_compaction", name: "exec", arguments: {} }], timestamp: 1 },
+      { role: "assistant", content: [{ type: "text", text: "commentary before compaction" }], timestamp: 2 },
+      { role: "toolResult", toolCallId: "call_compaction", toolName: "exec", content: "genuine result", isError: false, timestamp: 3 },
+      { role: "user", content: "summarize this history", timestamp: 4 },
+    ], { toolChoice: "none" });
+    parsed._compactionRequest = true;
+    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
+    const request = JSON.parse(String(body));
+    expect(request.messages.map((message: { role: string }) => message.role))
+      .toEqual(["assistant", "tool", "assistant", "user"]);
+    expect(request.messages[1]).toMatchObject({ tool_call_id: "call_compaction", content: "genuine result" });
+    expect(request.messages[2].content).toBe("commentary before compaction");
+    expect(request.tools).toBeUndefined();
+  });
+
   test("a deferred user message keeps its text and images after the tool result", async () => {
     const adapter = createOllamaNativeAdapter(ollamaProvider());
     const png = "data:image/png;base64,iVBORw0KGgo=";

```

## Exact additional regression block

Append this block to the existing uncapped native test file; no shared registry mutation is required. It reuses parsedWith/ollamaProvider and tests the public adapter boundary.

```typescript

describe("ollama-native commentary validation and replay ownership", () => {
  const call = (id = "call_guard") => ({
    role: "assistant", content: [{ type: "toolCall", id, name: "exec", namespace: "ops", arguments: { cmd: "pwd" } }], timestamp: 1,
  });
  const commentary = { role: "assistant", content: [{ type: "text", text: "Working." }], timestamp: 2 };
  const result = (id = "call_guard") => ({
    role: "toolResult", toolCallId: id, toolName: "exec", toolNamespace: "ops", content: "done", isError: false, timestamp: 3,
  });

  for (const [label, invalid, error] of [
    ["unknown id", { ...result(), toolCallId: "call_other" }, /has no originating call/],
    ["wrong name", { ...result(), toolName: "other" }, /names the wrong originating tool/],
    ["wrong namespace", { ...result(), toolNamespace: "other" }, /names the wrong originating tool/],
  ] as const) {
    test(`commentary does not bypass result validation: ${label}`, () => {
      const adapter = createOllamaNativeAdapter(ollamaProvider());
      expect(() => adapter.buildRequest(parsedWith([call(), commentary, invalid]))).toThrow(error);
    });
  }

  test("duplicate results remain rejected while commentary holds an unresolved batch", () => {
    const first = call("first");
    const second = call("second");
    const batch = { ...first, content: [...first.content, ...second.content] };
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    expect(() => adapter.buildRequest(parsedWith([batch, result("first"), commentary, result("first")]))).toThrow(/duplicate tool result/);
  });

  test("a result cannot cross a subsequent tool-call batch", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    expect(() => adapter.buildRequest(parsedWith([call("old"), commentary, call("new"), result("old")]))).toThrow(/has no originating call/);
  });

  for (const id of ["", "call_guard"]) {
    test(`new batches still reject ${id ? "reused" : "empty"} call IDs after commentary`, () => {
      const adapter = createOllamaNativeAdapter(ollamaProvider());
      expect(() => adapter.buildRequest(parsedWith([call(), commentary, call(id)]))).toThrow(/id is missing or duplicated/);
    });
  }

  test("EOF settles a missing result once before deferred commentary", () => {
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([call(), commentary]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(messages[1].tool_call_id).toBe("call_guard");
    expect(messages[1].content).toContain("execution status unknown");
    expect(messages[2].content).toBe("Working.");
  });

  test("completed batches release commentary before the next conversation turn", () => {
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
      call(), result(), commentary, { role: "user", content: "next" }, call("next"), result("next"),
    ]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "assistant", "user", "assistant", "tool"]);
    expect(messages[2].content).toBe("Working.");
    expect(messages[3].content).toBe("next");
    expect(messages[5].tool_call_id).toBe("next");
  });

  test("deep-frozen history keeps call order, deferred arrival order and original arguments", () => {
    const first = call("first");
    const second = call("second");
    const batch = { ...first, content: [...first.content, ...second.content] };
    const parsed = parsedWith([
      batch,
      { role: "developer", content: "hook" },
      result("second"),
      { role: "assistant", content: [{ type: "thinking", thinking: "Checking." }, { type: "text", text: "Working." }] },
      { role: "user", content: "notice" },
      result("first"),
    ]);
    function freeze(value: unknown): void {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    const before = JSON.stringify(parsed);
    freeze(parsed);
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
    expect(JSON.stringify(parsed)).toBe(before);
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "tool", "system", "assistant", "user"]);
    expect(messages.slice(1, 3).map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(["first", "second"]);
    expect(messages.slice(3).map((message: { content: string }) => message.content)).toEqual(["hook", "Working.", "notice"]);
    expect(messages[4].thinking).toBe("Checking.");
    expect(messages[0].tool_calls[0].function.arguments).toEqual({ cmd: "pwd" });
  });
});
```
