# WP5 — #404 혼합 게이트웨이 per-model adapter override

> 개정 이력: r1 초안은 A-gate에서 FAIL. blocker 6(임의 adapter 허용이 인증 경계를 확장)과
> blocker 10(inbound 분기 회귀 테스트 누락)을 r2에서 수정했다. 외부 근거는
> `001_external_evidence.md` §xAI 참조.
>
> r3: r2도 FAIL. allow-list의 소유 파일이 없었고, hard pin과의 충돌을 막지 않았으며,
> inbound 테스트 설명이 실제 코드와 반대였다(Claude 경로는 sampling 제거이고
> response-format 거부는 Chat Completions 쪽이다).
>
> **이 문서의 코드 블록은 설계 스케치다.** 정확한 diff는 이 phase의 P에서 작성한다.

## 증상

OpenAI 호환 게이트웨이 하나에 Grok과 Gemini가 함께 붙어 있을 때, Grok 4.5로 web_search를
요청하면 reasoning만 담긴 빈 응답이 온다. 프록시는 정상 `response.completed`를 만든다.
같은 게이트웨이에 직접 `/v1/responses`로 호출하면 정상 동작한다.

## 근본 원인

모델을 선택한 뒤에도 provider의 단일 `adapter` 값이 모든 모델에 적용된다.

`src/router.ts:227`이 provider 객체와 native model ID를 그대로 묶어 반환한다.

```ts
return {
  providerName,
  provider: routedProviderConfig(providerName, provider),
  modelId,
};
```

현재 모델별 wire 예외는 하드코딩 하나뿐이다. `src/server/adapter-resolve.ts:11`:

```ts
const ANTHROPIC_WIRE_MODELS = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};
```

`localmodels/grok-4.5`는 여기 없으므로 provider 기본값 `openai-chat`이 남는다.

그리고 `src/responses/parser.ts:153`이 hosted tool을 의도적으로 제거한다.

```ts
else if (typeof t.name === "string" && t.type !== "web_search" && t.type !== "image_generation") {
  pushFn(t);
}
// OpenAI-hosted server-side tools ... are intentionally dropped
```

따라서 `web_search`가 `/chat/completions`에 전혀 도달하지 못한다. upstream이
`reasoning_content + finish_reason=stop`만 보내면 `src/bridge.ts:642`가 reasoning item을
닫고 677행이 완료 이벤트를 만들어, 관찰된 "reasoning 하나, message 없음, completed"가 된다.

### 실측 대조

현재 트리에서 같은 provider를 두 adapter로 probe한 결과:

```
openai-chat      → https://gateway/v1/chat/completions   (tools 소실)
openai-responses → https://gateway/v1/responses          tools:[{"type":"web_search"}] 보존
```

## 공식 문서 근거

xAI 공식 문서상 hosted web_search는 Responses API 경로에서만 지원되며, 이 이슈의 OpenAI
호환 게이트웨이에서는 `/v1/responses`가 맞는 wire다. 출처는
`001_external_evidence.md` §xAI Responses vs Chat Completions 참조.

## 설계: `modelAdapters`

```json
{
  "adapter": "openai-chat",
  "modelAdapters": { "grok-4.5": "openai-responses" }
}
```

- 키는 namespace/combo 해석이 끝난 upstream native model ID (combo alias는 target을 먼저
  라우팅하므로 public alias가 아니다)
- wildcard 없이 exact key
- 우선순위: 설정된 override → 기존 hardcoded pin → provider 기본값
- 필드가 없으면 현재 동작과 완전히 동일
- **값은 wire-compatible 최소 집합으로 제한한다 (아래 보안 경계 참조)**

### 보안 경계: 허용 adapter를 제한한다

r1은 "`resolveAdapter()`가 지원하는 모든 ID"를 허용하려 했다. 이는 인증 경계를 넓힌다.
`src/server/adapter-resolve.ts:27`의 switch에는 provider 전용 어댑터가 함께 있다.

```
openai-chat / openai-responses / anthropic / google / kiro / azure / azure-openai / cursor / mimo-free
```

예를 들어 `cursor` override는 provider key가 없을 때 caller Authorization을 토큰으로
선택해 해당 provider의 `baseUrl`로 전송한다. 이는 "auth/baseUrl을 새로 만들지 않는다"는
전제를 깨고 크리덴셜 전달 의미를 바꾼다.

따라서 **허용 목록을 #404가 실제로 요구하는 두 wire로 한정한다.**

```ts
/**
 * Only OpenAI-shaped wires may be selected per model. Provider-specific adapters
 * (cursor, kiro, google, ...) carry their own credential and base-URL semantics,
 * so exposing them here would widen the auth boundary rather than pick a wire.
 * Extending this set requires a per-adapter credential threat model.
 */
const MODEL_ADAPTER_OVERRIDE_ALLOWED = new Set(["openai-chat", "openai-responses"]);
```

