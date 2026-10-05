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
 * one. Each reader returns null off its own platform, so the chain needs no platform
 * branch — and on Windows both return null, preserving today's behavior.
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
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? installedServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? serviceInstallHealthMs());
  let waited = false;
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
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
    if (await probe(port, hostname)) return { ok: true, port };
  }
  return { ok: false, port };
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
  const serving = await confirmServiceServing({ ...deps, timeoutMs: healthBudgetMs });
  const waitedMs = Math.max(0, now() - startedAt);
  const failureDetail = precedingFailure === undefined
    ? null
    : precedingFailure instanceof Error ? precedingFailure.message : String(precedingFailure);
  const operation = SERVICE_OPERATION_NOUN[verb];
  if (failureDetail !== null) {
    // Serving or not, the operation did not complete, so neither branch may print a
    // checkmark. What differs is whether anything is answering, which is the fact the
    // operator acts on next.
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
