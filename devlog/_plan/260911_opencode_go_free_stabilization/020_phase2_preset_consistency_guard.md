# 020 — wp3: 프리셋 내부 불일치 수정과 회귀 가드

## G1 — opencode-go의 thinking budget 게이트와 사다리가 어긋난다

`registry.ts:1755`가 `thinkingBudgetModels: THINKING_BUDGET_MODELS`(6개, Neuralwatt 전용 `qwen3.5-397b`·`qwen3.6-35b` 포함)인데, 같은 프리셋의 `modelReasoningEfforts`(`1771`)는 `OPENCODE_GO_THINKING_BUDGET_MODELS`(4개)만 spread한다. Go 로스터에 397b가 등장하면 어댑터는 `thinking_budget` 경로를 타는데(`src/adapters/openai-chat.ts:1539`) 카탈로그가 광고할 사다리는 없다.

변경: `thinkingBudgetModels: OPENCODE_GO_THINKING_BUDGET_MODELS`.

수용 기준: opencode-go 레지스트리 엔트리의 `thinkingBudgetModels`가 `modelReasoningEfforts`에 사다리를 가진 id의 부분집합이다. 활성 시나리오: parity 테스트가 두 컬렉션을 직접 비교한다.

## G2 — opencode-free가 같은 게이트웨이인데 DeepSeek 처리가 비대칭이다

opencode-zen(`3016-3039`)은 `DEEPSEEK_THINKING_MODELS` + `OPENCODE_FREE_DEEPSEEK_MODELS`를 reasoning/replay/noVision에 넣는다. opencode-free(`3042-3079`)는 `-free` id만 넣는다. free는 `liveModels: true`이고 같은 `opencode.ai/zen/v1` 게이트웨이다.

판단: free 로스터에 paid id가 실제로 등장한다는 근거는 없다. 따라서 **id를 추가하지 않는다.** 대신 두 프리셋이 공유해야 할 값을 상수로 묶어, 한쪽만 갱신되는 사고를 구조적으로 막는다.

변경: zen/free가 공유하는 `OPENCODE_ZEN_DEEPSEEK_REPLAY_MODELS` 상수를 도입하고, free는 자기 로스터에 해당하는 부분집합을 그 상수에서 파생시킨다. 코드 위치는 `registry.ts:643` 부근.

수용 기준: free의 `preserveReasoningContentModels`가 zen의 것과 같은 상수에서 파생되고, free에 없는 id를 zen에 추가해도 free가 조용히 뒤처지지 않는다.

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
