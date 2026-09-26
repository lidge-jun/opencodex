---
title: Cursor Private Inference
description: 공개 터널 없이 macOS, Windows, Linux의 Cursor 로컬 에이전트 빌드에서 opencodex 라우팅 모델을 사용합니다.
---

일반 Cursor는 사용자 컴퓨터의 프록시와 직접 통신할 수 없습니다. "Override OpenAI Base URL"을 설정하면 Cursor 백엔드가 프롬프트를 만들고 Cursor 서버에서 해당 URL을 호출합니다. 이 서버는 loopback, LAN, 사설 주소를 거부합니다. Cursor와 로컬 모델을 연결하는 커뮤니티 방법마다 ngrok, Cloudflare Tunnel, VPS가 필요한 이유입니다.

Cursor는 에이전트 루프를 로컬에서 실행하고 사용자가 설정한 OpenAI 호환 게이트웨이를 호출하는 두 번째 데스크톱 빌드인 **Cursor Private Inference**도 제공합니다. opencodex를 지정하면 터널, 앱 패치, TLS 없이 라우팅 모델을 사용할 수 있습니다. 이 문서는 해당 빌드를 다룹니다.

## 시작하기 전에

놓치기 쉬운 부분이니 먼저 읽어보세요.

- **opencodex는 이 빌드를 배포하지 않습니다.** Cursor도 문서화하지 않았습니다. cursor.com에서 링크하지 않으며, 예고 없이 바뀌거나 제공이 중단될 수 있습니다. 아직 갖고 있지 않다면 이 가이드는 적용되지 않습니다. 대신 공개 HTTPS 엔드포인트와 커뮤니티 [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) 브리지를 사용하세요.
- **Cursor 로그인은 여전히 필요합니다.** 로그인 화면이 게이트웨이 설정 창보다 먼저 나옵니다.
- **Cursor 자체 모델은 사용할 수 없습니다.** 로컬 모드의 선택기에는 게이트웨이가 반환한 모델만 나옵니다. Tab 자동 완성, Cursor 카탈로그(Composer, Auto), Cloud Agents는 꺼집니다. 해당 프로바이더를 설정했다면 opencodex의 `cursor/*` 경로를 통해 Cursor 프로바이더 모델을 사용할 수는 있습니다.
- **매 요청에는 Cursor의 로컬 시스템 프롬프트가 포함됩니다.** 두 번째 요청부터는 대략 23k 토큰입니다. 모델을 고를 때 이를 고려하세요.
- **일반 Cursor와 사용자 데이터를 공유합니다.** 번들 ID와 `~/.cursor`가 같고, macOS의 `Application Support/Cursor`, Windows의 `%APPDATA%\Cursor`, Linux의 `~/.config/Cursor`도 공유합니다. 둘을 분리하려면 `--user-data-dir <dir>`로 실행하고, 설정을 복사할 생각이 없다면 첫 실행 때 "Import data from existing Cursor installation"을 선택하지 마세요.

## 설치된 빌드 확인하기

두 빌드 모두 Dock에서 "Cursor"로 표시되고 번들 ID도 같으므로 `product.json`을 확인하세요.

| 플랫폼 | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (AppImage라면 먼저 압축을 풀어야 합니다) |

로컬 에이전트 빌드에서는 `nameLong`이 `"Cursor Private Inference"`, 일반 빌드에서는 `"Cursor"`입니다. `version`은 빌드 버전이며, 작성 당시에는 3.18.25였습니다. 대시보드의 Integrations > Cursor 카드도 같은 검사를 실행해 발견한 빌드를 나열합니다. 로컬 모드는 `product.json`이 아닌 워크벤치 번들 안에서 켜지므로 뒤집을 수 있는 플래그가 없습니다. `nameLong`이 일반 Cursor를 가리키면 해당 설치본은 loopback 게이트웨이에 연결할 수 없습니다.

게이트웨이와 통신하는 에이전트 루프는 같은 설치 루트의 `extensions/cursor-agent-exec/dist/main.js` 파일에 있습니다. opencodex는 이 파일을 제한된 범위에서 읽기 전용으로 살펴보고 Cursor의 추론 강도 표를 파악합니다. 아래 "모델과 추론 강도"를 참고하세요.

## 게이트웨이 설정하기

