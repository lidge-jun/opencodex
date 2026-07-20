# 002 — jawcode 가격 기반 비용($) + toks/$ 열 타당성 조사

## 결론

**조건부 가능**이다. jawcode의 정적 가격표와 OpenCodex 요청 로그에는 계산에 필요한
provider/model/usage가 있으며, 로그에는 combo의 attempt별 identity와 usage도 보존된다.
단, 다음 두 조건을 구현 전 계약으로 고정해야 한다.

1. `OcxUsage.inputTokens`는 캐시 읽기·쓰기를 포함하는 총 prompt 토큰이다. jawcode의
   원식을 이 값에 그대로 적용한 뒤 cacheRead/cacheWrite를 다시 더하면 캐시 토큰을
   이중과금한다. 아래의 **정규화 변환식**을 전용 helper로 구현해야 한다.
2. 가격 키는 화면에 보이는 `resolvedModel`도, 호출자가 보낸 `requestedModel`도 아닌,
   **로그의 canonical `provider` + canonical `model`**이어야 한다. provider는
   `deriveJawcodeAliases()`로 jawcode bundle으로 바꾸고 model은 native ID로 exact lookup한다.
   현재 정적 registry 계측의 exact 커버리지가 62.86%뿐이므로, 미매칭을 `$0`으로
   보이지 말고 `—`로 보이는 fail-closed 정책이 필수다.

속도(tok/s)는 별도 001 조사 범위이며, 여기서는 이 가격 열의 분모/분자 정책에만 한 줄로
연결한다.

## 1. jawcode 가격 데이터와 실제 계산 단위

### 가격표 구조

`jawcode/packages/ai/src/models.json`의 각 모델은 `cost` 객체에
`input`, `output`, `cacheRead`, `cacheWrite` 네 숫자를 가진다. 예컨대 첫 모델도 네 값이
모두 `0`으로 명시되어 있다
([`../jawcode/packages/ai/src/models.json:2-20`](../../../../jawcode/packages/ai/src/models.json:2)).
가격 타입도 동일한 네 필드를 요구한다
([`../jawcode/packages/stats/src/db.ts:21-23`](../../../../jawcode/packages/stats/src/db.ts:21)).

단위는 USD/token이 아니라 **USD / 1,000,000 tokens**이다. 이는 추정이 아니라 비용 계산의
권위 소스가 각 단가를 `1_000_000`으로 나눈 뒤 토큰 수를 곱하는 것으로 검증된다:

```ts
const input = (cost.input / 1_000_000) * tokens.input;
const output = (cost.output / 1_000_000) * tokens.output;
const cacheRead = (cost.cacheRead / 1_000_000) * tokens.cacheRead;
const cacheWrite = (cost.cacheWrite / 1_000_000) * tokens.cacheWrite;
total: input + output + cacheRead + cacheWrite;
```

위 코드는 jawcode의 실제 `calculateCatalogCost()`
([`../jawcode/packages/stats/src/db.ts:214-228`](../../../../jawcode/packages/stats/src/db.ts:214))의
내용이다. 여기서 `CostTokens`는 `Usage`의 `input/output/cacheRead/cacheWrite` 네 필드만
고른 타입이다 ([`../jawcode/packages/stats/src/db.ts:21-23`](../../../../jawcode/packages/stats/src/db.ts:21)).
`getCatalogCost()`는 all-zero 단가를 billable price로 취급하지 않아 `null`을 돌려준다
([`../jawcode/packages/stats/src/db.ts:189-211`](../../../../jawcode/packages/stats/src/db.ts:189)).

반대로 `aggregator.ts`의 `getDashboardStats()`는 `getOverallStats`, `getStatsByModel`,
시계열 등을 조합해 반환할 뿐 가격을 산정하지 않는 집계 facade다
([`../jawcode/packages/stats/src/aggregator.ts:368-389`](../../../../jawcode/packages/stats/src/aggregator.ts:368)).
따라서 단위/공식의 근거로 aggregator를 쓰면 안 된다.

