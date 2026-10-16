# 260915 godfile round3 — 사이클 4: catalog/provider-fetch.ts

provider-fetch.ts 2,944줄은 카탈로그의 "살아있는 발견" 전부 — gather single-flight, 인증 캡처, 모델 API 파싱, 콤보 합성, 설정 힌트 병합 — 를 한 파일에 쌓아 올린 파일이다. 이 문서는 그것을 상태 소유권이 겹치지 않는 6개 리프로 나눈 원본 행 범위, 예상 줄 수, PR별 write set, 재수출, 주석 오라클 패치를 복붙 실행 가능하게 고정한다. 실행자는 이 순서대로만 옮기고, 소비자(convergence, retained-sync, build-entries, management 서버, CLI)는 facade 경로를 유지하므로 아무것도 바뀌지 않으며, 마지막 PR에서 provider-fetch.ts는 sync.ts 52줄 선례와 같은 named re-export 전용 파사드가 된다.

> 전달 형태 정정: 이 문서가 적은 브랜치 이름과 PR 개수는 실행되지 않았다. 다섯 파일이 한 워킹트리에서 동시에 작업돼 두 개의 PR로 수렴했다. 이동 계약과 함정 항목은 그대로 실행됐다. 실제 전달은 [090_outcome.md](./090_outcome.md) 를 보라.


기준 트리: 작업 디렉터리 `/Users/jun/.codex/worktrees/5880/opencodex`, 브랜치 `codex/m3-l1-roadmap`, `origin/dev` `ce0ac617da`, HEAD `ce0ac617da`. 이 문서의 모든 행 번호는 그 HEAD에서 `wc -l`과 `rg -n`으로 실측한 값이다. PR1 base는 L4 체인 tip(`codex/m3-l4-auth-api`)이고 PR6 head가 사이클 4 tip(`codex/m3-l5-provider-fetch`)이다. 앞선 PR이 줄을 지운 뒤에는 sed 범위가 아니라 심볼 표가 권위다. 로컬 install/build/test는 하지 않는다. 로컬 검증은 `/tmp/m3_verify.ts`(`000_plan.md` 정의) 하나이고 나머지는 hosted exact-head CI다.

순수 이동. 동작 변경 금지. 원본 경로 facade 재수출 필수.

## 실측 요약 (HEAD ce0ac617da)

| 항목 | 값 | 근거 |
|---|---|---|
| 총 줄 수 | 2,944 | `wc -l` |
| top-level export 문 | 38 (function 30, interface 3, class 1, const 3, re-export 1) | `rg -c '^export'` = 38, `rg -c '^export (async )?function'` = 30 |
| 최대 함수 | fetchProviderModelsWithAuth 1602-2134 (533줄), gatherRoutedModelsUncached 2390-2816 (427줄), resolveComboCatalogMember 1029-1190 (162줄), applyProviderConfigHints 805-912 (108줄), catalogHintsFromModelsApiItem 1489-1567 (79줄) | `rg -n '^}'` 닫는 행 실측 |
| 모듈 스코프 `let` | 1개 (lastWarningReconciledGeneration, 1259) | `rg -n '^(let|var) '` |
| 가변 const 바인딩 | 3개 (gatherInflight 244, gatherGate 248, lastDropWarnSignature 1258) | 같은 grep + 사용처 |
| 미사용 import | `upstreamModelsSnapshot` (86행) — 파일 내 참조 0건 | `rg -n 'upstreamModelsSnapshot'` = 86 한 줄 |
| structure/ 백틱 참조 | 0곳 | `rg 'provider-fetch|gatherRoutedModels|fetchProviderModels' structure/` = 0 적중 |
| 본문을 텍스트로 읽는 오라클 | 0건 | `rg -U 'readFileSync\([^)]*provider-fetch' tests/` = 0 적중 |
| layout.json 등록 | 없음 (새 테스트 파일도 없음) | `rg 'provider-fetch' scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json` = 0 적중 |

top-level export 목록 (38): interface CatalogGatherProviderAuthOutcome(110), CatalogGatherProviderModelOutcome(115), GatherRoutedModelsOptions(120); class CatalogGatherBusyError(250, ResourceAdmissionError 상속); const lastDropWarnSignature(1258), QUIET_AUTHORITATIVE_CATALOG_PROVIDERS(1269), CALLABLE_CONFIGURED_COMPATIBILITY_MODELS(1271); `export type { CatalogGatherProviderAuthEvidence } from "./filesystem-evidence"`(106); 함수 30개 — catalogGatherAdmissionMetrics(259), createCatalogGatherAuthorityIdentity(314), applyRegistryCapabilitySeedFill(439), configuredComboTargetModelsByProvider(521), clearGatherRoutedModelsInflight(674), configuredContextWindow(704), configuredInputModalities(711), configuredModelDisplayName(719), configuredMaxInputTokens(728), configuredAutoCompactTokenLimit(771), applyProviderConfigHints(805), catalogHintsFromProviderConfig(914), applyConfigHintsToCachedModels(927), resolveComboCatalogMember(1029), isDatedVariantId(1253), reconcileProviderFetchWarnings(1261), warnDroppedConfiguredIdsOnce(1289), isGlm52ModelId(1304), isGlm53ModelId(1313), discoveredPricingStatus(1480), catalogHintsFromModelsApiItem(1489), fetchProviderModels(2136), shouldExposeProviderModel(2151), shouldRetainConfiguredProviderModel(2159), mergeConfiguredModelsIntoLiveCatalog(2180), filterCatalogVisibleModels(2226), gatherRoutedModels(2268), gatherRoutedModelsForCatalogGather(2284), augmentRoutedModelsWithRegistryOpenAiApiRows(2818), augmentRoutedModelsWithMetadata(2902).