**소유 파일 (r3)**: 이 상수는 `src/config.ts`(validator), `src/server/auth-cors.ts`
(management validator), `src/server/adapter-resolve.ts`(resolver) 세 곳이 참조한다.
`adapter-resolve.ts`에 두면 config가 server 모듈을 import하게 되어 순환 위험이 있다.
P에서 실제 import 그래프를 확인해 소유 파일을 정하되, `src/types.ts` 또는
`src/providers/` 아래의 의존성 없는 모듈이 후보다.

### hard pin 충돌 (r3 추가)

`src/server/adapter-resolve.ts:13`의 `ANTHROPIC_WIRE_MODELS`는 upstream이 해당 모델에
대해 Anthropic wire만 말한다는 사실을 담은 pin이다.

```ts
const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};
```

r2 설계는 override를 pin보다 **먼저** 검사하므로, `opencode-go/minimax-m3`에
`"openai-chat"` override를 넣으면 validator가 통과시키고 resolver가 pin 이전에 반환한다.
알려진 비호환 조합이 "유효 설정"이 되어버린다.

**결정: hard pin이 override보다 우선한다.** 그리고 validator가 pinned model에 대한
`modelAdapters` 항목 자체를 거부해, 사용자가 조용히 무시되는 설정을 쓰지 않게 한다.

즉 resolver의 순서는 `hard pin → configured override → provider 기본값`이다.
r1·r2가 적은 "override → pin" 순서는 폐기한다.

`MAINTAINERS.md`의 보안 검토 대상에 해당하므로, 구현 후 다음을 명시적으로 확인한다:
override가 `apiKey`/`authMode`/`baseUrl`을 바꾸지 않고 오직 `adapter` 필드만 교체하며,
반환된 객체가 원본 provider의 얕은 복사본임을 테스트로 고정한다.

`responsesModels: string[]` 대안은 "provider 기본이 Responses인데 일부만 Chat"인 반대
구성을 표현하지 못한다. 대칭적인 map이 낫다.

기존 모델별 필드 패턴 중 검증된 map(`modelSupportsReasoningSummaries`,
`modelOpenRouterRouting`)을 따른다. wire 선택은 요청의 의미 전체를 바꾸므로 validator 없는
배열 패턴(`noVisionModels`)보다 엄격해야 한다.

## Diff-level 변경안

### `src/types.ts` (721행 부근)

```ts
 adapter: string;
+/**
+ * Exact native model-id to adapter override. Lets one mixed gateway speak
+ * different wires per model (#404). Empty/absent keeps provider-wide behavior.
+ */
+modelAdapters?: Record<string, string>;
 baseUrl: string;
```

### `src/config.ts` (403행 부근)

`modelAdapterRecordConfigError()`를 추가하고 `configSchema.superRefine()`에 연결한다.
`modelSupportsReasoningSummaries`의 기존 validator(`src/config.ts:425`)를 형태 참고로 삼는다.

- plain own-properties object만 허용 (prototype 오염 방지: `Object.getPrototypeOf(v) === Object.prototype`)
- 키는 nonblank trimmed string
- 값은 `MODEL_ADAPTER_OVERRIDE_ALLOWED`의 원소만 허용
- 잘못된 설정은 startup fallback 전에 `providers.<name>.modelAdapters` 경로를 담은
  진단으로 거부

### `src/server/auth-cors.ts` (202행 부근)

`providerManagementConfigError()`에서 같은 validator를 호출해 `POST /api/providers`도
동일하게 막는다. GUI는 범위 밖이므로 `safeConfigDTO()` 노출이나 PATCH editor 확장은 없다.

### `src/server/adapter-resolve.ts` (18행)

hard pin을 **먼저** 평가하고, 그 다음에 configured override를 본다.

```ts
   const overrideSet = ANTHROPIC_WIRE_MODELS[providerName];
   if (overrideSet?.has(modelId) && providerConfig.adapter !== "anthropic") {
     return { ...providerConfig, adapter: "anthropic" };
   }
+  // Configured per-model override, evaluated only for models without a hard pin.
+  // The allow-list is re-checked here because config may have been hand-edited
+  // past the validator or written by an older build.
+  const requested = providerConfig.modelAdapters?.[modelId];
+  if (requested
+    && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requested)
+    && requested !== providerConfig.adapter) {
+    return { ...providerConfig, adapter: requested };
+  }
   return providerConfig;
```

`Object.hasOwn` 대신 직접 인덱싱해도 되는지는 prototype 오염 방어를 validator가 이미
수행하는지에 달렸다. P에서 확정한다.

### `src/server/responses/core.ts` (698행 부근)

현재 override는 adapter 생성 직전(897행)에만 적용된다. native model ID 정규화 직후로
앞당겨, 로그·`fastMode`·auth·sidecar 판단이 모두 effective adapter를 보게 한다.

```ts
+route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
```

897행 호출은 제거하거나 idempotent safety call로 남긴다.

### 나머지 inbound 경로

`src/server/chat-completions.ts:70`, `src/server/claude-messages.ts:570`,
`src/server/responses/compact.ts:177`은 `handleResponses()` 진입 전에 provider 기본
adapter로 sampling 제거·response-format 거부·compact passthrough를 판단한다. 이들도
effective adapter로 사전 분기해야 한다.

