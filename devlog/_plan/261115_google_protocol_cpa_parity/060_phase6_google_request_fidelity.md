# 060 — Phase 6: Google request fidelity

Rows: AG-M1, OUT-V04, OUT-V29 (P2), OUT-V27 (P3). Class C2 (one adapter, one endpoint helper).
Independent of #8742.

## 6a — AG-M1: nest tool-result images for Antigravity

`messagesToGeminiFormat` takes `nestToolResultImages` and today passes true only for Vertex
`gemini-4-argon|carbon|hydrogen` (`src/adapters/google.ts:1074-1080`), so on Cloud Code Assist a tool's
images ride as sibling `inline_data` parts after the `functionResponse`. The native Antigravity client
and CPA nest them in `functionResponse.parts` (`internal/translator/antigravity/gemini/antigravity_gemini_request.go:889-955`,
`internal/translator/antigravity/claude/antigravity_claude_request.go:671-701`).

```diff
-        provider.googleMode === "vertex" && (
-          parsed.modelId === "gemini-4-argon"
-          || parsed.modelId === "gemini-4-carbon"
-          || parsed.modelId === "gemini-4-hydrogen"
-        ),
+        isCloudCodeAssist || (provider.googleMode === "vertex" && (
+          parsed.modelId === "gemini-4-argon"
+          || parsed.modelId === "gemini-4-carbon"
+          || parsed.modelId === "gemini-4-hydrogen"
+        )),
```

`geminiToolResultParts` (`google.ts:337-355`) already builds the nested form. Nested parts use
`inlineData` with a `mimeType` defaulting to `image/png` when the source has none (CPA default); stale
check whether `toolResultImageParts` emits snake_case `inline_data` (proto JSON accepts both).

Test (EXTEND `tests/adapters/google/google-adapter.test.ts` or the Antigravity request test that covers
tool results): a CCA request whose tool result has text and one image serializes one part
`{functionResponse:{name,id,response:{result},parts:[{inline_data…}]}}` and no sibling image; AI Studio
keeps the sibling form.

## 6b — OUT-V04: Vertex multi-region hosts

```diff
// src/adapters/google-vertex-endpoint.ts (vertexInferenceUrl)
-  const host = selection.location === "global" ? "aiplatform.googleapis.com" : `${selection.location}-aiplatform.googleapis.com`;
+  const host = vertexHostForLocation(selection.location);
+
+/** global → aiplatform.googleapis.com; the us/eu multi-regions use the regional-endpoint (rep) hosts; regions keep <loc>-aiplatform. */
+export function vertexHostForLocation(location: string): string {
+  if (location === "global") return "aiplatform.googleapis.com";
+  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
+  return `${location}-aiplatform.googleapis.com`;
+}
```

Model discovery and the key-project probe use the fixed global host
(`src/adapters/google-vertex-key-project.ts:19`), not a location authority, so they stay. Update the
comment at `src/providers/google-vertex-location.ts:2`, which says every regional host is
`<location>-aiplatform.googleapis.com`.
Test: `vertexHostForLocation` table and `vertexInferenceUrl` for `us`, `eu`, `us-central1`, `global`
(CPA `gemini_vertex_executor_test.go:519` table).

## 6c — OUT-V29: audio input as `inline_data`

`OcxAudioContent` (`src/types/request.ts:355-363`: base64 `data`, `format: "mp3" | "wav"`) currently
falls through to the text branch and reaches Gemini as its text marker.

```diff
+            if (p.type === "audio" && !rejectsInlineAudio) {
+              parts.push({ inline_data: { mime_type: p.format === "mp3" ? "audio/mp3" : "audio/wav", data: p.data } });
+              continue;
+            }
```

`rejectsInlineAudio` is true for Claude models on Cloud Code Assist (they keep the marker). Test: an
AI Studio and a Vertex request with a WAV part serialize `inline_data` with `audio/wav`; a CCA Claude
request keeps the marker text.

## 6d — OUT-V27: tool error results

`geminiToolResultParts` writes `response:{result}` even when `msg.isError` is true
(`src/types/request.ts:291`). CPA writes `response:{error}` for error results
(`internal/translator/gemini/claude/gemini_claude_request.go:201-207`), which is the documented
functionResponse convention.

```diff
-    response: { result: geminiToolResultText(msg.content) },
+    response: msg.isError ? { error: geminiToolResultText(msg.content) } : { result: geminiToolResultText(msg.content) },
```

Test: an error tool result serializes `response.error`; a normal one keeps `response.result`.
Stale check: replay/test fixtures that assert `response.result` for an `isError` message.

## Docs

`structure/providers-and-adapters.md` Google request shaping (tool-result images, audio, error
results, Vertex hosts) and `docs-site` Vertex location note if the page lists hosts.

