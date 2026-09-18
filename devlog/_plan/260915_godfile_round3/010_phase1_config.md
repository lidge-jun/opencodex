# 010 — src/config.ts 파사드 분해 (260914 050 대체 최신판)

src/config.ts 4,799줄(기준 트리 ce0ac617da)이 스키마·로드 열화·salvage·잠금·치환 쓰기·라이브 재결합을 한 파일에 들고 있어 래칫 이후에도 2,000줄을 넘긴다. 이 문서는 `devlog/_plan/260914_godfile_round2/050_phase5_config.md`를 대체하는 복붙 가능한 이동 계약이다. 그 라운드가 dev에서 이 파일에 +92줄(#4546/#4624 credentialGroups)을 더했으므로 모든 원본 행 번호를 이 트리에서 다시 잡았다. 구현자는 아래 원본 행을 새 리프로 옮기고 파사드가 기존 export 이름을 그대로 다시보내며, 소비자는 import 경로를 건드리지 않는다. create-only 경로 initializePersistedConfigIfMissing와 치환 경로 saveConfig는 공용 헬퍼로 합치지 않고 잔여 파사드에 함께 남기고, 경고 메모 세 값은 warn-memo 단일 소유 모듈로 먼저 분리하며, configSchema는 키 그룹으로 쪼개지 않는다. PR 순서는 실제 의존(salvage→schema, diagnostics→salvage/load-degrade, live-reconcile→persist)을 따라 warn-memo·독립 잎 → schema → salvage+load-degrade → mutation-lock+persist-unlocked+diagnostics → live-reconcile로 고정했다.

> 전달 형태 정정: 이 문서가 적은 브랜치 이름과 PR 개수는 실행되지 않았다. 다섯 파일이 한 워킹트리에서 동시에 작업돼 두 개의 PR로 수렴했다. 이동 계약과 함정 항목은 그대로 실행됐다. 실제 전달은 [090_outcome.md](./090_outcome.md) 를 보라.


브랜치 `codex/m3-l6-config`, base는 라운드3 체인의 직전 링크(라운드3 000_plan 확정 시 따름). 순수 이동, 동작 변경 없음. 로컬 스위트·typecheck·build는 이 단위 금지(hosted CI). 새 테스트 파일을 만들지 않으므로 layout.json과 test-layout-expected.json은 등록하지 않는다. 기준 트리 ce0ac617da(origin/dev ce0ac617da), 파일 4,799줄 실측. 열린 PR 충돌은 순서에서 제외한다.

## 260914 050 대비 재계측 (dev +92줄의 정체)

+92줄은 전부 credentialGroups이고 네 기존 블록 안에 들어왔다. 블록 경계는 이동하지 않았고 시프트와 국소 추가만 있다.

| 블록 | 050 원본 | 이 트리 실측 | 비고 |
|---|---|---|---|
| 헤더 | 1-176 | 1-177 | :63 `credentialGroupIssues` import 신규 |
| openai-tier-backup | 177-439 | 178-440 | |
| warn-memo | 440-450 | 441-452 | 본체 12줄(빈 줄 444 포함) |
| leaf-validators | 452-1247 | 454-1241(712-729 제외, 본체 770) | 711-732 재수출 → 712-729(18줄). 신규 credentialGroups 블록 1205-1241 |
| configSchema | 1248-1822 | 1286-1865(580) | pool.credentialGroups 필드 1430-1435 신규. 후단 superRefine 1468 |
| load-degrade | 1823-2578+2703-2775 | 1867-2646+2774-2846 | 신규 degrade 경고 2194-2218 |
| loadConfig | 2579-2701 | 2647-2773 | 신규 warn 호출 2687·2731·2760. 수리 병합 2631-2644 → 2699-2705(핀 2702-2704) |
| diagnostics | 2777-3399 | 2848-3491 | 신규 poolCredentialGroupsError 3121-3141, validate 호출 3342 |
| mutation-lock | 3400-3626 | 3492-3712 | persist 주석 3618-3626 → 3714-3719(6줄) |
| persistConfigUnlocked | 3628-3664 | 3720-3756 | |
| init/save/mutate | 3666-3810 | 3758-3902 | |
| failClosedClientPersistenceError | 3811-3834 | 3903-3926 | |
| feature-flags | 3836-3890 | 3928-3980 | |
| live-reconcile | 3892-3904+3906-4154+4174-4291 | 3982-3991+3993-4246+4262-4383 | 배너 주석 3982-3991 |
| readRawConfigJson | 4156-4172 | 4247-4260 | 주석 4247 포함 |
| proxy-env | 4293-4472 | 4385-4564 | |
| salvage | 4473-4707 | 4565-4799 | salvageConfigCandidate의 configSchema.safeParse는 4702 단일 호출(050의 4588/4612 2회 기술은 이 트리에서 1회로 재확인) |

추가 정정: structure/providers/openai-tiers.md의 classify 인용은 :326이 아니라 **:346**이다. mergeConfigDefaults 핀은 2929-2945(핀 2937-2939), warnInheritedFastWireConflicts는 2630-2638(has/add 2632-2633), warnConfigRepaired는 4565(has/add 4566-4567), warnDroppedConfigSections는 4765(4766-4767), warnAndBackupInvalidConfig는 4777(4778-4779)이다. configSchema.safeParse 전수 위치는 2666·2710(loadConfig), 3355(validateConfigCandidate), 3375·3381(configDiagnosticsFromRaw), 4702(salvageConfigCandidate) 6곳이다. src/config.ts를 import하는 테스트는 176곳이 아니라 rg 실측 200곳이다.

## create-only 경계 (최우선 보존)

structure/config.md:14-23 현행:

> `initializePersistedConfigIfMissing` in `src/config.ts` is the create-only path consumed by
> `src/cli/init.ts`. It rechecks absence under the existing config-mutation lock and publishes through
> `src/config/initialize.ts`: a private descriptor is hardened before secret bytes are written, then
> linked without replacing an occupied destination. Existing invalid or unsafe entries are preserved.
> The initializer never truncates a staged inode or rolls back by unlinking the destination; cleanup
> only removes its own temporary name. Unsupported/denied links and incomplete cleanup fail explicitly,
> and publication followed by a later failure can leave a complete config or private residue. Ordinary
> `saveConfig` replacement behavior remains unchanged. This protects init-time config bytes, not a
> foreign winner's ownership under future uninstall; the existing ownership manifest and global CLI
> shim preflight keep their separate contracts.

코드 재확인. initializePersistedConfigIfMissing(3761-3794)는 withConfigMutationLockSync 안에서 observeInitialConfigState()를 재확인한 뒤 publishInitialConfigNoReplace(getConfigPath(), JSON.stringify(...) + "\n", io)만 호출한다(3783). atomicWriteFile을 쓰지 않는다. saveConfig(3797-3813)는 withConfigMutationLockSync → persistConfigUnlocked(3720-3756) → 변경 시에만 atomicWriteFile(3751). persistConfigUnlocked 주석(3714-3719)은 잠금 비보유를 계약으로 못 박는다.

금지: writeConfigBytes(mode). 두 공개 함수는 잔여 src/config.ts에 남긴다. 파사드 상단 import를 빈 줄로 나눠 create-only는 ./config/initialize만, replace는 ./config/persist-unlocked만 보게 한다.

## 직전 라운드 CI가 잡은 결함 — 예방 항목

260914 라운드에서 hosted CI가 실제로 잡은 5종이다. 각 PR마다 아래를 점검하고, 하나라도 발생하면 그 PR에서 고친 뒤 tip CI를 본다.

1. **(a) 리프가 심볼을 정의하고 export 안 함.** 원본 본문을 자아 넣으면서 `export` 키워드를 빼먹는 실수. 모듈 지도의 "공개" 칼럼과 내부 export 절이 각 리프의 export 목록이다. 형제가 import하는 내부 심볼도 형제 export에 올려야 한다. 예: credentialGroupsSchema(1231-1240)는 config-schema·load-degrade·diagnostics가 safeParse하므로 leaf-validators에서 export 필수. isCredentialGroupShape(1211-1217)는 credentialGroupsSchema 본문이 참조하므로 같이 이동하고 비공개 유지.
2. **(b) 파사드가 re-export만 하고 로컬 import 누락.** 파사드가 계속 호출하는 심볼은 `export {} from` 재수출과 별개로 `import {} from`이 있어야 한다. 구체적으로 loadConfig는 configSchema·mergeConfigDefaults·normalizeApiKeyIds·normalizeClaudeSubagentEffort·normalizeNativeSubagentSync·withRefreshedCostOverlays·warnDegraded*(warnDegradedCredentialGroups 포함)·warnConfigRepaired·warnInheritedFastWireConflicts·salvageConfigCandidate·warnAndBackupInvalidConfig·hardenExistingSecret을, initializePersistedConfigIfMissing는 observeInitialConfigState·validateConfigCandidate·projectCustomModelCatalogMigration·projectConfigRebaseProvenance·publishInitialConfigNoReplace·bumpGenerationForCooperatingConfigWrite을, saveConfig는 persistConfigUnlocked·readRawConfigJson·bumpGenerationForCooperatingConfigWrite을, mutatePersistedConfig는 readConfigFileSnapshot·withConfigMutationLockSync·configDiagnosticsFromRaw·unavailableConfigMutationReason을 로컬 바인딩으로 쓴다. 재수출만 남기면 모듈 스코프에 바인딩이 없다.
3. **(c) 타입을 잘못된 모듈에서 import.** OcxConfig·FastWire·ProviderCostOverlay 등은 src/types.ts, OcxRuntimeRole은 src/types/config.ts, ReadConfigGeneration·BumpConfigGeneration·ConfigGeneration·ConfigGenerationObservation·WithExpectedConfigGenerationSync는 src/codex/generation.ts 원본 그대로다. 리프끼리 타입을 재수출해 대체하지 마라. schema/ 리프는 2단 상승(`../../types`), src/config/ 리프는 1단(`../types`).
4. **(d) 정의가 통째로 사라지고 호출부만 남음.** 이동 후 원래 자리에 정의 없이 호출만 남기는 실수. 각 PR 끝에 `rg -n '<옮긴 심볼>' src/config.ts`가 재수출/import 한 줄만 남았는지 확인한다. 특히 loadConfig 수리 병합(2699-2705)을 mergeConfigDefaults(parsed) 호출로 치환할 때 mergeConfigDefaults가 load-degrade에서 export됐는지 먼저 확인한다(핀 2937-2939가 인라인 2702-2704와 동일한 키다). 이번 +92로 생긴 degradedCredentialGroupsWarning(2200-2211)·warnDegradedCredentialGroups(2213-2218)·poolCredentialGroupsError(3132-3141)도 같은 규칙이다.
5. **(e) 한 단계 깊어진 디렉터리의 `../x`.** src/config/schema/*.ts는 모든 트리 외부 참조가 `../../`(types, providers/*, routing/identity-domains, codex/*, claude/desktop-profile, combos/types)이고 형제 참조만 `./`다. src/config/*.ts는 `../`다. 리프가 `../config`를 import하면 순환이다.

## 공통 이동 규칙

원본 함수 본문을 고치지 않고 잘라 붙인다. 옮긴 공개 심볼은 파사드에서 삭제하고 `export { name } from "./config/…";` 한 줄로 다시보낸다. 내부 심볼은 파사드가 `import { name } from "./config/…";` 한다. 리프는 파사드를 import하지 않는다. specifier는 extensionless. 새 테스트 파일 금지. 리프가 src/lab/를 import하면 tests/lab/core-lab-boundary.test.ts가 실패해야 하며 그 상태로 남기지 않는다.

## 상태 소유권

모듈 수준 let/const/WeakMap/Set은 한 파일만 소유한다. Set 자체를 export하거나 인자로 넘겨 두 번째 참조를 만들지 않는다.

| 바인딩 | 현재 행 | 소유 | 이유 |
|---|---|---|---|
| warnedConfigFallbacks | 441 | warn-memo.ts | salvage 4566·4766·4778이 기록. 인자로 넘기면 프로세스 1회성 경고가 갈라진다 |
| warnedInheritedFastWireConflicts | 442 | warn-memo.ts | load-degrade 2632가 기록. 동일 |
| lastWarningReconciledGeneration | 443 | warn-memo.ts | reconcileConfigWarningMemos(445-452)와 동거 |
| warnedProxyConfigDiscards | 4455 | proxy-env.ts | applyProxyEnvWith만 사용. warn-memo와 합치지 말 것 |
| claudeCodeBaseline WeakMap | 3998 | live-reconcile.ts | arm/read/save가 같은 파일. 지연 arm은 첫 save 전 hand-edit를 놓친다 |
| liveConfigBaseline WeakMap | 4004 | live-reconcile.ts | 동일 |
| persistedLiveServerBinding WeakMap | 4013 | live-reconcile.ts | 동일 |
| configMutationLockDepth | 3562 | mutation-lock.ts | persist-unlocked로 이동 금지 |
| configMutationDatabase | 3563 | mutation-lock.ts | persist는 DB 핸들을 받지 않는다. bump는 bumpGenerationForCooperatingConfigWrite |
| warnedConfigMutationDirectoryAcl | 3494 | mutation-lock.ts | 동일 |
| persistedConfigMutationBeforeCommitForTests | 3825 | 잔여 파사드 | setter(3828-3830)와 mutatePersistedConfig(3844)와 동거 |

warn-memo 공개 API. Set 자체는 export하지 않는다.

    export function reconcileConfigWarningMemos(generation: number): number
    export function hasWarnedConfigFallback(configPath: string): boolean
    export function markWarnedConfigFallback(configPath: string): void
    export function hasWarnedInheritedFastWireConflict(configPath: string): boolean
    export function markWarnedInheritedFastWireConflict(configPath: string): void

has/mark는 현행 Set.has/add 래퍼다. warnConfigRepaired(4566-4567), warnDroppedConfigSections(4766-4767), warnAndBackupInvalidConfig(4778-4779), warnInheritedFastWireConflicts(2632-2633)만 이 API를 쓴다.

## 하지 말아야 할 분할

1. configSchema(1286-1865)를 키 그룹 파일로 쪼개지 않는다. 1468의 `).passthrough().superRefine((config, ctx) => {`의 addIssue 순서가 schemaDiagnosticsError(2947)와 salvage 로그 문자열을 결정한다. credentialGroupsSchema를 configSchema 밖 별도 파일로 빼는 것도 같은 금지다(아래 8).
2. create-only와 saveConfig를 한 writer로 합치지 않는다.
3. persistConfigUnlocked를 mutation-lock.ts에 넣지 않는다.
4. WeakMap 3종을 live-reconcile 밖으로 빼거나 startServer가 아닌 모듈에 arm을 옮기지 않는다.
5. 리프가 ../config를 import하지 않는다.
6. 712-729의 provider-name/provider-validation 재수출을 leaf-validators로 가져가지 않는다. 파사드 상단으로 올린다.
7. UNSALVAGEABLE_ISSUE_MESSAGES(4669)의 CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR(4670)를 일반 salvage로 지우지 않는다. 드롭하면 계정 셀렉터가 조용히 통과한다.
8. credentialGroupsSchema(1231-1240)를 leaf-validators 밖으로 빼지 않는다. degradedCredentialGroupsWarning(2200)과 poolCredentialGroupsError(3132)가 같은 스키마를 safeParse하므로 소유자가 갈라지면 리프 간 순환이 생긴다.

## 모듈 지도 (inclusive 현재 원본 행 → 대상, 본체 줄)

| 대상 | 원본 | 본체 | 예상 wc | 공개(파사드 재수출 O/X) |
|---|---|---:|---:|---|
| NEW src/config/warn-memo.ts | 441-452 | 12 | 30 | O reconcileConfigWarningMemos. has/mark는 X |
| NEW src/config/openai-tier-backup.ts | 178-440 | 263 | 295 | O 에러 5종, classify/backup/preserve, IO 타입 |
| NEW src/config/feature-flags.ts | 3928-3980 | 53 | 75 | O websocketsEnabled, ultraFastTierEnabled, CATALOG_AUTO_REFRESH_*, isCatalogAutoRefreshEnabled, resolveCatalogAutoRefreshIntervalMs |
| NEW src/config/proxy-env.ts | 4385-4564 | 180 | 215 | O getDefaultConfig, resolveEnvValue, applyProxyEnv, applyProxyEnvWith, codexAutoStartEnabled, CODEX_SHIM_AUTO_RESTORE_ENV, codexShimAutoRestoreEnabled, multiAgentGuidanceEnabled, runtimeRole |
| NEW src/config/schema/leaf-validators.ts | 454-1241 중 712-729 제외 | 770 | 850 | O requestPacingConfigError, providerWebSearchBridgeConfigError, providerModelCostsConfigError, sanitizeModelCostsForDisplay, modelPreferHostedToolsConfigError. 내부 스키마는 형제 export, 파사드 재수출 금지 |
| NEW src/config/schema/config-schema.ts | 1286-1865 | 580 | 645 | X configSchema (현재 unexported. 형제만 export) |
| NEW src/config/load-degrade.ts | 1867-2646 + 2774-2846 | 853 | 925 | O hardenExistingSecret, retryOn429PolicyConfigError. sanitizer/warn/normalize/mergeConfigDefaults는 형제 export |
| NEW src/config/salvage.ts | 4565-4799 | 235 | 280 | O backupInvalidConfig. salvageConfigCandidate·warn*는 형제 export |
| NEW src/config/diagnostics.ts | 2848-3491 | 644 | 710 | O ConfigDiagnostics, subagentDefaultSyncEffective, loopbackCompanionBindError, validateConfigCandidate, readConfigDiagnostics, observeInitialConfigState, ConfigAdmissionSnapshot, readConfigAdmissionSnapshot. configDiagnosticsFromRaw·readConfigFileSnapshot·poolCredentialGroupsError는 형제 export |
| NEW src/config/mutation-lock.ts | 3492-3712 | 221 | 265 | O ConfigMutationLockError, NestedConfigMutationError, prepareConfigMutationDatabasePathForWrite, withConfigMutationLockSync, readConfigGeneration, observeConfigGeneration, readConfigGenerationInCurrentMutationTransaction, bumpConfigGeneration, withExpectedConfigGenerationSync. bumpGenerationForCooperatingConfigWrite는 형제 export |
| NEW src/config/persist-unlocked.ts | 3714-3756 + 3903-3926 + 4247-4260 | 81 | 135 | X persistConfigUnlocked, readRawConfigJson. 파사드 공개 재수출 금지 |
| NEW src/config/live-reconcile.ts | 3982-4246 + 4262-4383 | 387 | 450 | O armClaudeCodeBaseline, adoptPersistedProviderIntoLiveConfig, claudeCodeBaselineArmed, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode |
| MODIFY src/config.ts 잔여 | 1-177 헤더 + 2647-2773 loadConfig + 3758-3902 init/save/mutate + 재수출 | 449 원본 | 600 전후 | 현행 공개 심볼 전부 |

잔여 449 = 헤더 177 + loadConfig 127 + init/save/mutate 145. 이번 +92는 전부 이동 블록 안에 있으므로 최종 파사드 추정은 050과 같은 자리(~600)다.

## 내부 export (파사드 공개 표면을 늘리지 말 것)

- config-schema.ts: export const configSchema
- leaf-validators.ts: retryOn429PolicySchema, providerConfigSchema, clientConnectionSchema, hubConfigSchema, remoteGuiConfigSchema, runtimeRoleSchema, agentTaskRecoverySchema, quotaResetNotifySchema, catalogAutoRefreshSchema, codexPoolSchema, codexAccountPrioritiesSchema, codexQuotaAutoRefreshSchema, CODEX_ACCOUNT_PIN_PATTERN, configuredCodexPoolAccountIds, credentialGroupsSchema, isCredentialGroupShape
- load-degrade.ts: sanitize*ForLoad, warnDegraded*(degradedCredentialGroupsWarning, warnDegradedCredentialGroups 포함), normalizeApiKeyIds, normalizeClaudeSubagentEffort, normalizeNativeSubagentSync, normalizePersistedClaudeCode, mergeConfigDefaults, inheritedFastWireConflictProviderNames, inheritedFastWireConflictWarning, nativeSubagentSyncDisabledReason, rawClaudeSubagentEffort, isClaudeSubagentEffort, CLAUDE_SUBAGENT_EFFORTS, rawConfigRecord, malformed*, degraded*Warnings, withRefreshedCostOverlays
- salvage.ts: salvageConfigCandidate, warnConfigRepaired, warnDroppedConfigSections, warnAndBackupInvalidConfig
- diagnostics.ts: configDiagnosticsFromRaw, readConfigFileSnapshot, poolCredentialGroupsError
- mutation-lock.ts: bumpGenerationForCooperatingConfigWrite
- persist-unlocked.ts: persistConfigUnlocked, readRawConfigJson

## 비순환 그래프

    warn-memo
    openai-tier-backup → paths, atomic-write, ../lib/windows-secret-acl
    feature-flags
    proxy-env → types, subagent-models, multi-agent-surface, ../lib/windows-system-proxy, ../lib/app-owned-memory
    schema/leaf-validators → ../provider-validation, ../../types, ../../providers/*, ../../routing/identity-domains(credentialGroupIssues), ../../codex/*
    schema/config-schema → ./leaf-validators, ../../combos/types, ../../routing/profile, ../../claude/desktop-profile, ../../codex/account-namespace-match
    load-degrade → schema/leaf-validators(credentialGroupsSchema 포함), warn-memo, ../provider-validation, ../../providers/fastwire, ../../lib/redact, ../../providers/default-aliases, ../../providers/model-discovery-limits
    salvage → schema/config-schema, warn-memo, ../lib/redact, ../codex/account-namespace-match
    diagnostics → load-degrade, salvage, schema/config-schema, schema/leaf-validators, proxy-env(getDefaultConfig)
    mutation-lock → ../../codex/generation, paths, bun:sqlite, ../lib/windows-secret-acl, ../lib/test-home-guard
    persist-unlocked → schema/leaf-validators(clientConnectionSchema), ../provider-validation(configReasoningPinsConfigError), rebase-provenance, atomic-write, ../usage/user-cost-overlays. mutation-lock을 import하지 않음
    live-reconcile → mutation-lock, persist-unlocked, diagnostics, load-degrade(normalizePersistedClaudeCode), rebase-provenance, ../usage/user-cost-overlays
    src/config.ts → 위 전부 재수출 + loadConfig + initializePersistedConfigIfMissing + saveConfig + mutatePersistedConfig

persist-unlocked가 mutation-lock을 import하지 않는 것이 잠금 비보유 계약이다. 호출자(saveConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode)가 이미 withConfigMutationLockSync 안에 있다.

## 동반 수정 의무

| 항목 | 조치 |
|---|---|
| structure/runtime.md:31 | 파사드 설명을 유지하고 새 리프 파일명을 같은 칸에 백틱. 없는 파일을 백틱하지 말 것(그 PR에서 만든 리프만) |
| structure/config.md:14-23 | initializePersistedConfigIfMissing in src/config.ts 유지(함수 잔여) |
| structure/config.md:20-21 | saveConfig 치환이 src/config/persist-unlocked.ts → atomicWriteFile임을 PR4에서 명시. 두 경로 병합 금지 |
| structure/config.md:39 | src/config.ts re-exports 유지 |
| structure/config.md:49 | loader는 src/config.ts. PR2에서 src/config/schema/leaf-validators.ts, src/config/schema/config-schema.ts 백틱 추가 |
| structure/config.md:62 | Env 해석 구현 src/config/proxy-env.ts, 공개 경로는 파사드(PR1) |
| structure/config.md:67 | salvage 구현 src/config/salvage.ts(PR3) |
| structure/config.md:201 | websocketsEnabled 구현 src/config/feature-flags.ts(PR1) |
| structure/config.md:224 | provider-validation 소유 문장에 schema 리프가 refinement 소비자임을 병기(PR2) |
| structure/config.md:310 | cadence resolver src/config/feature-flags.ts(PR1) |
| structure/overview.md:47 | OPENCODEX_HOME 공개 경로 src/config.ts 유지(getConfigDir 재수출) |
| structure/subagents.md:45 | getDefaultConfig 공개 src/config.ts, 구현 src/config/proxy-env.ts(PR1) |
| structure/subagents.md:48 | pin 구현 src/config/load-degrade.ts mergeConfigDefaults(PR3) |
| structure/providers/openai-tiers.md:346 | classifyOpenAiTierBackup 구현 src/config/openai-tier-backup.ts. 050의 :326은 옛 행이다(PR1) |
| structure/decisions/ADR-0016:8, ADR-0020:8/10, ADR-0003:8 | 수정 금지(역사 기록) |
| structure/INDEX.md:107 | 수동 수정 금지. manifest 생성물이고 src/config/는 1단에 이미 청구됨 |
| scripts/structure-ssot.ts:515-519 | unowned 검사는 src/ 1단만 본다. src/config/schema/ 신설은 unowned 실패를 만들지 않는다 |
| manifest.json | 변경 없음. structure:index 불필요 |
| layout.json / tests/fixtures/test-layout-expected.json | 등록하지 않음(새 테스트 없음) |

runtime.md:31은 파사드 한 칸이다. 각 PR에서 그 PR이 만든 리프만 백틱한다. 없는 경로를 백틱하면 structure:check가 git index 기준으로 실패한다.

## 소스 오라클 (파사드 경로 유지)

tests/config/config-mutation-lock.test.ts:84,151,395 — pathToFileURL(repoPath("src/config.ts")).href로 자식이 withConfigMutationLockSync를 import. 리프 URL로 바꾸지 마라. :31의 코멘트도 파사드 기준이다.

tests/codex-integration/codex-config-generation.test.ts:31 — 동일. :17-25가 bumpConfigGeneration, mutatePersistedConfig, observeConfigGeneration, readConfigGeneration, saveConfig, saveConfigPreservingClaudeCode, withExpectedConfigGenerationSync를 파사드에서 import.

tests/usage/user-cost-overlay-live-reconcile.test.ts:113,175,239 — 자식 await import("./src/config.ts"). :5 정적 import(getConfigPath·loadConfig·saveConfig from ../../src/config)도 파사드.

tests/service/init-eof.test.ts:190 — mock.module("./src/config.ts")가 initializePersistedConfigIfMissing를 감싼다. 심볼이 파사드에 있어야 mock가 잡는다. :182는 spread import, :252는 withConfigMutationLockSync 실호출.

tests/config/config-save-boundary.test.ts:19 — GUARDED_FILES는 다른 모듈의 saveConfig 직호출을 검사할 뿐 src/config.ts 본문을 읽지 않는다. 세 번째 테스트가 server/index.ts의 armClaudeCodeBaseline arm 순서를 검사하므로 arm 심볼이 파사드 재수출이면 index.ts 불변.

## INV 승계

INV-WS-01 — structure/overview.md:84-85. Enforced by tests/codex-integration/codex-catalog.test.ts(1행 주석 유지). 구현 모듈 src/config/feature-flags.ts websocketsEnabled. 테스트 import 경로는 파사드. 테스트 파일 이동·개명 금지. 이 파일을 묶는 다른 INV는 없다.

INV-TESTS-01 — 신규 테스트 없음. config 도메인 match는 scripts/test-layout/layout.json:138-142(`"^(?:config|expand|settings|types|url|yaml)-"`). 새 테스트가 생기면 tests/config/config-*.test.ts로 두고 layout.json explicit과 tests/fixtures/test-layout-expected.json 두 맵에 등록한다. 이 사이클은 등록하지 않는다.

## 소비자 (파사드 유지, write set 밖)

src/config.ts를 import하는 테스트는 rg 실측 200곳. 경로를 리프로 바꾸지 않는다. 새 리프를 router.ts·server/lifecycle.ts·server/responses/core.ts가 직접 import하지 않는다.

---

## PR 1 — warn-memo + tier-backup + flags + proxy-env

세 모듈은 서로 독립이고, warn-memo는 salvage(4566·4766·4778)와 load-degrade(2632)보다 먼저 소유권이 갈라져야 한다. base L5 상당 링크. 비-tip이면 커밋 제목 [skip ci] 가능.

### NEW

src/config/warn-memo.ts 예상 30줄. 원본 441-452. 위 has/mark API 추가만 허용.

src/config/openai-tier-backup.ts 예상 295줄. 원본 178-440. sameBytes(222-224)·isAlreadyExistsError(226-228) 비공개 동반. import: node:fs chmodSync/copyFileSync/existsSync/linkSync/readFileSync/truncateSync/unlinkSync/writeFileSync, fsConstants, getConfigPath(../config/paths), nextAtomicTempSequence·isMissingPathError(../config/atomic-write), hardenSecretPath·forgetEphemeralSecretPath(../lib/windows-secret-acl).

src/config/feature-flags.ts 예상 75줄. 원본 3928-3980. import type { OcxConfig } from "../types".

src/config/proxy-env.ts 예상 215줄. 원본 4385-4564. import: DEFAULT_SUBAGENT_MODELS·SUBAGENT_MODELS_VERSION(../config/subagent-models), MULTI_AGENT_SURFACE_ADVISORY_VERSION(../config/multi-agent-surface), OPENAI_PROVIDER_TIER_VERSION(../types), DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES(../lib/app-owned-memory), describeProxyForLog·readWindowsSystemProxy(../lib/windows-system-proxy), type OcxConfig(../types), type OcxRuntimeRole(../types/config).

### MODIFY

src/config.ts: 178-440, 441-452, 3928-3980, 4385-4564 삭제 후 재수출. 잔여 load-degrade가 warnedInheritedFastWireConflicts를 쓰므로 2632-2633을 warn-memo has/mark 호출로 치환. salvage 4566-4567·4766-4767·4778-4779도 동일(아직 파사드에 있는 동안). 본문 로직은 바꾸지 않는다.

structure/config.md:62,201,310 — 구현 경로 병기. 없는 리프를 미리 적지 말 것.
structure/providers/openai-tiers.md:346 — classifyOpenAiTierBackup → src/config/openai-tier-backup.ts.
structure/subagents.md:45 — getDefaultConfig 구현 src/config/proxy-env.ts, 공개는 src/config.ts.
structure/runtime.md:31 — 이 PR의 네 리프 파일명 백틱.

### DELETE

없음.

### 파사드 re-export (이 PR 후 상단)

    export { reconcileConfigWarningMemos } from "./config/warn-memo";
    export { OpenAiTierBackupCleanupError, OpenAiTierBackupRollbackError, OpenAiTierBackupCollisionError, OpenAiTierRollbackPreserveError, OpenAiTierBackupSecretResidualError, classifyOpenAiTierBackup, backupConfigBeforeOpenAiTierMigration, preserveOpenAiTierRollbackSnapshot, type OpenAiTierBackupIO, type OpenAiTierRollbackPreserveIO } from "./config/openai-tier-backup";
    export { websocketsEnabled, ultraFastTierEnabled, CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS, CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS, isCatalogAutoRefreshEnabled, resolveCatalogAutoRefreshIntervalMs } from "./config/feature-flags";
    export { codexAutoStartEnabled, CODEX_SHIM_AUTO_RESTORE_ENV, codexShimAutoRestoreEnabled, multiAgentGuidanceEnabled, runtimeRole, getDefaultConfig, resolveEnvValue, applyProxyEnv, applyProxyEnvWith } from "./config/proxy-env";

### 회귀

tests/server/proxy-env.test.ts, tests/config/config-catalog-auto-refresh.test.ts, tests/codex-integration/catalog-auto-refresh-scheduler.test.ts, tests/codex-integration/codex-catalog.test.ts(INV-WS-01), tests/codex-integration/codex-shim-autorestore.test.ts, tests/service/init-backup-cleanup.test.ts, tests/adapters/openai/openai-provider-option-startup.test.ts, tests/config/config-load-degrade.test.ts.

예상: config.ts 4,799-263-12-53-180+재수출 ≈ 20 ≈ 4,110.

---

## PR 2 — schema

salvage(4702)·loadConfig(2666·2710)·validateConfigCandidate(3355)·configDiagnosticsFromRaw(3375·3381)·load-degrade(credentialGroupsSchema)가 configSchema를 쓰므로 그들보다 앞선다.

### NEW

src/config/schema/leaf-validators.ts 예상 850줄. 원본 454-1241에서 712-729를 뺀다. 712-729는 파사드 상단 기존 provider-name/provider-validation import(7행, 11-30행)·재수출 근처로 옮긴다. import: z from zod/v4, ../provider-validation, ../../types, ../../providers/registry 등 ../../ 2단 상승, credentialGroupIssues from ../../routing/identity-domains.

src/config/schema/config-schema.ts 예상 645줄. 원본 1286-1865 그대로. 첫 import는 ./leaf-validators의 스키마들. CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR(1826 사용)는 ../../codex/account-namespace-match. export const configSchema. 파사드는 configSchema를 재수출하지 않는다.

### MODIFY

src/config.ts: 454-1241 삭제(712-729는 잘라 파사드 상단으로), 1286-1865 삭제. import { configSchema } from "./config/schema/config-schema"; (loadConfig·salvage·diagnostics가 아직 파사드에 있으면 로컬 바인딩).

structure/config.md:49 근처에 src/config/schema/leaf-validators.ts와 src/config/schema/config-schema.ts 백틱. :224에 schema 리프가 provider-validation을 소비한다고 적는다.

### 회귀

tests/config/config-load-degrade.test.ts(:352의 credentialGroups degrade 포함), tests/config/model-pinned-effort-config.test.ts, tests/server/config.test.ts, tests/routing/routing-profile.test.ts, tests/routing/routing-compatibility-boundaries.test.ts, tests/web-search/web-search-passthrough-bridge.test.ts, tests/providers/provider-cost-overlay-config.test.ts, tests/routing/routing-identity-domains.test.ts(credentialGroupIssues 원본 회귀).

함정: superRefine 본문(1468부터)이 원본 1286-1865와 export/import 외 일치. git diff로 확인. credentialGroupsSchema(1231-1240)는 leaf-validators에, pool 필드(1430-1435)는 config-schema에 그대로 남는지.

예상: config.ts ≈ 4,110-770-580+import ≈ 2,780.

---

## PR 3 — salvage + load-degrade

둘 다 configSchema와 warn-memo가 필요하다. load-degrade는 mergeConfigDefaults를 export해서 loadConfig 치환에 쓰인다.

### NEW

src/config/salvage.ts 예상 280줄. 원본 4565-4799. import: configSchema from ./schema/config-schema, has/markWarnedConfigFallback from ./warn-memo, redactSecretString from ../lib/redact, z from zod/v4, copyFileSync/chmodSync/existsSync from node:fs, CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR from ../codex/account-namespace-match.

src/config/load-degrade.ts 예상 925줄. 원본 1867-2646 + 2774-2846. import: leaf 스키마(credentialGroupsSchema 포함), warn-memo inherited API, ../provider-validation, ../../providers/fastwire, ../../lib/redact, MODEL_ALIAS_PATTERN from ../../providers/default-aliases, MODEL_DISCOVERY_MAX_MODELS from ../../providers/model-discovery-limits, type OcxConfig 등 from ../../types.

### MODIFY

src/config.ts: 1867-2646, 2774-2846, 4565-4799 삭제. loadConfig(2647-2773) 잔류. 2699-2705 인라인 병합을 mergeConfigDefaults(parsed) 호출로 치환(핀 2702-2704는 mergeConfigDefaults 2937-2939와 동일 키라 소실 없음). 2687·2731·2760의 warnDegradedCredentialGroups는 load-degrade import로 해석.

structure/config.md:67 — salvage 구현 src/config/salvage.ts.
structure/subagents.md:48 — pin 구현 src/config/load-degrade.ts mergeConfigDefaults.

재수출: hardenExistingSecret, retryOn429PolicyConfigError from load-degrade. backupInvalidConfig from salvage.

### 회귀

tests/config/config-load-degrade.test.ts(:343-367 degrade 경로), tests/config/config-user-edits.test.ts, tests/routing/fastwire-policy.test.ts, tests/server/config.test.ts, tests/config/settings-stream-mode.test.ts.

예상: config.ts ≈ 2,780-853-235+import ≈ 1,710.

---

## PR 4 — mutation-lock + persist-unlocked + diagnostics

diagnostics는 salvage·load-degrade·schema·getDefaultConfig가 필요하다. persist-unlocked는 clientConnectionSchema(leaf)와 configReasoningPinsConfigError(provider-validation)가 필요하다. mutation-lock은 독립이나 persist를 잠금 모듈에 넣지 않기 위해 같은 PR에서 persist-unlocked를 만든다.

### NEW

src/config/mutation-lock.ts 예상 265줄. 원본 3492-3712. import: Database from bun:sqlite, paths, hardenSecretDir·windowsSecretAclApplies from ../lib/windows-secret-acl, assertNotRealHomeUnderTest from ../lib/test-home-guard, generation 타입 from ../../codex/generation. persistConfigUnlocked 주석(3714-3719)은 이 모듈로 오지 않는다.

src/config/persist-unlocked.ts 예상 135줄. 본문 순서: readRawConfigJson(4247-4260), failClosedClientPersistenceError(3903-3926), persistConfigUnlocked(주석 3714-3719 + 본문 3720-3756). mutation-lock을 import하지 않음. import: configReasoningPinsConfigError from ../provider-validation, clientConnectionSchema from ./schema/leaf-validators, configRebaseDeletionKeys from ./rebase-provenance, atomicWriteFile from ./atomic-write, getConfigPath from ./paths, refreshUserCostOverlays·withPreservedDiskOnlyProviders from ../usage/user-cost-overlays.

src/config/diagnostics.ts 예상 710줄. 원본 2848-3491. import: getDefaultConfig from ./proxy-env, salvageConfigCandidate from ./salvage, load-degrade 헬퍼, configSchema from ./schema/config-schema, leaf 스키마, credentialGroupsSchema(poolCredentialGroupsError 3138용).

### MODIFY

src/config.ts: 2848-3491, 3492-3712, 3714-3756, 3903-3926, 4247-4260 삭제.

initializePersistedConfigIfMissing(3761-3794)과 saveConfig(3797-3813)는 잔류. 상단 import를 물리적으로 분리한다.

    // create-only path — never persist-unlocked / atomicWriteFile
    import { publishInitialConfigNoReplace, type InitialConfigPublicationIO } from "./config/initialize";
    import { observeInitialConfigState } from "./config/diagnostics";

    // replace path — never publishInitialConfigNoReplace
    import { persistConfigUnlocked } from "./config/persist-unlocked";

    import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./config/mutation-lock";

structure/config.md:14-23 — 치환 쓰기가 persist-unlocked.ts의 persistConfigUnlocked → atomicWriteFile임을 명시. 병합 금지.
structure/runtime.md:31 — mutation-lock.ts, persist-unlocked.ts, diagnostics.ts 백틱.

재수출: mutation-lock 공개 심볼, diagnostics 공개 심볼. persistConfigUnlocked는 재수출하지 않는다.

### 회귀

tests/config/config-mutation-lock.test.ts(오라클 :84 :151 :395), tests/codex-integration/codex-config-generation.test.ts:31, tests/codex-integration/codex-admission-primitives.test.ts, tests/config/config-load-degrade.test.ts(:371-400 write reject — validateConfigCandidate), tests/server/loopback-listener-admission.test.ts, tests/service/init-eof.test.ts:190.

예상: config.ts ≈ 1,710-644-221-81+import ≈ 780.

---

## PR 5 — live-reconcile (레인 tip)

diagnostics·persist-unlocked·mutation-lock·load-degrade가 필요하다. 이 PR이 tip이므로 커밋 제목에 [skip ci]를 붙이지 않는다.

### NEW

src/config/live-reconcile.ts 예상 450줄. 원본 3982-4246 + 4262-4383.

import: withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite from ./mutation-lock; persistConfigUnlocked, readRawConfigJson from ./persist-unlocked; configDiagnosticsFromRaw, readConfigDiagnostics from ./diagnostics; normalizePersistedClaudeCode from ./load-degrade; rebase-provenance; ../usage/user-cost-overlays. 파사드를 import하지 않는다.

### MODIFY

src/config.ts: 3982-4246, 4262-4383 삭제. armClaudeCodeBaseline, adoptPersistedProviderIntoLiveConfig, claudeCodeBaselineArmed, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode를 live-reconcile에서 재수출.

structure/config.md에 live-reconcile WeakMap(3998·4004·4013) 소유 한 문장. runtime.md:31에 live-reconcile.ts 백틱.

### 잔여 파사드 골격

loadConfig(2647-2773), initializePersistedConfigIfMissing(3761-3794), saveConfig(3797-3813), mutatePersistedConfig(3844-3901), persistedConfigMutationBeforeCommitForTests(3825)와 setter(3828-3830). atomicWriteFile은 initialize에 없다.

### 회귀

tests/config/config-user-edits.test.ts, tests/config/config-save-boundary.test.ts, tests/usage/user-cost-overlay-live-reconcile.test.ts:113,175,239, tests/codex-integration/codex-config-generation.test.ts, tests/lab/core-lab-boundary.test.ts.

예상: live-reconcile 450, config.ts ≈ 600 전후. wc -l src/config.ts src/config/*.ts src/config/schema/*.ts 전부 1,999 이하.

## 수락 기준

1. src/config.ts ≤ 1,999, 새 모듈 전부 ≤ 1,999.
2. initializePersistedConfigIfMissing가 persist-unlocked를 import하지 않고, persist-unlocked가 initialize를 import하지 않는다. atomicWriteFile은 save 경로에만 있다.
3. configSchema superRefine 본문(1468부터)이 원본 1286-1865와 동일(export/import 제외). 키 그룹 분할 없음. credentialGroupsSchema는 leaf-validators에, pool 필드는 config-schema에.
4. warned* 세 값(441-443)이 warn-memo.ts에만 있다. salvage(4566·4766·4778)와 load-degrade(2632)는 has/mark만 호출한다.
5. WeakMap 세 개(3998·4004·4013)가 live-reconcile.ts에만 있고 armClaudeCodeBaseline(4020-4023)이 liveConfigBaseline과 claudeCodeBaseline을 함께 set한다.
6. 오라클이 계속 repoPath("src/config.ts")·import("./src/config.ts")·mock.module("./src/config.ts")·../../src/config를 쓴다(config-mutation-lock:84·151·395, codex-config-generation:31, user-cost-overlay:5·113·175·239, init-eof:182·190·252).
7. INV-WS-01 테스트 경로 불변(codex-catalog.test.ts 1행). layout.json·test-layout-expected.json 불변. ADR 3개 불변. INDEX.md:107 수동 편집 없음.
8. 공개 export 집합이 PR 전후 동일. persistConfigUnlocked와 configSchema를 파사드 공개 표면에 추가하지 않는다.
9. 직전 라운드 CI 결함 5종 미발생: (a) 리프 정의 무 export, (b) 파사드 re-export만으로 로컬 import 누락, (c) 타입을 잘못된 모듈에서 import(OcxConfig는 types, schema/는 ../../), (d) 정의 소실·호출부 잔류, (e) schema/ 2단 상승 ../ 오용.