먼저 opencodex가 실행 중이어야 합니다(`ocx service status`). 다음 두 방법 중 어느 것을 써도 같은 설정으로 이어집니다.

**앱에서 설정하기.** Settings → Models → Gateway → Configure gateway:

| 필드 | 값 |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1` (`/v1`을 포함하세요. loopback의 일반 `http://`도 허용됩니다) |
| API Key | 서비스에서 API 인증을 사용한다면 `OPENCODEX_API_AUTH_TOKEN` 값, 아니면 `opencodex-loopback` 같은 임의의 자리표시자 |

**Refresh model list**를 누르세요. 선택기에 opencodex의 `/v1/models`가 표시되면 원하는 행을 켭니다.

**환경 변수로 설정하기.** 앱은 시작할 때 다음 값을 읽습니다.

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS`는 `User-Agent`와 해석되지 않은 `{...}` 자리표시자를 거부합니다. `{gitOrgRepo}`와 `{gitBranch}`는 실제 값으로 확장합니다.

우선순위는 높은 순서대로 모델별 인증 정보 → Settings에 저장한 게이트웨이 → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`(호환성 폴백)입니다. 환경 변수는 저장된 게이트웨이를 덮어쓰지 않으므로 환경 변수로 전환하려면 먼저 Settings에서 저장된 값을 지우세요.

Cursor Private Inference는 GUI 앱이므로 대화형 셸 프로필만 설정해서는 부족합니다. 앱을 실행하는 프로세스의 환경에 변수가 있어야 합니다.

| OS | 설정 위치 |
|---|---|
| macOS | 현재 로그인 세션에는 `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`을 사용합니다. 유지하려면 `EnvironmentVariables`가 있는 LaunchAgent를 사용하세요. 터미널에서 앱을 시작해도 됩니다. |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`(사용자 범위, 새 프로세스에 적용) 또는 System Properties → Environment Variables를 사용합니다. 그 뒤 앱을 다시 시작하세요. |
| Linux | 디스플레이 관리자 세션에서는 `~/.profile`이나 `~/.pam_environment`를, 데스크톱이 사용자 systemd 세션에서 실행된다면 `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1`을 사용합니다. 터미널에서 실행한 AppImage는 해당 셸의 환경을 상속합니다. |

이 빌드는 macOS(arm64, x64, universal), Windows(x64, arm64), Linux(x64, arm64)에서 제공됩니다. 설정 방법은 모두 같습니다.

## 대시보드에서 확인하기

opencodex 대시보드의 Integrations 아래에 **Cursor** 탭이 있습니다(`/#integrations/cursor`). Cursor에 대해서는 읽기 전용으로 동작합니다. Cursor 설정 데이터베이스, 키체인 항목, 앱 번들에 쓰지 않으므로 켜고 끌 스위치도 없습니다. 대신 필요한 값을 알려주고 적용 여부를 보여줍니다.

