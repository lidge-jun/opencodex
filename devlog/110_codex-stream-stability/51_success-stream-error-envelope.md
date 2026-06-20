# 110.51 — F1: Inline Error Envelope Inside a 200 Success Stream

## Objective

A chat/completions upstream can return **HTTP 200** and then emit an **inline error envelope**
mid-stream — `data: {"error": {"message": "...", "code": "..."}}` — instead of a clean
`[DONE]`. Today `openai-chat.ts` and `google.ts` **silently swallow** that frame (it has no
`choices`, so the loop `continue`s), then fall through to a post-loop `done`. The bridge turns
that into a `response.completed` with **truncated content**: Codex reports success, the user
sees a half-answer, and the real upstream error is lost.

The fix: detect a top-level `error` field after JSON-parsing each frame and `yield { type:
"error", message }`. The bridge already converts an adapter `error` event into a classified
`response.failed` (`bridge.ts:322-336`), so this reuses the entire existing failure path —
the change is one guard per adapter. `anthropic.ts` already handles this via its
`case "error"` (`anthropic.ts:277-280`); only the OpenAI-chat and Google adapters need it.

## Evidence

Codex consumes a classified failure correctly (stable checkout):

```text
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:318  is_context_window_error / classification flow
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:513-535  is_*_error recognized codes
```

opencodex gap (200-stream inline error is dropped):

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:189-204  JSON.parse → usage → choices; no error branch
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:142-146       JSON.parse → candidates; no error branch
```

opencodex already-correct sink (reused unchanged):

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:322-336  case "error" → response.failed { error, last_error } (classified)
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts:277-280  case "error" (already present)
```

## Files

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
```

Insert an inline-error guard immediately after the JSON parse, before the `usage` check
(current lines 189-196):

```diff
             let chunk: Record<string, unknown>;
             try {
               chunk = JSON.parse(payload) as Record<string, unknown>;
             } catch {
               continue;
             }
 
+            // A 200/OK chat-completions stream may carry an inline provider error envelope
+            // instead of a clean [DONE]. Surface it as a terminal error so the bridge emits a
+            // classified response.failed (bridge.ts:322) — never a truncated response.completed.
+            if (chunk.error) {
+              const err = chunk.error as { message?: string } | undefined;
+              if (currentToolCallId) yield { type: "tool_call_end" };
+              yield { type: "error", message: err?.message ?? "upstream error" };
+              return;
+            }
+
             if (chunk.usage) {
               pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);
               continue;
             }
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts
```

Insert the same guard after the JSON parse, before the `candidates` check (current lines 142-146).
Gemini surfaces stream errors as a top-level `error` object:

```diff
             let chunk: Record<string, unknown>;
             try { chunk = JSON.parse(payload); } catch { continue; }
 
+            // Inline provider error inside a 200 stream → terminal error (see openai-chat.ts).
+            if (chunk.error) {
+              const err = chunk.error as { message?: string } | undefined;
+              yield { type: "error", message: err?.message ?? "upstream error" };
+              return;
+            }
+
             const candidates = chunk.candidates as { content?: { parts?: unknown[] }; finishReason?: string }[] | undefined;
             if (!candidates?.length) continue;
```

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/adapter-error-inline.test.ts
```

Complete content:

```ts
import { describe, expect, test } from "bun:test";
import { openaiChatAdapter } from "../src/adapters/openai-chat";
import { googleAdapter } from "../src/adapters/google";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n").map(f => f.trim()).filter(f => f && f !== "data: [DONE]").map(frame => {
    const lines = frame.split("\n");
    const event = lines.find(l => l.startsWith("event: "))?.slice(7);
    const dataLine = lines.find(l => l.startsWith("data: "));
    return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
  });
}

describe("inline error envelope in a 200 stream", () => {
  test("openai-chat yields a terminal error, not silent truncation", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"Rate limit reached for model","code":"rate_limit_exceeded"}}\n\n',
    ]);
    const events = await collect(openaiChatAdapter.parseStream(res));
    expect(events.some(e => e.type === "error")).toBe(true);
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "Rate limit reached for model" });
  });

  test("google yields a terminal error on an inline error frame", async () => {
    const res = sseResponse([
      'data: {"error":{"message":"RESOURCE_EXHAUSTED","code":429}}\n\n',
    ]);
    const events = await collect(googleAdapter.parseStream(res));
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "RESOURCE_EXHAUSTED" });
  });

  test("bridge converts the adapter error into a classified response.failed", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "par" };
      yield { type: "error", message: "Rate limit reached for model" };
    }
    const frames = await collectSse(bridgeToResponsesSSE(gen(), "routed/model"));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    expect((failed!.data.response as Record<string, unknown>).error).toMatchObject({ code: "rate_limit_exceeded" });
    expect(frames.some(f => f.event === "response.completed")).toBe(false);
  });
});
```

> If the adapter export names differ (`openaiChatAdapter` / `googleAdapter`), align the imports
> with the actual exports in `src/adapters/index.ts` during implementation — the test logic is
> unchanged.

## Verification

```bash
bun test tests/adapter-error-inline.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected:

```text
inline-error tests pass (openai-chat + google yield error; bridge emits response.failed, no response.completed)
full suite passes
typecheck clean
whitespace check clean
```

## Commit

```text
[agent] fix: surface inline provider error envelope in 200 streams
```
