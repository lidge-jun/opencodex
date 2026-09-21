---
title: 네이티브 컨텍스트 호환성
description: Codex history·notes 중계의 지원 조건, 인증을 유지하는 시험 설정, 검증 범위와 한계.
---

OpenCodex에는 네이티브 Codex history·notes 중계가 이미 있습니다. 다른 제공자까지 사용할 수 있는
범용 메모리 서비스는 아닙니다. HTTP 경로가 존재한다고 모든 Codex 버전·계정·모델에서 동작하는
것도 아닙니다. 인증과 계정 소유권 규칙은 [Codex 통합](/ko/guides/codex-integration/)을 참고하세요.

## 서로 다른 두 가지 조건

Codex가 확장 기능을 활성화해야 하고, OpenCodex가 요청자를 식별할 수 있어야 합니다.
백엔드 URL만 바꾸면 두 조건이 모두 해결되는 것은 아닙니다.

확인한 Codex 소스에서는 모델의 네이티브 목록에 `supports_experimental_context`가 있어야 합니다.
적격 ChatGPT 로그인과 함께, 제공자 이름이 정확히 `OpenAI`이고 URL이 `/backend-api/codex`로
끝나야 합니다. `env_key`, `experimental_bearer_token`, 명령형 `auth`, AWS 인증이 설정된 제공자는
자동 활성화 대상에서 제외됩니다. 확인한 적격성 검사에는 ChatGPT Plus·Pro·ProLite가 포함되지만,
해당 요금제의 모든 계정에서 실제 history 백엔드가 동작한다는 뜻은 아닙니다.

OpenCodex는 성공한 모델 요청과 후속 컨텍스트 요청 모두에 유효한 **데이터 요청용 API 키**를
요구합니다. 기본 내장 loopback 연결은 이 키를 보내지 않으므로 모델 응답은 성공해도
컨텍스트 요청은 403 `context_principal_required`로 거부될 수 있습니다. 인증형 원격 제공자 설정도
그 자체로 해결책은 아닙니다. 해당 설정의 `env_key`와 제공자 이름은 위 Codex 조건과 맞지 않습니다.
이를 해결한다며 요청자 식별이나 계정 소유권 검사를 제거해서는 안 됩니다.

## 명시적 활성화 형식

OpenCodex는 Codex의 `FeatureToml`과 같이, 저장된 루트 기능 설정에서 두 형식을 인식합니다.

```toml
[features]
context_management = true
```

다음 표 형식도 같습니다. 불리언 형식을 아직 인식하지 않는 이전 OpenCodex 버전에서는
이 형식을 사용해야 합니다.

```toml
[features.context_management]
experimental_mode = true
```

둘 중 하나만 사용하세요. false·누락·잘못된 값은 비활성화 상태로 남습니다. 프록시는 자신의
Codex 홈 설정 파일을 읽으므로 CLI 인자로만 켜거나 프로필 안에만 켠 것으로는 중계가 활성화되지
않습니다. 모델 정보만 보고 사용자의 활성화 의사를 추정하지도 않습니다.

## 인증을 유지하는 네이티브 시험 프로필

아래 설정은 **소스의 조건을 대조한 시험 예제이며 실제 계정의 전체 동작을 인증한 결과가 아닙니다.**
설정 파일과 작업 체크포인트를 먼저 보관하고, 버려도 되는 새 대화에서 시험하세요.
기존 작업 대화의 제공자 식별자를 바꾸지 마세요.

현재 유효한 OpenCodex 데이터 요청용 키를 Codex 프로세스의 `OCX_CONTEXT_API_KEY` 환경변수로
전달하세요. 관리용/admin 토큰을 사용하거나 키를 TOML에 직접 기록하면 안 됩니다.
서비스의 환경변수가 별도로 실행한 데스크톱 앱에 자동 전달되는 것도 아닙니다.
Codex의 정상적인 ChatGPT 로그인은 유지해야 합니다. 추가 헤더는 OAuth 로그인을 대체하지 않습니다.

