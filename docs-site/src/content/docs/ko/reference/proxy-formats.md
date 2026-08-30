---
title: 프록시 API 형식
description: Responses, Chat Completions, Anthropic Messages, 모델 카탈로그, WebSocket, realtime, compaction 표면에 대한 와이어 레벨 참고 문서입니다.
---

opencodex는 하나의 로컬 프록시를 여러 클라이언트 방언으로 제공합니다. Codex 클라이언트는
Responses API를 말할 수 있고, OpenAI 호환 앱은 Chat Completions를 말할 수 있으며, Claude Code는
각 업스트림 공급자가 모든 형식을 구현하지 않아도 Anthropic Messages를 말할 수 있습니다.

일반적인 변환 경로는 다음과 같습니다.

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

Responses 표현이 이 연결의 중심입니다. 네이티브 호환 경로는 변환의 일부를 건너뛰고 요청을 그대로
전달할 수 있지만, 인증, 라우팅, 허용 제어, 응답 안전성은 여전히 프록시 경계에서 처리됩니다.
[Configuration](/reference/configuration/)에서 리스너와 admission 키를 설정하십시오. 하나의 공개 모델 id가
여러 대상 중 하나를 골라야 할 때는 [Combos](/guides/combos/)를 사용하십시오.

## 엔드포인트 개요

| 클라이언트 표면 | 엔드포인트 | 성공한 비스트리밍 결과 | 성공한 스트리밍 또는 소켓 결과 |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE, 또는 WebSocket의 Responses JSON 텍스트 프레임 |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `[DONE]`으로 끝나는 `chat.completion.chunk` SSE |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic token count | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | 해당 없음 |
| 모델 탐색 | `GET /v1/models` | 세 가지 카탈로그 계약 중 하나 | 해당 없음 |
| Voice and Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | 릴레이된 call-creation 응답 | 별도의 sideband WebSocket이 양방향 프레임을 릴레이함 |
| Responses compaction | `POST /v1/responses/compact` | 대체 히스토리 JSON | 해당 없음 |

## `POST /v1/responses`

이것이 opencodex의 기본 데이터 평면 형식입니다. 요청 본문은 비어 있지 않은 `model`을 가진 JSON 객체여야
합니다. `input`은 문자열이거나 Responses 항목 배열일 수 있습니다.

### 허용되는 요청 필드

| 영역 | 허용되는 형식 |
| --- | --- |
| 모델과 입력 | 필수의 비어 있지 않은 `model`; 선택적인 문자열 `input` 또는 항목 배열 |
| 메시지 항목 | `user`, `developer`, `system`, `assistant` 메시지; 역할에 맞는 문자열 콘텐츠 또는 형식화된 콘텐츠 블록 |
| 콘텐츠 블록 | 부모 항목이 허용하는 경우 텍스트, 입력 이미지, 입력 파일, 출력 텍스트, 거부, 추론 요약/텍스트 블록 |
| 도구 히스토리 | `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output` 항목 |
| 도구 | 함수 도구와 느슨한 built-in 또는 hosted tool 항목; `tool_choice`는 `auto`, `none`, `required`, 이름이 지정된 function/custom 선택, hosted 선택, 또는 `allowed_tools`를 받음 |
| 추론 | `reasoning.effort`와 `reasoning.summary` (`auto`, `concise`, `detailed`, `none`) |
| 계속 및 캐싱 | `previous_response_id`, `store`, `prompt_cache_key` |
| 생성 제어 | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty`, `frequency_penalty` |
| 서비스 및 실행 | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata`, `user` |
| 확장된 Responses 필드 | 호환 경로에서는 `background`, `include`, `prompt`, `text`, `truncation`도 허용됩니다 |

알 수 없는 항목 유형은 앞으로의 호환성을 위해 느슨한 형식의 typed item으로 허용됩니다. 변환된 어댑터는
자신이 인식하는 항목 유형만 처리하며, 제공자가 표현할 수 없는 기능은 거부할 수 있습니다.

### JSON과 SSE 출력

`stream: true`이면 응답은 `text/event-stream`입니다. 브리지는 `response.created`, output-item과 text/tool
deltas, 그리고 정확히 하나의 종료 `response.completed`, `response.failed`, 또는 `response.incomplete` 이벤트를
포함한 Responses 이벤트를 내보냅니다. 일반적인 스트림은 `data: [DONE]`으로 끝납니다.

