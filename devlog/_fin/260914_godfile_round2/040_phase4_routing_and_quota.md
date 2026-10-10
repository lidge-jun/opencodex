# 040 사이클 4 — routing.ts / quota.ts 갓파일 분해

사이클 4는 facade를 남긴 순수 이동으로 `src/codex/routing.ts`(3,507줄)와 `src/providers/quota.ts`(3,313줄)를 각각 1,999줄 이하로 나눈다. 소비자는 기존 경로를 그대로 import하고, 모듈 수준 싱글턴은 파일 하나에서만 살며, 재시도 예산은 `src/lib/request-execution-budget.ts`의 request 범위 밖을 만들지 않는다. 이 문서는 구현자가 행 범위를 복사해 옮길 수 있는 계약이다. 초안과 어긋난 실측은 본문에 `정정:`으로 적는다.

로프 위치: 브랜치 `codex/m2k-l5-routing-quota`, base는 L4(`codex/m2k-l4-inject-sync`). 로컬 install/build/typecheck/suite는 NOT RUN. 검증은 hosted CI(레인 tip exact-head). 새 테스트 파일을 만들지 않으므로 `scripts/test-layout/layout.json`과 `tests/fixtures/test-layout-expected.json`은 등록하지 않는다.

## 범위와 비범위

범위는 두 갓파일의 본문을 `src/codex/routing/`와 `src/providers/quota/` 아래로 옮기고, 원래 경로를 전량 re-export facade로 남기는 일이다. 기능 정책, 쿨다운 숫자, 프로브 엔드포인트, 관측 시임, 재시도 횟수는 바꾸지 않는다.

비범위: `src/server/responses/core.ts` 본체, `src/lib/request-execution-budget.ts` 정책 값, `src/quota/` reset-observer 본체, `src/routing/`(별도 패키지), `src/codex/quota.ts`, 관리 라우트의 import 경로 변경, 인자로 상태를 넘기는 리팩터.

디렉터리 충돌: 새 모듈은 반드시 `src/codex/routing/*.ts`와 `src/providers/quota/*.ts`다. 기존 `src/routing/`과 `src/quota/`(reset-observer)에 넣으면 소유권과 옵셔널 서브시스템 경계가 깨진다. `src/adapters/kiro.ts`+`src/adapters/kiro/`와 같은 facade+디렉터리 패턴을 따른다. macOS에서 `quota.ts`와 디렉터리 `quota/`는 확장자가 달라 공존한다.

## 예산 범위 불변

재시도 예산은 `src/lib/request-execution-budget.ts`의 request 범위다. 생성 지점은 `src/server/responses/core.ts:3508`(`sendBudget: options.sendBudget ?? createRequestExecutionBudget()`)과 `:5039`(`const sendBudget = options.sendBudget ?? createRequestExecutionBudget()`). account-failover 퍼밋은 `:1506`에서 `executionBudget`을 읽고 `:1511-1515`에서 `sendClass: "account-failover"`로 `reserveDispatch`한다. 정정: 초안의 ":1506 account-failover 퍼밋"은 바인딩 행이고, 실제 퍼밋 소비는 1511-1515다. gated-model 동일 계정 재시도는 `:1654` `maxRetrySends = retrySameConfirmedAccount ? 7 : 1`이며 이 숫자는 core.ts 소유다.

새 모듈 어디에도 시도 카운터, sendClass, maxRetrySends, reserveDispatch 복제를 신설하지 않는다. 링 전진은 계속 `src/codex/pool-rotation.ts`의 `pickRoundRobinAccount`가 수행한다. active 커서 승격 함수 `promoteActiveCodexAccount`는 `active-account.ts` 한 곳에만 둔다.

정정: `recordCodexUpstreamOutcome`은 `promoteActiveCodexAccount`의 단독 호출자가 아니다. 현재 호출 사이트는 `reconcileCodexActiveAfterExclusion:2239`, `applyFailureFailover:2413`, `resolveCodexAccountForThreadDetailed:2917·2967·3029`, `recordCodexUpstreamOutcome:3375·3426`이다. 단독 호출자 제약은 429 경로의 `pickAlternateCodexAccount` 재호출 금지로 좁힌다. 같은 요청이 이미 고른 대체 계정은 `meta.promoteAccountId`로 재사용하며, 그 행은 초안 3369·3420이 아니라 **3371·3422**다. 이 재사용을 빼면 round-robin 링이 한 요청에 두 칸 전진한다.

## 상태 소유권 — routing.ts

모듈 수준 싱글턴은 아래 표의 소유 파일로만 이동한다. 인자로 Map/Set을 넘기거나, 테스트 훅으로 두 번째 인스턴스를 만들지 않는다. 관리 라우트 9곳이 `clearThreadAccountMap`을 직접 import하는 것은 facade 싱글턴을 가리키게 그대로 둔다. 인자로 넘기면 호출측 기본값과 facade가 갈라져 인스턴스가 분기한다.

| 상태 | 현재 행 | 소유 모듈 | 비고 |
|---|---|---|---|
| `upstreamHealth` | 269-274 | `routing/health-store.ts` | `Map<string, CodexUpstreamHealth>` |
| `quotaScopedHealth` | 275-284 | `routing/health-store.ts` | 계정→scope→health |
| `lastReconciledGeneration` | 292 | `routing/health-store.ts` | `reconcileCodexRoutingHealth`와 `recordCodexUpstreamOutcome`이 함께 읽음. 후자는 facade에 남고 health-store getter를 쓴다 |
| `liveHealthAccountIds` | 293-294 | `routing/health-store.ts` | 동일 |
| `threadAccountMap` | 331 | `routing/thread-affinity.ts` | 금지: 순수함수+상태인자 |
| `threadAffinityEntryTotal` | 332-333 | `routing/thread-affinity.ts` | map과 같이 증감 |
| `pendingReleaseReasons` | 455-481 | `routing/thread-affinity.ts` | `MAX_PENDING_RELEASE_REASONS = 4096` |
| `manualPreference` | 2118-2155 | `routing/active-account.ts` | 연산자 one-shot |
| `runtimeActiveCodexAccountId` | 142-143 | `routing/active-account.ts` | 프로세스 로컬 커서 |

