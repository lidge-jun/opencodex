# WP2 — Responses malformed parser: PR #436 통합과 fake marker 제거

## ⚠️ 계획 재설계 (A-gate 3라운드 FAIL 후, LOOP-REPAIR-01)

A-gate가 3라운드 연속 FAIL했다. 원인은 계약의 세부가 아니라 **범위 설정 자체**였다.
독립 리뷰어의 지적이 옳다. 무엇이 잘못됐는지 기록한다.

1. 가짜 ref 마커(`[image: ?]`)를 제거하면 content가 빈 배열이 될 수 있다. 나는 그 빈 배열이
   Cursor에서 메시지 유실을 일으킨다는 사실을 발견하고 **parser에 placeholder 정규화를 추가**하려
   했다. 이 확장이 실패의 근원이다.
2. `src/responses/parser.ts:53`은 단일 text 파트를 **문자열로 collapse**한다. 따라서
   `Array.isArray()` 기반 정규화는 `[{type:"input_text",text:""}]` 같은 입력을 구조적으로
   잡을 수 없다.
3. Cursor의 `src/adapters/cursor/request-builder.ts:236` 필터는 파트 개수가 아니라
   **join된 문자열 길이** 기준이다 — `contentToText()`가 empty part를 filter하고 join한다.
   즉 parser에서 파트를 몇 개 남기든 텍스트가 실질적으로 비면 메시지는 제거된다.
4. 결국 "빈 content를 downstream에 내보내지 않는다"는 invariant는 parser 한 지점에서 달성
   불가능하다. 그것은 **Cursor adapter의 문제**이며 PR #436과 별개다.

### 재설계된 범위 — 이번 WP가 하는 것

- PR #436을 그대로 통합한다 (무검증 cast → 검증). 이것이 #435를 닫는다.
- 우리 repair는 **가짜 ref 마커 제거로만 한정**한다: 유효 ref가 없는 malformed image/file은
  생략하고 `?`나 raw `file_data`를 사용자 content로 만들지 않는다.
- `detail`은 지역 변수로 narrow한다 (typecheck 필수).
- file precedence: `file_id > file_data(+optional filename) > 생략`. `filename` 단독 금지.

### 이번 WP가 하지 않는 것 — 후속 이슈 후보, D 영수증에 기록

- **빈 content placeholder 정규화** — parser 단독으로 해결 불가. 아래 canonical diff의
  call-site 정규화 hunk는 **무효(SUPERSEDED)** 이며 적용하지 않는다.
- **Cursor malformed-only 첫 turn `resumeAction`** — 기존 결함이며 이 PR이 만들지 않는다.
  가짜 마커가 있던 시절에도 `content: ""`인 입력에서 동일하게 발생했다. 별도 이슈로 올린다.
- `contentPartsToText([]) → "[image]"` 허위 마커 (tool result 경로).
- `file_url` 스키마 부재.
- Kiro의 빈 assistant history 생성.

이 재설계로 계약은 PR #436의 범위 안에 머문다. **테스트 기대값은 원래 문서대로 `[]`를 유지**하며,
`filename` 단독 케이스만 `[file: report.pdf]` → 생략으로 바꾼다.

## 루프 계약

