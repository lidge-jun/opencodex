import { codexAutoStartEnabled } from "../config";
import { diagnoseService, type ServiceDiagnostic } from "../service";
import type { OcxConfig } from "../types";
import { getCodexRoutingKind, type CodexRoutingKind } from "./inject";
import { collectRoutingAdoption, type RoutingAdoptionEvidence } from "./routing-adoption";
import { diagnoseCodexShim, type CodexShimDiagnostic } from "./shim";

export type StartupProtection = "service" | "shim" | "none";
export type StartupHealthStatus = "native" | "protected" | "at-risk";
export type ShimCoverage = "full" | "cli-only" | "none";

export interface StartupHealthInputs {
  routingKind: CodexRoutingKind;
  autostartEnabled: boolean;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  platform: NodeJS.Platform;
  diagnosticStale?: boolean;
  routingAdoption?: RoutingAdoptionEvidence;
}

export interface StartupHealth {
  status: StartupHealthStatus;
  routingKind: CodexRoutingKind;
  routingInjected: boolean;
  localRoutingDependency: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: ShimCoverage;
  serviceSupported: boolean;
  platform: NodeJS.Platform;
  diagnosticStale: boolean;
  recommendedCommand: string | null;
  commands: {
    installService: string;
    repairService: string;
    installShim: string;
    restoreNative: string;
  };
  routingAdoption?: RoutingAdoptionEvidence;
}

const COMMANDS = {
  installService: "ocx service install",
  repairService: "ocx service repair",
  installShim: "ocx codex-shim install",
  restoreNative: "ocx restore",
} as const;

export function deriveStartupHealth(inputs: StartupHealthInputs): StartupHealth {
  const shimEffective = inputs.autostartEnabled && inputs.shimHealthy;
  const routingInjected = inputs.routingKind === "opencodex-local";
  const localRoutingDependency = inputs.routingKind === "opencodex-local"
    || inputs.routingKind === "custom-local"
    || inputs.routingKind === "unknown";
  // Script launchers never cover Codex Desktop/app-server surfaces. This is
  // intentionally conservative on every OS and for WSL-shared Codex homes.
  const shimCoverage: ShimCoverage = !shimEffective
    ? "none"
    : "cli-only";
  // We can only credit an opencodex service/shim for routing that opencodex owns.
  // An arbitrary localhost gateway has an independent lifecycle that OCX cannot repair.
  const ownsLocalRouting = inputs.routingKind === "opencodex-local";
  const protection: StartupProtection = ownsLocalRouting && inputs.serviceViable
    ? "service"
    : ownsLocalRouting && shimEffective
      ? "shim"
      : "none";
  const rebootSafe = !localRoutingDependency || (ownsLocalRouting && inputs.serviceViable);
  const status: StartupHealthStatus = !localRoutingDependency
    ? "native"
    : rebootSafe
      ? "protected"
      : "at-risk";
  const recommendedCommand = status !== "at-risk"
    ? null
    : inputs.routingKind === "custom-local" || inputs.routingKind === "unknown"
      ? COMMANDS.restoreNative
    : inputs.serviceSupported
      // An already-registered service is refreshed in place: `repair` reuses healthy Windows
      // scheduler definitions, while stale ones may be re-registered and require elevation.
      // It still cannot switch a WinSW install to Task Scheduler the way `install` would. Only a
      // genuinely absent (or conflicting, which needs uninstall-then-install) service
      // gets the registering command.
      ? (inputs.serviceInstalled && !inputs.serviceConflict ? COMMANDS.repairService : COMMANDS.installService)
      : COMMANDS.restoreNative;
  return {
    ...inputs,
    diagnosticStale: inputs.diagnosticStale ?? false,
    routingInjected,
    localRoutingDependency,
    status,
    rebootSafe,
    protection,
    shimCoverage,
    recommendedCommand,
    commands: { ...COMMANDS },
  };
}

export interface StartupHealthDiagnostics {
  routingKind?: CodexRoutingKind;
  service?: ServiceDiagnostic;
  shim?: CodexShimDiagnostic;
  routingAdoption?: RoutingAdoptionEvidence;
}

/** Collect current machine state without mutating config, services, or shims. */
export function collectStartupHealth(
  config: Pick<OcxConfig, "codexAutoStart">,
  diagnostics: StartupHealthDiagnostics = {},
): StartupHealth {
  const shim = diagnostics.shim ?? diagnoseCodexShim();
  const service = diagnostics.service ?? diagnoseService();
  const routingKind = diagnostics.routingKind ?? getCodexRoutingKind();
  const routingAdoption = diagnostics.routingAdoption
    ?? (routingKind === "opencodex-local" ? collectRoutingAdoption({ routingKind }) : undefined);
  return deriveStartupHealth({
    routingKind,
    autostartEnabled: codexAutoStartEnabled(config),
    serviceInstalled: service.installed,
    serviceViable: service.viable,
    serviceEnabled: service.enabled,
    serviceRunning: service.running,
    serviceStale: service.stale,
    serviceConflict: service.conflict,
    serviceSupported: service.supported,
    shimInstalled: shim.installed,
    shimHealthy: shim.healthy,
    platform: process.platform,
    ...(routingAdoption ? { routingAdoption } : {}),
  });
}