`stream: false`이거나 `stream`이 없으면, 같은 adapter 이벤트가 하나의 Responses JSON 객체로 수집됩니다.
두 형식 모두 선택한 모델, output item, 종료 상태, usage를 보존합니다.

클라이언트로 전달되는 Responses SSE 프레임은 SSE 블록 구분자 앞의 원시 바이트 기준으로 프레임당 4 MiB로 제한됩니다. HTTP에서는 구분자 없이 이 한도를 초과한 업스트림 프레임을 합성 `response.failed` 이벤트와 이어지는 `data: [DONE]`으로 fail closed 처리합니다. Responses WebSocket 브리지에서는 같은 조건에서 502 `websocket_protocol_error`를 보내고 업스트림 reader를 취소합니다. 완전한 Responses 종료 프레임이 이미 수신된 경우에는 그 종료가 우선하며, 이후의 과도한 크기 또는 잘못된 바이트는 완료된 턴을 전송 오류로 바꾸지 않고 버립니다.

:::note
네이티브 passthrough에서는 Responses 종료 이벤트가 우선합니다. 너무 이른 `data: [DONE]`은 해당 이벤트가 도착할 때까지 보류됩니다. 일반 네이티브 경로가 파싱된 종료 이벤트 없이 정상 HTTP 200 EOF에 도달하면, 프록시는 `incomplete_details.reason: "adapter_eof"`가 있는 `response.incomplete` 하나와 `data: [DONE]` 하나를 보냅니다. 구분자 없는 종료 JSON이 문법적으로 유효하면 정확히 한 번 받아들이고, 잘못되었거나 잘린 JSON은 incomplete로 남습니다. 모델별 종료 복구를 사용하도록 설정된 공급자에서는 프레임이 없는 종료 유사 suffix와 EOF의 너무 이른 `data: [DONE]`을, 승격할 수 있는 완전한 lifecycle 후보가 없을 때 `missing_terminal_event`로 fail closed 처리하며, 완전한 후보가 있으면 `response.completed`로 승격합니다. 신뢰도가 높은 `cyber_policy` 종료 형식은 의미론적 로깅 및 집계에서 `error.code: "cyber_policy"`가 있는 `response.failed`(status 400)로 정규화되지만, 이미 시작된 스트리밍 HTTP 응답은 200을 유지합니다. 이 커밋된 요청 경계에서는 재시도하거나 재전송하지 않습니다.
:::

canonical ChatGPT forward streaming은 stable Bun 1.4.0 이상에서 Codex 업스트림 WebSocket을
투명하게 사용할 수 있습니다. 번들 Bun 1.3.14, prerelease, 또는 검증 불가능한 런타임 identity는
HTTP/SSE를 사용합니다. 업스트림 WS adapter는 같은 downstream SSE 계약을 유지하며, 원시 JSON
프레임과 SSE envelope를 각각 4 MiB로 제한하고 8 MiB byte queue가 넘치기 전에 업스트림을 닫습니다.
queue overflow 시 downstream에는 terminal `response.failed` 이벤트와 `[DONE]`을 내보냅니다.

모든 종료 Responses usage 객체에는 제공자가 해당 세부 정보를 보고하지 않았더라도 두 상세 객체가 모두
포함됩니다.

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

사용 가능한 경우 `input_tokens_details`에는 `cache_write_tokens`도 포함될 수 있습니다. 항상 존재하는 상세 객체는
엄격한 Responses 클라이언트를 위한 호환성 보장입니다. 0은 "보고되지 않음"을 뜻할 수 있으며, 반드시
"제공자가 그런 작업을 하지 않았다"는 의미는 아닙니다.

### 응답과 요청 로그 연결

허용된 모든 HTTP Responses 응답에는 프록시가 생성한 `ocx-<32 hex>` 형식의 ID를 담은
`x-opencodex-request-id` 헤더가 있습니다. 이 값은 응답을 요청 로그 및 사용량 보고의 해당 행과 연결하는 키입니다.

프록시는 이 값을 항상 직접 생성하고 호출자가 제공하거나 업스트림이 반환한 ID를 덮어쓰므로, 이 프록시에서
고유하며 상관관계 키로 신뢰할 수 있습니다. 이 헤더는 `Access-Control-Expose-Headers`에 명시되어 있어 브라우저
JavaScript가 교차 출처에서도 읽을 수 있습니다. 사용자 지정 `x-` 헤더는 실제 전송 데이터에 있더라도 그렇지 않으면
`response.headers.get()`에서 보이지 않습니다.