## 현재 파일 해부

모든 리프는 `src/codex/catalog/` 바로 아래 형제다. 서브디렉터리를 만들지 않는다(`../x` 함정, 아래 예방 (e)).

| 새 파일 | NEW/MODIFY | 원본 행 (inclusive) | 원본 줄 수 | 예상 줄 수 | 가져갈 심볼 |
|---|---|---|---:|---:|---|
| catalog/model-hints.ts | NEW | 439-453, 678-936, 1269-1287, 1304-1567 | 557 | ~650 | applyRegistryCapabilitySeedFill, NUMERIC_MODEL_ID_SEGMENT, anthropicFamilyContextWindow, configuredContextWindow, configuredInputModalities, configuredModelDisplayName, configuredMaxInputTokens, generatedMaxOutputTokens, routedMaxOutputTokens, configuredAutoCompactTokenLimit, configuredReasoningSummarySupport, configuredVerbositySupport, applyProviderConfigHints, catalogHintsFromProviderConfig, applyConfigHintsToCachedModels, QUIET_AUTHORITATIVE_CATALOG_PROVIDERS, CALLABLE_CONFIGURED_COMPATIBILITY_MODELS, isGlm52ModelId, isGlm53ModelId, plainRecord, MODEL_DISCOVERY_METADATA_CONTROL_CHARS, positiveSafeInteger, normalizedMetadataString, normalizedStringList, modelCapabilities, modelInputModalities, DISCOVERED_PRICING_RATE_PATTERN, discoveredPricingRate, discoveredPricingStatus, catalogHintsFromModelsApiItem |
| catalog/combo-member.ts | NEW | 521-538, 946-1190 | 263 | ~330 | configuredComboTargetModelsByProvider, COMBO_MEMBER_CONTEXT_FALLBACK, ComboCatalogMemberFallback, comboMemberVendorMetadata, vendorMetadataComboFallback, resolveComboCatalogMember |
| catalog/model-visibility.ts | NEW | 1192-1267, 1289-1302, 2151-2266 | 206 | ~280 | DATED_VARIANT_YYYYMMDD/YYMMDD/MMDD_OR_YYMM, isLeapYear, isValidCalendarDate, isDatedVariantSuffix, isDatedVariantId, lastDropWarnSignature, lastWarningReconciledGeneration, reconcileProviderFetchWarnings, warnDroppedConfiguredIdsOnce, shouldExposeProviderModel, shouldRetainConfiguredProviderModel, mergeConfiguredModelsIntoLiveCatalog, filterCatalogVisibleModels |
| catalog/gather-capture.ts | NEW | 108-118, 142-195, 235-242, 245-246, 263-671 | 484 | ~570 | CatalogGatherProviderAuthOutcome, CatalogGatherProviderModelOutcome, ModelsAuthResolution, ModelsAuthResolver, ModelsAuthResolverFactory, CapturedModelsRequest, CapturedProviderGather, GatherFlightCapture, withCanonicalOpenAiForwardAuthDefault, CATALOG_GATHER_AUTHORITY_KEY, REQUEST_CREDENTIAL_SENTINEL, stableJson, framed, canonicalAuthorityEncoding, keyedGatherIdentity, keyedGatherBytesIdentity, createCatalogGatherAuthorityIdentity, detachedClone, recursivelyFreeze, detachedFrozen, capturedField, captureTrustedOpenAiApiPolicy, captureModelsRequest, captureProviderGather, captureGatherFlight, omitProviderTransportExecutor, materializeCapturedHeaders, providerCatalogFingerprint, gatherFlightKey |
| catalog/provider-models.ts | NEW | 137-140, 1575-1600, 1602-2149 | 578 | ~670 | ProviderModelsResult, refreshingModelsAuthResolver, observedModelsAuthResolver, fetchProviderModelsWithAuth, fetchProviderModels |
| catalog/routed-gather.ts | NEW | 120-135, 197-233, 244, 247-261, 674-676, 2268-2944 | 749 | ~850 | GatherRoutedModelsOptions, GatherFlightResult, GatherInflightEntry, gatherInflight, MAX_CONCURRENT_CATALOG_GATHERS, gatherGate, CatalogGatherBusyError, catalogGatherAdmissionMetrics, clearGatherRoutedModelsInflight, gatherRoutedModels, gatherRoutedModelsForCatalogGather, gatherRoutedModelsWithAuth, boundCustomNativeReasoning, gatherRoutedModelsUncached, augmentRoutedModelsWithRegistryOpenAiApiRows, augmentRoutedModelsWithCapturedOpenAiApiRows, augmentRoutedModelsWithMetadata |
| provider-fetch.ts facade | MODIFY | 1-107 import 블록을 재수출 블록으로 교체, 본문 0 | 2,944 -> ~120 | ~120 | 38개 export 전부 named re-export |

