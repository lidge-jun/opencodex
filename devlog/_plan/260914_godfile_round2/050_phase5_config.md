# 050 — 사이클 5: src/config.ts 파사드 분해

src/config.ts 4,707줄이 스키마·로드 열화·salvage·잠금·치환 쓰기·라이브 재결합을 한 파일에 들고 있어 래칫 이후에도 2,000줄을 넘긴다. 이 문서는 그 파일을 5개 PR로 줄이는 복붙 가능한 이동 계약이다. 구현자는 아래 원본 행을 새 리프로 옮기고 파사드가 기존 export 이름을 그대로 다시보내며, 소비자는 import 경로를 건드리지 않는다. create-only 경로 initializePersistedConfigIfMissing와 치환 경로 saveConfig는 잔여 파사드에 함께 남기되 공용 writeConfigBytes(mode)로 합치지 않고, 경고 메모 세 값은 인자로 넘기지 않으며, configSchema는 키 그룹으로 쪼개지 않는다. 초안의 PR 묶음은 salvage가 configSchema를, diagnostics가 salvage와 load-degrade를, live-reconcile이 persistConfigUnlocked를 쓰기 때문에 기술 의존성 순서로 재배치한다.

브랜치 `codex/m2k-l6-config`, base는 사이클 4 `codex/m2k-l5-routing-quota`. 순수 이동, 동작 변경 없음. 로컬 스위트·typecheck·build는 이 단위 금지(hosted CI). 새 테스트 파일을 만들지 않으므로 layout.json과 test-layout-expected.json은 등록하지 않는다. 기준 트리 origin/dev 4f788f916e, 파일 4,707줄. 열린 PR 충돌은 순서에서 제외한다.

## 정정 (초안 대비, 이 트리에서 재계측)

정정: warnedConfigFallbacks 블록은 440-450(11줄)이지 leaf-validators 440-1247에 들어 있지 않다. leaf-validators 본체는 452-1247(796줄)이고 452-458은 retryOn429PolicySchema 주석이라 schema로 간다.

정정: feature-flags 본체는 3836-3890(55줄)이다. 초안 3836-3905는 3892-3904 live-reconcile 배너 주석을 잘못 포함했다. 그 주석은 live-reconcile.ts로 이동한다.

정정: mutation-lock 본체는 3400-3626(227줄)이다. 초안 3400-3665는 persistConfigUnlocked(3628-3664, 37줄)를 포함하며, 그 함수는 잠금 모듈로 이동 금지이므로 범위에서 뺀다.

정정: load-degrade는 1823-2578(756줄)만이 아니다. loadConfig가 호출하는 sanitizeAliasesForLoad·sanitizeModelDisplayNamesForLoad·withRefreshedCostOverlays(2703-2775, 73줄)가 loadConfig(2579-2701) 뒤에 떨어져 있다. 세 함수는 load-degrade로 옮기고 loadConfig는 파사드 오케스트레이터로 잔류한다.

정정: salvageConfigCandidate는 configSchema.safeParse를 4588과 4612에서 호출한다. schema 추출 전에 salvage를 빼면 salvage → 파사드 → salvage 순환이 생긴다. 초안 PR2 salvage+warn-memo / PR5 schema+load-degrade 순서는 불가능하다.

정정: diagnostics(2777-3399)는 load-degrade 헬퍼, salvageConfigCandidate, configSchema, getDefaultConfig를 쓴다. reconcileLiveConfigFromDisk(4122)는 readConfigDiagnostics()를, saveConfigPreservingClaudeCode(4206)는 configDiagnosticsFromRaw·normalizePersistedClaudeCode·persistConfigUnlocked·withConfigMutationLockSync를 쓴다. 초안 PR3 live-reconcile / PR4 mutation-lock+diagnostics는 순환이다.

정정: persistConfigUnlocked를 파사드에 남기고 saveConfigPreservingClaudeCode를 live-reconcile로 옮기면 live-reconcile → 파사드 순환이 된다. persistConfigUnlocked·failClosedClientPersistenceError·readRawConfigJson을 src/config/persist-unlocked.ts로 선분리한다. 이는 writeConfigBytes 병합이 아니다. initializePersistedConfigIfMissing는 이 모듈을 import하지 않고 publishInitialConfigNoReplace만 쓴다.