- **설치된 빌드.** Cursor Private Inference의 경로와 버전, 일반 Cursor의 경로를 표시합니다. 일반 Cursor만 발견되면 탭은 Cursor 자체 업데이트 채널(`api2.cursor.sh`의 `cursor-local` 채널)에 이 플랫폼과 CPU용으로 안내되는 local-mode 설치 프로그램을 조회하고, 그 버전과 `downloads.cursor.com/local-mode/` 설치 프로그램 링크를 표시한 뒤 이 문서로 연결합니다. opencodex는 링크를 보여 줄 뿐이며 아무것도 다운로드, 실행, 설치하지 않습니다. 응답은 30분 동안(실패 시 5분) 캐시됩니다. 채널에 연결할 수 없거나, 쓸 수 없는 응답이 오거나, Cursor가 이 컴퓨터용 빌드를 제공하지 않으면(Windows, macOS, Linux의 x64와 arm64만 제공) 설치 프로그램을 확인할 수 없다고 표시합니다. 아래 게이트웨이 값은 어느 경우에나 유효합니다. 일반 Cursor 자체는 여전히 사용자 지정 엔드포인트를 Cursor 서버를 통해 호출하므로 loopback 프록시에 연결할 수 없습니다.
- **게이트웨이 값.** 프록시가 실제로 듣는 포트의 Base URL과 Copy 버튼을 표시합니다. 이 값은 런타임 기록에서 가져오므로 역방향 프록시를 거친 대시보드에서도 이 컴퓨터의 Cursor가 접근할 수 있는 포트가 표시됩니다. API Key 행은 바인딩 방식에 따라 달라집니다. 인증 정보가 필요 없으면 Copy 버튼과 함께 `opencodex-loopback`이 표시됩니다. API 인증을 사용하거나 opencodex API 키를 하나라도 설정했다면 자신의 키를 사용하라고 안내하고 API Keys 탭으로 연결합니다. 설정된 키라면 `OPENCODEX_API_AUTH_TOKEN`이 아니어도 됩니다.
- **연결 상태.** User-Agent가 정확히 `Cursor/<version>`인 마지막 `/v1/models` 요청의 시각과 버전을 표시합니다. 이 헤더는 Cursor 로컬 에이전트 런타임이 보냅니다. Cursor가 프록시를 호출하기 전까지는 "never seen"으로 표시되며, Cursor에서 **Refresh model list**를 누르면 상태가 바뀝니다. 탭이 열려 있는 동안 카드는 15초마다 갱신됩니다.
- **Cursor에 표시될 항목.** opencodex가 광고하는 모델의 Model / Reasoning / Context 표입니다. 비활성 모델과 프로바이더 허용 목록이 원본 목록과 동일하게 적용됩니다. 다음 절의 규칙에 따른 예측값이며, Reasoning 단계는 Cursor 자체 표에서 고릅니다.

## 모델과 추론 강도

선택기에는 opencodex의 원본 `/v1/models` 목록이 표시됩니다. 모델 행에 **Reasoning** 컨트롤이 붙으려면 두 조건을 충족해야 합니다.

1. opencodex가 행에 기능 정보(`api_types`와 `capabilities` 객체)를 광고해야 합니다. v2.41부터는 광고합니다. 이전 프록시에는 모델은 보이지만 강도 컨트롤은 없습니다.
2. 모델 ID에서 마지막 `/` 앞부분과 `@…` 접미사를 제거한 값이 Cursor 자체 강도 표와 일치해야 합니다. 이 표는 앱의 `extensions/cursor-agent-exec/dist/main.js`에 컴파일되어 있습니다. opencodex는 감지된 설치본에서 이를 읽어 대시보드 예측값을 Cursor 업데이트에 맞추며, 카드에는 읽은 빌드 또는 빌드를 찾지 못했을 때 "static mirror"가 표시됩니다. 단계는 opencodex가 아니라 Cursor가 결정합니다. 어떤 `/v1/models` 필드로도 이 표에 모델을 추가할 수 없습니다. 아래 표는 정적 미러에 포함된 3.18.25 스냅샷입니다.

| 모델 ID(마지막 `/` 뒤) | Cursor에 표시되는 단계 | 전송 필드 |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Low, Medium, High, Extra High(낮음부터 매우 높음까지) | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Low, Medium, High, Extra High(낮음부터 매우 높음까지) | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Low, Medium, High, Extra High, Max(낮음부터 최대까지) | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Low, Medium, High, Max(낮음부터 최대까지) | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Minimal, Low, Medium, High, Extra High(최소부터 매우 높음까지) | `reasoning_effort` |
| `gemini-*` (`supports_reasoning` 필요) | Minimal, Low, Medium, High | `reasoning_effort` |
| 그 밖의 모델(`claude-fable-5-1`, `kimi-k3` 포함) | 컨트롤 없음 | — |

따라서 `anthropic/claude-opus-5`는 사용할 수 있지만, 이 선택기에서는 GPT-5.6에 대한 opencodex의 `max`/`ultra` 단계를 선택할 수 없습니다.

### 컨트롤이 없는 모델

`anthropic/claude-fable-5-1`, `cursor/kimi-k3`와 표에 없는 다른 모델에는 Reasoning 컨트롤이 없습니다. 게이트웨이가 `supports_reasoning`을 광고하면 Cursor는 해당 ID마다 "Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family"라는 로그를 한 줄 남깁니다. 그래도 강도를 고르는 방법은 두 가지입니다.

