# 050 — wp5: effort 접미사 집합이 두 벌로 갈라져 있다

A 단계 감사(BLOCKER-1)가 찾아낸, 로드맵이 놓쳤던 버그다. wp1과 같은 함수를 건드리지만
별개 결함이라 별도 PR로 간다.

## 증상

같은 저장소에 effort 접미사 목록이 두 벌 있고, 서로 다르다.

`src/adapters/devin.ts:69` — 요청 경로:

```ts
const EFFORT_SUFFIXES = new Set(["low", "medium", "high", "xhigh", "max", "none", "1m", "max-1m", "none-1m", "fast"]);
```

`src/adapters/devin/live-models.ts:75-77` — 카탈로그/피커 경로:

```ts
const EFFORT_TOKENS = new Set([
  "low", "medium", "high", "xhigh", "max", "none", "fast", "priority", "1m",
]);
```

`priority`가 한쪽에만 있다. 레인 A가 네이티브 바이너리에서 확인한 실제 카탈로그
접미사에는 `-priority`가 있고(`gpt-5-6-sol-medium-priority`), `collapseDevinModelUid`는
이미 그것을 접미사로 취급해 벗겨낸다.

## 결과

`hasEffortSuffix("gpt-5-6-sol-medium-priority")`는 마지막 토큰 `priority`가
`EFFORT_SUFFIXES`에 없으므로 **false**다. 그러면 `resolveWireModelUid`가 이미 완전한
UID에 또 접미사를 붙인다. 카탈로그가 없는 degraded 모드에서는
`gpt-5-6-sol-medium-priority-medium`이 되고, Cognition은 이를 opaque한
`permission_denied`로 거절한다 — `normalizeDevinModelId` 주석(`devin.ts:71-77`)이
경고하는 바로 그 실패 모양이다.

`max-1m` / `none-1m`은 `EFFORT_SUFFIXES`에만 있는데, 이들은 하이픈을 포함하므로
마지막 토큰만 보는 `hasEffortSuffix`로는 애초에 매칭되지 않는다. 죽은 항목이다.

## MODIFY: 집합을 하나로

`EFFORT_TOKENS`를 단일 출처로 삼고 `devin.ts`가 그것을 import한다. 두 벌을 유지하는 한
다음 접미사가 추가될 때 같은 드리프트가 반복된다.

```ts
// src/adapters/devin/live-models.ts
export const EFFORT_TOKENS = new Set([
  "low", "medium", "high", "xhigh", "max", "none", "fast", "priority", "1m",
]);

// src/adapters/devin.ts
import { EFFORT_TOKENS, collapseDevinModelUid } from "./devin/live-models.js";

function hasEffortSuffix(modelId: string): boolean {
  return collapseDevinModelUid(modelId) !== modelId;
}
```

`collapseDevinModelUid`로 위임하면 다중 접미사(`-medium-priority`)도 자동으로 맞는다.
마지막 토큰 하나만 보는 현재 구현의 한계가 사라진다.

`resolveWireModelUid`의 effort 검증(`devin.ts:110,119`)도 `EFFORT_TOKENS`를 쓴다.
`max-1m`/`none-1m`은 죽은 항목이므로 제거하되, 커밋 본문에 왜 죽었는지 남긴다.

## NEW 테스트

| 입력 | 기대 |
|---|---|
| `gpt-5-6-sol-medium-priority` | 그대로 (접미사 재부착 없음) |
| `gpt-5-6-sol-priority` | 그대로 |
| `gpt-5-6-sol` + effort `medium` | `gpt-5-6-sol-medium` (기존 동작 불변) |
| `swe-2-high` | wp1의 SWE-2 경로와 충돌 없음 |
| degraded 모드에서 `...-priority` | 이중 접미사 없음 (회귀) |

## 순서

wp1이 먼저 착지한 뒤에 간다. 둘 다 `resolveWireModelUid`를 건드리므로 순차로 처리해
충돌을 피한다.

