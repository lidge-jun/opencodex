import { constants as osConstants } from "node:os";

/**
 * Exit status for a shutdown that a termination signal requested.
 *
 * The launchd plist keeps the job alive only on an unsuccessful exit (`KeepAlive` with
 * `SuccessfulExit` false), so that a supervised child standing down for a foreign recorded
 * owner (exit 0) stays down. A SIGTERM from outside — `kill`, a crashed parent, an operator —
 * must still read as unsuccessful there, as it did under the old unconditional KeepAlive, or
 * launchd would leave the proxy stopped. `launchctl bootout` and `ocx service stop` unload the
 * job first, so this never resurrects a deliberately stopped service.
 *
 * Only the launchd-managed job changes: systemd's `Restart=on-failure` already distinguishes a
 * stop it requested, and foreground, desktop and Windows runs keep their clean exit 0.
 */
export function handledSignalExitCode(
  signal: NodeJS.Signals | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== "darwin" || env.OCX_SERVICE_MANAGED !== "1") return 0;
  return 128 + (osConstants.signals[signal ?? "SIGTERM"] ?? osConstants.signals.SIGTERM);
}
