import { existsSync } from "node:fs";
import { statusWinswRaw, winswStatusSummary } from "../lib/winsw";
import { cachedCurrentWindowsIdentity, resolveCurrentWindowsPrincipal, WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS } from "../lib/windows-user-principal";
import { sh } from "./guards";
import { installedServiceListenPort, confirmServiceServing } from "./health";
import { expectedLaunchdCommand, launchdJobMatchesPlist, probeLaunchdLoadState } from "./launchd";
import type { LaunchdLoadProbe } from "./launchd";
import { plistPath, windowsServiceScriptPath, windowsLauncherVbsPath, windowsTaskXmlPath, readServiceInstallState } from "./state";
import type { ServiceBackend } from "./state";
import { unitPath, isSystemd } from "./systemd";
import { statusWindowsXml } from "./windows-ops";
import { cachedWindowsTaskUserIds, taskXmlSection, taskXmlWithoutCommentsAndCdata, taskXmlElementCount, readWindowsSchedulerXmlState } from "./windows-taskxml";
import type { ExpectedWindowsTaskUserId } from "./windows-taskxml";
import { join, win32 } from "node:path";
import { WINSW_VERSION } from "../lib/winsw";
import { serviceRepairCommand } from "./health";
import { LABEL, TASK, serviceLogPath } from "./state";

/**
 * Warn when the paths baked into installed service assets no longer exist (npm prefix
 * moved, nvm switch, reinstall) — the service manager would restart-loop on a dead path
 * while `schtasks`/`launchctl` still report "installed".
 */
export function bakedServicePathsDiagnostic(): string | null {
  const state = readServiceInstallState();
  // A launcher install runs the launcher, not the baked pair, so the pair's existence says
  // nothing about whether the service can start. Judging the recorded launcher is both
  // necessary (a deleted launcher IS stale) and sufficient (a replaced version directory
  // is not, which is exactly what #2898 made routine).
  if (state?.launcherPath) {
    if (existsSync(state.launcherPath)) return null;
    return `STALE baked paths (missing: ${state.launcherPath}) — run 'ocx service repair' to re-bake`;
  }
  if (!state?.bunPath || !state?.cliPath) return null;
  const missing = [state.bunPath, state.cliPath].filter(path => !existsSync(path));
  if (missing.length === 0) return null;
  return `STALE baked paths (missing: ${missing.join(", ")}) — run 'ocx service repair' to re-bake`;
}

export function serviceDiagnosticsSummary(): string {
  const stale = bakedServicePathsDiagnostic();
  return stale ? `${stale}; logs: ${serviceLogPath()}` : `logs: ${serviceLogPath()}`;
}

export interface ServiceDiagnostic {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  startable: boolean;
  stale: boolean;
  conflict: boolean;
  backend: ServiceBackend | "launchd" | "systemd" | null;
  summary: string;
}

/** Windows tray may restart a healthy-but-stopped native service; stale/conflicting installs remain blocked. */
export function serviceStartableFromTray(service: ServiceDiagnostic): boolean {
  return service.startable && !service.stale && !service.conflict;
}

export interface WindowsTaskDiagnosticIdentityDeps {
  currentIdentity?: () => Readonly<{ sid: string; name: string }> | null;
  resolvePrincipal?: (timeoutMs: number) => string;
}

/**
 * Resolve the effective account only when the registered task carries an explicit unprefixed
 * trigger scope. Empty/unscoped tasks do not need identity and must not pay a repeated sync
 * lookup timeout; prefixed scopes remain unreadable and fail closed in the XML validator.
 */
export function resolveWindowsTaskDiagnosticUserId(
  schedulerXml: string,
  deps: WindowsTaskDiagnosticIdentityDeps = {},
): readonly string[] | null {
  const currentIdentity = deps.currentIdentity ?? cachedCurrentWindowsIdentity;
  const cached = currentIdentity();
  if (cached) return [cached.sid, cached.name];

  const scrubbed = taskXmlWithoutCommentsAndCdata(schedulerXml);
  const triggers = taskXmlSection(scrubbed, "Triggers");
  if (taskXmlElementCount(triggers, "UserId") === 0) return null;

  try {
    (deps.resolvePrincipal ?? resolveCurrentWindowsPrincipal)(WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS);
  } catch {
    return null;
  }
  const resolved = currentIdentity();
  return resolved ? [resolved.sid, resolved.name] : null;
}

export interface WindowsServiceDiagnosticInputs {
  /**
   * Raw `schtasks /query /xml` output; empty when no task is registered. Passed as
   * XML rather than pre-computed booleans so every caller reads the document through
   * readWindowsSchedulerXmlState() — a second, stricter reading elsewhere would
   * silently reintroduce the stale-status false positive (#432).
   */
  schedulerXml: string;
  /** Resolved effective account for explicit scheduler trigger scopes; null means unknown. */
  schedulerExpectedUserId?: ExpectedWindowsTaskUserId | null;
  /** Whether the on-disk service assets exist. A filesystem concern, not an XML one. */
  schedulerAssetsPresent: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  recordedBackend: ServiceBackend | null;
  staleBakedPaths: boolean;
  nativeRepairAssetsOnly: boolean;
  diagnostics: string;
}

