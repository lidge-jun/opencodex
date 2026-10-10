# 020 — wp3: 프리셋 내부 불일치 수정과 회귀 가드

## G1 — opencode-go의 thinking budget 게이트와 사다리가 어긋난다

`registry.ts:1773`이 `thinkingBudgetModels: THINKING_BUDGET_MODELS`(6개, Neuralwatt 전용 `qwen3.5-397b`·`qwen3.6-35b` 포함)인데, 같은 프리셋의 `modelReasoningEfforts`(`1753` 부근의 spread)는 `OPENCODE_GO_THINKING_BUDGET_MODELS`(4개)만 넣는다. Go 로스터에 397b가 등장하면 어댑터는 `thinking_budget` 경로를 타는데(`src/adapters/openai-chat.ts:1539`) 카탈로그가 광고할 사다리는 없다.

실행 근거(`.tmp/preset-probe.ts`로 레지스트리를 직접 로드):

```
thinkingBudgetModels: ["qwen3.5-397b","qwen3.6-35b","qwen3.5-plus","qwen3.6-plus","qwen3.7-max","qwen3.7-plus"]
budget ids missing from ladder: ["qwen3.5-397b","qwen3.6-35b"]
```

감사 확인: 이 6원소를 equality로 고정한 테스트는 없다. `qwen3.5-397b`를 고정하는 건 neuralwatt 경로뿐이다(`tests/codex-integration/reasoning-effort.test.ts:875`, parity `356-376`).

변경: `thinkingBudgetModels: OPENCODE_GO_THINKING_BUDGET_MODELS`.

수용 기준: opencode-go 레지스트리 엔트리의 `thinkingBudgetModels`가 `modelReasoningEfforts`에 사다리를 가진 id의 부분집합이다. 활성 시나리오: parity 테스트가 두 컬렉션을 직접 비교한다.

## G2 — opencode-free가 같은 게이트웨이인데 DeepSeek 처리가 비대칭이다

opencode-zen(`3016-3039`)은 `DEEPSEEK_THINKING_MODELS` + `OPENCODE_FREE_DEEPSEEK_MODELS`를 reasoning/replay/noVision에 넣는다. opencode-free(`3042-3079`)는 `-free` id만 넣는다. free는 `liveModels: true`이고 같은 `opencode.ai/zen/v1` 게이트웨이다.

실행 근거:

```
zen  preserveReasoningContentModels: ["deepseek-v4-pro","deepseek-v4-flash","deepseek-v4-flash-free"]
free preserveReasoningContentModels: ["deepseek-v4-flash-free"]
zen  noVisionModels: [... text-only 6 ..., "deepseek-v4-pro", "deepseek-v4-flash"]
free noVisionModels: [... text-only 6 ...]
```

판단(감사 후 변경): **zen과 동일한 id를 free에도 싣는다.** 초안은 "free 로스터에 paid id 증거가 없으니 넣지 않는다"였고 grok 리뷰어도 같은 의견이었지만, 상속 모델 리뷰어가 같은 엔트리의 선례를 들어 반박했고 그쪽이 맞다:

- free는 이미 zen과 공유하는 text-only 목록 전체를 "같은 게이트웨이·같은 로스터"라는 근거로 싣는다(`registry.ts:3076`, #1043).
- 능력 표는 카탈로그 로스터를 만들지 않는다. `applyProviderConfigHints`는 이미 들어온 id만 장식하므로(`src/codex/catalog/provider-fetch.ts:766,799`), 등장하지 않는 id를 시드해도 아무것도 광고되지 않는다. 무해하고, 등장하면 정확하다.
- "상수에서 부분집합 파생"은 필터가 여전히 수작업이라 드리프트를 구조적으로 막지 못한다.

변경: free의 `modelReasoningEfforts` / `modelReasoningEffortMap` / `preserveReasoningContentModels` / `noVisionModels`가 zen과 같은 DeepSeek 집합을 쓰도록 같은 상수에서 파생시킨다.

수용 기준: free와 zen의 DeepSeek 관련 목록이 같은 집합을 갖는다. 반대 증거로, zen 전용이 아닌 free 고유 항목(text-only 무료 id)은 그대로 남는다.

## 회귀 가드

`tests/providers/provider-registry-parity.test.ts`에 추가:

1. **Go budget ⊆ ladder**: `thinkingBudgetModels`의 모든 id가 `modelReasoningEfforts`에 키를 가진다.
2. **Zen 계열 DeepSeek 대칭**: go/zen/free 각각에서, `modelReasoningEfforts`에 DeepSeek id가 있으면 `preserveReasoningContentModels`에도 있다. (#78/#950 계열 400의 구조적 방지)
3. **구조화 출력 시드 고정**: wp2가 넣은 세 프리셋의 시드 배열을 그대로 고정한다.

세 가드 모두 수정 전 코드에서 먼저 실패시켜 red-green을 확인한다. 특히 1번은 현재 코드에서 `qwen3.5-397b`로 실패해야 한다 — 실패하지 않으면 가드가 무의미하다는 뜻이므로 가드를 다시 쓴다.

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-zen-deepseek-reasoning.test.ts
bun test tests/providers/opencode-free-provider.test.ts
bun test tests/codex-integration/catalog-go-exact-efforts.test.ts
```

## 리스크

- `thinkingBudgetModels` 축소가 Go에서 397b를 실제로 쓰는 사용자에게 영향? 해당 id는 Go `modelReasoningEfforts`에 없어서 지금도 사다리가 없다. 축소는 광고되지 않던 경로를 끄는 것이다.
- parity 테스트는 배열 equality를 쓰는 곳이 있어(`73-80`) 시드 변경 시 같이 갱신해야 한다.