이동 합계 2,837 + 잔여(=import 헤더 1-107) 107 = 2,944. 리프 6개 합계 예상 ~3,320은 리프별 import 헤더 중복(~380줄) 때문이고 정상이다. 이름 충돌 검증: 기존 형제 20개(account-models, aggregation, auto-review, build-entries, bundled, derive-entry, effort, filesystem-evidence, gated-native-warn, kinds, metadata, native-models, parsing, provider-fetch, remote, reserve, restore, retained-sync, subagent-roster, sync)와 새 이름 6개(model-hints, combo-member, model-visibility, gather-capture, provider-models, routed-gather)는 겹치지 않는다.

## 상태 소유권 (인자로 새면 안 되는 것)

한 바인딩은 한 모듈. 아래 7개가 이 파일의 모듈 스코프 상태 전부다. 리프 간 공유는 "소유 리프가 export, 소비 리프가 named import"로만 하고 함수 인자나 반환값으로 넘기지 않는다. facade는 같은 바인딩을 재수출할 뿐 새로 만들지 않는다 — `export const lastDropWarnSignature = new Map()`을 facade에 다시 쓰면 build-entries의 리셋이 다른 Map을 clear하는 셈이다.

| 바인딩 | 현재 행 | 소유 리프 | 기록 위치 | 판독 위치 | resetCatalogRuntimeStateForTests | 비고 |
|---|---|---|---|---|---|---|
| gatherInflight (Map) | 244 | routed-gather | set 2336, delete 2326, bucket splice 2331, clear 675 | get 2310, 2323 | 간접 리셋됨 — build-entries.ts:326의 clearGatherRoutedModelsInflight() | single-flight 버킷. 키는 `refreshing:`/`observed:` 접두 + gatherFlightKey(2274, 2297) |
| gatherGate (AdmissionGate) | 248 | routed-gather | tryAcquire lease 2317 | metrics 260 | 리셋 없음(설계상 lease 기반) | `createAdmissionGate("catalog_gathers", 8)`. 초과 시 CatalogGatherBusyError 2318 |
| MAX_CONCURRENT_CATALOG_GATHERS | 247 | routed-gather | 없음(불변) | 248, 254 | 없음 | 불변이지만 gate와 class가 같은 값을 봐야 하므로 동일 리프 |
| CATALOG_GATHER_AUTHORITY_KEY | 245 | gather-capture | 없음(프로세스 수명 불변) | 300, 307 | 없음 | randomBytes(32). authority identity의 뿌리. 인스턴스가 2개 생기면 identity가 뒤섞인다 |
| REQUEST_CREDENTIAL_SENTINEL | 246 | gather-capture | 없음(불변) | 408(buildModelsRequest 주입), 615(materializeCapturedHeaders 치환) | 없음 | randomBytes(16) hex. 요청 직렬화에만 실제 키가 스치는 표식 |
| lastDropWarnSignature (Map, export) | 1258 | model-visibility | set 1292, clear 1264, clear build-entries.ts:317 | get 1291, size 1263 | 직접 리셋됨 | build-entries.ts:30이 facade 경유 import. re-export는 같은 바인딩이어야 한다 |
| lastWarningReconciledGeneration (`let`) | 1259 | model-visibility | 1265 | 1262 | 리셋하지 않음 (측정된 사실) | 유일한 `let`. state-store sweeper generation 게이트. 지금처럼 리셋 대상에서 빠져 있어야 한다 |

이 파일은 withCatalogWriteSerialization을 쓰지 않는다(동시성 제어는 모델 캐시 + inflight). retained-sync 쪽 permit 계약과 섞지 말 것. aggregation 소유의 openAiApiCollisionWarnings는 augment 클러스터(2891-2892)가 import해서 has/add만 한다 — 이동 후에도 routed-gather가 aggregation에서 import하는 현재 형태 유지. 리셋은 build-entries.ts:318이 aggregation에서 직접 가져와 하므로 변경 없음.

### resetCatalogRuntimeStateForTests와의 관계 (측정)

`src/codex/catalog/build-entries.ts:315-330` — 이 모듈 상태 2종을 리셋한다: `lastDropWarnSignature.clear()`(317)와 `clearGatherRoutedModelsInflight()`(326). `lastWarningReconciledGeneration`은 리셋하지 않고, `gatherGate`도 대상이 아니다. 분해 후에도 build-entries의 import 경로는 `./provider-fetch`(facade) 그대로고 facade가 model-visibility의 Map과 routed-gather의 clear 함수를 재수출하므로 build-entries는 무변경이다.

