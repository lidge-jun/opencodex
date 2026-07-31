# WP4 — #373 Cursor 재시작 후 context usage 0 보고

> 개정 이력: r1 초안은 A-gate에서 FAIL. blocker 5(존재하지 않는 `roots.serialized`를
> 반환 타입 변경 없이 사용, 핵심 함수 본문 생략)와 blocker 9(shared estimator 변경을
> Cursor 국소 변경으로 오분류)를 r2에서 수정했다. 외부 근거·경쟁 PR 이력은
> `001_external_evidence.md` 참조.
>
> r3: r2도 FAIL. Cursor 국소 Grok 비율이 공유 estimator의 CJK clamp를 우회해 한국어
> prompt를 과소계산하는 문제가 남았고, `prepareCursorRunRequest()` 본문이 여전히
> 생략돼 있었다.
>
> **이 문서의 코드 블록은 설계 스케치다.** 정확한 diff는 이 phase의 P에서 작성한다.

## 증상

프록시 재시작 후 checkpoint frame이 없는 agent/tool 턴이 계속 `inputTokens=0`,
`totalTokens=outputTokens`로 보고된다. 제보자 환경에서 61/61 요청이 재현됐다.
이는 `usage.jsonl` 표시 문제가 아니라 Codex에 실제 전달되는 `response.completed.usage`
문제다. Codex 입장에서 "거의 빈 컨텍스트"로 보이므로 compaction 타이밍이 망가진다.

## 근본 원인

마지막 absolute checkpoint가 디스크가 아니라 프로세스 내부 `Map`에만 있다.

`src/adapters/cursor/protobuf-events.ts:48`:

```ts
export function createCursorContextUsageTracker(...) {
  const entries = new Map<string, CursorContextUsageEntry>();
```

프로덕션 인스턴스도 `src/adapters/cursor/live-transport.ts:72`의 모듈 전역 변수다.
최대 200개, TTL 1시간이며 프로세스가 죽으면 전부 사라진다.

`responses-state.json`은 디스크에 persist되지만 `src/types.ts:226`이 보여주듯 conversation
ID와 `checkpointUsable`만 담는다. 즉 재시작 후 대화 ID는 복구돼도 토큰 checkpoint는 없다.

```ts
cursor?: {
  conversationId?: string;
  checkpointUsable?: boolean;
};
```

재시작 후 경로:

1. `live-transport.ts:515`에서 tracker 조회 → `entries`가 비어 carry 없음
2. `protobuf-events.ts:154` 초기 usage가 `{ inputTokens: 0, outputTokens: 0 }`
3. checkpoint frame이 안 오면 `protobuf-events.ts:380`의 absolute 기록도 없음
4. `tokenDelta`는 445행에서 output에만 누적
5. `protobuf-events.ts:474`가 초기 `inputTokens: 0`을 그대로 복사

```ts
const contextTokens = reportableContextTokens(state);
const usage: OcxUsage = contextTokens !== undefined
  ? usageFromContextTokens(state, contextTokens)
  : { ...state.usage };
```

`structure/04_transports-and-sidecars.md:188`은 재시작 후 "current-turn usage로 안전하게
fallback"한다고 적었지만, #373이 그 판단을 반증했다. output-only usage는 안전하지 않다.

## 대안 비교

| 대안 | 판단 |
|---|---|
| (a) checkpoint 디스크 persist | 비권장 — compaction epoch/reset/rekey/TTL/crash flush를 원자적으로 저장해야 하고, stale 큰 값이 새 컨텍스트를 덮을 위험. 새 대화·checkpoint-less flow는 여전히 미해결 |
| (b) pruning 이후 request-local estimate | **채택** — 재시작·새 대화·checkpoint-less를 모두 해결하고 stateless. prompt를 저장하지 않음 |
| (c) 둘 다 | (a)의 복잡성과 stale 위험이 그대로. 잘못 복원된 carry가 더 정확한 최신 estimate를 덮어씀 |

우선순위: `current checkpoint` → `process-local carry` → `post-pruning estimate` →
기존 output-only fallback.

**estimate는 절대 tracker에 기록하지 않는다.** tracker를 갱신하는 유일한 입력은 계속
실제 `conversationCheckpointUpdate.usedTokens`여야 한다.

## PR #376이 거절된 이유와 회피 방법

PR #376은 같은 방향이지만 CHANGES_REQUESTED다. 첫 커밋의 estimator는 이랬다.

```ts
return estimateTokens(JSON.stringify({
  system: request.system,
  messages: request.rawMessages ?? request.messages,
  tools: request.tools,
}), request.modelId);
```

