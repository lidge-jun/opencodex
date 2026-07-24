---
title: "사이드카: 웹 검색 및 비전"
description: 네이티브 ChatGPT 사이드카를 통해 라우팅 모델에 실제 웹 검색을, 텍스트 전용 모델에 이미지 이해 기능을 제공합니다.
---

라우팅 모델마다 호스팅 **웹 검색**이나 네이티브 **이미지 입력** 지원 범위가 다릅니다. opencodex는
ChatGPT 로그인(`forward`) 프로바이더나 저장된 Anthropic OAuth 프로바이더를 사용하는 두
사이드카로 부족한 기능을 보완합니다. 사이드카 오류는 턴 전체를 실패시키지 않고 길이가 제한된 도구
결과나 이미지 안내문으로 바뀝니다.

:::note[백엔드 자동 선택]
`backend`를 명시하면 그 값이 우선합니다. 생략하면 활성 계정이 `needsReauth` 상태가 아닌 Anthropic
OAuth 프로바이더가 있을 때 `anthropic`, 없을 때 `openai`를 사용합니다. 쓸 수 있는 자격 증명 없이
`anthropic`을 명시하면 실패 후 중단합니다. `openai`는 ChatGPT 로그인과 활성화된 `forward`
프로바이더가 모두 필요합니다.
:::

## 웹 검색 사이드카

Codex가 패스스루가 아닌 라우팅 모델에 호스팅 `web_search`를 요청하면 opencodex는 다음 순서로
처리합니다.

1. 호스팅 `web_search` 도구를 **제거하고** 라우팅 모델에는 합성 `web_search(query)` 함수 도구를
   노출합니다. 원래 호스팅 도구의 옵션은 사이드카 호출에 그대로 사용합니다.
2. 라우팅 모델을 작은 **에이전트 루프**에서 실행합니다. 모델이 `web_search`를 호출하면 선택한
   백엔드를 사용합니다. OpenAI는 기본 `gpt-5.6-luna`로 호스팅 `web_search`를 실행하고,
   Anthropic은 기본 `claude-sonnet-5`로 `web_search_20250305`를 실행합니다. 스트리밍 답변과
   인용을 파싱한 결과는 도구 결과로 돌려줍니다.
3. 모델이 답하거나 실제 검색 쿼리의 총합이 `maxSearchesPerTurn`(기본값 3)에 도달할 때까지
   **반복**합니다. 한도에 닿으면 검색 도구를 제거하고 최종 답변을 강제합니다. `apply_patch`나 shell
   같은 실제 클라이언트 도구가 나오면 턴을 끝내 해당 호출이 Codex에 전달되게 합니다.

라우팅 모델의 모든 반복은 업스트림에 `stream: true`를 요청하지만, opencodex는 검색 여부나 최종
답변을 결정하기 전에 의미 있는 event를 내부에서 전부 버퍼링합니다. 첫 번째 반복의 최종
header/status와 429 key rotation만 미리 가져옵니다. 따라서 합성 검색 호출과 중간 출력은 클라이언트에
모델 출력으로 노출되지 않습니다.

