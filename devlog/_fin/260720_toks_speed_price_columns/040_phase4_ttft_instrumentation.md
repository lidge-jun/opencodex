# 040 — WP4 TTFT (`firstOutputMs`) 계측 구현 PRD

## 0. 목적과 확정 의미

`firstOutputMs`는 **request/attempt 시작부터 비어 있지 않은 첫 모델 text 또는 reasoning delta를
관측할 때까지의 밀리초**다. 값은 one-shot으로 한 번만 기록한다.

- native Responses SSE: `response.output_text.delta`,
  `response.reasoning_summary_text.delta`, `response.reasoning_text.delta` 중 `delta.length > 0`.
- adapter stream: `text_delta.text`, `thinking_delta.thinking`,
  `reasoning_raw_delta.text` 중 `length > 0`.
- heartbeat, created/in_progress, signature/redacted-only, tool event, 빈 delta는 제외한다.
- 비스트리밍과 tool-only stream은 의도적으로 unset이다. completion 시각을 TTFT로 대입하지 않는다.
- top-level은 request start 기준, combo attempt는 해당 attempt start 기준이다.
- `tok/s` 정의는 WP2의 `outputTokens / durationMs` 그대로이며 TTFT로 분모를 바꾸지 않는다.
- GUI는 WP3 소비 계약의 optional 필드 한 줄만 참조한다. 이 WP에서 GUI 파일은 수정하지 않는다.

## 1. fresh HEAD 근거와 stale 앵커 정정

2026-07-20 이 워크트리 HEAD에서 직접 확인한 앵커다.

- `trackSseForRequestLog()`는 `src/server/relay.ts:142-198`; payload inspection은 `:159-172`.
  001의 `:142-187`은 끝 라인이 stale하다.
- native passthrough SSE는 일반 deferred wrapper를 우회한다
  (`src/server/relay.ts:211-213`). 실제 inspect branch는 `src/server/responses.ts:1153-1193`에서
  `tee()`한 뒤 `consumeForInspection()` 또는 `consumeForResponseLogMetadata()`로 간다.
  따라서 `trackSseForRequestLog()`만 수정하면 native TTFT가 누락된다.
- `consumeForInspection()` payload loop: `src/server/relay.ts:374-453`;
  metadata-only loop: `:455-500`.
- `bridgeToResponsesSSE()` 시작은 `src/bridge.ts:66-87`, event loop는 `:407-428`, delta cases는
  `:429-505`. 001의 `src/bridge.ts:213-215` 인용은 사용하지 않는다.
- adapter bridge 호출은 runTurn stream `src/server/responses.ts:1259-1272`와 parseStream
  `:1522-1538` 두 곳이다. non-streaming은 `:1280-1299`, `:1546-1563`.
- request/entry 타입은 `src/server/request-log.ts:29-89`, final projection은 `:399-467`,
  JSONL projection은 `:95-125`.
- persisted 타입/normalizer는 `src/usage/log.ts:16-53`, `:112-183`, `:191-211`.
- `/api/logs`는 in-memory entries를 그대로 JSON화한다: `src/server/management-api.ts:313-315`.
  따라서 endpoint handler 수정 없이 `RequestLogEntry.firstOutputMs`가 additive 노출된다.

## 2. 변경 파일 manifest (11)

