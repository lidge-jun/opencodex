# WP1 — Google empty content 방어: PR #430 통합과 누락 회귀 보강

## 루프 계약

- **Archetype:** 검증된 외부 PR을 현재 `dev` 위에 그대로 흡수한 뒤 누락된 경계 테스트만 보강하는 integration work-phase.
- **Trigger:** 이슈 #420의 Claude-on-Antigravity 경로가 빈 Gemini text block 또는 `parts: []`를 Anthropic으로 번역해 400을 반환한다.
- **Goal:** PR #430(`8704ab7b`)의 전체 패치를 변경 없이 적용하고, all-empty assistant text 배열과 빈 `developer` 메시지를 직접 회귀 테스트로 고정한다.
- **Non-goals:** PR의 프로덕션 로직 재설계, placeholder 문구 변경, remote/malformed tool-result image의 기존 marker-only 동작 수정, PR #430 외 파일 변경.
- **Verifier:** 구현자가 아래 pinned diff와 추가 테스트 delta를 대조하고 focused tests → typecheck → full suite → privacy scan을 실행한다. C에서 독립 reviewer가 changed-file ledger와 #420 실패 경로를 재확인한다.
- **Stop condition:** PR patch가 clean apply되고 추가 2개 테스트를 포함한 모든 검증 명령이 exit 0이며, `src/adapters/google.ts` 및 `tests/google-empty-content.test.ts` 외 변경이 없다.
- **Terminal outcomes:** `MERGE_OK`(모든 수용 기준 충족), `REWORK`(코드/테스트 결함), `STALE`(head SHA 또는 base가 달라져 문서 재작성 필요), `BLOCKED`(clean apply 또는 검증 불가).

## 착수 시점 사실

- 기준 시각: 2026-07-25 KST.
- worktree: `/Users/jun/.codex/worktrees/ebcd/opencodex`.
- 현재 체크아웃 상태는 브랜치가 아니라 **detached HEAD**이지만, `HEAD`와 `origin/dev`는 모두 `037e8f5e4fa32a82e4149acc509554f157656dad`이다. 브랜치 checkout은 하지 않는다.
- PR #430 base/head: `dev` ← `8704ab7bd38d7f98dd4cc9f94deae12642abac6b` (`fix/gemini-empty-content-parts`).
- PR 원문 diff 길이: 291줄. 대상은 `src/adapters/google.ts` MODIFY, `tests/google-empty-content.test.ts` NEW 두 파일뿐이다.
- 실행 명령: `gh pr diff 430 --repo lidge-jun/opencodex | git apply --check -`.
- 결과: exit 0, stderr/stdout 없음. 기준 `037e8f5e`에 clean apply된다.
- 독립 리뷰 판정은 `MERGE_OK`: #420의 empty string, empty/malformed text part, empty assistant turn, empty tool result 경로를 막는다. 이 WP의 추가 프로덕션 수정은 금지한다.

## 변경 계약

### 적용 순서와 고정점

1. 적용 직전에 `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad` 및 PR head가 위 full SHA와 같은지 확인한다.
2. 아래 **PR snapshot diff**를 그대로 적용한다. PR head가 달라졌다면 live diff를 임의 적용하지 말고 `STALE`로 멈춰 이 문서를 갱신한다.
3. PR 적용 후 `tests/google-empty-content.test.ts`에 “우리 delta” 2개 테스트만 추가한다.
4. `src/adapters/google.ts`에는 PR snapshot 밖의 수정이 없어야 한다.

### PR snapshot diff — 그대로 적용

출처: `gh pr diff 430 --repo lidge-jun/opencodex`, head `8704ab7bd38d7f98dd4cc9f94deae12642abac6b`.

