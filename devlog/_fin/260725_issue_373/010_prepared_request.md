# 010 — prepared request 구현 계약

근거는 `000_plan.md`.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/adapters/cursor/protobuf-request.ts` | MODIFY (serialized 보관, prepare 진입점) |
| `src/adapters/cursor/protobuf-events.ts` | MODIFY (estimate fallback) |
| `src/adapters/cursor/live-transport.ts` | MODIFY (배선 + `partialUsageFromEventState` 갱신) |
| `structure/04_transports-and-sidecars.md` | MODIFY (문서 정정) |
| `tests/cursor-blob.test.ts` | MODIFY |
| `tests/cursor-protobuf-events.test.ts` | MODIFY |
| `tests/cursor-live-transport.test.ts` | MODIFY (transport 배선 회귀) |

## 설계 원칙

estimate와 전송 bytes가 **같은 인스턴스**에서 파생되어야 한다. PR #376이 거절된 이유가
정확히 이 보장의 부재였다. 따라서 payload를 한 번만 준비하고 거기서 둘 다 만든다.

## 1. `protobuf-request.ts`

### 1a. `StoredRootBlob`에 직렬화 텍스트 보관 (83행)

```ts
 type StoredRootBlob = {
   id: Uint8Array;
   byteLength: number;
+  /** Exact JSON handed to storeCursorBlob(); reused for estimation without re-serializing. */
+  serialized: string;
   role: "system" | "user" | "assistant" | "toolResult";
```

`jsonBlob()`(79행)과 `storedRootBlob()`(92행)이 유일한 생성 지점이므로 그 자리에서 채운다.

```ts
-function jsonBlob(value: unknown): Uint8Array {
-  return encoder.encode(JSON.stringify(value));
-}
+function jsonBlob(value: unknown): { data: Uint8Array; serialized: string } {
+  const serialized = JSON.stringify(value);
+  return { data: encoder.encode(serialized), serialized };
+}
```

`jsonBlob()`의 호출자는 `storedRootBlob()`(97행) 하나뿐이다(확인 완료).

`argBytes()`(329-335행)의 catch fallback(333행)에도 비슷한 `encoder.encode(JSON.stringify(...))`가
있지만 그건 `jsonBlob()` 호출이 아니고, 반환 `Uint8Array`는 protobuf args 맵 계약이므로
**변환 대상이 아니다.**

### 1b. `rootPromptMessages()` 반환 타입 확장 (163행)

현재 반환은 `ids` / `byteLength` / `historyMessageStart` 셋뿐이다.

```ts
 function rootPromptMessages(request: CursorRunRequest): {
   ids: Uint8Array[];
   byteLength: number;
   historyMessageStart: number;
+  /** Serialized text of the roots that SURVIVED pruning, in wire order. */
+  serialized: string[];
 } {
```

**조기 반환(172행 부근)과 최종 반환(288행) 양쪽** 모두 채운다. 최종 반환은 pruning이 끝난
`selected`에서 파생하므로 버려진 history가 자동으로 빠진다.

### 1c. tool IIFE를 함수 스코프로 승격 (601행)

현재 tool 정의는 IIFE 안에서만 존재한다. 추정에 쓰려면 끌어올려야 한다.

```ts
-    ...(() => {
-      const visibleTools = cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice);
-      const mcpToolDefs = buildCursorToolDefinitions(visibleTools, request.toolChoice);
-      return mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {};
-    })(),
+    ...(mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {}),
```

`visibleTools` / `mcpToolDefs`를 `rootPromptMessagesState` 근처(536행 부근)에서 계산한다.
동작은 동일하다 — 계산 시점만 앞당긴다.

### 1d. 단일 준비 진입점

```ts
export interface PreparedCursorRunRequest {
  bytes: Uint8Array;
  estimatedInputTokens?: number;
}

export function prepareCursorRunRequest(
  request: CursorRunRequest,
  options?: { estimateInputTokens?: boolean },
): PreparedCursorRunRequest

/** Back-compat wrapper for existing callers and tests. */
export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array
```

`encodeCursorRunRequest()`의 기존 본문을 `prepareCursorRunRequest()`로 옮기고, 마지막에
추정을 붙인다.

```ts
if (!options?.estimateInputTokens) return { bytes };
// The estimate derives from the SAME roots/action/tool instances that produced `bytes`,
// so it can never count history or tools the wire payload dropped — the exact defect
// that blocked PR #376.
const modelVisibleParts = [
  ...rootPromptMessagesState.serialized,
  ...(actionCase === "userMessageAction" ? [text] : []),
  ...mcpToolDefs.map(modelVisibleToolText),
];
return { bytes, estimatedInputTokens: estimateTokens(modelVisibleParts.join("\n"), request.modelId) };
```

`modelVisibleToolText()`는 protobuf `inputSchema`(binary)를 `fromBinary`/`toJson`으로 복원해
모델이 보는 형태로 직렬화한다. 필요한 import를 함께 추가한다.

**공유 `estimateTokens()`를 그대로 쓴다.** Grok 비율 특례를 넣지 않는다 —
`token-estimate.ts:67`의 CJK clamp를 우회하면 한국어 prompt를 과소계산한다.

## 2. `protobuf-events.ts`

```ts
export interface CursorProtobufEventState {
  ...
  /** Request-local only. Never recorded into the checkpoint tracker. */
  estimatedInputTokens?: number;
}

function resolvedTurnUsage(state: CursorProtobufEventState): OcxUsage {
  const contextTokens = reportableContextTokens(state);
  if (contextTokens !== undefined) return usageFromContextTokens(state, contextTokens);
  const estimate = state.estimatedInputTokens;
  if (estimate !== undefined) {
    return { ...state.usage, inputTokens: estimate, totalTokens: estimate + state.usage.outputTokens, estimated: true };
  }
  return { ...state.usage };
}
```

`finalizeTurnEvents()`(461행)와 `partialUsageFromEventState()`가 이 helper를 쓴다.
후자는 기존 "checkpoint 또는 output signal이 하나라도 있어야 보고" guard를 **유지**한다 —
요청이 실제로 소비됐다는 증거 없이 usage를 만들면 안 된다.

### helper 소유 위치 (A-gate 지적)

`resolvedTurnUsage()`는 `protobuf-events.ts`에 두고 **export**한다.
`partialUsageFromEventState()`는 `protobuf-events.ts`가 아니라 **`live-transport.ts:883`**에
있으므로 그쪽에서 import해 쓴다.

이 배선을 빠뜨리면 failure 경로(502/stall/abort → `attachPartialUsage`,
`live-transport.ts:902`)에는 estimate가 영원히 적용되지 않는다. 그리고 테스트 10은 guard
유지만 고정하므로 이 누락을 잡지 못한다 — guard는 estimate 도입 여부와 무관하게 통과한다.

유지할 guard는 `live-transport.ts:888-890`의 `hasCurrentCheckpoint || hasCurrentOutput`이다.

`createCursorProtobufEventState()`가 `estimatedInputTokens` 옵션을 받되, 유한하고 양수일
때만 저장한다.

## 3. `live-transport.ts`

```ts
const contextUsage = cursorContextUsageTracker.controlsForConversation(request.conversationId, {...});
// Only estimate when there is no authoritative carry — otherwise the work is wasted.
const prepared = prepareCursorRunRequest(request, {
  estimateInputTokens: contextUsage.carryForwardTokens === undefined,
});
state = createCursorProtobufEventState({ ..., contextUsage, estimatedInputTokens: prepared.estimatedInputTokens });
```

`open()`에 `prepared.bytes`를 넘기도록 시그니처를 조정한다. B에서 현재 `open()`이 request를
받아 내부에서 encode하는지 확인해 맞춘다.

## 4. `structure/04_transports-and-sidecars.md`

188행의 "a process restart loses the numeric cache and safely falls back to current-turn
usage"를 실제 동작으로 정정한다: checkpoint도 carry도 없으면 Cursor에 보낸 것과 동일한
pruned payload에서 파생한 request-local estimate로 대체하며, estimate는 persist되거나
carry로 승격되지 않는다.

## 회귀 테스트

### `tests/cursor-blob.test.ts`

1. `prepared estimate ignores pruned oldest roots` — 한도를 넘긴 history에서 버려질
   oldest content만 크게 바꿔도 estimate가 동일
2. `prepared estimate uses the filtered tool catalog` — 필터로 빠진 tool의 크기를 바꿔도
   estimate가 동일
3. `image data URL size does not affect the estimate` — 작은/큰 base64 이미지에서 동일,
   decoded payload에는 placeholder만 존재
4. `the estimate derives from the bytes actually sent` — `PreparedCursorRunRequest`는
   `{bytes, estimatedInputTokens}`만 노출하므로 `serialized`를 직접 비교하지 않는다.
   대신 `tests/cursor-blob.test.ts:23-32`의 `blobData()`로 전송 blob을 decode해 estimate를
   재계산하고 `prepared.estimatedInputTokens`와 일치하는지 본다. 노출면을 넓히지 않으면서
   같은 불변량(estimate가 실제 전송 인스턴스에서 파생)을 고정한다
5. `estimate honors the shared CJK clamp` — 한국어 지배 payload에서 추정치가
   `estimateTokens()`와 정확히 일치. Grok 특례가 재도입되면 실패한다

### `tests/cursor-protobuf-events.test.ts`

6. `restart without checkpoint uses the prepared estimate` — **핵심 회귀**
   - 새 tracker + 실제 `prepareCursorRunRequest()` 결과
   - output 7 후 `input=estimate`, `total=estimate+7`
   - 수정 전 실패: `input=0`
7. `current checkpoint overrides the estimate`
8. `carry-forward overrides and suppresses the estimate` — estimate가 tracker에 들어가지
   않음을 함께 확인
9. `compaction reset never revives an estimated carry` — `clearPrior:true` 후 tracker가 빔
10. `pre-first-frame failure does not report an estimate alone` — checkpoint/output signal이
    전혀 없으면 `undefined` 유지
10b. `partial usage uses the estimate when output arrived` — output signal 있음 +
    estimate 있음 + checkpoint/carry 없음 → partial usage의 input이 estimate.
    테스트 10만으로는 `partialUsageFromEventState` 배선 누락을 잡지 못한다

### `tests/cursor-live-transport.test.ts` — **production 배선 회귀**

테스트 1-10은 전부 `protobuf-request` 수준이거나 `createCursorProtobufEventState()`에
`estimatedInputTokens`를 손으로 넣는 events 수준이다. 즉 **섹션 3(live-transport 배선)을
통째로 빠뜨려도 10개 전부 green이고 #373은 production에 그대로 남는다.**
`tests/cursor-hardening.test.ts`의 mock http2 서버 패턴을 재사용해 transport 수준에서 고정한다.

11. `restart turn reports the wire-derived estimate`
    - 새 tracker + mock 서버가 checkpoint 없이 `turnEnded`만 보냄
    - `done.usage.inputTokens`가 wire payload에서 재계산한 estimate와 일치
    - `prepareCursorRunRequest()` 호출이나 `open()`에 `prepared.bytes`를 넘기는 배선이
      빠지면 여기서 실패한다
12. `carry-forward turn skips the estimate entirely`
    - tracker에 checkpoint를 미리 기록해 carry가 있는 상태
    - checkpoint/carry가 우선하고 estimate가 쓰이지 않음
    - `estimateInputTokens: contextUsage.carryForwardTokens === undefined` 조건 검증
    - **주의**: "계산 자체를 생략"은 `done.usage`만으로 관측되지 않는다. carry가 있으면
      estimate를 계산했든 안 했든 usage 결과가 같기 때문이다. 회귀 방지의 핵심(carry 우선)은
      usage 단언으로 충분하지만, 생략 플래그까지 고정하려면 `prepareCursorRunRequest` 호출
      옵션에 spy를 걸어 `estimateInputTokens: false`로 불렸는지 확인한다

## 검증

```bash
bun run typecheck
bun test tests/cursor-blob.test.ts tests/cursor-protobuf-events.test.ts \
         tests/cursor-live-transport.test.ts \
         tests/cursor-interaction-query.test.ts tests/cursor-tool-continuation.test.ts \
         tests/cursor-request-builder.test.ts tests/token-estimate.test.ts
```

`tests/token-estimate.test.ts`는 공유 estimator를 건드리지 않았음을 증명하는 가드다.