원본 요청을 다시 읽으므로 버려진 history, 필터된 tool, 원본 base64 이미지까지 계산해
실제 전송량보다 크게 보고했다. 두 번째 커밋은 selected roots를 반영했지만
`modelVisibleRequestPayload()`를 estimate와 encode가 각각 호출해 직렬화·해싱을 두 번
수행했고, 두 결과가 같은 payload 인스턴스에서 나온다는 보장이 없었다.

owner 요구는 명확하다: **이미 pruning·정규화된 wire payload를 소비하고, request 구성을
중복하지 말며, checkpoint/carry가 없을 때만 계산할 것.**

우리 설계는 payload를 한 번만 준비하고 그 동일 객체에서 binary와 estimate를 함께
파생하므로 이 지적을 구조적으로 피한다.

## 정확한 추정 지점

pruning은 `src/adapters/cursor/protobuf-request.ts:223`부터 일어난다 (192 root blobs,
512 KiB, trailing tool result 보존, orphan 제거). 이미지 placeholder 치환은
`request-builder.ts:133`, tool 필터링은 `tool-definitions.ts:307`이다.

추정은 다음 세 항목이 모두 확정된 직후여야 한다.

```
rootPromptMessages()의 selected roots
+ 실제 userMessageAction text 또는 resumeAction
+ filtered/normalized mcpToolDefs
→ 같은 값으로 estimate
→ 같은 값으로 AgentRunRequest를 encode
```

## Diff-level 변경안

### `src/adapters/cursor/protobuf-request.ts`

**(1) `StoredRootBlob`에 직렬화 문자열 보관** (현재 타입 정의):

```ts
 type StoredRootBlob = {
   id: Uint8Array;
   byteLength: number;
+  /**
+   * The exact JSON string handed to storeCursorBlob(). Retained so the token
+   * estimate reads the same text the wire carries, without re-serializing (#373).
+   */
+  serialized: string;
   role: "system" | "user" | "assistant" | "toolResult";
   messageIndex?: number;
   text?: string;
 };
```

blob을 만드는 모든 지점에서 `serialized`를 채운다. 현재 `JSON.stringify(value)` 결과를
`encoder.encode()`에 넘기는 자리마다 중간 변수로 뽑아 그대로 저장한다.

```ts
-      const data = encoder.encode(JSON.stringify(value));
+      const serialized = JSON.stringify(value);
+      const data = encoder.encode(serialized);
       return {
         id: storeCursorBlob(data),
         byteLength: data.byteLength,
+        serialized,
         ...
       };
```

**(2) `rootPromptMessages()` 반환 타입 확장** — 현재 163-167행. r1의 오류가 여기였다.
실제 반환은 `ids` / `byteLength` / `historyMessageStart` 셋뿐이므로 필드를 추가해야 한다.

```ts
 function rootPromptMessages(request: CursorRunRequest): {
   ids: Uint8Array[];
   byteLength: number;
   historyMessageStart: number;
+  /** Serialized text of the roots that SURVIVED pruning, in wire order. */
+  serialized: string[];
 } {
```

조기 반환(messages 없음, 172행 부근)과 최종 반환(288행) **양쪽** 모두 채운다.
최종 반환은 pruning이 끝난 `selected`에서 파생하므로 버려진 history가 자동으로 빠진다.

```ts
   return {
     ids: selected.map(entry => entry.id),
     byteLength: selected.reduce((sum, entry) => sum + entry.byteLength, 0),
     historyMessageStart,
+    serialized: selected.map(entry => entry.serialized),
   };
```

조기 반환도 같은 방식으로 `entries.map(entry => entry.serialized)`를 넣는다.

**(3) tool 텍스트 복원 helper** — protobuf `inputSchema`는 binary라 그대로는 셀 수 없다.

```ts
+/**
+ * Reconstruct the model-visible text of a finalized tool definition. The schema
+ * travels as packed protobuf Value bytes, so it must be decoded to be counted the
+ * way the model sees it.
+ */
+function modelVisibleToolText(definition: McpToolDefinition): string {
+  const inputSchema = toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema));
+  return JSON.stringify({
+    name: definition.toolName || definition.name,
+    description: definition.description,
+    inputSchema,
+  });
+}
```

`toJson`, `fromBinary`, `ValueSchema` import를 파일 상단에 추가한다.

**(4) 단일 준비 진입점** — 기존 `encodeCursorRunRequest()`(506행부터)의 본문을 옮기고
반환만 바꾼다.

