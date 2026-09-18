# 020 사이클 2 — providers/registry.ts 갓파일 분해

이 문서는 `src/providers/registry.ts`(3,744줄)를 facade 보존 순수 이동으로 네 개의 리프(`registry/types.ts`, `registry/model-seeds.ts`, `registry/entries-core.ts`, `registry/entries-extended.ts`)와 잔여 facade로 나누는 계약이다. 이 파일은 로직 5.4%(203줄)와 provider 엔트리 93개(배열 본문 2,241줄), 공유 시드 상수(906줄), 타입(349줄)으로 이뤄져 있고 모듈 스코프 가변 바인딩이 0개다. 분해 후에도 소비자 52곳은 기존 facade 경로를 그대로 import하고, 배열 순서와 엔트리 객체 아이덴티티는 원본과 동일하게 유지된다. 단일 어댑터 생성 권한은 `src/adapters/registry.ts`에 그대로 두며 이 단위는 그 파일을 건드리지 않는다.

> 전달 형태 정정: 이 문서가 적은 브랜치 이름과 PR 개수는 실행되지 않았다. 다섯 파일이 한 워킹트리에서 동시에 작업돼 두 개의 PR로 수렴했다. 이동 계약과 함정 항목은 그대로 실행됐다. 실제 전달은 [090_outcome.md](./090_outcome.md) 를 보라.


로프 위치: 라운드 lane의 phase 2. 브랜치는 phase 안에서 3개로 쌓는다 — `codex/m3-l2-registry-types` → `codex/m3-l2-registry-seeds` → `codex/m3-l2-registry-entries`. 최하단 base는 phase 1(010 문서) head이고 lane bottom은 `codex/m3-l1-roadmap`(origin/dev `ce0ac617da` 기준)이다. 010 문서가 lane 명명과 skip-ci 정책을 소유하며 이 문서와 충돌하면 000/010을 따른다. 로컬 install/build/typecheck/suite는 NOT RUN이고 모든 검증은 hosted CI(레인 tip exact-head)다. 새 테스트 파일을 만들지 않으므로 `scripts/test-layout/layout.json`과 `tests/fixtures/test-layout-expected.json`은 등록하지 않는다.

## 단일 생성 권한 계약 (실측 근거)

`src/providers/registry.ts`는 어댑터 팩토리를 import하지 않는다. import 목록(1-39)은 전부 데이터·메타데이터 모듈이다: `../types`(1), `./fastwire`(2), `./kiro-models`(3), `../adapters/devin/live-models`(4), `./antigravity-models`(5), `./base-url-choices`(6-12), `../adapters/cursor/discovery`(13-21), `../adapters/cursor/catalog`(22), `./command-code-efforts`(23), `./openrouter-routing`(24), `./codebuddy-models`(25-38), `./qoder-models`(39). 엔트리의 `adapter` 필드는 `"openai-chat"`, `"anthropic"`, `"google"`, `"cursor"`, `"devin"`, `"codebuddy"`, `"command-code"`, `"openai-responses"`, `"azure-openai"`, `"mimo-free"`, `"qoder"` 같은 wire 문자열이고, 이 문자열 namespace의 유일한 구현 소유자가 `src/adapters/registry.ts`의 `ADAPTER_REGISTRY`다. 팩토리 실행은 `createRegisteredAdapter` 한 곳에서만 일어난다. 역방향 의존이 하나 있지만 순환이 아니다: `src/adapters/openai-chat.ts:6`이 `registryEntryForProviderDestination`을 조회(데이터 읽기)하며, 이 방향은 분해 후에도 facade를 향하므로 그대로 둔다. 이 단위에서 `src/adapters/registry.ts`는 NEW/MODIFY/DELETE 어느 쪽도 아니다.

## 범위와 비범위

범위는 본문을 `src/providers/registry/` 아래로 옮기고 원래 경로를 re-export+조회 facade로 남기는 일이다. 엔트리 값, 모델 목록, 컨텍스트 윈도우, effort ladder, note 문장, 배열 순서는 한 글자도 바꾸지 않는다. 소비자 import 경로 변경은 없다.