state-store 등록 `src/lib/state-store-registrations.ts:8,106`는 이름 문자열 `"provider-fetch-warning-memos"`로 reconcileProviderFetchWarnings(model-visibility 소유)를 건다. 등록 이름은 모듈 경로가 아니라 저장소 식별자다 — 절대 renamed하지 않는다.

## 리프 간 import 그래프 (순환 금지)

    model-hints:      (리프 import 없음)
    combo-member:     model-hints (applyProviderConfigHints 1093/1116, configuredAutoCompactTokenLimit 1169)
    model-visibility: model-hints (CALLABLE 2164, applyProviderConfigHints 2208)
    gather-capture:   model-hints (applyRegistryCapabilitySeedFill 464), combo-member (configuredComboTargetModelsByProvider 546)
    provider-models:  gather-capture (captureProviderGather 2142, materializeCapturedHeaders 1904, 타입), model-hints (catalogHintsFromProviderConfig 1636/1689/1722/1789, applyConfigHintsToCachedModels 1708/1714/1738/1746/1754/1805/1818/1826/1867/1885/1897/1937, applyProviderConfigHints 2014/2087, catalogHintsFromModelsApiItem 2076, QUIET 1657), model-visibility (mergeConfiguredModelsIntoLiveCatalog 1642, warnDroppedConfiguredIdsOnce 1659, shouldExposeProviderModel 2094)
    routed-gather:    gather-capture (captureGatherFlight 2309, gatherFlightKey 2274/2277, keyedGatherBytesIdentity 2294, withCanonicalOpenAiForwardAuthDefault 2575, 타입), provider-models (fetchProviderModelsWithAuth 2407, refreshingModelsAuthResolver 2275, observedModelsAuthResolver 2298), model-hints (configuredMaxInputTokens 2602, configuredAutoCompactTokenLimit 2619/2859, applyProviderConfigHints 2932, routedMaxOutputTokens 2866), combo-member (resolveComboCatalogMember 2540)
    provider-fetch.ts: 위 6개 리프 named re-export만

금지: 어떤 리프도 `./provider-fetch`, `./sync`, `./retained-sync`, `./build-entries`를 import하지 않는다. 이 파일을 아래에서 쓰는 쪽(build-entries.ts:30, retained-sync.ts:53, convergence.ts:28-34)이 위로 향하고, 리프가 다시 위를 보는 즉시 순환이다. 외부 형제 import는 원본 그대로 parsing/metadata/aggregation/filesystem-evidence만 허용된다.

## 함정 (하지 말아야 할 분할)

1. gatherRoutedModelsWithAuth(2303-2363)를 gatherInflight/gatherGate에서 떼어 내지 말 것. 2325 주석 "Claim the slot synchronously before any await"대로 bucket 조사→lease 획득→flight 등록이 한 동기 구간이다. 함수와 상태는 둘 다 routed-gather 소유다.
2. fetchProviderModelsWithAuth(533줄)와 gatherRoutedModelsUncached(427줄)를 쪼개지 말 것. ollama/cursor/qoder/devin/vertex/antigravity 분기는 한 함수 안의 분기지 모듈 경계가 아니다. uncached가 만드는 GatherFlightResult 필드 집합은 flight promise로 join되는 계약이라 필드 추가·삭제도 금지.
3. captureGatherFlight(540-594)가 만든 배열을 resolver(provider-models 소유)가 채우는 프로토콜(capturedField 371)을 인자 재설계로 바꾸지 말 것. capture 소유는 gather-capture로 고정.
4. lastDropWarnSignature를 두 리프가 나눠 갖거나 facade가 복제하지 말 것. build-entries의 리셋과 reconcileProviderFetchWarnings의 generation 게이트가 같은 Map을 봐야 한다.
5. augmentRoutedModelsWithCapturedOpenAiApiRows와 openAiApiCollisionWarnings(aggregation 소유)를 함께 옮기되, 상태를 routed-gather로 복제하지 말 것. 복제하면 같은 충돌이 두 번 경고된다.
6. catalogGatherAdmissionMetrics는 현재 src/gui/tests 어디에서도 호출하지 않는다(측정). 그래도 지우지 말 것 — public export 38개 보존이 이 사이클의 계약이다.

## 직전 라운드 CI가 잡은 5종 결함의 예방 (이 파일 매핑)

