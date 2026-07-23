---
title: 설정 레퍼런스
description: ~/.opencodex/config.json의 모든 필드 — 최상위 옵션, 프로바이더, 사이드카.
---

opencodex는 `~/.opencodex/config.json`에서 설정을 읽습니다. `ocx init`과 대시보드가 이 파일을
쓰지만 직접 편집해도 됩니다. 프록시는 시작할 때 다시 읽습니다. 잘렸거나 올바른 JSON이 아닌 등
파일을 파싱할 수 없으면 `config.json.invalid-<timestamp>`로 백업하고 콘솔에 경고한 뒤 기본값으로
시작합니다. 파일이 없어도 기본 설정(단일 `openai` forward 프로바이더)을 사용합니다.

## 예약된 OpenAI 프로바이더

`openai`와 `openai-apikey`는 고정된 예약 id입니다. `openai.codexAccountMode`는 기본 `"pool"`로
메인과 추가 계정을 선택하고, `"direct"`는 현재 Codex caller/메인 로그인만 사용합니다. API는
설정된 API key/key pool만 사용합니다. bare 모델 또는 `openai-apikey/<model>`로 선택하며
자격증명 경로 간 fallback은 없습니다.
API GPT-5.6 metadata는 context 1,050,000 / max input 922,000이고 Pro virtual id는 wire에서 base
모델과 `reasoning.mode: "pro"`로 변환됩니다.

`openaiProviderTierVersion: 2`는 현재 단일 프로바이더 projection 마커입니다. shipped v1 config를
이관하기 전에 `config.json.pre-openai-tiers-v2.bak`을 no-replace로 만들고 알려진 레거시
namespaced selected id를 bare id로 바꿉니다.