비범위: `src/adapters/registry.ts`, `src/providers/derive.ts`(`providerConfigSeed` 소유), `src/providers/fastwire.ts`, 엔트리 추가/삭제/수정, 시드 값 변경, 주석 다듬기, `src/integrations/registry.ts`(동명 이종 모듈), `src/lab/public/registry.ts`(동명 이종 모듈, `export * from "./registry"`는 이 파일을 가리킨다).

디렉터리 공존: `registry.ts`와 `registry/`는 확장자가 달라 macOS/Linux에서 공존한다(라운드 2의 `quota.ts`+`quota/` 선례). `src/providers/` 아래에 `registry` 이름의 충돌자는 없다.

## 현재 지도 (3,744줄, HEAD ce0ac617da 기준)

| 구간 | 행 | 줄 수 | 목적지 |
|---|---|---|---|
| import | 1-39 | 39 | 각 리프가 필요한 것만 재구성. facade는 `./fastwire`와 리프 import만 |
| (빈 줄) | 40 | 1 | — |
| 타입 전체 | 41-389 | 349 | `registry/types.ts` (PR 1) |
| (빈 줄) | 390 | 1 | — |
| 공유 시드 상수+주석 | 391-1296 | 906 | `registry/model-seeds.ts` (PR 2) |
| (빈 줄) | 1297 | 1 | — |
| 배열 오프너 | 1298 | 1 | facade concat 선언으로 대체 (PR 3) |
| 엔트리 전반 (openai→vultr, 38개) | 1299-2434 | 1,136 | `registry/entries-core.ts` (PR 3) |
| 엔트리 후반 (baseten→codebuddy-cn, 55개) | 2435-3539 | 1,105 | `registry/entries-extended.ts` (PR 3) |
| 배열 클로저 `];` | 3540 | 1 | 각 리프 오프너/클로저로 대체 (PR 3) |
| (빈 줄) | 3541 | 1 | — |
| `providerRegistryFastWireError` | 3542-3547 | 6 | facade 잔여 |
| fastwire 검증 루프 (모듈 스코프 실행문) | 3548-3551 | 4 | facade 잔여 (concat 뒤) |
| `getProviderRegistryEntry`~`effectiveGoogleMode` | 3552-3744 | 193 | facade 잔여 |

93개 엔트리 중 70개는 다중 행(4칸 들여쓰기 `id:`), 23개는 한 행 엔트리(`  { id: "groq", ... }`)다. 한 행 엔트리의 첫 행: groq 2160, google-vertex 2182, google-antigravity 2190, azure-openai 2191, ollama 2192, vllm 2193, lm-studio 2194, cerebras 2300, together 2685, fireworks 2686, huggingface 2709, venice 2733, nanogpt 2924, synthetic 2925, qianfan 3041, alibaba 3043, parallel 3117, mistral 3178, vercel-ai-gateway 3264, xiaomi 3309, kilo 3328, cloudflare-ai-gateway 3377, gitlab-duo 3444. 이동 시 한 행 엔트리는 그 행째로 옮겨야 한다(재포장 금지).

## facade export 인벤토리 (원본과 동일해야 하는 23개)

타입 11: `ProviderAuthKind`, `MetadataModelIdNormalize`, `InboundWire`, `ModelWireDefault`, `ResponsesTerminalRepairPolicy`, `ProviderModelDiscoveryScalar`, `ProviderModelDiscoveryPredicate`, `ProviderModelDiscoveryFilter`, `ProviderModelDiscoverySpec`, `ProviderRegistryEntry`, `ProviderConfigSeed`.

값 12: `PROVIDER_REGISTRY`, `providerRegistryFastWireError`, `getProviderRegistryEntry`, `mergeRegistryStaticHeaders`, `registryModelServiceTierCapabilityApplies`, `providerMatchesRegistryTransport`, `registryEntryForProviderDestination`, `providerModelWireDefault`, `providerModelResponsesUpstreamStreaming`, `providerModelResponsesTerminalRepair`, `providerCodexAccountMode`, `effectiveGoogleMode`.

