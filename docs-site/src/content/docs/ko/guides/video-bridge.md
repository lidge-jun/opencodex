---
title: 비디오 브리지
description: 비OpenAI 모델을 통해 Grok Imagine Video로 영상을 생성합니다.
---

## 개요

Video Bridge는 opencodex가 라우팅한 OpenAI가 아닌 모델로 xAI의 Grok Imagine Video 생성을 사용할 수 있게 합니다. 활성화하면 대화에 합성 `video_gen` 도구가 주입됩니다. 모델은 이를 일반 함수 도구처럼 호출하고, opencodex는 이 호출을 가로채 xAI에 영상 생성 작업을 제출한 뒤 완료될 때까지 폴링하고 결과를 내려받습니다.

## 사전 조건

- API 키가 있는 `xai` provider entry (`ocx login xai`만으로는 충분하지 않습니다. 비디오 브리지는 OAuth가 아니라 키 인증이 필요합니다)
- 라우팅 대상 provider로 비OpenAI 모델 사용 예시: Anthropic Claude, Google Gemini
- 비OpenAI provider를 거치도록 opencodex 설정

> **⚠ Provider key required:** 비디오 브리지는 `xai` provider가
> API key auth를 사용할 때만 활성화됩니다. 설정에 다음을 추가하십시오:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
>   }
> }
> ```
>
> `ocx login xai`(OAuth)로 연결했다면 provider는 계속 `authMode: "oauth"`
> 상태이며, 브리지는 아무 경고 없이 활성화되지 않습니다. 환경 변수로 `XAI_API_KEY`를
> 설정하거나, 위처럼 키를 직접 넣으십시오.

## 구성

`images` 설정에 `videoBridgeEnabled: true`를 추가하십시오:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `videoBridgeEnabled` | `false` | 전체 스위치입니다. 반드시 명시적으로 켜야 합니다. |
| `videoBridgeModel` | `"grok-imagine-video"` | xAI 비디오 모델 id입니다. |
| `videoMaxRounds` | `2` | 강제 최종 답변 전에 허용하는 최대 video-gen 라운드 수입니다. |
| `videoTimeoutMs` | `300000` (5분) | 폴링 시간을 포함한 비디오별 타임아웃입니다. |

## 동작 방식

1. opencodex는 `videoBridgeEnabled: true`가 켜진 비OpenAI 라우팅 모델을 감지합니다.
2. 합성 `video_gen` 함수 도구가 대화에 주입됩니다.
3. 모델이 `video_gen`을 호출하면, opencodex는 xAI의 `/videos/generations`로 작업을 제출합니다.
4. 브리지는 5-15초마다 작업 상태를 폴링하고, 스트림을 살리기 위해 heartbeat 메시지를 보냅니다.
5. 비디오가 준비되면 artifacts 디렉터리로 내려받습니다.
6. 로컬 파일 경로가 도구 결과로 모델에 반환됩니다.

## 지원 파라미터

`video_gen` 도구는 다음을 받습니다:

| 파라미터 | 타입 | 범위 | 설명 |
|----------|------|------|------|
| `prompt` | string | required | 상세한 영상 생성 프롬프트 |
| `duration` | integer | 1-15 | 영상 길이(초) |
| `resolution` | string | `"480p"`, `"720p"` | 영상 해상도 |
| `aspect_ratio` | string | 7 ratios | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

## 제한 사항

- **xAI 전용**: 영상 생성은 xAI의 Grok Imagine Video API로만 사용할 수 있습니다
- **비동기**: 영상 생성에는 30-120초가 걸립니다
- **비용**: 영상 생성은 유료 xAI 기능입니다(~$0.05/sec @480p, ~$0.07/sec @720p)
- **한 번에 한 편**: 각 `video_gen` 호출은 영상 하나를 생성합니다
- **Image Bridge와 공존 가능**: 두 브리지를 동시에 켤 수 있습니다
- **웹 검색 우선순위**: 한 턴에 웹 검색 사이드카가 활성화되어 있으면(`runTurn` 어댑터가 아닌 경우) 비디오 브리지는 건너뜁니다. 둘은 동시에 실행할 수 없습니다. 로그에서 확인할 수 있도록 `console.warn`이 출력됩니다.
- **타임아웃은 제출과 폴링을 함께 포함**: `videoTimeoutMs` 예산은 작업 제출 전에 시작하므로, 제출 호출(60초)과 이후 폴링이 같은 마감 시점을 공유합니다.
