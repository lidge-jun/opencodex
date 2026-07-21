# 030 — 패치 계획 S: mid-stream 실패 분류 + 계정 cooldown escalation (#186)

- 소스 RCA: `006_rca_s_sticky_502.md` (리뷰어 검증 완료; mid-stream 결함은 코드로 증명됨)
- 위험도: 중간~높음 (요청 런타임 핵심 경로 — 오분류 시 건강한 계정 회피/성능 저하)
- 선행 조건: 없음. 단 구현 순서상 Diff 1(분류)이 Diff 2(escalation)보다 선행 —
  escalation은 올바른 실패 신호 위에서만 의미가 있음.

## 핵심 제약 (리뷰어 blocker 반영)

**`ResponsesTerminalStatus` 공유 유니언을 확장하지 않는다.** `transport_failure`를 프로토콜
status로 추가하면 request log·WebSocket·native passthrough 등 선언된 write set 밖 소비자에
파급된다. 대신 **inspection-local 분류**를 쓴다: 기존 `failed` status + synthetic 502 마커
(`httpStatusOverride=502` 경로는 이미 존재 — `responses.ts:437-444` 주석 참조)로 전달.

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `src/server/relay.ts` | MODIFY | `consumeForInspection`의 `onTerminal` 파라미터 타입을 2-인자로 확장 + catch 분기에서 cancel/실제 read-error 분리 후 `failed`+502 보고 |
| `src/server/responses.ts` | MODIFY | `reportNativeTerminal` 래퍼가 2번째 인자를 recorder로 전달하도록 배선 |
| `src/codex/routing.ts` | MODIFY | per-account cooldown escalation |
| `src/server/request-log.ts` | MODIFY | `RequestLogEntry`에 진단 필드 3종 추가 |
| `tests/codex-routing.test.ts` | MODIFY | 분류 매트릭스 + escalation 회귀 |

## Diff 0 (선행) — `onTerminal` 콜백 시그니처 확장 (`relay.ts:409`, 배선 `responses.ts:1216`)

**중요(리뷰어 blocker + 자체 검증):** recorder(`codexForwardTerminalOutcomeRecorder`,
`responses.ts:425`)는 이미 `(status, httpStatusOverride?) => void`이지만, 그 사이 배선 두 곳은
단일 인자라 `onTerminal("failed", 502)`가 타입 통과하지 못한다. 두 지점을 먼저 확장한다.

`ResponsesTerminalStatus` 유니언 자체는 건드리지 않는다(공유 타입 파급 금지) — 콜백 시그니처에만
옵셔널 2번째 인자를 추가한다.

Before (`relay.ts:409`, 실측):

```ts
export function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
```

After:

```ts
export function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus, httpStatusOverride?: number) => void,
```

Before (배선 래퍼 `responses.ts:1216`, 실측):

```ts
        const reportNativeTerminal = (status: ResponsesTerminalStatus) => {
          terminalRecorder?.(status);
          options.onNativePassthroughTerminal?.(status);
        };
```

After:

```ts
        const reportNativeTerminal = (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
          terminalRecorder?.(status, httpStatusOverride);
          options.onNativePassthroughTerminal?.(status);
        };
```

참고: `onNativePassthroughTerminal` 콜백은 status만 소비하므로 override 미전달 유지(범위 밖 파급 없음).

## Diff 1 — inspection 실패 재분류 (`relay.ts:483-485`)

Before (실측):

```ts
    } catch {
      if (!reported && !cancelled) onTerminal("incomplete");
    } finally {
```

After:

```ts
    } catch {
      // Upstream read failure after HTTP 200 (mid-stream socket reset). This is
      // NOT the protocol `response.incomplete` terminal — report `failed` with a
      // synthetic 502 so the account-health recorder treats it as a transient
      // upstream failure instead of a success. Client cancellation must win:
      // `cancelled` (abort-driven rejection) records nothing.
      if (!reported && !cancelled) onTerminal("failed", 502);
    } finally {
```