정리 진입점은 확인됨. `src/lib/state-store-registrations.ts:111` `{ name: "codex-routing-health", reconcileGeneration: reconcileCodexRoutingHealth }`. import는 같은 파일 `:15-16`에서 `../codex/routing` facade. 분해 후에도 facade에서 re-export한다. `listLiveCodexAccountIds`(`:419-427`)는 같은 파일 `:61` `buildGenerationContext`가 쓰므로 health-store가 구현을 갖고 facade가 re-export한다.

관리 라우트 9곳(직접 import, 경로 유지):

1. `src/server/management-api.ts:33`
2. `src/server/management/oauth-account-routes.ts:36`
3. `src/server/management/model-routes.ts:115`
4. `src/server/management/combo-routes.ts:37`
5. `src/server/management/agent-settings-routes.ts:40`
6. `src/server/management/config-routes.ts:44`
7. `src/server/management/provider-routes.ts:69` (`:962·1065·1340`는 기존 `deps.clearThreadAccountMap ?? clearThreadAccountMap` 테스트 시임. 새 주입을 늘리지 않는다)
8. `src/server/management/logs-usage-routes.ts:32`
9. `src/server/management/shared.ts:34`

`src/server/index.ts:93-96`도 import하지만 관리 라우트가 아니다. 이것도 facade를 유지한다.

## 상태 소유권 — quota.ts

| 상태 | 현재 행 | 소유 모듈 | 비고 |
|---|---|---|---|
| `nativeMainReportGenerations` | 110 | `quota/report-cache.ts` | WeakMap, report 객체 키 |
| `accountReportCurrent` | 111 | `quota/report-cache.ts` | 동일 |
| `routingEvidence` | 112 | `quota/report-cache.ts` | 동일. 세 WeakMap을 다른 파일로 쪼개지 않는다 |
| `cache` / `inflight` / `invalidationEpoch` | 169-174 | `quota/report-cache.ts` | 프로세스 캐시 |
| `accountQuotaCache` | 1736 | `quota/account-cache.ts` | |
| `explicitAccountEpoch` | 1737 | `quota/account-cache.ts` | |
| `diskHydrated` | 1747 | `quota/account-cache.ts` | |
| `accountQuotaInflight` | 1772 | `quota/account-cache.ts` | |
| `lastReconciledGeneration` (quota) | 1773 | `quota/account-cache.ts` | routing의 동명 상태와 별개 |
| `liveAccountQuotaKeys` / `liveProviderQuotaKeys` | 1774-1775 | `quota/account-cache.ts` | |
| `anthropicUsageInflight` | 1480 | `quota/vendor-probes-oauth.ts` | anthropic 프로브 전용 |
| `antigravityOutboundDependencies` | 2915-2919 | `quota/antigravity.ts` | 테스트 시임 |
| `pendingProviderObservation` | 3144 | **facade에 잔류** | 이동 금지 |
| `providerQuotaBeforePublishForTests` | 113-120 | `quota/report-cache.ts` | publish 직전 훅 |

`notifyProviderQuotaSnapshot`(`:3171-3201`)과 `pendingProviderObservation`은 `src/providers/quota.ts` facade에 남긴다. 동적 엣지 `import("../quota/reset-observer")`와 `import("../quota/window-mapping")`가 이 함수 안에 있다. 옮기면 `tests/usage/quota-reset-core-boundary.test.ts:37` `SEAMS`가 새 경로의 동적 엣지를 못 찾고, 또는 정적 import가 생기면 core 경로에 reset-observer가 올라간다.

## 함정 (금지 분할)

1. `recordCodexUpstreamOutcome`(3147-3497, 351줄)을 outcome class별 파일로 나누지 않는다. 계약 순서는 `dropSpentCredentialFailure`(3178) → success/caller/neutral/workspace/credential → scoped 429(reset-derived, 3324-3382) → account-wide 429(3384-3457) → transient(3459-3496)이다. 한 분기가 `preservedCooldownFields`와 lease generation을 공유하므로 분리하면 순서와 필드 보존이 깨진다.
2. affinity API를 `(map, threadId, ...)` 형태의 순수함수로 바꾸지 않는다. `threadAccountMap`과 `threadAffinityEntryTotal`은 `thread-affinity.ts`의 모듈 바인딩으로만 존재한다.
3. `notifyProviderQuotaSnapshot` / `pendingProviderObservation` 이동 금지.
4. `.json(` 오라클을 확장하지 않은 채 프로브 함수만 추출 금지. PR 5가 첫 프로브 이동이며 오라클 확장이 같은 커밋에 있어야 한다.
5. 새 시도 카운터 신설 금지 (예산 불변).
6. `promoteAccountId` 재사용 삭제 금지 (3371·3422).
7. 순환 import: `transientDetourAccount`(1760-1787)와 `isTransientOnlyAffinityBlock`(1714-1731)은 `pickAlternateCodexAccount`를 호출한다. 이를 `thread-affinity.ts`에 넣으면 selection과 순환한다. 잔여 resolve 경로에 남긴다. 정정: 초안 thread-affinity ~600은 이 블록을 포함했다. 실제 이동분은 ~480.

## 오라클과 structure 동반 수정

### 오라클 1 — `tests/config/config-save-boundary.test.ts:22`

`GUARDED_FILES`가 `"codex/routing.ts"`를 리터럴로 읽고 bare `saveConfig(`를 금지한다. 현재 writer는 bare가 아니라 `saveConfigPreservingClaudeCode`다.

- `:2196` `setActiveCodexAccount`
- `:2305` `releaseDrainedCodexAccountPin` (reauth/pause 경로)
- `:2316` `releaseDrainedCodexAccountPin` (drained 경로)

세 writer가 `active-account.ts`로 가면 **같은 PR에서** `GUARDED_FILES`에 `"codex/routing/active-account.ts"`를 추가한다. facade `codex/routing.ts` 항목은 남긴다(차후 writer가 facade에 다시 생기는 것을 막는다). 추가하지 않으면 오라클이 새 파일을 읽지 않아 bare `saveConfig(`가 통과한다.

### 오라클 2 — `tests/providers/provider-quota.test.ts:122`

