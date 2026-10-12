---
title: MiniMax 클라이언트
description: MiniMax 자격 증명을 노출하지 않고 MiniMax Code와 MiniMax CLI 텍스트 명령을 opencodex로 라우팅합니다.
---

MiniMax는 서로 다른 두 명령줄 제품을 제공합니다. opencodex는 각 제품이 실제로 제공하는 프로토콜 경계에서 연동합니다.

- **MiniMax Code** (`mcode`)는 사용자 정의 Anthropic Messages 프로바이더를 지원하는 코딩 에이전트입니다.
- **MiniMax CLI** (`mmx`)는 멀티모달 플랫폼 CLI입니다. `text` 리소스만 opencodex가 라우팅할 수 있는 Anthropic 호환 API를 사용합니다.

## MiniMax Code

먼저 MiniMax 안내에 따라 MiniMax Code를 설치하고 로그인하세요. 그런 다음 opencodex를 시작하고 되돌릴 수 있는 파일 연동을 연결합니다.

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![분리된 예시 데이터를 사용한 MiniMax Code 연동 화면](/screenshots/minimax-code-integration.png)

이 연동은 `~/.minimax/config.yaml`에 블록 하나를 병합합니다.

```yaml
custom_provider:
  opencodex:
    name: OpenCodex
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: opencodex-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

실제로 생성되는 모델 목록과 확인된 컨텍스트 창 및 추론 강도 단계는 실행 중인 opencodex 카탈로그에서 가져옵니다. 신뢰할 수 있는 컨텍스트 창이나 강도 단계가 없는 모델에는 값을 추측해서 채우지 않고 해당 필드를 생략합니다. MCode는 현재 선택한 강도를 세션에 유지하므로 opencodex는 선택을 덮어쓰지 않고 `effortOptions`를 내보냅니다. 이 블록은 실제 키를 기록하거나 `defaultModel`을 교체하거나 MiniMax 로그인을 바꾸지 않습니다. MCode에서는 `custom_provider:opencodex/...` 아래의 모델을 고르세요.

`ocx mcode`는 클라이언트를 실행하기 전에 이 프로바이더가 현재 실행 중인 프록시를 가리키는지 확인합니다. 한 번 활성화한 뒤에는 포트나 카탈로그 기능이 달라질 때 `ocx sync`로 소유 블록을 갱신합니다. 자동 동기화는 소유하지 않은 블록을 만들거나, 삭제한 블록을 다시 만들거나, opencodex가 기록한 뒤 변경된 파일을 덮어쓰지 않습니다. 의도적으로 재연결하려면 활성화 명령을 사용하세요. 같은 감사 대상 연동 시스템에서 비활성화하거나 복원할 수 있습니다.

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

`MINIMAX_DATA_DIR`와 이전 이름인 `MAVIS_DATA_DIR`를 지원합니다. opencodex와 MCode가 서로 다른 작업 디렉터리에서 시작될 수 있어 상대 경로 오버라이드는 거부합니다.

## MiniMax CLI (`mmx`)

공식 CLI를 별도로 설치하세요.

```bash
npm install -g mmx-cli
mmx --version
```

래퍼와 opencodex 모델 ID를 사용해 텍스트 명령을 라우팅합니다.

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX는 API 기본 URL 아래의 `/anthropic/v1/messages`를 고정해 사용합니다. 래퍼는 자식 프로세스가 실행되는 동안 임시 루프백 브리지를 시작합니다. 이 브리지는 해당 Messages 경로와 `/anthropic/v1/messages/count_tokens`에 대한 POST 요청만 받고, 요청 본문과 쿼리 데이터를 유지하면서 opencodex의 기존 `/v1/messages` 및 `/v1/messages/count_tokens` 데이터 경로로 매핑합니다. opencodex의 정식 요청 변환, 사용량 계산, 설정된 다운스트림 프로바이더 인증은 그대로 적용됩니다. 설정에 따라 프로바이더에는 `x-api-key` 또는 bearer 전송 방식이 사용됩니다. 스트리밍은 Anthropic 메시지와 콘텐츠 이벤트를 유지합니다. 전달 전 브리지는 인바운드 수용 자격 증명 헤더를 제거하고 공개 `opencodex-loopback` 자리표시자를 고정합니다. 임의의 Anthropic 리소스를 프록시하지 않으며 브리지는 루프백 밖으로 노출되지 않습니다.

래퍼는 자리표시자만 들어 있는 임시 `MMX_CONFIG_DIR`도 만들고 `mmx` 종료 후 삭제합니다. 사용자의 `~/.mmx/config.json`, OAuth 토큰, MiniMax API 키는 불러오거나 복사하지 않습니다.

다음 제한은 의도된 것입니다.

- `text chat`과 `text repl`만 opencodex를 통해 라우팅됩니다.
- 호출자의 자격 증명이나 목적지 선택이 분리된 브리지와 충돌하지 않도록 래퍼는 `--api-key`, `--base-url`, `--region`을 거부합니다.
- MMX가 원격 바인딩에 필요한 opencodex 전용 `x-opencodex-api-key` 수용 헤더를 보낼 수 없어 래퍼는 루프백에서만 작동합니다.
- `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`, `auth`, `config`, `file`, `update`에는 일반 `mmx`를 실행하세요. 이 명령은 opencodex가 에뮬레이션하지 않는 MiniMax 전용 API를 호출합니다.

`mmx`의 기본 텍스트 모델은 `MiniMax-M3`입니다. 특정 opencodex 라우트가 필요하면 `--model <provider/model>`을 전달하세요. 그렇지 않으면 일반 opencodex 모델 라우팅 규칙이 기본 ID의 사용 가능 여부를 결정합니다.
