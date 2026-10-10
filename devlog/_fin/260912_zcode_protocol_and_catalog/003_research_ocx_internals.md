# 003 — ocx 내부 경로 (서브에이전트 3레인 조사)

## 인바운드 라우트

| 경로 | 등록 |
|---|---|
| `POST /v1/responses` | `src/server/index.ts:1994` |
| `POST /v1/messages` | `src/server/index.ts:2065` |
| `POST /v1/messages/count_tokens` | `src/server/index.ts:2047` |
| `POST /v1/chat/completions` | `src/server/index.ts:2097` |

Anthropic과 Chat 인바운드는 둘 다 본문을 Responses 형태로 번역해 내부적으로 `handleResponses`로
리플레이한다(`src/server/claude-messages.ts:2-7`, `src/server/chat-completions.ts:2-4`,
`claude-messages.ts:900`의 `new Request("http://localhost/v1/responses", ...)`).
Responses 인바운드만 번역이 0회다.

ocx 자신도 ZCode를 Responses 클라이언트로 이미 인지하고 있다:

> "Generic Responses-API clients (AI-SDK apps such as ZCode) omit `store`"
> — `tests/responses/responses-inbound-store-default.test.ts:2`

## 업스트림 와이어 결정

인바운드가 아니라 라우트된 프로바이더의 `adapter`가 결정한다
(`src/server/adapter-resolve.ts:13-15`, 하드핀 → 모델별 오버라이드 → 레지스트리 기본 → `provider.adapter`).
`zai`는 `adapter: "openai-chat"`이므로 어떤 인바운드로 들어와도 업스트림은 Chat Completions다.

## 클라이언트 export 프로토콜 지형

| 클라이언트 | 프로토콜 | baseURL 규칙 |
|---|---|---|
| zcode | `kind:"openai-compatible"` → chat | base + `/v1` |
| mcode | `api:"anthropic-messages"` | base에서 `/v1` 제거 |
| dsh | `api:"openai-responses"` | base 그대로(`/v1` 포함) |
| omp / raycast | chat completions | base 그대로 |

즉 Responses로 붙는 클라이언트(dsh)와 Anthropic으로 붙는 클라이언트(mcode) 선례가 둘 다 있다.

## ZCode 소유권 정책

`src/integrations/ownership-policy.ts:66-84`가 refreshable로 인정하는 경로는
`models.<id>.reasoning`, `models.<id>.limit.output`, (권위 컨텍스트 부재 시) `models.<id>.limit.context` 뿐이다.
`kind`는 보호 필드다:

> "Provider identity and connection fields (`name`, `kind`, `enabled`, `source`, and every `options` member), model membership, model names, modalities, and authoritative context limits remain protected. Changing any of them stays `conflict / foreign-edit`."
> — `structure/clients/integrations.md:112-114`

이건 사용자 편집에 대한 규칙이다. ocx가 생성 계약 자체를 바꾸면 desired contribution이 달라지므로
기존 기록과 대조해 refresh 경로를 타야 한다. wp2에서 마이그레이션 동작을 반드시 확인한다.

## 모달리티 전파 경로

`registry.ts` → `configuredInputModalities`(`src/codex/catalog/provider-fetch.ts:674-677`)
→ vision sidecar 보정(`provider-fetch.ts:787-798`) → 카탈로그 `input_modalities`
→ `inputModalitiesForClient`(`src/clients/config-export/model-metadata.ts:61-72`) → 각 클라이언트 export.

`zai` / `zhipu-bigmodel-coding` 행은 `modelInputModalities`를 아예 선언하지 않고
`noVisionModels`(음수 선언)만 쓴다. 그래서 `glm-5.3-flash`는 sidecar 우회는 면하지만
양수 선언이 없어 export 피커에서 `["text"]` 플로어로 떨어진다.

`zhipu-bigmodel-responses` 행은 반대로 양수 선언을 갖는다
(`modelInputModalities: { "glm-5.3": ["text"], "glm-5.3-flash": ["text", "image"], "glm-5-turbo": ["text"] }`).

## 상류 권위 카탈로그 (라이브 확인, 2026-09-12)

`GET https://api.z.ai/api/v1/models` → 200, Codex 형식 카탈로그:

```json
{"slug": "glm-5.3", "input_modalities": ["text"], "context_window": 1048576, "default_reasoning_level": "max"}
{"slug": "glm-5.3-flash", "input_modalities": ["text", "image"], "context_window": 1048576, "default_reasoning_level": "max"}
```

전체 응답은 `evidence/zai-responses-models.json`. `POST https://api.z.ai/api/v1/responses`도 200을 반환했으므로
"Coding Plan 구독 이력 키는 Chat만 가능"이라는 문서 문장은 이 키에 적용되지 않는다.

