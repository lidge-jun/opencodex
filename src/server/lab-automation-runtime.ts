import { readConfigDiagnostics } from "../config";
import type { OcxConfig } from "../types";
import { setLabAutomationShutdownHook } from "./lifecycle";

type RuntimeOwner = {
  release: () => void;
};

const runtimeOwners = new Map<string, RuntimeOwner>();

function configKey(configDir?: string): string {
  return configDir ?? "";
}

function loadLatestConfig(fallback: OcxConfig): OcxConfig {
  try {
    return readConfigDiagnostics().config;
  } catch {
    return fallback;
  }
}

function installShutdownHook(): void {
  setLabAutomationShutdownHook(() => {
    const {
      requestLabAutomationShutdown,
      stopLabAutomationScheduler,
    } = require("../lab/automation/orchestrator") as typeof import("../lab/automation/orchestrator");
    requestLabAutomationShutdown();
    for (const [key, owner] of runtimeOwners) {
      stopLabAutomationScheduler(key || undefined);
      owner.release();
    }
    runtimeOwners.clear();
  });
}

/**
 * Lazily install the host-owned dispatch authority required by explicit Lab
 * automation requests. Importing this module alone does not load Lab runtime
 * code; the Lab graph is entered only when an explicit caller invokes this.
 */
export function ensureLabAutomationRuntime(config: OcxConfig, configDir?: string): void {
  const key = configKey(configDir);
  if (runtimeOwners.has(key)) return;

  const { setLabAutomationDispatchDeps } = require(
    "../lab/automation/orchestrator",
  ) as typeof import("../lab/automation/orchestrator");
  const { createProductionLabRouteExecutor } = require(
    "../lib/lab-live-route-production",
  ) as typeof import("../lib/lab-live-route-production");
  const loadConfig = () => loadLatestConfig(config);
  const release = setLabAutomationDispatchDeps({
    configDir,
    loadConfig,
    routeExecutor: createProductionLabRouteExecutor({ configDir, loadConfig }),
  });
  runtimeOwners.set(key, { release });
  installShutdownHook();
}

/** Test-only reset for direct management-route tests that do not own a server lifecycle. */
export function resetLabAutomationRuntimeForTests(): void {
  for (const owner of runtimeOwners.values()) owner.release();
  runtimeOwners.clear();
  setLabAutomationShutdownHook(null);
}
