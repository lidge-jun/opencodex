# 030 Phase 3 — src/codex/auth-api.ts 갓파일 분해 (Codex 인증·quota·관리 라우트)

이 단위는 facade 보존 순수 이동으로 `src/codex/auth-api.ts`(3,134줄, 실측 HEAD `ce0ac617da`)를 `src/codex/auth-api/` 아래 10개 리프 모듈로 나누고, 원래 경로는 전량 re-export facade로 남겨 소비자 import를 바꾸지 않는다. 최대 함수 `handleCodexAuthAPI`(2217-3134, 918줄)는 22개 경로 가드로 23개 (method, path) 관리 라우트를 디스패치하며(`/api/codex-auth/pool-strategy` 가드 하나가 PUT과 PATCH 두 쌍을 등록한다), 분해 후 이 함수는 서비스 모듈 호출로만 구성된다. 이 문서의 계약은 보안 경계다. accessToken/refreshToken은 main-probe·pool-probe·reset-credit·login-flow 네 리프 안에만 존재하고 라우트 모듈과 facade를 통과하지 않으며, Pool/Direct/API-key 조기 반환 술어 두 곳(1699-1702, 1834-1839)은 한 모듈에 함께 둔다. 9개 PR 중 6개는 AGENTS.md 심사 경계(인증·credential·OAuth 표면)에 따라 보안 검토가 필요하고 나머지 3개는 순수 이동임을 각 PR 표기로 명시한다.

> 전달 형태 정정: 이 문서가 적은 브랜치 이름과 PR 개수는 실행되지 않았다. 다섯 파일이 한 워킹트리에서 동시에 작업돼 두 개의 PR로 수렴했다. 이동 계약과 함정 항목은 그대로 실행됐다. 실제 전달은 [090_outcome.md](./090_outcome.md) 를 보라.


로프 위치: 레인·브랜치 배치는 `000_plan.md`가 소유하며 이 문서는 파일 분해 계약만 고정한다. 모든 원본 행 번호는 브랜치 `codex/m3-l1-roadmap` HEAD `ce0ac617da`(origin/dev와 동일) 실측값이다. 로컬 install/build/typecheck/suite는 NOT RUN이고 검증은 hosted CI(레인 tip exact-head)다. 새 테스트 파일을 만들지 않으므로 `scripts/test-layout/layout.json:427`의 기존 `codex-auth-api.test.ts` 항목과 `tests/fixtures/test-layout-expected.json` 등록은 변경하지 않는다.

## 범위와 비범위

범위는 3,134줄 본문을 `src/codex/auth-api/*.ts`로 옮기고 `src/codex/auth-api.ts`를 전량 re-export facade(잔여 ~180줄)로 만드는 일이다. 기능 정책, 동의 경계, 재시도·백오프 숫자, 응답 셰이프, 마스킹 정책은 바꾸지 않는다.

비범위: `src/codex/main-device-reauth-api.ts`(`/api/codex-auth/main/reauth-device` 3개 라우트는 `src/server/management-api.ts:410-412`에서 별도 디스패치되며 이 파일과 무관), `src/codex/account-store.ts` 자격증명 저장소 본체, `src/oauth/` 로그인 플로우 엔진, `src/codex/routing/`·`src/providers/quota/`(선행 라운드 산출물), 관리 라우트 파일들의 import 경로 변경, 인자로 상태를 넘기는 리팩터.

디렉터리 충돌: 새 모듈은 반드시 `src/codex/auth-api/*.ts`다. macOS에서 `auth-api.ts` 파일과 `auth-api/` 디렉터리는 확장자가 달라 공존하며(`src/adapters/kiro.ts`+`src/adapters/kiro/`, `src/codex/routing.ts`+`src/codex/routing/` 선례), 기존 `src/auth/` 계열 디렉터리에 넣지 않는다.

## 보안 경계 실측 — (a) 자격증명 흐름

현재 토큰은 아래 4개 흐름으로만 이동하며, 전부 이 파일 안에서 read→dispatch→폐기된다. DTO와 응답은 토큰을 직렬화하지 않는다(`structure/gui-and-management-api.md:140` "tokens are never serialized" 불변식).

| 흐름 | 실측 행 | 토큰 경로 |
|---|---|---|
| main probe | 917 `readCodexTokensResult()` → 944 `observeMainQuotaCredential(tokens.access_token, …)` → 954 WHAM `Bearer` 발송 | `~/.codex/auth.json` 물리 토큰이 quota publication 증거(`MainQuotaWriter`)와 함께 소비됨. DTO에는 email/plan/quota만 남음 |
| pool probe | 1450 `getValidToken(accountId)` → 1451 `capturePoolQuotaWriter` → 1456 WHAM `Bearer`; 401이면 1473 `rejectedAccessToken` → 1322 `forceRefreshCodexPoolToken` → 1344 replay `Bearer`; 1580 deferred-validation warmup `accessToken` | 저장소 credential이 generation과 함께 소비됨. `PoolQuotaResult`는 토큰 없이 증거(dispatchSequence/credentialGeneration)만 운반 |
| reset-credit 게이트 | 401 `ResetCreditAuth.accessToken` 필드 → 436(main, `readCodexTokens`) 또는 465(pool, `getValidCodexToken`)에서 주입 → 소비자: 512·524(`createResetCreditWhamClient`), 2577(GET 라우트), 2685(consume 라우트), 1623(`manualResetAuthStillLive` 재검증), 1663(`resetToken` 재사용) | `withResetCreditAuth`(409-469)가 유일한 주입점. 라우트 본문 클로저가 `auth.accessToken`을 직접 헤더에 쓰는 것이 오늘의 유일한 토큰→라우트 누설 지점 |
| login flow | 2839-2841 OAuth credential로 WHAM probe `Bearer` → 2907 warmup에 `cred.access` 전달 → 2939-2943 `credential` 객체(`accessToken` 2940, `refreshToken` 2941) 구성 → 2947(재인증)·704(신규, `persistNewCodexAccount` 내부) `saveCodexAccountCredential` | OAuth 토큰이 저장소로 들어간 뒤 흐름 상태에는 email(마스킹 대상)만 남음 |

분할 후 라우트 모듈 비통과 설계:

1. 토큰 보유 리프는 `main-account-probe.ts`, `pool-quota-probe.ts`, `reset-credit-service.ts`, `login-flow.ts` 네 곳으로 한정한다.
2. PR 7에서 GET/POST reset-credit 라우트 본문(2562-2749)의 클로저를 `reset-credit-service.ts`의 `inspectResetCredits(config, accountId, signal)`·`consumeResetCredits(...)` 서비스 함수로 통째로 흡수하고 라우트 가드는 `return inspectResetCredits(...)` 한 줄로 남긴다. `ResetCreditAuth`와 `auth.accessToken` 식별자는 라우트 모듈에 등장하지 않는다.
3. PR 8에서 login 4개 라우트(2750-3134)의 오케스트레이션을 `login-flow.ts` 함수로 옮긴다. OAuth 토큰 read→검증→저장이 한 모듈 안에서 닫히고 라우트는 flowId/상태 투영 응답만 받는다.
4. 라우트 모듈과 facade가 받는 것은 `Response`·DTO(`CodexAuthAccountDto`)뿐이다. DTO 계층(`account-list.ts`)은 `projectEmail`(377, 2033)로 이메일만 투영하고 토큰 필드가 없다.
5. 완료 조건(각 보안 PR마다): `rg -n "ResetCreditAuth|accessToken|access_token" src/codex/auth-api/routes.ts src/codex/auth-api.ts`가 0 hits. PR 9 이후에는 `src/codex/auth-api/routes.ts`만 검사하면 된다.

## 보안 경계 실측 — (b) Pool/Direct/API-key 조기 반환 술어

`structure/providers/openai-tiers.md`가 명시한 경계: `:15-16` provider 표(`openai`는 `codexAccountMode`가 `"pool"`/`"direct"`, `openai-apikey`는 Codex 계정 조회 없음), `:18-20` "Direct short-circuits that engine before pool state is read or mutated", `:421-431` pool 저장소 계약. 이 경계의 코드 구현이 이 파일의 조기 반환 술어 두 곳이다.

| 진입점 | 실측 행 | 술어 |
|---|---|---|
| `runCodexCooldownRecoveryProbes` | 1698(OpenAI provider read) + 1699-1702 | `!openai || openai.disabled === true || !isCanonicalOpenAiForwardProvider(openai) || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool"`이면 return |
| `primeCodexPoolQuotas` | 1822(OpenAI provider read) + 1834-1839 | 동일 4항 논리(`isCanonicalOpenAiForwardProvider` 1836, `providerCodexAccountMode … !== "pool"` 1837) |

두 술어를 한 모듈(`pool-mode-gate.ts`)에 함께 두는 이유: 두 진입점은 같은 4항 논리를 공유하는 별개 배경 작업이고, 술어가 두 파일로 갈라지면 한쪽만 술어를 잃어도 Direct/API-key 모드에서 WHAM 발송과 native-main claim 획득이 시작된다. 이는 openai-tiers.md:20이 금지한 "pool state가 읽히거나 쓰이기 전에 Direct가 단락한다"를 정확히 위반하는 반면, 오늘 기준 두 진입점은 같은 커밋에서 같이 고쳐진 이력이 있다(`tests/codex-integration/codex-quota-prime.test.ts:354`가 direct·API-only·disabled 3구성을 한 테스트에서 함께 단언한다). 술어 논리를 추출한 헬퍼 함수로 합치는 것도 금지한다 — 함수는 공유하되 호출 지점 두 곳(1699, 1834)과 술어 본문은 같은 파일에 있어야 리뷰가 두 경로를 한 diff에서 본다.

INV 승계(선행 라운드에서 INV-OPENAI-01로 지칭한 Pool/Direct 경계): 승계 테스트 모듈은 `tests/codex-integration/codex-quota-prime.test.ts:354`("direct, API-only, and disabled OpenAI configurations never prime the Codex pool")와 `tests/codex-integration/codex-cooldown-recovery.test.ts:522`(`codexAccountMode = "direct"` 하위 케이스)다. 구조 게이트 승계는 `tests/ci-workflows/structure-ssot.test.ts`.

## 보안 경계 실측 — (c) 소스 오라클 (본문을 텍스트로 읽는 테스트)

`tests/codex-integration/codex-auth-api.test.ts`가 이 파일 본문을 텍스트로 읽는 지점은 정확히 6곳이고, 읽기 경로가 두 종류이다. 매칭이 원문 텍스트 기준이므로 이동 시 표현식을 한 글자도 바꾸지 않고 옮겨야 한다.