1. **리프가 심볼을 정의하고 export 안 함.** 원본 non-export였는데 리프 간 import가 필요한 심볼의 전환 목록: gather-capture → withCanonicalOpenAiForwardAuthDefault, captureProviderGather, captureGatherFlight, gatherFlightKey, keyedGatherBytesIdentity, materializeCapturedHeaders, ModelsAuthResolver/ModelsAuthResolverFactory/CapturedProviderGather 타입. provider-models → fetchProviderModelsWithAuth, refreshingModelsAuthResolver, observedModelsAuthResolver. model-hints → routedMaxOutputTokens. 각 PR에서 `rg -n '^export' 새파일`을 이동 심볼 목록과 대조하고, 소비 리프의 named import가 전부 해석되는지 /tmp/m3_verify.ts로 확인한다.
2. **파사드가 re-export만 하고 로컬 import 누락.** PR1~5 동안 provider-fetch.ts에는 잔여 블록이 남는다. 잔여는 삭제한 블록의 심볼을 반드시 named import해야 한다: PR1 후 applyRegistryCapabilitySeedFill(464)+catalogHintsFromProviderConfig/applyConfigHintsToCachedModels/applyProviderConfigHints/catalogHintsFromModelsApiItem(1602-2134 잔여)+QUIET(1657)+configuredMaxInputTokens/configuredAutoCompactTokenLimit(2390-2944 잔여). PR2 후 configuredComboTargetModelsByProvider(546, 2540)+resolveComboCatalogMember(2540). PR3 후 mergeConfiguredModelsIntoLiveCatalog(1642)+warnDroppedConfiguredIdsOnce(1659)+shouldExposeProviderModel(2094). PR4 후 captureProviderGather/captureGatherFlight/gatherFlightKey/keyedGatherBytesIdentity/withCanonicalOpenAiForwardAuthDefault/materializeCapturedHeaders. PR6 이후에는 잔여 본문이 0이고 re-export만 남는다(`export *` 금지 — 표면 대조가 무력화된다).
3. **타입을 잘못된 모듈에서 import.** 타입 소유 표: CatalogModel → ./parsing, ComboCatalogOmission → ./aggregation, CatalogGatherProviderAuthEvidence → ./filesystem-evidence, Catalog*Snapshot/CatalogSourceEvidence 등 convergence 스냅샷 5종 → ../convergence-types, CatalogGatherProviderAuthOutcome/ModelOutcome/ModelsAuth*/Captured*/GatherFlightCapture → gather-capture, ProviderModelsResult → provider-models, GatherRoutedModelsOptions/GatherFlightResult/GatherInflightEntry → routed-gather. metadata에서 CatalogModel을 import하거나 소비 리프가 결과 타입을 재정의하면 실패다.
4. **정의가 통째로 사라지고 호출부만 남음.** 모든 블록은 이동+재수출이 같은 커밋이다. 533줄/427줄 거대함수는 닫는 행 실측표(위 실측 요약)로 심볼 경계를 재확인하고, 이동 후 `rg -n 'fetchProviderModelsWithAuth|gatherRoutedModelsUncached' src/`로 정의가 정확히 한 곳에 있는지 본다.
5. **한 단계 깊어진 디렉터리에서 `../x` 오해석.** 이번 분해는 같은 디렉터리 형제라 원본의 `../../` 깊이가 그대로 유효하다. `src/codex/catalog/provider-fetch/` 같은 서브디렉터리를 만드는 순간 import가 전부 한 단어 어긋나고 이것이 직전 라운드의 사고다. 서브디렉터리 생성 금지를 PR 설명에 명시한다.

## INV 승계

해당 없음. `structure/overview.md:86-115`의 INV 5종(INV-TOML-01, INV-OPENAI-01, INV-AGENT-01, INV-RESTORE-01, INV-SLUG-01)은 provider-fetch와 결합이 없다(측정: 구간 전수 확인). 승계 모듈 지정과 헤더 주석 이관은 불필요하다.

## 소스 오라클 (본문을 텍스트로 읽음)

0건. provider-fetch 본문을 readFileSync로 읽는 테스트는 없다(`rg -U 'readFileSync\([^)]*provider-fetch' tests/` = 0). 대신 같은 PR에서 고쳐야 할 경로·행번호 주석 2건:

1. tests/routing/routing-capability-model-matching.test.ts:23 — `src/codex/catalog/provider-fetch.ts:612`(materializeCapturedHeaders, modelRecordValue 런타임 리더) → PR4에서 `src/codex/catalog/gather-capture.ts`로 경로를 바꾸고 행번호를 재고정하거나 삭제한다.
2. tests/codex-integration/catalog-seed-window-fill.test.ts:23 — "Mirrors detachedClone in src/codex/catalog/provider-fetch.ts" → PR4에서 gather-capture.ts로 경로 교체.

무해 주석(행번호 없음, facade 경로 유효, 수정 불요): tests/providers/zhipu-bigmodel-provider.test.ts:57, src/providers/registry.ts:640, src/server/fast-row.ts:111, src/cli/models.ts:121, src/codex/catalog/derive-entry.ts:66. docs-site `model-ordering.md` 8개 로케일의 `src/codex/catalog/provider-fetch.ts` 언급도 facade가 경로를 유지하므로 유효하다 — 수정 불요. 구현 소유를 명시하고 싶으면 8개 로케일을 동시에, routed-gather.ts 병기로만.

## structure 동반 수정

0곳. `rg 'provider-fetch|gatherRoutedModels|fetchProviderModels' structure/` = 0 적중(측정). manifest.json 변경 없음, `bun run structure:index` 불필요, `bun run structure:check`은 기존 녹색 유지. 공개 API를 말하는 문장이 없어 병기 교체 대상도 없다.

## layout.json

