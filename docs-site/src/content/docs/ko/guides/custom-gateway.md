---
title: 사용자 지정 원격 게이트웨이 검증
description: 모델 목록 조회부터 제한된 응답 생성까지 사용자 지정 게이트웨이를 확인합니다.
---

등록 전에 운영자로부터 사용이 허가된 Chat Completions 베이스 URL, API 키, 지원 모델 ID를 확보하세요.
예를 들어 `https://api.example.com/v1`은 실제 엔드포인트가 아닌 자리표시자입니다. 프록시가 꺼져 있다면
시작한 다음 대시보드에서 **Custom**을 선택하고 이름을 `my-gateway`, 어댑터를 `openai-chat`으로 정한 뒤
허가된 URL과 키를 입력하고 저장하세요. 키를 명령이나 공유 예시에 넣지 마세요. 저장 성공만으로 모델 목록 조회나
추론 성공이 증명되지는 않습니다.

[Remote Link](/ko/guides/remote-link/) Child에서는 provider를 Home에서 가져옵니다. Child 대시보드는 provider 변경을
거부하고, 요청은 Home의 provider가 처리합니다. 게이트웨이 등록과 검증은 Home에서 하세요.

각 단계를 따로 확인하세요. 기본 포트가 아니면 설정한 로컬 포트를 사용합니다.

```sh
curl -fsS http://127.0.0.1:10100/healthz
ocx ready
ocx provider test my-gateway
ocx models live --provider my-gateway --json
```

Health와 readiness는 프록시 상태이며 업스트림의 텍스트 생성 성공을 뜻하지 않습니다. `--model` 없는
provider test는 추론이 아닌 모델 목록 조회를 검사합니다. 정적 카탈로그에 실시간 모델 조회 엔드포인트가 없으면
`applicable: false`가 나올 수 있으며 이는 추론 성공이 아닙니다. 공개 모델 목록의 성공도 키 유효성을
증명하지 않을 수 있습니다. 모델 목록 조회가 실패하거나 모델이 없다면 선택 전에 URL, 자격 증명, 업스트림 접근 권한과
프로바이더 설정을 확인하세요.

게이트웨이는 모델 목록 엔드포인트가 없어도 응답을 생성할 수 있습니다. 운영자가 지원하는 원본 ID를 제공했다면
기존 프로바이더의 다른 필드는 유지하고 `liveModels: false`, `models: ["vendor/model"]`을 설정하세요.
예시 ID는 제공받은 정확한 값으로 바꿉니다. [정적 모델 설정](/ko/reference/configuration/providers/)을 참고하세요.

`config.json`을 직접 수정하기 전에 작업을 저장하고 진행 중인 요청이 끝날 때까지 기다리세요. 프록시를 중지하면
진행 중인 요청이 중단될 수 있습니다. 관리 주체에 따라 Desktop 트레이에서 OpenCodex를 종료하거나, 서비스 설치는
`ocx service stop`, 감독되지 않는 프록시는 `ocx stop`으로 중지하세요. 중지된 것을 확인한 뒤 다른 설정 쓰기 작업을
실행하지 않는 상태에서 파일을 수정하고 저장합니다. 같은 관리 주체로 다시 시작하세요: Desktop을 다시 열거나,
`ocx service start`를 실행하거나, 기존 `ocx start` 명령과 실행 옵션을 사용합니다. 직접 지정한 `--port`도
포함합니다. 포그라운드 시작 명령은 해당 터미널에서 계속 실행하고 다른 터미널에서 `ocx sync`와 나머지 검사를
실행하세요. 그다음 live 카탈로그를 다시 확인합니다. 또는 아래 비용 확인을 거치는 응답 생성 명령에
제공받은 원본 ID를 직접 사용할 수 있습니다. 이 테스트에는 카탈로그 행이 필요하지 않습니다.

