# 000 — OpenAI Priority (Fast) 서비스 티어 가격 배수 반영

## 목표

opencodex 가상 비용 산정(`src/usage/cost.ts`)에 OpenAI `service_tier: "priority"` (Fast)
가격 배수를 반영. 현재 `(provider, modelId)` 키로만 가격을 조회해서 priority 티어
요청도 베이스 가격으로 계산됨. usage 로그에는 이미 `requestedServiceTier`가 기록됨.

## 공식 가격 출처

OpenAI 공식 가격 페이지 (2026-07-24 확인):
https://platform.openai.com/docs/models

| 모델 | Standard ($/1M in/out) | Priority ($/1M in/out) | 배수 |
|------|----------------------|----------------------|------|
| GPT-5.6 Sol | 5 / 30 | 10 / 60 | 2× |
| GPT-5.6 Terra | 2.5 / 15 | 5 / 30 | 2× |
| GPT-5.6 Luna | 1 / 6 | 2 / 12 | 2× |
| GPT-5.5 | 5 / 30 | 12.5 / 75 | 2.5× |
| GPT-5.4 | 2.5 / 15 | 5 / 30 | 2× |
| GPT-5.3-codex-spark | 1.75 / 14 | 미확인 | 보류 |

cacheRead/cacheWrite도 동일 배수 적용 (공식 문서: "Priority pricing applies to all token types").

## 변경 범위 (IN)

1. `src/usage/expected-prices.ts` — `PRIORITY_MULTIPLIERS` 모델별 배수 테이블 + `resolvePriorityMultiplier(modelId)` 헬퍼 추가
2. `src/usage/cost.ts` — `estimateRequestCost`, `estimateAttemptCost`, `estimateComboCost`에 `serviceTier?: string` 파라미터 추가; priority일 때 cost4에 배수 적용
3. `src/usage/summary.ts` — `addEstimatedCost`, `buildModels`, `buildProviders`에서 `entry.requestedServiceTier` 전달
4. `src/server/management/shared.ts` — `costResult`에서 `requestedServiceTier` 전달
5. `tests/usage-cost.test.ts` — priority 배수 적용 + 미지정 회귀 테스트

## 변경 범위 (OUT)

- GUI 변경
- 카탈로그 service_tiers 구조
- 비-OpenAI 프로바이더 priority 가격
- 실제 과금 연동
- gpt-5.3-codex-spark (공식 priority 가격 미확인 → 배수 테이블에서 제외)

## 파일 변경 맵

### src/usage/expected-prices.ts (MODIFY)

```ts
// 파일末尾, findExpectedPriceOverlay 아래 추가

/** OpenAI service_tier "priority" (Fast) 가격 배수.
 *  공식 가격 페이지 기준 (2026-07-24). 모델 ID는 jawcode/openai 번들 슬러그. */
export const PRIORITY_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 2,
  "gpt-5.6-terra": 2,
  "gpt-5.6-luna": 2,
  "gpt-5.5": 2.5,
  "gpt-5.4": 2,
};

export function resolvePriorityMultiplier(modelId: string): number {
  return PRIORITY_MULTIPLIERS[modelId] ?? 1;
}
```

### src/usage/cost.ts (MODIFY)

- `estimateRequestCost` input에 `serviceTier?: string` 추가
- `estimateAttemptCost` attempt pick에 `serviceTier?: string` 추가 (combo에서 각 attempt는 entry 레벨 serviceTier 공유)
- `estimateComboCost`에 `serviceTier?: string` 추가
- `calculateCost` 호출 전에 `cost4`에 배수 적용:
  ```ts
  const multiplier = resolvePriorityMultiplier(modelId);
  const effectiveCost4 = multiplier !== 1
    ? { input: cost4.input * multiplier, output: cost4.output * multiplier, cacheRead: cost4.cacheRead * multiplier, cacheWrite: cost4.cacheWrite * multiplier }
    : cost4;
  ```
- `CostEstimate`에 `priorityMultiplier?: number` 추가 (GUI 표시용, optional)

### src/usage/summary.ts (MODIFY)

- `addEstimatedCost(totals, entry)` → `entry.requestedServiceTier`를 `estimateRequestCost`/`estimateComboCost`에 전달
- `buildModels`, `buildProviders`의 비용 계산 루프도 동일하게 전달

### src/server/management/shared.ts (MODIFY)

- `MetricSource`에 `requestedServiceTier?: string` 추가
- `costResult(entry)` → `entry.requestedServiceTier` 전달

### tests/usage-cost.test.ts (MODIFY)

- priority 배수 적용 테스트 (gpt-5.6-sol, 2×)
- priority 2.5× 테스트 (gpt-5.5)
- service_tier 미지정 → 배수 1 (회귀)
- 알 수 없는 모델 + priority → 배수 1 (폴백)

## 수용 기준

- c1: priority 티어 요청 비용 = 베이스 × 배수 (테스트 증명)
- c2: service_tier 미지정 → 기존 가격 그대로 (회귀 없음)
- c3: `bun run typecheck` green
- c4: `bun run test` green

## 활성화 시나리오 (C-ACTIVATION-GROUNDING)

- `requestedServiceTier === "priority"`이고 모델이 PRIORITY_MULTIPLIERS에 있으면 배수 적용
- `requestedServiceTier` 미지정 또는 `"default"` → 배수 1
- PRIORITY_MULTIPLIERS에 없는 모델 → 배수 1