## 2. HIGH — 캐시 이중과금 없는 `OcxUsage → CostTokens` 변환

### OpenCodex canonical 의미

OpenCodex는 `inputTokens`를 cache read/write를 **포함한 총 prompt**로 고정했고,
`cachedInputTokens`는 read만의 부분집합, `cacheReadInputTokens`와
`cacheCreationInputTokens`는 read/write 상세라고 문서화한다
([`src/types.ts:227-244`](../../../../src/types.ts:227)). `totalTokens`도
`inputTokens + outputTokens`이며 cache detail을 더하면 안 된다
([`src/types.ts:229-234`](../../../../src/types.ts:229)). GUI의 기존 토큰 합계도 같은 이유로
`input + output`에 cache를 재가산하지 않는다
([`gui/src/pages/Logs.tsx:62-81`](../../../../gui/src/pages/Logs.tsx:62)).

그러나 jawcode 원식은 `tokens.input` 전체에 input 단가를 곱하고 cache 단가를 별도로 더한다.
그러므로 jawcode의 `tokens.input`에 OpenCodex의 inclusive `inputTokens`를 넣어서는 안 된다.

### 확정 변환식

모든 계열의 최종 jawcode 인자는 다음으로 정규화한다. `I=usage.inputTokens`,
`O=usage.outputTokens`, `R=cacheRead`, `W=cacheWrite`라 두고, 오류/legacy row 방어를 위해
`U=max(0, I-R-W)`라 한다.

```text
CostTokens.input      = U                    // 비캐시 prompt 토큰
CostTokens.cacheRead  = R
CostTokens.cacheWrite = W
CostTokens.output     = O

USD = (inputRate*U + cacheReadRate*R + cacheWriteRate*W + outputRate*O) / 1_000_000
```

`R + W > I` 같은 불가능한 로그는 clamp해서 그럴듯한 금액을 만들지 말고 **미확인/—**으로
처리하는 편이 낫다. `U`의 `max`는 계산 helper의 수학적 안전장치일 뿐, 품질 상태를
`reported`로 승격하는 근거가 아니다.

| 제공자 usage 계열 | OpenCodex에 들어오는 값의 실증 | 변환 |
| --- | --- | --- |
| OpenAI형 | Chat adapter는 `prompt_tokens → inputTokens`, `prompt_tokens_details.cached_tokens → cachedInputTokens`로 저장한다. 즉 cached는 input의 부분집합이다 ([`src/adapters/openai-chat.ts:423-432`](../../../../src/adapters/openai-chat.ts:423)). | `R=cacheReadInputTokens ?? cachedInputTokens ?? 0`, `W=cacheCreationInputTokens ?? 0`, `input=I-R-W`. 일반 OpenAI 응답에 write가 없으면 0이다. |
| Anthropic형 | 원본 Anthropic `input_tokens`는 cache read/write를 **제외**한다. adapter가 `input_tokens + read + write`로 `inputTokens`를 만드는 것을 직접 확인했다 ([`src/adapters/anthropic.ts:292-307`](../../../../src/adapters/anthropic.ts:292)). read는 `cachedInputTokens`와 `cacheReadInputTokens` 양쪽에, write는 `cacheCreationInputTokens`에 저장된다 ([`src/adapters/anthropic.ts:300-305`](../../../../src/adapters/anthropic.ts:300)). | `R=cacheReadInputTokens` (동일한 read의 `cachedInputTokens`를 재가산 금지), `W=cacheCreationInputTokens`, `input=I-R-W`, 즉 원본 `input_tokens`로 복원된다. |

캐시 상세가 하나도 없으면 `R=W=0`으로 두고 `input=I`로 계산할 수 있다. 다만 이는
실제로 캐시가 없었다는 증명이 아니라 **상세 미보고**일 수 있으므로, 정확 금액 정책은
`usageStatus === "reported"` 및 유효한 cost match일 때만 표시하고, provider가 cache 가격을
제공하면서 캐시 상세이 없는 경우는 tooltip에 “cache breakdown not reported”를 남기는 것이
정직하다. `estimated` usage는 최종 로그에서도 명시적으로 추정 상태가 된다
([`src/usage/log.ts:63-81`](../../../../src/usage/log.ts:63)).

