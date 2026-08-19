---
title: 공급자 설정
description: 공급자 항목, 인증, 엔드포인트, 모델 카탈로그, 할당량, 컨텍스트 상한, 공급자별 옵션.
---

공급자는 opencodex에 모델의 위치, 사용하는 와이어 어댑터, 요청 인증 방식을 알려줍니다.

## 공급자 관련 최상위 필드

| 필드 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | 공급자 이름을 공급자 설정에 매핑합니다. |
| `openaiProviderTierVersion?` | `2` | 마이그레이션으로 설정됨 | 옵션을 인식하는 단일 OpenAI 투영이 완료되었음을 표시합니다. |
| `disabledModels?` | `string[]` | — | Codex catalog와 `/v1/models`에서는 숨기지만 직접 proxy 호출은 차단하지 않습니다. routed id는 목록에서 제거됩니다. account-qualified native id는 해당 selector row만 숨기고, bare native GPT id는 bare row와 그 model의 모든 account-selector row를 숨깁니다. Models 페이지에는 bare native 행과 routed 행만 표시됩니다. selector-qualified 행 하나만 숨기려면 이 설정 필드에 직접 추가하세요. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | 공급자별 Codex 표시 컨텍스트 상한입니다. 상한은 이미 알려진 컨텍스트 윈도만 낮춥니다. |
| `contextCapValue?` | `number` | `350000` | 대시보드의 컨텍스트 상한 컨트롤이 사용하는 기본값입니다. "모든 라우팅된 공급자에 적용" 토글이 켜져 있을 때만 값을 변경하면 기존 `providerContextCaps` 항목이 없는 공급자를 포함해 모든 라우팅된 공급자에 값이 적용됩니다. 그렇지 않으면 각 공급자는 자체 상한을 유지합니다. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth가 관리하는 ChatGPT/Codex 풀 계정 메타데이터입니다. 비밀 정보는 `codex-accounts.json`에 따로 저장됩니다. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | 일시 중지된 `__main__` 계정을 포함해, 재개될 때까지 Pool 선택에서 제외되는 계정입니다. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | 임의의 공개 model selector를 저장된 Codex 계정 target에 연결하는 선택적 map입니다. 계정 한정 선택기 행이 활성화되어 있으면 target이 존재하는 각 selector는 Codex picker에 별도의 `<selector>/<native-openai-model>` row를 추가하며, 각 row는 해당 계정만 사용합니다. selector가 하나라도 활성화되면 bare native row는 picker에서 숨겨지지만, 명시적으로 비활성화하지 않는 한 해당 id는 계속 routing 가능하고 raw `/v1/models`에 표시됩니다. |
| `codexAccountPickerEnabled?` | `boolean` | map이 비어 있으면 꺼짐 | 유효한 `codexAccountNamespaces` 매핑에서 account-qualified Codex 선택기 행을 생성할지 제어합니다. `true`는 매핑된 행의 표시를 허용합니다. 비어 있지 않은 map에서 생략하면 이전 버전과의 호환성을 위해 활성화된 것으로 취급되며, map이 비어 있으면 꺼집니다. `false`는 매핑을 삭제하거나 명시적 `<selector>/<native-openai-model>` 라우팅을 비활성화하지 않은 채 생성 행을 숨기고 선택기에 bare native 행을 복원합니다. |
| `activeCodexAccountId?` | `string` | — | 다음 요청에 수동으로 선택한 Pool 계정입니다. 선택하면 thread 결속이 해제되며, 진행 중인 요청은 캡처한 자격 증명을 유지합니다. |
| `codexAccountPriorities?` | `Record<string,number>` | — | Codex pool의 계정별 선택 순서. 계정 ID → `-100`부터 `100`까지의 정수이며 **값이 클수록 먼저** 쓰이고, 항목이 없으면 `0`입니다. 이는 eligibility 경계가 아니라 순서 경계입니다. 선택은 이미 적격한 계정들을 quota 여유가 남은 최상위 tier로 좁히고, 그 tier 안에서 `accountPoolStrategy`가 계정을 고릅니다. tier를 건너뛰는 경우는 그 구성원 전부가 `autoSwitchThreshold` 초과, cooldown, soft-avoid, 일시 중지 또는 재인증 대기일 때뿐이며, usage를 알 수 없다고 해서 tier가 소진되지는 않습니다. 순서는 부적격 계정을 선택 가능하게 만들지 않고, 이미 계정에 묶인 thread를 다시 bind하지도 않습니다. 메인 `__main__` 계정도 동일한 조건으로 참여하므로 Codex Desktop 로그인을 마지막에 쓰도록 둘 수 있습니다. 항목이 하나도 없으면 동작은 이전과 같습니다. map이 잘못된 경우 경고를 출력하고 순서 지정을 끕니다(config 복구는 하지 않습니다). `ocx account priority`와 Codex Auth 페이지에서 관리합니다. |
| `autoSwitchThreshold?` | `number` | `80` | 사용량 기반 선제 전환 임계값입니다. `quota`는 바인딩된 작업과 바인딩 없는 작업의 다음 요청을 모두 재평가할 수 있고, `fill-first`는 바인딩 없는 작업 배정의 소진 기준으로만 사용하며, 기본 `round-robin` 선택은 이 값을 사용하지 않습니다. 알려진 5시간, 주간, 30일 quota window 중 가장 높은 점수를 씁니다. `0`은 사용량 기반 전환만 끄며 바인딩 없는 작업 배정이나 실패 복구는 끄지 않습니다. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 새 작업/바인딩 없는 Codex 요청의 계정 배정 전략입니다. `(parent thread id, quota scope)`의 live affinity가 없으면 바인딩 없는 요청이며, 프록시 재시작이나 affinity 초기화 뒤에는 기존에 보이던 작업도 바인딩이 없어질 수 있습니다. `quota`는 활성 계정이 없을 때 알려진 usage가 가장 낮은 적격 계정을 선택하고, 적격 활성 계정이 `autoSwitchThreshold` 미만이면 유지합니다. 임계값 도달 뒤에는 바인딩 없는 요청이나 바인딩된 작업의 다음 요청을 usage가 더 낮은 적격 계정으로 옮길 수 있습니다. `round-robin`은 바인딩 없는 요청을 균등 분배하고, `fill-first`는 cooldown, 사용 불가 또는 drain threshold까지 활성 계정에 배정합니다. |
| `accountPoolStickyLimit?` | `number` | `1` | 한 round-robin 선택이 다음으로 넘어가기 전에 유지하는 새 작업/바인딩 없는 작업 배정 수입니다. 카운터는 업스트림 성공 뒤가 아니라 작업을 바인딩할 때 증가합니다. 범위 1–100이며 `accountPoolStrategy`가 `round-robin`일 때만 적용됩니다. |
| `upstreamFailoverThreshold?` | `number` | `3` | 연속된 일시적 실패가 이 횟수에 도달하면 이후 새 세션은 failover됩니다. `0`으로 두면 비활성화됩니다. 일반 Responses와 네이티브 compact 전송에서 입증된 연결 전 DNS/TCP 도달 불가 실패는 provider-host 범위로 기록되며 계정 상태, 계정 쿨다운, 스레드/세션 선호도, 활성 계정 선택 또는 Pool 라우팅에 영향을 주지 않고 이 임계값에도 집계되지 않습니다. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | 네이티브 OpenAI forward Responses와 compact 전송에서 입증된 연결 전 DNS/TCP 실패에 적용하는 선택적 회로 차단 임계값입니다. `0`은 비활성화하며, `1`~`20`은 이 횟수만큼 최종 논리 요청이 실패하면 provider-origin을 30초 동안 차단합니다. 차단 중에는 계정 선택이나 업스트림 전송 전에 `Retry-After`가 포함된 `503`을 반환하고, 시간이 지나면 반개방 요청 하나만 허용합니다. 타임아웃과 HTTP 응답은 집계하지 않으며, HTTP 응답이 하나라도 오면 회로를 닫습니다. Codex Pool 라우팅에서 계정이 고정되지 않은 경우에만 적용되며, `codexAccountMode: "direct"` 및 계정 한정 선택자에서는 동작하지 않습니다. |
| `modelCacheTtlMs?` | `number` | `300000` | 공급자별 `/models` 캐시의 최신성 창입니다. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic 프롬프트 캐시 정책입니다. 비활성, 5분짜리 임시, 1시간짜리 확장 중 하나입니다. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | 꺼짐 | 선택적 선제 OAuth 갱신과 Codex 계정 워밍업 정책입니다. |