비공개(export 금지): 시드 상수 약 130개(391-1296 전체), `normalizedProviderEndpoint`(3598 부근), 검증 루프. 시드는 원래 모듈 비공개였으므로 facade가 re-export하면 공개 면적이 늘어난다 — 리프에서만 export하고 facade는 re-export하지 않는다.

## 상태 소유권

모듈 스코프 가변 바인딩은 0개다. top-level은 `const`와 `function`뿐이고 유일한 모듈 스코프 실행문은 fastwire 검증 루프(3548-3551)다. 상태의 실체는 두 가지다.

1. **배열 싱글턴**: `PROVIDER_REGISTRY`는 프로세스당 하나이고 조립 지점은 facade 유일이어야 한다. 리프는 조각(`PROVIDER_REGISTRY_CORE`, `PROVIDER_REGISTRY_EXTENDED`)만 export하고, concat과 검증 루프는 facade에 둔다. 조회 함수 10개(3542-3744)가 조립된 배열을 필요로 하므로 전부 facade에 잔여시킨다 — `registry/lookup.ts`를 만들어 facade의 배열을 import하게 하면 리프→facade→리프 사이클이 생긴다(라운드 2에서 `transientDetourAccount`를 잔여시킨 동일 판단). 인자로 배열을 넘겨 재조립하는 함수를 만들지 않는다.
2. **엔트리 객체 아이덴티티**: 엔트리 객체는 리프가 소유하고 facade는 참조를 재배포할 뿐이다. `[...core, ...extended]`는 원소 참조를 보존한다. 소비자(`derive.ts`의 `providerConfigSeed`)는 엔트리를 읽기 템플릿으로만 쓴다. 런타임 소비자가 엔트리를 변이하지 않는다는 보장은 없다 — 아래 함정 6의 테스트가 실제로 변이하므로 아이덴티티 보존이 완료 조건이다.

## 함정 (금지 분할)

