# 020 — GUI Logs가 누적 컨텍스트 체크포인트를 표시한다

의존: 010 (필드가 먼저 기록돼야 표시할 것이 생긴다)

## 문제

`gui/src/pages/Logs.tsx`의 `UsageBreakdown` 인터페이스에 `contextTotalTokens`가 없어서
(라인 16-25) 010이 기록을 시작해도 표시 경로가 없다. `displayTokenTotal()`(라인 148-156)은
`inputTokens + outputTokens`와 저장된 `totalTokens`의 max만 쓴다.

Kiro는 attempt별 usage만 보고하므로 per-request `inputTokens`는 작게 남는 것이 정상이다.
사용자가 anthropic/kimi 행에서 보는 큰 숫자는 그 프로바이더가 누적 `prompt_tokens`를
보고하기 때문이다. Kiro에서 같은 체감을 주는 값은 `contextTotalTokens`다.

## 변경

### `gui/src/pages/Logs.tsx`

1. `UsageBreakdown`에 `contextTotalTokens?: number` 추가.
2. **행/상세 표시 전용** 헬퍼를 새로 만든다. 기존 `displayTokenTotal()`은 그대로 두고
   `displayContextTokenTotal()`을 추가한다:

```ts
/** 행/상세 표시 전용. 절대 checkpoint를 포함하므로 절대 합산하지 말 것. */
function displayContextTokenTotal(log: LogEntry): number | undefined {
  const base = displayTokenTotal(log);
  const contextTotal = log.usage?.contextTotalTokens;
  if (typeof contextTotal !== "number") return base;
  return Math.max(base ?? 0, contextTotal) || undefined;
}
```

   **왜 분리하는가 (리뷰 blocker 2):** `summarizeFilteredLogs()`가
   `displayTokenTotal()`을 요청마다 누적 합산한다 (`gui/src/pages/Logs.tsx:286-287`).
   `contextTotalTokens`는 매 요청의 **절대 컨텍스트 스냅샷**이므로, 이를 합산하면
   같은 컨텍스트를 요청 수만큼 중복 계상해 집계 토큰이 폭증한다. 한 대화에서
   컨텍스트가 12만이면 20개 요청에 240만처럼 표시된다. 따라서 checkpoint는
   **행과 상세 패널에서만** 쓰고, 집계 합계는 기존 `displayTokenTotal()`을 유지한다.
   행 표시(라인 574 부근)와 상세 패널만 새 헬퍼로 바꾼다.

3. `tokensTitle()` 툴팁에 활성 컨텍스트 항목을 추가해, 표시된 큰 숫자가 per-request
   합계가 아니라 절대 checkpoint라는 점을 밝힌다. 새 i18n 키 `logs.tokens.contextTotal`.

### `gui/src/i18n/*.ts`

`logs.tokens.contextTotal`을 7개 로케일 전부에 추가한다(en, ko, ja, zh, ru, de + 누락 확인).
ko: `활성 컨텍스트`. 한 로케일만 추가하면 나머지에서 키 누락이 된다.

## 회귀 테스트

GUI는 단위 테스트 대신 `bun run lint:gui`와 타입 체크로 가드한다. 표시 로직 자체는
`displayTokenTotal`이 순수 함수이므로, 이미 분리된 헬퍼가 있으면 그 파일에 케이스를
추가하고 없으면 로직을 추출하지 않는다(범위 초과).

판정 근거: `contextTotalTokens`가 `baseTotal`보다 클 때 표시 총합이 checkpoint를
따라가고, 없으면 기존 동작이 그대로 유지된다.

## 위험

- 낮음-중간. Kiro 행의 표시 숫자가 커진다. 이것이 사용자가 요청한 변화지만,
  per-request 비용 추정과 표시 총합이 달라 보일 수 있다. 툴팁 설명으로 완화한다.
- 비용 계산 경로는 건드리지 않는다. 확인 완료: `normalizeCostTokens()`는
  input/output/cacheRead/cacheWrite만 읽고 `contextTotalTokens`를 보지 않는다
  (`src/usage/cost.ts:106-125`). 비용은 서버가 계산한 `displayMetrics.cost`로
  들어오고 GUI 표시 총합과 독립적이다.
- **집계 합산 금지**를 코드 주석으로 못 박는다. 새 헬퍼에 "절대 합산하지 말 것"
  주석이 없으면 다음 사람이 `summarizeFilteredLogs()`에 그대로 끼워넣어 과대 계상을
  만든다. 이번 리뷰에서 실제로 잡힌 함정이다.
- 과거 행은 backfill 불가. `contextTotalTokens`가 기록되지 않았으므로 이번 수정
  이후의 새 요청부터 큰 숫자가 보인다.