```diff
diff --git a/src/adapters/google.ts b/src/adapters/google.ts
index 55df4c25..db627a17 100644
--- a/src/adapters/google.ts
+++ b/src/adapters/google.ts
@@ -87,6 +87,35 @@ function toolResultImageParts(content: string | OcxContentPart[]): unknown[] {
   return parts;
 }
 
+/**
+ * Antigravity translates these Gemini `contents` into Anthropic `messages` for Claude models, and
+ * Anthropic rejects a text block whose `text` is empty or absent. An empty Gemini text part reaches
+ * that upstream as `{"type":"text"}` — a proto3 empty string is omitted from the translated JSON —
+ * and 400s with `messages.N.content.M.text.text: Field required` (issue #420). An empty `parts: []`
+ * model turn fails the same way. Gemini itself accepts both shapes, which is why this only ever
+ * surfaced on Claude-on-Antigravity; the guard lives here because this is where the parts are
+ * built. Mirrors the Anthropic adapter's own empty-block guard (src/adapters/anthropic.ts).
+ */
+const GEMINI_EMPTY_PLACEHOLDER = "(empty)";
+const GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER = "(empty tool output)";
+
+/** A Gemini text part, or undefined when the value cannot form a valid non-empty text block. */
+function geminiTextPart(text: unknown): { text: string } | undefined {
+  return typeof text === "string" && text.length > 0 ? { text } : undefined;
+}
+
+/**
+ * Text for `functionResponse.response.result`. `contentPartsToText` collapses an empty array — or one
+ * holding only empty text — to its "[image]" marker, which would claim an image the turn does not
+ * actually carry (`toolResultImageParts` adds none). Fall back to the placeholder unless the content
+ * has something representable.
+ */
+function geminiToolResultText(content: string | OcxContentPart[]): string {
+  if (typeof content === "string") return content || GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER;
+  const hasContent = content.some(p => p.type === "image" || (typeof p.text === "string" && p.text.length > 0));
+  return hasContent ? contentPartsToText(content) : GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER;
+}
+
 function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?: unknown; contents: unknown[] } {
   // Neutralize Codex's GPT-5 identity line (Gemini/Antigravity share this path) so a routed model
   // never misreports as GPT-5/OpenAI, and never leaks the proxy identity upstream.
@@ -105,18 +134,22 @@ function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?:
       case "user":
       case "developer": {
         if (typeof msg.content === "string") {
-          contents.push({ role: "user", parts: [{ text: msg.content }] });
+          contents.push({ role: "user", parts: [{ text: msg.content || GEMINI_EMPTY_PLACEHOLDER }] });
         } else {
-          const parts = (msg.content as OcxContentPart[]).map(p => {
+          const parts: unknown[] = [];
+          for (const p of msg.content as OcxContentPart[]) {
             if (p.type === "image") {
               const data = parseDataUrl(p.imageUrl);
               // Gemini takes base64 via inline_data; a remote URL needs a mime type we don't have, so
               // fall back to a short marker rather than inlining the URL as a huge text blob.
-              return data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[image: ${p.imageUrl}]` };
+              parts.push(data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[image: ${p.imageUrl}]` });
+              continue;
             }
-            return { text: p.text };
-          });
-          contents.push({ role: "user", parts });
+            // Drop empty/malformed text instead of emitting `{ text: "" }` or a bare `{}` part.
+            const textPart = geminiTextPart(p.text);
+            if (textPart) parts.push(textPart);
+          }
+          contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: GEMINI_EMPTY_PLACEHOLDER }] });
         }
         break;
       }
@@ -124,8 +157,10 @@ function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?:
         const aMsg = msg as OcxAssistantMessage;
         const parts: unknown[] = [];
         for (const p of aMsg.content) {
-          if (p.type === "text") parts.push({ text: (p as OcxTextContent).text });
-          else if (p.type === "toolCall") {
+          if (p.type === "text") {
+            const textPart = geminiTextPart((p as OcxTextContent).text);
+            if (textPart) parts.push(textPart);
+          } else if (p.type === "toolCall") {
             const tc = p as OcxToolCall;
             // Preserve the thought signature on the function-call part so Antigravity/Gemini-3
             // reasoning continuity survives history-driven (stateless) turns, not just same-process
@@ -142,6 +177,10 @@ function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?:
             parts.push(part);
           }
         }
+        // A turn with nothing Gemini can represent (e.g. thinking-only) would serialize as
+        // `parts: []`, which the Anthropic translation rejects. Skip it, as the Anthropic
+        // adapter does for its own empty assistant content.
+        if (parts.length === 0) break;
         contents.push({ role: "model", parts });
         break;
       }
@@ -151,7 +190,7 @@ function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?:
         // tool-result screenshots (e.g. Computer Use) ride along as inline_data instead of being
         // flattened to a "[image]" marker the model can't actually see.
         const responseId = geminiToolCallId(msg.toolCallId);
-        const functionResponse: Record<string, unknown> = { name: namespacedToolName(msg.toolNamespace, msg.toolName), response: { result: contentPartsToText(msg.content) } };
+        const functionResponse: Record<string, unknown> = { name: namespacedToolName(msg.toolNamespace, msg.toolName), response: { result: geminiToolResultText(msg.content) } };
         // Mirror the matching functionCall id so Claude-on-Antigravity can pair this result with its
         // `tool_use` block (-> Anthropic `tool_result.tool_use_id`).
         if (responseId !== undefined) functionResponse.id = responseId;
diff --git a/tests/google-empty-content.test.ts b/tests/google-empty-content.test.ts
new file mode 100644
index 00000000..484084e0
--- /dev/null
+++ b/tests/google-empty-content.test.ts
@@ -0,0 +1,183 @@
+import { describe, expect, test } from "bun:test";
+import { createGoogleAdapter } from "../src/adapters/google";
+import type { OcxParsedRequest } from "../src/types";
+
+// Antigravity translates these Gemini `contents` into Anthropic `messages` for Claude models, and
+// Anthropic rejects empty/absent text and empty content arrays. An empty Gemini text part reaches
+// that upstream as `{"type":"text"}` (a proto3 empty string is omitted from JSON), producing
+// `messages.0.content.N.text.text: Field required` (issue #420). Gemini itself tolerates the same
+// parts, which is why this only ever surfaced on Claude-on-Antigravity.
+
+const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };
+
+function parsedWith(messages: unknown[]): OcxParsedRequest {
+  return { modelId: "gemini-3-pro", stream: false, options: {}, context: { messages } } as unknown as OcxParsedRequest;
+}
+
+async function geminiContents(parsed: OcxParsedRequest): Promise<{ role: string; parts: Record<string, unknown>[] }[]> {
+  const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
+  return JSON.parse(body).contents;
+}
+
+/** Every emitted text part must survive a JSON round-trip with a non-empty string `text`. */
+function assertNoEmptyTextParts(contents: { role: string; parts: Record<string, unknown>[] }[]): void {
+  for (const turn of contents) {
+    expect(Array.isArray(turn.parts)).toBe(true);
+    expect(turn.parts.length).toBeGreaterThan(0);
+    for (const part of turn.parts) {
+      if (!("text" in part)) continue;
+      expect(typeof part.text).toBe("string");
+      expect((part.text as string).length).toBeGreaterThan(0);
+    }
+  }
+}
+
+describe("google adapter — empty content part guard (#420)", () => {
+  test("user message with empty string content emits a placeholder, not an empty text part", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: "", timestamp: 0 },
+    ]));
+
+    expect(contents[0].parts).toEqual([{ text: "(empty)" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("empty text parts are dropped from a user message", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "hello" }], timestamp: 0 },
+    ]));
+
+    expect(contents[0].parts).toEqual([{ text: "hello" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("a user message whose parts are all empty falls back to a placeholder", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: [{ type: "text", text: "" }], timestamp: 0 },
+    ]));
+
+    expect(contents[0].parts).toEqual([{ text: "(empty)" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("a malformed part with a missing text field never becomes a bare {} part", async () => {
+    // A Responses `input_text` block with no `text` key parses into this shape
+    // (src/responses/parser.ts casts without validating), and `{ text: undefined }`
+    // serializes to `{}` — exactly the block Anthropic reports as `Field required`.
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: [{ type: "text" }, { type: "text", text: "real" }], timestamp: 0 },
+    ]));
+
+    expect(contents[0].parts).toEqual([{ text: "real" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("a non-string text value is dropped rather than sent as an object", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: [{ type: "text", text: { nested: "object" } }, { type: "text", text: "real" }], timestamp: 0 },
+    ]));
+
+    expect(contents[0].parts).toEqual([{ text: "real" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("empty assistant text parts are dropped", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: "start", timestamp: 0 },
+      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "visible" }], timestamp: 0 },
+    ]));
+
+    const model = contents.find(c => c.role === "model");
+    expect(model!.parts).toEqual([{ text: "visible" }]);
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("an assistant turn with no emittable parts is skipped, not sent with parts: []", async () => {
+    // Thinking-only assistant turns carry no Gemini-representable part: the loop handles
+    // text and toolCall only, so the turn would otherwise serialize as `parts: []`.
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: "start", timestamp: 0 },
+      { role: "assistant", content: [{ type: "thinking", thinking: "internal", signature: "sig" }], timestamp: 0 },
+    ]));
+
+    expect(contents.find(c => c.role === "model")).toBeUndefined();
+    assertNoEmptyTextParts(contents);
+  });
+
+  test("an empty tool result emits a placeholder result string", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
+      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "", isError: false, timestamp: 0 },
+    ]));
+
+    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
+    expect(toolTurn!.parts[0]).toEqual({
+      functionResponse: { name: "bash", response: { result: "(empty tool output)" }, id: "call_1" },
+    });
+  });
+
+  test("a tool result with an empty parts array does not claim a phantom image", async () => {
+    // contentPartsToText([]) collapses to its "[image]" marker, but toolResultImageParts()
+    // contributes no image part — the result would assert an image the turn does not carry.
+    const contents = await geminiContents(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
+      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false, timestamp: 0 },
+    ]));
+
+    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
+    expect(toolTurn!.parts).toEqual([
+      { functionResponse: { name: "bash", response: { result: "(empty tool output)" }, id: "call_1" } },
+    ]);
+  });
+
+  test("a tool result holding only empty text parts uses the placeholder", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
+      {
+        role: "toolResult",
+        toolCallId: "call_1",
+        toolName: "bash",
+        content: [{ type: "text", text: "" }, { type: "text", text: "" }],
+        isError: false,
+        timestamp: 0,
+      },
+    ]));
+
+    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
+    const fr = toolTurn!.parts[0] as { functionResponse: { response: { result: string } } };
+    expect(fr.functionResponse.response.result).toBe("(empty tool output)");
+  });
+
+  test("a genuine image-only tool result still reports [image]", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "snap", arguments: {} }], timestamp: 0 },
+      {
+        role: "toolResult",
+        toolCallId: "call_1",
+        toolName: "snap",
+        content: [{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }],
+        isError: false,
+        timestamp: 0,
+      },
+    ]));
+
+    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
+    const fr = toolTurn!.parts[0] as { functionResponse: { response: { result: string } } };
+    expect(fr.functionResponse.response.result).toBe("[image]");
+    expect(toolTurn!.parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } });
+  });
+
+  test("non-empty content is unchanged", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: "hello", timestamp: 0 },
+      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 },
+      { role: "user", content: [{ type: "text", text: "again" }], timestamp: 0 },
+    ]));
+
+    expect(contents).toEqual([
+      { role: "user", parts: [{ text: "hello" }] },
+      { role: "model", parts: [{ text: "hi" }] },
+      { role: "user", parts: [{ text: "again" }] },
+    ]);
+  });
+});
```

### 우리 delta — `tests/google-empty-content.test.ts` MODIFY

PR이 만든 파일의 `empty assistant text parts are dropped` 테스트 뒤에 all-empty 직접 사례를 추가한다. thinking-only 사례와 달리 **text part 배열 자체가 전부 empty**인 경계를 고정한다.

```diff
@@
   test("empty assistant text parts are dropped", async () => {
@@
     assertNoEmptyTextParts(contents);
   });
 
+  test("an assistant text array whose parts are all empty is skipped", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "user", content: "start", timestamp: 0 },
+      {
+        role: "assistant",
+        content: [{ type: "text", text: "" }, { type: "text", text: "" }],
+        timestamp: 0,
+      },
+    ]));
+
+    expect(contents.find(c => c.role === "model")).toBeUndefined();
+    assertNoEmptyTextParts(contents);
+  });
+
   test("an assistant turn with no emittable parts is skipped, not sent with parts: []", async () => {
```

PR의 첫 번째 empty user test 뒤에 빈 `developer` 문자열 직접 사례를 추가한다. Google wire에서는 developer가 user role로 변환되되 빈 text가 남아서는 안 된다.

```diff
@@
   test("user message with empty string content emits a placeholder, not an empty text part", async () => {
@@
     assertNoEmptyTextParts(contents);
   });
 
+  test("developer message with empty string content emits the same non-empty placeholder", async () => {
+    const contents = await geminiContents(parsedWith([
+      { role: "developer", content: "", timestamp: 0 },
+    ]));
+
+    expect(contents).toEqual([{ role: "user", parts: [{ text: "(empty)" }] }]);
+    assertNoEmptyTextParts(contents);
+  });
+
   test("empty text parts are dropped from a user message", async () => {
```

### 비차단 후속 — 이번 WP에서 수정 금지

PR snapshot의 `src/adapters/google.ts:113-115`(base 기준; 적용 후 helper는 약 151-181행)에 기존 불일치가 남는다.

- `geminiToolResultText()`는 `p.type === "image"`이면 remote URL 또는 malformed `imageUrl`도 “representable”로 계산해 result를 `"[image]"`로 만든다.
- `toolResultImageParts()`는 `parseDataUrl()`가 성공한 data URL만 `inline_data`로 방출한다.
- 따라서 remote/malformed image-only tool result는 실제 image part 없이 marker만 남을 수 있다.
- 독립 리뷰가 비차단으로 분류했으므로 PR #430 통합 범위에서는 고치지 않는다. D 영수증에 후속 이슈 후보로만 남긴다.

## 검증

적용 직후 아래 순서로 실행한다.

```bash
bun test tests/google-empty-content.test.ts
bun test tests/google-empty-content.test.ts tests/google-adapter.test.ts tests/google-antigravity-wire.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun run lint:gui
```

추가로 변경 범위를 확인한다.

```bash
git diff --check
git diff --name-status 037e8f5e4fa32a82e4149acc509554f157656dad --
```

## 수용 기준

- [ ] 적용 직전 PR #430 head가 `8704ab7bd38d7f98dd4cc9f94deae12642abac6b`와 정확히 일치한다.
- [ ] PR snapshot 291줄이 내용 변경 없이 적용된다.
- [ ] changed-file ledger가 `src/adapters/google.ts` MODIFY, `tests/google-empty-content.test.ts` NEW 두 파일만 보인다.
- [ ] user/developer empty string은 `{ text: "(empty)" }`를 방출한다.
- [ ] user text array의 empty/malformed text part는 제거되고 전부 제거되면 placeholder로 대체된다.
- [ ] assistant text array가 전부 empty이면 model turn 전체가 생략되며 `parts: []`가 없다.
- [ ] thinking-only assistant turn도 기존 PR 테스트대로 생략된다.
- [ ] empty string/empty array/all-empty-text tool result는 `"(empty tool output)"`을 사용한다.
- [ ] genuine data-URL image tool result는 `"[image]"` marker와 sibling `inline_data`를 모두 유지한다.
- [ ] non-empty 기존 content wire 결과가 변하지 않는다.
- [ ] 위 6개 검증 명령과 `git diff --check`가 모두 exit 0이다.
- [ ] remote/malformed tool-result image marker-only 동작은 비차단 후속으로 기록되고 이번 diff에는 수정이 없다.

## 실행 영수증

_(C/D 단계에서 작성)_
