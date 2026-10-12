import { foreignServiceOwnerRefusal, unknownServiceOwnerRefusal } from "./repair";
import {
  resolveServiceOwnership,
  SERVICE_MANAGED_ENV,
  windowsLauncherVbsPath,
  windowsServiceScriptPath,
} from "./state";
import { readProcessCommandLine } from "../config/process-state";
import { winswExePath } from "../lib/winsw";
import { serviceStayOutExitCode, WINDOWS_WRAPPER_PROTOCOL_ENV } from "./windows-wrapper-exit";

export type ServiceChildOwnershipDecision =
  | Readonly<{ kind: "proceed" }>
  | Readonly<{ kind: "stay-out"; refusal: string }>;

/**
 * Test seams for the marker-less supervisor detection below. Production callers
 * pass nothing; every default is the real process query.
 */
export type ServiceChildOwnershipDeps = {
  platform?: NodeJS.Platform;
  /** Defaults to process.ppid — the service child's direct supervisor. */
  parentPid?: () => number | undefined;
  /** Defaults to the shared Win32/procfs/ps command-line reader. */
  processCommandLine?: (pid: number) => string | undefined;
  /**
   * Canonical absolute paths that prove a parent process is one of THIS
   * installation's registered service hosts: the Task Scheduler wrapper script,
   * its wscript launcher, or the WinSW host executable.
   */
  serviceHostPaths?: () => readonly string[];
};

/** The env markers a real supervisor writes that an `ocx claude`/`ocx opencode` child does not. */
function isMarkedSupervisedServiceChild(env: NodeJS.ProcessEnv): boolean {
  return env[SERVICE_MANAGED_ENV] === "1" || env[WINDOWS_WRAPPER_PROTOCOL_ENV] === "1";
}

/**
 * Whether the parent's command line names one of the registered service-host
 * paths as a COMPLETE token. Same boundary rule as windowsWrapperKillScript:
 * the character before and after the path must be whitespace or a quote, so a
 * merely similar path suffix never qualifies.
 */
function commandLineRunsServiceHost(
  commandLine: string,
  serviceHostPaths: readonly string[],
): boolean {
  const upper = commandLine.toLowerCase();
  for (const serviceHostPath of serviceHostPaths) {
    const needle = serviceHostPath.toLowerCase();
    let from = 0;
    while (from < commandLine.length) {
      const at = upper.indexOf(needle, from);
      if (at < 0) break;
      // Boundary characters are read from the lowered copy so a case-mapping
      // that changes length can never shift the token check off by a code unit.
      const before = at === 0 ? " " : upper[at - 1];
      const end = at + needle.length;
      const after = end >= upper.length ? " " : upper[end];
      if (/[\s"']/.test(before) && /[\s"']/.test(after)) return true;
      from = at + 1;
    }
  }
  return false;
}

/**
 * Marker-less supervisor evidence for installs that predate the env markers.
 *
 * The legacy Windows Task Scheduler wrapper runs `start` inside the same
 * cmd.exe that hosts the :loop, and the WinSW host spawns it directly — so on
 * Windows the proof is the PARENT's command line naming the canonical wrapper
 * script, launcher, or WinSW executable inside this install's config dir.
 * POSIX is deliberately not guessed here: a companion whose parent exited can
 * be reparented to init (a reparented `ocx claude` proxy is not a managed
 * job), and `systemd --user` services are not init's children at all, so a
 * ppid check would refuse some companions while still missing user units.
 * Marker-less launchd/systemd registrations keep their previous behavior until
 * a discriminator backed by the manager itself exists.
 *
 * An unreadable parent command line is evidence of NOTHING and must not refuse:
 * `ocx claude`/`ocx opencode` companions carry only OCX_SERVICE=1 too, and a
 * failed CIM/procfs probe cannot be allowed to break them.
 */
function isUnmarkedSupervisedServiceChild(
  env: NodeJS.ProcessEnv,
  deps: Required<Pick<ServiceChildOwnershipDeps, "platform" | "parentPid" | "processCommandLine" | "serviceHostPaths">>,
): boolean {
  if (env.OCX_SERVICE !== "1") return false;
  if (deps.platform === "win32") {
    const ppid = deps.parentPid();
    if (ppid === undefined || ppid <= 0) return false;
    const parentCommandLine = deps.processCommandLine(ppid);
    if (parentCommandLine === undefined) return false;
    return commandLineRunsServiceHost(parentCommandLine, deps.serviceHostPaths());
  }
  return false;
}

export function isSupervisedServiceChild(env: NodeJS.ProcessEnv, deps: ServiceChildOwnershipDeps = {}): boolean {
  if (isMarkedSupervisedServiceChild(env)) return true;
  const resolved = {
    platform: deps.platform ?? process.platform,
    parentPid: deps.parentPid ?? (() => process.ppid),
    processCommandLine: deps.processCommandLine ?? readProcessCommandLine,
    serviceHostPaths:
      deps.serviceHostPaths ??
      (() => [windowsServiceScriptPath(), windowsLauncherVbsPath(), winswExePath()]),
  };
  return isUnmarkedSupervisedServiceChild(env, resolved);
}

/**
 * Whether a supervised service child may start serving under the recorded owner.
 *
 * `ocx service start` already refuses to activate the npm registration while the
 * desktop app owns the runtime, but the process manager itself never asked: the
 * Windows boot wrapper loops `index.ts start`, so a desktop takeover was
 * silently overridden the next time the wrapper respawned the child. The child
 * now asks the same question before binding a port.
 *
 * "none" still proceeds: a service installed before ownership tracking has no
 * claim to defer to. Registrations written before the supervisor env markers
 * existed are identified by the parent's command line on Windows rather than
 * by env alone, so an already-installed wrapper cannot sneak back in as an
 * ordinary OCX_SERVICE=1 child — while `ocx claude`/`ocx opencode`
 * companions, whose parent is the invoking CLI, still pass.
 */
export function serviceChildOwnershipDecision(
  env: NodeJS.ProcessEnv,
  resolve: typeof resolveServiceOwnership = resolveServiceOwnership,
  deps: ServiceChildOwnershipDeps = {},
): ServiceChildOwnershipDecision {
  return serviceChildOwnershipDecisionForClassifiedChild(isSupervisedServiceChild(env, deps), resolve);
}

/** Re-read the recorded owner after the startup mutation lease has been acquired. */
export function serviceChildOwnershipDecisionForClassifiedChild(
  supervised: boolean,
  resolve: typeof resolveServiceOwnership = resolveServiceOwnership,
): ServiceChildOwnershipDecision {
  if (!supervised) return Object.freeze({ kind: "proceed" as const });
  const ownership = resolve();
  if (ownership.kind === "unknown") {
    return Object.freeze({
      kind: "stay-out" as const,
      refusal: unknownServiceOwnerRefusal(ownership.reason, "start"),
    });
  }
  if (ownership.kind === "owned" && ownership.ownership.owner !== "cli") {
    return Object.freeze({
      kind: "stay-out" as const,
      refusal: foreignServiceOwnerRefusal(ownership.ownership, "start"),
    });
  }
  return Object.freeze({ kind: "proceed" as const });
}

/**
 * Exit code a refused supervised child must use: the Windows wrapper reads 42 as
 * an intentional stay-out and stops the loop; every other exit is a crash it
 * restarts. Elsewhere the code is 0 — systemd only restarts on failure, and
 * launchd's failure-only KeepAlive leaves an intentional exit-0 stand-down stopped.
 */
export function serviceChildStayOutExitCode(env: NodeJS.ProcessEnv = process.env): number {
  return serviceStayOutExitCode(env);
}
