/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */

export type { ServiceBackend, ServiceInstallState, ServiceStateEvidence } from "./service/state";
export { SERVICE_MANAGED_ENV, stableLauncherEntry, serviceLogPath, serviceStatePathsForOpenCodexHome, parseServiceInstallState, inspectServiceStateEvidence, currentServiceHomes, serviceHomeMatches, readServiceBackend, serviceReinstallArgs, serviceInstallArgs } from "./service/state";
export type { ServiceApiTokenOrigin, ProvisionedServiceApiToken } from "./service/guards";
export { ServiceOwnershipError, isServiceOwnershipError, serviceEnvironmentOwnedHere, assertServiceEnvironmentMatchesInstall, serviceRetryCommand, assertNotAdminToken, assertServiceAuthEnvironment, writeServiceApiTokenFile, assertLiveServiceManagerAllowed } from "./service/guards";
export { resolveServiceListenPort, installedServiceListenPort, SERVICE_INSTALL_HEALTH_MS, SERVICE_INSTALL_HEALTH_WINDOWS_MS, serviceInstallHealthMs, confirmServiceServing, reportServiceServing, resolvedProxyEnv } from "./service/health";
export type { LaunchdLoadState, LaunchdLoadProbe, LaunchdInstallOutcome } from "./service/launchd";
export { buildPlist, reusePreviousPlistPathVariable, expectedLaunchdCommand, launchdListenPort, runLaunchctl, launchctlLoadFailed, launchdJobMatchesPlist, launchdEvictionTargets, probeLaunchdLoadState, installLaunchd, restartLaunchdJob, startLaunchd } from "./service/launchd";
export { systemdListenPort, buildUnit, systemdNeedsDaemonReload, uninstallSystemd, systemdServiceInstallCleanupOps } from "./service/systemd";
export type { WindowsSchedulerTaskProbe, WindowsSchedulerProxyProbe, WindowsSchedulerInstallVerification, WindowsSchedulerRollbackDeps, ElevatedReconciliationOutcome, FinalizeWindowsSchedulerResult, FinalizeWindowsSchedulerOptions } from "./service/windows-scheduler";
export { decodeSchtasksOutput, setQuerySchtasksForTests, formatWindowsSchedulerServiceStatus, inspectWindowsSchedulerServiceStatus, windowsSchedulerCsvIncludesTask, probeWindowsSchedulerTask, windowsSchedulerTaskInstalled, evaluateWindowsSchedulerInstallVerification, verifyWindowsSchedulerInstall, rollbackWindowsSchedulerTaskOwnedByAttempt, setFinalizeWindowsSchedulerHooksForTests, schedulerVerificationMaySettle, finalizeWindowsSchedulerServiceRegistration, evaluateSchedulerInstallRestartReconciliation } from "./service/windows-scheduler";
export type { WindowsSchedulerXmlState } from "./service/windows-taskxml";
export { buildWindowsServiceScript, buildWindowsSchtasksCreateArgs, buildWindowsSchtasksCreateArgsForXml, buildWindowsLauncherVbs, buildWindowsTaskXml, buildWindowsTaskXmlDocument, windowsTaskRegistrationOwnedByAttempt, windowsTaskRegistrationHealthy, readWindowsSchedulerXmlState } from "./service/windows-taskxml";
export type { WindowsSchedulerRegistrationStageDeps, FreshWindowsSchedulerRegistrationDeps, RemoveNativeWindowsServiceDeps } from "./service/windows-ops";
export { windowsListenPort, winswListenPort, writeServiceDefinitionFile, definitionCarriesCredential, stageWindowsSchedulerRegistrationXml, registerFreshWindowsSchedulerTask, removeNativeWindowsServiceForScheduler, assertWindowsNativeServiceAccountSupported, isWindowsSchedulerEndBenign, stopWindows, stopWindowsChecked, classifyWindowsServiceStop } from "./service/windows-ops";
export type { ServiceRepairVerb, RepairServiceDeps } from "./service/repair";
export { repairService } from "./service/repair";
export type { ServiceInstallPreparationDeps, FreshWindowsSchedulerInstallDeps, ServiceStopOutcome, ServiceUninstallOutcome } from "./service/orchestration";
export { proxyStillLiveAfterStop, prepareServiceInstall, installServiceSafely, installFreshWindowsSchedulerSafely, installedServiceRespawnRisk, stopServiceIfInstalledDetailed, setUninstallServiceHooksForTests, uninstallServiceDetailed, uninstallServiceIfInstalled, isServiceInstalled, isServiceViable } from "./service/orchestration";
export type { ServiceDiagnostic, WindowsTaskDiagnosticIdentityDeps, WindowsServiceDiagnosticInputs, LaunchdServiceDiagnosticInputs } from "./service/diagnostics";
export { bakedServicePathsDiagnostic, serviceStartableFromTray, resolveWindowsTaskDiagnosticUserId, deriveWindowsServiceDiagnostic, deriveWindowsServiceDiagnosticForCurrentUser, deriveLaunchdServiceDiagnostic, diagnoseService, serviceStatusSummary, serviceStatusReport } from "./service/diagnostics";
export type { ParsedServiceArgs, ServiceInstallationState, ServiceInstallationProbe, ServiceInstallationProbeHooks, ServiceCommandPlan } from "./service/cli";
export { normalizeServiceSubcommand, probeServiceInstallation, selectServiceSubcommand, planServiceCommand, parseServiceArgs, serviceCommand } from "./service/cli";