정정: structure:check unowned는 src/ 1단만 본다(scripts/structure-ssot.ts:515-519). src/config/는 이미 config.md·runtime.md documents에 있어 src/config/schema/ 신설만으로 unowned 실패가 나지는 않는다. area 변경 의무로 config.md가 새 경로를 백틱 인용해야 하고, 백틱을 넣으면 git index에 파일이 있어야 한다.

정정: tests/usage/user-cost-overlay-live-reconcile.test.ts:113,175,239는 mock.module이 아니라 자식 await import("./src/config.ts")다. mock.module("./src/config.ts")는 tests/service/init-eof.test.ts:190뿐이다(:182는 spread import, :252는 withConfigMutationLockSync 실import).

정정: ADR-0016:8, ADR-0020:8/10, ADR-0003:8은 역사 기록이라 현재 트리에 맞춰 고치지 않는다. INDEX.md:107은 manifest 생성물이라 손대지 않는다. src/config/ documents가 이미 있어 structure:index도 불필요하다.

정정: 711-732의 provider-name/provider-validation re-export는 leaf-validators 한가운데 있다. 리프로 가져가지 말고 파사드 상단 블록으로 올린다.

정정: loadConfig의 수리 병합(2631-2644)과 diagnostics mergeConfigDefaults(2858-2874)는 같은 핀 세 키(subagentModelsVersion, multiAgentMode, multiAgentSurfaceAdvisoryVersion)를 복제한다. load-degrade로 옮길 때 인라인 병합을 mergeConfigDefaults 호출로 치환한다. 핀이 빠지면 v1 서브에이전트 표면이 침묵 수리된다(structure/subagents.md:45-48).

## create-only 경계 (최우선 보존)

structure/config.md:14-22 현행:

> `initializePersistedConfigIfMissing` in `src/config.ts` is the create-only path consumed by
> `src/cli/init.ts`. It rechecks absence under the existing config-mutation lock and publishes through
> `src/config/initialize.ts`: a private descriptor is hardened before secret bytes are written, then
> linked without replacing an occupied destination. Existing invalid or unsafe entries are preserved.
> The initializer never truncates a staged inode or rolls back by unlinking the destination; cleanup
> only removes its own temporary name. ... Ordinary `saveConfig` replacement behavior remains unchanged.

코드 재확인. initializePersistedConfigIfMissing(3669-3703)는 withConfigMutationLockSync 안에서 observeInitialConfigState()를 재확인한 뒤 publishInitialConfigNoReplace(getConfigPath(), JSON.stringify(...) + newline, io)만 호출한다. atomicWriteFile을 쓰지 않는다. saveConfig(3705-3721)는 withConfigMutationLockSync → persistConfigUnlocked(3628-3664) → 변경 시에만 atomicWriteFile(3659). persistConfigUnlocked 주석(3618-3626)은 잠금 비보유를 계약으로 못 박는다.

금지: writeConfigBytes(mode). 두 공개 함수는 잔여 src/config.ts에 남긴다. 파사드 상단 import를 빈 줄로 나눠 create-only는 ./config/initialize만, replace는 ./config/persist-unlocked만 보게 한다.

## 공통 이동 규칙

원본 함수 본문을 고치지 않고 잘라 붙인다. 옮긴 공개 심볼은 파사드에서 삭제하고 `export { name } from "./config/…";` 한 줄로 다시보낸다. 내부 심볼은 파사드가 `import { name } from "./config/…";` 한다. 리프는 파사드를 import하지 않는다. specifier는 extensionless. 새 테스트 파일 금지. 리프가 src/lab/를 import하면 tests/lab/core-lab-boundary.test.ts가 실패해야 하며 그 상태로 남기지 않는다.

## 상태 소유권

모듈 수준 let/const/WeakMap/Set은 한 파일만 소유한다. Set 자체를 export하거나 인자로 넘겨 두 번째 참조를 만들지 않는다.

