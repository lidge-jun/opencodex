---
title: Pi
description: Pi에서 라우팅된 모델을 그대로 쓸 수 있습니다. `ocx export`가 Pi의 `models.json`에 맞는 커스텀 provider 블록을 내보내고, 실행 중인 프록시에 연결합니다.
---

Pi는 하나의 전역 JSON 파일에서 공급자를 읽습니다. opencodex가 Pi를 실행하는 대신 `ocx export`가 기본 URL, 모델 목록, 비밀이 아닌 로컬 키 자리표시자가 담긴 `opencodex` 공급자 블록을 출력합니다. 이 블록을 기존 설정에 병합하세요.

## 빠른 시작

프록시를 먼저 띄우고 config를 출력합니다.

```bash
ocx start
```

이 프로세스를 실행한 상태로 두고, 두 번째 터미널에서 설정을 출력하세요.

```bash
ocx export --client pi
```

출력에는 JSON 다음으로 대상 경로, 병합 경고, 루프백 사용 안내와 확인된 컨텍스트 한도가 있는 모델 수가 나옵니다. 이 내보내기는 인증이 없는 루프백 프록시만 지원하며 원격 접근 인증을 설정하지 않습니다.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

생성된 Pi provider에는 `compat.sendSessionAffinityHeaders`가 활성화됩니다. provider를 병합하거나 직접 수정할 때 이 설정을 유지하세요. Pi가 안정적인 세션 식별자를 보내면 OpenCodex가 이를 바탕으로 정규 OpenCode Go 대상의 affinity를 계산합니다. `cacheRetention`이 `none`이면 Pi가 식별자를 보내지 않을 수 있습니다.

생성된 Pi provider는 `compat.supportsDeveloperRole`도 `false`로 설정합니다. 그래서 Pi는 시스템 프롬프트를 `developer`가 아닌 `system` 역할로 보냅니다. OpenCodex는 Chat Completions 역할을 받은 그대로 전달하는데, OpenAI 호환 업스트림 중 일부는 `developer`를 400으로 거부합니다. `system`은 모든 업스트림이 받습니다.

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

## 인증 키

내보낸 `apiKey`는 비밀이 아닌 자리표시자 `opencodex-loopback`입니다. 키 환경 변수를 내보낼 필요가 없습니다. 내보내기는 인증이 없는 루프백 프록시만 허용하며 원격 또는 토큰으로 보호된 프록시는 거부합니다. 공급자 자격 증명은 [공급자](/ko/guides/providers/)에 설명된 opencodex 설정에 남습니다. 이 Pi 블록에 상위 공급자의 키를 넣지 마세요. 원격 접근에는 프록시 접근 인증을 지원하는 통합을 사용하세요. 자리표시자를 바꿔도 Pi 원격 내보내기가 활성화되지 않습니다.

## 모델 메타데이터

`contextWindow`와 `maxTokens`는 카탈로그가 확정된 context window를 보고할 때만
출력됩니다. 그렇지 않으면 두 필드 모두 해당 모델에서 생략되고, Pi는 자체 기본값을
적용합니다. `ocx export`는 그 경우가 몇 줄이었는지도 함께 출력합니다.

출력 한도는 카탈로그 또는 생성된 메타데이터의 알려진 모델 한도를 사용합니다. 알 수 없는 경우에만 `32000`을 사용합니다. 출력 한도는 항상 context window 이하로 제한되며, `32000`보다 작은 알려진 한도도 유지됩니다.

의도적으로 빠진 필드도 두 개 있습니다. `cost`는 네 개의 가격 필드가 모두 있어야
하는데, opencodex는 라우팅된 모델의 가격 데이터를 갖고 있지 않습니다. 0을 넣으면
모든 모델이 무료라고 주장하는 꼴이 됩니다. `reasoning`은 Pi에서는 boolean이지만
카탈로그는 effort 단계 체계를 들고 있으므로, 둘을 1:1로 맞추는 것은 추측입니다.

## 스키마 상태

:::note[실제 설치에서 검증하지 않음]
위의 형태는 Pi가 공개한 custom-provider 문서를 따른 것입니다. Pi가 설치된 머신의
실제 `~/.pi/agent/models.json`으로는 아직 검증하지 않았습니다. Pi가 내보낸 블록을
거부하면 문제는 우리 쪽에 있습니다. Pi가 무엇을 보고했는지와 함께
[issue를 열어주세요](https://github.com/lidge-jun/opencodex/issues).
:::

## 요구 사항

실행 중인 opencodex 프록시(`ocx start`)와 설치된 Pi가 필요합니다. `ocx export`는
프록시의 management API를 통해 live catalog를 읽으므로, 빈 모델 목록으로는 config를
내보낼 수 없습니다.
