// Best-effort regression lint data for known dependency edges and bindings, not a
// security boundary or completeness proof. Runtime mutation guards enforce authority.
export const updateStaticImports: Readonly<Record<string, readonly string[]>> = {
  "bin/ocx.mjs": [
    "import { guardedRun, guardedSpawn, guardedSpawnSync, guardedExit, probeProcessAlive, relayOwnSignal } from \"../src/update/mutation-guard.mjs\";",
    "import { probeSpawn, probeSpawnSync } from \"../src/update/mutation-guard.mjs\";",
    "import { createSupervisionLatch, inspectDesktopSupervision } from \"../src/service/desktop-supervision.mjs\";",
    "import { planDesktopCliHandoff, runDesktopCliHandoff } from \"../src/lib/desktop-cli-handoff.mjs\";",
    "import { desktopCliRecordPath } from \"../src/lib/desktop-cli-record.mjs\";",
    "import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from \"../src/update/stop-contract.mjs\";",
    "import { probeProxyLiveness } from \"../src/update/proxy-liveness-probe.mjs\";",
    "import { decidePostStopUpdate } from \"../src/update/stop-decision.mjs\";",
    "import { createUpdateServiceHomePolicy, isUpdateHomeProbe, parseUpdateWorkerHome, UPDATE_HOME_LAUNCHER_PROTOCOL, UPDATE_PACKAGE_ONLY_EXIT_CODE, UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION } from \"../src/update/service-home-policy.mjs\";",
    "import { probeUpdateServiceHome, supportsUpdateHomeProbe, updateHomeProbeEnvironment } from \"../src/update/service-home-probe.mjs\";",
    "import { inspectPackageRuntimeLiveness, planStoppedRuntimeRecovery, planUpdateRuntimeHandling, } from \"../src/update/runtime-ownership.mjs\";",
    "import { inspectInstallStateBytes, selectAuthoritativeServiceState, serviceStateFilesFor, } from \"../src/service/install-state-contract.mjs\";",
    "import { acquireOwnershipMutationLease, ownershipMutationLeaseChildEnvironment, unprivilegedOwnershipMutationEnvironment, } from \"../src/service/ownership-mutation-lease.mjs\";",
    "import { randomBytes } from \"node:crypto\";",
    "import { createRequire } from \"node:module\";",
    "import { existsSync, readFileSync, readdirSync } from \"node:fs\";",
    "import { homedir } from \"node:os\";",
    "import { dirname, join, resolve } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "import { isRealBunBinary } from \"../src/lib/bun-binary-validator.mjs\";",
    "import { scopeTranspilerCacheToRuntime } from \"../src/lib/bun-transpiler-cache-scope.mjs\";",
    "import { findDesktopCli, findPathBun } from \"../src/lib/bun-path-runtime.mjs\";",
    "import { npmInvocation } from \"../src/update/npm-invocation.mjs\";",
    "import { runNpmInstall } from \"../src/update/npm-install.mjs\";",
    "import { pnpmInvocationForPath, resolvePnpmCommands } from \"../src/update/pnpm-invocation.mjs\";",
    "import { detectInstallOwnershipFromPath } from \"../src/update/install-detection.mjs\";",
    "import { pnpmOwnerInvocation, resolvePnpmGlobalOwner, runPnpmGlobalUpdate, } from \"../src/update/pnpm-global-install.mjs\";",
    "import { PNPM_READ_CWD, withPnpmCommandCwd, pnpmReadEnvironment } from \"../src/update/pnpm-read-policy.mjs\";",
    "import { checkRegistryPackageIntegrity } from \"../src/update/registry-integrity.mjs\";",
    "import { hasPendingTeardownIn } from \"../src/config/pending-teardown-names.mjs\";",
    "import { npmCachePreflightFailureMessage, resolveNpmCachePath, runNpmCachePreflight, } from \"../src/update/npm-cache-preflight.mjs\";",
    "import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from \"../src/update/tray-update-plan.mjs\";",
    "import { bootRestoreProbe, launcherUsableAfterNpmUpdate, transactionalNpmUpdate as transactionalNpmUpdateSync, transactionalNpmUpdateAsync } from \"../src/update/transactional-install.mjs\";",
    "import { manualUpdateFailureGuidance, npmUpdateFailureGuidance } from \"../src/update/update-failure-guidance.mjs\";",
    "import { captureCodexCliTransportEnv, CODEX_CLI_TRANSPORT_ENV_KEYS, CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS, codexCliInspectionLookupSeeds, carriesCodexCliUpdateInspectionContext, isCodexCliUpdateInspectionArgv, } from \"../src/update/codex-cli-update-launch-policy.mjs\";",
    "import { freshServingPid, hasRestartableServiceManager, readParentPid, readServiceManagerPid, restartServiceManagerJob, supervisionVerdict, unsettledManagerWarning, unsupervisedRuntimeWarning, } from \"../src/update/supervised-recovery.mjs\";"
  ],
  "src/update/async-check.ts": [
    "import { probeSpawn } from \"./mutation-guard.mjs\";",
    "import { unprivilegedOwnershipMutationEnvironment } from \"../service/ownership-mutation-lease.mjs\";",
    "import { PKG, registrySpawnTarget, type Channel, type Installer } from \"./index\";",
    "import { PNPM_READ_CWD, pnpmReadEnvironment } from \"./pnpm-read-policy.mjs\";"
  ],
  "src/update/badge.ts": [
    "import { currentVersion, defaultUpdateTag, detectInstall, type Channel } from \"./index\";",
    "import { CACHE_MAX_AGE_MS, isNewer, isSourceBuildVersion, readVersionCache } from \"./notify\";"
  ],
  "src/update/bind-probe.ts": [
    "import { probeSpawnSync } from \"./mutation-guard.mjs\";"
  ],
  "src/update/check-types.ts": [],
  "src/update/codex-cli-update-launch-policy.mjs": [],
  "src/update/desktop-badge.ts": [
    "import { defaultUpdateTag } from \"./index\";"
  ],
  "src/update/guarded-port-reclaim.ts": [
    "import { reclaimListenPort, type ReclaimListenPortOptions } from \"../server/port-reclaim\";"
  ],
  "src/update/guarded-runtime-ops.ts": [
    "import { isProcessAlive, waitForExit } from \"../lib/process-control\";",
    "import { atomicWriteFile } from \"../config/atomic-write\";",
    "import { removePid, removeRuntimePort } from \"../config/process-state\";",
    "import { dropWindowsTcpRowsForLocalPort } from \"../server/windows-tcp-drop\";",
    "import { stopWinswService } from \"../lib/winsw\";",
    "import { stopWindows } from \"../service\";",
    "import { killWindowsSchedulerWrappers } from \"../lib/windows-service-wrappers\";",
    "import { guardedRun, guardedKill, guardedExecFileSync, materializeMutationData, UpdateMutationRefusedError, type UpdateMutationAuthorizer } from \"./mutation-guard.mjs\";"
  ],
  "src/update/guarded-tray-ops.ts": [
    "import { getWindowsTrayStatus, startWindowsTray, stopWindowsTray } from \"../tray/windows\";",
    "import { guardedRun, UpdateMutationRefusedError, type UpdateMutationAuthorizer } from \"./mutation-guard.mjs\";"
  ],
  "src/update/index.ts": [
    "import { guardedRun, guardedSpawn, guardedSpawnSync } from \"./mutation-guard.mjs\";",
    "import { probeSpawn, probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { createSupervisionLatch, inspectDesktopSupervision } from \"../service/desktop-supervision.mjs\";",
    "import { manualUpdateFailureGuidance } from \"./update-failure-guidance.mjs\";",
    "import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from \"./stop-contract.mjs\";",
    "import { proxyIdentityAt } from \"../server/proxy-liveness\";",
    "import { probeProxyLiveness } from \"./proxy-liveness-probe.mjs\";",
    "import { decidePostStopUpdate } from \"./stop-decision.mjs\";",
    "import { existsSync, readFileSync, readdirSync } from \"node:fs\";",
    "import { fileURLToPath } from \"node:url\";",
    "import { dirname, join, resolve } from \"node:path\";",
    "import { getConfigDir, loadConfig } from \"../config\";",
    "import { readPid, readRuntimePort, getRuntimePortPath } from \"../config/process-state\";",
    "import { pendingTeardownOutstanding } from \"../config/pending-teardown\";",
    "import { planUpdateRuntimeHandling, planStoppedRuntimeRecovery, inspectPackageRuntimeLiveness } from \"./runtime-ownership.mjs\";",
    "import { unprivilegedOwnershipMutationEnvironment } from \"../service/ownership-mutation-lease.mjs\";",
    "import { withUpdateOwnershipLease, readUpdateRuntimeTarget } from \"./ownership-transaction\";",
    "import { createUpdateServiceHomePolicy, parseUpdateWorkerHome, UPDATE_PACKAGE_ONLY_EXIT_CODE } from \"./service-home-policy.mjs\";",
    "import { npmInvocation } from \"./npm-invocation.mjs\";",
    "import { pnpmInvocation, pnpmInvocationForPath, resolvePnpmCommands } from \"./pnpm-invocation.mjs\";",
    "import { detectInstallOwnershipFromPath } from \"./install-detection.mjs\";",
    "import { pnpmOwnerInvocation, readPnpmGlobalPackage, resolvePnpmGlobalOwner, runPnpmGlobalUpdate, } from \"./pnpm-global-install.mjs\";",
    "import { checkRegistryPackageIntegrity } from \"./registry-integrity.mjs\";",
    "import { npmCachePreflightFailureMessage, runNpmCachePreflight, } from \"./npm-cache-preflight.mjs\";",
    "import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from \"./tray-update-plan.mjs\";",
    "import { withProcessRuntimeProvenance } from \"../lib/bun-runtime\";",
    "import { withoutSiblingMarker } from \"../codex/sibling-start\";",
    "import { packageVersion } from \"../lib/package-version\";",
    "import { isStandaloneModuleUrl } from \"../lib/standalone\";",
    "import { selfLaunchArgv } from \"../lib/self-launch-argv\";",
    "import { PNPM_READ_CWD, withPnpmCommandCwd, pnpmReadEnvironment } from \"./pnpm-read-policy.mjs\";",
    "import { freshServingPid, hasRestartableServiceManager, readParentPid, readServiceManagerPid, restartServiceManagerJob, supervisionVerdict, unsettledManagerWarning, unsupervisedRuntimeWarning, } from \"./supervised-recovery.mjs\";"
  ],
  "src/update/install-detection.mjs": [
    "import { existsSync, readFileSync, realpathSync, statSync } from \"node:fs\";"
  ],
  "src/update/job-pinned-start.ts": [
    "import { guardedSpawn } from \"./mutation-guard.mjs\";",
    "import { closeSync, mkdirSync, openSync, writeSync } from \"node:fs\";",
    "import { join } from \"node:path\";",
    "import { getConfigDir } from \"../config\";",
    "import { withoutSiblingMarker } from \"../codex/sibling-start\";"
  ],
  "src/update/job-supervised-restart.ts": [
    "import { readRuntimePort } from \"../config/process-state\";",
    "import { proxyIdentityAt } from \"../server/proxy-liveness\";",
    "import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, updateServiceHomeRefusal, type UpdateServiceHomeInspector } from \"./service-home-authority\";",
    "import { guardedRun, UpdateMutationRefusedError } from \"./mutation-guard.mjs\";",
    "import { freshServingPid, hasRestartableServiceManager, readParentPid, readServiceManagerPid, restartServiceManagerJob, supervisionVerdict, unsettledManagerWarning, unsupervisedRuntimeWarning, } from \"./supervised-recovery.mjs\";"
  ],
  "src/update/job-update-home.ts": [
    "import { probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, type UpdateServiceHomeInspector } from \"./service-home-authority\";",
    "import { UPDATE_PACKAGE_ONLY_EXIT_CODE, UPDATE_WORKER_HOME_FLAG, updateWorkerHomeArgv } from \"./service-home-policy.mjs\";",
    "import { currentServiceHomes } from \"../service/state\";",
    "import { probeUpdatePackageOnlyLauncher, updateHomeProbeEnvironment } from \"./service-home-probe.mjs\";"
  ],
  "src/update/job-update-tray.ts": [
    "import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from \"./tray-update-plan.mjs\";"
  ],
  "src/update/job-windows-restart.ts": [
    "import { join } from \"node:path\";",
    "import { getConfigDir } from \"../config\";",
    "import { guardedStopWinsw, guardedStopWindows, guardedKillWindowsWrappers } from \"./guarded-runtime-ops\";",
    "import { readServiceBackend } from \"../service\";"
  ],
  "src/update/job.ts": [
    "import { guardedRun, guardedSpawnSync, materializeMutationData } from \"./mutation-guard.mjs\";",
    "import { probeSpawn, probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { existsSync, mkdirSync, readFileSync } from \"node:fs\";",
    "import { dirname, join, sep } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "import { atomicWriteFile, getConfigDir, loadConfig } from \"../config\";",
    "import { readPid, readRuntimePort, verifyPidIdentity } from \"../config/process-state\";",
    "import { isProcessAlive } from \"../lib/process-control\";",
    "import { selfLaunchArgv } from \"../lib/self-launch-argv\";",
    "import { buildWindowsElevatedArgumentList, resolveTrustedWindowsPowerShellExe, } from \"../lib/windows-elevation\";",
    "import { listListenPids, scanListenPids, type ListenPidScan } from \"../server/port-reclaim\";",
    "import { guardedReclaimListenPort as reclaimListenPort } from \"./guarded-port-reclaim\";",
    "import { guardedKillProxy, guardedRemovePid, guardedRemoveRuntimePort, guardedDropWindowsTcp, guardedPublishJob, type KillProxy } from \"./guarded-runtime-ops\";",
    "import { isHealthzVersion, isOpencodexHealthz, probeHostname, proxyIdentityAt, type HealthzIdentity, } from \"../server/proxy-liveness\";",
    "import { isServiceInstalled, isServiceViable } from \"../service\";",
    "import { stopWindowsServiceWrappersBestEffort } from \"./job-windows-restart\";",
    "import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, type UpdateServiceHomeInspector } from \"./service-home-authority\";",
    "import { runUpdateRestartWithOwnershipLease, type ServiceOwnershipResolution } from \"./restart-ownership\";",
    "import { restartServiceManagerAfterUpdate, unsettledManagerRestartFailure, unsupervisedRestartFailure, type ManagerRestartFn } from \"./job-supervised-restart\";",
    "import { type Channel, type Installer, PKG, STANDALONE_UPDATE_HINT, checkUpdatePackageIntegrity, currentVersion, defaultUpdateTag, detectInstall, detectInstallOwnership, latestVersion, miseUpdateCommand, updateCommand, updateCommandStr, resolveCurrentPnpmGlobalOwner, resolvePnpmActiveLauncher, } from \"./index\";",
    "import { isNewer } from \"./notify\";",
    "import { isRealBunBinary } from \"../lib/bun-binary-validator.mjs\";",
    "import { planWindowsTrayUpdate } from \"./tray-update-plan.mjs\";",
    "import { GUI_UPDATE_FAILURE_NEXT_STEP } from \"./update-failure-guidance.mjs\";",
    "import { npmCachePreflightFailureMessage, runNpmCachePreflight, type NpmCachePreflightReason, } from \"./npm-cache-preflight.mjs\";",
    "import { guiUpdateWorkerCommand } from \"./worker-launch\";",
    "import { prepareWorkerUpdateHome, packageOnlyUpdateSucceeded } from \"./job-update-home\";",
    "import { defaultWorkerTrayHandoff } from \"./job-update-tray\";",
    "import { spawnWorkerPinnedStart } from \"./job-pinned-start\";",
    "import { spawnBindProbe, strictBindProbeScript } from \"./bind-probe\";",
    "import { withoutUpdateTeardownHandover, withUpdateTeardownHandover } from \"./teardown-handover\";"
  ],
  "src/update/mise-launcher-target.ts": [
    "import { realpathSync } from \"node:fs\";",
    "import { dirname, isAbsolute, join } from \"node:path\";",
    "import { observePackageManifestAt, packageManifestPathIn, runningPackageRoot, } from \"../lib/package-tree-integrity\";",
    "import { readServiceInstallState, SERVICE_MANAGED_ENV } from \"../service/state\";",
    "import { detectInstallOwnershipFromPath, type InstallOwnership } from \"./install-detection.mjs\";"
  ],
  "src/update/mutation-guard.mjs": [
    "import { spawn, spawnSync, execFile, execFileSync } from \"node:child_process\";",
    "import { renameSync, rmSync, unlinkSync } from \"node:fs\";"
  ],
  "src/update/notify.ts": [
    "import { probeSpawn } from \"./mutation-guard.mjs\";",
    "import { existsSync, readFileSync } from \"node:fs\";",
    "import { join } from \"node:path\";",
    "import { isatty } from \"node:tty\";",
    "import { createInterface } from \"node:readline/promises\";",
    "import { atomicWriteFile, getConfigDir } from \"../config\";",
    "import { hasStarPromptRun } from \"../cli/star-prompt\";",
    "import { selfLaunchArgv } from \"../lib/self-launch-argv\";",
    "import { type Channel, currentVersion, detectInstall, latestVersion, runUpdate, updateCommandStr, updateTag, } from \"./index\";"
  ],
  "src/update/npm-cache-preflight.mjs": [
    "import { lstatSync, readdirSync, realpathSync, statSync } from \"node:fs\";",
    "import { probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { homedir } from \"node:os\";",
    "import { dirname, isAbsolute, resolve } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "import { npmInvocation } from \"./npm-invocation.mjs\";"
  ],
  "src/update/npm-install.mjs": [
    "import { guardedSpawn, materializeMutationData } from \"./mutation-guard.mjs\";",
    "import { dirname, join, win32 } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";"
  ],
  "src/update/npm-invocation.mjs": [
    "import { existsSync, realpathSync } from \"node:fs\";",
    "import { win32 } from \"node:path\";"
  ],
  "src/update/ownership-transaction.ts": [
    "import { readFileSync } from \"node:fs\";",
    "import { acquireOwnershipMutationLease, ownershipMutationLeaseChildEnvironment, unprivilegedOwnershipMutationEnvironment, } from \"../service/ownership-mutation-lease.mjs\";"
  ],
  "src/update/pnpm-global-install.mjs": [
    "import { existsSync, readFileSync, realpathSync, statSync } from \"node:fs\";",
    "import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from \"node:path\";",
    "import { pnpmInvocationForPath } from \"./pnpm-invocation.mjs\";",
    "import { verifyPnpmInstallTree } from \"./transactional-install.mjs\";"
  ],
  "src/update/pnpm-invocation.mjs": [
    "import { existsSync } from \"node:fs\";",
    "import { win32 } from \"node:path\";"
  ],
  "src/update/pnpm-owner-worker.ts": [
    "import { resolveCurrentPnpmGlobalOwner } from \"./index\";"
  ],
  "src/update/pnpm-read-policy.mjs": [
    "import { ownedArtifactUnlink } from \"./mutation-guard.mjs\";",
    "import { mkdtempSync, lstatSync, writeFileSync, rmdirSync } from \"node:fs\";",
    "import { tmpdir } from \"node:os\";",
    "import { dirname, join } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";"
  ],
  "src/update/proxy-liveness-probe.mjs": [
    "import { probeSpawnSync } from \"./mutation-guard.mjs\";"
  ],
  "src/update/refresh-scheduler.ts": [
    "import { checkForUpdate, type UpdateCheckResult } from \"./job\";",
    "import { currentVersion, defaultUpdateTag, detectInstall, detectInstallOwnership, miseUpdateCommand, type Channel, type Installer } from \"./index\";",
    "import { isSourceBuildVersion, readVersionCache, REFRESH_INTERVAL_MS, writeFreshVersionCache } from \"./notify\";",
    "import { latestVersionAsync } from \"./async-check\";"
  ],
  "src/update/registry-integrity.mjs": [],
  "src/update/restart-ownership.ts": [
    "import { resolveServiceOwnership } from \"../service\";",
    "import { serviceStatePaths } from \"../service/state\";",
    "import { acquireOwnershipMutationLease, OWNERSHIP_MUTATION_LEASE_TOKEN_ENV, } from \"../service/ownership-mutation-lease.mjs\";",
    "import { planUpdateRuntimeHandling } from \"./runtime-ownership.mjs\";",
    "import { createSupervisionLatch, inspectDesktopSupervision } from \"../service/desktop-supervision.mjs\";"
  ],
  "src/update/runtime-ownership.mjs": [],
  "src/update/service-home-authority.ts": [
    "import { isDeepStrictEqual } from \"node:util\";",
    "import { createHash } from \"node:crypto\";",
    "import { resolveCodexSqliteHome } from \"../codex/paths\";",
    "import { inspectNativeCodexOwnership, type OwnershipDeps } from \"../integrations/native/ownership-preflight\";",
    "import { compareServicePathToInstall, currentServiceHomes, inspectServiceStateEvidence, resolveServiceState, serviceStatePaths } from \"../service/state\";",
    "export { createUpdateServiceHomePolicy, updateServiceHomeRefusal } from \"./service-home-policy.mjs\";"
  ],
  "src/update/service-home-policy.mjs": [
    "import { createMutationAuthorizer } from \"./mutation-guard.mjs\";"
  ],
  "src/update/service-home-probe-entry.ts": [
    "import { inspectUpdateServiceHome } from \"./service-home-authority\";",
    "import { isUpdateHomeProbe } from \"./service-home-policy.mjs\";"
  ],
  "src/update/service-home-probe.mjs": [
    "import { parseUpdateHomeProbe, UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION } from \"./service-home-policy.mjs\";",
    "import { readFileSync, statSync } from \"node:fs\";",
    "import { dirname, join } from \"node:path\";"
  ],
  "src/update/stop-contract.mjs": [],
  "src/update/stop-decision.mjs": [
    "import { STOP_HISTORY_DEFERRED_EXIT_CODE, STOP_HISTORY_INCOMPLETE_EXIT_CODE, STOP_TEARDOWN_HANDED_OVER_EXIT_CODE, } from \"./stop-contract.mjs\";"
  ],
  "src/update/supervised-recovery.mjs": [
    "import { guardedRun, guardedSpawnSync, UpdateMutationRefusedError } from \"./mutation-guard.mjs\";"
  ],
  "src/update/teardown-handover.ts": [
    "import { clearPendingTeardown, isPendingTeardownAbandoned, listPendingTeardowns, pendingTeardownPathFor, pendingTeardownsAreExactly, readPendingTeardown, } from \"../config/pending-teardown\";",
    "import { isLikelyOcxProcess } from \"../config/process-state\";",
    "import { isProcessAlive } from \"../lib/process-control\";"
  ],
  "src/update/transactional-install.mjs": [
    "import { guardedRenameSync, ownedArtifactRm } from \"./mutation-guard.mjs\";",
    "import { probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { randomBytes } from \"node:crypto\";",
    "import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from \"node:fs\";",
    "import { basename, dirname, join } from \"node:path\";"
  ],
  "src/update/tray-update-plan.mjs": [],
  "src/update/update-failure-guidance.mjs": [
    "import { pnpmGlobalCommandArgs } from \"./pnpm-global-install.mjs\";"
  ],
  "src/update/worker-launch.ts": [
    "import { probeSpawn, probeSpawnSync } from \"./mutation-guard.mjs\";",
    "import { accessSync, constants, realpathSync, statSync } from \"node:fs\";",
    "import { dirname, isAbsolute } from \"node:path\";"
  ]
};
export const updateDeferredImports: readonly string[] = [
  "src/update/index.ts:resolvedRuntimeOwnership:{ resolveServiceOwnership } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ serviceStatePaths } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ inspectUpdateServiceHome } = await import(\"./service-home-authority\")",
  "src/update/index.ts:runUpdate:{ isServiceInstalled } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ getWindowsTrayStatus, guardedStartWindowsTray, guardedStopWindowsTray } = await import(\"./guarded-tray-ops\")",
  "src/update/index.ts:runUpdate:{ serviceReinstallArgs, isServiceViable } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ guardedStartWindowsTray } = await import(\"./guarded-tray-ops\")",
  "src/update/index.ts:runUpdate:{ guardedStartWindowsTray } = await import(\"./guarded-tray-ops\")",
  "src/update/index.ts:runUpdate:{ isCodexShimInstalled } = await import(\"../codex/shim\")",
  "src/update/index.ts:runUpdate:{ serviceReinstallArgs } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ guardedReclaimListenPort: reclaimListenPort } = await import(\"./guarded-port-reclaim\")",
  "src/update/index.ts:runUpdate:{ isServiceViable } = await import(\"../service\")",
  "src/update/index.ts:runUpdate:{ guardedStartWindowsTray } = await import(\"./guarded-tray-ops\")",
  "src/update/job-update-tray.ts:defaultWorkerTrayHandoff:{ getWindowsTrayStatus, guardedStartWindowsTray, guardedStopWindowsTray } = await import(\"./guarded-tray-ops\")",
  "src/update/job.ts:restartAfterUpdate:{ serviceReinstallArgs } = await import(\"../service\")"
];
// Existing trusted wrapper internals: each complete expression is reviewed.
// Import permission does not grant a wrapper arbitrary loader/global access.
export const updateBoundaryRootSites = new Map([
  ['src/update/mutation-guard.mjs:materializeMutationData:Reflect.ownKeys(value)', 'enumerate own string/symbol keys before authorization'],
  ['src/update/mutation-guard.mjs:guardedKill:process.kill.bind(process)', 'native signal adapter consumed by guardedRun after materialization and authorization'],
  ['src/update/mutation-guard.mjs:guardedExit:process.exit.bind(process)', 'native terminal adapter consumed by guardedRun after materialization and authorization'],
  ['src/update/mutation-guard.mjs:probeProcessAlive:process.kill(materializeMutationData(pid), 0)', 'signal-zero liveness observation only'],
  ['src/update/mutation-guard.mjs:relayOwnSignal:process.kill(process.pid, materializeMutationData(signal))', 'ordinary launcher signal relay to this process only'],
]);