`readFileSync(repoPath("src/providers/quota.ts"))` 본문에서 `/\.\s*json\s*\(/`를 금지한다. 프로브가 다른 파일로 나가면 그 파일도 같은 정규식으로 읽어야 한다. PR 5에서 배열로 확장하고, PR 6에서 oauth/antigravity 경로를 추가한다.

### 오라클 3 — `tests/usage/quota-reset-core-boundary.test.ts:37`

`SEAMS = ["src/codex/quota.ts", "src/providers/quota.ts"]`. facade에 `notifyProviderQuotaSnapshot`이 남는 한 SEAMS는 그대로다. 옮기면 SEAMS에 새 경로를 넣고 `OBSERVER_SPEC = "../quota/reset-observer"` 동적 엣지가 그 파일에서 발견돼야 한다. 이 사이클에서는 옮기지 않으므로 SEAMS 수정 없음.

### 오라클 4 — `tests/usage/quota-reset-detector.test.ts:120`

주석: `src/providers/quota.ts:279 and src/codex/quota.ts:192 disagree on whether 0 survives`. 정정: 현재 `quota.ts:279`는 `publicCapacityAggregation` 본문이며 0-survive와 무관하다. 실제 대립은 다음이다.

- `src/providers/quota.ts:1686-1687` `validReset`: `resetAt > 0` → 0 폐기
- `src/providers/quota-wire.ts:32` `epochMillis`: `value <= 0` → 0 폐기
- `src/codex/quota.ts:184` `normalizeResetAt`: `numeric < 0` → 0 생존 (`:173-184`, 주석이 가리킨 `:192`도 어긋남)

PR 7이 `normalizeAnthropicQuota`를 `account-cache.ts`로 옮기면 주석 경로를 새 파일의 `validReset` 행으로 고친다. 동작은 바꾸지 않는다.

### structure 백틱 (본문 텍스트를 읽는 소스 오라클)

| 문서 | 현재 | 이동 후 | PR |
|---|---|---|---|
| `structure/providers/openai-tiers.md:451` | `src/codex/routing.ts` applies optional `codexPool.excludedPlans` | 구현은 `src/codex/routing/selection.ts` (`isCodexAccountPlanExcluded` 1313-1325, `excludedCodexPoolPlanKeys` 1287-1312) | 4 |
| `structure/providers/openai-tiers.md:518` | `src/codex/routing.ts` supports `accountPoolStrategy: "reset-first"` | 구현은 `src/codex/routing/selection.ts` `pickResetFirstCodexAccount` 1788-1816 | 4 |
| `structure/runtime.md:342` | `src/providers/quota.ts` publishes routing evidence only when a producer explicitly supplies | WeakMap `routingEvidence` 소유가 `quota/report-cache.ts` | 8 |
| `structure/gui-and-management-api.md:502` | `src/providers/quota.ts` uses one exact normalized-base mapping for both Z.ai quota | `zaiQuotaMonitorHost` 356-373, `isCanonicalZaiBaseUrl` 374-377, `fetchZaiQuota` 881-928 → `quota/vendor-probes-key.ts` | 5 |
| `structure/transports/inventory.md:34` | 표 Discovery and quota에 `src/providers/quota.ts` | facade 유지. Spark DTO 억제는 `fetchProviderQuotaReports` 잔류 | 8에서 facade 잔류를 명시 |
| `structure/transports/inventory.md:134` | `src/providers/quota.ts` binds diagnoses to the probed credential/project | 진단 바인딩은 `fetchAccountQuota` 2170-2283(`account-cache.ts`)와 `probeAntigravityUsageQuota`(`antigravity.ts`) | 6+7 |

`structure/manifest.json`은 이미 `runtime.md`가 `src/codex/`와 `src/providers/`를 문서화하므로 새 top-level src area가 아니다. `bun run structure:index`는 백틱 문구만 고치면 필요 없고, manifest documents 배열을 건드리지 않는다. INV 승계: `INV-OPENAI-01`(Pool/Direct)은 선택 로직이 selection.ts로 옮겨도 제품 불변식은 동일하고 테스트 승계 모듈은 `tests/codex-integration/codex-routing.test.ts`와 `tests/codex-integration/codex-pool-plan-exclusion.test.ts`. `INV-TESTS-01`은 새 테스트 파일이 없으므로 유지. 구조 게이트 승계는 `tests/ci-workflows/structure-ssot.test.ts`.

## routing.ts 현재 지도 (3,507줄)

원본 행은 이 HEAD 기준이다.

