/**
 * The environment markers a supervisor writes for the one process it launches: the desktop app
 * (OCX_DESKTOP_SUPERVISED), a service manager (OCX_SERVICE_MANAGED: launchd, systemd, WinSW) and the
 * Windows Task Scheduler wrapper (OCX_WINDOWS_WRAPPER_PROTOCOL). A marker proves only that the
 * process was started with it, so it must never reach a process that supervisor did not launch: a
 * detached proxy, a replacement, or a shell handed to a tool. Every such launch removes them with
 * {@link withoutSupervisorMarkers}. The values match DESKTOP_SUPERVISED_ENV
 * (src/lib/system-restart-contract.ts), SERVICE_MANAGED_ENV (src/service/state.ts) and
 * WINDOWS_WRAPPER_PROTOCOL_ENV (src/service/windows-wrapper-exit.ts); a test pins that.
 */
export const SUPERVISOR_MARKER_ENVS = ["OCX_DESKTOP_SUPERVISED", "OCX_SERVICE_MANAGED", "OCX_WINDOWS_WRAPPER_PROTOCOL"] as const;

/** A copy of `env` without any supervisor marker; `env` itself is not changed. */
export function withoutSupervisorMarkers<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env };
  for (const name of SUPERVISOR_MARKER_ENVS) delete copy[name];
  return copy;
}