selector 이름은 사용자가 정하는 공개 label이며, opencodex는 여기에 계정 역할 의미를 부여하지 않습니다.
`codexAccountNamespaces` 키는 길이가 1~64자이고 시작과 끝은 ASCII 영숫자여야
하며, 내부에는 영숫자, `.`, `_`, `-`를 사용할 수 있습니다. 예약된 JavaScript object 이름은 거부됩니다.
값은 유효한 pool account id(내부 `__main__` 제외)이거나 Codex Desktop 계정을 나타내는 `"@main"`입니다.
provider 및 예약된 `openai` / `combo` / `policy` 충돌은 대소문자를 구분하지 않고 검사하며, namespace가 있는
combo 또는 routing-profile alias는 selector를 namespace prefix로 재사용할 수 없습니다. 설정된 pool id와 다른 selector
target도 selector로 재사용할 수 없습니다. raw account id와 email은 비공개로
유지하고 selector를 공개 이름으로 사용하세요. 명시적 선택 동작과 우선순위는
[라우팅 설정](/ko/reference/configuration/routing/)을 참고하십시오.

Codex Auth dashboard가 관리하는 map에는 명시적인 `codexAccountPickerEnabled` field가 있습니다. 빈
managed map을 활성화하면 privacy-safe selector를 만들고, 이후 계정 추가는 picker가 숨겨진 동안에도
기존 label을 바꾸지 않고 map을 확장합니다. flag가 생략된 수동 map은 자동 확장되지 않습니다. 계정을
삭제해도 mapping은 유지되며 같은 id를 다시 추가하면 새 selector 대신 기존 selector가 복원됩니다.

## 예약된 OpenAI 공급자

`openai`와 `openai-apikey`는 고정 예약 id입니다. `openai.codexAccountMode`의 기본값은 `"pool"`이며, 메인 계정과 추가된 계정 전체에서 선택합니다. `"direct"`는 현재 호출자/메인 로그인만 사용합니다. API는 설정된 API 키 또는 키 풀만 사용합니다. 모델 이름만 쓰거나 `openai-apikey/<model>`을 사용하십시오. 다른 라우트의 자격 증명으로는 대체하지 않습니다. API GPT-5.6 행에는 922,000 컨텍스트 / 922,000 최대 입력 메타데이터가 들어가며, Pro 가상 id는 기본 와이어 모델로 다시 쓰면서 `reasoning.mode: "pro"`를 적용합니다.