새 테스트 파일 없음. scripts/test-layout/layout.json explicit와 tests/fixtures/test-layout-expected.json에 등록하지 않는다. 기존 오라클 파일은 도메인 유지(provider-*는 tests/providers/, catalog-*는 tests/codex-integration/).

## 공통 재수출 규칙

소비자는 계속 다음만 import한다: `src/codex/catalog`(catalog.ts:8, 9 심볼), `src/codex/catalog/provider-fetch`(convergence.ts:28-34, management-api.ts:81, server/index.ts:98, model-routes.ts:75, provider-routes.ts:7, state-store-registrations.ts:8, cli/models.ts:7, retained-sync.ts:53, build-entries.ts:30, 테스트 직접 import 23파일). 테스트의 `from "../../src/codex/catalog/provider-fetch"`와 동적 import(`require`, `await import`)를 새 자식 경로로 바꾸지 않는다. 예외는 위 주석 2건뿐이다. facade는 named re-export만 하고 sync.ts 52줄 선례처럼 본문 함수를 갖지 않는다.

---

## PR 1 — model-hints

브랜치: codex/m3-l5-01-model-hints. base: L4 tip(codex/m3-l4-auth-api). 제목: refactor(catalog): extract provider-fetch model hints

Write set:

- NEW src/codex/catalog/model-hints.ts (원본 439-453, 678-936, 1269-1287, 1304-1567; 원본 557줄, 예상 ~650)
- MODIFY src/codex/catalog/provider-fetch.ts (해당 블록 삭제, 재수출 추가, 잔여가 ./model-hints에서 필요 심볼 named import)
- MODIFY tests/routing/routing-capability-model-matching.test.ts — 아님. 이 PR에서는 테스트 수정 없음

조각 순서: 439-453 → 678-936 → 1269-1287 → 1304-1567. 함수 본문 byte 불변. configured* 계열은 "unknown is not zero" 계약(anthropicFamilyContextWindow의 숫자 tail 규칙 포함)이므로 로직 다듬기 금지. 새 리프 내부 export 추가: routedMaxOutputTokens(routed-gather가 2866에서 사용). QUIET/CALLABLE은 원본부터 export다.

회귀: tests/codex-integration/catalog-hub-context-window.test.ts, tests/codex-integration/catalog-input-modality-enum.test.ts, tests/codex-integration/catalog-llamacpp-capabilities.test.ts, tests/codex-integration/catalog-free-pricing-status.test.ts, tests/codex-integration/catalog-seed-window-fill.test.ts, tests/providers/featherless-provider.test.ts, tests/providers/provider-model-discovery-contract.test.ts, tests/providers/orcarouter-provider.test.ts, tests/providers/provider-model-aliases.test.ts, tests/codex-integration/codex-tool-mode.test.ts(103행 require). hosted CI exact-head. 로컬 스위트 NOT RUN.

완료 조건: wc -l provider-fetch.ts < 2,944, model-hints.ts < 1,999, /tmp/m3_verify.ts ALL CHECKS PASS.

## PR 2 — combo-member

브랜치: codex/m3-l5-02-combo-member. base: PR1. 제목: refactor(catalog): extract provider-fetch combo member synthesis

Write set:

- NEW src/codex/catalog/combo-member.ts (원본 521-538, 946-1190; 263줄, 예상 ~330)
- MODIFY src/codex/catalog/provider-fetch.ts

combo-member는 ./model-hints에서 applyProviderConfigHints(1093, 1116)와 configuredAutoCompactTokenLimit(1169)를 import한다. 잔여는 captureGatherFlight의 546(configuredComboTargetModelsByProvider)과 uncached의 2540(resolveComboCatalogMember)을 ./combo-member에서 named import한다. aggregation 심볼(deriveComboCatalogModel, warnUncataloguedComboOnce, replaceLastComboCatalogOmissions)은 본문이 쓰는 대로 ./aggregation에서 계속 가져온다.

회귀: tests/codex-integration/codex-catalog.test.ts, tests/codex-integration/gather-routed-models-single-flight.test.ts, tests/codex-integration/catalog-zero-credit-picker.test.ts, tests/providers/provider-model-aliases.test.ts.

함정: COMBO_MEMBER_CONTEXT_FALLBACK(946, 128k) 주석이 "operator-facing window, not a clamp"임을 말한다. 폴백 값을 인자로 끌어내지 말 것.

## PR 3 — model-visibility

브랜치: codex/m3-l5-03-model-visibility. base: PR2. 제목: refactor(catalog): extract provider-fetch visibility and drop-warn memos

Write set:

- NEW src/codex/catalog/model-visibility.ts (원본 1192-1267, 1289-1302, 2151-2266; 206줄, 예상 ~280)
- MODIFY src/codex/catalog/provider-fetch.ts

모듈 상태 2종(lastDropWarnSignature, lastWarningReconciledGeneration)이 여기로 온다. lastDropWarnSignature는 export 유지 — facade 재수출이 build-entries.ts:30,317의 리셋 경로를 지탱한다. dated-variant 도우미 4종은 이 리프 내부에서만 공급된다(isDatedVariantId 1253의 유일한 in-file 호출부가 merge 2206). 잔여(WithAuth)는 mergeConfiguredModelsIntoLiveCatalog/warnDroppedConfiguredIdsOnce/shouldExposeProviderModel을 ./model-visibility에서 named import한다.