## 최상위 (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 프록시가 수신할 포트. |
| `hostname?` | `string` | `"127.0.0.1"` | 바인드 주소. LAN에 공개하려면 `"0.0.0.0"`으로 설정합니다(`OPENCODEX_API_AUTH_TOKEN` 필요, 아래 [원격 접근](#원격-접근) 참조). |
| `proxy?` | `string` | — | 외부로 나가는 HTTP(S) 프록시 URL 또는 `${ENV_VAR}` 참조. 해당 환경 변수가 비어 있을 때 `HTTP_PROXY` / `HTTPS_PROXY`에 적용하고, loopback은 `NO_PROXY`에 유지합니다. |
| `providers` | `Record<string, OcxProviderConfig>` | — | 프로바이더 이름 → 설정 map. |
| `openaiProviderTierVersion?` | `2` | migration 설정 | 단일 옵션형 OpenAI projection 완료 마커. |
| `defaultProvider` | `string` | `"openai"` | 라우팅에서 더 나은 match를 찾지 못했을 때 쓸 프로바이더. |
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 3종, `gpt-5.4-mini` | Codex 서브에이전트 선택기 앞쪽에 표시할 네이티브 slug 또는 `provider/model` id. 최대 5개이며, 명시적인 빈 배열도 그대로 보존합니다. v2 가이던스 로스터는 설정 목록과 Codex의 picker-visible·v2 호환·priority 순 상위 5개의 교집합이며 정규 카탈로그 slug와 사용 가능한 effort 사다리를 씁니다. 제외된 항목도 설정에는 남습니다. |
| `injectionModel?` | `string` | — | 주입되는 multi-agent 안내(v2 표면)에 들어갈 네이티브/라우팅 모델. 위임 안내에서 이 모델을 `fork_turns: "none"`과 함께 `spawn_agent`에 넘기게 합니다. |
| `injectionEffort?` | `string` | — | 선호하는 `spawn_agent` reasoning effort(`low`부터 `ultra`). `injectionModel`과 함께 쓸 때만 의미가 있습니다. |
| `effortCap?` | `string` | — | reasoning effort에 요청별로 적용하는 강제 상한입니다. 멀티 에이전트 V2 전용 기능으로, 자체 도구 목록에 V2 협업 표면이 있는 메인 턴과, `x-openai-subagent: collab_spawn` 헤더 또는 `x-codex-turn-metadata`의 `"subagent_kind": "thread_spawn"` 표식이 정확히 일치하는 스폰된 자식 턴에 적용됩니다(표식이 붙은 자식은 자체 도구 표면과 무관하게 적용 대상입니다). 일반 메인 턴과 V1 표면 메인 턴은 건드리지 않고, 컴팩션 턴은 항상 상한을 우회하며, `multiAgentMode: "v1"`은 상한 기능 전체를 비활성화합니다(대시보드도 패널을 숨깁니다). `low`부터 `ultra`까지 허용하며 값을 높이지 않고 낮추기만 합니다. 상한 이하에서 모델이 지원하는 가장 높은 단계로 내립니다. 모델이 effort 제어를 노출하지 않거나 상한 이하에 지원 단계가 없으면 effort 필드를 제거하고 프로바이더 기본값을 적용합니다. `max`와 `ultra`도 허용하지만 더 낮은 rank 상한을 만들지는 않습니다(클라이언트가 `ultra`를 `max`로 변환하므로 요청은 `low`부터 `max`로 들어옵니다). 단, 알려진 모델 effort 사다리에 따라 단계가 내려가거나 필드가 제거될 수 있습니다. 대시보드 선택기는 `low`부터 `xhigh`까지 제공합니다. `GET /api/effort-caps`와 `PUT /api/effort-caps`로 관리합니다. |
| `subagentEffortCap?` | `string` | — | 같은 강제 상한을 codex-rs 표식이 정확히 일치하는 스폰된 자식 턴에만 적용합니다: `x-openai-subagent: collab_spawn` 또는 `x-codex-turn-metadata`의 `"subagent_kind": "thread_spawn"`. 그 외 내부 서브에이전트 범주(리뷰, 컴팩션, 메모리 정리)는 이 상한에 걸리지 않으며, `multiAgentMode: "v1"`은 기능 전체를 비활성화합니다. `low`부터 `ultra`까지 허용하며 두 상한이 모두 설정되면 더 낮은 값이 적용되고, 값을 높이지 않고 낮추기만 합니다. 상한 이하에서 모델이 지원하는 가장 높은 단계로 내립니다. 모델이 effort 제어를 노출하지 않거나 상한 이하에 지원 단계가 없으면 effort 필드를 제거하고 프로바이더 기본값을 적용합니다. `max`와 `ultra`도 허용하지만 더 낮은 rank 상한을 만들지는 않습니다(클라이언트가 `ultra`를 `max`로 변환하므로 요청은 `low`부터 `max`로 들어옵니다). 단, 알려진 모델 effort 사다리에 따라 단계가 내려가거나 필드가 제거될 수 있습니다. 대시보드 선택기는 `low`부터 `xhigh`까지 제공합니다. `GET /api/effort-caps`와 `PUT /api/effort-caps`로 관리합니다. |
| `injectionPrompt?` | `string` | — | 주입되는 v2 안내 본문을 통째로 교체하는 커스텀 텍스트. `{{model}}`, `{{effort}}`, `{{roster}}` 플레이스홀더가 치환되며 발화 조건은 그대로입니다. `PUT /api/injection-model`의 `prompt` 키로도 설정할 수 있습니다. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | OpenCodex가 작성하는 multi-agent developer 가이던스만 제어합니다. 미설정/`true`는 v1/v2 가이던스를 유지하고, `false`는 collaboration surface, `subagentModels`, routing, effort cap을 바꾸지 않고 둘 다 억제합니다. `GET/PUT /api/injection-model`은 유효값을 제공하며 PUT은 부분 업데이트입니다. |
| `disabledModels?` | `string[]` | — | Codex에서 숨길 모델. 라우팅된 `provider/model` id는 카탈로그와 `/v1/models`에서 제외합니다. `gpt-5.4` 같은 일반 네이티브 GPT slug는 카탈로그 항목을 `visibility: "hide"`로 바꾸고 일반 `/v1/models` 목록에서 뺍니다. 대시보드 Models 페이지에서 모델별로 전환할 수 있습니다. |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 3단계 multi-agent surface override. `"v1"`은 업스트림 pin보다 우선해 모든 모델을 v1로, `"default"`는 업스트림 model pin(sol/terra=v2, luna=v1)을 따르고, `"v2"`는 모두 v2로 강제합니다. 대시보드 Models 페이지나 `ocx v2 mode`에서 설정합니다. |
| `providerContextCaps?` | `Record<string,number>` | `{}` | 프로바이더별 Codex 표시 context cap. 알려진 context window를 낮추기만 합니다. |
| `contextCapValue?` | `number` | `350000` | 대시보드 context-cap control에서 쓸 값. 바꾸면 `providerContextCaps`에서 활성화된 모든 항목을 갱신합니다. |
| `stallTimeoutSec?` | `number` | `300` | 업스트림 데이터가 오지 않을 때 bridge가 중단하고 `response.incomplete`를 내보내기까지의 초. 최소 1. |
| `connectTimeoutMs?` | `number` | `200000` | DNS/TCP/TLS와 최종 응답 헤더만 기다리는 시도별 deadline. 응답 body 생성 전 종료됩니다. |
| `shutdownTimeoutMs?` | `number` | `5000` | 진행 중인 turn을 중단하기 전 graceful drain deadline. |
| `websockets?` | `boolean` | `false` | `supports_websockets`를 알려 Codex가 Responses WebSocket 경로를 쓰게 합니다. 생략하거나 `false`이면 HTTP/SSE를 유지합니다. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 비-loopback 바인드에서 관리 API와 data plane 인증에 추가로 허용할 생성형 `ocx_…` 자격 증명. 대시보드가 관리하며 항목 필드는 아래에 설명합니다. |
| `codexAutoStart?` | `boolean` | `true` | Codex shim이 Codex 실행 전에 `ocx ensure`를 실행하게 합니다. `false`이면 `ocx ensure`가 아무 작업도 하지 않습니다. |
| `syncResumeHistory?` | `boolean` | `true` | 되돌릴 수 있는 Codex App 기록 호환 모드. opencodex가 원래 Codex thread metadata를 백업하고, 예전 OpenAI interactive row를 `opencodex`로 재매핑하며, opencodex가 만든 `exec` row를 App에 보이는 source로 잠시 승격합니다. `ocx stop` / `ocx restore`는 백업한 OpenAI row를 복원하고 남은 opencodex user thread를 OpenAI로 돌려 네이티브 Codex가 `config.toml`에서 프록시를 제거한 뒤에도 이어서 열 수 있게 합니다. 끄려면 `false`로 설정합니다. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth 대시보드에서 관리하는 ChatGPT/Codex pool 계정 metadata. secret은 `codex-accounts.json`에 따로 둡니다. |
| `activeCodexAccountId?` | `string` | — | 다음 새 Codex thread에 쓸 pool 계정. 기존 thread affinity는 원래 계정을 유지합니다. |
| `autoSwitchThreshold?` | `number` | `80` | 새 세션 자동 전환용 사용량 백분율 threshold. 알려진 5시간, 주간, 30일 quota window 중 가장 높은 점수를 씁니다. `0`이면 quota 자동 전환을 끕니다. |
| `upstreamFailoverThreshold?` | `number` | `3` | 일시적인 업스트림 실패가 연속으로 발생한 뒤, 이후 새 세션을 다른 적합한 pool 계정으로 failover할 횟수. `0`이면 실패 기반 failover를 끕니다. |
| `modelCacheTtlMs?` | `number` | `300000` | 프로바이더별 `/models` 캐시의 유효 기간(5분). |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt cache 정책. 끔, 5분 ephemeral, 1시간 extended 중 하나입니다. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | 웹 검색 사이드카 옵션(아래 참조). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | 비전 사이드카 옵션(아래 참조). |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | 선택형 proactive OAuth 갱신 및 Codex 계정 warmup 정책. 필드는 아래에 설명합니다. |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS에서 추가로 허용할 정확한 origin. loopback origin은 항상 허용합니다. |

`maxConcurrentThreadsPerSession`은 `config.json` 키가 아니라 `PUT /api/v2`에서 쓰는 camel-case
필드입니다. `ocx v2 threads <n>`은 대응하는 `max_concurrent_threads_per_session` 값을 Codex의
`$CODEX_HOME/config.toml` 안 `[features.multi_agent_v2]`에 저장합니다. 해당 table이 생기도록 v2를
먼저 켜세요.

백업 지원 이전의 개발 빌드에서 이미 `syncResumeHistory`를 실행했다면
`ocx recover-history --legacy-openai`로 같은 native-provider 복구를 강제할 수 있습니다.

:::note[Codex 계정 풀]
pool 계정 추가와 quota 갱신은 대시보드의 **Codex Auth** 페이지에서 처리하세요. 설정에는 secret이
아닌 계정 metadata만 저장하고, access/refresh token은 강화된 Codex 계정 credential store에 따로
보관합니다. 기존 thread id는 계정 affinity를 유지하며, 새 세션은 quota, cooldown, health에 따라
자동 라우팅될 수 있습니다.
:::

### 관리형 레코드 형태

`apiKeys[]` 항목에는 `id: string`, `name: string`, 생성된 `key: string`, ISO 형식의
`createdAt: string`이 들어갑니다. `codexAccounts[]` 항목에는 필수 `id`, `email`, `isMain`과 선택
`plan`, `chatgptAccountId`, 개인정보가 없는 `logLabel` 문자열이 들어갑니다. 보통 대시보드에서
관리합니다.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | proactive refresh 전체 스위치. |
| `tickSeconds?` | `number` | `21600` | sweep 간격(6시간, 최소 60초). |
| `jitterSeconds?` | `number` | `300` | sweep 전에 더할 무작위 지연. |
| `concurrency?` | `number` | `3` | sweep 한 번에 동시에 갱신할 최대 개수. |
| `leadSeconds?` | `number` | `900` | 한 tick에 더하는 선제 갱신 여유 시간. |
| `failureBackoffBaseSeconds?` | `number` | `300` | 첫 일시적 실패 backoff. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | backoff 상한 및 영구 실패 지연. |
| `codexWarmupEnabled?` | `boolean` | `false` | 합성 Codex pool 계정 검증 opt-in. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 계정을 다시 검증할 최대 기간(8일). |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 선택형 warmup에 쓸 네이티브 모델. |

## 원격 접근

opencodex는 기본적으로 `127.0.0.1`(loopback 전용)에 바인드합니다. `hostname`을 `0.0.0.0` 같은
비-loopback 주소로 설정하면 관리 API(`/api/*`)와 data plane(`/v1/responses`) **모두**에 token
인증을 강제합니다.

시작 전에 `OPENCODEX_API_AUTH_TOKEN` 환경 변수를 설정하세요.

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

비-loopback 바인드에서는 이 변수가 없으면 프록시가 시작되지 않습니다. LAN 접근용 백그라운드
서비스를 설치할 때도 같은 변수를 먼저 export한 뒤 `ocx service install`을 실행해야 launchd,
systemd, Task Scheduler에 전달됩니다. 클라이언트는 모든 요청의 `x-opencodex-api-key` 헤더에
token을 넣어야 합니다.

```
x-opencodex-api-key: your-secret-token
```

`Authorization: Bearer …` 헤더도 허용합니다. 시작 후에는 대시보드에서 생성한 `apiKeys`를 환경 변수
token 대신 쓸 수 있습니다. 모든 후보는 timing side channel을 막기 위해 상수 시간
(`timingSafeEqual`)으로 비교합니다.

:::caution[LAN 노출]
`0.0.0.0`에 바인드하면 프록시와 설정된 모든 프로바이더 자격 증명이 로컬 네트워크에 노출됩니다.
신뢰할 수 있는 네트워크에서만 사용하고 강력한 `OPENCODEX_API_AUTH_TOKEN`을 반드시 설정하세요.
:::

## 프로바이더 (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai`(또는 별칭 `azure`) 중 하나. |
| `baseUrl` | `string` | 업스트림 API base URL. |
| `responsesPath?` | `string` | `key` 인증 `openai-responses` 요청에 사용할 선택적 상대 resource path. `/`로 시작해야 하며 URL scheme, query, fragment를 포함할 수 없습니다. 생략하면 기존 `/v1/responses` URL 구성을 유지합니다. |
| `disabled?` | `boolean` | 설정은 디스크에 남기되 라우팅과 모델/카탈로그 목록에서 제외합니다. |
| `apiKey?` | `string` | API 키 또는 요청 시점에 해석할 `${ENV_VAR}` / `$ENV_VAR` 참조. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 여러 키를 담는 pool. `apiKey`는 활성 항목을 반영합니다. 각 항목에는 `id`, `key`, 선택 `label`, 선택 숫자 `addedAt`이 있습니다. |
| `defaultModel?` | `string` | 명시적인 모델 없이 이 프로바이더를 선택했을 때 쓸 모델. |
| `models?` | `string[]` | seed/fallback 모델 목록. `liveModels`가 `false`이면 여기 있는 모델만 발견됩니다. |
| `liveModels?` | `boolean` | 시작/동기화 시 프로바이더의 실시간 `/models` 카탈로그를 가져옵니다(기본 `true`). `false`이면 설정된 `models`만 사용합니다. |
| `selectedModels?` | `string[]` | 모델 발견 뒤 적용할 카탈로그 allowlist. 비어 있지 않으면 해당 id만 Codex에 노출하고, 비어 있거나 생략하면 발견한 모델을 모두 노출합니다. |
| `contextWindow?` | `number` | 라우팅 카탈로그 항목에 표시할 프로바이더 단위 context-window cap. 실시간 metadata가 더 작으면 그대로 둡니다. |
| `modelContextWindows?` | `Record<string,number>` | 모델별 context-window cap. 일치하는 모델에서는 `contextWindow`보다 우선하며 더 작은 실시간 metadata를 올리지 않습니다. |
| `modelInputModalities?` | `Record<string,string[]>` | `["text"]`, `["text", "image"]` 같은 모델별 카탈로그 input hint. |
| `headers?` | `Record<string,string>` | 추가 업스트림 헤더. Authorization, cookie, API-key 헤더, 줄바꿈이 든 값, 잘못된 헤더 이름은 거부합니다. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 기본 OpenRouter 프로바이더 라우팅 설정. `order`, `only`, `allowFallbacks`를 지원하며 canonical OpenRouter URL과 `openai-chat` adapter에서만 유효합니다. |
| `modelOpenRouterRouting?` | `Record<string,OpenRouterProviderRouting>` | `openRouterRouting`을 대체하는 정확한 모델 id별 설정입니다. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 인증 방식(기본 `key`). [프로바이더](/opencodex/ko/guides/providers/#인증-모드) 참조. |
| `codexAccountMode?` | `"pool" \| "direct"` | canonical `openai` 전용. 생략하면 Pool이며 Direct는 풀 상태를 건너뜁니다. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 이 OAuth 프로바이더의 Token Guardian 정책 override. |
| `reasoningEfforts?` | `string[]` | 알리고 전송할 프로바이더 단위 Codex reasoning 레이블(`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). |
| `modelReasoningEfforts?` | `Record<string,string[]>` | 모델별 reasoning 레이블. 빈 배열은 해당 모델의 effort control을 숨깁니다. |
| `modelSupportsReasoningSummaries?` | `Record<string,boolean>` | 모델별 reasoning summary capability. 모델 값을 `false`로 두면 summary 지원을 알리지 않고 `openai-responses` 요청 전에 summary-delivery 필드를 제거합니다. |
| `reasoningEffortMap?` | `Record<string,string>` | 프로바이더 단위 reasoning 레이블 wire alias. 업스트림이 다른 값을 요구할 때만 사용합니다. |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | 모델별 reasoning 레이블 wire alias. |
| `noReasoningModels?` | `string[]` | reasoning/thinking 파라미터를 거부하는 모델. 어댑터가 `reasoning_effort`를 제거합니다. |
| `noTemperatureModels?` | `string[]` | 호출자가 지정한 `temperature`를 거부하는 모델. |
| `noTopPModels?` | `string[]` | 호출자가 지정한 `top_p`를 거부하는 모델. |
| `noPenaltyModels?` | `string[]` | presence/frequency penalty를 거부하는 모델. |
| `parallelToolCalls?` | `boolean` | 병렬 툴 호출을 켜거나 끕니다. OpenAI Chat은 기본 on이며, chat 외 어댑터는 명시적인 `true`에서만 지원을 알립니다. |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice`에서 `auto` 또는 `none`만 받는 모델. 강제/지정 선택은 downgrade합니다. |
| `preserveReasoningContentModels?` | `string[]` | 이전 assistant `reasoning_content`를 chat history에 유지해야 하는 모델. |
| `thinkingToggleModels?` | `string[]` | effort 단계 대신 vendor `thinking.enabled` toggle을 쓰는 chat 모델. |
| `thinkingBudgetModels?` | `string[]` | 정수 `thinking_budget`을 쓰는 chat 모델. effort를 budget 비율로 매핑합니다. |
| `noVisionModels?` | `string[]` | 텍스트 전용 모델. [비전 사이드카](/opencodex/ko/guides/sidecars/)가 이미지를 설명합니다. Ollama의 `:size` 태그도 일치시킵니다. |
| `escapeBuiltinToolNames?` | `boolean` | Umans 같은 Anthropic 호환 gateway가 wire에서 툴 이름 escaping을 요구할 때 사용합니다. opencodex는 툴 호출을 Codex에 돌려주기 전에 prefix를 제거합니다. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google 전송/인증 모드. 기본 `ai-studio`. |
| `project?` | `string` | Vertex project id 또는 Antigravity Cloud Code Assist project id. |
| `location?` | `string` | Vertex location. 환경 변수 fallback은 `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string,CursorMcpServerConfig>` | **Cursor 전용.** stdio로 시작하거나 Streamable HTTP로 연결할 MCP server. 필드는 아래에 설명합니다. |
| `desktopExecutor?` | `DesktopExecutorConfig` | **Cursor 전용.** 외부 computer-use/record-screen 명령. 필드는 아래에 설명합니다. |
| `unsafeAllowNativeLocalExec?` | `boolean` | **Cursor 어댑터 전용.** Cursor 서버가 지시한 로컬 `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` 실행을 허용하는 opt-in escape hatch. 기본 `false`라 원격 Cursor 메시지가 Codex 승인과 sandbox를 우회하지 못합니다. 아래 [Cursor 프로바이더](#cursor-프로바이더-adapter-cursor) 참조. |

## Cursor 프로바이더 (`adapter: "cursor"`)

Cursor bridge는 실험적입니다. `ocx login cursor`를 실행한 뒤
`~/.opencodex/config.json`(Windows: `%USERPROFILE%\.opencodex\config.json`)의 `providers` 아래에
`cursor` 항목을 추가하거나 편집하세요.

Cursor 서버가 지시하는 네이티브 로컬 툴은 기본적으로 **꺼져 있습니다**. Codex는 자체 툴
(`apply_patch`, `exec_command` 등)을 기존 승인 및 sandbox 정책에 따라 계속 사용합니다. Cursor가
Codex 승인 경로 없이 로컬 파일을 읽고, 쓰고, 지우고, 나열하거나 grep/shell/fetch를 실행해도 되는
신뢰된 로컬 실험에서만 `unsafeAllowNativeLocalExec`을 설정하세요.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "unsafeAllowNativeLocalExec": true
    }
  }
}
```

이 플래그는 최상위 `config.json`이 아니라 **프로바이더 객체**(`providers.cursor`)에 둡니다.

[웹 대시보드](/opencodex/ko/guides/web-dashboard/)에서도 설정할 수 있습니다. **Providers →
Cursor → Edit JSON**에서 `"unsafeAllowNativeLocalExec": true`를 추가해 저장한 뒤 프록시를
재시작하세요(`ocx restart` 또는 `ocx stop` + `ocx start`).

MCP, 화면 녹화, computer-use는 별도의 `mcpServers` / `desktopExecutor` 설정을 쓰며 이 플래그의 영향을
받지 않습니다.

### Cursor 통합 레코드

각 `mcpServers.<name>` 값은 `command`(stdio) 또는 `url`(Streamable HTTP) 중 하나를 받습니다.
stdio 항목에는 `args?: string[]`, `env?: Record<string,string>`, `cwd?: string`도 넣을 수 있고, HTTP
항목에는 `headers?: Record<string,string>`을 넣을 수 있습니다. 두 형식 모두
`enabled?: boolean`(기본 true)과 `toolPrefix?: string`을 지원합니다.

`desktopExecutor`는 `computerUseCommand?`, `recordScreenCommand?`, `cwd?`,
`env?: Record<string,string>`, `timeoutMs?`(기본 `30000`)를 받습니다. 명령은 `sh -c`로 실행되며,
stdin에서 JSON 요청 하나를 읽고 stdout에 JSON 결과 하나를 써야 합니다.

:::caution[보안]
Codex 승인과 sandbox 규칙을 우회하는 Cursor 네이티브 로컬 실행이 명확히 필요한 경우가 아니라면
`unsafeAllowNativeLocalExec`을 생략하거나 `false`로 두세요.
:::

## OpenRouter 프로바이더 라우팅

OpenRouter에서 같은 모델을 제공하는 endpoint마다 prompt cache 지원, 적중률, 유지 시간과 가격이
다를 수 있습니다. `openRouterRouting`으로 기본 프로바이더를 지정하고,
`modelOpenRouterRouting`으로 특정 모델의 설정을 대체할 수 있습니다. 설정은 OpenRouter의
`order`, `only`, `allow_fallbacks` 요청 필드로 변환됩니다. `allowFallbacks: false`는 지정한
프로바이더가 실패했을 때 다른 endpoint로 전환하지 않고 요청을 실패시킵니다.

```json
{
  "openRouterRouting": { "order": ["deepseek"], "allowFallbacks": false },
  "modelOpenRouterRouting": {
    "anthropic/claude-sonnet-5": { "only": ["anthropic"], "allowFallbacks": false }
  }
}
```

## 정적 모델 allowlist

일부 프로바이더는 실시간 모델 카탈로그가 매우 크거나 느립니다. Codex에 `models`로 고정한 모델만
보이게 하려면 `liveModels`를 `false`로 설정하세요.

`liveModels`가 `false`이고 `models`가 비어 있거나 생략되면 opencodex는 해당 프로바이더의 라우팅
모델을 하나도 노출하지 않습니다.

`selectedModels`는 목적이 다릅니다. 모델 발견은 계속 실행하되 선택한 id만 Codex 카탈로그와
`/v1/models`에 게시합니다. 대시보드에는 전체 모델 목록이 남으므로 나중에 allowlist를 바꿀 수
있습니다.

프리뷰 GPT-5.6 fallback 항목도 같은 방식을 씁니다. OpenAI API 키 preset은 base와 Pro id를
context `1050000`, max input `922000`으로 seed하고, OpenRouter preset은
`openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`를 context `1050000`으로
seed합니다. Pool/Direct Codex catalog 계약은 `372000`입니다. 동기화된 Codex 카탈로그에서는 `max`
reasoning을 알리되 `xhigh`와 구분합니다. 실시간 프로바이더 결과와 이 명시적 항목을 합치려면
`liveModels`를 켜 두고, `models`만 노출하려면 `false`로 설정하세요.

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

## 사이드카

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 선택한 백엔드를 쓸 수 있을 때 on | 전체 스위치. 웹 검색 사이드카를 끄려면 `false`로 설정합니다. |
| `backend?` | `"openai" \| "anthropic"` | 자동 | 실행 백엔드. 명시한 값이 우선하며, 생략하면 쓸 수 있는 Anthropic OAuth 계정이 있을 때 `anthropic`, 없을 때 `openai`를 선택합니다. |
| `model?` | `string` | 백엔드별 기본값 | 검색 모델. `openai`는 `gpt-5.6-luna`, `anthropic`은 `claude-sonnet-5`를 씁니다. 명시적으로 남은 기존 `gpt-5.4-mini` 값은 시작할 때 마이그레이션합니다. |
| `reasoning?` | `string` | `low` | 사이드카 reasoning effort(`minimal`은 웹 검색과 함께 쓸 수 없음). |
| `maxSearchesPerTurn?` | `number` | `3` | 메인 모델 한 turn에서 실행할 실제 검색 총횟수(loop guard). |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 설정 파일에서만 지정할 수 있는 라우팅 모델 반복별 원시 응답 byte 연속 무활동 deadline. `1`부터 `2147483647`까지의 정수여야 하며, 비어 있지 않은 응답 body chunk가 올 때마다 다시 시작됩니다. |
| `timeoutMs?` | `number` | `200000` | 호스팅 웹 검색 요청 하나를 제한하는 별도 deadline. |

`openai` 백엔드는 활성화된 ChatGPT `forward` 프로바이더에서 호스팅 검색을 실행하므로 ChatGPT
로그인과 해당 프로바이더가 모두 필요합니다. Claude Code에서 들어온 라우팅 요청은 내부 사이드카
호출에 메인 ChatGPT 인증을 주입하므로 이 경로에 연결할 수 있습니다. `anthropic` 백엔드는
활성화된 Anthropic OAuth 프로바이더의 저장된 활성 자격 증명으로 Claude의
`web_search_20250305` 도구를 실행합니다. `backend: "anthropic"`을 명시했는데 활성 계정을 쓸 수
없거나 `needsReauth` 상태라면 OpenAI로 바꾸지 않고 실패 후 중단합니다.

웹 검색 경로에는 네 가지 clock이 있습니다. 기본 bridge event stall 예산(`stallTimeoutSec`),
DNS/TCP/TLS/최종 header 예산(`connectTimeoutMs`), 라우팅 모델의 원시 byte 무활동
(`routedModelStallTimeoutMs`), 호스팅 검색 하나의 제한(`timeoutMs`)입니다. 실제 bridge watchdog은
`max(기본 stall, connect timeout, 라우팅 모델 stall, 사이드카 timeout) + 30초`입니다. 라우팅 모델
stall은 무활동 감시 장치이며 전체 생성 timeout이 아닙니다.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 선택한 백엔드를 쓸 수 있을 때 on | 전체 스위치. 이미지 설명을 끄려면 `false`로 설정합니다. |
| `backend?` | `"openai" \| "anthropic"` | 자동 | 실행 백엔드. 웹 검색과 같은 명시값 우선, Anthropic 자격 증명 감지 규칙을 사용합니다. |
| `model?` | `string` | 백엔드별 기본값 | 이미지 설명 모델. `openai`는 `gpt-5.4-mini`, `anthropic`은 `claude-sonnet-5`를 씁니다. |
| `maxDescriptionsPerTurn?` | `number` | `8` | 메인 모델 한 turn에서 새로 실행할 설명(cache miss)의 최대 개수. `0`이면 설명 호출을 하지 않으며, 잘못된 값은 기본값을 씁니다. |
| `timeoutMs?` | `number` | `45000` | 사이드카 fetch timeout. |

비전 사이드카는 프로바이더의 `noVisionModels` 목록에 해당하는 모델로 이미지가 들어올 때만
작동합니다. OpenAI 백엔드는 웹 검색과 마찬가지로 ChatGPT 로그인과 forward 프로바이더가 모두
필요합니다. Anthropic 백엔드는 저장된 OAuth를 사용하며, 사용할 수 있는 자격 증명 없이 명시하면
실패 후 중단합니다. 성공한 `data:` 이미지 설명은 백엔드, 모델, detail, 이미지 바이트, 정규화한
메시지 문맥을 키로 삼아 크기가 제한된 프로세스 캐시에 저장합니다. 캐시 적중과 같은 turn의 중복
요청은 `maxDescriptionsPerTurn` 한도를 쓰지 않습니다. 원격 `https:` 이미지와 실패하거나 빈 설명은
캐시하지 않습니다.

Anthropic OAuth 검색과 이미지 설명 요청은 opencodex에서 이미 사용 중인 Claude Code OAuth
fingerprint 방식을 그대로 따릅니다. 저장소의 기존 OAuth 선례 안에 있지만, 실제로 사용할 계정과
작업량으로 충분히 soak test하는 편이 좋습니다.

<!-- TODO(WP5 GUI): GUI 컨트롤이 완성되면 사이드카 설정 화면 안내를 추가하세요. -->

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
  "subagentModels": ["anthropic/claude-opus-4-8", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  },
  "visionSidecar": { "enabled": true }
}
```

:::tip[시크릿]
키에는 `${ENV_VAR}` 참조를 사용해 `config.json`에 시크릿이 남지 않게 하세요. OAuth와 forward
프로바이더는 키를 저장하지 않습니다.
:::

:::note[원자적 쓰기]
모든 설정 및 카탈로그 파일(`config.toml`, `opencodex-catalog.json`)은 `atomicWriteFile`(임시 파일 +
이름 바꾸기)로 원자적으로 기록합니다. `ocx stop`과 프록시 자체 종료 handler처럼 여러 writer가
동시에 Codex를 복원하더라도 파일이 반만 기록되는 일을 막습니다.
:::
