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
[`bridge.ts`](/ko/reference/architecture/#브리지)가 이벤트를 Responses SSE로 바꿉니다.

## `openai-chat`

**대상:** OpenAI **Chat Completions**(`POST {baseUrl}/chat/completions`)와 모든 호환 프로바이더
— xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama(로컬) 등.
**인증:** `key`(Bearer).

- 내부 메시지를 OpenAI role로 변환하고, 툴은 `{type:"function", function:{…}}`과
  `tool_choice`(`auto`/`none`/`required` 또는 지정 함수)로 매핑합니다.
- **툴 결과에 든 이미지**는 `role:"tool"`이 텍스트 전용이므로, 툴 라운드가 닫힌 뒤 후속
  user vision 메시지(`image_url` 파트)로 전달됩니다. 툴 메시지에는 `[image]` 마커가 앵커로
  남습니다.
- **Codex의 GPT-5 정체성 프롬프트를 다시 작성**해 모델 중립적인 소개로 바꿉니다. 따라서 라우팅된
  모델이 자신을 OpenAI라고 주장하지 않습니다.
- 정확한 단계가 없으면 **`reasoning_effort`를 모델이 알린 하위 집합에 맞춰 조정**합니다.
  프로바이더가 명시적으로 alias를 설정하지 않는 한 `xhigh`와 `max`는 서로 다른 레이블로
  유지합니다. `provider.noReasoningModels`에 든 id에는 값을 **아예 보내지 않습니다**.
- `delta.content`(텍스트), `delta.reasoning_content`(thinking), `delta.tool_calls[]`를
  스트리밍하고 `usage`를 수집합니다.
- ClinePass는 라이브로 검증된 게이트웨이 형식 `reasoning: { enabled: true, effort }`을 사용하며,
  reasoning을 끌 때는 `{ enabled: false }`를 사용합니다. 공개 API 문서에는 현재 이 요청 형식이
  명시되어 있지 않습니다. 어댑터는 요청한 `low`, `medium`, `high`, `xhigh`, `max` 단계를 그대로
  유지하고, `delta.reasoning_content` 또는 `delta.reasoning`을 reasoning delta로 처리하며,
  `stream_options.include_usage`로 스트림 usage를 요청하고 비스트림 응답 envelope에서도 usage를 읽습니다.

## `ollama-native`

**대상:** OpenAI 호환 표면이 아니라 Ollama 자체의 **Chat API**(`POST /api/chat`). 내장
`ollama-cloud` 공급자는 이 어댑터로 레지스트리에서 선택되며, 별도 이름의 커스텀/셀프호스팅
Ollama 공급자에 `adapter: "ollama-native"`로 설정할 수도 있습니다.
**인증:** cloud/커스텀 대상은 `key`(Bearer). loopback 또는 `authMode: "local"` 대상에는
자격 증명을 보내지 않습니다.

- **레지스트리 선택이 실질적입니다.** 내장 `ollama-cloud` 행은 `/v1/models` 라이브 발견을 위해
  `https://ollama.com/v1` 기준 URL을 유지하면서 추론은 `POST https://ollama.com/api/chat`으로
  정규화됩니다. 이 공급자 행에서는 설정한 `adapter`가 버려집니다. 일반 내장 로컬 Ollama는
  `openai-chat`을 유지하며, 로컬/셀프호스팅 대상에 `ollama-native`를 선택하는 것은 명시적인
  공급자 구성 결정이고 호스트로 판별되므로 비(非)Ollama 대상이 조용히 재작성되지 않습니다.
- **모델 메타데이터:** `/v1/models`에는 모델별 메타데이터가 없으므로, 정식 Ollama Cloud에서는
  *제한된* `POST /api/show`(응답 256 KiB, 요청당 8초, 동시성 4, 48요청, 전체 단계 12초 마감)로
  발견된 각 id를 보완해 실제 context window와 vision 지원을 채웁니다. show 요청은 동일
  오리진이며 리다이렉트를 따르지 않고, 실패해도 해당 모델만 저하되고 발견 자체는 실패하지 않습니다.
- **스트리밍:** Ollama 네이티브 NDJSON. 텍스트와 `message.thinking` delta를 도착 즉시 전달하고,
  `done: true` 터미널 레코드에서만 턴을 완료합니다. 버퍼된 `done: false`나 누락된 터미널은 부분
  텍스트와 tool call을 전부 억제합니다.
- **Reasoning:** Ollama 네이티브 `think` 필드(`low`/`medium`/`high`/`max` 및 불리언)로 매핑되고
  모델의 공개 ladder로 클램프되며, 업스트림에서 구성한 `__omit__` sentinel 의미를 따릅니다.
- **이미지:** vision 지원 모델이면 메시지의 `images` 배열로 네이티브 전송됩니다. video는 잘못
  보내지 않고 거부하며, 원격 이미지 URL은 가져오지 않습니다.
- **도구:** Ollama 네이티브 형태로 선언되고, 스트림 tool call은 `arguments`가 객체인 whole-call
  레코드이며 tool result 리플레이는 call id와 tool 이름으로 엄격히 짝지어집니다.
  `tool_choice: "none"`과 `auto`는 정상 동작합니다. **`required`나 정확한 이름 지정은 fail
  closed**입니다. Ollama의 `/api/chat`에는 이를 강제할 `tool_choice` 필드가 없기 때문입니다.
- **구조화 출력은 정식 Ollama Cloud에서 거부됩니다.** Ollama는 현재 Cloud에서 구조화 출력을
  지원하지 않는다고 문서화하고 있으며 Cloud는 `format` 필드를 강제하지 않습니다. 따라서
  OpenCodex는 스키마가 지정된 요청에 자유 서술을 돌려주는 대신 요청을 닫고 실패시킵니다. 로컬 /
  커스텀 `ollama-native` 엔드포인트는 Ollama 네이티브 `format` 매핑(`json_object` → `"json"`,
  `json_schema` → schema 객체 자체)을 유지합니다.

## `openai-responses`

**대상:** OpenAI **Responses API**. **`passthrough: true`** — 일반적으로 원본 요청과 응답을
그대로 전달하되, 라우팅된 게이트웨이에 필요한 좁은 호환성 변환만 적용합니다.
**인증:** 정규 OpenAI `forward`는 안전한 호출자 헤더 허용 목록만 중계합니다. 비정규
`forward`는 호출자 authorization을 중계하지 않고 설정된 정적 헤더만 사용하며, `key`는
설정된 provider 키를 사용합니다.

비정규 Responses 게이트웨이에는 Codex의 클라이언트 실행형 `tool_search` 선언을 공개 function
도구와 충돌하지 않는 이름으로 전달합니다. 일치하는 요청 기록과 JSON/SSE function call은
클라이언트용 비공개 `tool_search` 수명 주기로 복원합니다. 정규 OpenAI forward 경로는
네이티브 비공개 타입을 그대로 유지합니다.

`key` 인증에서는 [`retryOn429`](/ko/reference/configuration/)도 여기에 적용됩니다: 사전 스트림
429는 번역된 `openai-chat`/Anthropic 요청 경로와 동일하게 다른 처리나 페일오버보다 먼저
같은 키로 동일 요청을 대기 후 재전송합니다. 커스텀 `runTurn` 전송은 HTTP 재시도 루프에
포함되지 않습니다.

- DeepSeek의 stateless Responses 파서는 제공자 범위의 기록 정규화를 받습니다: 훅으로
  주입된 컨텍스트는 명확한 tool-call/result 배치 뒤로 이동합니다. 병렬 호출은 각 결과 앞에
  함께 묶여 있어 모든 호출이 추론을 담은 어시스턴트 턴에 남습니다. 관대한 제공자와 중복되거나
  누락되거나 순서가 잘못된 call ID는 원래 입력 순서를 유지합니다.

- `forward` URL → `{baseUrl}/responses`. `key` provider는 기본적으로 기존 `{baseUrl}/v1/responses` 구성을 사용합니다.
- `key` provider는 검증된 상대 `responsesPath`를 설정할 수 있습니다. adapter는 `baseUrl` 끝의 `/` 하나를 제거하고 `{trimmedBaseUrl}{responsesPath}`로 전송합니다. Ark Agent Plan은 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"`와 `responsesPath: "/responses"`를 사용합니다.
- `forward` 모드에서는 안전한 헤더 허용 목록(`FORWARD_HEADERS`)만 중계합니다. authorization,
  ChatGPT account id, OpenAI beta/originator/session 헤더가 대상입니다. 이 ChatGPT 로그인 경로는
  [사이드카](/ko/guides/sidecars/)에도 쓰입니다.

## `anthropic`

**대상:** Anthropic **Messages**(`/v1/messages`).
**인증:** `key`(기본 `x-api-key`, 또는 `apiKeyTransport: "bearer"` 설정 시 `Authorization: Bearer`) 또는 `oauth`(Bearer + `anthropic-beta`, Claude Pro/Max용).

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
- Gemini가 tool-call id를 생략하면 합성합니다. Vertex와 Antigravity에서는 불투명한
  `thoughtSignature` 값을 보존하고 재사용해 tool-result 후속 턴에서도 reasoning 연속성을 유지합니다.
  서명 캐시는 설정 디렉터리에 스냅샷되므로 프록시 재시작 후에도 후속 턴이 유지됩니다.

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
### 완료와 네이티브 stop reason

Kiro의 어시스턴트 텍스트에는 그 자체로 턴 종료를 알리는 신뢰할 만한 구분이 없습니다. 다만 종단
`metadataEvent`가 네이티브 `stopReason`을 실어 올 수 있습니다. 하지만 Kiro가 진행 문구에도 `END_TURN`을
붙일 수 있으므로, 툴이 있는 턴에서는 `END_TURN`과 `STOP_SEQUENCE`만으로 완료하지 않습니다. 일반 텍스트는
commentary로 유지하고 비공개 완료 툴을 한 번 검증합니다.

`END_TURN`, `STOP_SEQUENCE`, 또는 stop reason이 없을 때는 한 번의 완료 호환 경로를 탈 수 있습니다. 그 외 명시적인 이유는 이미 상류에서 추론을 끝냈으므로
다시 모델에 요청하지 않고 그대로 보고합니다. 출력 토큰 한도는 이어쓸 수 있는 incomplete로, 컨텍스트 윈도
고갈은 재시도 불가한 context-length 오류로, 필터링이나 가드레일 정지는 filtered incomplete로 표면화합니다.
실제 툴 호출 없이 온 `TOOL_USE`는 진행이 아니라 모순으로 처리합니다.

툴이 있는 턴에는 비공개 `codex_kiro_final_answer`를 추가합니다. 완료 재시도는 빈 assistant/user 턴을 만들지
않고 원래 user/tool-result를 보존하며, 전송 전에 역할 교대·빈 구조 메시지·tool use/result 짝을 검증합니다.
완료 툴 답변은 이전 commentary와 같더라도 `final_answer`로 내보냅니다.
사용자만 줄 수 있는 결정·정보·설명이 없어 더 진행할 수 없을 때도 그 질문을 완료 툴로 보내고 멈추도록 계약이 지시합니다. 이때도 commentary가 아니라 턴이 끝난 `final_answer`로 도착합니다.

### Reasoning effort

`gpt-5.6-sol`과 `claude-opus-5`는 네이티브 effort를 지원하며 요청 필드 이름이 다릅니다.
`low` / `medium` / `high` / `xhigh` / `max` 값은 각각
`additionalModelRequestFields.reasoning.effort`와 `output_config.effort`로 전송됩니다.


## `cursor`

**대상:** 기본값은 `api2.cursor.sh`의 HTTP/2 Connect 스트리밍
`agent.v1.AgentService/Run`입니다. `upstreamHttpVersion: "http1.1"` 또는 `"h1"`을 설정하면
Cursor의 HTTP/1.1 호환 조합을 사용합니다. 서버 출력은 `agent.v1.AgentService/RunSSE`, 클라이언트
메시지는 `aiserver.v1.BidiService/BidiAppend`로 전송합니다. 이 설정은 추론과 live model
discovery에 모두 적용됩니다.
**인증:** `provider.apiKey` 또는 전달된 authorization 헤더의 Cursor OAuth/access token.

- 일반 fetch/parse 경로 대신 `runTurn`을 사용합니다. 요청, 서버 이벤트, 툴 인자, 사용량 checkpoint,
  클라이언트 응답은 `cursor/gen/agent_pb.ts`의 `@bufbuild/protobuf` 스키마로 인코딩한 뒤 Connect
  메시지로 framing합니다.
- content-addressed blob으로 대화 상태를 재생하고 서버 툴 호출을 Codex에 다시 매핑합니다. protobuf
  `GetUsableModels` RPC로 실시간 Cursor 모델을 찾으며, run 요청이 wire에 commit되기 전까지만
  재시도합니다.
- 도구 없이 정상 완료된 턴 뒤에는 Cursor가 돌려준 ConversationStateStructure를 프로세스 로컬
  store에 보관하고, 검증된 선형 이어말하기에서는 전체 root history를 다시 만들지 않고 그
  checkpoint를 재사용합니다. tool-result 턴은 커버된 메시지 경계를 알 수 있을 때만 마지막 정상
  완료 턴의 checkpoint에 커버되지 않은 suffix를 붙입니다. ref 없는 prefix 조회는 기억된 Cursor
  대화 또는 안정적인 클라이언트 스레드
  (범위가 제한된 Desktop session/thread 대체 식별자 포함)와 같은 provider 대화가 소유한
  checkpoint가 있을 때만 허용하며, 그 외에는 full replay합니다.
  compaction, helper/shadow 격리, 계정/모델 불일치, 없는 ref, decode 실패,
  forced-fresh 복구, invalid_argument 재시도는 기존 full replay로 돌아갑니다. 프로세스 재시작은
  메모리 store를 버리고 full replay합니다. Cursor Connect는 권위 있는 cache_read_tokens를 주지
  않으므로 OpenCodex usage만 보고 cache hit라고 단정하지 않습니다.
  범위가 제한된 Desktop 대체 식별자는 프로세스 로컬 HMAC 파생 소유자만 보관하며, 원본
  session/thread 헤더나 OAuth/authorization 자료를 checkpoint 상태에 쓰지 않습니다. OAuth 기반
  live transport와 계정별 live model discovery는 아직 실험 기능입니다. 로그인과 transport 설정은
  [공급자 가이드](/ko/guides/providers/)와 [Cursor 공급자 설정](/ko/reference/configuration/providers/#cursor-provider-adapter-cursor)을
  참고하세요. checkpoint 재사용 자체는 자동이며 사용자 설정이 없습니다.
- `cursor/grok-4.5-fast`는 선택 가능한 모델로 유지하되, Cursor에는 정식 `grok-4.5` 모델을 보내고
  별도의 `effort`, `fast=true` 값은 `requested_model.parameters`에 담습니다.
- Cursor 네이티브 로컬 파일시스템/shell/network 실행은 기본적으로 거부합니다. 명시적인
  `mcpServers`와 `desktopExecutor` 통합은 각각 별도 opt-in입니다. `nativeLocalExec: "on"`은
  더 넓은 내장 executor를 켜며 Codex 승인/샌드박스 규칙을 우회합니다. 예전 설정인
  `unsafeAllowNativeLocalExec: true`는 `nativeLocalExec`을 지정하지 않았을 때만 같은 뜻입니다.

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
