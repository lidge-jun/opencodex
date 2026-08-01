# 120 — WebSocket JSON incomplete event type 수정 (High)

## 문제

`ws-bridge.ts`의 JSON body→WebSocket 변환 경로에서, response status가 `incomplete`여도 event type은 `response.completed`로 전송됨.

```ts
// ws-bridge.ts:222-227 (현재)
const finalStatus = response.status === "failed" || response.status === "incomplete"
  ? response.status : "completed";
sendJsonFrame(ws, {
  type: finalStatus === "failed" ? "response.failed" : "response.completed",
  //                                                    ^^^^^^^^^^^^^^^^ incomplete도 여기로
  response: { ...response, status: finalStatus },
});
```

Codex RS는 event **type**으로만 terminal을 판정:
- `response.completed` → 정상 완료 (usage 저장, 다음 turn 진행)
- `response.incomplete` → 에러 (`ApiError::Stream("Incomplete response...")`)
- body의 `status` 필드는 무시

## 수정

### MODIFY `src/ws-bridge.ts:222-228`

```diff
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
  sendJsonFrame(ws, {
-   type: finalStatus === "failed" ? "response.failed" : "response.completed",
+   type: `response.${finalStatus}`,
    response: { ...response, status: finalStatus },
  });
```

`response.${finalStatus}`는:
- `"failed"` → `"response.failed"`
- `"incomplete"` → `"response.incomplete"`
- `"completed"` → `"response.completed"`

### MODIFY `tests/ws-endpoint.test.ts`

JSON incomplete fixture 추가:

```ts
test("JSON response with status 'incomplete' emits response.incomplete event type", () => {
  // Mock JSON response with status: "incomplete"
  // Verify sendJsonFrame receives type: "response.incomplete"
  // NOT type: "response.completed"
});
```

## 검증

1. JSON response `status: "incomplete"` → WS event `type: "response.incomplete"` (unit test)
2. JSON response `status: "failed"` → WS event `type: "response.failed"` (regression)
3. JSON response `status: "completed"` → WS event `type: "response.completed"` (regression)