`openaiProviderTierVersion: 2`는 현재의 단일 공급자 투영을 표시합니다. 출시된 v1 설정을 마이그레이션하기 전에 opencodex는 `config.json.pre-openai-tiers-v2.bak`를 만들고, 기존에 다른 백업이 있더라도 덮어쓰지 않으며, 알려진 레거시 네임스페이스 지정 선택 id를 bare id로 다시 씁니다.

## 공급자 항목 (`OcxProviderConfig`)

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` 중 하나이며, `azure`는 별칭입니다. |
| `baseUrl` | `string` | 상위 API 기본 URL입니다. 대부분의 내장 고정 엔드포인트는 불일치를 무시합니다. 충돌 안전 키 프리셋은 같은 이름의 이전 사용자 지정 목적지를 보존합니다. |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | 업스트림 사용량, 과금, rate-limit 지표와 별개인 선택적 클라이언트 측 아웃바운드 요청 시작 속도 조절입니다. Provider 제한은 모든 모델에 적용되고 `models` 항목은 정확한 업스트림 모델 ID와 일치하며 지연을 더 늘릴 때만 적용됩니다. 큐 대기는 응답 헤더 타임아웃을 소모하지 않습니다. HTTP, Responses WebSocket, 명시적 어댑터 `fetchResponse`/`runTurn` 전송을 포함합니다. |
| `responsesPath?` | `string` | 키 인증 `openai-responses` 요청의 상대 리소스 경로입니다. 반드시 `/`로 시작해야 하며 스킴, query, fragment를 포함하면 안 됩니다. |
| `supportsServiceTier?` | `boolean` | `service_tier` 케이퍼빌리티 3상태입니다. `true`: fast 모드가 주입할 수 있고 호출자 값도 보존합니다. `false`: 필드를 제거하고 절대 주입하지 않습니다(미지원으로 문서화된 업스트림에는 볼 수 없습니다). 미설정: 미분류 — 호출자가 준 값은 그대로 보존하고 fast 모드는 주입하지 않습니다. 레지스트리는 정식 OpenAI(`true`), DeepSeek, Volcengine Ark(`false`)를 분류하며, 실제로 티어를 지원하는 커스텀 게이트웨이에만 명시적으로 설정하세요. |
| `preserveResponsesReasoningContent?` | `boolean` | 리플레이되는 Responses reasoning 항목의 평문 reasoning 내용을 지우지 않고 유지합니다(지우는 것은 ChatGPT 백엔드 규칙입니다). DeepSeek처럼 reasoning 리플레이를 허용하는 업스트림에 켜세요. 프록시가 만든 `ocxr1` 봉투는 항상 제거됩니다. |
| `disabled?` | `boolean` | 공급자를 디스크에는 남기되, 라우팅과 모델/카탈로그 목록에서는 제외합니다. |
| `apiKey?` | `string` | API 키 또는 요청 시점에 해석되는 `${ENV_VAR}` / `$ENV_VAR` 참조입니다. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic 키 헤더 형식입니다. 기본값은 네이티브 `x-api-key`이며, 키 인증 `anthropic` 공급자에만 유효합니다. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 다중 키 풀입니다. `apiKey`는 활성 항목을 그대로 반영하며, 각 항목에는 `id`, `key`, 선택적 `label`, 선택적 숫자 `addedAt`가 들어갑니다. |
| `defaultModel?` | `string` | 이 공급자를 선택할 때 모델을 따로 지정하지 않으면 사용하는 모델입니다. |
| `models?` | `string[]` | 시드/폴백 모델 목록입니다. `liveModels: false`이면 이 목록만 발견된 모델로 취급합니다. |
| `liveModels?` | `boolean` | 시작 또는 동기화 시 라이브 카탈로그를 가져옵니다. 기본값은 `true`입니다. 사용자 지정 공급자는 `${baseUrl}/models`를 사용하고, 내장은 레지스트리 URL을 사용한 뒤 필터링할 수 있습니다. |
| `selectedModels?` | `string[]` | 발견 후 카탈로그 허용 목록입니다. 값이 비어 있지 않으면 그 id만 노출하고, 비어 있거나 생략하면 발견된 모델을 모두 노출합니다. |
| `contextWindow?` | `number` | 업스트림 메타데이터가 없을 때 쓰이는 공급자 전반의 컨텍스트 값입니다. 메타데이터가 있으면 상한으로 동작해 더 작은 라이브 값을 그대로 둡니다. Models 대시보드에서 `providerContextCaps`와 별도로 설정합니다. |
| `modelContextWindows?` | `Record<string, number>` | 모델별 컨텍스트 값이자 상한입니다. `contextWindow`보다 우선하며, 창 크기를 알 수 없으면 설정값을 쓰고 더 작은 라이브 메타데이터가 있으면 그쪽을 따릅니다. |
| `modelInputModalities?` | `Record<string, string[]>` | `["text"]` 또는 `["text", "image"]` 같은 모델별 입력 힌트입니다. |
| `modelMaxInputTokens?` | `Record<string, number>` | 카탈로그 자동 압축 힌트에 쓰는 양수 모델별 최대 입력 한도입니다. |
| `defaultMaxOutputTokens?` | `number` | 클라이언트가 `max_output_tokens`를 생략했을 때 쓰는 공급자 전반의 `openai-chat` 폴백입니다. |
| `modelMaxOutputTokens?` | `Record<string, number>` | 양수 모델별 `openai-chat` 폴백 예산입니다. 정확한 일치와 패턴 일치가 공급자 기본값보다 우선합니다. |
| `modelCosts?` | `Record<string, Cost4>` | 모델별 표시 가격(100만 토큰당 USD). 해당 공급자의 정확한 업스트림 모델 ID를 키로 사용하며(공급자 식별자나 라우팅된 `provider/model` 레이블이 아님) 값은 `input`, `output`, `cacheRead`, `cacheWrite` 네 필드입니다(예: `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`). 커스텀 공급자는 `openai-chat` 어댑터로 임의의 OpenAI 호환 엔드포인트를 대상으로 할 수 있으며, 내장 카탈로그에 없는 로컬·내부 공급자 ID도 유효합니다. 사용자 구성 가격은 Logs `~$` 및 Usage 추정에서 내장 카탈로그보다 우선합니다. 기존 항목도 현재 오버레이로 다시 계산되므로 가격을 편집하면 과거 합계가 바뀔 수 있습니다(폴백 순서: 사용자 설정 → jawcode 카탈로그 → expected-price 오버레이 → 모델별 벤더 가격). 전부 0인 항목은 다음 소스로 폴백합니다. 각 요율은 0 이상의 유한한 숫자이며 최대 1,000,000(100만 토큰당 USD)입니다. 범위를 벗어난 행은 관리 경계에서 거부되고 로드 시 삭제됩니다. 표시 전용 추정이며 라우팅·계정 선택·할당량·청구에는 영향을 주지 않습니다. |
| `headers?` | `Record<string, string>` | 추가 상위 헤더입니다. Authorization, cookies, API-key 헤더, 내장 개행, 잘못된 이름은 허용하지 않습니다. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 기본 OpenRouter `order`, `only`, `allowFallbacks` 선호도입니다. 정식 OpenRouter와 `openai-chat`에서만 유효합니다. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | 공급자 전반의 OpenRouter 선호도를 덮어쓰는 정확한 모델 id별 재정의입니다. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | 인증 모드입니다. 기본값은 `key`입니다. OAuth/구독 자격 증명은 `config.json` 밖에 저장되며, `local`은 레지스트리 항목이 허용하는 공급자에서만 사용할 수 있습니다. |
| `codexAccountMode?` | `"pool" \| "direct"` | 정식 `openai` 전용입니다. 기본값은 Pool입니다. Direct는 풀 상태를 우회합니다. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 이 OAuth 공급자의 Token Guardian 정책을 덮어씁니다. |
| `reasoningEfforts?` | `string[]` | 광고하고 전송할 공급자 전반의 Codex reasoning 레이블입니다. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | 모델별 레이블입니다. 빈 목록이면 effort 제어를 숨깁니다. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | 모델을 `false`로 두면 summary 광고를 멈추고 summary 전달 필드를 제거합니다. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | 모델별 Responses 전달 enum입니다. 기존 delivery 필드를 다시 씁니다. |
| `modelAdapters?` | `Record<string, string>` | 혼합 와이어 게이트웨이를 위한 모델별 `openai-chat` 또는 `openai-responses` 와이어 재정의입니다. 명시적 항목이 레지스트리 기본값보다 우선합니다. DeepSeek 프리셋은 `deepseek-v4-flash`에 네이티브 Responses를 선택할 수 있고, GitHub Copilot은 GPT-5 계열(`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`)을 Responses 전용 기본값으로 선언합니다. 이 모델들은 에이전트 트래픽에서 `/chat/completions`를 거부하기 때문입니다. `gpt-5.4-nano`처럼 기본값이 없는 모델은 여기서 직접 옵트인할 수 있습니다. 단일 와이어 상위 항목과 정식 ChatGPT forward는 재정의를 거부합니다. |
| xAI Responses 옵트인(대시보드) | 스위치 | `xai`에서만 `grok-4.5`와 `grok-4.6`의 `modelAdapters` 항목을 원자적으로 설정하거나 지웁니다. 한 항목만 있으면 다음 스위치 쓰기가 둘을 정규화할 때까지 혼합 상태로 표시됩니다. 다른 재정의와 티어 동작은 바뀌지 않습니다. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | hosted tool namespace를 예약하는 non-forward Responses gateway용 정확한 모델 ID opt-in입니다. 현재 `["image_generation"]`만 허용하며, 일치하는 모델은 `openai-responses` wire를 사용하고 해당 hosted tool을 지원해야 합니다. 충돌하는 클라이언트 `image_gen` 선언을 제거하고 호출자의 tool choice를 유지하도록 selector도 다시 씁니다. OpenAI API 가상 `-pro` 모델은 선택한 공개 ID를 먼저 일치시키고, 해석된 기본 wire-model ID를 대체값으로 사용합니다. `modelAdapters`는 공개 ID를 먼저, 그 다음 기본 ID를 해석하며, 두 번째 결과가 최종 wire를 결정합니다. 설정하지 않은 모델은 일반 alias 동작을 유지합니다. |
| `reasoningEffortMap?` | `Record<string, string>` | reasoning 레이블의 공급자 전반 와이어 별칭입니다. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | reasoning 레이블의 모델별 와이어 별칭입니다. |
| `reasoningWireFormat?` | `"gateway-object"` | `reasoning_effort` 대신 `reasoning: { enabled, effort }`를 받는 OpenAI 호환 게이트웨이용입니다. ClinePass 프리셋이 자동 설정합니다. |
| `noReasoningModels?` | `string[]` | reasoning/thinking 매개변수를 거부하는 모델입니다. |
| `noTemperatureModels?` | `string[]` | 호출자가 지정한 `temperature`를 거부하는 모델입니다. |
| `noTopPModels?` | `string[]` | 호출자가 지정한 `top_p`를 거부하는 모델입니다. |
| `noPenaltyModels?` | `string[]` | presence/frequency penalty를 허용하지 않는 모델입니다. |
| `noStructuredOutputModels?` | `string[]` | `openai-chat` 엔드포인트가 `response_format`을 거부하는 정확한 모델 ID입니다. 요청 모델이 항목과 정확히 일치할 때만 필드를 생략하며, 그 외 `openai-chat` 모델에서는 structured-output 변환을 유지합니다. |
| `parallelToolCalls?` | `boolean` | 병렬 도구 호출을 켜거나 끕니다. OpenAI Chat은 기본으로 켜져 있고, 비-chat 어댑터는 명시적으로 `true`일 때만 이를 노출합니다. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | 기본값이 꺼진 downstream SSE 복구입니다. 정확한 자리표시자 id, 누락된 종료 id, 그리고(`repairInvalidIds`) 정규 `msg_`/`rs_` 접두사가 없는 message/reasoning id를 복구합니다. function-call id는 다시 쓰지 않습니다. 내장 DeepSeek은 마지막 두 가지를 기본으로 켭니다. |
| `responsesSnapshotRepair?` | `boolean` | 기본값이 꺼진 클라이언트용 복구입니다. SSE와 JSON의 Responses 수명 주기에서 누락된 status, output, 도구 메타데이터를 채우며 raw 검사와 영속화는 변경하지 않습니다. |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | API-key 프로바이더 전용(`authMode: "key"`). 동일 대상 429 재시도: `retryOn429`가 없으면 기능이 꺼져 있고, 객체가 있으면 `enabled: false`가 아닌 한 활성화됩니다. 429 시 대기(업스트림 `Retry-After` 또는 고정 간격) 후 키 장애 조치 전에 동일 키로 동일 요청을 재전송합니다 — 일반 텍스트 턴 복구 루프, Responses passthrough, 이미지/비디오 브리지, web-search 사이드카, 터미널 연속 요청을 모두 포함합니다. 재전송 대상은 프리스트림 HTTP 429 응답뿐이며, 커스텀 `runTurn` 전송은 HTTP 재시도 루프에서 제외됩니다. `attempts`는 첫 429 이후의 동일 키 재전송 횟수(총 전송 = `attempts` + 1)이며, 메인 복구 루프·터미널 가드 연속 요청·브리지 재시도가 공유하는 요청 단위 예산입니다. `attempts`를 모두 소진해도 동일 키 재전송만 중단되며, 이후에는 일반 키 장애 조치 또는 최종 오류 처리가 사용 가능한 대상에 따라 진행됩니다 — 키 인증 passthrough 와이어에는 장애 조치가 없으므로 소진된 429가 그대로 반환됩니다. Codex 자체는 429를 재시도하지 않으므로 단일 키 프로바이더의 유일한 방어선입니다. 기본값: `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000`(단일 대기는 `maxIntervalMs`로 상한, 그 자체는 600000으로 상한), `respectRetryAfter: true`. |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice`가 `auto` 또는 `none`만 받는 모델입니다. 강제 선택은 낮은 수준으로 바뀝니다. |
| `preserveReasoningContentModels?` | `string[]` | chat 기록에서 이전 assistant `reasoning_content`가 필요한 모델입니다. |
| `requiresReasoningPlaceholderModels?` | `string[]` | `reasoning_content`가 없는 tool_call 연속을 업스트림이 거부하는 모델(DeepSeek thinking 모드). 리플레이 캐시 미스 시 최소 플레이스홀더를 주입합니다. 미설정 시 `preserveReasoningContentModels`를 따르며 `[]`로 명시적 해제 가능. |
| `thinkingToggleModels?` | `string[]` | effort 계층 대신 `thinking.enabled`를 쓰는 chat 모델입니다. |
| `thinkingBudgetModels?` | `string[]` | 정수 `thinking_budget`를 쓰는 chat 모델입니다. effort는 예산 비율로 매핑됩니다. |
| `noVisionModels?` | `string[]` | vision sidecar로 보내는 텍스트 전용 모델입니다. 일치 판정은 Ollama `:size` 태그도 허용합니다. |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic 호환 게이트웨이를 위해 내장 도구 이름을 이스케이프하고, 반환된 호출에서는 다시 복원합니다. |
| `anthropicEofTolerance?` | `boolean` | `message_stop` 전에 스트림이 끝나도 표시 텍스트 또는 완전한 JSON 객체 툴 입력을 받은 경우에만 완료를 허용합니다（Anthropic 호환 게이트웨이용）. 기본값은 꺼짐. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google 전송/인증 모드입니다. 기본값은 `ai-studio`입니다. |
| `project?` | `string` | Vertex 또는 Antigravity Cloud Code Assist 프로젝트 id입니다. |
| `location?` | `string` | Vertex 위치입니다. 환경 변수 폴백은 `GOOGLE_CLOUD_LOCATION`입니다. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Cursor 전용입니다. stdio 또는 Streamable HTTP MCP 서버입니다. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Cursor 전용입니다. 외부 computer-use 및 record-screen 명령입니다. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor 레거시 불리언입니다. 더 새로운 필드가 설정되지 않았을 때만 `nativeLocalExec: "on"`과 같습니다. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor 로컬 실행 정책입니다. 기본값은 `off`입니다. `codex-sandbox`는 현재 `off`처럼 실패를 닫습니다. |

