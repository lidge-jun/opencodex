# 260914 godfile round2 — 사이클 3: inject.ts / catalog/sync.ts

inject.ts 2,342줄과 catalog/sync.ts 2,698줄이 2,000줄 래칫을 넘고, TOML 루트 키 불변식·서브에이전트 5칸 창·히스토리 인라인 호출·카탈로그 mtime 계약이 한 파일에 섞여 있다. 이 문서는 기술 의존 순서로 나눈 7개 PR의 원본 행 범위, 예상 줄 수, write set, 재수출, 오라클 패치, structure 동반 수정을 복붙 실행 가능하게 고정한다. 실행자는 이 순서대로만 옮기고, 소비자 import 경로는 facade가 유지하므로 바뀌지 않으며, 본문을 텍스트로 읽는 테스트와 structure 백틱만 새 소유 모듈을 가리키게 바뀐다.

기준 트리: 작업 디렉터리 `/Users/jun/.codex/worktrees/5880/opencodex`, 브랜치 `codex/m2k-l1-roadmap`, `origin/dev` `4f788f916e`. 열린 PR 충돌은 순서에서 제외한다. 로컬 install/typecheck/test는 하지 않는다. 검증은 hosted CI.

`000_plan.md`는 사이클 3 봉투 브랜치를 `codex/m2k-l4-inject-sync`(base L3) 하나로 그린다. 아래 7개 PR은 그 봉투의 실행 분할이다. PR1 base는 L3, PR7 head가 사이클 3 tip이며 사이클 4(`codex/m2k-l5-routing-quota`)는 PR7 head를 base로 한다. 부모 레인이 단일 L4 PR을 고집하면 7 커밋을 그 브랜치에 쌓고 PR은 하나만 연다. write set은 달라지지 않는다.

순수 이동. 동작 변경 금지. 원본 경로 facade 재수출 필수.

## 정정 (초안 대비, 이 트리에서 재계측)

정정: `inject/routing-target.ts` 초안 173–271 ~150줄은 실제 99줄이다. `standaloneCodexRoutingTarget`(216)가 `providerBaseHost`(272)를 호출하므로 173–271만 옮기면 컴파일되지 않는다. 범위는 173–288(116줄)로 확장한다.

정정: `inject/config-toml.ts` 초안 96–135+272–513+620–894 ~620줄은 실제 557줄이다. `providerBaseHost`를 routing-target로 넘기면 96–135+289–513+620–894 = 540줄이 원본이다. 새 파일은 import를 더해 예상 610–650줄.

정정: `inject/routing-classify.ts` 514–619는 106줄이다 (초안 ~110).

정정: `inject/restore.ts` 초안 1832–2342 ~510줄(실제 511)은 `formatApplyHistoryFailure`(2324–2342, apply 문구)와 `getCodexConfigPath`(2314–2316, facade 잔여)를 포함한다. restore 본체는 1832–2312 = 481줄. apply가 restore를 import하면 방향이 뒤집힌다.

정정: inject 잔여 초안 ~780은 실제 909줄이다 (1–95 import/재수출 + 136–172 `InjectCodexOptions` + 895–948 결과/훅 + 949–1671 impl). `injectCodexConfigImpl` 949–1671 = 723줄은 맞다.

정정: 소스 오라클 `codex-retained-root-serialization.test.ts` 본문 슬라이스는 323행이 아니라 324행이다. 323은 `readFileSync`, 324가 `source.slice("const owningCodexHome" … "// Design B")`. 첫 `const owningCodexHome`는 2048, 그 이후 첫 `// Design B`는 2273.

정정: inject structure 백틱은 7곳이 아니라 8참조/7파일이다. `config.md`가 75와 277 두 번 등장한다.

정정: sync 잔여 초안 461–1393 ~700줄은 실제 933줄이다.

정정: roster 91–259 = 169줄 (초안 ~175). derive-entry 260–460 = 201줄 (초안 ~200). auto-review 1596–2094 = 499줄 (초안 ~500). gated-native-warn 2095–2152 = 58줄 (초안 ~60). retained-sync 1394–1595+2153–2427+2476–2563 = 565줄 (초안 ~610). catalog restore 초안 2428–2475+2564–2698 ~190줄은 실제 183줄이며, 그 안에 `invalidateCodexModelsCache*`(2636–2698, 63줄)가 들어 있다. 이건 restore가 아니라 cache writer다. restore.ts는 2428–2475+2564–2635 = 120줄, invalidate는 retained-sync로 간다.

정정: `effort.ts:42` `deriveEntry` import는 호출 사이트가 0이다 (123행 주석만). 경로만 `./derive-entry`로 바꾸면 `effort ↔ derive-entry` 순환이 남는다. 호출이 없으므로 해당 import 줄을 삭제한다.

정정: retained-sync를 별 파일로 빼면서 build/merge(461–1393)를 `sync.ts`에 남기면 retained-sync가 `./sync`를 역참조해 순환한다. PR7에서 build/merge도 `catalog/build-entries.ts`로 같이 빼고 `sync.ts`는 facade만 남긴다. "build/merge는 마지막"은 앞 PR에서 빼지 말라는 뜻이지, 마지막 PR에서 순환을 만들라는 뜻이 아니다.

정정: `INLINE_ALLOWED`의 `codex/inject.ts`(37행)는 `syncCodexHistoryProvider` 호출이 2287(`restoreNativeCodex`)에만 있다. 이동 후 facade에는 호출이 없다. `codex/inject/restore.ts`를 넣고 `codex/inject.ts`는 뺀다.

## 현재 파일 해부

### src/codex/inject.ts 2,342줄 — NEW 디렉터리 src/codex/inject/