| 상태 | 파일 | 책임 |
| --- | --- | --- |
| MODIFY | `src/bridge.ts` | adapter event one-shot callback |
| MODIFY | `src/server/relay.ts` | native/routed SSE payload 판별 및 callback 전달 |
| MODIFY | `src/server/request-log.ts` | context/entry 필드, one-shot recorder, final/JSONL projection |
| MODIFY | `src/usage/log.ts` | parent/attempt persisted field와 finite/nonnegative normalize |
| MODIFY | `src/server/responses.ts` | bridge/native inspect callback wiring과 combo attempt 기준시각 |
| MODIFY | `src/server/index.ts` | HTTP/WS request start callback wiring |
| MODIFY | `src/server/claude-messages.ts` | Claude surface request start callback wiring |
| MODIFY | `tests/bridge.test.ts` | adapter callback unit cases |
| MODIFY | `tests/request-log.test.ts` | native SSE one-shot, final projection, non-stream unset |
| MODIFY | `tests/usage-log.test.ts` | parent/attempt JSONL roundtrip 및 malformed validation |
| MODIFY | `tests/server-combo-failover-e2e.test.ts` | `/api/logs` + usage.jsonl combo attempt additive 계약 |
| MODIFY | `src/web-search/loop.ts` | web-search sidecar의 세 번째 `bridgeToResponsesSSE()` 직접 호출에도 `onFirstOutput` 전달 (감사 blocker #1 fold — WS 경로는 deferred wrapper가 없어 sidecar TTFT가 누락됨) |

`src/server/management-api.ts`는 수정하지 않는다. 현재 `filterRequestLogs(getRequestLogEntries())`
객체를 그대로 반환하므로 타입/projection 변경만으로 additive 필드가 노출된다.

**감사 fold 노트 (A-round):**

1. (#1 High) production `bridgeToResponsesSSE()` 호출은 responses.ts 2곳 + **web-search
   sidecar(`src/web-search/loop.ts:541` 부근)** 총 3곳이다. sidecar 호출에도 동일한
   `onFirstOutput` 옵션을 전달한다(옵션이 상위에서 안 내려오면 no-op이므로 additive).
2. (#2 Med) combo e2e는 finite 검증만으로는 request-relative/attempt-relative 분리를
   고정하지 못한다: 지연된 A 실패 → B streaming success fixture에서 **성공 attempt를
   선택**해 `parent.firstOutputMs > attempt.firstOutputMs`(A 실패 소요시간만큼 parent가
   더 큼)를 assert한다. 실패 attempt(output 없음)는 unset이어야 한다.
3. (#3 Low) `NaN`/`Infinity` malformed 검증은 JSON.stringify fixture로는 불가능
   (Infinity→null 변환). `appendUsageEntry()` direct-input 호출로 별도 assert한다.

## 3. MODIFY — `src/server/request-log.ts`

### 3.1 타입과 one-shot recorder

```diff
 export interface RequestLogContext {
   model: string;
   provider: string;
+  firstOutputMs?: number;
   surface?: "claude";
```

```diff
 export interface RequestLogEntry {
   requestId: string;
   timestamp: number;
   model: string;
   provider: string;
+  firstOutputMs?: number;
   surface?: "claude";
```

`RequestLogEntry.durationMs` 선언 바로 아래가 아니라 provider identity 바로 뒤에 두어도 되지만,
두 타입에서 이름/optional 의미는 같아야 한다. 다음 helper를 타입 선언 뒤에 추가한다.

```ts
export function recordFirstOutput(
  logCtx: RequestLogContext,
  requestStartedAt: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(now)) return;
  const requestElapsed = Math.max(0, now - requestStartedAt);
  if (logCtx.firstOutputMs === undefined) logCtx.firstOutputMs = requestElapsed;
  if (logCtx.activeAttempt && logCtx.activeAttempt.firstOutputMs === undefined) {
    const attemptStartedAt = logCtx.activeAttemptStartedAt ?? requestStartedAt;
    logCtx.activeAttempt.firstOutputMs = Math.max(0, now - attemptStartedAt);
  }
}
```

recorder는 request와 현재 committed attempt를 각각 one-shot 처리한다. callback이 bridge와 SSE tap
양쪽에서 와도 첫 값이 유지된다.

### 3.2 JSONL 및 final entry projection

```diff
       status: entry.status,
       durationMs: entry.durationMs,
+      ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
       usageStatus: entry.usageStatus,
```

```diff
     status: effectiveStatus,
     durationMs: Date.now() - start,
+    ...(logCtx.firstOutputMs !== undefined ? { firstOutputMs: logCtx.firstOutputMs } : {}),
     ...(errorCode ? { errorCode } : {}),
```

attempt clone(`:431-435`)는 spread로 `firstOutputMs`를 이미 보존하므로 별도 copy가 필요 없다.
`finishRequestAttempt()`는 값을 삭제/재계산하지 않는다.

## 4. MODIFY — `src/usage/log.ts`

### 4.1 persisted schema

```diff
 export interface PersistedUsageAttempt {
   ordinal: number;
   provider: string;
   model: string;
   adapter: string;
   status: number;
   durationMs: number;
+  firstOutputMs?: number;
   sendCount: number;
```

```diff
 export interface PersistedUsageEntry {
   requestId: string;
   timestamp: number;
   provider: string;
   model: string;
   surface?: "claude";
   resolvedModel?: string;
   requestedModel?: string;
   status: number;
   durationMs: number;
+  firstOutputMs?: number;
   usageStatus: UsageStatus;
```

### 4.2 attempt normalizer

invalid optional attempt TTFT가 있으면 해당 attempt를 malformed로 처리한다. 이는 기존
`inputTokenEstimate`/`totalTokens` validation과 같은 정책이다.

```diff
   if ("inputTokenEstimate" in attempt
     && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
+  if ("firstOutputMs" in attempt
+    && !isNonNegativeFiniteNumber(attempt.firstOutputMs)) return null;
   if ("totalTokens" in attempt
```

```diff
     status: attempt.status,
     durationMs: attempt.durationMs,
+    ...(isNonNegativeFiniteNumber(attempt.firstOutputMs)
+      ? { firstOutputMs: attempt.firstOutputMs }
+      : {}),
     sendCount: attempt.sendCount as number,
```

### 4.3 parent normalizer

parent의 malformed optional 값은 entry 전체를 버리지 않고 omit한다. 기존 legacy line을 최대한
읽는 top-level normalizer 정책을 유지한다.

```diff
     status: entry.status,
     durationMs: entry.durationMs,
+    ...(isNonNegativeFiniteNumber(entry.firstOutputMs)
+      ? { firstOutputMs: entry.firstOutputMs }
+      : {}),
     usageStatus: entry.usageStatus,
```

허용값은 finite `>=0`이다. `NaN`, `Infinity`, 음수, 문자열은 영속 결과에 남지 않는다.

## 5. MODIFY — `src/bridge.ts`

### 5.1 options callback

```diff
     compaction?: boolean;
+    onFirstOutput?: () => void;
     onTerminal?: (status: ResponsesTerminalStatus) => void;
```

### 5.2 event-loop one-shot

`let terminated = false` 인접에 state/helper를 둔다.

```diff
       let terminated = false;
+      let firstOutputReported = false;
+      const reportFirstOutput = (event: AdapterEvent): void => {
+        if (firstOutputReported) return;
+        const nonEmpty = event.type === "text_delta"
+          ? event.text.length > 0
+          : event.type === "thinking_delta"
+            ? event.thinking.length > 0
+            : event.type === "reasoning_raw_delta"
+              ? event.text.length > 0
+              : false;
+        if (!nonEmpty) return;
+        firstOutputReported = true;
+        try { options?.onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
+      };
       let macrotaskFired = true;
```

event loop에서 compaction early-continue보다 먼저 호출한다. hidden reasoning과 compaction에서도
모델 output의 first observation을 놓치지 않기 위해서다.

```diff
           activity = true;
           stallTicks = 0;
+          reportFirstOutput(event);
           // Compaction turns emit ONLY ...
```

tool/signature/redacted/heartbeat/done/error는 helper의 type filter에서 제외된다.

## 6. MODIFY — `src/server/relay.ts`

### 6.1 shared native Responses payload predicate

`terminalStatusFromSsePayload()` 앞에 추가한다.

```ts
export function isFirstOutputSsePayload(payload: string | null): boolean {
  if (!payload || payload === "[DONE]") return false;
  try {
    const event = JSON.parse(payload) as { type?: unknown; delta?: unknown };
    return (event.type === "response.output_text.delta"
      || event.type === "response.reasoning_summary_text.delta"
      || event.type === "response.reasoning_text.delta")
      && typeof event.delta === "string"
      && event.delta.length > 0;
  } catch {
    return false;
  }
}

function createFirstOutputReporter(onFirstOutput?: () => void): (payload: string | null) => void {
  let reported = false;
  return payload => {
    if (reported || !isFirstOutputSsePayload(payload)) return;
    reported = true;
    try { onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
  };
}
```

### 6.2 `trackSseForRequestLog()` callback

```diff
 export function trackSseForRequestLog(
   body: ReadableStream<Uint8Array>,
   onTerminal: (status: ResponsesTerminalStatus) => void,
   onCancel: () => void,
   logCtx?: RequestLogContext,
+  onFirstOutput?: () => void,
 ): ReadableStream<Uint8Array> {
```

```diff
   let terminalReported = false;
+  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
```

```diff
   const inspectPayload = (payload: string | null) => {
     if (!payload) return;
     if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
+    reportFirstOutput(payload);
     const status = terminalStatusFromSsePayload(payload);
```

`responseWithDeferredRequestLog()`의 호출 끝에 request-start recorder를 넘긴다.

```diff
     },
     logCtx,
+    () => recordFirstOutput(logCtx, start),
   );
```

이를 위해 relay의 request-log import에 `recordFirstOutput`을 추가한다.

### 6.3 native tee inspection 두 함수

`consumeForInspection()` 마지막 parameter로 callback을 추가한다.

```diff
   onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
+  onFirstOutput?: () => void,
 ): void {
```

`let cancelled = false` 인접에 reporter를 만든다.

```diff
   let reported = false;
   let cancelled = false;
+  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
```

`payload`를 얻는 두 지점(`:414`, `:433`) 모두 status 판별 전에 `reportFirstOutput(payload)`를
호출한다. `reported` terminal 여부와 독립적으로 first output을 한 번 기록한다.

`consumeForResponseLogMetadata()`에도 callback과 reporter를 정확히 추가한다.

```diff
 export function consumeForResponseLogMetadata(
   body: ReadableStream<Uint8Array>,
   logCtx: RequestLogContext,
   signal?: AbortSignal,
   onDone?: () => void,
   onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
+  onFirstOutput?: () => void,
 ): void {
   const reader = body.getReader();
   const decoder = new TextDecoder();
   let buffer = "";
+  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
```

payload 두 지점은 다음처럼 바꾼다.

```diff
             const payload = sseDataPayload(buffer);
             inspectResponseLogSsePayload(logCtx, payload);
+            reportFirstOutput(payload);
```

```diff
           const payload = sseDataPayload(next.block);
           inspectResponseLogSsePayload(logCtx, payload);
+          reportFirstOutput(payload);
```

`consumeForInspection()`의 두 payload 지점에도 동일한 `reportFirstOutput(payload)` 한 줄을 넣는다.
새 범용 utils 파일은 만들지 않는다.

## 7. MODIFY — `src/server/responses.ts`

### 7.1 HandleResponses callback

```diff
 interface HandleResponsesOptions {
   forceEmptyResponseId?: boolean;
   abortSignal?: AbortSignal;
+  onFirstOutput?: () => void;
```

두 bridge 호출의 options에 추가한다.

```diff
         {
           ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
           stallTimeoutSec: config.stallTimeoutSec,
           hideThinkingSummary: parsed.options.hideThinkingSummary,
+          onFirstOutput: options.onFirstOutput,
```

동일 diff를 runTurn stream(`:1259`)과 parseStream(`:1525`) 양쪽에 적용한다.

### 7.2 native tee inspect wiring

`consumeForInspection()` 호출의 마지막에 `options.onFirstOutput`을 넘긴다.

```diff
           () => options.onNativePassthroughCancel?.(),
           rememberPassthroughResponse,
+          options.onFirstOutput,
         );
```

metadata-only 호출은 multi-line으로 바꾸고 마지막에 callback을 넘긴다.

```diff
-        consumeForResponseLogMetadata(inspectBody, logCtx, turnAc.signal, () => unregisterTurn(turnAc), rememberPassthroughResponse);
+        consumeForResponseLogMetadata(
+          inspectBody,
+          logCtx,
+          turnAc.signal,
+          () => unregisterTurn(turnAc),
+          rememberPassthroughResponse,
+          options.onFirstOutput,
+        );
```

### 7.3 combo attempt 기준

combo child 재귀 옵션에서 root callback을 직접 넘기지 말고 attempt one-shot을 먼저 기록한다.
`attempt`와 `started`를 캡처하는 `handleResponses(childRequest, ...)` options에 추가한다.

```diff
         ...options,
         comboAttempt: true,
+        onFirstOutput: () => {
+          if (attempt.firstOutputMs === undefined) {
+            attempt.firstOutputMs = Math.max(0, Date.now() - started);
+          }
+          options.onFirstOutput?.();
+        },
```

root callback은 top-level request 기준을 기록하고, child closure는 attempt 기준을 기록한다.
`childLog.firstOutputMs`를 attempt-relative 값으로 설정하지 않는다. 성공 시 `Object.assign(logCtx,
childLog, ...)`가 top-level request-relative 값을 덮어쓰는 것을 막기 위해서다.

## 8. MODIFY — `src/server/index.ts`

request-log import에 `recordFirstOutput`을 추가한다.

### 8.1 HTTP `/v1/responses`

```diff
         const response = await handleResponses(req, config, logCtx, {
           abortSignal: req.signal,
+          onFirstOutput: () => recordFirstOutput(logCtx, start),
           onNativePassthroughTerminal: status => {
```

일반 adapter stream은 bridge callback과 deferred SSE tap 양쪽이 호출할 수 있으나 recorder가
one-shot이다. native marked response는 deferred wrapper를 우회하므로 handleResponses callback이
필수다.

### 8.2 Responses WebSocket

WS `response.create`의 handleResponses options에도 추가한다.

```diff
             const response = await handleResponses(req, config, logCtx, {
               forceEmptyResponseId: true,
               abortSignal: turnAbort.signal,
+              onFirstOutput: () => recordFirstOutput(logCtx, start),
```

WS는 HTTP deferred wrapper를 사용하지 않으므로 bridge/native callback이 유일한 계측 경로다.

## 9. MODIFY — `src/server/claude-messages.ts`

request-log import에 `recordFirstOutput`을 추가하고 internal Responses 호출에 request start를 연결한다.

```diff
   const upstream = await handleResponses(internalReq, buildClaudeReplayConfig(config), logCtx, {
     abortSignal: req.signal,
+    ...(logIds ? { onFirstOutput: () => recordFirstOutput(logCtx, logIds.start) } : {}),
     onNativePassthroughTerminal: status => ...,
```

Responses-vocabulary stream을 Anthropic 형식으로 번역하기 전에 계측하므로 text/reasoning 의미가
HTTP `/v1/responses`와 동일하다. `logIds` 없는 내부 호출은 계측값을 만들지 않는다.

## 10. 테스트 diff 계획

### 10.1 MODIFY — `tests/bridge.test.ts`

현행 `replay()`/`collectSse()` helper(`:5-27`)를 그대로 재사용해 describe 첫 부분에 추가한다.

- `heartbeat`, 빈 text, 빈 thinking 뒤 non-empty `reasoning_raw_delta`, 이후 text를 replay하고
  `onFirstOutput` spy count가 정확히 1인지 검증.
- non-empty `text_delta` 첫 관측에서 1회 호출되는 케이스.
- tool_call_start/delta/end + done만 있는 stream은 callback 0회.
- hidden reasoning(`hideThinkingSummary:true`)과 compaction stream도 non-empty reasoning/text를
  관측하면 callback 1회. 적어도 hidden reasoning 케이스는 같은 파일에 고정한다.

호출 형태:

```ts
let firstOutputs = 0;
await collectSse(bridgeToResponsesSSE(replay(events), "routed/model",
  undefined, undefined, undefined, undefined, 2_000, {
    onFirstOutput: () => { firstOutputs += 1; },
    hideThinkingSummary: true,
  }));
expect(firstOutputs).toBe(1);
```

tool-only negative는 같은 options 형태로 events만 바꿔 고정한다.

```diff
+  test("first-output callback ignores tool-only streams", async () => {
+    let firstOutputs = 0;
+    await collectSse(bridgeToResponsesSSE(replay([
+      { type: "tool_call_start", id: "call_1", name: "read_file" },
+      { type: "tool_call_delta", arguments: "{}" },
+      { type: "tool_call_end", id: "call_1" },
+      { type: "done" },
+    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
+      onFirstOutput: () => { firstOutputs += 1; },
+    }));
+    expect(firstOutputs).toBe(0);
+  });
```

### 10.2 MODIFY — `tests/request-log.test.ts`

현행 deferred JSON/SSE tests(`:350-425`, `:633-788`) 옆에 추가한다.

- native/routed SSE tap fixture: created → empty output delta → non-empty reasoning delta → non-empty
  text delta → completed. `Date.now()` 절대값은 assertion하지 말고 `firstOutputMs`가 finite `>=0`이며
  callback 이후 값이 한 번만 유지되는지 확인한다. active attempt도 optional field를 갖는지 검증.
- `addFinalRequestLog()`에 이미 `firstOutputMs: 12`인 context를 주고 final entry가 12를 보존하는지.
- **비스트리밍 unset**: 현행 deferred JSON response test에
  `expect(entries[0]).not.toHaveProperty("firstOutputMs")`를 추가한다.
- tool-only SSE fixture는 `firstOutputMs` unset.

최소 추가 assertion은 다음 형태다.

```diff
+    expect(typeof entries[0]?.firstOutputMs).toBe("number");
+    expect(entries[0]!.firstOutputMs!).toBeGreaterThanOrEqual(0);
+    expect(entries[0]?.attempts?.[0]?.firstOutputMs).toBe(entries[0]!.firstOutputMs!);
```

비스트리밍 fixture에는 다음을 추가한다.

```diff
     expect(entries).toHaveLength(1);
+    expect(entries[0]).not.toHaveProperty("firstOutputMs");
```

### 10.3 MODIFY — `tests/usage-log.test.ts`

현행 canonical attempt test(`:30-89`)와 malformed sibling test(`:91-131`)를 확장한다.

- parent `firstOutputMs: 7`, attempt `firstOutputMs: 3`을 append/read roundtrip.
- attempt `firstOutputMs`가 `-1`, `NaN`, `Infinity`, 문자열인 malformed siblings는 해당 attempt만
  drop된다.
- parent malformed optional 값은 entry는 유지되고 field만 omit된다.
- legacy line(필드 없음)은 기존 expected object와 동일하다.

JSON은 `NaN/Infinity`를 null로 바꾸므로 해당 두 값은 `appendUsageEntry()` direct input과 raw
`null` fixture를 나눠 검증한다.

canonical roundtrip fixture의 exact field diff:

```diff
       status: 200,
       durationMs: 20,
+      firstOutputMs: 7,
       usageStatus: "estimated",
@@
         status: 503,
         durationMs: 4,
+        firstOutputMs: 3,
         sendCount: 2,
```

read expected object에도 같은 두 값을 넣는다. malformed 배열에는 아래 네 row를 추가한다.

```diff
+      { ...valid(2), firstOutputMs: -1 },
+      { ...valid(2), firstOutputMs: null },
+      { ...valid(2), firstOutputMs: "3" },
+      { ...valid(2), firstOutputMs: Number.POSITIVE_INFINITY },
```

### 10.4 MODIFY — `tests/server-combo-failover-e2e.test.ts`

현행 `latestAttemptReceipts()`가 `/api/logs?tail=1`과 `readUsageEntries()`를 함께 반환한다
(`:242-247`). streaming combo success fixture를 하나 추가해 두 receipt를 동시에 검증한다.

- `/api/logs` parent에 finite nonnegative `firstOutputMs`가 존재.
- 성공 attempt에 finite nonnegative attempt-relative `firstOutputMs`가 존재.
- 같은 field가 마지막 `usage.jsonl` parent/attempt에도 존재.
- tool-only 또는 `stream:false` combo fixture에는 parent/attempt `firstOutputMs`가 없다.

streaming success test의 receipt assertion은 다음 형태로 추가한다.

```ts
const { log, usage } = await latestAttemptReceipts(config);
for (const receipt of [log, usage]) {
  expect(typeof receipt.firstOutputMs).toBe("number");
  expect(receipt.firstOutputMs as number).toBeGreaterThanOrEqual(0);
  const attempt = (receipt.attempts as Array<Record<string, unknown>>)[0]!;
  expect(typeof attempt.firstOutputMs).toBe("number");
  expect(attempt.firstOutputMs as number).toBeGreaterThanOrEqual(0);
}
```

이 테스트가 `/api/logs` additive 노출을 직접 고정한다. management handler 자체는 수정하지 않는다.

## 11. close gate

### 11.1 자동 검증

저장소 루트에서 실행한다.

```sh
bun run typecheck
bun test --isolate tests/bridge.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/server-combo-failover-e2e.test.ts
```

통과 조건은 두 명령 exit 0, 실패 0이다. 특히 다음 assertion이 있어야 한다.

- adapter text/thinking/raw reasoning callback one-shot.
- native tee/deferred SSE first output 기록.
- tool-only와 non-streaming unset.
- parent/attempt JSONL roundtrip 및 malformed optional field 방어.
- `/api/logs` parent/attempt additive field.

### 11.2 실요청 증거

테스트 통과 후 실제 local server에 **스트리밍 text 응답 1건**과 **비스트리밍 응답 1건**을 보낸다.
사용자의 정상 credential/provider를 사용하되 문서나 로그에 secret을 출력하지 않는다.

1. server 시작 전 `$OPENCODEX_HOME`(미설정이면 앱 config dir)의 `usage.jsonl` 경로를 확인한다.
2. streaming 요청 완료 후 마지막 line을 `jq`로 projection한다.

```sh
tail -n 1 "$OPENCODEX_HOME/usage.jsonl" \
  | jq '{requestId,provider,model,durationMs,firstOutputMs,attempts}'
```

`OPENCODEX_HOME`이 미설정이면 실제 config dir의 절대 `usage.jsonl` 경로로 대체한다. 기대 증거:

- text/reasoning streaming line: `firstOutputMs`가 number, `0 <= firstOutputMs <= durationMs`.
- combo면 각 output-producing attempt도 `0 <= firstOutputMs <= durationMs`.
- 비스트리밍 line: `has("firstOutputMs") == false`.

비스트리밍 unset 확인:

```sh
tail -n 1 "$OPENCODEX_HOME/usage.jsonl" \
  | jq '{requestId, hasFirstOutputMs: has("firstOutputMs"), firstOutputMs}'
```

실요청이 credential/network 문제로 실행되지 않으면 close gate는 통과가 아니라 **미확인**이다.
테스트 증거로 대체해 완료 처리하지 않는다.

## 12. 구현 순서와 리스크

1. persisted type/recorder를 먼저 추가한다.
2. bridge callback과 relay shared predicate를 추가한다.
3. responses/index/Claude/combo wiring을 연결한다.
4. unit/persistence/API tests를 추가한다.
5. typecheck와 targeted tests 후 실요청 JSONL 증거를 확인한다.

핵심 리스크:

1. native marked response는 deferred wrapper를 우회한다. tee inspection 두 함수에 callback을
   연결하지 않으면 ChatGPT passthrough TTFT가 항상 unset이다.
2. combo attempt-relative 값을 `childLog.firstOutputMs`에 넣고 `Object.assign()`하면 top-level
   request-relative 값이 덮인다. attempt에 직접 기록하고 root callback은 별도로 호출해야 한다.
3. compaction/hide-thinking early continue 뒤에서 callback을 호출하면 실제 reasoning first output을
   놓친다. event loop의 early continue 전에 판별한다.
4. callback 예외가 response stream을 끊어서는 안 된다. 계측 callback boundary는 swallow한다.
