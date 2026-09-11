# 010 — wp2: 프리셋이 구조화 출력 옵트아웃을 표현하게 한다

## 왜

`noStructuredOutputModels`는 #1424로 들어왔지만 사용자 config / management API 전용이다. `ProviderRegistryEntry`에 필드 자체가 없어서(`src/providers/registry.ts:160-353`) 어떤 프리셋도 "이 게이트웨이의 이 모델은 `response_format`을 거절한다"를 표현할 수 없다. 그래서 Zen Go에서 DeepSeek를 쓰는 운영자는 매번 손으로 config를 고친다(#1338, #1415, 2026-09-11 커뮤니티 제보).

## wp2 P 재검증 (2026-09-11, 사이클 진입 시)

문서가 지목한 편집 지점을 현재 트리에서 전부 다시 확인했다. 드리프트 없음.

| 지점 | 현재 내용 |
| --- | --- |
| `src/types/provider.ts:643` | `noStructuredOutputModels?: string[];` 선언과 계약 주석 |
| `src/providers/registry.ts:319-323` | `noVisionModels`…`noPenaltyModels` 선언 블록 |
| `src/router.ts:351` | `const noPenaltyModels = mergeStringArray(registryEntry.noPenaltyModels, provider.noPenaltyModels);` |
| `src/router.ts:475` | `...(noPenaltyModels ? { noPenaltyModels } : {}),` |
| `src/adapters/openai-chat.ts:142` | `if (provider.noStructuredOutputModels?.includes(modelId)) delete body.response_format;` |
| `src/adapters/openai-chat.ts:1580` | 번역 경로의 `if (!provider.noStructuredOutputModels?.includes(parsed.modelId)) { … }` |

추가로 발견한 선례: `registry.ts:315`의 `directReasoningEffortModels`가 `registry-only and is never persisted as user config`라고 명시한다. 즉 레지스트리 전용 필드는 이 저장소에 이미 있는 범주다. 새 필드도 같은 범주로 두되, 사용자가 config에 직접 적어도 검증을 통과하도록 zod 스키마에는 넣는다.

## 선례

`noPenaltyModels`가 같은 배선을 이미 완결해 두었다: 선언 `src/providers/registry.ts:323` → 병합 `src/router.ts:351` → emit `src/router.ts:475` → 소비 `src/adapters/openai-chat.ts:134`. 새 필드는 이 네 지점을 그대로 따른다. 아래 "배선 경로" 표가 확정 파일 지도다.

## 설계 수정 (아키텍트 반박 수용, 2026-09-11)

초안은 `noStructuredOutputModels`를 세 프리셋에 그대로 시드하려 했다. 독립 아키텍트 자문이 이를 반박했고 main이 수용한다.

반박 요지: 확인된 400은 `json_schema` **타입** 한정이다(`This response_format type is unavailable now`). 그런데 이 노브의 계약은 "`response_format` 필드를 통째로 생략"이라, 시드하면 `json_object`를 쓰던 클라이언트까지 같이 죽는다. 커뮤니티 제보는 운영자가 고른 무딘 킬스위치이지 "json_object도 거절된다"는 증거가 아니다. 그걸 기본값으로 올리면 앞으로 json_object가 실제로 거절되는지 여부를 관측할 신호까지 덮어버린다.

수정된 설계: **확인된 사실만 표현하는 좁은 필드를 새로 만든다.**

`noJsonSchemaModels` — "이 모델은 `response_format` `json_schema`를 거절한다. `json_object`에 대해서는 아무 주장도 하지 않는다."

동작:

| 요청 | 시드된 모델 | 시드되지 않은 모델 |
| --- | --- | --- |
| `json_schema` | `{"type":"json_object"}`로 낮춰 보낸다 | 그대로 `json_schema` |
| `json_object` | 그대로 | 그대로 |
| 사용자가 `noStructuredOutputModels`에 넣음 | 기존대로 필드 전체 생략(우선한다) | 동일 |

낮추기를 택한 이유: 클라이언트가 원한 건 JSON이다. 필드를 지우면 산문이 돌아오고, `json_object`로 낮추면 최소한 JSON이 온다. Zen Go가 `json_object`를 수용하는지는 **unverified**이지만, 거절한다면 400이 다시 뜨고 그건 새로운 검증된 사실이 되어 시드를 넓힐 근거가 된다. 킬스위치로 덮으면 그 신호가 사라진다.

## 시드 내용

```ts
// opencode-go
noJsonSchemaModels: [...DEEPSEEK_THINKING_MODELS],
// opencode-zen
noJsonSchemaModels: [...DEEPSEEK_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
// opencode-free
noJsonSchemaModels: [...OPENCODE_FREE_DEEPSEEK_MODELS],
```

매칭은 기존 목록과 같은 정확 일치다. `deepseek-v4.1-flash` 같은 신규 id는 걸리지 않는다 — 의도적이다. 게이트웨이가 그 id를 서빙한다는 근거가 없다.

## 배선 경로 (최소 경로를 택한다)

라우터는 레지스트리 엔트리와 사용자 config를 요청 시점에 병합한다(`src/router.ts:346-358`의 `mergeStringArray`, `471-482`의 emit). 따라서 프리셋 값은 `providerConfigSeed`로 config.json에 **영속시키지 않아도** 요청 경로에 도달한다. 새 사용자 설정 화면이나 management PATCH는 이번 범위가 아니다.