| 바인딩 | 원본 행 | 소유 | 이유 |
|---|---|---|---|
| warnedConfigFallbacks | 440 | warn-memo.ts | salvage 4474/4674/4686이 기록. 인자로 넘기면 프로세스 1회성 경고가 갈라진다 |
| warnedInheritedFastWireConflicts | 441 | warn-memo.ts | load-degrade 2564가 기록. 동일 |
| lastWarningReconciledGeneration | 442 | warn-memo.ts | reconcileConfigWarningMemos(444-450)와 동거 |
| warnedProxyConfigDiscards | 4363 | proxy-env.ts | applyProxyEnvWith만 사용. warn-memo와 합치지 말 것 |
| claudeCodeBaseline WeakMap | 3906 | live-reconcile.ts | arm/read/save가 같은 파일. 지연 arm은 첫 save 전 hand-edit를 놓친다 |
| liveConfigBaseline WeakMap | 3912 | live-reconcile.ts | 동일 |
| persistedLiveServerBinding WeakMap | 3921 | live-reconcile.ts | 동일 |
| configMutationLockDepth | 3470 | mutation-lock.ts | persist-unlocked로 이동 금지 |
| configMutationDatabase | 3471 | mutation-lock.ts | persist는 DB 핸들을 받지 않는다. bump는 bumpGenerationForCooperatingConfigWrite |
| warnedConfigMutationDirectoryAcl | 3402 | mutation-lock.ts | 동일 |
| persistedConfigMutationBeforeCommitForTests | 3733 | 잔여 파사드 | mutatePersistedConfig(3752)와 동거 |

warn-memo 공개 API. Set 자체는 export하지 않는다.

    export function reconcileConfigWarningMemos(generation: number): number
    export function hasWarnedConfigFallback(configPath: string): boolean
    export function markWarnedConfigFallback(configPath: string): void
    export function hasWarnedInheritedFastWireConflict(configPath: string): boolean
    export function markWarnedInheritedFastWireConflict(configPath: string): void

has/mark는 현행 Set.has/add 래퍼다. warnConfigRepaired(4474), warnDroppedConfigSections(4674), warnAndBackupInvalidConfig(4686), warnInheritedFastWireConflicts(2564)만 이 API를 쓴다.

## 하지 말아야 할 분할

