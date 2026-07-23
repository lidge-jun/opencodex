---
title: 어댑터
description: 7가지 프로바이더 어댑터의 대상, 요청 구성 방식, 고유 동작.
---

**어댑터**는 opencodex의 내부 요청/응답 모델과 프로바이더 wire 형식 사이를 변환합니다. 모든
어댑터는 `ProviderAdapter` 인터페이스(`src/adapters/base.ts`)를 구현합니다.

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // custom retry/transport
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  runTurn?(parsed, incoming, emit): Promise<void>;      // bidirectional transport
}
```

`buildRequest`는 `OcxParsedRequest`를 업스트림 HTTP 요청으로 내리고, `parseStream` /
`parseResponse`는 프로바이더 응답을 내부 `AdapterEvent`로 올립니다. `fetchResponse`가 있으면
어댑터가 재시도와 타임아웃을 직접 맡습니다. `runTurn`은 한 번의 HTTP fetch와 뒤이은 응답
스트림으로 표현할 수 없는 전송 방식을 지원합니다. 이후
[`bridge.ts`](/opencodex/ko/reference/architecture/#브리지)가 이벤트를 Responses SSE로 바꿉니다.

## `openai-chat`

**대상:** OpenAI **Chat Completions**(`POST {baseUrl}/chat/completions`)와 모든 호환 프로바이더
— xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama(로컬 및 클라우드) 등.
**인증:** `key`(Bearer).

- 내부 메시지를 OpenAI role로 변환하고, 툴은 `{type:"function", function:{…}}`과
  `tool_choice`(`auto`/`none`/`required` 또는 지정 함수)로 매핑합니다.
- **Codex의 GPT-5 정체성 프롬프트를 다시 작성**해 모델 중립적인 소개로 바꿉니다. 따라서 라우팅된
  모델이 자신을 OpenAI라고 주장하지 않습니다.
- 정확한 단계가 없으면 **`reasoning_effort`를 모델이 알린 하위 집합에 맞춰 조정**합니다.
  프로바이더가 명시적으로 alias를 설정하지 않는 한 `xhigh`와 `max`는 서로 다른 레이블로
  유지합니다. `provider.noReasoningModels`에 든 id에는 값을 **아예 보내지 않습니다**.
- `delta.content`(텍스트), `delta.reasoning_content`(thinking), `delta.tool_calls[]`를
  스트리밍하고 `usage`를 수집합니다.

## `openai-responses`

**대상:** OpenAI **Responses API**. **`passthrough: true`** — 원본 요청 본문을 전달하고 응답을
**변환하지 않은 채** 스트리밍합니다.
**인증:** `forward`(호출자 헤더 중계) 또는 `key`.

- `forward` URL → `{baseUrl}/responses`. `key` provider는 기본적으로 기존 `{baseUrl}/v1/responses` 구성을 사용합니다.
- `key` provider는 검증된 상대 `responsesPath`를 설정할 수 있습니다. adapter는 `baseUrl` 끝의 `/` 하나를 제거하고 `{trimmedBaseUrl}{responsesPath}`로 전송합니다. Ark Agent Plan은 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"`와 `responsesPath: "/responses"`를 사용합니다.
- `forward` 모드에서는 안전한 헤더 허용 목록(`FORWARD_HEADERS`)만 중계합니다. authorization,
  ChatGPT account id, OpenAI beta/originator/session 헤더가 대상입니다. 이 ChatGPT 로그인 경로는
  [사이드카](/opencodex/ko/guides/sidecars/)에도 쓰입니다.

## `anthropic`

**대상:** Anthropic **Messages**(`/v1/messages`).
**인증:** `key`(`x-api-key`) 또는 `oauth`(Bearer + `anthropic-beta`, Claude Pro/Max용).

- 메시지를 Anthropic content block(text, base64 image, `tool_use`, `thinking`)으로 변환합니다.
- **Extended thinking 계산:** Anthropic은 `max_tokens > thinking.budget_tokens`를 요구합니다.
  어댑터는 reasoning effort를 budget으로 매핑하고(minimal 1024 … max 32000), 출력 여유를 둔
  안전한 `max_tokens`를 계산합니다. thinking이 켜지면 Anthropic에서 금지한
  **`temperature`/`top_p`를 제거**합니다.