| 새 파일 | NEW/MODIFY | 원본 행 (inclusive) | 원본 줄 수 | 예상 줄 수 | 가져갈 심볼 |
|---|---|---|---:|---:|---|
| inject/routing-target.ts | NEW | 173-288 | 116 | 155 | CodexRoutingTarget, validateCodexRoutingTarget, usesProviderTable, standaloneCodexRoutingTarget, routingTargetOrigin, configuredManagedSubagentDefaults, providerBaseHost |
| inject/config-toml.ts | NEW | 96-135, 289-513, 620-894 | 540 | 630 | externalCodexModelProvider, currentExternalCodexModelProvider, dominantEol, applyEol, buildProviderTableBlock 오버로드, buildOpenaiBaseUrlLine 오버로드, buildRealtimeWsBaseUrlLine, setRootOpenaiBaseUrl 오버로드, setRootRealtimeWsBaseUrl, stripInjectedOpenaiBaseUrl, stripExistingModelProvider, stripRootContextWindowOverrides, stripRootRoutedModel, setRootModelProvider, readRootModelCatalogPath, setRootModelCatalogPath, removeProfileSection, normalizeServiceTier, ensureFastModeFeature, isOpencodexCatalogPath, stripOpencodexCatalogPath, buildProfileFile 오버로드, chooseCatalogPathForInjection |
| inject/routing-classify.ts | NEW | 514-619 | 106 | 145 | CodexRoutingKind, RoutingEndpointKind, ipv4Octets, classifyRoutingEndpoint, classifyCodexRouting, isCodexRoutingInjected, getCodexRoutingKind |
| inject/remove.ts | NEW | 1672-1831 | 160 | 210 | isOcxProviderHeaderLine, hasOcxProviderTable, removeOcxSection, StripOpencodexConfigResult, stripOpencodexConfigResult, stripOpencodexConfig, hasOpencodexRouting, removeCodexConfig |
| inject/restore.ts | NEW | 1832-2312 | 481 | 560 | restore 타입 4종, failedHistoryRestore*, externalProviderRestoreResult, foreignOwnershipRestoreRefusal, desiredEnabledRestoreSkip, skippedRestoreEnvelope, failedConfigRestoreEnvelope, restoreCodexConfigInline*, restoreCodexCatalogArtifact, restoreNativeCodexAsync*, restoreNativeCodex |
| inject.ts 잔여 | MODIFY | 1-95, 136-172, 895-1671, 2314-2342 | 909 + 재수출 ~40 | 960 | InjectCodexOptions, runClientWriteGuard, CodexInjectResult, historyArtifactStageForTests, beforeHistoryArtifactCommitForTests, injectCodexConfig, injectCodexConfigImpl (723줄, 쪼개지 않음), getCodexConfigPath, formatApplyHistoryFailure |

inject/ 는 src/codex/ 아래라 structure/manifest.json 신규 area가 아니다.

### src/codex/catalog/sync.ts 2,698줄 — 기존 디렉터리 src/codex/catalog/

| 새 파일 | NEW/MODIFY | 원본 행 (inclusive) | 원본 줄 수 | 예상 줄 수 | 가져갈 심볼 |
|---|---|---|---:|---:|---|
| catalog/subagent-roster.ts | NEW | 91-259 | 169 | 220 | MAX_SPAWN_AGENT_MODEL_OVERRIDES, PICKER_ORDER_PRIORITY_BASE, SPAWN_PRIORITY_FIELD, CATALOG_INACTIVE_REASON_FIELD, SpawnAgentSurface, SubagentRosterExclusion*, EffectiveSubagent*, isEligibleV2SubagentEntry, configuredCatalogEntry, configuredSubagentModelMatchesEntry, effectiveSubagentRoster |
| catalog/derive-entry.ts | NEW | 260-460 | 201 | 270 | finishUpstreamNativeEntry, isExactComboCatalogModel, isExactComboCatalogEntry, routedDisplayName, preservePinnedNativeCustomReasoning, deriveEntry |
| catalog/auto-review.ts | NEW | 1596-2094 | 499 | 560 | AUTO_REVIEW_ROOT_MARKER부터 finalizeAutoReviewModelOverride까지 스탬프/플랜/override 전부 |
| catalog/gated-native-warn.ts | NEW | 2095-2152 | 58 | 95 | gatedNativeReauthSuppressionReason, gatedNativeAccountLabel, warnedGatedNativeSuppression, resetGatedNativeSuppressionWarningsForTests, warnGatedNativeSuppressedOnce |
| catalog/retained-sync.ts | NEW | 1394-1595, 2153-2427, 2476-2563, 2636-2698 | 628 | 720 | retained read/revalidate/write, CodexCatalogSyncOptions, syncCatalogModels, invalidateCodexModelsCache* |
| catalog/restore.ts | NEW | 2428-2475, 2564-2635 | 120 | 170 | visibleAccountReplacementNatives, restoreAccountHiddenBareNatives, currentDisabledModelsForRestore, restoreCodexCatalogWithPermit, restoreCodexCatalog |
| catalog/build-entries.ts | NEW | 461-1393 | 933 | 1020 | ObservedCatalogEntryBuildInput, buildCatalogEntries*, resetCatalogRuntimeStateForTests, orderForSubagents, orderForModelPicker, merge/recovery 전부 |
| catalog/sync.ts facade | MODIFY | 1-90 정리 후 재수출만 | 90 -> ~80 | 80 | 모든 공개 심볼 재수출. 본문 함수 0 |
| catalog.ts 14줄 facade | 유지 | 변경 없음 | 14 | 14 | 계속 from "./catalog/sync" |
| catalog/effort.ts | MODIFY | 42행 1줄 삭제 | 560 -> 559 | 559 | unused deriveEntry import 삭제 |

## 상태 소유권 (인자로 새면 안 되는 것)

한 바인딩은 한 모듈. 테스트 훅 setter는 그 모듈에 두고 facade가 재수출한다. 자식 프로세스가 require("./src/codex/inject")로 setter를 잡는다 (codex-inject-integration.test.ts:174,217,269). facade 재수출이 빠지면 훅은 침묵한다.

| 바인딩 | 현재 행 | 소유 모듈 | facade 재수출 | 비고 |
|---|---|---|---|---|
| historyArtifactStageForTests | 924 | inject.ts 잔여 | setHistoryArtifactStageForTests | applyNativeArtifacts(1349)가 호출. impl과 같이 잔여 |
| beforeHistoryArtifactCommitForTests | 932 | inject.ts 잔여 | setBeforeHistoryArtifactCommitForTests | 같은 클로저 |
| beforeRestoreConfigForTests | 928 | inject/restore.ts | setBeforeRestoreConfigForTests | restoreCodexConfigInlineImpl:2002가 호출. setter도 restore.ts로 이동한 뒤 facade가 export { setBeforeRestoreConfigForTests } from "./inject/restore" |
| warnedGatedNativeSuppression | 2130 | catalog/gated-native-warn.ts | resetGatedNativeSuppressionWarningsForTests | resetCatalogRuntimeStateForTests가 이 Set을 지우지 않는다. 두 리셋 경로를 합치지 말 것. 현재 테스트 호출 사이트는 0이어도 public seam이므로 재수출 유지 |
| aggregation/provider-fetch/bundled/model-cache 리셋 집합 | 726 | catalog/build-entries.ts | resetCatalogRuntimeStateForTests | 타 모듈 상태를 모아서 지운다. gated-native Set은 여기 넣지 않음 |