인증 또는 출처 허용 단계에서 거부된 Responses 요청은 이 래퍼에 도달하지 않으며 ID가 없습니다. 따라서 헤더가
없다는 것은 요청이 로그에 기록되기 전에 거부되었다는 뜻입니다.

### 같은 경로에서의 WebSocket 업그레이드

`websockets`가 활성화되어 있으면 클라이언트는 HTTP POST를 여는 대신 `/v1/responses`로 업그레이드할 수
있습니다. 인증과 origin admission은 WebSocket 핸드셰이크 동안 처리됩니다. 각 프레임 안에서 다시 반복되지는
않습니다.

이 클라이언트 업그레이드는 위의 투명한 업스트림 ChatGPT WebSocket 선택과 별개이며,
`websockets` 설정은 클라이언트 엔드포인트만 제어합니다.

클라이언트는 JSON 텍스트 프레임을 보냅니다.

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

`type`을 제외한 모든 것은 Responses 요청 본문이 되며, 프록시는 해당 턴을 강제로 스트리밍으로 처리합니다.
새 `response.create`는 같은 소켓에서 이전 턴을 대체하고 취소합니다. `response.processed`는 no-op 확인으로
받아들입니다. 파싱할 수 없거나 관련 없는 프레임 유형은 무시됩니다.

서버 프레임은 JSON 텍스트 프레임입니다. 성공한 스트리밍 출력은 SSE `data:` 줄에 나타날 JSON payload와 같은
내용이지만, SSE envelope나 `[DONE]`은 없습니다. 비스트리밍 내부 결과는 `response.created`, 이어서 0개 이상의
`response.output_item.done` 프레임, 마지막으로 종료 프레임으로 재프레임됩니다. 오류는 다음 envelope를
사용합니다.

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

`generate: false`가 있는 warmup frame은 업스트림을 호출하지 않습니다. 대신 빈 response id와 출력이 없는
`response.created` 뒤에 `response.completed`를 반환합니다.

:::note
WebSockets가 비활성화되어 있으면 업그레이드 시도는 `upgrade_required` 코드와 함께 HTTP 426을 받습니다.
Codex는 그 핸드셰이크 결과를 해당 세션에서 HTTP로 되돌아가라는 신호로 처리합니다. 모델 턴 실패가 아닙니다.
:::

## `POST /v1/chat/completions`

이 엔드포인트는 필수 `model`과 비어 있지 않은 `messages` 배열을 가진 OpenAI 호환 Chat Completions 요청을
받습니다. system, user, assistant, tool 메시지를 내부 Responses 항목으로 변환하고, function tools, tool
choice, 이미지, reasoning effort, 지원되는 response format을 변환한 뒤, 일반 Responses 라우팅 파이프라인을
실행하고, 결과를 다시 변환합니다.

비스트리밍 출력의 `object`는 `"chat.completion"`입니다. 스트리밍 출력은 `object: "chat.completion.chunk"`인
SSE 객체, choice delta, `finish_reason`이 있는 종료 choice, `data: [DONE]`을 사용합니다. tool-call과 usage
정보는 원본 이벤트가 그것들을 담고 있을 때 다시 변환됩니다.

내부 실행 경로가 Responses 기반이기 때문에 provider adapter는 더 좁은 기능 집합을 강제할 수 있습니다. 예를
들어 선택된 adapter로 표현할 수 없는 요청 기능은 의미를 바꾸지 않고 오류로 반환됩니다.

## `POST /v1/messages`와 `count_tokens`

이 엔드포인트는 Claude Code와 호환 클라이언트가 사용하는 Anthropic Messages 방언을 말합니다. 대부분의 요청은
Responses로 변환되어 일반적으로 라우팅된 뒤, Anthropic JSON 또는 Anthropic SSE로 다시 변환됩니다.

네이티브 Anthropic passthrough는 다음이 모두 참일 때만 적용됩니다.

- Claude Code 설정에서 native passthrough가 비활성화되어 있지 않습니다.
- 요청한 모델이 `claude` 또는 `anthropic`으로 시작합니다.
- 요청에 네이티브 Anthropic bearer 또는 `x-api-key` 자격 증명이 들어 있습니다.
- 비루프백 listener에서는 `x-opencodex-api-key`에만 유효한 프록시 admission이 들어 있습니다.
- 설정된 alias 또는 model map이 해당 model id를 라우팅 대상으로 점유하고 있지 않습니다.

