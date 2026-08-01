# WP3 — Kiro per-attempt usage와 절대 context pressure 분리: PR #439 통합

## A-gate 반영 — 우리 test delta 2건 (활성화 공백)

독립 감사 결과 production 결함·보안 blocker는 없다(`VERDICT: GO-WITH-FIXES (blockers=2)`).
둘 다 **테스트가 조건부 경로를 실제로 증명하지 못하는** 활성화 공백이다. 원래 계획은
"우리 delta 없음, PR 그대로 통합"이었으나 아래 2건을 추가한다.

### delta 1 — fallback checkpoint가 rebuilt estimate에서 왔음을 구별한다

`tests/kiro-stream.test.ts`의 fallback 테스트(PR 기준 `:315-336`)는 실제 fallback을 실행하지만,
`mergeKiroUsage()`의 `first.contextTotalTokens + second.outputTokens` floor만으로 현재 assertion이
만족된다. 즉 `fallback.contextInputEstimate` 전달을 stale initial estimate로 퇴행시켜도 통과한다.

계약: **첫 attempt의 visible assistant progress 크기만 다른 두 실행**을 비교해 checkpoint가
서로 달라짐을 관찰한다. progress가 크면 두 번째 attempt의 rebuilt payload가 커지므로 checkpoint도
커져야 한다. stale estimate를 쓰면 두 값이 같아져 회귀가 잡힌다.

### delta 2 — non-stream `parseResponse`가 estimate closure를 활성화한다

non-stream 테스트가 `buildRequest()`를 호출하지 않아 `src/adapters/kiro.ts`의
`contextInputEstimate` closure 전달이 활성화되지 않는다.

계약: long-history 요청으로 먼저 `buildRequest()`를 호출한 뒤 `parseResponse()`의 terminal usage에서
absolute checkpoint가 per-attempt input보다 크다는 것을 단언한다.

두 delta 모두 기존 테스트를 수정하지 않고 새 테스트로 추가한다.

## 루프 계약