- **Archetype:** 외부 parser-hardening PR 흡수 + 발견된 correctness defect를 같은 work-phase에서 최소 수정하는 integration-and-repair.
- **Trigger:** 이슈 #435의 permissive catch-all이 malformed Responses content를 parser 내부로 통과시켜 crash/undefined content를 만들며, PR #436의 초기 수정은 ref 없는 image/file을 `[image: ?]` / `[file: ?]`라는 가짜 사용자 콘텐츠로 바꾼다.
- **Goal:** WP1(#430) 이후 PR #436(`acfe5c14`)을 적용하고, marker는 non-empty 실제 ref가 있을 때만 만들며 inline `file_data`는 bytes를 노출하지 않는 별도 marker로 처리하고 나머지 malformed block은 생략한다.
- **Non-goals:** Responses schema 자체를 strict-reject 방식으로 바꾸기, file bytes를 adapter native attachment로 전달하기, placeholder 문구의 전역 표준화, Google adapter의 WP1 밖 수정.
- **Verifier:** parser 단위 assertions와 raw Responses → `parseRequest()` → Google `buildRequest()` wire assertion을 함께 실행한다. 독립 reviewer는 fake marker가 남는 경로와 정상 image/file 회귀를 재검토한다.
- **Stop condition:** WP1이 먼저 통합되어 있고, PR snapshot + 아래 repair delta가 적용되며 focused/integration/full 검증이 모두 exit 0이고 변경 파일이 두 개뿐이다.
- **Terminal outcomes:** `MERGE_OK`, `REWORK`, `STALE`, `BLOCKED_BY_WP1`.

## 착수 시점 사실

- 기준 시각: 2026-07-25 KST.
- worktree: `/Users/jun/.codex/worktrees/ebcd/opencodex`.
- 현재 체크아웃은 detached HEAD이며, `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad`.
- PR #436 base/head: `dev` ← `acfe5c14034c0e3a5802757ab53b1ef1212747ab` (`fix/responses-parser-content-validation`).
- PR 원문 diff 길이: 209줄. 대상은 `src/responses/parser.ts` MODIFY, `tests/responses-parser-malformed-content.test.ts` NEW.
- 실행 명령: `gh pr diff 436 --repo lidge-jun/opencodex | git apply --check -`.
- 결과: exit 0, stderr/stdout 없음. 기준 `037e8f5e`에는 clean apply된다.
- **순서 의존:** 이 clean-apply 사실은 독립 적용 가능성만 뜻한다. #436 단독 적용 시 malformed message content가 `[]`가 되고, 현재 dev의 `src/adapters/google.ts:110-120`은 이를 `parts: []`로 직렬화한다. 그러면 #420이 재발한다. 반드시 WP1(#430)을 먼저 적용하고 그 결과 위에서 이 WP를 실행한다.

## 변경 계약

### 적용 순서와 고정점

1. WP1의 `src/adapters/google.ts` placeholder/skip guard와 `tests/google-empty-content.test.ts`가 존재하고 green인지 확인한다.
2. PR #436 head가 full SHA와 정확히 일치하는지 확인한 뒤 아래 209줄 snapshot을 그대로 적용한다.
3. PR 적용 후 `src/responses/parser.ts`에 fake-marker repair를 적용한다.
4. PR이 만든 `tests/responses-parser-malformed-content.test.ts`에 assistant-null, malformed image, file field matrix, raw-to-Google integration assertions를 추가한다.
5. `src/responses/schema.ts`는 이미 `file_data?: string`을 정상 schema로 선언하므로 수정하지 않는다(`src/responses/schema.ts:14-19`).

### PR snapshot diff — 그대로 적용

출처: `gh pr diff 436 --repo lidge-jun/opencodex`, head `acfe5c14034c0e3a5802757ab53b1ef1212747ab`.

```diff
diff --git a/src/responses/parser.ts b/src/responses/parser.ts
index 3e2245d3..c0fdd52e 100644
--- a/src/responses/parser.ts
+++ b/src/responses/parser.ts
@@ -27,25 +27,32 @@ type InputBlock =
   | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
   | { type: "input_file"; file_id?: string; filename?: string };
 
-function inputContentParts(blocks: unknown[] | string | undefined): string | OcxContentPart[] {
+function inputContentParts(blocks: unknown): string | OcxContentPart[] {
   if (typeof blocks === "string") return blocks;
-  if (!blocks) return [];
+  // The catch-all can also hand back a non-array `content` (an object, a number), which would
+  // throw at the loop below before any per-block guard runs.
+  if (!Array.isArray(blocks)) return [];
   const parts: OcxContentPart[] = [];
   for (const raw of blocks) {
+    // A malformed message item fails its strict schema and falls through to inputItemSchema's
+    // permissive catch-all, so blocks reaching here are NOT guaranteed to match the declared
+    // shape. Validate each field before use, as outputToToolResultContent already does.
+    if (!isObj(raw)) continue;
     const block = raw as InputBlock;
     if (block.type === "input_text" || block.type === "text") {
-      parts.push({ type: "text", text: (block as { text: string }).text });
+      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
     } else if (block.type === "input_image") {
       const b = block as { image_url?: string; file_id?: string; detail?: string };
-      if (b.image_url) {
+      if (typeof b.image_url === "string" && b.image_url.length > 0) {
         // Preserve the image as a structured part — adapters send it as a native image block.
         // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
-        parts.push({ type: "image", imageUrl: b.image_url, ...(b.detail ? { detail: normalizeImageDetail(b.detail) } : {}) });
+        parts.push({ type: "image", imageUrl: b.image_url, ...(typeof b.detail === "string" && b.detail.length > 0 ? { detail: normalizeImageDetail(b.detail) } : {}) });
       } else {
-        parts.push({ type: "text", text: `[image: ${b.file_id ?? "?"}]` }); // file_id ref → no inline data
+        parts.push({ type: "text", text: `[image: ${typeof b.file_id === "string" ? b.file_id : "?"}]` }); // file_id ref → no inline data
       }
     } else if (block.type === "input_file") {
-      const ref = (block as { file_id?: string; filename?: string }).file_id ?? (block as { filename?: string }).filename ?? "?";
+      const b = block as { file_id?: string; filename?: string };
+      const ref = typeof b.file_id === "string" ? b.file_id : typeof b.filename === "string" ? b.filename : "?";
       parts.push({ type: "text", text: `[file: ${ref}]` });
     }
   }
@@ -56,14 +63,19 @@ function inputContentParts(blocks: unknown[] | string | undefined): string | Ocx
 
 type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };
 
-function outputTextOf(blocks: unknown[] | string | undefined): OcxTextContent[] {
+function outputTextOf(blocks: unknown): OcxTextContent[] {
   if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
-  if (!blocks) return [];
+  if (!Array.isArray(blocks)) return [];
   const out: OcxTextContent[] = [];
   for (const raw of blocks) {
+    // Same catch-all caveat as inputContentParts: validate before use.
+    if (!isObj(raw)) continue;
     const b = raw as OutputBlock;
-    if (b.type === "output_text" || b.type === "text") out.push({ type: "text", text: (b as { text: string }).text });
-    else if (b.type === "refusal") out.push({ type: "text", text: `[refusal: ${(b as { refusal: string }).refusal}]` });
+    if (b.type === "output_text" || b.type === "text") {
+      if (typeof raw.text === "string") out.push({ type: "text", text: raw.text });
+    } else if (b.type === "refusal") {
+      if (typeof raw.refusal === "string") out.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
+    }
   }
   return out;
 }
@@ -311,9 +323,7 @@ export function parseRequest(body: unknown): OcxParsedRequest {
           content?: unknown;
         };
 
-        const content = inputContentParts(
-          agentMessage.content as unknown[] | string | undefined,
-        );
+        const content = inputContentParts(agentMessage.content);
 
         const hasContent =
           typeof content === "string"
@@ -338,7 +348,7 @@ export function parseRequest(body: unknown): OcxParsedRequest {
         switch (msg.role) {
           case "system": {
             pendingReasoning.length = 0;
-            const text = inputContentParts(msg.content as unknown[] | string | undefined);
+            const text = inputContentParts(msg.content);
             const flat = typeof text === "string" ? text : text.map(p => (p.type === "text" ? p.text : "")).join("");
             if (flat.length > 0) systemPrompt.push(flat);
             break;
@@ -346,12 +356,12 @@ export function parseRequest(body: unknown): OcxParsedRequest {
           case "user":
           case "developer": {
             pendingReasoning.length = 0;
-            const content = inputContentParts(msg.content as unknown[] | string | undefined);
+            const content = inputContentParts(msg.content);
             messages.push({ role: msg.role, content, timestamp: now });
             break;
           }
           case "assistant": {
-            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
+            const parts = outputTextOf(msg.content);
             messages.push({
               role: "assistant",
               content: pendingReasoning.length > 0
diff --git a/tests/responses-parser-malformed-content.test.ts b/tests/responses-parser-malformed-content.test.ts
new file mode 100644
index 00000000..a403cc37
--- /dev/null
+++ b/tests/responses-parser-malformed-content.test.ts
@@ -0,0 +1,100 @@
+import { describe, expect, test } from "bun:test";
+import { parseRequest } from "../src/responses/parser";
+import { createGoogleAdapter } from "../src/adapters/google";
+import { createAnthropicAdapter } from "../src/adapters/anthropic";
+import type { OcxProviderConfig } from "../src/types";
+
+// A message item whose content blocks do not match their strict schema fails
+// `userMessageItemSchema` / `assistantMessageItemSchema` and falls through to
+// `inputItemSchema`'s permissive catch-all (`z.object({ type: z.string() }).loose()`),
+// which passes the raw content through untouched. The parser then has to validate
+// it itself — otherwise a malformed block reaches an adapter, or crashes parseRequest.
+
+function inputOf(role: string, content: unknown) {
+  return { model: "gemini-3-pro", input: [{ type: "message", role, content }] };
+}
+
+function userContent(content: unknown): unknown {
+  const parsed = parseRequest(inputOf("user", content));
+  return (parsed.context.messages[0] as { content?: unknown } | undefined)?.content;
+}
+
+describe("responses parser — malformed content blocks", () => {
+  test("a user text block with no text key is dropped, not turned into undefined content", () => {
+    expect(userContent([{ type: "input_text" }])).toEqual([]);
+  });
+
+  test("a user text block with a non-string text is dropped, not leaked as an object", () => {
+    // Previously collapsed to `parts[0].text`, making the whole message content
+    // the raw object (`{a: 1}`), which is neither a string nor an array.
+    expect(userContent([{ type: "input_text", text: { a: 1 } }])).toEqual([]);
+  });
+
+  test("a null content block does not crash the parser", () => {
+    expect(() => userContent([null])).not.toThrow();
+    expect(userContent([null])).toEqual([]);
+  });
+
+  test("a system message with a malformed block does not crash the parser", () => {
+    // parseRequest flattens system content inline, so an undefined return threw here.
+    expect(() => parseRequest(inputOf("system", [{ type: "input_text" }]))).not.toThrow();
+    const parsed = parseRequest(inputOf("system", [{ type: "input_text" }]));
+    expect(parsed.context.systemPrompt ?? []).toEqual([]);
+  });
+
+  test("a non-array content container does not crash the parser", () => {
+    // The catch-all can also retain a `content` that is not an array at all; the block loop
+    // would throw ("{} is not iterable") before any per-block guard runs.
+    for (const container of [{ type: "input_text", text: "x" }, 42, true]) {
+      expect(() => userContent(container)).not.toThrow();
+      expect(userContent(container)).toEqual([]);
+    }
+  });
+
+  test("a non-array container on system and assistant roles is also safe", () => {
+    const container = { type: "input_text", text: "x" };
+    expect(() => parseRequest(inputOf("system", container))).not.toThrow();
+    expect(() => parseRequest(inputOf("assistant", container))).not.toThrow();
+
+    const assistant = parseRequest(inputOf("assistant", container));
+    const msg = assistant.context.messages[0] as { content: unknown[] };
+    expect(msg.content).toEqual([]);
+  });
+
+  test("valid blocks alongside malformed ones survive", () => {
+    expect(userContent([{ type: "input_text" }, { type: "input_text", text: "real" }])).toBe("real");
+    expect(userContent([{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }]))
+      .toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
+  });
+
+  test("an assistant output_text with no text key does not become a bare text part", () => {
+    const parsed = parseRequest(inputOf("assistant", [{ type: "output_text" }, { type: "output_text", text: "kept" }]));
+    const msg = parsed.context.messages[0] as { content: Array<{ type: string; text?: string }> };
+    expect(msg.content).toEqual([{ type: "text", text: "kept" }]);
+  });
+
+  test("a refusal block with a non-string refusal is dropped", () => {
+    const parsed = parseRequest(inputOf("assistant", [{ type: "refusal", refusal: { nope: true } }]));
+    const msg = parsed.context.messages[0] as { content: unknown[] };
+    expect(msg.content).toEqual([]);
+  });
+
+  test("an input_image with a non-string image_url degrades to a file marker instead of crashing", () => {
+    expect(userContent([{ type: "input_image", image_url: { bad: true }, file_id: "file_1" }]))
+      .toBe("[image: file_1]");
+  });
+
+  test("a valid image block is still preserved structurally", () => {
+    expect(userContent([{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" }]))
+      .toEqual([{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" }]);
+  });
+
+  test("adapters build a request from malformed input instead of throwing", async () => {
+    const parsed = parseRequest(inputOf("user", [{ type: "input_text" }]));
+    const google = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" } as unknown as OcxProviderConfig;
+    const anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x" } as unknown as OcxProviderConfig;
+
+    await expect(createGoogleAdapter(google).buildRequest(parsed)).resolves.toBeDefined();
+    await expect(createAnthropicAdapter(anthropic).buildRequest(parsed)).resolves.toBeDefined();
+  });
+});
```

### 우리 repair — `src/responses/parser.ts` MODIFY

#### 결함의 정확한 before

PR head `acfe5c14` 기준 `src/responses/parser.ts`의 fallback은 ref 부재를 정보로 보존하지 않고
`?`를 만들어낸다. **고정점은 라인 번호가 아니라 `inputContentParts()`의 `input_image` /
`input_file` 두 branch다** (A-gate blocker 6 반영). PR head에서 실측한 위치는 다음과 같다.

| 대상 | PR head `acfe5c14` 실제 라인 | 내용 |
|---|---|---|
| image fake marker | `:50-52` | `[image: ...?]` fallback |
| file fake marker | `:53-56` | `[file: ...?]` fallback |
| `:59` | — | collapse 관련 주석. repair 대상이 아니다 |

**두 branch를 모두 고쳐야 한다.** image branch만 놓치면 결함이 절반 남는다.
적용 시에는 라인 번호로 찾지 말고 `input_image` / `input_file` case 문자열로 찾아라.

```ts
      } else {
        parts.push({ type: "text", text: `[image: ${typeof b.file_id === "string" ? b.file_id : "?"}]` }); // file_id ref → no inline data
      }
    } else if (block.type === "input_file") {
      const b = block as { file_id?: string; filename?: string };
      const ref = typeof b.file_id === "string" ? b.file_id : typeof b.filename === "string" ? b.filename : "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
```

이는 malformed input을 생략하는 대신 모델이 실제 image/file이 있었다고 믿게 만드는 correctness defect다.

#### 정확한 after diff — CANONICAL (A-gate 라운드2에서 교체됨)

`InputBlock`에 schema의 정상 `file_data`를 반영하고, non-empty string 판정을 한 owner helper로
둔다. empty string과 non-string은 ref가 아니다. inline bytes는 marker에 삽입하지 않는다.
`detail`은 반드시 지역 변수로 narrow한다 — 조건에서만 호출하면 `string | undefined`가
`normalizeImageDetail()`에 전달되어 typecheck가 깨진다.

**[SUPERSEDED — 계획 재설계로 무효]** 빈 결과 정규화는 이번 WP에서 하지 않는다. 아래 call-site
hunk는 적용하지 않는다. 이유는 문서 상단 '계획 재설계' 절을 보라.
같은 helper를 system(`parser.ts:341`)이 공유하므로 내부에 두면 malformed system input이
고우선순위 지시문으로 변한다. system은 계속 drop한다.

```
 type InputBlock =
   | { type: "input_text"; text: string }
   | { type: "text"; text: string }
   | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
-  | { type: "input_file"; file_id?: string; filename?: string };
+  | { type: "input_file"; file_id?: string; filename?: string; file_data?: string };
+
+function nonEmptyString(value: unknown): string | undefined {
+  return typeof value === "string" && value.length > 0 ? value : undefined;
+}
```

image branch — ref가 전혀 없으면 블록을 생략한다. `[image: ?]`를 만들지 않는다.

```
     } else if (block.type === "input_image") {
       const b = block as { image_url?: string; file_id?: string; detail?: string };
-      if (typeof b.image_url === "string" && b.image_url.length > 0) {
-        parts.push({ type: "image", imageUrl: b.image_url, ...(typeof b.detail === "string" && b.detail.length > 0 ? { detail: normalizeImageDetail(b.detail) } : {}) });
-      } else {
-        parts.push({ type: "text", text: `[image: ${typeof b.file_id === "string" ? b.file_id : "?"}]` });
-      }
+      const imageUrl = nonEmptyString(b.image_url);
+      const fileId = nonEmptyString(b.file_id);
+      const detail = nonEmptyString(b.detail);
+      if (imageUrl) {
+        parts.push({
+          type: "image",
+          imageUrl,
+          ...(detail ? { detail: normalizeImageDetail(detail) } : {}),
+        });
+      } else if (fileId) {
+        parts.push({ type: "text", text: `[image: ${fileId}]` });
+      }
```

file branch — precedence는 `file_id` > `file_data`(+optional `filename`) > 생략이다.
`filename` 단독은 파일 resource가 아니므로 marker를 만들지 않는다.

```
     } else if (block.type === "input_file") {
-      const b = block as { file_id?: string; filename?: string };
-      const ref = typeof b.file_id === "string" ? b.file_id : typeof b.filename === "string" ? b.filename : "?";
-      parts.push({ type: "text", text: `[file: ${ref}]` });
+      const b = block as { file_id?: string; filename?: string; file_data?: string };
+      const fileId = nonEmptyString(b.file_id);
+      const fileData = nonEmptyString(b.file_data);
+      const filename = nonEmptyString(b.filename);
+      if (fileId) {
+        parts.push({ type: "text", text: `[file: ${fileId}]` });
+      } else if (fileData) {
+        parts.push({ type: "text", text: filename ? `[file: ${filename}]` : "[file: inline data]" });
+      }
     }
```

### [SUPERSEDED — 적용 금지]

아래 call-site 정규화는 A-gate 3라운드 FAIL로 무효화됐다. `parser.ts:53`의 단일-text collapse와
Cursor의 문자열 길이 기준 필터 때문에 parser 단독으로는 invariant를 달성할 수 없다.
참고용으로만 남긴다.

user/developer call site(`parser.ts:346-352`)에서 빈 결과를 정규화한다. `inputContentParts()`가
비배열 early return으로 `[]`를 주는 경로도 여기서 함께 잡힌다.

```
           case "user":
           case "developer": {
             pendingReasoning.length = 0;
             const content = inputContentParts(msg.content as unknown[] | string | undefined);
-            messages.push({ role: msg.role, content, timestamp: now });
+            // 빈 배열을 그대로 내보내면 Cursor(request-builder.ts:236)가 메시지를 제거하고
+            // tool result가 아닌데도 resumeAction을 만든다. 중립 문구로 정규화한다.
+            // image/file 존재를 주장하지 않으므로 원래 결함([image: ?])은 재발하지 않는다.
+            const normalized = Array.isArray(content) && content.length === 0
+              ? [{ type: "text" as const, text: "[empty or unsupported content]" }]
+              : content;
+            messages.push({ role: msg.role, content: normalized, timestamp: now });
             break;
           }
```

문구는 `[empty or unsupported content]`다. literal `[]`(정상 empty)와 malformed drop을 모두
포괄하므로 정상 입력을 "unsupported"라고 단정하지 않는다.

`file_url` 스키마 추가와 Kiro의 빈 assistant history 처리는 이 WP 범위 밖이며 D 영수증에
후속 후보로 기록한다.

계약의 precedence는 image가 `image_url > file_id > 생략`, file이 `file_id > file_data(+optional
filename) > 생략`이다. `filename` 단독은 파일 resource가 아니므로 marker를 만들지 않는다.
어떤 경로도 `?`, raw `file_data`, object stringification을 사용자 content로 만들지 않는다.

### A-gate 라운드1 blocker 반영 — 계약 개정

독립 감사가 High 3건 + Medium 1건을 냈다. 아래로 계약을 개정한다.

#### blocker 1 (High) — `detail` narrowing이 typecheck를 깨뜨린다

`nonEmptyString(b.detail)`을 조건으로만 쓰면 `b.detail`이 narrow되지 않아
`normalizeImageDetail(b.detail)`에 `string | undefined`가 전달된다. compiler probe로 재현됨.
**반드시 지역 변수에 저장해서 쓴다.**

```ts
const detail = nonEmptyString(b.detail);
// ...
...(detail ? { detail: normalizeImageDetail(detail) } : {}),
```

#### [SUPERSEDED — 비규범 역사 기록, 구현하지 말 것] blocker 3 — 빈 content와 Cursor `resumeAction`

> **이 절 전체는 무효다.** 아래 내용은 A-gate 3라운드에서 왜 이 방향을 포기했는지 남기는
> 역사 기록이며, 어떤 코드도 이 절을 근거로 작성하지 않는다. `parts.length === 0` 정규화,
> placeholder 삽입, Cursor 회귀 요구는 모두 이번 WP 범위 밖이다.
> 살아있는 계약은 문서 최상단 '계획 재설계' 절과 canonical diff뿐이다.

가짜 마커를 제거하면 malformed-only 메시지의 `content`가 `[]`가 된다. adapter별 실측 결과:

| adapter | 빈 content 처리 | 안전성 |
|---|---|---|
| Google | WP1(#430)이 `[{text:"(empty)"}]`로 대체 | 안전 |
| Anthropic | `"(empty)"` 대체 + 빈 assistant skip, `length > 0` 가드 존재 | 안전 |
| OpenAI-chat / MiMo | 빈 user 배열 → `content: ""` | builder는 통과하나 strict provider 증거 없음 |
| Kiro | 빈 current user → `content: ""` | malformed-only 첫 turn 미검증 |
| **Cursor** | `request-builder.ts:236`의 `content.length > 0` 필터가 메시지를 **제거**하고, tool result가 아닌데도 `resumeAction`을 만든다 | **안전하지 않음** |
| OpenAI Responses / Azure passthrough | `_rawBody` 사용 | 영향 없음 |

추가 실측 (정정, A-gate 라운드2): `src/adapters/image.ts:19` `contentPartsToText()`는 빈 배열과
all-empty text 배열에서 `"[image]"`를 반환한다.

```
$ bun -e 'contentPartsToText([])'                      -> "[image]"
$ bun -e 'contentPartsToText([{type:"text",text:""}])'  -> "[image]"
```

**다만 이것은 이번 user-message 경로의 소비처가 아니다.** `openai-chat.ts:149` 부근의 user
content는 직접 `map(...).join("")`하고, `contentPartsToText()`는 tool result에 쓰인다.
따라서 이 정규화의 근거는 **Cursor 메시지 유실**이며, `"[image]"` 허위 마커는 별도 후속
이슈로 분리한다. D 영수증에 후속 후보로 기록한다.

**따라서 parser 계약을 변경한다: 가짜 *ref* 마커는 없애되, 빈 content 배열을 downstream에
내보내지 않는다.** user/developer 메시지의 모든 파트가 drop된 경우 중립 placeholder 한 개를
남긴다. 이것은 존재하지 않는 image/file을 주장하지 않으면서, adapter가 메시지를 잃지 않게 한다.

```ts
// inputContentParts()의 반환 직전
// 모든 파트가 malformed로 drop된 경우: 빈 배열을 내보내면 Cursor는 메시지를 제거하고
// contentPartsToText()는 "[image]"라는 허위 마커를 만든다. 중립 텍스트로 정규화한다.
if (parts.length === 0) return [{ type: "text", text: "[unsupported content]" }];
```

`"[unsupported content]"`는 image/file 존재를 주장하지 않고 "보낼 수 없는 무언가가 있었다"만
표현한다. 원래 결함(`[image: ?]` / `[file: ?]`가 실제 첨부를 주장하는 것)은 해소되고,
Cursor 메시지 유실과 `"[image]"` 허위 마커도 함께 막힌다.

#### blocker 2 (High) — file 계약을 실제 스키마에 맞춘다

`src/responses/schema.ts:15-18`의 `input_file`은 `file_id`/`filename`/`file_data`만 받고
`file_url`은 없다. OpenAI 공식 사용 형태는 `file_id`, `file_url`, 또는 `filename + file_data`이며
**`filename` 단독은 파일 resource가 아니다.**

개정된 precedence:

1. `file_id`가 있으면 `[file: <file_id>]`
2. `file_data`가 있으면 `filename`이 있을 때 `[file: <filename>]`, 없으면 `[file: inline data]`
   (어느 경우도 `file_data` 바이트를 content로 만들지 않는다)
3. 위 어느 것도 없으면 이 블록을 생략한다 — **`filename` 단독으로 marker를 만들지 않는다**

`file_url` 스키마 추가는 이 WP의 범위를 넘는 별도 기능이므로 하지 않는다. D 영수증에
후속 이슈 후보로 기록한다.

#### blocker 4 (Medium) — 통합 assertion에 실제 malformed image/file을 넣는다 [유효]

원래 raw→Google assertion은 missing `input_text`만 입력해 image/file 경로를 한 번도 실행하지
않았다. 개정: malformed `input_image`(ref 없음)와 malformed `input_file`(ref 없음)을 raw input에
넣고 **Google wire 결과만** 관찰한다. Cursor 검증은 범위 밖이므로 요구하지 않는다.

### 우리 test delta — `tests/responses-parser-malformed-content.test.ts` MODIFY

PR의 assistant malformed test 근처에 `[null]` 직접 사례를 추가한다.

```diff
@@
   test("an assistant output_text with no text key does not become a bare text part", () => {
@@
     expect(msg.content).toEqual([{ type: "text", text: "kept" }]);
   });
 
+  test("an assistant content array containing null is dropped without throwing", () => {
+    expect(() => parseRequest(inputOf("assistant", [null]))).not.toThrow();
+    const parsed = parseRequest(inputOf("assistant", [null]));
+    const msg = parsed.context.messages[0] as { content: unknown[] };
+    expect(msg.content).toEqual([]);
+  });
+
   test("a refusal block with a non-string refusal is dropped", () => {
```

기존 malformed image test 뒤에 no-ref 계약을 추가한다.

```diff
@@
   test("an input_image with a non-string image_url degrades to a file marker instead of crashing", () => {
     expect(userContent([{ type: "input_image", image_url: { bad: true }, file_id: "file_1" }]))
       .toBe("[image: file_1]");
   });
 
+  test("an input_image without a non-empty URL or file ref is omitted", () => {
+    expect(userContent([{ type: "input_image", image_url: { bad: true } }])).toEqual([]);
+    expect(userContent([{ type: "input_image", image_url: "", file_id: "" }])).toEqual([]);
+    expect(userContent([{ type: "input_image", file_id: { bad: true } }])).toEqual([]);
+  });
+
   test("a valid image block is still preserved structurally", () => {
```

정상/malformed `input_file` 필드별 계약을 추가한다.

```diff
@@
   test("a valid image block is still preserved structurally", () => {
@@
       .toEqual([{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" }]);
   });
 
+  test("input_file marker follows file_id > file_data(+filename) > omit precedence", () => {
+    expect(userContent([{ type: "input_file", file_id: "file_1" }])).toBe("[file: file_1]");
+    // filename 단독은 파일 resource가 아니므로 생략된다 (A-gate 반영).
+    expect(userContent([{ type: "input_file", filename: "report.pdf" }])).toEqual([]);
+    expect(userContent([{ type: "input_file", file_data: "ZmlsZQ==" }])).toBe("[file: inline data]");
+    // filename + file_data는 공식 Base64 사용 형태다. filename을 이름으로 쓰는 true branch.
+    expect(userContent([{ type: "input_file", filename: "report.pdf", file_data: "ZmlsZQ==" }]))
+      .toBe("[file: report.pdf]");
+    // file_data 바이트는 어떤 경로에서도 content로 새지 않는다.
+    expect(JSON.stringify(userContent([{ type: "input_file", filename: "report.pdf", file_data: "ZmlsZQ==" }])))
+      .not.toContain("ZmlsZQ==");
+    expect(userContent([{
+      type: "input_file",
+      file_id: "file_1",
+      filename: "report.pdf",
+      file_data: "ZmlsZQ==",
+    }])).toBe("[file: file_1]");
+  });
+
+  test("malformed input_file fields are omitted instead of becoming [file: ?]", () => {
+    expect(userContent([{ type: "input_file" }])).toEqual([]);
+    expect(userContent([{ type: "input_file", file_id: "", filename: "", file_data: "" }])).toEqual([]);
+    expect(userContent([{
+      type: "input_file",
+      file_id: { bad: true },
+      filename: 42,
+      file_data: false,
+    }])).toEqual([]);
+  });
+
   test("adapters build a request from malformed input instead of throwing", async () => {
```

마지막 adapter smoke를 실제 raw Responses → Google wire assertion으로 강화한다. Anthropic no-throw는 유지한다.

```diff
@@
   test("adapters build a request from malformed input instead of throwing", async () => {
-    const parsed = parseRequest(inputOf("user", [{ type: "input_text" }]));
+    // ref 없는 malformed image/file을 실제로 통과시켜 두 repair branch를 활성화한다.
+    // missing input_text만 넣으면 image/file 경로가 한 번도 실행되지 않는다 (A-gate 반영).
+    const parsed = parseRequest(inputOf("user", [
+      { type: "input_text" },
+      { type: "input_image" },
+      { type: "input_file" },
+    ]));
     const google = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" } as unknown as OcxProviderConfig;
     const anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x" } as unknown as OcxProviderConfig;
 
-    await expect(createGoogleAdapter(google).buildRequest(parsed)).resolves.toBeDefined();
+    const googleRequest = await createGoogleAdapter(google).buildRequest(parsed);
+    // WP1(#430)의 빈 parts 방어가 placeholder를 넣는다. 세 malformed block 모두 생략됐다는 뜻.
+    expect(JSON.parse(googleRequest.body).contents).toEqual([
+      { role: "user", parts: [{ text: "(empty)" }] },
+    ]);
+    // 가짜 ref marker가 wire에 절대 나타나지 않는다.
+    expect(googleRequest.body).not.toContain("[image: ?]");
+    expect(googleRequest.body).not.toContain("[file: ?]");
+    expect(googleRequest.body).not.toContain("undefined");
     await expect(createAnthropicAdapter(anthropic).buildRequest(parsed)).resolves.toBeDefined();
   });
```

이 assertion은 #436만 적용한 dev에서는 `parts: []`로 실패하고 WP1 적용 후에만 통과하므로 순서 의존을 실행 가능하게 고정한다.

## 검증

WP1 green 확인부터 시작한다.

```bash
bun test tests/google-empty-content.test.ts
bun test tests/responses-parser-malformed-content.test.ts
bun test tests/responses-parser-malformed-content.test.ts tests/responses-parser.test.ts tests/google-empty-content.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun run lint:gui
```

변경 범위/patch integrity:

```bash
git diff --check
git diff --name-status -- src/responses/parser.ts tests/responses-parser-malformed-content.test.ts
rg -n '\[image: \?\]|\[file: \?\]' src/responses/parser.ts tests/responses-parser-malformed-content.test.ts
```

마지막 `rg`는 exit 1(매치 없음)이 성공 조건이다.

### 추가 필수 테스트 (A-gate 라운드2 반영)

아래 표에서 `SUPERSEDED`가 아닌 항목만 필수다. 취소선 항목은 계획 재설계로 무효이며 구현·검증 대상이 아니다.

| 테스트 | 트리거 | 관찰 (실행 증거) |
|---|---|---|
| ~~빈 content 정규화~~ | **SUPERSEDED — 이번 WP 범위 밖** | — |
| ~~system 미오염~~ | **SUPERSEDED — 정규화를 하지 않으므로 해당 없음** | — |
| ~~Cursor 회귀~~ | **SUPERSEDED — 범위 밖. 별도 이슈로 분리** | — |
| file precedence | `file_id` 단독 / `file_data` 단독 / `filename + file_data` / `filename` 단독 | 각각 `[file: <id>]`, `[file: inline data]`, `[file: <filename>]`, 그리고 **생략** |

통합 assertion은 malformed `input_image`(ref 없음)와 malformed `input_file`(ref 없음)을 실제
raw input에 포함해 **Google wire 결과만** 관찰한다. Cursor 검증은 이 WP 범위 밖이다.

## 수용 기준

- [ ] WP1이 먼저 적용되어 `tests/google-empty-content.test.ts`가 green이다.
- [ ] 적용 직전 PR #436 head가 `acfe5c14034c0e3a5802757ab53b1ef1212747ab`와 일치한다.
- [ ] PR snapshot 209줄을 먼저 적용한 뒤 우리 repair만 추가한다.
- [ ] changed-file ledger는 `src/responses/parser.ts`와 `tests/responses-parser-malformed-content.test.ts` 두 파일뿐이다.
- [ ] `inputContentParts()`와 `outputTextOf()`는 non-array container, null block, malformed field에서 throw하지 않는다.
- [ ] assistant `content: [null]`은 content `[]`가 되며 bare text part가 없다.
- [ ] non-empty `image_url`은 structured image, non-empty `file_id`는 image marker가 된다.
- [ ] URL/ref 없는 malformed `input_image`는 생략되며 `[image: ?]`가 없다.
- [ ] `input_file`의 `file_id` 단독, `file_data` 단독, `filename + file_data` 조합이 각각
      `[file: <id>]`, `[file: inline data]`, `[file: <filename>]`이 된다.
- [ ] **`filename` 단독인 malformed `input_file`은 생략된다** — 가짜 파일 marker를 만들지 않는다.
- [ ] empty/non-string file fields는 생략되며 `[file: ?]`와 raw `file_data` 노출이 없다.
- [ ] **`detail` narrowing**: `bun run typecheck`가 exit 0이다 (지역 변수 없이 조건 호출만 하면
      `string | undefined` 오류가 난다).
- [ ] raw malformed Responses input이 Google wire에서 `parts: [{ text: "(empty)" }]`가 되어 #420 경로를 재발시키지 않는다.
- [ ] 통합 assertion이 **실제 malformed `input_image`(ref 없음)와 malformed `input_file`(ref 없음)을
      raw input에 넣고** Google wire 결과를 관찰한다. missing `input_text`만 넣는 assertion은
      image/file 경로를 활성화하지 못하므로 불충분하다.
- [ ] valid blocks가 malformed siblings와 함께 있을 때 그대로 보존된다.
- [ ] focused tests, parser+Google integration, typecheck, full suite, privacy scan, GUI lint, `git diff --check`가 모두 기대한 exit code다.

## 실행 영수증

_(C/D 단계에서 작성)_
