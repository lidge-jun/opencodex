---
title: Factory Droid 브리지
description: 로컬 Responses 호환 브리지를 통해 Factory Droid 모델을 opencodex에 연결합니다.
---

Factory Droid는 에이전트 런타임이며, 문서화된 OpenAI 호환 추론 엔드포인트가 아닙니다. 내부
Factory LLM URL을 사용자 지정 프로바이더로 등록했을 때 `403 Forbidden`이 발생한다면,
opencodex 어댑터나 프로바이더 헤더만 바꿔도 그 비공개 경로가 지원되는 공개 API로 바뀌지는
않습니다.

검증된 연결 구조는 다음과 같습니다.

```text
텍스트 전용 Responses 클라이언트
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> 로컬 Responses 브리지 (http://127.0.0.1:11435/v1/responses)
  -> 공식 droid exec 명령
  -> Factory 계정과 선택 모델
```

이 구조에서는 Factory 자격 증명을 공식 Droid 클라이언트 안에 유지합니다. OpenCodex에는 별도의
로컬 전용 브리지 토큰만 전달합니다.

## 실패 원인과 수정 방법

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| Factory LLM URL에서 `403 Forbidden` | 해당 URL은 서드파티 클라이언트용 범용 OpenAI 엔드포인트로 문서화되지 않음 | 공식 Droid CLI 또는 SDK를 통해 호출 |
| `/models/models`에서 `404` | 프로바이더 Base URL에 `/models`가 이미 포함됨 | `baseUrl`에는 API 루트만 사용하고 검색 경로는 넣지 않음 |
| 모델 검색 실패 | 브리지가 완전한 실시간 카탈로그를 제공하지 않음 | `liveModels: false`와 정적 `models` 목록 사용 |
| 루프백 프로바이더 거부 | 사설 네트워크 접근은 기본적으로 차단됨 | 루프백 브리지에만 `allowPrivateNetwork: true` 설정 |
| `${DROID_BRIDGE_TOKEN}`을 찾지 못함 | opencodex 서비스 환경에 변수가 없음 | 대화형 셸이 아니라 서비스 프로세스에 변수 주입 |
| `OutputTextDelta without active item` | 출력 item과 content part를 열기 전에 text delta를 보냄 | Responses SSE 수명주기 전체를 순서대로 전송 |

따라서 같은 Factory 자격 증명으로 `droid exec`는 성공하지만, 문서화되지 않은 LLM URL 직접
요청은 `403`을 반환할 수 있습니다. 두 결과는 서로 다른 제품 표면을 시험한 것이므로 모순이
아닙니다.

## 준비 사항

