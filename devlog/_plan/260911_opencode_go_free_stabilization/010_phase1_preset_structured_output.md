# 010 — wp2: 프리셋이 구조화 출력 옵트아웃을 표현하게 한다

## 왜

`noStructuredOutputModels`는 #1424로 들어왔지만 사용자 config / management API 전용이다. `ProviderRegistryEntry`에 필드 자체가 없어서(`src/providers/registry.ts:160-353`) 어떤 프리셋도 "이 게이트웨이의 이 모델은 `response_format`을 거절한다"를 표현할 수 없다. 그래서 Zen Go에서 DeepSeek를 쓰는 운영자는 매번 손으로 config를 고친다(#1338, #1415, 2026-09-11 커뮤니티 제보).

## 파일 변경 지도

| 파일 | 성격 | 내용 |
| --- | --- | --- |
| `src/providers/registry.ts` | MODIFY | `ProviderRegistryEntry`에 `noStructuredOutputModels?: string[]` 추가 (`noPenaltyModels` 옆, 321 부근). `ProviderConfigSeed` Pick 유니온(`355-362`)에 이름 추가 |
| `src/providers/derive.ts` | MODIFY | 로컬 엔트리 타입(`38-44`)에 필드 추가. `providerConfigSeed`(`250` 부근)와 두 번째 시드 경로(`310` 부근)에 spread 추가. `510/563` 계열 merge 함수에 `if (!prov.noStructuredOutputModels && seed.noStructuredOutputModels) ...` 추가 |
| `src/router.ts` | MODIFY | `347-353`에 `mergeStringArray(registryEntry.noStructuredOutputModels, provider.noStructuredOutputModels)`, `471-477`에 emit |
| `src/providers/registry.ts` | MODIFY | opencode-go(`1695-1791`), opencode-zen(`3016-3039`), opencode-free(`3042-3079`) 프리셋에 시드 |
| `tests/providers/provider-registry-parity.test.ts` | MODIFY | 세 프리셋의 시드 내용을 고정 |
| `tests/providers/opencode-go-deepseek.test.ts` | MODIFY | 시드가 실제 요청에서 `response_format`을 지우는지 어댑터 경유로 확인 |

## 시드 내용

```ts
// opencode-go
noStructuredOutputModels: [...DEEPSEEK_THINKING_MODELS],
// opencode-zen
noStructuredOutputModels: [...DEEPSEEK_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
// opencode-free
noStructuredOutputModels: [...OPENCODE_FREE_DEEPSEEK_MODELS],
```

free는 무키 티어라 paid id를 시드하지 않는다. 그건 wp3의 G2에서 별도 판단한다.

## 주석에 반드시 남길 사실과 트레이드오프

- 업스트림이 돌려준 문구는 `This response_format type is unavailable now`이고, 보고된 사례는 전부 `json_schema`다(#1415는 `Error from provider (Console Go)`를 그대로 인용한다).
- 이 노브의 문서화된 의미는 "`response_format` 필드를 생략한다"이므로, `json_object`를 보내던 클라이언트도 같이 영향을 받는다. Zen Go가 `json_object`를 수용하는지는 **이 유닛에서 라이브로 확인하지 못했다(unverified)**. 운영자가 이미 손으로 적용하고 있는 바로 그 완화를 기본값으로 옮기는 것이며, management API PATCH로 모델 단위 해제가 가능하다.
- 매칭은 정확 일치다(`src/adapters/openai-chat.ts:142,1580`). `deepseek-v4.1-flash` 같은 신규 id는 이 시드에 걸리지 않는다 — 의도적이다. 게이트웨이가 그 id를 서빙한다는 근거가 없다.

## 수용 기준

1. `routeModel`을 거쳐 materialize한 opencode-go 프로바이더가 `noStructuredOutputModels`에 DeepSeek 두 id를 갖는다.
2. 같은 프로바이더로 `textFormat: json_schema` 요청을 만들면 `body.response_format`이 **없다**. 활성 시나리오: `buildOpenAIChatRequest`에 `deepseek-v4-flash`와 json_schema를 넣고 직렬화 결과를 읽는다.
3. 같은 프로바이더로 `glm-5.3`(시드에 없음) + json_schema면 `response_format`이 **남는다** — 정확 일치 경계가 살아 있다는 반대 증거.
4. 사용자 config가 이 필드를 비우면(management PATCH null) 시드 값이 다시 덮어쓰지 않는다.

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-go-deepseek.test.ts
bun test tests/adapters/openai/openai-chat-hardening.test.ts
bun run typecheck
```

## 리스크

- `json_object` 동반 손실(위 트레이드오프). 완화: PATCH로 해제 가능, PR 본문에 명시.
- `ProviderConfigSeed` 유니온 확장이 다른 프리셋의 스냅샷 테스트를 건드릴 수 있다. 확인: `tests/providers/provider-config-validation.test.ts`, `tests/config/client-config-export.test.ts`.