export function startupHealthSummary(health: StartupHealth): string {
  const summary = classifyStartupHealthSummary(health);
  const action = pendingClientRestartAction(health);
  return action ? `${summary}; ${action}` : summary;
}

/**
 * What to say at the end of setup, once routing is on disk and the autostart choice is made.
 *
 * #5261: applying the Codex integration does not install a background service, and on Windows
 * the scheduled task that a separate install would create is logon-triggered rather than
 * boot-triggered. So "routing written, nothing listening" is an ordinary state after a restart
 * rather than a corruption — and the user is never told, because setup ends on a success line.
 *
 * A boot trigger is not the missing piece and would be a false reassurance. The task runs as
 * the interactive user, so before logon there is no session for it to run in; making it truly
 * pre-logon means a different principal and a different service backend, not another trigger.
 * What is actually missing is that nobody says the dependency exists, which is cheap to fix and
 * true on every platform.
 *
 * Reuses the existing health model rather than re-deriving the condition, so this cannot drift
 * from what `ocx status` and `ocx doctor` report about the same install.
 */
export function injectedRoutingRestartWarningLines(health: StartupHealth): string[] {
  if (health.status !== "at-risk") return [];
  return [
    // Deliberately not "nothing will restart the proxy": a healthy launcher shim does restart it,
    // for CLI launches only, and is still at-risk. The summary line below says which case this is.
    "⚠️  Codex routing is written to disk and survives a restart; keeping the proxy running is a separate matter.",
    `   ${startupHealthSummary(health)}`,
    "   While the proxy is down Codex cannot sign in or reach a model. 'ocx restore' undoes the routing without needing it.",
  ];
}

function classifyStartupHealthSummary(health: StartupHealth): string {
  if (health.status === "native") return health.routingKind === "custom-remote"
    ? "custom remote Codex routing (no local restart dependency)"
    : "native Codex routing (no opencodex restart dependency)";
  if (health.protection === "service") return "protected by background service";
  const command = health.recommendedCommand ?? health.commands.restoreNative;
  if (health.routingKind === "unknown") return `AT RISK after restart (Codex routing could not be verified; run '${command}')`;
  if (health.routingKind === "custom-local") return `AT RISK after restart (custom local gateway lifecycle is not managed by opencodex; run '${command}')`;
  if (health.shimCoverage === "cli-only") return `AT RISK for Codex Desktop after restart (launcher shim covers CLI scripts only; run '${command}')`;
  if (health.serviceConflict) return `AT RISK after restart (background service managers conflict; run '${command}')`;
  if (health.serviceStale) return `AT RISK after restart (background service files are stale; run '${command}')`;
  if (health.serviceInstalled && !health.serviceViable) return `AT RISK after restart (installed service is disabled, stopped, or unhealthy; run '${command}')`;
  return `AT RISK after restart (no viable background service; run '${command}')`;
}

function pendingClientRestartAction(health: StartupHealth): string | null {
  const adoption = health.routingAdoption;
  if (adoption?.adoption !== "pending-client-restart") return null;
  const pids = adoption.staleClients.map(client => client.pid);
  if (pids.length === 0) return null;
  const pidList = pids.join(", ");
  return pids.length === 1
    ? `restart Codex client pid ${pidList} so it adopts the injected proxy route`
    : `restart Codex clients pid ${pidList} so they adopt the injected proxy route`;
}

function pendingClientRestartDetail(adoption: RoutingAdoptionEvidence | undefined): string | null {
  if (adoption?.adoption !== "pending-client-restart") return null;
  const pids = adoption.staleClients.map(client => client.pid);
  if (pids.length === 0) return null;
  return `clients=pending-restart(pid ${pids.join(", ")})`;
}

/**
 * The routing/service/shim token `ocx doctor` prints under restart safety.
 * Extracted so `ocx status` can show the same string rather than growing a
 * second copy that drifts (#2411). Two management routes computing the same
 * thing separately is exactly how #2457 happened.
 */
export function formatStartupRoutingDetail(health: StartupHealth): string {
  const service = health.serviceViable
    ? "viable"
    : health.serviceInstalled ? "installed-but-unhealthy" : "absent";
  const shim = health.shimHealthy
    ? "healthy"
    : health.shimInstalled ? "stale" : "absent";
  const base = `routing=${health.routingKind}, service=${service}, shim=${shim}`;
  const token = pendingClientRestartDetail(health.routingAdoption);
  return token ? `${base}, ${token}` : base;
}
