---
title: Grok Build 안내
description: xAI의 Grok Build CLI에서 opencodex로 라우팅되는 모든 모델을 사용합니다. 프로세스가 실행되는 동안 모델은 `~/.grok/config.toml`에 자동 등록됩니다.
---

opencodex는 로컬 포트에서 OpenAI 호환 `POST /v1/chat/completions`(및 `/v1/responses`)를 제공합니다. Grok Build는 OpenAI 호환 서버를 상대로 사용자 정의 모델을 지원합니다. 이 통합은 opencodex가 노출하는 전체 카탈로그를 Grok Build에 자동 등록합니다. 수동으로 설정 파일을 편집할 필요가 없습니다.

## 자동 등록

`~/.grok`가 있으면 `ocx start`(그리고 `ocx ensure` / `ocx restart`)가 `~/.grok/config.toml`에 관리 블록을 씁니다:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **추가형:** 펜스 밖에 있는 사용자 설정은 절대 건드리지 않습니다. 기존 파일에 처음 넣기 전에 한 번만 `~/.grok/config.toml.bak-opencodex`에 백업을 남깁니다.
- **멱등적:** `ocx start`를 실행할 때마다(자동 시작이 켜진 상태에서는 `ocx ensure`도) 현재 카탈로그로 펜스 블록을 다시 씁니다.
- **종료 시 제거:** `ocx stop`, `ocx eject`, `ocx uninstall`, 그리고 서비스가 아닌 데몬을 정상 종료할 때는 펜스 블록을 지우고 파일을 바이트 단위까지 원래대로 복원합니다. 서비스 관리자 아래에서는 종료가 `ocx stop`/`ocx uninstall`을 거칩니다(서비스 모드 프로세스는 재생성될 때도 블록을 의도적으로 유지합니다).
- **충돌 안전:** 이미 사용자 정의 `[model.*]` 테이블에 정의된 별칭은 존중합니다(opencodex는 자체 항목에 접미사를 붙입니다). 손상된 펜스(시작 표시는 있는데 끝 표시는 없는 경우)는 자동 변경을 거부하고 수동 복구를 요청합니다.

그다음 Grok Build에서 모델을 고릅니다:

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## 추론 강도

Grok Build의 `/effort`(및 `--effort`)는 카탈로그 항목이 추론 단계 목록을 제공하는
모델에서 동작합니다. 모델 목록은 원시 `GET /v1/models` 응답을 읽으며, 항목에는
`supports_reasoning_effort`와 `reasoning_efforts` 메뉴 선택지가 있어야 합니다. 단계 목록을
Grok 호환 형태로 투영한 결과가 각 관리형 `[model.*]` 테이블에도
`supports_reasoning_effort`, 기본
`reasoning_effort`, `[[model.<alias>.reasoning_efforts]]` 선택 행으로 기록됩니다.
라우팅 모델의 경우 opencodex는 설정된 공급자 단계(`reasoningEfforts` /
`modelReasoningEfforts`와 `modelDefaultReasoningEfforts`의 기본값)를 반영합니다. 이
메타데이터는 프록시에 설정된 라우팅 단계를 설명하며, 어댑터는 추론을 에뮬레이션하거나
단계를 공급자 전용 필드로 매핑할 수 있습니다. 단계 목록이 비어 있는 모델은 effort
컨트롤을 표시하지 않습니다. 네이티브 GPT-5.6 항목은 고정된 업스트림 추론 단계를
유지합니다. 모델이 제공하는 유효한 Grok 단계는 `none`과 `minimal`을 포함해 유지됩니다.
Codex 전용 `ultra`를 포함해 지원되지 않거나 중복된 단계는 파일에서 제외되어 기록된
모든 선택지는 실행 가능합니다.

Grok Build는 Responses API를 통해 opencodex와 통신합니다. 라우트가 추론 단계 목록을
광고하면 Responses passthrough가 설정된 대로 `reasoning.summary`를 전달하므로 추론
트레이스가 Responses reasoning 항목으로 Grok에 그대로 도착합니다. 모델은 추론하되
트레이스를 반환하지 않게 하려는 클라이언트는 `reasoning.summary: "none"`을 설정할 수
있습니다. 명시적인 `reasoning.summary`는 라우트 기본값보다 우선합니다.

## 인증 참고

Grok Build는 루프백에서도 사용자 정의 모델에 비어 있지 않은 API 키를 요구합니다. 주입되는 항목에는 자리표시자(`opencodex-loopback`)가 들어갑니다. opencodex는 루프백 연결의 admission key를 무시하므로 실제 비밀값은 들어가지 않습니다.

