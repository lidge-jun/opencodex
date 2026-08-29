---
title: Codex App 모델 선택기
description: 공유 Codex 카탈로그를 통해 opencodex 모델이 Codex App, Codex CLI, Codex TUI에 표시되는 방식.
---

opencodex는 Codex App을 직접 고치지 않습니다. Codex CLI/TUI와 같은 Codex 설정과 모델 카탈로그를
씁니다. app-server는 이 공유 상태를 읽지만, 일부 Codex Desktop 릴리스는 renderer에서 추가 remote
allowlist를 적용해 routed row를 picker에서 제거할 수 있습니다. 명시적 `nativeAlias: true` combo가
이 업스트림 버그를 위한 호환 모드입니다.

OpenAI 항목에는 네이티브 Codex 로그인과 네임스페이스가 붙은 `openai-apikey/<model>` API key
경로라는 두 가지 credential 경로가 있습니다. `codexAccountMode`만 Pool과 Direct 사이에서 바꾸는 것은
선택기 id를 바꾸지 않습니다. 하지만 `codexAccountPickerEnabled`로 계정 한정 선택기 행이 활성화되어 있고
`codexAccountNamespaces`에 대상 계정이 존재하는 selector가 있으면,
opencodex는 매핑된 계정별로 `<selector>/<native-openai-model>` 행을 추가하고 선택기에서 bare native 행을
숨깁니다. Selector 이름은 사용자가 정하는 공개 label이며 내장된 계정 역할 의미가 없습니다. `selector`가
붙은 행을 선택하면 매핑된 계정만 사용하고 활성 Pool 계정은 바뀌지 않습니다. 대상 계정을 사용할 수 없으면
다른 계정으로 전환하지 않고 요청이 실패합니다. 자세한 내용은 [명시적 Codex 계정 selector](/reference/configuration/routing/#exact-codex-account-selectors)를
참고하세요.

계정 한정 행에서 `gpt-daybreak-blue-latest`는 계정 카탈로그에 관측됐을 때만 보존되며 bare native
allowlist에는 추가되지 않습니다. 이와 별개로 canonical Codex 로그인 forward provider에 다음과 같은
명시적 `customModels` 항목을 두면 같은 wire id를 `openai/gpt-daybreak-blue-latest`로 노출할 수 있습니다.

```json
{
  "customModels": [
    {
      "id": "daybreak-codex-forward",
      "provider": "openai",
      "modelId": "gpt-daybreak-blue-latest"
    }
  ]
}
```

정확히 이 provider, endpoint, model id 조합만 고정된 Sol capability snapshot을 상속합니다. 컨텍스트는
922,000, 자동 압축점은 922,000이며 native reasoning ladder와 Codex tool metadata도 보존됩니다. 요청의
wire id는 계속 `gpt-daybreak-blue-latest`이고 Sol로 다시 쓰지 않으며 bare 행이나 계정 사용 권한을 만들지
않습니다. 별도 과금 경로인 `openai-apikey/daybreak-blue-latest`의 1,050,000 / 922,000 한도는 Codex 로그인
행으로 복사되지 않습니다.

`codexAccountNamespaces` map이 비어 있으면 계정 한정 선택기 행은 꺼집니다. 비어 있지 않은 map에서
`codexAccountPickerEnabled`를 생략하면 이전 버전과의 호환성을 위해 활성화된 것으로 취급됩니다. `false`로
설정하면 매핑을 삭제하거나 명시적 `<selector>/<native-openai-model>` 라우팅을 비활성화하지 않은 채 생성된
qualified 행을 숨기고 선택기에 bare native 행을 복원합니다.

API GPT-5.6과 Daybreak 항목은 context 922,000 / max input 922,000을
쓰고, `*-pro` picker id는 로그, 사용량, picker 상태에는 가상 id를 유지한 채 wire에서는 base model과
`reasoning.mode: "pro"`로 풀립니다. API 카탈로그는 `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, 세 개의
Pro 가상 id, `daybreak-red-latest`, `daybreak-blue-latest`까지 정확히 열 개로 고정되어 있으며,
일반적인 `gpt-5.6-pro` 별칭은 없습니다. Compact 요청은
선택한 tier를 유지하되 reasoning 객체 없이 base model만 보냅니다.

선택기 id로 credential 경로를 명시적으로 선택하세요. Pool/Direct는 Providers 페이지에서 바꾸며,
아래 `<selector>`는 `codexAccountNamespaces`로 매핑한 사용자 지정 공개 label입니다:

```text
gpt-5.6-sol                         # Pool 또는 Direct를 통한 bare Codex 로그인 경로
<selector>/gpt-5.6-sol              # 해당 selector에 매핑된 저장된 Codex 계정
openai-apikey/gpt-5.6-sol           # API key
openai/gpt-daybreak-blue-latest     # 명시적 Codex-forward custom 행 (922,000)
<selector>/gpt-daybreak-blue-latest # 사용 가능할 때 관측되는 계정 한정 native id
openai-apikey/daybreak-blue-latest  # 별도 API-key 경로 (1,050,000 / 922,000)
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
| Codex 로그인(계정 한정 선택기 행 비활성) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` 같은 bare native id를 표시하고 `codexAccountMode`에 따라 Pool 또는 Direct를 사용합니다. GPT-5.6 행의 카탈로그 창은 922,000토큰입니다. |
| Codex 로그인(계정 한정 선택기 행 활성, 유효한 selector 있음) | 유효한 selector와 지원되는 native model의 각 조합마다 `<selector>/<native-openai-model>` 행을 표시합니다. 각 행은 매핑된 계정만 사용하며 bare native 행은 선택기에서 숨깁니다. Native metadata와 context window는 보존됩니다. |
| Codex 로그인(명시적 Daybreak forward 행) | canonical `openai` provider에 정확한 `customModels` 항목이 있을 때만 `openai/gpt-daybreak-blue-latest`를 표시합니다. Daybreak wire id를 유지하고 고정된 Sol capability snapshot(컨텍스트 922,000; 자동 압축점 922,000)을 사용합니다. |
| OpenAI(API key) | 정확히 열 개의 네임스페이스 행: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, 세 개의 `*-pro` 가상 id, 두 Daybreak 별칭 (모두 컨텍스트 922,000; 최대 입력 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (922,000) |
| Cursor | 정적 폴백에는 `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` (1,000,000)와 Grok 4.5/4.6의 일반·Fast 항목(500,000)이 들어갑니다. 4.6은 `xhigh`도 노출하며, 실시간 계정 탐색이 어떤 항목을 계속 보일지 정합니다. |
| xAI | 실시간 탐색이 기준입니다. 폴백 카탈로그에는 `xai/grok-4.6`이 포함되며 기본값은 `xai/grok-4.5`입니다. 두 모델 모두 컨텍스트 창은 500,000입니다. Grok 4.6은 `low` / `medium` / `high` / `xhigh`(업스트림 기본값: `high`)를 제공하고, Grok 4.5는 `high`까지만 제공합니다. |

고정된 GPT-5.6 항목은 업스트림 ladder를 그대로 보존합니다. Sol과 Terra는 `low`부터 `ultra`까지 노출하고,
Luna는 `max`에서 멈춥니다. Sol의 기본값은 `low`이고, Terra와 Luna의 기본값은 `medium`입니다. 명시적
Codex-forward Daybreak Blue 행도 wire id를 바꾸지 않은 채 Sol의 ladder와 기본값을 상속합니다. `ultra`는
최대 reasoning과 선제적 delegation을 묶은 클라이언트 선택지이며 백엔드에는 `max`로 전달됩니다. picker 항목이
보인다는 것은 카탈로그가 준비됐다는 뜻일 뿐입니다. 연결된 계정이나 API key에 실제 사용 권한이 있어야
합니다.

## 네이티브 및 라우팅 모델 토글

대시보드 Models 페이지는 bare native id와 routed `provider/model` id에 대한 `disabledModels` 토글을
제공합니다. Account-qualified `<selector>/<native-openai-model>` id도 `disabledModels`에서
지원하지만 대시보드는 exact selector 행을 표시하거나 토글하지 않습니다. 이 id는 구성에 직접
추가해야 합니다.

- Routed provider id는 네임스페이스 형식(`provider/model`)입니다. 비활성화하면 동기화된 카탈로그와
  `/v1/models`에서 제외됩니다.
- Account-qualified native id는 `<selector>/<native-openai-model>` 형식입니다. 이 id를
  `disabledModels`에 추가하면 해당 selector 행만 숨깁니다.
- Bare native GPT id는 bare slug입니다. 비활성화하면 나중에 다시 켤 수 있도록 카탈로그 항목은
  유지하면서 bare 행과 해당 모델의 모든 account-selector 복제 행을 숨깁니다.
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

Codex는 선택기에 보이는 카탈로그 항목을 `priority` 오름차순으로 정렬한 뒤 처음 다섯 개를
`spawn_agent` model override로 노출합니다. 대시보드 Subagents 페이지에서는 bare native id 또는
routed `provider/model` id를 최대 다섯 개 선택하고 저장할 수 있습니다. 수동으로 설정한
`subagentModels`는 account-qualified `<selector>/<native-openai-model>` id도 지원하지만,
대시보드는 이러한 exact id를 제공하지 않으며 페이지를 저장하면 목록이 대시보드에 표시되는 선택 항목으로
교체됩니다. opencodex는 선택한 순서대로 낮은 카탈로그 priority를 부여합니다. 계정 한정 선택기 행이
활성화되어 있으면 bare native 선택은 selector-qualified 그룹으로 확장됩니다. 다른 모델도 정확한 id로
직접 호출할 수 있습니다.

featured-model 목록은 Dashboard의 **Sub-agent delegation** 선택과 별개입니다. Codex가 먼저 보여 줄
override를 정할 뿐, 모델을 고르거나 delegation을 시작하지는 않습니다.

## Desktop 원격 서버

Codex Desktop의 원격 서버 모드는 클라이언트 자체 `available_models` 허용 목록으로 picker를
필터링합니다(원격 `use_hidden_models` 설정이 켜져 있을 때 적용). 라우팅된 카탈로그 항목은
여전히 로드되고 제공됩니다. `model/list`가 항목을 반환하고 번들 CLI도 읽을 수 있지만, Desktop
렌더러는 표시 전에 이 네이티브 전용 허용 목록에 없는 항목을 버립니다. opencodex는 이 목록에
개입할 수 없습니다. 업스트림 버그는
[openai/codex#19694](https://github.com/openai/codex/issues/19694)에서 추적됩니다.

Desktop이 허용 목록을 제어할 수 있게 될 때까지:

- 원격 머신의 `~/.codex/config.toml`에서 모델을 직접 설정하세요(예: `model = "input/grok-4.5"`).
  picker에는 `Custom`으로 표시될 수 있지만, 요청은 설정된 라우팅 모델을 계속 사용합니다.
- Desktop picker 대신 Codex CLI 또는 TUI를 사용하세요. 이들은 허용 목록을 적용하지 않으며
  라우팅 모델을 정상적으로 나열합니다.

## 모델 상태 새로고침
## 네이티브 쿼터 폴백 제한

Codex 앱이 네이티브 5시간 쿼터를 다 쓰면 리저브 폴백 모델로 넘어가면서 피커의 다른 줄을 회색으로 만들 수 있습니다. [#2813](https://github.com/lidge-jun/opencodex/issues/2813)에 보고된 이 차단은 opencodex가 넣은 라우팅 줄까지 가립니다. 그 줄들은 관계없는 프로바이더 자격 증명을 쓰고 ChatGPT 쿼터를 전혀 쓰지 않습니다.

이 차단은 요청이 프록시에 닿기 전에 클라이언트가 적용하므로 opencodex가 풀 수 없습니다. 라우팅 줄은 `visibility: "list"`로 기록되고, 카탈로그 필터링은 `disabledModels`와 프로바이더별 `selectedModels`만 봅니다. 쿼터 값은 라우팅 줄의 노출에 관여하지 않습니다.

라우팅 모델을 직접 지정하는 경로는 피커를 거치지 않습니다. `config.toml`에 모델을 적습니다.

```toml
model = "anthropic/claude-sonnet-5"
```

또는 바로 보냅니다.

```bash
ocx access test anthropic/claude-sonnet-5 --protocol responses
```

두 경로 모두 **요청이 프록시에 도달한 뒤에는** 정상 라우팅되고, 이건 테스트로 덮여 있습니다. 확인되지 않은 부분은 리저브 모드에서 앱이 설정한 모델을 실제로 보내는지입니다. 클라이언트가 보내기 전에 바꾸거나 거부하면 프록시 설정으로는 바꿀 수 없습니다. 명시적 지정은 확정된 우회책이 아니라 시도해 볼 방법으로 보세요.


picker에 오래된 항목이 계속 보이면 카탈로그를 새로 쓰고 대상 Codex 서피스를 다시 시작합니다:

```bash
ocx sync
```

opencodex는 카탈로그의 visibility, priority, metadata가 바뀔 때마다 `models_cache.json`을 의도적으로
오래된 cache wrapper로 다시 씁니다. 다음 Codex 모델 새로고침이 새 카탈로그를 읽도록 하기 위해서입니다.
