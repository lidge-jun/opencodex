# 030 — wp4 / ISSUE-3: Z.AI 를 Responses 기본으로 통합하고 Chat 을 opt-in 으로

## 결함

Z.AI 는 같은 키로 세 프로토콜을 서빙한다(001 문서 인용).

    OpenAI Chat Completion   https://api.z.ai/api/coding/paas/v4
    OpenAI Response          https://api.z.ai/api/v1
    Anthropic Message        https://api.z.ai/api/anthropic

ocx 의 zai 행은 Chat 한 갈래에 고정되어 있다(adapter openai-chat). Chat 경로는 실사용에서 불안정하고,
Z.AI 자신의 devpack 안내도 Codex 계열 클라이언트에 Responses 엔드포인트를 지정한다("Codex:
https://api.z.ai/api/v1"). 국내판 Responses 행(zhipu-bigmodel-responses)만 있고 국제판이 없다.

## 라이브 확인 (2026-09-12, 사용자 키)

    GET  https://api.z.ai/api/v1/models                    -> 200 (Codex 형식, slug/input_modalities)
    POST https://api.z.ai/api/v1/responses  glm-5.3        -> 200
    POST https://api.z.ai/api/v1/responses  glm-5.3-flash  -> 200
    POST https://api.z.ai/api/v1/responses  glm-5.2        -> 200
    POST https://api.z.ai/api/v1/responses  glm-5.1        -> 200
    POST https://api.z.ai/api/v1/responses  glm-5          -> 200
    POST https://api.z.ai/api/v1/responses  glm-4.6        -> 200
    POST https://api.z.ai/api/v1/responses  glm-5-turbo    -> 200
    POST https://api.z.ai/api/v1/chat/completions glm-5.3  -> 403 model_access_denied
    POST https://api.z.ai/api/coding/paas/v4/chat/completions glm-5.3 -> 200

두 가지가 확정된다. Responses 엔드포인트가 로스터 전체를 받으므로 전환은 모델 손실이 없다.
그리고 두 와이어는 서로 다른 경로 접두를 쓰므로 한 baseUrl 로는 둘 다 맞출 수 없다.

문서의 "Coding Plan 구독 이력 키는 Chat 으로만 접근 가능"이라는 문장은 이 키에 해당하지 않는다.

## 설계

한 행으로 통합한다. Responses 가 기본이고 Chat 은 opt-in 이며, Chat 이 받지 않는 모델은
레지스트리가 Responses 로 고정한다. xAI 행과 방향이 같지는 않다 — 거기는 provider-wide Chat 에
일부 모델만 modelWireDefaults 로 Responses 를 씌운다. 여기서는 반대로 provider-wide Responses 에
Chat 을 opt-in 으로 둔다. 빌려오는 것은 modelWireDefaults 로 특정 모델의 와이어를 못박는 부분뿐이다.

막히는 지점은 하나다. resolveWireProtocolOverride 는 adapter 만 바꾸고 baseUrl 은 그대로 둔다
(src/server/adapter-resolve.ts:26-47). openai-chat 어댑터는 openaiChatCompletionsUrl(provider.baseUrl)
로 URL 을 만들고(src/adapters/openai-chat.ts:99), openai-responses 어댑터만 provider.responsesPath
라는 상대 경로 오버라이드를 갖는다(src/adapters/openai-responses.ts:2357-2362).
즉 Responses 쪽에는 이미 경로 오버라이드가 있고 Chat 쪽에만 없다.

그래서 responsesPath 의 대칭짝을 만든다.

### NEW FIELD chatCompletionsPath

MODIFY src/types/provider.ts — responsesPath 선언 바로 아래.

    /**
     * Relative send path for the openai-chat wire, mirroring responsesPath.
     * Absent keeps openaiChatCompletionsUrl(baseUrl). Needed when one upstream serves
     * Chat Completions and Responses under different path prefixes, so a per-model wire
     * override cannot reach the right endpoint by swapping the adapter alone.
     */
    chatCompletionsPath?: string;

MODIFY src/config.ts — responsesPath 검증과 같은 규칙을 재사용한다: 스킴 없는 상대 경로, "/" 로 시작,
쿼리/프래그먼트 금지. providerResponsesPathConfigError 를 경로 이름만 받는 공용 함수로 일반화하고
두 필드에 각각 적용한다.

MODIFY src/adapters/openai-chat.ts — URL 조립을 responses 쪽과 같은 모양으로 바꾼다.

    - return { url: openaiChatCompletionsUrl(provider.baseUrl), headers, hasCredential };
    + const url = provider.chatCompletionsPath === undefined
    +   ? openaiChatCompletionsUrl(provider.baseUrl)
    +   : provider.baseUrl.replace(/\/$/, "") + provider.chatCompletionsPath;
    + return { url, headers, hasCredential };

responsesPath 가 실제로 흐르는 경로 전체를 대칭으로 따라가야 한다. 감사에서 확인된 지점이다.
빠뜨리면 typecheck 가 즉시 깨지거나(auth-cors 의 satisfies Record<keyof OcxProviderConfig>)
런타임에 필드가 사라져 Chat opt-in 이 https://api.z.ai/chat/completions 로 나간다.

    src/providers/registry.ts:231    ProviderRegistryEntry 에 필드 선언
    src/providers/registry.ts:363    ProviderConfigSeed Pick 목록
    src/providers/derive.ts:18, :73  DerivedKeyLoginProvider / DerivedProviderPreset
    src/providers/derive.ts:224, :259  providerConfigSeed (복사가 두 군데다)
    src/providers/derive.ts:296      deriveKeyLoginMap
    src/providers/derive.ts:480, :523  enrichProviderFromRegistry
    src/providers/derive.ts:604      entryToPreset
    src/router.ts:377-378            fill-if-absent 시딩
    src/config.ts                    zod 스키마 + 경로 검증(responsesPath 규칙 재사용)
    src/server/auth-cors.ts:801      필드 권한 맵에 "editor"
    (대시보드 배선은 이 유닛에서 제외 — 아래 참고)
    tests/server/config.test.ts:1476  허용/거절 검증 3건의 대칭

openai-chat 쪽 URL 조립은 openAIChatTransport 한 곳(src/adapters/openai-chat.ts:99)이면 된다.
116행과 1460행은 그 함수를 탄다.

대시보드 payload/preset/모달은 이 변경에서 건드리지 않는다. router 의 fill-if-absent 가 라우팅 시점에
필드를 채우므로 대시보드로 추가한 프로바이더도 올바른 경로로 나간다. 남는 차이는 손으로 만든 커스텀
프로바이더의 디스크 설정에 필드가 남지 않는다는 것뿐이다. gui/ 아래 파일을 건드리면 PR 게이트가
UI 스크린샷을 요구하는데 이 변경에는 보여 줄 시각적 변화가 없다. 에디터에 실제 입력 컨트롤을 붙이는
후속 작업에서 스크린샷과 함께 가져간다.

### NEW modelSuffixBracketStrip 을 Responses 어댑터에도 적용

감사와 사전 조사가 일치한다. 이 플래그는 openai-chat.ts:119, :743, :1466 과 ollama-native.ts:214 에만
있고 openai-responses.ts 에는 매치가 0건이다. zai 로스터는 glm-5.3[1m] 과 glm-5.2[1m] 를 포함하고,
상류 실측에서 괄호 id 는 400 model_not_found 였다. 지금 상태로 Responses 를 기본으로 돌리면
두 별칭이 기본 경로에서 죽는다.

해결책은 둘이다. Responses buildRequest 에 스트립을 넣거나, 로스터에서 별칭을 뺀다.
후자는 zai/glm-5.3[1m] 을 고른 기존 사용자 선택을 깨고 parity 테스트가 고정한 별칭 메타데이터
(provider-registry-parity.test.ts:462, :490-504)까지 무너뜨린다. 결함 크기에 비해 파괴가 크다.
전자를 택한다.

삽입 지점은 감사가 정정했다. openai-responses 는 번역 어댑터가 없는 passthrough 라
(adapters/registry.ts:90-94) body 를 parsed.modelId 로 다시 만들지 않고 parsed._rawBody 를 흘린다
(openai-responses.ts:2373-2376). 라우터가 네이티브 id 를 _rawBody.model 에 써넣으므로
(server/responses/core.ts:2492-2497) 괄호 별칭은 그 필드에 남는다. openai-chat 처럼 wire model 만
건드리면 스트립이 조용히 무효가 된다.

따라서 createResponsesPassthroughAdapter.buildRequest 안, JSON.stringify(finalBody)(:2544) 직전에
provider.modelSuffixBracketStrip === true 이고 finalBody 가 plain object 이며 model 이 문자열일 때
stripBracketedModelSuffix 를 적용한다. 이 한 지점이 HTTP 와 WebSocket outbound 를 모두 덮는다 —
WS 는 어댑터가 URL/body 를 다시 만들지 않고 수송만 바꾼다(server/responses/fetch-helpers.ts:97-104).

테스트는 기존 openai-chat-model-suffix.test.ts 헬퍼를 그대로 쓸 수 없다. 그 헬퍼(:7-14)는 _rawBody 가
없어서 Responses 대칭 테스트에 넣으면 빈 body 가 된다. passthrough 테스트처럼 _rawBody 를 채운다.

### MODIFY zai 행

    id: "zai", label: "Z.AI — GLM Coding Plan",
    baseUrl: "https://api.z.ai",
    adapter: "openai-responses",
    responsesPath: "/api/v1/responses",
    chatCompletionsPath: "/api/coding/paas/v4/chat/completions",

models 로스터는 유지한다. modelContextWindows 의 5.3 가족은 상류 카탈로그가 말하는 1_048_576 으로
맞춘다(현재 1_000_000, 국내 Responses 행은 이미 1_048_576). modelInputModalities 는 020 에서 넣은
ZAI_GLM_5X_INPUT_MODALITIES 를 그대로 쓴다. preserveResponsesReasoningContent 를 켜고,
Chat 전용이던 preserveReasoningContentModels 는 유지한다(opt-in 한 사용자가 여전히 Chat 을 탄다).

### Chat opt-in 과 Responses 고정

opt-in 은 기존 수단을 그대로 쓴다: 사용자가 modelAdapters 에 "openai-chat" 을 적으면
resolveWireProtocolOverride 가 어댑터를 바꾸고, 새 chatCompletionsPath 가 올바른 경로로 보낸다.

Chat 이 받지 않는 모델은 레지스트리가 Responses 로 고정한다 — 다만 실측 결과 그런 모델이 없다.
2026-09-12 에 coding/paas/v4 chat 경로로 로스터 전체를 던졌더니 glm-5.3 / glm-5.3-flash / glm-5.2 /
glm-5.1 / glm-5 / glm-4.6 / glm-5-turbo 가 모두 200 이었다. 그래서 이번 변경에 modelWireDefaults 는
넣지 않는다. 나중에 어느 모델이 Chat 에서 거절되면 그때 wire "openai-responses" 와
inbound ["responses", "chat", "anthropic"] 로 선언하면 된다. grok-4.20-multi-agent 행 주석이 그 선례다.

### 감사에서 정리된 사항

- routedProviderConfig 는 매 요청 저장 설정을 레지스트리 값으로 덮는다(src/router.ts:375). 호스트가
  api.z.ai 로 같으므로 키가 다른 호스트로 가지 않는다. quota 매핑도 https://api.z.ai 와 /api/v1 을
  이미 허용한다(src/providers/quota.ts:348-356).
- liveModels 는 켜지 않는다. 상류가 Codex 형식(models[] + slug)을 돌려주는데 ocx 라이브 발견은
  OpenAI /models(data[] + id) 계약을 기대한다. 확인되지 않은 라이브 주장은 빈 피커를 만든다.
- free-directory 의 glm id 는 별개다(src/providers/free-directory.ts:112). 계속
  https://api.z.ai/api/coding/paas/v4 + openai-chat 에 남고 zai 전환을 따라가지 않는다.
- Lab behavior fingerprint: behavior.ts 에 wire 키를 넣으려면 src/lab/subject/behavior-fingerprint.ts 의
  CLOSED_KEYS(:5-6)에 같은 키를 등록해야 한다. 미분류 키는 normalizeBehaviorValues 가 런타임에 던지고
  (:60) LabBehaviorValues 가 Record<string, ...> 라 typecheck 로는 안 잡힌다. wire.chatCompletionsPath 를
  wire.responsesPath 와 나란히 등록한다.
- #1100 destination 매칭: registryEntryForProviderDestination(registry.ts:3513-3524)은 adapter 와
  정규화된 baseUrl 로 행을 찾는다. zai 를 openai-responses + https://api.z.ai 로 옮기면 구 Chat URL 을
  가리키는 커스텀 프로바이더(예: 이름 "GLM")가 zai 메타데이터를 잃는다
  (tests/codex-integration/codex-catalog.test.ts:6068-6075 가 그 계약을 고정한다).
  구 Chat 엔드포인트를 destination alias 로 남겨서 기존 동작을 보존한다.
- structure 문서 의무: 감사가 정정한 대로 structure/transports/responses.md:253 은 OpenCode Go URL 매처
  문단이라 넣을 자리가 아니다. 갱신 대상은 같은 문서의 responsesPath 일반 계약 문단,
  structure/data-planes/inbound-compat.md:8-10(현재 openaiChatCompletionsUrl 만 적혀 있다),
  structure/config.md, structure/runtime.md:143-144. docs-site 는 guides/providers.md:457 의 zai baseUrl 과
  reference/configuration/providers.md:144, reference/adapters.md:181 의 responsesPath 서술이 대상이다.
- 이 변경은 020 이 넣는 ZAI_GLM_5X_INPUT_MODALITIES 상수를 쓴다. wp3 가 dev 에 들어간 뒤 올린다.

## 테스트

갱신이 필요한 기존 고정 테스트. 두 번째 감사가 좁혀 준 목록이다 — 초안은 과했다.

    tests/providers/provider-registry-parity.test.ts:462   modelContextWindows 1_000_000 -> 1_048_576
    tests/codex-integration/codex-catalog.test.ts:6068-6075  #1100 destination 계약
    tests/server/config.test.ts:1476-1505                  responsesPath 검증의 대칭 3건 추가
    tests/adapters/openai/openai-chat-model-suffix.test.ts:116-118  routed zai 스트립을 Responses 로
    tests/gui/provider-payload.test.ts:195                 GUI 라운드트립 toEqual

건드리지 않는다: parity :281 / :313 / :527 은 구 Chat URL 을 '낡은 저장 설정' 픽스처로 쓸 뿐 adapter/baseUrl 을
단언하지 않는다. :512 는 131_072 라 무관하다. quota 테스트의 구 URL 은 매핑이 남아 있어 유효하다.
zhipu-bigmodel-provider.test.ts:86/:91 은 glm 이 coding/paas/v4 에 남는다는 단언이라 그대로 둔다.

MODIFY tests/providers/provider-registry-parity.test.ts

    test("the Z.AI row defaults to Responses and keeps Chat reachable as an opt-in", () => {
      const row = PROVIDER_REGISTRY.find(entry => entry.id === "zai");
      expect(row?.adapter).toBe("openai-responses");
      expect(row?.baseUrl).toBe("https://api.z.ai");
      expect(row?.responsesPath).toBe("/api/v1/responses");
      expect(row?.chatCompletionsPath).toBe("/api/coding/paas/v4/chat/completions");
    });

NEW tests/adapters/openai/openai-chat-path-override.test.ts — chatCompletionsPath 가 있을 때와
없을 때의 최종 URL 을 고정하고, modelAdapters 로 openai-chat 을 opt-in 한 zai 라우트가
coding/paas/v4 경로로 나가는지 end-to-end 로 확인한다.

경로가 tests/adapters 루트가 아니라 tests/adapters/openai 인 이유는 layout 규칙이다:
scripts/test-layout/layout.json 의 자식 규칙이 ^(?:openai)- 를 adapters/openai 로 보낸다.
AGENTS.md 대로 새 파일은 layout.json 의 explicit 과 tests/fixtures/test-layout-expected.json 양쪽에
"openai-chat-path-override.test.ts": "adapters/openai" 를 등록해야 한다.

## 검증

    bun test tests/providers/provider-registry-parity.test.ts tests/adapters
    bun run typecheck
    bun run test