위 루트 기능 설정, OpenCodex의 정식 ChatGPT forward 제공자, 최신 네이티브 모델 목록이 준비된
상태에서 아래 제공자와 프로필을 기존 Codex 설정에 **추가**하세요. 포트는 실제 로컬 프록시에
맞추고, 루트 `model_provider`와 기존 제공자 표는 바꾸지 마세요.

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

`codex --profile ocx-native-context`로 새 CLI 대화를 시작합니다. 초기 시험은 모델 요청에서 중계로
이어지는 소유권 경로를 확인하기 위해 HTTP/SSE를 사용합니다. 다른 프로필의 통신 방식은 바꾸지
않으며 WebSocket·실행 중 지시 추가 기능의 동등한 동작까지 보장하지 않습니다. 실제 계정의
네이티브 모델 목록에 컨텍스트 지원 정보가 있을 때만 해당 모델을 사용하세요. Devin·Gemini 등
다른 제공자 모델에 지원 표시를 강제로 붙이면 안 됩니다.

별도 제공자 ID를 쓰는 이유가 있습니다. Codex는 일반적으로 `model_providers.openai` 설정으로
내장 제공자를 덮어쓰지 않으므로 그곳에 헤더를 추가해도 적용되지 않을 수 있습니다.
별도 ID는 기존 제공자를 유지하고, 정확한 `OpenAI` 이름은 네이티브 백엔드 조건을 충족시킵니다.
이 프로필에 `env_key`를 추가하지 마세요. `env_http_headers`는 로컬 요청자 식별을 담당하고,
`Authorization`은 기존 ChatGPT 로그인을 유지합니다. 로컬 키는 OpenCodex에서 사용하며
ChatGPT로 전달하지 않습니다.

루트 활성화 설정은 다른 적격 네이티브 프로필에도 영향을 줍니다. **시험 중에는 추가 키를 보내지
않는 기본 내장 loopback 대화로 원래 작업을 계속하지 마세요.** 그 대화로 돌아가기 전 루트 기능을
끄고 `ocx sync`를 실행하세요. 자동 활성화나 기본 연결 방식 변경이 아니며, CLI 프로필 예제가
데스크톱 앱의 프로필 선택 지원을 뜻하는 것도 아닙니다.

## 컨텍스트 초기화 전 검증

새 대화에서 정상적인 네이티브 모델 응답을 먼저 받아야 합니다. 이어서 메모를 쓰고 같은 내용을
다시 읽은 뒤 그 대화의 history를 조회하세요. 이 단계들이 성공한 후에만 시험용 대화에서
`new_context`를 사용하고 저장한 상태가 복원되는지 확인하세요. 성공해도 외부 체크포인트는 유지합니다.

- **403 `context_principal_required`:** 유효한 로컬 데이터 요청용 키가 프록시에 전달되지 않았습니다.
- **409 `context_account_unavailable`:** 소유권이 없거나 일치하지 않습니다. 현재 활성 계정으로
  임의 대체하거나 메모 쓰기를 무작정 재시도하지 마세요.
- **404:** 프록시의 비활성화·알 수 없는 경로 오류와 실제 상류 서버의 404를 구분해야 합니다.
  상류 404만으로 OpenCodex 경로 결함이나 계정 전체 장애라고 판단할 수 없습니다.

모델 응답 또는 `ocx ready` 성공만으로 notes·history·상태 복원이 검증되지는 않습니다.
라우팅, 계정 변경, 프록시 재시작, 상류 경로의 가용성은 별도 조건입니다. 로컬 설정으로 없는
상류 권한을 만들 수 없으며, 컨텍스트 작업 실패를 초기화 성공으로 처리해서도 안 됩니다.
시험 후 프로필·제공자 표와 시험용 환경변수를 제거하고, 검증된 인증 경로를 쓸 때가 아니면
기능을 비활성화하세요.

확인한 upstream 소스와 정확한 커밋은 [영문 문서의 근거](/guides/codex-native-context/#upstream-contracts-inspected)에 있습니다.