1. **리프가 심볼을 정의하고 export하지 않음** — 라운드 2에서 CI가 잡은 결함 (a). `model-seeds.ts`는 옮긴 모든 top-level const에 `export`를 붙여야 하고, 두 엔트리 리프는 자신이 참조하는 시드 이름을 전부 import해야 한다. `export` 하나 빠지면 hosted CI typecheck 적색이다.
2. **facade가 re-export만 하고 로컬 import 누락** — 결함 (b). facade의 함수 본문은 `PROVIDER_REGISTRY`(concat 결과), `ProviderRegistryEntry`, `InboundWire`, `ResponsesTerminalRepairPolicy`, `fastWireDeclarationError`를 로컬로 import해야 한다. `export type { ... } from "./registry/types"`만 쓰면 함수 본문의 타입 참조가 해결되지 않는다. re-export 목록은 위 인벤토리 23개와 한 개도 달라서는 안 된다.
3. **타입을 잘못된 모듈에서 import** — 결함 (c). 새 리프끼리(`model-seeds`→, `entries-*`→) 타입은 반드시 `./types`에서 가져온다. 리프가 facade(`../registry`)에서 타입을 가져오는 순간 리프→facade→리프 런타임 사이클 위험이 생긴다. 기존 소비자는 반대로 facade 경로를 유지한다: `src/providers/fastwire.ts:10`의 `import type { InboundWire, ModelWireDefault, ProviderAuthKind } from "./registry"`는 type-only라 런타임에 소거되므로 facade가 `./fastwire`를 값 import해도 사이클이 아니다. 이 import를 `./registry/types`로 고치는 churn은 하지 않는다.
4. **정의가 통째로 사라지고 호출부만 남음** — 결함 (d). 검증 루프(3548-3551)는 concat 선언 뒤에 남고 `providerRegistryFastWireError` 정의(3542-3547)를 호출한다. 시드의 파생 const는 원본과 함께 움직여야 한다: `ZAI_GLM_5X_MODELS = [...ZAI_GLM_53_MODELS, ...ZAI_GLM_52_MODELS]`(448), `ZAI_GLM_5X_SIDECAR_VISION_MODELS = ZAI_GLM_5X_MODELS.filter(...)`(463), `KIMI_CODING_MODELS = [...KIMI_CODING_K3_MODELS, ...KIMI_LEGACY_API_MODELS, "kimi-for-coding"]`(959), `CLINE_PASS_TEXT_ONLY_MODELS`(1293) 등. 391-1296을 한 리프에 옮기면 파생 관계가 전부 파일 내부에 닫히므로, 시드를 벤더별로 다시 쪼개는 것도 금지한다.
5. **한 단계 깊어진 디렉터리에서 `../x` 오해석** — 결함 (e). `src/providers/registry/leaf.ts`에서 ``../types``는 `src/providers/types`(존재하지 않음)로 해석된다. 이동분의 상대 import는 전부 한 단계를 더 붙인다: `../types`→`../../types`, `./kiro-models`→`../kiro-models`, `../adapters/devin/live-models`→`../../adapters/devin/live-models`, `./base-url-choices`→`../base-url-choices`, `./codebuddy-models`→`../codebuddy-models`, `./qoder-models`→`../qoder-models`, `../adapters/cursor/discovery`→`../../adapters/cursor/discovery`, `../adapters/cursor/catalog`→`../../adapters/cursor/catalog`. facade 자신(`src/providers/registry.ts`)은 깊이가 변하지 않으므로 `./fastwire` 표기를 유지한다.
6. **엔트리를 빌더/Object.freeze로 바꾸지 않는다.** 라이브 엔트리를 in-place 변이 후 복원하는 테스트가 네 곳 있다. `tests/providers/provider-registry-parity.test.ts:270-297`(zai `modelMaxInputTokens` 대입, finally에서 delete/복원), `:300-336`(`defaultMaxOutputTokens`/`modelMaxOutputTokens` 대입+복원), `:1161-1196`(`directSeed.baseUrl = "https://mutated.example.test"` 후 재derive로 오염 없음을 확인), `tests/helpers/provider-registry-discovery.ts:14-32`(`entry.modelDiscovery`/`preserveCustomDestination` 대입 후 delete/복원 — 이 헬퍼는 여러 테스트 파일이 공유한다). `Object.freeze`는 strict 모드에서 대입·delete가 TypeError로 터지고, 엔트리를 사본으로 바꾸면(빌더/팩토리/clone) 변이가 검증 대상에 도달하지 않아 테스트가 조용히 무의미해진다. 리프 배열 export → facade spread concat이 유일하게 허용되는 형태다.
7. **adapter wire별 분할 금지.** 배열은 prefix+suffix로 정확히 한 번 쪼갠다(1299-2434 | 2435-3539). wire(`openai-chat`/`anthropic`/`google`)나 벤더로 재그룹하면 엔트리 순서가 바뀐다. 순서는 관측된 계약이다: parity 테스트의 featured 목록 순서(1165-1171), `presets.at(-1)?.id === "custom"`(1178), `EXPECTED_KEY_PROVIDER_IDS`(41-47)과 `deriveKeyLoginMap()` 키 순서 일치 단언. prefix/suffix concat은 이 순서를 비트 단위로 보존한다.
8. **순환 import 금지.** 허용되는 의존 방향은 `types` ← `model-seeds` ← `entries-core`/`entries-extended` ← facade, facade → `../fastwire`(값), facade → `../../types`(타입)뿐이다. `registry/lookup.ts` 신설 금지(함정 1의 배열 재조립 문제), 리프끼리 상호 import 금지, 리프가 facade를 import하는 것 금지.
9. **신규 top-level `let`/`Map` 금지.** 가변 바인딩 0은 이 파일의 실측된 성격이며 분해 후에도 유지한다.
10. **`src/adapters/registry.ts` 무수정.** 생성 권한 이동, wire 문자열 정렬, `AdapterWire` 타입 재사용 모두 금지. 이 단위는 문자열 namespace 계약을 참조만 한다.

## 소비자 인벤토리 (전부 무수정 — facade 경로 유지)