| 테스트(행) | 읽기 경로(현재) | 매칭 대상 | 이동 후 읽기 경로 |
|---|---|---|---|
| 4622-4632 device poll budget | `:4625` `Bun.file(new URL("../../src/codex/auth-api.ts", import.meta.url)).text()` | `:4626` 정규식 `const pollAttempts = useDeviceFlow \? (\d+) : (\d+);` | `../../src/codex/auth-api/login-flow.ts` |
| 5869-5872 collision self-exclusion | `:5870` `Bun.file("src/codex/auth-api.ts").text()` | `:5871` `checkAccountIdCollision(oauthAccountId, email, plan, reauth ? accountId : undefined)` | `src/codex/auth-api/login-flow.ts` |
| 5874-5882 reauth 신원 결합 | `:5875` 동일 | `:5876-5881` `expectedChatgptId`·`expectedEmail`·"Signed-in ChatGPT account does not match this pool account"·"Cannot verify account identity for reauth. Remove this account and add it again." | 동일 |
| 5883-5888 flow 대기/타임아웃 | `:5883` 동일 | `:5884-5888` `st.done && st.loggedIn`·"Login timed out before OAuth completed." | 동일 |
| 5889-5893 log-label 생성 지점 | `:5889` 동일 | `:5891` `withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts)` | 동일 |
| 5894-5901 login-status 이메일 마스킹(#3859) | `:5894` 동일 | `:5897-5900` `const maskFlowEmails = emailMaskingEnabled(config);`, 두 `projectEmail(st.email, maskFlowEmails)` 경계, `:5900` `.not.toMatch(/\{ \.\.\.st, email: st\.email/)` | 동일 |

여섯 전부 PR 8(login-flow 이동)과 같은 커밋에서 읽기 경로를 위 표의 새 경로로 고친다. 이 밖에 `tests/ci-workflows/ci-workflows.test.ts:1897·1934`는 `src/codex/auth-api.ts` 문자열을 합성 patch fixture 파일명으로 쓰는 것일 뿐 실제 파일을 읽지 않으므로 수정 대상이 아니다.

## 보안 경계 실측 — (d) config 저장 경계 오라클

`tests/config/config-save-boundary.test.ts`의 `GUARDED_FILES`(`:16-26`)에 `"codex/auth-api.ts"`(`:24`)가 있다. 이 파일에서 `saveConfigPreservingClaudeCode` 호출 지점은 `:641`(`saveRuntimeConfig` 640-648 내부) 단 한 곳이고, `:675` `withConfigMutationLockSync`와 `:1199-1201` `mutatePersistedConfig`는 가드 코디네이터라 어디에 둬도 허용된다. `saveRuntimeConfig`가 `src/codex/auth-api/runtime-config.ts`로 가는 PR 2에서 **같은 커밋에** `GUARDED_FILES`에 `"codex/auth-api/runtime-config.ts"`를 추가한다. facade 항목 `"codex/auth-api.ts"`는 남긴다(차후 writer가 facade에 다시 생기는 것을 막는 래칫 역할). 추가하지 않으면 오라클이 새 파일을 읽지 않아 bare `saveConfig(`가 통과한다.

## 보안 경계 실측 — (e) 관리 라우트 레지스트리

`src/server/management/route-registry.ts:88-116`가 `module: "codex/auth-api"`로 23개 (method, path) 쌍을 선언한다(DELETE/GET/POST accounts 3, GET active·login-status·quota·quota/history·reset-credits 5, PATCH pool-strategy, POST accounts·clear-cooldown·accounts/refresh·login·login/cancel·login/code·reset-credits/consume 6, PUT alias·pause·pause-exhausted·priority·active·auto-switch·failover·pool-strategy 8, 합계 23; pool-strategy PUT은 `:116` compatibility-alias exempt). `:101-104`의 main-device 3개 라우트는 별개 모듈이다.

`tests/server/management-route-registry.test.ts`는 3방향 검증이다. 검증 1(`:60-71`)은 `routeCarryingFiles()`(`:44-52`, `:45`에 `"src/codex/auth-api.ts"`)을 스캔해 선언 대비 초과를 잡고, 검증 2(`:73-90`)는 `src/${route.module}.ts` 파일을 읽어 경로 리터럴 존재를 요구하며, 검증 3(`:92-116`)은 모듈별 선언 수와 스캔 쌍 수를 대조한다. 따라서 라우트 가드가 `src/codex/auth-api/routes.ts`로 가는 PR 9에서 **같은 커밋에** (1) 레지스트리 23개 항목의 `module`을 `"codex/auth-api/routes"`로 바꾸고, (2) `routeCarryingFiles()`의 `"src/codex/auth-api.ts"` 항목을 `"src/codex/auth-api/routes.ts"`로 교체해야 한다. 셋 중 하나라도 빠지면 검증 2(경로 리터럴 소실) 또는 검증 1·3(스캔 누락)이 적색이 된다. 관리 라우트 파일 7곳과 `src/server/management-api.ts:34·414`, `src/server/index.ts:44-48·3371`은 facade만 import하므로 어느 PR에서도 손대지 않는다.

## 상태 소유권

모듈 수준 싱글턴은 아래 소유 파일로만 이동한다. 인자로 Map/Set/카운터 홀더를 넘기지 않고, 공유 `let`은 소유 모듈이 닫힌 접근자로만 노출한다.

| 상태 | 현재 행 | 소유 모듈 | 비고 |
|---|---|---|---|
| `codexAuthLoginState` | 209 | `login-state.ts` | `Map<string, CodexLoginStateRow>`. row에는 email 원문이 있으므로 투영은 `projectEmail` 경계에서만 |
| `MAX_CODEX_LOGIN_STATE_ROWS`·`CODEX_LOGIN_TERMINAL_TTL_MS` | 195·196 | `login-state.ts` | Map과 함께 증감·TTL |
| `mainResetCreditsProvenance` | 290 | `account-list.ts` | identity 태그 메모리 캐시(`rememberMainResetCredits` 292, `mainResetCreditsForCurrentIdentity` 298) |
| `quotaDispatchSequence` | 1086 | `pool-quota-probe.ts` | 프로세스 로컬 전역 순서. `nextQuotaDispatchSequence()`·`isQuotaDispatchCurrent(seq)`·`publishQuotaDispatch(seq)` 접근자만 export(패키지 내부) |
| `mainQuotaPublishedSequence` | 1089 | `pool-quota-probe.ts` | 동일 접근자로만 읽고씀. main-probe가 소비자 |
| `poolQuotaRefreshInFlight` | 1121 | `pool-quota-probe.ts` | flight coalescing Map(`MAX_POOL_QUOTA_FLIGHTS` 1122) |
| `MAIN_TERMINAL_AUTH_CODES` | 762-776 | `pool-quota-probe.ts` | main·pool 양쪽이 쓰는 단말 코드 화이트리스트. main→pool 단방향 엣지로 공유 |
| `EMPTY_MAIN_ACCOUNT_INFO` | 853 | `main-account-probe.ts` | |
| `MAIN_CACHE_TTL` | 624 | `main-account-probe.ts` | |
| `POOL_CACHE_TTL`·`POOL_QUOTA_REFRESH_CONCURRENCY` | 625·626 | `pool-quota-probe.ts` | |
| `primeInFlight` | 1684 | `pool-mode-gate.ts` | |
| `poolQuotaPrimeAttemptedAt` | 1694 | `pool-mode-gate.ts` | 실패 백오프, generation 키 |
| `cooldownRecoveryInFlight` | 1695 | `pool-mode-gate.ts` | |
| `mainHardLockRecoveryInFlight` | 1731 | `pool-mode-gate.ts` | |
| `getValidPoolTokenForPrime` | 1785 | `pool-mode-gate.ts` | 테스트 리졸버(`setCodexPoolQuotaTokenResolverForTests` 1788)와 한 파일 |

## 함정 (금지 분할 — 선행 라운드에서 CI가 실제로 잡은 5류 포함)

1. **(선행 CI 결함 a) 리프가 심볼을 정의하고 export하지 않음.** 각 PR의 "남이 import하는 이름" 목록을 export 의무로 취급한다. 특히 `pool-quota-probe.ts`의 카운터 접근자 3개와 `MAIN_TERMINAL_AUTH_CODES`, `login-state.ts`의 `seedLoginRowsForTests`, `main-account-probe.ts`의 `readMainAuthErrorCode`는 형제 모듈이 import하므로 누락 즉시 적색이다. PR별 완료 조건에 typecheck(hosted CI) 포함.
2. **(선행 CI 결함 b) facade가 re-export만 하고 로컬 import 누락.** `export { x } from "./auth-api/y"`는 로컬 바인딩을 만들지 않는다. facade 잔여 코드(`handleCodexAuthAPI` 위임, `seedCodexAuthAdmissionForTests`, `effectiveCodexAuthAccountId`, `CodexAuthCatalogConvergence`)가 쓰는 심볼은 별도 `import` 문이 필요하다.
3. **(선행 CI 결함 c) 타입을 잘못된 모듈에서 import.** `PoolQuotaResult`(1065-1084)는 `pool-quota-probe.ts`가 유일한 정의점이고 `account-list.ts`는 type-only import로 쓴다. `CodexAuthAccountDto`(1155-1184)·`CodexAccountReauthReason`(346-352)은 `account-list.ts`, `MainResetQuotaProof`(808-812)는 `main-account-probe.ts`, `ResetCreditAuth`(399-407)는 `reset-credit-service.ts` 내부 비export. 재정의·복제 금지.
4. **(선행 CI 결함 d) 정의가 통째로 사라지고 호출부만 남음.** 라우트 본문만 옮기고 그 본문이 부르는 헬퍼(`setCodexLoginState`, `pruneCodexLoginState`, `convergeAccountNamespaceCatalog`, `jsonResponse`, `expireCodexAuthFlow` 등)의 정의를 남기지 않는 실수. 각 PR의 원본 행 범위에 호출 대상 정의가 포함됐는지 심볼 목록과 대조한다.
5. **(선행 CI 결함 e) 한 단계 깊어진 디렉터리에서 `../x` 오해석.** `src/codex/auth-api/*.ts`에서 `src/codex/*`는 `../x`, `src/` 직하위(`lib`, `config.ts`, `types`, `oauth`, `providers`, `server`, `usage`)는 `../../x`다. facade의 `await import("../oauth")`(2790, 3083, 3095)는 `login-flow.ts`에서 `../../oauth`가 되고, `../lib/privacy`는 `../../lib/privacy`가 된다. 반대로 `./account-store`는 `../account-store`.
6. **토큰 경계 누설.** PR 7·8에서 라우트에 클로저를 부분만 남기면 `auth.accessToken`이 라우트 파일에 잔류한다. (a)항의 rg 완료 조건으로 각 PR을 검증한다.
7. **마스킹 오라클은 원문 매칭이다.** `maskFlowEmails` 바인딩, 두 `projectEmail` 경계, `.not.toMatch` 부정 조건을 표현식 그대로 유지한다. 변수명만 바꿔도 5894-5901이 적색이 된다.
8. **`pollAttempts` 정규식 형태 유지.** 폴 루프를 리팩터해 `const pollAttempts = useDeviceFlow ? N : M;` 단일 문 형태가 깨지면 4625-4631 오라클이 적색이다(동작 테스트는 5분 예산 회귀를 못 잡는 것이 이 오라클의 존재 이유다).
9. **동의 게이트를 서비스로 누설 금지.** POST `/api/codex-auth/accounts/refresh`의 `validatePending: principal === "gui-session"`(2232-2235)는 AGENTS_INSTALL 동의 경계의 코드 구현이다. routes.ts에 남기고, 서비스 시그니처에 principal을 넘기는 확장을 하지 않는다.
10. **순환 import 금지와 엣지 방향.** 허용 방향은 routes→(전부), facade→(전부), login-flow→{login-state, runtime-config, http}, pool-mode-gate→{pool-quota-probe, main-account-probe, runtime-config}, main-account-probe→{pool-quota-probe, runtime-config}, account-list→{양 probe, runtime-config}, reset-credit-service→{양 probe, runtime-config, http}다. `pool-quota-probe`가 `main-account-probe`를 import하면 카운터·단말 코드 공유가 순환한다. `login-flow`→`reset-credit-service` 엣지도 만들지 않는다.
11. **레지스트리 3방향 동반 수정.** (e)항의 두 편집과 23개 module 필드는 PR 9 한 커밋에 있어야 한다. 분산하면 중간 커밋이 적색이다.
12. **`seedCodexAuthAdmissionForTests`(1138-1154)는 두 맵을 모두 건드린다.** `pool-quota-probe.ts`로 옮기되 login-state 쪽 행 삽입은 `login-state.ts`의 패키지 내부 `seedLoginRowsForTests(n)`를 import해 구성한다. 한쪽 맵만 시딩하면 admission 테스트가 조용히 약해진다.

## auth-api.ts 현재 지도 (3,134줄)

원본 행은 HEAD `ce0ac617da` 기준 실측이다.

| 구간 | 행 | 줄 수 | 목적지 |
|---|---|---|---|
| import | 1-167 | 167 | 각 리프가 필요한 것만 재구성. facade는 자식 re-export만 |
| 응답 헬퍼 | 169-191 | 23 | http.ts |
| persistence 상수 | 192-193 | 2 | login-flow.ts |
| login-state | 195-230 | 36 | login-state.ts |
| pool/충돌 술어 | 231-254 | 24 | configuredPoolAccount→runtime-config.ts, codexAccountPersistenceConflict→login-flow.ts |
| plan/quota DTO 기반 | 255-345 | 91 | account-list.ts (`mainResetCreditsProvenance` 290 포함) |
| 재인증 사유 + pool DTO | 346-398 | 53 | account-list.ts |
| reset-credit 게이트 | 399-469 | 71 | reset-credit-service.ts |
| reset-credit DTO/파서 | 471-573 | 103 | reset-credit-service.ts |
| 수동 import 거부 응답 | 574-580 | 7 | http.ts |
| warmup 검증 | 581-606 | 26 | login-flow.ts |
| flow 만료 | 607-623 | 17 | login-state.ts |
| 캐시 TTL·config 래퍼 | 624-648 | 25 | 624→main-probe, 625-626→pool-probe, 628-648→runtime-config |
| 신규 계정 persistence | 649-718 | 70 | login-flow.ts |
| 카탈로그 수렴 + 동시성 | 719-761 | 43 | convergeAccountNamespaceCatalog→login-flow.ts, mapWithConcurrency→runtime-config.ts |
| 단말 인증 증거 | 762-807 | 46 | pool-quota-probe.ts (main이 import) |
| main probe | 808-1064 | 257 | main-account-probe.ts |
| pool probe 결과/비행 | 1065-1137 | 73 | pool-quota-probe.ts (`PoolQuotaProbeBusyError` 1124 포함) |
| admission 시딩 | 1138-1154 | 17 | pool-quota-probe.ts (`seedLoginRowsForTests` import) |
| DTO·플랜 재조정 | 1155-1258 | 104 | account-list.ts |
| pool 401 회복·커밋·fetch | 1259-1613 | 355 | pool-quota-probe.ts |
| 수동 리셋 후 재검증 | 1614-1683 | 70 | reset-credit-service.ts |
| 프라임/회복 워커 | 1684-1936 | 253 | pool-mode-gate.ts (술어 1699-1702·1834-1839) |
| 계정 목록/활성화/pause | 1937-2216 | 280 | 1937-1940 effectiveCodexAuthAccountId→facade 잔여, 나머지→account-list.ts |
| 관리 라우트 디스패처 | 2217-3134 | 918 | routes.ts(순수 config 2225-2561) + reset-credit-service(2562-2749) + login-flow(2750-3134) |

정리: 22개 경로 가드 시작 행 — 2225, 2230, 2238, 2242, 2262, 2280, 2312, 2355, 2390, 2399, 2434, 2452, 2465(PUT||PATCH), 2504, 2516, 2556, 2562, 2613, 2750, 3076, 3094, 3102.

## PR 1 — http + login-state 【순수 이동】

목적: 상태 없는 응답 셰이퍼와 로그인 흐름 상태 맵을 먼저 독립시켜 이후 PR의 의존 기반을 만든다.

Write set:

- NEW `src/codex/auth-api/http.ts` 예상 35줄 — 원본 행 169-191, 574-580. 심볼: `jsonResponse`, `nativeMainProfileBusyResponse`, `manualImportDisabledResponse`.
- NEW `src/codex/auth-api/login-state.ts` 예상 85줄 — 원본 행 192-193은 제외(→login-flow), 195-230, 607-623. 심볼: `CodexLoginStateRow`, `codexAuthLoginState`, `MAX_CODEX_LOGIN_STATE_ROWS`, `CODEX_LOGIN_TERMINAL_TTL_MS`, `CodexLoginStateBusyError`, `setCodexLoginState`, `pruneCodexLoginState`, `expireCodexAuthFlow`, 패키지 내부 `seedLoginRowsForTests`(함정 12).
- MODIFY `src/codex/auth-api.ts` — 이동 본문 삭제, 위 심볼 import, 기존 public re-export 유지.

토큰 없음. 회귀: `tests/codex-integration/codex-auth-api.test.ts`, `tests/server/management-route-registry.test.ts`(스캔 대상 facade에 경로 리터럴 유지). 완료 조건: facade에 Map 바인딩이 없고, `CodexLoginStateBusyError`가 facade에서 계속 보인다.

## PR 2 — runtime-config 【순수 이동, config 오라클 동반】

목적: live-config 판별·저장 래퍼와 전역 공용 술어를 한곳에 둔다.

Write set:

- NEW `src/codex/auth-api/runtime-config.ts` 예상 105줄 — 원본 행 231-236, 628-648, 745-761. 심볼: `configuredPoolAccount`, `nonEmptyPlan`, `isRuntimeConfig`, `getRuntimeConfig`, `saveRuntimeConfig`, `mapWithConcurrency`.
- MODIFY `src/codex/auth-api.ts`
- MODIFY `tests/config/config-save-boundary.test.ts` — `GUARDED_FILES`에 `"codex/auth-api/runtime-config.ts"` 추가(기존 `"codex/auth-api.ts"` 유지). (d)항 계약.

회귀: `tests/config/config-save-boundary.test.ts`, `tests/codex-integration/codex-auth-api.test.ts`. 완료 조건: `saveConfigPreservingClaudeCode` 호출 지점이 저장소 전체에서 `runtime-config.ts` 한 곳(`rg -n "saveConfigPreservingClaudeCode" src/codex/`).

## PR 3 — pool-quota-probe 【보안 검토 필요】

목적: pool WHAM 프로브·401 회복·비행 coalescing과 전역 디스패치 카운터의 소유를 확정한다. 이후 main-probe가 이 파일의 접근자를 소비한다(엣지 방향 고정).

Write set:

- NEW `src/codex/auth-api/pool-quota-probe.ts` 예상 570줄 — 원본 행 625-626, 762-807, 1065-1137, 1259-1613. 심볼: `MAIN_TERMINAL_AUTH_CODES`, `readMainAuthErrorCode`, `PoolQuotaResult`, `quotaDispatchSequence`·`mainQuotaPublishedSequence`(접근자 `nextQuotaDispatchSequence`/`isQuotaDispatchCurrent`/`publishQuotaDispatch`만 export), `PoolQuotaProbeEvidence`, `markQuotaProbeAttempted`, `withQuotaProbeEvidence`, `PoolQuotaRefreshFlight`, `poolQuotaRefreshInFlight`, `MAX_POOL_QUOTA_FLIGHTS`, `PoolQuotaProbeBusyError`, `poolQuotaFlightCount`, `seedCodexAuthAdmissionForTests`(함정 12), `recoverPoolQuotaFrom401`, `QUOTA_RECOVERY_BACKOFF_MS`, `isTerminalPoolAuthResponse`, `isTerminalRefreshError`, `commitPoolQuotaResponse`, `fetchFreshPoolAccountQuota`, `fetchPoolAccountQuota`, `POOL_CACHE_TTL`, `POOL_QUOTA_REFRESH_CONCURRENCY`.
- MODIFY `src/codex/auth-api.ts` — 본문 삭제, 접근자·타입 import, re-export 유지.

보안 사유: 저장소 credential read(`getValidCodexToken` 1450)와 WHAM `Bearer` 발송(1456·1344), 토큰 회전 후 replay(1322-1360)가 이동한다. 로직 무변경이지만 AGENTS.md credential 표면이므로 보안 검토 대상으로 명시한다.

회귀: `tests/codex-integration/codex-auth-api.test.ts`, `tests/codex-integration/reserve-quota-scope.test.ts`, `tests/codex-integration/codex-cooldown-recovery.test.ts`, `tests/codex-integration/codex-quota-prime.test.ts`, `tests/responses/responses-pool-401-refresh.test.ts`. 완료 조건: facade에 `poolQuotaRefreshInFlight` 바인딩이 없고, 401 회복 예산(credential lineage당 1회)이 그대로다.

## PR 4 — main-account-probe 【보안 검토 필요】

목적: native-main 자격증명 read→WHAM→quota publication 체인을 독립시킨다.

Write set:

- NEW `src/codex/auth-api/main-account-probe.ts` 예상 340줄 — 원본 행 624, 808-1064. 심볼: `MAIN_CACHE_TTL`, `MainResetQuotaProof`, `MainAccountInfoFetchResult`, `MainAccountInfoSnapshot`, `fetchMainAccountInfoSnapshot`, `fetchMainAccountInfo`, `EMPTY_MAIN_ACCOUNT_INFO`, `retryMainAccountInfoIfIdentityChanged`, `fetchMainAccountInfoAttempt`, `fetchMainAccountInfoWhileOwned`, `isTerminalMainAuthResponse`(pool-quota-probe의 `MAIN_TERMINAL_AUTH_CODES`·`readMainAuthErrorCode` import).
- MODIFY `src/codex/auth-api.ts`

보안 사유: `readCodexTokensResult`(917), `observeMainQuotaCredential`(944), WHAM `Bearer`(954), `markAccountNeedsReauth` 게시가 이동한다. native-main shared claim(`withNativeMainCredentialClaim`) 소비 지점이므로 claim 획득/해제 순서(`finally` release)를 그대로 유지해야 한다.

회귀: `tests/codex-integration/main-quota-window-observation.test.ts`, `tests/codex-integration/main-account-hard-lock-recovery.test.ts`, `tests/codex-integration/codex-auth-api.test.ts`. 완료 조건: bare 401 무시 정책(`isTerminalMainAuthResponse`, #1932)과 배경 폴링이 재인증 격리를 해제하지 않는 정책(#327)의 주석과 분기가 원문 보존.

## PR 5 — pool-mode-gate 【보안 검토 필요】

목적: Pool/Direct/API-key 조기 반환 술어와 프라임·회복 워커를 한 모듈에 둔다. (b)항의 핵심 PR.

Write set:

- NEW `src/codex/auth-api/pool-mode-gate.ts` 예상 275줄 — 원본 행 1684-1695, 1697-1936. 심볼: `primeInFlight`, `poolQuotaPrimeAttemptedAt`, `cooldownRecoveryInFlight`, `runCodexCooldownRecoveryProbes`, `mainHardLockRecoveryInFlight`, `runMainAccountHardLockRecovery`, `registerCodexCooldownRecoveryProbeWorker`, `PrimeCodexPoolQuotasOptions`, `getValidPoolTokenForPrime`, `setCodexPoolQuotaTokenResolverForTests`, `tryAcquireNativeMainPrimeLease`, `primeCodexPoolQuotas`, `clearCodexQuotaPrimeState`, `clearCodexQuotaPrimeSingleFlightForTests`, `clearCodexCooldownRecoveryProbeState`.
- MODIFY `src/codex/auth-api.ts`
- structure 수정 없음 — `structure/providers/openai-tiers.md`는 이 파일을 백틱 참조하지 않고(:473은 DTO 투영), 경계 서술(:15-20, :421-431)은 구현 파일명과 무관하게 유지된다. 대신 승계 테스트 모듈은 이 문서 (b)항에 기록됐다.

보안 사유: 술어 1699-1702·1834-1839가 같은 파일에 착지하는지가 리뷰 포인트다. 술어를 헬퍼로 추출하더라도 두 호출 지점과 본문이 이 파일을 벗어나면 안 된다.

회귀: `tests/codex-integration/codex-quota-prime.test.ts`(`:354` direct·API-only·disabled 게이트), `tests/codex-integration/codex-cooldown-recovery.test.ts`(`:522` direct), `tests/codex-integration/codex-auth-api.test.ts`. 완료 조건: 두 진입점의 술어가 동일 논리임이 한 diff에서 보인다. `src/server/management-api.ts:34`와 관리 라우트 7곳의 `primeCodexPoolQuotas` import는 facade 경로 그대로다.

## PR 6 — account-list 【보안 검토 필요】

목적: 계정 DTO·마스킹 투영·플랜 재조정·일괄 pause를 한 모듈에 둔다.

Write set:

- NEW `src/codex/auth-api/account-list.ts` 예상 580줄 — 원본 행 255-398, 1155-1258, 1941-2216. 심볼: `quotaForPlan`, `mainResetCreditsProvenance`, `rememberMainResetCredits`, `mainResetCreditsForCurrentIdentity`, `mainQuotaWithCarriedResetCredits`, `CodexAccountReauthReason`, `poolAccountDto`, `CodexAuthAccountDto`, `FreshPoolPlanUpdate`, `reconcileFreshPoolAccountPlans`, `CodexAuthAccountsSnapshot`, `listCodexAuthAccountsSnapshot`, `refreshCodexQuotaForActivation`, `listCodexAuthAccounts`, `PauseExhaustedResult`, `selectFallbackAfterPause`, `pauseExhaustedCodexAccounts`.
- MODIFY `src/codex/auth-api.ts`
- MODIFY `structure/providers/openai-tiers.md:473` — `` `src/codex/auth-api.ts` projects `selectionExcludedReason` `` → `` `src/codex/auth-api/account-list.ts` ``. 백틱 파일 경로 동반 수정 의무.

보안 사유: 이메일 마스킹 경계(`projectEmail` 377·2033, #3859 정책 read `emailMaskingEnabled` 1952), reauth 사유 귀속(`reauthReason`), DTO가 토큰을 직렬화하지 않는 불변식의 구현체가 이동한다.

회귀: `tests/codex-integration/codex-auth-api.test.ts`, `tests/codex-integration/main-quota-window-observation.test.ts`. 완료 조건: `src/providers/quota.ts:2`, `src/providers/quota/report-cache.ts:2`, `src/providers/quota/vendor-probes-oauth.ts:1`의 import가 무변경이고 DTO 필드 집합이 동일하다.

## PR 7 — reset-credit-service 【보안 검토 필요 — 토큰 게이트】

목적: (a)항 설계의 핵심. 자격증명 주입점과 소비 클로저를 한 파일로 모아 라우트에서 토큰 식별자를 없앤다.

Write set:

- NEW `src/codex/auth-api/reset-credit-service.ts` 예상 560줄 — 원본 행 399-469, 471-573, 1614-1683, 그리고 라우트 본문 2562-2749를 `inspectResetCredits(config, accountId, signal)`·`consumeResetCredits(config, accountId, operationId, signal)`로 통째 흡수(응답 셰이프 불변).
- MODIFY `src/codex/auth-api.ts` — GET/POST reset-credit 가드가 서비스 호출 한 줄이 되고 가드 안에 accountId 존재 검사(400)와 `PoolQuotaProbeBusyError`→503 매핑(`Retry-After` 1)을 유지한다.

보안 사유: `withResetCreditAuth`(409-469)의 main/pool 분기, native-main lease 획득·해제, ledger(`openManualResetCreditOperation` 등) 저널링, `Authorization: Bearer` 4곳(512·524·2577·2685), spend 확정/모호 처리(`settleManualResetCreditOperation`/`markManualResetCreditOperationAmbiguous`)가 모두 이동한다. 이중 지출 방지 논리는 한 글자도 다시 쓰지 않는 이동이다. 배경 소비자 `createResetCreditWhamClient`(`src/server/index.ts:44-48`)는 facade re-export로 무변경.

회귀: `tests/codex-integration/codex-auth-api.test.ts`(reset-credit 스위트), `tests/codex-integration/codex-auth-context.test.ts`. 완료 조건: (a)항 rg 검증 통과 — `routes` 후보 파일과 facade에 `ResetCreditAuth`·`accessToken`·`access_token` 0 hits.

## PR 8 — login-flow 【보안 검토 필요 — OAuth·자격증명·마스킹】

목적: OAuth 로그인/재인증/수동 코드/취소/상태 4개 라우트의 오케스트레이션과 신규 계정 persistence를 한 모듈로 모으고, 6개 소스 오라클의 읽기 경로를 같은 커밋에서 갱신한다.

Write set:

- NEW `src/codex/auth-api/login-flow.ts` 예상 650줄 — 원본 행 237-254, 581-606, 649-744, 2750-3134. 심볼: `CODEX_CREDENTIAL_PERSISTENCE_ERROR`·`CODEX_CREDENTIAL_PERSISTENCE_CODE`(192-193), `codexAccountPersistenceConflict`, `verifyCodexAccountWarmup`, `StagedNewCodexAccountState`, `PersistNewCodexAccountOutcome`, `codexCredentialPersistenceFailure`, `persistNewCodexAccount`, `AccountNamespaceCatalogRefresh`, `convergeAccountNamespaceCatalog`, 라우트 함수 4개(start/submit/cancel/status 투영).
- MODIFY `src/codex/auth-api.ts` — login 4개 가드가 서비스 호출이 되고 DELETE accounts 가드(`convergeAccountNamespaceCatalog` 소비)는 login-flow import로 유지된다.
- MODIFY `tests/codex-integration/codex-auth-api.test.ts` — (c)항 표대로 6개 오라클 읽기 경로를 `src/codex/auth-api/login-flow.ts`로 교체(`:4625`는 `new URL("../../src/codex/auth-api/login-flow.ts", import.meta.url)`, `:5870·5875·5883·5889·5894`는 `Bun.file("src/codex/auth-api/login-flow.ts")`). 매칭 문자열은 무변경.

보안 사유: OAuth 토큰 흐름(2839-2947), 재인증 신원 결합 거부(2876-2902), warmup 게이트(2907), credential 저장(2947·704), 이메일 마스킹 투영(3102-3133)이 이동한다. `withCodexAccountLogLabel` 생성 지점 오라클이 묶여 있어 계정 생성 호출부와 라벨 정책이 한 PR에서 같이 검증된다.

회귀: `tests/codex-integration/codex-auth-api.test.ts`(login 전 스위트 + 오라클 6건), `tests/codex-integration/codex-auth-collision.test.ts`(facade re-export 무변경 확인). 완료 조건: 오라클 6건이 전부 새 경로를 읽고 녹색이며, `await import("../oauth")`가 `../../oauth`로 고쳐져 있다(함정 5).

## PR 9 — routes + facade 확정 【순수 이동, 레지스트리·structure·래칫 동반】

목적: 남은 순수 config 라우트 본문을 디스패처 모듈로 모으고 facade를 확정한다.

Write set:

- NEW `src/codex/auth-api/routes.ts` 예상 500줄 — 원본 행 2217-2224(디스패처 프레임), 2225-2561(순수 config 가드 전부: GET accounts·POST accounts/refresh·POST accounts·DELETE accounts·PUT alias·PUT pause·PUT priority·PUT pause-exhausted·POST clear-cooldown·PUT active·GET active·PUT auto-switch·PUT||PATCH pool-strategy·PUT failover·GET quota/history·GET quota), PR 7·8에서 얇아진 6개 자격증명 가드(2562·2613·2750·3076·3094·3102)의 호출 한 줄, `handleCodexAuthAPI` 프레임. `principal === "gui-session"` 동의 게이트(2232-2235)는 이 파일에 남는다(함정 9).
- MODIFY `src/codex/auth-api.ts` — 예상 ~180줄: import, 전량 re-export, `CodexAuthCatalogConvergence`(719-720), `effectiveCodexAuthAccountId`(1937-1940), `handleCodexAuthAPI` 위임(`export { handleCodexAuthAPI } from "./auth-api/routes"`).
- MODIFY `src/server/management/route-registry.ts:89-99·105-116` — 23개 항목 `module: "codex/auth-api"` → `"codex/auth-api/routes"`. (e)항 계약.
- MODIFY `tests/server/management-route-registry.test.ts:45` — `"src/codex/auth-api.ts"` → `"src/codex/auth-api/routes.ts"`.
- MODIFY `structure/gui-and-management-api.md:108`(`src/codex/auth-api.ts` → `src/codex/auth-api/routes.ts`, credential 소유 문장은 4개 리프 병기)와 `:140`(경로 표 갱신).
- RUN `bun run ratchet:update`(`package.json:56`, `scripts/file-size-ratchet.ts --update`) — `tests/fixtures/file-size-baseline.json:23`의 `"src/codex/auth-api.ts": 3134` 항목을 회수한다. 새 모듈은 전부 1,999줄 이하라 신규 베이스라인 항목이 없다.

토큰 없음(이동되는 본문은 config 변경·쿨다운 해제·조회뿐). 회귀: `tests/server/management-route-registry.test.ts`(3방향 전부), `tests/server/account-pool-management-api.test.ts`(pool-strategy 골든), `tests/codex-integration/codex-auth-api.test.ts`, `tests/ci-workflows/file-size-ratchet.test.ts`. 완료 조건: `wc -l src/codex/auth-api.ts src/codex/auth-api/*.ts` 전부 ≤ 1,999.

## facade re-export 계약

facade는 분해 전 public 이름을 빠짐없이 다시 보낸다. 철자가 바뀌면 아래 소비자가 전부 적색이 된다.

- 타입/클래스: `CodexAccountReauthReason`, `CodexAuthCatalogConvergence`, `MainAccountInfoSnapshot`, `CodexAuthAccountDto`, `CodexAuthAccountsSnapshot`, `PrimeCodexPoolQuotasOptions`, `CodexLoginStateBusyError`, `PoolQuotaProbeBusyError`
- 기존 전방 re-export 유지(`:77-130`): `checkAccountIdCollision`, `getMainChatgptAccountId`, `clearAccountNeedsReauth`, `isAccountNeedsReauth`, `markAccountNeedsReauth`, `applyAccountQuotaFromUpstreamHeaders`, `clearAccountQuota`, `getAccountQuota`, `parseUsageQuota`, `setAccountQuotaFromParsed`, `updateAccountQuota`, `clearMainAccountInfoCache`, `maskEmail`
- 함수: `createResetCreditWhamClient`, `fetchMainAccountInfoSnapshot`, `fetchMainAccountInfo`, `fetchPoolAccountQuota`, `seedCodexAuthAdmissionForTests`, `listCodexAuthAccountsSnapshot`, `refreshCodexQuotaForActivation`, `listCodexAuthAccounts`, `runCodexCooldownRecoveryProbes`, `runMainAccountHardLockRecovery`, `registerCodexCooldownRecoveryProbeWorker`, `setCodexPoolQuotaTokenResolverForTests`, `primeCodexPoolQuotas`, `clearCodexQuotaPrimeState`, `clearCodexQuotaPrimeSingleFlightForTests`, `clearCodexCooldownRecoveryProbeState`, `effectiveCodexAuthAccountId`, `handleCodexAuthAPI`

검증된 소비자(전부 무변경이어야 함): `src/server/management-api.ts:34·414`, `src/server/index.ts:44-48·3371`, `src/codex/quota-auto-refresh.ts:152`, `src/providers/quota.ts:2`, `src/providers/quota/report-cache.ts:2`, `src/providers/quota/vendor-probes-oauth.ts:1`, `src/server/management/{combo,model,agent-settings,config,provider}-routes.ts`·`shared.ts`·`oauth-account-routes.ts`(`primeCodexPoolQuotas`), 테스트 16파일(`tests/responses/*` 3, `tests/codex-integration/*` 12, `tests/adapters/openai/openai-provider-option-e2e.test.ts:263`).

## PR 보안 라벨 요약

| PR | 라벨 | 근거 |
|---|---|---|
| 1 http+login-state | 순수 이동 | 토큰·자격증명 코드 없음 |
| 2 runtime-config | 순수 이동 | config 저장 래퍼 이동, GUARDED_FILES 동반 |
| 3 pool-quota-probe | 보안 검토 필요 | credential read + WHAM Bearer 발송 |
| 4 main-account-probe | 보안 검토 필요 | native-main 자격증명 read + Bearer + reauth 게시 |
| 5 pool-mode-gate | 보안 검토 필요 | Pool/Direct/API-key 단락 술어 |
| 6 account-list | 보안 검토 필요 | 이메일 마스킹·reauth 귀속 경계 |
| 7 reset-credit-service | 보안 검토 필요 | 토큰 게이트 + 이중 지출 ledger |
| 8 login-flow | 보안 검토 필요 | OAuth 플로우 + credential persistence + 마스킹 투영 |
| 9 routes+facade | 순수 이동 | 토큰 없는 config 라우트, 레지스트리·structure·래칫 동반 |

## 사이클 완료 조건

- `src/codex/auth-api.ts` ≤ 1,999(예상 ~180), 새 모듈 10개 전부 ≤ 1,999
- 토큰 식별자가 `routes.ts`와 facade에 0개(rg 검증), `ResetCreditAuth`는 `reset-credit-service.ts`에만 존재
- Pool/Direct 술어 두 진입점이 `pool-mode-gate.ts` 한 파일, 승계 테스트 2파일 녹색
- 소스 오라클 6건이 새 읽기 경로에서 녹색, GUARDED_FILES·레지스트리·routeCarryingFiles 동반 편집 완료
- structure 백틱 3곳(openai-tiers:473, gui-and-management:108·140)이 구현 파일과 모순 없음, `bun run structure:check` 논색(hosted CI)
- layout.json/test-layout-expected.json 변경 없음, 베이스라인 회수 완료
- 로컬 스위트 NOT RUN. 레인 tip hosted CI exact-head 녹색 후 D에서 ratchet:update 증적 기록