회귀: tests/codex-integration/catalog-retain-models.test.ts(mergeConfiguredModelsIntoLiveCatalog, shouldRetainConfiguredProviderModel 직접 import), tests/codex-integration/codex-catalog.test.ts, tests/oauth/state-store-sweeper.test.ts(provider-fetch-warning-memos 스윕).

## PR 4 — gather-capture

브랜치: codex/m3-l5-04-gather-capture. base: PR3. 제목: refactor(catalog): extract provider-fetch gather capture and authority identity

Write set:

- NEW src/codex/catalog/gather-capture.ts (원본 108-118, 142-195, 235-242, 245-246, 263-671; 484줄, 예상 ~570)
- MODIFY src/codex/catalog/provider-fetch.ts
- MODIFY tests/routing/routing-capability-model-matching.test.ts:23 (경로·행번호 주석 → gather-capture.ts)
- MODIFY tests/codex-integration/catalog-seed-window-fill.test.ts:23 (주석 경로 → gather-capture.ts)

새 리프 내부 export 추가: withCanonicalOpenAiForwardAuthDefault(routed-gather 2575), captureProviderGather(provider-models 2142), captureGatherFlight/gatherFlightKey/keyedGatherBytesIdentity(routed-gather 2309/2274/2294), materializeCapturedHeaders(provider-models 1904), ModelsAuthResolver/ModelsAuthResolverFactory/CapturedProviderGather 타입(B·C 시그니처). CATALOG_GATHER_AUTHORITY_KEY와 REQUEST_CREDENTIAL_SENTINEL은 non-export 유지 — 프로세스 단일 인스턴스가 authority identity와 크리덴티얼 치환의 정확성 조건이다.

회귀: tests/codex-integration/codex-gather-authority.test.ts, tests/codex-integration/catalog-oauth-observation.test.ts, tests/codex-integration/gather-routed-models-single-flight.test.ts, tests/routing/routing-capability-model-matching.test.ts, tests/codex-integration/catalog-seed-window-fill.test.ts.

## PR 5 — provider-models

브랜치: codex/m3-l5-05-provider-models. base: PR4. 제목: refactor(catalog): extract provider-fetch live model fetch

Write set:

- NEW src/codex/catalog/provider-models.ts (원본 137-140, 1575-1600, 1602-2149; 578줄, 예상 ~670)
- MODIFY src/codex/catalog/provider-fetch.ts

새 리프 내부 export 추가: fetchProviderModelsWithAuth, refreshingModelsAuthResolver, observedModelsAuthResolver(전부 routed-gather 소비). 원본 86행의 `upstreamModelsSnapshot` import는 파일 내 참조가 0이므로 어떤 리프도 가져가지 않고 여기서 소멸한다(측정 사실, 별도 삭제 커밋 불필요). ollama/cursor/qoder/devin/antigravity/google 어댑터 fetcher와 model-discovery, provider-outbound, redact, model-cache import는 본문이 쓰는 것만 원본 1-107에서 복사한다.

회귀: tests/providers/qoder-live-models.test.ts, tests/providers/devin-live-models.test.ts, tests/providers/github-copilot/github-copilot-wire-defaults.test.ts, tests/claude-integration/claude-agents-inject.test.ts, tests/codex-integration/codex-catalog.test.ts, tests/fixtures/provider-outbound-e2e.ts를 쓰는 outbound e2e.

함정: 533줄 fetchProviderModelsWithAuth를 PR 단위로도 쪼개지 않는다. ttl/cooling/stale 분기와 model-cache 키 흐름이 한 함수 안에서 맞물린다.

## PR 6 — routed-gather + facade 완성

브랜치: codex/m3-l5-06-routed-gather(= 사이클 4 tip codex/m3-l5-provider-fetch). base: PR5. 제목: refactor(catalog): extract routed gather and make provider-fetch a facade

Write set:

- NEW src/codex/catalog/routed-gather.ts (원본 120-135, 197-233, 244, 247-261, 674-676, 2268-2944; 749줄, 예상 ~850)
- MODIFY src/codex/catalog/provider-fetch.ts — 1-107을 named re-export 블록으로 교체, 본문 0, 목표 ~120줄

routed-gather는 상태 3종(gatherInflight, gatherGate, MAX_CONCURRENT)과 CatalogGatherBusyError/clearGatherRoutedModelsInflight/catalogGatherAdmissionMetrics를 소유한다. single-flight 동기 구간(2310-2336)이 통째로 같은 파일에 온다. facade는 원본 38개 export를 1:1 named re-export한다 — `rg '^export' src/codex/catalog/provider-fetch.ts`를 origin/dev 버전과 대조하는 것이 /tmp/m3_verify.ts export 표면 검사의 기준이다. catalog.ts(14줄)와 convergence/management 서버/CLI는 무변경.

