# 3841 implementation contract

Carry public source patch with -x. Add 64KiB HTTP error-body and non-settling cancel regressions. Preserve complete description frames before cap; discard unfinished frame even at exact cap; retain downstream clamp. No credential-policy changes.

Validation: local tests/typecheck/build/install NOT RUN by instruction. Read diff and source; top remote CI exercises changed test paths. Each conditional branch listed above is exercised by controlled fixtures; screenshot inspects GUI state. No new enforcement layer; existing API guards remain authoritative.

## Public source diff (MODIFY/NEW paths)

```diff
diff --git a/src/vision/anthropic-describe.ts b/src/vision/anthropic-describe.ts
index 4f41017ef..280096f03 100644
--- a/src/vision/anthropic-describe.ts
+++ b/src/vision/anthropic-describe.ts
@@ -10,6 +10,8 @@ import type { DescribeOutcome, VisionSettings } from "./describe";
 const ANTHROPIC_VISION_MAX_TOKENS = 1024;
 const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
 const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
+/** Bound the sidecar SSE stream and its untrusted error body; the description is clamped downstream. */
+const MAX_SIDECAR_RESPONSE_BYTES = 64 * 1024;
 const DESCRIBE_INSTRUCTION =
   "You are a vision describer for a text-only model that cannot see the image. Describe the image " +
   "thoroughly and factually so that model can fully reason about it: transcribe any visible text " +
@@ -43,6 +45,34 @@ function buildImageBlock(imageUrl: string): { block?: AnthropicImageBlock; error
   return { error: "unsupported image URL scheme (expected data: or https:)" };
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
+        try { void reader.cancel("vision sidecar error body byte limit reached").catch(() => undefined); }
+        catch { /* best-effort body teardown */ }
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
 /** Fold Anthropic Messages text deltas into one description. Malformed frames are ignored. */
 export async function parseAnthropicVisionSSE(res: Response): Promise<DescribeOutcome> {
   if (!res.body) return { text: "", error: "anthropic vision sidecar returned no response body" };
@@ -52,6 +82,7 @@ export async function parseAnthropicVisionSSE(res: Response): Promise<DescribeOu
   const decoder = new TextDecoder();
   const reader = res.body.getReader();
   let buffer = "";
+  let responseBytes = 0;
 
   const processFrame = (rawFrame: string): void => {
     let dataLine = "";
@@ -76,12 +107,24 @@ export async function parseAnthropicVisionSSE(res: Response): Promise<DescribeOu
     for (;;) {
       const { done, value } = await reader.read();
       if (done) break;
-      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
+      // Frames only fold on a `\n\n` separator, so an upstream that never emits one would grow
+      // `buffer` for the whole response. Accept a bounded prefix instead.
+      const remaining = MAX_SIDECAR_RESPONSE_BYTES - responseBytes;
+      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
+      responseBytes += accepted.byteLength;
+      buffer = (buffer + decoder.decode(accepted, { stream: true })).replace(/\r\n/g, "\n");
       let separator: number;
       while ((separator = buffer.indexOf("\n\n")) !== -1) {
         processFrame(buffer.slice(0, separator));
         buffer = buffer.slice(separator + 2);
       }
+      if (responseBytes >= MAX_SIDECAR_RESPONSE_BYTES) {
+        // Keep the frames folded above, drop the unterminated tail, and do not wait on teardown.
+        try { void reader.cancel("vision sidecar response byte limit reached").catch(() => undefined); }
+        catch { /* best-effort body teardown */ }
+        buffer = "";
+        break;
+      }
     }
     buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
     if (buffer.trim()) processFrame(buffer);
@@ -164,7 +207,8 @@ export async function describeImageAnthropic(
       { abortSignal: linkedSignal.signal, label: "vision-sidecar-anthropic" },
     );
     if (!res.ok) {
-      const responseText = await res.text().catch(() => "");
+      // The body is untrusted and only feeds one auth-failure message, so read a bounded prefix.
+      const responseText = await readBoundedText(res);
       console.warn(`[vision] anthropic sidecar HTTP ${res.status} (${Date.now() - startedAt}ms)`);
       if (res.status === 401) {
         return { text: "", error: `anthropic vision sidecar auth failed: ${publicOAuthAuthenticationErrorMessage(new Error(responseText))}` };
diff --git a/tests/vision/vision-anthropic.test.ts b/tests/vision/vision-anthropic.test.ts
index ee4b01b42..30ed17af9 100644
--- a/tests/vision/vision-anthropic.test.ts
+++ b/tests/vision/vision-anthropic.test.ts
@@ -225,6 +225,27 @@ describe("Anthropic vision executor", () => {
     expect(result).toEqual({ text: "first second" });
   });
 
+  test("an unterminated frame cannot buffer the stream without bound", async () => {
+    // A sidecar that never emits a frame separator: without a cap the parser accumulates the
+    // whole response in memory before it can fold anything.
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
+    const out = await parseAnthropicVisionSSE(new Response(body, { status: 200 }));
+    expect(cancelled).toBe(true);
+    // The cap stops the read long before the producer would have finished on its own.
+    expect(produced).toBeLessThan(1024 * 1024);
+    expect(out.text).toBe("");
+  });
+
   test("malformed and terminal-error streams degrade to explicit errors", async () => {
     const malformed = await parseAnthropicVisionSSE(sseResponse(["{not-json", { type: "message_stop" }]));
     expect(malformed.text).toBe("");

```