export function deriveWindowsServiceDiagnostic(inputs: WindowsServiceDiagnosticInputs): ServiceDiagnostic {
  const expectedUserId = inputs.schedulerExpectedUserId === undefined
    ? cachedWindowsTaskUserIds()
    : inputs.schedulerExpectedUserId;
  const schedulerState = readWindowsSchedulerXmlState(
    inputs.schedulerXml,
    undefined,
    undefined,
    expectedUserId,
  );
  const schedulerInstalled = schedulerState.installed;
  const schedulerEnabled = schedulerState.enabled;
  const schedulerAssetsHealthy = inputs.schedulerAssetsPresent && schedulerState.registrationHealthy;
  const nativeInstalled = inputs.nativeStatus !== "nonexistent";
  const conflict = schedulerInstalled && nativeInstalled;
  const backendStateMismatch = schedulerInstalled
    ? inputs.recordedBackend !== "scheduler"
    : nativeInstalled && inputs.recordedBackend !== "native";
  const stale = inputs.staleBakedPaths
    || (schedulerInstalled && !schedulerAssetsHealthy)
    || backendStateMismatch
    || (inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly);
  const backend = schedulerInstalled ? "scheduler" : nativeInstalled ? "native" : null;
  const enabled = schedulerInstalled ? schedulerEnabled : inputs.nativeStatus === "started";
  const running = nativeInstalled ? inputs.nativeStatus === "started" : schedulerInstalled && schedulerEnabled;
  const viable = !conflict && !stale
    && (schedulerInstalled ? schedulerEnabled && schedulerAssetsHealthy : inputs.nativeStatus === "started");
  const startable = !conflict && !stale
    && (schedulerInstalled
      ? schedulerEnabled && schedulerAssetsHealthy
      : inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const detail = conflict
    ? "CONFLICT: Task Scheduler and native WinSW are both present — run 'ocx service uninstall' then reinstall one"
    : stale
      ? "stale or missing service assets — run 'ocx service repair'"
      : schedulerInstalled
        ? schedulerEnabled ? "Task Scheduler enabled" : "Task Scheduler disabled"
        : nativeInstalled
          ? `native (WinSW ${WINSW_VERSION}): ${inputs.nativeStatus}`
          : "not installed";
  const summary = backend ? `installed, ${detail} (${inputs.diagnostics})` : `not installed (${inputs.diagnostics})`;
  return {
    supported: true,
    installed: schedulerInstalled || nativeInstalled,
    enabled,
    running,
    viable,
    startable,
    stale,
    conflict,
    backend,
    summary,
  };
}

/** Bind the live Windows identity to a scheduler snapshot before deriving service health. */
export function deriveWindowsServiceDiagnosticForCurrentUser(
  inputs: Omit<WindowsServiceDiagnosticInputs, "schedulerExpectedUserId">,
  identityDeps: WindowsTaskDiagnosticIdentityDeps = {},
): ServiceDiagnostic {
  return deriveWindowsServiceDiagnostic({
    ...inputs,
    schedulerExpectedUserId: resolveWindowsTaskDiagnosticUserId(inputs.schedulerXml, identityDeps),
  });
}

export interface LaunchdServiceDiagnosticInputs {
  installed: boolean;
  stale: boolean;
  load: LaunchdLoadProbe;
  diagnostics: string;
}

/**
 * Turn the launchd tri-state into a {@link ServiceDiagnostic}. Pure, so the four states
 * are testable without a live launchd.
 *
 * `unknown` is the one that used to do damage. The old probe collapsed "launchctl could
 * not be asked" into "not loaded", which printed `installed, not loaded` for a serving hub
 * and recommended `ocx service repair` — the command that evicts the job (#4236). So:
 *
 * - the summary says the state could not be verified and names NO repair command, and
 * - `viable` stays true, because `isServiceViable() === false` is what makes
 *   `src/update/index.ts` and `src/update/job.ts` treat a successful repair as a dead
 *   supervisor and start a competing proxy on the service's own port. A failed probe is
 *   not evidence against the service; `startable` is likewise left alone so the tray can
 *   still hand a start to `ocx service start`, which no-ops on an already-loaded job.
 *
 * `loaded-stale` keeps the viability the `launchctl list` era gave it (loaded ⇒ viable, so
 * the update fallback behaves as before), and only the summary is upgraded — the operator
 * is told the live job came from an older plist, which is the one case where `repair` is
 * exactly right.
 */
export function deriveLaunchdServiceDiagnostic(inputs: LaunchdServiceDiagnosticInputs): ServiceDiagnostic {
  const { installed, stale, load, diagnostics } = inputs;
  const loaded = load.state === "loaded-current" || load.state === "loaded-stale";
  const running = installed && loaded;
  const verified = load.state !== "unknown";
  const viable = installed && !stale && (loaded || !verified);
  const summary = !installed ? `not installed (${diagnostics})`
    : stale ? `installed, but stale (launchd; ${diagnostics})`
      : load.state === "loaded-current" ? `installed and loaded (launchd; ${diagnostics})`
        : load.state === "loaded-stale"
          ? `installed and loaded from an OLDER plist (launchd; ${diagnostics})`
          : load.state === "unknown"
            ? `installed; launchd state could not be verified — ${load.detail ?? "launchctl could not be asked"} (launchd; ${diagnostics})`
            : `installed, not loaded (launchd; ${diagnostics})`;
  return {
    supported: true,
    installed,
    enabled: running,
    running,
    viable,
    startable: installed && !stale,
    stale,
    conflict: false,
    backend: "launchd",
    summary,
  };
}

/**
 * Fail-closed restart diagnostic. Presence alone is never enough: conflicting
 * managers, stale baked paths, disabled registrations, and unknown/stopped
 * native managers cannot claim that Codex will reconnect after a reboot.
 */
export function diagnoseService(): ServiceDiagnostic {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    const installed = existsSync(plistPath());
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    return deriveLaunchdServiceDiagnostic({
      installed,
      stale,
      load: installed ? probeLaunchdLoadState() : { state: "not-loaded" },
      diagnostics,
    });
  }
  if (process.platform === "win32") {
    const schedulerXml = statusWindowsXml();
    const schedulerAssetsPresent = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()]
      .every(existsSync);
    const nativeStatus = statusWinswRaw();
    const installState = readServiceInstallState();
    const recordedBackend: ServiceBackend | null = !installState
      ? null
      : installState.backend === "native" ? "native" : "scheduler";
    return deriveWindowsServiceDiagnosticForCurrentUser({
      schedulerXml,
      schedulerAssetsPresent,
      nativeStatus,
      recordedBackend,
      staleBakedPaths: bakedServicePathsDiagnostic() !== null,
      nativeRepairAssetsOnly: Boolean(winswStatusSummary()),
      diagnostics,
    });
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker" };
    if (!isSystemd()) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported: systemd not found" };
    const installed = existsSync(unitPath());
    const enabled = installed && (() => { try { return sh(`systemctl --user is-enabled ${TASK}`) === "enabled"; } catch { return false; } })();
    const running = installed && (() => { try { return sh(`systemctl --user is-active ${TASK}`) === "active"; } catch { return false; } })();
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && enabled && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (systemd user; ${diagnostics})`
        : viable ? `installed, enabled and running (systemd user; ${diagnostics})`
          : `installed, but ${!enabled ? "disabled" : "not running"} (systemd user; ${diagnostics})`;
    return { supported: true, installed, enabled, running, viable, startable: installed && !stale, stale, conflict: false, backend: "systemd", summary };
  }
  return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: `unsupported on ${process.platform}` };
}

export function serviceStatusSummary(): string {
  return diagnoseService().summary;
}

/**
 * Status a human can act on: registration state, whether a proxy actually answers,
 * and — when it does not — whether launchd is running the plist we have on disk.
 *
 * `launchctl list` membership cannot distinguish "serving", "bootstrapped from an
 * older plist", and "loaded but never bound"; the reported failure was the middle
 * one presented as the first.
 *
 * Resolves the port through `confirmServiceServing`, i.e. the same
 * `installedServiceListenPort()` path install/start/repair use, so those surfaces can
 * never disagree about one service. The budget is short (2 probes) because this is a
 * status read, not a post-install wait.
 */
export async function serviceStatusReport(
  deps: {
    diagnose?: () => ServiceDiagnostic;
    serving?: () => Promise<{ ok: boolean; port: number }>;
    matchesPlist?: () => { loaded: boolean; matchesPlist: boolean };
  } = {},
): Promise<string> {
  const diag = (deps.diagnose ?? diagnoseService)();
  if (!diag.installed) return `❌ ${diag.summary}`;

  const serving = await (deps.serving ?? (() => confirmServiceServing({ timeoutMs: 1_500 })))();
  if (serving.ok) return `✅ ${diag.summary}\n   Serving on port ${serving.port}.`;

  // The dep is consulted FIRST; the platform check only guards the default. Wrapping
  // the whole expression in a darwin check would discard an injected seam on
  // Linux/Windows and make the stale-plist case untestable there.
  const stalePlist = deps.matchesPlist?.() ?? (process.platform === "darwin"
    ? (() => {
        // Pass the INSTALLED port explicitly: the default third argument is
        // resolveServiceListenPort(), which reads OCX_BAKE_PORT/config.port, so after
        // a config edit the expected string would never match and every run would
        // print a false "OLDER plist".
        return launchdJobMatchesPlist(expectedLaunchdCommand(installedServiceListenPort()));
      })()
    : null);
  const staleLine = stalePlist && stalePlist.loaded && !stalePlist.matchesPlist
    ? "   launchd is running an OLDER plist than the one on disk.\n"
      + `   Fix:    launchctl bootout gui/$(id -u)/${LABEL} && ocx service repair\n`
    : "";

  return `⚠️  ${diag.summary}\n`
    + `   Registered, but no proxy is answering on port ${serving.port}.\n`
    + staleLine
    + `   Log:    ${serviceLogPath()}\n`
    + `   Repair: ${serviceRepairCommand()}\n`
    + "   Meanwhile: ocx start           (serves in the foreground)";
}