인자로 새는 상태 금지: warnedGatedNativeSuppression을 함수 인자나 반환값으로 넘기지 않는다. permit(CatalogWritePermit)은 인자로 받는 것이 계약이다 (writeRetainedCatalogSync, restoreCodexCatalogWithPermit, invalidateCodexModelsCacheWithPermit). 추출 모듈 안에서 withCatalogWriteSerialization을 다시 호출해 permit을 재취득하지 않는다. invalidateCodexModelsCacheWithPermit:2639 주석이 말하는 재취득은 이미 있는 wrapper 동작이다. 새로 만들지 말 것.

read.catalog는 in-place 변형이다. writeRetainedCatalogSync:2274가 catalog[RESERVE_SOURCE_CATALOG_FIELD]를 쓰고, :2363이 catalog.models = mergeCatalogEntriesFromObservedState(...)를 대입한다. 이 catalog는 revalidateRetainedCatalogSync:1556이 JSON clone한 객체다. read/revalidate/write를 모듈로 쪼개면 clone 타이밍이 어긋나 디스크에 부분 merge가 커밋된다. 세 함수는 retained-sync.ts에 고정.

## 하지 말아야 할 분할

1. applyNativeArtifacts만 별 모듈 금지. 1349-1419 클로저가 자체 preImages(1352) + catch 보상(1389)을 갖고, 협조 경로 1491-1505가 그 바깥에서 다시 captureCodexPreImages/restoreCodexPreImages를 돈다. 함수만 빼면 이중 보상이 되거나, 바깥 보상이 안 잡힌 쓰기를 남긴다. 723줄 impl은 이 사이클에서 쪼개지 않는다.

2. removeCodexConfig를 restore에 흡수 금지. restoreCodexConfigInlineImpl:2034가 removeCodexConfig({ preserveProfile })를 호출하는 것은 의존이지 합병이 아니다. removeCodexConfig는 CLI/저널 테스트의 public API다. 흡수하면 journal-fallback과 명시적 remove가 한 envelope를 공유해 preserveProfile와 artifact 보고가 섞인다. remove.ts와 restore.ts는 두 파일. restore가 remove를 import한다.

