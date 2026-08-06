---
title: Pi
description: Pi에서 라우팅된 모델을 그대로 쓸 수 있습니다. `ocx export`가 Pi의 `models.json`에 맞는 커스텀 provider 블록을 내보내고, 실행 중인 프록시에 연결합니다.
---

Pi는 provider를 환경 변수 대신 하나의 전역 JSON 파일에서 읽기 때문에,
opencodex가 Pi를 직접 실행하지 않습니다. 대신 `ocx export`가 `opencodex` provider 블록,
즉 base URL, 모델 목록, 그리고 비밀이 아닌 리터럴 `apiKey` placeholder를 직렬화해서
사용자가 자신의 설정에 병합하도록 합니다.

## 빠른 시작

프록시를 먼저 띄우고 config를 출력합니다.

```bash
ocx start
ocx export --client pi
```

출력은 JSON으로 시작하고, 이어서 대상 경로, 병합 경고, 전체 모델 수, 그리고 context
limit을 생략한 row 수를 보여줍니다.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

모델 id는 프록시의 정규 선택자이므로, 라우팅된 모델은 `provider/model`
(`anthropic/claude-opus-5`) 형태로 나타나고, 네이티브 OpenAI slug는 접두사 없이
(`gpt-5.6-sol`) 유지됩니다. `name` 접미사인 `(anthropic)`, `(native)`, `(routed)`는
Pi 선택기에서 같은 이름의 서로 다른 upstream 모델을 구분하게 해줍니다.

## 저장 위치

Pi의 전역 모델 config는 다음과 같습니다.

```text
~/.pi/agent/models.json
```

:::caution[병합하고, 대체하지 마세요]
`ocx export`는 그 파일을 절대 쓰지 않습니다. `providers.opencodex` 블록을 그 안에
병합하세요. 파일을 통째로 바꾸면 이미 설정해 둔 다른 provider가 모두 사라집니다.
`--out`은 임시 경로용이며, `--force` 없이 이미 존재하는 파일을 덮어쓰지 못합니다.

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

내보낸 블록은 실시간 뷰가 아니라 고정 스냅샷입니다. provider를 추가하거나 모델
가시성을 바꾼 뒤에는 `ocx export`를 다시 실행하고, 새 블록을 옛 블록 위에 병합하세요.

## Pi의 `apiKey` placeholder

Pi는 일반적으로 `/chat/completions`를 호출하며, 설정된 `apiKey`를 Bearer 인증 값으로
보냅니다. 따라서 생성된 블록은 Pi의 일반 `apiKey` 필드에 비밀이 아닌 리터럴
`opencodex-loopback`을 넣습니다.

이 리터럴은 프록시 admission credential도 upstream provider 키도 아닙니다. 루프백
프록시는 이 값을 무시하며 credential을 전혀 요구하지 않습니다. 다만 모델 탐색에는
필수입니다. Pi는 모델 목록을 만들 때 `apiKey`를 해석하고, 값이 설정되지 않은 환경 변수
참조이면 provider 전체를 숨기므로, 리터럴이어야 라우팅된 모든 모델이 보입니다.

Provider 키는 별개입니다. Anthropic / OpenAI / OpenRouter 키는 opencodex의 자체
config에 있으며([Providers](/guides/providers/) 참조), 이 파일에는 절대 나타나지 않습니다.

## 모델 메타데이터

`contextWindow`와 `maxTokens`는 카탈로그가 확정된 context window를 보고할 때만
출력됩니다. 그렇지 않으면 두 필드 모두 해당 모델에서 생략되고, Pi는 자체 기본값을
적용합니다. `ocx export`는 그 경우가 몇 줄이었는지도 함께 출력합니다.

`maxTokens`는 스키마를 만족시키기 위한 `32000` 예산이며, context window보다 더 크게
잡히지 않도록 아래로 잘립니다. 즉, 작은 context 모델에 그보다 많은 출력을 주겠다는
의미가 아닙니다.

의도적으로 빠진 필드도 두 개 있습니다. `cost`는 네 개의 가격 필드가 모두 있어야
하는데, opencodex는 라우팅된 모델의 가격 데이터를 갖고 있지 않습니다. 0을 넣으면
모든 모델이 무료라고 주장하는 꼴이 됩니다. `reasoning`은 Pi에서는 boolean이지만
카탈로그는 effort 단계 체계를 들고 있으므로, 둘을 1:1로 맞추는 것은 추측입니다.

## 스키마 상태

:::note[실제 설치에서 검증됨]
위의 형태는 Pi 0.83.x가 설치된 머신의 실제 `~/.pi/agent/models.json`으로 검증했습니다.
블록이 유효하고 Pi가 지원하는 입력 modality를 가진 내보낸 라우팅 모델이 모두 선택기에
표시됩니다. 더 새로운 Pi가 이 블록을 거부하면 문제는 우리 쪽에 있습니다. Pi가 무엇을 보고했는지와 함께
[issue를 열어주세요](https://github.com/lidge-jun/opencodex/issues).
:::

## 요구 사항

실행 중인 opencodex 프록시(`ocx start`)와 설치된 Pi가 필요합니다. `ocx export`는
프록시의 management API를 통해 live catalog를 읽으므로, 빈 모델 목록으로는 config를
내보낼 수 없습니다.