적합한 요청은 Anthropic 방언으로 전달되므로 네이티브 beta 헤더, thinking 서명, 구독 식별 정보가 끝까지
유지됩니다. 그렇지 않으면 Responses 왕복을 탑니다.

전용 admission 헤더는 upstream으로 전달되지 않습니다. `Authorization` 또는 `x-api-key`에서
프록시 admission secret이 발견되어도 제거하며, 별도의 실제 Anthropic 자격 증명은 유지합니다.
쉼표로 결합된 모호한 자격 증명 헤더는 전달하지 않고 fail closed합니다.

`POST /v1/messages/count_tokens`도 같은 model resolution과 passthrough 판단을 따릅니다. 네이티브로 적합한
요청은 Anthropic의 count endpoint로 전달됩니다. 그 외 요청은 system content, messages, tools에 대한 로컬
문서화 추정치를 사용하고 다음을 반환합니다.

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

같은 경로가 서로 호환되지 않는 카탈로그 envelope를 기대하는 세 가지 클라이언트를 모두 처리합니다.
`client_version`이 함께 있지 않으면 Anthropic 형식이 우선합니다.

| 계약 | 트리거 | 최상위 형식 | 모델 id 동작 |
| --- | --- | --- | --- |
| Anthropic model list | `anthropic-version` 헤더 또는 `client_version`이 없는 `?flavor=anthropic` | Anthropic model-info 항목이 들어 있는 `{ "data": [...] }` | Claude Code는 읽기 쉬운 id를 받고, Desktop은 프로필별 alias 패밀리를 받을 수 있음 |
| Codex 카탈로그 | `client_version` 쿼리 파라미터 | `{ "models": [...] }` | 네이티브 및 라우팅 항목은 더 풍부한 Codex 카탈로그 필드, 표시 여부, effort, WebSocket, 다중 에이전트 메타데이터를 담음 |
| 일반 OpenAI list | 어느 트리거도 아님 | `{ "object": "list", "data": [...] }` | 보이는 네이티브 id는 그대로이며, 라우팅 id는 alias 또는 `provider/model` |

## `POST /v1/live`와 Realtime sideband

`POST /v1/live`는 ChatGPT/Codex App Frameless call-creation 표면을 받습니다.
`POST /v1/realtime/calls`는 OpenAI Realtime call-creation 표면을 받습니다. opencodex는 적절한 OpenAI 계열
경로를 선택하고, 업스트림 인증 모드에 맞게 call-creation 요청을 정규화한 뒤, 제한된 응답을 릴레이합니다.

call creation 이후 클라이언트는 다음의 지원되는 모든 inbound 형식 중 하나로 sideband WebSocket에 참여할 수
있습니다.

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

프록시는 업스트림 join URL을 정규화한 뒤, 양방향 텍스트 및 바이너리 프레임을 투명하게 릴레이합니다. 업스트림
인증은 프록시가 소유한 상태로 유지되며, 클라이언트 프로토콜 헤더는 보존됩니다.

## `POST /v1/responses/compact`

Compaction은 긴 Responses 대화를 줄여야 하는 클라이언트를 위해 대체 히스토리를 반환합니다.

| 경로 유형 | 동작 |
| --- | --- |
| 정식 ChatGPT 또는 공식 OpenAI 경로 | 확인된 계정과 모델 인증을 사용해 요청을 네이티브 `/responses/compact` endpoint로 전달합니다 |
| 다른 라우팅된 모델 | `compaction_trigger`가 있는 내부 비스트리밍 no-tools compaction 턴을 실행합니다. `encrypted_content`가 `ocx1:` envelope인 synthetic `compaction` 항목이 정확히 하나 있어야 하며, 그 요약을 v1 replacement history로 디코딩합니다 |

네이티브 compact 응답은 선언된 `Content-Length`가 이미 한도를 넘는 응답을 포함해 최대 32 MiB로 버퍼링됩니다.
compact 전용 실패는 다음과 같습니다.

| 상태 | 유형 또는 코드 | 의미 |
| --- | --- | --- |
| 400 | `invalid_request_error` | JSON/body 형식이 잘못되었거나 model이 없습니다 |
| 404 | `invalid_request_error` | 요청한 model을 라우팅할 수 없습니다 |
| 499 | `client_cancelled` | 전달 또는 버퍼링 중에 client가 취소했습니다 |
| 502 | `compact_response_too_large` | 네이티브 compact 출력이 32 MiB를 초과했습니다 |
| 502 | `upstream_error` | 연결, 읽기, 또는 synthetic compaction 턴 실패 |
| 502 | `invalid_response_error` | synthetic 턴이 유효하고 비어 있지 않은 `ocx1:` compaction 항목을 정확히 하나 만들지 못했습니다 |