## 3. HIGH — 가격 모델 ID 매칭 규칙과 커버리지

### 사용할 로그 필드

정규 요청에서 `requestedModel`은 route 전 클라이언트 selector이고
([`src/server/responses.ts:781-784`](../../../../src/server/responses.ts:781)), route 뒤
`logCtx.model = route.modelId`, `logCtx.provider = route.providerName`가 된다
([`src/server/responses.ts:814-825`](../../../../src/server/responses.ts:814)). 최종 로그도 combo가
아닌 경우 이 `model/provider`를 기록한다
([`src/server/request-log.ts:442-466`](../../../../src/server/request-log.ts:442)). 따라서 price key의
정답은 다음이다.

```text
jawcodeProvider = deriveJawcodeAliases()[entry.provider]
jawcodeModelId  = entry.model                 // native canonical ID
price = catalog[jawcodeProvider]?.get(jawcodeModelId)  // exact
```

`requestedModel`은 alias/namespace/legacy selector일 수 있어 금지한다. `resolvedModel`도
업스트림 응답 wire ID이며, OpenAI virtual model의 경우 log `model`은 선택 alias,
`resolvedModel`은 wire base ID로 의도적으로 갈라진다
([`src/providers/openai-virtual-models.ts:52-68`](../../../../src/providers/openai-virtual-models.ts:52)).
가격을 wire ID에 붙일 수 있다는 별도 매핑이 없는 한 resolvedModel fallback도 금지한다.

slash alias도 같은 이유다. Codex-facing ID는 내부 slash를 `-`로 바꾸지만 internal state,
logs, jawcode metadata, combo key는 native ID를 보존하며 decode는 known native ID의 exact
bijection이다 ([`src/providers/slug-codec.ts:13-19`](../../../../src/providers/slug-codec.ts:13)).
router 역시 configured provider namespace 뒤의 ID를 `decodeRoutedModelId()`로 native ID로
복원한다 ([`src/router.ts:243-258`](../../../../src/router.ts:243)). 이미 catalog metadata도
`provider + native model id`로 lookup해야 한다고 명시한다
([`src/codex/catalog.ts:540-547`](../../../../src/codex/catalog.ts:540)).

jawcode registry 자체도 provider별 `Map`에 ID를 넣고 `Map.get(modelId)`만 한다
([`../jawcode/packages/ai/src/models.ts:37-50`](../../../../jawcode/packages/ai/src/models.ts:37)).
stats의 cost lookup도 `getBundledModel(provider, modelId)`로 exact lookup한다
([`../jawcode/packages/stats/src/db.ts:193-215`](../../../../jawcode/packages/stats/src/db.ts:193)).
그러므로 `- → /` 치환이나 fuzzy match는 금지한다.

provider alias는 새로 만들 필요가 없다. generator가 이미 `deriveJawcodeAliases()`를 호출한다
([`scripts/generate-jawcode-metadata.ts:1-6`](../../../../scripts/generate-jawcode-metadata.ts:1)),
그 함수는 registry의 `jawcodeBundle`과 `extraMetadataAliases`를 모두 alias table로 만든다
([`src/providers/derive.ts:227-236`](../../../../src/providers/derive.ts:227)). 생성물도
`resolveJawcodeProvider()`로 이를 노출한다
([`src/generated/jawcode-model-metadata.ts:14-50`](../../../../src/generated/jawcode-model-metadata.ts:14)).
비용 lookup도 이 alias table을 재사용해야 한다.

### 실측 커버리지 (2026-07-20 로컬 snapshot)

다음 **임시 in-memory Bun 명령**을 실행했다. 파일은 생성하지 않았다. 후보는 각
`PROVIDER_REGISTRY` 항목의 `models`, `modelContextWindows` key, `virtualModels` key,
`defaultModel`의 합집합이며, `deriveJawcodeAliases()`가 있는 provider만 분모에 넣었다.