**주의 (r3)**: 실제 코드는 `mcpToolDefs`를 IIFE 안에서 만든다. 단순 이동으로는 추정에
필요한 변수에 접근할 수 없으므로, P에서 해당 IIFE를 풀어 `roots` / `text` /
`actionCase` / `mcpToolDefs`를 함수 스코프의 지역 변수로 끌어올려야 한다. 추가로
`McpToolDefinition` 타입과 `estimateTokens` import가 필요하다.

```ts
+export interface PreparedCursorRunRequest {
+  bytes: Uint8Array;
+  estimatedInputTokens?: number;
+}
+
+export function prepareCursorRunRequest(
+  request: CursorRunRequest,
+  options: { estimateInputTokens?: boolean } = {},
+): PreparedCursorRunRequest {
+  // (existing encodeCursorRunRequest body, unchanged, producing:)
+  //   const rawText = activePromptText(request);
+  //   const text  = ...
+  //   const actionCase = ...
+  //   const roots = rootPromptMessages(request);
+  //   const visibleTools = cursorToolsForActivePrompt(request.tools, rawText, request.toolChoice);
+  //   const mcpToolDefs  = buildCursorToolDefinitions(visibleTools, request.toolChoice);
+  //   const runRequest / message = ...
+  const bytes = toBinary(AgentClientMessageSchema, message);
+  if (!options.estimateInputTokens) return { bytes };
+
+  // The estimate derives from the SAME roots/action/tool instances that produced
+  // `bytes`, so it can never count history or tools the wire payload dropped —
+  // the exact defect that blocked PR #376.
+  const modelVisibleParts = [
+    ...roots.serialized,
+    ...(actionCase === "userMessageAction" ? [text] : []),
+    ...mcpToolDefs.map(modelVisibleToolText),
+  ];
+  return {
+    bytes,
+    estimatedInputTokens: estimateCursorInputTokens(modelVisibleParts.join("\n"), request.modelId),
+  };
+}
+
+/** Back-compat wrapper for existing callers and tests. */
+export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
+  return prepareCursorRunRequest(request).bytes;
+}
```

`text`와 `actionCase`가 위 본문에서 이미 계산되므로 추가 계산은 없다. B 단계에서 실제
변수명을 확인해 맞춘다.

### `src/adapters/cursor/live-transport.ts`

```ts
+const contextUsage = cursorContextUsageTracker.controlsForConversation(request.conversationId, {...});
+// Only estimate when there is no authoritative carry — otherwise skip the work.
+const prepared = prepareCursorRunRequest(request, {
+  estimateInputTokens: contextUsage.carryForwardTokens === undefined,
+});
 state = createCursorProtobufEventState({
   ...
+  contextUsage,
+  estimatedInputTokens: prepared.estimatedInputTokens,
 });
-this.open(request, signal, state, ...);
+this.open(prepared.bytes, signal, state, ...);
```

`open()`의 첫 인자를 `CursorRunRequest`에서 `Uint8Array`로 바꾸고 내부에서
`encodeConnectFrame(encodedRequest)`를 그대로 쓴다. 이로써 payload 생성이 턴당 한 번이고,
estimator가 본 payload와 실제 전송 payload가 동일함이 타입 수준에서 보장된다.

### `src/adapters/cursor/protobuf-events.ts`

```ts
 export interface CursorProtobufEventState {
   ...
+  /** Request-local only. Never recorded into the checkpoint tracker. */
+  estimatedInputTokens?: number;
 }
+
+function resolvedTurnUsage(state: CursorProtobufEventState): OcxUsage {
+  const contextTokens = reportableContextTokens(state);
+  if (contextTokens !== undefined) return usageFromContextTokens(state, contextTokens);
+  const estimate = state.estimatedInputTokens;
+  if (estimate !== undefined) {
+    return { ...state.usage, inputTokens: estimate, totalTokens: estimate + state.usage.outputTokens, estimated: true };
+  }
+  return { ...state.usage };
+}
```

`finalizeTurnEvents()`와 `partialUsageFromEventState()`가 이 helper를 쓴다. 후자는 기존
"checkpoint 또는 output signal이 하나라도 있어야 보고" guard를 반드시 유지한다 — 요청이
실제로 소비됐다는 증거 없이 usage를 만들어내면 안 된다.

### Grok 비율: 특례를 넣지 않는다 (r3 결정)

r1은 `KIRO_MODEL_PREFIXES`에 `"grok"`을 추가하려 했다. 그러나 `estimateTokens()`는
Cursor 전용이 아니다.

- `src/adapters/kiro.ts:151, 158, 565`
- `src/server/claude-messages.ts:591, 799`
- `src/server/chat-completions.ts:97`

