# 010 — `modelAdapters` 구현 계약

근거는 `000_plan.md`.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/types.ts` | MODIFY (`modelAdapters` 필드) |
| `src/config.ts` | MODIFY (validator + superRefine 연결) |
| `src/server/auth-cors.ts` | MODIFY (management validator) |
| `src/server/adapter-resolve.ts` | MODIFY (allow-list + resolver 순서) |
| `src/server/responses/core.ts` | MODIFY (override를 라우팅 직후 적용) |
| `src/server/chat-completions.ts` | MODIFY (effective adapter 기준 분기) |
| `src/server/claude-messages.ts` | MODIFY (effective adapter 기준 분기) |
| `docs-site/src/content/docs/reference/configuration.md` | MODIFY |
| `docs-site/src/content/docs/ko/reference/configuration.md` | MODIFY |
| `tests/config.test.ts` | MODIFY |
| `tests/management-provider-validation.test.ts` | MODIFY |
| `tests/chat-completions-endpoint.test.ts` | MODIFY (서버 수준 회귀 하네스) |
| `tests/adapter-resolve.test.ts` | NEW |

## 설계

```json
{
  "adapter": "openai-chat",
  "modelAdapters": { "grok-4.5": "openai-responses" }
}
```

- 키는 namespace/combo 해석이 끝난 **upstream native model ID**. combo alias는 target을
  먼저 라우팅하므로 public alias가 아니다.
- wildcard 없이 exact key.
- 필드가 없으면 현재 동작과 완전히 동일.

## 1. 허용 목록 (`adapter-resolve.ts`)

```ts
/**
 * Only OpenAI-shaped wires may be selected per model. Provider-specific adapters
 * (cursor, kiro, google, ...) carry their own credential and base-URL semantics, so
 * exposing them here would widen the auth boundary rather than pick a wire (#404).
 */
export const MODEL_ADAPTER_OVERRIDE_ALLOWED = new Set(["openai-chat", "openai-responses"]);
```

**소유 파일은 `src/types.ts`다** (P에서 확인).

`adapter-resolve.ts`는 1-8행에서 anthropic/azure/cursor/google/kiro/mimo-free/openai-chat/
openai-responses 어댑터를 전부 import한다. `config.ts`가 여기서 상수를 가져오면 설정 로딩이
어댑터 그래프 전체를 끌어오게 되고, `config.ts`는 현재 `./server/*`를 하나도 import하지
않는다(확인 완료). 그 방향을 새로 만들 이유가 없다.

`src/types.ts`는 이미 `config.ts`, `auth-cors.ts`, `adapter-resolve.ts` 셋 모두가 참조하는
공통 의존성이므로 상수를 여기 두면 세 소비자가 순환 없이 접근한다.

### hard pin 판정도 같은 곳으로 옮긴다

validator가 pinned 모델의 키를 거부하려면 pin 목록을 알아야 하는데, `ANTHROPIC_WIRE_MODELS`는
`adapter-resolve.ts:13`의 **비공개 상수**다. 이대로 두면 구현자에게 세 가지 나쁜 선택지밖에
없다: pin map을 validator 쪽에 중복 정의하거나, 금지한 import 방향을 만들거나, validator의
pin 검사를 빠뜨리거나. 중복 정의는 시간이 지나며 두 목록이 갈라진다.

따라서 **pin map과 판정 함수를 allow-list와 함께 `src/types.ts`로 옮긴다.**

```ts
/** Providers whose listed model ids must use the Anthropic wire regardless of config. */
const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};

/** True when the upstream only speaks one wire for this model, so overrides must not apply. */
export function isWirePinnedModel(providerName: string, modelId: string): boolean {
  return ANTHROPIC_WIRE_MODELS[providerName]?.has(modelId) ?? false;
}

/** The wire a pinned model must use, or undefined when it is not pinned. */
export function pinnedWireAdapter(providerName: string, modelId: string): string | undefined {
  return isWirePinnedModel(providerName, modelId) ? "anthropic" : undefined;
}
```

`adapter-resolve.ts`는 로컬 상수를 지우고 이 함수들을 쓴다. `config.ts`와 `auth-cors.ts`의
validator도 같은 `isWirePinnedModel()`을 호출하므로 resolver와 validator의 pin 인식이
구조적으로 갈라질 수 없다.

## 2. resolver 순서 (`adapter-resolve.ts:18`)

**hard pin을 먼저** 평가한다.

```ts
   const pinnedAdapter = pinnedWireAdapter(providerName, modelId);
   if (pinnedAdapter && providerConfig.adapter !== pinnedAdapter) {
     return { ...providerConfig, adapter: pinnedAdapter };
   }
