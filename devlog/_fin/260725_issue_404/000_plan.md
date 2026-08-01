# 260725 #404 — 혼합 게이트웨이 per-model adapter override (조사 · 근거 · 제약)

단일 work-phase 유닛. 구현 계약은 `010_model_adapters.md`.
xAI 공식 문서 근거는 `../260725_bug_sweep/001_external_evidence.md` §xAI.

## 증상

OpenAI 호환 게이트웨이 하나에 Grok과 Gemini가 함께 붙어 있을 때, Grok 4.5로 web_search를
요청하면 reasoning만 담긴 빈 응답이 온다. 프록시는 정상 `response.completed`를 만든다.
같은 게이트웨이에 직접 `/v1/responses`로 호출하면 정상 동작한다.

## 근본 원인 (코드 확인 완료)

모델을 선택한 뒤에도 provider의 단일 `adapter` 값이 모든 모델에 적용된다.
`src/router.ts:227`이 provider 객체와 native model ID를 그대로 묶어 반환한다.

현재 모델별 wire 예외는 하드코딩 하나뿐이다 (`src/server/adapter-resolve.ts:13`).

```ts
const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};
```

`localmodels/grok-4.5`는 여기 없으므로 provider 기본값 `openai-chat`이 남고,
`src/responses/parser.ts:153`이 hosted tool을 의도적으로 제거하므로 `web_search`가
`/chat/completions`에 도달하지 못한다. upstream이 `reasoning_content`만 돌려주면
`src/bridge.ts:642`가 reasoning item을 닫고 677행이 완료 이벤트를 만들어, 관찰된
"reasoning 하나, message 없음, completed"가 된다.

## 제약

### 인증 경계

`resolveAdapter()`(`adapter-resolve.ts:27`)의 switch에는 provider 전용 어댑터가 함께 있다.

```
openai-chat / openai-responses / anthropic / google / kiro / azure / azure-openai / cursor / mimo-free
```

`cursor` override는 provider key가 없을 때 caller Authorization을 토큰으로 선택해 해당
provider의 baseUrl로 전송한다. 즉 "adapter만 바꾸면 인증 경계는 그대로"라는 전제가 깨진다.
**허용 값을 `openai-chat` / `openai-responses` 두 wire로 한정한다.**

canonical/forward provider도 위험하다. forward provider에 `openai-chat` override를 넣으면
Chat adapter가 forwarded auth 대신 `provider.apiKey`만 쓰므로 인증 없는 호출이 된다.
**canonical forward provider에는 override 자체를 금지한다.**

### hard pin 우선

`ANTHROPIC_WIRE_MODELS`는 upstream이 해당 모델에 Anthropic wire만 말한다는 사실이다.
override가 이를 덮으면 알려진 비호환 조합을 "유효 설정"으로 인정하게 된다.
**hard pin이 override보다 우선하고, validator가 pinned model의 override를 거부한다.**

Grok은 pin 대상이 아니므로(확인 완료) 이 순서가 #404 해결을 막지 않는다.

### 문서화

`modelAdapters`는 새 사용자 설정 필드이므로 `AGENTS.md`의 docs-sync 정책이 적용된다.
영어/한국어 configuration reference에 반영한다.

## 확인된 코드 구조

- validator 패턴: `src/config.ts:425` `booleanRecordConfigError()`가 그대로 본이 된다
  (plain object 검사, prototype 오염 방어, nonblank key). 소비 지점은 `config.ts:525`와
  `src/server/auth-cors.ts:235`.
- inbound 사전 판단 3곳이 provider 기본 adapter를 본다.
  - `src/server/chat-completions.ts:75` — sampling/response-format 처리
  - `src/server/claude-messages.ts:572` — sampling 제거
  - `src/server/responses/compact.ts` — WP3에서 이미 capability helper로 교체됨