- **Archetype:** 독립 리뷰에서 `MERGE_OK`를 받은 cross-module usage-contract PR의 verbatim integration.
- **Trigger:** Kiro의 현재-turn usage와 활성 context 점유가 같은 total로 취급되어 Responses compaction pressure, fallback 합산, request logging이 서로 다른 의미의 숫자를 섞는다.
- **Goal:** PR #439(`e78e8463`)의 742줄 전체 diff를 그대로 적용해 per-attempt usage는 합산 가능한 비용으로, `contextTotalTokens`는 절대 활성-context checkpoint로 분리하고 streaming/non-stream/fallback/bridge/logging 전 경로를 보존한다.
- **Non-goals:** Kiro OAuth/브라우저 멀티계정(PR #447), provider credential 처리, context-window catalog 변경, 새로운 compaction threshold 정책, #439 밖 리팩터링.
- **Verifier:** six-file changed-file ledger, 세 focused test files, typecheck/full suite/privacy scan. 독립 reviewer는 usage double-count, fallback monotonicity, cache-detail bound, request-log persistence를 재검토한다.
- **Stop condition:** PR snapshot이 clean apply되고 추가 수정 없이 모든 검증이 exit 0이며, #447이 #439 위 rebase 대상으로 기록되어 있다.
- **Terminal outcomes:** `MERGE_OK`, `REWORK`, `STALE`, `BLOCKED_BY_OVERLAP`.

## 착수 시점 사실

- 기준 시각: 2026-07-25 KST.
- worktree: `/Users/jun/.codex/worktrees/ebcd/opencodex`.
- 현재 체크아웃은 detached HEAD이며, `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad`.
- PR #439 base/head: `dev` ← `e78e84636b799e37ac985e83781190bda6539e0c` (`fix/kiro-context-usage-reporting`).
- PR 원문 diff 길이: 정확히 742줄.
- 대상 파일: `src/adapters/kiro.ts`, `src/bridge.ts`, `src/types.ts`, `tests/bridge.test.ts`, `tests/kiro-stream.test.ts`, `tests/request-log.test.ts` — 모두 MODIFY, NEW/DELETE 없음.
- 실행 명령: `gh pr diff 439 --repo lidge-jun/opencodex | git apply --check -`.
- 결과: exit 0, stderr/stdout 없음. 기준 `037e8f5e`에 clean apply된다.
- 독립 리뷰 판정: `MERGE_OK`.
- 2026-07-25 조회 당시 PR #447 head는 `0c73bd1f06a4b6a7fa9973043330bcd943869e6b`. 보안 경계 때문에 별도 보류된 Kiro 브라우저 멀티계정 PR이며 `src/adapters/kiro.ts`와 `src/types.ts`를 함께 수정한다.
- #447의 직접 겹침은 base `src/adapters/kiro.ts:1101-1108`의 `createKiroAdapter().build()`에서 global region/profile lookup을 `parsed._kiroAuthContext` 기반으로 바꾸는 hunk다. #439가 같은 owner를 확장하고 행을 이동시키므로 **#439가 먼저**, #447은 이후 최신 dev 위 rebase/re-audit 대상이다. `src/types.ts`에서는 #447이 `OcxParsedRequest._kiroAuthContext`를 추가하고 #439가 `OcxUsage.contextTotalTokens`를 추가해 직접 동일 hunk는 아니지만 같은 파일 계약이므로 rebase 후 typecheck가 필요하다.

## 변경 계약

### 적용 순서와 고정점

1. 적용 직전 `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad` 및 PR head full SHA를 재확인한다.
2. 아래 742줄 PR snapshot을 **verbatim** 적용한다. 수동 최적화/renaming/formatting을 섞지 않는다.
3. snapshot 외 추가 코드는 없다. 테스트가 실패하면 임의 수정하지 말고 `REWORK`로 원인을 기록하고 A로 돌린다.
4. #447은 이 WP에 섞지 않는다. #439 통합 후 #447의 `createKiroAdapter` hunk를 최신 행/closure 상태에 맞춰 별도 rebase한다.

### 파일별 변경 의미와 데이터 흐름

#### `src/types.ts:308-322` MODIFY — 절대 checkpoint 타입 계약

- 기존 `inputTokens`, `outputTokens`, optional `totalTokens`는 per-attempt/provider usage 의미를 유지한다.
- NEW `contextTotalTokens?: number`는 **응답 후 절대 활성 context 크기**다.
- bridge는 `contextTotalTokens - outputTokens`로 Responses input side를 역산하므로 output을 절대 checkpoint에 다시 더하지 않는다.

#### `src/adapters/kiro.ts:138-215` MODIFY — 서로 다른 두 estimator

- `estimateKiroInputTokens()`(`:188-199`)는 current-turn 및 stable overhead만 세어 각 attempt의 `inputTokens`를 만든다.
- `estimateKiroPayloadInputTokens()`(`:151-182`)는 실제 `buildKiroPayload()`의 normalized `history + currentMessage + tools + toolResults + assistant toolUses + images`를 세어 활성 context estimate를 만든다.
- image는 `sniffImageDimensions()`가 있으면 pixel/750, 없으면 decoded bytes/512를 쓰되 최소 256 token으로 clamp한다(`:138-145`).
- `estimateKiroTokens()`는 model을 `kiro/<modelId>` namespace로 넘겨 Kiro route의 tokenizer ratio를 사용한다(`:147-149`).
- upstream percentage 분모는 user-configured client cap이 아니라 `KIRO_MODEL_CONTEXT_WINDOWS`의 native model window다(`:208-215`). `auto`는 response content의 concrete `modelId`가 올 때까지 undefined다.

#### `src/adapters/kiro.ts:594-651, 819-834, 928-954` MODIFY — 한 attempt의 usage

- `parseKiroAttempt()`은 per-attempt `inputTokens`와 별도 `contextInputEstimate`, 공유 `KiroContextWindowState`를 받는다(`:594-604`).
- per-attempt base usage는 provider metadata가 유효하면 authoritative usage, 아니면 current attempt input + generated chars estimate다(`:635-640`).
- 절대 context는 `max(payload estimate + output, percentage × native window, authoritative input + output)`이다(`:630-650`). 따라서 estimate가 authoritative turn usage보다 작아질 수 없다.
- content event가 concrete model ID를 주면 shared context-window state를 갱신해 뒤이어 오는 percentage를 해석한다(`:829-832`).
- terminal/error/incomplete 모두 같은 `usage()` owner를 사용하고, diagnostic은 `upstreamContextWindow` 명칭으로 기록한다(`:928-954`).

#### `src/adapters/kiro.ts:1051-1168` MODIFY — streaming/fallback 합성

- 첫 streaming attempt에 최초 payload의 `contextInputEstimate`를 전달한다(`:1051-1073`).
- bounded fallback은 request snapshot에 first assistant progress를 붙여 payload를 다시 만들고, **그 rebuilt payload의 estimate**를 second attempt에 전달한다(`:1094-1138`, build path는 `:1244-1282`).
- `mergeKiroUsage()`(`:526-567`)는 두 attempt의 `inputTokens`/ `outputTokens`/cache detail을 합산한다.
- context checkpoint는 두 attempt checkpoint의 max를 취한다. first attempt에 실제 assistant text가 있었다면 `first.contextTotalTokens + second.outputTokens`도 floor로 포함해 fallback 출력으로 증가한 확실한 context growth를 잃지 않는다(`:543-559`, 호출 `:1145-1167`).
- reasoning-only first attempt처럼 first assistant text가 없을 때도 combined output보다 context total이 작아지지 않는다.

#### `src/adapters/kiro.ts:1172-1345` MODIFY — build closure와 streaming/non-stream parity

- per-request closure에 `contextInputEstimate`를 별도 보관한다(`:1172-1182`).
- `build()`은 image normalization **후** actual Kiro payload estimate를 계산하고, request-log용 full Codex context estimate와 current-attempt estimate를 구분해 반환한다(`:1214-1241`).
- `buildRequest()`가 native window/current attempt/context estimate를 closure에 저장한다(`:1285-1298`).
- streaming `parseStream()`과 non-streaming `parseResponse()`가 모두 같은 `parseKiroStream(..., contextInputEstimate)`를 호출한다(`:1301-1312`, `:1331-1344`). 한 경로만 고치는 반쪽 수정은 허용되지 않는다.

#### `src/bridge.ts:16-48` MODIFY — Responses serialization과 cache-detail clamp

- `contextTotalTokens`가 있으면 `input_tokens = max(0, contextTotalTokens - outputTokens)`, `total_tokens = contextTotalTokens`다.
- checkpoint가 없으면 기존 `inputTokens` 및 `usageDisplayTotalTokens()` fallback을 유지한다.
- `cached_tokens <= derived input_tokens`; `cache_write_tokens <= derived input - cacheRead`로 clamp해 detail 합이 input을 넘지 않는다.
- 이 serialization은 streaming Responses terminal과 non-stream collector가 공유하므로 양쪽에 같은 absolute checkpoint가 노출된다.

#### `tests/kiro-stream.test.ts:315-405, 820-1037` MODIFY — adapter 계약 증명

- rebuilt fallback context와 upstream percentage 후 fallback growth(`:315-353`).
- reasoning-only fallback에서 `contextTotalTokens >= outputTokens`(`:391-406`).
- authoritative turn usage floor와 기존 cache split 보존(`:820-865`).
- percentage/native window/client-cap 분리, `auto` concrete model update, GPT Kiro ratio(`:905-964`).
- fresh full history가 context pressure에는 반영되지만 current-turn input은 동일함(`:966-990`).
- normalized payload에서 빠진 private reasoning은 request log estimate에만 남고 context checkpoint에는 들어가지 않음(`:992-1005`).
- normalized image 최소 token 및 request-log/current-turn 분리(`:1007-1037`).

#### `tests/bridge.test.ts:132-213` MODIFY — serialization/double-count 방지

- 226,000 checkpoint + output 12가 input 225,988 / total 226,000으로 직렬화된다.
- 연속 checkpoint 10,000 → 10,300은 bridge가 누적합하지 않고 각각 절대값으로 유지한다.
- cache read/write detail이 derived input 90을 넘지 않도록 90/0으로 clamp된다.

#### `tests/request-log.test.ts:755-783` MODIFY — deferred logging

- bridged SSE의 input 49,900 / total 50,000을 response body에서 확인한다.
- `responseWithDeferredRequestLog()`가 body를 소비한 뒤 persisted entry에도 input 49,900, output 100, total 50,000을 보존한다.
- request-start fallback estimate(`usageLogInputTokens: 200`)가 terminal absolute checkpoint를 덮어쓰지 않는다.

### PR snapshot diff — 정확한 before/after

출처: `gh pr diff 439 --repo lidge-jun/opencodex`, head `e78e84636b799e37ac985e83781190bda6539e0c`. 아래가 이 WP의 전체 코드/test 변경이며 별도 delta는 없다.

```diff
diff --git a/src/adapters/kiro.ts b/src/adapters/kiro.ts
index 9cb55e06..9e43e891 100644
--- a/src/adapters/kiro.ts
+++ b/src/adapters/kiro.ts
@@ -32,6 +32,7 @@ import type {
 import type { ProviderAdapter } from "./base";
 import type { AdapterFetchContext, AdapterRequest } from "./base";
 import { extractKiroImages, normalizeKiroImages, type KiroImage } from "./kiro-images";
+import { sniffImageDimensions } from "./anthropic-image-guard";
 import { fetchKiroWithRetry } from "./kiro-retry";
 import { convertKiroToolContext } from "./kiro-tools";
 import { neutralizeIdentity } from "./identity";
@@ -134,6 +135,52 @@ function messageLogText(msg: OcxMessage): string {
   }).filter(Boolean).join("\n");
 }
 
+function estimateKiroImageTokens(image: KiroImage): number {
+  const dimensions = sniffImageDimensions(image.source.bytes);
+  if (dimensions) {
+    return Math.max(256, Math.ceil(dimensions.width * dimensions.height / 750));
+  }
+  const decodedBytes = Math.floor(image.source.bytes.length * 3 / 4);
+  return Math.max(256, Math.ceil(decodedBytes / 512));
+}
+
+function estimateKiroTokens(text: string, modelId?: string): number {
+  return estimateTokens(text, modelId ? `kiro/${modelId}` : "kiro");
+}
+
+function estimateKiroPayloadInputTokens(payload: Record<string, unknown>, modelId: string): number {
+  const conversationState = (payload as {
+    conversationState?: {
+      history?: KiroHistoryEntry[];
+      currentMessage?: KiroHistoryEntry;
+    };
+  }).conversationState;
+  if (!conversationState) return 0;
+
+  const parts: string[] = [];
+  let imageTokens = 0;
+  const entries = [
+    ...(conversationState.history ?? []),
+    ...(conversationState.currentMessage ? [conversationState.currentMessage] : []),
+  ];
+  for (const entry of entries) {
+    const user = entry.userInputMessage;
+    if (user) {
+      if (user.content) parts.push(user.content);
+      for (const image of user.images ?? []) imageTokens += estimateKiroImageTokens(image);
+      const context = user.userInputMessageContext;
+      if (context?.tools?.length) parts.push(serializeForUsage(context.tools));
+      if (context?.toolResults?.length) parts.push(serializeForUsage(context.toolResults));
+    }
+    const assistant = entry.assistantResponseMessage;
+    if (assistant) {
+      if (assistant.content) parts.push(assistant.content);
+      if (assistant.toolUses?.length) parts.push(serializeForUsage(assistant.toolUses));
+    }
+  }
+  return estimateKiroTokens(parts.join("\n"), modelId) + imageTokens;
+}
+
 function shouldCountStablePromptOverhead(parsed: OcxParsedRequest): boolean {
   return !parsed.previousResponseId && !parsed.context.messages.some(m => m.role === "assistant");
 }
@@ -148,25 +195,21 @@ function estimateKiroInputTokens(parsed: OcxParsedRequest): number {
     if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
   }
 
-  return estimateTokens(parts.join("\n"), parsed.modelId);
+  return estimateKiroTokens(parts.join("\n"), parsed.modelId);
 }
 
 function estimateKiroLogInputTokens(parsed: OcxParsedRequest): number {
   const parts = parsed.context.messages.map(messageLogText).filter(Boolean);
   if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
   if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
-  return Math.max(estimateKiroInputTokens(parsed), estimateTokens(parts.join("\n"), parsed.modelId));
+  return Math.max(estimateKiroInputTokens(parsed), estimateKiroTokens(parts.join("\n"), parsed.modelId));
 }
 
-function configuredKiroContextWindow(provider: OcxProviderConfig, modelId: string | undefined): number | undefined {
+function kiroUpstreamContextWindow(modelId: string | undefined): number | undefined {
   if (!modelId) return undefined;
   const normalizedModelId = normalizeKiroModelId(modelId);
   if (normalizedModelId === "auto") return undefined;
-  const window =
-    modelRecordValue(provider.modelContextWindows, modelId)
-    ?? modelRecordValue(provider.modelContextWindows, normalizedModelId)
-    ?? provider.contextWindow
-    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
+  const window = modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
     ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalizedModelId);
   return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
 }
@@ -465,17 +508,26 @@ interface KiroAttemptResult {
 interface KiroFallbackAttempt {
   response: Response;
   inputTokens: number;
+  contextInputEstimate: number;
   nameMap: Map<string, string>;
   conversationId: string;
 }
 
+interface KiroContextWindowState {
+  value?: number;
+}
+
 type KiroFallbackFactory = (
   conversationId: string | undefined,
   assistantText: string,
   sawReasoning: boolean,
 ) => Promise<KiroFallbackAttempt>;
 
-function mergeKiroUsage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
+function mergeKiroUsage(
+  first: OcxUsage | undefined,
+  second: OcxUsage | undefined,
+  preserveFirstContextGrowth = false,
+): OcxUsage | undefined {
   if (!first) return second;
   if (!second) return first;
   const sumOptional = (key: keyof OcxUsage): number | undefined => {
@@ -488,9 +540,23 @@ function mergeKiroUsage(first: OcxUsage | undefined, second: OcxUsage | undefine
   const totalTokens = typeof first.totalTokens === "number" && typeof second.totalTokens === "number"
     ? first.totalTokens + second.totalTokens
     : undefined;
+  const carriedContextTotal = preserveFirstContextGrowth && typeof first.contextTotalTokens === "number"
+    ? first.contextTotalTokens + second.outputTokens
+    : undefined;
+  const combinedOutputTokens = first.outputTokens + second.outputTokens;
   return {
     inputTokens: first.inputTokens + second.inputTokens,
-    outputTokens: first.outputTokens + second.outputTokens,
+    outputTokens: combinedOutputTokens,
+    ...(typeof first.contextTotalTokens === "number" || typeof second.contextTotalTokens === "number"
+      ? {
+          contextTotalTokens: Math.max(
+            first.contextTotalTokens ?? 0,
+            second.contextTotalTokens ?? 0,
+            carriedContextTotal ?? 0,
+            combinedOutputTokens,
+          ),
+        }
+      : {}),
     ...(totalTokens !== undefined ? { totalTokens } : {}),
     ...(sumOptional("cachedInputTokens") !== undefined ? { cachedInputTokens: sumOptional("cachedInputTokens") } : {}),
     ...(sumOptional("cacheReadInputTokens") !== undefined ? { cacheReadInputTokens: sumOptional("cacheReadInputTokens") } : {}),
@@ -530,10 +596,11 @@ async function* parseKiroAttempt(
   mode: KiroCompletionMode,
   modelId: string | undefined,
   inputTokens: number,
-  contextWindow: number | undefined,
+  contextWindowState: KiroContextWindowState,
   nameMap: Map<string, string> | undefined,
   conversationId: string | undefined,
   previousAssistantText?: string,
+  contextInputEstimate?: number,
 ): AsyncGenerator<AdapterEvent, KiroAttemptResult> {
   const emptyResult = (): KiroAttemptResult => ({ assistantText: "", sawReasoning: false });
   if (!response.body) {
@@ -560,11 +627,28 @@ async function* parseKiroAttempt(
   const providerState = (): { kiro: { conversationId: string } } | undefined =>
     returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : undefined;
 
-  const usage = (): OcxUsage => authoritativeUsage ?? ({
+  const contextUsageTotalFloor = (): number | undefined => {
+    if (contextUsagePercentage === undefined || !contextWindowState.value) return undefined;
+    const floor = Math.ceil(contextWindowState.value * Math.min(contextUsagePercentage, 100) / 100);
+    return Number.isFinite(floor) && floor > 0 ? floor : undefined;
+  };
+  const usage = (): OcxUsage => {
+    const base = authoritativeUsage ?? {
       inputTokens,
-      outputTokens: estimateTokens(outputChars, modelId),
+      outputTokens: estimateKiroTokens(outputChars, modelId),
       estimated: true,
-    });
+    };
+    const estimatedContextTotal = contextInputEstimate !== undefined
+      ? contextInputEstimate + base.outputTokens
+      : undefined;
+    const authoritativeTurnTotal = base.inputTokens + base.outputTokens;
+    const contextTotal = Math.max(
+      estimatedContextTotal ?? 0,
+      contextUsageTotalFloor() ?? 0,
+      authoritativeTurnTotal,
+    );
+    return contextTotal > 0 ? { ...base, contextTotalTokens: contextTotal } : base;
+  };
 
   const classifiedTerminal = (failure: KiroErrorClassification): AdapterEvent => ({
     type: "error",
@@ -743,6 +827,9 @@ async function* parseKiroAttempt(
           if (isValidKiroConversationId(ev.conversationId)) returnedConversationId = ev.conversationId;
           break;
         case "content":
+          if (ev.modelId) {
+            contextWindowState.value = kiroUpstreamContextWindow(ev.modelId) ?? contextWindowState.value;
+          }
           if (open) {
             open = null;
             return { assistantText, sawReasoning, terminal: protocolTerminal(kiroTruncationErrorMessage("content arrived before tool stop")) };
@@ -843,7 +930,7 @@ async function* parseKiroAttempt(
     if (contextUsagePercentage !== undefined) {
       debugProviderDiagnostic("kiro", "context_usage", {
         contextUsagePercentage,
-        ...(contextWindow ? { configuredContextWindow: contextWindow } : {}),
+        ...(contextWindowState.value ? { upstreamContextWindow: contextWindowState.value } : {}),
       });
     }
     debugProviderDiagnostic("kiro", "attempt_complete", {
@@ -970,15 +1057,19 @@ export async function* parseKiroStream(
   conversationId?: string,
   completionMode: KiroCompletionMode = "disabled",
   fallbackFactory?: KiroFallbackFactory,
+  contextInputEstimate?: number,
 ): AsyncGenerator<AdapterEvent> {
+  const contextWindowState: KiroContextWindowState = { value: contextWindow };
   const first = parseKiroAttempt(
     response,
     completionMode,
     modelId,
     inputTokens,
-    contextWindow,
+    contextWindowState,
     nameMap,
     conversationId,
+    undefined,
+    contextInputEstimate,
   );
   let firstNext = await first.next();
   while (!firstNext.done) {
@@ -1039,10 +1130,11 @@ export async function* parseKiroStream(
     "text_fallback",
     modelId,
     fallback.inputTokens,
-    contextWindow,
+    contextWindowState,
     fallback.nameMap,
     fallback.conversationId,
     firstResult.assistantText,
+    fallback.contextInputEstimate,
   );
   let secondNext = await second.next();
   while (!secondNext.done) {
@@ -1054,7 +1146,8 @@ export async function* parseKiroStream(
     yield retryableKiroIncomplete(
       "empty_kiro_fallback",
       "Kiro's bounded completion retry ended without a terminal result",
-      mergeKiroUsage(firstResult.usage, secondResult.usage) ?? { inputTokens, outputTokens: 0, estimated: true },
+      mergeKiroUsage(firstResult.usage, secondResult.usage, Boolean(firstResult.assistantText))
+        ?? { inputTokens, outputTokens: 0, estimated: true },
       secondResult.providerState ?? firstResult.providerState,
     );
     return;
@@ -1062,7 +1155,7 @@ export async function* parseKiroStream(
   if (secondResult.terminal.type === "done" || secondResult.terminal.type === "incomplete") {
     yield {
       ...secondResult.terminal,
-      usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage),
+      usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage, Boolean(firstResult.assistantText)),
       providerState: secondResult.terminal.providerState ?? firstResult.providerState,
     };
     return;
@@ -1070,7 +1163,7 @@ export async function* parseKiroStream(
   yield {
     ...secondResult.terminal,
     ...(secondResult.terminal.type === "error"
-      ? { usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage) }
+      ? { usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage, Boolean(firstResult.assistantText)) }
       : {}),
   };
 }
@@ -1080,6 +1173,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
   // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
   // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
   let inputTokens = 0;
+  let contextInputEstimate = 0;
   let modelId: string | undefined;
   let contextWindow: number | undefined;
   let toolNameMap: Map<string, string> | undefined;
@@ -1097,6 +1191,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
     conversationId: string;
     completionMode: KiroCompletionMode;
     inputTokens: number;
+    contextInputEstimate: number;
   }> => {
     if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
       throw new Error("kiro token missing — run ocx login kiro");
@@ -1118,6 +1213,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
     if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
     const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode);
     await normalizeKiroImages(built.payload);
+    const contextInputEstimate = estimateKiroPayloadInputTokens(built.payload, parsed.modelId);
     const body = JSON.stringify(built.payload);
     debugProviderDiagnostic("kiro", "request", {
       region,
@@ -1141,6 +1237,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
       conversationId: built.conversationId,
       completionMode: built.completionMode,
       inputTokens: estimateKiroInputTokens(parsed),
+      contextInputEstimate,
     };
   };
 
@@ -1179,6 +1276,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
     return {
       response,
       inputTokens: retry.inputTokens,
+      contextInputEstimate: retry.contextInputEstimate,
       nameMap: retry.nameMap,
       conversationId: retry.conversationId,
     };
@@ -1189,8 +1287,9 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
     async buildRequest(parsed: OcxParsedRequest, incoming) {
       const built = await build(parsed);
       modelId = parsed.modelId;
-      contextWindow = configuredKiroContextWindow(provider, parsed.modelId);
+      contextWindow = kiroUpstreamContextWindow(parsed.modelId);
       inputTokens = built.inputTokens;
+      contextInputEstimate = built.contextInputEstimate;
       toolNameMap = built.nameMap;
       conversationId = built.conversationId;
       completionMode = built.completionMode;
@@ -1209,6 +1308,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
         conversationId,
         completionMode,
         completionMode === "required" ? fallbackFactory : undefined,
+        contextInputEstimate,
       );
     },
 
@@ -1239,6 +1339,7 @@ export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter
         conversationId,
         completionMode,
         completionMode === "required" ? fallbackFactory : undefined,
+        contextInputEstimate,
       )) events.push(e);
       return events;
     },
diff --git a/src/bridge.ts b/src/bridge.ts
index 09f11dd4..6e7025f1 100644
--- a/src/bridge.ts
+++ b/src/bridge.ts
@@ -15,20 +15,29 @@ function sseEvent(name: string, data: Record<string, unknown>): string {
 
 function responsesUsage(usage: OcxUsage | undefined): Record<string, unknown> {
   if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
-  // inputTokens is already inclusive of cache read/write (types.ts convention).
-  const inputTokens = usage.inputTokens;
+  // Stateful providers may report an absolute active-context checkpoint separately from their
+  // per-attempt usage. Split that checkpoint into input + output without adding output twice.
+  const inputTokens = usage.contextTotalTokens !== undefined
+    ? Math.max(0, usage.contextTotalTokens - usage.outputTokens)
+    : usage.inputTokens;
   const out: Record<string, unknown> = {
     input_tokens: inputTokens,
     output_tokens: usage.outputTokens,
-    total_tokens: usageDisplayTotalTokens(usage) ?? inputTokens + usage.outputTokens,
+    total_tokens: usage.contextTotalTokens !== undefined
+      ? usage.contextTotalTokens
+      : usageDisplayTotalTokens(usage) ?? inputTokens + usage.outputTokens,
   };
   const inputDetails: Record<string, number> = {};
   if (usage.cachedInputTokens !== undefined) {
     // cached_tokens carries cache READS only, matching OpenAI semantics.
-    inputDetails.cached_tokens = usage.cachedInputTokens;
+    inputDetails.cached_tokens = Math.min(usage.cachedInputTokens, inputTokens);
   }
   if (usage.cacheCreationInputTokens !== undefined) {
-    inputDetails.cache_write_tokens = usage.cacheCreationInputTokens;
+    const cacheRead = inputDetails.cached_tokens ?? 0;
+    inputDetails.cache_write_tokens = Math.min(
+      usage.cacheCreationInputTokens,
+      Math.max(0, inputTokens - cacheRead),
+    );
   }
   if (Object.keys(inputDetails).length > 0) {
     out.input_tokens_details = inputDetails;
diff --git a/src/types.ts b/src/types.ts
index c5937600..9df4c114 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -308,6 +308,12 @@ export interface OcxUrlCitation {
 export interface OcxUsage {
   inputTokens: number;
   outputTokens: number;
+  /**
+   * Absolute active-context size after the response. Stateful providers can expose this separately
+   * from their per-attempt usage. Responses serialization derives the input side from
+   * `contextTotalTokens - outputTokens` so output is never added to an absolute checkpoint twice.
+   */
+  contextTotalTokens?: number;
   totalTokens?: number;
   cachedInputTokens?: number;
   cacheReadInputTokens?: number;
diff --git a/tests/bridge.test.ts b/tests/bridge.test.ts
index 13f60ee4..00b419f1 100644
--- a/tests/bridge.test.ts
+++ b/tests/bridge.test.ts
@@ -129,6 +129,43 @@ describe("Responses bridge reasoning and usage parity", () => {
     });
   });
 
+  test("absolute context total drives Responses compaction without double-counting output", async () => {
+    const frames = await collectSse(bridgeToResponsesSSE(replay([
+      {
+        type: "done",
+        usage: {
+          inputTokens: 58,
+          contextTotalTokens: 226_000,
+          outputTokens: 12,
+          estimated: true,
+        },
+      },
+    ]), "kiro/claude-opus-5"));
+
+    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
+    expect(completed.usage).toEqual({
+      input_tokens: 225_988,
+      output_tokens: 12,
+      total_tokens: 226_000,
+    });
+  });
+
+  test("consecutive context checkpoints remain absolute instead of accumulating in the bridge", async () => {
+    const totals: number[] = [];
+    for (const [contextTotalTokens, outputTokens] of [[10_000, 42], [10_300, 20]] as const) {
+      const frames = await collectSse(bridgeToResponsesSSE(replay([{
+        type: "done",
+        usage: { inputTokens: 1, contextTotalTokens, outputTokens, estimated: true },
+      }]), "kiro/claude-opus-5"));
+      const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
+      const usage = completed.usage as Record<string, number>;
+      expect(usage.input_tokens).toBe(contextTotalTokens - outputTokens);
+      expect(usage.total_tokens).toBe(contextTotalTokens);
+      totals.push(usage.total_tokens);
+    }
+    expect(totals).toEqual([10_000, 10_300]);
+  });
+
   test("Anthropic cache read and write tokens pass through Responses usage without re-adding", async () => {
     const frames = await collectSse(bridgeToResponsesSSE(replay([
       {
@@ -153,6 +190,28 @@ describe("Responses bridge reasoning and usage parity", () => {
     });
   });
 
+  test("absolute context projection keeps cache details within derived input", async () => {
+    const frames = await collectSse(bridgeToResponsesSSE(replay([{
+      type: "done",
+      usage: {
+        inputTokens: 200,
+        outputTokens: 10,
+        contextTotalTokens: 100,
+        cachedInputTokens: 150,
+        cacheReadInputTokens: 150,
+        cacheCreationInputTokens: 50,
+      },
+    }]), "kiro/claude-opus-5"));
+
+    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
+    expect(completed.usage).toMatchObject({
+      input_tokens: 90,
+      output_tokens: 10,
+      total_tokens: 100,
+      input_tokens_details: { cached_tokens: 90, cache_write_tokens: 0 },
+    });
+  });
+
   test("adapter heartbeat is non-visual in streaming and non-streaming responses", async () => {
     const events: AdapterEvent[] = [
       { type: "heartbeat" },
diff --git a/tests/kiro-stream.test.ts b/tests/kiro-stream.test.ts
index 5dcc6245..c2e9107c 100644
--- a/tests/kiro-stream.test.ts
+++ b/tests/kiro-stream.test.ts
@@ -312,6 +312,46 @@ describe("kiro adapter — parseStream", () => {
     });
   });
 
+  test("bounded fallback uses its rebuilt context estimate for the final absolute checkpoint", async () => {
+    const firstText = "p".repeat(7000);
+    const finalText = "f".repeat(3500);
+    globalThis.fetch = (async () => new Response(streamOf(eventFrame({ content: finalText })))) as typeof fetch;
+    const adapter = createKiroAdapter(provider);
+    const request = await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));
+    const initialContextEstimate = request.usageLog?.inputTokens ?? 0;
+
+    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
+      eventFrame({ content: firstText }),
+    ))));
+    const done = events.at(-1);
+    expect(done?.type).toBe("done");
+    const usage = done?.type === "done" ? done.usage : undefined;
+    expect(usage?.outputTokens).toBe(estimateTokens(firstText, "claude-sonnet-4.5") + estimateTokens(finalText, "claude-sonnet-4.5"));
+    expect(usage?.contextTotalTokens).toBeGreaterThan(
+      initialContextEstimate + Math.max(
+        estimateTokens(firstText, "claude-sonnet-4.5"),
+        estimateTokens(finalText, "claude-sonnet-4.5"),
+      ),
+    );
+  });
+
+  test("bounded fallback preserves definite growth after an upstream context checkpoint", async () => {
+    const finalText = "f".repeat(3500);
+    const finalOutputTokens = estimateTokens(finalText, "claude-sonnet-4.5");
+    globalThis.fetch = (async () => new Response(streamOf(eventFrame({ content: finalText })))) as typeof fetch;
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));
+
+    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
+      eventFrame({ content: "I am checking." }),
+      eventFrame({ contextUsagePercentage: 25 }),
+    ))));
+    const done = events.at(-1);
+
+    expect(done?.type).toBe("done");
+    if (done?.type === "done") expect(done.usage?.contextTotalTokens).toBe(50_000 + finalOutputTokens);
+  });
+
   test("keeps a private-completion fallback after reasoning-only output as the final answer", async () => {
     globalThis.fetch = (async () => new Response(streamOf(...completionFrames("Done.")))) as typeof fetch;
     const adapter = createKiroAdapter(provider);
@@ -348,6 +388,24 @@ describe("kiro adapter — parseStream", () => {
     expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
   });
 
+  test("reasoning-only fallback keeps absolute context above combined output", async () => {
+    const reasoning = "r".repeat(14_000);
+    const finalText = "f".repeat(14_000);
+    globalThis.fetch = (async () => new Response(streamOf(eventFrame({ content: finalText })))) as typeof fetch;
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "solve" }], [bashTool]));
+
+    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
+      eventFrame({ content: `<thinking>${reasoning}</thinking>` }),
+    ))));
+    const done = events.at(-1);
+
+    expect(done?.type).toBe("done");
+    if (done?.type === "done") {
+      expect(done.usage?.contextTotalTokens).toBeGreaterThanOrEqual(done.usage?.outputTokens ?? 0);
+    }
+  });
+
   test("normal Responses cancellation aborts the adapter-owned fallback without another replay", async () => {
     const abort = new AbortController();
     let fetches = 0;
@@ -777,6 +835,7 @@ describe("kiro adapter — parseStream", () => {
     );
     expect(done).toEqual({
       inputTokens: 15,
+      contextTotalTokens: 204,
       cachedInputTokens: 3,
       cacheReadInputTokens: 3,
       cacheCreationInputTokens: 2,
@@ -785,6 +844,26 @@ describe("kiro adapter — parseStream", () => {
     });
   });
 
+  test("authoritative turn usage floors a smaller payload context estimate", async () => {
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
+    const done = await doneUsage(
+      adapter,
+      eventFrame({ content: "answer" }),
+      eventFrame({
+        tokenUsage: {
+          uncachedInputTokens: 500,
+          outputTokens: 4,
+          totalTokens: 504,
+        },
+      }, "metadataEvent"),
+    );
+
+    expect(done.inputTokens).toBe(500);
+    expect(done.outputTokens).toBe(4);
+    expect(done.contextTotalTokens).toBe(504);
+  });
+
   test("invalid provider token usage is rejected instead of replacing estimates", async () => {
     const adapter = createKiroAdapter(provider);
     await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
@@ -823,7 +902,7 @@ describe("kiro adapter — parseStream", () => {
     expect((events[0] as { message: string }).message).toContain("Compact or reduce the history");
   });
 
-  test("Kiro contextUsagePercentage remains diagnostic and does not override totals", async () => {
+  test("Kiro contextUsagePercentage drives context pressure without overriding turn totals", async () => {
     const adapter = createKiroAdapter(provider);
     await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
     const done = await doneUsage(
@@ -836,6 +915,15 @@ describe("kiro adapter — parseStream", () => {
     expect(done.outputTokens).toBe(100);
     expect(done.totalTokens).toBeUndefined();
     expect(done.estimated).toBe(true);
+    expect(done.contextTotalTokens).toBe(50_000);
+  });
+
+  test("Kiro context percentage uses the native model window instead of a configured client cap", async () => {
+    const adapter = createKiroAdapter({ ...provider, contextWindow: 1_000_000 });
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], undefined, "claude-sonnet-4.5"));
+    const done = await doneUsage(adapter, eventFrame({ content: "ok" }), eventFrame({ contextUsagePercentage: 25 }));
+
+    expect(done.contextTotalTokens).toBe(50_000);
   });
 
   test("Kiro auto ignores provider-level context window and falls back to heuristic totals", async () => {
@@ -850,6 +938,29 @@ describe("kiro adapter — parseStream", () => {
     expect(done.inputTokens).toBe(200);
     expect(done.outputTokens).toBe(100);
     expect(done.totalTokens).toBeUndefined();
+    expect(done.contextTotalTokens).toBe(300);
+  });
+
+  test("Kiro auto uses the concrete response model to decode context percentage", async () => {
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], undefined, "kiro-auto"));
+    const done = await doneUsage(
+      adapter,
+      eventFrame({ content: "ok", modelId: "claude-sonnet-4.5" }),
+      eventFrame({ contextUsagePercentage: 25 }),
+    );
+
+    expect(done.contextTotalTokens).toBe(50_000);
+  });
+
+  test("Kiro GPT routes use the Kiro token ratio without context percentage", async () => {
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(3500) }], undefined, "gpt-5.6-sol"));
+    const done = await doneUsage(adapter, eventFrame({ content: "y".repeat(3500) }));
+
+    expect(done.inputTokens).toBe(1000);
+    expect(done.outputTokens).toBe(1000);
+    expect(done.contextTotalTokens).toBe(2000);
   });
 
   test("fresh payload includes history while usage counts only the current turn", async () => {
@@ -875,6 +986,37 @@ describe("kiro adapter — parseStream", () => {
     expect(longBody.length).toBeGreaterThan(shortBody.length + 10_000);
     expect(longUsage.inputTokens).toBe(shortUsage.inputTokens);
     expect(longUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
+    expect(longUsage.contextTotalTokens).toBeGreaterThan(shortUsage.contextTotalTokens ?? 0);
+  });
+
+  test("context pressure follows the normalized Kiro payload while logs retain dropped reasoning", async () => {
+    const privateReasoning = "private-plan-".repeat(1000);
+    const adapter = createKiroAdapter(provider);
+    const request = await adapter.buildRequest(parsedWith([
+      { role: "user", content: "old question" },
+      { role: "assistant", content: [{ type: "thinking", thinking: privateReasoning }] },
+      { role: "user", content: "latest question" },
+    ]));
+    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
+
+    expect(request.body).not.toContain(privateReasoning);
+    expect(request.usageLog?.inputTokens).toBeGreaterThan((usage.contextTotalTokens ?? 0) + 1000);
+    expect(usage.contextTotalTokens).toBeLessThan(1000);
+  });
+
+  test("normalized images contribute conservative context tokens", async () => {
+    const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
+    const adapter = createKiroAdapter(provider);
+    await adapter.buildRequest(parsedWith([{
+      role: "user",
+      content: [
+        { type: "text", text: "inspect" },
+        { type: "image", imageUrl: `data:image/png;base64,${onePixelPng}` },
+      ],
+    }]));
+    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
+
+    expect(usage.contextTotalTokens).toBeGreaterThanOrEqual(256 + usage.outputTokens);
   });
 
   test("request log usage estimates the full Codex context while SSE usage stays current-turn", async () => {
@@ -891,6 +1033,7 @@ describe("kiro adapter — parseStream", () => {
     expect(usage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
     expect(request.usageLog?.estimated).toBe(true);
     expect(request.usageLog?.inputTokens).toBeGreaterThan(usage.inputTokens + 4000);
+    expect(usage.contextTotalTokens).toBe((request.usageLog?.inputTokens ?? 0) + usage.outputTokens);
   });
 
   test("resumed payload preserves the complete locally expanded history", async () => {
diff --git a/tests/request-log.test.ts b/tests/request-log.test.ts
index e7f86a39..cf7689fc 100644
--- a/tests/request-log.test.ts
+++ b/tests/request-log.test.ts
@@ -22,8 +22,14 @@ import {
   sealRequestAttemptIdentity,
   type RequestLogContext,
 } from "../src/server/request-log";
+import { bridgeToResponsesSSE } from "../src/bridge";
+import type { AdapterEvent } from "../src/types";
 import type { PersistedUsageEntry } from "../src/usage/log";
 
+async function* replayAdapterEvents(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
+  for (const event of events) yield event;
+}
+
 function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
   return {
     requestId: "ocx-test",
@@ -746,6 +752,36 @@ describe("request log metadata", () => {
     });
   });
 
+  test("deferred logging preserves a bridged Kiro absolute context checkpoint", async () => {
+    const entries: RequestLogEntry[] = [];
+    const body = bridgeToResponsesSSE(replayAdapterEvents([{
+      type: "done",
+      usage: {
+        inputTokens: 58,
+        outputTokens: 100,
+        contextTotalTokens: 50_000,
+        estimated: true,
+      },
+    }]), "kiro/claude-opus-5");
+    const response = responseWithDeferredRequestLog(
+      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
+      "ocx-test-kiro-context-checkpoint",
+      Date.now(),
+      { model: "kiro/claude-opus-5", provider: "kiro-p9d8524", usageLogInputTokens: 200 },
+      entry => entries.push(entry),
+    );
+
+    const text = await response.text();
+    expect(text).toContain('"input_tokens":49900');
+    expect(text).toContain('"total_tokens":50000');
+    expect(entries).toHaveLength(1);
+    expect(entries[0]).toMatchObject({
+      usageStatus: "estimated",
+      totalTokens: 50_000,
+      usage: { inputTokens: 49_900, outputTokens: 100, totalTokens: 50_000, estimated: true },
+    });
+  });
+
   test("final logging shows numeric Kiro estimates even when SSE usage is absent", async () => {
     const entries: RequestLogEntry[] = [];
     const response = responseWithDeferredRequestLog(
```

### #447 후속 rebase 계약

#439 통합 후 #447 구현자는 최소 다음 interdiff를 재작성·재검증한다.

```diff
-    const region = resolveKiroApiRegion();
-    const profileArn = resolveKiroProfileArn();
+    const region = resolveKiroApiRegion(parsed._kiroAuthContext);
+    const profileArn = resolveKiroProfileArn(parsed._kiroAuthContext);
```

이 hunk는 #439 적용 후 `src/adapters/kiro.ts:1196-1216` 부근의 `build(parsed, ...)` 안으로 이동한다. #447의 `OcxParsedRequest._kiroAuthContext` 추가와 #439의 `OcxUsage.contextTotalTokens`가 모두 보존되는지 `src/types.ts`를 수동 대조한다. 보안 리뷰가 끝나기 전에는 이 WP에 cherry-pick/수동 결합하지 않는다.

## 검증

```bash
bun test tests/kiro-stream.test.ts
bun test tests/bridge.test.ts
bun test tests/request-log.test.ts
bun test tests/kiro-stream.test.ts tests/bridge.test.ts tests/request-log.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun run lint:gui
```

범위 및 patch integrity:

```bash
git diff --check
git diff --name-status 037e8f5e4fa32a82e4149acc509554f157656dad --
git diff --stat 037e8f5e4fa32a82e4149acc509554f157656dad --
```

expected changed-file ledger는 정확히 아래 여섯 MODIFY다.

```text
M src/adapters/kiro.ts
M src/bridge.ts
M src/types.ts
M tests/bridge.test.ts
M tests/kiro-stream.test.ts
M tests/request-log.test.ts
```

## 수용 기준

- [ ] 적용 직전 PR #439 head가 `e78e84636b799e37ac985e83781190bda6539e0c`와 정확히 일치한다.
- [ ] 742줄 snapshot 전체가 verbatim 적용되고 snapshot 밖 production/test delta가 없다.
- [ ] changed-file ledger가 위 여섯 MODIFY와 정확히 일치한다.
- [ ] `OcxUsage.inputTokens/outputTokens`는 per-attempt semantics를 유지하고 `contextTotalTokens`만 absolute checkpoint다.
- [ ] initial stream과 non-stream parser가 동일한 `contextInputEstimate`를 받는다.
- [ ] fallback second attempt는 최초 estimate가 아니라 rebuilt payload estimate를 사용한다.
- [ ] fallback merge는 per-attempt 비용은 합산하되 absolute context는 중복 합산하지 않고 확실한 second output growth는 잃지 않는다.
- [ ] percentage는 native Kiro model window를 사용하며 client-configured cap에 오염되지 않는다.
- [ ] `kiro-auto`는 response concrete model ID로 percentage 분모를 해석하고, 없으면 heuristic floor를 사용한다.
- [ ] normalized payload에서 제외된 private reasoning은 context pressure에 들어가지 않고 request-log estimate에는 남는다.
- [ ] image context estimate가 최소 256 token을 기여한다.
- [ ] bridge는 `input = contextTotal - output`, `total = contextTotal`로 serialize해 output double-count를 막는다.
- [ ] cache read/write detail은 derived input bound를 넘지 않는다.
- [ ] deferred logging이 bridged absolute checkpoint를 persisted usage에 보존한다.
- [ ] focused 4회, typecheck, full suite, privacy scan, GUI lint, `git diff --check`가 모두 exit 0이다.
- [ ] PR #447은 #439 뒤 rebase/re-audit 대상으로 남고 이 WP에는 포함되지 않는다.

## 실행 영수증

_(C/D 단계에서 작성)_
