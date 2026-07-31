# 100.52 — Error and Header Fidelity Implementation Plan

## Objective

Phase 100.5 makes translated opencodex failures look more like native Codex Responses failures.

Codex RS classifies streaming failures from:

```text
response.failed.response.error.code
```

Current opencodex translated streams only emit:

```text
response.failed.response.last_error
```

That makes context-window, quota, and rate-limit failures look like generic stream errors. This phase
adds a shared error classifier, emits both `error` and `last_error` for streaming compatibility, and
tightens passthrough header sanitization without fabricating rate-limit headers.

## Evidence

Upstream Codex parser evidence:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:347
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:532
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:557
```

Local gap:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
```

## Files

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/src/errors.ts
```

Complete content:

```ts
export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
  const text = message.toLowerCase();
  if (text.includes("context_length_exceeded") || text.includes("context window") || text.includes("context length") || text.includes("maximum context") || text.includes("too many tokens")) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (text.includes("insufficient_quota") || text.includes("quota exceeded") || text.includes("exceeded your current quota")) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (status === 401 || status === 403 || type === "authentication_error") {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
```

Import classifier:

```diff
 import type { AdapterEvent, OcxUsage } from "./types";
+import { classifyError } from "./errors";
```

Add a helper near `responsesUsage()`:

```diff
+function responseError(status: number, type: string, message: string): Record<string, unknown> {
+  return classifyError(status, type, message);
+}
```

Update adapter error event:

```diff
               emit("response.failed", {
                 response: {
                   ...responseSnapshot("failed", finishedItems),
-                  last_error: { type: "upstream_error", message: event.message },
+                  error: responseError(502, "upstream_error", event.message),
+                  last_error: responseError(502, "upstream_error", event.message),
                 },
               });
```

Update caught bridge exception:

```diff
         emit("response.failed", {
           response: {
             ...responseSnapshot("failed", finishedItems),
-            last_error: { type: "proxy_error", message: err instanceof Error ? err.message : String(err) },
+            error: responseError(500, "proxy_error", err instanceof Error ? err.message : String(err)),
+            last_error: responseError(500, "proxy_error", err instanceof Error ? err.message : String(err)),
           },
         });
```

Update JSON error formatter:

```diff
-export function formatErrorResponse(status: number, type: string, message: string): Response {
-  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
+export function formatErrorResponse(status: number, type: string, message: string): Response {
+  return new Response(JSON.stringify({ error: classifyError(status, type, message) }), {
     status, headers: { "Content-Type": "application/json" },
   });
 }
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
```

Expand hop-by-hop/stale header drops:

```diff
-  const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
+  const DROP = new Set([
+    "content-encoding",
+    "content-length",
+    "transfer-encoding",
+    "connection",
+    "keep-alive",
+    "proxy-authenticate",
+    "proxy-authorization",
+    "te",
+    "trailer",
+    "upgrade",
+  ]);
```

This keeps truthful upstream headers such as `x-ratelimit-*`, `openai-*`, `request-id`,
`content-type`, and model/version headers. It does not synthesize rate-limit headers because
opencodex does not have complete upstream quota telemetry for translated providers.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/error-fidelity.test.ts
```

Complete content:

```ts
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, formatErrorResponse } from "../src/bridge";
import { classifyError } from "../src/errors";
import { sanitizePassthroughHeaders } from "../src/server";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
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
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

describe("error fidelity", () => {
  test("classifyError maps Codex-recognized context/quota/rate failures", () => {
    expect(classifyError(400, "upstream_error", "Your input exceeds the context window")).toMatchObject({
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    expect(classifyError(429, "upstream_error", "Rate limit reached for model")).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(classifyError(402, "upstream_error", "You exceeded your current quota")).toMatchObject({
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
  });

  test("formatErrorResponse returns OpenAI-compatible classified error envelope", async () => {
    const response = formatErrorResponse(429, "upstream_error", "Rate limit reached for model");
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Rate limit reached for model",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
  });

  test("streaming response.failed includes both error and last_error", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "error", message: "Your input exceeds the context window" },
    ]), "routed/model"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    expect(failed.last_error).toEqual(failed.error);
  });

  test("sanitizePassthroughHeaders drops stale and hop-by-hop headers while preserving rate-limit metadata", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "content-encoding": "gzip",
      "content-length": "12",
      "connection": "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "te": "trailers",
      "trailer": "x-checksum",
      "upgrade": "websocket",
      "x-ratelimit-limit-requests": "100",
      "openai-model": "gpt-5.5",
      "content-type": "application/json",
    }));
    expect(sanitized.has("content-encoding")).toBe(false);
    expect(sanitized.has("content-length")).toBe(false);
    expect(sanitized.has("connection")).toBe(false);
    expect(sanitized.has("keep-alive")).toBe(false);
    expect(sanitized.has("proxy-authenticate")).toBe(false);
    expect(sanitized.has("te")).toBe(false);
    expect(sanitized.has("trailer")).toBe(false);
    expect(sanitized.has("upgrade")).toBe(false);
    expect(sanitized.get("x-ratelimit-limit-requests")).toBe("100");
    expect(sanitized.get("openai-model")).toBe("gpt-5.5");
    expect(sanitized.get("content-type")).toBe("application/json");
  });
});
```

## Verification

Run:

```bash
bun test tests/error-fidelity.test.ts tests/bridge.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected result:

```text
error fidelity tests pass
full test suite passes
typecheck passes
diff whitespace check passes
```

## Commit

Commit as:

```text
[agent] fix: align error and header fidelity
```