**WP3와의 충돌 주의**: `compact.ts`와 `core.ts`는 WP3에서도 수정된다. 반드시 WP3를 먼저
닫고 그 결과 위에서 이 phase의 P를 다시 stale 체크한다. 특히 WP3가 `compact.ts:205`의
native gate를 `supportsNativeResponsesCompactEndpoint()`로 바꾸므로, 그 위에 effective
adapter 판단을 얹어야 한다.

### 변경하지 않는 파일

- `src/adapters/openai-responses.ts` — 이미 `/v1` → `/v1/responses` 정규화와 hosted tool
  보존을 구현함
- `src/adapters/openai-chat.ts` — 현재 Chat wire 동작은 정상
- `src/router.ts` — custom provider 필드를 spread 보존하므로 `modelAdapters`가 이미 route까지 도달
- `src/providers/registry.ts`, `derive.ts` — #404는 custom provider JSON이라 불필요
- GUI 전체

## 회귀 테스트

### `tests/config.test.ts`

- 유효한 `{"grok-4.5":"openai-responses"}`가 disk load 후 보존
- `null`, array, blank key, unknown adapter, non-string value 거부
- 필드 없는 기존 config가 동일하게 load

### `tests/management-provider-validation.test.ts`

- `POST /api/providers`가 유효 map 저장, 같은 invalid matrix는 400
- reserved canonical `openai` seed에는 임의 map 추가를 계속 거부

### 새 파일 `tests/adapter-resolve.test.ts`

- map hit: Grok → `openai-responses`
- miss: Gemini → provider 기본 `openai-chat`
- map 없음: 기존 동작 유지
- `opencode-go/minimax-m3` hardcoded fallback 유지
- public selector가 native `grok-4.5`로 decode된 뒤 hit
- 원본 provider 객체가 mutate되지 않음

### 새 파일 `tests/server-model-adapter-override-e2e.test.ts`

`tests/server-key-failover-e2e.test.ts:117`의 로컬 `Bun.serve()` 패턴을 재사용해 한 provider에
두 모델을 태운다.

1. Gemini 요청 → `/v1/chat/completions`
2. Grok 요청 → `/v1/responses`
3. Grok upstream body에 `{type:"web_search"}` 보존
4. mock Responses SSE의 `web_search_call` + assistant message가 proxy SSE에도 나타남
5. combo alias도 동일 target으로 라우팅
6. override 없는 config는 `/chat/completions` 유지
7. 허용 목록 밖 값(`cursor`, `kiro`)은 config 로드와 관리 API 양쪽에서 거부되고,
   그런 값이 이미 저장돼 있어도 resolver가 무시하고 provider 기본값을 쓴다
8. override 적용 결과가 원본 provider를 mutate하지 않고 `apiKey`/`authMode`/`baseUrl`이
   보존됨 — 인증 경계 불변 고정

### inbound 분기 회귀 (blocker 10)

계획이 수정하는 세 inbound 경로 각각에 override hit/miss 테스트가 필요하다. E2E가
`/responses`만 검증하면 이 wiring은 무증상으로 깨진다.

9. `chat-completions.ts` — 이 경로의 실제 사전 판단은 sampling 파라미터 처리(75행 부근)와
   response-format 거부(88행 부근)다. override로 effective adapter가 바뀐 모델에서
   두 판단이 effective adapter 기준으로 동작하는지 확인
10. `claude-messages.ts:570` — 이 경로의 실제 사전 판단은 sampling 제거다.
    r2가 "response-format 거부"라고 적은 것은 오류였다
11. `compact.ts` — WP3의 capability gate와 결합해, override된 모델의 compact 경로가
    native/synthetic 중 올바른 쪽을 고름
12. `hard pin wins over a configured override` — `opencode-go/minimax-m3`에
    `"openai-chat"` override를 넣어도 resolver가 `anthropic`을 반환하고,
    validator가 그 설정 자체를 거부

## 문서화 (r3 범위 추가)

`modelAdapters`는 새 사용자 설정 필드이므로 `AGENTS.md`의 docs-sync 정책이 적용된다.
영어/한국어 configuration reference에 필드 설명과 혼합 게이트웨이 예제를 추가한다.

- `docs-site/src/content/docs/reference/configuration.md`
- `docs-site/src/content/docs/ko/reference/configuration.md`

허용 값이 `openai-chat`/`openai-responses` 두 개뿐이라는 점과 hard pin이 우선한다는 점을
함께 적는다.

## 판정

구현 가능하며 BLOCKED가 아니다. 필요한 Responses adapter와 URL 정규화가 이미 있고, route에
native model ID가 전달되며, 모든 retry adapter 재생성 지점이 `resolveWireProtocolOverride()`를
재호출한다. auth/baseUrl을 새로 만들지 않고 request-local clone의 adapter만 바꾼다.

## 검증 명령

```bash
bun test tests/config.test.ts tests/management-provider-validation.test.ts \
         tests/adapter-resolve.test.ts tests/server-model-adapter-override-e2e.test.ts \
         tests/openai-responses-passthrough.test.ts
bun run typecheck
```