## 인증 매트릭스

loopback 전용 bind에서는 data-plane admission에 설정된 key가 필요하지 않습니다. remote bind에서는 아래
매트릭스를 사용하십시오. “Dedicated”는 `X-OpenCodex-API-Key`를 뜻하고, 다른 열은 `Authorization: Bearer ...`
와 `x-api-key`를 뜻합니다.

| 표면 | Dedicated | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP and WebSocket | 필요함 | proxy admission에서는 거부됨 | 거부됨 |
| `/v1/responses/compact` | 필요함 | proxy admission에서는 거부됨 | 거부됨 |
| `/v1/chat/completions` | 필요함 | proxy admission에서는 거부됨 | 거부됨 |
| `/v1/messages`와 `/v1/messages/count_tokens` | 허용됨 | 허용됨 | 허용됨 |
| `/v1/models` | 허용됨 | 허용됨 | 허용됨 |
| `/v1/live`, `/v1/realtime/calls`, 및 sideband joins | 허용됨 | 허용됨 | 허용됨 |

Responses 계열과 Chat 요청은 `Authorization`을 provider 또는 Codex Direct passthrough용으로 예약하므로, remote
proxy key는 전용 헤더를 사용해야 합니다. Messages와 Realtime 표면은 더 넓은 클라이언트 호환성이 필요하므로
세 가지 형식을 모두 허용합니다.

:::caution
data-plane key는 management credential이 아닙니다. management API는 별도의 admin secret을 사용합니다.
[Management API](/reference/management-api/)를 보십시오. 하나의 secret을 두 평면에 함께 재사용하지 마십시오.
:::

## 공통 오류 어휘

필요할 때는 클라이언트 방언의 envelope를 사용하지만, 다음 status/code 의미는 변하지 않습니다.

| 상태 | 유형 또는 코드 | 의미 |
| --- | --- | --- |
| 401 | `authentication_error` | 필요한 프록시 admission credential이 없거나 유효하지 않습니다 |
| 403 | `origin_rejected` | Responses/OpenAI data-plane 요청 또는 WebSocket 업그레이드가 허용되지 않은 origin에서 들어왔습니다 |
| 503 | `combo_unavailable` | 선택한 combo의 모든 대상이 사용할 수 없거나, cooldown 중이거나, 비활성화되어 있거나, 다른 이유로 부적합합니다 |
| 400 | `unreadable_encrypted_agent_task` | 암호화된 v2 worker task를 소비할 수 있는 적격 네이티브 ChatGPT 대상이 없습니다 |
| 426 | `upgrade_required` | Responses WebSocket transport가 비활성화되어 있거나 업그레이드에 실패했습니다. HTTP를 사용하십시오 |

Anthropic-origin 실패는 Anthropic의 error envelope로 렌더링됩니다. 따라서 해당 방언에서 origin 거부는
OpenAI 스타일 `origin_rejected` body가 아니라 403 `permission_error`입니다.

## 암호화된 콘텐츠 위생

프록시는 실제 백엔드 암호문을 불투명한 데이터로 취급합니다. 구조적으로 유효한 암호문은 바이트 단위로
그대로 보존됩니다. opencodex는 이를 복호화하거나, 내용을 번역하거나, 다른 프로바이더용으로 다시
암호화하지 않습니다.

일부 에이전트 hook은 과거에 평문 제어 텍스트를 `encrypted_content` 슬롯에 넣었습니다. 호환성을 위해
프록시는 구조적으로 유효한 Fernet 구간은 그대로 유지하면서 해당 평문을 텍스트 파트로 분리합니다.
이 복구 과정에서 `agent_message`의 암호화된 파트가 모두 사라지면 일반 user message가 됩니다. 현재 v2
작업이 실제로 암호화된 상태이고 선택된 라우팅 대상이 네이티브 ChatGPT 암호문을 읽을 수 없다면,
opencodex는 읽을 수 없는 바이트를 프로바이더에 보내는 대신 `unreadable_encrypted_agent_task`로
실패합니다. worker task와 관련된 클라이언트 동작은 [서브에이전트 표면](/guides/sub-agent-surface/)을
참조하세요.