+  // Configured per-model override, only for models without a hard wire pin. The
+  // allow-list is re-checked here because config may have been hand-edited past the
+  // validator or written by an older build.
+  const requested = providerConfig.modelAdapters?.[modelId];
+  if (requested
+    && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requested)
+    && requested !== providerConfig.adapter
+    && !isWirePinnedModel(providerName, modelId)
+    && !isCanonicalOpenAiForwardProvider(providerConfig)) {
+    return { ...providerConfig, adapter: requested };
+  }
   return providerConfig;
```

canonical forward 제외가 중요하다. forward provider를 Chat adapter로 바꾸면 forwarded
auth 대신 `provider.apiKey`만 쓰여 인증 없는 호출이 된다.

### `!isWirePinnedModel()` 가드가 반드시 필요한 이유

섹션 4가 라우팅 직후 적용을 추가하면 `resolveWireProtocolOverride()`가 같은 요청에서
**두 번** 평가된다(`core.ts:910`의 기존 호출이 남으므로).

pin 분기의 조건은 `providerConfig.adapter !== "anthropic"`이다. 따라서 validator를 우회한
설정(hand-edit 또는 구버전 기록 — 이 스니펫 주석이 스스로 상정한 위협 모델)에서:

1. 1차 평가: pin 분기가 `anthropic`을 반환
2. 2차 평가: 이미 `anthropic`이라 pin 분기를 건너뛰고, `requested !== adapter`가 참이므로
   **override 분기가 pin을 덮어쓴다**

결과는 `000_plan.md`가 막으려던 바로 그것 — 알려진 비호환 조합이 유효 설정이 된다.
pin 보유 모델은 현재 adapter와 무관하게 항상 제외해야 한다. `isWirePinnedModel()`이
adapter 값을 보지 않는 순수 판정이라는 점이 이 가드의 핵심이다.

## 3. validator (`config.ts`)

`booleanRecordConfigError()`(425행)를 본으로 `modelAdapterRecordConfigError()`를 추가한다.

- plain own-properties object만 허용 (prototype 오염 방어 포함)
- 키는 nonblank trimmed string
- 값은 `MODEL_ADAPTER_OVERRIDE_ALLOWED`의 원소만
- **hard pin이 걸린 모델의 키는 거부** — 조용히 무시되는 설정을 쓰게 두지 않는다
- **canonical forward provider의 `modelAdapters` 자체를 거부** — resolver가 어차피 무시하는데
  load는 통과시키면 정책이 비대칭이 된다. pinned 모델 키를 거부하는 것과 같은 논리다.
  `config.ts` → `providers/openai-tiers` import는 순환이 없다(확인 완료)

비canonical `authMode: "forward"` provider는 그대로 둔다. `openai-responses.ts:607-620`이
forward 모드에서 caller auth를 provider baseUrl로 보내므로 이론상 노출이지만, 직접 설정으로도
이미 가능한 구성이라 override가 새 리스크를 만들지 않는다. 더 조이려면 resolver 가드를
`authMode !== "forward"`로 넓히면 되지만, 그건 정상적인 forward 게이트웨이 사용까지 막는다.

`configSchema.superRefine()`에 `providers.<name>.modelAdapters` 경로로 연결한다.
`auth-cors.ts:235` 옆에서도 같은 validator를 호출해 `POST /api/providers`를 막는다.

## 4. effective adapter를 라우팅 직후 적용 (`core.ts`)

현재 override는 adapter 생성 직전에만 적용된다. native model ID 정규화 직후로 앞당겨,
로그·auth·sidecar 판단이 모두 effective adapter를 보게 한다.

```ts
route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
```

## 5. inbound 사전 분기

두 경로가 `route.provider.adapter === "openai-responses"`로 판단한다. 각 경로에서
`routeModel()` 직후 `resolveWireProtocolOverride()`를 **한 번** 적용하고, 이후 모든 분기가
effective provider를 보게 한다. 개별 조건문을 하나씩 고치는 방식은 누락이 생긴다.

- `chat-completions.ts:75` — sampling/response-format 처리. 같은 함수의 `:88`
  (`openai-chat && text !== undefined`)도 영향을 받는다. raw가 chat인데 wire가 responses면
  text format을 잘못된 쪽으로 처리한다. `:92`/`:101`은 allow-list가 OpenAI wire 두 종뿐이라
  무영향이다.
- `claude-messages.ts:572` — sampling 제거

`compact.ts`는 WP3(#422)에서 이미 capability helper로 교체됐다.

### 기존 call site는 유지한다

`core.ts:910` 외에 `:1112` / `:1580` 등 retry·refresh 경로도 `resolveWireProtocolOverride()`를
호출한다. 이들은 **다른 provider 객체**를 평가하므로 제거하면 안 된다. 위 `!isWirePinnedModel()` 가드
덕분에 이중 적용이 idempotent해진다.

## 회귀 테스트

### `tests/adapter-resolve.test.ts` (NEW)

1. `override selects the responses wire for one model` — Grok만 `openai-responses`
2. `models without an override keep the provider default` — Gemini는 `openai-chat`
3. `absent modelAdapters changes nothing`
4. `hard pin wins over a configured override` — `opencode-go/minimax-m3`에
   `"openai-chat"` override를 넣어도 `anthropic` 반환
5. `disallowed adapter values are ignored at resolve time` — `cursor`/`kiro` 값이
   저장돼 있어도 provider 기본값 유지
6. `canonical forward providers never take an override` — 인증 경계 불변
7. `the original provider object is not mutated` — `apiKey`/`authMode`/`baseUrl` 보존
7b. `a pinned model survives a second resolve pass` — **이중 적용 회귀**
   - `opencode-go/minimax-m3` + `{"minimax-m3":"openai-chat"}` override
   - `resolveWireProtocolOverride()`를 결과에 다시 적용해도 `anthropic` 유지
   - `!isWirePinnedModel()` 가드가 없으면 2차 평가에서 pin이 덮여 실패한다

### `tests/config.test.ts`

8. 유효한 `{"grok-4.5":"openai-responses"}`가 disk load 후 보존
9. `null` / array / blank key / unknown adapter / non-string value 거부
10. hard pin 모델(`opencode-go`의 `minimax-m3`) 키 거부

### `tests/management-provider-validation.test.ts`

11. `POST /api/providers`가 유효 map을 저장하고 같은 invalid matrix는 400

### 서버 수준 회귀 (증상 고정) — **blocker 대응**

테스트 1-11은 resolver 단위와 validator 수준이다. **섹션 4·5를 통째로 빠뜨려도 전부
green이고, #404의 신고 증상 자체를 증명하는 테스트가 하나도 없다.** `core.ts:910`의 기존
call site 덕분에 섹션 1-3만으로도 증상은 고쳐지므로, 단위 테스트는 "배선이 빠진 구현"과
"완전한 구현"을 구분하지 못한다.

`tests/chat-completions-endpoint.test.ts`의 mock-fetch 하네스를 재사용한다.

현재 helper(37-56행)는 `/chat/completions` 경로만 허용하고 URL을 저장하지 않으므로,
**하네스부터 확장해야 한다.**

- 요청 pathname과 파싱된 body를 함께 캡처한다 (지금은 body만).
- `/responses` 경로도 받아들이고 Responses 형식 SSE를 돌려준다.

이 확장 없이는 테스트 12가 "responses wire로 갔는지"를 관측할 수 없다.

12. `web_search survives to the responses wire` — **증상 회귀**
    - `modelAdapters` 설정 하에 `POST /v1/responses`
    - mock fetch가 받은 outbound URL이 `/responses` 경로이고 body에 `web_search`가 남아 있음
    - 이게 #404가 실제로 고쳐졌다는 유일한 직접 증거다
13. `fastMode reads the effective adapter` — 섹션 4 고정
    - override된 route + `fastMode: true` → outbound body에 `service_tier` 주입
    - `core.ts:745`가 effective adapter를 봐야만 통과한다
14. `inbound chat-completions strips sampling for an overridden model` — 섹션 5 고정
    - `/v1/chat/completions` inbound + override → outbound body에서 sampling 제거

## 검증

```bash
bun run typecheck
bun test tests/adapter-resolve.test.ts tests/config.test.ts \
         tests/management-provider-validation.test.ts \
         tests/chat-completions-endpoint.test.ts \
         tests/openai-responses-passthrough.test.ts tests/reasoning-effort.test.ts
```
