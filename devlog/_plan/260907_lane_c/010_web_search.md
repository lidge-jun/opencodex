# 3839 implementation contract

Carry public source patch with -x. Add deterministic 64KiB SSE and HTTP error-body regressions including cancel that never settles. Preserve complete prefix frames and discard incomplete tail. Tests use public run/parse APIs and controlled byte streams.

Validation: local tests/typecheck/build/install NOT RUN by instruction. Read diff and source; top remote CI exercises changed test paths. Each conditional branch listed above is exercised by controlled fixtures; screenshot inspects GUI state. No new enforcement layer; existing API guards remain authoritative.

## Public source diff (MODIFY/NEW paths)

```diff
diff --git a/src/web-search/anthropic-executor.ts b/src/web-search/anthropic-executor.ts
index 1eb206afa..cd3893900 100644
--- a/src/web-search/anthropic-executor.ts
+++ b/src/web-search/anthropic-executor.ts
@@ -5,7 +5,11 @@ import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "../adapters/client-fin
 import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
 import { sidecarEnter } from "../lib/sidecar-tracker";
 import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
-import type { WebSearchSource } from "./parse";
+import {
+  MAX_SIDECAR_RESPONSE_BYTES,
+  cancelReaderWithoutWaiting,
+  type WebSearchSource,
+} from "./parse";
 import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";
 
 /** Hardcoded per-turn search bound handed to the server tool (mirrors the loop's maxSearches intent). */
@@ -17,6 +21,33 @@ function isRec(v: unknown): v is Record<string, unknown> {
   return !!v && typeof v === "object" && !Array.isArray(v);
 }
 
+/** Read at most `MAX_SIDECAR_RESPONSE_BYTES` of an untrusted upstream body, then stop reading. */
+async function readBoundedText(res: Response): Promise<string> {
+  if (!res.body) return "";
+  const reader = res.body.getReader();
+  const decoder = new TextDecoder();
+  let out = "";
+  let seen = 0;
+  try {
+    for (;;) {
+      const { done, value } = await reader.read();
+      if (done) break;
+      const remaining = MAX_SIDECAR_RESPONSE_BYTES - seen;
+      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
+      seen += accepted.byteLength;
+      out += decoder.decode(accepted, { stream: true });
+      if (seen >= MAX_SIDECAR_RESPONSE_BYTES) {
+        cancelReaderWithoutWaiting(reader, "sidecar error body byte limit reached");
+        break;
+      }
+    }
+    out += decoder.decode();
+  } catch {
+    /* a failed error-body read must not mask the HTTP status we are about to report */
+  }
+  return out;
+}
+
 /**
  * Fold an Anthropic Messages SSE stream (a web_search_20250305 turn) into a WebSearchResult.
  *
@@ -41,6 +72,7 @@ export async function parseAnthropicSidecarSSE(res: Response): Promise<SidecarOu
   const decoder = new TextDecoder();
   const reader = res.body.getReader();
   let buffer = "";
+  let responseBytes = 0;
 
   const handleFrame = (data: Record<string, unknown>): void => {
     const type = typeof data.type === "string" ? data.type : "";
@@ -82,15 +114,27 @@ export async function parseAnthropicSidecarSSE(res: Response): Promise<SidecarOu
     for (;;) {
       const { done, value } = await reader.read();
       if (done) break;
+      // A sidecar that never emits a frame separator would otherwise grow `buffer` without
+      // limit. Bound the accepted bytes exactly like the Responses sidecar parser does.
+      const remaining = MAX_SIDECAR_RESPONSE_BYTES - responseBytes;
+      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
+      responseBytes += accepted.byteLength;
       // Normalize CRLF on the ACCUMULATED buffer so a `\r\n` pair split across two network chunks
       // (chunk ends in `\r`, next starts with `\n`) still collapses to `\n` (audit round-2 F2).
-      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
+      buffer = (buffer + decoder.decode(accepted, { stream: true })).replace(/\r\n/g, "\n");
       let sep: number;
       while ((sep = buffer.indexOf("\n\n")) !== -1) {
         const rawFrame = buffer.slice(0, sep);
         buffer = buffer.slice(sep + 2);
         processFrame(rawFrame);
       }
+      if (responseBytes >= MAX_SIDECAR_RESPONSE_BYTES) {
+        // Keep the frames already folded above, drop the unterminated tail, and do not wait on
+        // upstream teardown.
+        cancelReaderWithoutWaiting(reader, "sidecar response byte limit reached");
+        buffer = "";
+        break;
+      }
     }
     // Flush the decoder and process any final unterminated frame (a stream that ends without \n\n).
     buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
@@ -177,7 +221,9 @@ export async function runAnthropicWebSearch(
     // (found investigating #1419).
     const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
     if (!res.ok) {
-      const t = await res.text().catch(() => "");
+      // Untrusted upstream error bodies are only used for an auth-failure message, so read a
+      // bounded prefix instead of buffering an arbitrarily large response.
+      const t = await readBoundedText(res);
       detachBodyGuard();
       console.warn(`[web-search] anthropic sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
       if (res.status === 401) {
diff --git a/src/web-search/parse.ts b/src/web-search/parse.ts
index 757c309f3..7ba5d2607 100644
--- a/src/web-search/parse.ts
+++ b/src/web-search/parse.ts
@@ -193,7 +193,7 @@ function fromOutputArray(output: OutputItem[], seen: Set<string>): WebSearchResu
   return { text, sources };
 }
 
-function cancelReaderWithoutWaiting(
+export function cancelReaderWithoutWaiting(
   reader: ReadableStreamDefaultReader<Uint8Array>,
   reason: string,
 ): void {
diff --git a/tests/web-search/web-search-anthropic.test.ts b/tests/web-search/web-search-anthropic.test.ts
index f5b7f1df2..33f2616cc 100644
--- a/tests/web-search/web-search-anthropic.test.ts
+++ b/tests/web-search/web-search-anthropic.test.ts
@@ -130,6 +130,27 @@ describe("parseAnthropicSidecarSSE", () => {
     expect(out.error).toBeDefined();
   });
 
+  test("an unterminated frame cannot buffer the stream without bound", async () => {
+    // A sidecar that never emits a frame separator: without a cap the parser would accumulate
+    // the whole stream in memory before it could fold anything.
+    let produced = 0;
+    let cancelled = false;
+    const chunk = new TextEncoder().encode(`data: {"filler":"${"x".repeat(64 * 1024)}"}`);
+    const body = new ReadableStream<Uint8Array>({
+      pull(c) {
+        if (produced > 8 * 1024 * 1024) { c.close(); return; }
+        produced += chunk.byteLength;
+        c.enqueue(chunk);
+      },
+      cancel() { cancelled = true; },
+    });
+    const out = await parseAnthropicSidecarSSE(new Response(body, { status: 200 }));
+    expect(cancelled).toBe(true);
+    // The cap stops the read long before the producer would have finished on its own.
+    expect(produced).toBeLessThan(1024 * 1024);
+    expect(out.text).toBe("");
+  });
+
   test("empty results (content:[]) with answer text is a success, not an error", async () => {
     const res = sseResponse([
       { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_3", content: [] } },

```
