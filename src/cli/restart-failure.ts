import type { ProxyRestartResult } from "./tray-proxy";

export type RestartSupervisor = "desktop" | "service" | "service-unproven" | "legacy-flag";

/**
 * Why a client runtime with only a bare OCX_SERVICE=1 is kept (#8545 owner decision, 2026-11-16), and the one-time fix.
 * `ocx service repair` rewrites a legacy registration with the current ownership marker (OCX_SERVICE_MANAGED or the
 * Windows wrapper marker) and reloads it, after which restart, disconnect and sync hand the runtime to that service.
 */
export const LEGACY_FLAG_OWNER_ADVICE = "It carries only the bare OCX_SERVICE=1 flag, which a background service registered before OpenCodex 2.49 and the proxies started by ocx claude, ocx codex and ocx opencode all share, so its owner cannot be proven. If a background service runs it, re-register the service once with `ocx service repair` (this writes the current ownership marker and restarts it). If ocx claude, ocx codex or ocx opencode started it, run `ocx stop` and start it again.";

/** Only the bound client's explicit refusal establishes a supervisor for sync. */
export function supervisedRestartRefusal(result: ProxyRestartResult): RestartSupervisor | null {
  if (result.ok || result.phase !== "request" || !(result.error instanceof Error)) return null;
  if (result.error.message === "restart_supervised_desktop") return "desktop";
  if (result.error.message === "restart_supervised_service") return "service";
  if (result.error.message === "restart_supervised_service-unproven") return "service-unproven";
  if (result.error.message === "restart_supervised_legacy-flag") return "legacy-flag";
  return null;
}

export function deferSupervisedRestart(result: ProxyRestartResult, notify: (supervisor: RestartSupervisor) => void): boolean {
  const supervisor = supervisedRestartRefusal(result);
  if (!supervisor) return false;
  notify(supervisor);
  return true;
}

export const INCOMPLETE_INSTALL_RECOVERY = "If the installer already exited or failed, run `ocx status`, stop any running proxy through its owner (`ocx stop`, or its service or desktop app), then reinstall with the same package manager and start it again (see https://opencodex.me/troubleshooting/update-failed/).";

export function reportRestartFailure(result: Extract<ProxyRestartResult, { ok: false }>): void {
  if (result.phase === "identity") {
    console.error("Refusing to restart because the running proxy identity could not be attested. Run `ocx status` to inspect the intended proxy.");
  } else if (result.phase === "request") {
    const code = result.error instanceof Error ? result.error.message : "";
    if (code === "restart_capability_unsupported") {
      console.error("The running proxy predates process-bound restart support; no unsafe fallback was attempted.");
      console.error("   After confirming this home owns the proxy, run `ocx stop` and then `ocx start` once.");
    } else if (code === "restart_version_skew") {
      console.error("This CLI is older than the running proxy (or versions cannot be compared). Use the newer installation's ocx to restart; check `which -a ocx` and run `ocx status`. No changes were made.");
    } else if (code === "update_restart_home_unverified") {
      console.error("The proxy home or lifecycle ownership could not be verified. Run `ocx status`; if a service owns the proxy, use its installation's `ocx service restart`, otherwise use the owning app or supervisor. No changes were made.");
    } else if (code === "restart_package_tree_unsettled") {
      console.error(`The proxy's package files are unsettled. Wait for the install to finish, then run \`ocx restart\`. ${INCOMPLETE_INSTALL_RECOVERY}`);
    } else if (code === "restart_supervised_service") {
      console.error("Restart not performed; the running client runtime was kept. Its background service owns it: run `ocx service restart`.");
    } else if (code === "restart_supervised_service-unproven") {
      console.error("Restart not performed; the running client runtime was kept. A service manager started it (systemd opencodex-proxy.service, launchd com.opencodex.proxy or the Windows OpenCodex service), but it is not enabled or its relaunch could not be verified: restart it through the manager with 'ocx service restart', or check 'ocx service status'.");
    } else if (code === "restart_supervised_legacy-flag") {
      console.error(`Restart not performed; the running client runtime was kept and nothing was stopped. ${LEGACY_FLAG_OWNER_ADVICE}`);
    } else if (code === "restart_supervised_desktop") {
      console.error("Restart not performed; the running client runtime was kept. The OpenCodex desktop app owns it while its connection is current: use Quit in the OpenCodex tray menu, then reopen it. After `ocx disconnect`, `ocx restart` hands it to the app.");
    } else {
      console.error("Proxy restart request could not be confirmed; no fallback stop/start was attempted. Run `ocx status` to inspect ownership and runtime state.");
    }
  } else if (result.phase === "replacement") {
    console.error("Proxy restart was accepted, but no identity-verified replacement became healthy in time. Run `ocx status` to inspect the replacement.");
  } else {
    console.error("Proxy was not running and the fallback start did not become healthy. Run `ocx status` to inspect startup state.");
  }
}
