---
title: Ollama 호환 클라이언트
description: Ollama API를 사용하는 도구를 opencodex에 연결해 설정된 프로바이더 모델을 사용합니다.
---

opencodex는 Ollama HTTP API의 일부를 제공합니다. 따라서 Ollama와만 통신할 수 있는 도구도 opencodex에
이미 설정한 모델을 사용할 수 있습니다. 요청은 Chat Completions 경로로 변환되어 선택한 프로바이더로
전송됩니다. opencodex는 사용자의 컴퓨터에서 모델을 내려받거나 저장하거나 실행하지 않습니다.

## 클라이언트 연결

프록시 주소를 Ollama 호스트로 사용합니다. 기본 로컬 설치에서는 다음과 같습니다.

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

프록시가 API 키를 요구하는 경우(예: `0.0.0.0` 바인드) `/v1/chat/completions`와 같은 방식으로 키를
보냅니다. 예: `Authorization: Bearer <opencodex key>`. 모델 범위가 지정된 키는 허용된 모델만 보고 사용할 수
있습니다. 이 엔드포인트는 기본 리스너에서만 제공되며, 인증 없는 루프백 리스너, Remote Link, 허브 관리
인그레스에서는 노출되지 않습니다.

## 엔드포인트

| 엔드포인트 | 동작 |
| --- | --- |
| `GET /api/version` | opencodex 버전. |
| `GET /api/tags` | 설정된 프로바이더 모델을 `provider/model` 이름으로 나열합니다. |
| `POST /api/show` | `{ "model": "provider/model" }`은 알려진 정보만 반환합니다. 파일 크기, 다이제스트, 템플릿, 라이선스는 없습니다. |
| `POST /api/chat` | `system`, `user`, `assistant`, `tool` 메시지로 대화합니다. |
| `POST /api/generate` | 선택적 `system`이 있는 단일 프롬프트. |

그 밖의 모든 `/api/*` 경로는 opencodex 관리 API로 남습니다.

## 지원하는 요청 필드

- `model`: `/api/tags`에 있는 이름.
- `stream`: 기본값은 `true`(줄 단위 JSON)입니다. JSON 응답 하나를 받으려면 `false`로 설정합니다.
- `images`: 사용자 메시지(chat) 또는 요청(generate)에 넣는 base64 PNG, JPEG, GIF, WebP.
- `tools`(chat 전용): 함수 도구. assistant 메시지는 각 호출의 `id`를 포함해 그대로 다시 보냅니다.
  `tool` 결과는 `tool_call_id`로, 없으면 `tool_name`으로 연결됩니다.
- `options`: `temperature`, `top_p`, `num_predict`, `stop`.
- `format`: `"json"`만 지원합니다.

각 `/api/chat` 요청은 모든 assistant 메시지에 걸쳐 **도구 호출을 합계 1,024개까지** 허용합니다.
이미 결과가 있는 호출도 합계에 포함됩니다. 한도를 넘으면 프로바이더로 보내기 전에 HTTP 400을 반환합니다.
대화 이력을 줄인 뒤 다시 보내세요. 남겨 둔 도구 결과에는 해당 assistant 도구 호출도 함께 남겨야 합니다.

그 밖의 항목은 무시되지 않고 HTTP 400으로 거부됩니다. `think`, `keep_alive`, `suffix`, `raw`,
`template`, `context`, 기타 `options`, JSON 스키마 `format`, 이미지 URL이 여기에 해당합니다. Ollama의 모델
관리 및 임베딩 엔드포인트는 제공되지 않습니다.

콤보, 라우팅 정책, `--fast` 또는 effort 별칭, 호출자 자신의 자격 증명을 전달하는 프로바이더는 여기서
선택할 수 없습니다. 이러한 요청은 업스트림으로 아무것도 보내기 전에 실패합니다.

## 응답

완료된 응답에는 `done: true`와 `stop`, `tool_calls`, `length` 중 하나인 `done_reason`이 있습니다.
`prompt_eval_count`와 `eval_count`는 프로바이더가 사용량을 보고한 경우에만 나타나며, 소요 시간 필드는
보고되지 않습니다. 스트림은 업스트림 응답이 완전히 끝난 뒤 `done: true` 줄을 정확히 한 번 보냅니다.

오류는 Ollama 형식 `{ "error": "message" }`을 사용하며 HTTP 상태를 유지합니다. 속도 제한과 혼잡 거부에는
`Retry-After`도 포함됩니다. 콘텐츠 필터나 알 수 없는 이유로 중단된 응답은 일반적인 중지가 아니라 오류로
반환됩니다. 스트림이 시작된 뒤 실패하면 마지막 줄은 `error` 객체이며 `done: true` 줄은 뒤따르지 않습니다.

요청은 다른 트래픽과 마찬가지로 대시보드 요청 로그에 표시되며, 응답 헤더
`x-opencodex-request-id`가 해당 행을 가리킵니다.
