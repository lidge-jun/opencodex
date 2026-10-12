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


## 계획 수정 — 전 모델 적용 (사용자 지시)

"swe 뿐만 아니라 모든 devin 모델들에 대해 적용해야" 한다는 지시를 받았다. 정적 표로
전 모델을 채우려면 계정마다 다른 로스터를 지어내야 하므로, 설계를 바꾼다.

**라이브 카탈로그가 이미 답을 알고 있고 우리가 버리고 있다.**

`fetchDevinUsableModels`(`live-models.ts:97-127`)는 `catalog.byUid`를 돌면서
`collapseDevinModelUid`로 접미사를 벗긴다. 벗겨낸 그 토큰이 곧 그 모델의 실제
사다리다. 지금은 버려지고 base id만 남는다. `contextWindows`를 base별로 모으는 것과
똑같은 자리에서 efforts도 모으면 된다.

전달 채널도 이미 있다 — `CatalogModel.reasoningEfforts?: string[]`
(`parsing.ts:114`)와 `defaultReasoningEffort`(`:115`).

### 바뀐 diff 계획

**MODIFY `src/adapters/devin/live-models.ts`** — 결과 타입에 `efforts` 추가.

```ts
export type DevinUsableModelsResult =
  | { ok: true; models: string[]; contextWindows: Record<string, number>;
      efforts: Record<string, string[]> }
  | { ok: false; error: "auth" | "http" | "empty" | "unknown"; detail?: string };
```

수집 루프에서, 벗겨낸 토큰 중 Codex 사다리에 해당하는 것만 모은다.

```ts
const efforts = new Map<string, Set<string>>();
// ...루프 안, base 계산 직후
for (const token of devinEffortTokensOf(entry.modelUid, base)) {
  if (!CODEX_REASONING_RUNGS.has(token)) continue;  // fast/priority/1m 제외
  (efforts.get(base) ?? efforts.set(base, new Set()).get(base)!).add(token);
}
```

`fast`, `priority`, `1m`은 추론 단계가 아니라 티어·변형이므로 사다리에서 뺀다.
접미사 변형이 하나도 없는 base는 사다리가 비고, 그러면 컨트롤이 안 붙는다 — 그게
정직한 결과다.

**MODIFY `src/codex/catalog/provider-fetch.ts:1736-1744`** — base별 사다리를 싣는다.

```ts
      const result = liveResult.models.map((id) => {
        const liveWindow = liveResult.contextWindows[id];
        const liveEfforts = liveResult.efforts[id];
        return {
          id,
          provider: name,
          ...(liveWindow ? { contextWindow: liveWindow } : {}),
          ...(liveEfforts?.length ? { reasoningEfforts: liveEfforts } : {}),
          ...catalogHintsFromProviderConfig(...),
        } as CatalogModel;
      });
```

`catalogHintsFromProviderConfig`를 뒤에 두는 순서는 그대로다. contextWindow와 같은
이유로, 사용자가 명시한 오버라이드가 계속 이긴다.

**MODIFY `src/providers/registry.ts`** — degraded 모드 폴백.

라이브 카탈로그가 없을 때(로그인 전, 쿨다운, 네트워크 실패)는 시드 로스터가 쓰인다.
그때를 위한 정적 표와, Pi 형태 익스포트가 읽는 프로바이더 레벨 기본값을 둔다.

```ts
    modelReasoningEfforts: DEVIN_MODEL_EFFORTS,
    reasoningEfforts: DEVIN_DEFAULT_EFFORTS,
```

정적 표에는 실측된 것만 넣는다 — 현재는 `swe-2: ["medium","high","max"]`
(`SWE2_EFFORT` `devin.ts:116-126`이 박아 둔 3레인). 나머지는 기본값을 쓰고, 로그인
후에는 라이브 값이 덮는다. 모르는 사다리를 지어내지 않는다.

### 이 설계가 나은 이유

| | 정적 표만 | 라이브 파생 |
|---|---|---|
| 커버리지 | 손으로 적은 모델만 | **계정이 가진 전 모델** |
| 정확도 | 작성 시점 추측 | 계정의 실제 카탈로그 |
| 새 모델 | 코드 수정 필요 | 자동 |
| 계정별 차이 | 표현 불가 | 자연히 반영 |

Antigravity가 정적 표를 쓰는 건 그쪽 로스터가 고정이기 때문이다. Devin은 계정마다
다르고 이미 라이브 디스커버리를 하므로, 같은 목적지에 더 맞는 길이 있다.