live 카탈로그에서 실제 `id`, `namespaced`, `disabled`, `initialSelectionPending`을 확인하세요.
초기 선택에 따라 모델이 꺼져 있거나 대기 상태일 수 있습니다. [초기 모델 선택](/ko/reference/configuration/providers/)을
참고하세요. 행을 켜기 전에 초기 선택의 대기 상태를 해소합니다. 표시 관리 명령의 선택자는 프로바이더 이름과 행의
**원본 `id`**를 조합하며, ID 내부의 슬래시를 그대로 유지합니다.

```sh
ocx models enable 'my-gateway/<원본-업스트림-ID>'
```

예를 들어 원본 `id`가 `vendor/model`이면 선택자는 `my-gateway/vendor/model`입니다.
클라이언트용 `namespaced` 값은 `my-gateway/vendor-model`처럼 인코딩될 수 있습니다. 이를 대신 사용하면
원본 ID로 저장된 비활성 항목이 해제되지 않을 수 있습니다. 모델 하나를 켜도 다른 모델은 꺼지지 않습니다.
이 게이트웨이에서 해당 모델만 표시하려면 같은 선택자 형식에 각 행의 원본 `id`를 넣어 다른 활성 모델을 끄고
목록을 다시 확인하세요.

```sh
ocx models disable 'my-gateway/<다른-원본-업스트림-ID>'
ocx models live --provider my-gateway --json
```

원하는 행은 `disabled: false`이고 제외하려는 다른 행은 비활성 상태인지 확인하세요. 접두사 없는 네이티브 모델 ID는
다른 경로를 선택할 수 있습니다. 표시 이름이나 추측한 reasoning 접미사 대신 정확한 값을 쓰세요. 접미사는 별도
업스트림 모델 ID일 수 있으며 reasoning 강도는 별도 설정입니다. 자세한 내용은
[CLI 레퍼런스](/ko/reference/cli/providers-accounts/)를 참고하세요.

필요하면 `ocx sync`로 클라이언트 카탈로그에 반영한 뒤 Codex 모델 선택기에 해당 모델이 나타나는지 확인하세요.
실행 중인 클라이언트는 이전 목록을 메모리에 유지할 수 있습니다. 진행 중인 작업을 보존하고 목록이 계속 오래된 상태라면
Codex를 완전히 종료한 뒤 다시 여세요. 또는 명시적으로 승인한 뒤
[`ocx system codex-restart --yes`](/ko/reference/cli/agents/)를 사용할 수 있습니다.
이 명령은 세션을 중단하고 저장하지 않은 초안, 선택 또는 대기 중인 승인 요청을 잃게 할 수 있습니다.
위의 설정 파일 직접 수정 외에는 클라이언트나 프록시 재시작이 기본 복구 단계가 아닙니다.

지원되는 키 인증 원격 설정에서 실제 응답 생성 요청 하나를 검증하려면 행이나 게이트웨이 운영자로부터 얻은
**업스트림 원본 `id`**를 프로바이더 접두사를 추가하지 않고 그대로 사용합니다.

```sh
ocx provider test my-gateway --model '<원본-업스트림-ID>'
```

이 명령은 제한된 요청 하나를 보내며 쿼터를 사용하고 요금이 발생할 수 있습니다. 비용을 승인한 뒤에만 기본값이
No인 확인 질문에 동의하세요. 비대화형 또는 JSON 사용에는 `--yes`가 필요합니다. 응답 생성 테스트의
`applicable: false`는 요청을 보내지 않았다는 뜻이며 종료 코드가 0이어도 통과가 아닙니다. 성공한 테스트를 통과로
판정하기 전에 보고된 wire 모델이 의도한 업스트림 ID와 일치하는지 확인하세요. 별칭이 다른 모델로 해석될 수 있습니다.
JSON 출력에서는 `wireModel`입니다. 텍스트 생성 성공
한 번은 도구 호출, 구조화 출력, 연속 호출 또는 모델의 실제 정체를 증명하지 않습니다. 업스트림이 보고한
모델명은 메타데이터입니다. 이후 호환성 문제는 비식별 fixture로 해당 프로토콜을 따로 재현하세요.
