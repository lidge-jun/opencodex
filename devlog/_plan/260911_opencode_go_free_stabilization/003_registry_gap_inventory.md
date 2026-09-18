# 030 — 세 프리셋의 정확-id 표 갭 인벤토리

조사 대상 `src/providers/registry.ts` (opencode-go 1695-1791, opencode-zen 3016-3039, opencode-free 3042-3079).

## 매칭 방식

| 메커니즘 | 방식 | 비교 지점 |
| --- | --- | --- |
| `noVisionModels`, `noReasoningModels`, `thinkingToggleModels`, `thinkingBudgetModels`, `preserveReasoningContentModels`, sampling 목록 | 정확 일치 + colon-family(`gpt-oss`→`gpt-oss:120b`)만 예외 | `src/types/tools.ts:241` |
| `modelReasoningEfforts`, `modelReasoningEffortMap`, `modelContextWindows`, `modelInputModalities` | 정확 own-property + colon-family + case-fold | `src/reasoning-effort.ts:115`, `src/codex/catalog/provider-fetch.ts:668,799` |
| `noStructuredOutputModels` | 정확 `Array.includes`만 (colon-family도 없음) | `src/adapters/openai-chat.ts:142,1580` |
| generated metadata | 정확 `r[0] === modelId` | `src/generated/model-metadata.ts:62` |

`isDeepseekFlashModel`(`registry.ts:718`)은 substring이지만 **시드 루프 안에서만** 호출된다(`1754`, `3024`, `3065`). 런타임 조회 경로에는 쓰이지 않는다.

## live 로스터와 시드의 비대칭

세 프리셋 모두 정적 `models:` 배열이 없고 live `/models`로 로스터를 받는다(go/zen은 `liveModels` 미지정 → 기본 ON, free는 `liveModels: true`). 새 id는 카탈로그에는 들어오지만(`tests/providers/provider-live-models.test.ts:111-146`), `applyProviderConfigHints`는 **이미 시드된 맵만** 조회한다(`provider-fetch.ts:766,799`).

결과: 시드에 없는 live id는 reasoning ladder, replay, vision sidecar, context window, wire default가 전부 빈 채로 통과한다. #2410이 한 번 수동으로 메운 것과 같은 종류의 구멍이다.

## 증명된 내부 불일치 (upstream 사실 없이도 고칠 수 있는 것)

| # | 불일치 | 앵커 | 영향 |
| --- | --- | --- | --- |
| G1 | opencode-go `thinkingBudgetModels`는 `THINKING_BUDGET_MODELS` 전체(Neuralwatt 전용 `qwen3.5-397b`, `qwen3.6-35b` 포함)인데, 같은 프리셋의 `modelReasoningEfforts`는 `OPENCODE_GO_THINKING_BUDGET_MODELS`(4개)만 spread한다 | `registry.ts:1755` vs `1771` | 해당 id가 live로 오면 budget 게이트는 켜지고 광고할 ladder는 없다 |
| G2 | opencode-free는 같은 Zen 게이트웨이인데 paid DeepSeek id(`deepseek-v4-flash`, `deepseek-v4-pro`)를 reasoning/replay/noVision 어디에도 넣지 않는다. opencode-zen은 넣는다 | `registry.ts:3042-3079` vs `3016-3039` | free 로스터에 paid id가 등장하면 replay와 sidecar가 동시에 빠진다 |
| G3 | `noStructuredOutputModels`는 `ProviderRegistryEntry` 타입(`160-353`)에 필드 자체가 없고 `providerConfigSeed`(`src/providers/derive.ts:218`)도 복사하지 않는다 | 위 | 프리셋이 이 옵트아웃을 표현할 수단이 아예 없다. 사용자 config로만 가능 |

## parity 테스트가 강제하지 않는 것

`tests/providers/provider-registry-parity.test.ts`는 알려진 id를 고정한다. 강제하지 **않는** 것:

- live discovery로 들어온 미등록 id의 메타데이터 완전성
- `noStructuredOutputModels`
- go `thinkingBudgetModels` ↔ `modelReasoningEfforts` 정합 (G1)
- zen ↔ free의 DeepSeek 처리 대칭 (G2). Zen은 DeepSeek ladder 케이스 배열에 아예 없다(`1385-1417`)

## 이 유닛이 건드리지 않는 것

`src/providers/command-code-efforts.ts` — 열린 PR #4258이 소유한다.