API 키 공급자는 리터럴 키나 환경 참조를 둘 수 있습니다. OAuth 공급자는 `ocx login`으로 채워지는 자격 증명 저장소를 사용합니다. 구독 기반 Claude Code 실행 동작은 [`claudeCode.authMode`](/reference/configuration/server/#claude-code)에서 설정합니다.

## 공급자 진단용 외부 요청 안전성

대시보드 연결 테스트와 라이브 모델 발견은 범위가 제한된 GET 전용 전송을 사용합니다. 아웃바운드 프록시가 없으면 opencodex는 호스트 이름을 한 번만 확인하고, 검증된 주소로만 연결합니다. HTTPS는 원래 Host, SNI, 인증서 검증을 유지하며, 공급자 설정으로 인증서 검사를 끌 수는 없습니다.

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`가 적용되면 이 작업들은 Bun의 네이티브 fetch를 그대로 사용합니다. URL과 리터럴 주소 검사는 계속 실행되지만, 최종 경로, DNS 응답, 피어는 프록시가 고르므로 opencodex는 그 피어를 고정하거나 검증할 수 없습니다. 이는 명시적인 보안 한계입니다.

사설/로컬 목적지는 `allowPrivateNetwork: true`가 필요하며, 아웃바운드 프록시가 활성화된 경우에는 일치하는 `NO_PROXY` 항목도 필요합니다. loopback은 자동으로 추가됩니다. CIDR 항목은 해석하지 않으므로 각 LAN 호스트는 따로 적어야 합니다. matcher는 정확한 호스트, 도메인 접미사, 선택적 포트, 괄호로 감싼 IPv6, `*`를 지원합니다. 예를 들면 `192.168.1.50`은 따로 적어야 합니다. 메타데이터와 link-local 목적지는 계속 차단됩니다. 진단 요청은 리디렉션을 거부하고, 자격 증명이 제거된 대상만 보고합니다. 일반적인 공급자 요청의 리디렉션 검토는 이 진단 가드와 별도로 유지됩니다.

## Codex 계정 풀

pool 계정 추가와 quota 갱신은 대시보드의 **Codex Auth** 페이지에서 처리하세요. 설정에는 secret이
아닌 계정 metadata만 저장하고, access/refresh token은 강화된 Codex 계정 credential store에 따로
보관합니다. Pool 라우팅은 새 작업/바인딩 없는 작업 배정, 사용량 기반 선제 전환, 실패 복구로
구분됩니다. 바인딩된 작업은 보통 affinity를 유지하지만 `quota`는 사용량 임계값을 넘은 뒤 다음
요청에서 재바인딩할 수 있고, 일시 중지, cooldown, 재인증, 실패 처리도 독립적으로 라우팅을
지우거나 바꿀 수 있습니다. 바인딩 없는 요청은 live 계정 바인딩이 없는 요청이며, 프록시 재시작이나
affinity 초기화 뒤의 기존 작업도 포함될 수 있습니다. 출력 전 **429/402**는 사용량 기반 선제
전환이 꺼져 있어도 같은 요청에서 적격 대체 계정으로 한 번 재시도할 수 있습니다. 계정이 바뀌어도
대화 문맥은 보존·재생되지만 계정 간 프로바이더 측 prompt cache 재사용은 보장되지 않아 다시
예열해야 할 수 있습니다.
일시 중지된 계정과 quota metadata는 계속 표시되지만 자동 전환, 재시도/failover 선택, cooldown 복구 probe, 수동 활성화에서는 제외됩니다.
일시 중지는 해당 계정의 thread affinity map도 지웁니다. 진행 중인 요청은 이미 확보한 credential을 유지하지만, 이후 턴은 다시 라우팅되며 일시 중지된 계정은 재사용할 수 없습니다.
상태는 재시작 후에도 유지되며, 모든 계정이 일시 중지되면 Pool 라우팅은 계정을 몰래 선택하지 않고 실패합니다.
**한도 도달 계정 일시 중지**는 credential이 있는 적격 계정만 먼저 새로고친 뒤 관련 quota window가 이번 응답에서 100%로 확인된 계정만 일시 중지합니다. credential이 없는 계정과 quota가 없거나 새로고침에 실패한 계정은 변경하지 않습니다.
**401/403**이 발생하면 해당 계정의 프로세스 로컬 affinity를 해제하고 재인증을 요구합니다.
**429**에서는 `Retry-After`를 준수해 계정 cooldown을 시작하고 affinity를 해제한 뒤,
다른 적격 Pool 계정으로 요청을 전환할 수 있습니다. 이러한 실패 복구는
`autoSwitchThreshold: 0`에서도 계속 작동하며, `0`은 사용량 기반 선제 전환만 비활성화합니다.

**배정 및 선제 전환 전략:** `quota`(기본)는 활성 계정이 없을 때 최저 usage의 적격 계정을 선택하고,
적격 활성 계정이 `autoSwitchThreshold` 미만이면 유지합니다. 임계값 도달 뒤에는 바인딩 없는 요청이나 바인딩된 작업의 다음 요청을 usage가 더 낮은 적격 계정으로 옮길 수 있습니다.
`round-robin`은 바인딩 없는 요청을 균등 분배하며 임계값은 기본 순환에 영향을 주지 않습니다.
`accountPoolStickyLimit`(기본 `1`, 1–100)은 성공 응답이 아니라 배정/바인딩 횟수를 셉니다.
`fill-first`는 바인딩 없는 요청을 cooldown, 재인증 또는 drain threshold까지 활성 계정에 배정하고,
정상적인 바인딩 작업은 affinity를 유지합니다. 이 전략들은 provider enforcement를 우회하지 않으며
다계정 사용은 ToS 위반일 수 있습니다.

### `anthropicAccountPool` (실험적)

이 선택 기능은 이미 `auth.json`에 저장된 여러 Anthropic OAuth 계정을 함께 묶습니다. 기본값은 꺼짐이며 충분히 검증되지 않았습니다. 같은 조직의 계정은 할당량을 공유할 수 있고, 자동 순환은 공급자 제한을 유발할 수 있습니다.

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | sticky 결속과 429 쿨다운 failover를 켭니다. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | 새 세션에서는 이 임계값 이상에서 알려진 캐시 5시간 사용량이 가장 낮은 계정을 고릅니다. `0`이면 quota 선택을 끕니다. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 새 세션 전략입니다. quota는 5시간 막대만 사용합니다. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | 성공한 새 세션 결속이 한 번의 라운드로빈 선택에 유지되는 횟수입니다. 범위는 1–100입니다. |

활성화되면 429 레코드가 `Retry-After` 또는 기본 backoff에서 제한된 쿨다운을 기록하고, 요청 안에서 회전할 수 있습니다. 결속은 프로세스 로컬이며 크기가 제한됩니다. 자격 증명 401/403은 해당 계정이 재인증이 필요함을 표시합니다. 적격한 계정이 모두 쿨다운 중이면, 클라이언트는 인증 오류가 아니라 알려진 경우 `Retry-After`가 포함된 429를 받습니다.

:::caution[실험적 기능]
Anthropic 계정 정책 위험을 이해하지 못한다면 이 기능은 꺼두십시오. 확신이 없으면 수동 `ocx account use anthropic <id>` 전환을 우선하십시오.
:::

### 관리되는 레코드 구조

`apiKeys[]` 항목에는 `id`, `name`, 생성된 `key`, ISO 형식 `createdAt` 문자열이 들어갑니다. `codexAccounts[]` 항목에는 `id`, `email`, `isMain`이 필요하고, 선택적으로 `plan`, `chatgptAccountId`, 개인정보를 해치지 않는 `logLabel`을 둘 수 있습니다. 이런 레코드는 보통 대시보드가 관리합니다.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| 필드 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | 전역 선제 갱신 스위치입니다. |
| `tickSeconds?` | `number` | `21600` | 순회 간격입니다. 6시간이며 최소 60초입니다. |
| `jitterSeconds?` | `number` | `300` | 순회 전에 더하는 무작위 지연입니다. |
| `concurrency?` | `number` | `3` | 동시에 실행할 수 있는 최대 갱신 수입니다. |
| `leadSeconds?` | `number` | `900` | 한 틱을 넘겨서 더 확보하는 갱신 리드 타임입니다. |
| `failureBackoffBaseSeconds?` | `number` | `300` | 초기 일시적 실패 backoff입니다. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | backoff 상한이자 영구 실패 지연입니다. |
| `codexWarmupEnabled?` | `boolean` | `false` | 합성 Codex 풀 계정 검증을 선택적으로 켭니다. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 8일 후 계정을 다시 검증합니다. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 선택적 워밍업에 쓰는 네이티브 모델입니다. |

## 고정 공급자 엔드포인트

라우팅은 어댑터보다 먼저 공급자 엔드포인트를 해석합니다. 대부분의 내장 항목에서는 레지스트리 엔드포인트가 설정된 `baseUrl`보다 우선합니다. 다음 네 가지 유형은 설정한 URL을 유지합니다.

- 오버라이드가 활성화된 공급자: `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud`, `alibaba-token-plan-intl`;
- 사용자가 채운 레지스트리 템플릿, 예를 들면 `azure-openai`와 `cloudflare-ai-gateway`;
- 이전에 같은 이름으로 존재하던 사용자 지정 목적지를 보존하는 승격된 고정 API 키 프리셋; 그리고
- 레지스트리에 없는 공급자.

어댑터는 나중에 해석된 URL을 조정할 수 있습니다. 예를 들어 Kiro는 가져온 자격 증명의 API 지역을 따라 정식 `runtime.{region}.kiro.dev`를 사용합니다. [Adapters](/reference/adapters/)를 보십시오.

라우팅이 `baseUrl`을 버리면 opencodex는 레지스트리 엔드포인트와 설정된 origin만 기록합니다. 설정된 path 자체에 자격 증명이 들어 있을 수도 있습니다. 쓰지 않는 URL은 지우거나, 의도한 지역과 맞는 공급자 항목을 고르십시오. `alibaba-token-plan`은 베이징에 고정되어 있고, `alibaba-token-plan-intl`은 국제 엔드포인트를 담당합니다.

깨진 `openai-responses` 게이트웨이는 공급자 객체에서 복구해야 합니다.

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

자리표시자 목록은 정확히 일치해야 합니다. 일반적인 상태 유지형 Responses 공급자에서는 필드를 설정하지 마십시오. 그래야 passthrough가 바이트 단위로 동일하게 유지됩니다.

## Cursor 공급자 (`adapter: "cursor"`)

Cursor 브리지는 실험적입니다. `ocx login cursor`를 실행한 뒤 `providers.cursor`를 추가하거나 수정하십시오. Cursor Router의 최적화 단계는 선택기가 Cursor 전용 모델 매개변수를 렌더링하지 못하므로 별도의 Codex id로 노출됩니다.

| Codex 모델 | Cursor Router 모드 |
| --- | --- |
| `cursor/auto` | 팀/계정 기본값 |
| `cursor/auto-cost` | 비용 |
| `cursor/auto-balance` | 균형 |
| `cursor/auto-intelligence` | 지능 |

명시적 변형은 Cursor의 `default` 모델과 그 `optimization` 매개변수를 함께 보내며, 매 요청마다 선택을 유지합니다. 라이브 발견에서 `default`가 빠져도 계속 사용할 수 있습니다.

Cursor 서버 주도 로컬 도구는 기본값으로 비활성화됩니다. Codex는 계속해서 `apply_patch`, `exec_command` 같은 자체 도구를 자체 승인 및 샌드박스 정책과 함께 사용합니다.

- `"off"`(기본값)는 Cursor 네이티브 `read`, `write`, `delete`, `ls`, `grep`, `shell`, `fetch` 실행을 거부합니다.
- `"on"`은 신뢰된 로컬 실행을 허용하고, Codex 승인/샌드박스 의미를 우회합니다.
- `"codex-sandbox"`는 호환성을 위해 남아 있지만 `"off"`처럼 실패를 닫습니다. 요청 문구는 신뢰할 수 있는 샌드박스 증명이 아닙니다.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

필드는 최상위가 아니라 `providers.cursor`에 설정하십시오. 대시보드에서는 **Providers → Cursor → Edit JSON**을 사용해 저장한 뒤 다시 시작합니다. 레거시 `unsafeAllowNativeLocalExec: true`는 `nativeLocalExec`이 설정되지 않았을 때만 `nativeLocalExec: "on"`과 같습니다. MCP, 화면 녹화, computer use는 `mcpServers`와 `desktopExecutor`가 따로 제어합니다.

각 `mcpServers.<name>`는 `command`(stdio) 또는 `url`(Streamable HTTP) 중 하나를 받습니다. stdio는 `args`, `env`, `cwd`도 받습니다. HTTP는 `headers`를 받습니다. 둘 다 `enabled`(기본값 true)와 `toolPrefix`를 지원합니다. `desktopExecutor`는 `computerUseCommand`, `recordScreenCommand`, `cwd`, `env`, `timeoutMs`(기본값 `30000`)를 받습니다. 명령은 `sh -c`를 거치며 stdin에서 JSON 요청 하나를 읽고, stdout에 JSON 결과 하나를 써야 합니다.

:::caution[보안]
기본 loopback 바인드는 다른 사용자를 포함한 인증되지 않은 로컬 프로세스라면 무엇이든 허용합니다. 데이터 평면 호출자가 모두 신뢰된 경우가 아니고, Codex 승인과 샌드박스 의미를 의도적으로 우회할 생각이 아니라면 로컬 실행은 꺼 두십시오.
:::

## OpenRouter 공급자 라우팅

OpenRouter는 하나의 모델을 여러 추론 공급자로 제공할 수 있습니다. `openRouterRouting`은 요청을 선호하는 공급자에 유지하고, `modelOpenRouterRouting`은 정확한 모델 id에 대해 이를 대체합니다. 캐시 지원, 유지 시간, 히트율, 가격이 추론 공급자마다 다르기 때문에 프롬프트 캐시 결속에 유용합니다.

공급자 이름은 OpenRouter slug입니다. `allowFallbacks: false`는 실패를 닫고, `true`는 정렬된 목록 뒤에 있는 다른 적격 공급자를 허용합니다. `only`는 항상 허용 목록입니다.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

모델 키는 외부 opencodex 공급자 접두사 없이, 정확한 네이티브 OpenRouter id여야 합니다. `openrouter/anthropic-claude-sonnet-5`를 선택하면 모델 규칙을 적용하기 전에 네이티브 `anthropic/claude-sonnet-5`로 되돌아갑니다.

## 정적 모델 허용 목록

`liveModels: false`로 두면 `models`만 노출합니다. `models`가 비어 있거나 생략되면 공급자는 어떤 라우팅 모델도 노출하지 않습니다. 라이브 발견은 캐싱 전에 4 MiB 또는 원시 모델 행 2,000개를 넘으면 거부합니다. 내장 프리셋은 더 낮은 한도를 쓰고 chat 가능한 행만 필터링할 수 있습니다. 너무 크거나 형식이 잘못된 결과는 오래된/설정된 폴백을 따릅니다. 유효하지만 선택 가능한 항목이 0개인 결과는 그대로 권위가 있으며, 조용히 다른 값으로 바꾸거나 잘라내지 않습니다.

`selectedModels`는 발견은 계속하되, 선택된 id만 Codex와 `/v1/models`에 나타나게 하고 싶을 때 사용합니다. 대시보드는 나중에 허용 목록을 바꿀 수 있도록 발견된 전체 목록을 보관합니다.

프리뷰 GPT-5.6 폴백 항목도 같은 메커니즘을 사용합니다. OpenAI API 키 프리셋은 base와 Pro id에 컨텍스트 `922000`, 최대 입력 `922000`을 채웁니다. OpenRouter는 `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`에 컨텍스트 `922000`을 채웁니다. Pool/Direct는 `922000`을 노출하고, 동기화된 카탈로그는 `xhigh`를 구분한 채 `max`를 노출합니다.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## 전체 예시

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```