| 구간 | 행 | 줄 수 | 목적지 |
|---|---|---|---|
| import | 1-39 | 39 | 각 모듈이 필요한 것만. facade는 자식 re-export만 |
| affinity 타입/헬퍼 | 41-140 | 100 | thread-affinity.ts |
| `runtimeActiveCodexAccountId` | 142-143 | 2 | active-account.ts |
| `CodexUpstreamHealth` | 144-210 | 67 | health-store.ts |
| cooldown 상수 | 211-244 | 34 | cooldown-math.ts |
| affinity 상수 | 245-267 | 23 | thread-affinity.ts |
| health 맵 + dropSpent + reconcile 커서 | 269-294 | 26 | health-store.ts |
| outcome/scope/probe 타입 | 295-326 | 32 | cooldown-math(295-304) / health-store(305-306) / probe-lease(307-326) |
| affinity 맵 | 327-336 | 10 | thread-affinity.ts |
| quota scope 매핑 | 338-355 | 18 | health-store.ts (`codexQuotaScopeForModel` export) |
| `CodexUpstreamOutcomeMeta` | 356-406 | 51 | cooldown-math.ts (순수 타입. promoteAccountId 필드 포함) |
| `hasConfiguredPoolAccount` | 407-418 | 12 | 잔여 (resolve가 사용) |
| `listLiveCodexAccountIds` | 419-427 | 9 | health-store.ts |
| `clearThreadAccountMap*` | 428-454 | 27 | thread-affinity.ts |
| pending release | 455-481 | 27 | thread-affinity.ts |
| health clear/reconcile/get/scoped mutators | 483-562 | 80 | health-store.ts |
| usage/classify/parse/computeQuotaCooldown | 563-736 | 174 | cooldown-math.ts |
| `codexQuotaAvoidUntil` / `isCodexQuotaAvoided` | 737-759 | 23 | health-store.ts (맵 읽기. 초안이 cooldown-math에 넣으면 순수 제약을 깨므로 정정) |
| `computeQuotaCooldownUntil` | 760-774 | 15 | cooldown-math.ts |
| probe-lease 전체 | 775-1094 | 320 | probe-lease.ts |
| `preservedCooldownFields` | 1095-1107 | 13 | health-store.ts (record/probe가 공유) |
| `resetCodexRoutingForManualSelection` | 1108-1151 | 44 | active-account.ts (커서+preference 쓰기, affinity/health를 호출) |
| cooldown 스냅샷/clear/soft-avoid | 1152-1286 | 135 | health-store.ts |
| plan exclusion + selectable + block reason | 1287-1366 | 80 | selection.ts |
| affinity bind/prune/handOff | 1367-1583 | 217 | thread-affinity.ts |
| eligible/headroom/cacheAffinity | 1584-1713 | 130 | selection.ts |
| transient hold/detour | 1714-1787 | 74 | **잔여** (순환 import 방지) |
| pick* / peek* / plan helpers | 1788-2117 | 330 | selection.ts |
| manualPreference + active cursor + saveConfig writers | 2118-2242, 2292-2318 | 152 | active-account.ts |
| `pickPriorityPreemption` | 2255-2291 | 37 | selection.ts |
| `applyQuotaAutoSwitch` ~ `applyFailureFailover` | 2319-2419 | 101 | selection.ts (`setActive`/`promote`를 active-account에서 import) |
| `resolveCodexAccountForThread` | 2420-2429 | 10 | 잔여 |
| refusal + preview/rebind | 2430-2777 | 348 | 잔여 |
| `resolveCodexAccountForThreadDetailed` | 2778-3146 | 369 | 잔여 |
| `recordCodexUpstreamOutcome` | 3147-3497 | 351 | 잔여 |
| `formatCodexProviderForLog` | 3498-3507 | 10 | 잔여 |

정정: 잔여 ~900은 detailed 369 + record 351만으로 채워지지 않는다. 위 잔여 합은 hasConfigured(12)+transient(74)+resolve wrapper(10)+preview/rebind(348)+detailed(369)+record(351)+format(10) = 1,174에 facade re-export ~80을 더하면 ~1,250이다. 1,999 이하이므로 허용. 초안 ~900은 preview/rebind/transient를 빠진 채 센 숫자다.

## quota.ts 현재 지도 (3,313줄)

| 구간 | 행 | 줄 수 | 목적지 |
|---|---|---|---|
| import + type re-export | 1-82 | 82 | facade 유지 + 각 모듈이 필요한 import |
| key vendor URL 상수 | 83-105 | 23 | vendor-probes-key.ts |
| XAI URL | 106-107 | 2 | vendor-probes-oauth.ts |
| WeakMap 3개 + publish 훅 + 심볼 + Report 타입 | 109-174 | 66 | report-cache.ts |
| cache clear / cacheKey / capacity 공개 | 175-313 | 139 | report-cache.ts |
| `readProviderQuotaJsonForTests` | 314-318 | 5 | report-cache.ts (오라클이 이 심볼을 quota.ts에서 import. facade re-export) |
| canonical URL + key fetchers A6api~Neuralwatt | 319-1196 | 878 | vendor-probes-key.ts |
| `report` / `keyReport` / `tagNativeMainReport` / `publishKeyReportForTests` / `isProviderQuotaReportCurrent` | 1197-1273 | 77 | report-cache.ts |
| `fetchChatGptForwardQuota` | 1274-1347 | 74 | vendor-probes-oauth.ts |
| xai/claude/anthropic/kiro/muse/passive | 1348-1671 | 324 | vendor-probes-oauth.ts |
| account-cache 타입~explicit helpers | 1672-2163 | 492 | account-cache.ts |
| `antigravityQuotaDiagnosticIdentity` | 2164-2169 | 6 | antigravity.ts |
| `fetchAccountQuota` + `fetchProviderAccountQuotas` | 2170-2311 | 142 | account-cache.ts (antigravity probe를 import) |
| kimi/command parsers+fetchers | 2312-2597 | 286 | vendor-probes-key.ts (`keyQuotaReaderForProvider`가 닫힘) |
| `fetchCursorQuota` | 2598-2757 | 160 | vendor-probes-oauth.ts |
| antigravity parse/probe/fetch/test seam | 2758-3035 | 278 | antigravity.ts |
| `KeyQuotaReader` + `keyQuotaReaderForProvider` + `providerApiKeyQuotaMode` | 3036-3076 | 41 | vendor-probes-key.ts |
| `fetchProviderApiKeyQuotas` | 3077-3087 | 11 | 잔여 (`maybeFetchProviderQuota` 호출) |
| `maybeFetchProviderQuota` | 3088-3143 | 56 | 잔여 |
| 관측 시임 + `fetchProviderQuotaReports` | 3144-3313 | 170 | 잔여 |

정정: vendor-probes-key 초안 ~900은 319-1196만 센 값(878). kimi/command(286)+selector(41)+URL 상수(23)를 같은 파일에 모아야 `keyQuotaReaderForProvider`가 컴파일되므로 예상 **~1,230**. antigravity 초안 ~230 → 실제 2758-3035(278)+identity(6) = **~284**. account-cache 초안 ~520 → 1672-2163(492)+fetchAccountQuota/fetchProviderAccountQuotas(142) = **~634**. report-cache 초안 ~230 → 109-174(66)+175-318(144)+1197-1273(77) = **~287**. 잔여 초안 ~700은 `fetchProviderQuotaReports` 3207-3313(107줄)이 아니다. 잔여 합은 fetchProviderApiKeyQuotas(11)+maybeFetch(56)+관측/reports(170)+import/re-export ~80 = **~320**. 1,999 이하.

## PR 1 — cooldown-math

목적: 상태 없는 쿨다운/사용량 산술만 분리해 이후 모듈이 숫자 규칙을 공유한다.

Write set:

- NEW `src/codex/routing/cooldown-math.ts` 예상 300줄. 정정: 초안 ~260은 `CodexUpstreamOutcomeMeta`(356-406, 51줄)를 뺀 값. Meta는 promoteAccountId를 담지만 값 객체 타입이라 여기에 둔다.
- MODIFY `src/codex/routing.ts` 해당 본문을 삭제하고 `export { ... } from "./routing/cooldown-math"`

원본 이동 행: 211-244, 295-304, 356-406, 563-736, 760-774.

내보낼 이름: `CODEX_QUOTA_PROBE_INTERVAL_MS`, `CODEX_FAILURE_WINDOW_MS`, `TERMINAL_SHORT_WINDOW_FRESHNESS_MS`, `CODEX_TRANSIENT_SOFT_AVOID_MS`, `CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS`(const, 같은 파일), `CODEX_DEFAULT_QUOTA_COOLDOWN_MS`, `CODEX_MAX_QUOTA_COOLDOWN_MS`, `CODEX_MAX_RESET_DERIVED_COOLDOWN_MS`, `CODEX_MAX_QUOTA_AVOID_MS`, `CodexUpstreamOutcome`, `CodexUpstreamOutcomeClass`, `CodexCooldownSource`, `CodexUpstreamOutcomeMeta`, `computeCodexUsageScore`, `classifyCodexUpstreamOutcome`, `parseRetryAfterMs`, `parseResetCooldownMs`, `computeQuotaCooldown`, `computeQuotaCooldownUntil`. 같은 파일이 쓰는 비export `isTerminalShortWindow`, `clampCooldownMs`, `resetTimestampMs`, `quotaAvoidUntilFor`도 이 파일에 둔다.

`quotaAvoidUntilFor`는 순수(meta+now+cooldownUntil)이므로 여기 둔다. `codexQuotaAvoidUntil`는 맵을 읽으므로 이동하지 않는다.

회귀: `tests/codex-integration/codex-routing.test.ts`, `tests/codex-integration/codex-cooldown-recovery.test.ts`, `src/combos/failover.ts:1`이 `parseResetCooldownMs`를 routing facade에서 import하므로 facade re-export가 빠지면 combos가 깨진다.

structure 수정 없음. layout 등록 없음.

완료 조건: `routing.ts`가 위 함수 본문을 갖지 않고 re-export만 한다. 새 파일에 `let`/`Map` 없음. `computeCodexUsageScore`는 `CODEX_UNKNOWN_USAGE_SCORE`/`CODEX_EXHAUSTED_USAGE_PERCENT`(`../quota`)와 `isThirtyDayOnlyCodexPlan`(`../plan`)만 쓴다.

## PR 2 — health-store + probe-lease

목적: health 맵과 그 맵을 잠그는 probe lease를 한 PR에서 옮겨 싱글턴이 한 쌍으로만 존재하게 한다. 두 파일로 나누되 lease는 health-store의 mutator를 import한다. 맵을 인자로 받지 않는다.

Write set:

- NEW `src/codex/routing/health-store.ts` 예상 420줄
- NEW `src/codex/routing/probe-lease.ts` 예상 330줄 (775-1094 = 320 + 타입 307-326 = 20 + import ≈ 350. 초안 ~330에 가깝다)
- MODIFY `src/codex/routing.ts` re-export

health-store 원본 행: 144-210, 269-294, 305-306, 338-355, 419-427, 483-562, 737-759, 1095-1107, 1152-1286.

포함 심볼: `CodexUpstreamHealth`, `CodexQuotaScope`, `dropSpentCredentialFailure`, `lastReconciledGeneration`, `liveHealthAccountIds`, `NATIVE_MODEL_QUOTA_SCOPES`, `codexQuotaScopeForModel`, `isIndependentCodexQuotaScope`, `codexPoolKeyForScope`, `listLiveCodexAccountIds`, `clearCodexUpstreamHealth`, `clearCodexUpstreamHealthForAccount`, `reconcileCodexRoutingHealth`, `getCodexUpstreamHealth`, `scopedHealthFor`, `setScopedHealth`, `deleteScopedHealth`, `codexQuotaAvoidUntil`, `isCodexQuotaAvoided`, `preservedCooldownFields`, `getCodexAccountCooldownUntil`, `getCodexAccountHealthSnapshot`, `getCodexQuotaHealthSnapshot`, `isCodexAccountInCooldown`, `clearCodexAccountCooldown`, `getCodexAccountSoftAvoidUntil`, `isCodexAccountSoftAvoided`.

probe-lease가 맵을 직접 만지지 못하게 health-store는 `getAccountHealth`/`setAccountHealth`/`deleteAccountHealth`(이름은 구현자 선택, 의미는 account-wide Map mutator)를 같은 파일에서만 닫힌 채 export한다. 다른 패키지가 Map 값을 import하지 못하게 한다. facade는 기존 public 이름만 re-export.

`recordCodexUpstreamOutcome`(잔여)는 `lastReconciledGeneration`과 `liveHealthAccountIds`를 읽는다. health-store가 `isHealthAccountAdmissible(accountId, writerGeneration)` getter를 제공하거나 두 바인딩의 읽기 함수를 export한다. 복제하지 않는다.

probe-lease 원본 행: 307-326, 775-1094.

포함 심볼: `CodexQuotaRecoveryProbeClaim`, `CodexQuotaRecoveryProbeProof`, `ManualResetCooldownClaim`, `ManualResetRefreshLineage`, `tryAcquireCodexQuotaProbeLease`, `canAcquireCodexQuotaProbeLease`, `claimDueCodexQuotaRecoveryProbes`, `claimManualResetCooldowns`, `settleManualResetCooldown`, `settleCodexQuotaRecoveryProbe`, `tryAcquireCodexQuotaScopeProbeLease`, `canAcquireCodexQuotaScopeProbeLease`, `releaseCodexQuotaProbeLease`, `releaseCodexQuotaScopeProbeLease`, `ownsProbeLease`, `probeMayClearCooldown`, `withProbeLeaseReleased`. `ownsProbeLease`는 record 경로가 쓰므로 export한다.

회귀: `tests/codex-integration/codex-cooldown-recovery.test.ts`, `tests/codex-integration/reserve-quota-scope.test.ts`, `tests/oauth/oauth-health.test.ts`, `tests/oauth/state-store-sweeper.test.ts`(codex-routing-health 등록).