1. configSchema(1248-1822)를 키 그룹 파일로 쪼개지 않는다. 1424의 passthrough().superRefine((config, ctx) => { 의 addIssue 순서가 schemaDiagnosticsError(2876)와 salvage 로그 문자열을 결정한다.
2. create-only와 saveConfig를 한 writer로 합치지 않는다.
3. persistConfigUnlocked를 mutation-lock.ts에 넣지 않는다.
4. WeakMap 3종을 live-reconcile 밖으로 빼거나 startServer가 아닌 모듈에 arm을 옮기지 않는다.
5. 리프가 ../config를 import하지 않는다.
6. 711-732 re-export를 leaf-validators로 가져가지 않는다.
7. UNSALVAGEABLE_ISSUE_MESSAGES의 CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR를 일반 salvage로 지우지 않는다. 드롭하면 계정 셀렉터가 조용히 통과한다.

## 모듈 지도 (inclusive 원본 행 → 대상, 본체 줄)

| 대상 | 원본 | 본체 | 예상 wc | 공개(파사드 재수출 O/X) |
|---|---|---:|---:|---|
| NEW src/config/warn-memo.ts | 440-450 | 11 | 28 | O reconcileConfigWarningMemos. has/mark는 X |
| NEW src/config/openai-tier-backup.ts | 177-439 | 263 | 295 | O 에러 5종, classify/backup/preserve, IO 타입 |
| NEW src/config/feature-flags.ts | 3836-3890 | 55 | 78 | O websocketsEnabled, ultraFastTierEnabled, CATALOG_AUTO_REFRESH_*, isCatalogAutoRefreshEnabled, resolveCatalogAutoRefreshIntervalMs |
| NEW src/config/proxy-env.ts | 4293-4472 | 180 | 215 | O getDefaultConfig, resolveEnvValue, applyProxyEnv, applyProxyEnvWith, codexAutoStartEnabled, CODEX_SHIM_AUTO_RESTORE_ENV, codexShimAutoRestoreEnabled, multiAgentGuidanceEnabled, runtimeRole. 정정: 파일명은 proxy-env이나 초안 범위에 getDefaultConfig가 들어 있다 |
| NEW src/config/schema/leaf-validators.ts | 452-1247 중 711-732 제외 | 774 | 860 | O requestPacingConfigError, providerWebSearchBridgeConfigError, providerModelCostsConfigError, sanitizeModelCostsForDisplay, modelPreferHostedToolsConfigError. 내부 스키마는 형제 export, 파사드 재수출 금지 |
| NEW src/config/schema/config-schema.ts | 1248-1822 | 575 | 640 | X configSchema (현재 unexported. 형제만 export) |
| NEW src/config/load-degrade.ts | 1823-2578 + 2703-2775 | 829 | 900 | O hardenExistingSecret, retryOn429PolicyConfigError. sanitizer/warn/normalize/mergeConfigDefaults는 형제 export |
| NEW src/config/salvage.ts | 4473-4707 | 235 | 275 | O backupInvalidConfig. salvageConfigCandidate·warn*는 형제 export |
| NEW src/config/diagnostics.ts | 2777-3399 | 623 | 690 | O ConfigDiagnostics, subagentDefaultSyncEffective, loopbackCompanionBindError, validateConfigCandidate, readConfigDiagnostics, observeInitialConfigState, ConfigAdmissionSnapshot, readConfigAdmissionSnapshot. configDiagnosticsFromRaw·readConfigFileSnapshot는 형제 export |
| NEW src/config/mutation-lock.ts | 3400-3626 | 227 | 275 | O ConfigMutationLockError, NestedConfigMutationError, prepareConfigMutationDatabasePathForWrite, withConfigMutationLockSync, readConfigGeneration, observeConfigGeneration, readConfigGenerationInCurrentMutationTransaction, bumpConfigGeneration, withExpectedConfigGenerationSync. bumpGenerationForCooperatingConfigWrite는 형제 export |
| NEW src/config/persist-unlocked.ts | 3628-3664 + 3811-3834 + 4156-4172 | 78 | 130 | X persistConfigUnlocked, readRawConfigJson. 파사드 공개 재수출 금지 |
| NEW src/config/live-reconcile.ts | 3892-3904 + 3906-4154 + 4174-4291 | 380 | 450 | O armClaudeCodeBaseline, adoptPersistedProviderIntoLiveConfig, claudeCodeBaselineArmed, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode |
| MODIFY src/config.ts 잔여 | 1-176 헤더 + 2579-2701 loadConfig + 3666-3810 init/save/mutate + 재수출 | 444 원본 | 560 | 현행 공개 심볼 전부 |

잔여 444 = 헤더 176 + loadConfig 123 + init/save/mutate 145. persist를 잔여에 두면 saveConfigPreservingClaudeCode까지 남아 ~720이 된다. persist-unlocked가 ~560을 만든다.

## 내부 export (파사드 공개 표면을 늘리지 말 것)

- config-schema.ts: export const configSchema
- leaf-validators.ts: retryOn429PolicySchema, providerConfigSchema, clientConnectionSchema, hubConfigSchema, remoteGuiConfigSchema, runtimeRoleSchema, agentTaskRecoverySchema, quotaResetNotifySchema, catalogAutoRefreshSchema, codexPoolSchema, codexAccountPrioritiesSchema, codexQuotaAutoRefreshSchema, CODEX_ACCOUNT_PIN_PATTERN, configuredCodexPoolAccountIds
- load-degrade.ts: sanitize*ForLoad, warnDegraded*, normalizeApiKeyIds, normalizeClaudeSubagentEffort, normalizeNativeSubagentSync, normalizePersistedClaudeCode, mergeConfigDefaults, inheritedFastWireConflictProviderNames, inheritedFastWireConflictWarning, nativeSubagentSyncDisabledReason, rawClaudeSubagentEffort, isClaudeSubagentEffort, CLAUDE_SUBAGENT_EFFORTS, rawConfigRecord, malformed*, degraded*Warnings, withRefreshedCostOverlays
- salvage.ts: salvageConfigCandidate, warnConfigRepaired, warnDroppedConfigSections, warnAndBackupInvalidConfig
- diagnostics.ts: configDiagnosticsFromRaw, readConfigFileSnapshot
- mutation-lock.ts: bumpGenerationForCooperatingConfigWrite
- persist-unlocked.ts: persistConfigUnlocked, readRawConfigJson

## 비순환 그래프

    warn-memo
    openai-tier-backup → paths, atomic-write, windows-secret-acl
    feature-flags
    proxy-env → types, subagent-models, multi-agent-surface, windows-system-proxy
    schema/leaf-validators → provider-validation, types, providers/*
    schema/config-schema → leaf-validators, combos/types, routing/profile, claude/desktop-profile, account-namespace-match
    load-degrade → leaf-validators, warn-memo, provider-validation, fastwire, redact
    salvage → config-schema, warn-memo, redact
    diagnostics → load-degrade, salvage, config-schema, leaf-validators, proxy-env(getDefaultConfig)
    mutation-lock → codex/generation, paths, bun:sqlite, windows-secret-acl, test-home-guard
    persist-unlocked → leaf-validators(clientConnectionSchema), rebase-provenance, atomic-write, usage/user-cost-overlays. mutation-lock을 import하지 않음
    live-reconcile → mutation-lock, persist-unlocked, diagnostics, load-degrade(normalizePersistedClaudeCode), rebase-provenance, usage overlays
    src/config.ts → 위 전부 재수출 + loadConfig + initializePersistedConfigIfMissing + saveConfig + mutatePersistedConfig

persist-unlocked가 mutation-lock을 import하지 않는 것이 잠금 비보유 계약이다. 호출자(saveConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode)가 이미 withConfigMutationLockSync 안에 있다.

## 동반 수정 의무

| 항목 | 조치 |
|---|---|
| structure/runtime.md:31 | 파사드 설명을 유지하고 새 리프 파일명을 같은 칸에 백틱. 없는 파일을 백틱하지 말 것(그 PR에서 만든 리프만) |
| structure/config.md:14 | initializePersistedConfigIfMissing in src/config.ts 유지(함수 잔여) |
| structure/config.md:21 | saveConfig 치환이 src/config/persist-unlocked.ts → atomicWriteFile임을 PR4에서 명시. 두 경로 병합 금지 |
| structure/config.md:39 | src/config.ts re-exports 유지 |
| structure/config.md:49 | loader는 src/config.ts. PR2에서 src/config/schema/config-schema.ts, src/config/schema/leaf-validators.ts 백틱 추가 |
| structure/config.md:62 | Env 해석 구현 src/config/proxy-env.ts, 공개 경로는 파사드 |
| structure/config.md:67 | salvage 구현 src/config/salvage.ts |
| structure/config.md:201 | websocketsEnabled 구현 src/config/feature-flags.ts |
| structure/config.md:224 | Zod refinement 소비자 src/config/schema/config-schema.ts |
| structure/config.md:310 | cadence resolver src/config/feature-flags.ts |
| structure/overview.md:47 | OPENCODEX_HOME 공개 경로 src/config.ts 유지(getConfigDir 재수출) |
| structure/subagents.md:45 | getDefaultConfig 공개 src/config.ts, 구현 src/config/proxy-env.ts |
| structure/subagents.md:48 | pin 구현 src/config/load-degrade.ts mergeConfigDefaults |
| structure/providers/openai-tiers.md:326 | classifyOpenAiTierBackup src/config/openai-tier-backup.ts |
| ADR-0016:8, ADR-0020:8/10, ADR-0003:8 | 수정 금지 |
| INDEX.md:107 | 수동 수정 금지. src/config/는 1단에 이미 청구됨 |
| manifest.json | 변경 없음. structure:index 불필요 |
| layout.json / test-layout-expected.json | 등록하지 않음 |

runtime.md:31은 파사드 한 칸이다. 각 PR에서 그 PR이 만든 리프만 백틱한다. 없는 경로를 백틱하면 structure:check가 git index 기준으로 실패한다.

## 소스 오라클 (파사드 경로 유지)

tests/config/config-mutation-lock.test.ts:84,151,395 — pathToFileURL(repoPath("src/config.ts")).href로 자식이 withConfigMutationLockSync를 import. 리프 URL로 바꾸지 마라. :5 정적 import도 ../../src/config.

tests/codex-integration/codex-config-generation.test.ts:31 — 동일. :25가 bumpConfigGeneration, mutatePersistedConfig, observeConfigGeneration, readConfigGeneration, saveConfig, saveConfigPreservingClaudeCode, withExpectedConfigGenerationSync를 파사드에서 import.

tests/usage/user-cost-overlay-live-reconcile.test.ts:113,175,239 — 자식 await import("./src/config.ts"). :5 정적 import도 파사드.

tests/service/init-eof.test.ts:190 — mock.module("./src/config.ts")가 initializePersistedConfigIfMissing를 감싼다. 심볼이 파사드에 있어야 mock가 잡는다. :182는 configApi spread, :252는 withConfigMutationLockSync 실호출.

tests/config/config-save-boundary.test.ts — src/config.ts 본문을 읽지 않는다. GUARDED_FILES와 server/index.ts의 armClaudeCodeBaseline 리터럴을 읽는다. arm 심볼이 파사드 재수출이면 index.ts 불변.

## INV 승계

INV-WS-01 structure/overview.md:84. Enforced by tests/codex-integration/codex-catalog.test.ts (파일 1행 주석 유지). 구현 모듈 src/config/feature-flags.ts websocketsEnabled. 테스트 import 경로는 파사드. 테스트 파일 이동·개명 금지. 이 파일을 묶는 다른 INV는 없다.

INV-TESTS-01 — 신규 테스트 없음. config 도메인 match는 layout.json:138-141. 새 테스트가 생기면 tests/config/config-*.test.ts로 두고 두 맵에 explicit 등록한다. 이 사이클은 등록하지 않는다.

## 소비자 (파사드 유지, write set 밖)

src/config.ts를 import하는 테스트는 176곳. 경로를 리프로 바꾸지 않는다. 새 리프를 router.ts·server/lifecycle.ts·server/responses/core.ts가 직접 import하지 않는다.

---

## PR 1 — warn-memo + tier-backup + flags + proxy-env

초안 PR1(tier-backup+flags+proxy-env)에 warn-memo를 당긴다. 세 모듈은 서로 독립이고, warn-memo는 salvage/load-degrade보다 먼저 소유권이 갈라져야 한다. base L5. 비-tip이면 커밋 제목 [skip ci] 가능.

### NEW

src/config/warn-memo.ts 예상 28줄. 원본 440-450. 위 has/mark API 추가만 허용.

src/config/openai-tier-backup.ts 예상 295줄. 원본 177-439. sameBytes·isAlreadyExistsError 비공개 동반. import: node:fs chmodSync/copyFileSync/existsSync/linkSync/readFileSync/truncateSync/unlinkSync/writeFileSync, fsConstants, getConfigPath, nextAtomicTempSequence, isMissingPathError, hardenSecretPath, forgetEphemeralSecretPath.

src/config/feature-flags.ts 예상 78줄. 원본 3836-3890. import type { OcxConfig } from "../types".

src/config/proxy-env.ts 예상 215줄. 원본 4293-4472. import: DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODELS_VERSION, MULTI_AGENT_SURFACE_ADVISORY_VERSION, OPENAI_PROVIDER_TIER_VERSION, DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES, describeProxyForLog, readWindowsSystemProxy, type OcxConfig, type OcxRuntimeRole.

### MODIFY

src/config.ts: 177-439 삭제 후 re-export. 440-450 삭제 후 warn-memo import+re-export. 3836-3890 삭제 후 re-export. 4293-4472 삭제 후 re-export. 잔여 load-degrade가 warnedInheritedFastWireConflicts를 쓰므로 warn-memo has/mark로 2564-2565를 치환. salvage 4474/4674/4686도 동일. 본문 로직은 바꾸지 않는다.

structure/config.md:62,201,310 — 구현 경로 병기. 없는 리프를 미리 적지 말 것.

structure/providers/openai-tiers.md:326 — classifyOpenAiTierBackup → src/config/openai-tier-backup.ts.

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

tests/server/proxy-env.test.ts, tests/config/config-catalog-auto-refresh.test.ts, tests/codex-integration/catalog-auto-refresh-scheduler.test.ts, tests/codex-integration/codex-catalog.test.ts (INV-WS-01), tests/codex-integration/codex-shim-autorestore.test.ts, tests/service/init-backup-cleanup.test.ts, tests/adapters/openai/openai-provider-option-startup.test.ts, tests/config/config-load-degrade.test.ts.

예상: config.ts 4,707-263-11-55-180+재수출≈20 ≈ 4,218.

---

## PR 2 — schema

salvage·load-degrade·diagnostics가 configSchema를 쓰므로 그들보다 앞선다. 초안 PR5를 여기로 당긴다.

### NEW

src/config/schema/leaf-validators.ts 예상 860줄. 원본 452-1247에서 711-732를 뺀다. 711-732는 파사드 상단 기존 provider-name/provider-validation re-export와 합친다.

src/config/schema/config-schema.ts 예상 640줄. 원본 1248-1822 그대로. 첫 import는 ./leaf-validators의 스키마들. export const configSchema. 파사드는 configSchema를 재수출하지 않는다.

### MODIFY

src/config.ts: 452-1822 삭제. import { configSchema } from "./config/schema/config-schema"; (loadConfig·salvage·diagnostics가 아직 파사드에 있으면 로컬 바인딩). 711-732를 상단으로 이동.

structure/config.md:49 근처에 src/config/schema/leaf-validators.ts와 src/config/schema/config-schema.ts 백틱. :224에 schema 리프가 provider-validation을 소비한다고 적는다.

### 회귀

tests/config/config-load-degrade.test.ts, tests/config/model-pinned-effort-config.test.ts, tests/server/config.test.ts, tests/routing/routing-profile.test.ts, tests/routing/routing-compatibility-boundaries.test.ts, tests/web-search/web-search-passthrough-bridge.test.ts, tests/providers/provider-cost-overlay-config.test.ts.

함정: superRefine 본문이 원본 1248-1822와 export/import 외 일치. git diff로 확인.

예상: config.ts ≈ 4,218-774-575+import ≈ 2,890.

---

## PR 3 — salvage + load-degrade

초안 PR2 salvage를 schema 뒤로, 초안 PR5 load-degrade를 같은 PR로 모은다. 둘 다 configSchema와 warn-memo가 필요하다.

### NEW

src/config/salvage.ts 예상 275줄. 원본 4473-4707. import: configSchema from ./schema/config-schema, has/markWarnedConfigFallback from ./warn-memo, redactSecretString, z from zod/v4, copyFileSync/chmodSync/existsSync, CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR.

src/config/load-degrade.ts 예상 900줄. 원본 1823-2578 + 2703-2775. import: leaf schemas, warn-memo inherited API, provider-validation, fastwire, redact, MODEL_ALIAS_PATTERN, MODEL_DISCOVERY_MAX_MODELS.

### MODIFY

src/config.ts: 1823-2578, 2703-2775, 4473-4707 삭제. loadConfig(2579-2701) 잔류. 2631-2644 인라인 병합을 mergeConfigDefaults(parsed) 호출로 치환.

structure/config.md:67 — salvage 구현 src/config/salvage.ts.
structure/subagents.md:48 — pin 구현 src/config/load-degrade.ts mergeConfigDefaults.

재수출: hardenExistingSecret, retryOn429PolicyConfigError from load-degrade. backupInvalidConfig from salvage.

### 회귀

tests/config/config-load-degrade.test.ts, tests/config/config-user-edits.test.ts, tests/routing/fastwire-policy.test.ts, tests/server/config.test.ts, tests/config/settings-stream-mode.test.ts.

예상: config.ts ≈ 2,890-829-235+import ≈ 1,850.

---

## PR 4 — mutation-lock + persist-unlocked + diagnostics

diagnostics는 salvage·load-degrade·schema·getDefaultConfig가 필요하다. persist-unlocked는 clientConnectionSchema가 필요하다. mutation-lock은 독립이나 persist를 잠금 모듈에 넣지 않기 위해 같은 PR에서 persist-unlocked를 만든다.

### NEW

src/config/mutation-lock.ts 예상 275줄. 원본 3400-3626. persistConfigUnlocked 주석 3618-3626은 persist-unlocked.ts로 옮긴다.

src/config/persist-unlocked.ts 예상 130줄. 본문 순서: readRawConfigJson(4156-4172), failClosedClientPersistenceError(3811-3834), persistConfigUnlocked(3628-3664). mutation-lock을 import하지 않음.

src/config/diagnostics.ts 예상 690줄. 원본 2777-3399. import: getDefaultConfig from ./proxy-env, salvageConfigCandidate from ./salvage, load-degrade 헬퍼, configSchema, leaf-validators 스키마.

### MODIFY

src/config.ts: 2777-3399, 3400-3626, 3628-3664, 3811-3834, 4156-4172 삭제.

initializePersistedConfigIfMissing(3669-3703)와 saveConfig(3705-3721)는 잔류. 상단 import를 물리적으로 분리한다.

    // create-only path — never persist-unlocked / atomicWriteFile
    import { publishInitialConfigNoReplace, type InitialConfigPublicationIO } from "./config/initialize";
    import { observeInitialConfigState } from "./config/diagnostics";

    // replace path — never publishInitialConfigNoReplace
    import { persistConfigUnlocked } from "./config/persist-unlocked";

    import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./config/mutation-lock";

structure/config.md:14-22 — 치환 쓰기가 persist-unlocked.ts의 persistConfigUnlocked → atomicWriteFile임을 명시. 병합 금지.
structure/runtime.md:31 — mutation-lock.ts, persist-unlocked.ts, diagnostics.ts 백틱.

재수출: mutation-lock 공개 심볼, diagnostics 공개 심볼. persistConfigUnlocked는 재수출하지 않는다.

### 회귀

tests/config/config-mutation-lock.test.ts (오라클 :84 :151 :395), tests/codex-integration/codex-config-generation.test.ts:31, tests/codex-integration/codex-admission-primitives.test.ts, tests/config/config-load-degrade.test.ts, tests/server/loopback-listener-admission.test.ts, tests/service/init-eof.test.ts:190.

예상: config.ts ≈ 1,850-623-227-37-24-17+import ≈ 950.

---

## PR 5 — live-reconcile (레인 tip)

diagnostics·persist-unlocked·mutation-lock·load-degrade가 필요하다. 이 PR이 tip이므로 커밋 제목에 [skip ci]를 붙이지 않는다.

### NEW

src/config/live-reconcile.ts 예상 450줄. 원본 3892-3904 주석 + 3906-4154 + 4174-4291.

import: withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite from ./mutation-lock; persistConfigUnlocked, readRawConfigJson from ./persist-unlocked; configDiagnosticsFromRaw, readConfigDiagnostics from ./diagnostics; normalizePersistedClaudeCode from ./load-degrade. 파사드를 import하지 않는다.

### MODIFY

src/config.ts: 3892-4154, 4174-4291 삭제. armClaudeCodeBaseline, adoptPersistedProviderIntoLiveConfig, claudeCodeBaselineArmed, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode를 live-reconcile에서 재수출.

structure/config.md에 live-reconcile WeakMap 소유 한 문장. runtime.md:31에 live-reconcile.ts 백틱.

### 잔여 파사드 골격

loadConfig(2579-2701), initializePersistedConfigIfMissing(3669-3703), saveConfig(3705-3721), mutatePersistedConfig(3752-3810), persistedConfigMutationBeforeCommitForTests(3733)와 setter(3736). atomicWriteFile은 initialize에 없다.

### 회귀

tests/config/config-user-edits.test.ts, tests/config/config-save-boundary.test.ts, tests/usage/user-cost-overlay-live-reconcile.test.ts:113,175,239, tests/codex-integration/codex-config-generation.test.ts, tests/lab/core-lab-boundary.test.ts.

예상: live-reconcile 450, config.ts ≈ 560. wc -l src/config.ts src/config/*.ts src/config/schema/*.ts 전부 1,999 이하.

## 수락 기준

1. src/config.ts ≤ 1,999, 새 모듈 전부 ≤ 1,999.
2. initializePersistedConfigIfMissing가 persist-unlocked를 import하지 않고, persist-unlocked가 initialize를 import하지 않는다. atomicWriteFile은 save 경로에만 있다.
3. configSchema superRefine 본문이 원본과 동일(export/import 제외). 키 그룹 분할 없음.
4. warned* 세 값이 warn-memo.ts에만 있다. salvage와 load-degrade가 has/mark만 호출한다.
5. WeakMap 세 개가 live-reconcile.ts에만 있고 armClaudeCodeBaseline이 liveConfigBaseline과 claudeCodeBaseline을 함께 set한다.
6. 오라클 4개가 계속 repoPath("src/config.ts") 또는 import("./src/config.ts") 또는 mock.module("./src/config.ts")를 쓴다.
7. INV-WS-01 테스트 경로 불변. layout.json 불변. ADR 3개 불변. INDEX.md 수동 편집 없음.
8. 공개 export 집합이 PR 전후 동일. persistConfigUnlocked와 configSchema를 파사드 공개 표면에 추가하지 않는다.

