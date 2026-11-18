import { loadConfig } from "../config";
import { resolveServiceListenPort } from "./definition";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { launchdListenPort } from "./launchd";
import { serviceLogPath } from "./state";
import { systemdListenPort } from "./systemd";
import { windowsListenPort, winswListenPort } from "./windows-ops";

export { resolveServiceListenPort };
export { shellQuote, buildServiceShellCommand, buildServiceLauncherShellCommand, parseBakedListenPort, resolvedProxyEnv } from "./definition";

/**
 * The listen port of the INSTALLED service artifact, falling back to the configured
 * one. This historical artifact chain can read retained files from another platform;
 * platform-specific launchd command checks instead use only the plist and configured port.
 */
export function installedServiceListenPort(): number {
  return launchdListenPort()
    ?? systemdListenPort()
    ?? windowsListenPort()
    ?? winswListenPort()
    ?? resolveServiceListenPort();
}

export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * Windows gets a longer budget because its cold start does more before the
 * listener exists: NTFS ACL hardening and previous-session journal recovery
 * both run first, and #3009 recorded a service that bound a few seconds past
 * the 20s deadline and then stayed healthy. Reporting that as a terminal
 * repair failure is worse than waiting — the caller's fallback is to start a
 * second proxy against a port that is about to be taken.
 */
export const SERVICE_INSTALL_HEALTH_WINDOWS_MS = 45_000;

/** The health budget for the platform this is running on. */
export function serviceInstallHealthMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32" ? SERVICE_INSTALL_HEALTH_WINDOWS_MS : SERVICE_INSTALL_HEALTH_MS;
}

/** One identity read of a proxy: the pid its healthz reports, or null when it reports none. */
export type ServingIdentity = (port: number, hostname: string) => Promise<{ pid: number | null } | null>;

const defaultIdentify: ServingIdentity = async (port, hostname) => {
  const identity = await proxyIdentityAt(port, { hostname });
  return identity ? { pid: identity.pid } : null;
};