회귀: tests/codex-integration/gather-routed-models-single-flight.test.ts(CatalogGatherBusyError 직접 import), tests/providers/command-code-fakeip-discovery.test.ts(gatherRoutedModels/gatherRoutedModelsForCatalogGather 동적 import), tests/codex-integration/codex-gather-authority.test.ts, tests/codex-integration/catalog-retain-models.test.ts, tests/codex-integration/catalog-oauth-observation.test.ts, tests/oauth/state-store-sweeper.test.ts, tests/oauth/oauth-accounts-api.test.ts, tests/providers/provider-model-aliases.test.ts, tests/codex-integration/codex-catalog.test.ts, tests/codex-integration/codex-models-cache-invalidate.test.ts(retained-sync 경유), tests/claude-integration/claude-agents-inject.test.ts.

## 회귀 테스트 총표 (사이클 합본, hosted CI)

- tests/codex-integration/codex-catalog.test.ts
- tests/codex-integration/gather-routed-models-single-flight.test.ts
- tests/codex-integration/codex-gather-authority.test.ts
- tests/codex-integration/catalog-retain-models.test.ts
- tests/codex-integration/catalog-oauth-observation.test.ts
- tests/codex-integration/catalog-seed-window-fill.test.ts
- tests/codex-integration/catalog-hub-context-window.test.ts
- tests/codex-integration/catalog-input-modality-enum.test.ts
- tests/codex-integration/catalog-llamacpp-capabilities.test.ts
- tests/codex-integration/catalog-free-pricing-status.test.ts
- tests/codex-integration/catalog-zero-credit-picker.test.ts
- tests/codex-integration/codex-models-cache-invalidate.test.ts
- tests/codex-integration/codex-tool-mode.test.ts
- tests/providers/featherless-provider.test.ts
- tests/providers/provider-model-discovery-contract.test.ts
- tests/providers/orcarouter-provider.test.ts
- tests/providers/provider-model-aliases.test.ts
- tests/providers/qoder-live-models.test.ts
- tests/providers/devin-live-models.test.ts
- tests/providers/command-code-fakeip-discovery.test.ts
- tests/providers/github-copilot/github-copilot-wire-defaults.test.ts
- tests/routing/routing-capability-model-matching.test.ts
- tests/claude-integration/claude-agents-inject.test.ts
- tests/oauth/state-store-sweeper.test.ts
- tests/oauth/oauth-accounts-api.test.ts

로컬에서 이 목록을 실행하지 않는다. PR 본문에 NOT RUN을 적고 hosted exact-head만 증거로 쓴다.

## 검증

각 PR: /tmp/m3_verify.ts ALL CHECKS PASS(파싱, origin/dev 대비 facade export 표면, 상대 import 해석, tsc 필터) + hosted CI 녹색. bun install/build/test와 전체 스위트는 레인 정책상 금지이며 PR 본문에 NOT RUN으로 표기한다. 래칫(tests/ci-workflows/file-size-ratchet.test.ts)은 provider-fetch.ts 축소를 SHRANK로 통과시키고 신규 리프는 1,999줄 이하면 NEW_OK다 — 기준선 재시드는 000_plan.md대로 최종 병합 트리에서 한 번 한다.

## 수용 기준

- provider-fetch.ts와 리프 6개 전부 1,999줄 이하 (facade 목표 ~120)
- public export 38개가 이동 전과 동일 (facade, catalog.ts 포함)
- 모듈 상태 7종이 소유 리프 표대로 배치, 인자로 새는 상태 0, facade 복제 0
- 함정 6항 미발생, 결함 예방 5항 점검 통과
- 리프 간 import DAG 준수 — 어떤 리프도 provider-fetch/sync/retained-sync/build-entries를 import하지 않음
- 주석 오라클 2건이 새 경로를 가리키고, 본문 텍스트 오라클 0건 유지
- INV 승계 불요, structure 백틱 0곳, layout.json 등록 불요
- 로컬 스위트 NOT RUN, hosted CI exact-head 녹색

## 실행자가 복사할 이동 명령 (각 PR)

행 범위는 HEAD ce0ac617da의 provider-fetch.ts 2,944줄 기준 inclusive다. 앞 PR이 줄을 지웠으면 sed가 아니라 심볼 표가 권위다.

    PR1: sed -n '439,453p;678,936p;1269,1287p;1304,1567p' src/codex/catalog/provider-fetch.ts
    PR2: sed -n '521,538p;946,1190p' src/codex/catalog/provider-fetch.ts
    PR3: sed -n '1192,1267p;1289,1302p;2151,2266p' src/codex/catalog/provider-fetch.ts
    PR4: sed -n '108,118p;142,195p;235,242p;245,246p;263,671p' src/codex/catalog/provider-fetch.ts
    PR5: sed -n '137,140p;1575,1600p;1602,2149p' src/codex/catalog/provider-fetch.ts
    PR6: sed -n '120,135p;197,233p;244p;247,261p;674,676p;2268,2944p' src/codex/catalog/provider-fetch.ts