3. writeRetainedCatalogSync를 빌드/커밋으로 분리 금지. :2400-2415가 바이트 동일 rewrite를 건너뛰어 mtime을 보존한다 (#857 app-server 신선도, #1407 이후 stale이면 모델 가이드가 침묵). 빌드와 커밋을 나누면 동일 바이트 판정이 빌드 쪽 복사본을 보거나, 커밋 쪽이 항상 write한다.

4. build/merge를 PR1-6에서 빼지 말 것. PR7에서 build-entries.ts와 retained-sync.ts를 형제로 같이 뺀다. retained-sync가 ./sync를 import하면 순환이다.

5. derive-entry.ts가 ./sync를 import하지 말 것. 절단점이다. roster 상수(SPAWN_PRIORITY_FIELD, CATALOG_INACTIVE_REASON_FIELD)는 ./subagent-roster에서 가져온다. effort 심볼은 ./effort에서 가져온다.

## INV 승계

- INV-TOML-01 structure/overview.md:86-88 -> 테스트 바인딩 tests/codex-integration/codex-inject.test.ts:1 유지. 실질 소스 승계 모듈은 src/codex/inject/config-toml.ts. 파일 첫 줄에 테스트와 같은 id 주석을 넣는다. 테스트 주석은 삭제하지 않는다.
- INV-AGENT-01 structure/overview.md:92-94 -> 테스트 바인딩 tests/codex-integration/catalog-full-picker-order.test.ts:1 유지. 실질 소스 승계 모듈은 src/codex/catalog/subagent-roster.ts (MAX_SPAWN_AGENT_MODEL_OVERRIDES와 effectiveSubagentRoster). 헤더 id 주석 이관, 테스트 주석 유지.

## 소스 오라클 (본문을 텍스트로 읽음 — 경로를 반드시 고침)

1. tests/codex-integration/codex-retained-root-serialization.test.ts:323-326
   - 지금: readFileSync(.../src/codex/inject.ts) 후 const owningCodexHome ~ // Design B 슬라이스가 withCatalogWriteSerialization(owningCodexHome와 restoreCodexCatalogWithPermit를 포함하는지 본다.
   - 이동 후 슬라이스 전체가 inject/restore.ts (restoreCodexCatalogArtifact:2048 ~ restoreNativeCodex:2273).
   - 패치: readFileSync 대상을 src/codex/inject/restore.ts로 바꾼다. concat 불필요.

2. tests/codex-integration/codex-inject-history-wording.test.ts:11,118-123
   - 지금: injectSource = readFileSync(src/codex/inject.ts).
   - 리터럴 6종: 118 changed: rawHistory.rows > 0 || rawHistory.files > 0 -> restore.ts (restoreNativeCodex:2297). 119 restored original provider metadata for ${migratedRows} manifest-backed thread(s) -> 잔여 impl 1597 (apply). 120 original providers preserved -> restore.ts 2228과 2301. 121 No backed-up resume-history metadata was pending; untracked routed history was left unchanged. -> restore.ts 2229과 2302. 122-123 not.toContain 두 금지어는 두 파일 모두.
   - 패치: const injectSource = readFileSync(repoPath("src/codex/inject.ts"), "utf8") + readFileSync(repoPath("src/codex/inject/restore.ts"), "utf8");
   - import 경로 failedHistoryRestoreFromOutcome, formatApplyHistoryFailure는 facade 유지.

3. tests/codex-integration/codex-history-reachability.test.ts:35-39
   - 지금 INLINE_ALLOWED에 codex/inject.ts.
   - 패치: codex/inject.ts를 빼고 codex/inject/restore.ts를 넣는다. 인라인 호출은 restoreNativeCodex:2287 한 곳.

4. tests/providers/xai/grok-writer-boundary.test.ts:26
   - 주석만. 전 src/ walk라 자식 모듈이 grokHome+config.toml+write를 동시에 가지지 않는 한 통과. 코드 변경 없음. 주석의 codex/inject.ts는 facade 설명으로 남겨도 된다.

추가 경로 주석 (기계 오라클은 아님, 행번호가 깨지므로 같은 PR에서 고친다):

- tests/routing/routing-capability-catalog.test.ts:44 sync.ts:321-322 -> derive-entry.ts의 deriveEntry 본문. 행번호를 새 파일 기준으로 고치거나 행번호를 삭제한다.
- tests/providers/cursor/cursor-display-names.test.ts:10 routedDisplayName (codex/catalog/sync.ts) -> codex/catalog/derive-entry.ts.

## structure 동반 수정 (같은 PR, 나중 정리 금지)

structure/AGENTS.md: "Changing an area obliges the same change to update every doc listed for it." src/codex/ 소유 문서는 INDEX 표 그대로다. 신규 top-level area 없음. manifest.json 수정 없음. bun run structure:index 불필요.

공개 API를 말하는 문장은 facade 경로를 유지한다. 소유 모듈이 바뀐 문장만 백틱을 갈아끼운다.

inject.ts를 가리키는 8참조/7파일 — 히스토리 writer 문단은 facade+restore를 함께 적는다. 문장 골격은 유지하고 경로만 다음으로 교체한다.

| 파일:줄 | 지금 백틱 | 변경 |
|---|---|---|
| structure/config.md:75 | src/codex/inject.ts writes one of two forms | 유지 (공개 inject 동작). 구현 소유를 쓰려면 inject.ts(impl) + inject/config-toml.ts(루트 키 배치)를 병기 |
| structure/config.md:277 | 히스토리 writer 문단 inject.ts | src/codex/inject.ts와 src/codex/inject/restore.ts 병기 |
| structure/runtime.md:371 | 동일 문단 | 동일 병기 |
| structure/catalog.md:325 | 동일 문단 | 동일 병기 |
| structure/subagents.md:346 | 동일 문단 | 동일 병기 |
| structure/gui-and-management-api.md:576 | 동일 문단 | 동일 병기 |
| structure/ops/docs-and-release.md:354 | 동일 문단 | 동일 병기 |
| structure/providers/openai-tiers.md:455 | 동일 문단 | 동일 병기 |

sync.ts 2곳 — 소유가 옮겨졌으므로 경로를 교체한다.

| 파일:줄 | 지금 | 변경 |
|---|---|---|
| structure/subagents.md:71 | MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5 (mirrored in src/codex/catalog/sync.ts) | src/codex/catalog/subagent-roster.ts (sync.ts facade 재수출) |
| structure/catalog.md:343 | src/codex/catalog/sync.ts resolves exact case-preserving provider/model reviewer selectors | src/codex/catalog/auto-review.ts (retained sync와 convergence.ts가 facade를 통해 호출) |

히스토리 writer 문단의 병기 문장 템플릿 (7파일에 동일 치환):

src/codex/history-provider.ts refuses external writes to paginated or migration-capable history. src/codex/inject.ts (apply impl) and src/codex/inject/restore.ts check affected rows and manifest-owned restore targets before and after config/profile/journal changes, including successful journal and fallback restores, and compensate detected migration. Failed config restore stops later catalog/history work and rolls back a coordinated remove transition.

## layout.json

새 테스트 파일 없음. scripts/test-layout/layout.json explicit와 tests/fixtures/test-layout-expected.json에 등록하지 않는다. 기존 오라클 파일은 도메인 유지.

## 공통 재수출 규칙

소비자는 계속 다음만 import한다.

- src/codex/inject
- src/codex/catalog/sync
- src/codex/catalog (14줄, sync 재수출 유지)

src/grok/inject.ts:5의 applyEol, dominantEol, providerBaseHost도 facade를 유지한다. 테스트 from "../../src/codex/inject" / require("./src/codex/inject") / require("./src/codex/inject.ts") 를 새 자식 경로로 바꾸지 않는다. 예외는 위에 적은 본문-슬라이스 오라클 세 파일뿐이다.

순환 금지 그래프:

inject/routing-target.ts -> loopback-target, config(subagentDefaultSyncEffective), types
inject/routing-classify.ts -> injected-marker, paths (inject.ts 금지)
inject/config-toml.ts -> routing-target, injected-marker, paths, context-compat (inject.ts 금지)
inject/remove.ts -> config-toml, injected-marker, journal, history-provider (restore 금지)
inject/restore.ts -> remove, config-toml, catalog/sync facade, journal, history-*
inject.ts 잔여 -> 위 전부 + apply impl

catalog/subagent-roster.ts -> parsing/metadata/account-models/slug-codec (sync 금지)
catalog/derive-entry.ts -> roster, effort, parsing, metadata, identity (sync 금지)
catalog/effort.ts -> deriveEntry import 삭제. sync/derive-entry 금지
catalog/auto-review.ts -> parsing, provider-validation (sync 금지)
catalog/gated-native-warn.ts -> entitlements, account-label (sync 금지)
catalog/build-entries.ts -> derive-entry, roster, effort, parsing, metadata, features (sync·retained-sync 금지)
catalog/retained-sync.ts -> build-entries, auto-review, gated-native-warn, derive-entry, catalog-writer (sync 금지)
catalog/restore.ts -> catalog-writer, parsing, metadata (sync·retained-sync 금지, permit은 인자)
catalog/sync.ts -> 위 모듈 re-export only
catalog.ts -> ./catalog/sync 유지

---

## PR 1 — inject routing-target

브랜치: codex/m2k-l4-01-inject-routing-target. base: L3 (codex/m2k-l3-state-shim). 제목: refactor(codex): extract inject routing-target leaf

Write set:

- NEW src/codex/inject/routing-target.ts (원본 173-288, 예상 155줄)
- MODIFY src/codex/inject.ts (해당 블록 삭제, 아래 재수출 추가)
- tests/structure 수정 없음 (공개 경로 불변)

원본에서 잘라 붙일 블록: export interface CodexRoutingTarget (173)부터 providerBaseHost 함수 닫는 중괄호 (288)까지. 바로 위 Design B 주석(128-134)은 InjectCodexOptions용이므로 잔여에 둔다.

routing-target.ts 상단 import (이 집합만):

    import { subagentDefaultSyncEffective } from "../../config";
    import type { OcxConfig } from "../../types";
    import { type ManagedSubagentDefaults } from "../subagent-defaults";
    import { effectiveLoopbackListenerPort, isLoopbackHostname, shouldInjectApiAuthHeader } from "../loopback-target";

configuredManagedSubagentDefaults는 이 범위에 들어 있으나 impl만 쓴다. 같이 옮기고 잔여가 import한다. transformManagedSubagentDefaults 값 import가 이 함수에 없으면 type-only로 둔다. 원본 247-271을 그대로 옮겨 컴파일되면 그 형태를 유지한다.

inject.ts에 추가할 public 재수출 (원본이 export하던 것만):

    export {
      standaloneCodexRoutingTarget,
      providerBaseHost,
      type CodexRoutingTarget,
    } from "./inject/routing-target";

잔여는 같은 모듈에서 validateCodexRoutingTarget, usesProviderTable, routingTargetOrigin, configuredManagedSubagentDefaults를 로컬 import한다. 이 넷은 원본 non-export 유지.

회귀: tests/codex-integration/codex-inject.test.ts (standalone byte-compat 26행부터). tests/server/loopback-companion-client-targets.test.ts. hosted CI. 로컬 NOT RUN.

완료 조건: wc -l src/codex/inject.ts < 2342, 새 파일 < 1999, from "./inject/routing-target" 외 새 공개 경로 0.

---

## PR 2 — inject config-toml + routing-classify

브랜치: codex/m2k-l4-02-inject-toml-classify. base: PR1. 제목: refactor(codex): extract inject TOML transforms and routing classify

기술 의존: config-toml이 PR1의 CodexRoutingTarget / providerBaseHost / validateCodexRoutingTarget / usesProviderTable / routingTargetOrigin을 import한다. classify는 PR1과 독립이나 같은 PR에 묶어 래칫에 새 파일을 통과시킨다.

Write set:

- NEW src/codex/inject/config-toml.ts (원본 96-135 + 289-513 + 620-894, 원본 540줄, 예상 630)
- NEW src/codex/inject/routing-classify.ts (원본 514-619, 원본 106줄, 예상 145)
- MODIFY src/codex/inject.ts
- MODIFY src/codex/inject/config-toml.ts 헤더에 INV-TOML-01 주석 (NEW 파일의 첫 줄)
- MODIFY structure/config.md:75 — 루트 키 배치 소유를 inject/config-toml.ts로 병기
- 테스트 파일 수정 없음 (INV 테스트 바인딩 유지)

config-toml.ts 첫 줄:

    // Holds INV-TOML-01 from structure/overview.md; keep the id here if this file is split or renamed.

세 원본 조각을 이 순서로 붙인다: 96-135 (provider/EOL) -> 289-513 (table/base_url) -> 620-894 (root keys/profile/catalog path). 조각 사이에 빈 줄 하나. 함수 본문 바이트 불변.

classify는 514-619를 그대로. import는 injected-marker, paths, node:fs만. inject.ts 금지.

inject.ts 재수출에 추가할 public 이름 (원본 export만):

    export {
      externalCodexModelProvider,
      currentExternalCodexModelProvider,
      dominantEol,
      applyEol,
      buildProviderTableBlock,
      buildOpenaiBaseUrlLine,
      buildRealtimeWsBaseUrlLine,
      setRootOpenaiBaseUrl,
      setRootRealtimeWsBaseUrl,
      stripInjectedOpenaiBaseUrl,
      stripRootContextWindowOverrides,
      buildProfileFile,
      chooseCatalogPathForInjection,
    } from "./inject/config-toml";
    export {
      classifyCodexRouting,
      isCodexRoutingInjected,
      getCodexRoutingKind,
      type CodexRoutingKind,
    } from "./inject/routing-classify";

오버로드 시그니처(buildProviderTableBlock 289-315, buildOpenaiBaseUrlLine 342-355, setRootOpenaiBaseUrl 380-427, buildProfileFile 821-845)를 빠짐없이 옮긴다. 구현 함수(*ForTarget)는 non-export 유지.

회귀: tests/codex-integration/codex-inject.test.ts 전체 (INV-TOML-01). tests/service/autostart-health.test.ts (classifyCodexRouting). tests/server/loopback-listener-admission.test.ts (buildProviderTableBlock).

함정: setRootOpenaiBaseUrl는 루트 키를 첫 테이블 앞에 넣는다. 이 함수가 INV-TOML-01의 실체다. 프로파일 섹션 append로 바꾸지 말 것.

---

## PR 3 — inject remove

브랜치: codex/m2k-l4-03-inject-remove. base: PR2. 제목: refactor(codex): extract inject remove/strip primitives

Write set:

- NEW src/codex/inject/remove.ts (원본 1672-1831, 160줄, 예상 210)
- MODIFY src/codex/inject.ts

remove.ts가 config-toml에서 import할 심볼: dominantEol, applyEol, stripInjectedOpenaiBaseUrl, removeProfileSection, stripRootRoutedModel, stripOpencodexCatalogPath. stripOpencodexConfigResult가 추가로 쓰는 것은 transformManagedSubagentDefaults + journal/marker.

재수출:

    export { stripOpencodexConfig, removeCodexConfig } from "./inject/remove";

회귀: tests/codex-integration/codex-inject.test.ts (stripOpencodexConfig). tests/codex-integration/codex-journal.test.ts (removeCodexConfig require). tests/codex-integration/codex-inject-integration.test.ts remove 분기.

함정: remove를 이 PR에서 restore와 합치지 않는다. restore는 다음 PR.

---

## PR 4 — inject restore

브랜치: codex/m2k-l4-04-inject-restore. base: PR3. 제목: refactor(codex): extract inject native restore

Write set:

- NEW src/codex/inject/restore.ts (원본 1832-2312, 481줄, 예상 560)
- MODIFY src/codex/inject.ts — restore 블록 삭제, 훅 beforeRestoreConfigForTests 이동, formatApplyHistoryFailure(2324-2342)와 getCodexConfigPath(2314-2316) 잔여 유지
- MODIFY tests/codex-integration/codex-retained-root-serialization.test.ts:323-326 경로를 src/codex/inject/restore.ts
- MODIFY tests/codex-integration/codex-inject-history-wording.test.ts:11 concat
- MODIFY tests/codex-integration/codex-history-reachability.test.ts:35-39 INLINE_ALLOWED
- MODIFY structure 히스토리 문단 7파일 병기 (config.md:277, runtime.md:371, catalog.md:325, subagents.md:346, gui-and-management-api.md:576, ops/docs-and-release.md:354, providers/openai-tiers.md:455)

beforeRestoreConfigForTests let + setter(928-930)를 restore.ts로 옮긴다. 잔여의 924-926, 932-934 훅 두 개는 impl과 함께 남는다. facade:

    export {
      failedHistoryRestoreFromOutcome,
      skippedRestoreEnvelope,
      restoreNativeCodexAsync,
      restoreNativeCodex,
      setBeforeRestoreConfigForTests,
      type CodexRestoreArtifactState,
      type CodexRestoreConfigResult,
      type CodexRestoreCatalogResult,
      type CodexRestoreHistoryResult,
      type CodexNativeRestoreResult,
    } from "./inject/restore";

restore.ts는 removeCodexConfig를 ./remove에서, currentExternalCodexModelProvider를 ./config-toml에서, restoreCodexCatalogWithPermit를 ../catalog/sync에서 가져온다. 아직 catalog restore 추출 전이다. facade 경로는 이후 PR7에서도 유지.

오라클 패치 원문.

codex-retained-root-serialization.test.ts:323 부근을 다음으로 교체한다:

    const source = readFileSync(join(repoRoot, "src/codex/inject/restore.ts"), "utf8");
    const restoreRoot = source.slice(source.indexOf("const owningCodexHome"), source.indexOf("// Design B", source.indexOf("const owningCodexHome")));
    expect(restoreRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(restoreRoot).toContain("restoreCodexCatalogWithPermit");

슬라이스 문자열이 파일에 그대로 있는지는 이동 후 확인한다. 2048-2273이 한 파일에 남아 있어야 한다.

codex-inject-history-wording.test.ts:11:

    const injectSource =
      readFileSync(repoPath("src/codex/inject.ts"), "utf8") +
      readFileSync(repoPath("src/codex/inject/restore.ts"), "utf8");

codex-history-reachability.test.ts:35-39:

    const INLINE_ALLOWED = new Set([
      "codex/history-provider.ts",
      "codex/inject/restore.ts",
      "codex/internal/history-writer.ts",
    ]);

회귀: 위 오라클 3파일 + codex-inject-integration.test.ts (require setter) + codex-journal.test.ts restore + codex-restore-app-rewrite.test.ts.

이 PR 후 wc -l src/codex/inject.ts 목표는 잔여 909 + 재수출 ≈ 960 < 1999. 자식 5파일 모두 < 1999.

---

## PR 5 — catalog roster + derive-entry (순환 절단)

브랜치: codex/m2k-l4-05-catalog-roster-derive. base: PR4. 제목: refactor(catalog): extract subagent roster and deriveEntry

roster를 같은 PR에서 먼저 붙인다. derive-entry가 SPAWN_PRIORITY_FIELD, CATALOG_INACTIVE_REASON_FIELD를 roster에서 가져간다.

Write set:

- NEW src/codex/catalog/subagent-roster.ts (91-259, 169줄, 예상 220). 첫 줄 INV-AGENT-01 주석
- NEW src/codex/catalog/derive-entry.ts (260-460, 201줄, 예상 270)
- MODIFY src/codex/catalog/sync.ts — 해당 블록 삭제, 재수출 추가
- MODIFY src/codex/catalog/effort.ts:42 — import { deriveEntry } from "./sync"; 줄 삭제. 123행 주석은 문구 유지
- MODIFY structure/subagents.md:71 경로를 src/codex/catalog/subagent-roster.ts
- MODIFY tests/routing/routing-capability-catalog.test.ts:44 행번호 주석
- MODIFY tests/providers/cursor/cursor-display-names.test.ts:10 모듈 경로

catalog.ts:11-13은 그대로 from "./catalog/sync". sync facade가 roster/derive를 재수출하면 된다.

subagent-roster.ts 첫 줄:

    // Holds INV-AGENT-01 from structure/overview.md; keep the id here if this file is split or renamed.

sync.ts 재수출:

    export {
      MAX_SPAWN_AGENT_MODEL_OVERRIDES,
      PICKER_ORDER_PRIORITY_BASE,
      SPAWN_PRIORITY_FIELD,
      CATALOG_INACTIVE_REASON_FIELD,
      isEligibleV2SubagentEntry,
      configuredCatalogEntry,
      effectiveSubagentRoster,
      type SpawnAgentSurface,
      type SubagentRosterExclusionReason,
      type EffectiveSubagentModel,
      type SubagentRosterExclusion,
      type EffectiveSubagentRoster,
    } from "./subagent-roster";
    export {
      finishUpstreamNativeEntry,
      isExactComboCatalogModel,
      deriveEntry,
    } from "./derive-entry";

잔여 sync(아직 build/merge가 여기 있음)는 deriveEntry와 roster 상수를 새 파일에서 import한다. 이 시점의 그래프는 sync -> derive-entry -> effort, sync -> roster, effort는 sync를 보지 않음. 순환 없음.

derive-entry.ts가 가져야 할 import (원본 deriveEntry 본문이 실제로 쓰는 것만, 원본 1-90에서 복사 후 미사용은 삭제):

- ./parsing (applyCatalogMetadata, applyRoutedCodexToolMode, ensureStrictCatalogFields, normalizeServiceTiers, normalizeRoutedCatalogEntry, types)
- ./metadata (applyNativeOpenAiContextOverride, hasNativeOpenAiCapabilityMetadata, upstreamNativeEntry, CODEX_CUSTOM_MODEL_CATALOG_KIND)
- ./effort (applyReasoningLevels, applyCatalogModelMetadata, isGpt56NativeSlug, ensureGpt56ReasoningLevels, ensureUltraReasoningLevel)
- ./subagent-roster (SPAWN_PRIORITY_FIELD, CATALOG_INACTIVE_REASON_FIELD)
- ../../adapters/identity (identifyRoutedModel)
- ../../providers/default-aliases (effectiveProviderAlias) — routedDisplayName용
- ../../combos (COMBO_NAMESPACE)
- types CatalogModel, RawEntry, OcxConfig, NativeContextLimitsInput

회귀: tests/codex-integration/catalog-full-picker-order.test.ts (INV-AGENT-01, deriveEntry import는 계속 catalog/sync). catalog-go-exact-efforts.test.ts. catalog-zero-credit-picker.test.ts. catalog-free-pricing-status.test.ts. codex-catalog.test.ts 중 derive/roster 구간.

함정: catalog.ts가 derive-entry를 직접 가리키게 바꾸지 말 것. 이중 facade 계약은 catalog.ts + sync.ts 둘 다 재수출.

---

## PR 6 — auto-review + gated-native-warn

브랜치: codex/m2k-l4-06-catalog-review-warn. base: PR5. 제목: refactor(catalog): extract auto-review override and gated-native warn-once

Write set:

- NEW src/codex/catalog/auto-review.ts (1596-2094, 499줄, 예상 560)
- NEW src/codex/catalog/gated-native-warn.ts (2095-2152, 58줄, 예상 95)
- MODIFY src/codex/catalog/sync.ts
- MODIFY structure/catalog.md:343 경로를 src/codex/catalog/auto-review.ts

상태: warnedGatedNativeSuppression Set은 gated-native-warn 소유. resetGatedNativeSuppressionWarningsForTests도 그 파일. sync 잔여의 resetCatalogRuntimeStateForTests에 .clear()를 추가하지 않는다.

이 시점에 writeRetainedCatalogSync는 아직 sync.ts에 있다. 잔여가 finalizeAutoReviewModelOverride와 warnGatedNativeSuppressedOnce / gatedNativeReauthSuppressionReason / gatedNativeAccountLabel를 새 파일에서 import한다.

재수출 (sync + 따라서 catalog.ts 경유 가능):

    export {
      isValidAutoReviewModel,
      applyAutoReviewModelOverride,
      applyConfiguredAutoReviewModelOverride,
      finalizeAutoReviewModelOverride,
      type AutoReviewModelOverrideResult,
    } from "./auto-review";
    export {
      gatedNativeReauthSuppressionReason,
      resetGatedNativeSuppressionWarningsForTests,
    } from "./gated-native-warn";

회귀: tests/codex-integration/codex-catalog.test.ts auto-review require 구간 7260-7332. tests/codex-integration/catalog-gated-native-suppression-reason.test.ts (import는 catalog/sync 유지). convergence.ts는 facade 유지.

함정: isValidAutoReviewModel는 sync.ts:1616이 provider-validation 심볼을 감싼 re-export다. 이 래퍼를 auto-review로 옮기고 sync가 다시 재수출한다. config/provider-validation.ts:258 원본을 삭제하지 말 것.

---

## PR 7 — retained-sync + catalog restore + build-entries (마지막, 순환 절단)

브랜치: codex/m2k-l4-07-catalog-retained-restore (000_plan.md의 codex/m2k-l4-inject-sync tip). base: PR6. 제목: refactor(catalog): extract retained sync, restore, and build-entries

이 PR이 build/merge를 마지막으로 뺀다. 세 파일을 한 커밋에  twin으로 만들어 sync.ts를 facade로 남긴다. 나눠서 올리면 중간 커밋이 retained-sync -> sync -> retained-sync 순환을 갖는다.

Write set:

- NEW src/codex/catalog/build-entries.ts (461-1393, 933줄, 예상 1020)
- NEW src/codex/catalog/retained-sync.ts (1394-1595 + 2153-2427 + 2476-2563 + 2636-2698, 628줄, 예상 720)
- NEW src/codex/catalog/restore.ts (2428-2475 + 2564-2635, 120줄, 예상 170)
- MODIFY src/codex/catalog/sync.ts — 본문 함수 전부 제거, 1-90 import를 재수출 블록으로 교체. 목표 <= 80줄
- catalog.ts 변경 없음

retained-sync.ts 조각 순서: 1394-1595 (read/revalidate/evidence) -> 2153-2427 (writeRetainedCatalogSync, mtime 가드 포함) -> 2476-2563 (syncCatalogModels) -> 2636-2698 (invalidate cache). 한 모듈.

restore.ts 조각 순서: 2428-2475 (visibility helpers) -> 2564-2635 (restoreCodexCatalogWithPermit, restoreCodexCatalog).

writeRetainedCatalogSync 통째 이동. 2400-2415 mtime 주석과 onDiskBytes.equals 분기를 분리하지 말 것. catalog.models = in-place 대입(2363)과 reserve 필드 변이(2274)도 같은 함수 안에 둔다.

permit: writeRetainedCatalogSync와 invalidateCodexModelsCacheWithPermit와 restoreCodexCatalogWithPermit는 받은 permit만 replaceActiveCodexCatalog / replaceCodexModelsCache에 넘긴다. 모듈 내부에서 withCatalogWriteSerialization을 여는 것은 기존 wrapper (syncCatalogModels:2523, restoreCodexCatalog:2626, invalidateCodexModelsCache:2691)만. 그 wrapper는 각자 원래 있던 파일로 따라간다 — syncCatalogModels/invalidate는 retained-sync, restoreCodexCatalog는 restore.ts.

sync.ts facade 최종 형태 (원본 public export와 1:1인지 추출 직후 rg '^export ' src/codex/catalog/sync.ts로 대조):

    export {
      MAX_SPAWN_AGENT_MODEL_OVERRIDES,
      PICKER_ORDER_PRIORITY_BASE,
      SPAWN_PRIORITY_FIELD,
      CATALOG_INACTIVE_REASON_FIELD,
      isEligibleV2SubagentEntry,
      configuredCatalogEntry,
      effectiveSubagentRoster,
    } from "./subagent-roster";
    export type {
      SpawnAgentSurface,
      SubagentRosterExclusionReason,
      EffectiveSubagentModel,
      SubagentRosterExclusion,
      EffectiveSubagentRoster,
    } from "./subagent-roster";
    export { finishUpstreamNativeEntry, isExactComboCatalogModel, deriveEntry } from "./derive-entry";
    export {
      buildCatalogEntries,
      buildCatalogEntriesFromObservedState,
      resetCatalogRuntimeStateForTests,
      orderForSubagents,
      orderForModelPicker,
      mergeCatalogModelsWithNativeRecovery,
      applyFullModelPickerOrder,
      mergeCatalogEntriesFromObservedState,
      mergeCatalogEntriesForSync,
      CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
    } from "./build-entries";
    export type { ObservedCatalogEntryBuildInput, ObservedCatalogMergeInput, ObservedCatalogMergePolicy } from "./build-entries";
    export {
      isValidAutoReviewModel,
      applyAutoReviewModelOverride,
      applyConfiguredAutoReviewModelOverride,
      finalizeAutoReviewModelOverride,
    } from "./auto-review";
    export type { AutoReviewModelOverrideResult } from "./auto-review";
    export {
      gatedNativeReauthSuppressionReason,
      resetGatedNativeSuppressionWarningsForTests,
    } from "./gated-native-warn";
    export {
      syncCatalogModels,
      invalidateCodexModelsCache,
      invalidateCodexModelsCacheWithPermit,
    } from "./retained-sync";
    export type { CodexCatalogSyncOptions } from "./retained-sync";
    export { restoreCodexCatalog, restoreCodexCatalogWithPermit } from "./restore";

빠지면 catalog.ts와 convergence/remote/inject가 깨진다. 특히 invalidateCodexModelsCacheWithPermit (catalog/remote.ts:10), mergeCatalogModelsWithNativeRecovery (convergence.ts), buildCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, applyFullModelPickerOrder, SPAWN_PRIORITY_FIELD.

회귀:

- tests/codex-integration/codex-retained-root-serialization.test.ts (syncCatalogModels dynamic import 경로 ./src/codex/catalog/sync.ts 유지)
- tests/codex-integration/codex-models-cache-invalidate.test.ts
- tests/codex-integration/catalog-full-picker-order.test.ts
- tests/codex-integration/codex-catalog.test.ts
- tests/codex-integration/catalog-gated-native-suppression-reason.test.ts
- tests/codex-integration/reserve-catalog.test.ts
- tests/codex-integration/multi-agent-keep-native-v1.test.ts
- inject 쪽 restoreCodexCatalogWithPermit 경로 (facade) — PR4 오라클이 여전히 그린인지

완료 줄 수 목표:

| 파일 | 상한 |
|---|---|
| src/codex/inject.ts | 1999 (목표 ~960) |
| src/codex/inject/*.ts 각 | 1999 |
| src/codex/catalog/sync.ts | 1999 (목표 ~80) |
| src/codex/catalog/{subagent-roster,derive-entry,auto-review,gated-native-warn,build-entries,retained-sync,restore}.ts 각 | 1999 |
| 새 파일 전부 | 1999 |
| 래칫 기준선 | 이 사이클 D에서 회수. 증가 0 |

## 회귀 테스트 총표 (사이클 합본, hosted CI)

inject:

- tests/codex-integration/codex-inject.test.ts
- tests/codex-integration/codex-inject-integration.test.ts
- tests/codex-integration/codex-inject-history-wording.test.ts
- tests/codex-integration/codex-inject-write-lock.test.ts
- tests/codex-integration/codex-journal.test.ts
- tests/codex-integration/codex-restore-app-rewrite.test.ts
- tests/codex-integration/codex-retained-root-serialization.test.ts
- tests/codex-integration/codex-history-reachability.test.ts
- tests/codex-integration/codex-history-job.test.ts
- tests/codex-integration/client-injection-guard.test.ts
- tests/providers/xai/grok-writer-boundary.test.ts
- tests/service/autostart-health.test.ts
- tests/server/loopback-listener-admission.test.ts
- tests/server/loopback-companion-client-targets.test.ts

catalog:

- tests/codex-integration/catalog-full-picker-order.test.ts
- tests/codex-integration/catalog-go-exact-efforts.test.ts
- tests/codex-integration/catalog-zero-credit-picker.test.ts
- tests/codex-integration/catalog-free-pricing-status.test.ts
- tests/codex-integration/catalog-gated-native-suppression-reason.test.ts
- tests/codex-integration/codex-catalog.test.ts
- tests/codex-integration/codex-catalog-model-picker-order.test.ts
- tests/codex-integration/codex-models-cache-invalidate.test.ts
- tests/codex-integration/multi-agent-keep-native-v1.test.ts
- tests/codex-integration/reserve-catalog.test.ts
- tests/codex-integration/native-alias-maintainer-regressions.test.ts
- tests/codex-integration/codex-v2-gate.test.ts
- tests/providers/provider-model-aliases.test.ts

로컬에서 이 목록을 실행하지 않는다. PR 본문에 NOT RUN을 적고 hosted exact-head만 증거로 쓴다.

## 실행 순서 (기술 의존만)

1. routing-target (leaf, providerBaseHost 포함)
2. config-toml + classify (toml이 1에 의존)
3. remove (toml EOL/strip에 의존)
4. inject restore (remove에 의존, catalog restore는 아직 sync facade)
5. roster + derive-entry + effort import 삭제 (순환 절단). roster가 derive보다 앞선다
6. auto-review + gated-native-warn (상태 이전, write 경로보다 앞)
7. build-entries + retained-sync + catalog restore 동시 (mtime/in-place/permit 계약, sync facade화)

PR 사이에 동작 커밋을 끼우지 않는다. 래칫이 사이클 1에 있으면 각 PR의 새 파일은 2,000줄 미만이어야 통과한다. 예상 최장 새 파일은 build-entries.ts ~1020, retained-sync.ts ~720, config-toml.ts ~630, auto-review.ts ~560, inject/restore.ts ~560.

## 수용 기준

- inject.ts와 catalog/sync.ts 각각 1,999줄 이하, 새 모듈 전부 1,999줄 이하
- public export 집합이 이동 전과 동일 (inject facade, sync facade, catalog.ts)
- 모듈 상태 싱글톤 분기 0. gated-native Set과 history 훅 3개가 표의 소유 모듈에만 있다
- 함정 5항 미발생
- INV 헤더 주석이 승계 모듈에 있고 테스트 바인딩 파일이 남아 있다
- 오라클 3파일이 새 본문 경로를 읽는다
- structure 8+2 백틱이 위 표대로다
- layout.json 등록 없음
- 로컬 스위트 NOT RUN, hosted CI exact-head 녹색 (레인 정책은 000_plan.md)

## 실행자가 복사할 이동 명령 (각 PR C)

행 범위는 이 문서 작성 시점의 inject.ts 2342 / sync.ts 2698 기준 inclusive다. 앞 PR이 줄을 지우면 이후 PR은 심볼 이름으로 잘라라. sed 행번호는 PR1에만 안전하다.

PR1 (inject.ts 그대로일 때):

    mkdir -p src/codex/inject
    sed -n '173,288p' src/codex/inject.ts

PR2:

    sed -n '96,135p;289,513p;620,894p' src/codex/inject.ts
    sed -n '514,619p' src/codex/inject.ts

PR3:

    sed -n '1672,1831p' src/codex/inject.ts

PR4:

    sed -n '1832,2312p' src/codex/inject.ts
    sed -n '928,930p' src/codex/inject.ts

PR5:

    sed -n '91,259p' src/codex/catalog/sync.ts
    sed -n '260,460p' src/codex/catalog/sync.ts

PR6:

    sed -n '1596,2094p' src/codex/catalog/sync.ts
    sed -n '2095,2152p' src/codex/catalog/sync.ts

PR7:

    sed -n '461,1393p' src/codex/catalog/sync.ts
    sed -n '1394,1595p;2153,2427p;2476,2563p;2636,2698p' src/codex/catalog/sync.ts
    sed -n '2428,2475p;2564,2635p' src/codex/catalog/sync.ts

앞 PR이 이미 줄을 지웠으면 위 sed는 틀린 범위를 자른다. 그때는 이 문서의 심볼 표(함수/타입 이름)가 권위다.

