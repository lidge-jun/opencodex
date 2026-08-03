---
title: Codex App 모델 선택기
description: 공유 Codex 카탈로그를 통해 opencodex 모델이 Codex App, Codex CLI, Codex TUI에 표시되는 방식.
---

opencodex는 Codex App을 직접 고치지 않습니다. Codex CLI/TUI가 이미 쓰는 Codex 설정과 모델 카탈로그를
같은 위치에 씁니다. Codex App도 이 공유 상태를 읽기 때문에, 라우팅된 모델이 일반 Codex 카탈로그
항목처럼 App의 모델 선택기에 나타날 수 있습니다.

OpenAI 항목에는 두 가지 고정된 정체성이 있습니다. 하나는 `codexAccountMode`가 Pool(기본) 또는 Direct
계정 선택을 정하는 네이티브 `openai` 그룹이고, 다른 하나는 `openai-apikey/<model>` API key 전송 경로입니다.
계정 모드를 바꿔도 picker id는 바뀌지 않습니다. API GPT-5.6 항목은 context 1,050,000 / max input 922,000을
쓰고, `*-pro` picker id는 로그, 사용량, picker 상태에는 가상 id를 유지한 채 wire에서는 base model과
`reasoning.mode: "pro"`로 풀립니다. API 카탈로그는 `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, 그리고 세 개의
Pro 가상 id까지 정확히 여덟 개로 고정되어 있으며, 일반적인 `gpt-5.6-pro` 별칭은 없습니다. Compact 요청은
선택한 tier를 유지하되 reasoning 객체 없이 base model만 보냅니다.

사용할 인증 경로를 명시하세요. Providers 페이지에서 Pool/Direct를 바꾸세요:

```text
gpt-5.6-sol                         # openai (Pool or Direct option)
openai-apikey/gpt-5.6-sol           # API key
```

새로 설치한 환경과 저장된 모드가 없는 설정은 Pool이 기본값입니다. 현재 설정은 마커 2를 사용하고,
출하된 v1 소스를 `~/.opencodex/config.json.pre-openai-tiers-v2.bak`에 보관합니다. 복원하려면 다음을
실행합니다:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

이전 v1의 3-provider 설정은 자동으로 옵션을 인식하는 단일 행으로 마이그레이션됩니다.

## 통합 경로

`ocx init`, `ocx start`, `ocx sync`는 공유 Codex 설정과 카탈로그를 프록시에 연결합니다. 설정 주입,
카탈로그 동기화, shim, WebSocket 폴백, 복원 메커니즘은 [Codex 통합](/guides/codex-integration/)을
참고하세요.

## 라우팅 모델이 표시되는 이유

Codex의 모델 선택기는 Codex 형식의 카탈로그 항목을 기대합니다. opencodex는 네이티브 Codex 모델
템플릿을 복제한 뒤 라우팅된 모델의 식별자만 바꿉니다.

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

복제본에는 reasoning level, shell type, API 지원 플래그, base instructions처럼 엄격한 파서가 요구하는
필드가 그대로 남습니다. 그다음 opencodex는 해당 라우트가 감당할 수 없는 OpenAI service-tier 메타데이터
같은 네이티브 전용 기능을 제거합니다.

## 현재 안정 모델 범위

네이티브 폴백 목록에는 `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, 그리고 GPT-5.6 Sol/Terra/Luna가 들어 있습니다. GPT-5.5/5.4 계열은 설치된
Codex 카탈로그의 더 풍부한 실시간 항목을 보존하고, 빠진 항목만 합성합니다. 번들 업스트림 스냅샷은
GPT-5.6에만 사용합니다. 오래된 템플릿으로 근사하지 않고 모델별 실제 식별 정보와 메타데이터를
제공하기 위해서입니다.