| 파일 | 성격 | 내용 |
| --- | --- | --- |
| `src/types/provider.ts` | MODIFY | `noStructuredOutputModels`(`639-643`) 바로 아래에 `noJsonSchemaModels?: string[]` + 계약 주석 |
| `src/providers/registry.ts` | MODIFY | `ProviderRegistryEntry`에 같은 필드(`321` 부근), 세 프리셋에 시드 |
| `src/router.ts` | MODIFY | `mergeStringArray` 한 줄 + emit 한 줄 |
| `src/config.ts` | MODIFY | zod 스키마에 한 줄(`622` 패턴) — 사용자가 손으로 넣어도 검증을 통과하게 |
| `src/adapters/openai-chat.ts` | MODIFY | `142`(네이티브 패스스루)와 `1580`(번역 경로) 두 지점 모두에 낮추기 분기 |
| `tests/adapters/openai/openai-chat-hardening.test.ts` | MODIFY | 낮추기 동작과 경계 |
| `tests/providers/provider-registry-parity.test.ts` | MODIFY | 세 프리셋 시드 고정 |

## 수용 기준

1. `routeModel`을 거쳐 materialize한 opencode-go 프로바이더가 `noJsonSchemaModels`에 DeepSeek 두 id를 갖는다.
2. 같은 프로바이더로 `deepseek-v4-flash` + `textFormat: json_schema` 요청을 만들면 직렬화된 `body.response_format`이 `{"type":"json_object"}`다. 활성 시나리오: 번역 경로는 `buildOpenAIChatRequest`, 네이티브 경로는 `buildOpenAIChatPassthroughRequest`에 각각 넣고 결과 본문을 읽는다.
3. 같은 프로바이더로 `glm-5.3`(시드에 없음) + json_schema면 `response_format.type`이 `json_schema`로 **남는다** — 정확 일치 경계가 살아 있다는 반대 증거.
4. 시드된 모델 + `json_object` 요청은 그대로 `json_object`다 — 낮추기가 json_object를 건드리지 않는다는 반대 증거.
5. 같은 모델이 `noStructuredOutputModels`에도 있으면 `response_format`이 아예 없다 — 킬스위치 우선순위.

### 분기 순서와 누락 지점 (wp2 감사 반영)

- 패스스루(`142`): 킬스위치가 `delete body.response_format`을 먼저 실행하므로, 그 뒤의 낮추기는 `body.response_format?.type === "json_schema"`를 조건으로 두면 자동으로 발화하지 않는다. 감사 지적대로 `else if`는 맞지만 실질적으로 무의미하므로, 조건에 타입 검사를 넣고 킬스위치 우선임을 주석으로 남긴다. `.includes` 정확 일치는 유지한다.
- 번역 경로(`1580`): 킬스위치 게이트가 json_object/json_schema 두 분기를 함께 감싸므로, 낮추기는 json_schema 분기 **안**에 둔다.
- **config 검증은 선택이 아니다**: provider 스키마는 `.passthrough()`다. zod 검증을 빼면 사용자가 배열 대신 문자열을 넣어도 통과하고, `.includes()`가 부분 일치로 오작동한다.
- **관리 API 왕복 누락**(감사가 새로 찾음): `src/server/auth-cors.ts`의 검증기(`711` 패턴)와 `PROVIDER_CONFIG_FIELD_POLICY`(`868` 부근), `src/server/management/provider-routes.ts`의 PATCH 처리(`563` 패턴)와 DTO(`732` 부근)에 필드를 넣지 않으면, 대시보드 raw 에디터 왕복에서 값이 거부되거나 사라진다. `noStructuredOutputModels`와 동일하게 네 지점을 모두 추가한다.
- **처분 보류**: 스키마 계약이 조용히 free-form JSON으로 강등되는 것을 debug 로그로 남기라는 권고는 이번 범위에서 채택하지 않는다. 요청 본문 로깅 금지 규칙과 인접해 별도 판단이 필요하고, 필드 계약 주석과 PR 본문에 명시하는 것으로 대체한다. 후속 후보로 남긴다.
- **건드리지 말 것**: parity 테스트가 opencode-go `noVisionModels`를 리터럴 배열로 고정한다. 이번 슬라이스는 그 필드를 수정하지 않는다.

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-go-deepseek.test.ts
bun test tests/adapters/openai/openai-chat-hardening.test.ts
bun run typecheck
```

## 리스크

- Zen Go가 `json_object`도 거절하면 낮추기는 400을 막지 못한다. 그건 감추지 않고 드러내는 선택이며, 그때는 검증된 사실로 `noStructuredOutputModels` 쪽으로 넓히면 된다.
- 스키마를 요구한 클라이언트가 느슨한 JSON을 받는다. 필드를 지워 산문을 받는 기존 대안보다 낫고, 두 지점 모두 테스트로 고정한다.
- 새 필드가 라우터 병합 목록에서 빠지면 프리셋 값이 요청에 도달하지 않는다. 수용 기준 1이 이걸 직접 관측한다.