```sh
bun -e 'import { PROVIDER_REGISTRY } from "./src/providers/registry.ts";
import { deriveJawcodeAliases } from "./src/providers/derive.ts";
import models from "../jawcode/packages/ai/src/models.json" with {type:"json"};
const aliases=deriveJawcodeAliases(); const candidates=[];
for(const p of PROVIDER_REGISTRY){const ids=new Set([...(p.models??[]),
...Object.keys(p.modelContextWindows??{}),...Object.keys(p.virtualModels??{})]);
if(p.defaultModel)ids.add(p.defaultModel); for(const id of ids)candidates.push({provider:p.id,id,bundle:aliases[p.id]});}
const known=candidates.filter(x=>x.bundle); const hit=known.filter(x=>models[x.bundle]?.[x.id]);
console.log({aliasedPairs:known.length, exactCostHits:hit.length});'
```

결과는 registry 53 provider/후보 198쌍 중 alias 대상 **70쌍**, jawcode exact cost match
**44쌍 = 62.86%**, 미매칭 **26쌍 = 37.14%**였다. case-insensitive로만 회복되는 것은
**0쌍**이었다. 이 값은 live discovery/custom provider와 실제 과거 로그가 아닌, 이 checkout의
정적 registry coverage이므로 그 범위를 넘어 일반화하면 안 된다. 특히 `kimi-k2.7-code`,
Google Antigravity variants, `openrouter/openai/gpt-5.6` 등이 미매칭 표본이다. 이는
alias/decode를 고쳐서 해결할 문제가 아니라 jawcode 가격 catalog 동기화/별도 명시 매핑이
필요한 coverage gap이다.

## 4. cost=0 모델 정책

같은 명령의 exact-hit 44쌍 중 all-zero cost는 **3쌍 = 6.82%**였다: OAuth `xai/grok-composer-2.5-fast`,
OAuth `kimi/kimi-k2.5`, key `moonshot/kimi-k2.5`. 따라서 zero가 곧 “구독”이라는 보장은 없다.
전체 jawcode JSON도 48 provider/3,851 model 중 all-zero 2,446개(63.52%)여서, zero를
“무료”나 “$0”으로 단정하기도 위험하다. `hasBillableCost()`가 zero를 billable로 보지 않는
것도 이를 뒷받침한다 ([`../jawcode/packages/stats/src/db.ts:189-211`](../../../../jawcode/packages/stats/src/db.ts:189)).

권장 표시:

- known OAuth/subscription provider이고 네 rate가 0이면 `구독` (영문 locale `Included`) 라벨.
- key/local/unknown provider의 all-zero는 `가격 미제공` (`—`)이다. $0가 아니다.
- billable rate가 하나라도 있는 경우만 USD 숫자를 표시한다.

## 5. combo와 attempt별 합산

combo 완료 로그의 최상위 `provider/model`은 의도적으로 `combo`/`combo/*`가 되며,
attempt usage를 aggregate한다
([`src/server/request-log.ts:425-466`](../../../../src/server/request-log.ts:425)). 그 aggregate는
각 attempt의 input/output/cache 상세를 합치지만 가격을 계산하지 않는다
([`src/server/request-log.ts:609-655`](../../../../src/server/request-log.ts:609)).

하지만 attempt에는 `provider`, `model`, `durationMs`, `usage`, `usageStatus`가 보존된다
([`src/usage/log.ts:16-30`](../../../../src/usage/log.ts:16)). combo child도 target의 model/provider로
만들어진다 ([`src/server/responses.ts:592-595`](../../../../src/server/responses.ts:592)). 따라서
**attempt별 canonical key + 위 캐시 정규화식으로 각각 계산한 뒤 USD를 합산**할 수 있고,
이것이 권장안이다. 최상위 aggregate usage에 하나의 price를 적용하면 서로 다른 모델의
단가를 섞게 되어 틀린다.

표시 신뢰도는 다음처럼 fail-closed로 한다.

