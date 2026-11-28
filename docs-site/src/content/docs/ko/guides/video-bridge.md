---
title: 비디오 브리지
description: 비OpenAI 모델을 통해 Grok Imagine Video로 영상을 생성합니다.
---

## 개요

Video Bridge는 opencodex가 라우팅한 OpenAI가 아닌 모델로 xAI의 Grok Imagine Video 생성을 사용할 수 있게 합니다. 활성화하면 대화에 합성 `video_gen` 도구가 주입됩니다. 모델은 이를 일반 함수 도구처럼 호출하고, opencodex는 이 호출을 가로채 xAI에 영상 생성 작업을 제출한 뒤 완료될 때까지 폴링하고 결과를 내려받습니다.

기본적으로 작업은 xAI로 전송되며, `images.videoProvider`로 호환되는 다른 백엔드를 지정할 수 있습니다.

## 사전 조건

이 사전 조건은 기본 xAI 목적지에 적용됩니다. `images.videoProvider`를 설정했다면 [영상 제공자 선택](#영상-제공자-선택)을 참고하세요.

- API 키가 있는 `xai` provider entry (`ocx login xai`만으로는 충분하지 않습니다. 비디오 브리지는 OAuth가 아니라 키 인증이 필요합니다)
- 라우팅 대상 provider로 비OpenAI 모델 사용 예시: Anthropic Claude, Google Gemini
- 비OpenAI provider를 거치도록 opencodex 설정

> **⚠ Provider key required:** 비디오 브리지는 `xai` provider가
> API key auth를 사용할 때만 활성화됩니다. 설정에 다음을 추가하십시오:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> `XAI_API_KEY`는 프록시 시작 환경에 설정하고 `${XAI_API_KEY}`와 `authMode: "key"`를 유지하세요. 다른 터미널의 export는 실행 중인 프록시를 바꾸지 않습니다. 소유한 Desktop, 서비스 또는 전경 터미널을 통해 재시작하세요. 키를 커밋이나 로그에 넣지 마세요.

## 구성

`images` 설정에 `videoBridgeEnabled: true`를 추가하십시오:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `videoBridgeEnabled` | `false` | 전체 스위치입니다. 반드시 명시적으로 켜야 합니다. |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | xAI 비디오 모델 id입니다. |
| `videoMaxRounds` | `2` | 강제 최종 답변 전에 허용하는 최대 video-gen 라운드 수입니다. |
| `videoTimeoutMs` | `300000` (5분) | 폴링 시간을 포함한 비디오별 타임아웃입니다. |
| `videoProvider` | 미설정 (xAI) | `video_gen`을 자체 `baseUrl`과 키로 처리할 API 키 제공자(선택). [영상 제공자 선택](#영상-제공자-선택)을 참고하세요. |

## 영상 제공자 선택

기본적으로 브리지는 `xai` 제공자의 API 키로 xAI에 `video_gen` 작업을 보냅니다. 같은 비동기 API(`POST {baseUrl}/videos/generations` 후 `GET {baseUrl}/videos/{id}`)를 구현한 다른 백엔드(예: 직접 운영하는 미디어 브리지)로 보내려면 `images.videoProvider`를 설정하세요.

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- 지정한 제공자의 `baseUrl`과 API 키만 목적지와 자격 증명으로 사용합니다. 어댑터 종류는 상관없지만 API 키 인증이어야 합니다.
- `"videoProvider": "xai"`는 `xai` 항목의 `baseUrl`과 관계없이 고정된 `https://api.x.ai/v1`을 사용합니다. 다른 내장 제공자 ID는 거부되므로 사용자 지정 제공자를 지정하세요.
- 루프백 또는 사설망 `baseUrl`은 다른 제공자 트래픽과 마찬가지로 해당 제공자에 `allowPrivateNetwork: true`가 필요합니다.
- OpenCodex가 xAI 키로 식별할 수 있는 키(`xai-` 형식 키, `xai` 항목이 가진 키, xAI나 Grok 이름의 환경 변수 참조)는 `https://api.x.ai` 또는 `https://cli-chat-proxy.grok.com`으로만 전송되며 다른 출처는 거부됩니다. 이런 표시가 없는 키는 식별할 수 없으므로 xAI 키를 다른 제공자 항목에 붙여 넣지 마세요. 다른 제공자의 비밀을 가리키는 키체인 참조는 항상 거부되고, 일시 중지된 활성 키도 거부되며, `baseUrl`에는 자격 증명, 쿼리, 프래그먼트를 넣을 수 없습니다.
- 제공자가 없거나, 비활성화되었거나, 일시 중지되었거나, 키가 없거나, 거부되면 모든 `video_gen` 호출이 그 오류를 모델에 반환합니다. 아무것도 전송하지 않으며 xAI로 대체하지 않습니다.
- xAI 방식에서는 완성된 영상을 base64 `data:` URL이나 공개 `https:` URL에서만 내려받으므로, 로컬 브리지는 `video.url`로 둘 중 하나를 반환해야 합니다. 생성된 파일을 자기 호스트에서 제공하는 백엔드는 대신 `"videoApi": "openai"`를 설정합니다([영어 가이드의 OpenAI Videos API 절](/guides/video-bridge/#openai-videos-api-backends) 참고).

## 동작 방식

1. opencodex는 `videoBridgeEnabled: true`가 켜진 비OpenAI 라우팅 모델을 감지합니다.
2. 합성 `video_gen` 함수 도구가 대화에 주입됩니다.
3. 모델이 `video_gen`을 호출하면, opencodex는 xAI의 `/videos/generations`로 작업을 제출합니다 (`images.videoProvider`를 설정한 경우 그 제공자).
4. 브리지는 5-15초마다 작업 상태를 폴링하고, 스트림을 살리기 위해 heartbeat 메시지를 보냅니다.
5. 비디오가 준비되면 artifacts 디렉터리로 내려받습니다.
6. 로컬 파일 경로가 도구 결과로 모델에 반환됩니다.

## 지원 파라미터

`video_gen` 도구는 다음을 받습니다:

| 파라미터 | 타입 | 범위 | 설명 |
|----------|------|------|------|
| `prompt` | string | 이미지나 프레임이 있으면 선택 사항 | 텍스트 프롬프트 |
| `duration` | integer | 1-15 | 영상 길이(초) |
| `resolution` | string | `480p`, `720p`, `1080p` | 모델에 따라 다름; `last_frame`, `keyframes` 또는 `reference_images` 사용 시 최대 720p |
| `aspect_ratio` | string | 모델에 따라 다름 | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; `image`만 애니메이션화할 때는 거부되며 원래 비율이 유지됨 |
| `image` | string | 첫 프레임 | HTTPS URL, 데이터 URL 또는 기억된 아티팩트 |
| `last_frame` | string | 1.5 전용 | 마지막 프레임 |
| `keyframes` | array | 1.5, 최대 4 | `{image, timestamp_s}`; 타임스탬프는 클립 내부에만 허용 (`duration` 생략 시 8 s) |
| `reference_images` | array | 1.5: 14, 클래식: 7 (≤ 10 s) | 참조 이미지; 클래식 모델에서는 `image`와 함께 사용할 수 없음 |

모델이 지원할 수 없는 설정은 무시되지 않고 유료 호출 전에 거부됩니다.

### 모델과 이미지 입력

| 모델 | 해상도 | 입력 | 초당 (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p 네이티브 | 첫/마지막 프레임, 4 키프레임, 14 참조 이미지 (720p 최대) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (기본값) | 480p / 720p / 1080p 업스케일 | 첫 프레임 | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | 첫 프레임, 7 참조 이미지 | $0.05 / $0.07 / — |

프레임 지정이나 참조 이미지를 사용하려면 `images.videoBridgeModel`을 `grok-imagine-video-1.5`로 설정하세요. 알려진 모델은 화면비 9개를 지원합니다. 알 수 없는 모델은 기존 화면비 7개와 480p/720p만 제공하며 이미지 입력을 받지 않습니다. HTTPS URL과 디코딩 후 10 MiB 이하인 PNG/JPEG/WebP 데이터 URL을 사용할 수 있습니다. 이미지 브리지가 다운로드한 이미지는 아티팩트 URL, 절대 경로 또는 `file:` URL로 한 시간 동안 참조할 수 있습니다. 로컬 파일을 읽지 않고 저장된 원본 URL을 사용합니다. 이 참조는 고정 xAI 대상에서만 작동하며 사용자 지정 `images.videoProvider`에서는 사용할 수 없습니다. 인라인 결과에는 원본 URL이 없고 임시 URL은 더 일찍 만료될 수 있습니다.


## 제한 사항

- **기본값은 xAI**: `videoProvider`가 없으면 xAI의 Grok Imagine Video API를 사용합니다. 다른 백엔드는 같은 비동기 API를 구현해야 합니다
- **비동기**: 영상 생성에는 30-120초가 걸립니다
- **한 번에 한 편**: 각 `video_gen` 호출은 영상 하나를 생성합니다
- **Image Bridge와 공존 가능**: 두 브리지를 동시에 켤 수 있습니다
- **웹 검색 우선순위**: 한 턴에 웹 검색 사이드카가 활성화되어 있으면(`runTurn` 어댑터가 아닌 경우) 비디오 브리지는 건너뜁니다. 둘은 동시에 실행할 수 없습니다. 로그에서 확인할 수 있도록 `console.warn`이 출력됩니다.
- **타임아웃은 제출과 폴링을 함께 포함**: `videoTimeoutMs` 예산은 작업 제출 전에 시작하므로, 제출 호출(60초)과 이후 폴링이 같은 마감 시점을 공유합니다.