src 41곳: `src/config.ts:95-101`, `src/router.ts:17-22`, `src/routing/capability.ts:16`, `src/routing/compatibility/behavior.ts:4`, `src/routing/compatibility/subject.ts:2`(type), `src/images/plan.ts:6`, `src/claude/desktop-discovery-inputs.ts:15`, `src/web-search/gemini-executor.ts:20`, `src/lib/destination-policy.ts:3`, `src/adapters/openai-chat.ts:6`, `src/oauth/index.ts:49`, `src/oauth/token-guardian.ts:31`, `src/codex/convergence.ts:83`, `src/codex/convergence-types.ts:17`(type), `src/codex/subagent-model-fallback.ts:32`, `src/codex/quota-auto-refresh.ts:5`, `src/cli/account-api.ts:10`, `src/providers/derive.ts:3-8`, `src/providers/fastwire.ts:10`(type), `src/providers/key-store.ts:4`(type), `src/providers/model-discovery.ts:18-22`(type), `src/providers/service-tier.ts:5-10`, `src/providers/static-model-discovery.ts:2-6`, `src/providers/default-aliases.ts:2`, `src/providers/openai-virtual-models.ts:1`, `src/providers/initial-model-selection.ts:3`, `src/providers/openai-sidecar.ts:23`, `src/providers/opencode-zen-rate-limit.ts:17`, `src/providers/opencode-go-transport.ts:3`, `src/providers/quota-routing-cache.ts:5`, `src/providers/alibaba-region-migration.ts:4`, `src/providers/model-rename-migration.ts:19`, `src/providers/xai-responses-opt-in.ts:2`, `src/providers/zai-responses-migration.ts:1`, `src/providers/stale-context-window-migration.ts:18`, `src/codex/catalog/{aggregation:14, effort:14, provider-fetch:45, metadata:15, parsing:14, retained-sync:10}`.

tests 10곳: `tests/providers/provider-registry-parity.test.ts:18`, `tests/helpers/provider-registry-discovery.ts:2`, `tests/routing/fastwire-policy.test.ts:15`, `tests/service/service-tier-capability.test.ts:14`, `tests/vision/vision-sidecar-e2e.test.ts:7`, `tests/routing/routing-capability-model-matching.test.ts:12`, `tests/config/model-pinned-effort-config.test.ts:13`, `tests/adapters/openai/openai-api-virtual-models.test.ts:14`, `tests/adapters/openai/openai-provider-option.test.ts:11`, `tests/adapters/openai/openai-provider-option-e2e.test.ts:261`(동적 import).

scripts 1곳: `scripts/openai-provider-option-runtime-child.ts:152`(`import("../src/providers/registry")` 동적 import — 자식 프로세스에서 facade를 로드하므로 검증 루프가 facade에 남아야 하는 이유이기도 하다).

## PR 1 — registry/types.ts

목적: 타입 소유를 리프로 옮기고 facade가 type re-export로 계승하게 한다. 이후 모든 리프의 타입 import 대상이 된다.

Write set:

- NEW `src/providers/registry/types.ts` 예상 365줄. 원본 이동 행: **41-389**(빈 줄·주석 포함 전부).
- MODIFY `src/providers/registry.ts` — 41-389 삭제, `export type { 11개 나열 } from "./registry/types"` 추가, facade 본문이 아직 쓰는 타입(`ProviderRegistryEntry`, `ProviderModelDiscoverySpec`, `InboundWire`, `ResponsesTerminalRepairPolicy`)을 `import type ... from "./registry/types"`로 확보.

types.ts가 추가로 필요로 하는 import: `import type { CodexAccountMode, FastWire, OcxProviderConfig } from "../../types"`(원본 1행, 경로 보정), `import type { ProviderBaseUrlChoice } from "../base-url-choices"`(원본 6행, `baseUrlChoices` 174행에서 사용). 함정 5의 경로 보정이 이 PR부터 적용된다.

회귀: `tests/providers/provider-registry-parity.test.ts`, `tests/routing/fastwire-policy.test.ts`, `tests/service/service-tier-capability.test.ts`, hosted CI typecheck(src 소비자 41곳의 타입 해석).

structure 수정 없음. layout 등록 없음. 완료 조건: facade에 타입 선언 몸체가 남지 않고 23개 export가 전부 유효하다.

## PR 2 — registry/model-seeds.ts

