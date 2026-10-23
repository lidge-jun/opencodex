import { diagnoseService, type ServiceDiagnostic } from "./diagnostics";
import { desktopLoginStatusSummary, diagnoseDesktopStartup } from "./desktop-startup";
import { confirmServiceServing } from "./health";
import { ownershipMutationLeaseStatusLine } from "./ownership-mutation-lease.mjs";
import { LABEL, TASK, serviceLogPath, serviceStatePaths } from "./state";
import { WINSW_SERVICE_ID } from "../lib/winsw";
import { runPassiveRead } from "../lib/passive-read";

/** The service manager holding the registration; `none` when nothing is registered. */
export type ServiceStatusBackend = "launchd" | "systemd" | "schtasks" | "winsw" | "none";

/**
 * `ocx service status --json`. Additive within `schemaVersion: 1`.
 *
 * `running` is the service manager's own verdict — the value `ocx status --json` already
 * reports as `startup.serviceRunning` — and `serving` says separately whether a proxy
 * answers on the installed port, because a loaded job that never bound is the failure the
 * text report exists to show.
 */
export interface ServiceStatusJson {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  supported: boolean;
  backend: ServiceStatusBackend;
  label: string | null;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  stale: boolean;
  conflict: boolean;
  serving: { probed: boolean; ok: boolean; port: number | null };
  summary: string;
  logPath: string;
  ownershipLease: string | null;
  desktopLogin: string | null;
}

export interface ServiceStatusJsonDeps {
  platform?: NodeJS.Platform;
  diagnose?: () => ServiceDiagnostic;
  serving?: () => Promise<{ ok: boolean; port: number }>;
  logPath?: () => string;
  leaseLine?: () => string | null;
  desktopLogin?: () => string | null;
}

export function serviceStatusBackend(diag: ServiceDiagnostic): ServiceStatusBackend {
  if (!diag.supported || !diag.installed) return "none";
  switch (diag.backend) {
    case "launchd": return "launchd";
    case "systemd": return "systemd";
    case "scheduler": return "schtasks";
    case "native": return "winsw";
    default: return "none";
  }
}

const BACKEND_LABEL: Record<ServiceStatusBackend, string | null> = {
  launchd: LABEL,
  systemd: `${TASK}.service`,
  schtasks: TASK,
  winsw: WINSW_SERVICE_ID,
  none: null,
};

/**
 * Passive by construction: it performs the reads `ocx service status` already performs
 * (manager diagnosis, the loopback serving probe only when a registration exists, the
 * ownership-lease and Desktop login lines) and nothing else. The caller answers before
 * `platformOps()` is resolved, so no install, start, stop or repair path is reachable.
 * The whole collection runs in a passive-read scope: the serving probe resolves the port
 * through loadConfig(), which outside that scope hardens config modes and backs up a
 * malformed config — writes an inventory read must not make.
 */
export function collectServiceStatusJson(deps: ServiceStatusJsonDeps = {}): Promise<ServiceStatusJson> {
  return runPassiveRead(() => collectPassively(deps));
}

async function collectPassively(deps: ServiceStatusJsonDeps): Promise<ServiceStatusJson> {
  const diag = (deps.diagnose ?? diagnoseService)();
  const backend = serviceStatusBackend(diag);
  let serving: ServiceStatusJson["serving"] = { probed: false, ok: false, port: null };
  if (diag.installed) {
    // A probe that throws (config load, port resolution) must not cost the caller the whole
    // document; it is reported as probed, not serving, with no port.
    try {
      const result = await (deps.serving ?? (() => confirmServiceServing({ timeoutMs: 1_500 })))();
      serving = { probed: true, ok: result.ok, port: result.port };
    } catch {
      serving = { probed: true, ok: false, port: null };
    }
  }
  const desktopLogin = deps.desktopLogin ?? (() => {
    const desktop = diagnoseDesktopStartup();
    return desktop ? desktopLoginStatusSummary(desktop) : null;
  });
  return {
    schemaVersion: 1,
    platform: deps.platform ?? process.platform,
    supported: diag.supported,
    backend,
    label: BACKEND_LABEL[backend],
    installed: diag.installed,
    enabled: diag.enabled,
    running: diag.running,
    viable: diag.viable,
    stale: diag.stale,
    conflict: diag.conflict,
    serving,
    summary: diag.summary,
    logPath: (deps.logPath ?? serviceLogPath)(),
    ownershipLease: (deps.leaseLine ?? (() => ownershipMutationLeaseStatusLine(serviceStatePaths())))() ?? null,
    desktopLogin: desktopLogin(),
  };
}
