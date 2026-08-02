---
title: 이미지 브리지
description: OpenAI가 아닌 provider를 사용할 때 `image_generation` hosted-tool 호출을 xAI Grok Imagine으로 라우팅합니다.
---

## 개요

Codex를 Claude, Gemini, Grok 같은 OpenAI가 아닌 모델로 라우팅하면 `image_generation` **hosted tool**은 보통 동작하지 않습니다. 이 도구는 OpenAI의 서버 측 실행 환경을 필요로 하기 때문입니다. Image Bridge는 이런 호출을 감지해서 xAI Grok Imagine으로 투명하게 다시 라우팅하므로, 실제로 대화 중인 모델도 이미지를 생성할 수 있습니다.

## 사전 조건

- 구성에서 `images.bridgeEnabled: true`로 설정해 브리지를 켭니다. 예상치 못한 xAI 요금을 피하려고 기본값은 꺼져 있습니다. 아래 [Configuration](#configuration)을 참고합니다.
- API 키가 있는 `xai` provider 항목이 필요합니다. 브리지는 처리를 레지스트리의 xAI Images endpoint (`https://api.x.ai/v1`)에 고정하며, 이미지 호출에서는 설정된 `baseUrl` override를 무시합니다. OAuth / `ocx login xai`만으로는 브리지가 활성화되지 않습니다. Grok CLI OAuth transport는 채팅용이며 `/images/*`에는 사용되지 않습니다.

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- 활성 provider로 OpenAI가 아닌 모델을 선택해야 합니다. 활성 provider가 OpenAI이면 기본 hosted tool을 직접 사용하고, 브리지는 우회합니다.

## 설정

Image Bridge 옵션은 `~/.opencodex/config.json`의 `images` 아래에 있습니다. 브리지는 선택적(opt-in) 기능이며, 유료 xAI Grok Imagine 생성을 사용하려면 `bridgeEnabled: true`로 설정해야 합니다.

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `bridgeEnabled` | `false` | 마스터 스위치입니다. 브리지를 켜려면 `true`로 설정합니다. 예상치 못한 xAI 요금을 막기 위해 기본값은 꺼져 있습니다. |
| `bridgeModel` | `grok-imagine-image-quality` | 프롬프트를 보낼 xAI 이미지 모델 ID입니다. |
| `maxRounds` | `3` | 턴당 이미지 생성 루프의 최대 반복 횟수입니다. 정수로 내림한 뒤 `[0, 10]` 범위로 제한합니다. 유한하지 않은 값은 `3`으로 돌아갑니다. |
| `timeoutMs` | `60000` | 호출당 xAI 마감 시간(밀리초)입니다. 유한한 양수 값은 내림한 뒤 xAI 요청에 전달합니다. |
| `artifactsKeepCount` | `200` | `artifacts/` 아래에 유지할 최대 파일 수입니다. 이를 넘으면 각 완료된 호출 뒤에 가장 오래된 파일부터 삭제합니다. `0` 이하로 설정하면 정리를 비활성화합니다. |

## 아티팩트 보존

생성된 이미지는 `~/.opencodex/artifacts/`에 기록됩니다. 오래 실행되는 세션에서 디스크가 끝없이 늘어나는 것을 막기 위해, 이미지 호출이 완료될 때마다(그 호출의 전체 배치가 디스크에 올라간 뒤) 이 디렉터리를 자동으로 정리합니다. 개수가 설정된 최대값을 넘으면 수정 시각이 가장 오래된 파일부터 삭제합니다. 기본값은 200이며 `images.artifactsKeepCount`로 조정할 수 있습니다. 정리 후에도 남아 있는 경로만 모델에 반환합니다.

## 동작 방식

Image Bridge는 선택된 모델이 OpenAI가 아닌 상태에서, `/v1/responses`의 `tools` 배열에 hosted `image_generation` 도구가 들어 있는 **Responses** 턴에서만 활성화됩니다. Codex의 내장 `image_gen` 도구는 가로채지 않습니다. 이 도구는 `/v1/images/generations`(또는 `/images/edits`)로 직접 POST하며, 해당 경로는 [Codex Integration](/guides/codex-integration/#built-in-image-generation-image_gen)에서 따로 다룹니다.

1. Responses 요청의 `tools`에 `image_generation`이 들어 있으면, OpenCodex가 요청 사전 처리 과정에서 이를 감지합니다.
2. hosted tool은 라우팅된 모델이 정상적으로 호출할 수 있는 합성된 `function` 도구로 바뀝니다. 이렇게 하면 모델이 실행할 수 없는 opaque hosted tool 대신 호출 가능한 도구를 보게 됩니다.
3. 모델이 그 도구를 호출하면, OpenCodex가 호출을 가로채서 프롬프트를 xAI의 이미지 생성 API로 보냅니다.
4. 생성된 이미지는 `~/.opencodex/artifacts/`에 저장되고, 로컬 파일 경로가 도구 결과로 모델에 반환됩니다.
5. 모델은 생성된 이미지와 그 위치를 알고 있는 상태로 대화를 이어갑니다.

모델 입장에서는 아무것도 달라지지 않습니다. 도구를 호출했고 결과를 받았을 뿐입니다. 사용자 입장에서는 이미지 생성이 조용히 실패하는 대신, 라우팅된 어떤 provider로도 동작합니다.

## 제한 사항

- xAI Grok Imagine만 지원합니다. DALL-E와 다른 이미지 provider는 나중에 추가될 수 있습니다.
- 웹 검색 sidecar 루프를 지원하는 adapter에서는 웹 검색이 우선합니다. 같은 턴에서 웹 검색과 이미지 생성이 동시에 요청되면 웹 검색이 먼저 실행되고 이미지 생성은 건너뜁니다. 다만 현재 Cursor/`runTurn` adapter는 그 sidecar를 사용할 수 없어서, 이런 dual-tool 턴에서는 image bridge가 여전히 실행될 수 있습니다.
- xAI 요금이 발생합니다. xAI를 통한 이미지 생성에는 활성 xAI 구독이나 API 크레딧이 필요합니다.
- 스트리밍 전용입니다. 브리지는 SSE response stream을 가로채서 동작하므로 `stream: false` 요청은 400 오류로 거절됩니다.