목적: 벤더 공유 시드 상수를 하나의 데이터 리프로 옮겨 파생 관계(`ZAI_GLM_5X_MODELS` 등)가 파일 내부에 닫히게 한다.

Write set:

- NEW `src/providers/registry/model-seeds.ts` 예상 915줄. 원본 이동 행: **391-1296**(선행 주석 블록 391-396 포함, 전부).
- MODIFY `src/providers/registry.ts` — 391-1296 삭제, inline 엔트리(1299-3539, PR 3까지 facade에 잔류)가 참조하는 시드 이름을 `import { ... } from "./registry/model-seeds"`로 확보.

이동 규칙: 모든 top-level const에 `export`를 붙인다(이름·값·주석 그대로). 함수 3개도 그대로 export한다: `isDeepseekFlashModel`(814), `deepseekThinkingEffortsFor`(816), `deepseekReasoningMapFor`(818). 유일한 타입 import는 `import type { ProviderModelDiscoverySpec } from "./types"`(`ORCAROUTER_MODEL_DISCOVERY` 1233행). `Set`을 만드는 `CLINE_PASS_IMAGE_MODELS`(1279)도 그대로다. facade는 시드를 re-export하지 않는다(원래 비공개). tsconfig에 noUnusedLocals가 없어 미사용 import가 적색이 되지는 않지만, import 목록은 inline 엔트리가 실제 참조하는 이름으로 한정한다(`COMMAND_CODE_MODEL_REASONING_EFFORTS`처럼 1560·2483 양쪽에서 쓰이는 이름 포함).

시드 패밀리 지도(참고용, 행은 원본): ANTHROPIC 391-431, ZAI GLM 443-503, MINIMAX 504-523, OPENAI GPT5.6 524-552, META MUSE 553-577, OPENAI DAYBREAK 578-597, OPENROUTER/XAI 598-623, THINKING_TOGGLE+OPENCODE_GO 624-644, ZHIPU+THINKING_BUDGET 645-672, DEEPSEEK 673-699·791-823, COMMAND_CODE 700-738, OPENCODE_FREE/ZEN 739-790, ALIBABA 824-860·929-953, TENCENT 861-875, VOLCENGINE 876-928, KIMI 954-993·1072-1077, NVIDIA NIM 994-1071, NEURALWATT 1078-1091, BASETEN 1092-1132, DIGITALOCEAN 1133-1162, SCALEWAY 1163-1181, UMANS 1182-1216, CLINE_PASS+ORCAROUTER 1217-1296.

회귀: `tests/providers/provider-registry-parity.test.ts` 전체(엔트리 메타데이터 단언이 시드 값을 간접 검증한다), hosted CI typecheck.

structure 수정 없음. layout 등록 없음.

## PR 3 — entries-core/entries-extended + facade 확정 + 동반 수정 전부

목적: 배열 본문을 두 조각으로 옮겨 facade를 조회 계약으로 확정하고, 이동으로 이름이 바뀌는 모든 문서·기준선을 같은 PR에서 고친다.

Write set:

- NEW `src/providers/registry/entries-core.ts` 예상 1,150줄. 원본 이동 행: **1299-2434**(openai 1300 → vultr 2410-2434, 38개 엔트리).
- NEW `src/providers/registry/entries-extended.ts` 예상 1,120줄. 원본 이동 행: **2435-3539**(baseten 2435-2460 → codebuddy-cn 3520-3539, 55개 엔트리).
- MODIFY `src/providers/registry.ts` — 1298-3540(오프너·엔트리 본문·클로저)을 삭제하고 다음으로 대체:

```ts
import { PROVIDER_REGISTRY_CORE } from "./registry/entries-core";
import { PROVIDER_REGISTRY_EXTENDED } from "./registry/entries-extended";

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  ...PROVIDER_REGISTRY_CORE,
  ...PROVIDER_REGISTRY_EXTENDED,
];
```