/** The pid a restart must replace, or null when there is nothing valid to compare against. */
function replacedPid(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The pid of the proxy answering on the installed service port right now, or null when nothing
 * answers or the answer names no pid. `ocx service restart` reads it before restarting so the
 * serving check can tell the replacement from the runtime it was meant to replace (#7771).
 * Never throws: a failed read only means there is nothing to compare against.
 */
export async function servingRuntimePid(
  deps: { port?: number; hostname?: string; identify?: ServingIdentity } = {},
): Promise<number | null> {
  try {
    const port = deps.port ?? installedServiceListenPort();
    const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
    const pid = (await (deps.identify ?? defaultIdentify)(port, hostname))?.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether a proxy actually answers on the port this install/start just produced.
 *
 * Registration is not service: `launchctl list` reports a job that never bound, and
 * `systemctl is-active` reports a process that bound nothing. Probing is the only
 * thing that answers the question the user is actually asking.
 *
 * Probes the BAKED target rather than resolving one. `findLiveProxy` resolves through
 * pidfile -> runtime-port -> config.port, and a service reinstall has just invalidated
 * the first two while `resolveServiceListenPort` (OCX_BAKE_PORT precedence, config.port
 * === 0 normalization) can disagree with the third.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark and
 * an actionable warning.
 *
 * `replacing` is the pid that answered before a restart. While it is set, only a proxy that
 * reports a different pid counts as serving: a surviving old runtime answers healthz just as
 * well, and counting it reported a restart that never happened (#7771). An answer without a
 * pid cannot be shown to be the old runtime and counts. If the last answer still came from the
 * replaced pid, the result carries it as `staleRuntimePid`.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    replacing?: number | null;
    /**
     * Stop at the first answer from the replaced pid instead of waiting for a replacement. A
     * restart that already threw usually refused before touching anything, so the old runtime
     * answering is the final answer and polling the whole budget only delays the error.
     */
    settleOnReplaced?: boolean;
    identify?: ServingIdentity;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number; runtimePid?: number } | { ok: false; port: number; staleRuntimePid?: number }> {
  const port = deps.port ?? installedServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const replacing = replacedPid(deps.replacing);
  let staleRuntimePid: number | undefined;
  let runtimePid: number | undefined;
  const identify = deps.identify ?? defaultIdentify;
  const probe = replacing !== null
    ? async (p: number, h: string) => {
      const identity = await identify(p, h);
      staleRuntimePid = identity?.pid === replacing ? replacing : undefined;
      runtimePid = typeof identity?.pid === "number" && identity.pid !== replacing ? identity.pid : undefined;
      return identity !== null && staleRuntimePid === undefined;
    }
    : deps.probe ?? (async (p: number, h: string) => !!(await proxyIdentityAt(p, { hostname: h })));
  const serving = () => (runtimePid === undefined ? { ok: true as const, port } : { ok: true as const, port, runtimePid });
  const deadline = now() + (deps.timeoutMs ?? serviceInstallHealthMs());
  let waited = false;
  for (;;) {
    if (await probe(port, hostname)) return serving();
    if (deps.settleOnReplaced && staleRuntimePid !== undefined) return { ok: false, port, staleRuntimePid };
    if (now() >= deadline) break;
    await sleep(500);
    waited = true;
  }
  // The probe that ran last started before the deadline, so a service that binds
  // during it is reported as dead (#3009). Knock once more after a short grace
  // before calling it a failure. A zero budget means the caller asked not to
  // wait, so it gets exactly the single probe it asked for and nothing more.
  if (waited) {
    await sleep(500);
    if (await probe(port, hostname)) return serving();
  }
  return staleRuntimePid === undefined ? { ok: false, port } : { ok: false, port, staleRuntimePid };
}

/**
 * The operation, as a noun, for a sentence that has to say it did not complete.
 *
 * The verb form reads as an accomplished fact ("service repaired"), which is exactly the
 * claim that must not be made when the operation threw.
 */
const SERVICE_OPERATION_NOUN = {
  installed: "install",
  started: "start",
  repaired: "repair",
  restarted: "restart",
} as const;

/**
 * Print the outcome of `install` / `start` / `repair` in terms of what the user cares
 * about — is it serving? — instead of whether the manager accepted the registration.
 *
 * Sets `process.exitCode = 1` when nothing answers. That is deliberate: the GUI update
 * worker reads the child's exit status, so a registered-but-silent service now makes it
 * fall back to a direct proxy start rather than reporting a successful update over a
 * dead port.
 *
 * `precedingFailure` is the error the operation itself threw, when it threw. The serving
 * probe still runs — a rollback or a preserve/restart protocol may well have left the
 * previous job answering, and the operator needs that half of the answer (#4236). But the
 * two halves have to be ONE sentence. Printing the failure separately and then reaching
 * the success line here reported both outcomes for the same run and credited work that did
 * not happen: the registration was kept, not repaired (#4914).
 */
export async function reportServiceServing(
  verb: "installed" | "started" | "repaired" | "restarted",
  deps: Parameters<typeof confirmServiceServing>[0] = {},
  precedingFailure?: unknown,
): Promise<void> {
  const healthBudgetMs = deps.timeoutMs ?? serviceInstallHealthMs();
  // Timed here rather than reported from the budget. confirmServiceServing knocks once
  // more after a grace sleep whenever it waited at all, so the real wait is the budget
  // plus that grace — and printing the budget states a number the run did not spend.
  // What the reader is deciding is whether the service was still coming up, which is a
  // judgement about elapsed time (#3009).
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const serving = await confirmServiceServing({
    ...deps, timeoutMs: healthBudgetMs, settleOnReplaced: precedingFailure !== undefined,
  });
  const waitedMs = Math.max(0, now() - startedAt);
  const failureDetail = precedingFailure === undefined
    ? null
    : precedingFailure instanceof Error ? precedingFailure.message : String(precedingFailure);
  const operation = SERVICE_OPERATION_NOUN[verb];
  const replacing = replacedPid(deps.replacing);
  const staleRuntimePid = serving.ok ? undefined : serving.staleRuntimePid;
  if (failureDetail !== null) {
    // Serving or not, the operation did not complete, so neither branch may print a
    // checkmark. What differs is whether anything is answering, which is the fact the
    // operator acts on next.
    if (staleRuntimePid !== undefined) {
      console.error(
        `⚠️  Service ${operation} did not complete: ${failureDetail}\n`
        + `   The previous runtime (PID ${staleRuntimePid}) is still answering on port ${serving.port}; it was kept, not replaced.\n`
        + `   Log:       ${serviceLogPath()}`,
      );
      process.exitCode = 1;
      return;
    }
    if (serving.ok && replacing !== null) {
      console.error(
        `⚠️  Service ${operation} reported a failure: ${failureDetail}\n`
        + (serving.runtimePid !== undefined
          ? `   A new runtime (PID ${serving.runtimePid}) is answering on port ${serving.port}.\n`
          : `   A runtime that reports no pid is answering on port ${serving.port}; it could not be compared with the previous one.\n`)
        + `   Check the log before relying on it.\n`
        + `   Log:       ${serviceLogPath()}`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(
      serving.ok
        ? `⚠️  Service ${operation} did not complete: ${failureDetail}\n`
          + `   A proxy is answering on port ${serving.port}, so the existing registration was kept rather than replaced.\n`
          + `   The ${operation} did not take effect; rerun it once the reported cause is resolved.\n`
          + `   Log:       ${serviceLogPath()}`
        : `❌ Service ${operation} failed: ${failureDetail}\n`
          + `   No proxy answered on port ${serving.port} after ${Math.round(waitedMs / 1000)}s either.\n`
          + `   Log:       ${serviceLogPath()}\n`
          + `   Meanwhile: ocx start   (serves in the foreground)`,
    );
    process.exitCode = 1;
    return;
  }
  if (serving.ok) {
    console.log(`✅ opencodex service ${verb} and serving on port ${serving.port}.`);
    return;
  }
  if (staleRuntimePid !== undefined) {
    console.error(
      `⚠️  Service ${operation} requested, but the previous runtime (PID ${staleRuntimePid}) is still serving on port ${serving.port}; `
      + `the requested replacement was not confirmed after ${Math.round(waitedMs / 1000)}s.\n`
      + `   Log:       ${serviceLogPath()}`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    `⚠️  Service ${verb}, but no proxy answered on port ${serving.port} after `
    + `${Math.round(waitedMs / 1000)}s.\n`
    + `   The manager registered the job; that is not the same as serving.\n`
    + `   Log:       ${serviceLogPath()}\n`
    + `   Meanwhile: ocx start   (serves in the foreground)`,
  );
  process.exitCode = 1;
}

/**
 * The command that repairs the CURRENTLY INSTALLED backend without switching it.
 *
 * `ocx service repair` reads the recorded backend itself, so it cannot silently switch a
 * WinSW install to Task Scheduler the way a plain `ocx service install` would. A healthy
 * scheduler definition needs no elevation; a stale definition can be re-registered and prompt.
 */
export function serviceRepairCommand(): string {
  return "ocx service repair";
}
