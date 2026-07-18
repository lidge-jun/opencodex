# 004 — Model/provider patch index

## 빠른 분류

| 변경 종류 | 첫 소유자 | 함께 확인할 곳 |
|---|---|---|
| built-in provider 추가 | `src/providers/registry.ts` | derive, auth, router, adapter, catalog, management API, tests/docs |
| 기존 provider 모델 추가 | registry 또는 live metadata parser | adapter override, catalog tests, picker visibility |
| OAuth/login 변경 | `src/oauth/` | registry `authKind/oauthId`, store concurrency, management API |
| API-key pool/429 변경 | `src/providers/key-failover.ts` | relay retry 경계, tests, quota display |
| wire request/stream 변경 | `src/adapters/` | `src/server/adapter-resolve.ts`, bridge/parser tests |
| Codex picker metadata | `src/codex/catalog.ts` | registry hints, generated jawcode metadata, `/api/models` |
| jawcode model metadata sync | jawcode generator source | `bun run generate:jawcode-metadata`, catalog diff |
| GUI provider preset | registry → derive 경로 | management API, GUI는 파생값 소비 |

## 새 built-in provider

1. `src/providers/registry.ts`에 stable id, label, adapter, base URL, auth kind를 추가한다.
2. 기존 adapter로 충분한지 먼저 확인한다. 새 wire shape일 때만 `src/adapters/`와 `resolveAdapter()`를 확장한다.
3. key provider는 `dashboardUrl`과 `deriveKeyLoginMap()` 계약을 확인한다. OAuth면 `src/oauth/index.ts`에 login/refresh controller를 등록한다.
4. bare model prefix가 꼭 필요한 경우에만 `src/router.ts`의 prefix table을 넓힌다. 기본은 명시적 `provider/model`이다.
5. static fallback 모델, live discovery, context/modality/reasoning metadata의 소유자를 결정한다.
6. `/api/providers`, `/api/models`, selected/disabled models, Codex catalog sync를 확인한다.
7. focused provider/adapter/catalog test와 typecheck를 실행하고 사용자 docs를 갱신한다.

## 기존 provider에 모델 추가

1. upstream 모델 ID와 실제 wire protocol을 확인한다.
2. `liveModels: true`면 static allowlist를 만들지 말고 fallback/capability hint만 추가한다.
3. `modelContextWindows`, `modelInputModalities`, `modelReasoningEfforts`, parameter exclusion 목록 중 필요한 값만 해당 registry entry에 둔다.
4. 모델별 wire 차이가 있을 때만 `resolveWireProtocolOverride()`를 수정한다.
5. media-generation 모델인지 vision-input chat 모델인지 구분해 catalog filter를 확인한다.
6. jawcode metadata를 재사용해야 하면 생성 source를 고친 뒤 snapshot을 다시 만든다.

## 새 config field

새 필드가 정말 필요한 경우에만 아래 순서를 따른다.

1. `src/types.ts`의 `ProviderRegistryEntry` 또는 `OcxProviderConfig` 계약.
2. `src/config.ts`의 validation/default/migration.
3. `providerConfigSeed()`와 `enrichProviderFromRegistry()` 파생 경로.
4. router/adapter/catalog의 실제 소비자.
5. management API DTO와 GUI editor.
6. round-trip config test와 backward-compat test.

## jawcode와의 경계

| 질문 | jawcode 소유 | OpenCodex 소유 |
|---|---|---|
| JWC 자체가 provider를 호출하는가 | `packages/ai/src/providers/`, descriptor, auth storage | 해당 없음 |
| Codex 요청을 provider로 proxy하는가 | 참고 구현 | registry, router, adapters, bridge |
| JWC bundled model metadata | generator + `packages/ai/src/models.json` | generated metadata snapshot 소비 |
| Codex App picker 노출 | 해당 없음 | `src/codex/catalog.ts`와 sync/cache |
| OpenCodex OAuth 계정/키 pool | 해당 없음 | `src/oauth/`, `src/providers/api-keys.ts` |

Provider patch를 가져올 때 `JWC native`, `OCX proxy`, `both`, `docs-only` 중 하나로 먼저 분류한다. jawcode에 provider가 생겼다는 이유만으로 OCX registry를 자동 추가하지 않고, OCX가 route할 수 있다는 이유만으로 jawcode `KnownProvider`를 늘리지 않는다.

## 최소 검증 묶음

```bash
bun test --isolate tests/provider-registry-parity.test.ts tests/provider-live-models.test.ts
bun test --isolate tests/router.test.ts tests/codex-catalog.test.ts
bun run typecheck
git diff --check
```

실제 test 파일명은 변경 전 `rg --files tests | rg 'provider|router|catalog|oauth'`로 다시 확인한다.