- 모든 attempt가 `reported`, usage가 있고, 모든 attempt가 billable exact-match면 합계 `$`와
  효율을 표시한다.
- 하나라도 estimated/unreported/unsupported/missing price/zero-rate이면 총비용과 toks/$를
  모두 `—`로 한다. 부분합을 실제 총비용처럼 보이지 않는다.
- detail tooltip에는 attempt별 provider/model 및 제외 사유를 보여 준다. (최상위 `combo/*`는
  price lookup key가 아니다.)

## 6. usage 부재·estimated·output=0 정책

`usageStatus`는 reported/unreported/unsupported/estimated 네 상태이며
([`src/usage/log.ts:7-7`](../../../../src/usage/log.ts:7)), usage 자체가 없으면 unreported가 된다
([`src/usage/log.ts:79-81`](../../../../src/usage/log.ts:79)). 따라서 다음을 `$0`이나 무한대로
표시하지 않는다.

| 상태 | 비용($) | toks/$ |
| --- | --- | --- |
| `unreported` / `unsupported` / usage 없음 | `—` | `—` |
| `estimated` | 기본 정책 `—` (향후 opt-in 추정 표시를 만들면 `~$`/`~ toks/$`) | `—` |
| billable match이나 `outputTokens === 0` | 계산된 비용이 있더라도 `$`는 표시 가능 | `—` (0 또는 무한 효율 금지) |
| zero-rate subscription | `구독`/`가격 미제공` | `—` |
| exact price 미매칭 | `—` | `—` |

이 정책은 오류/취소가 real partial usage를 가질 수 있다는 logging 계약과도 충돌하지 않는다
([`src/types.ts:212-215`](../../../../src/types.ts:212)); 단지 정확하지 않은 monetary UI를
만들지 않는다.

## 7. 메타데이터 파이프라인과 GUI 구성

### 생성물 크기

현재 generator는 `contextWindow/maxTokens/input/reasoning/wireModelId`만 RawModel과 compact row에
넣고 cost는 버린다 ([`scripts/generate-jawcode-metadata.ts:7-14`](../../../../scripts/generate-jawcode-metadata.ts:7),
[`scripts/generate-jawcode-metadata.ts:53-67`](../../../../scripts/generate-jawcode-metadata.ts:53)). 생성물은
현재 27,120 B이며, 동일 generator 규칙을 메모리에서 비용 4 number tuple로 확장해 계산하면
현재 alias bundle 7개/485 DATA 행은 25,547 B에서 37,491 B로 **+11,944 B (+46.75%)**가 된다.
이는 source snapshot의 문자열 크기 추정이며 gzip/bundle minifier 결과는 **미확인**이다.

권장 schema는 optional nested object보다 compact tuple의 뒤 네 칸(`input`, `output`,
`cacheRead`, `cacheWrite`)이다. 모든 row에 cost가 있으므로 optional omission으로 크기 절감은
작다. `JawcodeModelMetadata`에는 `cost?: { input; output; cacheRead; cacheWrite }`를 노출한다.
provider alias 재사용과 native exact model lookup은 기존 metadata code와 같게 유지한다
([`src/generated/jawcode-model-metadata.ts:45-75`](../../../../src/generated/jawcode-model-metadata.ts:45)).

### Logs 표

현재 표는 `tokens` 다음에 model/effort/provider/status/request/duration의 8열이고
([`gui/src/pages/Logs.tsx:193-208`](../../../../gui/src/pages/Logs.tsx:193)), row도 token cache split과
resolved model label을 이미 표시한다
([`gui/src/pages/Logs.tsx:220-268`](../../../../gui/src/pages/Logs.tsx:220)). 권장 10열은:

```text
시간 | 토큰 | 비용 ($) | toks/$ | 모델 | effort | provider | status | request | duration
```

- **비용($)**: `$0.0123`처럼 작은 수는 4–6 significant digits, tooltip에는 input/output/cache
  four-way breakdown 및 matched `jawcodeProvider/model`을 표시한다.