**자동 등록은 루프백 전용입니다.** opencodex가 비루프백 호스트에 바인드하면, 모든 인터페이스를 노출하는 와일드카드 `0.0.0.0`와 `::`를 포함해 요청은 실제 admission token을 필요로 하고, 관리 블록은 그 값을 안전하게 담을 수 없습니다. 토큰을 그대로 쓰면 비밀값이 `~/.grok/config.toml`에 들어가고, 다음 `ocx start`/`ensure`/`restart` 때 그 자리에 있던 값이 덮어써집니다. 그래서 opencodex는 그런 경우 아무 것도 쓰지 않고(이전에 루프백 바인드가 남긴 블록도 제거합니다), 사용자는 관리 마커 바깥에서 모델을 직접 설정해야 합니다. 이 위치에서는 opencodex가 어떤 일을 해도 그 설정을 덮어쓸 수 없습니다. 정확한 테이블은 [수동 설정](#manual-recipe-without-auto-registration)을 보시고, `base_url`(실제로 `grok`가 도달할 수 있는 호스트)과 `api_key`(사용자의 `OPENCODEX_API_AUTH_TOKEN`)를 함께 설정합니다.

여기서는 `api_key`를 `env_key`로 바꾸지 마십시오. `env_key`가 해결되지 않아도 요청은 멈추지 않습니다. Grok가 사용자의 xAI 세션 토큰으로 넘어가서 항목이 가리키는 `base_url`로 보냅니다. LAN 배포에서는 그 `base_url`이 xAI가 아닌 평문 HTTP 엔드포인트입니다.

provider 항목에 주입된 `api_key`는 이 모델들에 대한 Grok의 자격 증명 체인에서 가장 먼저 사용되므로, opencodex를 대상으로 하는 요청에는 추가 Grok 로그인이 필요하지 않습니다. xAI에 직접 접속하는 네이티브 grok 모델과 모든 하니스 기능에는 평소 쓰던 `grok login` / `XAI_API_KEY` 구성을 그대로 유지합니다.

## 수동 설정 (자동 등록 없음)

직접 `~/.grok/config.toml`를 관리하거나 opencodex가 비루프백 호스트에 바인드되어 있다면, `# >>> opencodex managed block` 마커 바깥에 `[model_providers.opencodex]` 블록과 이를 참조하는 모델별 테이블을 추가합니다:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

네트워크에서 닿을 수 있는 프록시라면 `base_url`을 `grok`가 실제로 연결할 수 있는 주소로 두고 승인 토큰을 사용합니다:

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

관리 블록은 이제 `[model_providers.<id>]` 상속을 사용하며, Grok Build 0.2.109 이상(2026-07-21 출시)이 필요합니다. 이전 버전에서는 상속된 `base_url`이 추론 라우팅에 적용되지 않습니다 — 업그레이드하거나, 각 `[model.*]` 테이블에 모델별 직접 필드(`base_url`/`api_backend`/`api_key`)를 사용하세요.

점이 들어간 별칭은 반드시 따옴표로 감쌉니다. 대괄호만 쓴 `[model.grok-4.5]`는 id `grok-4.5`가 아니라 세 구간짜리 키 경로입니다. 생성된 별칭은 이런 이유로 점을 아예 쓰지 않습니다.

## 알려진 제한

- **서비스 설치된 `ocx restart`:** 실행 중인 프록시는 재시작 권한 확인과 드레인 조정을 담당하고, 기존 프로세스가 종료된 뒤 설치된 서비스 관리자가 교체 프로세스를 시작합니다. 서비스 감독은 그대로 유지됩니다. 루프백 자동 등록을 사용하는 경우에만 관리 블록도 핸드오프 동안 유지되며, 비루프백 배포에서는 Grok 설정을 수동으로 관리합니다. 같은 포트에서 신원이 확인된 다른 프로세스가 정상 상태가 된 뒤에만 명령이 성공합니다.
- **설정 읽기 시점:** 가장 예측 가능한 결과를 얻으려면 opencodex를 먼저 시작하고 그다음 `grok`를 실행합니다. Grok Build는 `~/.grok/config.toml`을 감시하다가 `[model]` 테이블이 실제로 바뀔 때 다시 불러옵니다(내용을 기준으로 비교하는 약 1초 디바운스). 그래서 새로 고친 블록은 재시작 없이 열린 세션에도 들어갑니다. Grok가 무엇을 파싱했는지 확인하려면 `grok inspect`를 실행합니다. 이 명령은 로드한 설정 원본을 나열하고 거부한 필드가 있으면 경고합니다. 해석된 모델 목록은 출력하지 않습니다. 현재 Grok Build는 잘못된 모델 필드를 경고와 함께 건너뛰고 나머지 모델 항목을 유지합니다. TOML 구문 오류가 있으면 파일을 불러올 수 없습니다. opencodex는 파일을 원자적으로 기록하므로 Grok는 다시 읽을 때마다 완전한 문서를 봅니다.
- **카탈로그 업데이트:** 펜스 블록은 주입 시점의 카탈로그를 반영합니다. 공급자나 모델을 추가한 뒤에는 `ocx ensure`를 실행하거나 프록시를 재시작해 갱신합니다.