전제 확인(자체 검증 완료): Diff 0으로 `consumeForInspection.onTerminal`과 `reportNativeTerminal`
래퍼가 2-인자를 전달하게 되면, recorder(`responses.ts:425`)의 `failed` 분기가 `httpStatusOverride ??
logCtx?.terminalHttpStatus ?? 502` 순으로 502를 취해 transient 기록(`recordCodexUpstreamOutcome`
5xx 경로 → soft-avoid/affinity 해제)으로 흐른다. `cancelled` 가드는 기존 `relay.ts`의 abort 분리를
그대로 사용 — cancel 시 계정 페널티 0. (주의: relay.ts에는 catch 분기 외에 정상 EOF 직전
`if (!reported && !cancelled) onTerminal("incomplete")`가 한 곳 더 있다 — 그 경로는 "이벤트 없이 스트림이
깨끗이 끝난" 경우로, 본 diff의 catch(read throw) 경로와 구분해 `incomplete` 유지한다.)

주의: 진짜 `response.incomplete` terminal 이벤트(SSE로 도착)는 기존 `incomplete` 성공 처리
유지 — 이 diff는 "이벤트 없이 read가 throw한" 경로만 바꾼다.

## Diff 2 — cooldown escalation (`routing.ts:494` 인접)

현행: transient 실패마다 고정 `now + CODEX_TRANSIENT_SOFT_AVOID_MS`(30s).

변경: 5분 failure window(`CODEX_FAILURE_WINDOW_MS`) 내 연속 실패 횟수 기반 단계:

```
1회: 30s → 2회: 2m → 3회: 10m → 4회+: 30m (상한)
```

- 복구: 단일 2xx 즉시 전체 클리어(`routing.ts:451`) 대신, escalation 단계가 2 이상인 계정은
  연속 정상 terminal 2회 후 완전 클리어 (1단계는 현행 즉시 클리어 유지 — 과도한 보수화 방지).
- `upstreamFailoverThreshold: 0` (failover 비활성) 설정은 현행처럼 escalation도 비활성.

## Diff 3 — 진단 필드 (관측성, 최소)

`RequestLogEntry`(`src/server/request-log.ts:67`)에 옵셔널 필드 3종 추가.

Before (`request-log.ts:93-95` 실측 — `RequestLogEntry` 말미):

```ts
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
}
```

After:

```ts
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  /** Codex pool affinity decision for this request (diagnostics for #186). */
  affinity?: "reused" | "new_bind" | "rebound" | "cleared";
  /** Where the upstream terminal/failure was observed. */
  transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse";
  /** Whether the terminal came from a real upstream SSE event or a proxy synthetic tail. */
  terminalSource?: "upstream" | "synthetic";
}
```

채움 지점: `affinity`는 `routing.ts`의 선택/rebind/clear 경로(`:372,:410,:487,:507` 인접)에서
logCtx에 기록, `transportPhase`/`terminalSource`는 `relay.ts` inspection 경로(pre-header reject vs
catch(mid_stream) vs SSE terminal)에서 기록. 계정 label은 기존 `openai-<safe-label>` 체계 유지.

## 명시적 범위 밖

- binding 전 lightweight probe, pool-exhaustion circuit-breaker (`routing.ts:419` fail-open),
  compact buffering 재검토(`responses.ts:1823,1830`), Windows raw relay 경로 — 후속 단위로 승격 가능하도록 방향만 기록.

## 테스트 매트릭스 (리뷰어 요구 반영)

| 시나리오 | 기대 |
|----------|------|
| pre-abort된 클라이언트 (읽기 전 cancel) | 기록 없음, 페널티 0 |
| mid-drain 클라이언트 cancel | 기록 없음, 페널티 0 |
| upstream read rejection (200 후 socket reset) | `failed`+502 → transient 실패 기록, affinity 해제 |
| 이벤트 없는 clean EOF | 현행 유지 (incomplete → 성공) — 의도 명시 |
| 실제 `response.incomplete` SSE terminal | 성공 기록 유지 |
| 연속 transient 실패 2/3/4회 | 2m/10m/30m escalation |
| escalation 2단계+ 계정의 첫 2xx | 즉시 클리어 안 됨, 2연속 후 클리어 |

## 수용 기준 / 검증

- [ ] `bun test tests/codex-routing.test.ts` — 위 매트릭스 전부 커버 (신규 케이스 포함)
- [ ] `bun run typecheck` 통과 — `ResponsesTerminalStatus` 유니언 무변경 확인 (`rg -n "type ResponsesTerminalStatus" src` diff 없음; 변경은 콜백 시그니처와 `RequestLogEntry`에 한정)
- [ ] `bun test tests/codex-routing.test.ts` 내 escalation 단계(30s/2m/10m/30m)와 2연속-2xx 복구 단위 검증
- [ ] `reportNativeTerminal`이 2-인자를 recorder로 전달하는지 회귀 assert (양 인자 캡처)
