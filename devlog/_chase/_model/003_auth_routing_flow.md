# 003 — Auth and routing flow

Provider를 추가할 때 인증, 모델 선택, wire adapter를 한 덩어리로 보면 잘못된 소유자에 코드를 넣기 쉽다. OpenCodex는 세 단계를 분리한다.

## 인증 종류

`ProviderAuthKind`는 `forward | oauth | key | local` 네 가지다 (`src/providers/registry.ts:9`). 2026-07-17 registry 분포는 forward 1, OAuth 6, key 42, local 3이다.

| 종류 | 예 | 실제 경로 |
|---|---|---|
| forward | `openai` | Pool(기본)은 메인 포함 계정 풀, Direct는 caller/main 전달만 사용한다. 일반 provider API key가 아니다. |
| OAuth | `xai`, `anthropic`, `kimi`, `kiro`, `google-antigravity`, `cursor` | `src/oauth/index.ts:62`의 controller와 `src/oauth/store.ts`의 계정별 credential store를 사용한다. |
| key | `openrouter`, `zai`, `google`, `anthropic-apikey` | provider config의 key 또는 key pool을 사용한다. |
| local | `ollama`, `vllm`, `lm-studio` | private destination을 명시적으로 허용하며 보통 key가 없다. |

`OAUTH_PROVIDERS`에는 registry OAuth 6개 외에 ChatGPT auth 관리용 특수 `chatgpt` controller가 있다. registry provider 수와 OAuth controller 수를 같은 값으로 세면 안 된다.

### OpenAI 권한 경계

- bare GPT id는 `openai`이며 `codexAccountMode`가 Pool(기본) 또는 Direct를 선택한다.
- Pool은 메인+추가 계정의 affinity/quota/cooldown 라우팅을 활성화하고 Direct는 풀 상태를 건너뛴다.
- `openai-apikey/<model>`은 API key/key pool만 사용한다.
- 두 credential 경로는 서로 fallback하지 않는다. legacy provider id는 migration 입력에만 남는다.

## 모델 라우팅 우선순위

`routeModel()`의 실제 순서는 다음과 같다 (`src/router.ts:162-222`).

1. 설정된 provider와 일치하는 명시적 `<provider>/<model>`.
2. 활성 provider의 `defaultModel`과 정확히 일치.
3. 알려진 bare-model prefix: Claude, GPT/o-series, Groq 계열.
4. 활성 provider의 static/configured `models`에 포함.
5. `defaultProvider` fallback.
6. 어느 provider도 없으면 오류.

Slash가 들어간 upstream model ID는 prefix가 실제 configured provider일 때만 namespace로 분리한다. 예를 들어 `anthropic/claude-*`가 OpenRouter 모델 ID라면 `anthropic` provider가 설정되지 않은 경우 그대로 다음 단계로 내려간다.

## Config backfill

`routedProviderConfig()`는 registry와 저장 config를 합친다 (`src/router.ts:79-159`).

- adapter와 built-in base URL/auth kind는 registry 정본을 따른다.
- 사용자 model metadata override는 registry seed보다 우선한다.
- local/self-hosted처럼 override가 허용된 base URL은 비어 있거나 placeholder가 남으면 거부한다.
- private destination은 `assertProviderDestinationAllowed()` 경계를 통과해야 한다.
- OAuth provider가 `allowKeyAuthOverride`를 명시한 경우만 key billing mode를 허용한다.

## Adapter 선택

`resolveAdapter()`가 8개 adapter family를 선택한다 (`src/server/adapter-resolve.ts:27-49`). 모델 하나가 provider 기본 wire와 다를 때는 새 provider를 만들지 않고 `resolveWireProtocolOverride()`에서 좁게 바꾼다. 현재 예는 OpenCode Go의 일부 MiniMax 모델이다 (`src/server/adapter-resolve.ts:13-24`).

## 429와 credential 동작

- 일반 upstream pre-stream retry는 connection reset과 선택된 5xx만 다룬다. 429는 generic transient status가 아니다 (`src/lib/upstream-retry.ts:37-40`).
- API-key pool은 429를 받으면 실패한 key를 cooldown하고 다음 key로 회전한다 (`src/providers/key-failover.ts:1-9`, `src/providers/key-failover.ts:67`).
- OAuth account refresh는 provider/account/generation 단위로 serialize해 회전된 refresh token을 덮어쓰지 않는다 (`src/oauth/store.ts:180-185`, `src/oauth/store.ts:321-322`).
- provider별 quota 조회는 `src/providers/quota.ts`가 맡고, wire retry taxonomy와 섞지 않는다.

## 인증 변경 체크리스트

- [ ] API key, OAuth, forward, local, product token 중 하나로 먼저 분류했다.
- [ ] 기존 adapter가 이미 필요한 Authorization/header shape를 지원하는지 확인했다.
- [ ] OAuth라면 login, refresh, store, account switch, reauth 상태를 함께 확인했다.
- [ ] key pool이라면 failed-key CAS와 cooldown을 보존했다.
- [ ] 로그, chase 문서, test fixture에 raw secret을 넣지 않았다.
- [ ] private/self-hosted base URL이 destination policy를 우회하지 않는다.
