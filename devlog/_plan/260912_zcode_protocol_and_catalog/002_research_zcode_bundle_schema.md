# 002 — ZCode 3.11.2 번들 스키마 (app.asar 추출)

조사 대상: `/Applications/ZCode.app/Contents/Resources/app.asar` (307MB, `rg -a`로 추출).
버전 확인: 실행 로그 `[arms] electron initialized env=prod version=3.11.2`.
리포지토리 주석은 3.7.7 / 3.8.1 기준이라 3.11.2 재확인이 필요했다.

## kind enum — 정확히 3값

```js
bt=t.enum(["anthropic","openai","openai-compatible"])
mh=t.enum(["anthropic-messages","openai-chat-completions","openai-responses"])
```

`mh`는 내부 `apiFormat` 표현이고 `bt`가 사용자 config의 `kind`다.

## kind → 요청 경로

```js
function fL(e){switch(e){case"anthropic":return"/v1/messages";case"openai":return"/responses";case"openai-compatible":return"/chat/completions"}}
s(fL,"getDefaultModelProviderEndpointPathForKind")

function IHe(e,t){let n=t.replace(/\/+$/,"");switch(e){case"anthropic":return`${n}/v1/messages`;case"openai_chat":return`${n}/chat/completions`;case"openai_responses":return`${n}/responses`;case"gemini":return n}}
s(IHe,"buildConnectivityRequestUrl")
```

baseURL 정규화는 kind별 접미사를 자동으로 떼어낸다:

```js
function lp(e,o){let r={anthropic:["/v1/messages","/messages"],openai:["/responses"],"openai-compatible":["/chat/completions"]},...}
s(lp,"normalizeModelProviderBaseUrlForKind")
```

따라서 `kind:"openai"` + `baseURL:"http://127.0.0.1:10100/v1"` → `POST http://127.0.0.1:10100/v1/responses`.
ocx는 그 경로를 실제로 서빙한다(`src/server/index.ts:1994`).

## reasoning 필드

사용자 config 모델 엔트리는 `variants`/`defaultVariant` 형태다:

```js
XWe=Q.object({enabled:Q.boolean().optional(),variants:Q.array(Q.string().min(1)).optional(),defaultVariant:Q.string().min(1).optional(),aliases:Q.record(Q.string(),Q.string()).optional()}).passthrough()
```

내부 카탈로그는 `levels`/`defaultLevel`이고 양방향 변환기(`openCodeReasoningToModelReasoning`)가 있다.
즉 현재 export가 쓰는 `variants`/`defaultVariant`는 kind를 바꿔도 그대로 유효하다.

wire 변환은 kind마다 다르다:

| kind | 요청 필드 |
|---|---|
| openai-compatible | `reasoning_effort` |
| openai | `reasoning: { effort }` |
| anthropic | `output_config: { effort }` (+ 선택 `thinking`) |

`kind:"openai"`가 보내는 `reasoning.effort`는 ocx `/v1/responses`가 네이티브로 읽는 필드다.

## 모달리티

```js
Zse=Q.enum(["text","image","video","audio","pdf"])
modalities:Q.object({input:Q.array(Zse).optional(),output:Q.array(Zse).optional()}).optional()
```

kind별 제한이 없고, `image`가 있으면 `supportsImages` 케파빌리티로 투영된다:

```js
w.supportsImages=y.modalities.input.includes("image")
```

## options / apiKeyRequired

`options`는 `Q.record(Q.string(),Q.unknown())` 자유형이고, `apiKeyRequired:false`면 크리덴셜 요구를
건너뛴다:

```js
function yA(e){if(e.apiKeyRequired===!1)return!0;...}s(yA,"hasRuntimeCredential")
```

## anthropic kind의 추가 요구사항 — 없음

```js
function rje(e){return e.kind?e.kind:...}s(rje,"resolveOpenCodeProviderDefaultKind")
```

명시된 `kind`가 최우선이고 `defaultKind`/`apiFormat`/`providerMappings`는 전부 optional 폴백이다.
세 kind 어느 쪽으로 내보내도 추가 필드는 필요 없다.

