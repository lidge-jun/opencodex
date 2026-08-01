# 140 — Heartbeat Stall Timeout 설정화 (Medium)

## 문제

`bridge.ts`의 heartbeat stall timeout이 `maxStallTicks=150` (2s × 150 = 5분)으로 하드코딩.

Codex RS 분석 결과:
- Codex RS의 idle timeout은 ANY SSE frame으로 리셋됨 (`timeout(idle_timeout, stream.next())`)
- opencodex의 heartbeat (`response.heartbeat`)가 2초마다 전송되므로 Codex 자체 idle timeout은 영원히 발동 안 함
- 따라서 proxy의 stall timeout이 **유일한** provider 실패 감지 경로
- 5분은 너무 긺 — 사용자가 멈춘 provider를 5분간 기다려야 함

## 수정

### MODIFY `src/types.ts` — OcxConfig에 필드 추가

```diff
  hostname?: string;
+ /** Upstream stall timeout (seconds). Default 90. After this many seconds of no
+  * upstream data, the proxy emits response.incomplete. */
+ stallTimeoutSec?: number;
  websockets?: boolean;
```

### MODIFY `src/bridge.ts:45,107` — 하드코딩 제거

```diff
  heartbeatMs = 2_000,
+ stallTimeoutSec = 90,
  options?: { responseId?: string },
```

```diff
- const maxStallTicks = 150; // 5 min at default 2 s interval
+ const maxStallTicks = Math.ceil((stallTimeoutSec * 1000) / heartbeatMs);
```

### MODIFY `src/server.ts` — config에서 stallTimeoutSec를 bridge에 전달

bridge 호출부에서 `config.stallTimeoutSec ?? 90` 전달.

### 설계 결정

- 기본값 90초 (5분 → 90초): 대부분의 LLM 응답은 30초 내 시작. 90초면 slow provider도 충분히 커버
- config 파일에서 변경 가능: heavy reasoning 모델 사용자는 더 길게 설정 가능
- heartbeat 간격(2초)은 변경 안 함 — Codex idle timeout 리셋용으로 적절

### MODIFY `tests/bridge-lifecycle.test.ts`

```ts
test("stall timeout triggers response.incomplete after configured seconds", async () => {
  // heartbeatMs=100, stallTimeoutSec=1 → maxStallTicks=10
  // 10 ticks 후 정확히 response.incomplete 1회 발생 확인
});
```

## 검증

1. `stallTimeoutSec=1` + `heartbeatMs=100` → ~1초 후 `response.incomplete` (unit test)
2. 기본값 90초가 config 미설정 시 적용 확인
3. config에 `stallTimeoutSec: 30` 설정 시 30초 timeout 동작 확인