주입 결과는 신뢰할 수 없는 데이터 경계로 감싸고 길이를 제한하며, 소스 URL 기준으로 중복을
제거합니다. 구조화된 출력 턴(`json_schema` / `json_object`)에서는 산문이 아니라 간결한 JSON으로
전달합니다. 라우팅 모델이 텍스트 전용이면 검색 모델에 관련 이미지를 글로 설명하고 소스 URL도
포함하도록 지시합니다.

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  }
}
```

호스팅 백엔드가 `minimal` 강도에서 도구 사용을 거부하므로 기본값은 `low`입니다. 검색이 실패하면
길이가 제한된 오류 결과를 라우팅 모델에 돌려주며, 모델은 이미 가진 문맥을 바탕으로 답할 수 있습니다.

서로 독립적인 네 가지 clock이 적용됩니다. `stallTimeoutSec`은 기본 bridge event stall 예산입니다.
`connectTimeoutMs`(기본값 `200000`)는 DNS/TCP/TLS와 최종 응답 header까지만 제한합니다. 설정
파일에서만 지정할 수 있는 `webSearchSidecar.routedModelStallTimeoutMs`(기본값 `200000`, 정수
`1..2147483647`)는 라우팅 모델 반복에서 원시 응답 byte가 연속으로 오지 않는 시간을 제한하며,
비어 있지 않은 byte가 올 때마다 다시 시작됩니다. `webSearchSidecar.timeoutMs`는 호스팅 검색 요청
하나를 별도로 제한합니다. 실제 bridge watchdog은
`max(기본 stall, connect timeout, 라우팅 모델 stall, 사이드카 timeout) + 30초`입니다. 라우팅 모델
stall은 전체 생성 timeout이 아닙니다. SSE가 시작되기 전 실패는 2xx가 아닌 JSON으로 반환하고,
응답 header가 시작된 뒤의 생성 실패는 `response.failed` SSE로 전달합니다.

## 비전 사이드카

라우팅 모델이 해당 프로바이더의 `noVisionModels`에 있고 요청에 이미지가 들어오면, opencodex는
메인 호출 **전에** 각 이미지를 설명한 텍스트로 바꿉니다. Dashboard와 관리 API의 현재 기본 선택값은
`gpt-5.6-luna`이며, 시작할 때 명시적으로 저장된 기존 `gpt-5.4-mini` 값도 Luna로 마이그레이션합니다.
다만 `visionSidecar.model` 필드 자체가 없으면 비전 실행 경로는 코드 폴백인 `gpt-5.4-mini`를 씁니다.

- 이미지는 사용자, developer, 도구 결과 메시지에서 올 수 있습니다. Codex의 `view_image` 결과도
  포함됩니다.
- 각 이미지는 설정된 네이티브 비전 모델에 `reasoning.effort: "low"`로 전달되고, 설명이 이미지
  부분을 인라인으로 대체합니다.
- 설명은 한 번에 3개씩 병렬 처리하며 입력 순서를 유지합니다. 설명 모델에 전달하는 사용자 문맥은
  800자, 주입하는 이미지 설명은 장당 2,000자로 제한합니다. ChatGPT 백엔드가 거부하는
  `max_output_tokens`는 보내지 않습니다.
- 이미지 URL은 전달 전에 검증합니다. data URL은 `png` / `jpeg` / `jpg` / `webp` / `gif`
  형식이어야 하고, base64 데이터는 약 20 MB로 제한됩니다. `data:`와 `https:` 스킴만 허용하며,
  원격 `https` 이미지는 프록시가 아니라 OpenAI 백엔드가 가져옵니다.
- `noVisionModels` 비교는 Ollama식 `:size` 접미사를 무시하므로 `gpt-oss` 항목 하나로
  `gpt-oss:120b`도 처리할 수 있습니다.
- 이미지 설명이 실패하면 짧은 처리 오류 안내문을 모델에 전달합니다. 사이드카 계획 자체를 만들 수
  없으면 텍스트 전용 백엔드에 원본 이미지를 보내지 않고 제거합니다.
- `maxDescriptionsPerTurn`(기본값 8)은 메인 모델 한 턴에서 새로 실행할 설명 수를 제한합니다. 캐시
  적중과 같은 턴의 중복 요청은 한도를 쓰지 않습니다. 성공한 `data:` 이미지 설명은 백엔드, 모델,
  detail, 이미지 바이트, 메시지 문맥을 기준으로 캐시하며, 바뀔 수 있는 `https:` 이미지는 캐시하지
  않습니다.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

텍스트 전용 모델은 프로바이더별로 표시합니다.

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## 대시보드 설정과 끄기

<!-- TODO(WP5 GUI): GUI 컨트롤이 완성되면 사이드카 설정 화면 안내를 추가하세요. -->

설정 파일 키는 지금 바로 사용할 수 있습니다. 기능을 끄려면 `config.json`에서 해당 사이드카의
`enabled`를 `false`로 설정하세요. Anthropic OAuth 검색과 이미지 설명은 기존 Claude Code OAuth
fingerprint 선례를 따르지만, 실제 계정과 작업량으로 충분히 soak test하는 편이 좋습니다. 전체
필드는 [설정 레퍼런스](/ko/reference/configuration/#sidecars)를 참고하세요.