각 리프는 `export const PROVIDER_REGISTRY_CORE: readonly ProviderRegistryEntry[] = [` / `export const PROVIDER_REGISTRY_EXTENDED: readonly ProviderRegistryEntry[] = [` 오프너로 원본 1298의 선언을 계승하고 `];`로 닫는다. 리프 import: `./types`(`ProviderRegistryEntry`), `./model-seeds`(자기 엔트리가 참조하는 시드 전부), 벤더 모듈 — core는 `../../types`가 필요한 필드가 없으면 불요, `../kiro-models`, `../../adapters/devin/live-models`, `../antigravity-models`, `../../adapters/cursor/discovery`, `../../adapters/cursor/catalog`, `../command-code-efforts`, `../openrouter-routing`; extended는 `../base-url-choices`(상수 8개 — 사용행 2693-3080 전부 후반), `../codebuddy-models`, `../qoder-models`, `../command-code-efforts`(2483·2489). 두 리프가 같은 벤더 모듈을 import해도 사이클이 아니다.

- MODIFY `structure/runtime.md:209-210` — ``src/providers/registry.ts`` 가 opencode-go live `deepseek-v4.1-flash` 창을 할당한다는 문장의 백틱을 ``src/providers/registry/entries-core.ts``로.
- MODIFY `structure/providers/xai-grok.md:96-97` — 동일 문장의 백틱을 ``src/providers/registry/entries-core.ts``로.
- MODIFY `tests/fixtures/file-size-baseline.json:26` — ``"src/providers/registry.ts": 3744`` 항목을 **삭제**한다. 라운드 2 이후 `src/providers/quota.ts` 항목이 같은 방식으로 제거된 것이 현재 기준선의 선례다. 래칫 판정은 `scripts/file-size-ratchet.ts:92-94`의 `isOffender` = NEW_OVERSIZED|GREW뿐이라 삭제·SHRANK는 통과다. 새 리프 4개는 1,999줄 미만이므로 NEW_OK로 기준선에 추가하지 않는다(`updateBaseline`도 threshold 미만 신규 파일을 추가하지 않는다).
- MODIFY docs-site 8개 파일(아래 절) — 엔트리 추가 위치를 새 리프로 안내.

무수정 근거를 남길 것: `structure/runtime.md:174`(표 행 "Canonical provider presets" — facade가 여전히 canonical import 경로이므로 갱신 불요), `structure/transports/inventory.md:34`(Discovery and quota 표 — facade 표면 참조이므로 갱신 불요, PR 본문에 이 판단을 명시).

회귀: `tests/providers/provider-registry-parity.test.ts`(순서 고정: featured 1165-1171, presets 1172-1181, `EXPECTED_KEY_PROVIDER_IDS` 41-47, 변이 3곳), `tests/adapters/openai/openai-provider-option.test.ts`(INV-OPENAI-01 홀더, 1행 코멘트), `tests/adapters/openai/openai-provider-option-e2e.test.ts:261`(동적 import), `tests/routing/fastwire-policy.test.ts`(검증 루프 경유), `tests/vision/vision-sidecar-e2e.test.ts`, `tests/routing/routing-capability-model-matching.test.ts`, `tests/adapters/openai/openai-api-virtual-models.test.ts`, `tests/config/model-pinned-effort-config.test.ts`, `tests/service/service-tier-capability.test.ts`, `tests/routing/routing-compatibility-model-matching.test.ts`(15행 주석의 ollama-cloud 시나리오).

이 PR 후 facade 예상 **~250줄**(import/re-export ~30 + concat ~6 + 함수·검증 루프 203). 1,999 이하.

## docs-site "Adding a provider" 언어별 파일 (전수 목록)

`src/providers/registry.ts`를 canonical 경로로 명시하는 "Adding a provider to the catalog" 절은 8개 로케일에 있다. 분해 후 이 안내를 따르는 기여자는 엔트리를 facade에 추가할 수 없게 되므로, PR 3에서 8개 모두의 경로 지시를 새 리프(`src/providers/registry/entries-core.ts` 또는 `entries-extended.ts`, 순서 유지 위해 뒤에 추가)로 고쳐야 한다. 영어 원본을 고치고 나머지 7개를 같은 의미로 동기화한다(번역 상충 금지 — 리뷰 지침).