| 경로 | 선택기 id와 카탈로그 메타데이터 |
| --- | --- |
| Codex 로그인(Pool 또는 Direct) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (372,000토큰 카탈로그 창) |
| OpenAI(API key) | 정확히 여덟 개의 네임스페이스 행: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, 그리고 세 개의 `*-pro` 가상 id (모두 컨텍스트 1,050,000; 최대 입력 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (1,050,000) |
| Cursor | 정적 폴백에는 `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` (1,000,000)와 `cursor/grok-4.5`, `cursor/grok-4.5-fast` (500,000)가 들어갑니다. 실시간 계정 탐색이 어떤 항목을 계속 보일지 정합니다. |
| xAI | 실시간 탐색이 기준입니다. 폴백 카탈로그의 기본값은 `xai/grok-4.5`이고, 컨텍스트 500,000과 `low` / `medium` / `high` 추론 제어를 제공합니다. |

고정된 GPT-5.6 항목은 업스트림 ladder를 그대로 보존합니다. Sol과 Terra는 `low`부터 `ultra`까지 노출하고,
Luna는 `max`에서 멈춥니다. Sol의 기본값은 `low`이고, Terra와 Luna의 기본값은 `medium`입니다. `ultra`는
최대 reasoning과 선제적 delegation을 묶은 클라이언트 선택지이며 백엔드에는 `max`로 전달됩니다. picker 항목이
보인다는 것은 카탈로그가 준비됐다는 뜻일 뿐입니다. 연결된 계정이나 API key에 실제 사용 권한이 있어야
합니다.

## 네이티브 및 라우팅 모델 토글

대시보드 Models 페이지는 두 모델 계열 모두 `disabledModels`를 사용합니다.

- 라우팅 id는 `provider/model` 형식입니다. 하나를 끄면 동기화된 카탈로그와 `/v1/models`에서 제외됩니다.
- 네이티브 GPT id는 bare slug입니다. 하나를 끄더라도 카탈로그 항목은 유지하고 `visibility`만 `hide`로
  바꿉니다. 나중에 다시 켤 때 같은 항목을 그대로 살리기 위해서입니다. 비활성 상태에서는 bare OpenAI
  목록 형식에서 빠집니다.
- 네이티브 행은 지원되는 정적 집합에서 오므로, 비활성화한 네이티브 모델은 대시보드에 계속 보이고 다시
  켤 수 있습니다.

표시 여부 처리 단계는 snapshot 업그레이드 뒤에 실행됩니다. 관리 API는 토글 뒤 카탈로그를 다시 쓰고
Codex의 모델 캐시를 강제로 오래된 상태로 만듭니다.

## 멀티 에이전트 서피스 모드

Models 페이지의 v1/base/v2 컨트롤은 각 Codex 협업 서피스가 어떤 선택기 항목을 쓰는지 바꿉니다. 기준
모드, delegation, 상속, 폴백, 암호화된 작업 동작은 [서브에이전트 서피스](/guides/sub-agent-surface/)
를 참고하세요.

## 추론 최상위 단계

reasoning-tier 표시 여부는 v1/base/v2 서피스 모드와 무관합니다. 생성된 reasoning 지원 항목은 direct
sub-agent effort override를 검증할 수 있도록 `max`를 광고합니다. 현재 생성된 routed 항목과 이전 세대
네이티브 GPT 항목은 `ultra`도 광고합니다. 정확한 업스트림 GPT-5.6 ladder는 그대로 보존되므로 Luna는
`max`까지만 있고 `ultra`는 없습니다.

wire에서는 라우팅 어댑터가 지원하지 않는 tier를 매핑하거나 제한합니다. 실제 ladder가 `xhigh`에서 끝나는
이전 네이티브 모델에서는 `nativeEffortClamp`가 직접 지정한 `max` 또는 `ultra` 선택을 `xhigh`로 바꿉니다.
예를 들면 GPT-5.5가 그렇습니다. Sol, Terra, Luna에는 실제 `max` 단계가 있습니다.

## Fast tier 규칙

Codex는 fast 모드를 다음처럼 저장합니다.

```toml
service_tier = "fast"

[features]
fast_mode = true
```

하지만 모델 카탈로그와 런타임 요청 tier id는 `priority`를 씁니다. opencodex는 이 분리를 그대로
유지합니다. 네이티브 OpenAI passthrough 모델은 fast 지원을 유지하고, 라우팅된 프로바이더는
케이퍼빌리티로 게이트되어 프로바이더가 `supportsServiceTier: false`를 선언한 경우에만
`service_tier`가 제거됩니다(레지스트리가 정식 OpenAI를 `true`, DeepSeek과 Volcengine Ark를 `false`로 분류). 미분류 커스텀 게이트웨이는 호출자가 준 값을 그대로 보존하고 주입도 받지 않습니다. 따라서
처리 불가능한 곳에 fast 옵션이 노출되지 않으며, 커스텀 게이트웨이는 `true`로 명시적으로 옵트인할 수 있습니다.

## 서브에이전트 선택

Codex는 선택기에 보이는 카탈로그 항목을 `priority` 오름차순으로 정렬한 뒤 처음 다섯 개를 `spawn_agent`
model override로 노출합니다. `subagentModels`나 대시보드 Subagents 페이지에서 네이티브 id 또는
`provider/model` id를 최대 다섯 개 고르면 opencodex가 선택한 순서대로 이 항목들에 priority 0-4를
부여합니다. 다른 모델도 정확한 id로 직접 호출할 수 있습니다.

featured-model 목록은 Dashboard의 **Sub-agent delegation** 선택과 별개입니다. Codex가 먼저 보여 줄
override를 정할 뿐, 모델을 고르거나 delegation을 시작하지는 않습니다.

## 모델 상태 새로고침

picker에 오래된 항목이 계속 보이면 카탈로그를 새로 쓰고 대상 Codex 서피스를 다시 시작합니다:

```bash
ocx sync
```

opencodex는 카탈로그의 visibility, priority, metadata가 바뀔 때마다 `models_cache.json`을 의도적으로
오래된 cache wrapper로 다시 씁니다. 다음 Codex 모델 새로고침이 새 카탈로그를 읽도록 하기 위해서입니다.