완료 조건: 두 파일이 같은 프로세스에서 하나의 `upstreamHealth`를 본다. 테스트가 `clearCodexUpstreamHealth()` 후 probe lease가 빈 맵을 본다.

## PR 3 — thread-affinity

목적: 스레드 바인딩 맵과 LRU/TTL/generation hand-off를 한 모듈에 둔다.

Write set:

- NEW `src/codex/routing/thread-affinity.ts` 예상 480줄 (정정: 초안 ~600에서 transient detour 74줄을 잔여로 뺌)
- MODIFY `src/codex/routing.ts`

원본 행: 41-140, 245-267, 327-336, 428-454, 455-481, 1367-1583.

포함 심볼: affinity 타입 전부, `CODEX_THREAD_AFFINITY_*`, `CODEX_TRANSIENT_AFFINITY_HOLD_MS`, `clearThreadAccountMap`, `clearThreadAccountMapForAccount`, `debugCodexAffinityGenerations`, `handOffThreadAffinityGeneration`, 내부 `bindThreadAffinity`, `bindModelDetourAffinity`, `deleteThreadAffinitiesForAccount`, `getThreadAffinity`, `prune*`, pending reason 삼총사. 잔여 resolve/record가 bind/delete/get/pending을 쓰므로 이 내부 함수들은 `src/codex/routing/` 안에서 export한다. 외부 facade는 기존 public만.

남기지 말 것: 1714-1787.

관리 라우트 9곳의 import 경로는 그대로 `../../codex/routing` 또는 `../codex/routing`.

회귀: `tests/server/session-affinity.test.ts`, `tests/codex-integration/codex-routing.test.ts`, `tests/codex-integration/codex-pool-rotation.test.ts`.

완료 조건: `clearThreadAccountMap()`가 관리 라우트와 테스트에서 같은 맵을 비운다. 함수 시그니처에 Map 파라미터가 없다.

## PR 4 — selection + active-account

목적: 후보 선택과 active 커서/디스크 writer를 한 PR에서 옮겨, 선택이 승격 함수를 호출해도 커서가 한곳이다.

Write set:

- NEW `src/codex/routing/selection.ts` 예상 680줄 (정정: 초안 ~560)
- NEW `src/codex/routing/active-account.ts` 예상 240줄
- MODIFY `src/codex/routing.ts`
- MODIFY `tests/config/config-save-boundary.test.ts` — `GUARDED_FILES`에 `"codex/routing/active-account.ts"` 추가. 기존 `"codex/routing.ts"`는 유지
- MODIFY `structure/providers/openai-tiers.md:451`와 `:518` 백틱 구현 경로

selection 원본 행: 1287-1366, 1584-1713, 1788-2117, 2255-2291, 2319-2419.

포함 심볼: `isCodexAccountPlanExcluded`, `getPoolAccountPlan`, `pickLowestUsageCodexAccount`, `pickAlternateCodexAccount`, 내부 pick/peek/eligible/headroom/`applyQuotaAutoSwitch`/`applyFailureFailover`/`shouldFailover`/`pickPriorityPreemption`.

active-account 원본 행: 142-143, 1108-1151, 2118-2242, 2292-2318.

포함 심볼: `resetCodexRoutingForManualSelection`, `getEffectiveActiveCodexAccountId`, `isEffectiveCodexAccountPinned`, `reconcileCodexActiveAfterExclusion`, 내부 `promoteActiveCodexAccount`, `setActiveCodexAccount`, `rememberActiveCodexAccount`, `releaseCodexAccountPinFor`, `releaseDrainedCodexAccountPin`, `consumeManualPreference`, `forgetManualPreference`, `manualPreferenceBlocks`.

`setActiveCodexAccount:2196`, `releaseDrainedCodexAccountPin:2305·2316`의 `saveConfigPreservingClaudeCode`가 이 파일로 온다. 오라클 1 동반 수정이 이 PR의 완료 조건이다.

`promoteActiveCodexAccount`는 이 파일의 패키지 내부 export다. 잔여 `recordCodexUpstreamOutcome`과 selection의 failover가 호출한다. 새 호출자를 만들지 않는다. 429 분기는 계속 `meta.promoteAccountId`를 재사용한다. 그 두 블록은 record 함수 안에 남는다.

회귀: `tests/codex-integration/codex-pool-rotation.test.ts`, `tests/codex-integration/codex-pool-plan-exclusion.test.ts`, `tests/codex-integration/codex-main-rotation.test.ts`, `tests/config/config-save-boundary.test.ts`, `tests/codex-integration/codex-routing.test.ts`.

이 PR 후 `src/codex/routing.ts` 잔여 본문 + re-export가 1,999줄 이하여야 한다. 예상 잔여 본문 ~1,174 + re-export ~80 ≈ 1,254.

## PR 5 — vendor-probes-key + 오라클 확장

목적: API 키 프로브를 옮기고, 옮긴 파일에 `.json(` 오라클을 같이 건다.

Write set:

- NEW `src/providers/quota/vendor-probes-key.ts` 예상 1,230줄
- MODIFY `src/providers/quota.ts`
- MODIFY `tests/providers/provider-quota.test.ts:122` 오라클 파일 목록
- MODIFY `structure/gui-and-management-api.md:502` 백틱

원본 행: 83-105, 319-1196, 2312-2597, 3036-3076.

`keyQuotaReaderForProvider`가 kimi/command/A6api/OpenCode Go/OpenRouter/DeepSeek/Cline/Ollama/Zai/Minimax/Moonshot/Venice/Synthetic/DeepInfra/Neuralwatt를 한 selector로 닫는다. 이 함수와 fetchers를 다른 PR로 쪼개지 않는다.

오라클 확장 후 형태(동등):

```ts
const QUOTA_PROBE_SOURCES = [
  "src/providers/quota.ts",
  "src/providers/quota/vendor-probes-key.ts",
] as const;
for (const relative of QUOTA_PROBE_SOURCES) {
  const source = readFileSync(repoPath(relative), "utf8");
  expect(source).not.toMatch(/\.\s*json\s*\(/);
}
```

