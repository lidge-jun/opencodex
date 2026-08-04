---
title: opencode
description: opencode에서 라우팅된 어떤 모델이든 사용하세요. opencodex가 런타임 provider 블록을 주입하고, 사용자의 opencode 설정은 그대로 둡니다.
---

opencode는 환경 변수 대신 병합된 JSON 구성 레이어에서 provider를 읽으므로,
`ANTHROPIC_BASE_URL`처럼 끼워 넣을 자리가 없습니다. `ocx opencode`는 그 간극을
메웁니다. 프록시가 실행 중인지 확인하고, 표시된 카탈로그에서 provider 블록을
만들고, OpenCode의 인라인 런타임 레이어(`OPENCODE_CONFIG_CONTENT`)를 통해
주입합니다.

## 빠른 시작

```bash
ocx opencode
```

이 명령은 프록시가 실행 중임을 보장하고, 그 프로세스에는 생성된
`provider.opencodex` 블록만 주입한 채 opencode를 실행합니다. 추가 인자는 그대로
전달됩니다: `ocx opencode run "hello"`.

라우팅된 모델은 선택기에서 `opencodex` 공급자 아래에 나타납니다:

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## 사용자 구성은 절대 수정되지 않습니다

런처는 `~/.config/opencode/opencode.json`, 프로젝트의 `opencode.json` /
`opencode.jsonc`, 그리고 그 밖의 어떤 디스크상의 구성 레이어도 복사하거나 다시
쓰지 않습니다. 전역 또는 프로젝트 구성을 읽어 `provider.opencodex` 재정의가 있는지만
확인할 수 있으며, 기존의 공급자, 에이전트, 키 바인딩, MCP 항목, 그리고 상대 경로
`{file:…}` 참조는 계속 원래 파일을 기준으로 해석됩니다.

이번 실행에서만 opencodex는 생성된 `provider.opencodex` 블록을 OpenCode의 인라인
런타임 레이어를 통해 추가합니다. 이 레이어는 전역/사용자 지정/프로젝트 구성 뒤에
병합되며, 자식 프로세스에서는 충돌하는 키만 덮어씁니다.

| 레이어 | `ocx opencode`에서의 동작 |
| --- | --- |
| 전역 / 사용자 지정 / 프로젝트 구성 | 사용자가 쓴 그대로 디스크에 남습니다 |
| 인라인 런타임 (`OPENCODE_CONFIG_CONTENT`) | 생성된 `provider.opencodex` 블록만 받습니다 |
| 상대 `{file:…}` 경로 | 원래 정의된 구성 파일을 기준으로 계속 해석됩니다 |

전역 또는 프로젝트 구성에도 `provider.opencodex`가 정의되어 있으면, 런처는 안내
메시지를 출력합니다. `ocx opencode`의 런타임 레이어가 이번 실행에서는 그것을
덮어씁니다.

## 블록을 사용자 구성에 넣기

`ocx opencode`는 provider 블록을 한 번의 실행에만 주입하므로, 평범한 `opencode`는
여전히 프록시를 모릅니다. 일반 `opencode`에서, 혹은 런처를 거치지 않는 편집기
확장에서 라우팅된 모델을 쓰고 싶다면 `ocx export`가 같은 provider 블록을 출력해
주므로 사용자 구성에 병합하면 됩니다:

```bash
ocx export --client opencode
```

프록시는 실행 중이어야 합니다. 이 명령은 구성, 표준 대상 위치
(`~/.config/opencode/opencode.json`, 또는 `XDG_CONFIG_HOME`이 설정되어 있으면 그
아래 경로), 병합 경고, 그리고 env export 줄을 출력합니다. 이 명령은 그 파일을 절대
건드리지 않습니다. 앞 절의 설명은 그대로 유지되며, 블록을 구성에 옮기는 것은
사용자가 직접 하는 일입니다.

:::caution[병합하고, 절대 교체하지 마세요]
기존 구성에 `provider.opencodex` 블록을 병합하세요. 내보낸 파일로 전체를 바꾸면
기존의 공급자, 에이전트, 키 바인딩, MCP 항목이 모두 사라집니다.
`ocx export --out`이 이미 존재하는 파일을 덮어쓰지 못하게 막는 이유가 바로 이것입니다.
그러니 `--out`은 임시 경로를 가리키게 두고, 블록만 옮겨 담으세요:

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

런처의 런타임 블록과 달리, 병합한 블록은 정적인 스냅샷입니다. 카탈로그를 따라가지
않습니다. provider를 추가하거나 모델 노출을 바꾼 뒤에는 `ocx export`를 다시
실행하세요.

병합한 뒤에는 opencode를 실행하기 전에 인증 키를 export하세요. 단, 프록시가
loopback에 바인딩되어 있으면 필요하지 않습니다:

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

## 인증 키는 디스크에 쓰이지 않습니다

프록시가 API 키를 요구할 때, 인라인 런타임 구성에는 비밀값 대신 opencode의
`{env:…}` 참조가 들어갑니다. 루프백 바인드에서는 그 참조를 `apiKey`로 사용하고,
루프백이 아닌 바인드에서는 `x-opencodex-api-key`로만 보내므로 프록시 인증은 상위
`Authorization` 헤더와 분리됩니다.

루프백 예시:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

루프백이 아닌 예시:

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

실제 값은 자식 프로세스 환경으로만 전달됩니다.
`OPENCODEX_API_AUTH_TOKEN`이 가장 우선이고, 그다음 하드닝된 서비스 토큰 파일,
그다음에 구성된 API 키가 옵니다. 루프백이 아닌 바인드에는 바로 이 API 키가
필요합니다.

루프백 바인드(`127.0.0.1`, 기본값)는 아무 인증도 하지 않으므로 `{env:…}` 참조는
아무 효과가 없고, 변수를 비워 둬도 됩니다. 이것이 중요해지는 것은 `hostname`이
루프백을 벗어날 때뿐입니다. [원격 접속](/reference/configuration/#remote-access)을
보세요. 이 인증 키는 opencodex 전용이며, [공급자](/guides/providers/) 아래에
설정한 upstream provider 키와는 무관합니다.

## 되돌리기

되돌릴 것은 없습니다. `~/.opencodex` 아래에 생성된 구성 파일은 쓰이지 않습니다.
평소처럼 `opencode`를 실행하면 기존 구성을 그대로 읽습니다.

## 모델 제한

카탈로그가 공식 context window를 보고할 때만 `limit.context`를 씁니다. 그렇지 않으면
`limit` 블록 전체를 생략하고 opencode는 자체 기본값을 유지합니다.

opencode의 스키마는 `output` 없이 `context`만 있는 `limit` 블록을 거부합니다. 카탈로그에는
모델별로 공인된 `output` 필드가 없으므로, 이를 맞추기 위해 `32000`의 `output`
예산을 함께 내보내고, 작은 context 모델에 `output > context`가 되지 않도록 context
window에 맞춰 낮춥니다. 그 수치는 스키마를 만족시키기 위한 값일 뿐이며, 어떤 특정
모델의 실제 최대치를 뜻하지는 않습니다.

`opencodex` provider 블록은 실행할 때마다 다시 생성되므로, 그 안에서 한 모델별
조정은 유지되지 않습니다. 대신 사용자만의 provider 키 아래에 사용자 정의 항목을
두세요.

## 요구 사항

opencode가 설치되어 있고 `PATH`에 있어야 합니다:

```bash
npm install -g opencode-ai
```
