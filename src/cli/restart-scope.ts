/**
 * The restart scope a command was asked for, and the post-write restart itself.
 *
 * Its own module because `sync`, `sync-cache` and `catalog pull` all need it, and
 * having `catalog.ts` import it from `dispatch.ts` would make the two files circular.
 */
import { afterCatalogWriteHandleAppServers } from "../codex/app-server-processes";
import type { AfterCatalogWriteAppServerResult } from "../codex/app-server-processes";
import type { DesktopAppRestartResult } from "../codex/desktop-app-restart";

/**
 * Which restart a command was asked for.
 *
 * `--restart-codex` used to mean app-server-only, and the desktop restart was a
 * separate Windows-only opt-in. That split existed because quitting the app ends live
 * conversations, which is a bigger consent than restarting a background helper. The
 * reasoning was sound and is superseded by an explicit maintainer decision:
 * `--restart-codex` now means the app is fully stopped and started again. The narrow
 * behaviour did not disappear, it moved to a flag that names it.
 *
 * One reader for every command, so `sync`, `sync-cache` and `catalog pull` cannot
 * drift in what the same flag means.
 */
export interface RestartScope {
  /** Signal matching app-server / code-mode-host processes. */
  appServers: boolean;
  /** Fully quit and relaunch the Codex desktop app. */
  desktopApp: boolean;
}

export function readRestartScope(
  args: readonly string[],
  log: Pick<Console, "error">,
): RestartScope {
  const appServerOnly = args.includes("--restart-app-server-only");
  const legacyDesktop = args.includes("--restart-desktop-app");
  const restartCodex = args.includes("--restart-codex");
  if (legacyDesktop) {
    log.error(
      "--restart-desktop-app is deprecated: --restart-codex now restarts the Codex "
      + "desktop app on every platform. The flag still works and will be removed in a "
      + "future release.",
    );
  }
  if (appServerOnly && (restartCodex || legacyDesktop)) {
    // Contradictory scopes, and the NARROW one wins. Losing live conversations is
    // unrecoverable; a stale model picker is not. A user who typed the app-server-only
    // flag asked not to lose them.
    log.error(
      "--restart-app-server-only overrides --restart-codex/--restart-desktop-app; "
      + "the desktop app was left running.",
    );
    return { appServers: true, desktopApp: false };
  }
  if (appServerOnly) return { appServers: true, desktopApp: false };
  if (restartCodex || legacyDesktop) return { appServers: true, desktopApp: true };
  return { appServers: false, desktopApp: false };
}

export interface RestartScopeOutcome {
  appServers?: AfterCatalogWriteAppServerResult;
  desktopApp?: DesktopAppRestartResult;
}

/**
 * The post-write restart, for every command that performs one.
 *
 * App-servers that belong to the desktop tree are excluded when a desktop restart is
 * also going to run: the app-server is a CHILD of the app on every platform, so
 * signalling it first and then quitting the app interrupts the operator's in-flight
 * turn twice in one command. A discovery or probe failure yields no exclusion, which
 * is the safe direction - a missed exclusion costs an extra interruption, a wrong one
 * leaves a stale app-server serving a roster that no longer exists.
 */
export async function handleRestartScopeAfterWrite(
  scope: RestartScope,
  log: Pick<Console, "log" | "error">,
): Promise<RestartScopeOutcome> {
  const { listCodexDesktopAppPids } = await import("../codex/desktop-app-restart");
  // KNOWN LIMITATION on Windows. The exclusion matches pids against the discovered
  // desktop tree, and the Windows probe enumerates only ChatGPT.exe, while Windows
  // app-servers run as codex.exe / codex-code-mode-host. They therefore never match and
  // still receive SIGTERM before the app quits, so Windows keeps the double interruption
  // this exclusion removes on macOS and Linux - where the app-server executable does live
  // under the bundle or install root and is enumerated.
  //
  // Closing it means widening the Windows probe past ChatGPT.exe, which is the same query
  // that decides what may be killed, so it needs its own verification rather than being
  // appended here. The restart itself is correct on Windows either way; the cost is one
  // extra interrupted turn.
  const excludePids = scope.desktopApp ? (listCodexDesktopAppPids() ?? []) : [];
  const appServers = afterCatalogWriteHandleAppServers({
    restart: scope.appServers, log, excludePids,
  });
  const desktopApp = scope.desktopApp ? await handleDesktopAppRestart(log) : undefined;
  return { appServers, desktopApp };
}

/**
 * Report the outcome of a desktop-app restart. Kept next to the callers so every
 * command tells the user the same thing.
 */
export async function handleDesktopAppRestart(
  log: Pick<Console, "log" | "error">,
): Promise<DesktopAppRestartResult> {
  const { restartCodexDesktopApp } = await import("../codex/desktop-app-restart");
  const { startDesktopRestartHandoff } = await import("../codex/desktop-app/handoff");
  const result = restartCodexDesktopApp({
    // The CLI is the one caller whose exit is exactly the signal the helper waits for,
    // so it is the one caller allowed to hand off. The management service is not (it
    // runs in a proxy that never exits) and the helper itself is not (recursion).
    startHandoff: () => {
      const outcome = startDesktopRestartHandoff();
      return outcome.kind === "started"
        ? { helperPid: outcome.helperPid, logPath: outcome.logPath }
        : null;
    },
  });
  switch (result.reason) {
    case "unsupported_platform":
      log.error(
        `Restarting the Codex desktop app is not supported on ${process.platform}; `
        + "nothing was stopped.",
      );
      return result;
    case "restart_in_flight":
      log.error(
        "Another Codex desktop-app restart is already running; this one did nothing. "
        + "Wait for it to finish and check again.",
      );
      return result;
    case "relaunch_failed":
      log.error(
        "The Codex desktop app was stopped but could not be started again. Launch it manually.",
      );
      return result;
    case "package_discovery_failed":
      log.error(
        "Could not identify the installed Codex desktop package. Quit and relaunch the desktop app "
        + "manually to refresh the model picker.",
      );
      return result;
    case "handoff_started":
      // Saying the session will end is the point. The operator is about to lose the
      // terminal they typed into, and a message that omits that reads as a hang.
      log.log(
        "This command is running inside the Codex app, so the restart was handed off to "
        + `a detached helper (pid ${result.handoff?.helperPid ?? 0}). The app will quit and `
        + `relaunch in a moment; this session will end with it. Outcome: ${result.handoff?.logPath ?? ""}`,
      );
      return result;
    case "self_ancestry":
      log.error(
        "Refusing to restart the desktop app because this command is running inside it, "
        + "and the restart could not be handed off to a detached helper. "
        + "Run 'ocx sync --restart-codex' from a terminal outside the app instead.",
      );
      return result;
    case "process_probe_failed":
      // Distinct from `no_targets`: we could not look, which is not the same as looking and
      // finding nothing. Saying "not running" here sent users away believing there was nothing
      // to restart (#2557).
      log.error(
        "Could not enumerate Codex desktop processes, so the app was not restarted. "
        + "Quit and relaunch the desktop app manually to refresh the model picker.",
      );
      return result;
    case "no_targets":
      log.log("Codex desktop app is not running; nothing to restart.");
      return result;
    case "targets_survived":
      log.error(
        `Codex desktop app PID(s) ${result.surviving.join(", ")} did not exit, so it was not relaunched. `
        + "Quit the desktop app manually to refresh the model picker.",
      );
      return result;
    default:
      if (result.relaunch === "started") {
        log.log("Codex desktop app restarted; its model picker will re-read the catalog.");
      }
      return result;
  }
}