prefix 추가는 이 경로들의 Grok usage-log 추정치를 함께 바꾼다. #373과 무관한 회계
변경이므로 범위 밖이다.

r2는 Cursor 국소 helper로 가두려 했으나 그것도 틀렸다. 공유 estimator에는 CJK 보호가 있다
(`src/lib/token-estimate.ts:62`).

```ts
  let ratio = charsPerToken(modelId);
  if (cjkRatio(text) > CJK_RATIO_THRESHOLD) ratio = Math.min(ratio, CJK_CHARS_PER_TOKEN);
  return Math.max(1, Math.ceil(len / ratio));
```

국소 helper가 `length / 3.5`를 직접 반환하면 이 clamp를 건너뛴다. 한국어 Grok prompt는
CJK 비율이 높아 2.5로 clamp되어야 하는데 3.5로 나눠 **과소계산**된다. 사용자가 한국어로
작업하는 이 저장소에서는 특히 나쁘다.

**결론: Grok 비율 조정을 이번 범위에서 뺀다.** `estimateCursorInputTokens()`를 만들지 않고
`estimateTokens(text, modelId)`를 그대로 쓴다.

근거: #373의 증상은 `inputTokens=0`이다. 0에서 "pruning 이후 payload 기반 추정치"로 가는
것이 수정의 본질이고, 그 추정치가 4 chars/token이냐 3.5냐는 부차적이다. 비율 정확도는
근거(실측 대조)를 갖춘 별도 unit에서 다루는 편이 옳다. `estimated: true` 플래그가 이미
추정치임을 알린다.

`src/lib/token-estimate.ts`는 **변경하지 않는다.**

### `structure/04_transports-and-sidecars.md`

188행의 "safely falls back to current-turn usage"를 실제 동작으로 정정한다: checkpoint도
carry도 없으면 Cursor에 보낸 것과 동일한 pruned payload에서 파생한 request-local estimate로
대체하며, estimate는 절대 persist되거나 carry로 승격되지 않는다.

## 회귀 테스트

### `tests/cursor-blob.test.ts`

1. `prepared estimate ignores pruned oldest roots` — 한도를 넘긴 history에서 버려질
   oldest content만 크게 바꿔도 estimate가 동일
2. `prepared estimate uses filtered tool catalog` — 필터로 빠진 50 KiB filler tool의
   크기를 바꿔도 estimate가 동일
3. `image data URL size does not affect estimate` — 작은/큰 base64 이미지에서 estimate 동일,
   decoded payload에는 placeholder만 존재
4. `prepared bytes are the payload used for estimation` — 반환된 bytes를 decode해
   roots/action/tool 경계 검증

4b. `serialized roots match the blobs actually sent` — decode한 blob 바이트를
   `serialized` 문자열과 대조해 truncation 이후에도 정확히 일치함을 확인.
   `StoredRootBlob.serialized`가 stale해지는 실수를 잡는다.

4c. `estimate honors the shared CJK clamp` — 한국어가 지배적인 payload에서 추정치가
   `estimateTokens()`와 정확히 일치함을 확인한다. Grok 특례가 재도입되어 CJK 보호를
   우회하면 이 테스트가 실패한다. `tests/token-estimate.test.ts` 기존 10개도 무변경 통과.

### `tests/cursor-protobuf-events.test.ts`

5. `restart without checkpoint uses prepared request estimate` — 새 tracker + 실제
   `prepareCursorRunRequest()` 결과. output 7 후 `input=estimate`, `total=estimate+7`
   (수정 전 실패: `input=0`)
6. `current checkpoint overrides request estimate`
7. `carry-forward overrides and suppresses request estimate` — estimate가 tracker에
   들어가지 않음을 함께 확인
8. `compaction reset never revives an estimated carry` — `clearPrior:true` 후에도
   다음 tracker lookup이 비어 있음

### `tests/cursor-interaction-query.test.ts`

9. `partial failure after output uses prepared estimate`
10. `pre-first-frame failure does not report estimate alone` — checkpoint/output signal이
    전혀 없으면 `undefined` 유지

## 검증 명령

```bash
bun test tests/cursor-blob.test.ts tests/cursor-protobuf-events.test.ts \
         tests/cursor-interaction-query.test.ts tests/cursor-tool-continuation.test.ts \
         tests/cursor-request-builder.test.ts tests/token-estimate.test.ts
bun run typecheck
```

`tests/token-estimate.test.ts`는 공유 estimator를 건드리지 않았음을 증명하는 회귀 가드다.