- **toks/$ 분자**: `outputTokens`를 쓴다. 비용의 큰 부분이 prompt/cache인 요청에서
  `totalTokens / $`는 cache read로 total만 부풀려 “산출 효율”처럼 보이는 오해를 만든다.
  output은 실제 생성 산출량이라 $와의 비교가 가장 직접적이다. reasoning은 OpenCodex에서
  `outputTokens`에 포함되는 provider total이어야 하며 별도 `reasoningOutputTokens`를 다시
  더하지 않는다 (`totalTokens` 재가산 금지 계약은 [`src/types.ts:229-234`](../../../../src/types.ts:229)).
- 계산식은 `outputTokens / cost.total`; `outputTokens <= 0` 혹은 `cost.total <= 0`면 `—`이다.
- i18n에는 모든 locale의 `logs.col.cost`, `logs.col.toksPerDollar`와 unavailable/included
  문자열을 추가해야 한다. 기존 `logs.col.*` 위치는 예를 들어 English
  [`gui/src/i18n/en.ts:290-299`](../../../../gui/src/i18n/en.ts:290), Korean
  [`gui/src/i18n/ko.ts:285-294`](../../../../gui/src/i18n/ko.ts:285)다.

가격은 request log entry에 저장하지 않고 `/api/logs` consumer/UI에서 generated static metadata로
파생하는 것이 현재 JSONL schema를 바꾸지 않는 최소안이다. 다만 historical reproducibility
(가격표 갱신 후 과거 비용 변화)가 제품 요구가 되면 계산 당시 price snapshot을 entry에
영속하는 별도 설계가 필요하며, 현재 요구에서는 **미확인/범위 밖**이다.

## 8. 구현 시 변경 목록과 권장 순서

아래는 조사 결론의 예상 diff 목록이며, 이번 조사에서 변경한 파일은 없다.

| 구분 | 파일 | 변경 |
| --- | --- | --- |
| MODIFY | `scripts/generate-jawcode-metadata.ts` | RawModel/row에 cost 4값 생성 |
| MODIFY (generated) | `src/generated/jawcode-model-metadata.ts` | compact cost data와 accessor 생성 |
| NEW | `src/usage/cost.ts` (권장) | OcxUsage cache 정규화, exact provider/model lookup, combo attempt sum, display eligibility를 순수 함수화 |
| MODIFY | `src/server/request-log.ts` 또는 API view layer | `/api/logs`가 attempts를 GUI에 제공해야 하면 contract 확인; 파생을 server에서 할 경우 cost view field 추가 |
| MODIFY | `gui/src/pages/Logs.tsx` | 두 열, tooltip, `—`/`구독` 상태, colSpan 8→10 |
| MODIFY | `gui/src/i18n/{en,ko,de,zh}.ts` | 두 헤더와 상태 문자열 |
| NEW/MODIFY | 관련 unit test | OpenAI/Anthropic cache double-charge regression, slash native ID, unmatched/zero/estimated/output=0, mixed-price combo |

권장 순서:

1. generated metadata에 cost를 추가하고 native exact lookup/alias를 unit test로 고정한다.
2. `src/usage/cost.ts`에 위 canonical conversion과 eligibility를 구현한다. Anthropic fixture는
   `inputTokens=raw+read+write`가 raw input 단가 한 번만 받는지 반드시 검증한다.
3. combo는 attempt별 계산만 허용하고 partial total을 숨기는 테스트를 추가한다.
4. 마지막으로 server/UI/i18n에 두 열을 붙이고, 미매칭·zero·estimated·0 output의 `—` 정책을
   렌더링 테스트한다.

결론적으로, 62.86%의 현재 exact static coverage 안에서는 정확한 비용/toks/$를 제공할 수
있다. 그러나 cache 변환과 native ID 키를 지키지 않으면 특히 캐시가 큰 요청에서 비용이
최대 두 번 계산되며, 37.14% 미매칭 및 zero-rate rows를 `$0`으로 보이면 비용 UI 자체가
오도한다. 따라서 위 두 blocker와 fail-closed 표시를 수용하는 경우에만 구현을 권장한다.