프로브는 계속 `readQuotaJson`(`quota-wire.ts`)만 쓴다. 새 파일에 `response.json(` 또는 `.json(`가 생기면 이 테스트가 실패해야 한다.

회귀: `tests/providers/provider-quota.test.ts`, `tests/providers/zhipu-bigmodel-responses-quota.test.ts`, `tests/providers/opencode-go-quota.test.ts`, `tests/providers/command-code-quota.test.ts`, `tests/providers/provider-api-keys.test.ts`.

layout 등록 없음 (기존 테스트 수정).

## PR 6 — vendor-probes-oauth + antigravity

목적: OAuth 프로브와 Antigravity 프로브를 옮긴다. account-cache는 아직 남고 antigravity 함수를 현재 경로에서 import한다.

Write set:

- NEW `src/providers/quota/vendor-probes-oauth.ts` 예상 700줄 (1274-1671 398 + cursor 160 + XAI URL 2 + anthropicUsageInflight 포함 import ≈ 620~700)
- NEW `src/providers/quota/antigravity.ts` 예상 284줄
- MODIFY `src/providers/quota.ts`
- MODIFY `tests/providers/provider-quota.test.ts` 오라클 배열에 두 파일 추가
- MODIFY `structure/transports/inventory.md:134` — 진단 바인딩 구현 경로. 최종 문구는 PR 7에서 account-cache를 더한다

oauth 원본 행: 106-107, 1274-1671, 2598-2757.
antigravity 원본 행: 2164-2169, 2758-3035.

export: `parseXaiCreditsResponse`, `isCanonicalAntigravityQuotaUrl`, `setAntigravityAccountQuotaTransportForTests`, `fetchAntigravityUsageQuota`. 내부 `fetchAnthropicQuota`/`fetchKiroQuota`/`fetchCursorQuota`/`fetchChatGptForwardQuota`는 `maybeFetchProviderQuota`가 쓰므로 패키지 내부 export.

회귀: `tests/providers/provider-account-quota.test.ts`, `tests/adapters/anthropic/anthropic-ratelimit-headers.test.ts`, `tests/providers/muse-passive-quota-observation.test.ts`, `tests/providers/kiro/kiro-account-quota.test.ts`.

## PR 7 — account-cache

목적: per-account 캐시와 persist/reconcile을 한 모듈에 둔다.

Write set:

- NEW `src/providers/quota/account-cache.ts` 예상 634줄
- MODIFY `src/providers/quota.ts`
- MODIFY `tests/usage/quota-reset-detector.test.ts:120` 주석 경로를 `account-cache.ts`의 `validReset` 행으로
- MODIFY `structure/transports/inventory.md:134` 최종 구현 파일 `quota/account-cache.ts` + `quota/antigravity.ts`

원본 행: 1672-2163, 2170-2311.

포함 심볼: `ProviderAccountQuota`, `supportsPerAccountQuota`, `providerOAuthAccountQuotaMode`, `getCachedProviderAccountQuota`, `setCachedProviderAccountQuotaForTests`, `parseAnthropicRateLimitHeaders`, `recordAnthropicAccountQuotaFromHeaders`, `hasPassiveAccountQuota`, `recordPassiveAccountQuota`, `readPassiveProviderAccountQuotas`, `sweepExpiredProviderAccountQuotaRows`, `reconcileProviderAccountQuotaRows`, `resetProviderQuotaReconcileStateForTests`, `clearAccountQuotaCache`, `fetchProviderAccountQuotas`.

state-store `provider-quota-history`는 `reconcileProviderAccountQuotaRows`를 facade에서 계속 import.

회귀: `tests/providers/provider-account-quota.test.ts`, `tests/providers/provider-account-quota-persistence.test.ts`, `tests/oauth/state-store-sweeper.test.ts`, `tests/adapters/anthropic/anthropic-quota-dispatch.test.ts`, `tests/server/provider-account-quota-routes.test.ts`.

## PR 8 — report-cache

목적: report 객체 키 WeakMap 세 개와 프로세스 캐시를 한곳에 둔다. 관측 시임은 facade에 남긴다.

Write set:

- NEW `src/providers/quota/report-cache.ts` 예상 287줄
- MODIFY `src/providers/quota.ts` — `fetchProviderQuotaReports` 3207-3313, `maybeFetchProviderQuota` 3088-3143, `notifyProviderQuotaSnapshot` 3171-3201, `pendingProviderObservation` 3144, `fetchProviderApiKeyQuotas` 3077-3087, 전량 re-export
- MODIFY `structure/runtime.md:342` WeakMap 소유를 `src/providers/quota/report-cache.ts`로
- MODIFY `structure/transports/inventory.md:34`는 facade `src/providers/quota.ts`를 오케스트레이션으로 남긴다. 증거 바인딩 문장은 runtime.md와 중복되지 않게 report-cache를 가리킨다

원본 행: 109-174, 175-318, 1197-1273.

세 WeakMap은 이 파일 밖으로 나가지 않는다. `tagNativeMainReport` / `keyReport` / `isProviderQuotaReportCurrent`만 export.

`notifyProviderQuotaSnapshot`은 계속 facade에 있고 `import("../quota/reset-observer")` 동적 엣지를 유지한다. `SEAMS` 수정 없음.

이 PR 후 `src/providers/quota.ts` 예상 ~320줄.

회귀: `tests/providers/provider-quota.test.ts`, `tests/providers/provider-quota-observed-marker.test.ts`, `tests/usage/quota-reset-core-boundary.test.ts`, `tests/usage/quota-reset-account-key.test.ts`.

## facade re-export 계약

두 facade는 분해 전 `export` 이름을 빠짐없이 다시보낸다. 철자가 바뀌면 소비자 전부가 빨간다.