| 파일 | 명시 행 | 절 시작 |
|---|---|---|
| `docs-site/src/content/docs/contributing.md` | 175 | 173 |
| `docs-site/src/content/docs/ko/contributing.md` | 125 | — |
| `docs-site/src/content/docs/ja/contributing.md` | 126 | — |
| `docs-site/src/content/docs/zh-cn/contributing.md` | 116 | — |
| `docs-site/src/content/docs/zh-tw/contributing.md` | 134 | — |
| `docs-site/src/content/docs/ru/contributing.md` | 127 | — |
| `docs-site/src/content/docs/fr/contributing.md` | 163 | — |
| `docs-site/src/content/docs/tr/contributing.md` | 189 | — |

`docs-site/src/content/docs/contributing/`와 로케일 하위의 다른 문서는 이 경로를 명시하지 않는다(실측).

## 오라클·structure·INV·layout 동반 수정 의무

- **본문을 텍스트로 읽는 소스 오라클: 0건.** `tests/adapters/openai/openai-provider-option.test.ts:114`의 `readFileSync`는 `openai-tiers-destination.ts`를 읽고, `tests/routing/routing-compatibility-model-matching.test.ts:15`는 주석이다. 유일한 "본문 수치" 오라클은 file-size ratchet이며 그 동반 수정(baseline 26행 삭제)은 PR 3 write set이다. 새 텍스트 오라클을 만들지 않는다.
- **INV 승계:** `INV-OPENAI-01`(`structure/overview.md:89-91`, enforcement ``tests/adapters/openai/openai-provider-option.test.ts`` 1행 코멘트)는 `openai`/`openai-apikey` 엔트리가 `entries-core.ts`로 옮겨가도 제품 불변식이 동일하다. 데이터 승계 모듈은 `src/providers/registry/entries-core.ts`, enforcement 모듈은 현행 유지(facade 경유). 구조 게이트 승계는 `tests/ci-workflows/structure-ssot.test.ts`와 `bun run structure:check`(hosted CI). 파일 크기 게이트 승계는 `tests/ci-workflows/file-size-ratchet.test.ts`.
- **layout 등록: 없음.** 신규 테스트 파일이 없으므로 `scripts/test-layout/layout.json`과 `tests/fixtures/test-layout-expected.json`은 건드리지 않는다(라운드 2와 동일).
- **structure/manifest.json: 무수정.** `src/providers/`는 이미 runtime.md가 documents하는 영역이고 새 top-level src area가 아니므로 `bun run structure:index` 불요.

## 예상 줄 수 총괄

| 파일 | 판정 | 예상 줄 수 |
|---|---|---|
| `src/providers/registry.ts` | MODIFY | 3,744 → ~3,410 (PR 1) → ~2,550 (PR 2) → **~250** (PR 3) |
| `src/providers/registry/types.ts` | NEW | ~365 |
| `src/providers/registry/model-seeds.ts` | NEW | ~915 |
| `src/providers/registry/entries-core.ts` | NEW | ~1,150 |
| `src/providers/registry/entries-extended.ts` | NEW | ~1,120 |

신규 4파일 전부 1,999 이하. DELETE 없음.

## 완료 조건

- `src/providers/registry.ts` ≤ 1,999(예상 ~250), 신규 리프 전부 ≤ 1,999
- PROVIDER_REGISTRY 원소 순서가 원본과 동일(concat core→extended), 엔트리 객체 아이덴티티 보존(변이 테스트 4곳 녹색)
- facade export 23개(타입 11+값 12) 전부 유효, 소비자 52곳(src 41+tests 10+scripts 1) import 무수정
- 모듈 스코프 가변 바인딩 0 유지, 검증 루프가 facade concat 뒤에서 실행
- `src/adapters/registry.ts` diff 0
- structure 백틱 2곳 갱신+2곳 무수정 근거 명시, structure:check hosted CI 녹색
- docs-site 8개 로케일 갱신, 영어 원본과 번역 상충 없음
- file-size-baseline.json에서 registry.ts 항목 삭제
- layout.json/test-layout-expected.json 무수정
- 로컬 스위트 NOT RUN. 레인 tip exact-head hosted CI 녹색 후 이 단위 D에서 결과 기록
