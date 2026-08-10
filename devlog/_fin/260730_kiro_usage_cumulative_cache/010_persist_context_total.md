# 010 — 누적 컨텍스트 체크포인트를 로그 지속 경로에 통과시킨다

의존: 없음 (첫 구현 단계)

## 문제

`normalizeUsageValue()`가 필드 화이트리스트를 쓰는데 `contextTotalTokens`가 빠져 있어
`usage.jsonl` 전체에서 이 필드가 0회 등장한다. 브리지 wire(`src/bridge.ts:34-41`)는
이미 이 값을 쓰고 있으므로 어댑터 → 브리지는 정상이고, 지속 계층만 끊겼다.

## 변경

### `src/usage/log.ts`

`normalizeUsageValue()` 화이트리스트에 `contextTotalTokens`를 추가한다.
`totalTokens` 바로 앞에 배치해 canonical 주석 순서(`src/types.ts:309-326`)와 맞춘다.

```ts
 return {
   inputTokens: usage.inputTokens,
   outputTokens: usage.outputTokens,
+  ...(typeof usage.contextTotalTokens === "number" ? { contextTotalTokens: usage.contextTotalTokens } : {}),
   ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
```

`usageTotalTokens()` / `usageDisplayTotalTokens()`는 건드리지 않는다. `contextTotalTokens`는
절대 checkpoint이고 표시 총합과 의미가 다르다. 총합 계산에 섞으면 devlog 070의
"cache detail을 다시 더하지 않는다" 규약과 같은 종류의 이중 계상을 만든다.

### `src/server/request-log.ts` — 이번 단계에서 제외 (리뷰 blocker 3)

초안은 `finalizedUsage()`의 `Math.max` floor를 authoritative 캐시 분해 존재 여부로
건너뛰게 하려 했다. **철회한다.** 이유:

- 이 floor의 목적은 인과 사슬(000 참조)과 무관하다. 별개 관심사다.
- `inputTokens`를 바꾸면 `normalizeCostTokens()`가 그 값을 그대로 쓰므로
  (`src/usage/cost.ts:106-125`) Kiro/Cursor 비용 계산이 변한다. 이번 수정의 목표는
  표시 복원이고, 비용 회계 변경은 별도 근거와 테스트가 필요하다.
- 캐시 필드 존재만으로 floor를 끄는 판정은 근거가 약하다.

정합성 문제(`inputTokens != uncached + read + write`)는 실재하지만, 현재 실측에서
authoritative 캐시 분해를 가진 행이 0개라 발동하지 않는다. 별도 후속으로 남긴다.

## 회귀 테스트

`tests/usage-log.test.ts`

1. `contextTotalTokens`를 담은 usage가 직렬화 왕복(serialize → parse) 후에도 값을 유지한다.
   현재 트리에서 실패한다.
2. `contextTotalTokens`가 없는 usage는 필드를 만들어내지 않는다.

`tests/request-log.test.ts` — **프로덕션 분기 테스트 (리뷰 blocker 1, 필수)**

3. 회귀가 조용히 통과한 이유는 기존 테스트
   (`deferred logging preserves a bridged Kiro absolute context checkpoint`,
   `tests/request-log.test.ts:906`)가 `usageFromBridge`를 켜지 않고 wire 재파싱 경로만
   재현하기 때문이다. 프로덕션은 `src/server/responses/core.ts:2473`에서 `onUsage`로
   raw usage를 넣고 `usageFromBridge`를 켠다. 그 조합을 덮는 테스트를 추가한다:

   - `onUsage`가 raw Kiro usage(`contextTotalTokens` 포함, 캐시 필드 없음)를 보고하고
     `logCtx.usageFromBridge = true`가 설정된 상태에서
   - 지속된 JSONL 행이 `contextTotalTokens`를 유지하고
   - 캐시 필드는 여전히 부재하며
   - `cache_detail_missing` 사유가 계속 붙는다 (0422ce193이 고친 동작 보존 증명).

   이 테스트가 없으면 같은 종류의 조합 퇴행이 또 통과한다.

## 위험

- 낮음. 필드 추가는 append-only 로그에 하위 호환이다. 기존 행에는 필드가 없고
  읽기 경로는 `typeof === "number"` 가드를 쓴다.
- 기존 행은 backfill 불가하다. checkpoint가 기록 시점에 이미 버려졌으므로 과거
  Kiro 행은 계속 작은 숫자로 남는다. 사용자에게 이 점을 알려야 한다.
- 비용 경로는 영향 없음. `normalizeCostTokens()`는 input/output/cacheRead/cacheWrite만
  읽고 `contextTotalTokens`를 보지 않는다 (`src/usage/cost.ts:106-125`).
  `cache_detail_missing` 판정도 캐시 필드 3개의 부재만 본다
  (`src/server/management/shared.ts:134-136`). 확인 완료.