routing.ts public 목록 (현재 export): `CodexThreadResolution`, `CodexAffinityMove`, `CodexAffinityReason`, `CodexAffinityDecision`, `CODEX_QUOTA_PROBE_INTERVAL_MS`, `CODEX_FAILURE_WINDOW_MS`, `TERMINAL_SHORT_WINDOW_FRESHNESS_MS`, `CODEX_TRANSIENT_SOFT_AVOID_MS`, `CODEX_THREAD_AFFINITY_IDLE_TTL_MS`, `CODEX_THREAD_AFFINITY_MAX_ENTRIES`, `CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS`, `CODEX_TRANSIENT_AFFINITY_HOLD_MS`, `CodexUpstreamOutcome`, `CodexUpstreamOutcomeClass`, `CodexCooldownSource`, `CodexQuotaScope`, `CodexQuotaRecoveryProbeClaim`, `CodexQuotaRecoveryProbeProof`, `codexQuotaScopeForModel`, `CodexUpstreamOutcomeMeta`, `listLiveCodexAccountIds`, `clearThreadAccountMap`, `clearThreadAccountMapForAccount`, `clearCodexUpstreamHealth`, `clearCodexUpstreamHealthForAccount`, `reconcileCodexRoutingHealth`, `getCodexUpstreamHealth`, `computeCodexUsageScore`, `classifyCodexUpstreamOutcome`, `parseRetryAfterMs`, `parseResetCooldownMs`, `computeQuotaCooldown`, `computeQuotaCooldownUntil`, `tryAcquireCodexQuotaProbeLease`, `canAcquireCodexQuotaProbeLease`, `claimDueCodexQuotaRecoveryProbes`, `ManualResetCooldownClaim`, `claimManualResetCooldowns`, `ManualResetRefreshLineage`, `settleManualResetCooldown`, `settleCodexQuotaRecoveryProbe`, `tryAcquireCodexQuotaScopeProbeLease`, `canAcquireCodexQuotaScopeProbeLease`, `releaseCodexQuotaProbeLease`, `releaseCodexQuotaScopeProbeLease`, `resetCodexRoutingForManualSelection`, `getCodexAccountCooldownUntil`, `getCodexAccountHealthSnapshot`, `getCodexQuotaHealthSnapshot`, `isCodexAccountInCooldown`, `clearCodexAccountCooldown`, `getCodexAccountSoftAvoidUntil`, `isCodexAccountSoftAvoided`, `isCodexAccountPlanExcluded`, `debugCodexAffinityGenerations`, `handOffThreadAffinityGeneration`, `getPoolAccountPlan`, `pickLowestUsageCodexAccount`, `pickAlternateCodexAccount`, `getEffectiveActiveCodexAccountId`, `isEffectiveCodexAccountPinned`, `reconcileCodexActiveAfterExclusion`, `resolveCodexAccountForThread`, `previewCodexAccountForRequest`, `resolveCodexAccountForThreadDetailed`, `recordCodexUpstreamOutcome`, `formatCodexProviderForLog`.

quota.ts public 목록: `ProviderQuota` 타입 re-export, `QUOTA_RESPONSE_MAX_BYTES`, `setProviderQuotaBeforePublishForTests`, `ProviderQuotaReport`, `ProviderQuotaResponse`, `clearProviderQuotaCache`, `readProviderQuotaJsonForTests`, `parseOllamaCloudQuota`, `parseZaiQuotaLimits`, `publishKeyReportForTests`, `parseXaiCreditsResponse`, `ProviderAccountQuota`, `supportsPerAccountQuota`, `providerOAuthAccountQuotaMode`, `getCachedProviderAccountQuota`, `setCachedProviderAccountQuotaForTests`, `parseAnthropicRateLimitHeaders`, `recordAnthropicAccountQuotaFromHeaders`, `hasPassiveAccountQuota`, `recordPassiveAccountQuota`, `readPassiveProviderAccountQuotas`, `sweepExpiredProviderAccountQuotaRows`, `reconcileProviderAccountQuotaRows`, `resetProviderQuotaReconcileStateForTests`, `clearAccountQuotaCache`, `fetchProviderAccountQuotas`, `isCanonicalAntigravityQuotaUrl`, `setAntigravityAccountQuotaTransportForTests`, `fetchAntigravityUsageQuota`, `providerApiKeyQuotaMode`, `fetchProviderApiKeyQuotas`, `providerObservationAccountKeyForTests`, `flushProviderQuotaObservationsForTests`, `fetchProviderQuotaReports`.

## 사이클 완료 조건

- `src/codex/routing.ts` ≤ 1,999, `src/providers/quota.ts` ≤ 1,999, 새 모듈 전부 ≤ 1,999
- 싱글턴이 표의 소유 파일에만 존재. 인자로 새는 상태 0
- 함정 7항 미발생
- 오라클 4건이 새 경로를 읽거나, 읽지 않아도 되는 이유(SEAMS facade 잔류)가 이 문서와 일치
- structure 백틱 6곳이 구현 파일과 모순 없음
- layout.json / test-layout-expected.json 변경 없음
- 로컬 스위트 NOT RUN. 레인 tip hosted CI exact-head 녹색 후 D에서 ratchet:update

## 정정 모아보기

1. `promoteAccountId` 재사용 행 3369·3420 → **3371·3422**.
2. `recordCodexUpstreamOutcome`는 `promoteActiveCodexAccount` 단독 호출자가 아님. 단독 제약은 429 링 이중 전진 방지로 좁힘.
3. vendor-probes-key ~900 → **~1,230** (kimi/command+selector 포함).
4. antigravity ~230 → **~284**.
5. account-cache ~520 → **~634**.
6. report-cache ~230 → **~287**.
7. routing 잔여 ~900 → preview/rebind/transient 포함 **~1,250**.
8. quota 잔여 ~700(`fetchProviderQuotaReports` 3207) → reports 본체는 107줄, 잔여 합 **~320**.
9. thread-affinity ~600 → 순환 import 제외 **~480**.
10. selection ~560 → apply*/priority 포함 **~680**.
11. cooldown-math ~260 → Meta 타입 포함 **~300**.
12. detector 주석 `quota.ts:279`는 현재 잘못된 행. 0-survive는 `quota.ts:1686-1687` vs `codex/quota.ts:184`.
13. core.ts account-failover 퍼밋은 1506이 아니라 **1511-1515**.
14. `codexQuotaAvoidUntil`는 cooldown-math가 아니라 health-store.
15. 새 디렉터리는 `src/codex/routing/`, `src/providers/quota/` (기존 `src/routing/`, `src/quota/` 금지).