1. [Droid CLI](https://docs.factory.ai/droid-cli/quickstart)를 설치하고 로그인합니다.
2. 제한된 headless 요청이 성공하는지 확인합니다.

   ```bash
   droid exec --model glm-5.2 --output-format json "DROID_OK만 답하세요."
   ```

3. `droid exec` 또는 공식 Droid SDK를 호출하면서 아래 엔드포인트를 제공하는 로컬 브리지를
   실행합니다.

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory는 `droid exec`를 비대화형 자동화 표면으로 문서화하며, 스크립트에서는 JSON 출력을
권장합니다. 장시간 유지되는 통합에는 stream JSON-RPC와 공식 TypeScript/Python SDK도 사용할 수
있습니다. 자세한 내용은 [Droid Exec 가이드](https://docs.factory.ai/droid-exec/overview)를
참고하세요.

## 브리지 계약

브리지는 `127.0.0.1`에만 바인딩하고, 무작위 bearer 토큰을 요구하며, 요청 크기와 모델 ID를
제한해야 합니다. 최소 브리지는 다음 Responses `input` 형태만 허용합니다.

- 비어 있지 않은 문자열
- `message` item만 들어 있는 배열. 각 메시지의 role은 `user`, `developer`, `system`,
  `assistant` 중 하나여야 하며, content는 문자열이거나 텍스트 전용 content part여야 합니다.
  입력 role에는 `input_text`, assistant 이력에는 `output_text`만 허용합니다.

Droid를 실행하기 전에 요청 전체를 검증해야 합니다. input part에 이미지나 파일이 있거나,
`tools`에 도구 정의가 하나라도 있거나, `input`에 도구 호출 또는 결과(`function_call`,
`function_call_output`, `custom_tool_call`, `custom_tool_call_output`)가 있으면 Responses 형식의
`invalid_request_error`와 함께 HTTP `400`을 반환합니다. `unsupported_bridge_input`처럼 안정적인
브리지 전용 code를 사용하고 message에서 거부한 필드를 명시하세요. `stream: true`여도 SSE를
시작하기 전에 이렇게 거부해야 합니다. 지원하지 않는 내용을 버리거나 문자열로 바꾸거나
프롬프트에 합치면 안 됩니다.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

허용된 요청에 대해 브리지는 다음 작업을 수행합니다.

1. 허용된 Responses `input`을 프롬프트로 변환합니다.
2. `droid exec --model <id> --output-format json <prompt>`를 실행합니다.
3. 최종 `result`와 `session_id`를 파싱합니다.
4. OpenAI Responses envelope을 반환합니다.
5. 대화 연속성이 필요하면 `previous_response_id`를 Droid session ID에 매핑합니다.

스트리밍 응답은 다음 수명주기를 순서대로 보내야 합니다.

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

브리지를 `0.0.0.0`에 노출하지 말고, Factory 자격 증명을 브리지 bearer 토큰으로 재사용하지
마세요.

## OpenCodex 프로바이더 설정

명시적인 프로바이더 ID `droid`로 사용자 지정 프로바이더를 생성합니다.

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

이 명령은 `providers.droid` 설정 항목을 만듭니다. 대시보드에서 **Providers → droid → JSON
편집**을 열고 해당 프로바이더의 값을 다음 내용으로 바꿉니다.

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

모델 ID는 예시입니다. 로그인한 Factory 계정의 `droid exec`에서 실제로 사용할 수 있는 모델만
남기세요. 이 프로바이더의 업스트림은 Factory HTTP 엔드포인트가 아니라 로컬 브리지이므로
Factory 추론 전용 헤더를 추가하지 않습니다.

프로바이더를 저장하거나 정적 카탈로그를 바꾼 뒤에는 새 세션이 갱신된 카탈로그를 읽도록 Codex
app-server를 동기화하고 재시작합니다.

```bash
ocx sync --restart-codex
ocx doctor
```

Codex app-server 재시작은 진행 중인 Codex 작업을 중단합니다. 해당 세션을 끝내거나 저장한 뒤에만
재시작하세요.

## 전체 경로 검증

각 경계를 따로 확인합니다.

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

프로바이더 행이나 모델 선택기 표시는 카탈로그 노출만 증명합니다. Responses probe가
`droid/<model>` 경로를 통해 실제 응답을 반환해야 연동 성공입니다.

## 현재 한계

위 최소 브리지는 텍스트와 Responses SSE 수명주기만 변환합니다. Codex App과 `codex exec`는
프롬프트에서 도구를 호출하지 말라고 해도 일반적으로 도구 정의를 보내며, 현재 Codex CLI에는 그
정의를 모두 제거하는 범용 플래그가 없습니다. 최소 브리지는 위 계약에 따라 해당 요청을 `400`으로
거부해야 합니다. 도구 정의, 도구 호출과 결과, 권한, 취소, 풍부한 Droid 이벤트를 처리하려면
Factory stream JSON-RPC 모드 또는 공식 Droid SDK를 사용하는 상태 유지 브리지가 필요합니다.
`ocx access test` 성공을 Codex 에이전트나 도구 경로 성공으로 간주하지 마세요.
