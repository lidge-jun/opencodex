# 010 — wp2: Devin 모델별 추론 사다리

## NEW: src/providers/devin-models.ts 에 사다리 추가 — 또는 live-models.ts 확장

Antigravity는 `ANTIGRAVITY_MODEL_EFFORTS`를 `antigravity-models.ts`에 두고 레지스트리가
import한다. Devin도 같은 자리에 둔다. `src/adapters/devin/live-models.ts`가 이미
`DEVIN_MODEL_CONTEXT_WINDOWS`를 export하고 레지스트리가 그걸 쓰므로 같은 파일에 붙인다.

```ts
/**
 * Effort ladders per collapsed base model.
 *
 * Cognition spells effort as a model-id suffix, so the picker row that
 * collapseDevinModelUid() produces needs its ladder declared here or the catalog
 * falls back to the six-rung default. SWE-2 ships exactly three lanes, so
 * advertising low, xhigh or ultra would offer a control that silently rounds to
 * one of these three - the bar registry.ts:418-420 already sets for Anthropic.
 */
export const DEVIN_MODEL_EFFORTS: Record<string, string[]> = {
  "swe-2": ["medium", "high", "max"],
};

/**
 * Ladder for a model this table does not name, including anything the live
 * catalog discovers. Five rungs rather than six: `ultra` has no Cognition lane.
 */
export const DEVIN_DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
```

## MODIFY: src/providers/registry.ts — devin 행

```ts
// import 줄
import { DEVIN_MODEL_CONTEXT_WINDOWS, DEVIN_MODEL_EFFORTS, DEVIN_DEFAULT_EFFORTS } from "../adapters/devin/live-models";

// devin 행 (1340-1358) 끝에 두 줄
    modelContextWindows: DEVIN_MODEL_CONTEXT_WINDOWS,
+   modelReasoningEfforts: DEVIN_MODEL_EFFORTS,
+   reasoningEfforts: DEVIN_DEFAULT_EFFORTS,
```

`modelReasoningEfforts`가 Codex 피커의 모델별 사다리를 정하고(Antigravity 선례),
`reasoningEfforts`가 Pi 형태 익스포트의 `ExportModel.reasoningEfforts`를 채운다
(Anthropic 선례 `df416a439c`). 한 변경이 두 표면을 동시에 고친다.

## 왜 SWE-2만 표에 넣는가

라이브 카탈로그의 모델별 실제 suffix 집합은 계정마다 다르고 이 세션에서 실측하지
않았다. 확증된 것은 `SWE2_EFFORT`(`devin.ts:116-126`)가 박아 둔 SWE-2의 3레인뿐이다.
나머지는 5단 기본값으로 두고, 실측이 생기면 표에 줄을 추가한다. 모르는 사다리를
지어내는 것보다 낫다.

## NEW: tests/providers/devin-effort-ladder.test.ts

| 케이스 | 기대 |
|---|---|
| `DEVIN_MODEL_EFFORTS["swe-2"]` | `["medium","high","max"]` — `low`/`xhigh`/`ultra` 없음 |
| 표의 모든 사다리가 `SWE2_EFFORT`의 치역에 포함 | 광고와 실제 레인 일치 (드리프트 가드) |
| devin 레지스트리 행이 두 필드를 모두 노출 | 두 표면 회귀 |
| `DEVIN_DEFAULT_EFFORTS`에 `ultra` 없음 | Cognition 레인 없음 |
| omp export가 Devin 모델에 `thinking.mode = "effort"`를 씀 | Pi 회귀 — `management-client-config-route.test.ts:181` Anthropic 케이스 복제 |

마지막 줄이 증상 3의 직접 회귀다. 기존 Anthropic 케이스가 그대로 본이 된다.

## 레이아웃 등록

- `scripts/test-layout/layout.json` `explicit`
- `tests/fixtures/test-layout-expected.json`

`devin-adapter.test.ts`가 `providers`로 등록돼 있으니 같은 값을 쓴다.

## 범위 밖

레인 C가 #4484 후속으로 남긴 것들 — `src/adapters/registry.ts:26-30`의 구 주석,
`DEVIN_STATIC_MODELS`에 swe-2 부재, `stale-context-window-migration.ts:45-56`의 구
로스터. 사다리와 무관하므로 이 PR에서 건드리지 않는다.