- **강도별 행**(opencodex 설정의 `cursorEffortRows: true`, 기본값은 꺼짐): 표에 없는 모델마다 `anthropic/claude-fable-5-1--high`나 `cursor/kimi-k3--max`처럼 강도별 선택기 항목을 게시하고, 선택한 강도를 적용해 기본 모델로 라우팅합니다. Cursor가 이미 컨트롤을 표시하는 모델에는 행을 추가하지 않습니다. 정확히 일치하는 알려진 모델 ID는 언제나 `--<effort>` 접미사보다 우선합니다. 켠 뒤 Refresh model list를 누르세요. 대시보드 카드는 모델별 게시 행 수를 표시합니다. 행 선택은 명시적 선택이므로 요청 안의 `ocx-effort` 지시보다 우선합니다.
- **고정 기본값**(프로바이더의 `modelDefaultReasoningEfforts`): Cursor가 강도를 보내지 않을 때 적용됩니다.

### "Max"의 두 가지 의미

일반 Cursor에서는 일부 모델 옆에 **Max** 토글이 표시됩니다. 이는 추론 단계가 아니라 더 큰 컨텍스트 창을 쓰는 Max Mode입니다. 로컬 에이전트 빌드에서는 같은 개념이 모델 메뉴의 **Context** 항목에 나타납니다. opencodex는 네이티브 GPT-5.6 계열에서 **272K**(기본값) 또는 **922K**(비용이 더 높다고 표시되는 1M 옵트인)를 활성화합니다. 선택한 값은 해당 요청의 컨텍스트 상한이 됩니다. 라우팅 모델에는 단일 창만 표시되고 Context 항목은 없습니다. 프로바이더의 컨텍스트 상한이 922K보다 낮으면 네이티브 행에서도 항목이 사라집니다.

추론 강도 **Max**(opencodex의 `max`/`ultra`)는 다른 의미이며, 여기서는 선택할 수 없습니다. Cursor가 게이트웨이 대신 자체 표에서 강도 단계를 가져오고 GPT-5.6 항목은 Extra High에서 끝나기 때문입니다.

opencodex가 `api_types`에 `responses`를 광고하므로 이 빌드는 에이전트 요청을 `/v1/chat/completions`가 아닌 `reasoning.effort`를 포함한 `/v1/responses`로 보냅니다.

이 전송 선택에는 Claude 행에 대한 부작용이 있습니다. Cursor는 Anthropic Messages 전송 방식에서만 Claude 강도를 `output_config.effort`로 보냅니다. 따라서 Base URL이 `/v1`이면 컨트롤이 표시되는 Claude 행도 프로바이더 기본 강도로 실행됩니다. Base URL이 `/messages`로 끝나면 반대가 됩니다. Claude 강도는 전송되지만 OpenAI 계열 강도는 빠집니다. 하나의 게이트웨이 항목으로 두 계열을 모두 처리할 수 없습니다. 위의 강도별 행을 사용하면 opencodex가 직접 강도를 적용하므로 이 문제를 피할 수 있습니다.

## 확인하기

`ocx observe logs`에서 요청이 `inboundProtocol: responses`와 `admissionKind: loopback`으로 표시됩니다.

| 증상 | 확인할 사항 |
|---|---|
| 게이트웨이에서 401 응답 | API Key가 `OPENCODEX_API_AUTH_TOKEN`과 일치하지 않습니다. API 인증 없는 loopback 바인딩이라면 어떤 값이든 됩니다. |
| 선택기가 비어 있음 | opencodex가 실행 중이지 않거나 Base URL에 `/v1`이 빠졌습니다. 수정한 뒤 Refresh model list를 누르세요. |
| 모델은 보이지만 Reasoning 컨트롤이 없음 | opencodex가 v2.41보다 이전 버전이거나 ID가 Cursor 표에 없습니다(대시보드에는 —로 표시). `cursorEffortRows`를 켜거나 프로바이더 기본값을 설정하세요. |
| 스키마 변경이 반영되지 않음 | Cursor는 Base URL 문자열별로 `/models`를 만료 없이 캐시합니다. Refresh model list를 누르면 다시 읽습니다. 그렇지 않으면 앱을 재시작하거나 URL을 다른 표기(`localhost`와 `127.0.0.1`)로 잠시 저장하세요. |
| 첫 요청에 23k 토큰 사용 | 예상된 동작입니다. Cursor의 로컬 시스템 프롬프트가 포함됩니다. |
