import { spawnSync } from "node:child_process";

/**
 * How to launch the dashboard update worker on POSIX.
 *
 * A worker spawned from the systemd user service stays in that service's cgroup even when
 * detached, and the generated unit keeps the default `KillMode=control-group`. The updater then
 * stops `opencodex-proxy.service` and systemd kills the worker with it, leaving the proxy offline
 * on the old package (#5750). `systemd-run --user --scope` moves the worker into its own
 * transient scope first; `--scope` execs the command in place, so the returned PID is still the
 * worker's. Outside a systemd-started process (`INVOCATION_ID` unset), or when `systemd-run` is
 * missing, the plain detached spawn is unchanged.
 */
export const SYSTEMD_SCOPE_ARGS = ["--user", "--scope", "--quiet", "--collect", "--"] as const;

export interface WorkerLaunchContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hasSystemdRun?: () => boolean;
}

let systemdRunProbe: boolean | undefined;

function probeSystemdRun(): boolean {
  if (systemdRunProbe === undefined) {
    // Run a real no-op scope rather than `--version`: a present binary without a reachable user
    // bus would otherwise pass the probe and then fail to start the worker at all.
    const probe = spawnSync("systemd-run", [...SYSTEMD_SCOPE_ARGS, "true"], { stdio: "ignore", timeout: 5_000 });
    systemdRunProbe = !probe.error && probe.status === 0;
  }
  return systemdRunProbe;
}

export function guiUpdateWorkerCommand(
  execPath: string,
  args: readonly string[],
  context: WorkerLaunchContext = {},
): { command: string; argv: string[] } {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const underSystemd = platform === "linux" && Boolean(env.INVOCATION_ID);
  if (underSystemd && (context.hasSystemdRun ?? probeSystemdRun)()) {
    return { command: "systemd-run", argv: [...SYSTEMD_SCOPE_ARGS, execPath, ...args] };
  }
  return { command: execPath, argv: [...args] };
}
