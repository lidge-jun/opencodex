# 020 — transient 5xx → Anthropic 529 `overloaded_error` 매핑 (Claude 경로)

## 목표

010의 프록시 재시도가 소진돼도 Claude Code(Anthropic SDK 기반, 5xx/529를
retry-after 존중 지수백오프로 자동 재시도 — platform.claude.com/docs/en/api/errors
Tier-2 확인)가 스스로 재시도하도록, Claude 경로에서 upstream transient 5xx를
`api_error` 대신 529 `overloaded_error`로 분류한다. 대상은 두 지점: pre-stream
HTTP 에러 봉투와 mid-stream SSE 에러 이벤트의 **type 분류**. mid-stream의
fail-closed 정책(blind replay 금지) 자체는 불변 — 바꾸는 것은 에러의 분류뿐이다.

## 변경 파일

### MODIFY `src/server/claude-messages.ts` `if (!response.ok)` 분기 (~line 449)

before (핵심부):

```ts
const retryAfter = response.headers.get("retry-after");
const out = new Response(JSON.stringify(anthropicErrorBody(response.status, message)), {
  status: response.status,
  headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
});
```

after:

```ts
const retryAfter = response.headers.get("retry-after");
// Transient upstream 5xx (already retried pre-stream in 010): reclassify as Anthropic
// 529 overloaded_error so the Claude Code client applies its built-in backoff retry
// instead of treating the turn as a fatal api_error (260716 sol-builder incident).
const transient = isTransientUpstreamStatus(response.status);
const outStatus = transient ? 529 : response.status;
const out = new Response(JSON.stringify(anthropicErrorBody(outStatus, message)), {
  status: outStatus,
  headers: {
    "Content-Type": "application/json",
    ...(retryAfter ? { "Retry-After": retryAfter } : (transient ? { "Retry-After": "2" } : {})),
  },
});
```

import: `isTransientUpstreamStatus` from `../lib/upstream-retry`.
원문 메시지(`message`, request ID 포함)는 보존 — 진단성 유지.
504는 transient 집합에 포함되어 529로 승격된다(기존 `timeout_error`도 Claude가
재시도하지 않는 치명 분류이므로 overloaded 승격이 사건 목적에 부합).

### MODIFY `src/claude/outbound.ts` — SSE `fail()`의 타입 분류 (fail 구현부 = line 205)

감사 확인: `fail(status, message)`은 outbound.ts:205에서
`emit("error", anthropicErrorBody(status, message))`만 수행 — 실제 diff는
`anthropicErrorBody`의 **3번째 인자(type)** 전달이다. 감사 blocker #3 반영:
**upstream 유래 실패만** overloaded로 승격하고, 프록시 내부 예외는 api_error 유지
(내부 버그를 클라이언트 재시도로 가리면 안 됨).

```ts
// fail 시그니처에 플래그 추가
const fail = (status: number, message: string, upstreamDerived = false) => {
  // ...기존 terminated/ensureStarted/closeOpenBlock...
  const type = upstreamDerived && isTransientUpstreamStatus(status) ? "overloaded_error" : undefined;
  emit("error", anthropicErrorBody(status, message, type));
};
```

호출처별 플래그:

- `response.failed` 핸들러(outbound.ts:326) → `upstreamDerived: true`.
  **주의(blocker #3 핵심)**: `relaySseWithFailedTail`의 합성 `response.failed`는
  `error: {type, code, message}`만 있고 숫자 `status`가 없어 기본값 500으로
  들어온다 — 500이 transient 집합에 있으므로 실제 리셋 시나리오가 이 경로로
  overloaded가 된다. 이것이 의도된 동작이다.
- EOF 트렁케이션 `fail(502, "...truncated...")`(outbound.ts:363) → `upstreamDerived: true`.
- reader 예외 catch `fail(500, err.message)`(outbound.ts:365) → 플래그 없음(내부
  예외, api_error 유지).
- win32 잔여(재감사 Low): win32는 relaySseWithFailedTail 없이 nativeBody를 직접
  릴레이하므로 mid-stream 소켓 리셋이 :365 catch로 들어와 api_error로 남는다 —
  현행과 동일한 보수적 방향(회귀 아님), 의도된 잔여로 기록.

문서 계약: mid-stream error 이벤트의 `error.type`만 바뀌고 스트림 종결 방식·
fail-closed는 동일.
`anthropicErrorType` 함수 자체는 변경 금지 — 다른 소비처의 400번대/504 매핑 보존.

### 로그 상호작용 (감사 blocker #7 — 분석 완료, 코드 변경 없음)

`responseWithDeferredRequestLog`(relay.ts:200)의 `finalizeJsonLog`는 **upstream
`response.status`(502)를 클로저로 잡은 뒤**에 봉투가 재작성되므로, request-log와
usage.jsonl(030)에는 원래의 upstream 502가 남고 클라이언트만 529를 본다. 의도된
진단 설계: 로그 = upstream 진실, 클라이언트 = 재시도 신호. 향후 포렌식에서
"로그 502 vs 클라이언트 529" 불일치는 정상이다. cr2 테스트에 로그 항목이 502를
유지하는 assertion을 포함한다.

## 리스크/미검증

- Claude Code가 **mid-stream** error 이벤트의 overloaded_error를 자동 재시도하는지는
  문서로 미확정(SDK 레벨 pre-stream 재시도는 Tier-2 증명). 매핑해도 현재보다
  나빠질 수 없음(현행도 치명 처리): 순수 개선 or 무해.
- 진짜 영구 장애(수 분 연속 5xx)가 529로 보이면 Claude Code가 몇 회 더 재시도 후
  동일하게 실패 — 허용 가능한 트레이드오프, 메시지 원문으로 판별 가능.

## Accept criteria + activation

- MODIFY `tests/claude-messages-endpoint.test.ts` (또는 NEW `tests/claude-529-mapping.test.ts`):
  1. mock upstream 502 JSON 에러 → `/v1/messages` 응답 status 529 + body
     `error.type === "overloaded_error"` + 원문 메시지 포함 + Retry-After 존재 (cr2)
     + request-log/usage 항목의 status는 upstream 502 유지 (blocker #7)
     + upstream이 Retry-After를 준 경우 그 값이 fallback "2"보다 우선함을 assert
  2. mock upstream 400 → status 400 + `invalid_request_error` 보존 (비-transient 불변)
- MODIFY `tests/claude-outbound.test.ts`:
  3. SSE `response.failed`(error.status 502) → error 이벤트 `overloaded_error`
  3b. SSE `response.failed`(**status 필드 부재** — relaySseWithFailedTail 실물 형상)
     → 기본 500 경로 → `overloaded_error` (blocker #3 activation)
  4. EOF 트렁케이션(터미널 없이 종료) → 502 경로 → overloaded_error
     (기존 :130의 api_error assertion을 갱신)
  5. reader 내부 예외 경로 → `api_error` 유지 (내부 예외 비승격)
  (upstreamDerived+비-transient 케이스는 기존 claude-outbound.test.ts:111의 429→
  rate_limit_error 테스트가 커버 — 삭제 금지)
- 전체 스위트 green.