- 항상 `anthropic-version: 2023-06-01`을 보냅니다. `content_block_delta`(`text_delta`,
  `thinking_delta`, `input_json_delta`)를 스트리밍합니다.

## `google`

**대상:** Google **Gemini**, **Vertex AI**, Antigravity **Cloud Code Assist**. AI Studio는
`/v1beta/models/{model}:streamGenerateContent`, 나머지 모드는 각 Google 네이티브 엔드포인트를
사용합니다.
**인증:** `googleMode`에 따라 API 키, Vertex ADC, Google Antigravity OAuth 중 하나를 선택합니다.

- 시스템 프롬프트 → `systemInstruction`; 메시지 → `contents[]`(assistant → `model`); 툴 →
  `functionDeclarations`. data URL 이미지 → `inline_data`.
- Gemini가 tool-call id를 생략하면 합성합니다. Antigravity에서는 실제 `thoughtSignature` 값을
  보존하고 재사용해 다음 턴에서도 reasoning 연속성을 유지합니다.

## `kiro`

**대상:** Kiro가 사용하는 Amazon CodeWhisperer Streaming `GenerateAssistantResponse` 서비스
(`https://runtime.{region}.kiro.dev/`).
**인증:** Kiro 자격 증명의 region/profile 메타데이터와 Kiro OAuth access token(Bearer).

- Kiro `conversationState`를 만들고 Codex 툴과 툴 결과를 매핑하며, Kiro wire가 지원하는 이미지
  block을 보냅니다.
- `application/vnd.amazon.eventstream`을 디코딩해 text/thinking/tool 이벤트를 복원하고, 잘린 툴
  JSON을 감지합니다. 업스트림이 토큰 수를 반환하지 않아 사용량은 추정합니다.
- `fetchResponse`에서 제한된 횟수만 재시도하고 오류를 분류/마스킹합니다. 비스트리밍 파서는 웹 검색
  루프를 위해 같은 이벤트 스트림을 끝까지 소비합니다.

## `cursor`

**대상:** `api2.cursor.sh`의 HTTP/2 Connect 스트리밍
`agent.v1.AgentService/Run`.
**인증:** `provider.apiKey` 또는 전달된 authorization 헤더의 Cursor OAuth/access token.

- 일반 fetch/parse 경로 대신 `runTurn`을 사용합니다. 요청, 서버 이벤트, 툴 인자, 사용량 checkpoint,
  클라이언트 응답은 `cursor/gen/agent_pb.ts`의 `@bufbuild/protobuf` 스키마로 인코딩한 뒤 Connect
  메시지로 framing합니다.
- content-addressed blob으로 대화 상태를 재생하고 서버 툴 호출을 Codex에 다시 매핑합니다. protobuf
  `GetUsableModels` RPC로 실시간 Cursor 모델을 찾으며, run 요청이 wire에 commit되기 전까지만
  재시도합니다.
- Cursor 네이티브 로컬 파일시스템/shell/network 실행은 기본적으로 거부합니다. 명시적인
  `mcpServers`와 `desktopExecutor` 통합은 각각 별도 opt-in입니다. `unsafeAllowNativeLocalExec`은
  더 넓은 내장 executor를 켜며 Codex 승인/샌드박스 규칙을 우회합니다.

## `azure-openai` (별칭: `azure`)

**대상:** **Azure OpenAI**. `openai-responses`를 감싸므로 마찬가지로 `passthrough: true`입니다.
**인증:** `api-key` 헤더의 `key`(Bearer 아님).

- 요청 구성은 Responses passthrough에 맡깁니다. `baseUrl`에 해석되지 않은 템플릿 placeholder가
  없는지 검증하고 `Authorization`을 `api-key`로 바꿉니다. 설정 URL이 Azure v1 Responses API를
  직접 가리키므로 `api-version`은 덧붙이지 않습니다.

## 이미지 유틸리티 (`image.ts`)

이미지를 처리하는 어댑터가 함께 쓰는 헬퍼입니다.

- `parseDataUrl(url)` — `data:<type>;base64,<data>` URL을 `{ mediaType, base64 }`로 나눠
  Anthropic/Google 이미지 block에 사용합니다.
- `contentPartsToText(content)` — 텍스트 전용 툴 메시지를 위해 content part를 텍스트로
  평탄화합니다. 설명이 없는 이미지는 토큰을 폭증시키는 base64 blob 대신 짧은 `[image]` marker가
  됩니다.
